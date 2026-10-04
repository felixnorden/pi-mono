import { Context, Effect, Layer, Option, Ref } from "effect";
import type { TodoList, TrackerState } from "../core/domain.ts";

/**
 * Completion detection and the pending-completion record.
 *
 * The record is in-memory only and never persisted. It carries the active list
 * as it stands and every item that transitioned open → done since the last
 * decision, as a batch. The batch is referenced prior work; the decision's
 * subject is always the next unfinished candidate.
 */

/** The completions a settle decision may act on. In memory only, never persisted. */
export interface PendingCompletion {
  /** The active list as it stands now; refreshed on every same-list mutation. */
  readonly list: TodoList;
  /** Every item that transitioned open → done since the last decision, in list order. */
  readonly completedItemIds: readonly number[];
}

/**
 * Ids of active-list items that transitioned open → done, in list order. Empty
 * when none. Only the active list is consulted, and a completion in another
 * list contributes nothing.
 */
export const completedInActiveList = (
  before: TrackerState,
  after: TrackerState,
): readonly number[] => {
  if (after.activeListId === null) return [];
  const activeAfter = after.lists.find((list) => list.id === after.activeListId);
  if (activeAfter === undefined) return [];
  const activeBefore = before.lists.find((list) => list.id === after.activeListId);
  const doneBefore = new Set(
    (activeBefore?.items ?? []).filter((item) => item.done).map((item) => item.id),
  );
  return activeAfter.items
    .filter((item) => item.done && !doneBefore.has(item.id))
    .map((item) => item.id);
};

/**
 * Live-record fold: refresh the snapshot from `after`; keep the previously
 * completed ids that are still done and present; add the new ones. A different
 * active list (or none) clears the record. An empty result clears it too, so a
 * reopen or removal between the completion and the settle cannot leave a
 * stale batch behind.
 */
const mergeLiveBatch = (
  current: Option.Option<PendingCompletion>,
  after: TrackerState,
  newlyCompleted: readonly number[],
): Option.Option<PendingCompletion> => {
  if (after.activeListId === null) return Option.none();
  const list = after.lists.find((candidate) => candidate.id === after.activeListId);
  if (list === undefined) return Option.none();

  const previousIds =
    Option.isSome(current) && current.value.list.id === list.id
      ? current.value.completedItemIds
      : [];
  const tracked = new Set<number>([...previousIds, ...newlyCompleted]);
  const completedItemIds = list.items
    .filter((item) => item.done && tracked.has(item.id))
    .map((item) => item.id);
  return completedItemIds.length === 0
    ? Option.none()
    : Option.some({ list, completedItemIds });
};

export class CompletionObserver extends Context.Service<
  CompletionObserver,
  {
    readonly record: (before: TrackerState, after: TrackerState) => Effect.Effect<void>;
    /** Read and clear in one step, so one completion set yields one decision. */
    readonly consume: Effect.Effect<Option.Option<PendingCompletion>>;
  }
>()("tracker/CompletionObserver") {
  static readonly layer: Layer.Layer<CompletionObserver> = Layer.effect(
    CompletionObserver,
    Effect.gen(function* () {
      const pending = yield* Ref.make(Option.none<PendingCompletion>());
      const record = Effect.fnUntraced(function* (before: TrackerState, after: TrackerState) {
        const newlyCompleted = completedInActiveList(before, after);
        // A mutation in a different active list (or a deselect/delete) clears
        // the record. Otherwise the snapshot follows the current list, and ids
        // that were reopened or removed drop out; an empty result clears it.
        yield* Ref.update(pending, (current) => mergeLiveBatch(current, after, newlyCompleted));
      });
      return CompletionObserver.of({
        record,
        consume: Ref.modify(pending, (current) => [current, Option.none<PendingCompletion>()]),
      });
    }),
  );
}
