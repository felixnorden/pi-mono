#!/usr/bin/env bun
/**
 * Score the reliance rule table against the human labels, per rule and per pass.
 *
 * The report measures two replays. The **frozen replay** feeds the rule table
 * the corpus facts the pre-revert router used (batch item texts plus the full
 * evidence record); every candidate's row and verdict must equal its
 * `verdicts.jsonl` entry, so the rename is proven to change nothing. The
 * **production replay** feeds the table a reconstruction of what the product
 * observes at settle: batch item texts plus tool-call paths and commands, with
 * no transcript prose.
 *
 * The gate runs on the production table: at least 10 labeled firings, at least
 * 95% agreement, above the pass base rate, in at least two passes. Only a rule
 * that clears the gate may decide without a model call; the rest report and
 * abstain. `ACCEPTED_RULES` must equal the measured set, or the report exits
 * nonzero. An empty measured set is valid: every row reports and abstains.
 *
 * Usage: `bun run eval:rules [--out <dir>]`
 */
import { join } from "node:path";
import { NEEDS_CONTEXT_LABEL, NEEDS_NONE_LABEL } from "../src/compaction/classifier.ts";
import {
  documentPathsOf,
  knownTextOf,
  PRODUCING_TOOLS,
  producedTextOf,
  productionFacts,
  QRSPI_PLAN_DOCUMENT,
  type BatchFootprint,
  type RecordText,
  type WrittenPath,
} from "../src/compaction/observations.ts";
import { ACCEPTED_RULES, route, type RuleVerdict } from "../src/compaction/rules.ts";
import { readJsonl, type StoredCase, type StoredEvidence } from "./case-file.ts";
import { syntheticCorpus } from "./fixture.ts";
import { LABEL_PASSES, passOf, type LabelPass } from "./pass.ts";

const HERE = import.meta.dir;

/** A label as stored, before canonicalization. */
export interface StoredLabel {
  readonly label: string;
  readonly at: string;
}

/** One frozen pre-revert verdict, from `verdicts.jsonl`. */
export interface StoredVerdict {
  readonly caseId: string;
  readonly key: string;
  /** The frozen rule verdict: `compact`, `keep`, or `uncertain`. */
  readonly rule: string;
  readonly ruleReason: string;
  readonly verdict: string;
}

/** One candidate's raw rule decision, with its label when one exists. */
export interface RuleEntry {
  readonly caseId: string;
  /** The question key, so the frozen parity joins by case id and question key. */
  readonly questionKey: string;
  readonly pass: LabelPass;
  readonly rule: string;
  readonly verdict: RuleVerdict;
  readonly truth: "needs" | "stands" | undefined;
  /** True for the synthetic fixture, never for a real session. */
  readonly synthetic?: boolean;
}

/** One rule's per-pass tally. */
export interface RuleRow {
  readonly pass: LabelPass;
  readonly rule: string;
  readonly verdict: RuleVerdict;
  /** Firings that carry a label. */
  readonly labeled: number;
  /** Labeled firings whose verdict matches the label. */
  readonly correct: number;
}

/** The replayed rules, and the labels the replay could not read. */
export interface RuleReplay {
  readonly entries: readonly RuleEntry[];
  /** Labels present in the file whose spelling is unknown. */
  readonly droppedLabels: number;
}

/** The six frozen reasons mapped to the renamed rows. */
export const FROZEN_REASON_TO_RULE: Readonly<Record<string, string>> = {
  "no document and no plan in play": "no-visible-link",
  "a producing tool wrote the document": "names-batch-output",
  "names a document the batch and record never mention": "names-unknown-path",
  "the work record names a plan document": "plan-document",
  "a document and a dependency both in play": "document-and-dependency",
  "a dependent successor": "dependent-successor",
};

/** The frozen three-way verdict mapped to the rule verdicts. */
export const FROZEN_VERDICT: Readonly<Record<string, RuleVerdict>> = {
  compact: "compact",
  keep: "keep",
  uncertain: "abstain",
};

/** True when the verdict agrees with the label. A keep needs context; a compact stands alone. */
const agrees = (verdict: RuleVerdict, truth: "needs" | "stands"): boolean =>
  (verdict === "keep" && truth === "needs") || (verdict === "compact" && truth === "stands");

/** Map a stored label to the truth it states, or undefined for an unknown spelling. */
const canonicalLabel = (label: string): "needs" | "stands" | undefined =>
  label === NEEDS_CONTEXT_LABEL ? "needs" : label === NEEDS_NONE_LABEL ? "stands" : undefined;

/**
 * The tool-projected footprint for one case: the write and edit paths, the read
 * paths, and every command. Only the call's bounded `path` and `command` count,
 * so assistant prose and tool-result text never enter. Deletes are not parsed
 * from commands.
 */
export const footprintOf = (entries: readonly RecordText[]): BatchFootprint => {
  const wrote: WrittenPath[] = [];
  const read: string[] = [];
  const commands: string[] = [];
  for (const entry of entries) {
    if (entry.kind !== "tool-call") continue;
    const path = entry.args?.path;
    if (path !== undefined) {
      if (PRODUCING_TOOLS.has(entry.name ?? "")) wrote.push({ path, spans: [] });
      else if (entry.name === "read") read.push(path);
    }
    if (entry.args?.command !== undefined) commands.push(entry.args.command);
  }
  return { wrote, read, deleted: [], commands };
};

/** The rule inputs a replay derives from the corpus. */
interface CorpusFacts {
  readonly knownText: string;
  readonly producedText: string;
  readonly candidatePaths: readonly string[];
  readonly planDocument: boolean;
}

/** Build one case's rule inputs from its evidence record and a candidate. */
type FactsOf = (
  stored: StoredCase,
  entries: readonly RecordText[],
  candidateText: string,
) => CorpusFacts;

/** The batch texts one case contributes: each completed item's title and description. */
const batchTextsOf = (stored: StoredCase): readonly string[] =>
  stored.completed.flatMap((item) =>
    item.description === undefined || item.description.length === 0
      ? [item.text]
      : [item.text, item.description],
  );

/** The frozen projection: the batch plus the full evidence record. */
const frozenFacts: FactsOf = (stored, entries, candidateText) => {
  const knownText = knownTextOf(batchTextsOf(stored), entries);
  return {
    knownText,
    producedText: producedTextOf(entries),
    candidatePaths: documentPathsOf(candidateText),
    planDocument: QRSPI_PLAN_DOCUMENT.test(knownText),
  };
};

/** The production projection: the batch plus the tool-projected footprint. */
const productionFactsOf: FactsOf = (stored, entries, candidateText) =>
  productionFacts(batchTextsOf(stored), footprintOf(entries), candidateText);

/**
 * Replay the rules over the corpus with one facts projection. The pass is the
 * label sitting: a labeled question uses its own label timestamp, an unlabeled
 * question uses the first labeled sibling, and a case with no labels uses its
 * own timestamp.
 *
 * Throws when a case pairs questions and candidates unevenly, because every
 * later join is positional.
 */
const replay = (
  cases: readonly StoredCase[],
  evidence: ReadonlyMap<string, StoredEvidence>,
  labels: ReadonlyMap<string, StoredLabel>,
  factsOf: FactsOf,
): RuleReplay => {
  const entries: RuleEntry[] = [];
  let droppedLabels = 0;
  for (const stored of cases) {
    if (stored.questions.length !== stored.candidates.length) {
      throw new Error(
        `${stored.caseId}: ${stored.questions.length} questions for ${stored.candidates.length} candidates`,
      );
    }
    const record = evidence.get(stored.caseId)?.entries ?? [];
    const caseLabels = stored.questions.map((question) =>
      labels.get(`${stored.caseId}\u0000${question.key}`),
    );
    const firstLabelAt = caseLabels.find((label) => label !== undefined)?.at;
    for (const [index, candidate] of stored.candidates.entries()) {
      const labeled = caseLabels[index];
      const canonical = labeled === undefined ? undefined : canonicalLabel(labeled.label);
      if (labeled !== undefined && canonical === undefined) droppedLabels += 1;
      // The live decision record, when the pointer candidate declared
      // something, is the raw row. The other candidates have no record, so the
      // corpus facts route them as before.
      const recorded = index === 0 ? stored.decision : undefined;
      const facts = factsOf(stored, record, candidate.text);
      const decision: { readonly rule: string; readonly verdict: RuleVerdict } =
        recorded === undefined
          ? route({
              references: [],
              products: [],
              candidatePaths: facts.candidatePaths,
              knownText: facts.knownText,
              producedText: facts.producedText,
              dependent: candidate.class === "dependent-successor",
              planDocument: facts.planDocument,
            })
          : { rule: recorded.rule, verdict: recorded.verdict as RuleVerdict };
      entries.push({
        caseId: stored.caseId,
        questionKey: stored.questions[index]!.key,
        pass: passOf(labeled?.at ?? firstLabelAt ?? stored.at),
        rule: decision.rule,
        verdict: decision.verdict,
        truth: canonical,
        ...(stored.synthetic === true ? { synthetic: true } : {}),
      });
    }
  }
  return { entries, droppedLabels };
};

/** The frozen replay: the rename proof, scored against the pre-revert facts. */
export const frozenEntries = (
  cases: readonly StoredCase[],
  evidence: ReadonlyMap<string, StoredEvidence>,
  labels: ReadonlyMap<string, StoredLabel>,
): RuleReplay => replay(cases, evidence, labels, frozenFacts);

/** The production replay: the gate's evidence, scored against product facts. */
export const productionEntries = (
  cases: readonly StoredCase[],
  evidence: ReadonlyMap<string, StoredEvidence>,
  labels: ReadonlyMap<string, StoredLabel>,
): RuleReplay => replay(cases, evidence, labels, productionFactsOf);

/** One candidate whose replayed row or verdict differs from `verdicts.jsonl`. */
export interface ParityMismatch {
  readonly caseId: string;
  readonly questionKey: string;
  readonly expectedRule: string;
  readonly expectedVerdict: RuleVerdict;
  readonly actualRule: string;
  readonly actualVerdict: RuleVerdict;
}

/** Join the frozen replay to `verdicts.jsonl` by case id and question key. */
export const checkParity = (
  entries: readonly RuleEntry[],
  verdicts: readonly StoredVerdict[],
): readonly ParityMismatch[] => {
  const byKey = new Map(verdicts.map((row) => [`${row.caseId}\u0000${row.key}`, row]));
  const mismatches: ParityMismatch[] = [];
  for (const entry of entries) {
    const frozen = byKey.get(`${entry.caseId}\u0000${entry.questionKey}`);
    if (frozen === undefined) {
      mismatches.push({
        caseId: entry.caseId,
        questionKey: entry.questionKey,
        expectedRule: "(missing)",
        expectedVerdict: "abstain",
        actualRule: entry.rule,
        actualVerdict: entry.verdict,
      });
      continue;
    }
    const expectedRule = FROZEN_REASON_TO_RULE[frozen.ruleReason] ?? "(unknown)";
    const expectedVerdict = FROZEN_VERDICT[frozen.rule] ?? "abstain";
    if (expectedRule !== entry.rule || expectedVerdict !== entry.verdict) {
      mismatches.push({
        caseId: entry.caseId,
        questionKey: entry.questionKey,
        expectedRule,
        expectedVerdict,
        actualRule: entry.rule,
        actualVerdict: entry.verdict,
      });
    }
  }
  return mismatches;
};
/** Tally each rule's labeled firings and agreement, per pass. */
export const summarizeRules = (entries: readonly RuleEntry[]): readonly RuleRow[] => {
  const byKey = new Map<
    string,
    {
      pass: LabelPass;
      rule: string;
      verdict: RuleVerdict;
      labeled: number;
      correct: number;
    }
  >();
  for (const entry of entries) {
    const key = `${entry.pass}\u0000${entry.rule}\u0000${entry.verdict}`;
    const row = byKey.get(key) ?? {
      pass: entry.pass,
      rule: entry.rule,
      verdict: entry.verdict,
      labeled: 0,
      correct: 0,
    };
    if (entry.truth !== undefined) {
      row.labeled += 1;
      if (agrees(entry.verdict, entry.truth)) row.correct += 1;
    }
    byKey.set(key, row);
  }
  const order = new Map(LABEL_PASSES.map((pass, index) => [pass, index]));
  return [...byKey.values()].sort(
    (left, right) =>
      order.get(left.pass)! - order.get(right.pass)! ||
      right.labeled - left.labeled ||
      left.rule.localeCompare(right.rule) ||
      left.verdict.localeCompare(right.verdict),
  );
};

/** The labeled question count per pass, the coverage denominator. */
export const labeledByPass = (entries: readonly RuleEntry[]): ReadonlyMap<LabelPass, number> => {
  const counts = new Map<LabelPass, number>(LABEL_PASSES.map((pass) => [pass, 0]));
  for (const entry of entries) {
    if (entry.truth !== undefined) counts.set(entry.pass, counts.get(entry.pass)! + 1);
  }
  return counts;
};

const percent = (value: number): string => `${(value * 100).toFixed(1)}%`;

const signedPercent = (value: number): string =>
  `${value >= 0 ? "+" : "-"}${Math.abs(value * 100).toFixed(1)}%`;

/** Render a table from a header and rows, padding each column. */
const table = (header: readonly string[], rows: readonly (readonly string[])[]): string => {
  const widths = header.map((name, column) =>
    Math.max(name.length, ...rows.map((cells) => cells[column]!.length)),
  );
  const line = (cells: readonly string[]) =>
    cells
      .map((cell, column) => cell.padEnd(widths[column]!))
      .join("  ")
      .trimEnd();
  return [
    line(header),
    widths.map((width) => "─".repeat(width)).join("  "),
    ...rows.map(line),
  ].join("\n");
};

/** The raw per-rule per-pass table. Coverage is against the pass's labeled set. */
export const formatRules = (
  rows: readonly RuleRow[],
  labeled: ReadonlyMap<LabelPass, number>,
): string =>
  table(
    ["pass", "rule", "verdict", "labeled", "coverage", "agreement"],
    rows.map((row) => [
      row.pass,
      row.rule,
      row.verdict,
      String(row.labeled),
      percent(row.labeled / Math.max(1, labeled.get(row.pass) ?? 0)),
      row.verdict === "abstain" || row.labeled === 0 ? "—" : percent(row.correct / row.labeled),
    ]),
  );

/** One rule's tally in one pass, with the base rate it must beat. */
export interface GatePass {
  readonly pass: LabelPass;
  readonly labeled: number;
  readonly correct: number;
  readonly agreement: number;
  readonly base: number;
  readonly lift: number;
  readonly qualifies: boolean;
}

/** One rule's gate result across the passes. */
export interface GateRule {
  readonly rule: string;
  readonly passes: readonly GatePass[];
  readonly qualified: number;
  readonly accepted: boolean;
}

/** The floor a rule must clear in at least two passes. */
export const GATE_MIN_LABELED = 10;
export const GATE_MIN_AGREEMENT = 0.95;
export const GATE_MIN_PASSES = 2;

/**
 * Compute the gate. A pass qualifies when the rule has at least 10 labeled
 * firings, at least 95% agreement, and agreement above the pass base rate (the
 * stand-alone share of every label in that pass). A rule is accepted when at
 * least two passes qualify. The base rate is independent of the rule, so a
 * rule that only fires on the common case cannot pass by matching the base.
 */
export const gateOf = (entries: readonly RuleEntry[]): readonly GateRule[] => {
  const baseByPass = new Map<LabelPass, { labeled: number; stands: number }>();
  const byRule = new Map<string, Map<LabelPass, { labeled: number; correct: number }>>();
  for (const entry of entries) {
    if (entry.truth === undefined) continue;
    const base = baseByPass.get(entry.pass) ?? { labeled: 0, stands: 0 };
    base.labeled += 1;
    if (entry.truth === "stands") base.stands += 1;
    baseByPass.set(entry.pass, base);
    const perRule = byRule.get(entry.rule) ?? new Map();
    const cell = perRule.get(entry.pass) ?? { labeled: 0, correct: 0 };
    cell.labeled += 1;
    if (agrees(entry.verdict, entry.truth)) cell.correct += 1;
    perRule.set(entry.pass, cell);
    byRule.set(entry.rule, perRule);
  }
  const rules: GateRule[] = [];
  for (const [rule, perRule] of byRule) {
    const passes = LABEL_PASSES.map((pass) => {
      const cell = perRule.get(pass) ?? { labeled: 0, correct: 0 };
      const baseCell = baseByPass.get(pass) ?? { labeled: 0, stands: 0 };
      const agreement = cell.labeled === 0 ? 0 : cell.correct / cell.labeled;
      const base = baseCell.labeled === 0 ? 0 : baseCell.stands / baseCell.labeled;
      const lift = agreement - base;
      const qualifies =
        cell.labeled >= GATE_MIN_LABELED && agreement >= GATE_MIN_AGREEMENT && lift > 0;
      return {
        pass,
        labeled: cell.labeled,
        correct: cell.correct,
        agreement,
        base,
        lift,
        qualifies,
      };
    });
    const qualified = passes.filter((pass) => pass.qualifies).length;
    rules.push({ rule, passes, qualified, accepted: qualified >= GATE_MIN_PASSES });
  }
  return rules.sort((left, right) => left.rule.localeCompare(right.rule));
};

/** The set of rules the gate accepts. */
export const gateAccepted = (rules: readonly GateRule[]): ReadonlySet<string> =>
  new Set(rules.filter((rule) => rule.accepted).map((rule) => rule.rule));

/** The gate table: one row per rule and pass, with the base rate and the lift. */
export const formatGate = (rules: readonly GateRule[]): string =>
  table(
    ["rule", "pass", "labeled", "agreement", "base", "lift", "gate"],
    rules.flatMap((rule) =>
      rule.passes.map((pass) => [
        rule.rule,
        pass.pass,
        String(pass.labeled),
        pass.labeled === 0 ? "—" : percent(pass.agreement),
        pass.labeled === 0 ? "—" : percent(pass.base),
        pass.labeled === 0 ? "—" : signedPercent(pass.lift),
        pass.qualifies ? "PASS" : "fail",
      ]),
    ),
  );

/** True when the two rule sets hold the same names. */
export const sameRuleSet = (left: ReadonlySet<string>, right: ReadonlySet<string>): boolean =>
  left.size === right.size && [...left].every((value) => right.has(value));

/** The gated case-level effect: how many cases need no model call at all. */
export interface CaseRuleSummary {
  readonly cases: number;
  readonly fullyDecided: number;
  readonly mixed: number;
  readonly allAbstain: number;
  readonly questions: number;
  readonly decided: number;
}

/** True when the product policy handles a question without a model call. */
const isHandled = (entry: RuleEntry, accepted: ReadonlySet<string>): boolean =>
  accepted.has(entry.rule) && entry.verdict !== "abstain";

/**
 * Count the gated case-level effect. A case needs no model call when every
 * question is handled by an accepted rule. A mixed case still calls the
 * classifier for the questions the rules left alone.
 */
export const summarizeCases = (
  entries: readonly RuleEntry[],
  accepted: ReadonlySet<string>,
): CaseRuleSummary => {
  const byCase = new Map<string, RuleEntry[]>();
  for (const entry of entries) {
    // The synthetic fixture measures a declared row; it is never counted as a
    // real session.
    if (entry.synthetic === true) continue;
    const list = byCase.get(entry.caseId);
    if (list === undefined) byCase.set(entry.caseId, [entry]);
    else list.push(entry);
  }
  let fullyDecided = 0;
  let mixed = 0;
  let allAbstain = 0;
  let questions = 0;
  let decided = 0;
  for (const list of byCase.values()) {
    questions += list.length;
    const decidedHere = list.filter((entry) => isHandled(entry, accepted)).length;
    decided += decidedHere;
    if (decidedHere === list.length) fullyDecided += 1;
    else if (decidedHere === 0) allAbstain += 1;
    else mixed += 1;
  }
  return { cases: byCase.size, fullyDecided, mixed, allAbstain, questions, decided };
};

/** The gated case-level line: how many cases need no model call at all. */
export const formatCases = (summary: CaseRuleSummary): string =>
  `${summary.cases} cases — ${summary.fullyDecided} need no model call (${percent(
    summary.fullyDecided / Math.max(1, summary.cases),
  )}), ${summary.mixed} call for part of the frontier, ${summary.allAbstain} call for the whole frontier; ${summary.decided}/${summary.questions} questions handled by a rule`;

interface Options {
  readonly out: string;
  /** Add the checked-in synthetic fixture to the production replay. */
  readonly fixture: boolean;
}

const usage = `rules.ts [--out <dir>] [--fixture]

  --out      corpus directory (default: evals/data)
  --fixture  add the checked-in synthetic fixture to the production replay`;

const parseOptions = (argv: readonly string[]): Options => {
  const values = new Map<string, string>();
  let fixture = false;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]!;
    if (flag === "--fixture") {
      fixture = true;
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
  return { out: values.get("out") ?? join(HERE, "data"), fixture };
};

/** Read the corpus into the maps the two replays share. */
export const readCorpus = (out: string) => {
  const cases = readJsonl<StoredCase>(join(out, "cases.jsonl"));
  const evidence = new Map(
    readJsonl<StoredEvidence>(join(out, "evidence.jsonl")).map((entry) => [entry.caseId, entry]),
  );
  const labels = new Map<string, StoredLabel>();
  for (const row of readJsonl<{
    readonly caseId: string;
    readonly key: string;
    readonly label: string;
    readonly at: string;
  }>(join(out, "labels.jsonl"))) {
    labels.set(`${row.caseId}\u0000${row.key}`, { label: row.label, at: row.at });
  }
  const verdicts = readJsonl<StoredVerdict>(join(out, "verdicts.jsonl"));
  return { cases, evidence, labels, verdicts };
};

const main = (): void => {
  const options = parseOptions(process.argv.slice(2));
  const real = readCorpus(options.out);
  const frozen = frozenEntries(real.cases, real.evidence, real.labels);
  // The synthetic fixture adds declared-row coverage to the production replay
  // only. The frozen parity runs on the real corpus, which has no declarations.
  const fixture = options.fixture
    ? syntheticCorpus()
    : {
        cases: [],
        evidence: new Map<string, StoredEvidence>(),
        labels: new Map<string, StoredLabel>(),
      };
  const productionCases = [...real.cases, ...fixture.cases];
  const productionEvidence = new Map([...real.evidence, ...fixture.evidence]);
  const productionLabels = new Map([...real.labels, ...fixture.labels]);
  const production = productionEntries(productionCases, productionEvidence, productionLabels);
  const labeled = frozen.entries.filter((entry) => entry.truth !== undefined).length;
  console.log(
    `corpus: ${real.cases.length} cases, ${frozen.entries.length} questions, ${labeled} labeled`,
  );
  if (options.fixture) {
    console.log(`synthetic fixture: ${fixture.cases.length} case(s), not counted as real sessions`);
  }
  if (frozen.droppedLabels > 0) {
    console.log(`dropped labels: ${frozen.droppedLabels} (unknown spelling)`);
    process.exitCode = 1;
  }
  console.log(`\naccepted rules: ${[...ACCEPTED_RULES].sort().join(", ") || "(none)"}`);

  console.log("\nFrozen replay — the pre-revert facts and the full evidence record:\n");
  console.log(formatRules(summarizeRules(frozen.entries), labeledByPass(frozen.entries)));
  const mismatches = checkParity(frozen.entries, real.verdicts);
  console.log(
    `\nfrozen parity: ${frozen.entries.length} candidates against verdicts.jsonl — ${
      mismatches.length === 0 ? "exact" : `${mismatches.length} MISMATCHES`
    }`,
  );
  for (const mismatch of mismatches.slice(0, 10)) {
    console.log(
      `  ${mismatch.caseId} ${mismatch.questionKey}: expected ${mismatch.expectedRule}/${mismatch.expectedVerdict}, got ${mismatch.actualRule}/${mismatch.actualVerdict}`,
    );
  }
  if (mismatches.length > 0) process.exitCode = 1;

  console.log("\nProduction replay — the batch texts plus the tool footprint:\n");
  console.log(formatRules(summarizeRules(production.entries), labeledByPass(production.entries)));
  console.log(
    `\nThe rule gate (>=${GATE_MIN_LABELED} labeled, >=${GATE_MIN_AGREEMENT * 100}% agreement, above the pass base rate, in >=${GATE_MIN_PASSES} passes):`,
  );
  const gate = gateOf(production.entries);
  console.log(formatGate(gate));
  const measured = gateAccepted(gate);
  const match = sameRuleSet(measured, ACCEPTED_RULES);
  console.log(
    `\nACCEPTED_RULES: ${[...ACCEPTED_RULES].sort().join(", ")} — ${
      match ? "MATCH" : `MISMATCH (measured: ${[...measured].sort().join(", ") || "(none)"})`
    }`,
  );
  if (!match) process.exitCode = 1;

  console.log("\nThe gated case-level effect (accepted rules only):");
  console.log(formatCases(summarizeCases(production.entries, ACCEPTED_RULES)));
};

if (import.meta.main) main();
