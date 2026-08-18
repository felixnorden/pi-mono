import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import qrspiArtifacts, { cachedGitMetadata } from "../extensions/qrspi-artifacts.js";

const STAMPED_PATH_RE = /^\.qrspi\/plans\/\d{8}-foo\.md$/;

/**
 * Minimal ExtensionAPI stub: captures the `tool_call` handler so tests can
 * fire fake tool calls through the real wiring (path mutation, blocking,
 * frontmatter stamping) without launching pi.
 */
function stubPi() {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const pi = {
    on: (name: string, fn: (event: unknown, ctx: unknown) => unknown) => {
      handlers.set(name, fn);
    },
  };
  qrspiArtifacts(pi as never);
  return {
    fire: (event: Record<string, unknown>, cwd: string) => {
      const handler = handlers.get("tool_call");
      if (!handler) throw new Error("tool_call handler not registered");
      return handler(event, { cwd, hasUI: false, ui: { notify: () => {} } });
    },
  };
}

function tempProject(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "qrspi-test-"));
  mkdirSync(join(dir, ".qrspi", "plans"), { recursive: true });
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function writeEvent(path: string, content: string) {
  return { toolName: "write", toolCallId: "t1", input: { path, content } };
}

function editEvent(path: string) {
  return { toolName: "edit", toolCallId: "t2", input: { path, edits: [] } };
}

describe("tool_call wiring", () => {
  test("mutates path in place for a new .qrspi artifact write", async () => {
    const { dir, cleanup } = tempProject();
    const { fire } = stubPi();
    const event = writeEvent(".qrspi/plans/foo.md", "---\ntopic: x\n---\nBody");
    const result = await fire(event, dir);
    expect(result).toBeUndefined();
    expect(event.input.path).toMatch(STAMPED_PATH_RE);
    cleanup();
  });

  test("stamps frontmatter date on a new artifact write", async () => {
    const { dir, cleanup } = tempProject();
    const { fire } = stubPi();
    const event = writeEvent(
      ".qrspi/plans/foo.md",
      "---\ndate: { ISO datetime }\ntopic: x\n---\nBody",
    );
    await fire(event, dir);
    expect(event.input.content).toMatch(/^date: \d{4}-\d{2}-\d{2}T/m);
    cleanup();
  });

  test("leaves existing artifacts untouched (iterate overwrite)", async () => {
    const { dir, cleanup } = tempProject();
    const existing = join(dir, ".qrspi", "plans", "20260101-foo.md");
    writeFileSync(existing, "old");
    const { fire } = stubPi();
    const event = writeEvent(".qrspi/plans/20260101-foo.md", "---\ndate: 2026-01-01\n---\nNew");
    await fire(event, dir);
    expect(event.input.path).toBe(".qrspi/plans/20260101-foo.md");
    expect(event.input.content).toBe("---\ndate: 2026-01-01\n---\nNew");
    cleanup();
  });

  test("does not touch content on edit", async () => {
    const { dir, cleanup } = tempProject();
    const { fire } = stubPi();
    const event = editEvent(".qrspi/plans/foo.md");
    await fire(event, dir);
    expect(event.input.path).toMatch(STAMPED_PATH_RE);
    expect(event.input).not.toHaveProperty("content");
    cleanup();
  });

  test("blocks path traversal", async () => {
    const { dir, cleanup } = tempProject();
    const { fire } = stubPi();
    const event = writeEvent(".qrspi/plans/../research/foo.md", "x");
    const result = await fire(event, dir);
    expect(result).toMatchObject({ block: true });
    expect(event.input.path).toBe(".qrspi/plans/../research/foo.md");
    cleanup();
  });

  test("ignores non-artifact writes", async () => {
    const { dir, cleanup } = tempProject();
    const { fire } = stubPi();
    const event = writeEvent("src/foo.md", "---\ndate: { ISO datetime }\n---\nBody");
    await fire(event, dir);
    expect(event.input.path).toBe("src/foo.md");
    expect(event.input.content).toBe("---\ndate: { ISO datetime }\n---\nBody");
    cleanup();
  });

  test("ignores non-write/edit tools", async () => {
    const { dir, cleanup } = tempProject();
    const { fire } = stubPi();
    const event = {
      toolName: "bash",
      toolCallId: "t3",
      input: { command: "ls" },
    };
    expect(await fire(event, dir)).toBeUndefined();
    expect(event.input).toEqual({ command: "ls" });
    cleanup();
  });

  test("git-mutating bash commands invalidate the metadata cache", async () => {
    const { dir, cleanup } = tempProject();
    const { fire } = stubPi();
    // Seed the cache with a first commit value.
    let fetches = 0;
    const fetch = async () => {
      fetches++;
      return { commit: `c${fetches}` };
    };
    const first = await cachedGitMetadata(dir, () => 0, fetch);
    expect(first.commit).toBe("c1");

    // A git commit via bash must invalidate, so the next fetch re-resolves.
    const event = {
      toolName: "bash",
      toolCallId: "t4",
      input: { command: "git commit -m wip" },
    };
    expect(await fire(event, dir)).toBeUndefined();

    const second = await cachedGitMetadata(dir, () => 0, fetch);
    expect(second.commit).toBe("c2");
    expect(fetches).toBe(2);
    cleanup();
  });

  test("read-only git bash commands keep the cache warm", async () => {
    const { dir, cleanup } = tempProject();
    const { fire } = stubPi();
    let fetches = 0;
    const fetch = async () => {
      fetches++;
      return { commit: "c1" };
    };
    await cachedGitMetadata(dir, () => 0, fetch);

    const event = {
      toolName: "bash",
      toolCallId: "t5",
      input: { command: "git status" },
    };
    await fire(event, dir);
    const readOnly = {
      toolName: "bash",
      toolCallId: "t6",
      input: { command: "git branch --show-current" },
    };
    await fire(readOnly, dir);

    const second = await cachedGitMetadata(dir, () => 0, fetch);
    expect(second.commit).toBe("c1");
    expect(fetches).toBe(1);
    cleanup();
  });
});
