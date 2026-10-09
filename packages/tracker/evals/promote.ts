/**
 * Promote a rule row into `ACCEPTED_RULES`.
 *
 * `ACCEPTED_RULES` is the product policy and `bun run eval:rules` fails when it
 * differs from the production gate. This module turns the manual edit into one
 * command: it reads the real corpus, computes the gate, and rewrites the one
 * `ACCEPTED_RULES` block in `src/compaction/rules.ts` to the measured set.
 *
 * The real corpus only. The synthetic fixture proves the record path, but
 * promotion rests on a labeled pass on real decisions, so `--fixture` is not
 * accepted here.
 *
 * Run: `bun run eval:promote [--out <dir>] [--write]`.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ACCEPTED_RULES } from "../src/compaction/rules.ts";
import {
  formatGate,
  gateAccepted,
  gateOf,
  productionEntries,
  readCorpus,
  sameRuleSet,
  type RuleEntry,
} from "./rules.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));

/** The product source this command reads and writes. */
export const RULES_PATH = fileURLToPath(new URL("../src/compaction/rules.ts", import.meta.url));

/** The one block this module rewrites. */
const ACCEPTED_BLOCK =
  /export const ACCEPTED_RULES: ReadonlySet<string> = new Set\(\[[\s\S]*?\]\);/;

/** The accepted set, as the product's own TypeScript literal, sorted. */
export const renderAcceptedRules = (rules: ReadonlySet<string>): string => {
  const sorted = [...rules].sort();
  if (sorted.length === 0) {
    return "export const ACCEPTED_RULES: ReadonlySet<string> = new Set([]);";
  }
  const lines = sorted.map((rule) => `  ${JSON.stringify(rule)},`).join("\n");
  return `export const ACCEPTED_RULES: ReadonlySet<string> = new Set([\n${lines}\n]);`;
};

/** Read the accepted set back out of the product source. */
export const parseAcceptedRules = (source: string): ReadonlySet<string> => {
  const match = source.match(ACCEPTED_BLOCK);
  if (match === null) throw new Error("ACCEPTED_RULES block not found");
  const body = match[0].slice(match[0].indexOf("["), match[0].lastIndexOf("]") + 1);
  const found = new Set<string>();
  for (const quoted of body.matchAll(/"((?:[^"\\]|\\.)*)"/g)) {
    found.add(JSON.parse(`"${quoted[1]!}"`) as string);
  }
  return found;
};

/** Replace the accepted block, leaving the rest of the module untouched. */
export const applyAcceptedRules = (source: string, rules: ReadonlySet<string>): string => {
  if (!ACCEPTED_BLOCK.test(source)) throw new Error("ACCEPTED_RULES block not found");
  return source.replace(ACCEPTED_BLOCK, () => renderAcceptedRules(rules));
};

/** Rows a rewrite would add or remove. */
export interface AcceptedDiff {
  readonly promoted: readonly string[];
  readonly dropped: readonly string[];
}

export const diffAccepted = (
  current: ReadonlySet<string>,
  measured: ReadonlySet<string>,
): AcceptedDiff => ({
  promoted: [...measured].filter((rule) => !current.has(rule)).sort(),
  dropped: [...current].filter((rule) => !measured.has(rule)).sort(),
});

/**
 * The reason to refuse a promotion, or null when the corpus carries labeled
 * evidence. A missing data directory, an unlabeled corpus, or a label file
 * with unknown spellings all measure as an empty set; writing that set would
 * erase the shipped policy. Refuse instead of writing.
 */
export const corpusRefusal = (entries: readonly RuleEntry[]): string | null =>
  entries.some((entry) => entry.truth !== undefined)
    ? null
    : "corpus has no labeled decisions; refusing to rewrite ACCEPTED_RULES " +
      "(run bun run eval:harvest, then label the decisions)";

// ---------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------

interface Options {
  readonly out: string;
  /** Rewrite the product constant. Off means dry run. */
  readonly write: boolean;
}

const usage = `promote.ts [--out <dir>] [--write]

  --out    corpus directory (default: evals/data)
  --write  rewrite ACCEPTED_RULES to the measured set (default: dry run)`;

const parseOptions = (argv: readonly string[]): Options => {
  const values = new Map<string, string>();
  let write = false;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]!;
    if (flag === "--write") {
      write = true;
      continue;
    }
    if (!flag.startsWith("--")) continue;
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      throw new Error(`missing value for ${flag}\n\n${usage}`);
    }
    values.set(flag.slice(2), next);
    index += 1;
  }
  return { out: values.get("out") ?? join(HERE, "data"), write };
};

const listOf = (rules: ReadonlySet<string>): string => [...rules].sort().join(", ") || "(none)";

/**
 * Report the measured set against the product constant. Returns the process
 * exit code: nonzero in a dry run means the constant is stale.
 */
const main = (): number => {
  const options = parseOptions(process.argv.slice(2));
  const { cases, evidence, labels } = readCorpus(options.out);
  const entries = productionEntries(cases, evidence, labels).entries;
  const refusal = corpusRefusal(entries);
  if (refusal !== null) {
    console.error(refusal);
    return 2;
  }
  const gate = gateOf(entries);
  const measured = gateAccepted(gate);

  console.log("The promotion gate is the same gate eval:rules prints.\n");
  console.log(formatGate(gate));
  console.log(`\ncurrently accepted: ${listOf(ACCEPTED_RULES)}`);
  console.log(`measured accepted: ${listOf(measured)}`);
  const diff = diffAccepted(ACCEPTED_RULES, measured);
  for (const rule of diff.promoted) console.log(`+ promote ${rule}`);
  for (const rule of diff.dropped) console.log(`- drop ${rule}`);

  if (sameRuleSet(ACCEPTED_RULES, measured)) {
    console.log("\nACCEPTED_RULES is in sync.");
    return 0;
  }

  const current = readFileSync(RULES_PATH, "utf8");
  if (!options.write) {
    console.log("\nOut of sync. Re-run with --write to apply:\n");
    console.log(renderAcceptedRules(measured));
    return 1;
  }

  writeFileSync(RULES_PATH, applyAcceptedRules(current, measured));
  const reparsed = parseAcceptedRules(readFileSync(RULES_PATH, "utf8"));
  if (!sameRuleSet(reparsed, measured)) {
    throw new Error("ACCEPTED_RULES did not stick after the write");
  }
  console.log("\nACCEPTED_RULES updated.");
  return 0;
};

if (import.meta.main) process.exitCode = main();
