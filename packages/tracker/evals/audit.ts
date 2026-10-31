#!/usr/bin/env bun
/**
 * Audit a sample of the replayed facts against the disk as it is now.
 *
 * `facts.jsonl` is frozen; the gate reads it. This command draws up to ten
 * replayed cases per declared row, replays them again against today's disk, and
 * writes the frozen state next to the current one to `audit.jsonl`. A mismatch
 * excludes the case from the gate; two mismatches for one row block the row.
 *
 * Run: `bun run eval:audit [--out <dir>] [--per-row <n>] [--seed <n>] [--evidence <dir>]`.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readJsonl, type StoredCase, type StoredEvidence } from "./case-file.ts";
import { hideSessionIdsDeep } from "./evidence-redact.ts";
import { caseFacts, type CaseFacts } from "./facts.ts";
import { sessionProbe } from "./probe.ts";
import { seededShuffle } from "./sample.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));

/** The frozen and current state of one audited case. */
export interface AuditRow {
  readonly caseId: string;
  readonly row: string;
  readonly verdict: "match" | "mismatch";
  readonly expected: string;
  readonly actual: string;
}

/** Select up to `perRow` replays per declared row. Deterministic for a seed. */
export const drawAudit = (
  facts: readonly CaseFacts[],
  perRow: number,
  seed: number,
): readonly CaseFacts[] => {
  const byRow = new Map<string, CaseFacts[]>();
  for (const entry of facts) {
    if (!entry.promotable || !entry.declaredHead) continue;
    if (entry.source !== "replayed" && entry.source !== "live") continue;
    byRow.set(entry.head.row, [...(byRow.get(entry.head.row) ?? []), entry]);
  }
  return [...byRow.entries()]
    .sort((left, right) => left[0].localeCompare(right[0]))
    .flatMap(([, cases]) => seededShuffle(cases, seed).slice(0, perRow));
};

const referenceKeyOf = (reference: {
  readonly kind: string;
  readonly path?: string;
  readonly topic?: string;
}): string =>
  reference.kind === "decision"
    ? `decision:${reference.topic ?? ""}`
    : `path:${reference.path ?? ""}`;

/** Compare one frozen case with its fresh replay. States are named on a mismatch. */
export const auditRow = (frozen: CaseFacts, current: CaseFacts): AuditRow => {
  for (const reference of frozen.head.references) {
    const key = referenceKeyOf(reference.reference);
    const now = current.head.references.find((entry) => referenceKeyOf(entry.reference) === key);
    if (now === undefined || now.state !== reference.state) {
      return {
        caseId: frozen.caseId,
        row: frozen.head.row,
        verdict: "mismatch",
        expected: reference.state,
        actual: now?.state ?? "resolved-away",
      };
    }
  }
  for (const product of frozen.head.products) {
    const now = current.head.products.find((entry) => entry.path === product.path);
    if (now === undefined || now.state !== product.state) {
      return {
        caseId: frozen.caseId,
        row: frozen.head.row,
        verdict: "mismatch",
        expected: product.state,
        actual: now?.state ?? "resolved-away",
      };
    }
  }
  if (current.head.row !== frozen.head.row) {
    return {
      caseId: frozen.caseId,
      row: frozen.head.row,
      verdict: "mismatch",
      expected: frozen.head.row,
      actual: current.head.row,
    };
  }
  return {
    caseId: frozen.caseId,
    row: frozen.head.row,
    verdict: "match",
    expected: frozen.head.row,
    actual: current.head.row,
  };
};

interface Options {
  readonly out: string;
  readonly evidence?: string;
  readonly perRow: number;
  readonly seed: number;
}

const usage = `audit.ts [--out <dir>] [--per-row <n>] [--seed <n>] [--evidence <dir>]

  --out       corpus directory (default: evals/data/v2)
  --per-row   replays sampled per declared row (default: 10)
  --seed      selection seed (default: 7)
  --evidence  also write audit.jsonl to <dir>`;

const parseOptions = (argv: readonly string[]): Options => {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]!;
    if (!flag.startsWith("--")) continue;
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      throw new Error(`missing value for ${flag}\n\n${usage}`);
    }
    values.set(flag.slice(2), next);
    index += 1;
  }
  const positive = (name: string, fallback: number): number => {
    const raw = values.get(name);
    if (raw === undefined) return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 1) {
      throw new Error(`--${name} must be a positive integer\n\n${usage}`);
    }
    return value;
  };
  return {
    out: values.get("out") ?? join(HERE, "data", "v2"),
    ...(values.get("evidence") === undefined ? {} : { evidence: values.get("evidence") }),
    perRow: positive("per-row", 10),
    seed: positive("seed", 7),
  };
};

/** One line per declared row: sampled, matched, mismatched. */
export const formatAudit = (rows: readonly AuditRow[]): string => {
  const byRow = new Map<string, { sampled: number; match: number; mismatch: number }>();
  for (const row of rows) {
    const cell = byRow.get(row.row) ?? { sampled: 0, match: 0, mismatch: 0 };
    cell.sampled += 1;
    if (row.verdict === "match") cell.match += 1;
    else cell.mismatch += 1;
    byRow.set(row.row, cell);
  }
  return [...byRow.entries()]
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(
      ([row, cell]) =>
        `${row}: ${cell.sampled} sampled, ${cell.match} match, ${cell.mismatch} mismatch`,
    )
    .join("\n");
};

const main = (): void => {
  const options = parseOptions(process.argv.slice(2));
  const cases = readJsonl<StoredCase>(join(options.out, "cases.jsonl"));
  const evidence = new Map(
    readJsonl<StoredEvidence>(join(options.out, "evidence.jsonl")).map((entry) => [
      entry.caseId,
      entry,
    ]),
  );
  const frozen = readJsonl<CaseFacts>(join(options.out, "facts.jsonl"));
  if (frozen.length === 0) {
    process.stderr.write(`no facts in ${options.out}; run bun run eval:facts first\n`);
    process.exitCode = 1;
    return;
  }
  const byId = new Map(cases.map((entry) => [entry.caseId, entry]));
  const picked = drawAudit(frozen, options.perRow, options.seed);
  const rows: AuditRow[] = [];
  for (const entry of picked) {
    const stored = byId.get(entry.caseId);
    if (stored === undefined) continue;
    const current = caseFacts(stored, evidence.get(stored.caseId), sessionProbe(stored.sessionCwd));
    rows.push(auditRow(entry, current));
  }
  mkdirSync(options.out, { recursive: true });
  const serialized = rows
    .map((row) => JSON.stringify(row))
    .join("\n")
    .concat("\n");
  writeFileSync(join(options.out, "audit.jsonl"), serialized);
  if (options.evidence !== undefined) {
    mkdirSync(options.evidence, { recursive: true });
    writeFileSync(
      join(options.evidence, "audit.jsonl"),
      rows
        .map((row) => JSON.stringify(hideSessionIdsDeep(row)))
        .join("\n")
        .concat("\n"),
    );
  }
  process.stdout.write(`${formatAudit(rows)}\n`);
};

if (import.meta.main) main();
