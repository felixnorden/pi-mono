import {
  CustomEditor,
  type ExtensionAPI,
  type ExtensionContext,
  type KeybindingsManager,
  type Theme,
  type ThemeColor,
} from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
  inspectAutocompleteInternals,
  type AutocompleteInternals,
} from "../autocomplete-contract.ts";
import { makeBorderedBox } from "../components/bordered-box.ts";
import { buildBoxFrame, composeBorderLine } from "../frame/box-frame.ts";
import { findBottomBorderIndex, isEditorBorderLine, padRight, stripAnsi } from "../utils.ts";
import { closeAutocomplete } from "../vim/editor-close-autocomplete.ts";
import { VimEditorState } from "../vim/editor-state.ts";
import { vimModeGlyph, vimModeTint } from "../vim/mode-indicator.ts";
import { type EditorTintServiceHandle, upsertBorderTintProvider } from "./editor-tint.ts";
import { renderSelection } from "../vim/selection-render.ts";
import { type Cursor, type Range, type VimTextModelShape } from "../vim/text-model.ts";
import { wordBackward, wordEnd, wordForward } from "../vim/word-motion.ts";

/**
 * Top or bottom border of the editor frame, composed from the shared
 * {@link buildBoxFrame} model and {@link composeBorderLine} so every box in
 * the package uses the same geometry. The top border carries the host
 * editor's scroll hint (`↓ N more`) and, when one is injected, the mode
 * indicator glyph (`N · ↓ 3 more`), with a single trailing space instead of
 * the model's default decorative dash tail — hence the `labelSuffix`
 * override.
 */
function roundedBorder(
  width: number,
  kind: "top" | "bottom",
  paint: (s: string) => string,
  sourceLine?: string,
  modeGlyph?: string,
): string {
  const scrollLabel =
    sourceLine === undefined ? undefined : stripAnsi(sourceLine).match(/([↑↓]\s+\d+\s+more)/)?.[1];
  // The mode glyph and the scroll hint share the border's single label slot;
  // join them with the house separator so a narrow editor drops both together.
  const label =
    modeGlyph === undefined
      ? scrollLabel
      : scrollLabel === undefined
        ? modeGlyph
        : `${modeGlyph} · ${scrollLabel}`;
  const frame = buildBoxFrame(width, {
    label,
    labelWidth: label === undefined ? undefined : visibleWidth(label),
    labelSuffix: label === undefined ? undefined : " ",
    minLabelWidth: 3,
    paddingX: 0,
  });
  // The caller guards `width < 4`, so the frame is never null here; the
  // fallback only narrows the type for the degenerate model.
  if (!frame) return paint(kind === "top" ? "╭╮" : "╰╯");
  return composeBorderLine(frame, kind, paint);
}

export interface TuiEditorOptions {
  /** Called once when the autocomplete internals contract no longer matches. */
  readonly onAutocompleteMismatch?: (detail: string) => void;
  /** Live vim toggle; the editor is a plain always-insert editor when off. */
  readonly getVimEnabled?: () => boolean;
  /** Paint applied to the visual-mode selection span (default: identity). */
  readonly paintSelection?: (s: string) => string;
  /**
   * Current border tint to apply (e.g. from the shared EditorTintService), or
   * undefined to keep pi's own border color. Generic — the editor has no
   * notion of what supplied the color.
   */
  readonly getBorderTint?: () => ThemeColor | undefined;
  /** Paints a given theme color onto text (e.g. `theme.fg(color, s)`). */
  readonly tintPaint?: (color: ThemeColor, s: string) => string;
  /**
   * Live mode indicator for the top border (e.g. vim's N/I/V letter), or
   * undefined for none. A thunk so the glyph follows mode changes on every
   * render; when the scroll hint is also present the two share the label
   * slot (`N · ↓ 3 more`). Generic — the editor has no notion of what
   * supplied the glyph.
   */
  readonly getModeIndicator?: () => string | undefined;
}

export class TuiEditor extends CustomEditor {
  // BorderedBox paints its rails via theme.fg(color, text); route every token
  // through the editor's own border paint so the suggestion box follows bash
  // mode / thinking-level recoloring and any registered border tint like the
  // input frame does.
  private readonly boxTheme: Theme;
  private readonly onAutocompleteMismatch?: (detail: string) => void;
  private readonly paintSelection: (s: string) => string;
  private readonly getBorderTint?: () => ThemeColor | undefined;
  private readonly tintPaint?: (color: ThemeColor, s: string) => string;
  private readonly getModeIndicator?: () => string | undefined;
  /** The modal state machine backing vim; read by the package's tint wiring. */
  readonly vimState: VimEditorState;
  private autocompleteDiagnosed = false;

  constructor(
    tui: TUI,
    editorTheme: EditorTheme,
    keybindings: KeybindingsManager,
    options: TuiEditorOptions = {},
  ) {
    super(tui, editorTheme, keybindings, { paddingX: 0 });
    this.boxTheme = {
      fg: (_color: ThemeColor, s: string) => this.borderPaint(s),
    } as unknown as Theme;
    this.onAutocompleteMismatch = options.onAutocompleteMismatch;
    this.paintSelection = options.paintSelection ?? ((s: string) => s);
    this.getBorderTint = options.getBorderTint;
    this.tintPaint = options.tintPaint;
    this.getModeIndicator = options.getModeIndicator;
    // The editor exposes its text through a VimTextModelShape adapter (the
    // state machine stays a plain class over that interface; gate off by
    // default). `moveToLineStart`/`moveToLineEnd` live in the adapter because
    // the pi-tui base class already owns those private names.
    this.vimState = new VimEditorState(
      this.buildVimModel(),
      options.getVimEnabled ?? (() => false),
    );
  }

  override setPaddingX(_padding: number): void {
    // The custom rail owns the horizontal inset and keeps one stable text gap.
    super.setPaddingX(0);
  }

  /**
   * Validated view of pi's autocomplete internals. When the contract no
   * longer matches (pi internals changed shape), report once and return
   * undefined so rendering falls back to the unframed passthrough.
   */
  private getAutocompleteView(): AutocompleteInternals | undefined {
    const inspection = inspectAutocompleteInternals(this);
    if (inspection.ok) {
      // Both fields are set and cleared together in the built-in editor, so
      // active suggestions without a render-able list mean a rename/shape
      // change rather than a transient in-flight state.
      if (this.isShowingAutocomplete() && inspection.view.autocompleteList === undefined) {
        this.reportAutocompleteMismatch("autocomplete is active but no render-able list was found");
      }
      return inspection.view;
    }
    this.reportAutocompleteMismatch(inspection.issue);
    return undefined;
  }

  private reportAutocompleteMismatch(detail: string): void {
    if (this.autocompleteDiagnosed) return;
    this.autocompleteDiagnosed = true;
    this.onAutocompleteMismatch?.(detail);
  }

  // -------------------------------------------------------------------------
  // VimTextModelShape over the real editor
  // -------------------------------------------------------------------------

  /**
   * The state machine's view of this editor. `moveToLineStart`/
   * `moveToLineEnd` are pure cursor computations provided here because the
   * pi-tui base class owns those private names (they would collide on the
   * class itself).
   */
  private buildVimModel(): VimTextModelShape {
    return {
      getText: () => this.getText(),
      getCursor: () => this.getCursor(),
      moveCursorTo: (c) => this.moveCursorTo(c),
      getLineCount: () => this.getLineCount(),
      lineLength: (line) => this.lineLength(line),
      moveWordForward: (from) => this.moveWordForward(from),
      moveWordBackward: (from) => this.moveWordBackward(from),
      moveWordEnd: (from) => this.moveWordEnd(from),
      moveToLineStart: (c) => ({ line: c.line, col: 0 }),
      moveToLineEnd: (c) => ({ line: c.line, col: this.lineLength(c.line) }),
      deleteRange: (range) => this.deleteRange(range),
      yankRange: (range) => this.yankRange(range),
      replaceRange: (range, text) => this.replaceRange(range, text),
      insertTextAtCursor: (text) => this.insertTextAtCursor(text),
    };
  }

  getLineCount(): number {
    return this.getLines().length;
  }

  lineLength(line: number): number {
    return this.getLines()[line]?.length ?? 0;
  }

  /**
   * Move the cursor, clamped to the text bounds. Writes the private editor
   * state through a guarded surface (pi-tui has no public cursor-setter);
   * `setCursorCol` is preferred because it clears the insert-mode sticky
   * column so vim motions never inherit it.
   */
  moveCursorTo(c: Cursor): void {
    const internal = this as unknown as {
      state?: { cursorLine?: number; cursorCol?: number };
      setCursorCol?: (col: number) => void;
    };
    if (!internal.state) return;
    const line = Math.max(0, Math.min(c.line, this.getLineCount() - 1));
    const col = Math.max(0, Math.min(c.col, this.lineLength(line)));
    internal.state.cursorLine = line;
    if (typeof internal.setCursorCol === "function") internal.setCursorCol(col);
    else internal.state.cursorCol = col;
  }

  moveWordForward(from: Cursor): Cursor {
    return wordForward(this.getLines(), from);
  }

  moveWordBackward(from: Cursor): Cursor {
    return wordBackward(this.getLines(), from);
  }

  moveWordEnd(from: Cursor): Cursor {
    return wordEnd(this.getLines(), from);
  }

  /** Absolute index of a cursor in the newline-joined text. */
  private absoluteIndex(c: Cursor): number {
    const lines = this.getLines();
    let idx = 0;
    for (let i = 0; i < c.line; i++) idx += (lines[i]?.length ?? 0) + 1;
    return idx + c.col;
  }

  deleteRange(range: Range): void {
    const flat = this.getText();
    const startIdx = this.absoluteIndex(range.start);
    const endIdx = this.absoluteIndex(range.end);
    this.setText(flat.slice(0, startIdx) + flat.slice(endIdx));
    // setText resets the cursor to the end; restore it to the range start.
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
    this.setText(flat.slice(0, startIdx) + text + flat.slice(endIdx));
    this.moveCursorTo(range.start);
  }

  override handleInput(data: string): void {
    const decision = this.vimState.step(data);
    if (decision.kind === "consumed") {
      // Entering Normal (Escape in Insert) closes the autocomplete popup
      // (binding decision 2); the TUI re-renders after handleInput.
      if (decision.enteredNormal) closeAutocomplete(this);
      return;
    }
    super.handleInput(data);
  }

  /**
   * The border paint for the current state. A registered border tint (from
   * the shared EditorTintService, which vim or any extension may contribute)
   * overrides pi's own `borderColor`; with no tint, bash/thinking recoloring
   * keeps working untouched.
   */
  private borderPaint(s: string): string {
    const tint = this.getBorderTint?.();
    if (tint !== undefined && this.tintPaint) return this.tintPaint(tint, s);
    return this.borderColor(s);
  }

  override render(width: number): string[] {
    if (width < 4) return super.render(width);

    const rail = this.borderPaint("│");
    const borderPaint = (s: string) => this.borderPaint(s);
    const innerWidth = Math.max(0, width - 4);
    const baseLines = super.render(innerWidth);

    // While suggestions are showing, the built-in editor appends the list
    // right after the input's bottom border. The split point comes from the
    // validated internals contract; when the contract is unavailable (pi
    // internals changed shape) we fall back to the scan below.
    const internals = this.getAutocompleteView();
    const list = internals?.autocompleteList;
    const listLines = list ? list.render(innerWidth) : [];
    const hasFramedList =
      this.isShowingAutocomplete() &&
      listLines.length > 0 &&
      baseLines.length > listLines.length + 1;
    const bottomIdx = hasFramedList
      ? baseLines.length - listLines.length - 1
      : findBottomBorderIndex(baseLines);

    // Visual-mode selection highlight: paint the state machine's range onto
    // the content lines (between the top border at 0 and the bottom border at
    // bottomIdx). First cut maps the logical range onto the rendered lines.
    const selection = this.vimState.selection;
    const contentLines = selection
      ? renderSelection({
          lines: baseLines.slice(1, bottomIdx),
          selection,
          paint: this.paintSelection,
        })
      : undefined;

    const result: string[] = [];
    result.push(roundedBorder(width, "top", borderPaint, baseLines[0], this.getModeIndicator?.()));

    for (let i = 1; i < bottomIdx; i++) {
      const line = contentLines ? (contentLines[i - 1] ?? "") : (baseLines[i] ?? "");
      if (isEditorBorderLine(line)) {
        result.push(`${rail} ${padRight("", innerWidth)} ${rail}`);
      } else {
        result.push(`${rail} ${padRight(line, innerWidth)} ${rail}`);
      }
    }

    result.push(roundedBorder(width, "bottom", borderPaint, baseLines[bottomIdx]));

    if (hasFramedList) {
      const prefix = internals?.autocompletePrefix;
      const label = truncateToWidth(
        `suggestions${prefix ? ` · ${prefix}` : ""}`,
        Math.max(4, width - 16),
        "",
      );
      const box = makeBorderedBox(
        { render: () => listLines, invalidate: () => {} },
        this.boxTheme,
        { label, paddingX: 1 },
      );
      result.push(...box.render(width));
    } else {
      for (let i = bottomIdx + 1; i < baseLines.length; i++) {
        result.push(baseLines[i]!);
      }
    }

    return result.map((line) => truncateToWidth(line, width, ""));
  }
}

export function installEditor(
  _pi: ExtensionAPI,
  ctx: ExtensionContext,
  options: {
    readonly getVimEnabled: () => boolean;
    readonly tint: EditorTintServiceHandle;
  },
): () => void {
  ctx.ui.setEditorComponent((tui, editorTheme, keybindings) => {
    const editor = new TuiEditor(tui, editorTheme, keybindings, {
      getVimEnabled: options.getVimEnabled,
      // Paints the resolved border tint through the theme's color fg().
      tintPaint: (color, s) => ctx.ui.theme.fg(color, s),
      // The editor stays generic: it asks the shared service for a tint and
      // knows nothing about vim. vim is just one provider registered here.
      getBorderTint: () => options.tint.getTint(),
      // vim registers its own live mode indicator (the editor stays generic
      // and just asks the injected getter per render, like the tint).
      getModeIndicator: () => vimModeGlyph(editor.vimState),
      paintSelection: (s) => ctx.ui.theme.inverse(s),
      onAutocompleteMismatch: (detail) => {
        const message =
          `[pi-tui] built-in autocomplete internals no longer match the expected contract ` +
          `(${detail}); suggestion framing disabled. ` +
          `This usually means the bundled pi editor changed shape — please update this extension.`;
        console.warn(message);
        // notify may request a render; defer so we never re-enter from inside a render pass.
        queueMicrotask(() =>
          ctx.ui.notify(
            "Autocomplete framing disabled: internals changed shape (see logs).",
            "warning",
          ),
        );
      },
    });
    // Register vim's own border-tint provider into the shared service. The
    // getTint closure reads the editor's live modal state, so the border
    // tracks normal/visual/insert without the editor knowing vim exists.
    options.tint.configure((current) =>
      upsertBorderTintProvider(current, {
        id: "vim",
        getTint: () => vimModeTint(editor.vimState),
      }),
    );
    return editor;
  });
  return () => {
    ctx.ui.setEditorComponent(undefined);
  };
}
