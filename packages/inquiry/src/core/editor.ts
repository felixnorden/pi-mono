/**
 * Pure inline text editor state.
 *
 * Replaces the pi-tui `Editor` widget in the core. `cursor` is an index into
 * the code points of `text` (not UTF-16 code units), so backspace and cursor
 * movement operate on full characters, including surrogate pairs.
 */

export interface EditorState {
  readonly text: string;
  /** Cursor position as a code-point index into `text` (0..= code point count). */
  readonly cursor: number;
}

export const emptyEditor = (): EditorState => ({ text: "", cursor: 0 });

/** Editor state with `text` and the cursor at the end (used to pre-fill an existing answer). */
export const editorFromText = (text: string): EditorState => ({
  text,
  cursor: Array.from(text).length,
});

/** Insert `input` at the cursor. */
export const editorInsert = (state: EditorState, input: string): EditorState => {
  if (input === "") return state;
  const chars = Array.from(state.text);
  const at = Math.min(state.cursor, chars.length);
  const inserted = Array.from(input);
  const next = [...chars.slice(0, at), ...inserted, ...chars.slice(at)];
  return { text: next.join(""), cursor: at + inserted.length };
};

/**
 * Sanitize pasted text for insertion.
 *
 * Normalizes line endings, expands tabs (mirroring the pi editor), and drops
 * remaining control characters while keeping newlines.
 */
export const sanitizePaste = (input: string): string => {
  const normalized = input.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\t/g, "    ");
  return Array.from(normalized)
    .filter((ch) => ch === "\n" || (ch.codePointAt(0) ?? 0) >= 0x20)
    .join("");
};

/** Delete the character before the cursor. */
export const editorBackspace = (state: EditorState): EditorState => {
  if (state.cursor <= 0) return state;
  const chars = Array.from(state.text);
  const at = Math.min(state.cursor, chars.length);
  const next = [...chars.slice(0, at - 1), ...chars.slice(at)];
  return { text: next.join(""), cursor: at - 1 };
};

/** Delete the character at the cursor. */
export const editorDelete = (state: EditorState): EditorState => {
  const chars = Array.from(state.text);
  if (state.cursor >= chars.length) return state;
  const next = [...chars.slice(0, state.cursor), ...chars.slice(state.cursor + 1)];
  return { text: next.join(""), cursor: state.cursor };
};

export const editorMoveLeft = (state: EditorState): EditorState => ({
  ...state,
  cursor: Math.max(0, state.cursor - 1),
});

export const editorMoveRight = (state: EditorState): EditorState => ({
  ...state,
  cursor: Math.min(Array.from(state.text).length, state.cursor + 1),
});

export const editorMoveHome = (state: EditorState): EditorState => ({ ...state, cursor: 0 });

export const editorMoveEnd = (state: EditorState): EditorState => ({
  ...state,
  cursor: Array.from(state.text).length,
});
