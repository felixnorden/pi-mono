import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { Option, Question, type Question as QuestionType, type QuestionResult } from "./domain.ts";
import { FileSuggestions, Keyboard, Renderer, type SuggestionItem } from "./services.ts";
import { runQuestionnaire } from "./flow.ts";
import { KeyEvent } from "./keyboard.ts";
import type { MachineState } from "./machine.ts";

const question = (over: Partial<QuestionType> = {}): QuestionType =>
  new Question({
    id: "q1",
    label: "Q1",
    prompt: "Pick one?",
    options: [new Option({ label: "Yes" }), new Option({ label: "No" })],
    allowOther: true,
    ...over,
  });

/** Scripted keyboard: replays the given keys, then cancels with escape if exhausted. */
const scriptedKeyboard = (keys: KeyEvent[]): Keyboard["Service"] => {
  const remaining = [...keys];
  return {
    nextKey: () => Effect.sync(() => remaining.shift() ?? KeyEvent.escape),
  };
};

interface QueryRecord {
  readonly text: string;
  readonly cursor: number;
  readonly force: boolean;
}

/**
 * Scripted file completions. `handler` decides each query's result; when it
 * returns null the popup closes. `apply` mirrors the pi-tui provider's `@`
 * completion: replace the prefix, add a space after files (not directories).
 */
const scriptedFileSuggestions = (
  handler: (
    text: string,
    cursor: number,
    force: boolean,
  ) => { prefix: string; items: SuggestionItem[] } | null,
): { service: FileSuggestions["Service"]; queries: QueryRecord[] } => {
  const queries: QueryRecord[] = [];
  const service: FileSuggestions["Service"] = {
    query: (text, cursor, force) =>
      Effect.sync(() => {
        queries.push({ text, cursor, force: force ?? false });
        return handler(text, cursor, force ?? false);
      }),
    apply: (text, cursor, item, prefix) =>
      Effect.sync(() => {
        const chars = Array.from(text);
        const at = Math.min(cursor, chars.length);
        const before = chars.slice(0, at - prefix.length).join("");
        const after = chars.slice(at).join("");
        const suffix = item.label.endsWith("/") ? "" : " ";
        const next = before + item.value + suffix + after;
        return { text: next, cursor: Array.from(before + item.value + suffix).length };
      }),
  };
  return { service, queries };
};

/** No completions: every query closes the popup. */
const noFileSuggestions = (): { service: FileSuggestions["Service"]; queries: QueryRecord[] } =>
  scriptedFileSuggestions(() => null);

interface Harness {
  readonly states: MachineState[];
  readonly completed: QuestionResult | undefined;
}

const run = (
  questions: readonly Question[],
  keys: KeyEvent[],
  suggestions: {
    service: FileSuggestions["Service"];
    queries: QueryRecord[];
  } = noFileSuggestions(),
): Effect.Effect<Harness> =>
  Effect.gen(function* () {
    const states: MachineState[] = [];
    let completed: QuestionResult | undefined;
    const renderer: Renderer["Service"] = {
      present: (state) =>
        Effect.sync(() => {
          states.push(state);
        }),
      complete: (result) =>
        Effect.sync(() => {
          completed = result;
        }),
    };
    yield* runQuestionnaire(questions).pipe(
      Effect.provideService(Keyboard, scriptedKeyboard(keys)),
      Effect.provideService(Renderer, renderer),
      Effect.provideService(FileSuggestions, suggestions.service),
    );
    return { states, completed };
  });

/** Keys that open the editor for the "Type something" option. */
const openEditor: KeyEvent[] = [KeyEvent.down, KeyEvent.down, KeyEvent.enter];

const fileItems: SuggestionItem[] = [
  { value: "src/main.ts", label: "main.ts", description: "src/main.ts" },
  { value: "src/utils/", label: "utils/", description: "src/utils/" },
];

describe("runQuestionnaire", () => {
  it.effect("presents the initial state before reading keys", () =>
    Effect.gen(function* () {
      const harness = yield* run([question()], [KeyEvent.enter]);
      expect(harness.states.length).toBeGreaterThanOrEqual(1);
      expect(harness.states[0]?.mode).toBe("single");
    }),
  );

  it.effect("completes with the selected option", () =>
    Effect.gen(function* () {
      const harness = yield* run([question()], [KeyEvent.down, KeyEvent.enter]);
      const result = harness.completed;
      expect(result?.cancelled).toBe(false);
      expect(result?.answers).toHaveLength(1);
      expect(result?.answers[0]?.label).toBe("No");
      expect(result?.answers[0]?.index).toBe(2);
    }),
  );

  it.effect("cancels on escape", () =>
    Effect.gen(function* () {
      const harness = yield* run([question()], [KeyEvent.escape]);
      expect(harness.completed?.cancelled).toBe(true);
      expect(harness.completed?.answers).toHaveLength(0);
    }),
  );

  it.effect("collects a custom answer from the editor", () =>
    Effect.gen(function* () {
      const harness = yield* run(
        [question()],
        [...openEditor, KeyEvent.char("c"), KeyEvent.char("u"), KeyEvent.char("s"), KeyEvent.enter],
      );
      expect(harness.completed?.answers[0]?.label).toBe("cus");
      expect(harness.completed?.answers[0]?.wasCustom).toBe(true);
    }),
  );

  it.effect("handles multi-question flows with a submit tab", () =>
    Effect.gen(function* () {
      const questions = [question(), question({ id: "q2", label: "Q2", prompt: "Second?" })];
      const harness = yield* run(questions, [
        KeyEvent.enter, // q1 -> q2
        KeyEvent.enter, // q2 -> submit tab
        KeyEvent.enter, // confirm
      ]);
      expect(harness.completed?.cancelled).toBe(false);
      expect(harness.completed?.answers.map((a) => a.id)).toEqual(["q1", "q2"]);
    }),
  );

  it.effect("presents a scene after every step", () =>
    Effect.gen(function* () {
      const harness = yield* run([question()], [KeyEvent.down, KeyEvent.down, KeyEvent.enter]);
      // initial, down, down, editor open, then the scripted fallback (escape) closes the editor
      expect(harness.states.map((s) => s.optionIndex)).toEqual([0, 1, 2, 2, 2]);
      expect(harness.states[3]?.inputMode).toBe(true);
      expect(harness.completed?.cancelled).toBe(true);
    }),
  );

  it.effect("lets the user edit a custom answer after returning to its tab", () =>
    Effect.gen(function* () {
      const questions = [question(), question({ id: "q2", label: "Q2", prompt: "Second?" })];
      const harness = yield* run(questions, [
        KeyEvent.down,
        KeyEvent.down,
        KeyEvent.enter, // open editor on q1
        KeyEvent.char("h"),
        KeyEvent.char("i"),
        KeyEvent.enter, // submit "hi", advance to q2
        KeyEvent.shiftTab, // back to q1: answer shown and highlighted
        KeyEvent.enter, // reopen the pre-filled editor
        KeyEvent.char("!"),
        KeyEvent.enter, // re-submit "hi!", advance to q2
        KeyEvent.enter, // answer q2 "Yes", advance to submit
        KeyEvent.enter, // confirm
      ]);
      expect(harness.completed?.answers.find((a) => a.id === "q1")?.label).toBe("hi!");
      expect(harness.completed?.answers.find((a) => a.id === "q1")?.wasCustom).toBe(true);
    }),
  );

  it.effect("lets the user change an option answer after returning to its tab", () =>
    Effect.gen(function* () {
      const questions = [question(), question({ id: "q2", label: "Q2", prompt: "Second?" })];
      const harness = yield* run(questions, [
        KeyEvent.down,
        KeyEvent.enter, // answer q1 "No", advance to q2
        KeyEvent.shiftTab, // back to q1: "No" highlighted
        KeyEvent.up, // "Yes"
        KeyEvent.enter, // change to "Yes", advance to q2
        KeyEvent.enter, // answer q2 "Yes", advance to submit
        KeyEvent.enter, // confirm
      ]);
      expect(harness.completed?.answers.find((a) => a.id === "q1")?.label).toBe("Yes");
      expect(harness.completed?.answers.find((a) => a.id === "q1")?.index).toBe(1);
    }),
  );

  it.effect("opens the popup when typing an @ context, with the best match preselected", () =>
    Effect.gen(function* () {
      const suggestions = scriptedFileSuggestions((text) =>
        text === "@src" ? { prefix: "@src", items: fileItems } : null,
      );
      const harness = yield* run(
        [question()],
        [
          ...openEditor,
          KeyEvent.char("@"),
          KeyEvent.char("s"),
          KeyEvent.char("r"),
          KeyEvent.char("c"),
        ],
        suggestions,
      );
      const last = [...harness.states].reverse().find((s) => s.inputMode && s.suggestions !== null);
      expect(last?.suggestions).toEqual({
        prefix: "@src",
        items: fileItems,
        selectedIndex: 0, // no exact or prefix match on value -> first item
      });
      // Queries follow every edit in the @ context
      expect(suggestions.queries.map((q) => q.text)).toEqual(["@", "@s", "@sr", "@src"]);
    }),
  );

  it.effect("preselects the exact-match item", () =>
    Effect.gen(function* () {
      const suggestions = scriptedFileSuggestions((text) =>
        text.startsWith("@")
          ? {
              prefix: "@src/main",
              items: [
                { value: "@src/main.ts", label: "main.ts" },
                { value: "@src/main", label: "main", description: "src/main" },
              ],
            }
          : null,
      );
      const harness = yield* run(
        [question()],
        [
          ...openEditor,
          KeyEvent.char("@"),
          KeyEvent.char("s"),
          KeyEvent.char("r"),
          KeyEvent.char("c"),
          KeyEvent.char("/"),
          KeyEvent.char("m"),
          KeyEvent.char("a"),
          KeyEvent.char("i"),
          KeyEvent.char("n"),
        ],
        suggestions,
      );
      const last = [...harness.states].reverse().find((s) => s.inputMode && s.suggestions !== null);
      expect(last?.suggestions?.selectedIndex).toBe(1); // value "@src/main" === prefix
    }),
  );

  it.effect("does not query outside an @ context", () =>
    Effect.gen(function* () {
      const suggestions = noFileSuggestions();
      yield* run(
        [question()],
        [...openEditor, KeyEvent.char("h"), KeyEvent.char("i")],
        suggestions,
      );
      expect(suggestions.queries).toHaveLength(0);
    }),
  );

  it.effect("closes the popup when an edit breaks the @ context", () =>
    Effect.gen(function* () {
      const suggestions = scriptedFileSuggestions((text) =>
        text.endsWith("@") ? { prefix: "@", items: fileItems } : null,
      );
      const harness = yield* run(
        [question()],
        [...openEditor, KeyEvent.char("@"), KeyEvent.char(" ")],
        suggestions,
      );
      const states = harness.states;
      const popupOpen = [...states].reverse().find((s) => s.suggestions !== null);
      expect(popupOpen?.editor.text).toBe("@");
      const lastEditor = [...states].reverse().find((s) => s.inputMode);
      expect(lastEditor?.suggestions).toBeNull();
    }),
  );

  it.effect("navigates the popup with up and down, wrapping", () =>
    Effect.gen(function* () {
      const suggestions = scriptedFileSuggestions((text) =>
        text.startsWith("@") ? { prefix: "@", items: fileItems } : null,
      );
      const harness = yield* run(
        [question()],
        [...openEditor, KeyEvent.char("@"), KeyEvent.down, KeyEvent.down, KeyEvent.up],
        suggestions,
      );
      const last = [...harness.states].reverse().find((s) => s.inputMode && s.suggestions !== null);
      expect(last?.suggestions?.selectedIndex).toBe(1); // 0 -> 1 -> 0 (wrap) -> 1
    }),
  );

  it.effect("escape closes the popup without touching the text", () =>
    Effect.gen(function* () {
      const suggestions = scriptedFileSuggestions((text) =>
        text.startsWith("@") ? { prefix: "@", items: fileItems } : null,
      );
      const harness = yield* run(
        [question()],
        [...openEditor, KeyEvent.char("@"), KeyEvent.escape, KeyEvent.char("x")],
        suggestions,
      );
      const states = harness.states;
      const afterEscape = [...states]
        .reverse()
        .find((s) => s.inputMode && s.suggestions === null && s.editor.text === "@");
      expect(afterEscape).toBeDefined();
      // Typing after Esc reopens the popup in an @ context, like the pi editor
      const reopened = [...states]
        .reverse()
        .find((s) => s.inputMode && s.editor.text === "@x" && s.suggestions !== null);
      expect(reopened).toBeDefined();
    }),
  );

  it.effect("tab applies the selected completion and closes the popup", () =>
    Effect.gen(function* () {
      const suggestions = scriptedFileSuggestions((text) =>
        text.startsWith("@") ? { prefix: "@", items: fileItems } : null,
      );
      const harness = yield* run(
        [question()],
        [...openEditor, KeyEvent.char("@"), KeyEvent.down, KeyEvent.tab, KeyEvent.enter],
        suggestions,
      );
      expect(harness.completed?.answers[0]?.label).toBe("src/utils/"); // second item applied, then Enter submits
      expect(harness.completed?.answers[0]?.wasCustom).toBe(true);
    }),
  );

  it.effect("enter applies the completion instead of submitting while the popup is open", () =>
    Effect.gen(function* () {
      const suggestions = scriptedFileSuggestions((text) =>
        text.startsWith("@") ? { prefix: "@", items: fileItems } : null,
      );
      const harness = yield* run(
        [question()],
        [...openEditor, KeyEvent.char("@"), KeyEvent.enter, KeyEvent.enter],
        suggestions,
      );
      const answer = harness.completed?.answers[0];
      expect(answer?.label).toBe("src/main.ts"); // best match applied on first Enter
      expect(answer?.wasCustom).toBe(true);
    }),
  );

  it.effect("re-queries after applying a directory so completion can continue", () =>
    Effect.gen(function* () {
      const suggestions = scriptedFileSuggestions((text, _cursor, force) => {
        if (text === "@") return { prefix: "@", items: fileItems };
        // After applying the directory, continuation happens on the plain
        // path token via a forced Tab query.
        if (text === "src/utils/" && force) {
          return {
            prefix: "src/utils/",
            items: [
              {
                value: "src/utils/helpers.ts",
                label: "helpers.ts",
                description: "src/utils/helpers.ts",
              },
            ],
          };
        }
        return null;
      });
      const harness = yield* run(
        [question()],
        [
          ...openEditor,
          KeyEvent.char("@"),
          KeyEvent.down, // select utils/ (a directory)
          KeyEvent.tab, // applies "src/utils/" without a trailing space
          KeyEvent.tab, // forced query continues completion inside the directory
          KeyEvent.enter, // applies helpers.ts
          KeyEvent.enter, // submits
        ],
        suggestions,
      );
      const answer = harness.completed?.answers[0];
      expect(answer?.label).toBe("src/utils/helpers.ts");
      expect(answer?.wasCustom).toBe(true);
      expect(suggestions.queries.map((q) => q.force)).toEqual([false, true]);
    }),
  );

  it.effect("tab with no popup forces file completion outside an @ context", () =>
    Effect.gen(function* () {
      const suggestions = scriptedFileSuggestions((text, _cursor, force) =>
        text === "src/ut" && force
          ? {
              prefix: "src/ut",
              items: [{ value: "src/utils/", label: "utils/", description: "src/utils/" }],
            }
          : null,
      );
      const harness = yield* run(
        [question()],
        [
          ...openEditor,
          KeyEvent.char("s"),
          KeyEvent.char("r"),
          KeyEvent.char("c"),
          KeyEvent.char("/"),
          KeyEvent.char("u"),
          KeyEvent.char("t"),
          KeyEvent.tab,
          KeyEvent.enter, // applies the best match
          KeyEvent.enter, // submits
        ],
        suggestions,
      );
      expect(harness.completed?.answers[0]?.label).toBe("src/utils/");
      // Plain typing never queried; only the forced Tab did
      expect(suggestions.queries.map((q) => q.text)).toEqual(["src/ut"]);
      expect(suggestions.queries[0]?.force).toBe(true);
    }),
  );
});
