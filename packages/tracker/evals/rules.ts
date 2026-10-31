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
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
import type { CaseFacts } from "./facts.ts";
import { syntheticCorpus } from "./fixture.ts";
import { LABEL_PASSES, passOfRecord, type LabelPass } from "./pass.ts";

const HERE = import.meta.dir;

/** A label as stored, before canonicalization. */
export interface StoredLabel {
  readonly label: string;
  readonly at: string;
  /** The explicit pass a declared-corpus record carries. */
  readonly pass?: string;
  /** A blind pilot seed never enters a pass measurement. */
  readonly pilot?: boolean;
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
  /** Where the facts came from, on the declared corpus. */
  readonly source?: "live" | "replayed" | "mismatch" | "unresolved";
  /** True for a non-head candidate: never gated. */
  readonly diagnostic?: boolean;
  /** True when the case's head carries no declaration: the base-rate subset. */
  readonly control?: boolean;
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
  frozen?: ReadonlyMap<string, CaseFacts>,
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
    const storedFacts = frozen?.get(stored.caseId);
    for (const [index, candidate] of stored.candidates.entries()) {
      const labeled = caseLabels[index];
      const canonical = labeled === undefined ? undefined : canonicalLabel(labeled.label);
      if (labeled !== undefined && canonical === undefined) droppedLabels += 1;
      // The live decision record, when the pointer candidate declared
      // something, is the raw row. The other candidates have no record, so the
      // corpus facts route them as before.
      const recorded = index === 0 ? stored.decision : undefined;
      const candidateFacts =
        index === 0 ? storedFacts?.head : storedFacts?.diagnostics[index - 1];
      const facts = factsOf(stored, record, candidate.text);
      const decision: { readonly rule: string; readonly verdict: RuleVerdict } =
        candidateFacts !== undefined
          ? { rule: candidateFacts.row, verdict: candidateFacts.verdict }
          : recorded === undefined
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
        pass: passOfRecord({ at: labeled?.at ?? firstLabelAt ?? stored.at, ...(labeled?.pass === undefined ? {} : { pass: labeled.pass }) }),
        rule: decision.rule,
        verdict: decision.verdict,
        truth: labeled?.pilot === true ? undefined : canonical,
        ...(stored.synthetic === true ? { synthetic: true } : {}),
        ...(storedFacts === undefined
          ? {}
          : {
              source: storedFacts.source,
              control: !storedFacts.declaredHead,
              ...(index > 0 ? { diagnostic: true } : {}),
            }),
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
  facts?: ReadonlyMap<string, CaseFacts>,
): RuleReplay => replay(cases, evidence, labels, productionFactsOf, facts);

/** One candidate whose replayed row or verdict differs from `verdicts.jsonl`. */
export interface ParityMismatch {
  readonly caseId: string;
  readonly questionKey: string;
  readonly expectedRule: string;
  readonly expectedVerdict: RuleVerdict;
  readonly actualRule: string;
  readonly actualVerdict: RuleVerdict;
}

/** The frozen-parity result: mismatches among the judged, plus the unjudged count. */
export interface ParityReport {
  readonly mismatches: readonly ParityMismatch[];
  /**
   * Candidates with no `verdicts.jsonl` row: a harvest after the frozen
   * corpus. They carry no rename proof, and they never count as mismatches.
   */
  readonly unjudged: number;
}

/** Join the frozen replay to `verdicts.jsonl` by case id and question key. */
export const checkParity = (
  entries: readonly RuleEntry[],
  verdicts: readonly StoredVerdict[],
): ParityReport => {
  const byKey = new Map(verdicts.map((row) => [`${row.caseId}\u0000${row.key}`, row]));
  const mismatches: ParityMismatch[] = [];
  let unjudged = 0;
  for (const entry of entries) {
    const frozen = byKey.get(`${entry.caseId}\u0000${entry.questionKey}`);
    if (frozen === undefined) {
      unjudged += 1;
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
  return { mismatches, unjudged };
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
  const order = new Map<string, number>(LABEL_PASSES.map((pass, index) => [pass, index]));
  const rank = (pass: string): number => order.get(pass) ?? LABEL_PASSES.length;
  return [...byKey.values()].sort(
    (left, right) =>
      rank(left.pass) - rank(right.pass) ||
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
  /** Control labels behind the base rate. */
  readonly baseLabeled: number;
  readonly lift: number;
  /** True below 30 controls: the lift is advisory, not gating. */
  readonly advisory: boolean;
  readonly qualifies: boolean;
}

/** One rule's gate result across the passes. */
export interface GateRule {
  readonly rule: string;
  readonly verdict: RuleVerdict;
  readonly passes: readonly GatePass[];
  readonly qualified: number;
  readonly accepted: boolean;
}

/** The floor a rule must clear in at least two passes. */
export const GATE_MIN_LABELED = 10;
export const GATE_MIN_AGREEMENT = 0.95;
export const GATE_MIN_PASSES = 2;

/**
 * Compute the gate over the passes the caller supplies. A pass qualifies when
 * the rule has at least 10 labeled firings, at least 95% agreement, and
 * agreement above that pass's base rate. The base rate comes from the control
 * subset when the entries carry a control flag; the old corpus has none, so it
 * keeps the all-label base. A rule is accepted when at least two passes
 * qualify. A diagnostic entry never counts.
 */
export const gateOf = (
  entries: readonly RuleEntry[],
  passes: readonly LabelPass[] = LABEL_PASSES,
  declaredRows: readonly { readonly row: string; readonly verdict: RuleVerdict }[] = [],
): readonly GateRule[] => {
  const controlled = entries.some((entry) => entry.control !== undefined);
  const baseByPass = new Map<LabelPass, { labeled: number; stands: number }>();
  const byRule = new Map<string, Map<LabelPass, { labeled: number; correct: number }>>();
  const verdictOf = new Map<string, RuleVerdict>();
  for (const entry of entries) {
    if (entry.diagnostic === true) continue;
    verdictOf.set(entry.rule, entry.verdict);
    if (entry.truth !== undefined && (!controlled || entry.control === true)) {
      const base = baseByPass.get(entry.pass) ?? { labeled: 0, stands: 0 };
      base.labeled += 1;
      if (entry.truth === "stands") base.stands += 1;
      baseByPass.set(entry.pass, base);
    }
    if (entry.truth === undefined) continue;
    const perRule = byRule.get(entry.rule) ?? new Map();
    const cell = perRule.get(entry.pass) ?? { labeled: 0, correct: 0 };
    cell.labeled += 1;
    if (agrees(entry.verdict, entry.truth)) cell.correct += 1;
    perRule.set(entry.pass, cell);
    byRule.set(entry.rule, perRule);
  }
  for (const row of declaredRows) {
    if (!verdictOf.has(row.row)) verdictOf.set(row.row, row.verdict);
    if (!byRule.has(row.row)) byRule.set(row.row, new Map());
  }
  const rules: GateRule[] = [];
  for (const [rule, perRule] of byRule) {
    const cells = passes.map((pass) => {
      const cell = perRule.get(pass) ?? { labeled: 0, correct: 0 };
      const baseCell = baseByPass.get(pass) ?? { labeled: 0, stands: 0 };
      const agreement = cell.labeled === 0 ? 0 : cell.correct / cell.labeled;
      const base = baseCell.labeled === 0 ? 0 : baseCell.stands / baseCell.labeled;
      const lift = agreement - base;
      const advisory = controlled && baseCell.labeled < 30;
      const qualifies =
        cell.labeled >= GATE_MIN_LABELED && agreement >= GATE_MIN_AGREEMENT && lift > 0;
      return {
        pass,
        labeled: cell.labeled,
        correct: cell.correct,
        agreement,
        base,
        baseLabeled: baseCell.labeled,
        lift,
        advisory,
        qualifies,
      };
    });
    const qualified = cells.filter((cell) => cell.qualifies).length;
    rules.push({
      rule,
      verdict: verdictOf.get(rule) ?? "abstain",
      passes: cells,
      qualified,
      accepted: qualified >= GATE_MIN_PASSES,
    });
  }
  return rules.sort((left, right) => left.rule.localeCompare(right.rule));
};

/** The set of rules the gate accepts. */
export const gateAccepted = (rules: readonly GateRule[]): ReadonlySet<string> =>
  new Set(rules.filter((rule) => rule.accepted).map((rule) => rule.rule));

/** The accepted rows that can change behavior: an abstain row is never promotable. */
export const promotableAccepted = (rules: readonly GateRule[]): ReadonlySet<string> =>
  new Set(
    rules.filter((rule) => rule.accepted && rule.verdict !== "abstain").map((rule) => rule.rule),
  );

/** Where the base rate comes from: the control subset or the whole label set. */
export const gateBase = (entries: readonly RuleEntry[]): "controls" | "labels" =>
  entries.some((entry) => entry.control !== undefined) ? "controls" : "labels";

/** Passes present in the records but absent from the corpus' pass list. */
export const unlistedPasses = (
  entries: readonly RuleEntry[],
  passes: readonly LabelPass[],
): readonly string[] => [
  ...new Set(entries.map((entry) => entry.pass).filter((pass) => !passes.includes(pass))),
].sort();

/** The passes that carry at least one label. */
export const labeledPasses = (entries: readonly RuleEntry[]): readonly string[] => [
  ...new Set(entries.filter((entry) => entry.truth !== undefined).map((entry) => entry.pass)),
].sort();

/** The gate table: one row per rule and pass, with the base rate and the lift. */
export const formatGate = (rules: readonly GateRule[]): string =>
  table(
    ["rule", "verdict", "pass", "labeled", "agreement", "base", "lift", "gate"],
    rules.flatMap((rule) =>
      rule.passes.map((pass) => [
        rule.rule,
        rule.verdict,
        pass.pass,
        String(pass.labeled),
        pass.labeled === 0 ? "—" : percent(pass.agreement),
        pass.labeled === 0 ? "—" : pass.advisory ? `thin (${pass.baseLabeled})` : percent(pass.base),
        pass.labeled === 0
          ? "—"
          : `${signedPercent(pass.lift)}${pass.advisory ? " advisory" : ""}`,
        rule.verdict === "abstain"
          ? "reported, not promotable"
          : pass.qualifies
            ? "PASS"
            : "fail",
      ]),
    ),
  );

/** The soft report when no pass carries a label. */
export const formatUnmeasured = (
  rows: readonly { readonly row: string; readonly verdict: RuleVerdict }[],
): string =>
  table(
    ["rule", "verdict", "state"],
    [...rows]
      .sort((left, right) => left.row.localeCompare(right.row))
      .map((row) => [row.row, row.verdict, "unmeasured"]),
  );

/**
 * The frozen old floor. The old corpus measured these two rows; the declared
 * corpus never did, so a promotion keeps them and checks only that it did not
 * drop them.
 */
export const OLD_FLOOR: ReadonlySet<string> = new Set([
  "names-batch-output",
  "no-visible-link",
]);

/** The old corpus' superset check: the floor is kept, the rest is unmeasured here. */
export const formatFloor = (
  accepted: ReadonlySet<string>,
  floor: ReadonlySet<string>,
): string => {
  const missing = [...floor].filter((rule) => !accepted.has(rule)).sort();
  const unmeasured = [...accepted].filter((rule) => !floor.has(rule)).sort();
  return [
    `${missing.length === 0 ? "still accepted" : "MISSING"}: ${[...floor].sort().join(", ")}`,
    `not measured by this corpus: ${unmeasured.join(", ") || "(none)"}`,
  ].join("\n");
};

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
  /** Also write gate.json to this directory. */
  readonly evidence?: string;
}

const usage = `rules.ts [--out <dir>] [--fixture] [--evidence <dir>]

  --out       corpus directory (default: evals/data)
  --fixture   add the checked-in synthetic fixture to the production replay
  --evidence  also write gate.json to <dir>`;

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
  return {
    out: values.get("out") ?? join(HERE, "data"),
    fixture,
    ...(values.get("evidence") === undefined ? {} : { evidence: values.get("evidence") }),
  };
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
    readonly pass?: string;
    readonly pilot?: boolean;
  }>(join(out, "labels.jsonl"))) {
    labels.set(`${row.caseId}\u0000${row.key}`, {
      label: row.label,
      at: row.at,
      ...(row.pass === undefined ? {} : { pass: row.pass }),
      ...(row.pilot === true ? { pilot: true } : {}),
    });
  }
  const verdicts = readJsonl<StoredVerdict>(join(out, "verdicts.jsonl"));
  return { cases, evidence, labels, verdicts };
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

/** The sample's pass list, or undefined when the directory has no sample. */
const samplePasses = (out: string): readonly string[] | undefined => {
  try {
    const sample = JSON.parse(readFileSync(join(out, "sample.json"), "utf8")) as {
      passes?: Record<string, unknown>;
    };
    return sample.passes === undefined ? undefined : Object.keys(sample.passes);
  } catch {
    return undefined;
  }
};

/** The frozen facts, keyed by case. */
const readFacts = (out: string): ReadonlyMap<string, CaseFacts> =>
  new Map(readJsonl<CaseFacts>(join(out, "facts.jsonl")).map((entry) => [entry.caseId, entry]));

/** One declared row from the frozen facts. */
const declaredRowsOf = (
  facts: ReadonlyMap<string, CaseFacts>,
): readonly { readonly row: string; readonly verdict: RuleVerdict }[] => {
  const rows = new Map<string, RuleVerdict>();
  for (const entry of facts.values()) {
    if (!entry.promotable || !entry.declaredHead) continue;
    rows.set(entry.head.row, entry.head.verdict);
  }
  return [...rows.entries()].map(([row, verdict]) => ({ row, verdict }));
};

const sourceCounts = (facts: ReadonlyMap<string, CaseFacts>): Readonly<Record<string, number>> => {
  const totals: Record<string, number> = { live: 0, replayed: 0, mismatch: 0, unresolved: 0 };
  for (const entry of facts.values()) totals[entry.source] = (totals[entry.source] ?? 0) + 1;
  return totals;
};

const writeGate = (
  evidence: string,
  gate: readonly GateRule[],
  body: Record<string, unknown>,
): void => {
  mkdirSync(evidence, { recursive: true });
  writeFileSync(join(evidence, "gate.json"), `${JSON.stringify({ rows: gate, ...body }, null, 2)}\n`);
};

/** The declared corpus: frozen facts, explicit passes, the control base rate. */
const declaredReport = (options: Options, format: string | undefined): number => {
  const real = readCorpus(options.out);
  const facts = readFacts(options.out);
  const entries = productionEntries(real.cases, real.evidence, real.labels, facts).entries;
  const fromSample = samplePasses(options.out);
  const passes = fromSample ?? [
    ...new Set(entries.filter((entry) => entry.truth !== undefined).map((entry) => entry.pass)),
  ];
  const declaredRows = declaredRowsOf(facts);
  const sources = sourceCounts(facts);
  const labeled = entries.filter((entry) => entry.truth !== undefined).length;
  const passLabel = fromSample === undefined ? "from records (no sample)" : passes.join(", ");

  console.log(`corpus: ${real.cases.length} cases, ${entries.length} questions, ${labeled} labeled`);
  console.log(`format: ${format ?? "unknown"}`);
  console.log(`passes: ${passLabel}`);
  console.log(`sources: live ${sources.live}, replayed ${sources.replayed}, mismatch ${sources.mismatch}, unresolved ${sources.unresolved}`);
  console.log(`base: ${gateBase(entries)}`);

  const labeledList = [...new Set(entries.filter((entry) => entry.truth !== undefined).map((entry) => entry.pass))];
  if (labeledList.length === 0) {
    console.log("");
    console.log(formatUnmeasured(declaredRows));
    if (options.evidence !== undefined) {
      writeGate(options.evidence, [], {
        corpus: format,
        passes: { list: passes, source: passLabel },
        base: gateBase(entries),
        accepted: [],
        promotion: [...OLD_FLOOR].sort(),
        unmeasured: declaredRows.map((row) => row.row),
        sources,
      });
    }
    console.log("\nno pass carries a label; nothing to compare.");
    return 0;
  }

  for (const pass of unlistedPasses(entries, passes)) {
    console.log(`${pass}: not in this corpus`);
  }
  const gate = gateOf(entries, passes, declaredRows);
  console.log("");
  console.log(formatGate(gate));
  const measured = promotableAccepted(gate);
  const promotion = new Set([...OLD_FLOOR, ...measured]);
  const unmeasured = declaredRows
    .filter((row) => !gate.some((rule) => rule.rule === row.row && rule.passes.some((pass) => pass.labeled > 0)))
    .map((row) => row.row);
  if (options.evidence !== undefined) {
    writeGate(options.evidence, gate, {
      corpus: format,
      passes: { list: passes, source: passLabel },
      base: gateBase(entries),
      accepted: [...measured].sort(),
      promotion: [...promotion].sort(),
      unmeasured,
      sources,
    });
  }

  console.log("\nThe gated case-level effect (accepted rules only):");
  console.log(formatCases(summarizeCases(entries, ACCEPTED_RULES)));

  if (labeledList.length < 2) {
    console.log(
      `\n${labeledList.length} pass carries labels; a rule needs two. No ACCEPTED_RULES comparison.`,
    );
    return 0;
  }
  const match = sameRuleSet(ACCEPTED_RULES, promotion);
  console.log(
    `\nACCEPTED_RULES: ${[...ACCEPTED_RULES].sort().join(", ")} — ${
      match
        ? "MATCH"
        : `MISMATCH (promotion: ${[...promotion].sort().join(", ") || "(none)"})`
    }`,
  );
  return match ? 0 : 1;
};

/** The old corpus: the rename proof, the production gate, and the floor check. */
const oldReport = (options: Options): void => {
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
  const parity = checkParity(frozen.entries, real.verdicts);
  const judged = frozen.entries.length - parity.unjudged;
  console.log(
    `\nfrozen parity: ${judged} candidates against verdicts.jsonl — ${
      parity.mismatches.length === 0 ? "exact" : `${parity.mismatches.length} MISMATCHES`
    }${parity.unjudged === 0 ? "" : ` (${parity.unjudged} new candidates without a frozen verdict)`}`,
  );
  for (const mismatch of parity.mismatches.slice(0, 10)) {
    console.log(
      `  ${mismatch.caseId} ${mismatch.questionKey}: expected ${mismatch.expectedRule}/${mismatch.expectedVerdict}, got ${mismatch.actualRule}/${mismatch.actualVerdict}`,
    );
  }
  if (parity.mismatches.length > 0) process.exitCode = 1;

  console.log("\nProduction replay — the batch texts plus the tool footprint:\n");
  console.log(formatRules(summarizeRules(production.entries), labeledByPass(production.entries)));
  console.log(
    `\nThe rule gate (>=${GATE_MIN_LABELED} labeled, >=${GATE_MIN_AGREEMENT * 100}% agreement, above the pass base rate, in >=${GATE_MIN_PASSES} passes):`,
  );
  const gate = gateOf(production.entries);
  console.log(formatGate(gate));
  const measured = gateAccepted(gate);
  console.log(`\n${formatFloor(ACCEPTED_RULES, OLD_FLOOR)}`);
  if ([...OLD_FLOOR].some((rule) => !ACCEPTED_RULES.has(rule))) {
    process.exitCode = 1;
  }
  if (!sameRuleSet(measured, new Set()) && [...measured].some((rule) => !OLD_FLOOR.has(rule))) {
    console.log(
      `measured here but absent from ACCEPTED_RULES: ${[...measured]
        .filter((rule) => !ACCEPTED_RULES.has(rule))
        .sort()
        .join(", ")}`,
    );
  }

  console.log("\nThe gated case-level effect (accepted rules only):");
  console.log(formatCases(summarizeCases(production.entries, ACCEPTED_RULES)));
};

const main = (): void => {
  const options = parseOptions(process.argv.slice(2));
  const format = corpusFormat(options.out);
  if (format === "declared") {
    process.exitCode = declaredReport(options, format);
    return;
  }
  oldReport(options);
};

if (import.meta.main) main();
