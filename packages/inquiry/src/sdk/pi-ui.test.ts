import { describe, expect, it, vi } from "vitest";
import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { initialMachineState, step, type MachineState } from "../core/machine.ts";
import { KeyEvent } from "../core/keyboard.ts";
import { Option, Question } from "../core/domain.ts";
import { codePointToUtf16, makeSceneRenderer, runQuestionUi, utf16ToCodePoint } from "./pi-ui.ts";

describe("makeSceneRenderer cache", () => {
  const fixture = (): { state: MachineState; theme: Theme; paints: () => number } => {
    let count = 0;
    const theme = {
      fg: (_color: string, text: string): string => {
        count++;
        return text;
      },
      inverse: (text: string): string => {
        count++;
        return text;
      },
      bold: (text: string): string => text,
    } as unknown as Theme;
    const state = initialMachineState([
      new Question({
        id: "q1",
        label: "Q1",
        prompt: "Pick one?",
        options: [new Option({ label: "Yes" }), new Option({ label: "No" })],
        allowOther: true,
        multiple: false,
      }),
    ]);
    return { state, theme, paints: () => count };
  };

  it("serves the cached lines across frames while state and width are unchanged", () => {
    const { state, theme, paints } = fixture();
    const cell = { state };
    const scene = makeSceneRenderer(() => cell.state, theme);
    const first = scene.render(40);
    expect(paints()).toBeGreaterThan(0);
    const before = paints();
    expect(scene.render(40)).toBe(first); // same array, no repaint
    expect(scene.render(40)).toBe(first);
    expect(paints()).toBe(before);
  });

  it("repaints when the terminal width changes", () => {
    const { state, theme, paints } = fixture();
    const cell = { state };
    const scene = makeSceneRenderer(() => cell.state, theme);
    scene.render(40);
    const before = paints();
    const resized = scene.render(50);
    expect(resized.length).toBeGreaterThan(0);
    expect(paints()).toBeGreaterThan(before);
  });

  it("repaints when the machine emits a new state snapshot", () => {
    const { state, theme, paints } = fixture();
    const cell = { state };
    const scene = makeSceneRenderer(() => cell.state, theme);
    scene.render(40);
    const before = paints();
    cell.state = step(cell.state, KeyEvent.down).state; // fresh immutable snapshot
    scene.render(40);
    expect(paints()).toBeGreaterThan(before);
  });

  it("invalidate() forces a repaint so cached colors follow theme changes", () => {
    const { state, theme, paints } = fixture();
    const cell = { state };
    const scene = makeSceneRenderer(() => cell.state, theme);
    scene.render(40);
    const before = paints();
    scene.invalidate(); // the TUI calls this on theme changes
    scene.render(40);
    expect(paints()).toBeGreaterThan(before);
  });
});

describe("runQuestionUi input routing", () => {
  // A fake extension UI that captures the component returned by the custom
  // factory and records tool-expansion toggles. `custom` never resolves — the
  // questionnaire only closes when the flow calls `done`.
  const makeFakeUi = (): {
    ui: ExtensionUIContext;
    component: () => { handleInput: (data: string) => void };
    setToolsExpanded: ReturnType<typeof vi.fn>;
  } => {
    let expanded = false;
    let component: { handleInput: (data: string) => void } | undefined;
    // Mirror the app's KEYBINDINGS: TUI defaults plus the app.tools.expand
    // action (default ctrl+o), so `matches` has real semantics.
    const keybindings = new KeybindingsManager({
      ...TUI_KEYBINDINGS,
      "app.tools.expand": { defaultKeys: "ctrl+o" },
    });
    const ui = {
      custom: (
        factory: (
          tui: unknown,
          theme: unknown,
          injectedKeybindings: unknown,
          done: () => void,
        ) => unknown,
      ) => {
        component = factory({ requestRender: () => {} }, {}, keybindings, () => {}) as {
          handleInput: (data: string) => void;
        };
        return new Promise(() => {});
      },
      getToolsExpanded: () => expanded,
      setToolsExpanded: vi.fn((value: boolean) => {
        expanded = value;
      }),
    };
    return {
      ui: ui as unknown as ExtensionUIContext,
      component: () => component!,
      setToolsExpanded: ui.setToolsExpanded as unknown as ReturnType<typeof vi.fn>,
    };
  };

  const questions = [
    new Question({
      id: "q1",
      label: "Q1",
      prompt: "Pick one?",
      options: [new Option({ label: "Yes" })],
      allowOther: true,
      multiple: false,
    }),
  ];

  it("toggles tool output expansion on ctrl+o while the questionnaire is open", () => {
    const { ui, component, setToolsExpanded } = makeFakeUi();
    void runQuestionUi(ui, questions, "/tmp");
    component().handleInput("\x0f"); // ctrl+o
    expect(setToolsExpanded).toHaveBeenCalledWith(true);
    component().handleInput("\x0f");
    expect(setToolsExpanded).toHaveBeenCalledWith(false);
  });

  it("does not treat other keys as the expand toggle", () => {
    const { ui, component, setToolsExpanded } = makeFakeUi();
    void runQuestionUi(ui, questions, "/tmp");
    // ctrl+e is not the expand toggle by default.
    component().handleInput("\x05");
    expect(setToolsExpanded).not.toHaveBeenCalled();
  });

  it("does not swallow question-flow keys", () => {
    const { ui, component, setToolsExpanded } = makeFakeUi();
    void runQuestionUi(ui, questions, "/tmp");
    // 'a' is a printable character the flow feeds into the answer editor.
    component().handleInput("a");
    expect(setToolsExpanded).not.toHaveBeenCalled();
  });
});

describe("cursor unit conversion", () => {
  it("round-trips ASCII text", () => {
    const text = "@src/main.ts";
    for (let i = 0; i <= text.length; i++) {
      expect(utf16ToCodePoint(text, codePointToUtf16(text, i))).toBe(i);
    }
  });

  it("counts surrogate pairs as single code points", () => {
    // 😀 is 2 UTF-16 code units but 1 code point
    const text = "😀 @s";
    expect(codePointToUtf16(text, 0)).toBe(0);
    expect(codePointToUtf16(text, 1)).toBe(2); // after the emoji
    expect(codePointToUtf16(text, 2)).toBe(3); // after the space
    expect(codePointToUtf16(text, 4)).toBe(5); // end of text
    expect(utf16ToCodePoint(text, 5)).toBe(4);
    expect(utf16ToCodePoint(text, 2)).toBe(1);
  });

  it("clamps out-of-range cursors", () => {
    expect(codePointToUtf16("ab", 99)).toBe(2);
    expect(codePointToUtf16("ab", -1)).toBe(0);
    expect(utf16ToCodePoint("ab", 99)).toBe(2);
    expect(utf16ToCodePoint("ab", -1)).toBe(0);
  });
});
