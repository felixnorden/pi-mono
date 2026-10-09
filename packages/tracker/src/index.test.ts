/**
 * Bridge tests for `src/index.ts`. The store and the planner have their own
 * suites; these tests pin the thin wiring between them, including the result
 * contract that both `update_items` forms report an affected-items array. That
 * contract broke once: the scalar form returned one `TodoItem`, the renderer
 * called `.map` on it, and the tool failed with `items.map is not a function`.
 */
import {
  type AgentBeforeSettleEvent,
  type AgentToolResult,
  type CompactOptions,
  type ExtensionAPI,
  type ExtensionToolContext,
  type Theme,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type {
  ClassifierApi,
  ClassifierChoiceAnswer,
  ClassifierModel,
  ClassifierResult,
  JsonObject,
} from "@earendil-works/pi-ai";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import { Effect } from "effect";
import * as FileSystem from "effect/FileSystem";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  NEEDS_CONTEXT_LABEL,
  NEEDS_NONE_LABEL,
  type ClassifierRegistry,
} from "./compaction/classifier.ts";
import tracker from "./index.ts";
import type { TrackerToolDetails, TrackerToolParams } from "./presentation/tool-metadata.ts";

/**
 * The variable `getAgentDir()` reads. Pi 1.0.2 does not re-export the
 * `ENV_AGENT_DIR` constant from its package root, so its value is inlined here.
 */
const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";

interface Harness {
  readonly tool: ToolDefinition<any, unknown, any>;
  readonly ctx: ExtensionToolContext;
  /** Every persisted snapshot, in the order the session received it. */
  readonly appends: unknown[];
  /** Every `ctx.compact` call's options, in order. */
  readonly compacts: CompactOptions[];
  /** Every `ctx.ui.notify` call. */
  readonly notifications: Array<{ readonly message: string; readonly severity?: string }>;
  /** Every `pi.sendMessage` call. */
  readonly sends: Array<{ readonly message: any; readonly options?: any }>;
  /** Every `pi.sendUserMessage` call. */
  readonly userSends: unknown[];
  /** Invoke the captured `agent_before_settle` handler. */
  readonly settle: (event?: Partial<AgentBeforeSettleEvent>) => Promise<void>;
  /** Invoke the captured `session_compact_failed` handler. */
  readonly compactFailed: (aborted: boolean) => Promise<void>;
}

interface HarnessOptions {
  /** Classifier registry double; defaults to one with no available classifier. */
  readonly registry?: ClassifierRegistry;
  /** Parsed contents for the temp `tui.json`; omitted means no config file. */
  readonly config?: unknown;
}

const classifierModel = (provider: string, id: string): ClassifierModel<ClassifierApi> => ({
  id,
  name: id,
  api: "typesafe-system-one",
  provider,
  baseUrl: "https://example.invalid",
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  type: "classifier",
  contextWindow: 8192,
});

/** Answer every question in the classifier context with the same needs mass. */
const choiceResult = (
  needsMass: number,
  context: { readonly questions: Record<string, unknown> },
  confidence = 1,
): ClassifierResult => {
  const answers: Record<string, ClassifierChoiceAnswer> = {};
  for (const key of Object.keys(context.questions)) {
    answers[key] = {
      type: "choice",
      choice: needsMass >= 0.5 ? NEEDS_CONTEXT_LABEL : NEEDS_NONE_LABEL,
      probabilities: { [NEEDS_CONTEXT_LABEL]: needsMass, [NEEDS_NONE_LABEL]: 1 - needsMass },
      confidence,
    };
  }
  return {
    api: "typesafe-system-one",
    provider: "typesafe",
    model: "jev-latest",
    answers,
    stopReason: "stop",
    timestamp: 0,
  };
};

/** Create a temp agent directory (and optional `tui.json`) via the FileSystem service. */
const prepareAgentDir = (config: unknown): Promise<string> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectory({ prefix: "tracker-smart-compaction-" });
      if (config !== undefined) {
        yield* fs.writeFileString(join(directory, "tui.json"), JSON.stringify(config));
      }
      return directory;
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

/**
 * Register the extension against a minimal fake API and return the captured
 * tool plus a context that satisfies the paths `execute`, the widget refresh,
 * persistence, and the settle handler touch.
 *
 * Sets the agent-dir environment variable to a fresh temp directory before the
 * factory runs, so the settings reader never touches the developer's real
 * `~/.pi/agent/tui.json`.
 */
const makeHarness = async (options: HarnessOptions = {}): Promise<Harness> => {
  const agentDir = await prepareAgentDir(options.config);
  process.env[AGENT_DIR_ENV] = agentDir;

  let registered: ToolDefinition<any, unknown, any> | undefined;
  const handlers = new Map<string, (event: any, ctx: any) => unknown>();
  const appends: unknown[] = [];
  const compacts: CompactOptions[] = [];
  const notifications: Array<{ message: string; severity?: string }> = [];
  const sends: Array<{ message: any; options?: any }> = [];
  const userSends: unknown[] = [];

  const registry: ClassifierRegistry = options.registry ?? {
    getAvailableOfType: async () => [],
    classify: async (_model, context) => choiceResult(1, context),
  };

  const api = {
    registerTool: (tool: ToolDefinition<any, unknown, any>) => {
      registered = tool;
    },
    registerCommand: () => {},
    on: (event: string, handler: (event: any, ctx: any) => unknown) => {
      handlers.set(event, handler);
    },
    appendEntry: (_type: string, data: unknown) => {
      appends.push(data);
    },
    sendMessage: (message: any, options?: any) => {
      sends.push({ message, options });
    },
    sendUserMessage: (content: unknown) => {
      userSends.push(content);
    },
  } as unknown as ExtensionAPI;

  tracker(api);
  if (!registered) throw new Error("tracker did not register a tool");

  const ctx = {
    ui: {
      setWidget: () => {},
      notify: (message: string, severity?: string) => {
        notifications.push({ message, ...(severity === undefined ? {} : { severity }) });
      },
    },
    modelRegistry: registry,
    signal: undefined,
    compact: (opts?: CompactOptions) => {
      compacts.push(opts ?? {});
    },
  } as unknown as ExtensionToolContext;

  const settle = async (event: Partial<AgentBeforeSettleEvent> = {}): Promise<void> => {
    const handler = handlers.get("agent_before_settle");
    if (!handler) throw new Error("tracker did not register an agent_before_settle handler");
    await handler({ type: "agent_before_settle", outcome: "completed", ...event }, ctx);
  };

  const compactFailed = async (aborted: boolean): Promise<void> => {
    const handler = handlers.get("session_compact_failed");
    if (!handler) throw new Error("tracker did not register a session_compact_failed handler");
    await handler({ type: "session_compact_failed", aborted }, ctx);
  };

  return {
    tool: registered,
    ctx,
    appends,
    compacts,
    notifications,
    sends,
    userSends,
    settle,
    compactFailed,
  };
};

const run = (
  harness: Harness,
  params: TrackerToolParams,
): Promise<AgentToolResult<TrackerToolDetails>> =>
  harness.tool.execute("test-call", params, undefined, undefined, harness.ctx) as Promise<
    AgentToolResult<TrackerToolDetails>
  >;

const textOf = (result: AgentToolResult<TrackerToolDetails>): string => {
  const block = result.content[0];
  return block?.type === "text" ? block.text : "";
};

/** Identity theme: styles pass text through, so assertions search plain text. */
const identityTheme = {
  fg: (_color: string, text: string): string => text,
  bold: (text: string): string => text,
  strikethrough: (text: string): string => text,
  style: (text: string): string => text,
} as unknown as Theme;

/** Render a tool result through the registered `renderResult`. */
const renderList = (
  harness: Harness,
  result: AgentToolResult<TrackerToolDetails>,
  expanded: boolean,
): string =>
  harness.tool.renderResult!(
    result,
    { expanded, isPartial: false },
    identityTheme,
    harness.ctx as never,
  )
    .render(400)
    .join("\n")
    .replace(/\s+/g, " ");

describe("tracker tool bridge", () => {
  it("returns an affected-items array for the scalar update_items form", async () => {
    const harness = await makeHarness();
    await run(harness, {
      action: "create_list",
      name: "Work",
      initial_items: [{ title: "write plan" }, { title: "ship it" }],
    });

    const result = await run(harness, { action: "update_items", item_id: "Work:1", done: true });

    expect(result.details?.items).toHaveLength(1);
    expect(result.details?.items?.[0]?.done).toBe(true);
    expect(textOf(result)).toContain("Updated 1 item");
    expect(textOf(result)).toContain("Work:1 (completed)");
  });

  it("keeps the title patch for the scalar update_items form", async () => {
    const harness = await makeHarness();
    await run(harness, { action: "create_list", name: "Work", initial_items: [{ title: "old" }] });

    const result = await run(harness, { action: "update_items", item_id: "Work:1", title: "new" });

    expect(result.details?.items).toHaveLength(1);
    expect(result.details?.items?.[0]?.title).toBe("new");
    expect(textOf(result)).toContain("Work:1 (title: new)");
  });

  it("returns one entry per patch for the batch update_items form", async () => {
    const harness = await makeHarness();
    await run(harness, {
      action: "create_list",
      name: "Work",
      initial_items: [{ title: "a" }, { title: "b" }, { title: "c" }],
    });

    const result = await run(harness, {
      action: "update_items",
      list_id: 1,
      items: [
        { item_id: "Work:1", done: true },
        { item_id: "Work:3", title: "cee" },
      ],
    });

    expect(result.details?.items).toHaveLength(2);
    expect(textOf(result)).toContain("Updated 2 items");
    expect(textOf(result)).toContain("Work:3 (title: cee)");
  });

  it("shows id-based references in the list output", async () => {
    const harness = await makeHarness();
    await run(harness, {
      action: "create_list",
      name: "Work",
      initial_items: [{ title: "write plan" }, { title: "ship it" }],
    });

    await run(harness, { action: "update_items", item_id: "Work:2", done: true });
    const result = await run(harness, { action: "list" });

    expect(textOf(result)).toContain("[x] #Work:2: ship it");
  });

  it("shows stable ids after a removal", async () => {
    const harness = await makeHarness();
    await run(harness, {
      action: "create_list",
      name: "Work",
      initial_items: [{ title: "a" }, { title: "b" }, { title: "c" }],
    });

    await run(harness, { action: "remove_item", item_id: "Work:1" });
    const result = await run(harness, { action: "list" });

    // The remaining items keep their ids instead of shifting down.
    expect(textOf(result)).toContain("#Work:2: b");
    expect(textOf(result)).toContain("#Work:3: c");
    expect(textOf(result)).not.toContain("#Work:1");
  });

  it("shows the full description in the expanded list view", async () => {
    const harness = await makeHarness();
    const description = "detail ".repeat(30).trim();
    await run(harness, { action: "create_list", name: "Work" });
    await run(harness, {
      action: "add_items",
      list_id: 1,
      items: [{ title: "big", description }],
    });
    const result = await run(harness, { action: "list" });

    expect(renderList(harness, result, true)).toContain(description);
    expect(renderList(harness, result, false)).not.toContain(description);
  });

  it("reports an error result for a missing item instead of throwing", async () => {
    const harness = await makeHarness();
    await run(harness, { action: "create_list", name: "Work", initial_items: [{ title: "only" }] });

    const result = await run(harness, { action: "update_items", item_id: "Work:9", done: true });

    expect(result.details?.error).toContain("Work:9");
    expect(result.content[0]).toMatchObject({ type: "text" });
  });

  it("accepts dependencies in the object item form", async () => {
    const harness = await makeHarness();
    await run(harness, {
      action: "create_list",
      name: "Work",
      initial_items: [{ title: "a" }, { title: "b", deps: ["Work:1"] }],
    });

    const added = await run(harness, {
      action: "add_items",
      list_id: 1,
      items: [{ title: "c", deps: ["Work:2"] }],
    });

    expect(added.details?.error).toBeUndefined();
    expect(added.details?.items?.[0]?.deps).toEqual(["Work:2"]);
    expect(textOf(added)).toContain("Work:3");
  });

  it("carries every nested object field on add_items", async () => {
    const harness = await makeHarness();
    await run(harness, {
      action: "create_list",
      name: "Work",
      initial_items: [{ title: "a" }, { title: "b" }],
    });

    const added = await run(harness, {
      action: "add_items",
      list_id: 1,
      items: [
        {
          title: "Wire the promotion script",
          description: "Add evals/promote.ts.",
          refs: [{ kind: "path", path: "evals/rules.ts" }],
          produces: [{ path: "evals/promote.ts" }],
          deps: ["Work:1"],
        },
      ],
    });

    expect(added.details?.error).toBeUndefined();
    expect(added.details?.items?.[0]).toMatchObject({
      title: "Wire the promotion script",
      description: "Add evals/promote.ts.",
      refs: [{ kind: "path", path: "evals/rules.ts" }],
      produces: [{ path: "evals/promote.ts" }],
      deps: ["Work:1"],
    });
  });

  it("rejects a malformed dependency reference with an actionable message", async () => {
    const harness = await makeHarness();
    await run(harness, { action: "create_list", name: "Work", initial_items: [{ title: "a" }] });

    const result = await run(harness, {
      action: "add_items",
      list_id: 1,
      items: [{ title: "b", deps: ["nonsense"] }],
    });

    expect(result.details?.error).toContain("listName:id");
  });

  it("names the cycle when a dependency would close one", async () => {
    const harness = await makeHarness();
    await run(harness, {
      action: "create_list",
      name: "Work",
      initial_items: [{ title: "a" }, { title: "b", deps: ["Work:1"] }],
    });

    const result = await run(harness, {
      action: "update_items",
      item_id: "Work:1",
      deps: ["Work:2"],
    });

    expect(result.details?.error).toContain("Work:1");
    expect(result.details?.error).toContain("Work:2");
  });

  it("annotates blocked items and names what is ready", async () => {
    const harness = await makeHarness();
    await run(harness, {
      action: "create_list",
      name: "Work",
      initial_items: [
        { title: "a" },
        { title: "b", deps: ["Work:1"] },
        { title: "c", deps: ["Work:2"] },
      ],
    });

    const text = textOf(await run(harness, { action: "list" }));

    expect(text).toContain("blocked by #Work:1");
    expect(text).toContain("blocked by #Work:2");
    expect(text).toContain("Ready now: #Work:1");
  });

  it("leaves the list output untouched for a dependency-free list", async () => {
    const harness = await makeHarness();
    await run(harness, {
      action: "create_list",
      name: "Work",
      initial_items: [{ title: "a" }, { title: "b" }],
    });

    const text = textOf(await run(harness, { action: "list" }));

    expect(text).not.toContain("blocked by");
    expect(text).not.toContain("Ready now");
    expect(text).toBe("[1] Work — 0/2 (active)\n  [ ] #Work:1: a\n  [ ] #Work:2: b");
  });

  it("names the blockers when a completion is refused", async () => {
    const harness = await makeHarness();
    await run(harness, {
      action: "create_list",
      name: "Work",
      initial_items: [{ title: "a" }, { title: "b", deps: ["Work:1"] }],
    });

    const result = await run(harness, { action: "update_items", item_id: "Work:2", done: true });

    expect(result.details?.error).toContain("Work:1");
    expect(result.details?.error).toContain("blocked");
  });

  it("notes the done dependents when a dependency is reopened", async () => {
    const harness = await makeHarness();
    await run(harness, {
      action: "create_list",
      name: "Work",
      initial_items: [{ title: "a" }, { title: "b", deps: ["Work:1"] }],
    });
    await run(harness, { action: "update_items", item_id: "Work:1", done: true });
    await run(harness, { action: "update_items", item_id: "Work:2", done: true });

    const text = textOf(
      await run(harness, { action: "update_items", item_id: "Work:1", done: false }),
    );

    expect(text).toContain("Note:");
    expect(text).toContain("Work:2");
  });

  it("adds no reopen note when no dependent is done", async () => {
    const harness = await makeHarness();
    await run(harness, {
      action: "create_list",
      name: "Work",
      initial_items: [{ title: "a" }, { title: "b", deps: ["Work:1"] }],
    });
    await run(harness, { action: "update_items", item_id: "Work:1", done: true });

    const text = textOf(
      await run(harness, { action: "update_items", item_id: "Work:1", done: false }),
    );

    expect(text).not.toContain("Note:");
  });

  it("marks a done item whose dependency is open again", async () => {
    const harness = await makeHarness();
    await run(harness, {
      action: "create_list",
      name: "Work",
      initial_items: [{ title: "a" }, { title: "b", deps: ["Work:1"] }],
    });
    await run(harness, { action: "update_items", item_id: "Work:1", done: true });
    await run(harness, { action: "update_items", item_id: "Work:2", done: true });
    await run(harness, { action: "update_items", item_id: "Work:1", done: false });

    const text = textOf(await run(harness, { action: "list" }));

    // The row is done, so it is not "blocked": it says what it waits on.
    expect(text).toContain("[x] #Work:2: b (waiting on #Work:1)");
    expect(text).not.toContain("blocked by");
    expect(text).toContain("Ready now: #Work:1");
  });

  it("notes a done item that a dependency edit left waiting", async () => {
    const harness = await makeHarness();
    await run(harness, {
      action: "create_list",
      name: "Work",
      initial_items: [{ title: "a" }, { title: "b" }],
    });
    await run(harness, { action: "update_items", item_id: "Work:2", done: true });

    const text = textOf(
      await run(harness, { action: "update_items", item_id: "Work:2", deps: ["Work:1"] }),
    );

    expect(text).toContain("Note: Work:2 is done but now waits on Work:1");
  });

  it("names the dependencies a deps edit removed", async () => {
    const harness = await makeHarness();
    await run(harness, {
      action: "create_list",
      name: "Work",
      initial_items: [{ title: "a" }, { title: "b", deps: ["Work:1"] }, { title: "c" }],
    });

    const cleared = await run(harness, { action: "update_items", item_id: "Work:2", deps: [] });
    expect(textOf(cleared)).toContain("deps cleared (was Work:1)");

    await run(harness, { action: "update_items", item_id: "Work:2", deps: ["Work:1"] });
    const replaced = await run(harness, {
      action: "update_items",
      item_id: "Work:2",
      deps: ["Work:3"],
    });
    expect(textOf(replaced)).toContain("deps: Work:1 → Work:3");
  });

  it("persists overlapping mutations in order", async () => {
    const harness = await makeHarness();
    await run(harness, {
      action: "create_list",
      name: "Work",
      initial_items: [{ title: "a" }, { title: "b" }],
    });

    // Two calls in flight at once. The last snapshot the session receives must
    // be the state after both, or a later restore resurrects an older one.
    await Promise.all([
      run(harness, { action: "update_items", item_id: "Work:1", done: true }),
      run(harness, { action: "update_items", item_id: "Work:2", done: true }),
    ]);

    const last = harness.appends.at(-1) as {
      lists: Array<{ items: Array<{ done: boolean }> }>;
    };
    expect(last.lists[0]?.items.map((item) => item.done)).toEqual([true, true]);

    const text = textOf(await run(harness, { action: "list" }));
    expect(text).toContain("[x] #Work:1: a");
    expect(text).toContain("[x] #Work:2: b");
  });

  it("shows items in dependency order, not stored order", async () => {
    const harness = await makeHarness();
    await run(harness, {
      action: "create_list",
      name: "Work",
      initial_items: [{ title: "ship", deps: ["Work:2"] }, { title: "write plan" }],
    });

    const text = textOf(await run(harness, { action: "list" }));

    // "write plan" is the dependency, so it is listed before "ship" even
    // though "ship" was created first.
    expect(text.indexOf("write plan")).toBeLessThan(text.indexOf("ship"));
    expect(text).toContain("#Work:2: write plan");
  });
});

describe("tracker smart-compaction bridge", () => {
  const available: readonly ClassifierModel<ClassifierApi>[] = [
    classifierModel("typesafe", "jev-latest"),
  ];

  const compactRegistry = (
    needsMass: number,
    onDescribe?: (state: JsonObject) => void,
    confidence = 1,
  ): ClassifierRegistry => ({
    getAvailableOfType: async () => available,
    classify: async (_model, context) => {
      onDescribe?.(context.state);
      return choiceResult(needsMass, context, confidence);
    },
  });

  /** Create a two-item dependency list and complete the first item. */
  const completeFirst = async (harness: Harness): Promise<void> => {
    await run(harness, {
      action: "create_list",
      name: "Work",
      initial_items: [{ title: "first" }, { title: "second", deps: ["Work:1"] }],
    });
    await run(harness, { action: "update_items", item_id: "Work:1", done: true });
  };

  it("a completed item with a compact verdict starts pi's compaction at the settle boundary", async () => {
    const harness = await makeHarness({ registry: compactRegistry(0.1) });
    await completeFirst(harness);

    await harness.settle({ outcome: "completed" });

    expect(harness.compacts).toHaveLength(1);
    expect(harness.compacts[0]?.customInstructions).toBeUndefined();
    expect(typeof harness.compacts[0]?.onComplete).toBe("function");
    expect(typeof harness.compacts[0]?.onError).toBe("function");
  });

  it("a keep verdict leaves the run untouched", async () => {
    const harness = await makeHarness({ registry: compactRegistry(0.9) });
    await completeFirst(harness);

    await harness.settle();

    expect(harness.compacts).toHaveLength(0);
  });

  it("a raised needsContextProbabilityThreshold compacts an answer the default would keep", async () => {
    const harness = await makeHarness({
      registry: compactRegistry(0.6),
      config: { smartCompaction: { needsContextProbabilityThreshold: 0.9 } },
    });
    await completeFirst(harness);

    await harness.settle();

    expect(harness.compacts).toHaveLength(1);
  });

  it("a lowered needsContextProbabilityThreshold keeps an answer the default would compact", async () => {
    const harness = await makeHarness({
      registry: compactRegistry(0.45),
      config: { smartCompaction: { needsContextProbabilityThreshold: 0.2 } },
    });
    await completeFirst(harness);

    await harness.settle();

    expect(harness.compacts).toHaveLength(0);
  });

  it("keeps context when the classifier answer is below the confidence floor", async () => {
    const harness = await makeHarness({
      registry: compactRegistry(0.1, undefined, 0.2),
      config: { smartCompaction: { minAnswerConfidence: 0.9 } },
    });
    await completeFirst(harness);

    await harness.settle();

    expect(harness.compacts).toHaveLength(0);
  });

  it("compacts when the classifier answer reaches the confidence floor", async () => {
    const harness = await makeHarness({
      registry: compactRegistry(0.1, undefined, 0.9),
      config: { smartCompaction: { minAnswerConfidence: 0.5 } },
    });
    await completeFirst(harness);

    await harness.settle();

    expect(harness.compacts).toHaveLength(1);
  });

  it("judges the whole ready frontier and keeps context when any candidate needs it", async () => {
    let questions: Record<string, unknown> = {};
    const harness = await makeHarness({
      registry: {
        getAvailableOfType: async () => available,
        classify: async (_model, context) => {
          questions = context.questions;
          const answers: Record<string, ClassifierChoiceAnswer> = {};
          // Work:2 (dependent) says no; Work:3 (independent) says yes.
          for (const key of Object.keys(context.questions)) {
            const needsMass = key.includes("Work_3") ? 0.9 : 0.1;
            answers[key] = {
              type: "choice",
              choice: needsMass >= 0.5 ? NEEDS_CONTEXT_LABEL : NEEDS_NONE_LABEL,
              probabilities: {
                [NEEDS_CONTEXT_LABEL]: needsMass,
                [NEEDS_NONE_LABEL]: 1 - needsMass,
              },
              confidence: 1,
            };
          }
          return {
            api: "typesafe-system-one",
            provider: "typesafe",
            model: "jev-latest",
            answers,
            stopReason: "stop",
            timestamp: 0,
          };
        },
      },
    });
    await run(harness, {
      action: "create_list",
      name: "Work",
      initial_items: [
        { title: "first" },
        { title: "second", deps: ["Work:1"] },
        { title: "third" },
      ],
    });
    await run(harness, { action: "update_items", item_id: "Work:1", done: true });

    await harness.settle();

    expect(Object.keys(questions).length).toBe(2);
    expect(harness.compacts).toHaveLength(0);
  });

  it("compacts when every judged candidate is self-contained", async () => {
    const harness = await makeHarness({ registry: compactRegistry(0.1) });
    await run(harness, {
      action: "create_list",
      name: "Work",
      initial_items: [
        { title: "first" },
        { title: "second", deps: ["Work:1"] },
        { title: "third" },
      ],
    });
    await run(harness, { action: "update_items", item_id: "Work:1", done: true });

    await harness.settle();

    expect(harness.compacts).toHaveLength(1);
  });

  it("no credential-available classifier leaves the run untouched", async () => {
    let classifyCalls = 0;
    const harness = await makeHarness({
      registry: {
        getAvailableOfType: async () => [],
        classify: async (_model, context) => {
          classifyCalls += 1;
          return choiceResult(0.1, context);
        },
      },
    });
    await completeFirst(harness);

    await harness.settle();

    expect(harness.compacts).toHaveLength(0);
    expect(classifyCalls).toBe(0);
  });

  it("an enabled: false setting leaves the run untouched even when a classifier is available", async () => {
    const harness = await makeHarness({
      registry: compactRegistry(0.1),
      config: { smartCompaction: { enabled: false } },
    });
    await completeFirst(harness);

    await harness.settle();

    expect(harness.compacts).toHaveLength(0);
  });

  it("a settle with no pending completion calls no classifier", async () => {
    let classifyCalls = 0;
    const harness = await makeHarness({
      registry: {
        getAvailableOfType: async () => available,
        classify: async (_model, context) => {
          classifyCalls += 1;
          return choiceResult(0.1, context);
        },
      },
    });
    await run(harness, {
      action: "create_list",
      name: "Work",
      initial_items: [{ title: "first" }, { title: "second", deps: ["Work:1"] }],
    });

    await harness.settle();

    expect(classifyCalls).toBe(0);
    expect(harness.compacts).toHaveLength(0);
  });

  it("one completion yields at most one compaction across settles", async () => {
    const harness = await makeHarness({ registry: compactRegistry(0.1) });
    await completeFirst(harness);

    await harness.settle();
    await harness.settle();

    expect(harness.compacts).toHaveLength(1);
  });

  it("an aborted settle clears the record without compacting", async () => {
    const harness = await makeHarness({ registry: compactRegistry(0.1) });
    await completeFirst(harness);

    await harness.settle({ outcome: "aborted" });
    await harness.settle({ outcome: "completed" });

    expect(harness.compacts).toHaveLength(0);
  });

  it("an errored settle clears the record without compacting", async () => {
    const harness = await makeHarness({ registry: compactRegistry(0.1) });
    await completeFirst(harness);

    await harness.settle({ outcome: "error" });
    await harness.settle({ outcome: "completed" });

    expect(harness.compacts).toHaveLength(0);
  });

  it("the digest centres on the candidate and carries the completed batch as prior work", async () => {
    let captured: JsonObject | undefined;
    const harness = await makeHarness({
      registry: compactRegistry(0.1, (state) => {
        captured = state;
      }),
    });
    await completeFirst(harness);

    await harness.settle();

    const digest = captured as unknown as {
      candidates: Array<{ ref: string; class: string }>;
      completed: Array<{ ref: string }>;
    };
    expect(digest.candidates[0]?.ref).toBe("Work:2");
    expect(digest.candidates[0]?.class).toBe("dependent-successor");
    expect(digest.completed).toEqual([{ ref: "Work:1", text: "first" }]);
  });

  it("a classifier error leaves the run untouched", async () => {
    const harness = await makeHarness({
      registry: {
        getAvailableOfType: async () => available,
        classify: async () => {
          throw new Error("provider unreachable");
        },
      },
    });
    await completeFirst(harness);

    await harness.settle();

    expect(harness.compacts).toHaveLength(0);
  });

  it("an abort signal during classification leaves the run untouched", async () => {
    const controller = new AbortController();
    const harness = await makeHarness({
      registry: {
        getAvailableOfType: async () => available,
        classify: (_model, _context, options) => {
          const signal = options?.signal;
          return new Promise((_resolve, reject) => {
            signal?.addEventListener("abort", () => reject(new Error("aborted")));
            controller.abort();
          });
        },
      },
    });
    harness.ctx.signal = controller.signal;
    await completeFirst(harness);

    await harness.settle();

    expect(harness.compacts).toHaveLength(0);
  });

  it("the hook adds no tracker custom entry and does not change the tool result", async () => {
    const harness = await makeHarness({ registry: compactRegistry(0.1) });
    await run(harness, {
      action: "create_list",
      name: "Work",
      initial_items: [{ title: "first" }, { title: "second", deps: ["Work:1"] }],
    });

    const result = await run(harness, { action: "update_items", item_id: "Work:1", done: true });
    const appendsBefore = harness.appends.length;

    await harness.settle();

    expect(harness.appends).toHaveLength(appendsBefore);
    expect(textOf(result)).toBe("Updated 1 item: Work:1 (completed)");
  });

  it("compaction completion sends one resume turn naming the next ready item", async () => {
    const harness = await makeHarness({ registry: compactRegistry(0.1) });
    await completeFirst(harness);
    await harness.settle();

    harness.compacts[0]?.onComplete?.({
      summary: "summary",
      firstKeptEntryId: "entry-1",
      tokensBefore: 100,
    });

    expect(harness.sends).toHaveLength(1);
    const message = harness.sends[0]?.message as { content: string };
    expect(message.content).toContain("Work:2");
  });

  it("the resume turn is a continuation message that triggers a turn", async () => {
    const harness = await makeHarness({ registry: compactRegistry(0.1) });
    await completeFirst(harness);
    await harness.settle();
    harness.compacts[0]?.onComplete?.({
      summary: "summary",
      firstKeptEntryId: "entry-1",
      tokensBefore: 100,
    });

    const message = harness.sends[0]?.message as { customType: string };
    const options = harness.sends[0]?.options as { triggerTurn?: boolean };
    expect(options.triggerTurn).toBe(true);
    expect(message.customType).toBe("tracker/smart-compaction");
    expect(harness.userSends).toHaveLength(0);
  });

  it("a compaction failure resumes with a warning", async () => {
    const harness = await makeHarness({ registry: compactRegistry(0.1) });
    await completeFirst(harness);
    await harness.settle();

    await harness.compactFailed(false);
    harness.compacts[0]?.onError?.(new Error("boom"));

    expect(harness.notifications).toHaveLength(1);
    expect(harness.notifications[0]?.severity).toBe("warning");
    expect(harness.sends).toHaveLength(1);
  });

  it("a cancelled compaction sends no resume turn", async () => {
    const harness = await makeHarness({ registry: compactRegistry(0.1) });
    await completeFirst(harness);
    await harness.settle();

    await harness.compactFailed(true);
    harness.compacts[0]?.onError?.(new Error("cancelled"));

    expect(harness.sends).toHaveLength(0);
    expect(harness.notifications).toHaveLength(1);
    expect(harness.notifications[0]?.severity).toBe("warning");
  });

  it("the resume turn is delivered once even if the completion callback fires twice", async () => {
    const harness = await makeHarness({ registry: compactRegistry(0.1) });
    await completeFirst(harness);
    await harness.settle();

    const onComplete = harness.compacts[0]?.onComplete;
    onComplete?.({ summary: "summary", firstKeptEntryId: "entry-1", tokensBefore: 100 });
    onComplete?.({ summary: "summary", firstKeptEntryId: "entry-1", tokensBefore: 100 });

    expect(harness.sends).toHaveLength(1);
  });
});
