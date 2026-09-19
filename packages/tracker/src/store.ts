import { Context, Effect, Layer, Ref, Result, Schema } from "effect";
import { blockersOf, cyclePath, dependentsOf, formatItemRef, parseItemRef } from "./deps.ts";
import { TodoItem, TodoList, TrackerState, emptyState } from "./domain.ts";

// --------------------------------------------------------------------------
// Errors
// --------------------------------------------------------------------------

const Reason = Schema.Union([
  Schema.Literal("ListNotFound"),
  Schema.Literal("ItemNotFound"),
  Schema.Literal("EmptyText"),
  Schema.Literal("DuplicateListName"),
  Schema.Literal("DependencyNotFound"),
  Schema.Literal("CrossListDependency"),
  Schema.Literal("DependencyCycle"),
  Schema.Literal("ItemBlocked"),
  Schema.Literal("ItemDependedOn"),
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

/** Outcome of resolving an item id against a state. */
type ResolvedItem =
  | { readonly kind: "malformed" }
  | { readonly kind: "noList"; readonly listName: string }
  | { readonly kind: "noItem"; readonly list: TodoList }
  | {
      readonly kind: "ok";
      readonly list: TodoList;
      readonly item: TodoItem;
      /** 0-based position of the item within its list. */
      readonly index: number;
    };

/**
 * Resolve `listName:id` against the current state. The id is permanent, so a
 * reference keeps pointing at the same item after other items are removed.
 */
const resolveItem = (s: TrackerState, itemId: string): ResolvedItem => {
  const parsed = parseItemRef(itemId);
  if (!parsed) return { kind: "malformed" };
  const list = s.lists.find((l) => l.name === parsed.name);
  if (!list) return { kind: "noList", listName: parsed.name };
  const index = list.items.findIndex((item) => item.id === parsed.id);
  const item = index === -1 ? undefined : list.items[index];
  if (!item) return { kind: "noItem", list };
  return { kind: "ok", list, item, index };
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
          message: `Item "${itemId}" must look like "listName:id" (e.g. "Work:2")`,
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
    case "noItem":
      return {
        ok: false,
        error: new TrackerError({
          reason: "ItemNotFound",
          message: itemNotFoundMessage(resolved.list, itemId),
          listId: resolved.list.id,
          itemId,
        }),
      };
    case "ok":
      return { ok: true, list: resolved.list, item: resolved.item, index: resolved.index };
  }
};

/** Ids the caller can use instead, formatted as `listName:id`. */
const availableItemIds = (list: TodoList): string =>
  list.items.map((item) => `${list.name}:${item.id}`).join(", ");

/**
 * `Item "Work:9" not found in list "Work" — available: Work:1, Work:3`.
 * Shared by the item, batch, and dependency paths so each names usable ids.
 */
const notFoundMessage = (subject: string, label: string, list: TodoList): string => {
  const available = availableItemIds(list);
  return available === ""
    ? `${label} "${subject}" not found in list "${list.name}" (no items)`
    : `${label} "${subject}" not found in list "${list.name}" — available: ${available}`;
};

const itemNotFoundMessage = (list: TodoList, itemId: string): string =>
  notFoundMessage(itemId, "Item", list);

/**
 * The next item id to hand out: the stored counter, raised past the highest id
 * in the list. Never below 1, so a list with an unset counter still hands out
 * a usable id, and a removed id is never reused.
 */
const nextItemIdFor = (items: readonly TodoItem[], counter: number): number =>
  items.reduce((max, item) => Math.max(max, item.id + 1), Math.max(counter, 1));

/** A copy of `list` with a replaced item array and a counter above its ids. */
const withItems = (list: TodoList, items: readonly TodoItem[]): TodoList =>
  new TodoList({
    id: list.id,
    name: list.name,
    items: [...items],
    nextItemId: nextItemIdFor(items, list.nextItemId),
  });

// --------------------------------------------------------------------------
// Store
// --------------------------------------------------------------------------

/**
 * How a caller declares an item to create: the bare text, or an object that
 * also carries the ids of the same-list items this one waits for.
 */
export type ItemSpec = string | { readonly text: string; readonly deps?: readonly string[] };

/** Trim a spec's text and settle its dependency refs. */
const normalizeSpec = (
  spec: ItemSpec,
): { readonly text: string; readonly deps: readonly string[] } => {
  if (typeof spec === "string") return { text: spec.trim(), deps: [] };
  return { text: spec.text.trim(), deps: spec.deps ?? [] };
};

/**
 * The first problem with `deps` for the item at `targetIndex`, or null when
 * every dependency is valid. `list` must already contain the item and its
 * siblings, so a reference to an item created by the same call resolves.
 *
 * Checks run in order: reference shape, same-list rule, existence, a self
 * reference, then whether the resulting graph stays acyclic.
 */
const firstDependencyError = (
  list: TodoList,
  targetIndex: number,
  deps: readonly string[],
): TrackerError | null => {
  const target = list.items[targetIndex];
  for (const ref of deps) {
    const parsed = parseItemRef(ref);
    if (parsed === null) {
      return new TrackerError({
        reason: "DependencyNotFound",
        message: `Dependency "${ref}" must look like "listName:id" (e.g. "Work:2")`,
      });
    }
    if (parsed.name !== list.name) {
      return new TrackerError({
        reason: "CrossListDependency",
        message:
          `Dependency "${ref}" is in another list. Dependencies must be in "${list.name}" ` +
          `(e.g. "${list.name}:${parsed.id}")`,
      });
    }
    if (!list.items.some((item) => item.id === parsed.id)) {
      return new TrackerError({
        reason: "DependencyNotFound",
        message: notFoundMessage(ref, "Dependency", list),
      });
    }
    if (target !== undefined && target.id === parsed.id) {
      return new TrackerError({
        reason: "DependencyCycle",
        message: `Item "${ref}" cannot depend on itself`,
      });
    }
  }
  const cycle = cyclePath(list, targetIndex, deps);
  if (cycle === null) return null;
  const where =
    cycle.length === 0
      ? `involving "${list.name}:${target?.id ?? targetIndex + 1}"`
      : `: ${cycle.join(" → ")}`;
  return new TrackerError({
    reason: "DependencyCycle",
    message: `Dependency cycle${where}. Change or clear one of these dependencies`,
  });
};

/**
 * The refusal for completing a blocked item, or null when the item is already
 * done or every dependency is done. Completion is gated; reopening is not, so
 * a dependency that is reopened can always be re-closed or dropped.
 */
const blockedError = (list: TodoList, index: number): TrackerError | null => {
  const blockers = blockersOf(list, index);
  if (blockers.length === 0) return null;
  const subject = formatItemRef(list.name, list.items[index]!.id);
  return new TrackerError({
    reason: "ItemBlocked",
    message:
      `Item "${subject}" is blocked by ${blockers.join(", ")}. ` +
      "Complete those items first, or clear this item's dependencies",
    itemId: subject,
  });
};

/** The refusal for removing an item that other items depend on, or null. */
const dependedOnError = (list: TodoList, index: number, itemId: string): TrackerError | null => {
  const dependents = dependentsOf(list, index);
  if (dependents.length === 0) return null;
  const names = dependents
    .map((dependent) => formatItemRef(list.name, list.items[dependent]!.id))
    .join(", ");
  return new TrackerError({
    reason: "ItemDependedOn",
    message:
      `Item "${itemId}" has dependents: ${names}. ` + "Remove or change those dependencies first",
    itemId,
  });
};

export interface UpdateItemPatch {
  readonly text?: string;
  readonly done?: boolean;
  /** Replacement dependency set (same-list `listName:id` refs); `[]` clears it. */
  readonly deps?: readonly string[];
}

/**
 * An `UpdateItemPatch` that targets an item by id within a single list
 * (mirrors `add_item`'s `list_id + text[]` shape: the list is factored out,
 * the patches name their item).
 */
export interface UpdateItemInListPatch extends UpdateItemPatch {
  /** The item's `listName:id` reference, e.g. "Work:2". */
  readonly itemId: string;
}

/** Options for `createList`: activation behavior and initial items. */
export interface CreateListOptions {
  /** Make the new list the active list (defaults to true). */
  readonly activate?: boolean;
  /** Initial items, added when the list is created (atomic with the list). */
  readonly initialItems?: readonly ItemSpec[];
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
    readonly addItem: (
      listId: number,
      text: string,
      deps?: readonly string[],
    ) => Effect.Effect<TodoItem, TrackerError>;
    readonly addItems: (
      listId: number,
      specs: readonly ItemSpec[],
    ) => Effect.Effect<TodoItem[], TrackerError>;
    readonly updateItem: (
      itemId: string,
      patch: UpdateItemPatch,
    ) => Effect.Effect<TodoItem, TrackerError>;
    readonly updateItems: (
      listId: number,
      patches: readonly UpdateItemInListPatch[],
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
        const initialSpecs = (options.initialItems ?? []).map(normalizeSpec);
        if (initialSpecs.some((spec) => spec.text === "")) {
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
            const items = initialSpecs.map(
              (spec, index) =>
                new TodoItem({ id: index + 1, text: spec.text, done: false, deps: [...spec.deps] }),
            );
            const list = new TodoList({
              id: s.nextListId,
              name: trimmed,
              items,
              nextItemId: items.length + 1,
            });
            // Dependencies are checked against the new list itself, so an
            // initial item may depend on a sibling from the same call.
            for (const [index, item] of items.entries()) {
              const error = firstDependencyError(list, index, item.deps);
              if (error !== null) return [Result.fail(error), s];
            }
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

      /**
       * Append items to a list, assigning ids from the list counter. Accepts
       * bare text or `{ text, deps }` objects; a dependency may name an item
       * created by this same call.
       */
      const addItems = Effect.fn("TrackerStore.addItems")(function* (
        listId: number,
        items: readonly ItemSpec[],
      ) {
        const specs = items.map(normalizeSpec);
        if (specs.some((spec) => spec.text === "")) {
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
            let nextId = nextItemIdFor(list.items, list.nextItemId);
            const added = specs.map((spec) => {
              const item = new TodoItem({
                id: nextId,
                text: spec.text,
                done: false,
                deps: [...spec.deps],
              });
              nextId += 1;
              return item;
            });
            const nextList = withItems(list, [...list.items, ...added]);
            // Validate against the post-insertion list, so a dependency may
            // name a sibling created by this same call.
            for (const [offset, item] of added.entries()) {
              const error = firstDependencyError(nextList, list.items.length + offset, item.deps);
              if (error !== null) return [Result.fail(error), s];
            }
            const lists = s.lists.map((l) => (l.id === listId ? nextList : l));
            return [Result.succeed(added), new TrackerState({ ...s, lists })];
          },
        );
      });

      const addItem = Effect.fn("TrackerStore.addItem")(function* (
        listId: number,
        text: string,
        deps: readonly string[] = [],
      ) {
        const [item] = yield* addItems(listId, [{ text, deps }]);
        return item!;
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
            // Completion is gated on the list as it stands: an item may only be
            // completed once its dependencies are done. Reopening and text or
            // dependency edits stay open, so a blocked item can be repaired.
            if (patch.done === true) {
              const blocked = blockedError(list, resolved.index);
              if (blocked !== null) return [Result.fail(blocked), s];
            }
            if (patch.text === undefined && patch.done === undefined && patch.deps === undefined) {
              // No-op patch: return the current item, leave state untouched.
              return [Result.succeed(item), s];
            }
            const next = new TodoItem({
              id: item.id,
              text: trimmed ?? item.text,
              done: patch.done ?? item.done,
              deps: patch.deps === undefined ? item.deps : [...patch.deps],
            });
            const nextList = withItems(
              list,
              list.items.map((i) => (i.id === item.id ? next : i)),
            );
            // The replacement set is validated against the list the change
            // produces, so dependencies are checked exactly as they will be
            // stored. The item keeps its position, so the index still holds.
            const error = firstDependencyError(nextList, resolved.index, next.deps);
            if (error !== null) return [Result.fail(error), s];
            const lists = s.lists.map((l) => (l.id === list.id ? nextList : l));
            return [Result.succeed(next), new TrackerState({ ...s, lists })];
          },
        );
      });

      /**
       * Per-list batched updates, mirroring `addItems(listId, texts)`: the
       * list is named once and each patch targets an item by id within that
       * list. The whole batch fails atomically if the list is missing or any
       * id does not resolve.
       */
      const updateItems = Effect.fn("TrackerStore.updateItems")(function* (
        listId: number,
        patches: readonly UpdateItemInListPatch[],
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
            // Resolve every target id within this single list; the batch fails
            // atomically if any of them does not resolve. A reference naming
            // another list does not resolve here either.
            const targets: number[] = [];
            for (const patch of patches) {
              const parsed = parseItemRef(patch.itemId);
              if (parsed === null) {
                return [
                  Result.fail(
                    new TrackerError({
                      reason: "ItemNotFound",
                      message: `Item "${patch.itemId}" must look like "listName:id" (e.g. "Work:2")`,
                      listId,
                      itemId: patch.itemId,
                    }),
                  ),
                  s,
                ];
              }
              const index =
                parsed.name === list.name
                  ? list.items.findIndex((item) => item.id === parsed.id)
                  : -1;
              if (index === -1) {
                return [
                  Result.fail(
                    new TrackerError({
                      reason: "ItemNotFound",
                      message: itemNotFoundMessage(list, patch.itemId),
                      listId,
                      itemId: patch.itemId,
                    }),
                  ),
                  s,
                ];
              }
              targets.push(index);
            }
            // Later patches win for duplicate ids.
            const byIndex = new Map<number, UpdateItemPatch>();
            patches.forEach((patch, index) => byIndex.set(targets[index]!, patch));
            // Every completion in the batch is gated on the list as it stands,
            // so one call cannot complete an item that is still blocked. Mark
            // the blocker done first, then complete the dependent.
            for (const [index, patch] of patches.entries()) {
              if (patch.done !== true) continue;
              const blocked = blockedError(list, targets[index]!);
              if (blocked !== null) return [Result.fail(blocked), s];
            }
            const nextItems = list.items.map((item, index) => {
              const patch = byIndex.get(index);
              if (!patch) return item;
              return new TodoItem({
                id: item.id,
                text: patch.text === undefined ? item.text : patch.text.trim(),
                done: patch.done ?? item.done,
                deps: patch.deps === undefined ? item.deps : [...patch.deps],
              });
            });
            const nextList = withItems(list, nextItems);
            // Validate every dependency change against the batch's result, so
            // two patches that would only close a cycle together are refused.
            for (const [index, patch] of patches.entries()) {
              if (patch.deps === undefined) continue;
              const target = targets[index]!;
              const error = firstDependencyError(nextList, target, nextItems[target]!.deps);
              if (error !== null) return [Result.fail(error), s];
            }
            const lists = s.lists.map((l) => (l.id === listId ? nextList : l));
            return [
              // Results in patch order so the caller can map them 1:1.
              Result.succeed(targets.map((index) => nextItems[index]!)),
              new TrackerState({ ...s, lists }),
            ];
          },
        );
      });

      /**
       * Remove an item. Its id is never reused and the ids of the items after it
       * do not change, so a reference the caller already holds keeps pointing at
       * the same item. A stale reference still lists every id that does resolve.
       * An item that other items depend on cannot be removed: the dependents
       * would be left dangling.
       */
      const removeItem = Effect.fn("TrackerStore.removeItem")(function* (itemId: string) {
        return yield* mutate((s): readonly [Result.Result<void, TrackerError>, TrackerState] => {
          const resolved = resolveItemOrError(s, itemId);
          if (!resolved.ok) {
            return [Result.fail(resolved.error), s];
          }
          const { list, item } = resolved;
          const dependedOn = dependedOnError(list, resolved.index, itemId);
          if (dependedOn !== null) return [Result.fail(dependedOn), s];
          const lists = s.lists.map((l) =>
            l.id === list.id
              ? withItems(
                  l,
                  l.items.filter((i) => i.id !== item.id),
                )
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
