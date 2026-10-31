#!/usr/bin/env bun
/**
 * Draw the declared-format label sample.
 *
 * The sample is quota-based, staged by the measured head firings in
 * `facts.jsonl`. Every behavior-changing declared row gets up to 25 cases per
 * pass, the 20-case pilot is drawn first and kept out of both passes, and
 * control heads fill the remainder so the lift test has a base rate. The order
 * is one seeded shuffle per pass, interleaved, so the queue walks the stored
 * order unchanged.
 *
 * Run: `bun run eval:sample [--out <dir>] [--seed <n>] [--target <n>] [--evidence <dir>]`.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readJsonl, type StoredCase } from "./case-file.ts";
import { hideSessionIdsDeep } from "./evidence-redact.ts";
import type { CaseFacts } from "./facts.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));

/** The two label passes the declared corpus uses. */
export const V2_PASSES = ["v2-a", "v2-b"] as const;
export type V2Pass = (typeof V2_PASSES)[number];

/** One sitting: its cards in order, and the blind pilot seeds it opens with. */
export interface SampleSitting {
  readonly cards: readonly string[];
  readonly seededWith: readonly string[];
}

/** One pass split into sittings of at most 200 cards. */
export interface SamplePass {
  readonly sittings: readonly SampleSitting[];
}

/** The stored queue and the quota bookkeeping behind it. */
export interface LabelSample {
  readonly corpus: "v2";
  readonly createdAt: string;
  readonly seed: number;
  readonly target: number;
  readonly targetPerRowPerPass: number;
  readonly floorPerRowPerPass: number;
  readonly unmeasurable: readonly string[];
  readonly belowQuota: readonly string[];
  readonly pilot: readonly string[];
  readonly passes: Readonly<Record<V2Pass, SamplePass>>;
}

/** One declared row's quota result. */
export interface SampleRow {
  readonly row: string;
  readonly verdict: "compact" | "keep" | "abstain";
  /** Available declared heads for the row. */
  readonly heads: number;
  /** Reserved firings per pass. */
  readonly firings: Readonly<Record<V2Pass, number>>;
  readonly status: "measure" | "unmeasurable" | "below quota" | "reported";
}

export interface SampleOptions {
  readonly seed: number;
  readonly target: number;
  readonly targetPerRowPerPass: number;
  readonly floorPerRowPerPass: number;
  /** The stored sample's timestamp; injected so a rerun is byte-identical. */
  readonly now: string;
}

/** A small deterministic PRNG (mulberry32). */
const prng = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
};

/** Fisher-Yates, seeded. The input is never mutated. */
export const seededShuffle = <T>(values: readonly T[], seed: number): readonly T[] => {
  const out = [...values];
  const random = prng(seed);
  for (let index = out.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    const value = out[index]!;
    out[index] = out[swap]!;
    out[swap] = value;
  }
  return out;
};

/** True when a case's head is a control: it carries no declaration. */
const isControl = (facts: CaseFacts): boolean => !facts.declaredHead;

/**
 * Weave two kinds so neither runs long. The smaller group is spaced through
 * the larger one, which keeps the mix proportional across a sitting.
 */
const weaveByKind = (
  cards: readonly CaseFacts[],
  kindOf: (facts: CaseFacts) => boolean,
): readonly CaseFacts[] => {
  const one = cards.filter(kindOf);
  const other = cards.filter((facts) => !kindOf(facts));
  if (one.length === 0 || other.length === 0) return [...cards];
  const smaller = one.length <= other.length ? one : other;
  const larger = one.length <= other.length ? other : one;
  const run = Math.ceil(larger.length / smaller.length);
  const out: CaseFacts[] = [];
  let small = 0;
  let large = 0;
  while (small < smaller.length || large < larger.length) {
    if (small < smaller.length) out.push(smaller[small++]!);
    for (let step = 0; step < run && large < larger.length; step += 1) {
      out.push(larger[large++]!);
    }
  }
  return out;
};

/** Split cards into sittings of at most `size`, in order. */
const sittingsOf = (cards: readonly string[], size: number): readonly (readonly string[])[] => {
  const parts: string[][] = [];
  for (let start = 0; start < cards.length; start += size) {
    parts.push(cards.slice(start, start + size));
  }
  return parts;
};

/** Ten blind pilot seeds for one sitting, cycling through the pilot set. */
const seedsFor = (pilot: readonly string[], index: number): readonly string[] =>
  pilot.length === 0
    ? []
    : Array.from({ length: 10 }, (_, offset) => pilot[(index * 10 + offset) % pilot.length]!);

/**
 * Draw the sample. Every eligible case lands in exactly one pass; the pilot is
 * excluded from both. For a behavior-changing row the reservation stops at the
 * available count, so a row below the target is still measured.
 */
export const drawSample = (
  facts: readonly CaseFacts[],
  options: SampleOptions,
): { readonly sample: LabelSample; readonly rows: readonly SampleRow[] } => {
  const eligible = facts.filter((entry) => entry.promotable);
  const shuffled = seededShuffle(eligible, options.seed);

  // Behavior-changing declared rows, ranked by available heads.
  const byRow = new Map<string, CaseFacts[]>();
  for (const entry of shuffled) {
    if (!entry.declaredHead) continue;
    if (entry.head.verdict === "abstain") continue;
    byRow.set(entry.head.row, [...(byRow.get(entry.head.row) ?? []), entry]);
  }
  const ranked = [...byRow.entries()].sort(
    (left, right) => right[1].length - left[1].length || left[0].localeCompare(right[0]),
  );

  const passA: CaseFacts[] = [];
  const passB: CaseFacts[] = [];
  const reserved = new Set<string>();
  const firingsByRow = new Map<string, Record<V2Pass, number>>();
  for (const [row, cases] of ranked) {
    const even = cases.filter((_, index) => index % 2 === 0);
    const odd = cases.filter((_, index) => index % 2 === 1);
    const pickedA = even.slice(0, options.targetPerRowPerPass);
    const pickedB = odd.slice(0, options.targetPerRowPerPass);
    for (const entry of [...pickedA, ...pickedB]) reserved.add(entry.caseId);
    passA.push(...pickedA);
    passB.push(...pickedB);
    firingsByRow.set(row, { "v2-a": pickedA.length, "v2-b": pickedB.length });
  }

  const passTargetA = Math.ceil(options.target / 2);
  const passTargetB = options.target - passTargetA;
  for (const entry of shuffled) {
    if (!isControl(entry) || reserved.has(entry.caseId)) continue;
    const roomA = passA.length < passTargetA;
    const roomB = passB.length < passTargetB;
    if (!roomA && !roomB) break;
    if (roomA && (!roomB || passA.length <= passB.length)) passA.push(entry);
    else passB.push(entry);
  }

  // The pilot is drawn last, from the cases the gate is not using. Controls
  // come first, so a blind seed never shrinks a declared row's quota.
  const used = new Set([...passA, ...passB].map((entry) => entry.caseId));
  const leftover = shuffled.filter((entry) => !used.has(entry.caseId));
  const pilotIds = [
    ...leftover.filter((entry) => isControl(entry)),
    ...leftover.filter((entry) => !isControl(entry)),
  ]
    .slice(0, Math.min(20, leftover.length))
    .map((entry) => entry.caseId);

  // Declared rows that were not reserved are dropped: the remainder is controls.
  const passes: Record<V2Pass, SamplePass> = { "v2-a": { sittings: [] }, "v2-b": { sittings: [] } };
  let sittingIndex = 0;
  for (const [name, cards] of [
    ["v2-a", passA],
    ["v2-b", passB],
  ] as const) {
    const byId = new Map(cards.map((entry) => [entry.caseId, entry]));
    passes[name] = {
      sittings: sittingsOf(
        cards.map((entry) => entry.caseId),
        200,
      ).map((cardsHere, index) => {
        const interleaved = weaveByKind(
          cardsHere.map((id) => byId.get(id)!),
          (entry) => entry.declaredHead,
        ).map((entry) => entry.caseId);
        return {
          cards: interleaved,
          seededWith: seedsFor(pilotIds, sittingIndex + index),
        };
      }),
    };
    sittingIndex += passes[name].sittings.length;
  }

  const rows: SampleRow[] = [];
  const addRow = (row: string, verdict: SampleRow["verdict"], heads: number): void => {
    const firings = firingsByRow.get(row) ?? { "v2-a": 0, "v2-b": 0 };
    const status: SampleRow["status"] =
      verdict === "abstain"
        ? "reported"
        : heads < options.floorPerRowPerPass * 2
          ? "unmeasurable"
          : V2_PASSES.some((pass) => firings[pass] < options.targetPerRowPerPass)
            ? "below quota"
            : "measure";
    rows.push({ row, verdict, heads, firings, status });
  };
  for (const [row, cases] of ranked) addRow(row, cases[0]!.head.verdict, cases.length);
  // Abstain rows are counted and reported, never reserved.
  const abstain = new Map<string, number>();
  for (const entry of shuffled) {
    if (!entry.declaredHead || entry.head.verdict !== "abstain") continue;
    abstain.set(entry.head.row, (abstain.get(entry.head.row) ?? 0) + 1);
  }
  for (const [row, heads] of abstain) {
    if (!rows.some((entry) => entry.row === row)) addRow(row, "abstain", heads);
  }

  const sample: LabelSample = {
    corpus: "v2",
    createdAt: options.now,
    seed: options.seed,
    target: options.target,
    targetPerRowPerPass: options.targetPerRowPerPass,
    floorPerRowPerPass: options.floorPerRowPerPass,
    unmeasurable: rows
      .filter((row) => row.status === "unmeasurable")
      .map((row) => row.row)
      .sort(),
    belowQuota: rows
      .filter((row) => row.status === "below quota")
      .map((row) => row.row)
      .sort(),
    pilot: pilotIds,
    passes,
  };
  return { sample, rows: rows.sort((left, right) => left.row.localeCompare(right.row)) };
};

/** The quota table the command prints. */
export const formatSampleTable = (
  rows: readonly SampleRow[],
  passes: readonly V2Pass[],
): string => {
  const header = ["declared row", "verdict", "heads", ...passes, "status"];
  const cells = rows.map((row) => [
    row.row,
    row.verdict,
    String(row.heads),
    ...passes.map((pass) => String(row.firings[pass])),
    row.status,
  ]);
  const widths = header.map((name, column) =>
    Math.max(name.length, ...cells.map((line) => line[column]!.length)),
  );
  const line = (values: readonly string[]): string =>
    values
      .map((value, column) => value.padEnd(widths[column]!))
      .join("  ")
      .trimEnd();
  return [
    line(header),
    widths.map((width) => "─".repeat(width)).join("  "),
    ...cells.map(line),
  ].join("\n");
};

interface Options {
  readonly out: string;
  readonly evidence?: string;
  readonly seed: number;
  readonly target: number;
}

const usage = `sample.ts [--out <dir>] [--seed <n>] [--target <n>] [--evidence <dir>]

  --out       corpus directory (default: evals/data/v2)
  --seed      shuffle seed (default: 7)
  --target    sampled cards (default: 660)
  --evidence  also write sample.json to <dir>`;

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
    seed: positive("seed", 7),
    target: positive("target", 660),
  };
};

/** The corpus timestamp, so a rerun with the same seed is byte-identical. */
const corpusStamp = (out: string, cases: readonly StoredCase[]): string => {
  try {
    const manifest = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8")) as {
      generatedAt?: unknown;
    };
    if (typeof manifest.generatedAt === "string") return manifest.generatedAt;
  } catch {
    // Fall through to the newest case time.
  }
  return cases[cases.length - 1]?.at ?? "1970-01-01T00:00:00.000Z";
};

const main = (): void => {
  const options = parseOptions(process.argv.slice(2));
  const cases = readJsonl<StoredCase>(join(options.out, "cases.jsonl"));
  const facts = readJsonl<CaseFacts>(join(options.out, "facts.jsonl"));
  if (facts.length === 0) {
    process.stderr.write(`no facts in ${options.out}; run bun run eval:facts first\n`);
    process.exitCode = 1;
    return;
  }
  const { sample, rows } = drawSample(facts, {
    seed: options.seed,
    target: options.target,
    targetPerRowPerPass: 25,
    floorPerRowPerPass: 10,
    now: corpusStamp(options.out, cases),
  });
  mkdirSync(options.out, { recursive: true });
  const serialized = `${JSON.stringify(sample, null, 2)}\n`;
  writeFileSync(join(options.out, "sample.json"), serialized);
  if (options.evidence !== undefined) {
    mkdirSync(options.evidence, { recursive: true });
    writeFileSync(
      join(options.evidence, "sample.json"),
      `${JSON.stringify(hideSessionIdsDeep(sample), null, 2)}\n`,
    );
  }
  process.stdout.write(`${formatSampleTable(rows, V2_PASSES)}\n`);
  process.stdout.write(
    `\nsample: ${Object.values(sample.passes)
      .flatMap((pass) => pass.sittings)
      .reduce(
        (total, sitting) => total + sitting.cards.length,
        0,
      )} cards, ${sample.pilot.length} pilot seeds, seed ${options.seed}\n`,
  );
};

if (import.meta.main) main();
