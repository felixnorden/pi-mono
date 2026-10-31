import { assert, it } from "@effect/vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe } from "vitest";
import { parseOptions } from "./label.ts";
import type { CaseFacts } from "./facts.ts";
import type { StoredCase, StoredEvidence } from "./case-file.ts";
import { ansiPaint, plainPaint, type MarkdownRenderer } from "./style.ts";
import {
  buildQueue,
  compactView,
  countLabels,
  formatCounts,
  formatLabelRecord,
  passRefusal,
  fullView,
  keyToAction,
  labeledPairs,
  labelIndex,
  labelKeyOf,
  LABELS,
  parseLabels,
  PROMPT,
  queueSize,
  recordSurprise,
  renderCaseContext,
  renderCandidate,
  renderEvidence,
  renderList,
  renderPrompt,
  runLabeling,
  wrap,
  type LabelRecord,
  type LabelSession,
  type LabelStore,
  type StoredSurprise,
} from "./labeling.ts";
import { passOfRecord } from "./pass.ts";
import type { LabelSample } from "./sample.ts";

const caseOf = (caseId: string, classes: readonly string[]): StoredCase => ({
  caseId,
  session: { dir: "<SESSION-DIR>", file: "s.jsonl" },
  at: "2026-10-05T00:00:00.000Z",
  index: 0,
  list: {
    id: 1,
    name: "Work",
    items: [
      { id: 1, text: "first", done: true, deps: [] },
      { id: 2, text: "second", done: false, deps: [] },
      { id: 3, text: "third", done: false, deps: ["Work:2"] },
    ],
  },
  completed: [{ ref: "Work:1", text: "first" }],
  candidates: classes.map((cls, index) => ({
    ref: `Work:${index + 2}`,
    text: `candidate ${index + 1}`,
    class: cls,
    relationship: "independent of Work:1",
  })),
  questions: classes.map((_, index) => ({
    key: `k${index}`,
    instructions: `Question ${index + 1}?`,
    criteria: { "needs-context": "it does", "stands-alone": "it does not" },
  })),
  frontier: classes.length,
  itemCount: 3,
  openCount: 2,
  doneCount: 1,
  declaredDeps: 1,
});

const evidenceOf = (caseId: string): StoredEvidence => ({
  caseId,
  entries: [
    { kind: "assistant", at: "2026-10-05T00:00:01.000Z", text: "did the work" },
    {
      kind: "tool-result",
      at: "2026-10-05T00:00:02.000Z",
      name: "bash",
      text: "ok",
      isError: false,
    },
  ],
  omitted: 2,
});

/** A session that returns the scripted keys in order, then quits. */
const scripted = (keys: readonly string[]): { session: LabelSession; output: string[] } => {
  const output: string[] = [];
  let index = 0;
  return {
    output,
    session: {
      write: (text) => {
        output.push(text);
      },
      nextKey: async () => keys[index++] ?? "q",
    },
  };
};

const memoryStore = (): LabelStore & { lines: string[] } => {
  const records: LabelRecord[] = [];
  const lines: string[] = [];
  return {
    records,
    lines,
    append: (record) => {
      records.push(record);
      lines.push(JSON.stringify(record));
    },
    rewrite: () => {
      lines.length = 0;
      for (const record of records) lines.push(JSON.stringify(record));
    },
  };
};

const runOptions = { width: 80, now: () => "2026-10-05T00:00:00.000Z" };

it("skips a malformed label line and a bad label", () => {
  const text = [
    JSON.stringify({ caseId: "a", key: "k", label: "needs-context", at: "t" }),
    "{ not json",
    JSON.stringify({ caseId: "a", key: "k2", label: "maybe", at: "t" }),
    JSON.stringify({ caseId: "a", key: "k3", label: "stands-alone", at: "t" }),
  ].join("\n");
  const records = parseLabels(text);
  assert.deepStrictEqual(
    records.map((record) => record.key),
    ["k", "k3"],
  );
});

it("takes the last answer for a repeated question", () => {
  const records: readonly LabelRecord[] = [
    { caseId: "a", key: "k", label: "needs-context", at: "t" },
    { caseId: "a", key: "k", label: "stands-alone", at: "t" },
  ];
  assert.strictEqual(labelIndex(records).get(labelKeyOf("a", "k")), "stands-alone");
});

it("queues unanswered questions in corpus order", () => {
  const cases = [caseOf("a", ["ready-queue", "dependent-successor"]), caseOf("b", ["ready-queue"])];
  const answered = labelIndex([{ caseId: "a", key: "k0", label: "stands-alone", at: "t" }]);
  const queue = buildQueue(cases, new Map(), { answered });
  assert.strictEqual(queue.length, 2);
  assert.deepStrictEqual(
    queue[0]!.pending.map((entry) => entry.questionKey),
    ["k1"],
  );
  assert.strictEqual(queueSize(queue), 2);
});

it("filters the queue by candidate class", () => {
  const cases = [caseOf("a", ["ready-queue", "dependent-successor"])];
  const queue = buildQueue(cases, new Map(), {
    answered: new Map(),
    classes: ["dependent-successor"],
  });
  assert.deepStrictEqual(
    queue[0]!.pending.map((entry) => entry.questionKey),
    ["k1"],
  );
});

it("stops the queue at the limit", () => {
  const cases = [caseOf("a", ["ready-queue", "ready-queue", "ready-queue"])];
  const queue = buildQueue(cases, new Map(), { answered: new Map(), limit: 2 });
  assert.strictEqual(queueSize(queue), 2);
  assert.strictEqual(queue[0]!.pending.length, 2);
});

it("wraps text and hard-splits a long word", () => {
  assert.strictEqual(wrap("one two three", 8), "one two\nthree");
  assert.strictEqual(wrap("abcdefghij", 4), "abcd\nefgh\nij");
  assert.strictEqual(wrap("", 10), "");
});

it("renders the context with the batch and the work record", () => {
  const queue = buildQueue([caseOf("a", ["ready-queue"])], new Map([["a", evidenceOf("a")]]), {
    answered: new Map(),
  });
  const header = renderCaseContext(queue[0]!, 1, 100);
  assert.match(header, /case 1\/1 · Work · 1 to label/);
  assert.match(header, /Work:1 first/);
  assert.match(header, /WORK RECORD \(2 entries\)/);
  assert.match(header, /2 earlier entries omitted/);
  // The list moved out of the context block and now sits above each candidate.
  assert.strictEqual(header.includes("THE LIST"), false);
});

it("renders the list with each item state", () => {
  const queue = buildQueue([caseOf("a", ["ready-queue"])], new Map(), { answered: new Map() });
  const list = renderList(queue[0]!, 100);
  assert.match(list, /THE LIST/);
  assert.match(list, /1 {2}done, this batch/);
  assert.match(list, /3 {2}blocked by Work:2/);
  assert.match(list, /2 {2}candidate/);
});

it("renders a candidate with its question and criteria", () => {
  const queue = buildQueue([caseOf("a", ["dependent-successor"])], new Map(), {
    answered: new Map(),
  });
  const rendered = renderCandidate(queue[0]!, queue[0]!.pending[0]!, 1, 100);
  assert.match(rendered, /CANDIDATE 1\/1 {2}Work:2 {2}\(dependent-successor\)/);
  assert.match(rendered, /question: Question 1\?/);
  assert.match(rendered, /needs-context: it does/);
});

it("renders item descriptions in the list and the completed batch", () => {
  const entry: StoredCase = {
    ...caseOf("a", ["ready-queue"]),
    list: {
      id: 1,
      name: "Work",
      items: [
        { id: 1, text: "first", description: "batch detail", done: true, deps: [] },
        { id: 2, text: "second", description: "candidate detail", done: false, deps: [] },
      ],
    },
    completed: [{ ref: "Work:1", text: "first", description: "batch detail" }],
  };
  const queue = buildQueue([entry], new Map(), { answered: new Map() });
  const list = renderList(queue[0]!, 100);
  assert.match(list, /batch detail/);
  assert.match(list, /candidate detail/);
  const context = renderCaseContext(queue[0]!, 1, 100);
  assert.match(context, /batch detail/);
});

it("renders a candidate's description and declarations", () => {
  const base = caseOf("a", ["ready-queue"]);
  const entry: StoredCase = {
    ...base,
    candidates: [
      {
        ...base.candidates[0]!,
        description: "the detail",
        refs: [{ kind: "path", path: "src/a.ts", symbol: "route" }],
        produces: [{ path: "out.md" }],
      },
    ],
  };
  const queue = buildQueue([entry], new Map(), { answered: new Map() });
  const rendered = renderCandidate(queue[0]!, queue[0]!.pending[0]!, 1, 100);
  assert.match(rendered, /the detail/);
  assert.match(rendered, /src\/a\.ts/);
  assert.match(rendered, /route/);
  assert.match(rendered, /out\.md/);
});

it("renders the decision record on its pointer candidate", () => {
  const base = caseOf("a", ["ready-queue"]);
  const entry: StoredCase = {
    ...base,
    decision: {
      rule: "no-visible-link",
      verdict: "compact",
      candidateRef: "Work:2",
      references: [{ kind: "path", path: "src/a.ts", state: "readable" }],
      products: [{ path: "out.md", state: "exists" }],
    },
  };
  const queue = buildQueue([entry], new Map(), { answered: new Map() });
  const rendered = renderCandidate(queue[0]!, queue[0]!.pending[0]!, 1, 100, undefined, {
    revealed: true,
  });
  assert.match(rendered, /decision: no-visible-link \(compact\)/);
  assert.match(rendered, /src\/a\.ts: readable/);
  assert.match(rendered, /out\.md: exists/);
});

it("maps each key to one action", () => {
  assert.deepStrictEqual(keyToAction("n"), { kind: "answer", label: "needs-context" });
  assert.deepStrictEqual(keyToAction("2"), { kind: "answer", label: "stands-alone" });
  assert.deepStrictEqual(keyToAction("a"), { kind: "answer-all", label: "stands-alone" });
  assert.deepStrictEqual(keyToAction("A"), { kind: "answer-all", label: "needs-context" });
  assert.deepStrictEqual(keyToAction("p"), { kind: "reprint" });
  assert.deepStrictEqual(keyToAction("u"), { kind: "undo" });
  assert.deepStrictEqual(keyToAction("k"), { kind: "skip-case" });
  assert.deepStrictEqual(keyToAction("q"), { kind: "quit" });
  assert.deepStrictEqual(keyToAction("z"), { kind: "unknown" });
});

it("treats every enter flavour as accept", () => {
  for (const key of ["\r", "\n", "return", "enter"]) {
    assert.deepStrictEqual(keyToAction(key), { kind: "accept" });
  }
});

it("shows a suggestion above the prompt, and only when there is one", () => {
  const shown = renderPrompt(plainPaint, {
    label: "stands-alone",
    reason: "no document and no plan in play",
    confidence: "high",
  });
  assert.match(shown, /suggested: stands-alone — no document and no plan in play \(high\)/);
  assert.match(shown, /\[enter\] accepts/);
  assert.ok(!renderPrompt(plainPaint).includes("suggested:"));
});

it("accepts a suggestion with enter", async () => {
  const queue = buildQueue([caseOf("a", ["ready-queue"])], new Map(), { answered: new Map() });
  const store = memoryStore();
  const { session, output } = scripted(["\r"]);
  const suggestions = new Map([
    [
      labelKeyOf("a", "k0"),
      { label: "stands-alone" as const, reason: "plain", confidence: "high" },
    ],
  ]);
  const result = await runLabeling(queue, store, session, { ...runOptions, suggestions });
  assert.deepStrictEqual(result, { answered: 1, quit: false });
  assert.deepStrictEqual(
    store.records.map((record) => [record.key, record.label]),
    [["k0", "stands-alone"]],
  );
  assert.ok(output.some((text) => text.includes("suggested: stands-alone")));
});

it("reports a missing suggestion instead of guessing", async () => {
  const queue = buildQueue([caseOf("a", ["ready-queue"])], new Map(), { answered: new Map() });
  const store = memoryStore();
  const { session, output } = scripted(["\r", "n"]);
  const result = await runLabeling(queue, store, session, runOptions);
  assert.deepStrictEqual(result, { answered: 1, quit: false });
  assert.deepStrictEqual(
    store.records.map((record) => record.label),
    ["needs-context"],
  );
  assert.ok(output.some((text) => text.includes("no suggestion for this question")));
});

it("records one answer per keypress", async () => {
  const queue = buildQueue([caseOf("a", ["ready-queue", "ready-queue"])], new Map(), {
    answered: new Map(),
  });
  const store = memoryStore();
  const { session, output } = scripted(["n", "s"]);
  const result = await runLabeling(queue, store, session, runOptions);
  assert.deepStrictEqual(result, { answered: 2, quit: false });
  assert.deepStrictEqual(
    store.records.map((record) => [record.key, record.label]),
    [
      ["k0", "needs-context"],
      ["k1", "stands-alone"],
    ],
  );
  assert.strictEqual(store.lines.length, 2);
  assert.ok(output.some((text) => text.includes(PROMPT)));
});

it("labels the rest of a case with the answer-all key", async () => {
  const queue = buildQueue(
    [caseOf("a", ["ready-queue", "ready-queue", "ready-queue"])],
    new Map(),
    {
      answered: new Map(),
    },
  );
  const store = memoryStore();
  const result = await runLabeling(queue, store, scripted(["a"]).session, runOptions);
  assert.strictEqual(result.answered, 3);
  assert.deepStrictEqual(
    store.records.map((record) => record.label),
    ["stands-alone", "stands-alone", "stands-alone"],
  );
});

it("skips the rest of a case", async () => {
  const queue = buildQueue(
    [caseOf("a", ["ready-queue", "ready-queue"]), caseOf("b", ["ready-queue"])],
    new Map(),
    {
      answered: new Map(),
    },
  );
  const store = memoryStore();
  const result = await runLabeling(queue, store, scripted(["k", "n"]).session, runOptions);
  assert.strictEqual(result.answered, 1);
  assert.deepStrictEqual(
    store.records.map((record) => [record.caseId, record.key]),
    [["b", "k0"]],
  );
});

it("undo removes the last answer and asks the question again", async () => {
  const queue = buildQueue([caseOf("a", ["ready-queue", "ready-queue"])], new Map(), {
    answered: new Map(),
  });
  const store = memoryStore();
  const { session, output } = scripted(["n", "u", "s"]);
  const result = await runLabeling(queue, store, session, runOptions);
  assert.strictEqual(result.answered, 1);
  assert.strictEqual(store.records.length, 1);
  assert.strictEqual(store.records[0]!.key, "k0");
  assert.strictEqual(store.records[0]!.label, "stands-alone");
  assert.strictEqual(store.lines.length, 1);
  assert.ok(output.some((text) => text.includes("undid answer for k0")));
});

it("reports a quit and keeps what was answered", async () => {
  const queue = buildQueue([caseOf("a", ["ready-queue", "ready-queue"])], new Map(), {
    answered: new Map(),
  });
  const store = memoryStore();
  const result = await runLabeling(queue, store, scripted(["n", "q"]).session, runOptions);
  assert.deepStrictEqual(result, { answered: 1, quit: true });
  assert.strictEqual(store.records.length, 1);
});

it("undo can reach an answer from an earlier run", async () => {
  const cases = [caseOf("a", ["ready-queue"])];
  // The corpus and the queue exclude the answered question, but the file keeps it.
  const queue = buildQueue(cases, new Map(), { answered: new Map() });
  const store = memoryStore();
  store.records.push({
    caseId: "a",
    key: "k0",
    label: "needs-context",
    at: "t",
  });
  store.rewrite();
  const { session } = scripted(["u", "s"]);
  const result = await runLabeling(queue, store, session, runOptions);
  assert.strictEqual(result.answered, 1);
  assert.deepStrictEqual(
    store.records.map((record) => [record.key, record.label]),
    [["k0", "stands-alone"]],
  );
  assert.strictEqual(store.lines.length, 1);
});

it("says nothing to undo when the session has no answers", async () => {
  const queue = buildQueue([caseOf("a", ["ready-queue"])], new Map(), { answered: new Map() });
  const store = memoryStore();
  const { session, output } = scripted(["u", "n"]);
  const result = await runLabeling(queue, store, session, runOptions);
  assert.strictEqual(result.answered, 1);
  assert.ok(output.some((text) => text.includes("nothing to undo")));
});

it("skips an unknown key and asks again", async () => {
  const queue = buildQueue([caseOf("a", ["ready-queue"])], new Map(), { answered: new Map() });
  const store = memoryStore();
  const { session, output } = scripted(["z", "n"]);
  const result = await runLabeling(queue, store, session, runOptions);
  assert.strictEqual(result.answered, 1);
  assert.ok(output.some((text) => text.includes("unknown key")));
});

it("counts answers by candidate class", () => {
  const cases = [caseOf("a", ["ready-queue", "dependent-successor"])];
  const records: readonly LabelRecord[] = [
    { caseId: "a", key: "k0", label: "stands-alone", at: "t" },
    { caseId: "a", key: "k1", label: "needs-context", at: "t" },
  ];
  const counts = countLabels(cases, records);
  assert.strictEqual(counts.total, 2);
  assert.strictEqual(counts.needsContext, 1);
  assert.strictEqual(counts.standsAlone, 1);
  assert.deepStrictEqual(counts.needsContextByClass, { "dependent-successor": 1 });
  assert.match(formatCounts(counts), /dependent-successor: 1\/1 needs-context \(100%\)/);
  assert.match(formatCounts(counts), /ready-queue: 0\/1 needs-context \(0%\)/);
});

it("renders prose as markdown and tool traffic as a code block", () => {
  const calls: Array<{ text: string; colors: boolean; columns: number }> = [];
  const render: MarkdownRenderer = (text, options) => {
    calls.push({ text, colors: options.colors, columns: options.columns });
    return "RENDERED";
  };
  const evidence: StoredEvidence = {
    caseId: "a",
    entries: [
      { kind: "assistant", at: "2026-10-05T00:00:01.000Z", text: "**done**" },
      { kind: "tool-call", at: "2026-10-05T00:00:02.000Z", name: "bash", text: '{"command":"ls"}' },
    ],
    omitted: 0,
  };
  renderEvidence(evidence, 100, ansiPaint(true, render), fullView);
  assert.deepStrictEqual(calls[0], { text: "**done**", colors: true, columns: 94 });
  assert.strictEqual(calls[1]!.text, '```json\n{\n  "command": "ls"\n}\n```');
});

it("shows only the newest entries in the compact view", () => {
  const entries = [1, 2, 3, 4, 5].map((index) => ({
    kind: "assistant" as const,
    at: "2026-10-05T00:00:00.000Z",
    text: `entry ${index}`,
  }));
  const rendered = renderEvidence({ caseId: "a", entries, omitted: 0 }, 100, undefined, {
    entries: 2,
    lines: 10,
  });
  assert.match(rendered, /WORK RECORD \(5 entries, newest 2; press p for all\)/);
  assert.strictEqual(rendered.includes("entry 1"), false);
  assert.match(rendered, /entry 4/);
  assert.match(rendered, /entry 5/);
  assert.strictEqual(compactView.entries, 8);
});

it("renders every entry in the full view", () => {
  const entries = [1, 2, 3, 4, 5].map((index) => ({
    kind: "assistant" as const,
    at: "2026-10-05T00:00:00.000Z",
    text: `entry ${index}`,
  }));
  const rendered = renderEvidence({ caseId: "a", entries, omitted: 0 }, 100, undefined, fullView);
  assert.match(rendered, /WORK RECORD \(5 entries\)/);
  assert.match(rendered, /entry 1/);
});

it("reprint switches the card to the full work record", async () => {
  const caseEntry = caseOf("a", ["ready-queue"]);
  const entries = Array.from({ length: 12 }, (_, index) => ({
    kind: "assistant" as const,
    at: "2026-10-05T00:00:00.000Z",
    text: `note ${index + 1}`,
  }));
  const queue = buildQueue([caseEntry], new Map([["a", { caseId: "a", entries, omitted: 0 }]]), {
    answered: new Map(),
  });
  const store = memoryStore();
  const { session, output } = scripted(["p", "n"]);
  await runLabeling(queue, store, session, runOptions);
  const headers = output.filter((text) => text.includes("WORK RECORD ("));
  assert.strictEqual(headers.length, 2);
  assert.match(headers[0]!, /press p for all/);
  assert.strictEqual(headers[1]!.includes("press p for all"), false);
  const lines = (text: string): readonly string[] => text.split("\n").map((line) => line.trim());
  assert.strictEqual(lines(headers[0]!).includes("note 1"), false);
  assert.strictEqual(lines(headers[1]!).includes("note 1"), true);
});

it("uses the two shipped label values", () => {
  assert.deepStrictEqual(Object.values(LABELS), ["needs-context", "stands-alone"]);
});

it("shows item declarations under the list item", () => {
  const caseEntry = caseOf("a", ["ready-queue"]);
  const declared: StoredCase = {
    ...caseEntry,
    list: {
      ...caseEntry.list,
      items: caseEntry.list.items.map((item) =>
        item.id === 2
          ? {
              ...item,
              refs: [{ kind: "path", path: "src/a.ts" }],
              produces: [{ path: "docs/out.md" }],
            }
          : item,
      ),
    },
  };
  const queue = buildQueue([declared], new Map(), { answered: new Map() });
  const rendered = renderList(queue[0]!, 120);
  assert.include(rendered, "src/a.ts");
  assert.include(rendered, "docs/out.md");
});

describe("label records name their corpus and pass", () => {
  const v2Record: LabelRecord = {
    caseId: "c1",
    key: "k0",
    label: LABELS.standsAlone,
    at: "2026-10-24T12:00:00.000Z",
    corpus: "v2",
    pass: "v2-a",
    rule: "reference-is-readable",
    source: "replayed",
  };

  it("round-trips corpus, pass, rule, and source", () => {
    const parsed = parseLabels(formatLabelRecord(v2Record));
    assert.deepStrictEqual(parsed, [v2Record]);
  });

  it("keeps an old record without the new fields", () => {
    const old: LabelRecord = {
      caseId: "c1",
      key: "k0",
      label: LABELS.standsAlone,
      at: "2026-10-05T00:00:00.000Z",
    };
    const parsed = parseLabels(JSON.stringify(old));
    assert.deepStrictEqual(parsed, [old]);
    assert.strictEqual(passOfRecord(parsed[0]!), "pass1");
  });
});

describe("a sampled queue", () => {
  const sampleOf = (passes: Record<string, readonly string[]>): LabelSample => ({
    corpus: "v2",
    createdAt: "2026-10-24T12:00:00.000Z",
    seed: 7,
    target: 660,
    targetPerRowPerPass: 25,
    floorPerRowPerPass: 10,
    unmeasurable: [],
    belowQuota: [],
    pilot: [],
    passes: Object.fromEntries(
      Object.entries(passes).map(([name, cards]) => [
        name,
        { sittings: [{ cards, seededWith: [] }] },
      ]),
    ) as unknown as LabelSample["passes"],
  });

  it("asks only the head question of a sampled case", () => {
    const cases = [caseOf("c1", ["ready-queue"]), caseOf("c2", ["ready-queue"]), caseOf("c3", ["ready-queue"])];
    const queue = buildQueue(cases, new Map(), {
      answered: new Map(),
      sample: sampleOf({ "v2-a": ["c1", "c2"] }),
    });
    assert.strictEqual(queueSize(queue), 2);
    assert.deepStrictEqual(
      queue.map((entry) => [entry.entry.caseId, entry.pending[0]!.index]),
      [
        ["c1", 0],
        ["c2", 0],
      ],
    );
  });

  it("walks the stored order, not the corpus order", () => {
    const cases = [caseOf("c1", ["ready-queue"]), caseOf("c2", ["ready-queue"]), caseOf("c3", ["ready-queue"])];
    const queue = buildQueue(cases, new Map(), {
      answered: new Map(),
      sample: sampleOf({ "v2-a": ["c3", "c1", "c2"] }),
    });
    assert.deepStrictEqual(
      queue.map((entry) => entry.entry.caseId),
      ["c3", "c1", "c2"],
    );
  });

  it("filters focus inside the sample", () => {
    const declared = caseOf("c1", ["ready-queue"]);
    const withDeclared: StoredCase = {
      ...declared,
      candidates: [{ ...declared.candidates[0]!, refs: [{ kind: "path", path: "src/a.ts" }] }],
    };
    const plain = caseOf("c2", ["ready-queue"]);
    const queue = buildQueue([withDeclared, plain], new Map(), {
      answered: new Map(),
      sample: sampleOf({ "v2-a": ["c1", "c2"] }),
      focus: "declared",
    });
    assert.deepStrictEqual(
      queue.map((entry) => entry.entry.caseId),
      ["c1"],
    );
  });

  it("puts a sitting's pilot seeds before its cards", () => {
    const cases = [caseOf("c1", ["ready-queue"]), caseOf("p1", ["ready-queue"])];
    const sample = sampleOf({ "v2-a": ["c1"] });
    const withSeed: LabelSample = {
      ...sample,
      pilot: ["p1"],
      passes: {
        "v2-a": { sittings: [{ cards: ["c1"], seededWith: ["p1"] }] },
        "v2-b": { sittings: [] },
      },
    };
    const queue = buildQueue(cases, new Map(), { answered: new Map(), sample: withSeed });
    assert.deepStrictEqual(
      queue.map((entry) => [entry.entry.caseId, entry.pilot === true]),
      [
        ["p1", true],
        ["c1", false],
      ],
    );
  });
});

describe("labeledPairs", () => {
  const cases = [caseOf("c1", ["ready-queue"]), caseOf("c2", ["ready-queue"])];
  const recordsOf = (pass: string, extra?: Partial<LabelRecord>): LabelRecord[] => [
    {
      caseId: "c1",
      key: "k0",
      label: LABELS.standsAlone,
      at: "2026-10-24T12:00:00.000Z",
      pass,
      ...extra,
    },
    {
      caseId: "c2",
      key: "k0",
      label: LABELS.needsContext,
      at: "2026-10-24T12:00:00.000Z",
      pass,
    },
  ];

  it("measures only its own pass", () => {
    const pairs = labeledPairs(cases, recordsOf("v2-a"), "v2-a");
    assert.strictEqual(pairs.length, 2);
    assert.strictEqual(labeledPairs(cases, recordsOf("v2-b"), "v2-a").length, 0);
  });

  it("drops a pilot seed", () => {
    const records = recordsOf("v2-a");
    records[0] = { ...records[0]!, pilot: true };
    const pairs = labeledPairs(cases, records, "v2-a");
    assert.strictEqual(pairs.length, 1);
    assert.strictEqual(pairs[0]!.caseId, "c2");
  });
});

describe("pass and suggestion guards", () => {
  it("refuses --suggest for a declared corpus", () => {
    const out = mkdtempSync(join(tmpdir(), "label-"));
    try {
      writeFileSync(join(out, "manifest.json"), JSON.stringify({ format: "declared" }));
      assert.throws(
        () => parseOptions(["--out", out, "--suggest", "x.json"]),
        /disabled for a declared corpus/,
      );
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  it("names the sample's passes when the pass is unknown", () => {
    const sample = {
      corpus: "v2",
      createdAt: "",
      seed: 7,
      target: 660,
      targetPerRowPerPass: 25,
      floorPerRowPerPass: 10,
      unmeasurable: [],
      belowQuota: [],
      pilot: [],
      passes: { "v2-a": { sittings: [] }, "v2-b": { sittings: [] } },
    } as unknown as LabelSample;
    const refusal = passRefusal(sample, "v2-c");
    assert.match(refusal ?? "", /v2-a, v2-b/);
  });
});

it("writes one record to each sampled pass with its corpus and row", async () => {
  const sample = {
    corpus: "v2",
    createdAt: "",
    seed: 7,
    target: 660,
    targetPerRowPerPass: 25,
    floorPerRowPerPass: 10,
    unmeasurable: [],
    belowQuota: [],
    pilot: [],
    passes: {
      "v2-a": { sittings: [{ cards: ["a"], seededWith: [] }] },
      "v2-b": { sittings: [{ cards: ["b"], seededWith: [] }] },
    },
  } as unknown as LabelSample;
  const facts = new Map(
    ["a", "b"].map((caseId) => [
      caseId,
      {
        caseId,
        at: "2026-10-24T12:00:00.000Z",
        sessionCwd: "/tmp",
        source: "replayed" as const,
        promotable: true,
        declaredHead: true,
        head: {
          questionKey: "k0",
          candidateRef: "Work:2",
          row: "reference-is-readable",
          verdict: "compact" as const,
          references: [],
          products: [],
          diagnostic: false,
        },
        diagnostics: [],
      },
    ]),
  );
  const store = memoryStore();
  for (const pass of ["v2-a", "v2-b"]) {
    const queue = buildQueue([caseOf(pass === "v2-a" ? "a" : "b", ["ready-queue"])], new Map(), {
      answered: new Map(),
      sample,
      pass,
    });
    const { session } = scripted(["s"]);
    await runLabeling(queue, store, session, {
      ...runOptions,
      corpus: "v2",
      pass,
      facts,
    });
  }
  assert.deepStrictEqual(
    store.records.map((record) => [record.caseId, record.pass, record.corpus, record.rule]),
    [
      ["a", "v2-a", "v2", "reference-is-readable"],
      ["b", "v2-b", "v2", "reference-is-readable"],
    ],
  );
});

const factsFor = (overrides?: {
  readonly source?: "live" | "replayed" | "mismatch" | "unresolved";
  readonly row?: string;
  readonly state?: string;
}): CaseFacts => ({
  caseId: "a",
  at: "2026-10-24T12:00:00.000Z",
  sessionCwd: "/tmp",
  source: overrides?.source ?? "replayed",
  promotable: overrides?.source !== "mismatch" && overrides?.source !== "unresolved",
  declaredHead: true,
  head: {
    questionKey: "k0",
    candidateRef: "Work:2",
    row: overrides?.row ?? "reference-is-readable",
    verdict: "compact",
    references: [
      {
        reference: { kind: "path", path: "src/a.ts" },
        state: (overrides?.state ?? "readable") as "readable",
      },
    ],
    products: [],
    diagnostic: false,
  },
  diagnostics: [],
});

describe("the candidate card", () => {
  const declaredCase = (): StoredCase => {
    const base = caseOf("a", ["ready-queue"]);
    return {
      ...base,
      candidates: [
        {
          ...base.candidates[0]!,
          refs: [{ kind: "path", path: "src/a.ts" }],
        },
      ],
    };
  };

  it("hides the row and the source before the answer", () => {
    const queue = buildQueue([declaredCase()], new Map(), { answered: new Map() });
    const rendered = renderCandidate(queue[0]!, queue[0]!.pending[0]!, 1, 100, undefined, {
      facts: factsFor(),
      revealed: false,
    });
    assert.match(rendered, /src\/a\.ts/);
    assert.match(rendered, /readable/);
    assert.strictEqual(rendered.includes("reference-is-readable"), false);
    assert.strictEqual(rendered.includes("replayed"), false);
  });

  it("shows unresolved before the answer", () => {
    const queue = buildQueue([declaredCase()], new Map(), { answered: new Map() });
    const rendered = renderCandidate(queue[0]!, queue[0]!.pending[0]!, 1, 100, undefined, {
      facts: { ...factsFor({ source: "unresolved", row: "" }), head: { ...factsFor().head, references: [] } },
      revealed: false,
    });
    assert.match(rendered, /unresolved/);
    assert.strictEqual(rendered.includes("reference-is-readable"), false);
  });

  it("reveals the row, the verdict, and the source", () => {
    const queue = buildQueue([declaredCase()], new Map(), { answered: new Map() });
    const rendered = renderCandidate(queue[0]!, queue[0]!.pending[0]!, 1, 100, undefined, {
      facts: factsFor(),
      revealed: true,
    });
    assert.match(rendered, /reference-is-readable \(compact\)/);
    assert.match(rendered, /resolution: replayed/);
  });

  it("cannot change the answer when the reveal takes a key", async () => {
    const queue = buildQueue([declaredCase()], new Map(), { answered: new Map() });
    const store = memoryStore();
    const { session } = scripted(["s", "x"]);
    const surprises: StoredSurprise[] = [];
    await runLabeling(queue, store, session, {
      ...runOptions,
      facts: new Map([["a", factsFor()]]),
      reveal: true,
      onSurprise: (surprise) => recordSurprise(surprises, surprise),
    });
    assert.strictEqual(store.records.length, 1);
    assert.strictEqual(surprises.length, 0);
  });

  it("writes one surprise row when the labeler marks one", async () => {
    const queue = buildQueue([declaredCase()], new Map(), { answered: new Map() });
    const store = memoryStore();
    const { session } = scripted(["s", "!"]);
    const surprises: StoredSurprise[] = [];
    await runLabeling(queue, store, session, {
      ...runOptions,
      facts: new Map([["a", factsFor()]]),
      reveal: true,
      onSurprise: (surprise) => recordSurprise(surprises, surprise),
    });
    assert.strictEqual(surprises.length, 1);
    assert.strictEqual(store.records.length, 1);
    assert.deepStrictEqual(
      {
        caseId: surprises[0]!.caseId,
        questionKey: surprises[0]!.questionKey,
        rule: surprises[0]!.rule,
        label: surprises[0]!.label,
      },
      {
        caseId: "a",
        questionKey: "k0",
        rule: "reference-is-readable",
        label: "stands-alone",
      },
    );
  });
});

describe("the pilot sitting", () => {
  const sample = {
    corpus: "v2",
    createdAt: "",
    seed: 7,
    target: 660,
    targetPerRowPerPass: 25,
    floorPerRowPerPass: 10,
    unmeasurable: [],
    belowQuota: [],
    pilot: ["p1", "p2"],
    passes: {
      "v2-a": { sittings: [{ cards: ["a"], seededWith: ["p1"] }] },
      "v2-b": { sittings: [{ cards: ["b"], seededWith: ["p2"] }] },
    },
  } as unknown as LabelSample;

  it("queues the pilot ids as ordinary cards, in sample order", () => {
    const cases = [caseOf("a", ["ready-queue"]), caseOf("p1", ["ready-queue"]), caseOf("p2", ["ready-queue"])];
    const queue = buildQueue(cases, new Map(), { answered: new Map(), sample, pilot: true });
    assert.deepStrictEqual(
      queue.map((entry) => [entry.entry.caseId, entry.pilot === true]),
      [
        ["p1", false],
        ["p2", false],
      ],
    );
  });

  it("cannot be combined with --pass", () => {
    assert.throws(() => parseOptions(["--pilot", "--pass", "v2-a"]), /cannot be combined/);
  });
});
