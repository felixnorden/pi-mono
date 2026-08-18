import { afterEach, assert, it } from "@effect/vitest";
import { vi } from "vitest";
import { Effect } from "effect";
import {
  CustomEditor,
  type KeybindingsManager,
  type ThemeColor,
} from "@earendil-works/pi-coding-agent";
import {
  KeybindingsManager as TuiKeybindingsManager,
  setKeybindings,
  TUI_KEYBINDINGS,
  type EditorTheme,
  type TUI,
} from "@earendil-works/pi-tui";
import { TuiEditor, type TuiEditorOptions } from "../ui/editor.ts";
import { vimModeGlyph, vimModeTint } from "./mode-indicator.ts";
import {
  EditorTintService,
  EditorTintServiceDefault,
  type EditorTintServiceHandle,
  resetEditorTintProviders,
  upsertBorderTintProvider,
} from "../ui/editor-tint.ts";
import { closeAutocomplete } from "./editor-close-autocomplete.ts";

const fakeEditorTheme: EditorTheme = {
  borderColor: (s: string) => s,
  selectList: {
    selectedPrefix: (s: string) => s,
    selectedText: (s: string) => s,
    description: (s: string) => s,
    scrollInfo: (s: string) => s,
    noMatch: (s: string) => s,
  },
};

const makeEditor = (options: TuiEditorOptions = {}): TuiEditor => {
  const tui = {
    terminal: { rows: 24, write() {} },
    requestRender() {},
  } as unknown as TUI;
  // pi hands the editor its richer KeybindingsManager in production; a base
  // pi-tui manager (with the same `matches` surface the tests exercise)
  // suffices here.
  const kb = new TuiKeybindingsManager(TUI_KEYBINDINGS, {}) as unknown as KeybindingsManager;
  setKeybindings(kb);
  return new TuiEditor(tui, fakeEditorTheme, kb, options);
};

/** Spy on the CustomEditor super-handler so we can observe delegation. */
const spyOnSuper = (): ReturnType<typeof vi.spyOn> =>
  vi.spyOn(CustomEditor.prototype, "handleInput").mockImplementation(() => {});

const argsOf = (spy: ReturnType<typeof vi.spyOn>): string[] =>
  spy.mock.calls.map((call: unknown[]) => call[0] as string);

afterEach(() => vi.restoreAllMocks());

// ---------------------------------------------------------------------------
// Gating (vim off ⇒ plain always-insert editor)
// ---------------------------------------------------------------------------

it("passes all input through unchanged when vim is off", () => {
  const editor = makeEditor({ getVimEnabled: () => false });
  const spy = spyOnSuper();
  editor.handleInput("a");
  editor.handleInput("\x1b");
  editor.handleInput("\x1b[B");
  assert.strictEqual(spy.mock.calls.length, 3);
  assert.deepStrictEqual(argsOf(spy), ["a", "\x1b", "\x1b[B"]);
});

// ---------------------------------------------------------------------------
// Insert mode
// ---------------------------------------------------------------------------

it("inserts printable keys through super when vim is on", () => {
  const editor = makeEditor({ getVimEnabled: () => true });
  const spy = spyOnSuper();
  editor.handleInput("h");
  assert.strictEqual(spy.mock.calls.length, 1);
  assert.deepStrictEqual(argsOf(spy), ["h"]);
  assert.strictEqual((editor as unknown as { vimState: { mode: string } }).vimState.mode, "insert");
});

it("escape in insert enters normal and does not reach super", () => {
  const editor = makeEditor({ getVimEnabled: () => true });
  const spy = spyOnSuper();
  editor.handleInput("\x1b");
  assert.strictEqual(spy.mock.calls.length, 0);
  assert.strictEqual((editor as unknown as { vimState: { mode: string } }).vimState.mode, "normal");
});

it("escape in insert closes an open autocomplete popup", () => {
  const editor = makeEditor({ getVimEnabled: () => true });
  // Simulate an open popup through the guarded private surface.
  (editor as unknown as { autocompleteState: unknown }).autocompleteState = "manual";
  assert.strictEqual(editor.isShowingAutocomplete(), true);
  const spy = spyOnSuper();
  editor.handleInput("\x1b");
  assert.strictEqual(editor.isShowingAutocomplete(), false);
  assert.strictEqual(spy.mock.calls.length, 0);
});

// ---------------------------------------------------------------------------
// Normal mode
// ---------------------------------------------------------------------------

it("consumes vim motions and commands in normal mode without reaching super", () => {
  const editor = makeEditor({ getVimEnabled: () => true });
  editor.handleInput("\x1b"); // enter normal
  const spy = spyOnSuper();
  editor.handleInput("l");
  editor.handleInput("w");
  editor.handleInput("i");
  assert.strictEqual(spy.mock.calls.length, 0);
});

it("escapes and control chords in normal mode are delegated to super", () => {
  const editor = makeEditor({ getVimEnabled: () => true });
  editor.handleInput("\x1b"); // enter normal
  const spy = spyOnSuper();
  editor.handleInput("\x1b"); // escape → app.interrupt (passed through)
  editor.handleInput("\x1b[P"); // ctrl+p
  editor.handleInput("\t"); // tab
  assert.strictEqual(spy.mock.calls.length, 3);
});

it("is a plain always-insert editor when the getter is omitted", () => {
  const editor = makeEditor();
  const spy = spyOnSuper();
  editor.handleInput("a");
  assert.strictEqual(spy.mock.calls.length, 1);
  assert.strictEqual((editor as unknown as { vimState: { mode: string } }).vimState.mode, "insert");
});

// ---------------------------------------------------------------------------
// closeAutocomplete (guarded pi internals)
// ---------------------------------------------------------------------------

interface PopupLike {
  isShowingAutocomplete(): boolean;
  cancelAutocomplete?(): void;
  clearAutocompleteUi?(): void;
}

it("closes an open popup via the guarded internals", () => {
  let closed = 0;
  const editor: PopupLike = {
    isShowingAutocomplete: () => true,
    cancelAutocomplete: () => {
      closed++;
    },
  };
  closeAutocomplete(editor);
  assert.strictEqual(closed, 1);
});

it("is a no-op when no popup is showing", () => {
  let closed = 0;
  const editor: PopupLike = {
    isShowingAutocomplete: () => false,
    cancelAutocomplete: () => {
      closed++;
    },
  };
  closeAutocomplete(editor);
  assert.strictEqual(closed, 0);
});

it("degrades softly when the cancel method has been reshaped", () => {
  let cleared = 0;
  const editor: PopupLike = {
    isShowingAutocomplete: () => true,
    clearAutocompleteUi: () => {
      cleared++;
    },
  };
  closeAutocomplete(editor);
  assert.strictEqual(cleared, 1);
});

// ---------------------------------------------------------------------------
// Editor border color (generic tint source + vim registration)
// ---------------------------------------------------------------------------

const makeBorderEditor = (
  tint: (() => ThemeColor | undefined) | undefined,
  extra: TuiEditorOptions = {},
): TuiEditor => {
  const tui = { terminal: { rows: 24, write() {} }, requestRender() {} } as unknown as TUI;
  const kb = new TuiKeybindingsManager(TUI_KEYBINDINGS, {}) as unknown as KeybindingsManager;
  setKeybindings(kb);
  // `borderColor` is identity in the fake theme, so a tint shows up as a
  // literal `<color>:` prefix on the border tokens we assert on.
  return new TuiEditor(tui, fakeEditorTheme, kb, {
    tintPaint: (color, s) => `${color}:${s}`,
    getBorderTint: tint,
    ...extra,
  });
};

const topBorderOf = (editor: TuiEditor): string => editor.render(40)[0] ?? "";

it("keeps pi's border color when no tint source is provided", () => {
  const editor = makeBorderEditor(undefined);
  assert.ok(topBorderOf(editor).includes("╭"));
  assert.ok(!topBorderOf(editor).includes("accent:"));
});

it("keeps pi's border color when the tint source returns undefined", () => {
  const editor = makeBorderEditor(() => undefined);
  assert.ok(!topBorderOf(editor).includes("accent:"));
});

it("tints the border when a tint source returns a color", () => {
  const editor = makeBorderEditor(() => "accent");
  assert.ok(topBorderOf(editor).includes("accent:"));
});

it("tracks a changing tint source across renders", () => {
  let tint: ThemeColor | undefined;
  const editor = makeBorderEditor(() => tint);
  assert.ok(!topBorderOf(editor).includes("accent:"));
  tint = "accent";
  assert.ok(topBorderOf(editor).includes("accent:"));
  tint = undefined;
  assert.ok(!topBorderOf(editor).includes("accent:"));
});

// ---------------------------------------------------------------------------
// vim border-tint registration lives in the editor, not the state machine
// ---------------------------------------------------------------------------

const resolveTint = (): EditorTintServiceHandle =>
  Effect.runSync(
    Effect.service(EditorTintService).pipe(Effect.provide(EditorTintServiceDefault)),
  );

/**
 * Mirror installEditor's wiring on a bare TuiEditor: ask the shared service
 * for the tint and register vim's provider reading the live modal state.
 */
const makeVimTintEditor = (getVimEnabled: () => boolean): TuiEditor => {
  resetEditorTintProviders();
  const tui = { terminal: { rows: 24, write() {} }, requestRender() {} } as unknown as TUI;
  const kb = new TuiKeybindingsManager(TUI_KEYBINDINGS, {}) as unknown as KeybindingsManager;
  setKeybindings(kb);
  const editor = new TuiEditor(tui, fakeEditorTheme, kb, {
    getVimEnabled,
    tintPaint: (color, s) => `${color}:${s}`,
    getBorderTint: () => resolveTint().getTint(),
  });
  resolveTint().configure((current) =>
    upsertBorderTintProvider(current, { id: "vim", getTint: () => vimModeTint(editor.vimState) }),
  );
  return editor;
};

it("vim registers a live provider so the border tracks normal/visual/insert", () => {
  const editor = makeVimTintEditor(() => true);
  assert.ok(!topBorderOf(editor).includes("syntaxOperator:")); // insert
  editor.handleInput("\x1b"); // → normal
  assert.ok(topBorderOf(editor).includes("syntaxOperator:"));
  editor.handleInput("v"); // → visual
  assert.ok(topBorderOf(editor).includes("syntaxNumber:"));
  assert.ok(!topBorderOf(editor).includes("syntaxOperator:"));
  editor.handleInput("\x1b"); // → normal
  assert.ok(topBorderOf(editor).includes("syntaxOperator:"));
  editor.handleInput("i"); // → insert
  assert.ok(!topBorderOf(editor).includes("syntaxOperator:"));
});

it("vim stays untinted when the toggle is off", () => {
  const editor = makeVimTintEditor(() => false);
  editor.handleInput("\x1b"); // even an escape cannot leave insert gated off
  assert.ok(!topBorderOf(editor).includes("syntaxOperator:"));
});

it("another extension can override vim's tint through configure", () => {
  const editor = makeVimTintEditor(() => true);
  editor.handleInput("\x1b"); // normal → vim tints syntaxOperator
  assert.ok(topBorderOf(editor).includes("syntaxOperator:"));
  // A later .configure from a different extension takes precedence.
  resolveTint().configure((cur) =>
    upsertBorderTintProvider(cur, { id: "my-extension", getTint: () => "error" }),
  );
  assert.ok(topBorderOf(editor).includes("error:"));
  assert.ok(!topBorderOf(editor).includes("syntaxOperator:"));
});

// ---------------------------------------------------------------------------
// vim mode indicator (injectable top-border glyph)
// ---------------------------------------------------------------------------

/**
 * Mirror installEditor's wiring on a bare TuiEditor: the editor asks the
 * injected getter; installEditor supplies vim's live glyph reading the modal
 * state.
 */
const makeVimGlyphEditor = (getVimEnabled: () => boolean): TuiEditor => {
  const tui = { terminal: { rows: 24, write() {} }, requestRender() {} } as unknown as TUI;
  const kb = new TuiKeybindingsManager(TUI_KEYBINDINGS, {}) as unknown as KeybindingsManager;
  setKeybindings(kb);
  const editor = new TuiEditor(tui, fakeEditorTheme, kb, {
    getVimEnabled,
    getModeIndicator: () => vimModeGlyph(editor.vimState),
  });
  return editor;
};

it("keeps the border glyph-free when no indicator is injected", () => {
  const editor = makeEditor({ getVimEnabled: () => true });
  assert.ok(!topBorderOf(editor).includes("N"));
  assert.ok(!topBorderOf(editor).includes("I"));
  assert.ok(!topBorderOf(editor).includes("V"));
});

it("shows the insert letter by default and tracks mode transitions", () => {
  const editor = makeVimGlyphEditor(() => true);
  assert.ok(topBorderOf(editor).includes("I"));
  editor.handleInput("\x1b"); // → normal
  assert.ok(topBorderOf(editor).includes("N"));
  assert.ok(!topBorderOf(editor).includes("I"));
  editor.handleInput("v"); // → visual
  assert.ok(topBorderOf(editor).includes("V"));
  assert.ok(!topBorderOf(editor).includes("N"));
  editor.handleInput("\x1b"); // → normal
  editor.handleInput("i"); // → insert
  assert.ok(topBorderOf(editor).includes("I"));
});

it("stays glyph-free when vim is off", () => {
  const editor = makeVimGlyphEditor(() => false);
  editor.handleInput("\x1b"); // gated; cannot leave insert
  assert.ok(!topBorderOf(editor).includes("N"));
  assert.ok(!topBorderOf(editor).includes("V"));
  assert.ok(!topBorderOf(editor).includes("I"));
});
