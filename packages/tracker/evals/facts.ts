#!/usr/bin/env bun
/**
 * Freeze the facts the declared reliance rows fire on.
 *
 * The gate scores one candidate per decision: the head. This command replays
 * every candidate of every stored case against the session cwd on disk, marks
 * index 0 as the head and the rest as diagnostics, and writes one frozen fact
 * per case to `facts.jsonl`. A case with a live decision record is replayed
 * first; the replay must equal the record, or the case is a `mismatch` and can
 * never promote.
 *
 * The report counts the head firings per declared row, the sources, and the
 * pre-flight verdict: whether any behavior-changing row can reach the gate's
 * floor of 10 firings per pass. `STOP:` exits non-zero, so the human run never
 * starts against a corpus that cannot promote.
 *
 * Run: `bun run eval:facts [--out <dir>] [--evidence <dir>] [--drift] [--force]`.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { candidatesOf } from "./input.ts";
import {
  readJsonl,
  type StoredCase,
  type StoredEvidence,
  type StoredDecision,
} from "./case-file.ts";
import {
  footprintOf,
  GATE_MIN_LABELED,
} from "./rules.ts";
import { freezeRefusal } from "./harvest.ts";
import { sessionProbe } from "./probe.ts";
import {
  buildRuleInput,
  resolveCandidates,
  route,
  type RuleVerdict,
} from "../src/compaction/rules.ts";
import {
  productionFacts,
  type DeclaredReference,
  type FileProbe,
  type ProductState,
  type ReferenceState,
} from "../src/compaction/observations.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));

/** How a case's facts were obtained. */
export type FactSource = "live" | "replayed" | "mismatch" | "unresolved";

/** One resolved reference with the state it resolved to. */
export interface ReferenceFact {
  readonly reference: DeclaredReference;
  readonly state: ReferenceState;
}

/** One resolved product with the state it resolved to. */
export interface ProductFact {
  readonly path: string;
  readonly state: ProductState;
}

/** The replayed facts for one candidate. */
export interface CandidateFacts {
  readonly questionKey: string;
  readonly candidateRef: string;
  readonly row: string;
  readonly verdict: RuleVerdict;
  readonly references: readonly ReferenceFact[];
  readonly products: readonly ProductFact[];
  readonly diagnostic: boolean;
}

/** The first difference between the replay and the live record. */
export interface CaseMismatch {
  readonly caseId: string;
  readonly candidateRef: string;
  readonly kind: "reference" | "product" | "row" | "verdict";
  readonly expected: string;
  readonly actual: string;
}

/** One case's frozen facts. */
export interface CaseFacts {
  readonly caseId: string;
  readonly at: string;
  readonly sessionCwd: string;
  readonly source: FactSource;
  readonly promotable: boolean;
  /** True when the head candidate carries at least one declaration. */
  readonly declaredHead: boolean;
  readonly head: CandidateFacts;
  readonly diagnostics: readonly CandidateFacts[];
  readonly mismatch?: CaseMismatch;
}

/** A declared head is the head candidate that carries a reference or a product. */
export const isDeclaredHead = (candidate: object): boolean => {
  const record = candidate as {
    readonly refs?: readonly unknown[];
    readonly produces?: readonly unknown[];
  };
  return (record.refs?.length ?? 0) + (record.produces?.length ?? 0) > 0;
};

/** The empty head a case with no candidates carries. It is never promotable. */
const NO_HEAD: CandidateFacts = {
  questionKey: "",
  candidateRef: "",
  row: "",
  verdict: "abstain",
  references: [],
  products: [],
  diagnostic: false,
};

const referenceKey = (reference: DeclaredReference): string =>
  reference.kind === "decision" ? `decision:${reference.topic}` : `path:${reference.path}`;

/** One reference state as the live record names it. */
const recordReferenceState = (
  record: StoredDecision,
  reference: DeclaredReference,
): string | undefined => {
  const wanted = referenceKey(reference);
  for (const entry of record.references) {
    const key =
      entry.kind === "decision" ? `decision:${entry.topic ?? ""}` : `path:${entry.path ?? ""}`;
    if (key === wanted) return entry.state;
  }
  return undefined;
};

const recordProductState = (record: StoredDecision, path: string): string | undefined =>
  record.products.find((entry) => entry.path === path)?.state;

/**
 * The first difference between the replay and the live record. States are
 * compared before the row, because a row difference is a consequence of a
 * state difference and the state names what actually drifted.
 */
const mismatchOf = (head: CandidateFacts, record: StoredDecision): CaseMismatch | null => {
  for (const reference of head.references) {
    const expected = recordReferenceState(record, reference.reference);
    if (expected !== undefined && expected !== reference.state) {
      return {
        caseId: "",
        candidateRef: record.candidateRef,
        kind: "reference",
        expected,
        actual: reference.state,
      };
    }
  }
  for (const product of head.products) {
    const expected = recordProductState(record, product.path);
    if (expected !== undefined && expected !== product.state) {
      return {
        caseId: "",
        candidateRef: record.candidateRef,
        kind: "product",
        expected,
        actual: product.state,
      };
    }
  }
  if (record.rule !== head.row) {
    return {
      caseId: "",
      candidateRef: record.candidateRef,
      kind: "row",
      expected: record.rule,
      actual: head.row,
    };
  }
  if (record.verdict !== head.verdict) {
    return {
      caseId: "",
      candidateRef: record.candidateRef,
      kind: "verdict",
      expected: record.verdict,
      actual: head.verdict,
    };
  }
  return null;
};

const batchTextsOf = (stored: StoredCase): readonly string[] =>
  stored.completed.flatMap((item) =>
    item.description === undefined || item.description.length === 0
      ? [item.text]
      : [item.text, item.description],
  );

/** The unresolved case: no cwd, so no declared path can be resolved. */
const unresolvedFacts = (stored: StoredCase): CaseFacts => {
  const candidates = stored.candidates;
  const head: CandidateFacts =
    candidates.length === 0
      ? NO_HEAD
      : {
          questionKey: stored.questions[0]?.key ?? "",
          candidateRef: candidates[0]?.ref ?? "",
          row: "",
          verdict: "abstain",
          references: [],
          products: [],
          diagnostic: false,
        };
  return {
    caseId: stored.caseId,
    at: stored.at,
    sessionCwd: stored.sessionCwd ?? "",
    source: "unresolved",
    promotable: false,
    declaredHead: candidates.length > 0 && isDeclaredHead(candidates[0]!),
    head,
    diagnostics: candidates.slice(1).map((candidate, index) => ({
      questionKey: stored.questions[index + 1]?.key ?? "",
      candidateRef: candidate.ref,
      row: "",
      verdict: "abstain",
      references: [],
      products: [],
      diagnostic: true,
    })),
  };
};

/**
 * Replay every candidate and label index 0 the head. The live record, when it
 * exists, is the parity oracle: a replay that disagrees is a `mismatch`, and
 * the case can never promote.
 */
export const caseFacts = (
  stored: StoredCase,
  evidence: StoredEvidence | undefined,
  probe: FileProbe,
): CaseFacts => {
  if (stored.candidates.length === 0) return unresolvedFacts(stored);
  // A probe that reports an unavailable cwd cannot resolve anything. The
  // optional field keeps a plain test probe valid.
  if ((probe as FileProbe & { readonly available?: boolean }).available === false) {
    return unresolvedFacts(stored);
  }
  if (stored.sessionCwd === undefined) return unresolvedFacts(stored);

  const candidates = candidatesOf(stored);
  const footprint = footprintOf(evidence?.entries ?? []);
  const resolved = resolveCandidates(candidates, footprint, probe);
  const batchTexts = batchTextsOf(stored);
  const facts = candidates.map((candidate, index): CandidateFacts => {
    const production = productionFacts(batchTexts, footprint, candidate.text);
    const decision = route(buildRuleInput(resolved[index]!, production));
    return {
      questionKey: stored.questions[index]?.key ?? "",
      candidateRef: stored.candidates[index]?.ref ?? `${candidate.listName}:${candidate.id}`,
      row: decision.rule,
      verdict: decision.verdict,
      references: resolved[index]!.references.map((entry) => ({
        reference: entry.reference,
        state: entry.state,
      })),
      products: resolved[index]!.products.map((entry) => ({
        path: entry.product.path,
        state: entry.state,
      })),
      diagnostic: index > 0,
    };
  });

  const head = facts[0]!;
  const declaredHead = isDeclaredHead(candidates[0]!);
  const record = stored.decision;
  if (record === undefined) {
    return {
      caseId: stored.caseId,
      at: stored.at,
      sessionCwd: stored.sessionCwd,
      source: "replayed",
      promotable: true,
      declaredHead,
      head,
      diagnostics: facts.slice(1),
    };
  }
  const mismatch = mismatchOf(head, record);
  if (mismatch === null) {
    return {
      caseId: stored.caseId,
      at: stored.at,
      sessionCwd: stored.sessionCwd,
      source: "live",
      promotable: true,
      declaredHead,
      head,
      diagnostics: facts.slice(1),
    };
  }
  return {
    caseId: stored.caseId,
    at: stored.at,
    sessionCwd: stored.sessionCwd,
    source: "mismatch",
    promotable: false,
    declaredHead,
    head,
    diagnostics: facts.slice(1),
    mismatch: { ...mismatch, caseId: stored.caseId },
  };
};

/** The rows that always appear in the pre-flight block, in display order. */
const REPORT_ROWS = [
  "reference-is-readable",
  "product-is-unwritten-plan",
  "declarations-unresolved",
] as const;

/** One row of the pre-flight verdict. */
export interface PreflightRow {
  readonly row: string;
  readonly verdict: RuleVerdict;
  readonly heads: number;
  /** Half the available heads, the two-pass estimate. */
  readonly perPass: number;
  readonly status: "measure" | "thin" | "reported";
}

/** The pre-flight verdict: can any behavior-changing row reach the floor? */
export interface Preflight {
  readonly rows: readonly PreflightRow[];
  readonly stop: boolean;
  readonly reason: string;
  readonly measured: readonly string[];
}

const verdictOfRow = (cases: readonly CaseFacts[], row: string): RuleVerdict => {
  for (const entry of cases) {
    const candidate = [entry.head, ...entry.diagnostics].find((item) => item.row === row);
    if (candidate !== undefined) return candidate.verdict;
  }
  return row === "declarations-unresolved" ? "abstain" : "compact";
};

/**
 * Count the promotable head firings per row and decide whether any
 * behavior-changing row can reach the unchanged floor of 10 per pass. An
 * abstain row is reported and can never promote, so it never keeps the run
 * alive.
 */
export const preflight = (cases: readonly CaseFacts[]): Preflight => {
  const counts = new Map<string, number>();
  for (const entry of cases) {
    if (!entry.promotable || !entry.declaredHead) continue;
    counts.set(entry.head.row, (counts.get(entry.head.row) ?? 0) + 1);
  }
  const rows = new Map<string, PreflightRow>();
  const add = (row: string): void => {
    const heads = counts.get(row) ?? 0;
    const verdict = verdictOfRow(cases, row);
    const perPass = Math.floor(heads / 2);
    rows.set(row, {
      row,
      verdict,
      heads,
      perPass,
      status:
        verdict === "abstain" ? "reported" : perPass >= GATE_MIN_LABELED ? "measure" : "thin",
    });
  };
  for (const row of REPORT_ROWS) add(row);
  for (const row of [...counts.keys()].sort()) if (!rows.has(row)) add(row);
  const ordered = [...rows.values()];
  const measured = ordered
    .filter((row) => row.status === "measure")
    .map((row) => row.row);
  const stop = measured.length === 0;
  return {
    rows: ordered,
    stop,
    reason: stop
      ? `STOP: no behavior-changing declared row can reach ${GATE_MIN_LABELED} firings per pass`
      : `measured: ${measured.length} behavior-changing row(s) can reach ${GATE_MIN_LABELED} firings per pass`,
    measured,
  };
};

/** The pre-flight block, as the command prints it. */
export const formatPreflight = (pre: Preflight): string => {
  const cells = pre.rows.map((row) => {
    const label = row.status === "reported" ? "reported, not promotable" : row.status;
    const volume =
      row.status === "reported"
        ? `${row.heads} heads`
        : `${row.heads} promotable heads | ${row.perPass} per pass`;
    return [`  ${row.row}`.padEnd(35), `${label} | ${volume}`].join(" ");
  });
  return ["preflight:", ...cells, pre.reason].join("\n");
};

/** The row totals over the gating population, for the report and the digest. */
export const rowTotals = (cases: readonly CaseFacts[]): Readonly<Record<string, number>> => {
  const totals: Record<string, number> = {};
  for (const entry of cases) {
    if (!entry.promotable || !entry.declaredHead) continue;
    totals[entry.head.row] = (totals[entry.head.row] ?? 0) + 1;
  }
  return totals;
};

/** Per-source case counts. */
export const sourceTotals = (cases: readonly CaseFacts[]): Readonly<Record<FactSource, number>> => {
  const totals: Record<FactSource, number> = { live: 0, replayed: 0, mismatch: 0, unresolved: 0 };
  for (const entry of cases) totals[entry.source] += 1;
  return totals;
};

/** The evidence digest: counts only, no case id and no path. */
export const factsDigest = (cases: readonly CaseFacts[], pre: Preflight): unknown => ({
  cases: cases.length,
  promotable: cases.filter((entry) => entry.promotable).length,
  declaredHeads: cases.filter((entry) => entry.declaredHead).length,
  controls: cases.filter((entry) => entry.promotable && !entry.declaredHead).length,
  rows: rowTotals(cases),
  sources: sourceTotals(cases),
  preflight: {
    stop: pre.stop,
    measured: pre.measured,
    rows: pre.rows,
  },
});

/** One changed case between frozen and recomputed facts. */
export interface DriftReport {
  readonly cases: number;
  readonly ids: readonly string[];
}

const statesKey = (entry: CaseFacts): string =>
  JSON.stringify({
    row: entry.head.row,
    verdict: entry.head.verdict,
    references: entry.head.references.map((reference) => [
      referenceKey(reference.reference),
      reference.state,
    ]),
    products: entry.head.products.map((product) => [product.path, product.state]),
    source: entry.source,
  });

/** Compare frozen facts with a fresh replay. Reports change; writes nothing. */
export const driftOf = (
  frozen: readonly CaseFacts[],
  recomputed: readonly CaseFacts[],
): DriftReport => {
  const byId = new Map(recomputed.map((entry) => [entry.caseId, entry]));
  const ids: string[] = [];
  for (const entry of frozen) {
    const current = byId.get(entry.caseId);
    if (current === undefined || statesKey(current) !== statesKey(entry)) ids.push(entry.caseId);
  }
  return { cases: ids.length, ids };
};

interface Options {
  readonly out: string;
  readonly evidence?: string;
  readonly drift: boolean;
  readonly force: boolean;
}

const usage = `facts.ts [--out <dir>] [--evidence <dir>] [--drift] [--force]

  --out       corpus directory (default: evals/data/v2)
  --evidence  also write facts.digest.json to <dir>
  --drift     recompute the facts and report change; writes nothing
  --force     write into a directory that holds freeze.json`;

const parseOptions = (argv: readonly string[]): Options => {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]!;
    if (!flag.startsWith("--")) continue;
    const name = flag.slice(2);
    if (name === "drift" || name === "force") {
      flags.add(name);
      continue;
    }
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      throw new Error(`missing value for ${flag}\n\n${usage}`);
    }
    values.set(name, next);
    index += 1;
  }
  return {
    out: values.get("out") ?? join(HERE, "data", "v2"),
    ...(values.get("evidence") === undefined ? {} : { evidence: values.get("evidence") }),
    drift: flags.has("drift"),
    force: flags.has("force"),
  };
};

/** Build facts for every stored case, in corpus order. */
export const factsOfCorpus = (
  cases: readonly StoredCase[],
  evidence: ReadonlyMap<string, StoredEvidence>,
): readonly CaseFacts[] =>
  cases.map((stored) =>
    caseFacts(stored, evidence.get(stored.caseId), sessionProbe(stored.sessionCwd)),
  );

const readEvidence = (out: string): ReadonlyMap<string, StoredEvidence> =>
  new Map(
    readJsonl<StoredEvidence>(join(out, "evidence.jsonl")).map((entry) => [entry.caseId, entry]),
  );

/** The report the command prints: rows, sources, then the pre-flight. */
export const formatFactsReport = (cases: readonly CaseFacts[]): string => {
  const rows = rowTotals(cases);
  const sources = sourceTotals(cases);
  const rowLine =
    Object.keys(rows).length === 0
      ? "rows: (none)"
      : `rows: ${Object.entries(rows)
          .map(([row, count]) => `${row} ${count}`)
          .join(", ")}`;
  return [
    rowLine,
    `sources: live ${sources.live}, replayed ${sources.replayed}, mismatch ${sources.mismatch}, unresolved ${sources.unresolved}`,
    formatPreflight(preflight(cases)),
  ].join("\n");
};

const main = (): number => {
  const options = parseOptions(process.argv.slice(2));
  const cases = readJsonl<StoredCase>(join(options.out, "cases.jsonl"));
  const evidence = readEvidence(options.out);
  const facts = factsOfCorpus(cases, evidence);
  const pre = preflight(facts);
  const report = formatFactsReport(facts);

  if (options.drift) {
    let frozen: readonly CaseFacts[] = [];
    try {
      frozen = readJsonl<CaseFacts>(join(options.out, "facts.jsonl"));
    } catch {
      frozen = [];
    }
    const drift = driftOf(frozen, facts);
    process.stdout.write(`${report}\n\ndrift: ${drift.cases} cases\n`);
    for (const id of drift.ids.slice(0, 10)) process.stdout.write(`  ${id}\n`);
    return 0;
  }

  const refusal = options.force ? null : freezeRefusal(options.out);
  if (refusal !== null) {
    process.stderr.write(`${refusal}\n`);
    return 2;
  }

  writeFileSync(
    join(options.out, "facts.jsonl"),
    facts.map((entry) => JSON.stringify(entry)).join("\n").concat("\n"),
  );
  if (options.evidence !== undefined) {
    mkdirSync(options.evidence, { recursive: true });
    writeFileSync(
      join(options.evidence, "facts.digest.json"),
      `${JSON.stringify(factsDigest(facts, pre), null, 2)}\n`,
    );
  }
  process.stdout.write(`${report}\n`);
  return pre.stop ? 1 : 0;
};

if (import.meta.main) process.exitCode = main();
