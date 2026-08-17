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
        items: [{ item_id: "Work:1", done: "yes" }],
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
      { action: "update_item", items: [{ item_id: "Work:2", done: true }] },
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

    // The old numeric contract (list_id + numeric item_id) is rejected with
    // the new parameter list, so a stale agent call self-corrects.
    const stale = validateTrackerCall({ action: "update_item", list_id: 1, item_id: 2 });
    expect(stale.ok).toBe(false);
    if (!stale.ok) {
      expect(stale.message).toContain("list_id");
      expect(stale.message).toContain("item_id");
    }
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

describe("doneMarkReminder (batch done-mark guard)", () => {
  it("reminds when one call marks two or more items done", () => {
    const reminder = doneMarkReminder([{ done: true }, { done: true }]);
    expect(reminder).not.toBeNull();
    expect(reminder).toContain("same turn");
    expect(reminder).toContain("2 items");
  });

  it("is silent for single done marks and text-only batches", () => {
    expect(doneMarkReminder([{ done: true }])).toBeNull();
    expect(doneMarkReminder([{}, {}])).toBeNull(); // text-only/no-op patches
    expect(doneMarkReminder([])).toBeNull();
  });

  it("does not count reopening (done: false) as marking done", () => {
    expect(doneMarkReminder([{ done: true }, { done: false }])).toBeNull();
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
