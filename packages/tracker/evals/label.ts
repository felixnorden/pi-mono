/**
 * Interactive labeler for the smart-compaction corpus.
 *
 * One keypress per candidate: `n` for needs-context, `s` for stands-alone. Each
 * answer is appended to `data/labels.jsonl` as it is given, so quitting or
 * crashing loses nothing, and the next run resumes where the last one stopped.
 *
 * Run `bun run eval:harvest` and `bun run eval:review` first.
 *
 * Run: `bun run eval:label` (options below). Needs a real terminal.
 */

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { emitKeypressEvents, type Key } from "node:readline";
import { readJsonl, type StoredCase, type StoredEvidence } from "./case-file.ts";
import type { CaseFacts } from "./facts.ts";
import { passOfRecord } from "./pass.ts";
import type { LabelSample } from "./sample.ts";
import {
  buildQueue,
  countLabels,
  formatCounts,
  formatSampleSplit,
  passRefusal,
  formatLabelRecord,
  LABELS,
  labelIndex,
  labelKeyOf,
  queueSize,
  runLabeling,
  type LabelRecord,
  type LabelSession,
  type LabelStore,
  type LabelSuggestion,
  type LabelValue,
  type StoredSurprise,
} from "./labeling.ts";
import { ansiPaint, useColor } from "./style.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const LABELS_FILE = "labels.jsonl";
const SURPRISES_FILE = "surprises.jsonl";

/** One suggested verdict from a suggestion file, written by an eval. */
interface StoredVerdict {
  readonly caseId: string;
  readonly key: string;
  readonly verdict: string;
  readonly reason: string;
  readonly confidence: string;
}

interface Options {
  readonly out: string;
  readonly classes?: readonly string[];
  readonly limit?: number;
  readonly relabel: boolean;
  readonly report: boolean;
  readonly noColor: boolean;
  readonly suggest?: string;
  readonly pass?: string;
  readonly focus?: "declared" | "control" | "all";
  readonly wave?: number;
  readonly pilot: boolean;
}

const usage = `label.ts [--out <dir>] [--class <name>]... [--limit <n>] [--all] [--no-color]
                 [--report] [--suggest <path>] [--pass <name>] [--focus <kind>] [--wave <n>]

  --out       corpus directory (default: evals/data)
  --class     only this candidate class; repeatable
  --limit     stop after this many answers
  --all       ask about questions that already have an answer
  --no-color  plain output, no escape codes
  --report    print the counts and exit, no terminal needed
  --suggest   read a suggestion file and offer its verdicts as defaults
  --pass      label only this sample pass (v2-a, v2-b)
  --pilot     label the sample's 20 pilot cases as an ordinary sitting
  --focus     declared, control, or all (default: all)
  --wave      the refill wave this sitting belongs to (1 or 2)

With --suggest, each card shows a suggested answer and [enter] accepts it. The
suggestion is a default, not an answer: the accepted label still passes through
a keypress, so the ground truth stays human-authored.`;

export const parseOptions = (argv: readonly string[]): Options => {
  const values = new Map<string, string[]>();
  const flags = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]!;
    if (!flag.startsWith("--")) continue;
    const name = flag.slice(2);
    const next = argv[index + 1];
    if (name === "all" || name === "report" || name === "no-color" || name === "pilot") {
      flags.add(name);
      continue;
    }
    if (next === undefined || next.startsWith("--")) {
      throw new Error(`missing value for ${flag}\n\n${usage}`);
    }
    values.set(name, [...(values.get(name) ?? []), next]);
    index += 1;
  }
  const limit = values.get("limit")?.[0];
  if (limit !== undefined && (!Number.isInteger(Number(limit)) || Number(limit) < 1)) {
    throw new Error(`--limit must be a positive integer\n\n${usage}`);
  }
  const classes = values.get("class");
  const suggest = values.get("suggest")?.[0];
  const out = values.get("out")?.[0] ?? join(HERE, "data");
  if (suggest !== undefined && corpusFormat(out) === "declared") {
    throw new Error(
      `--suggest is disabled for a declared corpus (${out}): the label must not see a suggestion`,
    );
  }
  const pass = values.get("pass")?.[0];
  const pilot = flags.has("pilot");
  if (pilot && pass !== undefined) {
    throw new Error(`--pilot and --pass cannot be combined\n\n${usage}`);
  }
  const focus = values.get("focus")?.[0] as Options["focus"] | undefined;
  if (focus !== undefined && focus !== "declared" && focus !== "control" && focus !== "all") {
    throw new Error(`--focus must be declared, control, or all\n\n${usage}`);
  }
  const rawWave = values.get("wave")?.[0];
  const wave = rawWave === undefined ? undefined : Number(rawWave);
  if (wave !== undefined && wave !== 1 && wave !== 2) {
    throw new Error(`--wave must be 1 or 2\n\n${usage}`);
  }
  return {
    out,
    ...(classes === undefined ? {} : { classes }),
    ...(limit === undefined ? {} : { limit: Number(limit) }),
    ...(suggest === undefined ? {} : { suggest }),
    ...(pass === undefined ? {} : { pass }),
    ...(focus === undefined ? {} : { focus }),
    ...(wave === undefined ? {} : { wave }),
    pilot,
    relabel: flags.has("all"),
    report: flags.has("report"),
    noColor: flags.has("no-color"),
  };
};

/** The manifest's format, when the directory has one. */
const corpusFormat = (out: string): string | undefined => {
  try {
    const manifest = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8")) as {
      format?: unknown;
    };
    return typeof manifest.format === "string" ? manifest.format : undefined;
  } catch {
    return undefined;
  }
};

/** The stored sample, when the directory has one. */
const readSample = (out: string): LabelSample | undefined => {
  try {
    return JSON.parse(readFileSync(join(out, "sample.json"), "utf8")) as LabelSample;
  } catch {
    return undefined;
  }
};

/** Read the suggested verdicts as labeler defaults. Uncertain rows are dropped. */
const readSuggestions = (path: string): ReadonlyMap<string, LabelSuggestion> => {
  const map = new Map<string, LabelSuggestion>();
  for (const row of readJsonl<StoredVerdict>(path)) {
    const label: LabelValue | undefined =
      row.verdict === "keep"
        ? LABELS.needsContext
        : row.verdict === "compact"
          ? LABELS.standsAlone
          : undefined;
    if (label === undefined) continue;
    map.set(labelKeyOf(row.caseId, row.key), {
      label,
      reason: row.reason,
      confidence: row.confidence,
    });
  }
  return map;
};

/** Width of the card, clamped so it stays readable in a narrow or wide terminal. */
const terminalWidth = (): number => Math.min(160, Math.max(60, process.stdout.columns ?? 100));

/** The real terminal: raw keypresses in, text out. */
const ttySession = (): LabelSession => {
  process.stdin.setRawMode(true);
  emitKeypressEvents(process.stdin);
  process.stdin.resume();
  // One persistent listener feeding a queue. Registering a listener per key
  // would drop every key that arrives in the same tick as the previous one.
  const pending: string[] = [];
  let resolveNext: ((key: string) => void) | undefined;
  process.stdin.on("keypress", (str: string | undefined, key: Key) => {
    // Raw mode delivers Ctrl-C as a key, not as a signal.
    const value =
      key.ctrl && (key.name === "c" || key.name === "d") ? "q" : (str ?? key.name ?? "");
    if (resolveNext === undefined) {
      pending.push(value);
      return;
    }
    const resolve = resolveNext;
    resolveNext = undefined;
    resolve(value);
  });
  return {
    write: (text) => {
      process.stdout.write(text);
    },
    nextKey: () => {
      const buffered = pending.shift();
      if (buffered !== undefined) return Promise.resolve(buffered);
      return new Promise<string>((resolve) => {
        resolveNext = resolve;
      });
    },
  };
};

/** Answers file: append on every answer, rewrite on undo. */
const fileStore = (path: string, records: LabelRecord[]): LabelStore => ({
  records,
  append: (record) => {
    records.push(record);
    appendFileSync(path, `${formatLabelRecord(record)}\n`);
  },
  rewrite: () => {
    const text = records.map((record) => formatLabelRecord(record)).join("\n");
    writeFileSync(path, text.length === 0 ? "" : `${text}\n`);
  },
});

const main = async (): Promise<void> => {
  const options = parseOptions(process.argv.slice(2));
  const cases = readJsonl<StoredCase>(join(options.out, "cases.jsonl"));
  if (cases.length === 0) {
    process.stderr.write(`no cases in ${options.out}; run bun run eval:harvest first\n`);
    process.exitCode = 1;
    return;
  }
  mkdirSync(options.out, { recursive: true });
  const labelsPath = join(options.out, LABELS_FILE);
  const records = [...readJsonl<LabelRecord>(labelsPath)];
  const sample = readSample(options.out);
  const refusal = passRefusal(sample, options.pass);
  if (refusal !== null) throw new Error(refusal);
  if (options.pilot && sample === undefined) {
    throw new Error(`--pilot needs a sample.json in ${options.out}`);
  }

  if (options.report) {
    const gateRecords = records.filter((record) => passOfRecord(record) !== "pilot");
    process.stdout.write(`${formatCounts(countLabels(cases, gateRecords))}\n`);
    if (sample !== undefined) process.stdout.write(`${formatSampleSplit(sample, cases)}\n`);
    return;
  }
  if (process.stdin.isTTY !== true || typeof process.stdin.setRawMode !== "function") {
    process.stderr.write(
      "this labeler needs an interactive terminal.\nsplit a terminal and run: cd packages/tracker && bun run eval:label\nuse --report for the counts without a terminal.\n",
    );
    process.exitCode = 1;
    return;
  }

  const evidence = new Map(
    readJsonl<StoredEvidence>(join(options.out, "evidence.jsonl")).map((record) => [
      record.caseId,
      record,
    ]),
  );
  const facts = new Map(
    readJsonl<CaseFacts>(join(options.out, "facts.jsonl")).map((entry) => [entry.caseId, entry]),
  );
  const surprisesPath = join(options.out, SURPRISES_FILE);
  const build = (): ReturnType<typeof buildQueue> =>
    buildQueue(cases, evidence, {
      answered: options.relabel ? new Map() : labelIndex(records),
      ...(options.classes === undefined ? {} : { classes: options.classes }),
      ...(options.limit === undefined ? {} : { limit: options.limit }),
      ...(sample === undefined ? {} : { sample }),
      ...(options.pilot ? { pilot: true } : {}),
      ...(options.pass === undefined ? {} : { pass: options.pass }),
      ...(options.focus === undefined ? {} : { focus: options.focus }),
    });
  const queue = build();
  if (queue.length === 0) {
    process.stdout.write("every queued question already has an answer\n");
    process.stdout.write(`${formatCounts(countLabels(cases, records))}\n`);
    return;
  }

  process.stdout.write(
    `${queueSize(queue)} question(s) in ${queue.length} case(s). n = needs-context, s = stands-alone, ? = keys.\n`,
  );
  // Always render; `--no-color` only drops the escape codes. Without Bun's
  // renderer, `ansiPaint` degrades to plain text on its own.
  const paint = ansiPaint(useColor() && !options.noColor);
  const store = fileStore(labelsPath, records);
  const suggestions = options.suggest === undefined ? undefined : readSuggestions(options.suggest);
  if (suggestions !== undefined) {
    process.stdout.write(
      `${suggestions.size} suggestion(s) loaded from ${options.suggest}; [enter] accepts one.\n`,
    );
  }
  try {
    const result = await runLabeling(queue, store, ttySession(), {
      width: terminalWidth(),
      now: () => new Date().toISOString(),
      paint,
      ...(suggestions === undefined ? {} : { suggestions }),
      ...(sample === undefined ? {} : { corpus: "v2" }),
      ...(options.pilot
        ? { pass: "pilot" }
        : options.pass === undefined
          ? {}
          : { pass: options.pass }),
      ...(facts.size === 0 ? {} : { facts, reveal: true }),
      ...(options.wave === undefined ? {} : { wave: options.wave }),
      onSurprise: (surprise: StoredSurprise) => {
        appendFileSync(surprisesPath, `${JSON.stringify(surprise)}\n`);
      },
    });
    process.stdout.write(
      `\n${paint.bold(result.quit ? "quit" : "done")} after ${result.answered} answer(s)\n`,
    );
  } finally {
    process.stdin.setRawMode(false);
    process.stdin.pause();
  }
  process.stdout.write(`${formatCounts(countLabels(cases, records))}\n`);
  process.stdout.write(`${paint.dim(`wrote ${records.length} answer(s) to ${labelsPath}`)}\n`);
  process.stdout.write(`${queueSize(build())} question(s) left\n`);
};

if (import.meta.main) await main();
