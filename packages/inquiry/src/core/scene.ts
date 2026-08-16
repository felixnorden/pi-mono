/**
 * Scene model: the pure, terminal-agnostic rendering output of the core.
 *
 * A scene is a list of lines; a line is a list of spans. Each span carries
 * plain text plus an optional style token from our own palette. The fringe
 * painter maps style tokens to the pi theme and emits ANSI. The core never
 * touches ANSI codes or terminal themes.
 */

import type { MachineState } from "./machine.ts";
import { currentOptions, isAllAnswered, type SuggestionState } from "./machine.ts";
import { truncateToWidth, visibleWidth } from "./text.ts";
import type { EditorState } from "./editor.ts";

export type Style =
  | "accent"
  | "border"
  | "muted"
  | "dim"
  | "text"
  | "success"
  | "warning"
  | "cursor"
  | "toolTitle";

export interface Span {
  readonly text: string;
  readonly style?: Style;
  readonly bold?: boolean;
}

export type SceneLine = readonly Span[];

export interface Scene {
  readonly lines: readonly SceneLine[];
}

export const span = (text: string, style?: Style, bold = false): Span => ({
  text,
  ...(style === undefined ? {} : { style }),
  ...(bold ? { bold: true } : {}),
});

export const line = (...spans: readonly Span[]): SceneLine => spans;

/** Concatenated plain text of a line (used by tests and simple consumers). */
export const plain = (sceneLine: SceneLine): string => sceneLine.map((s) => s.text).join("");

/**
 * Word-wrap a styled line to a maximum visible width, preserving spans across
 * line breaks. Continuation lines keep the styles of the tokens they contain.
 * Literal newlines inside spans split lines.
 */
export const wrapLine = (content: SceneLine, width: number): readonly SceneLine[] => {
  if (width <= 0) return [content];

  // Split at literal newlines first
  const segments: Span[][] = [[]];
  for (const s of content) {
    const parts = s.text.split(/(\r\n|\r|\n)/);
    for (const part of parts) {
      if (part === "\r\n" || part === "\r" || part === "\n") {
        segments.push([]);
        continue;
      }
      if (part !== "")
        segments[segments.length - 1]!.push({ text: part, style: s.style, bold: s.bold });
    }
  }

  const out: SceneLine[] = [];
  for (const segment of segments) {
    out.push(...wrapSegment(segment, width));
  }
  return out;
};

const wrapSegment = (segment: SceneLine, width: number): readonly SceneLine[] => {
  if (segment.length === 0) return [[]];
  const joined = plain(segment);
  if (visibleWidth(joined) <= width) return [segment];

  // Split spans into whitespace/non-whitespace tokens, preserving style
  const tokens: Span[] = [];
  for (const s of segment) {
    for (const part of s.text.split(/(\s+)/)) {
      if (part !== "") tokens.push({ text: part, style: s.style, bold: s.bold });
    }
  }

  const lines: Span[][] = [];
  let current: Span[] = [];
  let currentWidth = 0;
  for (const token of tokens) {
    const tokenWidth = visibleWidth(token.text);
    const isWhitespace = token.text.trim() === "";
    if (tokenWidth > width && !isWhitespace) {
      if (current.length > 0) {
        lines.push(trimEndLine(current));
        current = [];
        currentWidth = 0;
      }
      const broken = breakLongSpan(token, width);
      for (let i = 0; i < broken.length - 1; i++) lines.push(broken[i]!);
      current = broken[broken.length - 1]!;
      currentWidth = visibleWidth(plain(current));
      continue;
    }
    if (currentWidth + tokenWidth > width && current.length > 0) {
      lines.push(trimEndLine(current));
      current = isWhitespace ? [] : [token];
      currentWidth = isWhitespace ? 0 : tokenWidth;
    } else {
      if (current.length === 0 && isWhitespace) continue;
      current.push(token);
      currentWidth += tokenWidth;
    }
  }
  if (current.length > 0) lines.push(trimEndLine(current));
  return lines.length > 0 ? lines : [[]];
};

const trimEndLine = (spans: Span[]): Span[] => {
  const out = spans.slice();
  while (out.length > 0 && out[out.length - 1]!.text.trim() === "") out.pop();
  if (out.length === 0) return [];
  const last = out[out.length - 1]!;
  out[out.length - 1] = { ...last, text: last.text.trimEnd() };
  return out;
};

const breakLongSpan = (token: Span, width: number): readonly Span[][] => {
  const chunks: string[] = [];
  let current = "";
  let currentWidth = 0;
  for (const ch of token.text) {
    const w = visibleWidth(ch);
    if (currentWidth + w > width && current !== "") {
      chunks.push(current);
      current = "";
      currentWidth = 0;
    }
    current += ch;
    currentWidth += w;
  }
  if (current !== "") chunks.push(current);
  if (chunks.length === 0) chunks.push("");
  return chunks.map((text) => [{ text, style: token.style, bold: token.bold }]);
};

/**
 * Build the scene for the current machine state.
 *
 * Layout mirrors the legacy tools: accent separators, wrapped prompt,
 * numbered options with `→ ` selection marker (the same arrow the main
 * editor's autocomplete popup uses), optional tab bar, inline editor box,
 * and a help line.
 */
export const buildScene = (state: MachineState, width: number): Scene => {
  const renderWidth = Math.max(1, width);
  const lines: SceneLine[] = [];
  const question = state.questions[state.currentTab];
  const options = currentOptions(state);

  const pushWrapped = (prefix: Span, content: SceneLine): void => {
    const prefixWidth = visibleWidth(prefix.text);
    if (prefixWidth >= renderWidth) {
      lines.push([prefix, ...content]);
      return;
    }
    const wrapped = wrapLine(content, renderWidth - prefixWidth);
    for (let i = 0; i < wrapped.length; i++) {
      lines.push(
        i === 0 ? [prefix, ...wrapped[i]!] : [span(" ".repeat(prefixWidth)), ...wrapped[i]!],
      );
    }
  };

  const pushSeparator = (): void => {
    lines.push([span("─".repeat(renderWidth), "accent")]);
  };

  const renderOptions = (): void => {
    for (let i = 0; i < options.length; i++) {
      const option = options[i]!;
      const selected = i === state.optionIndex;
      const isOther = option.isOther;
      const labelText = `${i + 1}. ${option.label}${isOther && state.inputMode ? " ✎" : ""}`;
      const color = selected || (isOther && state.inputMode) ? "accent" : "text";
      pushWrapped(selected ? span("→ ", "accent") : span("  "), [span(labelText, color)]);
      if (option.description) {
        pushWrapped(span("     "), [span(option.description, "muted")]);
      } else if (option.isOther && !state.inputMode && question) {
        // Show an existing custom answer as a subtitle under "Type something".
        const answer = state.answers.get(question.id);
        if (answer?.wasCustom) {
          pushWrapped(span("     "), [span(`Current answer: ${answer.label}`, "muted")]);
        }
      }
    }
  };

  pushSeparator();

  // Tab bar (multi-question mode only)
  if (state.mode === "multi") {
    const tabs: Span[] = [span("← ")];
    for (let i = 0; i < state.questions.length; i++) {
      const q = state.questions[i]!;
      const active = i === state.currentTab;
      const answered = state.answers.has(q.id);
      // Active tab gets a bordered square (`▣`); finished tabs are solid
      // (`■`), unfinished ones are outline squares (`□`). No background
      // fill — like the editor popup, the current item is marked by symbol
      // and accent color rather than a greyed block.
      const box = active ? "▣" : answered ? "■" : "□";
      const color = active ? "accent" : answered ? "success" : "muted";
      tabs.push(span(` ${box} ${q.label} `, color), span(" "));
    }
    const canSubmit = isAllAnswered(state);
    const isSubmitTab = state.currentTab === state.questions.length;
    const submitText = " ✓ Submit ";
    tabs.push(
      isSubmitTab ? span(submitText, "accent") : span(submitText, canSubmit ? "success" : "dim"),
      span(" →"),
    );
    pushWrapped(span(" "), tabs);
    lines.push([]);
  }

  // Content
  if (state.inputMode && question) {
    pushWrapped(span(" "), [span(question.prompt, "text")]);
    lines.push([]);
    renderOptions();
    lines.push([]);
    pushWrapped(span(" "), [span("Your answer:", "muted")]);
    for (const editorLine of buildEditorBox(state.editor, Math.max(1, renderWidth - 2))) {
      lines.push([span(" "), ...editorLine]);
    }
    if (state.suggestions) {
      for (const popupLine of buildSuggestionPopup(
        state.suggestions,
        Math.max(1, renderWidth - 6),
      )) {
        lines.push([span("  "), ...popupLine]);
      }
    }
    lines.push([]);
    if (state.suggestions) {
      pushWrapped(span(" "), [span("↑↓ pick • Enter/Tab complete • Esc close", "dim")]);
    } else {
      pushWrapped(span(" "), [
        span("Enter to submit • Shift+Enter for newline • Esc to go back", "dim"),
      ]);
    }
  } else if (state.currentTab === state.questions.length) {
    pushWrapped(span(" "), [span("Ready to submit", "accent", true)]);
    lines.push([]);
    for (const q of state.questions) {
      const answer = state.answers.get(q.id);
      if (answer) {
        const prefix = answer.wasCustom ? "(wrote) " : "";
        pushWrapped(span(" "), [
          span(`${q.label}: `, "muted"),
          span(prefix + answer.label, "text"),
        ]);
      }
    }
    lines.push([]);
    if (isAllAnswered(state)) {
      pushWrapped(span(" "), [span("Press Enter to submit", "success")]);
    } else {
      const missing = state.questions
        .filter((q) => !state.answers.has(q.id))
        .map((q) => q.label)
        .join(", ");
      pushWrapped(span(" "), [span(`Unanswered: ${missing}`, "warning")]);
    }
  } else if (question) {
    pushWrapped(span(" "), [span(question.prompt, "text")]);
    lines.push([]);
    renderOptions();
  }

  lines.push([]);
  if (!state.inputMode) {
    const help =
      state.mode === "multi"
        ? "Tab/←→ navigate • ↑↓ select • Enter confirm • Esc cancel"
        : "↑↓ navigate • Enter to select • Esc to cancel";
    pushWrapped(span(" "), [span(help, "dim")]);
  }
  pushSeparator();

  return { lines };
};

/**
 * Build the inline editor box lines (without the leading gutter space).
 *
 * Mirrors the legacy pi-tui editor look: accent `─` borders, content wrapped
 * to `boxWidth - 1` (one column reserved for the cursor), the cursor drawn as
 * an inverse-video cell (replacing the character under it, or a trailing
 * space at end of text), and content lines padded to the box width.
 */
/**
 * Build the editor box: a rounded frame (`╭─╮` / `╰─╯`) with vertical rails,
 * matching the box style of the tui and tracker extensions. Content is
 * word-wrapped to `boxWidth - 4` (one space of padding inside each rail) and
 * padded so the rails stay flush; the cursor is drawn as a reverse-video
 * cell (a trailing space at the end of the text).
 */
export const buildEditorBox = (editor: EditorState, boxWidth: number): readonly SceneLine[] => {
  const box = Math.max(4, boxWidth);
  const contentWidth = box - 4;

  const chars = Array.from(editor.text);
  const cursor = Math.min(editor.cursor, chars.length);

  // Split into logical lines at newlines, wrap each to the content width, and
  // flatten into rendered rows. Each row records the UTF-16 offset of its start
  // within the original text so the cursor can be placed precisely.
  const rows: LayoutChunk[] = [];
  let offset = 0;
  for (const lineText of editor.text.split("\n")) {
    for (const chunk of layoutChunks(lineText, contentWidth)) {
      rows.push({ text: chunk.text, start: offset + chunk.start });
    }
    offset += lineText.length + 1; // +1 for the newline
  }

  const cursorUtf16 = chars.slice(0, cursor).join("").length;
  let cursorRow = rows.length - 1;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    if (cursorUtf16 >= row.start && cursorUtf16 <= row.start + row.text.length) {
      cursorRow = i;
      break;
    }
  }

  const frame = (char: string): Span => span(char, "border");

  const out: SceneLine[] = [];
  out.push([frame("╭"), frame("─".repeat(box - 2)), frame("╮")]);

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const rowChars = Array.from(row.text);
    let cursorAtEnd = false;
    let cursorCol = 0;
    if (i === cursorRow) {
      if (cursorUtf16 >= row.start + row.text.length) {
        cursorAtEnd = true;
        cursorCol = rowChars.length;
      } else {
        cursorCol = Array.from(row.text.slice(0, cursorUtf16 - row.start)).length;
      }
    }
    const spans: Span[] = [];
    for (let j = 0; j < rowChars.length; j++) {
      if (i === cursorRow && j === cursorCol && !cursorAtEnd) {
        spans.push(span(rowChars[j]!, "cursor"));
      } else {
        spans.push(span(rowChars[j]!));
      }
    }
    if (i === cursorRow && cursorAtEnd) {
      spans.push(span(" ", "cursor"));
    }
    // Pad content to the content width so the rails stay flush (the cursor
    // cell counts toward the width).
    const renderedWidth = visibleWidth(plain(spans));
    const padding = " ".repeat(Math.max(0, contentWidth - renderedWidth));
    if (padding) spans.push(span(padding));
    out.push([frame("│"), span(" "), ...spans, span(" "), frame("│")]);
  }

  out.push([frame("╰"), frame("─".repeat(box - 2)), frame("╯")]);
  return out;
};

interface LayoutChunk {
  readonly text: string;
  /** UTF-16 offset of the chunk start within the original text. */
  readonly start: number;
}

/**
 * Build the file-completion popup lines (without the leading gutter).
 *
 * Mirrors pi-tui's SelectList used by the main editor: the highlighted item
 * is marked with `→ ` and rendered in accent foreground (the main editor's
 * `theme.selectList.selectedText` — no background fill), descriptions align
 * in a primary column when width allows, and a `(n/m)` indicator appears
 * when the list overflows the visible window of five items.
 */
export const buildSuggestionPopup = (
  suggestions: SuggestionState,
  width: number,
): readonly SceneLine[] => {
  const renderWidth = Math.max(10, width);
  const { items, selectedIndex } = suggestions;
  const maxVisible = 5;
  const start = Math.max(
    0,
    Math.min(selectedIndex - Math.floor(maxVisible / 2), Math.max(0, items.length - maxVisible)),
  );
  const end = Math.min(start + maxVisible, items.length);

  const lines: SceneLine[] = [];
  for (let i = start; i < end; i++) {
    const item = items[i]!;
    const isSelected = i === selectedIndex;
    const marker = isSelected ? "→ " : "  ";
    const label = item.label;
    const description = item.description?.replace(/\r\n|\r|\n/g, " ");
    if (description && renderWidth > 40) {
      const primary = Math.max(1, Math.min(32, renderWidth - 6));
      const maxPrimary = Math.max(1, primary - 2);
      const truncatedLabel = truncateToWidth(label, maxPrimary);
      const spacing = " ".repeat(Math.max(1, primary - visibleWidth(truncatedLabel)));
      const remaining = renderWidth - 2 - visibleWidth(truncatedLabel) - spacing.length - 2;
      if (remaining > 10) {
        const truncatedDescription = truncateToWidth(description, remaining);
        lines.push(
          isSelected
            ? [span(marker + truncatedLabel + spacing + truncatedDescription, "accent")]
            : [
                span(marker),
                span(truncatedLabel),
                span(spacing),
                span(truncatedDescription, "muted"),
              ],
        );
        continue;
      }
    }
    const maxPrimary = renderWidth - 2;
    const truncatedLabel = truncateToWidth(label, maxPrimary);
    lines.push(
      isSelected ? [span(marker + truncatedLabel, "accent")] : [span(marker), span(truncatedLabel)],
    );
  }
  if (start > 0 || end < items.length) {
    lines.push([span(`  (${selectedIndex + 1}/${items.length})`, "muted")]);
  }
  return lines;
};

const layoutChunks = (text: string, width: number): readonly LayoutChunk[] => {
  if (text === "") return [{ text: "", start: 0 }];
  if (visibleWidth(text) <= width) return [{ text, start: 0 }];

  // Whitespace-run tokens with UTF-16 offsets
  const tokens: { text: string; start: number }[] = [];
  const re = /\s+/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    if (match.index > last) tokens.push({ text: text.slice(last, match.index), start: last });
    tokens.push({ text: match[0], start: match.index });
    last = match.index + match[0].length;
  }
  if (last < text.length) tokens.push({ text: text.slice(last), start: last });

  const chunks: LayoutChunk[] = [];
  let current = "";
  let currentStart = 0;
  let currentWidth = 0;
  let hasContent = false;
  for (const token of tokens) {
    const tokenWidth = visibleWidth(token.text);
    const isWhitespace = token.text.trim() === "";
    if (tokenWidth > width && !isWhitespace) {
      if (hasContent) {
        chunks.push({ text: current, start: currentStart });
        current = "";
        currentWidth = 0;
        hasContent = false;
      }
      const pieces = breakLongString(token.text, width);
      for (let i = 0; i < pieces.length - 1; i++) {
        chunks.push({ text: pieces[i]!, start: token.start });
      }
      current = pieces[pieces.length - 1]!;
      currentStart = token.start + (token.text.length - current.length);
      currentWidth = visibleWidth(current);
      hasContent = true;
      continue;
    }
    if (currentWidth + tokenWidth > width && hasContent) {
      chunks.push({ text: current, start: currentStart });
      current = isWhitespace ? "" : token.text;
      currentStart = isWhitespace ? token.start + token.text.length : token.start;
      currentWidth = isWhitespace ? 0 : tokenWidth;
      hasContent = !isWhitespace;
    } else {
      if (!hasContent && isWhitespace) continue;
      if (!hasContent) {
        currentStart = token.start;
        hasContent = true;
      }
      current += token.text;
      currentWidth += tokenWidth;
    }
  }
  if (hasContent) chunks.push({ text: current, start: currentStart });
  if (chunks.length === 0) chunks.push({ text: "", start: 0 });
  return chunks;
};

const breakLongString = (text: string, width: number): readonly string[] => {
  const lines: string[] = [];
  let current = "";
  let currentWidth = 0;
  for (const ch of text) {
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
