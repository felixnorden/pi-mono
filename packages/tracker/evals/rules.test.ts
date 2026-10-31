import { assert, it } from "@effect/vitest";
import { fileURLToPath } from "node:url";
import { productionFacts, type RecordText } from "../src/compaction/observations.ts";
import { ACCEPTED_RULES, type RuleVerdict } from "../src/compaction/rules.ts";
import type { StoredCase } from "./case-file.ts";
import { syntheticCorpus } from "./fixture.ts";
import {
  checkParity,
  footprintOf,
  frozenEntries,
  gateAccepted,
  gateBase,
  gateOf,
  OLD_FLOOR,
  promotableAccepted,
  formatFloor,
  formatGate,
  formatUnmeasured,
  unlistedPasses,
  productionEntries,
  readCorpus,
  sameRuleSet,
  summarizeCases,
  summarizeRules,
  type RuleEntry,
  type StoredVerdict,
} from "./rules.ts";

const DATA = fileURLToPath(new URL("data", import.meta.url));

/** One minimal corpus case with a single candidate and question. */
const caseOf = (overrides: Partial<StoredCase> = {}): StoredCase => ({
  caseId: "case#0",
  session: { dir: "sessions", file: "case.jsonl" },
  at: "2026-01-01T00:00:00.000Z",
  index: 0,
  list: { id: 1, name: "Work", items: [] },
  completed: [{ ref: "Work:1", text: "done" }],
  candidates: [
    { ref: "Work:2", text: "candidate", class: "ready-queue", relationship: "independent" },
  ],
  questions: [{ key: "q.0", instructions: "", criteria: {} }],
  frontier: 1,
  itemCount: 2,
  openCount: 1,
  doneCount: 1,
  declaredDeps: 0,
  ...overrides,
});

it("the frozen replay reproduces the pre-revert verdict for every candidate", () => {
  const { cases, evidence, labels, verdicts } = readCorpus(DATA);
  const replay = frozenEntries(cases, evidence, labels);
  const report = checkParity(replay.entries, verdicts);
  assert.deepStrictEqual(report.mismatches, []);
});

it("a new candidate without a frozen verdict is reported, not failed", () => {
  const entry = (caseId: string): RuleEntry => ({
    caseId,
    questionKey: "q",
    pass: "pass1",
    rule: "no-visible-link",
    verdict: "compact",
    truth: undefined,
  });
  const verdict: StoredVerdict = {
    caseId: "old",
    key: "q",
    rule: "compact",
    ruleReason: "no document and no plan in play",
    verdict: "compact",
  };
  const report = checkParity([entry("old"), entry("new")], [verdict]);
  assert.deepStrictEqual(report.mismatches, []);
  assert.strictEqual(report.unjudged, 1);
});

it("the production replay projects only product-visible facts", () => {
  const record: RecordText[] = [
    { kind: "assistant", text: "we will touch src/prose-only.ts" },
    { kind: "tool-call", name: "write", text: "{}", args: { path: "src/written.ts" } },
  ];
  const facts = productionFacts(
    ["batch item"],
    footprintOf(record),
    "candidate names src/written.ts",
  );
  assert.include(facts.knownText, "src/written.ts");
  assert.include(facts.producedText, "src/written.ts");
  assert.notInclude(facts.knownText, "src/prose-only.ts");
  assert.notInclude(facts.producedText, "src/prose-only.ts");
});

it("a command never marks a path produced", () => {
  const record: RecordText[] = [
    { kind: "tool-call", name: "bash", text: "{}", args: { command: "touch out.md" } },
  ];
  const facts = productionFacts([], footprintOf(record), "candidate names out.md");
  assert.strictEqual(facts.producedText, "");
  assert.include(facts.knownText, "touch out.md");
});

it("the production replay counts a completed item's description as batch text", () => {
  const stored = caseOf({
    completed: [{ ref: "Work:1", text: "done", description: "touched src/written.ts" }],
    candidates: [
      {
        ref: "Work:2",
        text: "read src/written.ts",
        class: "ready-queue",
        relationship: "independent",
      },
    ],
  });
  const { entries } = productionEntries([stored], new Map(), new Map());
  assert.strictEqual(entries.length, 1);
  assert.strictEqual(entries[0]!.rule, "no-visible-link");
});

it("the production gate accepts exactly the measured rule set", () => {
  const { cases, evidence, labels } = readCorpus(DATA);
  const measured = gateAccepted(gateOf(productionEntries(cases, evidence, labels).entries));
  assert.isTrue(
    sameRuleSet(measured, ACCEPTED_RULES),
    `measured: ${[...measured].sort().join(", ") || "(none)"}`,
  );
  assert.isFalse(sameRuleSet(new Set([...measured, "injected-row"]), measured));
  assert.isTrue(sameRuleSet(new Set(), new Set()));
});

it("an unknown label spelling is dropped, not guessed", () => {
  const labels = new Map([["case#0\u0000q.0", { label: "maybe", at: "2026-01-01T00:00:00.000Z" }]]);
  const replay = frozenEntries([caseOf()], new Map(), labels);
  assert.strictEqual(replay.droppedLabels, 1);
  assert.isUndefined(replay.entries[0]!.truth);
});

it("the case summary counts a case as fully decided only when every question is handled", () => {
  const entry = (caseId: string, rule: string, verdict: RuleVerdict): RuleEntry => ({
    caseId,
    questionKey: "q",
    pass: "pass1",
    rule,
    verdict,
    truth: undefined,
  });
  const summary = summarizeCases(
    [
      entry("a", "no-visible-link", "compact"),
      entry("a", "no-visible-link", "compact"),
      entry("b", "no-visible-link", "compact"),
      entry("b", "names-unknown-path", "keep"),
    ],
    new Set(["no-visible-link"]),
  );
  assert.strictEqual(summary.cases, 2);
  assert.strictEqual(summary.fullyDecided, 1);
  assert.strictEqual(summary.mixed, 1);
  assert.strictEqual(summary.allAbstain, 0);
});

// ---------------------------------------------------------------------------
// Slice 7: the decision record and the synthetic fixture
// ---------------------------------------------------------------------------

it("the harvest reads the decision entry into the case", () => {
  const { cases, evidence } = syntheticCorpus();
  assert.strictEqual(cases.length, 1);
  const stored = cases[0]!;
  assert.strictEqual(stored.synthetic, true);
  assert.strictEqual(stored.decision?.rule, "reference-is-readable");
  assert.deepStrictEqual(stored.decision?.references, [
    { kind: "path", path: "src/a.ts", state: "readable" },
  ]);
  assert.notInclude(JSON.stringify(stored), "transcript");
  assert.strictEqual(evidence.get(stored.caseId)?.caseId, stored.caseId);
});

it("the report counts a declared-row firing once and never as a real session", () => {
  const synthetic = syntheticCorpus();
  const production = productionEntries(synthetic.cases, synthetic.evidence, synthetic.labels);
  assert.strictEqual(production.entries.length, 1);
  const entry = production.entries[0]!;
  assert.strictEqual(entry.rule, "reference-is-readable");
  assert.strictEqual(entry.verdict, "compact");
  assert.strictEqual(entry.truth, "stands");
  assert.strictEqual(entry.synthetic, true);
  const rows = summarizeRules(production.entries).filter(
    (row) => row.rule === "reference-is-readable",
  );
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0]!.labeled, 1);
  // The synthetic case is not counted as a real session.
  assert.strictEqual(summarizeCases(production.entries, ACCEPTED_RULES).cases, 0);
});

// ---------------------------------------------------------------------------
// The declared-corpus gate
// ---------------------------------------------------------------------------

const gateEntry = (input: {
  readonly caseId?: string;
  readonly pass?: string;
  readonly rule?: string;
  readonly verdict?: RuleVerdict;
  readonly truth?: "needs" | "stands";
  readonly control?: boolean;
  readonly diagnostic?: boolean;
}): RuleEntry => ({
  caseId: input.caseId ?? "case",
  questionKey: "q",
  pass: input.pass ?? "v2-a",
  rule: input.rule ?? "reference-is-readable",
  verdict: input.verdict ?? "compact",
  truth: input.truth,
  ...(input.control === undefined ? {} : { control: input.control }),
  ...(input.diagnostic === undefined ? {} : { diagnostic: input.diagnostic }),
});

it("groups by the record's pass, not the timestamp", () => {
  const entries = [
    gateEntry({ caseId: "a", pass: "v2-a", truth: "stands" }),
    gateEntry({ caseId: "b", pass: "v2-b", truth: "stands" }),
  ];
  const gate = gateOf(entries, ["v2-a", "v2-b"]);
  assert.strictEqual(gate[0]!.passes.length, 2);
});

it("names a pass outside the corpus' list", () => {
  const entries = [gateEntry({ pass: "pass1", truth: "stands" })];
  assert.deepStrictEqual(unlistedPasses(entries, ["v2-a", "v2-b"]), ["pass1"]);
});

it("takes the base rate from the controls", () => {
  const entries = [
    ...Array.from({ length: 10 }, (_, index) =>
      gateEntry({ caseId: `d-${index}`, truth: "stands", control: false }),
    ),
    ...Array.from({ length: 10 }, (_, index) =>
      gateEntry({
        caseId: `c-${index}`,
        rule: "no-visible-link",
        truth: index % 2 === 0 ? "stands" : "needs",
        control: true,
      }),
    ),
  ];
  const gate = gateOf(entries, ["v2-a", "v2-b"]);
  const row = gate.find((rule) => rule.rule === "reference-is-readable")!;
  assert.strictEqual(row.passes[0]!.base, 0.5);
  assert.strictEqual(gateBase(entries), "controls");
});

it("marks a thin control set advisory", () => {
  const entries = [
    gateEntry({ truth: "stands" }),
    ...Array.from({ length: 12 }, (_, index) =>
      gateEntry({ caseId: `c-${index}`, rule: "no-visible-link", truth: "stands", control: true }),
    ),
  ];
  const text = formatGate(gateOf(entries, ["v2-a", "v2-b"]));
  assert.match(text, /thin \(12\)/);
  assert.match(text, /advisory/);
});

it("never accepts a rule on one pass", () => {
  const entries = Array.from({ length: 20 }, (_, index) =>
    gateEntry({ caseId: `c-${index}`, pass: "v2-a", truth: "stands" }),
  );
  const gate = gateOf(entries, ["v2-a", "v2-b"]);
  assert.strictEqual(gate[0]!.accepted, false);
});

it("accepts a rule that clears both passes", () => {
  const entries = [
    ...Array.from({ length: 10 }, (_, index) =>
      gateEntry({ caseId: `a-${index}`, pass: "v2-a", truth: "stands" }),
    ),
    ...Array.from({ length: 10 }, (_, index) =>
      gateEntry({ caseId: `b-${index}`, pass: "v2-b", truth: "stands" }),
    ),
    ...Array.from({ length: 20 }, (_, index) =>
      gateEntry({
        caseId: `c-${index}`,
        rule: "no-visible-link",
        truth: index % 4 === 0 ? "stands" : "needs",
        control: true,
      }),
    ),
  ];
  const gate = gateOf(entries, ["v2-a", "v2-b"]);
  assert.strictEqual(gate.find((rule) => rule.rule === "reference-is-readable")!.accepted, true);
});

it("reports an abstain row and never promotes it", () => {
  const entries = [
    ...Array.from({ length: 30 }, (_, index) =>
      gateEntry({
        caseId: `a-${index}`,
        pass: "v2-a",
        rule: "declarations-unresolved",
        verdict: "abstain",
        truth: "stands",
      }),
    ),
    ...Array.from({ length: 30 }, (_, index) =>
      gateEntry({
        caseId: `b-${index}`,
        pass: "v2-b",
        rule: "declarations-unresolved",
        verdict: "abstain",
        truth: "stands",
      }),
    ),
  ];
  const gate = gateOf(entries, ["v2-a", "v2-b"]);
  assert.match(formatGate(gate), /reported, not promotable/);
  assert.strictEqual(promotableAccepted(gate).has("declarations-unresolved"), false);
});

it("prints every declared row unmeasured with zero labeled passes", () => {
  const text = formatUnmeasured([
    { row: "reference-is-readable", verdict: "compact" },
    { row: "product-is-unwritten-plan", verdict: "keep" },
  ]);
  assert.match(text, /reference-is-readable/);
  assert.match(text, /unmeasured/);
  assert.strictEqual(text.includes("ACCEPTED_RULES"), false);
});

it("skips a diagnostic entry in the gate but keeps its case", () => {
  const entries = [
    gateEntry({ caseId: "a", truth: "stands" }),
    gateEntry({ caseId: "b", rule: "reference-is-readable", truth: "needs", diagnostic: true }),
  ];
  const gate = gateOf(entries, ["v2-a", "v2-b"]);
  assert.strictEqual(gate[0]!.passes[0]!.labeled, 1);
  assert.strictEqual(summarizeCases(entries, new Set()).cases, 2);
});

it("checks the frozen floor as a superset", () => {
  const text = formatFloor(new Set([...OLD_FLOOR, "reference-is-readable"]), OLD_FLOOR);
  assert.match(text, /still accepted: names-batch-output, no-visible-link/);
  assert.match(text, /not measured by this corpus: reference-is-readable/);
});
