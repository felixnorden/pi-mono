/**
 * Pure text measurement and wrapping helpers.
 *
 * The core never deals with ANSI codes or terminal themes, only plain strings
 * and their visible widths. Styling is applied later by the fringe painter.
 */

/** Width in terminal columns of a single character (code point). */
export const charWidth = (ch: string): number => {
  const cp = ch.codePointAt(0) ?? 0;
  if (cp === 0x09) return 3; // tab
  if (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f)) return 0; // control
  if (cp === 0x200d) return 0; // zero-width joiner
  if ((cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0xe0100 && cp <= 0xe01ef)) return 0; // variation selectors
  if (/\p{Mark}/u.test(ch)) return 0; // combining marks
  if (isWide(cp)) return 2;
  return 1;
};

/** Visible width of a string in terminal columns. */
export const visibleWidth = (text: string): number => {
  let width = 0;
  for (const ch of text) {
    width += charWidth(ch);
  }
  return width;
};

/** Truncate `text` to at most `width` visible columns, cutting whole characters. */
export const truncateToWidth = (text: string, width: number): string => {
  if (width <= 0) return "";
  if (visibleWidth(text) <= width) return text;
  let out = "";
  let used = 0;
  for (const ch of text) {
    const w = charWidth(ch);
    if (used + w > width) break;
    out += ch;
    used += w;
  }
  return out;
};

/**
 * Wrap plain text to a maximum visible width per line.
 *
 * Word-aware: whitespace runs separate tokens; tokens longer than the width
 * are broken character by character. Trailing whitespace is trimmed. Literal
 * newlines split lines. Mirrors the wrapping semantics of pi-tui's
 * `wrapTextWithAnsi` for unstyled text.
 */
export const wrapText = (text: string, width: number): readonly string[] => {
  if (width <= 0) return [""];
  const out: string[] = [];
  for (const segment of text.split(/\r\n|\r|\n/)) {
    out.push(...wrapSegment(segment, width));
  }
  return out.length > 0 ? out : [""];
};

const wrapSegment = (segment: string, width: number): readonly string[] => {
  if (segment === "") return [""];
  if (visibleWidth(segment) <= width) return [segment];
  const tokens = segment.split(/(\s+)/);
  const lines: string[] = [];
  let current = "";
  let currentWidth = 0;
  for (const token of tokens) {
    const tokenWidth = visibleWidth(token);
    const isWhitespace = token.trim() === "";
    if (tokenWidth > width && !isWhitespace) {
      if (current !== "") {
        lines.push(current.trimEnd());
        current = "";
        currentWidth = 0;
      }
      const broken = breakLongToken(token, width);
      for (let i = 0; i < broken.length - 1; i++) lines.push(broken[i]!);
      current = broken[broken.length - 1]!;
      currentWidth = visibleWidth(current);
      continue;
    }
    if (currentWidth + tokenWidth > width && current !== "") {
      lines.push(current.trimEnd());
      current = isWhitespace ? "" : token;
      currentWidth = isWhitespace ? 0 : tokenWidth;
    } else {
      if (current === "" && isWhitespace) continue;
      current += token;
      currentWidth += tokenWidth;
    }
  }
  if (current !== "") lines.push(current.trimEnd());
  return lines.length > 0 ? lines : [""];
};

const breakLongToken = (token: string, width: number): readonly string[] => {
  const lines: string[] = [];
  let current = "";
  let currentWidth = 0;
  for (const ch of token) {
    const w = visibleWidth(ch);
    if (currentWidth + w > width && current !== "") {
      lines.push(current);
      current = "";
      currentWidth = 0;
    }
    current += ch;
    currentWidth += w;
  }
  if (current !== "") lines.push(current);
  return lines.length > 0 ? lines : [""];
};

/** East Asian wide/fullwidth and emoji ranges (wcwidth-style). */
const isWide = (cp: number): boolean =>
  (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
  (cp >= 0x231a && cp <= 0x231b) ||
  (cp >= 0x2329 && cp <= 0x232a) ||
  (cp >= 0x23e9 && cp <= 0x23ec) ||
  cp === 0x23f0 ||
  cp === 0x23f3 ||
  (cp >= 0x25fd && cp <= 0x25fe) ||
  (cp >= 0x2614 && cp <= 0x2615) ||
  (cp >= 0x2648 && cp <= 0x2653) ||
  cp === 0x267f ||
  cp === 0x2693 ||
  cp === 0x26a1 ||
  (cp >= 0x26aa && cp <= 0x26ab) ||
  (cp >= 0x26bd && cp <= 0x26be) ||
  (cp >= 0x26c4 && cp <= 0x26c5) ||
  cp === 0x26ce ||
  cp === 0x26d4 ||
  cp === 0x26ea ||
  (cp >= 0x26f2 && cp <= 0x26f3) ||
  cp === 0x26f5 ||
  cp === 0x26fa ||
  cp === 0x26fd ||
  cp === 0x2705 ||
  (cp >= 0x270a && cp <= 0x270b) ||
  cp === 0x2728 ||
  cp === 0x274c ||
  cp === 0x274e ||
  (cp >= 0x2753 && cp <= 0x2755) ||
  cp === 0x2757 ||
  (cp >= 0x2795 && cp <= 0x2797) ||
  cp === 0x27b0 ||
  cp === 0x27bf ||
  (cp >= 0x2b1b && cp <= 0x2b1c) ||
  cp === 0x2b50 ||
  cp === 0x2b55 ||
  (cp >= 0x2e80 && cp <= 0x303e) || // CJK Radicals .. CJK Symbols and Punctuation
  (cp >= 0x3041 && cp <= 0x33ff) || // Hiragana .. CJK Compatibility
  (cp >= 0x3400 && cp <= 0x4dbf) || // CJK Extension A
  (cp >= 0x4e00 && cp <= 0x9fff) || // CJK Unified Ideographs
  (cp >= 0xa000 && cp <= 0xa4cf) || // Yi
  (cp >= 0xa960 && cp <= 0xa97f) ||
  (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul syllables
  (cp >= 0xf900 && cp <= 0xfaff) ||
  (cp >= 0xfe10 && cp <= 0xfe19) ||
  (cp >= 0xfe30 && cp <= 0xfe6f) ||
  (cp >= 0xff00 && cp <= 0xff60) || // Fullwidth forms
  (cp >= 0xffe0 && cp <= 0xffe6) ||
  cp === 0x1f004 ||
  cp === 0x1f0cf ||
  cp === 0x1f18e ||
  (cp >= 0x1f191 && cp <= 0x1f19a) ||
  (cp >= 0x1f1e6 && cp <= 0x1f1ff) || // regional indicators
  (cp >= 0x1f200 && cp <= 0x1f320) ||
  (cp >= 0x1f32d && cp <= 0x1f335) ||
  (cp >= 0x1f337 && cp <= 0x1f37c) ||
  (cp >= 0x1f37e && cp <= 0x1f393) ||
  (cp >= 0x1f3a0 && cp <= 0x1f3ca) ||
  (cp >= 0x1f3cf && cp <= 0x1f3d3) ||
  (cp >= 0x1f3e0 && cp <= 0x1f3f0) ||
  cp === 0x1f3f4 ||
  (cp >= 0x1f3f8 && cp <= 0x1f43e) ||
  cp === 0x1f440 ||
  (cp >= 0x1f442 && cp <= 0x1f4fc) ||
  (cp >= 0x1f4ff && cp <= 0x1f53d) ||
  (cp >= 0x1f54b && cp <= 0x1f54e) ||
  (cp >= 0x1f550 && cp <= 0x1f567) ||
  cp === 0x1f57a ||
  (cp >= 0x1f595 && cp <= 0x1f596) ||
  cp === 0x1f5a4 ||
  (cp >= 0x1f5fb && cp <= 0x1f64f) ||
  (cp >= 0x1f680 && cp <= 0x1f6c5) ||
  cp === 0x1f6cc ||
  (cp >= 0x1f6d0 && cp <= 0x1f6d2) ||
  (cp >= 0x1f6d5 && cp <= 0x1f6d7) ||
  (cp >= 0x1f6dc && cp <= 0x1f6df) ||
  (cp >= 0x1f6eb && cp <= 0x1f6ec) ||
  (cp >= 0x1f6f4 && cp <= 0x1f6fc) ||
  (cp >= 0x1f7e0 && cp <= 0x1f7eb) ||
  cp === 0x1f7f0 ||
  (cp >= 0x1f90c && cp <= 0x1f93a) ||
  (cp >= 0x1f93c && cp <= 0x1f945) ||
  (cp >= 0x1f947 && cp <= 0x1f9ff) ||
  (cp >= 0x1fa70 && cp <= 0x1fa7c) ||
  (cp >= 0x1fa80 && cp <= 0x1fa88) ||
  (cp >= 0x1fa90 && cp <= 0x1fabd) ||
  (cp >= 0x1fabf && cp <= 0x1fac5) ||
  cp === 0x1face ||
  (cp >= 0x1fae0 && cp <= 0x1fae8) ||
  (cp >= 0x1faf0 && cp <= 0x1faf8) ||
  (cp >= 0x20000 && cp <= 0x2fffd) || // CJK Extensions B..
  (cp >= 0x30000 && cp <= 0x3fffd);
