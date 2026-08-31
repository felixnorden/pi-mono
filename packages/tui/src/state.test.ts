import { assert, it } from "@effect/vitest";
import type { FooterState } from "./state.ts";
import { activeWorkingMs, createInitialState, waitingMs } from "./state.ts";
import { GitStatus } from "./commands/git-status.ts";

it("createInitialState seeds git with an all-zero empty status", () => {
  assert.deepStrictEqual(createInitialState().git, GitStatus.empty());
});

it("createInitialState starts with no timers and no user-wait state", () => {
  const s = createInitialState();
  assert.strictEqual(s.workingSince, undefined);
  assert.strictEqual(s.lastDoneIn, undefined);
  assert.strictEqual(s.waitingSince, undefined);
  assert.strictEqual(s.waitingAccum, 0);
});

const base: FooterState = {
  git: GitStatus.empty(),
  runtime: null,
  sessionStartEpoch: 0,
  workingSince: 1000,
  lastDoneIn: undefined,
  waitingSince: undefined,
  waitingAccum: 0,
};

it("activeWorkingMs is the elapsed run time minus completed and in-flight waits", () => {
  // Run started at t=1s, nothing waited: 4s of work by t=5s.
  assert.strictEqual(activeWorkingMs(base, 5000), 4000);

  // A completed 2s wait must not count as work: 4000 - 2000 = 2000.
  assert.strictEqual(activeWorkingMs({ ...base, waitingAccum: 2000 }, 5000), 2000);

  // An in-flight wait from t=4s is excluded too: 4000 - 2000 - 1000 = 1000.
  assert.strictEqual(
    activeWorkingMs({ ...base, waitingAccum: 2000, waitingSince: 4000 }, 5000),
    1000,
  );
});

it("activeWorkingMs is 0 without an active run and clamps when waits exceed runtime", () => {
  assert.strictEqual(activeWorkingMs({ ...base, workingSince: undefined }, 5000), 0);
  assert.strictEqual(activeWorkingMs({ ...base, waitingAccum: 9000 }, 5000), 0);
});

it("waitingMs is the open-wait span and 0 when no prompt is open", () => {
  assert.strictEqual(waitingMs(base, 5000), 0);
  assert.strictEqual(waitingMs({ ...base, waitingSince: 4000 }, 5000), 1000);
  assert.strictEqual(waitingMs({ ...base, waitingSince: undefined }, 5000), 0);
});