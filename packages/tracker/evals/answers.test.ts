import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type { StoredCase } from "./case-file.ts";
import type { CaseFacts } from "./facts.ts";
import { answerPath, askable, shortModel } from "./answers.ts";

const caseOf = (caseId: string, classes = ["ready-queue"]): StoredCase => ({
  caseId,
  session: { dir: "d", file: "s.jsonl" },
  at: "2026-10-24T00:00:00.000Z",
  index: 0,
  list: { id: 1, name: "Work", items: [] },
  completed: [{ ref: "Work:1", text: "first" }],
  candidates: classes.map((cls, index) => ({
    ref: `Work:${index + 2}`,
    text: "candidate",
    class: cls,
    relationship: "independent",
  })),
  questions: classes.map((_, index) => ({
    key: `k${index}`,
    instructions: "Question?",
    criteria: {},
  })),
  frontier: classes.length,
  itemCount: 1,
  openCount: 0,
  doneCount: 1,
  declaredDeps: 0,
});

const factsOf = (caseId: string, promotable = true): CaseFacts => ({
  caseId,
  at: "2026-10-24T00:00:00.000Z",
  sessionCwd: "/tmp",
  source: promotable ? "replayed" : "unresolved",
  promotable,
  declaredHead: true,
  head: {
    questionKey: "k0",
    candidateRef: "Work:2",
    row: "reference-is-readable",
    verdict: "compact",
    references: [],
    products: [],
    diagnostic: false,
  },
  diagnostics: [],
});

describe("answerPath", () => {
  it("names the file by the short model", () => {
    assert.strictEqual(
      answerPath("/tmp/corpus", "cloudflare-workers-ai/@cf/cloudflare/clef-omni"),
      "/tmp/corpus/answers.clef-omni.jsonl",
    );
    assert.strictEqual(shortModel("cloudflare-workers-ai/@cf/cloudflare/clef-flash"), "clef-flash");
  });

  it("keeps the baseline name stable", () => {
    assert.strictEqual(
      answerPath("out", "cloudflare-workers-ai/@cf/cloudflare/clef-flash"),
      "out/answers.clef-flash.jsonl",
    );
  });
});

describe("askable", () => {
  it("asks only sampled, labeled, promotable heads", () => {
    const cases = [caseOf("a"), caseOf("b"), caseOf("c"), caseOf("d")];
    const labeled = new Set(["a\u0000k0", "c\u0000k0", "d\u0000k0"]);
    const sample = new Set(["a", "b", "d"]);
    const facts = new Map([
      ["a", factsOf("a")],
      ["b", factsOf("b")],
      ["c", factsOf("c")],
      ["d", factsOf("d", false)],
    ]);
    assert.deepStrictEqual(
      askable(cases, labeled, sample, facts).map((entry) => entry.caseId),
      ["a"],
    );
  });
});
