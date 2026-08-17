import { Context, Duration, Effect, Layer, Schema, Stream, PlatformError } from "effect";
import * as CP from "effect/unstable/process";

/** Fixed per-invocation time cap applied to every git command (2 seconds). */
export const GIT_EXECUTION_CAP: Duration.Duration = Duration.seconds(2);

/**
 * The stdout and exit code of a single command invocation.
 *
 * A non-zero exit code is data, not an effect failure: only platform-level
 * failures (missing executable, unusable working directory, cap firing) fail
 * the effect, as {@link GitSpawnError} or {@link GitTimeoutError}. Interpreting
 * the exit code is the caller's concern.
 */
export interface CommandResult {
  readonly stdout: string;
  readonly exitCode: number;
}

/** A git invocation failed at the platform level (spawn, working directory, ...). */
export class GitSpawnError extends Schema.TaggedError<GitSpawnError>()("GitSpawnError", {
  command: Schema.String,
  message: Schema.String,
}) {}

/** A git invocation exceeded the execution cap; the hung child is interrupted. */
export class GitTimeoutError extends Schema.TaggedError<GitTimeoutError>()("GitTimeoutError", {
  command: Schema.String,
  durationMillis: Schema.Finite,
}) {}

/** Error union of the execution service: platform failures and cap firing. */
export type GitExecutionError = GitSpawnError | GitTimeoutError;

/** Apply the cap to one invocation and map the timeout to a tagged error. */
const withCap = <E extends GitExecutionError>(
  cap: Duration.Input,
  command: string,
  effect: Effect.Effect<CommandResult, E, never>,
): Effect.Effect<CommandResult, GitExecutionError, never> =>
  effect.pipe(
    Effect.timeout(cap),
    Effect.catchTag("TimeoutError", () =>
      Effect.fail(new GitTimeoutError({ command, durationMillis: Duration.toMillis(cap) })),
    ),
  );

/**
 * Executes one command in a working directory and returns its stdout and exit
 * code. Every invocation is capped at {@link GIT_EXECUTION_CAP}; a timeout
 * interrupts the child and fails with {@link GitTimeoutError}, and platform
 * failures map to {@link GitSpawnError}.
 */
export class GitExecutionService extends Context.Service<
  GitExecutionService,
  {
    /**
     * Runs one command with the given args in `cwd` and returns the captured
     * stdout plus the exit code of that single invocation.
     */
    readonly run: (
      command: string,
      args: ReadonlyArray<string>,
      cwd: string,
    ) => Effect.Effect<CommandResult, GitExecutionError, never>;
  }
>()("tui/git/GitExecutionService") {
  /**
   * The real execution service over the platform
   * `ChildProcessSpawner.ChildProcessSpawner`.
   *
   * @param cap - override the default execution cap (tests inject shorter caps)
   */
  static make(
    cap: Duration.Input = GIT_EXECUTION_CAP,
  ): Layer.Layer<GitExecutionService, never, CP.ChildProcessSpawner.ChildProcessSpawner> {
    return Layer.effect(
      GitExecutionService,
      Effect.gen(function* () {
        const spawner = yield* CP.ChildProcessSpawner.ChildProcessSpawner;
        const run = Effect.fn("GitExecutionService.run")(function* (
          command: string,
          args: ReadonlyArray<string>,
          cwd: string,
        ) {
          const commandEffect = Effect.scoped(
            Effect.gen(function* () {
              const handle = yield* spawner.spawn(CP.ChildProcess.make(command, args, { cwd }));
              const stdout = yield* Stream.mkString(Stream.decodeText(handle.stdout));
              const exitCode = yield* handle.exitCode;
              return { stdout, exitCode };
            }),
          );
          return yield* withCap(
            cap,
            command,
            commandEffect.pipe(
              Effect.mapError(
                (err: PlatformError.PlatformError) =>
                  new GitSpawnError({ command, message: err.message }),
              ),
            ),
          );
        });
        return GitExecutionService.of({ run });
      }),
    );
  }

  /** The real execution service over the platform spawner, with the default 2-second cap. */
  static readonly layer: Layer.Layer<
    GitExecutionService,
    never,
    CP.ChildProcessSpawner.ChildProcessSpawner
  > = GitExecutionService.make();

  /**
   * A stub execution service for tests, keyed by exact command + args.
   * See {@link makeStubLayer} for the behavior contract.
   */
  static readonly layerStub = (
    entries: ReadonlyArray<StubEntry>,
    cap: Duration.Input = GIT_EXECUTION_CAP,
  ): Layer.Layer<GitExecutionService> => makeStubLayer(entries, cap);
}

/**
 * A scripted response for one exact command + args pair in the stub layer.
 * The `cwd` argument of the invocation is ignored: responses are keyed by
 * command + args only.
 */
export interface StubCommand {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly stdout: string;
  readonly exitCode: number;
}

/**
 * A stub-layer entry: either a scripted response, or a marker that the
 * invocation never completes (so the execution cap can be exercised).
 */
export type StubEntry =
  | StubCommand
  | {
      readonly command: string;
      readonly args: ReadonlyArray<string>;
      readonly neverCompletes: true;
    };

/**
 * Builds a stub {@link GitExecutionService} for tests, replacing the platform
 * spawner entirely (no real processes are started).
 *
 * - Responses are looked up by exact command + args; an unlisted command fails
 *   loudly with {@link GitSpawnError} ("fail fast": a test that forgot to
 *   script an invocation never passes silently).
 * - `neverCompletes` entries hang until the cap fires, exercising the timeout
 *   path without a real spawner.
 * - The same cap wrapping as the real layer applies, so the default 2-second
 *   cap (or an injected shorter one) behaves identically.
 */
export const makeStubLayer = (
  entries: ReadonlyArray<StubEntry>,
  cap: Duration.Input = GIT_EXECUTION_CAP,
): Layer.Layer<GitExecutionService> =>
  Layer.effect(
    GitExecutionService,
    Effect.sync(() => {
      const lookup = (command: string, args: ReadonlyArray<string>): StubEntry | undefined =>
        entries.find(
          (entry) =>
            entry.command === command &&
            entry.args.length === args.length &&
            entry.args.every((arg, i) => arg === args[i]),
        );
      const run = Effect.fn("GitExecutionService.stubRun")(function* (
        command: string,
        args: ReadonlyArray<string>,
        _cwd: string,
      ) {
        const entry = lookup(command, args);
        if (entry === undefined) {
          return yield* new GitSpawnError({
            command,
            message: `no stub response for ${command} ${args.join(" ")}`,
          });
        }
        if ("neverCompletes" in entry) {
          return yield* Effect.never;
        }
        return { stdout: entry.stdout, exitCode: entry.exitCode };
      });
      return GitExecutionService.of({
        run: (command, args, cwd) => withCap(cap, command, run(command, args, cwd)),
      });
    }),
  );
