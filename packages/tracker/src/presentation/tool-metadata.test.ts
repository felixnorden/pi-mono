import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import { TodoItem, TodoList, TrackerState, emptyState } from "../core/domain.ts";
import {
  TOOL_ACTIONS,
  TRACKER_TOOL_METADATA,
  TRACKER_TOOL_NAME,
  TITLE_LIMIT,
  TrackerToolParams,
  doneMarkReminder,
  blockedDoneNote,
  validateTrackerCall,
} from "./tool-metadata.ts";

describe("tracker tool parameter schema", () => {
  it("accepts valid parameters for every action", () => {
    const valid: Array<Record<string, unknown>> = [
      { action: "list" },
      { action: "create_list", name: "Work" },
      { action: "create_list", name: "Work", activate: true },
      { action: "create_list", name: "Work", activate: false },
      {
        action: "create_list",
        name: "Work",
        initial_items: [{ title: "Fix bug" }, { title: "Write test" }],
      },
      {
        action: "create_list",
        name: "Work",
        initial_items: [{ title: "Fix bug" }],
        activate: false,
      },
      { action: "delete_list", list_id: 1 },
      { action: "set_active", list_id: 1 },
      { action: "set_active" },
      { action: "add_items", list_id: 1, items: [{ title: "Fix bug" }] },
      { action: "add_items", list_id: 1, items: [{ title: "Fix bug" }, { title: "Write test" }] },
      { action: "update_items", item_id: "Work:2", title: "New text", done: true },
      { action: "update_items", item_id: "Work:2" },
      {
        action: "update_items",
        list_id: 1,
        items: [
          { item_id: "Work:1", done: true },
          { item_id: "Work:2", title: "New text" },
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
    expect(
      Value.Check(TrackerToolParams, {
        action: "add_items",
        list_id: "one",
        items: [{ title: "x" }],
      }),
    ).toBe(false);
    expect(Value.Check(TrackerToolParams, { action: "create_list", name: 42 })).toBe(false);
    expect(Value.Check(TrackerToolParams, { action: "create_list", activate: "yes" })).toBe(false);
    expect(Value.Check(TrackerToolParams, { action: "update_items", done: "yes" })).toBe(false);
    expect(
      Value.Check(TrackerToolParams, { action: "add_items", list_id: 1, items: [1, "x"] }),
    ).toBe(false);
    expect(
      Value.Check(TrackerToolParams, {
        action: "update_items",
        list_id: 1,
        items: [{ item_id: 1, done: "yes" }],
      }),
    ).toBe(false);
    expect(
      Value.Check(TrackerToolParams, {
        // index inside the batch is the old positional field; patch objects are strict.
        action: "update_items",
        list_id: 1,
        items: [{ index: 1, done: true }],
      }),
    ).toBe(false);
    expect(Value.Check(TrackerToolParams, { action: "update_items", item_id: 2 })).toBe(false); // ids are strings
  });

  it("rejects empty batch arrays", () => {
    expect(Value.Check(TrackerToolParams, { action: "add_items", list_id: 1, items: [] })).toBe(
      false,
    );
    expect(Value.Check(TrackerToolParams, { action: "update_items", items: [] })).toBe(false);
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
      {
        action: "create_list",
        name: "Work",
        initial_items: [{ title: "a" }, { title: "b" }],
        activate: false,
      },
      { action: "delete_list", list_id: 1 },
      { action: "set_active" },
      { action: "set_active", list_id: 1 },
      { action: "add_items", list_id: 1, items: [{ title: "x" }] },
      { action: "add_items", list_id: 1, items: [{ title: "a" }, { title: "b" }] },
      { action: "update_items", item_id: "Work:2" },
      { action: "update_items", item_id: "Work:2", title: "x", done: true },
      { action: "update_items", list_id: 1, items: [{ item_id: "Work:2", done: true }] },
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
      action: "update_items",
      list_id: 1,
      items: [{ item_id: "Work:2", done: true }],
    });
    expect(batch.ok).toBe(true);
  });

  it("nudges on missing required fields", () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ action: "create_list" }, "'name'"],
      [{ action: "delete_list" }, "'list_id'"],
      [{ action: "add_items", list_id: 1 }, "'items'"],
      [{ action: "add_items", items: [{ title: "x" }] }, "'list_id'"],
      [{ action: "update_items" }, "'item_id'"],
      [{ action: "remove_item" }, "'item_id'"],
    ];
    for (const [call, expected] of cases) {
      const result = validateTrackerCall(call);
      expect(result.ok, JSON.stringify(call)).toBe(false);
      if (!result.ok) expect(result.message, JSON.stringify(call)).toContain(expected);
    }
  });

  it("nudges on mixed update_items forms and an array title", () => {
    const mixed = validateTrackerCall({
      action: "update_items",
      item_id: "Work:2",
      items: [{ item_id: "Work:3" }],
    });
    expect(mixed.ok).toBe(false);
    if (!mixed.ok) expect(mixed.message).toContain("not both");

    const missingList = validateTrackerCall({
      action: "update_items",
      items: [{ item_id: "Work:1", done: true }],
    });
    expect(missingList.ok).toBe(false);
    if (!missingList.ok) expect(missingList.message).toContain("list_id");

    const arrayText = validateTrackerCall({
      action: "update_items",
      item_id: "Work:2",
      title: ["a"],
    });
    expect(arrayText.ok).toBe(false);
    if (!arrayText.ok) expect(arrayText.message).toContain("single string");
  });

  it("rejects top-level refs and produces on the update_items batch form", () => {
    // The batch form carries refs/produces inside each item. A top-level
    // refs/produces alongside `items` used to pass validation and was then
    // dropped, so the call reported success without the declaration.
    const extras = [
      { refs: [{ kind: "path", path: "src/a.ts" }] },
      { produces: [{ path: "out.md" }] },
    ] as const;
    for (const extra of extras) {
      const result = validateTrackerCall({
        action: "update_items",
        list_id: 1,
        items: [{ item_id: "Work:2", done: true }],
        ...extra,
      });
      expect(result.ok, JSON.stringify(extra)).toBe(false);
      if (!result.ok) expect(result.message).toContain("not both");
    }
  });

  it("accepts add_items item objects and rejects a bare string or the old title container", () => {
    expect(
      validateTrackerCall({ action: "add_items", list_id: 1, items: [{ title: "Wire it" }] }).ok,
    ).toBe(true);
    expect(
      validateTrackerCall({
        action: "add_items",
        list_id: 1,
        items: [
          {
            title: "Wire it",
            description: "detail",
            refs: [{ kind: "path", path: "src/a.ts" }],
            produces: [{ path: "out.md" }],
            deps: ["Work:1"],
          },
        ],
      }).ok,
    ).toBe(true);

    // Every entry is an item object with a title.
    expect(validateTrackerCall({ action: "add_items", list_id: 1, items: ["a"] }).ok).toBe(false);
    // The old title container is an unknown parameter now.
    const old = validateTrackerCall({ action: "add_items", list_id: 1, title: "Wire it" });
    expect(old.ok).toBe(false);
    if (!old.ok) expect(old.message).toContain("items");
  });

  it("rejects an add_items entry that carries an item_id", () => {
    const result = validateTrackerCall({
      action: "add_items",
      list_id: 1,
      items: [{ item_id: "Work:1", title: "a" }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("item_id");
  });

  it("rejects an update_items entry without an item_id", () => {
    const result = validateTrackerCall({
      action: "update_items",
      list_id: 1,
      items: [{ title: "a" }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("item_id");
  });

  it("requires a title string in each add_items entry and points at the description", () => {
    const result = validateTrackerCall({
      action: "add_items",
      list_id: 1,
      items: [{ description: "x" }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("title");
      expect(result.message).toContain("description");
    }
  });

  it("rejects a bare string in create_list's initial_items", () => {
    const result = validateTrackerCall({
      action: "create_list",
      name: "Work",
      initial_items: ["a"],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("item object");
  });

  it("rejects a title over the cap and names the description", () => {
    const result = validateTrackerCall({
      action: "add_items",
      list_id: 1,
      items: [{ title: "a".repeat(TITLE_LIMIT + 1) }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain(String(TITLE_LIMIT));
      expect(result.message).toContain("description");
    }
    // The cap is inclusive: a title at the limit passes.
    expect(
      validateTrackerCall({
        action: "add_items",
        list_id: 1,
        items: [{ title: "a".repeat(TITLE_LIMIT) }],
      }).ok,
    ).toBe(true);
  });

  it("rejects an over-cap title in create_list's initial_items", () => {
    const result = validateTrackerCall({
      action: "create_list",
      name: "Work",
      initial_items: [{ title: "a".repeat(TITLE_LIMIT + 1) }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain(String(TITLE_LIMIT));
      expect(result.message).toContain("description");
    }
  });

  it("rejects a reference without a kind, naming the accepted kinds", () => {
    const result = validateTrackerCall({
      action: "add_items",
      list_id: 1,
      items: [{ title: "x", refs: [{ path: "src/a.ts" }] }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("kind");
      expect(result.message).toContain("path");
      expect(result.message).toContain("decision");
    }
  });

  it("rejects a path reference without a path", () => {
    const result = validateTrackerCall({
      action: "add_items",
      list_id: 1,
      items: [{ title: "x", refs: [{ kind: "path", symbol: "route" }] }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("path");
  });

  it("accepts declared references and products in every shape", () => {
    const calls: Array<Record<string, unknown>> = [
      {
        action: "add_items",
        list_id: 1,
        items: [{ title: "x", refs: [{ kind: "path", path: "src/a.ts" }] }],
      },
      {
        action: "add_items",
        list_id: 1,
        items: [{ title: "x", refs: [{ kind: "decision", topic: "t" }] }],
      },
      {
        action: "add_items",
        list_id: 1,
        items: [{ title: "x", produces: [{ path: "docs/a.md" }] }],
      },
      {
        action: "create_list",
        name: "W",
        initial_items: [{ title: "a", refs: [{ kind: "decision", topic: "t" }] }],
      },
      { action: "update_items", item_id: "W:1", refs: [{ kind: "path", path: "src/a.ts" }] },
      {
        action: "update_items",
        list_id: 1,
        items: [{ item_id: "W:1", produces: [{ path: "a.md" }] }],
      },
    ];
    for (const call of calls) {
      expect(Value.Check(TrackerToolParams, call), JSON.stringify(call)).toBe(true);
      expect(validateTrackerCall(call).ok, JSON.stringify(call)).toBe(true);
    }
  });

  it("carries the declaration guidance in the tool description", () => {
    const description = TRACKER_TOOL_METADATA.description;
    expect(description).toContain("one short action line");
    expect(description).toMatch(/Declare a reference/);
    expect(description).toMatch(/declare a product/i);
    expect(description).toMatch(/Both are optional/);
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
      { action: "create_list", name: "Work", initial_items: [{ title: "a", deps: ["Work:1"] }] },
      {
        action: "create_list",
        name: "Work",
        initial_items: [{ title: "a" }, { title: "b", deps: ["Work:1"] }],
      },
      { action: "add_items", list_id: 1, items: [{ title: "b", deps: ["Work:1"] }] },
      {
        action: "add_items",
        list_id: 1,
        items: [{ title: "a" }, { title: "b", deps: ["Work:1"] }],
      },
      { action: "update_items", item_id: "Work:2", deps: ["Work:1"] },
      { action: "update_items", item_id: "Work:2", deps: [] },
      { action: "update_items", list_id: 1, items: [{ item_id: "Work:2", deps: ["Work:1"] }] },
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

  it("rejects a top-level deps list on add_items", () => {
    const result = validateTrackerCall({
      action: "add_items",
      list_id: 1,
      items: [{ title: "a" }],
      deps: ["Work:1"],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("deps");
  });

  it("rejects a batch entry that carries both an item_id and a stray index", () => {
    expect(
      Value.Check(TrackerToolParams, {
        action: "update_items",
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

describe("blockedDoneNote (advisory done-blocked guard)", () => {
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
                title: `item ${index + 1}`,
                done: done.includes(index),
                deps: itemDeps,
              }),
          ),
        }),
      ],
    });

  it("notes the done dependents of a reopened item", () => {
    const state = stateWith([[], ["Work:1"]], [1]);

    const note = blockedDoneNote([{ id: "Work:1", done: false }], state);

    expect(note).not.toBeNull();
    expect(note).toContain("Work:2");
    expect(note).toContain("done but blocked");
  });

  it("is silent when a patch leaves no done item unsatisfied", () => {
    const state = stateWith([[], ["Work:1"]], [1]);

    expect(blockedDoneNote([{ id: "Work:1", done: true }], state)).toBeNull();
    expect(blockedDoneNote([{ id: "Work:1", title: "new" }], state)).toBeNull();
    expect(blockedDoneNote([], state)).toBeNull();
  });

  it("notes a done item that a dependency edit left waiting", () => {
    const state = stateWith([[], ["Work:1"]], [1]);

    const note = blockedDoneNote([{ id: "Work:2", deps: ["Work:1"] }], state);

    expect(note).not.toBeNull();
    expect(note).toContain("Work:2 is done but now waits on Work:1");
  });

  it("is silent when a dependency edit leaves a done item satisfied", () => {
    const done = stateWith([[], ["Work:1"]], [0, 1]);
    expect(blockedDoneNote([{ id: "Work:2", deps: ["Work:1"] }], done)).toBeNull();
    // Clearing is never a problem, and an open item's annotation already
    // reports its own blockers.
    expect(blockedDoneNote([{ id: "Work:2", deps: [] }], done)).toBeNull();
    expect(
      blockedDoneNote([{ id: "Work:2", deps: ["Work:1"] }], stateWith([[], ["Work:1"]], [])),
    ).toBeNull();
  });

  it("names an item once when a reopen and a dependency edit both hit it", () => {
    const state = stateWith([[], ["Work:1"]], [1]);

    const note = blockedDoneNote(
      [
        { id: "Work:1", done: false },
        { id: "Work:2", deps: ["Work:1"] },
      ],
      state,
    );

    expect(note?.match(/Work:2/g) ?? []).toHaveLength(1);
  });

  it("is silent when no dependent is done", () => {
    const state = stateWith([[], ["Work:1"]], []);

    expect(blockedDoneNote([{ id: "Work:1", done: false }], state)).toBeNull();
  });

  it("ignores a patch id that does not resolve", () => {
    const state = stateWith([[], ["Work:1"]], [1]);

    expect(blockedDoneNote([{ id: "?", done: false }], state)).toBeNull();
    expect(blockedDoneNote([{ id: "Other:1", done: false }], state)).toBeNull();
    expect(blockedDoneNote([{ id: "Work:9", done: false }], state)).toBeNull();
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
    // A dependency-free list carries no blocked-by marker and no Ready now
    // line, so the description has to say what that means.
    expect(TRACKER_TOOL_METADATA.description).toContain("without a blocked-by marker");
    // The done-row annotation and the batch order rule are stated too.
    expect(TRACKER_TOOL_METADATA.description).toContain("waiting on");
    expect(TRACKER_TOOL_METADATA.description).toContain("Patches apply in order");
  });

  it("runs tool calls sequentially to avoid mutation races", () => {
    expect(TRACKER_TOOL_METADATA.executionMode).toBe("sequential");
  });
});
