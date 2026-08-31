import { assert, it } from "@effect/vitest";
import type { FooterState } from "./state.ts";
import { createInitialState } from "./state.ts";
import { GitStatus } from "./commands/git-status.ts";

it("createInitialState seeds git with an all-zero empty status", () => {
  assert.deepStrictEqual(createInitialState().git, GitStatus.empty());
});

it("createInitialState starts with a fresh tracker and no done figure", () => {
  const s: FooterState = createInitialState();
  assert.strictEqual(s.lastDoneIn, undefined);
  assert.strictEqual(s.tracker.isRunOpen(), false);
  assert.strictEqual(s.tracker.isWaiting(), false);
  assert.deepStrictEqual(s.tracker.breakdown(0), { inference: 0, tool: 0, wait: 0, total: 0 });
});