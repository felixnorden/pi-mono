import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";
import { readJsonl } from "./case-file.ts";
import { LABEL_PASSES, partitionByPass, passOf, type LabelPass } from "./pass.ts";

const LABELS_PATH = fileURLToPath(new URL("data/labels.jsonl", import.meta.url));

describe("passOf", () => {
  it("splits the recorded cutoffs", () => {
    assert.strictEqual(passOf("2026-10-05T17:50:00.000Z"), "pass1");
    assert.strictEqual(passOf("2026-10-06T15:23:00.000Z"), "pass2");
    assert.strictEqual(passOf("2026-10-06T17:01:00.000Z"), "pass3");
  });

  it("counts a cutoff itself in the later pass", () => {
    assert.strictEqual(passOf("2026-10-06T00:00:00.000Z"), "pass2");
    assert.strictEqual(passOf("2026-10-06T17:00:00.000Z"), "pass3");
  });
});

describe("partitionByPass", () => {
  it("reproduces the recorded sizes", () => {
    const rows = readJsonl<{ readonly caseId: string; readonly at: string }>(LABELS_PATH);
    const parts = partitionByPass(rows);
    assert.strictEqual(parts.get("pass1")!.length, 811);
    assert.strictEqual(parts.get("pass2")!.length, 265);
    assert.strictEqual(parts.get("pass3")!.length, 309);

    // No case carries labels from two passes, so the case sets stay disjoint.
    const casesOf = (pass: LabelPass): ReadonlySet<string> =>
      new Set(parts.get(pass)!.map((row) => row.caseId));
    const first = casesOf("pass1");
    const second = casesOf("pass2");
    const third = casesOf("pass3");
    for (const other of [second, third]) {
      for (const caseId of other) assert.strictEqual(first.has(caseId), false, caseId);
    }
    for (const caseId of third) assert.strictEqual(second.has(caseId), false, caseId);
  });

  it("keeps every row and the pass order", () => {
    const rows = [
      { at: "2026-10-05T00:00:00.000Z" },
      { at: "2026-10-06T10:00:00.000Z" },
      { at: "2026-10-06T18:00:00.000Z" },
    ];
    const parts = partitionByPass(rows);
    assert.deepStrictEqual([...parts.keys()], [...LABEL_PASSES]);
    assert.deepStrictEqual(
      LABEL_PASSES.map((pass) => parts.get(pass)!.length),
      [1, 1, 1],
    );
  });
});
