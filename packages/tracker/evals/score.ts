#!/usr/bin/env bun
/**
 * Score a frozen classifier answer file against the human labels.
 *
 * The product's own `classifyVerdict` decides each case, so a score row is the
 * decision the tracker would have taken. Only the head question is scored: the
 * product routes one candidate per decision. The headline row uses the product
 * thresholds; the threshold sweep is secondary. There is no feature column.
 *
 * Run: `bun run eval:score --out <dir> --model <provider/id>`.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ClassifierAnswer,
  ClassifierResult,
  ClassifierStopReason,
} from "@earendil-works/pi-ai";
import {
  classifyVerdict,
  DEFAULT_MIN_ANSWER_CONFIDENCE,
  DEFAULT_NEEDS_CONTEXT_PROBABILITY_THRESHOLD,
  NEEDS_CONTEXT_LABEL,
} from "../src/compaction/classifier.ts";
import { answerPath } from "./answers.ts";
import { readJsonl, type StoredAnswer, type StoredCase } from "./case-file.ts";
import type { CaseFacts } from "./facts.ts";
import type { LabelRecord } from "./labeling.ts";
import { passOfRecord } from "./pass.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));

/** One label joined to its question, inside a pass. */
export interface ScoreLabel {
  readonly caseId: string;
  readonly key: string;
  readonly label: string;
  readonly at: string;
  readonly pass: string;
}

/** One row of the score. */
export interface ScoreRow {
  readonly name: string;
  readonly cases: number;
  readonly compacted: number;
  readonly falseCompact: number;
  readonly correct: number;
  readonly caseAccuracy: number;
}

/** The pooled and per-pass score. */
export interface ScoreReport {
  readonly model: string;
  readonly rows: readonly ScoreRow[];
  readonly passes: readonly string[];
}

/** Rebuild the `ClassifierResult` the classifier returned. */
export const reconstructResult = (stored: StoredAnswer): ClassifierResult => ({
  api: "typesafe-system-one",
  provider: stored.provider,
  model: stored.model,
  answers: Object.fromEntries(
    Object.entries(stored.answers).map(([key, answer]) =>
      "probability" in answer
        ? [key, { type: "bool" as const, probability: answer.probability }]
        : [
            key,
            {
              type: "choice" as const,
              choice: answer.choice,
              probabilities: { ...answer.probabilities },
              confidence: answer.confidence,
            },
          ],
    ),
  ),
  stopReason: stored.stopReason as ClassifierStopReason,
  ...(stored.errorMessage === undefined ? {} : { errorMessage: stored.errorMessage }),
  timestamp: 0,
});

/** `P(needs-context)` for a choice answer, `P(true)` for a bool, else 0. */
export const needsProbabilityOf = (answer: ClassifierAnswer): number =>
  answer.type === "choice"
    ? (answer.probabilities[NEEDS_CONTEXT_LABEL] ?? 0)
    : answer.type === "bool"
      ? answer.probability
      : 0;

/** One point in the threshold sweep. */
export interface KnobPoint {
  readonly threshold: number;
  readonly confidence: number;
}

/** The product's thresholds and confidence floors to sweep. */
export const GRID: {
  readonly thresholds: readonly number[];
  readonly confidences: readonly number[];
} = {
  thresholds: Array.from({ length: 19 }, (_, index) => Number((0.05 + index * 0.05).toFixed(2))),
  confidences: Array.from({ length: 10 }, (_, index) => Number((index * 0.1).toFixed(2))),
};

export const gridPoints = (): readonly KnobPoint[] =>
  GRID.thresholds.flatMap((threshold) =>
    GRID.confidences.map((confidence) => ({ threshold, confidence })),
  );

const answerModelOf = (stored: StoredAnswer): string => `${stored.provider}/${stored.model}`;

/** The requested model and every answer must name the same classifier. */
const checkModels = (answers: readonly StoredAnswer[], model: string): void => {
  const frozen = [...new Set(answers.map(answerModelOf))];
  if (frozen.some((entry) => entry !== model)) {
    throw new Error(
      `the score asks for ${model} but the answers are frozen for ${frozen.join(", ")}`,
    );
  }
};

interface Scored {
  readonly caseId: string;
  readonly pass: string;
  readonly result: ClassifierResult;
  readonly key: string;
  readonly needs: boolean;
}

const scoreRow = (name: string, entries: readonly Scored[], point: KnobPoint): ScoreRow => {
  let compacted = 0;
  let falseCompact = 0;
  let correct = 0;
  for (const entry of entries) {
    const verdict = classifyVerdict(entry.result, [entry.key], point.threshold, point.confidence);
    const compacting = verdict.kind === "compact";
    if (compacting) compacted += 1;
    if (compacting && entry.needs) falseCompact += 1;
    if (compacting !== entry.needs) correct += 1;
  }
  return {
    name,
    cases: entries.length,
    compacted,
    falseCompact,
    correct,
    caseAccuracy: entries.length === 0 ? 0 : correct / entries.length,
  };
};

/**
 * Score the frozen answers. A label outside the requested passes is ignored;
 * the pooled row covers every scored case.
 */
export const scoreAnswers = (input: {
  readonly cases: readonly StoredCase[];
  readonly facts: ReadonlyMap<string, CaseFacts>;
  readonly labels: readonly ScoreLabel[];
  readonly answers: readonly StoredAnswer[];
  readonly model: string;
  readonly passes: readonly string[];
  readonly threshold?: number;
  readonly confidence?: number;
}): ScoreReport => {
  checkModels(input.answers, input.model);
  const answers = new Map(input.answers.map((entry) => [entry.caseId, entry]));
  const point: KnobPoint = {
    threshold: input.threshold ?? DEFAULT_NEEDS_CONTEXT_PROBABILITY_THRESHOLD,
    confidence: input.confidence ?? DEFAULT_MIN_ANSWER_CONFIDENCE,
  };
  const scored: Scored[] = [];
  for (const stored of input.cases) {
    const fact = input.facts.get(stored.caseId);
    if (fact === undefined || !fact.promotable) continue;
    const question = stored.questions[0];
    if (question === undefined) continue;
    const label = input.labels.find(
      (entry) => entry.caseId === stored.caseId && entry.key === question.key,
    );
    const answer = answers.get(stored.caseId);
    if (label === undefined || answer === undefined) continue;
    scored.push({
      caseId: stored.caseId,
      pass: label.pass,
      result: reconstructResult(answer),
      key: question.key,
      needs: label.label === NEEDS_CONTEXT_LABEL,
    });
  }
  const rows = input.passes.map((pass) =>
    scoreRow(
      pass,
      scored.filter((entry) => entry.pass === pass),
      point,
    ),
  );
  rows.push(scoreRow("pooled", scored, point));
  return { model: input.model, rows, passes: input.passes };
};

/** A fixed-width table, one row per pass and pooled. */
export const formatScore = (report: ScoreReport): string => {
  const header = ["score", "cases", "compacted", "badCmp", "caseAcc"];
  const cells = report.rows.map((row) => [
    row.name,
    String(row.cases),
    String(row.compacted),
    String(row.falseCompact),
    `${(row.caseAccuracy * 100).toFixed(1)}%`,
  ]);
  const widths = header.map((name, column) =>
    Math.max(name.length, ...cells.map((line) => line[column]!.length)),
  );
  const line = (values: readonly string[]): string =>
    values
      .map((value, column) => value.padEnd(widths[column]!))
      .join("  ")
      .trimEnd();
  const point = `${(DEFAULT_NEEDS_CONTEXT_PROBABILITY_THRESHOLD * 100).toFixed(0)}% needs-context, ${(DEFAULT_MIN_ANSWER_CONFIDENCE * 100).toFixed(0)}% confidence`;
  return [
    `model: ${report.model}`,
    `threshold: ${point}`,
    line(header),
    widths.map((width) => "─".repeat(width)).join("  "),
    ...cells.map(line),
  ].join("\n");
};

interface Options {
  readonly out: string;
  readonly model: string;
  readonly evidence?: string;
}

const usage = `score.ts --model <provider/id> [--out <dir>] [--evidence <dir>]

  --model     the classifier the answer file names
  --out       corpus directory (default: evals/data/v2)
  --evidence  also write score.json to <dir>`;

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
  const model = values.get("model");
  if (model === undefined) throw new Error(`--model is required\n\n${usage}`);
  return {
    out: values.get("out") ?? join(HERE, "data", "v2"),
    model,
    ...(values.get("evidence") === undefined ? {} : { evidence: values.get("evidence") }),
  };
};

const main = (): void => {
  const options = parseOptions(process.argv.slice(2));
  const cases = readJsonl<StoredCase>(join(options.out, "cases.jsonl"));
  const facts = new Map(
    readJsonl<CaseFacts>(join(options.out, "facts.jsonl")).map((entry) => [entry.caseId, entry]),
  );
  const records = readJsonl<LabelRecord>(join(options.out, "labels.jsonl"));
  const passes = [...new Set(records.map((record) => passOfRecord(record)))].sort();
  const labels = records.map((record): ScoreLabel => ({
    caseId: record.caseId,
    key: record.key,
    label: record.label,
    at: record.at,
    pass: passOfRecord(record),
  }));
  const answers = readJsonl<StoredAnswer>(answerPath(options.out, options.model));
  if (answers.length === 0) {
    throw new Error(
      `no answers at ${answerPath(options.out, options.model)}; run eval:answers first`,
    );
  }
  const report = scoreAnswers({
    cases,
    facts,
    labels,
    answers,
    model: options.model,
    passes,
  });
  process.stdout.write(`${formatScore(report)}\n`);
  if (options.evidence !== undefined) {
    mkdirSync(options.evidence, { recursive: true });
    writeFileSync(
      join(options.evidence, "score.json"),
      `${JSON.stringify({ model: report.model, rows: report.rows }, null, 2)}\n`,
    );
  }
};

if (import.meta.main) main();
