import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type { CaseFacts } from "./facts.ts";
import { auditRow, drawAudit } from "./audit.ts";

const factsOf = (
  caseId: string,
  state: "readable" | "unresolved",
  source: "replayed" | "live" | "unresolved" = "replayed",
): CaseFacts => ({
  caseId,
  at: "2026-10-24T12:00:00.000Z",
  sessionCwd: "/tmp",
  source,
  promotable: source !== "unresolved",
  declaredHead: true,
  head: {
    questionKey: "k0",
    candidateRef: "Work:2",
    row: state === "readable" ? "reference-is-readable" : "reference-is-unresolved",
    verdict: state === "readable" ? "compact" : "abstain",
    references: [{ reference: { kind: "path", path: "src/a.ts" }, state }],
    products: [],
    diagnostic: false,
  },
  diagnostics: [],
});

describe("drawAudit", () => {
  it("draws at most ten replays per declared row, without duplicates", () => {
    const facts = Array.from({ length: 40 }, (_, index) => factsOf(`case-${index}`, "readable"));
    const picked = drawAudit(facts, 10, 7);
    assert.strictEqual(picked.length, 10);
    assert.strictEqual(new Set(picked.map((entry) => entry.caseId)).size, 10);
    assert.deepStrictEqual(
      picked.map((entry) => entry.caseId),
      drawAudit(facts, 10, 7).map((entry) => entry.caseId),
    );
  });

  it("samples each declared row separately", () => {
    const facts = [
      ...Array.from({ length: 12 }, (_, index) => factsOf(`a-${index}`, "readable")),
      ...Array.from({ length: 12 }, (_, index) =>
        factsOf(`b-${index}`, "unresolved", "replayed"),
      ),
    ];
    const picked = drawAudit(facts, 10, 7);
    assert.strictEqual(picked.length, 20);
  });
});

describe("auditRow", () => {
  it("names both states when the current state disagrees", () => {
    const row = auditRow(factsOf("case-1", "readable"), factsOf("case-1", "unresolved"));
    assert.strictEqual(row.verdict, "mismatch");
    assert.strictEqual(row.expected, "readable");
    assert.strictEqual(row.actual, "unresolved");
  });

  it("matches when the states agree", () => {
    const row = auditRow(factsOf("case-1", "readable"), factsOf("case-1", "readable"));
    assert.strictEqual(row.verdict, "match");
  });
});
