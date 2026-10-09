/**
 * The reliance rule table.
 *
 * Every row is named for the observation it tests; the verdict is separate.
 * The declared rows fire only when the item carries declarations, and they come
 * first. The legacy rows reproduce the pre-revert rules exactly, under honest
 * names, so the corpus parity test can show the rename changed nothing.
 *
 * `ACCEPTED_RULES` is the product policy. A row that has not cleared the
 * two-pass gate reports its raw verdict and abstains, so an unmeasured row can
 * never compact on its own.
 */
import type { CompactionCandidate } from "./candidate.ts";
import {
  QRSPI_PLAN_DOCUMENT,
  productionFacts,
  resolveProducts,
  resolveReferences,
  type BatchFootprint,
  type FileProbe,
  type ResolvedProduct,
  type ResolvedReference,
} from "./observations.ts";

/** What the rule layer decides for one candidate. */
export type RuleVerdict = "keep" | "compact" | "abstain";

/** Everything the rows read. Declarations may be empty; the legacy facts may not. */
export interface RuleInput {
  /** Declared references, already resolved against the disk. */
  readonly references: readonly ResolvedReference[];
  /** Declared products, already resolved against the disk. */
  readonly products: readonly ResolvedProduct[];
  /** Every file path the candidate names. */
  readonly candidatePaths: readonly string[];
  /** The batch texts plus the work record, joined. A document named here was named. */
  readonly knownText: string;
  /** The `write` and `edit` call paths, joined. A path named here was produced. */
  readonly producedText: string;
  /** The candidate is a `dependent-successor`. */
  readonly dependent: boolean;
  /** The batch or the record names a plan, design, or outline document. */
  readonly planDocument: boolean;
}

export interface RuleDecision {
  readonly verdict: RuleVerdict;
  /** The rule id, stable across the report and the product. */
  readonly rule: string;
}

const hasDeclaration = (input: RuleInput): boolean =>
  input.references.length > 0 || input.products.length > 0;

/** The declaration facts one candidate resolves to. */
export interface CandidateFacts {
  readonly references: readonly ResolvedReference[];
  readonly products: readonly ResolvedProduct[];
  /** The candidate is a `dependent-successor`. */
  readonly dependent: boolean;
}

/**
 * Decide one candidate from the observations.
 *
 * The order matters. A lost reference keeps the context before anything else.
 * An unwritten plan product keeps it next, because the document it will write
 * needs the upstream decisions. A declared decision abstains: it is a semantic
 * claim, and the classifier is the judge. A drifted or unresolved declaration
 * abstains rather than compact on half a fact. Only then do the legacy rows
 * run, and they run exactly as the pre-revert table did.
 */
export const route = (input: RuleInput): RuleDecision => {
  // --- Declared rows: they fire only when the item carries declarations. ---
  if (input.references.some((entry) => entry.state === "lost")) {
    return { verdict: "keep", rule: "reference-is-lost" };
  }
  if (
    input.products.some(
      (entry) => entry.state === "missing" && QRSPI_PLAN_DOCUMENT.test(entry.product.path),
    )
  ) {
    return { verdict: "keep", rule: "product-is-unwritten-plan" };
  }
  if (input.references.some((entry) => entry.reference.kind === "decision")) {
    return { verdict: "abstain", rule: "decision-is-declared" };
  }
  if (input.references.some((entry) => entry.state === "drifted")) {
    return { verdict: "abstain", rule: "reference-has-drifted" };
  }
  if (
    input.references.length > 0 &&
    input.references.every((entry) => entry.state === "readable")
  ) {
    return { verdict: "compact", rule: "reference-is-readable" };
  }
  if (input.references.some((entry) => entry.state === "unresolved")) {
    return { verdict: "abstain", rule: "reference-is-unresolved" };
  }
  if (hasDeclaration(input)) {
    // A declaration exists and no row decided it. Never compact on a
    // half-resolved declaration.
    return { verdict: "abstain", rule: "declarations-unresolved" };
  }

  // --- Legacy rows: the frozen pre-revert rules, under honest names. ---
  const writes = input.candidatePaths.some((path) => !input.knownText.includes(path));
  const reads = input.candidatePaths.some((path) => input.producedText.includes(path));
  if (writes) return { verdict: "keep", rule: "names-unknown-path" };
  if (reads && !input.dependent) return { verdict: "compact", rule: "names-batch-output" };
  if (!reads && !input.dependent && !input.planDocument) {
    return { verdict: "compact", rule: "no-visible-link" };
  }
  if (input.dependent && input.planDocument) {
    return { verdict: "abstain", rule: "document-and-dependency" };
  }
  if (input.dependent) return { verdict: "abstain", rule: "dependent-successor" };
  return { verdict: "abstain", rule: "plan-document" };
};

/**
 * The rows that cleared the gate and may decide without a model call. The
 * measured production gate: `names-batch-output` agrees with 96.4% of pass 1
 * and 100.0% of pass 2, and `no-visible-link` with 96.0% of pass 2 and 98.2%
 * of pass 3. `bun run eval:promote` prints the table and rewrites this block;
 * every declared row is observe-only until it clears the same gate on a corpus
 * that carries declarations.
 */
export const ACCEPTED_RULES: ReadonlySet<string> = new Set([
  "names-batch-output",
  "no-visible-link",
]);

/**
 * The product policy: a rule that cleared the gate keeps its verdict; every
 * other row abstains and keeps its name for the report.
 */
export const acceptedRoute = (input: RuleInput): RuleDecision => {
  const decision = route(input);
  return ACCEPTED_RULES.has(decision.rule) ? decision : { verdict: "abstain", rule: decision.rule };
};

/** True when the batch recorded any work at all. */
export const hasFootprint = (footprint: BatchFootprint): boolean =>
  footprint.wrote.length > 0 ||
  footprint.read.length > 0 ||
  footprint.deleted.length > 0 ||
  footprint.commands.length > 0;

/**
 * Resolve each candidate's declarations against the footprint and the disk.
 *
 * Without a footprint there is nothing to resolve against: a session restore
 * leaves the recorder empty, so every declared reference abstains and the
 * classifier decides. Declared products still check disk existence, because a
 * product is a claim about a file, not about the batch.
 */
export const resolveCandidates = (
  candidates: readonly CompactionCandidate[],
  footprint: BatchFootprint,
  probe: FileProbe,
): readonly CandidateFacts[] => {
  const recorded = hasFootprint(footprint);
  return candidates.map((candidate) => {
    const references = candidate.refs ?? [];
    return {
      references: recorded
        ? resolveReferences(references, footprint, probe)
        : references.map((reference) => ({ reference, state: "unresolved" as const })),
      products: resolveProducts(candidate.produces ?? [], probe),
      dependent: candidate.class === "dependent-successor",
    };
  });
};

/** Fold the resolved declarations and the production facts into a rule input. */
export const buildRuleInput = (
  facts: CandidateFacts,
  production: ReturnType<typeof productionFacts>,
): RuleInput => ({
  references: facts.references,
  products: facts.products,
  candidatePaths: production.candidatePaths,
  knownText: production.knownText,
  producedText: production.producedText,
  dependent: facts.dependent,
  planDocument: production.planDocument,
});
