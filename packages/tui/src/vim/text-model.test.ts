import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { makeRange, type VimTextModelShape, VimTextModel } from "./text-model.ts";
import { findWordBackStart, findWordEnd, findWordStart, wordForward } from "./word-motion.ts";

// ---------------------------------------------------------------------------
// Range normalization (binding decision 3)
// ---------------------------------------------------------------------------

it("makeRange keeps anchor and active and normalizes start/end", () => {
  const r = makeRange({ line: 0, col: 1 }, { line: 0, col: 3 });
  assert.deepStrictEqual(r.anchor, { line: 0, col: 1 });
  assert.deepStrictEqual(r.active, { line: 0, col: 3 });
  assert.deepStrictEqual(r.start, { line: 0, col: 1 });
  assert.deepStrictEqual(r.end, { line: 0, col: 3 });
});

it("makeRange orders multi-line ranges by line then column", () => {
  const r = makeRange({ line: 2, col: 0 }, { line: 1, col: 5 });
  assert.deepStrictEqual(r.start, { line: 1, col: 5 });
  assert.deepStrictEqual(r.end, { line: 2, col: 0 });
});

// ---------------------------------------------------------------------------
// Word-motion geometry
// ---------------------------------------------------------------------------

it("findWordStart skips the current word and whitespace", () => {
  assert.strictEqual(findWordStart("foo bar", 0), 4);
  assert.strictEqual(findWordStart("foo bar", 4), 7);
  assert.strictEqual(findWordStart("foo", 0), 3);
  assert.strictEqual(findWordStart("", 0), 0);
});

it("findWordBackStart returns the start of the previous word", () => {
  assert.strictEqual(findWordBackStart("foo bar", 4), 0);
  assert.strictEqual(findWordBackStart("foo bar", 7), 4);
  assert.strictEqual(findWordBackStart("foo", 0), 0);
});

it("findWordEnd returns the last character of the word at or after col", () => {
  assert.strictEqual(findWordEnd("foo bar", 0), 2);
  assert.strictEqual(findWordEnd("foo bar", 3), 6);
  assert.strictEqual(findWordEnd("foo bar", 2), 2);
});

it("wordForward composes across lines", () => {
  assert.deepStrictEqual(wordForward(["foo bar", "baz"], { line: 0, col: 0 }), {
    line: 0,
    col: 4,
  });
  // at the end of "bar" there is no further word on line 0 → next line start
  assert.deepStrictEqual(wordForward(["foo bar", "baz"], { line: 0, col: 7 }), {
    line: 1,
    col: 0,
  });
});

// ---------------------------------------------------------------------------
// VimTextModel service tag (house service pattern)
// ---------------------------------------------------------------------------

const noopShape: VimTextModelShape = {
  getText: () => "hello",
  getCursor: () => ({ line: 0, col: 0 }),
  moveCursorTo: () => {},
  getLineCount: () => 1,
  lineLength: () => 5,
  moveWordForward: (from) => from,
  moveWordBackward: (from) => from,
  moveWordEnd: (from) => from,
  moveToLineStart: (c) => c,
  moveToLineEnd: (c) => c,
  deleteRange: () => {},
  yankRange: () => "",
  replaceRange: () => {},
  insertTextAtCursor: () => {},
};

it.effect("VimTextModel.layerFrom provides the shape through the service tag", () =>
  Effect.gen(function* () {
    const model = yield* VimTextModel;
    assert.strictEqual(model.getText(), "hello");
  }).pipe(Effect.provide(VimTextModel.layerFrom(noopShape) as Layer.Layer<VimTextModel>)),
);
