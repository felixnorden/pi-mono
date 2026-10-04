import { Effect, Schema } from "effect";

/**
 * Domain model for the tracker extension.
 *
 * Schema classes double as their own TypeScript types (no separate
 * interfaces). The on-disk / session snapshot is the full `TrackerState`.
 *
 * Items carry a per-list integer `id` and a same-list `deps` list. Both were
 * added after the first release, so decode applies defaults for them and
 * `normalizeSnapshot` tolerates the older item shapes. `migrateState` then
 * turns a decoded snapshot into a state the store can rely on: every item has
 * a real id and every list has a counter above its ids.
 */

/**
 * An item id of 0 means "not assigned yet": a snapshot written before ids
 * existed, or an item whose legacy string id was dropped. `migrateState`
 * assigns the real id (the item's position for a legacy list).
 */
const itemId = Schema.Int.pipe(
  Schema.withDecodingDefaultType(Effect.succeed(0)),
  Schema.withConstructorDefault(Effect.succeed(0)),
);

/** Same-list dependencies, as `listName:id` references. */
const itemDeps = Schema.Array(Schema.String).pipe(
  Schema.withDecodingDefaultType(Effect.succeed([])),
  Schema.withConstructorDefault(Effect.succeed([])),
);

/**
 * Sentinel for a list that stored no item id counter, which means the snapshot
 * was written before item ids existed. `normalizeSnapshot` stamps it so
 * `migrateState` can tell such a list apart and reassign its ids by position.
 */
const LEGACY_ITEM_COUNTER = 0;

/** Per-list counter for the next item id. Strictly increasing, never reused. */
const itemCounter = Schema.Int.pipe(
  Schema.withDecodingDefaultType(Effect.succeed(1)),
  Schema.withConstructorDefault(Effect.succeed(1)),
);

export class TodoItem extends Schema.Class<TodoItem>("tracker/TodoItem")({
  id: itemId,
  text: Schema.String,
  done: Schema.Boolean,
  deps: itemDeps,
}) {}

export class TodoList extends Schema.Class<TodoList>("tracker/TodoList")({
  id: Schema.Int,
  name: Schema.String,
  // Strictly-increasing counter ⇒ stable item ids, never reused after deletes.
  nextItemId: itemCounter,
  items: Schema.Array(TodoItem),
}) {}

export class TrackerState extends Schema.Class<TrackerState>("tracker/TrackerState")({
  lists: Schema.Array(TodoList),
  // null = no active list (avoids Option in the serialized snapshot)
  activeListId: Schema.NullOr(Schema.Int),
  // Strictly-increasing counter ⇒ stable list ids, never reused after deletes.
  nextListId: Schema.Int,
}) {}

/**
 * Fresh state: no lists, list counter starting at 1.
 *
 * State is always carried as real class instances: `Schema.Class` encode
 * requires instances (its Declaration checks the class marker), and the
 * constructors validate their input (`new TodoItem({ text: 42, ... })` throws).
 */
export const emptyState = (): TrackerState =>
  new TrackerState({ lists: [], activeListId: null, nextListId: 1 });

// --------------------------------------------------------------------------
// Legacy snapshot tolerance
// --------------------------------------------------------------------------

/** A copy of `item` with a replaced id. */
const withId = (item: TodoItem, id: number): TodoItem =>
  new TodoItem({ id, text: item.text, done: item.done, deps: item.deps });

/**
 * Reassign ids for one list and return it with a counter above every id.
 *
 * A list carrying the legacy sentinel was written before item ids existed, so
 * its stored ids (if any) mean nothing now: ids are assigned from each item's
 * position, which is what the old `listName:index` references resolved to.
 * Otherwise stored ids are kept and the counter is raised past the highest
 * one, so it never hands out an id twice.
 */
const migrateList = (list: TodoList): TodoList => {
  if (list.nextItemId === LEGACY_ITEM_COUNTER) {
    return new TodoList({
      id: list.id,
      name: list.name,
      items: list.items.map((item, index) => withId(item, index + 1)),
      nextItemId: list.items.length + 1,
    });
  }
  const highest = list.items.reduce((max, item) => Math.max(max, item.id), 0);
  let counter = Math.max(list.nextItemId, highest + 1);
  const items = list.items.map((item) => {
    if (item.id !== LEGACY_ITEM_COUNTER) return item;
    // A stray unassigned id (hand-edited snapshot): hand out a fresh one
    // rather than leave an item no reference can reach.
    const assigned = withId(item, counter);
    counter += 1;
    return assigned;
  });
  return new TodoList({ id: list.id, name: list.name, items, nextItemId: counter });
};

/**
 * Make a decoded snapshot safe for the store: every item has a real id and
 * every list has a counter above its ids. Pure; called once per restore.
 */
export const migrateState = (state: TrackerState): TrackerState =>
  new TrackerState({
    lists: state.lists.map(migrateList),
    activeListId: state.activeListId,
    nextListId: state.nextListId,
  });

/**
 * Drop a legacy `listName:index` string item id so the item decodes as
 * unassigned. An older format stored the id as a string; the schema now
 * stores an integer, and rejecting the snapshot would lose the whole session.
 */
const normalizeItem = (item: unknown): unknown => {
  if (typeof item !== "object" || item === null || Array.isArray(item)) return item;
  const record = item as Record<string, unknown>;
  if (typeof record.id !== "string") return item;
  const next = { ...record };
  delete next.id;
  return next;
};

/**
 * Tolerate item shapes written by older versions before the schema sees them.
 *
 * Two older shapes exist, described on `normalizeItem` and on
 * `LEGACY_ITEM_COUNTER`. Anything unrecognizable passes through untouched, so
 * the schema still reports the real error for malformed input.
 */
const normalizeSnapshot = (snapshot: unknown): unknown => {
  if (typeof snapshot !== "object" || snapshot === null || Array.isArray(snapshot)) {
    return snapshot;
  }
  const state = snapshot as Record<string, unknown>;
  if (!Array.isArray(state.lists)) return snapshot;
  let changed = false;
  const lists = state.lists.map((list) => {
    if (typeof list !== "object" || list === null || Array.isArray(list)) return list;
    const record = list as Record<string, unknown>;
    const next: Record<string, unknown> = { ...record };
    let listChanged = false;
    const rawItems = record.items;
    if (Array.isArray(rawItems)) {
      const items = rawItems.map(normalizeItem);
      if (items.some((item, index) => item !== rawItems[index])) {
        next.items = items;
        listChanged = true;
      }
    }
    if (typeof record.nextItemId !== "number") {
      next.nextItemId = LEGACY_ITEM_COUNTER;
      listChanged = true;
    }
    if (!listChanged) return list;
    changed = true;
    return next;
  });
  return changed ? { ...state, lists } : snapshot;
};

// --------------------------------------------------------------------------
// Codecs
// --------------------------------------------------------------------------

/**
 * Encode a `TrackerState` into its plain JSON shape (the session snapshot).
 * Guarantees the snapshot is JSON-serializable and schema-valid.
 */
export const encodeState = Schema.encodeSync(TrackerState);

/**
 * Encode a `TrackerState` into its plain JSON shape, as an Effect.
 * Fails with `SchemaError` in the error channel instead of throwing.
 */
export const encodeStateEffect = Schema.encodeEffect(TrackerState);

/**
 * Decode an untrusted snapshot (e.g. `data` from a session custom entry)
 * into a validated `TrackerState`. Fails with `SchemaError` on malformed
 * input; unknown extra keys are ignored for forward compatibility, and the
 * legacy item shapes accepted by `normalizeSnapshot` are tolerated.
 *
 * The result is not yet migrated: call `migrateState` (as
 * `TrackerPersistence.restore` does) before handing it to the store.
 */
export const decodeStateEffect = (snapshot: unknown) =>
  Schema.decodeUnknownEffect(TrackerState, { onExcessProperty: "ignore" })(
    normalizeSnapshot(snapshot),
  );
