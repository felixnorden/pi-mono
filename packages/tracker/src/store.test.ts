import { assert, layer } from "@effect/vitest";
import { Effect, Option, Result } from "effect";
import { TodoList, TrackerState, emptyState } from "./domain.ts";
import { TrackerStore } from "./store.ts";

/**
 * The suite shares one `TrackerStore.layer` (one `Ref`), so every test starts
 * from a known state via `reset(emptyState())`.
 */
layer(TrackerStore.layer)("TrackerStore", (it) => {
  it.effect("createList adds a list and advances the counter", () =>
    Effect.gen(function* () {
      const store = yield* TrackerStore;
      yield* store.reset(emptyState());

      const list = yield* store.createList("Work");
      assert.strictEqual(list.id, 1);
      assert.deepStrictEqual(list.items, []);

      const state = yield* store.state;
      assert.strictEqual(state.lists.length, 1);
      assert.strictEqual(state.lists[0]?.name, "Work");
      assert.strictEqual(state.nextListId, 2);
    }),
  );

  it.effect("createList trims whitespace", () =>
    Effect.gen(function* () {
      const store = yield* TrackerStore;
      yield* store.reset(emptyState());

      const list = yield* store.createList("  Work  ");
      assert.strictEqual(list.name, "Work");
    }),
  );

  it.effect("createList rejects empty names", () =>
    Effect.gen(function* () {
      const store = yield* TrackerStore;
      yield* store.reset(emptyState());

      for (const bad of ["", "   "]) {
        const result = yield* Effect.result(store.createList(bad));
        assert(Result.isFailure(result), `expected "${bad}" to be rejected`);
        const failure = Option.getOrThrow(Result.getFailure(result));
        assert.strictEqual(failure.reason, "EmptyText");
        assert.strictEqual(failure._tag, "TrackerError");
      }
    }),
  );

  it.effect("createList rejects duplicate names (case-sensitive)", () =>
    Effect.gen(function* () {
      const store = yield* TrackerStore;
      yield* store.reset(emptyState());

      yield* store.createList("Work");
      const result = yield* Effect.result(store.createList("Work"));
      assert(Result.isFailure(result));
      assert.strictEqual(Option.getOrThrow(Result.getFailure(result)).reason, "DuplicateListName");

      // Different case is a different name.
      const other = yield* store.createList("work");
      assert.strictEqual(other.id, 2);
    }),
  );

  it.effect("createList makes the first list active", () =>
    Effect.gen(function* () {
      const store = yield* TrackerStore;
      yield* store.reset(emptyState());

      const list = yield* store.createList("Work");
      const state = yield* store.state;
      assert.strictEqual(state.activeListId, list.id);
    }),
  );

  it.effect("createList switches to the new list by default (activate opt-out)", () =>
    Effect.gen(function* () {
      const store = yield* TrackerStore;
      yield* store.reset(emptyState());

      const a = yield* store.createList("A");
      const b = yield* store.createList("B");
      assert.strictEqual((yield* store.state).activeListId, b.id);
      assert.notStrictEqual(b.id, a.id);
    }),
  );

  it.effect("createList with activate=false keeps the current active list", () =>
    Effect.gen(function* () {
      const store = yield* TrackerStore;
      yield* store.reset(emptyState());

      const a = yield* store.createList("A");
      yield* store.createList("B", { activate: false });
      assert.strictEqual((yield* store.state).activeListId, a.id);
    }),
  );

  it.effect("createList with activate=false on an empty state leaves no active list", () =>
    Effect.gen(function* () {
      const store = yield* TrackerStore;
      yield* store.reset(emptyState());

      yield* store.createList("A", { activate: false });
      assert.strictEqual((yield* store.state).activeListId, null);
    }),
  );

  it.effect("createList with initial items creates the list with its items in one call", () =>
    Effect.gen(function* () {
      const store = yield* TrackerStore;
      yield* store.reset(emptyState());

      const list = yield* store.createList("Work", { initialItems: ["a", "b"] });
      assert.strictEqual(list.id, 1);
      assert.deepStrictEqual(
        list.items.map((i) => [i.text, i.done]),
        [
          ["a", false],
          ["b", false],
        ],
      );

      const state = yield* store.state;
      assert.strictEqual(state.nextListId, 2);
      assert.strictEqual(state.activeListId, list.id); // activates by default
    }),
  );

  it.effect("createList trims initial item texts", () =>
    Effect.gen(function* () {
      const store = yield* TrackerStore;
      yield* store.reset(emptyState());

      const list = yield* store.createList("Work", { initialItems: ["  a  ", "b"] });
      assert.deepStrictEqual(
        list.items.map((i) => i.text),
        ["a", "b"],
      );
    }),
  );

  it.effect("createList rejects empty initial item texts atomically", () =>
    Effect.gen(function* () {
      const store = yield* TrackerStore;
      yield* store.reset(emptyState());

      const before = yield* store.state;
      for (const bad of [["a", ""], ["a", "   "], [""]]) {
        const result = yield* Effect.result(store.createList("Work", { initialItems: bad }));
        assert(Result.isFailure(result), JSON.stringify(bad));
        assert.strictEqual(Option.getOrThrow(Result.getFailure(result)).reason, "EmptyText");
        // No list, no items, no counter movement.
        assert.deepStrictEqual(yield* store.state, before);
      }
    }),
  );

  it.effect("createList with initial items and activate=false keeps the previous active list", () =>
    Effect.gen(function* () {
      const store = yield* TrackerStore;
      yield* store.reset(emptyState());

      const a = yield* store.createList("A");
      const b = yield* store.createList("B", { initialItems: ["x"], activate: false });
      assert.strictEqual((yield* store.state).activeListId, a.id);
      assert.strictEqual((yield* store.state).lists[1]?.items.length, 1);
      assert.strictEqual(b.items.length, 1);
    }),
  );

  it.effect("createList rejects duplicate names even with initial items", () =>
    Effect.gen(function* () {
      const store = yield* TrackerStore;
      yield* store.reset(emptyState());

      yield* store.createList("Work");
      const result = yield* Effect.result(store.createList("Work", { initialItems: ["x"] }));
      assert(Result.isFailure(result));
      assert.strictEqual(Option.getOrThrow(Result.getFailure(result)).reason, "DuplicateListName");
    }),
  );

  it.effect("deleting the active list clears it; creating again re-activates", () =>
    Effect.gen(function* () {
      const store = yield* TrackerStore;
      yield* store.reset(emptyState());

      const a = yield* store.createList("A");
      yield* store.deleteList(a.id);
      assert.strictEqual((yield* store.state).activeListId, null);

      const c = yield* store.createList("C");
      assert.strictEqual((yield* store.state).activeListId, c.id);
    }),
  );

  it.effect("setActiveList with null clears the active list (deselect)", () =>
    Effect.gen(function* () {
      const store = yield* TrackerStore;
      yield* store.reset(emptyState());

      yield* store.createList("A");
      yield* store.setActiveList(null);
      assert.strictEqual((yield* store.state).activeListId, null);
    }),
  );

  it.effect("deleteList removes the list and resets the active pointer", () =>
    Effect.gen(function* () {
      const store = yield* TrackerStore;
      yield* store.reset(emptyState());

      const a = yield* store.createList("A");
      yield* store.createList("B");
      yield* store.setActiveList(a.id);
      yield* store.deleteList(a.id);

      const state = yield* store.state;
      assert.strictEqual(state.lists.length, 1);
      assert.strictEqual(state.lists[0]?.name, "B");
      assert.strictEqual(state.activeListId, null);
    }),
  );

  it.effect("deleteList keeps the active pointer when deleting another list", () =>
    Effect.gen(function* () {
      const store = yield* TrackerStore;
      yield* store.reset(emptyState());

      const a = yield* store.createList("A");
      const b = yield* store.createList("B");
      yield* store.setActiveList(a.id);
      yield* store.deleteList(b.id);

      const state = yield* store.state;
      assert.strictEqual(state.activeListId, a.id);
    }),
  );

  it.effect("deleteList fails for an unknown list", () =>
    Effect.gen(function* () {
      const store = yield* TrackerStore;
      yield* store.reset(emptyState());

      const result = yield* Effect.result(store.deleteList(99));
      assert(Result.isFailure(result));
      const failure = Option.getOrThrow(Result.getFailure(result));
      assert.strictEqual(failure.reason, "ListNotFound");
      assert.strictEqual(failure.listId, 99); // optional field populated
    }),
  );

  it.effect("setActiveList accepts null to clear and rejects unknown ids", () =>
    Effect.gen(function* () {
      const store = yield* TrackerStore;
      yield* store.reset(emptyState());

      const a = yield* store.createList("A");
      yield* store.setActiveList(a.id);
      assert.strictEqual((yield* store.state).activeListId, a.id);

      yield* store.setActiveList(null);
      assert.strictEqual((yield* store.state).activeListId, null);

      const bad = yield* Effect.result(store.setActiveList(7));
      assert(Result.isFailure(bad));
      assert.strictEqual(Option.getOrThrow(Result.getFailure(bad)).reason, "ListNotFound");
    }),
  );

  it.effect("addItem appends a pending item", () =>
    Effect.gen(function* () {
      const store = yield* TrackerStore;
      yield* store.reset(emptyState());

      const list = yield* store.createList("Work");
      const item = yield* store.addItem(list.id, "write plan");
      assert.strictEqual(item.text, "write plan");
      assert.strictEqual(item.done, false);

      const state = yield* store.state;
      assert.strictEqual(state.lists[0]?.items.length, 1);
    }),
  );

  it.effect("addItem trims text and rejects empty text", () =>
    Effect.gen(function* () {
      const store = yield* TrackerStore;
      yield* store.reset(emptyState());

      const list = yield* store.createList("Work");
      const item = yield* store.addItem(list.id, "  ship  ");
      assert.strictEqual(item.text, "ship");

      for (const bad of ["", "   "]) {
        const result = yield* Effect.result(store.addItem(list.id, bad));
        assert(Result.isFailure(result), `expected "${bad}" to be rejected`);
        assert.strictEqual(Option.getOrThrow(Result.getFailure(result)).reason, "EmptyText");
      }
    }),
  );

  it.effect("addItems appends several items in order", () =>
    Effect.gen(function* () {
      const store = yield* TrackerStore;
      yield* store.reset(emptyState());

      const list = yield* store.createList("Work");
      const items = yield* store.addItems(list.id, ["a", "b", "c"]);
      assert.deepStrictEqual(
        items.map((i) => [i.text, i.done]),
        [
          ["a", false],
          ["b", false],
          ["c", false],
        ],
      );

      const state = yield* store.state;
      assert.deepStrictEqual(
        state.lists[0]?.items.map((i) => i.text),
        ["a", "b", "c"],
      );
    }),
  );

  it.effect("addItems trims texts", () =>
    Effect.gen(function* () {
      const store = yield* TrackerStore;
      yield* store.reset(emptyState());

      const list = yield* store.createList("Work");
      const items = yield* store.addItems(list.id, ["  a  ", "b"]);
      assert.deepStrictEqual(
        items.map((i) => i.text),
        ["a", "b"],
      );
    }),
  );

  it.effect("addItems rejects empty texts atomically", () =>
    Effect.gen(function* () {
      const store = yield* TrackerStore;
      yield* store.reset(emptyState());

      const list = yield* store.createList("Work");
      const before = yield* store.state;

      for (const bad of [["a", ""], ["a", "   "], [""]]) {
        const result = yield* Effect.result(store.addItems(list.id, bad));
        assert(Result.isFailure(result), JSON.stringify(bad));
        assert.strictEqual(Option.getOrThrow(Result.getFailure(result)).reason, "EmptyText");
        assert.deepStrictEqual(yield* store.state, before);
      }
    }),
  );

  it.effect("addItem fails for an unknown list", () =>
    Effect.gen(function* () {
      const store = yield* TrackerStore;
      yield* store.reset(emptyState());

      const result = yield* Effect.result(store.addItem(42, "x"));
      assert(Result.isFailure(result));
      assert.strictEqual(Option.getOrThrow(Result.getFailure(result)).reason, "ListNotFound");
    }),
  );

  it.effect("addItems fails for an unknown list", () =>
    Effect.gen(function* () {
      const store = yield* TrackerStore;
      yield* store.reset(emptyState());

      const result = yield* Effect.result(store.addItems(42, ["x"]));
      assert(Result.isFailure(result));
      assert.strictEqual(Option.getOrThrow(Result.getFailure(result)).reason, "ListNotFound");
    }),
  );

  it.effect("addItems with a single text behaves like addItem", () =>
    Effect.gen(function* () {
      const store = yield* TrackerStore;
      yield* store.reset(emptyState());

      const list = yield* store.createList("Work");
      const items = yield* store.addItems(list.id, ["write plan"]);
      assert.strictEqual(items.length, 1);
      assert.strictEqual(items[0]?.text, "write plan");
      assert.strictEqual(items[0]?.done, false);
    }),
  );

  it.effect("updateItem sets done", () =>
    Effect.gen(function* () {
      const store = yield* TrackerStore;
      yield* store.reset(emptyState());

      const list = yield* store.createList("Work");
      yield* store.addItem(list.id, "write plan");
      const updated = yield* store.updateItem("Work:1", { done: true });
      assert.strictEqual(updated.done, true);
      assert.strictEqual(updated.text, "write plan");

      const state = yield* store.state;
      assert.strictEqual(state.lists[0]?.items[0]?.done, true);
    }),
  );

  it.effect("updateItem sets the task text", () =>
    Effect.gen(function* () {
      const store = yield* TrackerStore;
      yield* store.reset(emptyState());

      const list = yield* store.createList("Work");
      yield* store.addItem(list.id, "write plan");
      const updated = yield* store.updateItem("Work:1", { text: "ship it" });
      assert.strictEqual(updated.text, "ship it");
      assert.strictEqual(updated.done, false); // untouched field preserved

      const state = yield* store.state;
      assert.strictEqual(state.lists[0]?.items[0]?.text, "ship it");
    }),
  );

  it.effect("updateItem combines text and done in one patch", () =>
    Effect.gen(function* () {
      const store = yield* TrackerStore;
      yield* store.reset(emptyState());

      const list = yield* store.createList("Work");
      yield* store.addItem(list.id, "write plan");
      const updated = yield* store.updateItem("Work:1", { text: "done!", done: true });
      assert.strictEqual(updated.text, "done!");
      assert.strictEqual(updated.done, true);
    }),
  );

  it.effect("updateItem with an empty patch is a no-op", () =>
    Effect.gen(function* () {
      const store = yield* TrackerStore;
      yield* store.reset(emptyState());

      const list = yield* store.createList("Work");
      yield* store.addItem(list.id, "write plan");
      const stateBefore = yield* store.state;
      const result = yield* store.updateItem("Work:1", {});
      const stateAfter = yield* store.state;

      assert.strictEqual(result.text, "write plan");
      assert.deepStrictEqual(stateAfter, stateBefore);
    }),
  );

  it.effect("updateItem rejects empty task text", () =>
    Effect.gen(function* () {
      const store = yield* TrackerStore;
      yield* store.reset(emptyState());

      const list = yield* store.createList("Work");
      yield* store.addItem(list.id, "write plan");
      const stateBefore = yield* store.state;

      const result = yield* Effect.result(store.updateItem("Work:1", { text: "  " }));
      assert(Result.isFailure(result));
      assert.strictEqual(Option.getOrThrow(Result.getFailure(result)).reason, "EmptyText");

      // State unchanged after the failed mutation.
      assert.deepStrictEqual(yield* store.state, stateBefore);
    }),
  );

  it.effect("updateItems applies several patches in one call", () =>
    Effect.gen(function* () {
      const store = yield* TrackerStore;
      yield* store.reset(emptyState());

      const list = yield* store.createList("Work");
      yield* store.addItems(list.id, ["a", "b", "c"]);

      const updated = yield* store.updateItems([
        { itemId: "Work:1", done: true },
        { itemId: "Work:2", text: "bee" },
        { itemId: "Work:3", text: "sea", done: true },
      ]);
      // Returned in patch order, with the final state of each item.
      assert.deepStrictEqual(
        updated.map((i) => [i.text, i.done]),
        [
          ["a", true],
          ["bee", false],
          ["sea", true],
        ],
      );

      const state = yield* store.state;
      assert.deepStrictEqual(
        state.lists[0]?.items.map((i) => [i.text, i.done]),
        [
          ["a", true],
          ["bee", false],
          ["sea", true],
        ],
      );
    }),
  );

  it.effect("updateItems with all-empty patches is a no-op", () =>
    Effect.gen(function* () {
      const store = yield* TrackerStore;
      yield* store.reset(emptyState());

      const list = yield* store.createList("Work");
      yield* store.addItem(list.id, "a");
      const before = yield* store.state;

      const result = yield* store.updateItems([{ itemId: "Work:1" }, { itemId: "Work:1" }]);
      assert.deepStrictEqual(
        result.map((i) => i.text),
        ["a", "a"],
      );
      assert.deepStrictEqual(yield* store.state, before);
    }),
  );

  it.effect("updateItems rejects empty replacement text atomically", () =>
    Effect.gen(function* () {
      const store = yield* TrackerStore;
      yield* store.reset(emptyState());

      const list = yield* store.createList("Work");
      yield* store.addItem(list.id, "a");
      const before = yield* store.state;

      const result = yield* Effect.result(
        store.updateItems([
          { itemId: "Work:1", done: true },
          { itemId: "Work:1", text: "  " },
        ]),
      );
      assert(Result.isFailure(result));
      assert.strictEqual(Option.getOrThrow(Result.getFailure(result)).reason, "EmptyText");
      assert.deepStrictEqual(yield* store.state, before);
    }),
  );

  it.effect("updateItems fails atomically when any item is missing", () =>
    Effect.gen(function* () {
      const store = yield* TrackerStore;
      yield* store.reset(emptyState());

      const list = yield* store.createList("Work");
      yield* store.addItem(list.id, "a");
      const before = yield* store.state;

      const noList = yield* Effect.result(store.updateItems([{ itemId: "Nope:1", done: true }]));
      assert(Result.isFailure(noList));
      const noListFailure = Option.getOrThrow(Result.getFailure(noList));
      assert.strictEqual(noListFailure.reason, "ItemNotFound");
      assert.strictEqual(noListFailure.itemId, "Nope:1");

      const noItem = yield* Effect.result(
        store.updateItems([
          { itemId: "Work:1", done: true },
          { itemId: "Work:99", done: true },
        ]),
      );
      assert(Result.isFailure(noItem));
      const failure = Option.getOrThrow(Result.getFailure(noItem));
      assert.strictEqual(failure.reason, "ItemNotFound");
      assert.strictEqual(failure.itemId, "Work:99");
      // The valid patch in the batch was not applied.
      assert.deepStrictEqual(yield* store.state, before);
    }),
  );

  it.effect("updateItems with duplicate item ids: the last patch wins", () =>
    Effect.gen(function* () {
      const store = yield* TrackerStore;
      yield* store.reset(emptyState());

      const list = yield* store.createList("Work");
      yield* store.addItem(list.id, "a");

      const updated = yield* store.updateItems([
        { itemId: "Work:1", text: "first" },
        { itemId: "Work:1", text: "second", done: true },
      ]);
      assert.deepStrictEqual(
        updated.map((i) => [i.text, i.done]),
        [
          ["second", true],
          ["second", true],
        ],
      );
      assert.deepStrictEqual(
        (yield* store.state).lists[0]?.items.map((i) => [i.text, i.done]),
        [["second", true]],
      );
    }),
  );

  it.effect("updateItems spans several lists in one atomic batch", () =>
    Effect.gen(function* () {
      const store = yield* TrackerStore;
      yield* store.reset(emptyState());

      const work = yield* store.createList("Work");
      yield* store.addItem(work.id, "a");
      yield* store.addItem(work.id, "b");
      const home = yield* store.createList("Home", { activate: false });
      yield* store.addItem(home.id, "c");

      const updated = yield* store.updateItems([
        { itemId: "Work:1", done: true },
        { itemId: "Home:1", text: "water plants" },
      ]);
      assert.deepStrictEqual(
        updated.map((i) => [i.text, i.done]),
        [
          ["a", true],
          ["water plants", false],
        ],
      );

      const state = yield* store.state;
      assert.deepStrictEqual(
        state.lists[0]?.items.map((i) => [i.text, i.done]),
        [
          ["a", true],
          ["b", false],
        ],
      );
      assert.deepStrictEqual(
        state.lists[1]?.items.map((i) => [i.text, i.done]),
        [["water plants", false]],
      );
    }),
  );

  it.effect("updateItem rejects malformed ids with a format hint", () =>
    Effect.gen(function* () {
      const store = yield* TrackerStore;
      yield* store.reset(emptyState());

      yield* store.createList("Work");
      for (const bad of ["Work", "Work:", ":1", "Work:0", "Work:x", "Work:007"]) {
        const result = yield* Effect.result(store.updateItem(bad, { done: true }));
        assert(Result.isFailure(result), `expected "${bad}" to be rejected`);
        const failure = Option.getOrThrow(Result.getFailure(result));
        assert.strictEqual(failure.reason, "ItemNotFound");
        assert.match(failure.message, /listName:index/);
      }
    }),
  );

  it.effect("updateItem fails for unknown list or item", () =>
    Effect.gen(function* () {
      const store = yield* TrackerStore;
      yield* store.reset(emptyState());

      const list = yield* store.createList("Work");
      yield* store.addItem(list.id, "write plan");

      const noList = yield* Effect.result(store.updateItem("Nope:1", { done: true }));
      assert(Result.isFailure(noList));
      const noListFailure = Option.getOrThrow(Result.getFailure(noList));
      assert.strictEqual(noListFailure.reason, "ItemNotFound");
      assert.match(noListFailure.message, /no list named "Nope"/);
      assert.match(noListFailure.message, /Work/); // names the available list

      const noItem = yield* Effect.result(store.updateItem("Work:99", { done: true }));
      assert(Result.isFailure(noItem));
      const failure = Option.getOrThrow(Result.getFailure(noItem));
      assert.strictEqual(failure.reason, "ItemNotFound");
      assert.strictEqual(failure.listId, list.id);
      assert.strictEqual(failure.itemId, "Work:99");
      assert.match(failure.message, /Work:1/); // lists the available ids
    }),
  );

  it.effect("removeItem removes only the target item (positions shift implicitly)", () =>
    Effect.gen(function* () {
      const store = yield* TrackerStore;
      yield* store.reset(emptyState());

      const list = yield* store.createList("Work");
      yield* store.addItem(list.id, "a");
      yield* store.addItem(list.id, "b");
      yield* store.addItem(list.id, "c");

      yield* store.removeItem("Work:2");

      const state = yield* store.state;
      const items = state.lists[0]?.items ?? [];
      assert.deepStrictEqual(
        items.map((i) => i.text),
        ["a", "c"],
      );
    }),
  );

  it.effect("removeItem fails for unknown list or item", () =>
    Effect.gen(function* () {
      const store = yield* TrackerStore;
      yield* store.reset(emptyState());

      const list = yield* store.createList("Work");
      yield* store.addItem(list.id, "a");

      const noList = yield* Effect.result(store.removeItem("Nope:1"));
      assert(Result.isFailure(noList));
      assert.strictEqual(Option.getOrThrow(Result.getFailure(noList)).reason, "ItemNotFound");

      const noItem = yield* Effect.result(store.removeItem("Work:99"));
      assert(Result.isFailure(noItem));
      assert.strictEqual(Option.getOrThrow(Result.getFailure(noItem)).reason, "ItemNotFound");
    }),
  );

  it.effect("failed mutations leave the state untouched", () =>
    Effect.gen(function* () {
      const store = yield* TrackerStore;
      yield* store.reset(emptyState());

      const list = yield* store.createList("Work");
      yield* store.addItem(list.id, "keep me");

      const before = yield* store.state;
      yield* Effect.result(store.addItem(999, "x")); // ListNotFound
      yield* Effect.result(store.addItem(list.id, "   ")); // EmptyText
      yield* Effect.result(store.updateItem("Work:999", { done: true })); // ItemNotFound
      yield* Effect.result(store.deleteList(999)); // ListNotFound
      yield* Effect.result(store.createList("Work")); // DuplicateListName
      yield* Effect.result(store.setActiveList(999)); // ListNotFound
      const after = yield* store.state;

      assert.deepStrictEqual(after, before);
    }),
  );

  it.effect("item references are positional (listName:index) and shift after removal", () =>
    Effect.gen(function* () {
      const store = yield* TrackerStore;
      yield* store.reset(emptyState());

      const a = yield* store.createList("A");
      const b = yield* store.createList("B");
      yield* store.deleteList(a.id);
      const c = yield* store.createList("C");
      yield* store.addItem(b.id, "one");
      yield* store.addItem(b.id, "two");

      // "B:1" is position 1, "B:2" position 2 — not session-wide counters.
      const first = yield* store.updateItem("B:1", { done: true });
      assert.strictEqual(first.text, "one");
      assert.strictEqual(first.done, true);

      // Removing position 1 shifts the rest: "two" becomes "B:1".
      yield* store.removeItem("B:1");
      const shifted = yield* store.updateItem("B:1", { done: true });
      assert.strictEqual(shifted.text, "two");

      // New items take the next free position.
      yield* store.addItem(b.id, "three");
      const third = yield* store.updateItem("B:2", { done: true });
      assert.strictEqual(third.text, "three");

      // List ids are still strictly monotonic, never reused after deletes.
      assert.strictEqual(c.id, 3);
      assert.strictEqual((yield* store.state).nextListId, 4);
    }),
  );

  it.effect("list names may contain colons (ids split on the last colon)", () =>
    Effect.gen(function* () {
      const store = yield* TrackerStore;
      yield* store.reset(emptyState());

      const list = yield* store.createList("Work:2024");
      yield* store.addItem(list.id, "a");

      const updated = yield* store.updateItem("Work:2024:1", { done: true });
      assert.strictEqual(updated.text, "a");
      assert.strictEqual(updated.done, true);
    }),
  );

  it.effect("reset replaces the whole state", () =>
    Effect.gen(function* () {
      const store = yield* TrackerStore;
      yield* store.reset(emptyState());

      yield* store.createList("A");
      const restored = new TrackerState({
        lists: [new TodoList({ id: 5, name: "R", items: [] })],
        activeListId: 5,
        nextListId: 6,
      });
      yield* store.reset(restored);

      const state = yield* store.state;
      assert.deepStrictEqual(state, restored);
    }),
  );
});
