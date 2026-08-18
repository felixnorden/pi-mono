import type { Cursor } from "./text-model.ts";

/**
 * Pure word-motion geometry over plain lines, shared by the real editor's
 * `VimTextModelShape` implementation and the test fakes (a fake with real
 * geometry per the London-school test-double guidance).
 *
 * A "word" is a run of non-whitespace characters. Motions operate on logical
 * lines and compose across newlines; they never mutate anything.
 */

const isWs = (ch: string | undefined): boolean => ch === undefined || /\s/.test(ch);

/**
 * Vim `w`: the start of the next word at or after `col`, or `line.length`
 * when the line has no further word. Skips the current word run, then any
 * whitespace, and returns the first non-whitespace index.
 */
export function findWordStart(line: string, col: number): number {
  const n = line.length;
  if (n === 0) return 0;
  let i = Math.min(col, n);
  while (i < n && !isWs(line[i])) i++;
  while (i < n && isWs(line[i])) i++;
  return i;
}

/**
 * Vim `b`: the start of the word at or before `col`. Skips whitespace
 * backwards, then the preceding word run; returns the word's first index.
 * Returns 0 when no word precedes on this line.
 */
export function findWordBackStart(line: string, col: number): number {
  const n = line.length;
  let i = Math.min(col, n);
  while (i > 0 && isWs(line[i - 1])) i--;
  while (i > 0 && !isWs(line[i - 1])) i--;
  return i;
}

/**
 * Vim `e`: the index of the last character of the word at or after `col`
 * (inclusive). Whitespace is skipped forward first. Returns `line.length`
 * when no word is ahead on this line.
 */
export function findWordEnd(line: string, col: number): number {
  const n = line.length;
  if (n === 0) return 0;
  let i = Math.min(col, n - 1);
  while (i < n && isWs(line[i])) i++;
  if (i >= n) return n;
  while (i + 1 < n && !isWs(line[i + 1])) i++;
  return i;
}

/** `w` across lines: next word start; at the end of a line, next line's start. */
export function wordForward(lines: readonly string[], from: Cursor): Cursor {
  const line = lines[from.line] ?? "";
  const target = findWordStart(line, from.col);
  if (target < line.length || (target === 0 && line.length === 0)) {
    return { line: from.line, col: target };
  }
  if (from.line < lines.length - 1) return { line: from.line + 1, col: 0 };
  return { line: from.line, col: line.length };
}

/** `b` across lines: previous word start; at a line start, the previous line's last word. */
export function wordBackward(lines: readonly string[], from: Cursor): Cursor {
  if (from.line === 0 && from.col === 0) return from;
  const line = lines[from.line] ?? "";
  const target = findWordBackStart(line, from.col);
  if (target > 0 || (from.col > 0 && target === 0)) {
    return { line: from.line, col: target };
  }
  const prev = lines[from.line - 1] ?? "";
  return { line: from.line - 1, col: findWordBackStart(prev, prev.length) };
}

/** `e` across lines: end of the current/next word; at a line end, the next line's first word. */
export function wordEnd(lines: readonly string[], from: Cursor): Cursor {
  const line = lines[from.line] ?? "";
  const at = Math.min(from.col, line.length);
  if (at >= line.length) {
    if (from.line < lines.length - 1) {
      const next = lines[from.line + 1] ?? "";
      const end = findWordEnd(next, 0);
      return { line: from.line + 1, col: end === 0 && next.length > 0 ? 0 : end };
    }
    return from;
  }
  const target = findWordEnd(line, from.col);
  if (target !== from.col) return { line: from.line, col: target };
  // Already at the end of the current word: move to the end of the next word.
  const nextTarget = findWordEnd(line, from.col + 1);
  return { line: from.line, col: nextTarget };
}
