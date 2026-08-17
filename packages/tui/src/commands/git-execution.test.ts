import { assert, it } from "@effect/vitest";
import { Duration, Effect } from "effect";
import {
  GIT_EXECUTION_CAP,
  GitExecutionService,
  GitSpawnError,
  GitTimeoutError,
} from "./git-execution.ts";

it.effect("run returns stdout and exit code from a stub response", () =>
  Effect.gen(function* () {
    const svc = yield* GitExecutionService;
    const r = yield* svc.run("git", ["status"], "/cwd");
    assert.deepStrictEqual(r, { stdout: "## main\n", exitCode: 0 });
  }).pipe(
    Effect.provide(
      GitExecutionService.layerStub([
        { command: "git", args: ["status"], stdout: "## main\n", exitCode: 0 },
      ]),
    ),
  ),
);

it.effect("run fails with GitSpawnError for a command with no stub response", () =>
  Effect.gen(function* () {
    const svc = yield* GitExecutionService;
    const tag = yield* svc.run("git", ["status"], "/cwd").pipe(
      Effect.match({
        onFailure: (err) => err._tag,
        onSuccess: () => "unexpected-success",
      }),
    );
    assert.strictEqual(tag, "GitSpawnError");
  }).pipe(Effect.provide(GitExecutionService.layerStub([]))),
);

it.live("run fails with GitTimeoutError when the cap fires on a never-completing invocation", () =>
  Effect.gen(function* () {
    const svc = yield* GitExecutionService;
    const tag = yield* svc.run("git", ["hang"], "/cwd").pipe(
      Effect.match({
        onFailure: (err) => err._tag,
        onSuccess: () => "unexpected-success",
      }),
    );
    assert.strictEqual(tag, "GitTimeoutError");
  }).pipe(
    Effect.provide(
      GitExecutionService.layerStub(
        [{ command: "git", args: ["hang"], neverCompletes: true }],
        "10 millis",
      ),
    ),
  ),
);

it("the default execution cap is the fixed 2-second constant", () => {
  assert.strictEqual(Duration.toMillis(GIT_EXECUTION_CAP), 2000);
});

it("GitSpawnError and GitTimeoutError carry the expected tags", () => {
  const spawnErr = new GitSpawnError({ command: "git", message: "boom" });
  assert.strictEqual(spawnErr._tag, "GitSpawnError");
  assert.instanceOf(spawnErr, GitSpawnError);

  const timeoutErr = new GitTimeoutError({ command: "git", durationMillis: 2000 });
  assert.strictEqual(timeoutErr._tag, "GitTimeoutError");
  assert.instanceOf(timeoutErr, GitTimeoutError);
});
