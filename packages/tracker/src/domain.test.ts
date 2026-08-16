import { assert, it } from "@effect/vitest";
import { Effect, Option, Result } from "effect";
import {
  decodeStateEffect,
  emptyState,
  encodeState,
  TodoItem,
  TodoList,
  TrackerState,
} from "./domain.ts";

/**
 * Round-trip helpers compare *encoded* forms (plain JSON) instead of decoded
 * values, because `Schema.Class` decode produces class instances while the
 * fixtures are plain object literals — encoding both sides normalizes them.
 */
const roundTripsTo = (state: TrackerState, snapshot: unknown) =>
  assert.deepStrictEqual(encodeState(decodeOrThrow(snapshot)), encodeState(state));

const decodeOrThrow = (snapshot: unknown): TrackerState =>
  Effect.runSync(decodeStateEffect(snapshot));

/** A realistic two-list state used by several tests. */
const sampleState = (): TrackerState =>
  new TrackerState({
    lists: [
      new TodoList({
        id: 1,
        name: "Work",
        items: [
          new TodoItem({ text: "write plan", done: true }),
          new TodoItem({ text: "implement tracker", done: false }),
        ],
      }),
      new TodoList({
        id: 2,
        name: "Home",
        items: [new TodoItem({ text: "water plants", done: false })],
      }),
    ],
    activeListId: 1,
    nextListId: 3,
  });

it("emptyState produces the canonical empty snapshot", () => {
  assert.deepStrictEqual(encodeState(emptyState()), {
    lists: [],
    activeListId: null,
    nextListId: 1,
  });
});

it("empty state round-trips through encode/decode", () => {
  roundTripsTo(emptyState(), encodeState(emptyState()));
});

it("a realistic state round-trips, preserving order", () => {
  const state = sampleState();
  roundTripsTo(state, encodeState(state));
  const decoded = decodeOrThrow(encodeState(state));
  assert.deepStrictEqual(decoded.lists, state.lists);
  assert.strictEqual(decoded.activeListId, 1);
  assert.strictEqual(decoded.nextListId, 3);
});

it("decoded values are real class instances", () => {
  const decoded = decodeOrThrow(encodeState(sampleState()));
  const firstItem = decoded.lists[0]?.items[0];
  assert(firstItem instanceof TodoItem);
  assert(decoded.lists[0] instanceof TodoList);
  assert(decoded instanceof TrackerState);
});

it("constructors validate their input", () => {
  // Invalid types / missing fields throw at construction time. (The invalid
  // inputs are cast because the constructor signature is already typed.)
  assert.throws(() => new TodoItem({ text: 42, done: false } as never));
  assert.throws(() => new TodoItem({ text: "x" } as never));
  assert.throws(() => new TrackerState({} as never));
});

it("encoded snapshots are JSON-serializable", () => {
  const state = sampleState();
  const encoded = encodeState(state);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(encoded)), encoded);
});

it("activeListId: null round-trips as null (not undefined)", () => {
  const decoded = decodeOrThrow(encodeState(emptyState()));
  assert(decoded.activeListId === null);
  assert("activeListId" in encodeState(decoded));
  assert.strictEqual(encodeState(decoded).activeListId, null);
});

it("unknown extra keys are ignored (forward compatibility)", () => {
  const state = sampleState();
  const encoded = encodeState(state);
  const snapshot = { ...encoded, futureKey: { anything: 1 } };
  // An extra key inside a valid list object is tolerated too.
  const listWithExtra = { ...encoded.lists[0]!, extra: true };
  const nested = { ...encoded, lists: [listWithExtra, ...encoded.lists.slice(1)] };
  roundTripsTo(state, snapshot);
  roundTripsTo(state, nested);
});

it("rejects a snapshot with the wrong field type", () => {
  const result = Effect.runSync(Effect.result(decodeStateEffect({ lists: 42 })));
  assert(Result.isFailure(result));
  const failure = Option.getOrThrow(Result.getFailure(result));
  assert.strictEqual(failure._tag, "SchemaError");
  assert.match(failure.message, /lists/i);
});

it("rejects a snapshot with an invalid item field", () => {
  const bad = {
    lists: [{ id: 1, name: "Work", items: [{ text: "x", done: "yes" }] }],
    activeListId: null,
    nextListId: 2,
  };
  const result = Effect.runSync(Effect.result(decodeStateEffect(bad)));
  assert(Result.isFailure(result));
});

it("ignores legacy item id fields (ids are positions, not stored)", () => {
  // Snapshots from both previous formats (numeric ids and listName:index
  // strings) decode cleanly; the stored id is ignored.
  const legacy = {
    lists: [{ id: 1, name: "Work", items: [{ id: "Work:1", text: "x", done: false }] }],
    activeListId: null,
    nextListId: 2,
    nextItemId: 9,
  };
  const decoded = decodeOrThrow(legacy);
  assert.deepStrictEqual(decoded.lists[0]?.items, [new TodoItem({ text: "x", done: false })]);
});

it("enforces Int list ids (fractional ids are rejected)", () => {
  const bad = {
    lists: [{ id: 1.5, name: "Work", items: [] }],
    activeListId: null,
    nextListId: 2,
  };
  const result = Effect.runSync(Effect.result(decodeStateEffect(bad)));
  assert(Result.isFailure(result));
});

it("rejects a snapshot missing required fields", () => {
  const result = Effect.runSync(Effect.result(decodeStateEffect({ lists: [] })));
  assert(Result.isFailure(result));
});

it("rejects non-object input", () => {
  for (const bad of ["not json", 42, null, undefined, [1, 2]]) {
    const result = Effect.runSync(Effect.result(decodeStateEffect(bad)));
    assert(Result.isFailure(result), `expected ${JSON.stringify(bad)} to fail`);
  }
});
