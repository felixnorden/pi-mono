import type { JsonObject } from "@earendil-works/pi-ai";
import { formatItemRef } from "../core/deps.ts";
import { NEEDS_CONTEXT_LABEL, NEEDS_NONE_LABEL, type CompactionQuestion } from "./classifier.ts";
import type { CompactionCandidate } from "./candidate.ts";
import type { DeclaredReference, ProductState, ReferenceState } from "./observations.ts";

/**
 * The bounded classifier input: every ready candidate, each with its title,
 * its description, its class, its relationship to the completed batch, and its
 * resolved declarations, plus the batch itself as referenced prior work. One
 * survival instruction states what the item may still reach after compaction.
 * The transcript is never read.
 */

/** Shared prefix of the per-candidate classifier question key. */
export const QUESTION_KEY_PREFIX = "needsCompletedContext";

/** The most references one candidate's digest carries. */
export const REFERENCE_CAP = 8;
/** The most products one candidate's digest carries. */
export const PRODUCT_CAP = 4;
/** Characters of a description's first paragraph the digest keeps. */
export const DESCRIPTION_LIMIT = 400;

/** What survives compaction, stated once for the whole call. */
export const SURVIVAL_INSTRUCTION =
  "After compaction, each item's title and description survive, and a file that exists on disk survives. The transcript does not survive, so ask only whether the item needs a detail that its own title, its description, or an existing file does not carry.";

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

/** The first paragraph of a text, then the cap with a marker naming the cut. */
const descriptionOf = (text: string): string => {
  const paragraph = text.split(/\n\s*\n/)[0]?.trim() ?? "";
  return paragraph.length <= DESCRIPTION_LIMIT
    ? paragraph
    : `${paragraph.slice(0, DESCRIPTION_LIMIT)}… [${paragraph.length - DESCRIPTION_LIMIT} more characters]`;
};

/** One declared reference with the state it resolved to. */
const referenceOf = (reference: DeclaredReference, state: ReferenceState): JsonObject =>
  reference.kind === "decision"
    ? { kind: "decision", topic: reference.topic, state }
    : {
        kind: "path",
        path: reference.path,
        ...(reference.symbol === undefined ? {} : { symbol: reference.symbol }),
        ...(reference.span === undefined ? {} : { span: reference.span }),
        state,
      };

/** A bounded candidate state: title, description, relationship, declarations. */
const candidateOf = (
  candidate: CompactionCandidate,
  facts: {
    readonly references: readonly {
      readonly reference: DeclaredReference;
      readonly state: ReferenceState;
    }[];
    readonly products: readonly {
      readonly product: { readonly path: string };
      readonly state: ProductState;
    }[];
  },
): JsonObject => {
  const references = facts.references.slice(0, REFERENCE_CAP);
  const products = facts.products.slice(0, PRODUCT_CAP);
  const droppedReferences = facts.references.length - references.length;
  const droppedProducts = facts.products.length - products.length;
  return {
    ref: formatItemRef(candidate.listName, candidate.id),
    text: candidate.text,
    ...(candidate.description === undefined || candidate.description.length === 0
      ? {}
      : { description: descriptionOf(candidate.description) }),
    class: candidate.class,
    relationship: relationshipOf(candidate),
    references: references.map((entry) => referenceOf(entry.reference, entry.state)),
    products: products.map((entry) => ({ path: entry.product.path, state: entry.state })),
    ...(droppedReferences === 0
      ? {}
      : { referenceCut: `… [${droppedReferences} more references declared]` }),
    ...(droppedProducts === 0
      ? {}
      : { productCut: `… [${droppedProducts} more products declared]` }),
  };
};

/**
 * One entry per candidate plus the completed batch once, plus the survival
 * instruction. The state is facts only: a title, a description, a class, a
 * relationship, resolved references, resolved products, and their cut markers.
 */
export const buildDigests = (
  candidates: readonly CompactionCandidate[],
  facts: readonly {
    readonly references: readonly {
      readonly reference: DeclaredReference;
      readonly state: ReferenceState;
    }[];
    readonly products: readonly {
      readonly product: { readonly path: string };
      readonly state: ProductState;
    }[];
  }[] = [],
): JsonObject => ({
  candidates: candidates.map((candidate, index) =>
    candidateOf(candidate, facts[index] ?? { references: [], products: [] }),
  ),
  completed: (candidates[0]?.completed ?? []).map((item) => ({
    ref: item.ref,
    text: item.text,
    ...(item.description === undefined ? {} : { description: item.description }),
  })),
  survival: SURVIVAL_INSTRUCTION,
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
