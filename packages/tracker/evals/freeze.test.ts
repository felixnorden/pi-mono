import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "vitest";
import { buildReport, freezeCorpus } from "./freeze.ts";

const fixture = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "freeze-"));
  writeFileSync(
    join(dir, "manifest.json"),
    `${JSON.stringify({
      generatedAt: "2026-10-24T12:00:00.000Z",
      trackerVersion: "0.7.0",
      format: "declared",
      formatRule: "a case is declared when its snapshot holds a declared key",
      formatCounts: { snapshotRule: 935, completedItemRule: 935 },
      excluded: { legacy: 1672, declared: 0 },
      events: { total: 935 },
      source: { from: "2026-08-11T00:18:44.218Z", to: "2026-10-25T11:44:33.838Z" },
    })}\n`,
  );
  writeFileSync(
    join(dir, "sample.json"),
    `${JSON.stringify({
      corpus: "v2",
      createdAt: "2026-10-24T12:00:00.000Z",
      seed: 7,
      target: 660,
      targetPerRowPerPass: 25,
      floorPerRowPerPass: 10,
      unmeasurable: ["product-is-unwritten-plan"],
      belowQuota: ["reference-is-readable"],
      pilot: ["p1"],
      passes: {
        "v2-a": { sittings: [{ cards: ["a", "b"], seededWith: ["p1"] }] },
        "v2-b": { sittings: [{ cards: ["c"], seededWith: ["p1"] }] },
      },
    })}\n`,
  );
  writeFileSync(
    join(dir, "facts.jsonl"),
    `${JSON.stringify({ caseId: "a", at: "t", sessionCwd: "/tmp", source: "replayed", promotable: true, declaredHead: true, head: { questionKey: "k0", candidateRef: "Work:2", row: "reference-is-readable", verdict: "compact", references: [], products: [], diagnostic: false }, diagnostics: [] })}\n`,
  );
  writeFileSync(
    join(dir, "labels.jsonl"),
    [
      { caseId: "a", key: "k0", label: "stands-alone", at: "2026-10-24T13:00:00.000Z", pass: "v2-a" },
      { caseId: "b", key: "k0", label: "needs-context", at: "2026-10-24T13:01:00.000Z", pass: "v2-a" },
      { caseId: "p1", key: "k0", label: "stands-alone", at: "2026-10-24T13:02:00.000Z", pass: "v2-a", pilot: true },
    ]
      .map((row) => JSON.stringify(row))
      .join("\n")
      .concat("\n"),
  );
  writeFileSync(
    join(dir, "surprises.jsonl"),
    `${JSON.stringify({ caseId: "a", questionKey: "k0", rule: "reference-is-readable", label: "stands-alone", at: "t" })}\n`,
  );
  writeFileSync(
    join(dir, "audit.jsonl"),
    `${JSON.stringify({ caseId: "a", row: "reference-is-readable", verdict: "mismatch", expected: "readable", actual: "unresolved" })}\n`,
  );
  writeFileSync(
    join(dir, "gate.json"),
    `${JSON.stringify({
      passes: { list: ["v2-a", "v2-b"], source: "v2-a, v2-b" },
      base: "controls",
      sources: { live: 8, replayed: 226, mismatch: 11, unresolved: 691 },
      rows: [
        {
          rule: "reference-is-readable",
          verdict: "compact",
          accepted: false,
          passes: [
            { pass: "v2-a", labeled: 10, agreement: 0.9, base: 0.5, lift: 0.4, qualifies: false },
          ],
        },
      ],
      accepted: [],
      promotion: [],
    })}\n`,
  );
  return dir;
};

describe("buildReport", () => {
  it("names the outcome and copies the numbers it read", () => {
    const dir = fixture();
    try {
      const report = buildReport(dir);
      assert.match(report, /no behavior-changing row cleared/);
      assert.match(report, /v2-a/);
      assert.match(report, /1672/);
      assert.match(report, /935/);
      assert.match(report, /1 mismatch/);
      assert.match(report, /surprises: 1/);
      assert.match(report, /reference-is-readable/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("accepts a declared row and names its verdict", () => {
    const dir = fixture();
    try {
      writeFileSync(
        join(dir, "gate.json"),
        `${JSON.stringify({
          passes: { list: ["v2-a", "v2-b"], source: "sample" },
          base: "controls",
          sources: { live: 8, replayed: 226, mismatch: 11, unresolved: 691 },
          rows: [
            {
              rule: "reference-is-readable",
              verdict: "compact",
              accepted: true,
              passes: [{ pass: "v2-a", labeled: 25, agreement: 1, base: 0.5, lift: 0.5, qualifies: true }],
            },
          ],
          accepted: ["reference-is-readable"],
          promotion: ["no-visible-link", "reference-is-readable"],
        })}\n`,
      );
      assert.match(buildReport(dir), /accepted: reference-is-readable \(compact\)/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("freezeCorpus", () => {
  it("writes three hashes and refuses a second freeze without force", () => {
    const dir = fixture();
    try {
      const frozen = freezeCorpus(dir, false);
      assert.match(frozen.manifestHash, /^[0-9a-f]{64}$/);
      assert.match(frozen.sampleHash, /^[0-9a-f]{64}$/);
      assert.match(frozen.factsHash, /^[0-9a-f]{64}$/);
      assert.throws(() => freezeCorpus(dir, false), /already frozen/);
      assert.doesNotThrow(() => freezeCorpus(dir, true));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("selfAgreement", () => {
  it("pairs a blind repeat with the pilot sitting's ordinary label", async () => {
    const { selfAgreement } = await import("./freeze.ts");
    const labels = [
      { caseId: "p", key: "k0", label: "stands-alone", at: "t", pass: "pilot" },
      { caseId: "p", key: "k0", label: "stands-alone", at: "t", pass: "v2-a", pilot: true },
      { caseId: "q", key: "k0", label: "needs-context", at: "t", pass: "pilot" },
      { caseId: "q", key: "k0", label: "stands-alone", at: "t", pass: "v2-b", pilot: true },
    ] as unknown as import("./labeling.ts").LabelRecord[];
    assert.deepStrictEqual(selfAgreement(labels), { pairs: 2, agreed: 1 });
  });
});
