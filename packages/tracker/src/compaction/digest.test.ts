import { assert, it } from "@effect/vitest";
import { NEEDS_CONTEXT_LABEL, NEEDS_NONE_LABEL } from "./classifier.ts";
import type { CompactionCandidate } from "./candidate.ts";
import {
  DESCRIPTION_LIMIT,
  PRODUCT_CAP,
  QUESTION_KEY_PREFIX,
  REFERENCE_CAP,
  buildDigests,
  compactQuestions,
  questionKey,
} from "./digest.ts";
import type { ResolvedProduct, ResolvedReference } from "./observations.ts";

interface DigestShape {
  candidates: Array<{
    ref: string;
    text: string;
    description?: string;
    class: string;
    relationship: string;
    references: Array<Record<string, unknown>>;
    products: Array<Record<string, unknown>>;
    referenceCut?: string;
    productCut?: string;
  }>;
  completed: Array<{ ref: string; text: string; description?: string }>;
  survival: string;
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

const noFacts: readonly { references: []; products: [] }[] = [];

it("buildDigests carries only the candidates, the completed batch, and the survival instruction", () => {
  const digest = buildDigests([dependent], noFacts);
  assert.deepStrictEqual(Object.keys(digest).sort(), ["candidates", "completed", "survival"]);
});

it("buildDigests lists one entry per candidate with its class and relationship", () => {
  const digest = buildDigests([dependent, readyQueue], noFacts) as unknown as DigestShape;
  assert.deepStrictEqual(digest.candidates, [
    {
      ref: "Work:2",
      text: "second",
      class: "dependent-successor",
      relationship: "depends on Work:1",
      references: [],
      products: [],
    },
    {
      ref: "Work:3",
      text: "third",
      class: "ready-queue",
      relationship: "independent of Work:1",
      references: [],
      products: [],
    },
  ]);
});

it("buildDigests carries the completed batch once as prior work", () => {
  const digest = buildDigests([dependent, readyQueue], noFacts) as unknown as DigestShape;
  assert.deepStrictEqual(digest.completed, [{ ref: "Work:1", text: "first" }]);
});

// ---------------------------------------------------------------------------
// Slice 6: descriptions, declarations, and the survival instruction
// ---------------------------------------------------------------------------

it("buildDigests carries a long description as its first paragraph with a named cut", () => {
  const first = "a".repeat(DESCRIPTION_LIMIT + 50);
  const candidate: CompactionCandidate = {
    ...readyQueue,
    description: `${first}\n\nsecond paragraph`,
  };
  const digest = buildDigests([candidate], noFacts) as unknown as DigestShape;
  const description = digest.candidates[0]!.description!;
  assert.strictEqual(description, `${"a".repeat(DESCRIPTION_LIMIT)}… [50 more characters]`);
  assert.notInclude(description, "second paragraph");
});

it("buildDigests carries a description that is already one short paragraph unchanged", () => {
  const candidate: CompactionCandidate = { ...readyQueue, description: "one line" };
  const digest = buildDigests([candidate], noFacts) as unknown as DigestShape;
  assert.strictEqual(digest.candidates[0]!.description, "one line");
});

it("buildDigests caps references at eight and products at four with a marker", () => {
  const refs = Array.from({ length: 10 }, (_value, index) => ({
    kind: "path" as const,
    path: `src/f${index}.ts`,
  }));
  const produces = Array.from({ length: 6 }, (_value, index) => ({ path: `src/p${index}.ts` }));
  const references: ResolvedReference[] = refs.map((reference) => ({
    reference,
    state: "readable",
  }));
  const products: ResolvedProduct[] = produces.map((product) => ({ product, state: "exists" }));
  const digest = buildDigests(
    [{ ...readyQueue, refs, produces }],
    [{ references, products }],
  ) as unknown as DigestShape;
  const candidate = digest.candidates[0]!;
  assert.strictEqual(candidate.references.length, REFERENCE_CAP);
  assert.strictEqual(candidate.products.length, PRODUCT_CAP);
  assert.strictEqual(candidate.referenceCut, "… [2 more references declared]");
  assert.strictEqual(candidate.productCut, "… [2 more products declared]");
});

it("buildDigests carries a declared decision as a fact and never asserts it is archived", () => {
  const refs = [{ kind: "decision" as const, topic: "storage shape" }];
  const digest = buildDigests(
    [{ ...readyQueue, refs }],
    [{ references: [{ reference: refs[0]!, state: "unresolved" }], products: [] }],
  ) as unknown as DigestShape;
  assert.deepStrictEqual(digest.candidates[0]!.references, [
    { kind: "decision", topic: "storage shape", state: "unresolved" },
  ]);
  assert.notInclude(JSON.stringify(digest), "archived");
});

it("buildDigests carries the survival instruction and no transcript text", () => {
  const digest = buildDigests([dependent], noFacts) as unknown as DigestShape;
  assert.include(digest.survival, "transcript");
  assert.include(digest.survival, "description");
  assert.notInclude(JSON.stringify(digest), "assistant said");
  assert.notInclude(JSON.stringify(digest), "tool-call");
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
