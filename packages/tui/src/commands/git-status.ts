import { Context, Effect, Layer, Match, Schema } from "effect";
import {
  GitExecutionService,
  type CommandResult,
  type GitExecutionError,
} from "./git-execution.ts";

// ---------------------------------------------------------------------------
// Domain records
// ---------------------------------------------------------------------------

/**
 * Detached-HEAD commit information: the full oid, the detached flag, and the
 * exact-matching tag when one exists (each degraded to `null` on read failure).
 */
export class GitCommitInfo extends Schema.Class<GitCommitInfo>("tui/git/GitCommitInfo")({
  oid: Schema.NullOr(Schema.String),
  detached: Schema.Boolean,
  tag: Schema.NullOr(Schema.String),
}) {}

/**
 * The git status record the footer consumes: branch, ahead/behind counts,
 * working-tree counts, stash count, and detached-HEAD commit info.
 */
export class GitStatus extends Schema.Class<GitStatus>("tui/git/GitStatus")({
  branch: Schema.optional(Schema.String),
  ahead: Schema.Finite,
  behind: Schema.Finite,
  modified: Schema.Finite,
  untracked: Schema.Finite,
  staged: Schema.Finite,
  stashed: Schema.Finite,
  conflicted: Schema.Finite,
  renamed: Schema.Finite,
  deleted: Schema.Finite,
  commit: Schema.NullOr(GitCommitInfo),
}) {
  /** A fresh all-zero status: no branch, no changes, no commit info. */
  static empty() {
    return GitStatus.make({
      branch: undefined,
      ahead: 0,
      behind: 0,
      modified: 0,
      untracked: 0,
      staged: 0,
      stashed: 0,
      conflicted: 0,
      renamed: 0,
      deleted: 0,
      commit: null,
    });
  }
}

/** A parsed `## ...` branch header from porcelain v1 output. */
export class ParsedBranch extends Schema.Class<ParsedBranch>("tui/git/ParsedBranch")({
  detached: Schema.Boolean,
  name: Schema.optional(Schema.String), // undefined when detached
  ahead: Schema.Finite,
  behind: Schema.Finite,
}) {}

// Compiled once at module load; reused across calls (stateless, no `g` flag).
const BRANCH_NAME_PATTERN = /^(\S+?)(?:\.\.\.\S+)?(?:\s+\[.*\])?\s*$/;
const AHEAD_PATTERN = /\bahead (\d+)/;
const BEHIND_PATTERN = /\bbehind (\d+)/;

/**
 * Parses a `## ...` branch header line: detached HEAD, branch name (with or
 * without an `...upstream` reference), and ahead/behind divergence counts.
 */
export function parseBranchLine(line: string): ParsedBranch {
  const branchPart = line.startsWith("## ") ? line.slice(3) : line;
  if (branchPart.startsWith("HEAD (no branch)")) {
    return ParsedBranch.make({ detached: true, name: undefined, ahead: 0, behind: 0 });
  }
  const nameMatch = BRANCH_NAME_PATTERN.exec(branchPart);
  const aheadMatch = AHEAD_PATTERN.exec(branchPart);
  const behindMatch = BEHIND_PATTERN.exec(branchPart);
  return ParsedBranch.make({
    detached: false,
    name: nameMatch?.[1] ?? undefined,
    ahead: aheadMatch ? Number(aheadMatch[1]) : 0,
    behind: behindMatch ? Number(behindMatch[1]) : 0,
  });
}

// Mutable fields: `parseFileLines` counts into the instance, like the legacy
// counters did. All other records are built immutably via `make`/spread.
/**
 * Porcelain v1 file-status counters with the footer's counting semantics:
 * each status line increments one or two of the six buckets.
 */
export class FileCounts extends Schema.Class<FileCounts>("tui/git/FileCounts")({
  modified: Schema.mutableKey(Schema.Finite),
  untracked: Schema.mutableKey(Schema.Finite),
  staged: Schema.mutableKey(Schema.Finite),
  conflicted: Schema.mutableKey(Schema.Finite),
  renamed: Schema.mutableKey(Schema.Finite),
  deleted: Schema.mutableKey(Schema.Finite),
}) {
  /** A fresh all-zero counts record. */
  static empty() {
    return FileCounts.make({
      modified: 0,
      untracked: 0,
      staged: 0,
      conflicted: 0,
      renamed: 0,
      deleted: 0,
    });
  }
}

/**
 * Counts porcelain v1 file-status lines into per-field totals, skipping the
 * `##` branch header and empty lines.
 */
export function parseFileLines(lines: ReadonlyArray<string>): FileCounts {
  const counts = FileCounts.empty();
  for (const line of lines) {
    if (line.length < 3 || line.startsWith("#")) continue; // skip empty and header lines
    const x = line[0]!;
    const y = line[1]!;
    if (x === "U" || y === "U" || (x === "C" && y === "C")) counts.conflicted++;
    else if (x === "?" && y === "?") counts.untracked++;
    else if (x === "R") counts.renamed++;
    else if (x === "D" || y === "D") counts.deleted++;
    else {
      if (x !== " " && x !== "?") counts.staged++;
      if (y === "M" || y === "D") counts.modified++;
    }
  }
  return counts;
}

/**
 * Counts `git stash list` entries by counting non-empty lines; empty output
 * (no stashes) yields 0. The count contract only — subjects are not parsed.
 */
export function parseStashCount(output: string): number {
  if (output.trim() === "") return 0;
  return output.split("\n").filter((line) => line.trim() !== "").length;
}

// ---------------------------------------------------------------------------
// Status service
// ---------------------------------------------------------------------------

/**
 * The primary status invocation exited non-zero with unexpected non-empty
 * output. (A non-zero exit with empty stdout is the silent not-a-repository
 * case and returns the empty status instead of this error.)
 */
export class GitStatusError extends Schema.TaggedError<GitStatusError>()("GitStatusError", {
  cwd: Schema.String,
  command: Schema.String,
  exitCode: Schema.Int,
  stdout: Schema.String,
}) {}

/** Error union surfaced by the status service to its callers. */
export type GitError = GitExecutionError | GitStatusError;

/**
 * Options for {@link GitStatusService.read}. `readTag` gates the detached-HEAD
 * tag lookup (default off); the commit-id lookup always runs when detached.
 */
export interface GitStatusOptions {
  readonly readTag?: boolean; // read the tag when the head is detached (default off)
}

const PRIMARY_COMMAND = "git status --porcelain=v1 --branch --show-stash";
const PRIMARY_ARGS: ReadonlyArray<string> = [
  "status",
  "--porcelain=v1",
  "--branch",
  "--show-stash",
];

const TerminalOutcome = Schema.TaggedStruct("Terminal", { status: GitStatus });
const ContinueOutcome = Schema.TaggedStruct("Continue", { status: GitStatus });
/** Outcome of interpreting the primary invocation: stop, or continue with the secondary reads. */
const PrimaryOutcome = Schema.Union([TerminalOutcome, ContinueOutcome]);
type PrimaryOutcome = typeof PrimaryOutcome.Type;

/**
 * Owns the git domain logic on top of {@link GitExecutionService}: the four
 * invocations, exit-code interpretation, per-field degradation, and the
 * {@link GitStatus} record the footer consumes.
 */
export class GitStatusService extends Context.Service<
  GitStatusService,
  {
    /**
     * Reads the git status for `cwd`: primary status invocation, unconditional
     * stash count, then (when detached) the commit id and optionally the tag.
     * Primary failures surface as {@link GitError}; secondary-read failures
     * degrade their own field instead of aborting.
     */
    readonly read: (
      cwd: string,
      options?: GitStatusOptions,
    ) => Effect.Effect<GitStatus, GitError, GitExecutionService>;
  }
>()("tui/git/GitStatusService") {
  /** The status service over the execution service. */
  static readonly layer = Layer.effect(
    GitStatusService,
    Effect.gen(function* () {
      const exec = yield* GitExecutionService;
      // One git invocation through the execution service.
      const git = Effect.fn("GitStatusService.runGit")(function* (
        args: ReadonlyArray<string>,
        cwd: string,
      ) {
        return yield* exec.run("git", args, cwd);
      });

      // Exit-code interpretation boundary plus branch/file parsing.
      const interpretPrimary = Effect.fn("GitStatusService.interpretPrimary")(function* (
        primary: CommandResult,
        cwd: string,
      ): Effect.fn.Return<PrimaryOutcome, GitStatusError> {
        if (primary.exitCode !== 0) {
          if (primary.stdout.trim() === "") {
            // Not a repository / no output: silent empty status.
            return TerminalOutcome.make({ status: GitStatus.empty() });
          }
          return yield* new GitStatusError({
            cwd,
            command: PRIMARY_COMMAND,
            exitCode: primary.exitCode,
            stdout: primary.stdout,
          });
        }

        let status = GitStatus.empty();
        const lines = primary.stdout.split("\n");
        const branchLine = lines.find((line) => line.startsWith("## "));
        if (branchLine) {
          const parsed = parseBranchLine(branchLine);
          if (parsed.detached) {
            status = GitStatus.make({
              ...status,
              commit: GitCommitInfo.make({ oid: null, detached: true, tag: null }),
            });
          } else {
            status = GitStatus.make({
              ...status,
              branch: parsed.name,
              ahead: parsed.ahead,
              behind: parsed.behind,
            });
          }
        }
        const counts = parseFileLines(lines);
        return ContinueOutcome.make({
          status: GitStatus.make({
            ...status,
            ...counts,
          }),
        });
      });

      // Secondary reads: each degrades its own field on any failure.
      const readStash = Effect.fn("GitStatusService.readStash")(function* (cwd: string) {
        const result = yield* git(["stash", "list"], cwd).pipe(
          Effect.orElseSucceed(() => ({ stdout: "", exitCode: 0 })),
        );
        return parseStashCount(result.stdout);
      });

      const readCommitOid = Effect.fn("GitStatusService.readCommitOid")(function* (cwd: string) {
        const result = yield* git(["rev-parse", "HEAD"], cwd).pipe(
          Effect.orElseSucceed(() => ({ stdout: "", exitCode: 0 })),
        );
        return result.stdout.trim() || null;
      });

      const readCommitTag = Effect.fn("GitStatusService.readCommitTag")(function* (cwd: string) {
        const result = yield* git(["describe", "--tags", "--exact-match", "HEAD"], cwd).pipe(
          Effect.orElseSucceed(() => ({ stdout: "", exitCode: 0 })),
        );
        return result.stdout.trim() || null;
      });

      const read = Effect.fn("GitStatusService.read")(function* (
        cwd: string,
        options: GitStatusOptions = {},
      ) {
        const primary = yield* git(PRIMARY_ARGS, cwd);
        const outcome = yield* interpretPrimary(primary, cwd);
        return yield* Match.value(outcome).pipe(
          Match.tags({
            Continue: () =>
              Effect.gen(function* () {
                const stashed = yield* readStash(cwd);
                const base = GitStatus.make({ ...outcome.status, stashed });
                if (!base.commit?.detached) return base;

                const oid = yield* readCommitOid(cwd);
                const tag = options.readTag === true ? yield* readCommitTag(cwd) : null;
                return GitStatus.make({
                  ...base,
                  commit: GitCommitInfo.make({ oid, detached: true, tag }),
                });
              }),
            Terminal: () => Effect.succeed(outcome.status),
          }),
          Match.exhaustive,
        );
      });

      return GitStatusService.of({ read });
    }),
  );
}
