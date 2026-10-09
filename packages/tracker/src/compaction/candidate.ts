import { dependentsOf, formatItemRef, readiness } from "../core/deps.ts";
import type { DeclaredProduct, DeclaredReference } from "../core/domain.ts";
import type { PendingCompletion } from "./completion.ts";

/** Why the candidate was chosen; the classifier question is keyed by this. */
export type CandidateClass = "dependent-successor" | "ready-queue";

/** One item from the completed batch, as referenced prior work. */
export interface CompletedItem {
  readonly ref: string;
  readonly text: string;
  /** The item's description, when it carries one. Part of the batch text. */
  readonly description?: string;
}

/** The single next unfinished item, with the batch as referenced prior work. */
export interface CompactionCandidate {
  readonly class: CandidateClass;
  readonly listName: string;
  readonly id: number;
  /** The item's title. */
  readonly text: string;
  /** The item's description, when it carries one. */
  readonly description?: string;
  /** Every item completed since the last decision. Never the subject. */
  readonly completed: readonly CompletedItem[];
  /** The item's declared references, when it carries any. */
  readonly refs?: readonly DeclaredReference[];
  /** The item's declared products, when it carries any. */
  readonly produces?: readonly DeclaredProduct[];
}

/**
 * The single next unfinished item: the first open ready item in list order that
 * depends on any item in the completed batch, else the first remaining ready
 * item in list order, excluding every completed item. Reuses the readiness and
 * dependent-set derivations (`deps.ts`); adds no graph behavior.
 *
 * The candidates to judge, in decision order: the ready dependent successors
 * first (in list order), then the remaining ready items (in list order),
 * excluding every completed item, capped at `limit`. The first entry is the
 * pointer target, so it matches the old single candidate; the array is empty
 * when nothing is ready.
 */
export const selectCandidates = (
  completion: PendingCompletion,
  limit: number,
): readonly CompactionCandidate[] => {
  const { list } = completion;
  const completedIds = new Set(completion.completedItemIds);
  const completed: CompletedItem[] = completion.completedItemIds.flatMap((id) => {
    const item = list.items.find((candidate) => candidate.id === id);
    if (item === undefined) return [];
    return [
      {
        ref: formatItemRef(list.name, id),
        text: item.title,
        ...(item.description === undefined || item.description.length === 0
          ? {}
          : { description: item.description }),
      },
    ];
  });

  // The completed items were selected because the candidate depends on one of
  // them; a blocked dependent is skipped and the ready queue takes over.
  const completedIndexes = list.items
    .map((item, index) => (completedIds.has(item.id) ? index : -1))
    .filter((index) => index >= 0);
  const dependentIndexes = new Set(
    completedIndexes.flatMap((index) => [...dependentsOf(list, index)]),
  );
  const view = readiness(list);

  const make = (index: number, cls: CandidateClass): CompactionCandidate => {
    const item = list.items[index]!;
    return {
      class: cls,
      listName: list.name,
      id: item.id,
      text: item.title,
      ...(item.description === undefined || item.description.length === 0
        ? {}
        : { description: item.description }),
      completed,
      ...(item.refs.length === 0 ? {} : { refs: item.refs }),
      ...(item.produces.length === 0 ? {} : { produces: item.produces }),
    };
  };

  const ordered: CompactionCandidate[] = [];
  const take = (index: number, cls: CandidateClass): void => {
    if (ordered.length < limit) ordered.push(make(index, cls));
  };
  for (let index = 0; index < list.items.length && ordered.length < limit; index += 1) {
    if (view[index]!.ready && dependentIndexes.has(index)) take(index, "dependent-successor");
  }
  for (let index = 0; index < list.items.length && ordered.length < limit; index += 1) {
    const item = list.items[index]!;
    if (view[index]!.ready && !completedIds.has(item.id) && !dependentIndexes.has(index)) {
      take(index, "ready-queue");
    }
  }
  return ordered;
};
