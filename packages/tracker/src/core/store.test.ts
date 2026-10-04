import { assert, layer } from "@effect/vitest";
import { Effect, Option, Result } from "effect";
import {
  TodoList,
  TrackerState,
  decodeStateEffect,
  emptyState,
  encodeState,
  migrateState,
} from "./domain.ts";
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

  it.effect("updateItems applies several patches within one list", () =>
    Effect.gen(function* () {
      const store = yield* TrackerStore;
      yield* store.reset(emptyState());

      const list = yield* store.createList("Work");
      yield* store.addItems(list.id, ["a", "b", "c"]);

      const updated = yield* store.updateItems(list.id, [
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
      assert.deepStrictEqual(
        (yield* store.state).lists[0]?.items.map((i) => [i.text, i.done]),
        [
          ["a", true],
          ["bee", false],
          ["sea", true],
        ],
      );
    }),
  );

  it.effect("updateItems fails atomically for an unknown item id", () =>
    Effect.gen(function* () {
      const store = yield* TrackerStore;
      yield* store.reset(emptyState());

      const list = yield* store.createList("Work");
      yield* store.addItem(list.id, "a");
      const before = yield* store.state;

      const result = yield* Effect.result(
        store.updateItems(list.id, [
          { itemId: "Work:1", done: true },
          { itemId: "Work:99", done: true },
        ]),
      );
      assert(Result.isFailure(result));
      assert.strictEqual(Option.getOrThrow(Result.getFailure(result)).reason, "ItemNotFound");
      // The valid patch in the batch was not applied.
      assert.deepStrictEqual(yield* store.state, before);
    }),
  );

  it.effect("updateItems fails for a missing list", () =>
    Effect.gen(function* () {
      const store = yield* TrackerStore;
      yield* store.reset(emptyState());

      const result = yield* Effect.result(
        store.updateItems(999, [{ itemId: "Work:1", done: true }]),
      );
      assert(Result.isFailure(result));
      assert.strictEqual(Option.getOrThrow(Result.getFailure(result)).reason, "ListNotFound");
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
        store.updateItems(list.id, [
          { itemId: "Work:1", done: true },
          { itemId: "Work:1", text: "  " },
        ]),
      );
      assert(Result.isFailure(result));
      assert.strictEqual(Option.getOrThrow(Result.getFailure(result)).reason, "EmptyText");
      assert.deepStrictEqual(yield* store.state, before);
    }),
  );

  it.effect("updateItems with duplicate item id: the last patch wins", () =>
    Effect.gen(function* () {
      const store = yield* TrackerStore;
      yield* store.reset(emptyState());

      const list = yield* store.createList("Work");
      yield* store.addItem(list.id, "a");

      const updated = yield* store.updateItems(list.id, [
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
        assert.match(failure.message, /listName:id/);
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

  it.effect("removeItem removes only the target item (later ids stay stable)", () =>
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

  it.effect("item references are stable ids (listName:id) and survive removal", () =>
    Effect.gen(function* () {
      const store = yield* TrackerStore;
      yield* store.reset(emptyState());

      const a = yield* store.createList("A");
      const b = yield* store.createList("B");
      yield* store.deleteList(a.id);
      const c = yield* store.createList("C");
      yield* store.addItem(b.id, "one");
      yield* store.addItem(b.id, "two");

      // Ids are per-list counters, assigned in creation order.
      const first = yield* store.updateItem("B:1", { done: true });
      assert.strictEqual(first.text, "one");
      assert.strictEqual(first.done, true);

      // Removing "one" leaves a gap: "two" keeps id 2 instead of becoming B:1.
      yield* store.removeItem("B:1");
      const stale = yield* Effect.result(store.updateItem("B:1", { done: true }));
      assert(Result.isFailure(stale));
      const second = yield* store.updateItem("B:2", { done: true });
      assert.strictEqual(second.text, "two");

      // New items take the next counter value, never the gap.
      yield* store.addItem(b.id, "three");
      const third = yield* store.updateItem("B:3", { done: true });
      assert.strictEqual(third.text, "three");

      // List ids are still strictly monotonic, never reused after deletes.
      assert.strictEqual(c.id, 3);
      assert.strictEqual((yield* store.state).nextListId, 4);
    }),
  );

  it.effect("createList assigns sequential ids to initial items", () =>
    Effect.gen(function* () {
      const store = yield* TrackerStore;
      yield* store.reset(emptyState());

      const list = yield* store.createList("Work", { initialItems: ["a", "b", "c"] });

      assert.deepStrictEqual(
        list.items.map((i) => i.id),
        [1, 2, 3],
      );
      assert.strictEqual((yield* store.state).lists[0]?.nextItemId, 4);
    }),
  );

  it.effect("addItem assigns the list counter and advances it", () =>
    Effect.gen(function* () {
      const store = yield* TrackerStore;
      yield* store.reset(emptyState());

      const list = yield* store.createList("Work", { initialItems: ["a", "b"] });
      const item = yield* store.addItem(list.id, "c");

      assert.strictEqual(item.id, 3);
      assert.strictEqual((yield* store.state).lists[0]?.nextItemId, 4);
    }),
  );

  it.effect("removeItem leaves a gap and does not renumber later items", () =>
    Effect.gen(function* () {
      const store = yield* TrackerStore;
      yield* store.reset(emptyState());

      yield* store.createList("Work", { initialItems: ["a", "b", "c"] });
      yield* store.removeItem("Work:2");

      const list = (yield* store.state).lists[0];
      assert.deepStrictEqual(
        list?.items.map((i) => i.id),
        [1, 3],
      );
      assert.strictEqual(list?.nextItemId, 4);
    }),
  );

  it.effect("a removed id is never reused", () =>
    Effect.gen(function* () {
      const store = yield* TrackerStore;
      yield* store.reset(emptyState());

      const list = yield* store.createList("Work", { initialItems: ["a", "b", "c"] });
      yield* store.removeItem("Work:2");
      const item = yield* store.addItem(list.id, "d");

      assert.strictEqual(item.id, 4);
      assert.deepStrictEqual(
        (yield* store.state).lists[0]?.items.map((i) => i.id),
        [1, 3, 4],
      );
    }),
  );

  it.effect("updateItem resolves by id, not by position", () =>
    Effect.gen(function* () {
      const store = yield* TrackerStore;
      yield* store.reset(emptyState());

      yield* store.createList("Work", { initialItems: ["a", "b", "c"] });
      yield* store.removeItem("Work:1");

      const updated = yield* store.updateItem("Work:3", { text: "cee" });

      assert.strictEqual(updated.text, "cee");
      assert.deepStrictEqual(
        (yield* store.state).lists[0]?.items.map((i) => [i.id, i.text]),
        [
          [2, "b"],
          [3, "cee"],
        ],
      );
    }),
  );

  it.effect("updateItem preserves the item id", () =>
    Effect.gen(function* () {
      const store = yield* TrackerStore;
      yield* store.reset(emptyState());

      yield* store.createList("Work", { initialItems: ["a"] });
      const updated = yield* store.updateItem("Work:1", { done: true, text: "ay" });

      assert.strictEqual(updated.id, 1);
      assert.strictEqual((yield* store.state).lists[0]?.nextItemId, 2);
    }),
  );

  it.effect("updateItems preserves every item id in the batch", () =>
    Effect.gen(function* () {
      const store = yield* TrackerStore;
      yield* store.reset(emptyState());

      const list = yield* store.createList("Work", { initialItems: ["a", "b", "c"] });
      const updated = yield* store.updateItems(list.id, [
        { itemId: "Work:1", done: true },
        { itemId: "Work:3", text: "cee" },
      ]);

      assert.deepStrictEqual(
        updated.map((i) => i.id),
        [1, 3],
      );
      assert.deepStrictEqual(
        (yield* store.state).lists[0]?.items.map((i) => i.id),
        [1, 2, 3],
      );
    }),
  );

  it.effect("the not-found message lists the available ids after a gap", () =>
    Effect.gen(function* () {
      const store = yield* TrackerStore;
      yield* store.reset(emptyState());

      yield* store.createList("Work", { initialItems: ["a", "b", "c"] });
      yield* store.removeItem("Work:2");
      const before = yield* store.state;

      const result = yield* Effect.result(store.updateItem("Work:9", { done: true }));
      assert(Result.isFailure(result));
      const failure = Option.getOrThrow(Result.getFailure(result));
      assert.strictEqual(failure.reason, "ItemNotFound");
      assert.match(failure.message, /Work:1/);
      assert.match(failure.message, /Work:3/);
      assert.equal(failure.message.includes("Work:2"), false);
      // A stale reference changes nothing.
      assert.deepStrictEqual(yield* store.state, before);
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

  it.effect("createList accepts initial items with dependencies", () =>
    Effect.gen(function* () {
      const store = yield* TrackerStore;
      yield* store.reset(emptyState());

      const list = yield* store.createList("Work", {
        initialItems: ["a", { text: "b", deps: ["Work:1"] }],
      });

      assert.deepStrictEqual(
        list.items.map((i) => i.deps),
        [[], ["Work:1"]],
      );
    }),
  );

  it.effect("addItems accepts a mix of bare strings and objects with dependencies", () =>
    Effect.gen(function* () {
      const store = yield* TrackerStore;
      yield* store.reset(emptyState());

      const list = yield* store.createList("Work");
      yield* store.addItem(list.id, "a");
      const items = yield* store.addItems(list.id, ["b", { text: "c", deps: ["Work:2"] }]);

      assert.deepStrictEqual(
        items.map((i) => i.id),
        [2, 3],
      );
      assert.deepStrictEqual(items[1]?.deps, ["Work:2"]);
    }),
  );

  it.effect("a dependency can name a sibling created by the same call", () =>
    Effect.gen(function* () {
      const store = yield* TrackerStore;
      yield* store.reset(emptyState());

      const list = yield* store.createList("Work");
      const items = yield* store.addItems(list.id, ["a", { text: "b", deps: ["Work:1"] }]);

      assert.deepStrictEqual(items[1]?.deps, ["Work:1"]);
    }),
  );

  it.effect("a dependency on a missing item is refused and leaves state untouched", () =>
    Effect.gen(function* () {
      const store = yield* TrackerStore;
      yield* store.reset(emptyState());

      const list = yield* store.createList("Work");
      yield* store.addItem(list.id, "a");
      const before = yield* store.state;

      const result = yield* Effect.result(store.addItem(list.id, "b", ["Work:9"]));

      assert(Result.isFailure(result));
      const failure = Option.getOrThrow(Result.getFailure(result));
      assert.strictEqual(failure.reason, "DependencyNotFound");
      assert.match(failure.message, /Work:9/);
      assert.deepStrictEqual(yield* store.state, before);
    }),
  );

  it.effect("a malformed dependency reference is refused", () =>
    Effect.gen(function* () {
      const store = yield* TrackerStore;
      yield* store.reset(emptyState());

      const list = yield* store.createList("Work");
      const before = yield* store.state;

      for (const bad of ["nonsense", "Work:0", ":1"]) {
        const result = yield* Effect.result(store.addItem(list.id, "a", [bad]));
        assert(Result.isFailure(result), `expected ${JSON.stringify(bad)} to be rejected`);
        const failure = Option.getOrThrow(Result.getFailure(result));
        assert.strictEqual(failure.reason, "DependencyNotFound");
        assert.match(failure.message, /listName:id/);
      }
      assert.deepStrictEqual(yield* store.state, before);
    }),
  );

  it.effect("a dependency on another list is refused", () =>
    Effect.gen(function* () {
      const store = yield* TrackerStore;
      yield* store.reset(emptyState());

      const work = yield* store.createList("Work");
      yield* store.createList("Home", { initialItems: ["x"] });
      const before = yield* store.state;

      const result = yield* Effect.result(store.addItem(work.id, "b", ["Home:1"]));

      assert(Result.isFailure(result));
      const failure = Option.getOrThrow(Result.getFailure(result));
      assert.strictEqual(failure.reason, "CrossListDependency");
      assert.match(failure.message, /Home:1/);
      assert.deepStrictEqual(yield* store.state, before);
    }),
  );

  it.effect("a dependency that closes a cycle is refused, with the path named", () =>
    Effect.gen(function* () {
      const store = yield* TrackerStore;
      yield* store.reset(emptyState());

      yield* store.createList("Work", {
        initialItems: ["a", { text: "b", deps: ["Work:1"] }],
      });
      const before = yield* store.state;

      const result = yield* Effect.result(store.updateItem("Work:1", { deps: ["Work:2"] }));

      assert(Result.isFailure(result));
      const failure = Option.getOrThrow(Result.getFailure(result));
      assert.strictEqual(failure.reason, "DependencyCycle");
      assert.match(failure.message, /Work:1/);
      assert.match(failure.message, /Work:2/);
      assert.deepStrictEqual(yield* store.state, before);
    }),
  );

  it.effect("deps replaces the dependency set, and an empty array clears it", () =>
    Effect.gen(function* () {
      const store = yield* TrackerStore;
      yield* store.reset(emptyState());

      yield* store.createList("Work", { initialItems: ["a", "b"] });
      yield* store.updateItem("Work:2", { deps: ["Work:1"] });
      assert.deepStrictEqual((yield* store.state).lists[0]?.items[1]?.deps, ["Work:1"]);

      yield* store.updateItem("Work:2", { deps: [] });
      assert.deepStrictEqual((yield* store.state).lists[0]?.items[1]?.deps, []);
    }),
  );

  it.effect("a cycle closed by a later batch patch is refused", () =>
    Effect.gen(function* () {
      const store = yield* TrackerStore;
      yield* store.reset(emptyState());

      const list = yield* store.createList("Work", { initialItems: ["a", "b"] });
      const before = yield* store.state;

      // Patches apply in order, so the first one is legal on its own and the
      // second closes the cycle. The batch fails atomically.
      const result = yield* Effect.result(
        store.updateItems(list.id, [
          { itemId: "Work:1", deps: ["Work:2"] },
          { itemId: "Work:2", deps: ["Work:1"] },
        ]),
      );

      assert(Result.isFailure(result));
      assert.strictEqual(Option.getOrThrow(Result.getFailure(result)).reason, "DependencyCycle");
      assert.deepStrictEqual(yield* store.state, before);
    }),
  );

  it.effect("a batch patch cannot make an item depend on itself", () =>
    Effect.gen(function* () {
      const store = yield* TrackerStore;
      yield* store.reset(emptyState());

      const list = yield* store.createList("Work", { initialItems: ["a"] });
      const before = yield* store.state;

      const result = yield* Effect.result(
        store.updateItems(list.id, [{ itemId: "Work:1", deps: ["Work:1"] }]),
      );

      assert(Result.isFailure(result));
      assert.strictEqual(Option.getOrThrow(Result.getFailure(result)).reason, "DependencyCycle");
      assert.deepStrictEqual(yield* store.state, before);
    }),
  );

  it.effect("dependencies survive an encode and restore round trip", () =>
    Effect.gen(function* () {
      const store = yield* TrackerStore;
      yield* store.reset(emptyState());

      yield* store.createList("Work", {
        initialItems: ["a", { text: "b", deps: ["Work:1"] }],
      });

      const snapshot = encodeState(yield* store.state);
      const restored = migrateState(yield* decodeStateEffect(snapshot));

      assert.deepStrictEqual(restored.lists[0]?.items[1]?.deps, ["Work:1"]);
      assert.strictEqual(restored.lists[0]?.items[1]?.id, 2);
    }),
  );

  it.effect("completing a blocked item is refused and leaves state untouched", () =>
    Effect.gen(function* () {
      const store = yield* TrackerStore;
      yield* store.reset(emptyState());

      yield* store.createList("Work", { initialItems: ["a", { text: "b", deps: ["Work:1"] }] });
      const before = yield* store.state;

      const result = yield* Effect.result(store.updateItem("Work:2", { done: true }));

      assert(Result.isFailure(result));
      const failure = Option.getOrThrow(Result.getFailure(result));
      assert.strictEqual(failure.reason, "ItemBlocked");
      assert.match(failure.message, /Work:1/);
      assert.match(failure.message, /blocked/);
      assert.deepStrictEqual(yield* store.state, before);
    }),
  );

  it.effect("a blocked item can still be un-completed", () =>
    Effect.gen(function* () {
      const store = yield* TrackerStore;
      yield* store.reset(emptyState());

      // "b" is done, then its dependency is reopened, so "b" is blocked but
      // must stay reopenable (only completion is gated).
      yield* store.createList("Work", { initialItems: ["a", { text: "b", deps: ["Work:1"] }] });
      yield* store.updateItem("Work:1", { done: true });
      yield* store.updateItem("Work:2", { done: true });
      yield* store.updateItem("Work:1", { done: false });

      const reopened = yield* store.updateItem("Work:2", { done: false });

      assert.strictEqual(reopened.done, false);
    }),
  );

  it.effect("completing a ready item unblocks its dependents", () =>
    Effect.gen(function* () {
      const store = yield* TrackerStore;
      yield* store.reset(emptyState());

      yield* store.createList("Work", { initialItems: ["a", { text: "b", deps: ["Work:1"] }] });
      yield* store.updateItem("Work:1", { done: true });

      const completed = yield* store.updateItem("Work:2", { done: true });

      assert.strictEqual(completed.done, true);
    }),
  );

  it.effect("reopening a dependency is allowed and does not cascade", () =>
    Effect.gen(function* () {
      const store = yield* TrackerStore;
      yield* store.reset(emptyState());

      yield* store.createList("Work", { initialItems: ["a", { text: "b", deps: ["Work:1"] }] });
      yield* store.updateItem("Work:1", { done: true });
      yield* store.updateItem("Work:2", { done: true });

      yield* store.updateItem("Work:1", { done: false });

      const items = (yield* store.state).lists[0]?.items;
      assert.deepStrictEqual(
        items?.map((i) => i.done),
        [false, true],
      );
    }),
  );

  it.effect("removing a depended-on item is refused and names the dependents", () =>
    Effect.gen(function* () {
      const store = yield* TrackerStore;
      yield* store.reset(emptyState());

      yield* store.createList("Work", { initialItems: ["a", { text: "b", deps: ["Work:1"] }] });
      const before = yield* store.state;

      const result = yield* Effect.result(store.removeItem("Work:1"));

      assert(Result.isFailure(result));
      const failure = Option.getOrThrow(Result.getFailure(result));
      assert.strictEqual(failure.reason, "ItemDependedOn");
      assert.match(failure.message, /Work:2/);
      assert.deepStrictEqual(yield* store.state, before);
    }),
  );

  it.effect("removing an item nothing depends on succeeds and leaves other deps intact", () =>
    Effect.gen(function* () {
      const store = yield* TrackerStore;
      yield* store.reset(emptyState());

      yield* store.createList("Work", {
        initialItems: ["a", "b", { text: "c", deps: ["Work:2"] }],
      });
      yield* store.removeItem("Work:1");

      const list = (yield* store.state).lists[0];
      assert.deepStrictEqual(
        list?.items.map((i) => i.id),
        [2, 3],
      );
      assert.deepStrictEqual(list?.items[1]?.deps, ["Work:2"]);
    }),
  );

  it.effect("a batch applies its patches in order, so one call can complete a chain", () =>
    Effect.gen(function* () {
      const store = yield* TrackerStore;
      yield* store.reset(emptyState());

      const list = yield* store.createList("Work", {
        initialItems: ["a", { text: "b", deps: ["Work:1"] }, { text: "c", deps: ["Work:2"] }],
      });

      // Each completion unblocks the next patch, exactly as three sequential
      // calls would.
      const updated = yield* store.updateItems(list.id, [
        { itemId: "Work:1", done: true },
        { itemId: "Work:2", done: true },
        { itemId: "Work:3", done: true },
      ]);

      assert.deepStrictEqual(
        updated.map((item) => item.done),
        [true, true, true],
      );
    }),
  );

  it.effect("a batch still refuses a completion that is out of order", () =>
    Effect.gen(function* () {
      const store = yield* TrackerStore;
      yield* store.reset(emptyState());

      const list = yield* store.createList("Work", {
        initialItems: ["a", { text: "b", deps: ["Work:1"] }],
      });
      const before = yield* store.state;

      // The blocker is named, but later in the array. Order is what counts, so
      // the whole batch fails atomically.
      const result = yield* Effect.result(
        store.updateItems(list.id, [
          { itemId: "Work:2", done: true },
          { itemId: "Work:1", done: true },
        ]),
      );

      assert(Result.isFailure(result));
      assert.strictEqual(Option.getOrThrow(Result.getFailure(result)).reason, "ItemBlocked");
      assert.deepStrictEqual(yield* store.state, before);
    }),
  );

  it.effect("a batch keeps an earlier patch to the same item", () =>
    Effect.gen(function* () {
      const store = yield* TrackerStore;
      yield* store.reset(emptyState());

      const list = yield* store.createList("Work", {
        initialItems: ["a", { text: "b", deps: ["Work:1"] }],
      });

      // Items are addressed by id and the patches are one per item in the
      // documented form, but nothing stops a caller from sending two for the
      // same item. Sequential calls would keep both changes.
      const updated = yield* store.updateItems(list.id, [
        { itemId: "Work:2", deps: [] },
        { itemId: "Work:2", done: true },
      ]);

      assert.strictEqual(updated[0]?.done, true);
      assert.deepStrictEqual(updated[0]?.deps, []);
    }),
  );

  it.effect("a batch can complete a dependent once its blocker is done", () =>
    Effect.gen(function* () {
      const store = yield* TrackerStore;
      yield* store.reset(emptyState());

      const list = yield* store.createList("Work", {
        initialItems: ["a", { text: "b", deps: ["Work:1"] }],
      });
      yield* store.updateItem("Work:1", { done: true });

      const updated = yield* store.updateItems(list.id, [{ itemId: "Work:2", done: true }]);

      assert.strictEqual(updated[0]?.done, true);
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
