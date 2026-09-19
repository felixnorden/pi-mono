import { assert, layer } from "@effect/vitest";
import { Effect, Option, Result } from "effect";
import { TodoItem, TodoList, TrackerState, emptyState, encodeState } from "./domain.ts";
import { TrackerPersistence } from "./persistence.ts";

/**
 * The suite shares one `TrackerPersistence.layer`, whose `append` callback
 * writes into this module-level capture. Every test resets the capture first.
 */
const capture: { latest: unknown; snapshots: unknown[] } = { latest: undefined, snapshots: [] };
const resetCapture = () => {
  capture.latest = undefined;
  capture.snapshots = [];
};

layer(
  TrackerPersistence.layer((encoded) => {
    capture.latest = encoded;
    capture.snapshots.push(encoded);
  }),
)("TrackerPersistence", (it) => {
  const sampleState = (): TrackerState =>
    new TrackerState({
      lists: [
        new TodoList({
          id: 1,
          name: "Work",
          nextItemId: 3,
          items: [
            new TodoItem({ id: 1, text: "write plan", done: true }),
            new TodoItem({ id: 2, text: "implement tracker", done: false }),
          ],
        }),
        new TodoList({
          id: 2,
          name: "Home",
          nextItemId: 2,
          items: [new TodoItem({ id: 1, text: "water plants", done: false })],
        }),
      ],
      activeListId: 1,
      nextListId: 3,
    });

  const decodeFailureOf = (snapshot: unknown) =>
    Effect.gen(function* () {
      const persistence = yield* TrackerPersistence;
      const result = yield* Effect.result(persistence.restore(snapshot));
      assert(Result.isFailure(result), `expected ${JSON.stringify(snapshot)} to fail`);
      const failure = Option.getOrThrow(Result.getFailure(result));
      assert.strictEqual(failure._tag, "SchemaError");
      return failure.message;
    });

  it.effect("save writes the encoded snapshot", () =>
    Effect.gen(function* () {
      resetCapture();
      const persistence = yield* TrackerPersistence;
      const state = sampleState();

      yield* persistence.save(state);

      assert.deepStrictEqual(capture.latest, encodeState(state));
    }),
  );

  it.effect("save then restore round-trips the state", () =>
    Effect.gen(function* () {
      resetCapture();
      const persistence = yield* TrackerPersistence;
      const state = sampleState();

      yield* persistence.save(state);
      const restored = yield* persistence.restore(capture.latest);

      assert.deepStrictEqual(encodeState(restored), encodeState(state));
    }),
  );

  it.effect("restore returns real class instances", () =>
    Effect.gen(function* () {
      resetCapture();
      const persistence = yield* TrackerPersistence;
      yield* persistence.save(sampleState());

      const restored = yield* persistence.restore(capture.latest);
      assert(restored instanceof TrackerState);
      assert(restored.lists[0] instanceof TodoList);
      assert(restored.lists[0]?.items[0] instanceof TodoItem);
    }),
  );

  it.effect("saved snapshots are JSON-serializable", () =>
    Effect.gen(function* () {
      resetCapture();
      const persistence = yield* TrackerPersistence;
      yield* persistence.save(sampleState());

      const roundTripped = JSON.parse(JSON.stringify(capture.latest)) as unknown;
      assert.deepStrictEqual(roundTripped, capture.latest);
    }),
  );

  it.effect("every save is captured, restore decodes the latest", () =>
    Effect.gen(function* () {
      resetCapture();
      const persistence = yield* TrackerPersistence;
      const first = emptyState();
      const second = sampleState();

      yield* persistence.save(first);
      yield* persistence.save(second);

      assert.strictEqual(capture.snapshots.length, 2);
      assert.deepStrictEqual(capture.snapshots[0], encodeState(first));
      const restored = yield* persistence.restore(capture.latest);
      assert.deepStrictEqual(encodeState(restored), encodeState(second));
    }),
  );

  it.effect("empty state round-trips with activeListId null", () =>
    Effect.gen(function* () {
      resetCapture();
      const persistence = yield* TrackerPersistence;
      yield* persistence.save(emptyState());

      const restored = yield* persistence.restore(capture.latest);
      assert.deepStrictEqual(encodeState(restored), encodeState(emptyState()));
      assert.strictEqual(restored.activeListId, null);
      assert("activeListId" in (capture.latest as object));
    }),
  );

  it.effect("restore ignores unknown extra keys (forward compatibility)", () =>
    Effect.gen(function* () {
      resetCapture();
      const persistence = yield* TrackerPersistence;
      const state = sampleState();
      yield* persistence.save(state);

      const snapshot = {
        ...(capture.latest as object),
        futureKey: { anything: 1 },
      };
      const restored = yield* persistence.restore(snapshot);
      assert.deepStrictEqual(encodeState(restored), encodeState(state));
    }),
  );

  it.effect("restore assigns legacy item ids by position (no per-list counter stored)", () =>
    Effect.gen(function* () {
      resetCapture();
      const persistence = yield* TrackerPersistence;
      // A list written before item ids existed carries no nextItemId, so its
      // stored (session-wide) numeric ids are ignored and reassigned from each
      // item's position.
      const legacy = {
        lists: [{ id: 1, name: "Work", items: [{ id: 7, text: "a", done: false }] }],
        activeListId: 1,
        nextListId: 2,
        nextItemId: 8,
      };

      const restored = yield* persistence.restore(legacy);
      const expected = new TrackerState({
        lists: [
          new TodoList({
            id: 1,
            name: "Work",
            nextItemId: 2,
            items: [new TodoItem({ id: 1, text: "a", done: false })],
          }),
        ],
        activeListId: 1,
        nextListId: 2,
      });
      assert.deepStrictEqual(encodeState(restored), encodeState(expected));
      assert.deepStrictEqual(restored.lists[0]?.items, [
        new TodoItem({ id: 1, text: "a", done: false }),
      ]);
    }),
  );

  it.effect("restore gives a legacy item without an id its position as the id", () =>
    Effect.gen(function* () {
      resetCapture();
      const persistence = yield* TrackerPersistence;
      const legacy = {
        lists: [
          {
            id: 1,
            name: "Work",
            items: [
              { text: "a", done: false },
              { text: "b", done: true },
            ],
          },
        ],
        activeListId: 1,
        nextListId: 2,
      };

      const restored = yield* persistence.restore(legacy);

      assert.deepStrictEqual(
        restored.lists[0]?.items.map((i) => i.id),
        [1, 2],
      );
      assert.deepStrictEqual(
        restored.lists[0]?.items.map((i) => i.deps),
        [[], []],
      );
      assert.strictEqual(restored.lists[0]?.nextItemId, 3);
    }),
  );

  it.effect("restore keeps stored ids and raises a counter that lags behind them", () =>
    Effect.gen(function* () {
      resetCapture();
      const persistence = yield* TrackerPersistence;
      // The list stored a counter (so its ids are real), but the counter is
      // lower than the highest id: it must not hand out an id twice.
      const snapshot = {
        lists: [
          {
            id: 1,
            name: "Work",
            nextItemId: 2,
            items: [
              { id: 1, text: "a", done: false, deps: [] },
              { id: 7, text: "b", done: false, deps: ["Work:1"] },
            ],
          },
        ],
        activeListId: 1,
        nextListId: 2,
      };

      const restored = yield* persistence.restore(snapshot);

      assert.deepStrictEqual(
        restored.lists[0]?.items.map((i) => i.id),
        [1, 7],
      );
      assert.deepStrictEqual(restored.lists[0]?.items[1]?.deps, ["Work:1"]);
      assert.strictEqual(restored.lists[0]?.nextItemId, 8);
    }),
  );

  it.effect("restore tolerates a legacy string item id (the session stays loadable)", () =>
    Effect.gen(function* () {
      resetCapture();
      const persistence = yield* TrackerPersistence;
      // Deleting this session's lists would be data loss, so a string id is
      // dropped at the boundary instead of failing the whole decode.
      const legacy = {
        lists: [{ id: 1, name: "Work", items: [{ id: "Work:1", text: "a", done: false }] }],
        activeListId: 1,
        nextListId: 2,
      };

      const restored = yield* persistence.restore(legacy);

      assert.deepStrictEqual(
        restored.lists[0]?.items.map((i) => [i.id, i.text]),
        [[1, "a"]],
      );
    }),
  );

  it.effect("restore rejects non-object garbage", () =>
    Effect.gen(function* () {
      for (const bad of ["not json", 42, null, undefined, [1, 2]]) {
        yield* decodeFailureOf(bad);
      }
    }),
  );

  it.effect("restore rejects structurally invalid snapshots", () =>
    Effect.gen(function* () {
      yield* decodeFailureOf({ lists: 42 });
      yield* decodeFailureOf({ lists: [] }); // missing counters + activeListId
      yield* decodeFailureOf({
        lists: [{ id: 1, name: "Work", items: [{ text: "x", done: "yes" }] }],
        activeListId: null,
        nextListId: 2,
      });
      yield* decodeFailureOf({ ...encodeState(emptyState()), nextListId: 1.5 });
    }),
  );
});
