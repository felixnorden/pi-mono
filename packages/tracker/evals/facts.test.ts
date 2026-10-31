import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";
import type { CompactionCandidate } from "../src/compaction/candidate.ts";
import type { ReplayProbe } from "./probe.ts";
import type { StoredCase, StoredDecision, StoredEvidence } from "./case-file.ts";
import {
  caseFacts,
  driftOf,
  factsDigest,
  formatPreflight,
  isDeclaredHead,
  preflight,
  type CaseFacts,
} from "./facts.ts";
import { sessionProbe } from "./probe.ts";

const scratch: string[] = [];

const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "facts-"));
  scratch.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A case whose head declares one path, unless `refs` says otherwise. */
const caseOf = (input?: {
  readonly refs?: readonly { readonly kind: "path"; readonly path: string }[];
  readonly produces?: readonly { readonly path: string }[];
  readonly decision?: StoredDecision;
  readonly secondRefs?: readonly { readonly kind: "path"; readonly path: string }[];
  readonly sessionCwd?: string;
}): StoredCase => ({
  caseId: "session/log.jsonl#0",
  session: { dir: "session", file: "log.jsonl" },
  at: "2026-10-01T00:00:02.000Z",
  index: 0,
  list: {
    id: 1,
    name: "Work",
    items: [
      { id: 1, text: "first", done: true, deps: [] },
      { id: 2, text: "second", done: false, deps: [] },
      { id: 3, text: "third", done: false, deps: [] },
    ],
  },
  completed: [{ ref: "Work:1", text: "first" }],
  candidates: [
    {
      ref: "Work:2",
      text: "second",
      class: "ready-queue",
      relationship: "independent of Work:1",
      ...(input?.refs === undefined ? {} : { refs: input.refs }),
      ...(input?.produces === undefined ? {} : { produces: input.produces }),
    },
    {
      ref: "Work:3",
      text: "third",
      class: "ready-queue",
      relationship: "independent of Work:1",
      ...(input?.secondRefs === undefined ? {} : { refs: input.secondRefs }),
    },
  ],
  questions: [
    { key: "k0", instructions: "Question?", criteria: {} },
    { key: "k1", instructions: "Question?", criteria: {} },
  ],
  frontier: 2,
  itemCount: 3,
  openCount: 2,
  doneCount: 1,
  declaredDeps: 0,
  ...(input?.decision === undefined ? {} : { decision: input.decision }),
  ...(input?.sessionCwd === undefined ? {} : { sessionCwd: input.sessionCwd }),
});

const evidenceOf = (): StoredEvidence => ({
  caseId: "session/log.jsonl#0",
  entries: [
    {
      kind: "tool-call",
      at: "2026-10-01T00:00:01.000Z",
      text: "read",
      name: "read",
      args: { path: "src/a.ts" },
    },
  ],
  omitted: 0,
});

/** A probe backed by a path-to-text map; a missing entry cannot be read. */
const probeOf = (files: Readonly<Record<string, string>>, available = true): ReplayProbe => ({
  available,
  read: (path) => files[path],
  findSymbol: () => [],
});

const readableCase = (dir: string): StoredCase =>
  caseOf({ refs: [{ kind: "path", path: "src/a.ts" }], sessionCwd: dir });

describe("isDeclaredHead", () => {
  it("rejects a description-only head", () => {
    const candidate = {
      class: "ready-queue",
      listName: "Work",
      id: 2,
      text: "second",
      description: "a detail",
      completed: [],
    } satisfies CompactionCandidate;
    assert.strictEqual(isDeclaredHead(candidate), false);
  });

  it("accepts a head with a reference or a product", () => {
    const base = {
      class: "ready-queue",
      listName: "Work",
      id: 2,
      text: "second",
      completed: [],
    } satisfies CompactionCandidate;
    assert.strictEqual(isDeclaredHead({ ...base, refs: [{ kind: "path", path: "a.ts" }] }), true);
    assert.strictEqual(isDeclaredHead({ ...base, produces: [{ path: "out.md" }] }), true);
  });
});

describe("caseFacts", () => {
  it("replays a declared row for a declared head without a live record", () => {
    const dir = tempDir();
    const facts = caseFacts(readableCase(dir), evidenceOf(), probeOf({ "src/a.ts": "text" }));
    assert.strictEqual(facts.head.row, "reference-is-readable");
    assert.strictEqual(facts.source, "replayed");
    assert.strictEqual(facts.promotable, true);
  });

  it("takes the live record when the replay matches it", () => {
    const dir = tempDir();
    const stored = caseOf({
      refs: [{ kind: "path", path: "src/a.ts" }],
      sessionCwd: dir,
      decision: {
        rule: "reference-is-readable",
        verdict: "compact",
        candidateRef: "Work:2",
        references: [{ kind: "path", path: "src/a.ts", state: "readable" }],
        products: [],
      },
    });
    const facts = caseFacts(stored, evidenceOf(), probeOf({ "src/a.ts": "text" }));
    assert.strictEqual(facts.source, "live");
    assert.strictEqual(facts.head.row, "reference-is-readable");
    assert.strictEqual(facts.mismatch, undefined);
  });

  it("names a replayed state that disagrees with the live record", () => {
    const dir = tempDir();
    const stored = caseOf({
      refs: [{ kind: "path", path: "src/a.ts" }],
      sessionCwd: dir,
      decision: {
        rule: "reference-is-readable",
        verdict: "compact",
        candidateRef: "Work:2",
        references: [{ kind: "path", path: "src/a.ts", state: "readable" }],
        products: [],
      },
    });
    const facts = caseFacts(stored, evidenceOf(), probeOf({}));
    assert.strictEqual(facts.source, "mismatch");
    assert.strictEqual(facts.promotable, false);
    assert.strictEqual(facts.mismatch?.caseId, stored.caseId);
    assert.strictEqual(facts.mismatch?.candidateRef, "Work:2");
    assert.strictEqual(facts.mismatch?.expected, "readable");
    assert.strictEqual(facts.mismatch?.actual, "unresolved");
  });

  it("marks a missing session cwd unresolved", () => {
    const stored = caseOf({
      refs: [{ kind: "path", path: "src/a.ts" }],
      sessionCwd: "/definitely/not/here",
    });
    const facts = caseFacts(stored, evidenceOf(), sessionProbe(stored.sessionCwd));
    assert.strictEqual(facts.source, "unresolved");
    assert.strictEqual(facts.promotable, false);
    assert.deepStrictEqual(facts.head.references, []);
  });

  it("marks non-head candidates diagnostic", () => {
    const dir = tempDir();
    const stored = caseOf({ sessionCwd: dir, secondRefs: [{ kind: "path", path: "src/a.ts" }] });
    const facts = caseFacts(stored, evidenceOf(), probeOf({ "src/a.ts": "text" }));
    assert.strictEqual(facts.head.row, "no-visible-link");
    assert.strictEqual(facts.diagnostics.length, 1);
    assert.strictEqual(facts.diagnostics[0]!.diagnostic, true);
    assert.strictEqual(facts.diagnostics[0]!.row, "reference-is-readable");
  });

  it("takes the legacy rows for a case with no declarations", () => {
    const dir = tempDir();
    const stored = caseOf({ sessionCwd: dir });
    const facts = caseFacts(stored, evidenceOf(), probeOf({}));
    assert.strictEqual(facts.head.row, "no-visible-link");
    assert.strictEqual(facts.head.verdict, "compact");
  });

  it("counts a description-only head as a control", () => {
    const dir = tempDir();
    const stored = caseOf({ sessionCwd: dir });
    const facts = caseFacts(
      {
        ...stored,
        candidates: stored.candidates.map((candidate, index) =>
          index === 0 ? { ...candidate, description: "detail" } : candidate,
        ),
      },
      evidenceOf(),
      probeOf({}),
    );
    assert.strictEqual(facts.declaredHead, false);
    assert.strictEqual(facts.promotable, true);
  });
});

describe("preflight", () => {
  const factsFiring = (count: number, row: string): readonly CaseFacts[] =>
    Array.from({ length: count }, (_, index) => {
      const facts = caseFacts(
        { ...readableCase("/tmp"), caseId: `case-${index}` },
        evidenceOf(),
        probeOf({ "src/a.ts": "text" }),
      );
      return { ...facts, head: { ...facts.head, row } };
    });

  it("stops a thin corpus", () => {
    const result = preflight(factsFiring(12, "reference-is-readable"));
    assert.strictEqual(result.stop, true);
    assert.strictEqual(
      result.rows.find((row) => row.row === "reference-is-readable")?.perPass,
      6,
    );
    assert.match(formatPreflight(result), /6 per pass/);
    assert.match(formatPreflight(result), /STOP:/);
  });

  it("passes a thick corpus", () => {
    const result = preflight(factsFiring(40, "reference-is-readable"));
    assert.strictEqual(result.stop, false);
    assert.strictEqual(
      result.rows.find((row) => row.row === "reference-is-readable")?.perPass,
      20,
    );
    assert.match(formatPreflight(result), /20 per pass/);
    assert.match(formatPreflight(result), /measured/);
  });
});

describe("driftOf", () => {
  it("counts a changed state without changing the frozen facts", () => {
    const dir = tempDir();
    const stored = readableCase(dir);
    const frozen = caseFacts(stored, evidenceOf(), probeOf({ "src/a.ts": "text" }));
    const recomputed = caseFacts(stored, evidenceOf(), probeOf({}));
    const report = driftOf([frozen], [recomputed]);
    assert.strictEqual(report.cases, 1);
    assert.deepStrictEqual(report.ids, [stored.caseId]);
    assert.strictEqual(frozen.head.references[0]!.state, "readable");
  });
});

describe("facts digest", () => {
  it("holds row and source totals but no case id and no path", () => {
    const dir = tempDir();
    const stored = readableCase(dir);
    const facts = caseFacts(stored, evidenceOf(), probeOf({ "src/a.ts": "text" }));
    const digest = factsDigest([facts], preflight([facts]));
    const text = JSON.stringify(digest);
    assert.ok(text.includes("reference-is-readable"));
    assert.ok(!text.includes(dir));
    assert.ok(!text.includes(stored.caseId));
  });
});
