import { assert, it } from "@effect/vitest";
import type { CompactionCandidate } from "./candidate.ts";
import { resumePointer } from "./pointer.ts";

const candidate: CompactionCandidate = {
  class: "dependent-successor",
  listName: "Work",
  id: 4,
  text: "third slice",
  completed: [{ ref: "Work:1", text: "first slice" }],
};

it("resumePointer names the next ready item", () => {
  const pointer = resumePointer(candidate);
  assert.isTrue(pointer.includes("Work:4"));
  assert.isTrue(pointer.includes("third slice"));
});

it("resumePointer reads as a continuation of the current work", () => {
  const pointer = resumePointer(candidate);
  assert.isTrue(pointer.includes("Work"));
  assert.isTrue(pointer.includes("compacted"));
  // A continuation, not a new request: it must not open by soliciting new work.
  assert.isFalse(pointer.toLowerCase().includes("please"));
  assert.isFalse(pointer.toLowerCase().includes("new task"));
});
