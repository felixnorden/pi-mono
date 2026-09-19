import { assert, it } from "@effect/vitest";
import { TodoItem, TodoList } from "./domain.ts";
import {
  cyclePath,
  dependentsOf,
  firstReadyIndex,
  orderedItems,
  parseItemRef,
  readiness,
} from "./deps.ts";

/**
 * A list whose items have ids 1..n in order, the given dependency sets, and
 * the given item indexes marked done. `deps[i]` are the `listName:id`
 * references of the item at index `i`.
 */
const listWith = (
  deps: ReadonlyArray<readonly string[]>,
  done: readonly number[] = [],
  name = "Work",
): TodoList =>
  new TodoList({
    id: 1,
    name,
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
  });

/** Every item open. */
const listOf = (deps: ReadonlyArray<readonly string[]>, name = "Work"): TodoList =>
  listWith(deps, [], name);

it("parseItemRef returns null for a malformed reference", () => {
  for (const bad of ["Work", "", ":1", "Work:0", "Work:1x", "Work:-1", "Work:"]) {
    assert.strictEqual(parseItemRef(bad), null, `expected ${JSON.stringify(bad)} to be rejected`);
  }
});

it("parseItemRef splits on the last colon so list names may contain colons", () => {
  assert.deepStrictEqual(parseItemRef("My:List:3"), { name: "My:List", id: 3 });
});

it("cyclePath returns null for a candidate that keeps the graph acyclic", () => {
  // Item 2 depends on item 1, so adding "item 3 depends on item 2" is fine.
  const list = listOf([[], ["Work:1"], []]);

  assert.strictEqual(cyclePath(list, 2, ["Work:2"]), null);
});

it("cyclePath names a direct cycle", () => {
  // Item 1 depends on item 2; making item 2 depend on item 1 closes the loop.
  const list = listOf([["Work:2"], []]);

  const path = cyclePath(list, 1, ["Work:1"]);

  assert.notStrictEqual(path, null);
  assert.include(path ?? [], "Work:1");
  assert.include(path ?? [], "Work:2");
  // The path starts and ends at the item being changed.
  assert.strictEqual(path?.[0], "Work:2");
  assert.strictEqual(path?.[path.length - 1], "Work:2");
});

it("cyclePath names an indirect cycle", () => {
  // 1 depends on 2 and 2 depends on 3; making 3 depend on 1 closes the loop.
  const list = listOf([["Work:2"], ["Work:3"], []]);

  const path = cyclePath(list, 2, ["Work:1"]);

  assert.notStrictEqual(path, null);
  for (const ref of ["Work:1", "Work:2", "Work:3"]) {
    assert.include(path ?? [], ref);
  }
});

it("cyclePath catches a self dependency", () => {
  const list = listOf([[]]);

  assert.deepStrictEqual(cyclePath(list, 0, ["Work:1"]), ["Work:1", "Work:1"]);
});

it("cyclePath ignores a dependency that does not resolve", () => {
  // An unresolvable reference cannot close a cycle; the store rejects it
  // separately with a DependencyNotFound error.
  const list = listOf([[]]);

  assert.strictEqual(cyclePath(list, 0, ["Work:9"]), null);
});

it("cyclePath ignores a dependency naming another list", () => {
  const list = listOf([[]], "Work");

  assert.strictEqual(cyclePath(list, 0, ["Home:1"]), null);
});

// --------------------------------------------------------------------------
// Readiness (derived on read, never stored)
// --------------------------------------------------------------------------

it("an item with no dependencies is ready when open", () => {
  const entries = readiness(listWith([[], []]));

  assert.deepStrictEqual(
    entries.map((entry) => entry.ready),
    [true, true],
  );
  assert.deepStrictEqual(
    entries.map((entry) => entry.blockers),
    [[], []],
  );
});

it("a dependency blocks its dependent until it is done", () => {
  const entries = readiness(listWith([[], ["Work:1"]]));

  assert.strictEqual(entries[0]?.ready, true);
  assert.strictEqual(entries[1]?.ready, false);
  assert.deepStrictEqual(entries[1]?.blockers, ["Work:1"]);
});

it("a done item is never blocked", () => {
  const entries = readiness(listWith([[], ["Work:1"]], [0, 1]));

  assert.deepStrictEqual(entries[1]?.blockers, []);
});

it("readiness follows a chain", () => {
  // Item 3 depends on item 2, which depends on item 1.
  const chain = listWith([[], ["Work:1"], ["Work:2"]]);
  assert.deepStrictEqual(
    readiness(chain).map((entry) => entry.ready),
    [true, false, false],
  );

  // Only the middle link is unblocked by completing item 1.
  const progressed = listWith([[], [], ["Work:2"]], [0]);
  assert.deepStrictEqual(
    readiness(progressed).map((entry) => entry.blockers),
    [[], [], ["Work:2"]],
  );
});

it("a diamond dependency unblocks only when both branches are done", () => {
  const branches = [[], [], ["Work:1", "Work:2"]];

  assert.deepStrictEqual(readiness(listWith(branches))[2]?.blockers, ["Work:1", "Work:2"]);
  assert.deepStrictEqual(readiness(listWith(branches, [0]))[2]?.blockers, ["Work:2"]);

  const joined = readiness(listWith(branches, [0, 1]))[2];
  assert.deepStrictEqual(joined?.blockers, []);
  assert.strictEqual(joined?.ready, true);
});

it("firstReadyIndex returns the earliest ready item in list order", () => {
  // Item 1 is done, item 2 is blocked by item 3, item 3 is ready.
  assert.strictEqual(firstReadyIndex(listWith([[], ["Work:3"], []], [0])), 2);
  // Item 1 is blocked by item 2, which is ready.
  assert.strictEqual(firstReadyIndex(listWith([["Work:2"], []])), 1);
});

it("firstReadyIndex is undefined when nothing is ready", () => {
  assert.strictEqual(firstReadyIndex(listWith([[], []], [0, 1])), undefined);
});

it("a dangling reference leaves its dependent blocked", () => {
  const entry = readiness(listWith([[], ["Work:9"]]))[1];

  assert.strictEqual(entry?.ready, false);
  assert.deepStrictEqual(entry?.blockers, ["?"]);
});

it("dependentsOf lists the items that depend on a given item", () => {
  const list = listWith([[], ["Work:1"], ["Work:1", "Work:2"], []]);

  assert.deepStrictEqual(dependentsOf(list, 0), [1, 2]);
  assert.deepStrictEqual(dependentsOf(list, 1), [2]);
  assert.deepStrictEqual(dependentsOf(list, 2), []);
  assert.deepStrictEqual(dependentsOf(list, 3), []);
});

// --------------------------------------------------------------------------
// Derived display order
// --------------------------------------------------------------------------

/** The ids of the given items, so an order is easy to assert. */
const idsOf = (items: readonly { readonly id?: number }[]): number[] =>
  items.map((item) => item.id ?? 0);

it("orderedItems returns the stored order when nothing has dependencies", () => {
  const list = listWith([[], [], []]);

  assert.deepStrictEqual(idsOf(orderedItems(list)), [1, 2, 3]);
});

it("orderedItems puts a dependency before its dependent", () => {
  // Item 1 waits for item 2.
  const list = listWith([["Work:2"], []]);

  assert.deepStrictEqual(idsOf(orderedItems(list)), [2, 1]);
});

it("orderedItems follows a chain", () => {
  // Item 3 -> item 2 -> item 1.
  const list = listWith([[], ["Work:1"], ["Work:2"]]);

  assert.deepStrictEqual(idsOf(orderedItems(list)), [1, 2, 3]);
});

it("orderedItems keeps the stored order among items that are ready together", () => {
  // Item 2 waits for item 1. Item 3 is ready from the start, so it keeps its
  // place ahead of item 2, which only becomes ready once item 1 is emitted.
  const list = listWith([[], ["Work:1"], []]);

  assert.deepStrictEqual(idsOf(orderedItems(list)), [1, 3, 2]);
});

it("orderedItems keeps every item when the graph has a cycle", () => {
  // Only a hand-edited snapshot can produce a cycle; rendering must not throw
  // or drop items, so the stored order stands in.
  const list = listWith([["Work:2"], ["Work:1"]]);

  assert.deepStrictEqual(idsOf(orderedItems(list)), [1, 2]);
});
