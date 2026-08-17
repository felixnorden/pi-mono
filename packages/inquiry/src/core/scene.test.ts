import { describe, expect, it } from "vitest";
import { Option, Question, type Question as QuestionType } from "./domain.ts";
import { KeyEvent } from "./keyboard.ts";
import {
  initialMachineState,
  openSuggestions,
  step,
  type MachineState,
  type SuggestionState,
} from "./machine.ts";
import {
  buildEditorBox,
  buildScene,
  buildSuggestionPopup,
  line,
  plain,
  span,
  wrapLine,
  type Scene,
  type SceneLine,
} from "./scene.ts";
import { emptyEditor } from "./editor.ts";

const question = (over: Partial<QuestionType> = {}): QuestionType =>
  new Question({
    id: "q1",
    label: "Q1",
    prompt: "Pick one?",
    options: [new Option({ label: "Yes" }), new Option({ label: "No" })],
    allowOther: true,
    ...over,
  });

const twoQuestions = (): readonly Question[] => [
  question(),
  question({ id: "q2", label: "Q2", prompt: "Second?" }),
];

const plainLines = (scene: Scene): string[] => scene.lines.map(plain);

// Helpers for the house rounded border (╭─╮│╰─╯) that frames the scene.
const boxed = (content: string, width: number): string => "│" + content.padEnd(width - 2) + "│";
const boxTop = (width: number): string => "╭" + "─".repeat(width - 2) + "╮";
const boxBottom = (width: number): string => "╰" + "─".repeat(width - 2) + "╯";

const openEditor = (state: MachineState): MachineState => {
  let s = state;
  s = step(s, KeyEvent.down).state;
  s = step(s, KeyEvent.down).state;
  return step(s, KeyEvent.enter).state;
};

describe("buildScene: single question", () => {
  it("renders a rounded border, prompt, options and help, without a tab bar", () => {
    const scene = buildScene(initialMachineState([question()]), 60);
    const lines = plainLines(scene);
    expect(lines[0]).toBe(boxTop(60));
    expect(lines[1]).toBe(boxed(" Pick one?", 60));
    expect(lines[2]).toBe(boxed("", 60));
    expect(lines[3]).toBe(boxed("→ 1. Yes", 60));
    expect(lines[4]).toBe(boxed("  2. No", 60));
    expect(lines[5]).toBe(boxed("  3. Type something.", 60));
    expect(lines[6]).toBe(boxed("", 60));
    expect(lines[7]).toBe(boxed(" ↑↓ navigate • Enter to select • Esc to cancel", 60));
    expect(lines[8]).toBe(boxBottom(60));
    expect(lines).toHaveLength(9);
  });

  it("marks the selected option with accent spans", () => {
    const scene = buildScene(initialMachineState([question()]), 40);
    // framed: [rail, marker, label, pad..., rail]
    const selectedLine = scene.lines[3]!;
    expect(selectedLine[1]).toEqual({ text: "→ ", style: "accent" });
    expect(selectedLine[2]).toEqual({ text: "1. Yes", style: "accent" });
    const unselectedLine = scene.lines[4]!;
    expect(unselectedLine[2]).toEqual({ text: "2. No", style: "text" });
  });

  it("shows descriptions indented under options", () => {
    const q = question({
      options: [new Option({ label: "Yes", description: "Go ahead" }), new Option({ label: "No" })],
    });
    const scene = buildScene(initialMachineState([q]), 40);
    const lines = plainLines(scene);
    expect(lines.some((l) => l.includes("     Go ahead"))).toBe(true);
  });

  it("wraps long prompts with continuation indentation", () => {
    const q = question({ prompt: "A very long prompt that definitely wraps" });
    const scene = buildScene(initialMachineState([q]), 20);
    const lines = plainLines(scene);
    expect(lines[1]).toBe(boxed(" A very long", 20));
    expect(lines[2]).toBe(boxed(" prompt that", 20));
    expect(lines[3]).toBe(boxed(" definitely wraps", 20));
  });
});

describe("buildScene: multi question", () => {
  it("renders a tab bar with the active tab marked by a bordered square", () => {
    const scene = buildScene(initialMachineState(twoQuestions()), 60);
    const lines = plainLines(scene);
    expect(lines[1]).toBe(boxed(" ←  ▣ Q1   □ Q2   ✓ Submit  →", 60));
    expect(lines[2]).toBe(boxed("", 60));
    expect(lines[3]).toBe(boxed(" Pick one?", 60));
  });

  it("marks answered tabs with filled squares", () => {
    let state = initialMachineState(twoQuestions());
    state = step(state, KeyEvent.enter).state; // answer q1
    const scene = buildScene(state, 60);
    expect(plainLines(scene)[1]).toBe(boxed(" ←  ■ Q1   ▣ Q2   ✓ Submit  →", 60));
  });

  it("shows the submit tab summary with unanswered warnings", () => {
    let state = initialMachineState(twoQuestions());
    state = step(state, KeyEvent.enter).state; // q1 answered, now q2
    state = step(state, KeyEvent.tab).state; // submit tab
    const scene = buildScene(state, 60);
    const lines = plainLines(scene);
    expect(lines[3]).toBe(boxed(" Ready to submit", 60));
    expect(lines[5]).toBe(boxed(" Q1: Yes", 60));
    expect(lines[7]).toBe(boxed(" Unanswered: Q2", 60));
  });

  it("offers submit when all questions are answered", () => {
    let state = initialMachineState(twoQuestions());
    state = step(state, KeyEvent.enter).state;
    state = step(state, KeyEvent.enter).state; // q2 answered, now submit tab
    const scene = buildScene(state, 60);
    const lines = plainLines(scene);
    expect(lines).toContain(boxed(" Press Enter to submit", 60));
    expect(lines.some((l) => l.includes(" Unanswered"))).toBe(false);
  });

  it("shows the custom answer as a subtitle under 'Type something'", () => {
    let state = initialMachineState(twoQuestions());
    state = step(state, KeyEvent.down).state;
    state = step(state, KeyEvent.down).state;
    state = step(state, KeyEvent.enter).state; // open editor
    for (const ch of ["h", "i"]) state = step(state, KeyEvent.char(ch)).state;
    state = step(state, KeyEvent.enter).state; // submit, advance to q2
    state = step(state, KeyEvent.shiftTab).state; // back to q1
    const lines = plainLines(buildScene(state, 60));
    expect(lines.some((l) => l.includes("→ 3. Type something."))).toBe(true);
    expect(lines.some((l) => l.includes("     Current answer: hi"))).toBe(true);
  });

  it("shows the chosen option when returning to its tab", () => {
    let state = initialMachineState(twoQuestions());
    state = step(state, KeyEvent.down).state; // "No"
    state = step(state, KeyEvent.enter).state; // answer q1, advance to q2
    state = step(state, KeyEvent.shiftTab).state; // back to q1
    const lines = plainLines(buildScene(state, 60));
    expect(lines.some((l) => l.includes("→ 2. No"))).toBe(true);
    expect(lines.some((l) => l.includes("Current answer"))).toBe(false);
  });

  it("indents the custom answer subtitle like option descriptions", () => {
    const q = question({
      options: [new Option({ label: "Yes", description: "Go ahead" }), new Option({ label: "No" })],
    });
    let state = initialMachineState([q, question({ id: "q2", label: "Q2", prompt: "Second?" })]);
    state = step(state, KeyEvent.down).state;
    state = step(state, KeyEvent.down).state;
    state = step(state, KeyEvent.enter).state; // open editor
    for (const ch of ["h", "i"]) state = step(state, KeyEvent.char(ch)).state;
    state = step(state, KeyEvent.enter).state; // submit, advance to q2
    state = step(state, KeyEvent.shiftTab).state; // back to q1
    const lines = plainLines(buildScene(state, 60));
    const descLine = lines.find((l) => l.includes("Go ahead"));
    const answerLine = lines.find((l) => l.includes("Current answer: hi"));
    // Both subtitles must share the same indentation inside the box.
    const before = (l: string, text: string) => l.slice(0, l.indexOf(text));
    expect(before(descLine!, "Go ahead")).toBe(before(answerLine!, "Current answer: hi"));
  });

  it("shows a custom answer in the submit summary", () => {
    let state = initialMachineState(twoQuestions());
    state = step(state, KeyEvent.down).state;
    state = step(state, KeyEvent.down).state;
    state = step(state, KeyEvent.enter).state; // open editor
    for (const ch of ["h", "i"]) state = step(state, KeyEvent.char(ch)).state;
    state = step(state, KeyEvent.enter).state; // submit, advance to q2
    state = step(state, KeyEvent.enter).state; // answer q2 "Yes", advance to submit
    const lines = plainLines(buildScene(state, 60));
    expect(lines.some((l) => l.includes(" Q1: (wrote) hi"))).toBe(true);
    expect(lines.some((l) => l.includes(" Q2: Yes"))).toBe(true);
  });
});

describe("buildScene: editor mode", () => {
  it("shows the editor box with prompt and options", () => {
    const scene = buildScene(openEditor(initialMachineState([question()])), 40);
    const lines = plainLines(scene);
    expect(lines[1]).toBe(boxed(" Pick one?", 40));
    expect(lines).toContain(boxed(" Your answer:", 40));
    expect(lines.some((l) => l.includes("Shift+Enter"))).toBe(true);
    expect(lines.some((l) => l.includes("Esc to go back"))).toBe(true);
    expect(lines[3]).toBe(boxed("  1. Yes", 40));
    expect(lines[5]).toBe(boxed("→ 3. Type something. ✎", 40));
    // editor box frame, prefixed with the gutter space, inside the outer rails
    expect(lines[8]).toBe("│ ╭" + "─".repeat(35) + "╮│");
  });

  it("does not render the navigation help while editing", () => {
    const scene = buildScene(openEditor(initialMachineState([question()])), 40);
    const lines = plainLines(scene);
    expect(lines.some((l) => l.includes("navigate"))).toBe(false);
  });

  it("shows the completion popup and its help below the editor", () => {
    let state = openEditor(initialMachineState([question()]));
    state = openSuggestions(state, "@src", [
      { value: "src/main.ts", label: "main.ts", description: "src/main.ts" },
      { value: "src/utils/", label: "utils/", description: "src/utils/" },
    ]);
    const scene = buildScene(state, 40);
    const lines = plainLines(scene);
    const popupStart = lines.findIndex((l) => l.includes("→ main.ts"));
    expect(popupStart).toBeGreaterThan(-1);
    expect(lines[popupStart]).toBe(boxed("  → main.ts", 40));
    expect(lines[popupStart + 1]).toBe(boxed("    utils/", 40));
    expect(lines.some((l) => l.includes("↑↓ pick") && l.includes("Enter/Tab complete"))).toBe(true);
    expect(lines.some((l) => l.includes("Shift+Enter"))).toBe(false);
  });
});

describe("buildSuggestionPopup", () => {
  const suggestions = (): SuggestionState => ({
    prefix: "@src",
    items: [
      { value: "src/main.ts", label: "main.ts", description: "src/main.ts" },
      { value: "src/utils/", label: "utils/", description: "src/utils/" },
    ],
    selectedIndex: 0,
  });

  it("marks the highlighted item and shows descriptions in a primary column", () => {
    const popup = buildSuggestionPopup(suggestions(), 60);
    // primary column: min(32, 60 - 6) = 32; label padded to 32; then description
    expect(plain(popup[0]!)).toBe("→ main.ts" + " ".repeat(25) + "src/main.ts");
    expect(popup[0]![0]).toEqual({ text: plain(popup[0]!), style: "accent" });
    expect(plain(popup[1]!)).toBe("  utils/" + " ".repeat(26) + "src/utils/");
    // description span is muted, marker and label are plain
    expect(popup[1]![3]).toEqual({ text: "src/utils/", style: "muted" });
  });

  it("omits descriptions when the terminal is narrow", () => {
    const popup = buildSuggestionPopup(suggestions(), 30);
    expect(plain(popup[0]!)).toBe("→ main.ts");
    expect(plain(popup[1]!)).toBe("  utils/");
  });

  it("wraps the highlight around the list ends", () => {
    const popup = buildSuggestionPopup({ ...suggestions(), selectedIndex: 1 }, 60);
    expect(plain(popup[0]!)).toBe("  main.ts" + " ".repeat(25) + "src/main.ts");
    expect(plain(popup[1]!).startsWith("→ utils/")).toBe(true);
  });

  it("centers the window and shows a scroll indicator for long lists", () => {
    const items = Array.from({ length: 20 }, (_, i) => ({
      value: `src/f${i}.ts`,
      label: `f${i}.ts`,
    }));
    const popup = buildSuggestionPopup({ prefix: "@src/", items, selectedIndex: 10 }, 40);
    // window is centered on the selection: f8..f12, selection at position 2
    expect(plain(popup[0]!)).toBe("  f8.ts");
    expect(plain(popup[2]!)).toBe("→ f10.ts");
    expect(plain(popup[4]!)).toBe("  f12.ts");
    expect(plain(popup[5]!)).toBe("  (11/20)");
    expect(popup[5]![0]).toEqual({ text: "  (11/20)", style: "muted" });
  });
});

describe("buildEditorBox", () => {
  it("renders an empty rounded box with the cursor at the start", () => {
    const box = buildEditorBox(emptyEditor(), 10);
    expect(plain(box[0]!)).toBe("╭" + "─".repeat(8) + "╮");
    // rail, space, cursor cell + padding, space, rail
    expect(plain(box[1]!)).toBe("│ " + " ".repeat(6) + " │");
    expect(box[1]![0]).toEqual({ text: "│", style: "border" });
    expect(box[1]![1]).toEqual({ text: " " });
    expect(box[1]![2]).toEqual({ text: " ", style: "cursor" });
    expect(plain(box[2]!)).toBe("╰" + "─".repeat(8) + "╯");
  });

  it("renders the cursor over the character at the cursor position", () => {
    const box = buildEditorBox({ text: "ab", cursor: 1 }, 10);
    const content = box[1]!;
    expect(content[2]).toEqual({ text: "a" });
    expect(content[3]).toEqual({ text: "b", style: "cursor" });
    expect(plain(content).length).toBe(10);
  });

  it("renders a trailing cursor cell at the end of text", () => {
    const box = buildEditorBox({ text: "ab", cursor: 2 }, 10);
    const content = box[1]!;
    expect(content[2]).toEqual({ text: "a" });
    expect(content[3]).toEqual({ text: "b" });
    expect(content[4]).toEqual({ text: " ", style: "cursor" });
    expect(plain(content).length).toBe(10);
  });

  it("wraps long text inside the box", () => {
    const box = buildEditorBox({ text: "a".repeat(20), cursor: 20 }, 8);
    expect(plain(box[0]!)).toBe("╭" + "─".repeat(6) + "╮");
    for (let i = 1; i <= 4; i++) {
      expect(plain(box[i]!)).toBe("│ aaaa │");
    }
    // The last logical row is exactly full, so the trailing cursor cell
    // would overflow the rails and is dropped — the row stays flush, matching
    // BorderedBox's row clipping (see sdk/box-parity.test.ts).
    expect(plain(box[5]!)).toBe("│ aaaa │");
    expect(plain(box[6]!)).toBe("╰" + "─".repeat(6) + "╯");
  });

  it("places the cursor on the correct wrapped line", () => {
    const box = buildEditorBox({ text: "a".repeat(10), cursor: 0 }, 8);
    // cursor at start: first content line's first content span is the cursor
    const first = box[1]!;
    expect(first[2]).toEqual({ text: "a", style: "cursor" });
    const second = box[2]!;
    expect(second.slice(2, -2).every((s) => s.style === undefined || s.style === "cursor")).toBe(
      true,
    );
    expect(second.slice(2, -2).some((s) => s.style === "cursor")).toBe(false);
  });

  it("renders one row per logical line, preserving newlines", () => {
    const box = buildEditorBox({ text: "one\ntwo", cursor: 7 }, 10);
    expect(plain(box[1]!)).toBe("│ one    │");
    expect(plain(box[2]!)).toBe("│ two    │");
    // cursor after "two": trailing cursor cell on the last row
    expect(box[2]![5]).toEqual({ text: " ", style: "cursor" });
    expect(plain(box[3]!)).toBe("╰" + "─".repeat(8) + "╯");
  });

  it("renders empty lines between newlines", () => {
    const box = buildEditorBox({ text: "a\n\nb", cursor: 4 }, 10);
    expect(plain(box[1]!)).toBe("│ a      │");
    expect(plain(box[2]!)).toBe("│        │");
    expect(plain(box[3]!)).toBe("│ b      │");
    expect(plain(box[4]!)).toBe("╰" + "─".repeat(8) + "╯");
  });

  it("places the cursor at the end of the line containing the newline", () => {
    // cursor sits on the newline (index 1): end of the first row
    const box = buildEditorBox({ text: "a\nb", cursor: 1 }, 10);
    expect(box[1]![3]).toEqual({ text: " ", style: "cursor" });
    expect(box[2]!.slice(2, -2).some((s) => s.style === "cursor")).toBe(false);
  });

  it("wraps long logical lines independently", () => {
    const box = buildEditorBox({ text: "a".repeat(6) + "\nb", cursor: 6 }, 8);
    // first logical line wraps to two rows of 4; second stays on its own row
    expect(plain(box[1]!)).toBe("│ aaaa │");
    expect(plain(box[2]!)).toBe("│ aa   │");
    expect(plain(box[3]!)).toBe("│ b    │");
  });
});

describe("wrapLine", () => {
  it("preserves spans across line breaks", () => {
    const wrapped = wrapLine(line(span("one", "accent"), span(" two three", "muted")), 7);
    expect(plain(wrapped[0]!)).toBe("one two");
    expect(plain(wrapped[1]!)).toBe("three");
    expect(wrapped[0]![0]!.style).toBe("accent");
    expect(wrapped[0]![1]!.style).toBe("muted");
    expect(wrapped[1]![0]!.style).toBe("muted");
  });

  it("splits on literal newlines inside spans", () => {
    const wrapped = wrapLine(line(span("one\ntwo")), 20);
    expect(wrapped.map(plain)).toEqual(["one", "two"]);
  });

  it("returns an empty line for empty content", () => {
    expect(wrapLine([], 10)).toEqual([[]]);
  });

  it("keeps content unchanged when it fits", () => {
    const content: SceneLine = line(span("hello", "accent"));
    expect(wrapLine(content, 20)).toEqual([content]);
  });
});
