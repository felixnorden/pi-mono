import { assert, it } from "@effect/vitest";
import { vimModeGlyph, vimModeTint } from "./mode-indicator.ts";

// ---------------------------------------------------------------------------
// vimModeTint (pure mode → border color mapping)
// ---------------------------------------------------------------------------

it("insert (or vim off) yields no tint", () => {
  assert.strictEqual(vimModeTint({ enabled: true, mode: "insert" }), undefined);
  assert.strictEqual(vimModeTint({ enabled: false, mode: "normal" }), undefined);
});

it("normal tints syntaxOperator; visual tints syntaxNumber", () => {
  assert.strictEqual(vimModeTint({ enabled: true, mode: "normal" }), "syntaxOperator");
  assert.strictEqual(vimModeTint({ enabled: true, mode: "visual" }), "syntaxNumber");
});

// ---------------------------------------------------------------------------
// vimModeGlyph (pure mode → top-border glyph mapping)
// ---------------------------------------------------------------------------

it("maps modes to single letters; vim off yields nothing", () => {
  assert.strictEqual(vimModeGlyph({ enabled: true, mode: "insert" }), "I");
  assert.strictEqual(vimModeGlyph({ enabled: true, mode: "normal" }), "N");
  assert.strictEqual(vimModeGlyph({ enabled: true, mode: "visual" }), "V");
  assert.strictEqual(vimModeGlyph({ enabled: false, mode: "normal" }), undefined);
});
