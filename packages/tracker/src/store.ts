import { Context, Effect, Layer, Ref, Result, Schema } from "effect";
import { TodoItem, TodoList, TrackerState, emptyState } from "./domain.ts";

// --------------------------------------------------------------------------
// Errors
// --------------------------------------------------------------------------

const Reason = Schema.Union([
  Schema.Literal("ListNotFound"),
  Schema.Literal("ItemNotFound"),
  Schema.Literal("EmptyText"),
  Schema.Literal("DuplicateListName"),
]);

export type TrackerErrorReason = Schema.Schema.Type<typeof Reason>;

export class TrackerError extends Schema.TaggedError<TrackerError>()("TrackerError", {
  reason: Reason,
  message: Schema.String,
  listId: Schema.optional(Schema.Int),
  itemId: Schema.optional(Schema.String),
}) {}

/**
 * Not-found messages name the available ids so the caller (the LLM) can
 * retry without an extra round trip. Empty lists produce a "no lists / no
 * items" hint instead.
 */
const listNotFoundMessage = (s: TrackerState, listId: number): string => {
  const available = s.lists.map((list) => `#${list.id}`).join(", ");
  return available === ""
    ? `List #${listId} not found (no lists exist)`
    : `List #${listId} not found — available: ${available}`;
};

/**
 * Parse a `listName:index` item id (e.g. `Work:2`). Splits on the *last*
 * colon so list names may contain colons; the index must be a positive
 * integer. Returns null for anything that is not a well-formed id.
 */
const parseItemId = (
  itemId: string,
): { readonly listName: string; readonly index: number } | null => {
  const colon = itemId.lastIndexOf(":");
  if (colon <= 0 || colon === itemId.length - 1) return null;
  const indexText = itemId.slice(colon + 1);
  if (!/^[1-9]\d*$/.test(indexText)) return null;
  return { listName: itemId.slice(0, colon), index: Number(indexText) };
};

/** Outcome of resolving an item id against a state. */
type ResolvedItem =
  | { readonly kind: "malformed" }
  | { readonly kind: "noList"; readonly listName: string }
  | { readonly kind: "noItem"; readonly list: TodoList }
  | {
      readonly kind: "ok";
      readonly list: TodoList;
      readonly item: TodoItem;
      readonly index: number;
    };

/** Resolve `listName:index` against the current state (index is 1-based). */
const resolveItem = (s: TrackerState, itemId: string): ResolvedItem => {
  const parsed = parseItemId(itemId);
  if (!parsed) return { kind: "malformed" };
  const list = s.lists.find((l) => l.name === parsed.listName);
  if (!list) return { kind: "noList", listName: parsed.listName };
  const item = list.items[parsed.index - 1];
  if (!item) return { kind: "noItem", list };
  return { kind: "ok", list, item, index: parsed.index };
};

/**
 * Resolve an item id, or build the not-found error naming what the caller
 * (the LLM) can use instead. Not-found messages list the available ids so a
 * stale reference self-corrects on the next attempt.
 */
const resolveItemOrError = (
  s: TrackerState,
  itemId: string,
):
  | { readonly ok: true; readonly list: TodoList; readonly item: TodoItem; readonly index: number }
  | { readonly ok: false; readonly error: TrackerError } => {
  const resolved = resolveItem(s, itemId);
  switch (resolved.kind) {
    case "malformed":
      return {
        ok: false,
        error: new TrackerError({
          reason: "ItemNotFound",
          message: `Item "${itemId}" must look like "listName:index" (e.g. "Work:2")`,
          itemId,
        }),
      };
    case "noList": {
      const available = s.lists.map((list) => `[${list.id}] ${list.name}`).join(", ");
      return {
        ok: false,
        error: new TrackerError({
          reason: "ItemNotFound",
          message:
            available === ""
              ? `Item "${itemId}" not found — no lists exist`
              : `Item "${itemId}" not found — no list named "${resolved.listName}" (available: ${available})`,
          itemId,
        }),
      };
    }
    case "noItem": {
      const available = resolved.list.items
        .map((_, i) => `${resolved.list.name}:${i + 1}`)
        .join(", ");
      return {
        ok: false,
        error: new TrackerError({
          reason: "ItemNotFound",
          message:
            available === ""
              ? `Item "${itemId}" not found in list "${resolved.list.name}" (no items)`
              : `Item "${itemId}" not found in list "${resolved.list.name}" — available: ${available}`,
          listId: resolved.list.id,
          itemId,
        }),
      };
    }
    case "ok":
      return { ok: true, list: resolved.list, item: resolved.item, index: resolved.index };
  }
};

// --------------------------------------------------------------------------
// Store
// --------------------------------------------------------------------------

export interface UpdateItemPatch {
  readonly text?: string;
  readonly done?: boolean;
}

/** An `UpdateItemPatch` that also names the item it targets (batch form). */
export interface UpdateItemPatchWithId extends UpdateItemPatch {
  /** `listName:index`, as shown by the list action (e.g. `Work:2`). */
  readonly itemId: string;
}

/** Options for `createList`: activation behavior and initial items. */
export interface CreateListOptions {
  /** Make the new list the active list (defaults to true). */
  readonly activate?: boolean;
  /** Initial item texts, added when the list is created (atomic with the list). */
  readonly initialItems?: readonly string[];
}

export class TrackerStore extends Context.Service<
  TrackerStore,
  {
    readonly state: Effect.Effect<TrackerState>;
    readonly reset: (state: TrackerState) => Effect.Effect<void>;
    readonly createList: (
      name: string,
      options?: CreateListOptions,
    ) => Effect.Effect<TodoList, TrackerError>;
    readonly deleteList: (listId: number) => Effect.Effect<void, TrackerError>;
    readonly setActiveList: (listId: number | null) => Effect.Effect<void, TrackerError>;
    readonly addItem: (listId: number, text: string) => Effect.Effect<TodoItem, TrackerError>;
    readonly addItems: (
      listId: number,
      texts: readonly string[],
    ) => Effect.Effect<TodoItem[], TrackerError>;
    readonly updateItem: (
      itemId: string,
      patch: UpdateItemPatch,
    ) => Effect.Effect<TodoItem, TrackerError>;
    readonly updateItems: (
      patches: readonly UpdateItemPatchWithId[],
    ) => Effect.Effect<TodoItem[], TrackerError>;
    readonly removeItem: (itemId: string) => Effect.Effect<void, TrackerError>;
  }
>()("tracker/TrackerStore") {
  static readonly layer: Layer.Layer<TrackerStore> = Layer.effect(
    TrackerStore,
    Effect.gen(function* () {
      const ref = yield* Ref.make(emptyState());

      /**
       * Atomic read-modify-write. The callback validates against the current
       * state and either fails with `Result.fail` (state untouched) or
       * succeeds with `Result.succeed(result)` plus the next state.
       */
      const mutate = <A>(
        f: (s: TrackerState) => readonly [Result.Result<A, TrackerError>, TrackerState],
      ): Effect.Effect<A, TrackerError> =>
        Ref.modify(ref, f).pipe(Effect.flatMap(Effect.fromResult));

      const state: Effect.Effect<TrackerState> = Ref.get(ref);

      const reset = Effect.fn("TrackerStore.reset")(function* (state: TrackerState) {
        yield* Ref.set(ref, state);
      });

      const createList = Effect.fn("TrackerStore.createList")(function* (
        name: string,
        options: CreateListOptions = {},
      ) {
        const trimmed = name.trim();
        if (trimmed === "") {
          return yield* new TrackerError({
            reason: "EmptyText",
            message: "List name must not be empty",
          });
        }
        const initialItems = (options.initialItems ?? []).map((text) => text.trim());
        if (initialItems.some((text) => text === "")) {
          return yield* new TrackerError({
            reason: "EmptyText",
            message: "Item text must not be empty",
          });
        }
        const activate = options.activate ?? true;
        return yield* mutate(
          (s): readonly [Result.Result<TodoList, TrackerError>, TrackerState] => {
            if (s.lists.some((list) => list.name === trimmed)) {
              return [
                Result.fail(
                  new TrackerError({
                    reason: "DuplicateListName",
                    message: `List "${trimmed}" already exists`,
                  }),
                ),
                s,
              ];
            }
            const items = initialItems.map((text) => new TodoItem({ text, done: false }));
            const list = new TodoList({ id: s.nextListId, name: trimmed, items });
            return [
              Result.succeed(list),
              new TrackerState({
                ...s,
                lists: [...s.lists, list],
                // The new list becomes the active list by default (the widget
                // switches to it); pass activate: false to keep the current
                // active list (or stay without one).
                activeListId: activate ? list.id : s.activeListId,
                nextListId: s.nextListId + 1,
              }),
            ];
          },
        );
      });

      const deleteList = Effect.fn("TrackerStore.deleteList")(function* (listId: number) {
        return yield* mutate((s): readonly [Result.Result<void, TrackerError>, TrackerState] => {
          if (!s.lists.some((list) => list.id === listId)) {
            return [
              Result.fail(
                new TrackerError({
                  reason: "ListNotFound",
                  message: listNotFoundMessage(s, listId),
                  listId,
                }),
              ),
              s,
            ];
          }
          const lists = s.lists.filter((list) => list.id !== listId);
          const activeListId = s.activeListId === listId ? null : s.activeListId;
          return [Result.succeed(undefined), new TrackerState({ ...s, lists, activeListId })];
        });
      });

      const setActiveList = Effect.fn("TrackerStore.setActiveList")(function* (
        listId: number | null,
      ) {
        return yield* mutate((s): readonly [Result.Result<void, TrackerError>, TrackerState] => {
          if (listId === null) {
            return [Result.succeed(undefined), new TrackerState({ ...s, activeListId: null })];
          }
          if (!s.lists.some((list) => list.id === listId)) {
            return [
              Result.fail(
                new TrackerError({
                  reason: "ListNotFound",
                  message: listNotFoundMessage(s, listId),
                  listId,
                }),
              ),
              s,
            ];
          }
          return [Result.succeed(undefined), new TrackerState({ ...s, activeListId: listId })];
        });
      });

      const addItem = Effect.fn("TrackerStore.addItem")(function* (listId: number, text: string) {
        const trimmed = text.trim();
        if (trimmed === "") {
          return yield* new TrackerError({
            reason: "EmptyText",
            message: "Item text must not be empty",
          });
        }
        return yield* mutate(
          (s): readonly [Result.Result<TodoItem, TrackerError>, TrackerState] => {
            const list = s.lists.find((l) => l.id === listId);
            if (!list) {
              return [
                Result.fail(
                  new TrackerError({
                    reason: "ListNotFound",
                    message: listNotFoundMessage(s, listId),
                    listId,
                  }),
                ),
                s,
              ];
            }
            const item = new TodoItem({ text: trimmed, done: false });
            const lists = s.lists.map((l) =>
              l.id === listId
                ? new TodoList({ id: l.id, name: l.name, items: [...l.items, item] })
                : l,
            );
            return [Result.succeed(item), new TrackerState({ ...s, lists })];
          },
        );
      });

      const addItems = Effect.fn("TrackerStore.addItems")(function* (
        listId: number,
        texts: readonly string[],
      ) {
        const trimmed = texts.map((text) => text.trim());
        if (trimmed.some((text) => text === "")) {
          return yield* new TrackerError({
            reason: "EmptyText",
            message: "Item text must not be empty",
          });
        }
        return yield* mutate(
          (s): readonly [Result.Result<TodoItem[], TrackerError>, TrackerState] => {
            const list = s.lists.find((l) => l.id === listId);
            if (!list) {
              return [
                Result.fail(
                  new TrackerError({
                    reason: "ListNotFound",
                    message: listNotFoundMessage(s, listId),
                    listId,
                  }),
                ),
                s,
              ];
            }
            const items = trimmed.map((text) => new TodoItem({ text, done: false }));
            const lists = s.lists.map((l) =>
              l.id === listId
                ? new TodoList({ id: l.id, name: l.name, items: [...l.items, ...items] })
                : l,
            );
            return [Result.succeed(items), new TrackerState({ ...s, lists })];
          },
        );
      });

      const updateItem = Effect.fn("TrackerStore.updateItem")(function* (
        itemId: string,
        patch: UpdateItemPatch,
      ) {
        const trimmed = patch.text === undefined ? undefined : patch.text.trim();
        if (patch.text !== undefined && trimmed === "") {
          return yield* new TrackerError({
            reason: "EmptyText",
            message: "Item text must not be empty",
          });
        }
        return yield* mutate(
          (s): readonly [Result.Result<TodoItem, TrackerError>, TrackerState] => {
            const resolved = resolveItemOrError(s, itemId);
            if (!resolved.ok) {
              return [Result.fail(resolved.error), s];
            }
            const { list, item } = resolved;
            if (patch.text === undefined && patch.done === undefined) {
              // No-op patch: return the current item, leave state untouched.
              return [Result.succeed(item), s];
            }
            const next = new TodoItem({
              text: trimmed ?? item.text,
              done: patch.done ?? item.done,
            });
            const lists = s.lists.map((l) =>
              l.id === list.id
                ? new TodoList({
                    id: l.id,
                    name: l.name,
                    items: l.items.map((i, idx) => (idx === resolved.index - 1 ? next : i)),
                  })
                : l,
            );
            return [Result.succeed(next), new TrackerState({ ...s, lists })];
          },
        );
      });

      /**
       * Batched updates. Each patch's `itemId` names its own list
       * (`listName:index`), so one batch may span several lists. The whole
       * batch fails atomically if any target is missing.
       */
      const updateItems = Effect.fn("TrackerStore.updateItems")(function* (
        patches: readonly UpdateItemPatchWithId[],
      ) {
        // Reject empty replacement texts up front so the whole batch fails
        // before touching the state (atomicity).
        for (const patch of patches) {
          if (patch.text !== undefined && patch.text.trim() === "") {
            return yield* new TrackerError({
              reason: "EmptyText",
              message: "Item text must not be empty",
            });
          }
        }
        return yield* mutate(
          (s): readonly [Result.Result<TodoItem[], TrackerError>, TrackerState] => {
            // Every target item must exist; the batch fails atomically otherwise.
            const resolved: Array<{
              readonly index: number;
              readonly list: TodoList;
              readonly item: TodoItem;
            }> = [];
            for (const patch of patches) {
              const r = resolveItemOrError(s, patch.itemId);
              if (!r.ok) {
                return [Result.fail(r.error), s];
              }
              resolved.push({ index: r.index, list: r.list, item: r.item });
            }
            // All-empty batch: return the current items, leave state untouched.
            if (patches.every((patch) => patch.text === undefined && patch.done === undefined)) {
              return [Result.succeed(resolved.map((r) => r.item)), s];
            }
            // Later patches win for duplicate positions. Group by list id so
            // affected lists are rebuilt exactly once each.
            const byList = new Map<number, Map<number, UpdateItemPatch>>();
            for (const [i, patch] of patches.entries()) {
              const listId = resolved[i]!.list.id;
              let patchesByIndex = byList.get(listId);
              if (!patchesByIndex) {
                patchesByIndex = new Map();
                byList.set(listId, patchesByIndex);
              }
              patchesByIndex.set(resolved[i]!.index, patch);
            }
            const lists = s.lists.map((l) => {
              const patchesByIndex = byList.get(l.id);
              if (!patchesByIndex) return l;
              const nextItems = l.items.map((item, idx) => {
                const patch = patchesByIndex.get(idx + 1);
                if (!patch) return item;
                const text = patch.text === undefined ? item.text : patch.text.trim();
                const done = patch.done ?? item.done;
                return new TodoItem({ text, done });
              });
              return new TodoList({ id: l.id, name: l.name, items: nextItems });
            });
            return [
              // Results in patch order so the caller can map them 1:1.
              Result.succeed(
                resolved.map((r) => lists.find((l) => l.id === r.list.id)!.items[r.index - 1]!),
              ),
              new TrackerState({ ...s, lists }),
            ];
          },
        );
      });

      /**
       * Remove an item. Positions shift implicitly: the item that followed
       * the removed one takes its index, so `Work:3` becomes `Work:2`. The
       * error message lists the fresh ids for a stale reference.
       */
      const removeItem = Effect.fn("TrackerStore.removeItem")(function* (itemId: string) {
        return yield* mutate((s): readonly [Result.Result<void, TrackerError>, TrackerState] => {
          const resolved = resolveItemOrError(s, itemId);
          if (!resolved.ok) {
            return [Result.fail(resolved.error), s];
          }
          const { list, index } = resolved;
          const lists = s.lists.map((l) =>
            l.id === list.id
              ? new TodoList({
                  id: l.id,
                  name: l.name,
                  items: l.items.filter((_, idx) => idx !== index - 1),
                })
              : l,
          );
          return [Result.succeed(undefined), new TrackerState({ ...s, lists })];
        });
      });

      return TrackerStore.of({
        state,
        reset,
        createList,
        deleteList,
        setActiveList,
        addItem,
        addItems,
        updateItem,
        updateItems,
        removeItem,
      });
    }),
  );
}
