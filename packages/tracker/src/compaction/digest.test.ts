import { assert, it } from "@effect/vitest";
import { NEEDS_CONTEXT_LABEL, NEEDS_NONE_LABEL } from "./classifier.ts";
import type { CompactionCandidate } from "./candidate.ts";
import {
  QUESTION_KEY_PREFIX,
  buildDigests,
  compactQuestions,
  questionKey,
} from "./digest.ts";

interface DigestShape {
  candidates: Array<{ ref: string; text: string; class: string; relationship: string }>;
  completed: Array<{ ref: string; text: string }>;
}

const dependent: CompactionCandidate = {
  class: "dependent-successor",
  listName: "Work",
  id: 2,
  text: "second",
  completed: [{ ref: "Work:1", text: "first" }],
};

const readyQueue: CompactionCandidate = {
  class: "ready-queue",
  listName: "Work",
  id: 3,
  text: "third",
  completed: [{ ref: "Work:1", text: "first" }],
};

it("buildDigests carries only the candidates and the completed batch", () => {
  const digest = buildDigests([dependent]);
  assert.deepStrictEqual(Object.keys(digest).sort(), ["candidates", "completed"]);
});

it("buildDigests lists one entry per candidate with its class and relationship", () => {
  const digest = buildDigests([dependent, readyQueue]) as unknown as DigestShape;
  assert.deepStrictEqual(digest.candidates, [
    { ref: "Work:2", text: "second", class: "dependent-successor", relationship: "depends on Work:1" },
    { ref: "Work:3", text: "third", class: "ready-queue", relationship: "independent of Work:1" },
  ]);
});

it("buildDigests carries the completed batch once as prior work", () => {
  const digest = buildDigests([dependent, readyQueue]) as unknown as DigestShape;
  assert.deepStrictEqual(digest.completed, [{ ref: "Work:1", text: "first" }]);
});

it("compactQuestions keys each question by its candidate reference and index", () => {
  const questions = compactQuestions([dependent, readyQueue]);
  assert.deepStrictEqual(
    questions.map((entry) => entry.key),
    [questionKey("Work:2", 0), questionKey("Work:3", 1)],
  );
  assert.strictEqual(questions[0]!.key, `${QUESTION_KEY_PREFIX}.Work_2.0`);
});

it("compactQuestions produces ids that satisfy the provider pattern", () => {
  const questions = compactQuestions([dependent, readyQueue]);
  for (const { key } of questions) {
    assert.match(key, /^[A-Za-z0-9_.-]{1,100}$/);
  }
});

it("compactQuestions asks one two-label choice question per candidate", () => {
  const questions = compactQuestions([dependent, readyQueue]);
  assert.strictEqual(questions.length, 2);
  for (const { question } of questions) {
    assert.strictEqual(question.type, "choice");
    if (question.type !== "choice") continue;
    assert.isAtLeast(question.instructions.length, 1);
    assert.deepStrictEqual(
      Object.keys(question.criteria).sort(),
      [NEEDS_CONTEXT_LABEL, NEEDS_NONE_LABEL].sort(),
    );
    assert.isAtLeast(question.criteria[NEEDS_CONTEXT_LABEL]!.length, 1);
    assert.isAtLeast(question.criteria[NEEDS_NONE_LABEL]!.length, 1);
  }
});

it("compactQuestions uses the class-specific wording", () => {
  const [dependentQuestion, queueQuestion] = compactQuestions([dependent, readyQueue]);
  assert.include(dependentQuestion!.question.instructions, "depends on");
  assert.include(queueQuestion!.question.instructions, "completed work");
  assert.notStrictEqual(
    dependentQuestion!.question.instructions,
    queueQuestion!.question.instructions,
  );
});
