#!/usr/bin/env bun
/**
 * Freeze real classifier answers for every sampled, labeled head.
 *
 * The file name carries the model, so the baseline writes
 * `answers.clef-flash.jsonl` and a comparison writes its own file. Answered
 * cases are skipped, so a rerun continues where the last one stopped. The
 * classifier input carries the frozen resolved facts, matching `settle.ts`.
 *
 * Run: `bun run eval:answers --out <dir> --model <provider/id>`.
 */

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  readJsonl,
  type StoredAnswer,
  type StoredAnswerValue,
  type StoredCase,
} from "./case-file.ts";
import type { CaseFacts } from "./facts.ts";
import { classifierInput } from "./input.ts";
import type { LabelSample } from "./sample.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));

/** The last path segment of a `provider/id` model name. */
export const shortModel = (model: string): string => model.slice(model.lastIndexOf("/") + 1);

/** The answer file for one model: `answers.<short-model>.jsonl`. */
export const answerPath = (out: string, model: string): string =>
  join(out, `answers.${shortModel(model)}.jsonl`);

/** Every case id the sample asks about, excluding the blind pilot seeds. */
export const sampledCaseIds = (sample: LabelSample | undefined): ReadonlySet<string> => {
  if (sample === undefined) return new Set();
  return new Set(
    Object.values(sample.passes).flatMap((pass) =>
      pass.sittings.flatMap((sitting) => sitting.cards),
    ),
  );
};

/**
 * A case is askable when it is sampled, its head question carries a label, and
 * its frozen facts are promotable. A pilot seed and an unresolved case are
 * never asked.
 */
export const askable = (
  cases: readonly StoredCase[],
  labeled: ReadonlySet<string>,
  sample: ReadonlySet<string>,
  facts?: ReadonlyMap<string, CaseFacts>,
): readonly StoredCase[] =>
  cases.filter((entry) => {
    if (!sample.has(entry.caseId)) return false;
    if (entry.candidates.length === 0 || entry.questions.length === 0) return false;
    if (!labeled.has(`${entry.caseId}\u0000${entry.questions[0]!.key}`)) return false;
    const fact = facts?.get(entry.caseId);
    if (fact !== undefined && !fact.promotable) return false;
    return true;
  });

interface Options {
  readonly out: string;
  readonly model: string;
  readonly limit: number;
  readonly timeout: number;
}

const usage = `answers.ts --model <provider/id> [--out <dir>] [--limit <n>] [--timeout <ms>]

  --model    the classifier to call, provider/id
  --out      corpus directory (default: evals/data/v2)
  --limit    stop after this many new cases
  --timeout  per-call timeout in milliseconds (default: 15000)`;

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
    model,
    limit: positive("limit", Number.MAX_SAFE_INTEGER),
    timeout: positive("timeout", 15_000),
  };
};

const readSample = (out: string): LabelSample | undefined => {
  try {
    return JSON.parse(readFileSync(join(out, "sample.json"), "utf8")) as LabelSample;
  } catch {
    return undefined;
  }
};

const main = async (): Promise<void> => {
  const options = parseOptions(process.argv.slice(2));
  const cases = readJsonl<StoredCase>(join(options.out, "cases.jsonl"));
  if (cases.length === 0) {
    throw new Error(`no cases in ${options.out}; run bun run eval:harvest:v2 first`);
  }
  // The sample is a single JSON object, read with the platform loader.
  const sample = readSample(options.out);
  const labels = readJsonl<{ readonly caseId: string; readonly key: string; readonly pilot?: boolean }>(
    join(options.out, "labels.jsonl"),
  ).filter((row) => row.pilot !== true);
  const labeled = new Set(labels.map((row) => `${row.caseId}\u0000${row.key}`));
  const facts = new Map(
    readJsonl<CaseFacts>(join(options.out, "facts.jsonl")).map((entry) => [entry.caseId, entry]),
  );
  const answersPath = answerPath(options.out, options.model);
  const answered = new Set(readJsonl<StoredAnswer>(answersPath).map((row) => row.caseId));
  const pending = askable(cases, labeled, sampledCaseIds(sample), facts)
    .filter((entry) => !answered.has(entry.caseId))
    .slice(0, options.limit);
  if (pending.length === 0) {
    console.log(`${answered.size} cases already answered; nothing to do`);
    return;
  }

  const runtime = await ModelRuntime.create();
  const available = await runtime.getAvailableOfType("classifier");
  const [provider, ...rest] = options.model.split("/");
  const modelId = rest.join("/");
  const model = available.find((entry) => entry.provider === provider && entry.id === modelId);
  if (model === undefined) {
    throw new Error(`no classifier matches ${options.model}`);
  }

  mkdirSync(options.out, { recursive: true });
  let malformed = 0;
  for (const [index, entry] of pending.entries()) {
    const { digest, questions } = classifierInput(entry, facts.get(entry.caseId));
    const result = await runtime.classify(
      model,
      {
        state: digest,
        questions: Object.fromEntries(questions.map((q) => [q.key, q.question])),
      },
      { signal: AbortSignal.timeout(options.timeout) },
    );
    const answers: Record<string, StoredAnswerValue> = {};
    for (const [key, answer] of Object.entries(result.answers)) {
      if (answer.type === "choice") {
        answers[key] = {
          choice: answer.choice,
          probabilities: { ...answer.probabilities },
          confidence: answer.confidence,
        };
      } else if (answer.type === "bool") {
        answers[key] = { probability: answer.probability };
      } else {
        malformed += 1;
      }
    }
    appendFileSync(
      answersPath,
      `${JSON.stringify({
        caseId: entry.caseId,
        at: entry.at,
        provider: result.provider,
        model: result.model,
        stopReason: result.stopReason,
        ...(result.errorMessage === undefined ? {} : { errorMessage: result.errorMessage }),
        answers,
      })}\n`,
    );
    if ((index + 1) % 25 === 0 || index + 1 === pending.length) {
      console.log(`  ${index + 1}/${pending.length} answered`);
    }
  }
  console.log(`wrote ${pending.length} to ${answersPath}`);
  if (malformed > 0) console.log(`  ${malformed} answer(s) were not a choice and were dropped`);
};

if (import.meta.main) await main();
