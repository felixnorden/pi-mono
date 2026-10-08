import { assert, it } from "@effect/vitest";
import type { StoredCase, StoredEvidence } from "./case-file.ts";
import { ansiPaint, plainPaint, type MarkdownRenderer } from "./style.ts";
import {
  buildQueue,
  compactView,
  countLabels,
  formatCounts,
  fullView,
  keyToAction,
  labelIndex,
  labelKeyOf,
  LABELS,
  parseLabels,
  PROMPT,
  queueSize,
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
} from "./labeling.ts";

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
