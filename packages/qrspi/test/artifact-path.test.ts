import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cachedGitMetadata,
  dateStamp,
  fixFrontmatterDate,
  fixFrontmatterGit,
  hasFrontmatterKey,
  invalidateGitMetadata,
  normalizeArtifactPath,
  readGitMetadata,
  repositoryNameFromUrl,
  slugify,
} from "../extensions/qrspi-artifacts.js";

// Fixed clock so tests are deterministic
const NOW = new Date("2026-08-14T12:00:00");
const MISSING = () => false;
const EXISTS = () => true;
const fetchA = async () => ({ commit: "a" });
const fetchB = async () => ({ commit: "b" });

describe("dateStamp", () => {
  test("formats local date as YYYYMMDD", () => {
    expect(dateStamp(NOW)).toBe("20260814");
  });
});

describe("slugify", () => {
  test("lowercases and kebab-cases", () => {
    expect(slugify("Add Payment Flow")).toBe("add-payment-flow");
    expect(slugify("Auth_refactor")).toBe("auth-refactor");
    expect(slugify("  spaces  ")).toBe("spaces");
  });
});

describe("fixFrontmatterDate", () => {
  test("replaces placeholder date in frontmatter", () => {
    const content = "---\ndate: { ISO datetime }\ntopic: auth\n---\nBody";
    expect(fixFrontmatterDate(content, NOW)).toBe(
      `---\ndate: ${NOW.toISOString()}\ntopic: auth\n---\nBody`,
    );
  });

  test("replaces wrong date with host-clock date", () => {
    const content = "---\ndate: 2026-01-01\n---\nBody";
    expect(fixFrontmatterDate(content, NOW)).toContain(`date: ${NOW.toISOString()}`);
  });

  test("leaves content without frontmatter unchanged", () => {
    const content = "# Title\n\nBody";
    expect(fixFrontmatterDate(content, NOW)).toBe(content);
  });

  test("leaves frontmatter without date key unchanged", () => {
    const content = "---\ntopic: auth\n---\nBody";
    expect(fixFrontmatterDate(content, NOW)).toBe(content);
  });
});

describe("repositoryNameFromUrl", () => {
  test("extracts repo name from ssh url", () => {
    expect(repositoryNameFromUrl("git@github.com:felixnorden/skills.git")).toBe("skills");
  });

  test("extracts repo name from https url", () => {
    expect(repositoryNameFromUrl("https://github.com/felixnorden/skills.git")).toBe("skills");
  });

  test("handles missing extension and trailing slash", () => {
    expect(repositoryNameFromUrl("https://github.com/felixnorden/skills/")).toBe("skills");
  });
});

describe("fixFrontmatterGit", () => {
  const git = { commit: "abc123", branch: "main", repository: "skills" };

  test("replaces git metadata values in frontmatter", () => {
    const content =
      "---\ngit_commit: { hash }\nbranch: { branch }\nrepository: { repo name }\n---\nBody";
    expect(fixFrontmatterGit(content, git)).toBe(
      "---\ngit_commit: abc123\nbranch: main\nrepository: skills\n---\nBody",
    );
  });

  test("skips undefined values", () => {
    const content = "---\ngit_commit: { hash }\nbranch: { branch }\n---\nBody";
    expect(fixFrontmatterGit(content, { commit: "abc123" })).toBe(
      "---\ngit_commit: abc123\nbranch: { branch }\n---\nBody",
    );
  });

  test("leaves content without those keys unchanged", () => {
    const content = "---\ntopic: auth\n---\nBody";
    expect(fixFrontmatterGit(content, git)).toBe(content);
  });
});

describe("hasFrontmatterKey", () => {
  test("detects keys in frontmatter block only", () => {
    expect(hasFrontmatterKey("---\ndate: x\n---\nBody", ["date"])).toBe(true);
    expect(hasFrontmatterKey("---\ntopic: x\n---\ndate: y", ["date"])).toBe(false);
    expect(hasFrontmatterKey("No frontmatter", ["date"])).toBe(false);
  });
});

describe("readGitMetadata", () => {
  test("returns undefined values outside a git repo", async () => {
    const { dir, cleanup } = tempDir();
    const meta = await readGitMetadata(dir);
    expect(meta.commit).toBeUndefined();
    expect(meta.branch).toBeUndefined();
    expect(meta.repository).toBeUndefined();
    cleanup();
  });
});

function tempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "qrspi-unit-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("cachedGitMetadata", () => {
  test("fetches once per cwd within the TTL (shared by subagents)", async () => {
    let fetches = 0;
    const fetch = async () => {
      fetches++;
      return { commit: "abc", branch: "main", repository: "skills" };
    };
    let now = 1_000_000;
    const first = await cachedGitMetadata("/repo", () => now, fetch);
    const second = await cachedGitMetadata("/repo", () => now, fetch);
    expect(first).toEqual({
      commit: "abc",
      branch: "main",
      repository: "skills",
    });
    expect(second).toEqual(first);
    expect(fetches).toBe(1);
  });

  test("re-fetches after TTL expiry", async () => {
    let fetches = 0;
    const fetch = async () => {
      fetches++;
      return { commit: `c${fetches}` };
    };
    let now = 0;
    await cachedGitMetadata("/repo-ttl", () => now, fetch);
    now = 61_000; // past the 60s TTL
    const fresh = await cachedGitMetadata("/repo-ttl", () => now, fetch);
    expect(fresh).toEqual({ commit: "c2" });
    expect(fetches).toBe(2);
  });

  test("keeps per-cwd entries independent", async () => {
    const a = await cachedGitMetadata("/a", undefined, fetchA);
    const b = await cachedGitMetadata("/b", undefined, fetchB);
    expect(a.commit).toBe("a");
    expect(b.commit).toBe("b");
  });

  test("invalidateGitMetadata forces a re-fetch", async () => {
    let fetches = 0;
    const fetch = async () => {
      fetches++;
      return { commit: `c${fetches}` };
    };
    await cachedGitMetadata("/repo-invalidate", () => 0, fetch);
    invalidateGitMetadata("/repo-invalidate");
    const fresh = await cachedGitMetadata("/repo-invalidate", () => 0, fetch);
    expect(fresh).toEqual({ commit: "c2" });
    expect(fetches).toBe(2);
  });
});

describe("normalizeArtifactPath", () => {
  test("adds date prefix to plain slug", () => {
    const res = normalizeArtifactPath(".qrspi/plans/foo.md", NOW, MISSING);
    expect(res.path).toBe(".qrspi/plans/20260814-foo.md");
  });

  test("preserves existing canonical name", () => {
    const res = normalizeArtifactPath(".qrspi/plans/20260101-foo.md", NOW, MISSING);
    expect(res.path).toBeUndefined();
  });

  test("replaces malformed date prefix", () => {
    const res = normalizeArtifactPath(".qrspi/plans/2026-8-14-foo.md", NOW, MISSING);
    expect(res.path).toBe(".qrspi/plans/20260814-foo.md");
  });

  test("replaces non-zero-padded compact date", () => {
    const res = normalizeArtifactPath(".qrspi/designs/2026814-foo.md", NOW, MISSING);
    expect(res.path).toBe(".qrspi/designs/20260814-foo.md");
  });

  test("slugifies messy names", () => {
    const res = normalizeArtifactPath(".qrspi/research/Add Payment Flow.md", NOW, MISSING);
    expect(res.path).toBe(".qrspi/research/20260814-add-payment-flow.md");
  });

  test("preserves directory prefix (subdir / absolute)", () => {
    const rel = normalizeArtifactPath("sub/.qrspi/outlines/foo.md", NOW, MISSING);
    expect(rel.path).toBe("sub/.qrspi/outlines/20260814-foo.md");
    const abs = normalizeArtifactPath("/repo/.qrspi/plans/foo.md", NOW, MISSING);
    expect(abs.path).toBe("/repo/.qrspi/plans/20260814-foo.md");
  });

  test("keeps existing files untouched (iterate overwrite)", () => {
    const res = normalizeArtifactPath(".qrspi/plans/foo.md", NOW, EXISTS);
    expect(res.path).toBeUndefined();
  });

  test("ignores non-artifact paths", () => {
    expect(normalizeArtifactPath("src/foo.md", NOW, MISSING).path).toBeUndefined();
    expect(normalizeArtifactPath(".qrspi/foo.md", NOW, MISSING).path).toBeUndefined();
    expect(normalizeArtifactPath(".qrspi/notes/foo.md", NOW, MISSING).path).toBeUndefined();
  });

  test("ignores non-md files", () => {
    expect(normalizeArtifactPath(".qrspi/plans/foo.txt", NOW, MISSING).path).toBeUndefined();
  });

  test("blocks path traversal", () => {
    const res = normalizeArtifactPath(".qrspi/plans/../research/foo.md", NOW, MISSING);
    expect(res.block).toBeDefined();
    expect(res.block).toContain("traverse");
  });

  test("allows .. outside the .qrspi namespace", () => {
    const res = normalizeArtifactPath("../shared/foo.md", NOW, MISSING);
    expect(res.block).toBeUndefined();
    expect(res.path).toBeUndefined();
  });
});
