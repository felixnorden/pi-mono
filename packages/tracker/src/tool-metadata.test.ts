import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import { TodoItem, TodoList, TrackerState, emptyState } from "./domain.ts";
import {
  TOOL_ACTIONS,
  TRACKER_TOOL_METADATA,
  TRACKER_TOOL_NAME,
  TrackerToolParams,
  doneMarkReminder,
  reopenNote,
  validateTrackerCall,
} from "./tool-metadata.ts";

describe("tracker tool parameter schema", () => {
  it("accepts valid parameters for every action", () => {
    const valid: Array<Record<string, unknown>> = [
      { action: "list" },
      { action: "create_list", name: "Work" },
      { action: "create_list", name: "Work", activate: true },
      { action: "create_list", name: "Work", activate: false },
      { action: "create_list", name: "Work", initial_items: ["Fix bug", "Write test"] },
      { action: "create_list", name: "Work", initial_items: ["Fix bug"], activate: false },
      { action: "delete_list", list_id: 1 },
      { action: "set_active", list_id: 1 },
      { action: "set_active" },
      { action: "add_item", list_id: 1, text: "Fix bug" },
      { action: "add_item", list_id: 1, text: ["Fix bug", "Write test"] },
      { action: "update_item", item_id: "Work:2", text: "New text", done: true },
      { action: "update_item", item_id: "Work:2" },
      {
        action: "update_item",
        list_id: 1,
        items: [
          { item_id: "Work:1", done: true },
          { item_id: "Work:2", text: "New text" },
        ],
      },
      { action: "remove_item", item_id: "Work:2" },
    ];
    for (const params of valid) {
      expect(Value.Check(TrackerToolParams, params), JSON.stringify(params)).toBe(true);
    }
  });

  it("rejects unknown actions", () => {
    expect(Value.Check(TrackerToolParams, { action: "bogus" })).toBe(false);
    expect(Value.Check(TrackerToolParams, {})).toBe(false);
  });

  it("rejects wrong parameter types", () => {
    expect(Value.Check(TrackerToolParams, { action: "add_item", list_id: "one", text: "x" })).toBe(
      false,
    );
    expect(Value.Check(TrackerToolParams, { action: "create_list", name: 42 })).toBe(false);
    expect(Value.Check(TrackerToolParams, { action: "create_list", activate: "yes" })).toBe(false);
    expect(Value.Check(TrackerToolParams, { action: "update_item", done: "yes" })).toBe(false);
    expect(Value.Check(TrackerToolParams, { action: "add_item", list_id: 1, text: [1, "x"] })).toBe(
      false,
    );
    expect(
      Value.Check(TrackerToolParams, {
        action: "update_item",
        list_id: 1,
        items: [{ item_id: 1, done: "yes" }],
      }),
    ).toBe(false);
    expect(
      Value.Check(TrackerToolParams, {
        // index inside the batch is the old positional field; patch objects are strict.
        action: "update_item",
        list_id: 1,
        items: [{ index: 1, done: true }],
      }),
    ).toBe(false);
    expect(Value.Check(TrackerToolParams, { action: "update_item", item_id: 2 })).toBe(false); // ids are strings
  });

  it("rejects empty batch arrays", () => {
    expect(Value.Check(TrackerToolParams, { action: "add_item", list_id: 1, text: [] })).toBe(
      false,
    );
    expect(Value.Check(TrackerToolParams, { action: "update_item", items: [] })).toBe(false);
    expect(
      Value.Check(TrackerToolParams, { action: "create_list", name: "Work", initial_items: [] }),
    ).toBe(false);
    expect(
      Value.Check(TrackerToolParams, { action: "create_list", name: "Work", initial_items: [1] }),
    ).toBe(false);
    expect(Value.Check(TrackerToolParams, { action: "set_active", list_id: "one" })).toBe(false);
  });
});

describe("validateTrackerCall (error-nudging layer)", () => {
  it("accepts every valid call shape", () => {
    const valid: Array<Record<string, unknown>> = [
      { action: "list" },
      { action: "create_list", name: "Work" },
      { action: "create_list", name: "Work", initial_items: ["a", "b"], activate: false },
      { action: "delete_list", list_id: 1 },
      { action: "set_active" },
      { action: "set_active", list_id: 1 },
      { action: "add_item", list_id: 1, text: "x" },
      { action: "add_item", list_id: 1, text: ["a", "b"] },
      { action: "update_item", item_id: "Work:2" },
      { action: "update_item", item_id: "Work:2", text: "x", done: true },
      { action: "update_item", list_id: 1, items: [{ item_id: "Work:2", done: true }] },
      { action: "remove_item", item_id: "Work:2" },
    ];
    for (const call of valid) {
      const result = validateTrackerCall(call);
      expect(result.ok, JSON.stringify(call)).toBe(true);
    }
  });

  it("nudges on unknown fields with the accepted parameter list", () => {
    const result = validateTrackerCall({ action: "create_list", name: "Work", list_id: 1 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("list_id");
      expect(result.message).toContain("name");
      expect(result.message).toContain("initial_items");
      expect(result.message).toContain("activate");
    }

    const bare = validateTrackerCall({ action: "list", name: "x" });
    expect(bare.ok).toBe(false);
    if (!bare.ok) expect(bare.message).toContain("accepts no parameters");

    // The old numeric contract (list_id + numeric item_id) is enforced by the
    // schema (item_id must be a string), not here; the mixed-form and
    // missing-list_id nudges below cover the batch contract.
    const batch = validateTrackerCall({
      action: "update_item",
      list_id: 1,
      items: [{ item_id: "Work:2", done: true }],
    });
    expect(batch.ok).toBe(true);
  });

  it("nudges on missing required fields", () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ action: "create_list" }, "'name'"],
      [{ action: "delete_list" }, "'list_id'"],
      [{ action: "add_item", list_id: 1 }, "'text'"],
      [{ action: "add_item", text: "x" }, "'list_id'"],
      [{ action: "update_item" }, "'item_id'"],
      [{ action: "remove_item" }, "'item_id'"],
    ];
    for (const [call, expected] of cases) {
      const result = validateTrackerCall(call);
      expect(result.ok, JSON.stringify(call)).toBe(false);
      if (!result.ok) expect(result.message, JSON.stringify(call)).toContain(expected);
    }
  });

  it("nudges on mixed update_item forms and array text", () => {
    const mixed = validateTrackerCall({
      action: "update_item",
      item_id: "Work:2",
      items: [{ item_id: "Work:3" }],
    });
    expect(mixed.ok).toBe(false);
    if (!mixed.ok) expect(mixed.message).toContain("not both");

    const missingList = validateTrackerCall({
      action: "update_item",
      items: [{ item_id: "Work:1", done: true }],
    });
    expect(missingList.ok).toBe(false);
    if (!missingList.ok) expect(missingList.message).toContain("list_id");

    const arrayText = validateTrackerCall({
      action: "update_item",
      item_id: "Work:2",
      text: ["a"],
    });
    expect(arrayText.ok).toBe(false);
    if (!arrayText.ok) expect(arrayText.message).toContain("single string");
  });

  it("nudges on unknown actions and non-object args", () => {
    const unknown = validateTrackerCall({ action: "bogus" });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) {
      expect(unknown.message).toContain("bogus");
      expect(unknown.message).toContain(TOOL_ACTIONS.join(", "));
    }
    expect(validateTrackerCall("nope").ok).toBe(false);
    expect(validateTrackerCall(undefined).ok).toBe(false);
    expect(validateTrackerCall([1]).ok).toBe(false);
  });

  it("accepts dependency declarations in every shape that supports them", () => {
    const valid: Array<Record<string, unknown>> = [
      { action: "create_list", name: "Work", initial_items: [{ text: "a", deps: ["Work:1"] }] },
      {
        action: "create_list",
        name: "Work",
        initial_items: ["a", { text: "b", deps: ["Work:1"] }],
      },
      { action: "add_item", list_id: 1, text: { text: "b", deps: ["Work:1"] } },
      { action: "add_item", list_id: 1, text: ["a", { text: "b", deps: ["Work:1"] }] },
      { action: "update_item", item_id: "Work:2", deps: ["Work:1"] },
      { action: "update_item", item_id: "Work:2", deps: [] },
      { action: "update_item", list_id: 1, items: [{ item_id: "Work:2", deps: ["Work:1"] }] },
    ];
    for (const call of valid) {
      expect(Value.Check(TrackerToolParams, call), JSON.stringify(call)).toBe(true);
      const result = validateTrackerCall(call);
      expect(result.ok, JSON.stringify(call)).toBe(true);
    }
  });

  it("rejects a deps list on an action that does not accept one", () => {
    const result = validateTrackerCall({ action: "remove_item", item_id: "Work:1", deps: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("deps");
      expect(result.message).toContain("item_id");
    }
  });

  it("rejects a deps list on add_item, which takes deps inside the item object", () => {
    const result = validateTrackerCall({
      action: "add_item",
      list_id: 1,
      text: "a",
      deps: ["Work:1"],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("deps");
  });

  it("rejects a batch entry that carries both an item_id and a stray index", () => {
    expect(
      Value.Check(TrackerToolParams, {
        action: "update_item",
        list_id: 1,
        items: [{ item_id: "Work:1", index: 1, deps: [] }],
      }),
    ).toBe(false);
  });
});

describe("doneMarkReminder (terminal batch done-mark guard)", () => {
  it("reminds when one call marks two or more items done and clears the tracker", () => {
    const reminder = doneMarkReminder([{ done: true }, { done: true }], 0);
    expect(reminder).not.toBeNull();
    expect(reminder).toContain("same turn");
    expect(reminder).toContain("no open items");
    expect(reminder).toContain("2 items");
  });

  it("is silent when a multi-done batch leaves open items (mid-turn progress)", () => {
    // Two done marks but other work still open: not a terminal batch.
    expect(doneMarkReminder([{ done: true }, { done: true }], 1)).toBeNull();
    // Multi-done batch, post-call state unknown: stay quiet rather than guess.
    expect(doneMarkReminder([{ done: true }, { done: true }])).toBeNull();
  });

  it("is silent for single done marks, text-only batches, and empty batches", () => {
    expect(doneMarkReminder([{ done: true }], 0)).toBeNull();
    expect(doneMarkReminder([{}, {}], 0)).toBeNull(); // text-only/no-op patches
    expect(doneMarkReminder([], 0)).toBeNull();
  });

  it("does not count reopening (done: false) as marking done", () => {
    expect(doneMarkReminder([{ done: true }, { done: false }], 0)).toBeNull();
  });
});

describe("reopenNote (advisory reopen guard)", () => {
  /** A one-list state: `deps[i]` are the refs of item i, ids 1..n. */
  const stateWith = (
    deps: ReadonlyArray<readonly string[]>,
    done: readonly number[],
  ): TrackerState =>
    new TrackerState({
      ...emptyState(),
      lists: [
        new TodoList({
          id: 1,
          name: "Work",
          nextItemId: deps.length + 1,
          items: deps.map(
            (itemDeps, index) =>
              new TodoItem({
                id: index + 1,
                text: `item ${index + 1}`,
                done: done.includes(index),
                deps: itemDeps,
              }),
          ),
        }),
      ],
    });

  it("notes the done dependents of a reopened item", () => {
    const state = stateWith([[], ["Work:1"]], [1]);

    const note = reopenNote([{ id: "Work:1", done: false }], state);

    expect(note).not.toBeNull();
    expect(note).toContain("Work:2");
    expect(note).toContain("done but blocked");
  });

  it("is silent when the patch is not a reopen", () => {
    const state = stateWith([[], ["Work:1"]], [1]);

    expect(reopenNote([{ id: "Work:1", done: true }], state)).toBeNull();
    expect(reopenNote([{ id: "Work:1", text: "new" }], state)).toBeNull();
    expect(reopenNote([], state)).toBeNull();
  });

  it("is silent when no dependent is done", () => {
    const state = stateWith([[], ["Work:1"]], []);

    expect(reopenNote([{ id: "Work:1", done: false }], state)).toBeNull();
  });

  it("ignores a patch id that does not resolve", () => {
    const state = stateWith([[], ["Work:1"]], [1]);

    expect(reopenNote([{ id: "?", done: false }], state)).toBeNull();
    expect(reopenNote([{ id: "Other:1", done: false }], state)).toBeNull();
    expect(reopenNote([{ id: "Work:9", done: false }], state)).toBeNull();
  });
});

describe("tracker tool prompt metadata", () => {
  it("every guideline names the tracker tool", () => {
    for (const guideline of TRACKER_TOOL_METADATA.promptGuidelines) {
      expect(guideline, guideline).toContain(TRACKER_TOOL_NAME);
    }
  });

  it("description and snippet are non-empty and cover every action", () => {
    expect(TRACKER_TOOL_METADATA.description.length).toBeGreaterThan(0);
    expect(TRACKER_TOOL_METADATA.promptSnippet.length).toBeGreaterThan(0);
    for (const action of TOOL_ACTIONS) {
      expect(TRACKER_TOOL_METADATA.description, `description should mention ${action}`).toContain(
        action,
      );
    }
  });

  it("states the dependency rules in the description", () => {
    expect(TRACKER_TOOL_METADATA.description).toContain("blocked");
    expect(TRACKER_TOOL_METADATA.description).toContain("Ready now");
    expect(TRACKER_TOOL_METADATA.description).toContain("cannot be removed");
  });

  it("runs tool calls sequentially to avoid mutation races", () => {
    expect(TRACKER_TOOL_METADATA.executionMode).toBe("sequential");
  });
});
