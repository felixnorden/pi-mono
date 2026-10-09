import { assert, it } from "@effect/vitest";
import { Effect, Option } from "effect";
import { CompletionObserver, completedInActiveList } from "./completion.ts";
import { TodoItem, TodoList, TrackerState } from "../core/domain.ts";

interface ItemSpec {
  readonly id: number;
  readonly done: boolean;
  readonly deps?: readonly string[];
}

const list = (id: number, name: string, items: readonly ItemSpec[]): TodoList =>
  new TodoList({
    id,
    name,
    items: items.map(
      (item) =>
        new TodoItem({
          id: item.id,
          title: `item ${item.id}`,
          done: item.done,
          deps: [...(item.deps ?? [])],
        }),
    ),
    nextItemId: items.reduce((max, item) => Math.max(max, item.id), 0) + 1,
  });

const state = (
  lists: readonly TodoList[],
  activeListId: number | null,
  nextListId = lists.length + 1,
): TrackerState => new TrackerState({ lists: [...lists], activeListId, nextListId });

// ---------------------------------------------------------------------------
// completedInActiveList
// ---------------------------------------------------------------------------

it("completedInActiveList returns every item that transitioned from open to done, in list order", () => {
  const before = state(
    [
      list(1, "Work", [
        { id: 1, done: false },
        { id: 3, done: false },
      ]),
    ],
    1,
  );
  const after = state(
    [
      list(1, "Work", [
        { id: 1, done: true },
        { id: 3, done: true },
      ]),
    ],
    1,
  );
  assert.deepStrictEqual(completedInActiveList(before, after), [1, 3]);
});

it("completedInActiveList returns a single id for a single completion", () => {
  const before = state([list(1, "Work", [{ id: 1, done: false }])], 1);
  const after = state([list(1, "Work", [{ id: 1, done: true }])], 1);
  assert.deepStrictEqual(completedInActiveList(before, after), [1]);
});

it("completedInActiveList ignores an item that was already done", () => {
  const before = state([list(1, "Work", [{ id: 1, done: true }])], 1);
  const after = state([list(1, "Work", [{ id: 1, done: true }])], 1);
  assert.deepStrictEqual(completedInActiveList(before, after), []);
});

it("completedInActiveList ignores a completion in a list that is not active", () => {
  const before = state(
    [list(1, "Work", [{ id: 1, done: false }]), list(2, "Other", [{ id: 1, done: false }])],
    1,
  );
  const after = state(
    [list(1, "Work", [{ id: 1, done: false }]), list(2, "Other", [{ id: 1, done: true }])],
    1,
  );
  assert.deepStrictEqual(completedInActiveList(before, after), []);
});

// ---------------------------------------------------------------------------
// CompletionObserver
// ---------------------------------------------------------------------------

const withObserver = <A, E>(
  program: Effect.Effect<A, E, CompletionObserver>,
): Effect.Effect<A, E> => program.pipe(Effect.provide(CompletionObserver.layer));

it.effect("CompletionObserver record folds successive mutations into one batch", () =>
  withObserver(
    Effect.gen(function* () {
      const observer = yield* CompletionObserver;
      const s0 = state(
        [
          list(1, "Work", [
            { id: 1, done: false },
            { id: 3, done: false },
          ]),
        ],
        1,
      );
      const s1 = state(
        [
          list(1, "Work", [
            { id: 1, done: true },
            { id: 3, done: false },
          ]),
        ],
        1,
      );
      const s2 = state(
        [
          list(1, "Work", [
            { id: 1, done: true },
            { id: 3, done: true },
          ]),
        ],
        1,
      );
      yield* observer.record(s0, s1);
      yield* observer.record(s1, s2);
      const batch = Option.getOrThrow(yield* observer.consume);
      assert.deepStrictEqual(batch.completedItemIds, [1, 3]);
      assert.deepStrictEqual(
        batch.list.items.map((item) => item.done),
        [true, true],
      );
    }),
  ),
);

it.effect(
  "CompletionObserver record refreshes the snapshot when a later mutation completes nothing",
  () =>
    withObserver(
      Effect.gen(function* () {
        const observer = yield* CompletionObserver;
        const s0 = state([list(1, "Work", [{ id: 1, done: false }])], 1);
        const s1 = state([list(1, "Work", [{ id: 1, done: true }])], 1);
        const s2 = state(
          [
            list(1, "Work", [
              { id: 1, done: true },
              { id: 2, done: false },
            ]),
          ],
          1,
        );
        yield* observer.record(s0, s1);
        yield* observer.record(s1, s2);
        const batch = Option.getOrThrow(yield* observer.consume);
        assert.deepStrictEqual(batch.completedItemIds, [1]);
        assert.deepStrictEqual(
          batch.list.items.map((item) => item.id),
          [1, 2],
        );
      }),
    ),
);

it.effect("CompletionObserver record drops a completed item that was reopened before settle", () =>
  withObserver(
    Effect.gen(function* () {
      const observer = yield* CompletionObserver;
      const s0 = state([list(1, "Work", [{ id: 1, done: false }])], 1);
      const s1 = state([list(1, "Work", [{ id: 1, done: true }])], 1);
      const s2 = state([list(1, "Work", [{ id: 1, done: false }])], 1);
      yield* observer.record(s0, s1);
      yield* observer.record(s1, s2);
      assert.strictEqual(Option.isNone(yield* observer.consume), true);
    }),
  ),
);

it.effect("CompletionObserver record drops a completed item that was removed before settle", () =>
  withObserver(
    Effect.gen(function* () {
      const observer = yield* CompletionObserver;
      const s0 = state([list(1, "Work", [{ id: 1, done: false }])], 1);
      const s1 = state([list(1, "Work", [{ id: 1, done: true }])], 1);
      const s2 = state([list(1, "Work", [])], 1);
      yield* observer.record(s0, s1);
      yield* observer.record(s1, s2);
      assert.strictEqual(Option.isNone(yield* observer.consume), true);
    }),
  ),
);

it.effect(
  "CompletionObserver record clears the batch when the active list changes without a completion",
  () =>
    withObserver(
      Effect.gen(function* () {
        const observer = yield* CompletionObserver;
        const s0 = state(
          [list(1, "Work", [{ id: 1, done: false }]), list(2, "Other", [{ id: 1, done: false }])],
          1,
        );
        const s1 = state(
          [list(1, "Work", [{ id: 1, done: true }]), list(2, "Other", [{ id: 1, done: false }])],
          1,
        );
        const s2 = state(
          [list(1, "Work", [{ id: 1, done: true }]), list(2, "Other", [{ id: 1, done: false }])],
          2,
        );
        yield* observer.record(s0, s1);
        yield* observer.record(s1, s2);
        assert.strictEqual(Option.isNone(yield* observer.consume), true);
      }),
    ),
);

it.effect(
  "CompletionObserver record starts a fresh batch when a completion arrives in a different active list",
  () =>
    withObserver(
      Effect.gen(function* () {
        const observer = yield* CompletionObserver;
        const s0 = state(
          [list(1, "Work", [{ id: 1, done: false }]), list(2, "Other", [{ id: 1, done: false }])],
          1,
        );
        const s1 = state(
          [list(1, "Work", [{ id: 1, done: true }]), list(2, "Other", [{ id: 1, done: false }])],
          1,
        );
        const s2 = state(
          [list(1, "Work", [{ id: 1, done: true }]), list(2, "Other", [{ id: 1, done: true }])],
          2,
        );
        yield* observer.record(s0, s1);
        yield* observer.record(s1, s2);
        const batch = Option.getOrThrow(yield* observer.consume);
        assert.deepStrictEqual(batch.completedItemIds, [1]);
        assert.strictEqual(batch.list.name, "Other");
      }),
    ),
);

it.effect("CompletionObserver consume clears the record", () =>
  withObserver(
    Effect.gen(function* () {
      const observer = yield* CompletionObserver;
      const s0 = state([list(1, "Work", [{ id: 1, done: false }])], 1);
      const s1 = state([list(1, "Work", [{ id: 1, done: true }])], 1);
      yield* observer.record(s0, s1);
      const first = yield* observer.consume;
      const second = yield* observer.consume;
      assert.strictEqual(Option.isSome(first), true);
      assert.strictEqual(Option.isNone(second), true);
    }),
  ),
);
