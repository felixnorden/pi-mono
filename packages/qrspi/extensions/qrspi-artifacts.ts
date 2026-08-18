/**
 * QRSPI Artifact Enforcement
 *
 * Guards the `.qrspi/` artifact convention at the tool layer, for every
 * `write`/`edit`/`bash` call from the orchestrator session or any subagent:
 *
 * - Paths: `.qrspi/<artifact-dir>/<basename>` is normalized to the canonical
 *   `YYYYMMDD-{slug}.md` naming convention, using the host clock so agents
 *   cannot hallucinate timestamps. Writes that escape the `.qrspi/` namespace
 *   are blocked.
 * - Frontmatter: NEW artifacts get their `date:` and git keys
 *   (`git_commit`, `branch`, `repository`) stamped with real values from the
 *   host repository. Re-writing an existing artifact (iterate-overwrite)
 *   keeps its original date and provenance.
 * - Git metadata is resolved lazily and cached per working directory, so the
 *   orchestrator and its subagents share one resolution per session. Bash
 *   commands that mutate git state invalidate the cache.
 *
 * Installed as part of the pi-qrspi package via `pi.extensions`.
 *
 * Run `bun test` to exercise the logic (see test/artifact-path.test.ts,
 * test/wiring.test.ts).
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 3000;
const GIT_CACHE_TTL_MS = 60_000;

/** Artifact subdirectories under `.qrspi/`. */
const ARTIFACT_DIRS = ["research", "designs", "outlines", "plans"] as const;

/** Matches `.qrspi/<artifact-dir>/<basename>` anywhere in a path. */
const ARTIFACT_PATH_RE = new RegExp(
  `(^|.*[\\\\/])\\.qrspi/(${ARTIFACT_DIRS.join("|")})/([^/\\\\]+)$`,
);

/** Canonical artifact filename: YYYYMMDD-slug.md */
const CANONICAL_RE = /^\d{8}-[a-z0-9-]+\.md$/;

/** Compact date prefix, e.g. 20260101 (7-8 digits, padded or not) */
const COMPACT_DATE_RE = /^\d{7,8}/;

/** Dashed date prefix, e.g. 2026-08-14 or 2026-8-14 */
const DASHED_DATE_RE = /^\d{4}-\d{1,2}-\d{1,2}/;

/** Local-time date stamp in YYYYMMDD form. */
export function dateStamp(now: Date): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}

/**
 * Replace the `date:` value in a leading YAML frontmatter block with the real
 * ISO datetime from the host clock. Only touches an existing `date:` key at
 * line start; content without frontmatter or without a `date:` key is unchanged.
 */
export function fixFrontmatterDate(content: string, now: Date): string {
  const fm = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fm) return content;
  const block = fm[1] ?? "";
  if (!/^date:/m.test(block)) return content;
  const iso = now.toISOString();
  return content.replace(block, block.replace(/^date:.*$/m, `date: ${iso}`));
}

/**
 * True when the content has a YAML frontmatter block containing any of the
 * given line-start keys. Used to avoid spawning git for content that does not
 * carry git metadata keys.
 */
export function hasFrontmatterKey(content: string, keys: readonly string[]): boolean {
  const fm = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fm) return false;
  const block = fm[1] ?? "";
  const pattern = new RegExp(`^(${keys.join("|")}):`, "m");
  return pattern.test(block);
}

/**
 * Replace git metadata key values in a leading YAML frontmatter block with
 * real values resolved from the host repository. Only touches existing keys
 * at line start; missing keys are left alone (the template declares them).
 */
export function fixFrontmatterGit(content: string, git: GitMetadata): string {
  const fm = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fm) return content;
  const block = fm[1] ?? "";
  let out = block;
  for (const { prop, key } of FRONTMATTER_GIT_KEYS) {
    const value = git[prop];
    if (value === undefined) continue;
    if (!new RegExp(`^${key}:`, "m").test(out)) continue;
    out = out.replace(new RegExp(`^${key}:.*$`, "m"), `${key}: ${value}`);
  }
  return out === block ? content : content.replace(block, out);
}

/** Git metadata for artifact frontmatter, resolved from the host repository. */
export interface GitMetadata {
  commit?: string;
  branch?: string;
  repository?: string;
}

/** GitMetadata property → YAML frontmatter key (`commit` is `git_commit` in the templates). */
const FRONTMATTER_GIT_KEYS = [
  { prop: "commit", key: "git_commit" },
  { prop: "branch", key: "branch" },
  { prop: "repository", key: "repository" },
] as const;

async function runGit(cwd: string, args: string[]): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      timeout: GIT_TIMEOUT_MS,
    });
    return stdout.trim();
  } catch {
    return undefined;
  }
}

/** Derive a repo name from a remote URL (e.g. github.com/user/repo.git → repo). */
export function repositoryNameFromUrl(url: string): string | undefined {
  const cleaned = url.replace(/\.git$/, "").replace(/\/$/, "");
  const name = cleaned.split(/[/:]/).pop();
  return name || undefined;
}

/** Resolve real git metadata from the repository at `cwd` (best effort). */
export async function readGitMetadata(cwd: string): Promise<GitMetadata> {
  const [commit, branch, remoteUrl] = await Promise.all([
    runGit(cwd, ["rev-parse", "HEAD"]),
    runGit(cwd, ["branch", "--show-current"]),
    runGit(cwd, ["remote", "get-url", "origin"]),
  ]);
  return {
    commit,
    branch: branch || undefined,
    repository: remoteUrl ? repositoryNameFromUrl(remoteUrl) : undefined,
  };
}

/**
 * Per-cwd cache of resolved git metadata.
 *
 * The extension process is shared by the orchestrator session and every
 * subagent it spawns, and `tool_call` carries the writer's own `ctx.cwd`.
 * So the first `.qrspi/` artifact write anywhere in a session populates the
 * cache, and all later writes — including from subagents — reuse it without
 * re-spawning git. Values are fetched lazily on first use.
 */
const gitMetadataCache = new Map<string, { meta: GitMetadata; at: number }>();

/** Invalidate the cached metadata for one working directory. */
export function invalidateGitMetadata(cwd: string): void {
  gitMetadataCache.delete(cwd);
}

/**
 * Resolve git metadata for `cwd`, using the per-cwd cache within its TTL.
 * Exposed for tests: pass `now` and `fetch` to control time and the fetcher.
 */
export async function cachedGitMetadata(
  cwd: string,
  now: () => number = Date.now,
  fetch: (dir: string) => Promise<GitMetadata> = readGitMetadata,
): Promise<GitMetadata> {
  const at = now();
  const hit = gitMetadataCache.get(cwd);
  if (hit && at - hit.at < GIT_CACHE_TTL_MS) return hit.meta;
  const meta = await fetch(cwd);
  gitMetadataCache.set(cwd, { meta, at });
  return meta;
}

/**
 * git subcommands that can change branch, HEAD, or remote state. Read-only
 * matches are harmless — they only force one re-fetch of the metadata cache.
 */
const GIT_MUTATING_VERBS = [
  "commit",
  "merge",
  "rebase",
  "pull",
  "push",
  "fetch",
  "checkout",
  "switch",
  "reset",
  "restore",
  "revert",
  "cherry-pick",
  "tag",
  "stash",
  "clean",
  "gc",
  "remote",
  "submodule",
  "update-ref",
  // `git branch` mutates (create/delete/rename); read-only listings excluded
  "branch(?!\\s*--(?:show-current|list))",
] as const;

const GIT_MUTATION_RE = new RegExp(`\\bgit\\s+(${GIT_MUTATING_VERBS.join("|")})`);

/** Lowercase kebab-case slug. */
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export interface NormalizeResult {
  /** Replacement path, when the filename was normalized. */
  path?: string;
  /** Block reason, when the path escapes the `.qrspi/` namespace. */
  block?: string;
}

/**
 * Normalize a file path to the canonical artifact naming convention when it
 * targets `.qrspi/<artifact-dir>/`.
 *
 * Rules:
 * - Non-`.qrspi/` paths, unknown artifact dirs, and non-`.md` files are untouched.
 * - Canonical names (`YYYYMMDD-slug.md`) are untouched.
 * - Existing files are never renamed — iterate-overwrite writes in place.
 * - Missing files get today's date stamp (host clock, local time) and a
 *   slugified name, replacing any malformed date prefix the agent invented.
 * - Paths containing `..` inside the `.qrspi/` namespace are blocked.
 */
export function normalizeArtifactPath(
  rawPath: string,
  now: Date,
  exists: (path: string) => boolean,
): NormalizeResult {
  if (rawPath.includes(".qrspi") && rawPath.split(/[\\/]/).includes("..")) {
    return {
      block: `QRSPI artifact path must not traverse outside .qrspi/: ${rawPath}`,
    };
  }

  const match = rawPath.match(ARTIFACT_PATH_RE);
  if (!match) return {};
  const prefix = match[1] ?? "";
  const kind = match[2] ?? "";
  const basename = match[3] ?? "";

  if (CANONICAL_RE.test(basename)) return {};
  if (!basename.endsWith(".md")) return {};
  if (exists(rawPath)) return {};

  const stem = basename
    .replace(/\.md$/, "")
    .replace(COMPACT_DATE_RE, "")
    .replace(DASHED_DATE_RE, "");
  const slug = slugify(stem);
  if (!slug) return {};

  return { path: `${prefix}.qrspi/${kind}/${dateStamp(now)}-${slug}.md` };
}

/** Frontmatter keys the hook stamps with real values on new artifact writes. */
const FRONTMATTER_STAMP_KEYS = ["date", "git_commit", "branch", "repository"] as const;

/**
 * Stamp a new artifact's frontmatter in place with the real date and git
 * metadata. Does nothing when the content has no stampable keys.
 */
async function stampFrontmatter(input: { content?: unknown }, cwd: string): Promise<void> {
  const content = input.content;
  if (typeof content !== "string") return;
  if (!hasFrontmatterKey(content, FRONTMATTER_STAMP_KEYS)) return;
  const now = new Date();
  const git = await cachedGitMetadata(cwd);
  const fixed = fixFrontmatterGit(fixFrontmatterDate(content, now), git);
  if (fixed !== content) {
    input.content = fixed;
  }
}

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    // A git-mutating bash command invalidates the cached metadata for this
    // cwd, so the next artifact write re-resolves branch/commit/remote state.
    if (event.toolName === "bash") {
      const command = (event.input as { command?: unknown }).command;
      if (typeof command === "string" && GIT_MUTATION_RE.test(command)) {
        invalidateGitMetadata(ctx.cwd);
      }
      return undefined;
    }
    if (event.toolName !== "write" && event.toolName !== "edit") return undefined;

    const input = event.input as { path?: unknown; content?: unknown };
    if (typeof input.path !== "string") return undefined;
    const rawPath = input.path;

    const exists = (p: string) => existsSync(resolve(ctx.cwd, p));
    const result = normalizeArtifactPath(rawPath, new Date(), exists);

    if (result.block) {
      if (ctx.hasUI) ctx.ui.notify(result.block, "warning");
      return { block: true, reason: result.block };
    }
    if (result.path && result.path !== rawPath) {
      input.path = result.path; // mutate in place — the tool executes with the canonical path
    }
    // Stamp the frontmatter only when creating a NEW .qrspi artifact.
    // Re-writing an existing file (iterate-overwrite) keeps its original
    // date and provenance. `rawPath` is the pre-normalization path — both
    // forms match ARTIFACT_PATH_RE, so the test is valid either way.
    const isNewArtifact =
      event.toolName === "write" && ARTIFACT_PATH_RE.test(rawPath) && !exists(rawPath);
    if (isNewArtifact) {
      await stampFrontmatter(input, ctx.cwd);
    }
    return undefined;
  });
}
