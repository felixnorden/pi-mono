import { Effect, Schema } from "effect";
import { REFERENCE_CAP, PRODUCT_CAP } from "./digest.ts";
import type { ResolvedProduct, ResolvedReference } from "./observations.ts";
import type { RuleVerdict } from "./rules.ts";

/**
 * The live decision record.
 *
 * One compact custom session entry per settle decision, appended only when the
 * candidate declared a reference or a product. It carries the raw rule row,
 * the raw verdict, the candidate reference, and the resolved states, all
 * bounded by the digest's caps. Nothing else from the decision enters: no
 * transcript text, no batch prose, no item body beyond the reference.
 *
 * The eval harvest reads this entry back into its case, so a declared row's
 * real coverage can be measured without a second classifier call.
 */

/** The custom-entry type the bridge appends for one settle decision. */
export const DECISION_CUSTOM_TYPE = "tracker/reliance-decision";

/** Every declared reference state the record may carry. */
const referenceState = Schema.Literals(["readable", "lost", "drifted", "unresolved"]);

/** Every declared product state the record may carry. */
const productState = Schema.Literals(["exists", "missing"]);

/** One resolved reference, flattened to the fields its kind owns. */
const recordReference = Schema.Struct({
  kind: Schema.Literals(["path", "decision"]),
  path: Schema.optional(Schema.String),
  symbol: Schema.optional(Schema.String),
  span: Schema.optional(Schema.String),
  topic: Schema.optional(Schema.String),
  state: referenceState,
});

/** One resolved product. */
const recordProduct = Schema.Struct({
  path: Schema.String,
  state: productState,
});

/** The stored shape of one decision record. */
export const decisionRecordSchema = Schema.Struct({
  rule: Schema.String,
  verdict: Schema.Literals(["keep", "compact", "abstain"]),
  candidateRef: Schema.String,
  references: Schema.Array(recordReference),
  products: Schema.Array(recordProduct),
});

export type DecisionRecord = Schema.Schema.Type<typeof decisionRecordSchema>;

const referenceOf = (entry: ResolvedReference): DecisionRecord["references"][number] =>
  entry.reference.kind === "decision"
    ? { kind: "decision", topic: entry.reference.topic, state: entry.state }
    : {
        kind: "path",
        path: entry.reference.path,
        ...(entry.reference.symbol === undefined ? {} : { symbol: entry.reference.symbol }),
        ...(entry.reference.span === undefined ? {} : { span: entry.reference.span }),
        state: entry.state,
      };

/**
 * Build the record for one decision, or undefined when the candidate declared
 * nothing. The caps match the digest, so the entry stays compact.
 */
export const buildDecisionRecord = (input: {
  readonly rule: string;
  readonly verdict: RuleVerdict;
  readonly candidateRef: string;
  readonly references: readonly ResolvedReference[];
  readonly products: readonly ResolvedProduct[];
}): DecisionRecord | undefined => {
  if (input.references.length === 0 && input.products.length === 0) return undefined;
  return {
    rule: input.rule,
    verdict: input.verdict,
    candidateRef: input.candidateRef,
    references: input.references.slice(0, REFERENCE_CAP).map(referenceOf),
    products: input.products.slice(0, PRODUCT_CAP).map((entry) => ({
      path: entry.product.path,
      state: entry.state,
    })),
  };
};

/** Encode a record into its plain JSON shape, throwing on a malformed value. */
export const encodeDecisionRecord = (record: DecisionRecord): unknown =>
  Schema.encodeSync(decisionRecordSchema)(record);

/**
 * Decode an untrusted session entry into a record. Unknown extra keys are
 * ignored, so a newer writer does not break an older reader.
 */
export const decodeDecisionRecord = (
  snapshot: unknown,
): Effect.Effect<DecisionRecord, Schema.SchemaError> =>
  Schema.decodeUnknownEffect(decisionRecordSchema, { onExcessProperty: "ignore" })(snapshot);
