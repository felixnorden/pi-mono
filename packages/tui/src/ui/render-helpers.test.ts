import { assert, it } from "@effect/vitest";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { renderBar, renderRuntimeSegment } from "./render-helpers.ts";

// Identity theme: styling is a no-op so assertions read the plain text.
const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

it("renderBar fills by rounded percentage in ascii and unicode", () => {
  assert.strictEqual(renderBar(theme, 50, 10, true), "[#####-----]");
  assert.strictEqual(renderBar(theme, 0, 4, false), "[░░░░]");
  assert.strictEqual(renderBar(theme, 100, 4, true), "[####]");
  assert.strictEqual(renderBar(theme, 150, 4, true), "[####]");
});

it("renderRuntimeSegment joins every runtime with a dim separator", () => {
  assert.strictEqual(renderRuntimeSegment(theme, [], "ascii"), "");
  assert.strictEqual(
    renderRuntimeSegment(theme, [{ name: "nodejs", version: "1.2.3" }, { name: "rust" }], "ascii"),
    "node 1.2.3 · rs",
  );
});
