import { decodeKittyPrintable, Key, matchesKey } from "@earendil-works/pi-tui";
import { makeRange, type Cursor, type Range, type VimTextModelShape } from "./text-model.ts";

/**
 * Modal state machine for the vim editor: Normal / Visual / Insert.
 *
 * Pure transition core: no Effect imports and no pi-tui internals beyond the
 * pure key-decoding helpers. All text access goes through the
 * {@link VimTextModelShape} interface (the editor implements it; tests use a
 * fake with real geometry). The host editor calls `step` per raw input and
 * delegates to `super.handleInput` only when the decision says pass-through.
 */
export type EditorMode = "insert" | "normal" | "visual";

/**
 * What the host editor should do after a `step`:
 * - `consumed`: vim handled the input; do NOT call `super.handleInput`.
 *   `enteredNormal` is set when the step transitioned from Insert into
 *   Normal (Escape), signalling the host to close any open autocomplete.
 * - `pass-through`: vim did not handle the input; call `super.handleInput`.
 */
export type VimDecision =
  | { readonly kind: "consumed"; readonly enteredNormal?: boolean }
  | { readonly kind: "pass-through" };

const CONSUMED: VimDecision = { kind: "consumed" };
const PASS_THROUGH: VimDecision = { kind: "pass-through" };

type Operator = "d" | "c" | "y";

const MOTIONS = new Set(["h", "j", "k", "l", "w", "b", "e", "0", "^", "$"]);

/**
 * The printable character a raw input represents, or undefined when the
 * input is not a plain (or Shift-modified) text key. Covers Kitty CSI-u
 * sequences via the public `decodeKittyPrintable`, plus the legacy raw
 * single-char case pi's editor itself accepts.
 */
function printableOf(data: string): string | undefined {
  return (
    decodeKittyPrintable(data) ?? (data.length === 1 && data.charCodeAt(0) >= 32 ? data : undefined)
  );
}

export class VimEditorState {
  mode: EditorMode = "insert";
  selection: Range | undefined;
  yankBuffer: string | undefined;
  private pendingOperator: Operator | undefined;

  constructor(
    private readonly model: VimTextModelShape,
    private readonly getVimEnabled: () => boolean,
  ) {}

  /** Whether the vim gate is currently on (drives the cursor style too). */
  get enabled(): boolean {
    return this.getVimEnabled();
  }

  /** Step the state machine with one raw input chunk. */
  step(data: string): VimDecision {
    if (!this.getVimEnabled()) return PASS_THROUGH; // gated; inert
    switch (this.mode) {
      case "insert":
        return this.stepInsert(data);
      case "normal":
        return this.stepNormal(data);
      case "visual":
        return this.stepVisual(data);
    }
  }

  // -------------------------------------------------------------------------
  // Insert
  // -------------------------------------------------------------------------

  private stepInsert(data: string): VimDecision {
    if (matchesKey(data, Key.escape)) {
      // Escape enters Normal (classic vim, assumption 1). Entering Normal
      // closes any open autocomplete popup (binding decision 2).
      this.mode = "normal";
      this.selection = undefined;
      this.pendingOperator = undefined;
      return { kind: "consumed", enteredNormal: true };
    }
    return PASS_THROUGH; // plain always-insert editor in Insert mode
  }

  // -------------------------------------------------------------------------
  // Normal
  // -------------------------------------------------------------------------

  private stepNormal(data: string): VimDecision {
    // Escape in Normal delegates to the app (app.interrupt), unchanged.
    if (matchesKey(data, Key.escape)) return PASS_THROUGH;
    const printable = printableOf(data);
    if (printable === undefined) {
      // Arrows, Tab/autocomplete keys, control chords, shift chords: abort a
      // pending operator and delegate to the existing editor/app handling.
      this.pendingOperator = undefined;
      return PASS_THROUGH;
    }

    if (this.pendingOperator !== undefined) {
      const target = this.resolveMotionCursor(printable);
      if (target !== undefined) {
        this.applyOperator(this.pendingOperator, makeRange(this.model.getCursor(), target));
        this.pendingOperator = undefined;
        return CONSUMED;
      }
      // A non-motion printable aborts the pending operator (no-op).
      this.pendingOperator = undefined;
      return CONSUMED;
    }

    if (MOTIONS.has(printable)) {
      this.moveCursorByMotion(printable);
      return CONSUMED;
    }
    if (printable === "i") {
      this.mode = "insert";
      return CONSUMED;
    }
    if (printable === "a") {
      const cur = this.model.getCursor();
      this.model.moveCursorTo({
        line: cur.line,
        col: Math.min(this.model.lineLength(cur.line), cur.col + 1),
      });
      this.mode = "insert";
      return CONSUMED;
    }
    if (printable === "o") {
      // Open a new line below the cursor: jump to the line end and insert
      // a newline; the model positions the cursor on the fresh line.
      this.model.moveCursorTo(this.model.moveToLineEnd(this.model.getCursor()));
      this.model.insertTextAtCursor("\n");
      this.mode = "insert";
      return CONSUMED;
    }
    if (printable === "v") {
      const cur = this.model.getCursor();
      this.selection = makeRange(cur, cur);
      this.mode = "visual";
      return CONSUMED;
    }
    if (printable === "d" || printable === "c" || printable === "y") {
      this.pendingOperator = printable;
      return CONSUMED;
    }
    if (printable === "p") {
      if (this.yankBuffer !== undefined) this.model.insertTextAtCursor(this.yankBuffer);
      return CONSUMED;
    }
    // Bare letter that is not a vim command: consumed, never inserted.
    return CONSUMED;
  }

  // -------------------------------------------------------------------------
  // Visual
  // -------------------------------------------------------------------------

  private stepVisual(data: string): VimDecision {
    // Escape leaves Visual without deleting and is then passed through so the
    // app interrupt still fires (like Normal-mode Escape).
    if (matchesKey(data, Key.escape)) {
      this.mode = "normal";
      this.selection = undefined;
      return PASS_THROUGH;
    }
    const printable = printableOf(data);
    if (printable === undefined) return PASS_THROUGH; // arrows/ctrl/tab delegate

    if (printable === "v") {
      this.mode = "normal";
      this.selection = undefined;
      return CONSUMED;
    }
    if (printable === "d" || printable === "c" || printable === "y") {
      const sel = this.selection;
      if (sel) {
        if (printable === "d") {
          this.yankBuffer = this.model.yankRange(sel);
          this.model.deleteRange(sel);
        } else if (printable === "c") {
          this.yankBuffer = this.model.yankRange(sel);
          this.model.replaceRange(sel, "");
        } else {
          this.yankBuffer = this.model.yankRange(sel);
        }
      }
      this.mode = "normal";
      this.selection = undefined;
      return CONSUMED;
    }
    if (MOTIONS.has(printable)) {
      this.moveCursorByMotion(printable);
      if (this.selection) {
        // Extend the selection: the anchor stays fixed, the active end moves.
        this.selection = makeRange(this.selection.anchor, this.model.getCursor());
      }
      return CONSUMED;
    }
    // Other printable keys are consumed (nothing is inserted in Visual mode).
    return CONSUMED;
  }

  // -------------------------------------------------------------------------
  // Shared pieces
  // -------------------------------------------------------------------------

  /** True when `c` is one of the motion keys; moves the cursor to its target. */
  private moveCursorByMotion(c: string): boolean {
    const cur = this.model.getCursor();
    switch (c) {
      case "h":
        this.model.moveCursorTo({ line: cur.line, col: Math.max(0, cur.col - 1) });
        return true;
      case "l": {
        const maxCol = this.model.lineLength(cur.line);
        this.model.moveCursorTo({ line: cur.line, col: Math.min(maxCol, cur.col + 1) });
        return true;
      }
      case "j": {
        const next = Math.min(cur.line + 1, this.model.getLineCount() - 1);
        this.model.moveCursorTo({
          line: next,
          col: Math.min(cur.col, this.model.lineLength(next)),
        });
        return true;
      }
      case "k": {
        const prev = Math.max(0, cur.line - 1);
        this.model.moveCursorTo({
          line: prev,
          col: Math.min(cur.col, this.model.lineLength(prev)),
        });
        return true;
      }
      case "w":
        this.model.moveCursorTo(this.model.moveWordForward(cur));
        return true;
      case "b":
        this.model.moveCursorTo(this.model.moveWordBackward(cur));
        return true;
      case "e":
        this.model.moveCursorTo(this.model.moveWordEnd(cur));
        return true;
      case "^":
      case "0":
        this.model.moveCursorTo(this.model.moveToLineStart(cur));
        return true;
      case "$":
        this.model.moveCursorTo(this.model.moveToLineEnd(cur));
        return true;
      default:
        return false;
    }
  }

  /** The motion target for a printable key, or undefined when not a motion. */
  private resolveMotionCursor(c: string): Cursor | undefined {
    const cur = this.model.getCursor();
    switch (c) {
      case "h":
        return { line: cur.line, col: Math.max(0, cur.col - 1) };
      case "l":
        return { line: cur.line, col: Math.min(this.model.lineLength(cur.line), cur.col + 1) };
      case "j": {
        const next = Math.min(cur.line + 1, this.model.getLineCount() - 1);
        return { line: next, col: Math.min(cur.col, this.model.lineLength(next)) };
      }
      case "k": {
        const prev = Math.max(0, cur.line - 1);
        return { line: prev, col: Math.min(cur.col, this.model.lineLength(prev)) };
      }
      case "w":
        return this.model.moveWordForward(cur);
      case "b":
        return this.model.moveWordBackward(cur);
      case "e":
        return this.model.moveWordEnd(cur);
      case "^":
      case "0":
        return this.model.moveToLineStart(cur);
      case "$":
        return this.model.moveToLineEnd(cur);
      default:
        return undefined;
    }
  }

  /**
   * Apply a Normal-mode operator over the motion-delineated range. Deletes and
   * changes push the removed text into the unnamed yank buffer (single put
   * source); the cursor lands at the range start.
   */
  private applyOperator(op: Operator, range: Range): void {
    switch (op) {
      case "d":
        this.yankBuffer = this.model.yankRange(range);
        this.model.deleteRange(range);
        break;
      case "c":
        this.yankBuffer = this.model.yankRange(range);
        this.model.replaceRange(range, "");
        break;
      case "y":
        this.yankBuffer = this.model.yankRange(range);
        break;
    }
  }
}
