import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type { StoredAnswer, StoredCase } from "./case-file.ts";
import type { CaseFacts } from "./facts.ts";
import { classifierInput } from "./input.ts";
import { formatScore, scoreAnswers } from "./score.ts";

const caseOf = (caseId: string): StoredCase => ({
  caseId,
  session: { dir: "d", file: "s.jsonl" },
  at: "2026-10-24T00:00:00.000Z",
  index: 0,
  list: { id: 1, name: "Work", items: [] },
  completed: [{ ref: "Work:1", text: "first" }],
  candidates: [
    {
      ref: "Work:2",
      text: "read src/a.ts",
      class: "ready-queue",
      relationship: "independent",
      refs: [{ kind: "path", path: "src/a.ts" }],
    },
  ],
  questions: [{ key: "k0", instructions: "Question?", criteria: {} }],
  frontier: 1,
  itemCount: 1,
  openCount: 1,
  doneCount: 0,
  declaredDeps: 0,
});

const factsOf = (caseId: string): CaseFacts => ({
  caseId,
  at: "2026-10-24T00:00:00.000Z",
  sessionCwd: "/tmp",
  source: "replayed",
  promotable: true,
  declaredHead: true,
  head: {
    questionKey: "k0",
    candidateRef: "Work:2",
    row: "reference-is-readable",
    verdict: "compact",
    references: [{ reference: { kind: "path", path: "src/a.ts" }, state: "readable" }],
    products: [],
    diagnostic: false,
  },
  diagnostics: [],
});

const answerOf = (caseId: string, model = "@cf/cloudflare/clef-flash"): StoredAnswer => ({
  caseId,
  at: "2026-10-24T00:00:00.000Z",
  provider: "cloudflare-workers-ai",
  model,
  stopReason: "stop",
  answers: {
    k0: {
      choice: "stands-alone",
      probabilities: { "stands-alone": 0.9, "needs-context": 0.1 },
      confidence: 0.9,
    },
  },
});

const labelsOf = (caseId: string, pass: string) => [
  {
    caseId,
    key: "k0",
    label: "stands-alone",
    at: "2026-10-24T00:00:00.000Z",
    pass,
  },
];

describe("the declared digest", () => {
  it("carries the resolved reference", () => {
    const stored = caseOf("a");
    const { digest } = classifierInput(stored, factsOf("a"));
    const text = JSON.stringify(digest);
    assert.ok(text.includes("src/a.ts"));
    assert.ok(text.includes("readable"));
  });
});

describe("scoreAnswers", () => {
  it("rejects a model mismatch and prints both model ids", () => {
    const cases = [caseOf("a")];
    const facts = new Map([["a", factsOf("a")]]);
    const labels = labelsOf("a", "v2-a");
    assert.throws(
      () =>
        scoreAnswers({
          cases,
          facts,
          labels,
          answers: [answerOf("a")],
          model: "cloudflare-workers-ai/@cf/cloudflare/clef-omni",
          passes: ["v2-a", "v2-b"],
        }),
      /clef-omni[\s\S]*clef-flash/,
    );
  });

  it("reports each pass and the pooled figure", () => {
    const cases = [caseOf("a"), caseOf("b")];
    const facts = new Map([
      ["a", factsOf("a")],
      ["b", factsOf("b")],
    ]);
    const labels = [...labelsOf("a", "v2-a"), ...labelsOf("b", "v2-b")];
    const report = scoreAnswers({
      cases,
      facts,
      labels,
      answers: [answerOf("a"), answerOf("b")],
      model: "cloudflare-workers-ai/@cf/cloudflare/clef-flash",
      passes: ["v2-a", "v2-b"],
    });
    const text = formatScore(report);
    assert.match(text, /v2-a/);
    assert.match(text, /v2-b/);
    assert.match(text, /pooled/);
    assert.strictEqual(text.includes("feature"), false);
  });
});

describe("the answer file", () => {
  it("round-trips a frozen answer through the model-named file", async () => {
    const { mkdtempSync, readFileSync, rmSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { answerPath } = await import("./answers.ts");
    const out = mkdtempSync(join(tmpdir(), "score-"));
    try {
      const path = answerPath(out, "cloudflare-workers-ai/@cf/cloudflare/clef-flash");
      writeFileSync(path, `${JSON.stringify(answerOf("a"))}\n`);
      const rows = readFileSync(path, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as StoredAnswer);
      assert.strictEqual(rows.length, 1);
      assert.strictEqual(rows[0]!.model, "@cf/cloudflare/clef-flash");
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});
