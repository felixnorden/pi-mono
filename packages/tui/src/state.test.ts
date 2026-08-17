import { assert, it } from "@effect/vitest";
import { createInitialState } from "./state.ts";
import { GitStatus } from "./commands/git-status.ts";

it("createInitialState seeds git with an all-zero empty status", () => {
  assert.deepStrictEqual(createInitialState().git, GitStatus.empty());
});
