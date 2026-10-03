import { afterEach, assert, it } from "@effect/vitest";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import {
  alignRight,
  cacheHitColor,
  center,
  findBottomBorderIndex,
  fitSegmentsByPriority,
  fmtTokens,
  formatCost,
  formatCwd,
  formatDuration,
  formatModelLabel,
  formatProviderLabel,
  formatThinkingLabel,
  isEditorBorderLine,
  padRight,
  providerColor,
  sanitizeStatus,
  stressColor,
  stripAnsi,
  truncatePath,
} from "./utils.ts";

// Identity theme: styling is a no-op so assertions read the plain text.
const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it("stripAnsi removes SGR and OSC sequences", () => {
  assert.strictEqual(stripAnsi("\x1b[31mred\x1b[0m"), "red");
  assert.strictEqual(stripAnsi("a\x1b]0;title\x07b"), "ab");
});

it("formatCwd collapses paths inside HOME and leaves others literal", () => {
  const home = mkdtempSync(join(tmpdir(), "pi-tui-home-"));
  dirs.push(home);
  const previous = process.env.HOME;
  process.env.HOME = home;
  try {
    assert.strictEqual(formatCwd(home), "~");
    assert.strictEqual(formatCwd(join(home, "dev")), `~${sep}dev`);
    assert.strictEqual(formatCwd("/etc"), "/etc");
  } finally {
    if (previous === undefined) delete process.env.HOME;
    else process.env.HOME = previous;
  }
});

it("truncatePath keeps the first and trailing segments", () => {
  assert.strictEqual(truncatePath("~/dev", 20), "~/dev");
  assert.strictEqual(truncatePath("~/dev/projects/pi-mono/packages/tui", 20), "~/.../packages/tui");
  assert.strictEqual(truncatePath("abcdefgh", 3), "...");
});

it("fmtTokens uses plain digits below 1k and scales above", () => {
  assert.strictEqual(fmtTokens(999), "999");
  assert.strictEqual(fmtTokens(1500), "1.5k");
  assert.strictEqual(fmtTokens(15_000), "15k");
  assert.strictEqual(fmtTokens(2_000_000), "2.0M");
  assert.strictEqual(fmtTokens(12_000_000), "12M");
});

it("formatCost appends the currency sign only when the glyph lacks it", () => {
  assert.strictEqual(formatCost("$", 1.5), "$ 1.500");
  assert.strictEqual(formatCost("n", 1.5, 2), "n $1.50");
});

it("formatDuration clamps negatives and scales through hours", () => {
  assert.strictEqual(formatDuration(-5), "0s");
  assert.strictEqual(formatDuration(0), "0s");
  assert.strictEqual(formatDuration(1000), "1s");
  assert.strictEqual(formatDuration(59_000), "59s");
  assert.strictEqual(formatDuration(60_000), "1m 0s");
  assert.strictEqual(formatDuration(3_600_000), "1h 0m 0s");
  assert.strictEqual(formatDuration(3_723_000), "1h 2m 3s");
});

it("model, provider, and thinking labels", () => {
  assert.strictEqual(formatModelLabel(undefined), "no-model");
  assert.strictEqual(formatModelLabel({ id: "gpt" }), "gpt");
  assert.strictEqual(formatModelLabel({ provider: "openai", id: "gpt" }), "openai/gpt");
  assert.strictEqual(formatProviderLabel(undefined), "Unknown");
  assert.strictEqual(formatProviderLabel("openai"), "Openai");
  assert.strictEqual(formatThinkingLabel("off"), "thinking off");
  assert.strictEqual(formatThinkingLabel("high"), "high effort");
});

it("threshold colors map to the expected tokens", () => {
  assert.strictEqual(stressColor(50), "accent");
  assert.strictEqual(stressColor(70), "warning");
  assert.strictEqual(stressColor(95), "error");
  assert.strictEqual(cacheHitColor(10), "error");
  assert.strictEqual(cacheHitColor(50), "warning");
  assert.strictEqual(cacheHitColor(80), "success");
  assert.strictEqual(providerColor("anthropic"), "accent");
  assert.strictEqual(providerColor("openai"), "success");
  assert.strictEqual(providerColor("mystery"), "muted");
});

it("alignRight pads the gap and keeps the right block flush", () => {
  assert.strictEqual(alignRight("a", "b", 5, theme), "a   b");
  assert.strictEqual(alignRight("a", "b", 2, theme), "b");
});

it("fitSegmentsByPriority drops the lowest priority first", () => {
  const kept = fitSegmentsByPriority(
    [
      { text: "a", priority: 0 },
      { text: "bb", priority: 1 },
    ],
    5,
  );
  assert.deepStrictEqual(kept, ["a", "bb"]);

  const dropped = fitSegmentsByPriority(
    [
      { text: "aaaa", priority: 0 },
      { text: "bb", priority: 1 },
    ],
    4,
  );
  assert.deepStrictEqual(dropped, ["bb"]);
});

it("padRight and center produce the expected columns", () => {
  assert.strictEqual(padRight("ab", 5), "ab   ");
  assert.strictEqual(center("ab", 6), "  ab");
});

it("sanitizeStatus strips ANSI, controls, and collapses whitespace", () => {
  assert.strictEqual(sanitizeStatus("\x1b[31m  a\n b  \x1b[0m"), "a b");
});

it("editor border detection and bottom-border lookup", () => {
  assert.strictEqual(isEditorBorderLine("────"), true);
  assert.strictEqual(isEditorBorderLine("↓ 3 more"), true);
  assert.strictEqual(isEditorBorderLine("hello"), false);
  assert.strictEqual(findBottomBorderIndex(["a", "─", "b"]), 1);
  assert.strictEqual(findBottomBorderIndex(["a", "b"]), 1);
});
