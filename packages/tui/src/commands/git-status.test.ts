import { assert, it } from "@effect/vitest";
import { Duration, Effect, Layer } from "effect";
import type { StubEntry } from "./git-execution.ts";
import { GitExecutionService } from "./git-execution.ts";
import {
  FileCounts,
  GitCommitInfo,
  GitStatus,
  GitStatusService,
  ParsedBranch,
  parseBranchLine,
  parseFileLines,
  parseStashCount,
} from "./git-status.ts";

const PRIMARY_ARGS = ["status", "--porcelain=v1", "--branch", "--show-stash"];

const statusLayer = (entries: ReadonlyArray<StubEntry>, cap?: Duration.Input) =>
  GitStatusService.layer.pipe(Layer.provideMerge(GitExecutionService.layerStub(entries, cap)));

const runStatus = (
  entries: ReadonlyArray<StubEntry>,
  options?: { readTag?: boolean },
  cap?: Duration.Input,
) =>
  Effect.gen(function* () {
    const svc = yield* GitStatusService;
    return yield* svc.read("/cwd", options);
  }).pipe(Effect.provide(statusLayer(entries, cap)));

it("GitStatus.empty returns a fresh all-zero record", () => {
  const a = GitStatus.empty();
  const b = GitStatus.empty();
  assert.deepStrictEqual(
    a,
    GitStatus.make({
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
    }),
  );
  assert.notStrictEqual(a, b);
});

it("parseBranchLine parses a clean branch line", () => {
  assert.deepStrictEqual(
    parseBranchLine("## main"),
    ParsedBranch.make({ detached: false, name: "main", ahead: 0, behind: 0 }),
  );
});

it("parseBranchLine parses an ahead-only divergence", () => {
  assert.deepStrictEqual(
    parseBranchLine("## feature...main [ahead 2]"),
    ParsedBranch.make({ detached: false, name: "feature", ahead: 2, behind: 0 }),
  );
});

it("parseBranchLine parses a behind-only divergence", () => {
  assert.deepStrictEqual(
    parseBranchLine("## feature...main [behind 1]"),
    ParsedBranch.make({ detached: false, name: "feature", ahead: 0, behind: 1 }),
  );
});

it("parseBranchLine parses the combined diverged form", () => {
  assert.deepStrictEqual(
    parseBranchLine("## feature...main [ahead 1, behind 4]"),
    ParsedBranch.make({ detached: false, name: "feature", ahead: 1, behind: 4 }),
  );
});

it("parseBranchLine parses an upstream reference without divergence", () => {
  assert.deepStrictEqual(
    parseBranchLine("## feature...origin/feature"),
    ParsedBranch.make({ detached: false, name: "feature", ahead: 0, behind: 0 }),
  );
});

it("parseBranchLine detects detached HEAD", () => {
  assert.deepStrictEqual(
    parseBranchLine("## HEAD (no branch)"),
    ParsedBranch.make({ detached: true, name: undefined, ahead: 0, behind: 0 }),
  );
});

it("parseFileLines counts worktree-modified lines", () => {
  assert.deepStrictEqual(
    parseFileLines([" M a.txt", "MM b.txt"]),
    FileCounts.make({ ...FileCounts.empty(), modified: 2, staged: 1 }),
  );
});

it("parseFileLines counts staged additions and staged deletions", () => {
  assert.deepStrictEqual(
    parseFileLines(["A  s.txt", "D  e.txt"]),
    FileCounts.make({ ...FileCounts.empty(), staged: 1, deleted: 1 }),
  );
});

it("parseFileLines counts untracked and renamed files", () => {
  assert.deepStrictEqual(
    parseFileLines(["?? u.txt", "R  d.txt -> renamed.txt"]),
    FileCounts.make({ ...FileCounts.empty(), untracked: 1, renamed: 1 }),
  );
});

it("parseFileLines counts conflicted files (UU)", () => {
  assert.deepStrictEqual(
    parseFileLines(["UU c.txt"]),
    FileCounts.make({ ...FileCounts.empty(), conflicted: 1 }),
  );
});

it("parseFileLines counts the full captured matrix", () => {
  assert.deepStrictEqual(
    parseFileLines([
      " M a.txt",
      "MM a.txt",
      "A  s.txt",
      "D  e.txt",
      "R  d.txt -> renamed.txt",
      "UU c.txt",
      "?? d.txt",
    ]),
    FileCounts.make({
      ...FileCounts.empty(),
      modified: 2,
      staged: 2,
      deleted: 1,
      renamed: 1,
      conflicted: 1,
      untracked: 1,
    }),
  );
});

it("parseFileLines ignores the branch header and empty lines", () => {
  assert.deepStrictEqual(
    parseFileLines(["## main", "", " M a.txt"]),
    FileCounts.make({ ...FileCounts.empty(), modified: 1 }),
  );
});

it("parseFileLines counts a worktree deletion as deleted, not modified", () => {
  assert.deepStrictEqual(
    parseFileLines([" D d.txt"]),
    FileCounts.make({ ...FileCounts.empty(), deleted: 1 }),
  );
});

it("parseStashCount counts stash list entries", () => {
  assert.strictEqual(
    parseStashCount("stash@{0}: On main: s1\nstash@{1}: WIP on feature: xyz\n"),
    2,
  );
});

it("parseStashCount returns 0 for an empty stash", () => {
  assert.strictEqual(parseStashCount(""), 0);
});

it.effect("read returns a full status for a clean repository", () =>
  Effect.gen(function* () {
    const result = yield* runStatus([
      { command: "git", args: PRIMARY_ARGS, stdout: "## main\n", exitCode: 0 },
      { command: "git", args: ["stash", "list"], stdout: "", exitCode: 0 },
    ]);
    assert.deepStrictEqual(result, GitStatus.make({ ...GitStatus.empty(), branch: "main" }));
  }),
);

it.effect("read parses a diverged branch end-to-end", () =>
  Effect.gen(function* () {
    const result = yield* runStatus([
      {
        command: "git",
        args: PRIMARY_ARGS,
        stdout: "## feature...main [ahead 1, behind 4]\n",
        exitCode: 0,
      },
      { command: "git", args: ["stash", "list"], stdout: "", exitCode: 0 },
    ]);
    assert.strictEqual(result.branch, "feature");
    assert.strictEqual(result.ahead, 1);
    assert.strictEqual(result.behind, 4);
  }),
);

it.effect("read counts working-tree changes from captured real output", () =>
  Effect.gen(function* () {
    const result = yield* runStatus([
      {
        command: "git",
        args: PRIMARY_ARGS,
        stdout:
          "## feature...main [ahead 2, behind 1]\n M a.txt\nMM a.txt\nA  s.txt\nD  e.txt\nR  d.txt -> renamed.txt\nUU c.txt\n?? d.txt\n",
        exitCode: 0,
      },
      { command: "git", args: ["stash", "list"], stdout: "", exitCode: 0 },
    ]);
    assert.strictEqual(result.modified, 2);
    assert.strictEqual(result.staged, 2);
    assert.strictEqual(result.deleted, 1);
    assert.strictEqual(result.renamed, 1);
    assert.strictEqual(result.conflicted, 1);
    assert.strictEqual(result.untracked, 1);
    assert.strictEqual(result.ahead, 2);
    assert.strictEqual(result.behind, 1);
  }),
);

it.effect("read parses the stash count from a separate invocation", () =>
  Effect.gen(function* () {
    const result = yield* runStatus([
      { command: "git", args: PRIMARY_ARGS, stdout: "## main\n", exitCode: 0 },
      {
        command: "git",
        args: ["stash", "list"],
        stdout: "stash@{0}: On main: s1\nstash@{1}: WIP on feature: xyz\n",
        exitCode: 0,
      },
    ]);
    assert.strictEqual(result.stashed, 2);
  }),
);

it.effect("read degrades the stash field to 0 when the stash invocation fails", () =>
  Effect.gen(function* () {
    const result = yield* runStatus([
      { command: "git", args: PRIMARY_ARGS, stdout: "## main\n", exitCode: 0 },
    ]);
    assert.strictEqual(result.stashed, 0);
  }),
);

it.effect("read returns the silent empty status for a non-repository directory", () =>
  Effect.gen(function* () {
    const result = yield* runStatus([
      { command: "git", args: PRIMARY_ARGS, stdout: "", exitCode: 128 },
      { command: "git", args: ["stash", "list"], stdout: "", exitCode: 0 },
    ]);
    assert.deepStrictEqual(result, GitStatus.empty());
  }),
);

it.effect("read fails with GitStatusError on non-zero exit with non-empty stdout", () =>
  Effect.gen(function* () {
    const tag = yield* runStatus([
      { command: "git", args: PRIMARY_ARGS, stdout: "unexpected output\n", exitCode: 128 },
      { command: "git", args: ["stash", "list"], stdout: "", exitCode: 0 },
    ]).pipe(
      Effect.match({
        onFailure: (err) => err._tag,
        onSuccess: () => "unexpected-success",
      }),
    );
    assert.strictEqual(tag, "GitStatusError");
  }),
);

it.effect("read propagates primary spawn failures", () =>
  Effect.gen(function* () {
    const tag = yield* runStatus([
      { command: "git", args: ["stash", "list"], stdout: "", exitCode: 0 },
    ]).pipe(
      Effect.match({
        onFailure: (err) => err._tag,
        onSuccess: () => "unexpected-success",
      }),
    );
    assert.strictEqual(tag, "GitSpawnError");
  }),
);

it.live("read fails with GitTimeoutError when the primary invocation hangs past the cap", () =>
  Effect.gen(function* () {
    const tag = yield* runStatus(
      [{ command: "git", args: PRIMARY_ARGS, neverCompletes: true }],
      undefined,
      "10 millis",
    ).pipe(
      Effect.match({
        onFailure: (err) => err._tag,
        onSuccess: () => "unexpected-success",
      }),
    );
    assert.strictEqual(tag, "GitTimeoutError");
  }),
);

it.effect("read reads the detached commit id and skips the tag when readTag is off", () =>
  Effect.gen(function* () {
    const result = yield* runStatus([
      { command: "git", args: PRIMARY_ARGS, stdout: "## HEAD (no branch)\n", exitCode: 0 },
      { command: "git", args: ["stash", "list"], stdout: "", exitCode: 0 },
      {
        command: "git",
        args: ["rev-parse", "HEAD"],
        stdout: "0502eea0d67bf502c9f910af4c61fbb5c89d474c\n",
        exitCode: 0,
      },
    ]);
    assert.deepStrictEqual(
      result.commit,
      GitCommitInfo.make({
        oid: "0502eea0d67bf502c9f910af4c61fbb5c89d474c",
        detached: true,
        tag: null,
      }),
    );
  }),
);

it.effect("read reads the detached tag when readTag is on", () =>
  Effect.gen(function* () {
    const result = yield* runStatus(
      [
        { command: "git", args: PRIMARY_ARGS, stdout: "## HEAD (no branch)\n", exitCode: 0 },
        { command: "git", args: ["stash", "list"], stdout: "", exitCode: 0 },
        {
          command: "git",
          args: ["rev-parse", "HEAD"],
          stdout: "0502eea0d67bf502c9f910af4c61fbb5c89d474c\n",
          exitCode: 0,
        },
        {
          command: "git",
          args: ["describe", "--tags", "--exact-match", "HEAD"],
          stdout: "v2\n",
          exitCode: 0,
        },
      ],
      { readTag: true },
    );
    assert.strictEqual(result.commit?.tag, "v2");
  }),
);

it.effect("read degrades the detached id to null when rev-parse fails", () =>
  Effect.gen(function* () {
    const result = yield* runStatus([
      { command: "git", args: PRIMARY_ARGS, stdout: "## HEAD (no branch)\n", exitCode: 0 },
      { command: "git", args: ["stash", "list"], stdout: "", exitCode: 0 },
    ]);
    assert.deepStrictEqual(
      result.commit,
      GitCommitInfo.make({ oid: null, detached: true, tag: null }),
    );
  }),
);

it.effect("read degrades the detached tag to null when describe fails", () =>
  Effect.gen(function* () {
    const result = yield* runStatus(
      [
        { command: "git", args: PRIMARY_ARGS, stdout: "## HEAD (no branch)\n", exitCode: 0 },
        { command: "git", args: ["stash", "list"], stdout: "", exitCode: 0 },
        {
          command: "git",
          args: ["rev-parse", "HEAD"],
          stdout: "0502eea0d67bf502c9f910af4c61fbb5c89d474c\n",
          exitCode: 0,
        },
      ],
      { readTag: true },
    );
    assert.strictEqual(result.commit?.tag, null);
    assert.strictEqual(result.commit?.oid, "0502eea0d67bf502c9f910af4c61fbb5c89d474c");
  }),
);
