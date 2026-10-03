import { afterEach, assert, it } from "@effect/vitest";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readRuntimeInfo } from "./runtime.ts";

// Env-based runtimes (no marker file) would leak the host environment into
// the "no marker matches" case, so that test clears them.
const ENV_KEYS = [
  "MESON_DEVENV",
  "IN_NIX_SHELL",
  "GUIX_ENVIRONMENT",
  "CONDA_DEFAULT_ENV",
  "PIXI_ENVIRONMENT_NAME",
  "SPACK_ENV",
] as const;

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-tui-runtime-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it("returns every matching runtime in table order", async () => {
  const dir = tempDir();
  writeFileSync(join(dir, "CMakeLists.txt"), "");
  const runtimes = await readRuntimeInfo(dir);
  assert.deepStrictEqual(
    runtimes.map((r) => r.name),
    ["cpp", "c", "cmake"],
  );
});

it("returns an empty list when no marker matches", async () => {
  const dir = tempDir();
  const saved = ENV_KEYS.map((key) => [key, process.env[key]] as const);
  for (const key of ENV_KEYS) delete process.env[key];
  try {
    assert.deepStrictEqual(await readRuntimeInfo(dir), []);
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

it("matches env-based runtimes without a marker file", async () => {
  const dir = tempDir();
  const key = "CONDA_DEFAULT_ENV";
  const previous = process.env[key];
  process.env[key] = "pi-tui-test";
  try {
    const runtimes = await readRuntimeInfo(dir);
    assert.deepStrictEqual(
      runtimes.map((r) => r.name),
      ["conda"],
    );
  } finally {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
});

it("reuses the cached entry until the marker fingerprint changes", async () => {
  const dir = tempDir();
  const marker = join(dir, "settings.gradle.kts");
  writeFileSync(marker, "");
  const first = await readRuntimeInfo(dir);
  const second = await readRuntimeInfo(dir);
  // A cache hit returns the same object, not a rebuilt one.
  assert.strictEqual(first[0], second[0]);
  assert.strictEqual(first[0]?.name, "kotlin");

  // Touching the marker changes the fingerprint, so the next read rebuilds.
  const future = new Date(Date.now() + 60_000);
  utimesSync(marker, future, future);
  const third = await readRuntimeInfo(dir);
  assert.notStrictEqual(third[0], first[0]);
  assert.strictEqual(third[0]?.name, "kotlin");
});
