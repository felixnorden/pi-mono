import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import type { EditorMode } from "./editor-state.ts";

/**
 * vim-mode → editor presentation mappings (border tint, top-border glyph).
 *
 * The generic editor host never knows vim exists: `installEditor` injects
 * these through the editor's options (`getBorderTint`, `getModeIndicator`)
 * and evaluates them live on every render. Keeping the mappings here, pure
 * and unit-tested, mirrors `selection-render.ts` — vim presentation logic
 * lives in `vim/`, chrome stays in `ui/`.
 */

/** The modal state both mappings read. */
export interface VimModeState {
  readonly enabled: boolean;
  readonly mode: EditorMode;
}

/**
 * vim's border tint for the current modal state: block-style modes tint the
 * border (visual uses a distinct color from normal); insert and vim-off fall
 * through to pi's border.
 */
export function vimModeTint(state: VimModeState): ThemeColor | undefined {
  if (!state.enabled) return undefined;
  if (state.mode === "visual") return "syntaxNumber";
  if (state.mode === "normal") return "syntaxOperator";
  return undefined;
}

/**
 * vim's mode indicator for the current modal state: a single letter on the
 * editor's top border (N normal, V visual, I insert); vim-off yields
 * nothing. Injectable via `TuiEditorOptions.getModeIndicator` — the editor
 * never knows vim exists, installEditor supplies the live glyph reading the
 * modal state.
 */
export function vimModeGlyph(state: VimModeState): string | undefined {
  if (!state.enabled) return undefined;
  if (state.mode === "normal") return "N";
  if (state.mode === "visual") return "V";
  return "I";
}
