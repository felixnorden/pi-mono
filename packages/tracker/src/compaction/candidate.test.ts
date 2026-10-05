import { assert, it } from "@effect/vitest";
import { selectCandidates, type CompactionCandidate } from "./candidate.ts";
import type { PendingCompletion } from "./completion.ts";
import { TodoItem, TodoList } from "../core/domain.ts";

interface ItemSpec {
  readonly id: number;
  readonly done: boolean;
  readonly text?: string;
  readonly deps?: readonly string[];
}

const completion = (
  items: readonly ItemSpec[],
  completedItemIds: readonly number[],
): PendingCompletion => {
  const list = new TodoList({
    id: 1,
    name: "Work",
    items: items.map(
      (item) =>
        new TodoItem({
          id: item.id,
          text: item.text ?? `item ${item.id}`,
          done: item.done,
          deps: [...(item.deps ?? [])],
        }),
    ),
    nextItemId: items.reduce((max, item) => Math.max(max, item.id), 0) + 1,
  });
  return { list, completedItemIds };
};

/** The primary candidate: the first entry, which the pointer names. */
const first = (pending: PendingCompletion, limit = 8): CompactionCandidate => {
  const candidates = selectCandidates(pending, limit);
  assert.isAtLeast(candidates.length, 1);
  return candidates[0]!;
};

it("selectCandidates prefers the first ready dependent successor", () => {
  const candidate = first(
    completion(
      [
        { id: 1, done: true },
        { id: 2, done: false, deps: ["Work:1"] },
        { id: 3, done: false },
      ],
      [1],
    ),
  );
  assert.strictEqual(candidate.id, 2);
  assert.strictEqual(candidate.class, "dependent-successor");
});

it("selectCandidates skips a dependent successor that is still blocked", () => {
  const candidate = first(
    completion(
      [
        { id: 1, done: true },
        { id: 2, done: false, deps: ["Work:1", "Work:4"] },
        { id: 3, done: false },
        { id: 4, done: false },
      ],
      [1],
    ),
  );
  assert.strictEqual(candidate.id, 3);
  assert.strictEqual(candidate.class, "ready-queue");
});

it("selectCandidates considers every item in the completed batch", () => {
  const candidate = first(
    completion(
      [
        { id: 1, done: true },
        { id: 2, done: false },
        { id: 3, done: true },
        { id: 4, done: false, deps: ["Work:3"] },
      ],
      [1, 3],
    ),
  );
  assert.strictEqual(candidate.id, 4);
  assert.strictEqual(candidate.class, "dependent-successor");
});

it("selectCandidates falls back to the first remaining ready item in list order", () => {
  const candidate = first(
    completion(
      [
        { id: 1, done: true },
        { id: 3, done: false },
        { id: 4, done: false },
      ],
      [1],
    ),
  );
  assert.strictEqual(candidate.id, 3);
  assert.strictEqual(candidate.class, "ready-queue");
});

it("selectCandidates excludes every completed item from the fallback", () => {
  const candidate = first(
    completion(
      [
        { id: 1, done: false },
        { id: 2, done: false },
        { id: 3, done: false },
      ],
      [1, 2],
    ),
  );
  assert.strictEqual(candidate.id, 3);
  assert.notStrictEqual(candidate.id, 1);
  assert.notStrictEqual(candidate.id, 2);
});

it("selectCandidates returns an empty array when nothing is ready", () => {
  const candidates = selectCandidates(
    completion(
      [
        { id: 1, done: true },
        { id: 2, done: false, deps: ["Work:9"] },
      ],
      [1],
    ),
    8,
  );
  assert.deepStrictEqual(candidates, []);
});

it("selectCandidates carries the completed batch as prior work", () => {
  const candidate = first(
    completion(
      [
        { id: 1, done: true, text: "first" },
        { id: 3, done: true, text: "third" },
        { id: 4, done: false, text: "fourth", deps: ["Work:3"] },
      ],
      [1, 3],
    ),
  );
  assert.deepStrictEqual(candidate.completed, [
    { ref: "Work:1", text: "first" },
    { ref: "Work:3", text: "third" },
  ]);
  assert.strictEqual(candidate.id, 4);
});

it("selectCandidates orders dependent successors before the ready queue", () => {
  const candidates = selectCandidates(
    completion(
      [
        { id: 1, done: true },
        { id: 2, done: false, deps: ["Work:1"] },
        { id: 3, done: false },
        { id: 4, done: false, deps: ["Work:1"] },
      ],
      [1],
    ),
    8,
  );
  assert.deepStrictEqual(
    candidates.map((candidate) => candidate.id),
    [2, 4, 3],
  );
  assert.deepStrictEqual(
    candidates.map((candidate) => candidate.class),
    ["dependent-successor", "dependent-successor", "ready-queue"],
  );
});

it("selectCandidates caps the judged set at the limit, dependents first", () => {
  const candidates = selectCandidates(
    completion(
      [
        { id: 1, done: true },
        { id: 2, done: false },
        { id: 3, done: false, deps: ["Work:1"] },
        { id: 4, done: false },
      ],
      [1],
    ),
    2,
  );
  assert.deepStrictEqual(
    candidates.map((candidate) => candidate.id),
    [3, 2],
  );
});
