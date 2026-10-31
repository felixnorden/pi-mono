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
import { readJsonl } from "./case-file.ts";
import type { CaseFacts } from "./facts.ts";
import {
  formatGate,
  gateBase,
  gateOf,
  labeledPasses,
  OLD_FLOOR,
  promotableAccepted,
  productionEntries,
  readCorpus,
  sameRuleSet,
  unlistedPasses,
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
export const corpusRefusal = (entries: readonly import("./rules.ts").RuleEntry[]): string | null =>
  entries.some((entry) => entry.truth !== undefined)
    ? null
    : "corpus has no labeled decisions; refusing to rewrite ACCEPTED_RULES " +
      "(run bun run eval:harvest, then label the decisions)";

/** Promotion is a v2-only operation. Name the corpus, not the caller's intent. */
export const corpusRefusalFor = (format: string | undefined): string | null =>
  format === "declared"
    ? null
    : `promotion runs on the v2 corpus only; this corpus is ${format ?? "unknown"}`;

/** One audited case's verdict, as `audit.jsonl` stores it. */
export interface AuditVerdict {
  readonly row: string;
  readonly verdict: "match" | "mismatch";
}

/** Rows blocked by two or more audit mismatches. */
export const blockedRows = (audit: readonly AuditVerdict[]): readonly string[] => {
  const mismatches = new Map<string, number>();
  for (const row of audit) {
    if (row.verdict !== "mismatch") continue;
    mismatches.set(row.row, (mismatches.get(row.row) ?? 0) + 1);
  }
  return [...mismatches.entries()]
    .filter(([, count]) => count >= 2)
    .map(([row]) => row)
    .sort();
};

/**
 * The additive promotion: the frozen floor plus the measured set, minus any row
 * a deliberate `--remove` names, minus any row two audit mismatches block.
 */
export const promotionSet = (
  measured: ReadonlySet<string>,
  floor: ReadonlySet<string>,
  audit: readonly AuditVerdict[],
  remove: readonly string[],
): ReadonlySet<string> => {
  const rules = new Set<string>([...floor, ...measured]);
  for (const row of remove) rules.delete(row);
  for (const row of blockedRows(audit)) rules.delete(row);
  return rules;
};

// ---------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------

interface Options {
  readonly out: string;
  /** Rewrite the product constant. Off means dry run. */
  readonly write: boolean;
  /** Rows a deliberate promotion removes. */
  readonly remove: readonly string[];
}

const usage = `promote.ts [--out <dir>] [--write] [--remove <rule>]...

  --out     corpus directory (default: evals/data/v2)
  --write   rewrite ACCEPTED_RULES to the additive promotion (default: dry run)
  --remove  delete a row from the accepted set; repeatable, and never implicit`;

const parseOptions = (argv: readonly string[]): Options => {
  const values = new Map<string, string>();
  const remove: string[] = [];
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
    if (flag === "--remove") remove.push(next);
    else values.set(flag.slice(2), next);
    index += 1;
  }
  return { out: values.get("out") ?? join(HERE, "data", "v2"), write, remove };
};

const listOf = (rules: ReadonlySet<string>): string => [...rules].sort().join(", ") || "(none)";

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

/** The corpus' pass list: the sample's keys, else the passes the records carry. */
const passesOf = (
  out: string,
  entries: readonly import("./rules.ts").RuleEntry[],
): readonly string[] => {
  try {
    const sample = JSON.parse(readFileSync(join(out, "sample.json"), "utf8")) as {
      passes?: Record<string, unknown>;
    };
    if (sample.passes !== undefined) return Object.keys(sample.passes);
  } catch {
    // Fall back to the records.
  }
  return labeledPasses(entries);
};

/** One declared row from the frozen facts. */
const declaredRowsOf = (
  facts: readonly CaseFacts[],
): readonly { readonly row: string; readonly verdict: "compact" | "keep" | "abstain" }[] => {
  const rows = new Map<string, "compact" | "keep" | "abstain">();
  for (const entry of facts) {
    if (!entry.promotable || !entry.declaredHead) continue;
    rows.set(entry.head.row, entry.head.verdict);
  }
  return [...rows.entries()].map(([row, verdict]) => ({ row, verdict }));
};

const readOptional = <T>(path: string): readonly T[] => {
  try {
    return readJsonl<T>(path);
  } catch {
    return [];
  }
};

/**
 * Report the additive promotion against the product constant. Returns the
 * process exit code: nonzero in a dry run means the constant is stale.
 */
const main = (): number => {
  const options = parseOptions(process.argv.slice(2));
  const corpus = corpusFormat(options.out);
  const corpusRefusalHere = corpusRefusalFor(corpus);
  if (corpusRefusalHere !== null) {
    console.error(corpusRefusalHere);
    return 2;
  }
  const { cases, evidence, labels } = readCorpus(options.out);
  const facts = new Map(
    readOptional<CaseFacts>(join(options.out, "facts.jsonl")).map((entry) => [entry.caseId, entry]),
  );
  const entries = productionEntries(cases, evidence, labels, facts).entries;
  const refusal = corpusRefusal(entries);
  if (refusal !== null) {
    console.error(refusal);
    return 2;
  }
  const labeled = labeledPasses(entries);
  if (labeled.length < 2) {
    console.error(
      `promotion needs two labeled passes; this corpus has ${labeled.length} (${labeled.join(", ") || "(none)"})`,
    );
    return 2;
  }
  const passes = passesOf(options.out, entries);
  const unlisted = unlistedPasses(entries, passes);
  if (unlisted.length > 0) {
    console.log(`not in this corpus: ${unlisted.join(", ")}`);
  }
  const audit = readOptional<AuditVerdict>(join(options.out, "audit.jsonl"));
  const gate = gateOf(entries, passes, declaredRowsOf([...facts.values()]));
  const measured = promotableAccepted(gate);
  const promotion = promotionSet(measured, OLD_FLOOR, audit, options.remove);

  console.log("The promotion gate is the same gate eval:rules prints.\n");
  console.log(`base: ${gateBase(entries)}`);
  console.log(formatGate(gate));
  console.log(`\ncurrently accepted: ${listOf(ACCEPTED_RULES)}`);
  console.log(`frozen floor: ${listOf(OLD_FLOOR)}`);
  console.log(`measured accepted: ${listOf(measured)}`);
  for (const row of blockedRows(audit)) console.log(`! blocked by two audit mismatches: ${row}`);
  for (const row of options.remove) console.log(`- remove by flag: ${row}`);
  const diff = diffAccepted(ACCEPTED_RULES, promotion);
  for (const rule of diff.promoted) console.log(`+ promote ${rule}`);
  for (const rule of diff.dropped) console.log(`- drop ${rule}`);
  console.log(`\npromotion set: ${listOf(promotion)}`);

  if (sameRuleSet(ACCEPTED_RULES, promotion)) {
    console.log("\nACCEPTED_RULES is in sync.");
    return 0;
  }

  const current = readFileSync(RULES_PATH, "utf8");
  if (!options.write) {
    console.log("\nOut of sync. Re-run with --write to apply:\n");
    console.log(renderAcceptedRules(promotion));
    return 1;
  }

  writeFileSync(RULES_PATH, applyAcceptedRules(current, promotion));
  const reparsed = parseAcceptedRules(readFileSync(RULES_PATH, "utf8"));
  if (!sameRuleSet(reparsed, promotion)) {
    throw new Error("ACCEPTED_RULES did not stick after the write");
  }
  console.log("\nACCEPTED_RULES updated.");
  return 0;
};

if (import.meta.main) process.exitCode = main();
