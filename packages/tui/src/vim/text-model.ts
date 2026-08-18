import { Context, Layer } from "effect";

/**
 * Cursor position in the text model: logical line index and column within
 * that line (UTF-16 code units, matching pi-tui's editor columns).
 */
export interface Cursor {
  readonly line: number;
  readonly col: number;
}

/**
 * One range concept (binding decision 3): Visual selections AND Normal-mode
 * operator motions share this single primitive.
 *
 * `anchor` is the selection start point (fixed while the selection is
 * extended); `active` is the moving end. `start`/`end` are the normalized
 * span (min/max of anchor/active, ordered by line then column). Text
 * operations consume `[start, end)` — start inclusive, end exclusive.
 */
export interface Range {
  readonly anchor: Cursor;
  readonly active: Cursor;
  readonly start: Cursor;
  readonly end: Cursor;
}

function order(a: Cursor, b: Cursor): [Cursor, Cursor] {
  return a.line < b.line || (a.line === b.line && a.col <= b.col) ? [a, b] : [b, a];
}

/** Build a {@link Range} from anchor and active, normalizing start/end. */
export function makeRange(anchor: Cursor, active: Cursor): Range {
  const [start, end] = order(anchor, active);
  return { anchor, active, start, end };
}

/**
 * The state machine's dependency: a plain interface over the text the vim
 * mode edits. Motions, selection, and operators all operate on this shape, so
 * the `VimEditorState` core is pure and unit-testable without pi-tui
 * internals. `TuiEditor` implements it over the real editor; tests provide a
 * fake with real line/word geometry through the `VimTextModel` service tag.
 */
export interface VimTextModelShape {
  readonly getText: () => string;
  readonly getCursor: () => Cursor;
  readonly moveCursorTo: (c: Cursor) => void;
  readonly getLineCount: () => number;
  readonly lineLength: (line: number) => number;
  // motion geometry
  readonly moveWordForward: (from: Cursor) => Cursor;
  readonly moveWordBackward: (from: Cursor) => Cursor;
  readonly moveWordEnd: (from: Cursor) => Cursor;
  readonly moveToLineStart: (c: Cursor) => Cursor;
  readonly moveToLineEnd: (c: Cursor) => Cursor;
  // operations (Slice 5): consume `[range.start, range.end)`
  readonly deleteRange: (range: Range) => void;
  readonly yankRange: (range: Range) => string;
  readonly replaceRange: (range: Range, text: string) => void;
  readonly insertTextAtCursor: (text: string) => void;
}

/**
 * Effect service tag over the same shape (house service pattern). Layers and
 * tests provide doubles via `layerFrom`; the host wires the real editor
 * through the session's effect context.
 */
export class VimTextModel extends Context.Service<VimTextModel, VimTextModelShape>()(
  "tui/vim/VimTextModel",
) {
  static layerFrom(model: VimTextModelShape): Layer.Layer<VimTextModel> {
    return Layer.succeed(VimTextModel, VimTextModel.of(model));
  }
}
