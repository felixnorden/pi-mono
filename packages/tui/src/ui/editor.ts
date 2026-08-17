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

/**
 * Top or bottom border of the editor frame, composed from the shared
 * {@link buildBoxFrame} model and {@link composeBorderLine} so every box in
 * the package uses the same geometry. The top border carries the host
 * editor's scroll hint (`↓ N more`) with a single trailing space instead of
 * the model's default decorative dash tail — hence the `labelSuffix`
 * override.
 */
function roundedBorder(
  width: number,
  kind: "top" | "bottom",
  paint: (s: string) => string,
  sourceLine?: string,
): string {
  const scrollLabel =
    sourceLine === undefined ? undefined : stripAnsi(sourceLine).match(/([↑↓]\s+\d+\s+more)/)?.[1];
  const frame = buildBoxFrame(width, {
    label: scrollLabel,
    labelWidth: scrollLabel === undefined ? undefined : visibleWidth(scrollLabel),
    labelSuffix: scrollLabel === undefined ? undefined : " ",
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
}

export class TuiEditor extends CustomEditor {
  private readonly getRail: () => string;
  private readonly getBorder: (s: string) => string;
  // BorderedBox paints its rails via theme.fg(color, text); route every token
  // through the editor's own border color so the suggestion box follows bash
  // mode / thinking-level recoloring like the input frame does.
  private readonly boxTheme: Theme;
  private readonly onAutocompleteMismatch?: (detail: string) => void;
  private autocompleteDiagnosed = false;

  constructor(
    tui: TUI,
    editorTheme: EditorTheme,
    keybindings: KeybindingsManager,
    options: TuiEditorOptions = {},
  ) {
    super(tui, editorTheme, keybindings, { paddingX: 0 });
    // via updateEditorBorderColor() — bash mode ("! " prefix → green) and
    // thinking-level borders both flow through this one property.
    this.getRail = () => this.borderColor("│");
    this.getBorder = (s: string) => this.borderColor(s);
    this.boxTheme = {
      fg: (_color: ThemeColor, s: string) => this.borderColor(s),
    } as unknown as Theme;
    this.onAutocompleteMismatch = options.onAutocompleteMismatch;
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

  override render(width: number): string[] {
    if (width < 4) return super.render(width);

    const rail = this.getRail();
    const borderPaint = this.getBorder;
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

    const result: string[] = [];
    result.push(roundedBorder(width, "top", borderPaint, baseLines[0]));

    for (let i = 1; i < bottomIdx; i++) {
      const line = baseLines[i] ?? "";
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

export function installEditor(_pi: ExtensionAPI, ctx: ExtensionContext): () => void {
  ctx.ui.setEditorComponent(
    (tui, editorTheme, keybindings) =>
      new TuiEditor(tui, editorTheme, keybindings, {
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
      }),
  );
  return () => {
    ctx.ui.setEditorComponent(undefined);
  };
}
