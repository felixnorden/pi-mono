import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readJsonl, type StoredCase, type StoredEvidence } from "./case-file.ts";
import { harvestSession } from "./harvest.ts";

/**
 * The checked-in synthetic corpus.
 *
 * The real corpus carries no declarations, so the declared rows have no live
 * firings to measure. This fixture is a session-shaped log with one
 * `tracker/reliance-decision` entry, and it flows through the same harvester and
 * the same `decision-record.ts` codec the product uses, so it cannot drift from
 * the real shape. Every derived case is marked `synthetic: true` and is never
 * counted as a real session.
 */

const HERE = fileURLToPath(new URL(".", import.meta.url));

/** The checked-in fixture directory. */
export const SYNTHETIC_DIR = join(HERE, "data", "synthetic");

/** The label file's shape, before it becomes a keyed map. */
interface StoredLabelRow {
  readonly caseId: string;
  readonly key: string;
  readonly label: string;
  readonly at: string;
}

export interface SyntheticCorpus {
  readonly cases: readonly StoredCase[];
  readonly evidence: ReadonlyMap<string, StoredEvidence>;
  readonly labels: ReadonlyMap<string, { readonly label: string; readonly at: string }>;
}

/** Harvest the checked-in synthetic session. A missing fixture is empty. */
export const syntheticCorpus = (): SyntheticCorpus => {
  let text: string;
  try {
    text = readFileSync(join(SYNTHETIC_DIR, "session.jsonl"), "utf8");
  } catch {
    return { cases: [], evidence: new Map(), labels: new Map() };
  }
  const harvested = harvestSession(
    text,
    "synthetic",
    "session.jsonl",
    { limit: 64, redact: (value) => value },
    () => undefined,
  );
  const cases = (harvested?.cases ?? []).map((entry): StoredCase => ({
    ...entry,
    synthetic: true,
  }));
  const evidence = new Map(
    (harvested?.evidence ?? []).map((record) => [record.caseId, record] as const),
  );
  const labels = new Map<string, { readonly label: string; readonly at: string }>();
  for (const row of readJsonl<StoredLabelRow>(join(SYNTHETIC_DIR, "labels.jsonl"))) {
    labels.set(`${row.caseId}\u0000${row.key}`, { label: row.label, at: row.at });
  }
  return { cases, evidence, labels };
};
