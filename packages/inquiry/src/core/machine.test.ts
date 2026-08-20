import { describe, expect, it } from "vitest";
import { Option, Question, type Question as QuestionType } from "./domain.ts";
import { KeyEvent } from "./keyboard.ts";
import {
  currentOptions,
  initialMachineState,
  isAtCompletionContext,
  isMultiEntrySelected,
  multiEntries,
  openSuggestions,
  step,
  textBeforeCursor,
  type MachineState,
  type SuggestionState,
} from "./machine.ts";

const question = (over: Partial<QuestionType> = {}): QuestionType =>
  new Question({
    id: "q1",
    label: "Q1",
    prompt: "Pick one?",
    options: [new Option({ label: "Yes" }), new Option({ label: "No" })],
    allowOther: true,
    multiple: false,
    ...over,
  });

const twoQuestions = (): readonly Question[] => [
  question(),
  question({ id: "q2", label: "Q2", prompt: "Second?" }),
];

const down = (n: number) => Array.from({ length: n }, () => KeyEvent.down);

describe("single question", () => {
  it("starts in single mode on the first tab", () => {
    const state = initialMachineState([question()]);
    expect(state.mode).toBe("single");
    expect(state.currentTab).toBe(0);
    expect(state.optionIndex).toBe(0);
    expect(state.inputMode).toBe(false);
  });

  it("navigates options with up and down, clamped", () => {
    let state = initialMachineState([question()]);
    for (const event of down(2)) state = step(state, event).state;
    expect(state.optionIndex).toBe(2); // clamps at "Type something."
    state = step(state, KeyEvent.up).state;
    expect(state.optionIndex).toBe(1);
    state = step(state, KeyEvent.up).state;
    state = step(state, KeyEvent.up).state;
    expect(state.optionIndex).toBe(0); // clamps at 0
  });

  it("completes with the selected option on enter", () => {
    const result = step(
      step(initialMachineState([question()]), KeyEvent.down).state,
      KeyEvent.enter,
    );
    expect(result.action.type).toBe("complete");
    if (result.action.type === "complete") {
      const answer = result.action.result.answers[0];
      expect(result.action.result.cancelled).toBe(false);
      expect(answer?.id).toBe("q1");
      expect(answer?.label).toBe("No");
      expect(answer?.wasCustom).toBe(false);
      expect(answer?.index).toBe(2);
    }
  });

  it("cancels with escape", () => {
    const result = step(initialMachineState([question()]), KeyEvent.escape);
    expect(result.action.type).toBe("complete");
    if (result.action.type === "complete") {
      expect(result.action.result.cancelled).toBe(true);
      expect(result.action.result.answers).toHaveLength(0);
    }
  });

  it("opens the editor on the 'Type something' option", () => {
    let state = initialMachineState([question()]);
    for (const event of down(2)) state = step(state, event).state;
    const next = step(state, KeyEvent.enter);
    expect(next.state.inputMode).toBe(true);
    expect(next.state.editor.text).toBe("");
    expect(next.action.type).toBe("none");
  });

  it("submits a custom answer from the editor", () => {
    let state = initialMachineState([question()]);
    for (const event of down(2)) state = step(state, event).state;
    state = step(state, KeyEvent.enter).state;
    for (const ch of ["c", "u", "s"]) {
      state = step(state, KeyEvent.char(ch)).state;
    }
    const result = step(state, KeyEvent.enter);
    expect(result.action.type).toBe("complete");
    if (result.action.type === "complete") {
      const answer = result.action.result.answers[0];
      expect(answer?.label).toBe("cus");
      expect(answer?.wasCustom).toBe(true);
      expect(answer?.index).toBeUndefined();
    }
  });

  it("returns to the options on escape from the editor", () => {
    let state = initialMachineState([question()]);
    for (const event of down(2)) state = step(state, event).state;
    state = step(state, KeyEvent.enter).state;
    state = step(state, KeyEvent.char("x")).state;
    const next = step(state, KeyEvent.escape);
    expect(next.state.inputMode).toBe(false);
    expect(next.state.editor.text).toBe("");
    expect(next.action.type).toBe("none");
  });

  it("submits an empty editor as '(no response)'", () => {
    let state = initialMachineState([question()]);
    for (const event of down(2)) state = step(state, event).state;
    state = step(state, KeyEvent.enter).state;
    const result = step(state, KeyEvent.enter);
    expect(result.action.type).toBe("complete");
    if (result.action.type === "complete") {
      expect(result.action.result.answers[0]?.label).toBe("(no response)");
      expect(result.action.result.answers[0]?.wasCustom).toBe(true);
    }
  });

  it("inserts a newline on shift+enter while editing", () => {
    let state = initialMachineState([question()]);
    for (const event of down(2)) state = step(state, event).state;
    state = step(state, KeyEvent.enter).state;
    const events = [KeyEvent.char("a"), KeyEvent.shiftEnter, KeyEvent.char("b")];
    for (const event of events) state = step(state, event).state;
    expect(state.editor.text).toBe("a\nb");
    expect(state.editor.cursor).toBe(3);
    expect(state.inputMode).toBe(true); // not submitted
  });

  it("inserts sanitized paste text while editing", () => {
    let state = initialMachineState([question()]);
    for (const event of down(2)) state = step(state, event).state;
    state = step(state, KeyEvent.enter).state;
    state = step(state, KeyEvent.paste("line1\r\nline2")).state;
    expect(state.editor.text).toBe("line1\nline2");
    state = step(state, KeyEvent.paste("\x03a\x07b\t c")).state;
    expect(state.editor.text).toBe("line1\nline2ab     c");
  });

  it("ignores paste and shift+enter while navigating options", () => {
    let state = initialMachineState([question()]);
    expect(step(state, KeyEvent.paste("x")).state).toBe(state);
    expect(step(state, KeyEvent.shiftEnter).state).toBe(state);
  });

  it("ignores tab navigation in single mode", () => {
    const result = step(initialMachineState([question()]), KeyEvent.tab);
    expect(result.state.currentTab).toBe(0);
    expect(result.action.type).toBe("none");
  });
});

describe("multi question", () => {
  it("starts in multi mode", () => {
    expect(initialMachineState(twoQuestions()).mode).toBe("multi");
  });

  it("cycles tabs with tab and shift-tab, including the submit tab", () => {
    let state = initialMachineState(twoQuestions());
    state = step(state, KeyEvent.tab).state;
    expect(state.currentTab).toBe(1);
    state = step(state, KeyEvent.tab).state;
    expect(state.currentTab).toBe(2); // submit tab
    state = step(state, KeyEvent.tab).state;
    expect(state.currentTab).toBe(0); // wraps
    state = step(state, KeyEvent.shiftTab).state;
    expect(state.currentTab).toBe(2);
  });

  it("treats left and right as tab navigation", () => {
    let state = initialMachineState(twoQuestions());
    state = step(state, KeyEvent.right).state;
    expect(state.currentTab).toBe(1);
    state = step(state, KeyEvent.left).state;
    expect(state.currentTab).toBe(0);
  });

  it("resets the option index when changing tabs", () => {
    let state = initialMachineState(twoQuestions());
    state = step(state, KeyEvent.down).state;
    expect(state.optionIndex).toBe(1);
    state = step(state, KeyEvent.tab).state;
    expect(state.optionIndex).toBe(0);
  });

  it("answers and advances to the next tab", () => {
    const result = step(initialMachineState(twoQuestions()), KeyEvent.enter);
    expect(result.state.currentTab).toBe(1);
    expect(result.state.answers.get("q1")?.[0]?.label).toBe("Yes");
    expect(result.action.type).toBe("none");
  });

  it("advances to the submit tab after the last question", () => {
    let state = initialMachineState(twoQuestions());
    state = step(state, KeyEvent.tab).state;
    state = step(state, KeyEvent.enter).state;
    expect(state.currentTab).toBe(2);
  });

  it("gates submit on all questions being answered", () => {
    let state = initialMachineState(twoQuestions());
    state = step(state, KeyEvent.enter).state; // q1 answered, now q2
    state = step(state, KeyEvent.tab).state; // submit tab, q2 unanswered
    const blocked = step(state, KeyEvent.enter);
    expect(blocked.action.type).toBe("none");
    expect(blocked.state.currentTab).toBe(2);
    const cancelled = step(state, KeyEvent.escape);
    expect(cancelled.action.type).toBe("complete");
    if (cancelled.action.type === "complete") {
      expect(cancelled.action.result.cancelled).toBe(true);
    }
  });

  it("completes when all answered and submit is confirmed", () => {
    let state = initialMachineState(twoQuestions());
    state = step(state, KeyEvent.enter).state;
    state = step(state, KeyEvent.enter).state; // answers q2, advances to submit tab
    const result = step(state, KeyEvent.enter);
    expect(result.action.type).toBe("complete");
    if (result.action.type === "complete") {
      expect(result.action.result.cancelled).toBe(false);
      expect(result.action.result.answers).toHaveLength(2);
      expect(result.action.result.questions.map((q) => q.id)).toEqual(["q1", "q2"]);
    }
  });

  it("keeps answers in answering order", () => {
    let state = initialMachineState(twoQuestions());
    state = step(state, KeyEvent.tab).state; // q2
    state = step(state, KeyEvent.enter).state; // answer q2, advances to submit tab
    state = step(state, KeyEvent.shiftTab).state; // q2
    state = step(state, KeyEvent.shiftTab).state; // q1
    state = step(state, KeyEvent.enter).state; // answer q1, advances to q2
    state = step(state, KeyEvent.tab).state; // submit tab
    const result = step(state, KeyEvent.enter);
    expect(result.action.type).toBe("complete");
    if (result.action.type === "complete") {
      expect(result.action.result.answers.map((a) => a.id)).toEqual(["q2", "q1"]);
    }
  });

  it("excludes the 'Type something' option when allowOther is false", () => {
    const state = initialMachineState([
      question({ id: "x", allowOther: false }),
      question({ id: "y", allowOther: false }),
    ]);
    expect(currentOptions(state)).toHaveLength(2);
    expect(currentOptions(state).every((o) => !o.isOther)).toBe(true);
  });

  it("answers with an index relative to the visible options", () => {
    let state = initialMachineState([question({ allowOther: false })]);
    state = step(state, KeyEvent.down).state; // "No" is index 1 of 2
    const result = step(state, KeyEvent.enter);
    expect(result.action.type).toBe("complete");
    if (result.action.type === "complete") {
      expect(result.action.result.answers[0]?.index).toBe(2);
    }
  });

  it("highlights the answered option when returning to a tab", () => {
    let state = initialMachineState(twoQuestions());
    state = step(state, KeyEvent.down).state; // "No"
    state = step(state, KeyEvent.enter).state; // answer q1, advance to q2
    state = step(state, KeyEvent.shiftTab).state; // back to q1
    expect(state.currentTab).toBe(0);
    expect(state.optionIndex).toBe(1); // "No" is the second option
  });

  it("highlights 'Type something' when returning to a custom-answered tab", () => {
    let state = initialMachineState(twoQuestions());
    for (const event of down(2)) state = step(state, event).state;
    state = step(state, KeyEvent.enter).state; // open editor
    state = step(state, KeyEvent.char("hi")).state;
    state = step(state, KeyEvent.enter).state; // submit, advance to q2
    state = step(state, KeyEvent.shiftTab).state; // back to q1
    expect(state.currentTab).toBe(0);
    expect(state.optionIndex).toBe(2); // the "Type something" entry
  });

  it("pre-fills the editor with the existing custom answer when reopened", () => {
    let state = initialMachineState(twoQuestions());
    for (const event of down(2)) state = step(state, event).state;
    state = step(state, KeyEvent.enter).state;
    state = step(state, KeyEvent.char("hey")).state;
    state = step(state, KeyEvent.enter).state; // submit, advance to q2
    state = step(state, KeyEvent.shiftTab).state; // back to q1
    state = step(state, KeyEvent.enter).state; // reopen the editor
    expect(state.inputMode).toBe(true);
    expect(state.editor).toEqual({ text: "hey", cursor: 3 });
  });

  it("opens an empty editor on a tab answered with an option", () => {
    let state = initialMachineState(twoQuestions());
    state = step(state, KeyEvent.enter).state; // answer q1 with "Yes"
    state = step(state, KeyEvent.shiftTab).state; // back to q1
    state = step(state, KeyEvent.down).state;
    state = step(state, KeyEvent.down).state; // "Type something"
    state = step(state, KeyEvent.enter).state;
    expect(state.inputMode).toBe(true);
    expect(state.editor).toEqual({ text: "", cursor: 0 });
  });

  it("updates an existing custom answer when edited and re-submitted", () => {
    let state = initialMachineState(twoQuestions());
    for (const event of down(2)) state = step(state, event).state;
    state = step(state, KeyEvent.enter).state;
    state = step(state, KeyEvent.char("hey")).state;
    state = step(state, KeyEvent.enter).state; // submit "hey"
    state = step(state, KeyEvent.shiftTab).state; // back to q1
    state = step(state, KeyEvent.enter).state; // reopen, pre-filled
    state = step(state, KeyEvent.char("!")).state;
    state = step(state, KeyEvent.enter).state; // re-submit "hey!"
    expect(state.answers.get("q1")?.[0]?.label).toBe("hey!");
    expect(state.answers.get("q1")?.[0]?.wasCustom).toBe(true);
    expect(state.currentTab).toBe(1);
  });

  it("highlights an existing answer when advancing to an answered tab", () => {
    let state = initialMachineState(twoQuestions());
    state = step(state, KeyEvent.tab).state; // q2
    state = step(state, KeyEvent.down).state; // "No"
    state = step(state, KeyEvent.enter).state; // answer q2, advance to submit
    state = step(state, KeyEvent.shiftTab).state; // q2
    state = step(state, KeyEvent.shiftTab).state; // q1
    state = step(state, KeyEvent.enter).state; // answer q1 "Yes", advance to q2
    expect(state.currentTab).toBe(1);
    expect(state.optionIndex).toBe(1); // q2's answer "No" is highlighted
  });
});

describe("multi-select question", () => {
  const multiQuestion = (): QuestionType => question({ multiple: true });

  it("starts with checkbox options and an add entry", () => {
    const state = initialMachineState([multiQuestion()]);
    expect(multiEntries(state).map((e) => e.kind)).toEqual(["option", "option", "add"]);
    expect(isMultiEntrySelected(state, multiEntries(state)[0]!)).toBe(false);
  });

  it("toggles an option on and off with space", () => {
    let state = initialMachineState([multiQuestion()]);
    state = step(state, KeyEvent.char(" ")).state; // toggle option 0 on
    expect(state.answers.get("q1")?.[0]).toMatchObject({ index: 1, wasCustom: false });
    expect(isMultiEntrySelected(state, multiEntries(state)[0]!)).toBe(true);
    state = step(state, KeyEvent.char(" ")).state; // toggle the same option off
    expect(state.answers.get("q1")).toBeUndefined(); // emptied, no stale key
    expect(isMultiEntrySelected(state, multiEntries(state)[0]!)).toBe(false);
  });

  it("selects several options before confirming", () => {
    let state = initialMachineState([multiQuestion()]);
    state = step(state, KeyEvent.char(" ")).state; // Yes
    state = step(state, KeyEvent.down).state;
    state = step(state, KeyEvent.char(" ")).state; // No
    expect(state.answers.get("q1")?.map((a) => a.index)).toEqual([1, 2]);
  });

  it("selects a single option with space", () => {
    let state = initialMachineState([question()]);
    const result = step(state, KeyEvent.char(" "));
    expect(result.action.type).toBe("complete");
    if (result.action.type === "complete") {
      expect(result.action.result.answers.map((a) => a.label)).toEqual(["Yes"]);
    }
  });

  it("adds a custom answer from the editor without advancing", () => {
    let state = initialMachineState([multiQuestion()]);
    state = step(state, KeyEvent.down).state;
    state = step(state, KeyEvent.down).state; // "add"
    state = step(state, KeyEvent.char(" ")).state; // open editor
    expect(state.inputMode).toBe(true);
    for (const ch of ["M", "y"]) state = step(state, KeyEvent.char(ch)).state;
    const next = step(state, KeyEvent.enter); // submit
    expect(next.state.inputMode).toBe(false);
    expect(next.state.currentTab).toBe(0); // stays on the tab
    expect(next.state.answers.get("q1")?.map((a) => [a.label, a.wasCustom])).toEqual([
      ["My", true],
    ]);
  });

  it("opens the add-editor with enter on the add row, like single-select", () => {
    let state = initialMachineState([multiQuestion()]);
    state = step(state, KeyEvent.down).state;
    state = step(state, KeyEvent.down).state; // "add"
    const next = step(state, KeyEvent.enter); // enter instead of space
    expect(next.action.type).toBe("none");
    expect(next.state.inputMode).toBe(true);
    expect(next.state.currentTab).toBe(0); // did not advance
    // Enter on an option row still confirms rather than opening the editor
    let confirm = initialMachineState([multiQuestion()]);
    confirm = step(confirm, KeyEvent.char(" ")).state; // select option 0
    const done = step(confirm, KeyEvent.enter);
    expect(done.action.type).toBe("complete");
  });

  it("types a space into the add-editor instead of toggling", () => {
    let state = initialMachineState([multiQuestion()]);
    state = step(state, KeyEvent.down).state;
    state = step(state, KeyEvent.down).state; // "add"
    state = step(state, KeyEvent.char(" ")).state; // open editor
    expect(state.inputMode).toBe(true);
    state = step(state, KeyEvent.char("h")).state;
    state = step(state, KeyEvent.char(" ")).state; // space while typing
    state = step(state, KeyEvent.char("i")).state;
    expect(state.editor.text).toBe("h i"); // inserted literally, not a toggle
    expect(state.answers.get("q1")).toBeUndefined(); // selection untouched
  });

  it("removes an added custom answer chip with space", () => {
    let state = initialMachineState([multiQuestion()]);
    state = step(state, KeyEvent.down).state;
    state = step(state, KeyEvent.down).state; // "add"
    state = step(state, KeyEvent.char(" ")).state;
    for (const ch of ["M", "y"]) state = step(state, KeyEvent.char(ch)).state;
    state = step(state, KeyEvent.enter).state; // submit -> chip at index 2
    state = step(state, KeyEvent.char(" ")).state; // space on the chip removes it
    expect(state.answers.get("q1")).toBeUndefined();
  });

  it("blocks Enter until at least one answer is chosen", () => {
    let state = initialMachineState([multiQuestion()]);
    const blocked = step(state, KeyEvent.enter); // no selection yet
    expect(blocked.action.type).toBe("none");
    expect(state.answers.get("q1")).toBeUndefined();
  });

  it("completes a single multi-select question on Enter", () => {
    let state = initialMachineState([multiQuestion()]);
    state = step(state, KeyEvent.char(" ")).state; // Yes
    const result = step(state, KeyEvent.enter); // confirm
    expect(result.action.type).toBe("complete");
    if (result.action.type === "complete") {
      expect(result.action.result.cancelled).toBe(false);
      expect(result.action.result.answers.map((a) => a.label)).toEqual(["Yes"]);
    }
  });

  it("combines chosen options and custom answers in the result", () => {
    let state = initialMachineState([multiQuestion()]);
    state = step(state, KeyEvent.char(" ")).state; // Yes
    state = step(state, KeyEvent.down).state;
    state = step(state, KeyEvent.char(" ")).state; // No
    state = step(state, KeyEvent.down).state; // "add"
    state = step(state, KeyEvent.char(" ")).state;
    for (const ch of ["M", "y"]) state = step(state, KeyEvent.char(ch)).state;
    state = step(state, KeyEvent.enter).state; // submit custom -> chip at index 2
    const result = step(state, KeyEvent.enter); // confirm
    expect(result.action.type).toBe("complete");
    if (result.action.type === "complete") {
      expect(result.action.result.answers.map((a) => [a.label, a.wasCustom])).toEqual([
        ["Yes", false],
        ["No", false],
        ["My", true],
      ]);
    }
  });

  it("advances a multi-select question to the next tab on Enter", () => {
    let state = initialMachineState([multiQuestion(), question({ id: "q2" })]);
    state = step(state, KeyEvent.char(" ")).state; // select option 0 on q1
    const done = step(state, KeyEvent.enter); // confirm -> q2
    expect(done.action.type).toBe("none");
    expect(done.state.currentTab).toBe(1);
  });

  it("resets the highlight when returning to an answered multi-select tab", () => {
    let state = initialMachineState([multiQuestion(), question({ id: "q2" })]);
    state = step(state, KeyEvent.char(" ")).state; // select option 0
    state = step(state, KeyEvent.enter).state; // advance to q2
    state = step(state, KeyEvent.shiftTab).state; // back to q1
    expect(state.currentTab).toBe(0);
    expect(state.optionIndex).toBe(0); // multi-select has no single highlight
  });

  it("hides the add entry when allowOther is false", () => {
    const state = initialMachineState([question({ multiple: true, allowOther: false })]);
    expect(multiEntries(state).map((e) => e.kind)).toEqual(["option", "option"]);
  });
});

describe("file suggestions", () => {
  const suggestions = (over: Partial<SuggestionState> = {}): SuggestionState => ({
    prefix: "@src",
    items: [
      { value: "src/main.ts", label: "main.ts", description: "src/main.ts" },
      { value: "src/utils/", label: "utils/", description: "src/utils/" },
    ],
    selectedIndex: 0,
    ...over,
  });

  const openEditorWithSuggestions = (): MachineState => {
    let state = initialMachineState([question()]);
    for (const event of down(2)) state = step(state, event).state;
    state = step(state, KeyEvent.enter).state;
    return openSuggestions(state, "@src", suggestions().items);
  };

  it("preselects the best match on open", () => {
    const state = openEditorWithSuggestions();
    expect(state.suggestions?.selectedIndex).toBe(0);
    // Exact value match wins over prefix match
    const state2 = openSuggestions(openEditorWithSuggestions(), "src/main", [
      { value: "src/main.ts", label: "main.ts" },
      { value: "src/main", label: "main", description: "src/main" },
    ]);
    expect(state2.suggestions?.selectedIndex).toBe(1);
  });

  it("navigates the highlight with up and down, wrapping at both ends", () => {
    let state = openEditorWithSuggestions();
    state = step(state, KeyEvent.up).state;
    expect(state.suggestions?.selectedIndex).toBe(1); // wrapped from top
    state = step(state, KeyEvent.down).state;
    expect(state.suggestions?.selectedIndex).toBe(0);
    state = step(state, KeyEvent.down).state;
    expect(state.suggestions?.selectedIndex).toBe(1);
    expect(state.editor.text).toBe(""); // navigation does not edit
  });

  it("tab and enter ask to apply the highlighted suggestion", () => {
    const state = openEditorWithSuggestions();
    const tab = step(state, KeyEvent.tab);
    expect(tab.action.type).toBe("applySuggestion");
    const enter = step(state, KeyEvent.enter);
    expect(enter.action.type).toBe("applySuggestion");
    // The editor text is untouched: applying is the flow's job
    expect(tab.state.editor).toEqual(enter.state.editor);
  });

  it("escape closes the popup without leaving the editor", () => {
    let state = openEditorWithSuggestions();
    state = step(state, KeyEvent.char("x")).state;
    const next = step(state, KeyEvent.escape);
    expect(next.state.inputMode).toBe(true);
    expect(next.state.suggestions).toBeNull();
    expect(next.state.editor.text).toBe("x");
  });

  it("typing and editing still work while the popup is open", () => {
    let state = openEditorWithSuggestions();
    state = step(state, KeyEvent.char("m")).state;
    state = step(state, KeyEvent.backspace).state;
    expect(state.editor.text).toBe("");
    expect(state.suggestions).not.toBeNull(); // popup stays; the flow refreshes it
  });

  it("tab with no popup asks for a forced completion", () => {
    let state = initialMachineState([question()]);
    for (const event of down(2)) state = step(state, event).state;
    state = step(state, KeyEvent.enter).state;
    expect(step(state, KeyEvent.tab).action.type).toBe("forceSuggestion");
    expect(step(state, KeyEvent.shiftTab).action.type).toBe("none");
  });

  it("closes the popup when leaving the editor", () => {
    let state = openEditorWithSuggestions();
    state = step(state, KeyEvent.escape).state; // popup closed, editor stays
    state = step(state, KeyEvent.escape).state; // editor closed
    expect(state.inputMode).toBe(false);
    expect(state.suggestions).toBeNull();
    state = step(state, KeyEvent.enter).state; // reopen the editor
    expect(state.inputMode).toBe(true);
    expect(state.suggestions).toBeNull(); // starts without a popup
  });

  it("detects @ completion contexts at token boundaries", () => {
    expect(isAtCompletionContext("@")).toBe(true);
    expect(isAtCompletionContext("see @src")).toBe(true);
    expect(isAtCompletionContext("see @src/utils/")).toBe(true);
    expect(isAtCompletionContext("src/")).toBe(false); // plain paths need Tab
    expect(isAtCompletionContext("@src ")).toBe(false); // broken by a space
    expect(isAtCompletionContext("a@src")).toBe(false); // mid-token
  });

  it("textBeforeCursor slices at the cursor", () => {
    const editor = { text: "ab@cd", cursor: 3 };
    expect(textBeforeCursor(editor)).toBe("ab@");
  });
});
