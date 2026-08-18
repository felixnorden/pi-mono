import { assert, it } from "@effect/vitest";
import { makeRange } from "./text-model.ts";
import { paintVisibleSpan, renderSelection } from "./selection-render.ts";

const paint = (s: string) => `[sel]${s}[/sel]`;

// ---------------------------------------------------------------------------
// renderSelection
// ---------------------------------------------------------------------------

it("is inert with no selection", () => {
  const lines = ["foo", "bar"];
  assert.deepStrictEqual(renderSelection({ lines, selection: undefined, paint }), lines);
});

it("paints the span on the first/last lines of the range", () => {
  const lines = ["foo bar", "second line", "third"];
  const selection = makeRange({ line: 0, col: 1 }, { line: 2, col: 2 });
  const out = renderSelection({ lines, selection, paint });
  assert.strictEqual(out[0], "f[sel]oo bar[/sel]");
  assert.strictEqual(out[1], "[sel]second line[/sel]"); // interior line: full
  assert.strictEqual(out[2], "[sel]th[/sel]ird");
});

it("paints nothing for a single-cursor range", () => {
  const lines = ["foo bar"];
  const selection = makeRange({ line: 0, col: 2 }, { line: 0, col: 2 });
  assert.deepStrictEqual(renderSelection({ lines, selection, paint }), lines);
});

it("makeRange normalizes a reverse range into a forward span", () => {
  const r = makeRange({ line: 0, col: 4 }, { line: 0, col: 2 });
  assert.deepStrictEqual(r.start, { line: 0, col: 2 });
  assert.deepStrictEqual(r.end, { line: 0, col: 4 });
  const out = renderSelection({ lines: ["foo bar"], selection: r, paint });
  assert.strictEqual(out[0], "fo[sel]o [/sel]bar");
});

it("leaves lines outside the range untouched", () => {
  const lines = ["alpha", "beta", "gamma"];
  const selection = makeRange({ line: 1, col: 0 }, { line: 1, col: 2 });
  const out = renderSelection({ lines, selection, paint });
  assert.strictEqual(out[0], "alpha");
  assert.strictEqual(out[1], "[sel]be[/sel]ta");
  assert.strictEqual(out[2], "gamma");
});

// ---------------------------------------------------------------------------
// paintVisibleSpan: ANSI awareness
// ---------------------------------------------------------------------------

it("copies escape sequences verbatim without counting their width", () => {
  const line = "he\x1b[7ml\x1b[0mlo"; // cursor marker over the 'l' at col 2
  const out = paintVisibleSpan(line, 0, 5, paint);
  assert.strictEqual(out, "[sel]he\x1b[7ml\x1b[0mlo[/sel]");
});

it("paints a span that excludes a leading escape sequence", () => {
  const line = "he\x1b[7ml\x1b[0mlo";
  const out = paintVisibleSpan(line, 3, 4, paint);
  assert.strictEqual(out, "he\x1b[7ml\x1b[0m[sel]l[/sel]o");
});

it("does not paint when the span starts beyond the visible text", () => {
  const line = "abc";
  assert.strictEqual(paintVisibleSpan(line, 9, 10, paint), line);
});

it("paints to the last visible char when the span runs past the line end", () => {
  assert.strictEqual(paintVisibleSpan("abc", 1, 99, paint), "a[sel]bc[/sel]");
});

it("is a no-op for a zero-width span", () => {
  const line = "abc";
  assert.strictEqual(paintVisibleSpan(line, 1, 1, paint), line);
  assert.strictEqual(paintVisibleSpan(line, 3, 1, paint), line);
});
