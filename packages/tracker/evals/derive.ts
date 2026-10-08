import type { JsonObject } from "@earendil-works/pi-ai";
import { type CompactionCandidate, selectCandidates } from "../src/compaction/candidate.ts";
import { completedInActiveList } from "../src/compaction/completion.ts";
import { buildDigests, compactQuestions } from "../src/compaction/digest.ts";
import { formatItemRef } from "../src/core/deps.ts";
import type { TrackerState } from "../src/core/domain.ts";

/**
 * Derive one eval case per smart-compaction decision from a session's tracker
 * snapshots.
 *
 * The derivation calls the product's own pure functions, so a case is exactly
 * what the live settle path would have seen: `completedInActiveList` finds the
 * open → done transition, `selectCandidates` picks the ready frontier in
 * decision order, and `buildDigests` plus `compactQuestions` produce the
 * classifier input. Nothing here re-implements that logic, so the corpus
 * cannot drift from the product.
 *
 * Snapshots must already be decoded (`decodeStateEffect` + `migrateState`), so
 * every item has a real id.
 */

/** One tracker snapshot with the timestamp of the session entry that carried it. */
export interface TimedSnapshot {
  readonly at: string;
  readonly state: TrackerState;
}

/** One judged candidate, as the classifier digest presents it. */
export interface EventCandidate {
  readonly ref: string;
  readonly text: string;
  readonly class: string;
  readonly relationship: string;
}

/** One item of the completed batch, as referenced prior work. */
export interface EventCompleted {
  readonly ref: string;
  readonly text: string;
}

/** One item of the active list at the decision. */
export interface EventItem {
  readonly id: number;
  readonly text: string;
  readonly done: boolean;
  /** `listName:id` references to same-list items. */
  readonly deps: readonly string[];
}

/** One classifier question, without the constant `type` field. */
export interface EventQuestion {
  readonly key: string;
  readonly instructions: string;
  readonly criteria: Readonly<Record<string, string>>;
}

/** One decision the live tracker would have taken. */
export interface CompletionEvent {
  /** Ordinal within the session, in time order. */
  readonly index: number;
  /**
   * Index into the snapshot array this event was derived from. The harvest uses
   * it to find the session entries that hold the work for the batch: the entries
   * between this snapshot and the one that produced the previous event.
   */
  readonly snapshotIndex: number;
  readonly at: string;
  readonly listId: number;
  readonly listName: string;
  /**
   * Every item of the active list at the decision, in list order. The batch and
   * the frontier are views of this list; storing the whole list lets a labeler
   * see the plan shape, including items that are blocked or already done.
   */
  readonly items: readonly EventItem[];
  readonly completedItemIds: readonly number[];
  /** The batch, by reference. Computed directly so an empty frontier keeps it. */
  readonly completed: readonly EventCompleted[];
  /** The judged frontier, capped at the harvest's candidate limit. */
  readonly candidates: readonly EventCandidate[];
  /** One question per judged candidate, in the same order. */
  readonly questions: readonly EventQuestion[];
  /** Ready candidates before the cap. Larger than `candidates.length` when capped. */
  readonly frontier: number;
  readonly itemCount: number;
  readonly openCount: number;
  readonly doneCount: number;
  /** Open items that declare at least one dependency. */
  readonly declaredDeps: number;
}

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const stringField = (record: Record<string, unknown>, key: string): string =>
  String(record[key] ?? "");

/**
 * Read the digest back into a typed shape. A missing field yields an empty
 * string rather than failing the whole harvest; `manifest.json` reports how
 * many cases carried an empty field.
 */
export const candidateViews = (digest: JsonObject): readonly EventCandidate[] => {
  const raw = digest.candidates;
  if (!Array.isArray(raw)) return [];
  return raw.map((entry) => {
    const record = asRecord(entry);
    return {
      ref: stringField(record, "ref"),
      text: stringField(record, "text"),
      class: stringField(record, "class"),
      relationship: stringField(record, "relationship"),
    };
  });
};

export const questionViews = (
  candidates: readonly CompactionCandidate[],
): readonly EventQuestion[] =>
  compactQuestions(candidates).map(({ key, question }) => ({
    key,
    instructions: question.instructions,
    criteria: Object.fromEntries(
      Object.entries(question.criteria).map(([label, description]) => [label, String(description)]),
    ),
  }));

/**
 * One event per open → done transition in the active list.
 *
 * `candidateLimit` bounds the stored frontier, not the product's cap: the
 * replay slices this list again for each `maxCandidates` under test, and
 * `selectCandidates` fills in order, so a slice is the same list the product
 * would have built.
 */
export const deriveEvents = (
  snapshots: readonly TimedSnapshot[],
  candidateLimit: number,
): readonly CompletionEvent[] => {
  const events: CompletionEvent[] = [];
  for (let index = 1; index < snapshots.length; index += 1) {
    const previous = snapshots[index - 1]!;
    const current = snapshots[index]!;
    const completedItemIds = completedInActiveList(previous.state, current.state);
    if (completedItemIds.length === 0) continue;
    const list = current.state.lists.find((entry) => entry.id === current.state.activeListId);
    if (list === undefined) continue;

    const frontier = selectCandidates({ list, completedItemIds }, Number.MAX_SAFE_INTEGER);
    const judged = frontier.slice(0, candidateLimit);
    events.push({
      index: events.length,
      snapshotIndex: index,
      at: current.at,
      listId: list.id,
      listName: list.name,
      items: list.items.map((item) => ({
        id: item.id,
        text: item.text,
        done: item.done,
        deps: [...item.deps],
      })),
      completedItemIds,
      completed: completedItemIds.flatMap((id) => {
        const item = list.items.find((entry) => entry.id === id);
        return item === undefined ? [] : [{ ref: formatItemRef(list.name, id), text: item.text }];
      }),
      candidates: candidateViews(buildDigests(judged)),
      questions: questionViews(judged),
      frontier: frontier.length,
      itemCount: list.items.length,
      openCount: list.items.filter((item) => !item.done).length,
      doneCount: list.items.filter((item) => item.done).length,
      declaredDeps: list.items.filter((item) => !item.done && item.deps.length > 0).length,
    });
  }
  return events;
};
