import { Schema } from "effect";

/**
 * Domain model for the tracker extension.
 *
 * Schema classes double as their own TypeScript types (no separate
 * interfaces). The on-disk / session snapshot is the full `TrackerState`,
 * so decode does not need to apply defaults: a snapshot is either complete
 * and valid, or rejected with a `SchemaError`.
 */

export class TodoItem extends Schema.Class<TodoItem>("tracker/TodoItem")({
  text: Schema.String,
  done: Schema.Boolean,
}) {}

export class TodoList extends Schema.Class<TodoList>("tracker/TodoList")({
  id: Schema.Int,
  name: Schema.String,
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
 * Item ids are not stored: `listName:index` is a reference syntax where
 * `index` is the 1-based position in the list's `items` array. State is
 * always carried as real class instances: `Schema.Class` encode requires
 * instances (its Declaration checks the class marker), and the constructors
 * validate their input (`new TodoItem({ text: 42, ... })` throws).
 */
export const emptyState = (): TrackerState => new TrackerState({ lists: [], activeListId: null, nextListId: 1 });

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
 * input; unknown extra keys are ignored for forward compatibility.
 */
export const decodeStateEffect = Schema.decodeUnknownEffect(TrackerState, {
  onExcessProperty: "ignore",
});
