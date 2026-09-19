/**
 * Bridge tests for `src/index.ts`. The store and the planner have their own
 * suites; these tests pin the thin wiring between them, including the result
 * contract that both `update_item` forms report an affected-items array. That
 * contract broke once: the scalar form returned one `TodoItem`, the renderer
 * called `.map` on it, and the tool failed with `items.map is not a function`.
 */
import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import tracker from "./index.ts";
import type { TrackerToolDetails, TrackerToolParams } from "./tool-metadata.ts";

interface Harness {
  readonly tool: ToolDefinition<any, unknown, any>;
  readonly ctx: ExtensionContext;
  /** Every persisted snapshot, in the order the session received it. */
  readonly appends: unknown[];
}

/**
 * Register the extension against a minimal fake API and return the captured
 * tool plus a context that satisfies the paths `execute` touches (widget
 * refresh and persistence).
 */
const makeHarness = (): Harness => {
  let registered: ToolDefinition<any, unknown, any> | undefined;
  const appends: unknown[] = [];
  const api = {
    registerTool: (tool: ToolDefinition<any, unknown, any>) => {
      registered = tool;
    },
    registerCommand: () => {},
    on: () => {},
    appendEntry: (_type: string, data: unknown) => {
      appends.push(data);
    },
  } as unknown as ExtensionAPI;
  tracker(api);
  if (!registered) throw new Error("tracker did not register a tool");
  const ctx = {
    ui: { setWidget: () => {}, notify: () => {} },
  } as unknown as ExtensionContext;
  return { tool: registered, ctx, appends };
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

describe("tracker tool bridge", () => {
  it("returns an affected-items array for the scalar update_item form", async () => {
    const harness = makeHarness();
    await run(harness, {
      action: "create_list",
      name: "Work",
      initial_items: ["write plan", "ship it"],
    });

    const result = await run(harness, { action: "update_item", item_id: "Work:1", done: true });

    expect(result.details?.items).toHaveLength(1);
    expect(result.details?.items?.[0]?.done).toBe(true);
    expect(textOf(result)).toContain("Updated 1 item");
    expect(textOf(result)).toContain("Work:1 (completed)");
  });

  it("keeps the text patch for the scalar update_item form", async () => {
    const harness = makeHarness();
    await run(harness, { action: "create_list", name: "Work", initial_items: ["old"] });

    const result = await run(harness, { action: "update_item", item_id: "Work:1", text: "new" });

    expect(result.details?.items).toHaveLength(1);
    expect(result.details?.items?.[0]?.text).toBe("new");
    expect(textOf(result)).toContain("Work:1 (text: new)");
  });

  it("returns one entry per patch for the batch update_item form", async () => {
    const harness = makeHarness();
    await run(harness, { action: "create_list", name: "Work", initial_items: ["a", "b", "c"] });

    const result = await run(harness, {
      action: "update_item",
      list_id: 1,
      items: [
        { item_id: "Work:1", done: true },
        { item_id: "Work:3", text: "cee" },
      ],
    });

    expect(result.details?.items).toHaveLength(2);
    expect(textOf(result)).toContain("Updated 2 items");
    expect(textOf(result)).toContain("Work:3 (text: cee)");
  });

  it("shows id-based references in the list output", async () => {
    const harness = makeHarness();
    await run(harness, {
      action: "create_list",
      name: "Work",
      initial_items: ["write plan", "ship it"],
    });

    await run(harness, { action: "update_item", item_id: "Work:2", done: true });
    const result = await run(harness, { action: "list" });

    expect(textOf(result)).toContain("[x] #Work:2: ship it");
  });

  it("shows stable ids after a removal", async () => {
    const harness = makeHarness();
    await run(harness, { action: "create_list", name: "Work", initial_items: ["a", "b", "c"] });

    await run(harness, { action: "remove_item", item_id: "Work:1" });
    const result = await run(harness, { action: "list" });

    // The remaining items keep their ids instead of shifting down.
    expect(textOf(result)).toContain("#Work:2: b");
    expect(textOf(result)).toContain("#Work:3: c");
    expect(textOf(result)).not.toContain("#Work:1");
  });

  it("reports an error result for a missing item instead of throwing", async () => {
    const harness = makeHarness();
    await run(harness, { action: "create_list", name: "Work", initial_items: ["only"] });

    const result = await run(harness, { action: "update_item", item_id: "Work:9", done: true });

    expect(result.details?.error).toContain("Work:9");
    expect(result.content[0]).toMatchObject({ type: "text" });
  });

  it("accepts dependencies in the object item form", async () => {
    const harness = makeHarness();
    await run(harness, {
      action: "create_list",
      name: "Work",
      initial_items: ["a", { text: "b", deps: ["Work:1"] }],
    });

    const added = await run(harness, {
      action: "add_item",
      list_id: 1,
      text: { text: "c", deps: ["Work:2"] },
    });

    expect(added.details?.error).toBeUndefined();
    expect(added.details?.items?.[0]?.deps).toEqual(["Work:2"]);
    expect(textOf(added)).toContain("Work:3");
  });

  it("rejects a malformed dependency reference with an actionable message", async () => {
    const harness = makeHarness();
    await run(harness, { action: "create_list", name: "Work", initial_items: ["a"] });

    const result = await run(harness, {
      action: "add_item",
      list_id: 1,
      text: { text: "b", deps: ["nonsense"] },
    });

    expect(result.details?.error).toContain("listName:id");
  });

  it("names the cycle when a dependency would close one", async () => {
    const harness = makeHarness();
    await run(harness, {
      action: "create_list",
      name: "Work",
      initial_items: ["a", { text: "b", deps: ["Work:1"] }],
    });

    const result = await run(harness, {
      action: "update_item",
      item_id: "Work:1",
      deps: ["Work:2"],
    });

    expect(result.details?.error).toContain("Work:1");
    expect(result.details?.error).toContain("Work:2");
  });

  it("annotates blocked items and names what is ready", async () => {
    const harness = makeHarness();
    await run(harness, {
      action: "create_list",
      name: "Work",
      initial_items: ["a", { text: "b", deps: ["Work:1"] }, { text: "c", deps: ["Work:2"] }],
    });

    const text = textOf(await run(harness, { action: "list" }));

    expect(text).toContain("blocked by #Work:1");
    expect(text).toContain("blocked by #Work:2");
    expect(text).toContain("Ready now: #Work:1");
  });

  it("leaves the list output untouched for a dependency-free list", async () => {
    const harness = makeHarness();
    await run(harness, { action: "create_list", name: "Work", initial_items: ["a", "b"] });

    const text = textOf(await run(harness, { action: "list" }));

    expect(text).not.toContain("blocked by");
    expect(text).not.toContain("Ready now");
    expect(text).toBe("[1] Work — 0/2 (active)\n  [ ] #Work:1: a\n  [ ] #Work:2: b");
  });

  it("names the blockers when a completion is refused", async () => {
    const harness = makeHarness();
    await run(harness, {
      action: "create_list",
      name: "Work",
      initial_items: ["a", { text: "b", deps: ["Work:1"] }],
    });

    const result = await run(harness, { action: "update_item", item_id: "Work:2", done: true });

    expect(result.details?.error).toContain("Work:1");
    expect(result.details?.error).toContain("blocked");
  });

  it("notes the done dependents when a dependency is reopened", async () => {
    const harness = makeHarness();
    await run(harness, {
      action: "create_list",
      name: "Work",
      initial_items: ["a", { text: "b", deps: ["Work:1"] }],
    });
    await run(harness, { action: "update_item", item_id: "Work:1", done: true });
    await run(harness, { action: "update_item", item_id: "Work:2", done: true });

    const text = textOf(
      await run(harness, { action: "update_item", item_id: "Work:1", done: false }),
    );

    expect(text).toContain("Note:");
    expect(text).toContain("Work:2");
  });

  it("adds no reopen note when no dependent is done", async () => {
    const harness = makeHarness();
    await run(harness, {
      action: "create_list",
      name: "Work",
      initial_items: ["a", { text: "b", deps: ["Work:1"] }],
    });
    await run(harness, { action: "update_item", item_id: "Work:1", done: true });

    const text = textOf(
      await run(harness, { action: "update_item", item_id: "Work:1", done: false }),
    );

    expect(text).not.toContain("Note:");
  });

  it("marks a done item whose dependency is open again", async () => {
    const harness = makeHarness();
    await run(harness, {
      action: "create_list",
      name: "Work",
      initial_items: ["a", { text: "b", deps: ["Work:1"] }],
    });
    await run(harness, { action: "update_item", item_id: "Work:1", done: true });
    await run(harness, { action: "update_item", item_id: "Work:2", done: true });
    await run(harness, { action: "update_item", item_id: "Work:1", done: false });

    const text = textOf(await run(harness, { action: "list" }));

    // The row is done, so it is not "blocked": it says what it waits on.
    expect(text).toContain("[x] #Work:2: b (waiting on #Work:1)");
    expect(text).not.toContain("blocked by");
    expect(text).toContain("Ready now: #Work:1");
  });

  it("notes a done item that a dependency edit left waiting", async () => {
    const harness = makeHarness();
    await run(harness, { action: "create_list", name: "Work", initial_items: ["a", "b"] });
    await run(harness, { action: "update_item", item_id: "Work:2", done: true });

    const text = textOf(
      await run(harness, { action: "update_item", item_id: "Work:2", deps: ["Work:1"] }),
    );

    expect(text).toContain("Note: Work:2 is done but now waits on Work:1");
  });

  it("names the dependencies a deps edit removed", async () => {
    const harness = makeHarness();
    await run(harness, {
      action: "create_list",
      name: "Work",
      initial_items: ["a", { text: "b", deps: ["Work:1"] }, "c"],
    });

    const cleared = await run(harness, { action: "update_item", item_id: "Work:2", deps: [] });
    expect(textOf(cleared)).toContain("deps cleared (was Work:1)");

    await run(harness, { action: "update_item", item_id: "Work:2", deps: ["Work:1"] });
    const replaced = await run(harness, {
      action: "update_item",
      item_id: "Work:2",
      deps: ["Work:3"],
    });
    expect(textOf(replaced)).toContain("deps: Work:1 → Work:3");
  });

  it("persists overlapping mutations in order", async () => {
    const harness = makeHarness();
    await run(harness, { action: "create_list", name: "Work", initial_items: ["a", "b"] });

    // Two calls in flight at once. The last snapshot the session receives must
    // be the state after both, or a later restore resurrects an older one.
    await Promise.all([
      run(harness, { action: "update_item", item_id: "Work:1", done: true }),
      run(harness, { action: "update_item", item_id: "Work:2", done: true }),
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
    const harness = makeHarness();
    await run(harness, {
      action: "create_list",
      name: "Work",
      initial_items: [{ text: "ship", deps: ["Work:2"] }, "write plan"],
    });

    const text = textOf(await run(harness, { action: "list" }));

    // "write plan" is the dependency, so it is listed before "ship" even
    // though "ship" was created first.
    expect(text.indexOf("write plan")).toBeLessThan(text.indexOf("ship"));
    expect(text).toContain("#Work:2: write plan");
  });
});
