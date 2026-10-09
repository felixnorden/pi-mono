import { readFileSync } from "node:fs";
import type { DeclaredProduct, DeclaredReference } from "../src/core/domain.ts";
import type { EvidenceEntry } from "./evidence.ts";

/**
 * The shape of the two corpus files.
 *
 * `harvest.ts` writes them and `review.ts` reads them, so the shape lives in one
 * place. Every string in these files has already passed through `redact.ts`.
 */

/** One item of a stored list. */
export interface StoredItem {
  readonly id: number;
  readonly text: string;
  /** The item's description, when it carried one. Part of the batch text. */
  readonly description?: string;
  readonly done: boolean;
  readonly deps: readonly string[];
}

/** One judged candidate, as written to `cases.jsonl`. */
export interface StoredCandidate {
  readonly ref: string;
  readonly text: string;
  /** The digest's capped description, when the item carried one. */
  readonly description?: string;
  readonly class: string;
  readonly relationship: string;
  /** The declarations the item carried, as authored. */
  readonly refs?: readonly DeclaredReference[];
  readonly produces?: readonly DeclaredProduct[];
}

/** One resolved reference, as the decision record carries it. */
export interface StoredDecisionReference {
  readonly kind: string;
  readonly path?: string;
  readonly symbol?: string;
  readonly span?: string;
  readonly topic?: string;
  readonly state: string;
}

/** One resolved product, as the decision record carries it. */
export interface StoredDecisionProduct {
  readonly path: string;
  readonly state: string;
}

/**
 * The live decision record for one case, read from the session's
 * `tracker/reliance-decision` custom entry. Present only when the candidate
 * declared a reference or a product.
 */
export interface StoredDecision {
  readonly rule: string;
  readonly verdict: string;
  readonly candidateRef: string;
  readonly references: readonly StoredDecisionReference[];
  readonly products: readonly StoredDecisionProduct[];
}

/** One decision, as written to `cases.jsonl`. */
export interface StoredCase {
  readonly caseId: string;
  readonly session: { readonly dir: string; readonly file: string };
  readonly at: string;
  readonly index: number;
  readonly list: {
    readonly id: number;
    readonly name: string;
    readonly items: readonly StoredItem[];
  };
  readonly completed: readonly {
    readonly ref: string;
    readonly text: string;
    readonly description?: string;
  }[];
  readonly candidates: readonly StoredCandidate[];
  readonly questions: readonly {
    readonly key: string;
    readonly instructions: string;
    readonly criteria: Readonly<Record<string, string>>;
  }[];
  readonly frontier: number;
  readonly itemCount: number;
  readonly openCount: number;
  readonly doneCount: number;
  readonly declaredDeps: number;
  /**
   * The rule row the live settle path fired for the pointer candidate, present
   * only for a decision that carried declarations. A corpus harvested before
   * the decision record existed lacks it.
   */
  readonly decision?: StoredDecision;
  /** True for the checked-in synthetic fixture, never for a real session. */
  readonly synthetic?: boolean;
  /**
   * How large the conversation was at the decision. Optional so a corpus
   * harvested before the context pass still parses.
   */
  readonly context?: {
    readonly entries: number;
    readonly messages: number;
    readonly chars: number;
    readonly inputTokens: number;
  };
}

/** The work record for one case, as written to `evidence.jsonl`. */
export interface StoredEvidence {
  readonly caseId: string;
  readonly entries: readonly EvidenceEntry[];
  readonly omitted: number;
}

/** One frozen two-label answer, as returned for a candidate question. */
export interface StoredChoiceAnswer {
  readonly choice: string;
  readonly probabilities: Readonly<Record<string, number>>;
  readonly confidence: number;
}

/** One frozen bool answer, as returned for a `bool` question. */
export interface StoredBoolAnswer {
  readonly probability: number;
}

/**
 * One frozen answer value. A `choice` answer carries labels and a confidence;
 * a `bool` answer carries one probability and no confidence. The two are told
 * apart by shape, so a corpus written before bool support still parses.
 */
export type StoredAnswerValue = StoredChoiceAnswer | StoredBoolAnswer;

/**
 * One frozen classifier answer set for a case, as written to `answers.jsonl`.
 *
 * Answers are frozen so the knob sweep is reproducible: the classifier is not
 * called again, and every grid point is scored against the same input.
 */
export interface StoredAnswer {
  readonly caseId: string;
  readonly at: string;
  readonly provider: string;
  readonly model: string;
  readonly stopReason: string;
  readonly errorMessage?: string;
  /** Keyed by question key. A question with no answer is absent. */
  readonly answers: Readonly<Record<string, StoredAnswerValue>>;
}

/** Parse a JSONL file into records. A missing file yields an empty array. */
export const readJsonl = <T>(path: string): readonly T[] => {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as T);
};
