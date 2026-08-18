import { assert, it } from "@effect/vitest";
import { VimEditorState } from "./editor-state.ts";
import { makeRange, type Cursor, type Range, type VimTextModelShape } from "./text-model.ts";
import { wordBackward, wordEnd, wordForward } from "./word-motion.ts";

/**
 * In-memory text model with real line/word geometry (London-school fake:
 * stateful behavior, not a stub). It is provided to the pure state machine
 * directly; the `VimTextModel` service tag wraps the same shape in layers.
 */
export class FakeVimTextModel implements VimTextModelShape {
  lines: string[];
  cursor: Cursor;

  constructor(lines: string[], cursor: Cursor = { line: 0, col: 0 }) {
    this.lines = [...lines];
    this.cursor = { ...cursor };
  }

  getText(): string {
    return this.lines.join("\n");
  }

  getCursor(): Cursor {
    return { ...this.cursor };
  }

  moveCursorTo(c: Cursor): void {
    const line = Math.max(0, Math.min(c.line, this.lines.length - 1));
    this.cursor = { line, col: Math.max(0, Math.min(c.col, this.lineLength(line))) };
  }

  getLineCount(): number {
    return this.lines.length;
  }

  lineLength(line: number): number {
    return this.lines[line]?.length ?? 0;
  }

  moveWordForward(from: Cursor): Cursor {
    return wordForward(this.lines, from);
  }

  moveWordBackward(from: Cursor): Cursor {
    return wordBackward(this.lines, from);
  }

  moveWordEnd(from: Cursor): Cursor {
    return wordEnd(this.lines, from);
  }

  moveToLineStart(c: Cursor): Cursor {
    return { line: c.line, col: 0 };
  }

  moveToLineEnd(c: Cursor): Cursor {
    return { line: c.line, col: this.lineLength(c.line) };
  }

  private absoluteIndex(c: Cursor): number {
    let idx = 0;
    for (let i = 0; i < c.line; i++) idx += (this.lines[i]?.length ?? 0) + 1;
    return idx + c.col;
  }

  deleteRange(range: Range): void {
    const flat = this.getText();
    const startIdx = this.absoluteIndex(range.start);
    const endIdx = this.absoluteIndex(range.end);
    this.lines = (flat.slice(0, startIdx) + flat.slice(endIdx)).split("\n");
    this.moveCursorTo(range.start);
  }

  yankRange(range: Range): string {
    const flat = this.getText();
    return flat.slice(this.absoluteIndex(range.start), this.absoluteIndex(range.end));
  }

  replaceRange(range: Range, text: string): void {
    const flat = this.getText();
    const startIdx = this.absoluteIndex(range.start);
    const endIdx = this.absoluteIndex(range.end);
    this.lines = (flat.slice(0, startIdx) + text + flat.slice(endIdx)).split("\n");
    this.moveCursorTo(range.start);
  }

  insertTextAtCursor(text: string): void {
    const flat = this.getText();
    const idx = this.absoluteIndex(this.cursor);
    this.lines = (flat.slice(0, idx) + text + flat.slice(idx)).split("\n");
    if (!text.includes("\n")) {
      this.cursor = { line: this.cursor.line, col: this.cursor.col + text.length };
    } else {
      const parts = text.split("\n");
      this.cursor = {
        line: this.cursor.line + parts.length - 1,
        col: parts[parts.length - 1]!.length,
      };
    }
  }
}

const makeState = (lines: string[], cursor?: Cursor) => {
  const model = new FakeVimTextModel(lines, cursor);
  const state = new VimEditorState(model, () => true);
  return { model, state };
};

/** Enter Normal mode from the initial Insert mode. */
const toNormal = (state: VimEditorState): void => {
  const decision = state.step("\x1b");
  assert.deepStrictEqual(decision, { kind: "consumed", enteredNormal: true });
};

// ---------------------------------------------------------------------------
// Gating
// ---------------------------------------------------------------------------

it("passes every input through when vim is off", () => {
  const model = new FakeVimTextModel(["foo"]);
  const state = new VimEditorState(model, () => false);
  assert.deepStrictEqual(state.step("a"), { kind: "pass-through" });
  assert.deepStrictEqual(state.step("\x1b"), { kind: "pass-through" });
  assert.deepStrictEqual(state.step("\x1b[B"), { kind: "pass-through" });
  assert.strictEqual(state.mode, "insert");
  assert.strictEqual(model.getText(), "foo");
});

// ---------------------------------------------------------------------------
// Insert mode
// ---------------------------------------------------------------------------

it("insert mode passes printable keys through and stays in insert", () => {
  const { model, state } = makeState(["foo"], { line: 0, col: 1 });
  const decision = state.step("h");
  assert.deepStrictEqual(decision, { kind: "pass-through" });
  assert.strictEqual(state.mode, "insert");
  assert.deepStrictEqual(model.getCursor(), { line: 0, col: 1 }); // untouched
});

it("escape enters normal mode from insert and signals the host", () => {
  const { state } = makeState(["hello"]);
  const decision = state.step("\x1b");
  assert.deepStrictEqual(decision, { kind: "consumed", enteredNormal: true });
  assert.strictEqual(state.mode, "normal");
});

// ---------------------------------------------------------------------------
// Normal mode: motions
// ---------------------------------------------------------------------------

it("moves the cursor with h/l/j/k in normal mode", () => {
  const { model, state } = makeState(["foo", "bar"], { line: 0, col: 1 });
  toNormal(state);
  state.step("h");
  assert.deepStrictEqual(model.getCursor(), { line: 0, col: 0 });
  state.step("l");
  assert.deepStrictEqual(model.getCursor(), { line: 0, col: 1 });
  state.step("j");
  assert.deepStrictEqual(model.getCursor(), { line: 1, col: 1 });
  state.step("k");
  assert.deepStrictEqual(model.getCursor(), { line: 0, col: 1 });
});

it("clamps h/l at the line edges and j/k at the last line", () => {
  const { model, state } = makeState(["foo"], { line: 0, col: 0 });
  toNormal(state);
  state.step("h");
  assert.deepStrictEqual(model.getCursor(), { line: 0, col: 0 });
  state.step("k");
  assert.deepStrictEqual(model.getCursor(), { line: 0, col: 0 });
  state.step("$");
  state.step("l");
  assert.deepStrictEqual(model.getCursor(), { line: 0, col: 3 });
  state.step("j");
  assert.deepStrictEqual(model.getCursor(), { line: 0, col: 3 });
});

it("word motions w/b/e and line motions 0/$ target the right positions", () => {
  const { model, state } = makeState(["foo bar baz"], { line: 0, col: 0 });
  toNormal(state);
  state.step("w");
  assert.deepStrictEqual(model.getCursor(), { line: 0, col: 4 });
  state.step("b");
  assert.deepStrictEqual(model.getCursor(), { line: 0, col: 0 });
  state.step("e");
  assert.deepStrictEqual(model.getCursor(), { line: 0, col: 2 });
  state.step("0");
  assert.deepStrictEqual(model.getCursor(), { line: 0, col: 0 });
  state.step("$");
  assert.deepStrictEqual(model.getCursor(), { line: 0, col: 11 });
});

it("word motions move across lines", () => {
  const { model, state } = makeState(["foo", "bar"], { line: 0, col: 3 });
  toNormal(state);
  state.step("w");
  assert.deepStrictEqual(model.getCursor(), { line: 1, col: 0 });
  state.step("b"); // no word before on line 1 → start of the last word on line 0
  assert.deepStrictEqual(model.getCursor(), { line: 0, col: 0 });
  state.step("e");
  assert.deepStrictEqual(model.getCursor(), { line: 0, col: 2 });
});

// ---------------------------------------------------------------------------
// Normal mode: entering Insert
// ---------------------------------------------------------------------------

it("i returns to insert with the cursor unchanged", () => {
  const { model, state } = makeState(["foo"], { line: 0, col: 1 });
  toNormal(state);
  state.step("i");
  assert.strictEqual(state.mode, "insert");
  assert.deepStrictEqual(model.getCursor(), { line: 0, col: 1 });
});

it("a returns to insert with the cursor one column right", () => {
  const { model, state } = makeState(["foo"], { line: 0, col: 1 });
  toNormal(state);
  state.step("a");
  assert.strictEqual(state.mode, "insert");
  assert.deepStrictEqual(model.getCursor(), { line: 0, col: 2 });
});

it("o opens a new line below and enters insert on it", () => {
  const { model, state } = makeState(["foo", "bar"], { line: 0, col: 1 });
  toNormal(state);
  state.step("o");
  assert.strictEqual(state.mode, "insert");
  assert.deepStrictEqual(model.lines, ["foo", "", "bar"]);
  assert.deepStrictEqual(model.getCursor(), { line: 1, col: 0 });
});

// ---------------------------------------------------------------------------
// Normal mode: delegation rules
// ---------------------------------------------------------------------------

it("delegates arrows, escape, tab, and control chords in normal mode", () => {
  const { state } = makeState(["foo"]);
  toNormal(state);
  for (const data of ["\x1b[B", "\x1b", "\t", "\x1b[P", "\x1b[Z"]) {
    assert.deepStrictEqual(state.step(data), { kind: "pass-through" });
  }
  assert.strictEqual(state.mode, "normal");
});

it("consumes bare letters that are not vim commands in normal mode", () => {
  const { model, state } = makeState(["foo"], { line: 0, col: 0 });
  toNormal(state);
  const decision = state.step("q");
  assert.deepStrictEqual(decision, { kind: "consumed" });
  assert.strictEqual(model.getText(), "foo"); // not inserted
  assert.strictEqual(state.mode, "normal");
});

// ---------------------------------------------------------------------------
// Visual mode
// ---------------------------------------------------------------------------

it("v enters visual mode and v again returns to normal", () => {
  const { state } = makeState(["foo"], { line: 0, col: 1 });
  toNormal(state);
  state.step("v");
  assert.strictEqual(state.mode, "visual");
  assert.deepStrictEqual(state.selection, makeRange({ line: 0, col: 1 }, { line: 0, col: 1 }));
  state.step("v");
  assert.strictEqual(state.mode, "normal");
  assert.strictEqual(state.selection, undefined);
});

it("motions in visual mode extend the selection while the anchor stays fixed", () => {
  const { model, state } = makeState(["foo bar"], { line: 0, col: 1 });
  toNormal(state);
  state.step("v");
  state.step("l");
  assert.deepStrictEqual(state.selection, makeRange({ line: 0, col: 1 }, { line: 0, col: 2 }));
  state.step("w");
  assert.deepStrictEqual(state.selection, makeRange({ line: 0, col: 1 }, { line: 0, col: 4 }));
  assert.deepStrictEqual(state.selection?.anchor, { line: 0, col: 1 });
  assert.deepStrictEqual(model.getCursor(), { line: 0, col: 4 });
});

it("escape in visual mode returns to normal without deleting", () => {
  const { model, state } = makeState(["foo bar"], { line: 0, col: 1 });
  toNormal(state);
  state.step("v");
  state.step("l");
  const decision = state.step("\x1b");
  assert.deepStrictEqual(decision, { kind: "pass-through" }); // delegated to app.interrupt
  assert.strictEqual(state.mode, "normal");
  assert.strictEqual(state.selection, undefined);
  assert.strictEqual(model.getText(), "foo bar");
});

// ---------------------------------------------------------------------------
// Operators (d/c/y/p) + unnamed yank buffer
// ---------------------------------------------------------------------------

it("d w deletes a word-delineated range", () => {
  const { model, state } = makeState(["foo bar"], { line: 0, col: 0 });
  toNormal(state);
  state.step("d");
  state.step("w");
  assert.strictEqual(model.getText(), "bar");
  assert.strictEqual(state.yankBuffer, "foo ");
  assert.deepStrictEqual(model.getCursor(), { line: 0, col: 0 });
});

it("c w changes a word (yank + replace with empty)", () => {
  const { model, state } = makeState(["foo bar"], { line: 0, col: 0 });
  toNormal(state);
  state.step("c");
  state.step("w");
  assert.strictEqual(model.getText(), "bar");
  assert.strictEqual(state.yankBuffer, "foo ");
  assert.strictEqual(state.mode, "normal");
});

it("y w yanks a word and p puts it at the cursor", () => {
  const { model, state } = makeState(["foo bar"], { line: 0, col: 0 });
  toNormal(state);
  state.step("y");
  state.step("w");
  state.step("p");
  assert.strictEqual(state.yankBuffer, "foo ");
  assert.strictEqual(model.getText(), "foo foo bar");
});

it("visual mode d deletes the selection and clears visual", () => {
  const { model, state } = makeState(["foo bar"], { line: 0, col: 1 });
  toNormal(state);
  state.step("v");
  state.step("l");
  state.step("l"); // selection {0,1} → {0,3}
  state.step("d");
  assert.strictEqual(model.getText(), "f bar");
  assert.strictEqual(state.yankBuffer, "oo");
  assert.strictEqual(state.mode, "normal");
  assert.strictEqual(state.selection, undefined);
});

it("visual mode c changes the selection and pushes the old text to the buffer", () => {
  const { model, state } = makeState(["foo bar"], { line: 0, col: 1 });
  toNormal(state);
  state.step("v");
  state.step("l");
  state.step("l");
  state.step("c");
  assert.strictEqual(model.getText(), "f bar");
  assert.strictEqual(state.yankBuffer, "oo");
  assert.strictEqual(state.mode, "normal");
});

it("visual mode y yanks the selection into the unnamed buffer without deleting", () => {
  const { model, state } = makeState(["foo bar"], { line: 0, col: 1 });
  toNormal(state);
  state.step("v");
  state.step("l");
  state.step("l");
  state.step("y");
  assert.strictEqual(model.getText(), "foo bar");
  assert.strictEqual(state.yankBuffer, "oo");
  assert.strictEqual(state.mode, "normal");
});

it("operator with no following motion is a no-op", () => {
  const { model, state } = makeState(["foo bar"], { line: 0, col: 0 });
  toNormal(state);
  state.step("d");
  const decision = state.step("\x1b[B"); // non-motion delegates
  assert.deepStrictEqual(decision, { kind: "pass-through" });
  assert.strictEqual(model.getText(), "foo bar");
  assert.strictEqual(state.yankBuffer, undefined);
  // the pending operator was aborted: the next motion is a plain move
  state.step("w");
  assert.deepStrictEqual(model.getCursor(), { line: 0, col: 4 });
});

it("put with an empty unnamed buffer is a no-op", () => {
  const { model, state } = makeState(["foo"], { line: 0, col: 0 });
  toNormal(state);
  state.step("p");
  assert.strictEqual(model.getText(), "foo");
});
