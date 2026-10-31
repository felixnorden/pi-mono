import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";
import { sessionProbe } from "./probe.ts";

const scratch: string[] = [];

const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "probe-"));
  scratch.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("sessionProbe", () => {
  it("renders a relative path against the session cwd", () => {
    const cwd = tempDir();
    mkdirSync(join(cwd, "src"));
    writeFileSync(join(cwd, "src", "a.ts"), "export const a = 1;\n");
    const probe = sessionProbe(cwd);
    assert.strictEqual(probe.read("src/a.ts"), "export const a = 1;\n");
  });

  it("reads an absolute path as given", () => {
    const cwd = tempDir();
    const file = join(cwd, "absolute.ts");
    writeFileSync(file, "absolute\n");
    assert.strictEqual(sessionProbe(cwd).read(file), "absolute\n");
  });

  it("returns unavailable for every path when the cwd is missing", () => {
    assert.strictEqual(sessionProbe(undefined).read("src/a.ts"), undefined);
    assert.strictEqual(sessionProbe("/definitely/not/here").read("src/a.ts"), undefined);
  });

  it("does not fall back to the repository root", () => {
    const cwd = tempDir();
    assert.strictEqual(sessionProbe(cwd).read("README.md"), undefined);
  });
});
