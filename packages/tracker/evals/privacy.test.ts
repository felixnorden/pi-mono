import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { describe, it } from "vitest";

const EVALS = "packages/tracker/evals";

const REPO = ((): string | null => {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
})();

const repoRoot = REPO ?? "";

/** The path relative to the evals directory when it must stay local, else null. */
const leakOf = (path: string): string | null => {
  const rel = path.slice(EVALS.length + 1);
  if (rel.startsWith("data/") && !rel.startsWith("data/synthetic/")) return rel;
  // The old layout. Kept so a reintroduced directory cannot become tracked.
  if (rel.startsWith("data-v2/") || rel.startsWith("v2-evidence/")) return rel;
  return null;
};

const trackedFiles = (): readonly string[] => {
  const output = execFileSync("git", ["ls-files", "-z", "--", EVALS], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  return output.split("\0").filter((entry) => entry.length > 0);
};

describe.skipIf(REPO === null)("session data stays out of git", () => {
  it("tracks no harvested corpus or evidence files", () => {
    const leaks = trackedFiles()
      .map(leakOf)
      .filter((entry): entry is string => entry !== null);
    assert.deepStrictEqual(leaks, []);
  });

  it("keeps the synthetic fixture tracked", () => {
    assert.ok(trackedFiles().includes(`${EVALS}/data/synthetic/session.jsonl`));
    assert.ok(trackedFiles().includes(`${EVALS}/data/synthetic/labels.jsonl`));
  });

  it("ignores the local corpus and evidence paths", () => {
    for (const rel of [
      "data/cases.jsonl",
      "data/v2/cases.jsonl",
      "data/v2-evidence/manifest.json",
    ]) {
      const status = spawnSync("git", ["check-ignore", "-q", "--no-index", `${EVALS}/${rel}`], {
        cwd: repoRoot,
        stdio: "ignore",
      });
      assert.strictEqual(status.status, 0, `${rel} is not ignored`);
    }
  });
});
