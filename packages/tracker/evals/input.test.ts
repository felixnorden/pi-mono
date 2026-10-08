import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type { CandidateClass, CompactionCandidate } from "../src/compaction/candidate.ts";
import { buildDigests, compactQuestions } from "../src/compaction/digest.ts";
import type { StoredCase } from "./case-file.ts";
import { candidateViews, questionViews } from "./derive.ts";
import { candidatesOf, classifierInput, replayMatches } from "./input.ts";

const batch = [{ ref: "Work:1", text: "Cut the release branch" }];

const candidate = (
  id: number,
  text: string,
  cls: CandidateClass = "ready-queue",
  listName = "Work",
): CompactionCandidate => ({ class: cls, listName, id, text, completed: batch });

/** The inverse of `candidatesOf`: the stored case the harvest would have written. */
const stored = (candidates: readonly CompactionCandidate[]): StoredCase => ({
  caseId: "session.jsonl#0",
  session: { dir: "d", file: "session.jsonl" },
  at: "2026-01-01T00:00:00.000Z",
  index: 0,
  list: {
    id: 1,
    name: candidates[0]?.listName ?? "Work",
    items: candidates.map((entry) => ({
      id: entry.id,
      text: entry.text,
      done: false,
      deps: [],
    })),
  },
  completed: candidates[0]?.completed.map((item) => ({ ref: item.ref, text: item.text })) ?? [],
  candidates: candidateViews(buildDigests(candidates)),
  questions: questionViews(candidates),
  frontier: candidates.length,
  itemCount: candidates.length,
  openCount: candidates.length,
  doneCount: 0,
  declaredDeps: 0,
});

describe("candidatesOf", () => {
  it("rebuilds the judged candidates in decision order", () => {
    const candidates = [
      candidate(3, "Research the adapter", "dependent-successor"),
      candidate(4, "Write the outline"),
    ];
    assert.deepEqual(candidatesOf(stored(candidates)), candidates);
  });

  it("splits a list name that holds a colon", () => {
    const candidates = [candidate(7, "Approve the scope", "ready-queue", "Phase: Q")];
    const rebuilt = candidatesOf(stored(candidates));
    assert.strictEqual(rebuilt[0]?.listName, "Phase: Q");
    assert.strictEqual(rebuilt[0]?.id, 7);
  });

  it("gives every candidate the whole completed batch", () => {
    const candidates = [candidate(3, "a"), candidate(4, "b")];
    for (const rebuilt of candidatesOf(stored(candidates))) {
      assert.deepEqual(rebuilt.completed, batch);
    }
  });
});

describe("replayMatches", () => {
  it("accepts a case whose stored views reproduce", () => {
    assert.strictEqual(replayMatches(stored([candidate(3, "a"), candidate(4, "b")])), true);
  });

  it("accepts a case with no candidates", () => {
    assert.strictEqual(replayMatches(stored([])), true);
  });

  it("rejects a case whose candidate text was altered", () => {
    const caseFile = stored([candidate(3, "a")]);
    const altered = {
      ...caseFile,
      candidates: [{ ...caseFile.candidates[0]!, text: "something else" }],
    };
    assert.strictEqual(replayMatches(altered), false);
  });

  it("rejects a case whose completed batch was altered", () => {
    const caseFile = stored([candidate(3, "a")]);
    assert.strictEqual(replayMatches({ ...caseFile, completed: [] }), false);
  });

  it("rejects a case whose class was altered", () => {
    const caseFile = stored([candidate(3, "a", "dependent-successor")]);
    const altered = {
      ...caseFile,
      candidates: [{ ...caseFile.candidates[0]!, class: "ready-queue" }],
    };
    assert.strictEqual(replayMatches(altered), false);
  });
});

describe("classifierInput", () => {
  it("reproduces the digest and the questions", () => {
    const candidates = [candidate(3, "a", "dependent-successor"), candidate(4, "b")];
    const input = classifierInput(stored(candidates));
    assert.deepEqual(input.digest, buildDigests(candidates));
    assert.deepEqual(input.questions, compactQuestions(candidates));
    assert.strictEqual(input.questions.length, 2);
  });
});
