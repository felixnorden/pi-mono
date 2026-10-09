import { assert, it } from "@effect/vitest";
import { TodoItem, TodoList, TrackerState } from "../src/core/domain.ts";
import { deriveEvents, type TimedSnapshot } from "./derive.ts";

interface ItemSpec {
  readonly id: number;
  readonly title: string;
  readonly description?: string;
  readonly done: boolean;
  readonly deps?: readonly string[];
}

const listWith = (items: readonly ItemSpec[], name = "Work", id = 1): TodoList =>
  new TodoList({
    id,
    name,
    nextItemId: items.length + 1,
    items: items.map(
      (item) =>
        new TodoItem({
          id: item.id,
          title: item.title,
          description: item.description ?? "",
          done: item.done,
          deps: item.deps ?? [],
        }),
    ),
  });

const stateOf = (lists: readonly TodoList[], activeListId: number | null = 1): TrackerState =>
  new TrackerState({ lists: [...lists], activeListId, nextListId: lists.length + 1 });

const at = (snapshot: TrackerState, time: string): TimedSnapshot => ({ at: time, state: snapshot });

it("derives one event per open to done transition", () => {
  const before = stateOf([
    listWith([
      { id: 1, title: "first", done: false },
      { id: 2, title: "second", done: false },
    ]),
  ]);
  const after = stateOf([
    listWith([
      { id: 1, title: "first", done: true },
      { id: 2, title: "second", done: false },
    ]),
  ]);
  const events = deriveEvents([at(before, "t0"), at(after, "t1")], 16);
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0]!.index, 0);
  assert.strictEqual(events[0]!.at, "t1");
  assert.deepStrictEqual(events[0]!.completedItemIds, [1]);
  assert.deepStrictEqual(events[0]!.completed, [{ ref: "Work:1", text: "first" }]);
  assert.deepStrictEqual(events[0]!.candidates, [
    {
      ref: "Work:2",
      text: "second",
      class: "ready-queue",
      relationship: "independent of Work:1",
    },
  ]);
});

it("carries an item description through the event and the completed batch", () => {
  const before = stateOf([
    listWith([{ id: 1, title: "first", description: "detail", done: false }]),
  ]);
  const after = stateOf([listWith([{ id: 1, title: "first", description: "detail", done: true }])]);
  const events = deriveEvents([at(before, "t0"), at(after, "t1")], 16);
  assert.deepStrictEqual(events[0]!.completed, [
    { ref: "Work:1", text: "first", description: "detail" },
  ]);
  assert.deepStrictEqual(events[0]!.items[0], {
    id: 1,
    text: "first",
    description: "detail",
    done: true,
    deps: [],
  });
});

it("emits no event when nothing completes", () => {
  const before = stateOf([listWith([{ id: 1, title: "first", done: false }])]);
  const after = stateOf([listWith([{ id: 1, title: "first", done: false }])]);
  assert.deepStrictEqual(deriveEvents([at(before, "t0"), at(after, "t1")], 16), []);
});

it("emits no event for a completion in a list that is not active", () => {
  const work = listWith([{ id: 1, title: "first", done: false }], "Work", 1);
  const side = listWith([{ id: 1, title: "side", done: false }], "Side", 2);
  const before = stateOf([work, side], 1);
  const sideDone = listWith([{ id: 1, title: "side", done: true }], "Side", 2);
  const after = stateOf([work, sideDone], 1);
  assert.deepStrictEqual(deriveEvents([at(before, "t0"), at(after, "t1")], 16), []);
});

it("orders a dependent successor before the ready queue", () => {
  const before = stateOf([
    listWith([
      { id: 1, title: "root", done: false },
      { id: 2, title: "independent", done: false },
      { id: 3, title: "dependent", done: false, deps: ["Work:1"] },
    ]),
  ]);
  const after = stateOf([
    listWith([
      { id: 1, title: "root", done: true },
      { id: 2, title: "independent", done: false },
      { id: 3, title: "dependent", done: false, deps: ["Work:1"] },
    ]),
  ]);
  const event = deriveEvents([at(before, "t0"), at(after, "t1")], 16)[0]!;
  assert.deepStrictEqual(
    event.candidates.map((candidate) => [candidate.ref, candidate.class]),
    [
      ["Work:3", "dependent-successor"],
      ["Work:2", "ready-queue"],
    ],
  );
  assert.strictEqual(event.declaredDeps, 1);
  assert.strictEqual(event.frontier, 2);
});

it("asks a dependent successor about the item it depends on", () => {
  const before = stateOf([
    listWith([
      { id: 1, title: "root", done: false },
      { id: 2, title: "dependent", done: false, deps: ["Work:1"] },
    ]),
  ]);
  const after = stateOf([
    listWith([
      { id: 1, title: "root", done: true },
      { id: 2, title: "dependent", done: false, deps: ["Work:1"] },
    ]),
  ]);
  const event = deriveEvents([at(before, "t0"), at(after, "t1")], 16)[0]!;
  assert.strictEqual(event.questions.length, 1);
  assert.match(event.questions[0]!.instructions, /depends on/);
  assert.deepStrictEqual(Object.keys(event.questions[0]!.criteria), [
    "needs-context",
    "stands-alone",
  ]);
});

it("asks an independent item about the completed batch", () => {
  const before = stateOf([
    listWith([
      { id: 1, title: "root", done: false },
      { id: 2, title: "independent", done: false },
    ]),
  ]);
  const after = stateOf([
    listWith([
      { id: 1, title: "root", done: true },
      { id: 2, title: "independent", done: false },
    ]),
  ]);
  const event = deriveEvents([at(before, "t0"), at(after, "t1")], 16)[0]!;
  assert.strictEqual(/depends on/.test(event.questions[0]!.instructions), false);
  assert.match(event.questions[0]!.instructions, /completed work/);
});

it("caps the stored candidates but reports the full frontier", () => {
  const items = (done: readonly number[]): ItemSpec[] =>
    [1, 2, 3, 4].map((id) => ({ id, title: `item ${id}`, done: done.includes(id) }));
  const event = deriveEvents(
    [at(stateOf([listWith(items([]))]), "t0"), at(stateOf([listWith(items([1]))]), "t1")],
    2,
  )[0]!;
  assert.strictEqual(event.frontier, 3);
  assert.strictEqual(event.candidates.length, 2);
  assert.strictEqual(event.questions.length, 2);
  assert.deepStrictEqual(
    event.candidates.map((candidate) => candidate.ref),
    ["Work:2", "Work:3"],
  );
});

it("keeps the completed batch when the frontier is empty", () => {
  const before = stateOf([
    listWith([
      { id: 1, title: "first", done: false },
      { id: 2, title: "second", done: false },
    ]),
  ]);
  const after = stateOf([
    listWith([
      { id: 1, title: "first", done: true },
      { id: 2, title: "second", done: true },
    ]),
  ]);
  const event = deriveEvents([at(before, "t0"), at(after, "t1")], 16)[0]!;
  assert.deepStrictEqual(event.completed, [
    { ref: "Work:1", text: "first" },
    { ref: "Work:2", text: "second" },
  ]);
  assert.deepStrictEqual(event.candidates, []);
  assert.strictEqual(event.frontier, 0);
  assert.strictEqual(event.doneCount, 2);
  assert.strictEqual(event.openCount, 0);
});

it("reports the list shape at the event", () => {
  const before = stateOf([
    listWith([
      { id: 1, title: "first", done: false },
      { id: 2, title: "second", done: true },
      { id: 3, title: "third", done: false, deps: ["Work:2"] },
    ]),
  ]);
  const after = stateOf([
    listWith([
      { id: 1, title: "first", done: true },
      { id: 2, title: "second", done: true },
      { id: 3, title: "third", done: false, deps: ["Work:2"] },
    ]),
  ]);
  const event = deriveEvents([at(before, "t0"), at(after, "t1")], 16)[0]!;
  assert.strictEqual(event.itemCount, 3);
  assert.strictEqual(event.openCount, 1);
  assert.strictEqual(event.doneCount, 2);
  assert.strictEqual(event.declaredDeps, 1);
  assert.strictEqual(event.listName, "Work");
});

it("emits no event when only the active list changes", () => {
  const work = listWith([{ id: 1, title: "open", done: false }], "Work", 1);
  const side = listWith([{ id: 1, title: "already done", done: true }], "Side", 2);
  const before = stateOf([work, side], 1);
  const after = stateOf([work, side], 2);
  // `completedInActiveList` reads the *new* active list's previous state, so a
  // list switch reports none of that list's pre-existing done items.
  assert.deepStrictEqual(deriveEvents([at(before, "t0"), at(after, "t1")], 16), []);
});

it("carries every list item in list order", () => {
  const before = stateOf([
    listWith([
      { id: 1, title: "first", done: false },
      { id: 2, title: "second", done: true },
      { id: 3, title: "third", done: false, deps: ["Work:2"] },
    ]),
  ]);
  const after = stateOf([
    listWith([
      { id: 1, title: "first", done: true },
      { id: 2, title: "second", done: true },
      { id: 3, title: "third", done: false, deps: ["Work:2"] },
    ]),
  ]);
  const event = deriveEvents([at(before, "t0"), at(after, "t1")], 16)[0]!;
  assert.deepStrictEqual(event.items, [
    { id: 1, text: "first", done: true, deps: [] },
    { id: 2, text: "second", done: true, deps: [] },
    { id: 3, text: "third", done: false, deps: ["Work:2"] },
  ]);
});

it("numbers events in time order", () => {
  const open = (done: readonly number[]): TrackerState =>
    stateOf([
      listWith([
        { id: 1, title: "a", done: done.includes(1) },
        { id: 2, title: "b", done: done.includes(2) },
      ]),
    ]);
  const events = deriveEvents(
    [at(open([]), "t0"), at(open([1]), "t1"), at(open([1, 2]), "t2")],
    16,
  );
  assert.deepStrictEqual(
    events.map((event) => [event.index, event.at]),
    [
      [0, "t1"],
      [1, "t2"],
    ],
  );
});
