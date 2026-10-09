import { assert, it } from "@effect/vitest";
import type { StoredCase } from "./case-file.ts";
import { parseOptions, renderCase } from "./review.ts";

/** One case with every new field the review pack must show. */
const caseOf = (): StoredCase => ({
  caseId: "s.jsonl#0",
  session: { dir: "d", file: "s.jsonl" },
  at: "2026-10-05T00:00:00.000Z",
  index: 0,
  list: {
    id: 1,
    name: "Work",
    items: [
      { id: 1, text: "first", description: "batch detail", done: true, deps: [] },
      { id: 2, text: "second", description: "candidate detail", done: false, deps: [] },
    ],
  },
  completed: [{ ref: "Work:1", text: "first", description: "batch detail" }],
  candidates: [
    {
      ref: "Work:2",
      text: "second",
      description: "candidate detail",
      class: "ready-queue",
      relationship: "independent of Work:1",
      refs: [{ kind: "path", path: "src/a.ts", symbol: "route" }],
      produces: [{ path: "out.md" }],
    },
  ],
  questions: [{ key: "k0", instructions: "Question?", criteria: { "needs-context": "it does" } }],
  frontier: 1,
  itemCount: 2,
  openCount: 1,
  doneCount: 1,
  declaredDeps: 0,
  decision: {
    rule: "no-visible-link",
    verdict: "compact",
    candidateRef: "Work:2",
    references: [{ kind: "path", path: "src/a.ts", state: "readable" }],
    products: [{ path: "out.md", state: "exists" }],
  },
});

it("defaults the corpus directory and accepts --out", () => {
  assert.match(parseOptions([]).out, /evals\/data$/);
  assert.strictEqual(parseOptions(["--out", "/tmp/corpus"]).out, "/tmp/corpus");
});

it("renders descriptions, declarations, and the decision in a case file", () => {
  const markdown = renderCase(1, caseOf(), undefined, 1);
  assert.include(markdown, "batch detail");
  assert.include(markdown, "candidate detail");
  assert.include(markdown, "src/a.ts");
  assert.include(markdown, "route");
  assert.include(markdown, "out.md");
  assert.include(markdown, "no-visible-link");
  assert.include(markdown, "readable");
  assert.include(markdown, "exists");
});
