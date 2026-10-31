/**
 * The labeling-pass split.
 *
 * The human labels were recorded in three sittings, each with its own idea of
 * the frontier. `passOf` reproduces those sittings from the label `at` field,
 * so the reports can score each pass as its own label set. The cutoffs live
 * here, next to the recorded sizes, because two reports need the same split.
 */

export const LABEL_PASSES = ["pass1", "pass2", "pass3"] as const;
/**
 * A pass name. The old corpus uses the three timestamp passes; the declared
 * corpus names its own (`v2-a`, `v2-b`), so the type is open.
 */
export type LabelPass = string;

/** The recorded label-sitting boundaries. Pass 3 starts at the second one. */
const PASS_CUTOFFS = ["2026-10-06", "2026-10-06T17"] as const;

export const passOf = (at: string): LabelPass =>
  at < PASS_CUTOFFS[0] ? "pass1" : at < PASS_CUTOFFS[1] ? "pass2" : "pass3";

/** One record with the fields that decide its pass. */
export interface PassRecord {
  readonly at: string;
  /** The explicit pass a declared-corpus record carries. */
  readonly pass?: string;
}

/** An explicit pass wins; an old record falls back to the timestamp split. */
export const passOfRecord = (record: PassRecord): LabelPass =>
  record.pass ?? passOf(record.at);

export const partitionByPass = <T extends { readonly at: string }>(
  rows: readonly T[],
): ReadonlyMap<LabelPass, readonly T[]> => {
  const parts = new Map<LabelPass, T[]>(LABEL_PASSES.map((pass) => [pass, []]));
  for (const row of rows) parts.get(passOf(row.at))!.push(row);
  return parts;
};
