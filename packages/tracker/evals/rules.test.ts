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
  gateOf,
  productionEntries,
  readCorpus,
  sameRuleSet,
  summarizeCases,
  summarizeRules,
  type RuleEntry,
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
  assert.strictEqual(replay.entries.length, verdicts.length);
  assert.deepStrictEqual(checkParity(replay.entries, verdicts), []);
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
