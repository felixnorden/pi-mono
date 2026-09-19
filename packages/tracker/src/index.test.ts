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
}

/**
 * Register the extension against a minimal fake API and return the captured
 * tool plus a context that satisfies the paths `execute` touches (widget
 * refresh and persistence).
 */
const makeHarness = (): Harness => {
  let registered: ToolDefinition<any, unknown, any> | undefined;
  const api = {
    registerTool: (tool: ToolDefinition<any, unknown, any>) => {
      registered = tool;
    },
    registerCommand: () => {},
    on: () => {},
    appendEntry: () => {},
  } as unknown as ExtensionAPI;
  tracker(api);
  if (!registered) throw new Error("tracker did not register a tool");
  const ctx = {
    ui: { setWidget: () => {}, notify: () => {} },
  } as unknown as ExtensionContext;
  return { tool: registered, ctx };
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
        { index: 1, done: true },
        { index: 3, text: "cee" },
      ],
    });

    expect(result.details?.items).toHaveLength(2);
    expect(textOf(result)).toContain("Updated 2 items");
  });

  it("returns an error result for a missing item instead of throwing", async () => {
    const harness = makeHarness();
    await run(harness, { action: "create_list", name: "Work", initial_items: ["only"] });

    const result = await run(harness, { action: "update_item", item_id: "Work:9", done: true });

    expect(result.details?.error).toContain("Work:9");
    expect(result.content[0]).toMatchObject({ type: "text" });
  });
});
