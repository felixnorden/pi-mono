import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import {
  TOOL_ACTIONS,
  TRACKER_TOOL_METADATA,
  TRACKER_TOOL_NAME,
  TrackerToolParams,
  doneMarkReminder,
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
          { index: 1, done: true },
          { index: 2, text: "New text" },
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
        items: [{ index: "one", done: "yes" }],
      }),
    ).toBe(false);
    expect(
      Value.Check(TrackerToolParams, {
        // item_id inside the batch is a typo now; patch objects are strict.
        action: "update_item",
        list_id: 1,
        items: [{ item_id: "Work:1", done: true }],
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
      { action: "update_item", list_id: 1, items: [{ index: 2, done: true }] },
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
      items: [{ index: 2, done: true }],
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
      items: [{ index: 3 }],
    });
    expect(mixed.ok).toBe(false);
    if (!mixed.ok) expect(mixed.message).toContain("not both");

    const missingList = validateTrackerCall({
      action: "update_item",
      items: [{ index: 1, done: true }],
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

  it("runs tool calls sequentially to avoid mutation races", () => {
    expect(TRACKER_TOOL_METADATA.executionMode).toBe("sequential");
  });
});
