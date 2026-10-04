import type { JsonObject } from "@earendil-works/pi-ai";
import { formatItemRef } from "../core/deps.ts";
import { NEEDS_CONTEXT_LABEL, NEEDS_NONE_LABEL, type CompactionQuestion } from "./classifier.ts";
import type { CompactionCandidate } from "./candidate.ts";

/**
 * The bounded classifier input: every ready candidate, each with its class and
 * its relationship to the completed batch, plus the batch itself as referenced
 * prior work. The transcript is never read.
 */

/** Shared prefix of the per-candidate classifier question key. */
export const QUESTION_KEY_PREFIX = "needsCompletedContext";

/**
 * A safe, unique question id for one candidate. Cloudflare Workers AI rejects
 * any id that does not match `^[A-Za-z0-9_.-]{1,100}$`, so the item reference
 * (`Work:2`) is sanitized and a positional index is appended for uniqueness.
 */
export const questionKey = (ref: string, index: number): string =>
  `${QUESTION_KEY_PREFIX}.${ref.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 60)}.${index}`;

const relationshipOf = (candidate: CompactionCandidate): string =>
  candidate.class === "dependent-successor"
    ? `depends on ${candidate.completed[0]?.ref ?? "the completed work"}`
    : `independent of ${candidate.completed.map((item) => item.ref).join(", ")}`;

/**
 * One entry per candidate plus the completed batch once. Exactly two keys.
 */
export const buildDigests = (candidates: readonly CompactionCandidate[]): JsonObject => ({
  candidates: candidates.map((candidate) => ({
    ref: formatItemRef(candidate.listName, candidate.id),
    text: candidate.text,
    class: candidate.class,
    relationship: relationshipOf(candidate),
  })),
  completed: (candidates[0]?.completed ?? []).map((item) => ({ ref: item.ref, text: item.text })),
});

/**
 * One two-label choice question per candidate, keyed by the candidate's
 * reference, so a single classifier call judges the whole ready frontier. The
 * candidate class chooses the wording, so a dependent successor and independent
 * work are asked different questions in the same call. The two labels stay
 * binary either way; `confidence` rides along on the answer.
 */
export const compactQuestions = (
  candidates: readonly CompactionCandidate[],
): readonly CompactionQuestion[] =>
  candidates.map((candidate, index) => {
    const ref = formatItemRef(candidate.listName, candidate.id);
    const dependent = candidate.class === "dependent-successor";
    return {
      key: questionKey(ref, index),
      question: {
        type: "choice",
        instructions: dependent
          ? `The completed work is about to leave the context. Does this ready item #${ref} ("${candidate.text}") need the detail of the completed item it depends on?`
          : `The completed work is about to leave the context. Does this ready item #${ref} ("${candidate.text}") need the detail of the completed work?`,
        criteria: {
          [NEEDS_CONTEXT_LABEL]: dependent
            ? "The item needs specifics of the completed work — an interface, decision, or value — that its own text does not carry."
            : "The item refers to the completed work or needs its details to proceed.",
          [NEEDS_NONE_LABEL]: dependent
            ? "The item's own text is self-contained and its dependency is only ordering."
            : "The item stands alone and does not need the completed detail.",
        },
      },
    };
  });
