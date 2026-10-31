#!/usr/bin/env bun
/**
 * Freeze the labeled corpus and generate its report.
 *
 * `freeze.json` names the three artifacts the gate trusts: the harvest
 * manifest, the sample, and the frozen facts. Once it exists, harvest and
 * facts refuse the directory, so the case ids under the labels cannot move.
 *
 * `--report` rebuilds `report.md` from the run's own artifacts. It accepts no
 * typed count: every number comes from a file this run wrote.
 *
 * Run: `bun run eval:freeze --out <dir> --evidence <dir> [--report] [--force]`.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readJsonl } from "./case-file.ts";
import type { StoredSurprise } from "./labeling.ts";
import type { LabelRecord } from "./labeling.ts";
import { passOfRecord } from "./pass.ts";
import type { LabelSample } from "./sample.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));

/** The freeze record: three artifact hashes, the version, and the date. */
export interface FreezeRecord {
  readonly corpus: "v2";
  readonly frozenAt: string;
  readonly trackerVersion: string;
  readonly manifestHash: string;
  readonly sampleHash: string;
  readonly factsHash: string;
}

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

const readText = (path: string): string => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    throw new Error(`cannot freeze: missing ${path}`);
  }
};

/** Freeze the corpus, or rewrite an existing freeze only with `force`. */
export const freezeCorpus = (out: string, force: boolean): FreezeRecord => {
  const manifestText = readText(join(out, "manifest.json"));
  const sampleText = readText(join(out, "sample.json"));
  const factsText = readText(join(out, "facts.jsonl"));
  const freezePath = join(out, "freeze.json");
  if (existsSync(freezePath) && !force) {
    let frozenAt = "unknown";
    try {
      const existing = JSON.parse(readFileSync(freezePath, "utf8")) as { frozenAt?: unknown };
      frozenAt = String(existing.frozenAt ?? "unknown");
    } catch {
      // A malformed freeze still freezes the directory.
    }
    throw new Error(`${out} is already frozen since ${frozenAt}; pass --force to rewrite it`);
  }
  let trackerVersion = "unknown";
  try {
    const manifest = JSON.parse(manifestText) as { trackerVersion?: unknown };
    trackerVersion = String(manifest.trackerVersion ?? "unknown");
  } catch {
    // A malformed manifest still freezes; the report will show it.
  }
  const record: FreezeRecord = {
    corpus: "v2",
    frozenAt: new Date().toISOString(),
    trackerVersion,
    manifestHash: sha256(manifestText),
    sampleHash: sha256(sampleText),
    factsHash: sha256(factsText),
  };
  writeFileSync(freezePath, `${JSON.stringify(record, null, 2)}\n`);
  return record;
};

interface GateArtifact {
  readonly passes?: { readonly list?: readonly string[]; readonly source?: string };
  readonly base?: string;
  readonly sources?: Readonly<Record<string, number>>;
  readonly rows?: readonly {
    readonly rule: string;
    readonly verdict: string;
    readonly accepted?: boolean;
    readonly passes?: readonly {
      readonly pass: string;
      readonly labeled: number;
      readonly agreement: number;
      readonly base: number;
      readonly lift: number;
      readonly qualifies: boolean;
    }[];
  }[];
  readonly accepted?: readonly string[];
  readonly promotion?: readonly string[];
}

const readObject = <T>(path: string): T | undefined => {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return undefined;
  }
};

/** One per-row audit tally. */
const auditTallies = (
  rows: readonly { readonly row: string; readonly verdict: string }[],
): readonly { readonly row: string; readonly match: number; readonly mismatch: number }[] => {
  const byRow = new Map<string, { match: number; mismatch: number }>();
  for (const row of rows) {
    const cell = byRow.get(row.row) ?? { match: 0, mismatch: 0 };
    if (row.verdict === "match") cell.match += 1;
    else cell.mismatch += 1;
    byRow.set(row.row, cell);
  }
  return [...byRow.entries()]
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(([row, cell]) => ({ row, ...cell }));
};

/**
 * How often a blind pilot repeat agreed with the same case's ordinary label.
 * No pair means the sitting carried no repeat; the report says so.
 */
export const selfAgreement = (
  labels: readonly LabelRecord[],
): { readonly pairs: number; readonly agreed: number } => {
  const answered = new Map<string, string>();
  for (const record of labels) {
    if (record.pilot === true) continue;
    answered.set(`${record.caseId}\u0000${record.key}`, record.label);
  }
  let pairs = 0;
  let agreed = 0;
  for (const record of labels) {
    if (record.pilot !== true) continue;
    const ordinary = answered.get(`${record.caseId}\u0000${record.key}`);
    if (ordinary === undefined) continue;
    pairs += 1;
    if (ordinary === record.label) agreed += 1;
  }
  return { pairs, agreed };
};

const percent = (value: number): string => `${(value * 100).toFixed(1)}%`;

/** Build the markdown report from the artifacts in `dir`, gate and audit in `evidence`. */
export const buildReport = (dir: string, evidence: string = dir): string => {
  const manifest = readObject<{
    generatedAt?: string;
    trackerVersion?: string;
    format?: string;
    formatRule?: string;
    formatCounts?: { snapshotRule?: number; completedItemRule?: number };
    excluded?: { legacy?: number; declared?: number };
    events?: { total?: number };
    source?: { from?: string | null; to?: string | null };
  }>(join(dir, "manifest.json"));
  const sample = readObject<LabelSample>(join(dir, "sample.json"));
  const gate = readObject<GateArtifact>(join(evidence, "gate.json")) ?? readObject<GateArtifact>(join(dir, "gate.json"));
  const audit = readJsonl<{ readonly caseId: string; readonly row: string; readonly verdict: string }>(
    join(evidence, "audit.jsonl"),
  );
  const auditFallback = audit.length === 0
    ? readJsonl<{ readonly caseId: string; readonly row: string; readonly verdict: string }>(
        join(dir, "audit.jsonl"),
      )
    : audit;
  const labels = readJsonl<LabelRecord>(join(dir, "labels.jsonl"));
  const surprises = readJsonl<StoredSurprise>(join(dir, "surprises.jsonl"));
  const score = readObject<{ readonly model?: string; readonly rows?: readonly { readonly name: string; readonly cases: number; readonly falseCompact: number; readonly caseAccuracy: number }[] }>(
    join(evidence, "score.json"),
  );

  const lines: string[] = ["# Smart Compaction Eval v2 — report", ""];
  lines.push("## Corpus", "");
  lines.push(`- generated: ${manifest?.generatedAt ?? "(missing)"}`);
  lines.push(`- tracker: ${manifest?.trackerVersion ?? "(missing)"}`);
  lines.push(`- format: ${manifest?.format ?? "(missing)"}`);
  lines.push(`- rule: ${manifest?.formatRule ?? "(missing)"}`);
  lines.push(`- cases: ${manifest?.events?.total ?? "(missing)"}`);
  lines.push(
    `- shape counts: snapshot rule ${manifest?.formatCounts?.snapshotRule ?? "(missing)"}, completed-item rule ${manifest?.formatCounts?.completedItemRule ?? "(missing)"}`,
  );
  lines.push(
    `- excluded: legacy ${manifest?.excluded?.legacy ?? "(missing)"}, declared ${manifest?.excluded?.declared ?? "(missing)"}`,
  );
  lines.push(
    `- source: ${manifest?.source?.from ?? "(missing)"} to ${manifest?.source?.to ?? "(missing)"}`,
    "",
  );

  lines.push("## Sample", "");
  if (sample === undefined) {
    lines.push("- (missing)");
  } else {
    lines.push(`- seed: ${sample.seed}`);
    for (const [pass, body] of Object.entries(sample.passes)) {
      const cards = body.sittings.flatMap((sitting) => sitting.cards);
      lines.push(`- ${pass}: ${cards.length} cards, ${body.sittings.length} sitting(s)`);
    }
    lines.push(`- pilot: ${sample.pilot.length}`);
    lines.push(`- unmeasurable: ${sample.unmeasurable.join(", ") || "(none)"}`);
    lines.push(`- below quota: ${sample.belowQuota.join(", ") || "(none)"}`);
  }
  lines.push("");

  lines.push("## Labels", "");
  const ordinary = labels.filter((record) => record.pilot !== true);
  lines.push(`- total: ${ordinary.length}`);
  const byPass = new Map<string, number>();
  for (const record of ordinary) {
    const pass = passOfRecord(record);
    byPass.set(pass, (byPass.get(pass) ?? 0) + 1);
  }
  for (const [pass, count] of [...byPass.entries()].sort()) {
    lines.push(`- ${pass}: ${count}`);
  }
  const agreement = selfAgreement(labels);
  lines.push(
    `- self-agreement: ${
      agreement.pairs === 0
        ? "no pilot repeat"
        : `${agreement.agreed}/${agreement.pairs} (${percent(agreement.agreed / agreement.pairs)})`
    }`,
  );
  lines.push("");

  lines.push("## Gate", "");
  if (gate === undefined) {
    lines.push("- (missing)");
  } else {
    lines.push(`- passes: ${gate.passes?.list?.join(", ") ?? "(missing)"} (${gate.passes?.source ?? "unknown"})`);
    lines.push(`- base: ${gate.base ?? "(missing)"}`);
    lines.push(
      `- sources: ${Object.entries(gate.sources ?? {})
        .map(([source, count]) => `${source} ${count}`)
        .join(", ")}`,
    );
    for (const row of gate.rows ?? []) {
      for (const pass of row.passes ?? []) {
        lines.push(
          `- ${row.rule} | ${row.verdict} | ${pass.pass} | labeled ${pass.labeled} | agreement ${percent(pass.agreement)} | base ${percent(pass.base)} | lift ${percent(pass.lift)} | ${pass.qualifies ? "PASS" : "fail"}`,
        );
      }
    }
    const accepted = gate.accepted ?? [];
    if (accepted.length === 0) {
      lines.push("- accepted: none — no behavior-changing row cleared both passes");
    } else {
      for (const rule of accepted) {
        const verdict = (gate.rows ?? []).find((row) => row.rule === rule)?.verdict ?? "unknown";
        lines.push(`- accepted: ${rule} (${verdict})`);
      }
    }
    lines.push(`- promotion: ${(gate.promotion ?? []).join(", ") || "(none)"}`);
  }
  lines.push("");

  lines.push("## Audit", "");
  if (auditFallback.length === 0) {
    lines.push("- (missing)");
  } else {
    for (const tally of auditTallies(auditFallback)) {
      lines.push(`- ${tally.row}: ${tally.match + tally.mismatch} sampled, ${tally.match} match, ${tally.mismatch} mismatch`);
    }
  }
  lines.push("");

  lines.push("## Surprises", "");
  lines.push(`- surprises: ${surprises.length}`);
  lines.push("");

  lines.push("## Classifier", "");
  if (score === undefined) {
    lines.push("- (missing; run eval:score --evidence)");
  } else {
    lines.push(`- model: ${score.model ?? "(missing)"}`);
    for (const row of score.rows ?? []) {
      lines.push(
        `- ${row.name}: ${row.cases} cases, ${row.falseCompact} false compact, accuracy ${percent(row.caseAccuracy)}`,
      );
    }
  }
  lines.push("");
  return lines.join("\n");
};

interface Options {
  readonly out: string;
  readonly evidence?: string;
  readonly report: boolean;
  readonly force: boolean;
}

const usage = `freeze.ts [--out <dir>] [--evidence <dir>] [--report] [--force]

  --out       corpus directory (default: evals/data/v2)
  --evidence  where freeze.json and report.md land (default: --out)
  --report    write report.md from the run's artifacts
  --force     rewrite an existing freeze`;

const parseOptions = (argv: readonly string[]): Options => {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]!;
    if (!flag.startsWith("--")) continue;
    const name = flag.slice(2);
    if (name === "report" || name === "force") {
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
    report: flags.has("report"),
    force: flags.has("force"),
  };
};

const main = (): void => {
  const options = parseOptions(process.argv.slice(2));
  const evidence = options.evidence ?? options.out;
  if (options.report) {
    const report = buildReport(options.out, evidence);
    mkdirSync(evidence, { recursive: true });
    writeFileSync(join(evidence, "report.md"), report);
    process.stdout.write(`wrote ${join(evidence, "report.md")}\n`);
    return;
  }
  const frozen = freezeCorpus(options.out, options.force);
  if (options.evidence !== undefined) {
    mkdirSync(evidence, { recursive: true });
    writeFileSync(join(evidence, "freeze.json"), `${JSON.stringify(frozen, null, 2)}\n`);
  }
  process.stdout.write(`${JSON.stringify(frozen, null, 2)}\n`);
};

if (import.meta.main) main();
