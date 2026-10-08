import type { JsonObject } from "@earendil-works/pi-ai";
import type { CandidateClass, CompactionCandidate } from "../src/compaction/candidate.ts";
import { buildDigests, compactQuestions } from "../src/compaction/digest.ts";
import type { CompactionQuestion } from "../src/compaction/classifier.ts";
import type { StoredCase } from "./case-file.ts";
import { candidateViews, questionViews } from "./derive.ts";

/**
 * Rebuild the classifier input from a stored case.
 *
 * `cases.jsonl` keeps the digest and the questions as the product rendered
 * them, not the candidates behind them. The candidates are still recoverable:
 * `selectCandidates` gives every judged candidate the whole completed batch as
 * `completed`, so `listName`, `id`, and `completed` follow from the case alone.
 *
 * `replayMatches` proves the rebuild: it re-renders the digest and the
 * questions and compares them with the stored copies. The eval corpus passes
 * for every labeled case, so a frozen answer belongs to the input the product
 * would have sent.
 */

/** The stored candidate class, narrowed. The corpus only holds the two. */
const classOf = (value: string): CandidateClass =>
  value === "dependent-successor" ? "dependent-successor" : "ready-queue";

/** Split `listName:id` at the last colon, so a list name may hold one. */
const splitRef = (ref: string): { readonly listName: string; readonly id: number } => {
  const at = ref.lastIndexOf(":");
  return { listName: ref.slice(0, at), id: Number(ref.slice(at + 1)) };
};

/** Rebuild the judged candidates, in decision order, from a stored case. */
export const candidatesOf = (stored: StoredCase): readonly CompactionCandidate[] => {
  const completed = stored.completed.map((item) => ({ ref: item.ref, text: item.text }));
  return stored.candidates.map((candidate) => ({
    class: classOf(candidate.class),
    ...splitRef(candidate.ref),
    text: candidate.text,
    completed,
  }));
};

/** The exact digest and question set the product would send for this case. */
export const classifierInput = (
  stored: StoredCase,
): { readonly digest: JsonObject; readonly questions: readonly CompactionQuestion[] } => {
  const candidates = candidatesOf(stored);
  return {
    digest: buildDigests(candidates),
    questions: compactQuestions(candidates),
  };
};

/** True when the rebuild reproduces every stored view of the input. */
export const replayMatches = (stored: StoredCase): boolean => {
  const candidates = candidatesOf(stored);
  const digest = buildDigests(candidates);
  return (
    JSON.stringify(candidateViews(digest)) === JSON.stringify(stored.candidates) &&
    JSON.stringify(digest.completed) === JSON.stringify(stored.completed) &&
    JSON.stringify(questionViews(candidates)) === JSON.stringify(stored.questions)
  );
};
