/**
 * Pure interaction state machine for the question flow.
 *
 * Encodes the UX contract of the legacy `question` and `questionnaire` tools:
 * - Single question: simple option list, answering completes immediately.
 * - Multiple questions: tab bar navigation, optional submit tab, answering
 *   advances to the next tab.
 * - Returning to an answered tab highlights the current answer; reopening
 *   "Type something" pre-fills the editor so the answer can be edited.
 * - "Type something" opens an inline editor; Enter submits the typed answer,
 *   Esc returns to the options.
 *
 * `step` is a pure reducer: same state + event -> same next state. The flow
 * program (and its tests) drive it with keyboard events.
 */

import { Match } from "effect";
import type { KeyEvent } from "./keyboard.ts";
import {
  editorBackspace,
  editorDelete,
  editorFromText,
  editorInsert,
  editorMoveEnd,
  editorMoveHome,
  editorMoveLeft,
  editorMoveRight,
  emptyEditor,
  sanitizePaste,
  type EditorState,
} from "./editor.ts";
import { Answer, QuestionResult, type Question } from "./domain.ts";
import type { SuggestionItem } from "./services.ts";

/** An option as presented to the user. The last one is the "Type something" entry when `allowOther` is set. */
export interface OptionChoice {
  readonly label: string;
  readonly description?: string;
  readonly isOther: boolean;
}

/** The open file-completion popup over the inline editor. */
export interface SuggestionState {
  /** The `@` token prefix the items replace. */
  readonly prefix: string;
  readonly items: readonly SuggestionItem[];
  /** Index of the highlighted item (wraps at both ends). */
  readonly selectedIndex: number;
}

export type Mode = "single" | "multi";

export interface MachineState {
  readonly mode: Mode;
  readonly questions: readonly Question[];
  /** Active tab: 0..questions.length-1 for questions, `questions.length` for the submit tab. */
  readonly currentTab: number;
  readonly optionIndex: number;
  /** Whether the inline "Type something" editor is open. */
  readonly inputMode: boolean;
  readonly answers: ReadonlyMap<string, Answer>;
  readonly editor: EditorState;
  /** Open file-completion popup, or null when closed. */
  readonly suggestions: SuggestionState | null;
}

export type MachineAction =
  | { readonly type: "none" }
  | { readonly type: "applySuggestion" }
  | { readonly type: "forceSuggestion" }
  | { readonly type: "complete"; readonly result: QuestionResult };

export interface StepResult {
  readonly state: MachineState;
  readonly action: MachineAction;
}

export const initialMachineState = (questions: readonly Question[]): MachineState => ({
  mode: questions.length > 1 ? "multi" : "single",
  questions,
  currentTab: 0,
  optionIndex: 0,
  inputMode: false,
  answers: new Map(),
  editor: emptyEditor(),
  suggestions: null,
});

/** Options of the active question, with the "Type something" entry appended when allowed. */
export const currentOptions = (state: MachineState): readonly OptionChoice[] =>
  optionsForTab(state.questions, state.currentTab);

/** Options of the question on the given tab, with the "Type something" entry appended when allowed. */
export const optionsForTab = (
  questions: readonly Question[],
  tab: number,
): readonly OptionChoice[] => {
  const question = questions[tab];
  if (!question) return [];
  const options: OptionChoice[] = question.options.map((o) => ({
    label: o.label,
    description: o.description,
    isOther: false,
  }));
  if (question.allowOther) {
    options.push({ label: "Type something.", isOther: true });
  }
  return options;
};

export const isAllAnswered = (state: MachineState): boolean =>
  state.questions.every((q) => state.answers.has(q.id));

export const step = (state: MachineState, event: KeyEvent): StepResult =>
  state.inputMode ? stepInEditor(state, event) : stepInOptions(state, event);

/** No-op: the event is intentionally ignored in this mode. */
const ignore = (state: MachineState): StepResult => ({ state, action: { type: "none" } });

/**
 * Text before the cursor, used to detect `@` completion contexts.
 *
 * The pattern mirrors pi-tui's default trigger pattern: `@` at the start of
 * the text or right after whitespace, followed by non-whitespace.
 */
export const textBeforeCursor = (editor: EditorState): string => {
  const chars = Array.from(editor.text);
  return chars.slice(0, editor.cursor).join("");
};

/** Whether the text before the cursor should open the `@` file popup. */
export const isAtCompletionContext = (before: string): boolean => /(?:^|\s)@[^\s]*$/.test(before);

/** Open the popup with the given items, preselecting the best match. */
export const openSuggestions = (
  state: MachineState,
  prefix: string,
  items: readonly SuggestionItem[],
): MachineState => ({
  ...state,
  suggestions: {
    prefix,
    items,
    selectedIndex: bestSuggestionIndex(items, prefix),
  },
});

/** Apply a new editor state. */
const edit = (state: MachineState, editor: EditorState): StepResult => ({
  state: { ...state, editor },
  action: { type: "none" },
});

/**
 * Preselect the item that best matches the typed prefix, like pi-tui:
 * exact `value` match wins, else the first item whose `value` starts with the
 * prefix, else the first item.
 */
const bestSuggestionIndex = (items: readonly SuggestionItem[], prefix: string): number => {
  for (let i = 0; i < items.length; i++) {
    if (items[i]!.value === prefix) return i;
  }
  for (let i = 0; i < items.length; i++) {
    if (items[i]!.value.startsWith(prefix)) return i;
  }
  return 0;
};

const stepInOptions = (state: MachineState, event: KeyEvent): StepResult =>
  Match.valueTags(event, {
    // Tab navigation (multi-question mode only)
    tab: () => (state.mode === "multi" ? moveTab(state, 1) : ignore(state)),
    right: () => (state.mode === "multi" ? moveTab(state, 1) : ignore(state)),
    shiftTab: () => (state.mode === "multi" ? moveTab(state, -1) : ignore(state)),
    left: () => (state.mode === "multi" ? moveTab(state, -1) : ignore(state)),
    // Selection moves are inert on the submit tab
    up: () =>
      state.currentTab >= state.questions.length ? ignore(state) : moveSelection(state, -1),
    down: () =>
      state.currentTab >= state.questions.length ? ignore(state) : moveSelection(state, 1),
    enter: () =>
      state.currentTab >= state.questions.length ? maybeSubmit(state) : chooseOption(state),
    escape: () => complete(state, true),
    // Everything else is ignored while navigating options
    char: () => ignore(state),
    paste: () => ignore(state),
    shiftEnter: () => ignore(state),
    backspace: () => ignore(state),
    delete: () => ignore(state),
    home: () => ignore(state),
    end: () => ignore(state),
  });

const moveTab = (state: MachineState, dir: -1 | 1): StepResult => {
  const totalTabs = state.questions.length + 1;
  const currentTab = (state.currentTab + dir + totalTabs) % totalTabs;
  return { state: enterTab({ ...state, currentTab }), action: { type: "none" } };
};

/**
 * Prepare a tab for display: highlight the option that reflects an existing
 * answer (the chosen option, or "Type something" for a custom answer) and
 * close any open editor.
 */
const enterTab = (state: MachineState): MachineState => ({
  ...state,
  inputMode: false,
  editor: emptyEditor(),
  suggestions: null,
  optionIndex: answeredOptionIndex(state) ?? 0,
});

/** Option index that reflects the existing answer on the current tab, if any. */
const answeredOptionIndex = (state: MachineState): number | undefined => {
  const question = state.questions[state.currentTab];
  if (!question) return undefined;
  const answer = state.answers.get(question.id);
  if (!answer) return undefined;
  const options = optionsForTab(state.questions, state.currentTab);
  if (answer.wasCustom) return options.length - 1; // the "Type something" entry
  if (answer.index === undefined) return undefined;
  return Math.min(Math.max(0, answer.index - 1), options.length - 1);
};

const moveSelection = (state: MachineState, dir: -1 | 1): StepResult => {
  const options = currentOptions(state);
  const optionIndex = Math.min(Math.max(0, state.optionIndex + dir), options.length - 1);
  return { state: { ...state, optionIndex }, action: { type: "none" } };
};

/** Enter on the submit tab: submit only when every question is answered. */
const maybeSubmit = (state: MachineState): StepResult =>
  isAllAnswered(state) ? complete(state, false) : ignore(state);

/** Enter on a question tab: pick the highlighted option, or open the editor. */
const chooseOption = (state: MachineState): StepResult => {
  const question = state.questions[state.currentTab];
  const option = currentOptions(state)[state.optionIndex];
  if (!question || !option) return ignore(state);
  if (option.isOther) {
    const existing = state.answers.get(question.id);
    return {
      state: {
        ...state,
        inputMode: true,
        editor: existing?.wasCustom ? editorFromText(existing.label) : emptyEditor(),
        suggestions: null,
      },
      action: { type: "none" },
    };
  }
  return advanceAfterAnswer(
    withAnswer(state, question, option.label, false, state.optionIndex + 1),
  );
};

const stepInEditor = (state: MachineState, event: KeyEvent): StepResult =>
  state.suggestions ? stepInEditorWithSuggestions(state, event) : stepInEditorPlain(state, event);

/**
 * Key handling while the completion popup is open. Navigation and selection
 * keys drive the popup; text and cursor keys fall through to normal editor
 * handling (the flow re-queries afterwards).
 */
const stepInEditorWithSuggestions = (state: MachineState, event: KeyEvent): StepResult =>
  Match.valueTags(event, {
    up: () => moveSuggestionSelection(state, -1),
    down: () => moveSuggestionSelection(state, 1),
    tab: () => ({ state, action: { type: "applySuggestion" } as const }),
    enter: () => ({ state, action: { type: "applySuggestion" } as const }),
    escape: () => closeSuggestions(state),
    // Everything else is regular editor input; the flow refreshes the popup.
    char: (e) => edit(state, editorInsert(state.editor, e.char)),
    paste: (e) => edit(state, editorInsert(state.editor, sanitizePaste(e.text))),
    shiftEnter: () => edit(state, editorInsert(state.editor, "\n")),
    backspace: () => edit(state, editorBackspace(state.editor)),
    delete: () => edit(state, editorDelete(state.editor)),
    left: () => edit(state, editorMoveLeft(state.editor)),
    right: () => edit(state, editorMoveRight(state.editor)),
    home: () => edit(state, editorMoveHome(state.editor)),
    end: () => edit(state, editorMoveEnd(state.editor)),
    shiftTab: () => ignore(state),
  });

/** Regular editor keys: navigation keys are inert while typing. */
const stepInEditorPlain = (state: MachineState, event: KeyEvent): StepResult =>
  Match.valueTags(event, {
    escape: () => exitEditor(state),
    enter: () => submitEditor(state),
    char: (e) => edit(state, editorInsert(state.editor, e.char)),
    paste: (e) => edit(state, editorInsert(state.editor, sanitizePaste(e.text))),
    shiftEnter: () => edit(state, editorInsert(state.editor, "\n")),
    backspace: () => edit(state, editorBackspace(state.editor)),
    delete: () => edit(state, editorDelete(state.editor)),
    left: () => edit(state, editorMoveLeft(state.editor)),
    right: () => edit(state, editorMoveRight(state.editor)),
    home: () => edit(state, editorMoveHome(state.editor)),
    end: () => edit(state, editorMoveEnd(state.editor)),
    // Navigation keys are inert while typing
    up: () => ignore(state),
    down: () => ignore(state),
    tab: () => ({ state, action: { type: "forceSuggestion" } as const }),
    shiftTab: () => ignore(state),
  });

/** Move the popup highlight, wrapping at both ends. */
const moveSuggestionSelection = (state: MachineState, dir: -1 | 1): StepResult => {
  const suggestions = state.suggestions!;
  const count = suggestions.items.length;
  if (count === 0) return ignore(state);
  const selectedIndex = (((suggestions.selectedIndex + dir) % count) + count) % count;
  return {
    state: { ...state, suggestions: { ...suggestions, selectedIndex } },
    action: { type: "none" },
  };
};

/** Close the completion popup, keeping the editor open. */
const closeSuggestions = (state: MachineState): StepResult => ({
  state: { ...state, suggestions: null },
  action: { type: "none" },
});

/** Esc in the editor: leave without answering. */
const exitEditor = (state: MachineState): StepResult => ({
  state: { ...state, inputMode: false, editor: emptyEditor(), suggestions: null },
  action: { type: "none" },
});

/** Enter in the editor: submit the typed answer. */
const submitEditor = (state: MachineState): StepResult => {
  const question = state.questions[state.currentTab];
  if (!question) return ignore(state);
  const label = state.editor.text.trim() || "(no response)";
  const next = withAnswer(state, question, label, true);
  return advanceAfterAnswer({
    ...next,
    inputMode: false,
    editor: emptyEditor(),
    suggestions: null,
  });
};

const withAnswer = (
  state: MachineState,
  question: Question,
  label: string,
  wasCustom: boolean,
  index?: number,
): MachineState => {
  const answers = new Map(state.answers);
  answers.set(
    question.id,
    index === undefined
      ? new Answer({ id: question.id, label, wasCustom })
      : new Answer({ id: question.id, label, wasCustom, index }),
  );
  return { ...state, answers };
};

const advanceAfterAnswer = (state: MachineState): StepResult => {
  if (state.mode === "single") return complete(state, false);
  const currentTab =
    state.currentTab < state.questions.length - 1 ? state.currentTab + 1 : state.questions.length;
  return { state: enterTab({ ...state, currentTab }), action: { type: "none" } };
};

const complete = (state: MachineState, cancelled: boolean): StepResult => ({
  state,
  action: {
    type: "complete",
    result: new QuestionResult({
      questions: [...state.questions],
      answers: [...state.answers.values()],
      cancelled,
    }),
  },
});
