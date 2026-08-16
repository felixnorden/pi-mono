/**
 * The question flow: an Effect program that drives the interaction machine
 * from keyboard events to a final result.
 *
 * Pure core — no pi imports. The `Keyboard` and `Renderer` services abstract
 * the terminal; the fringe implements them with `ctx.ui.custom`. The
 * `FileSuggestions` service provides `@` file completion for the inline
 * editor; the flow re-queries it after every editor change and applies the
 * chosen item when the machine asks to.
 */

import { Effect } from "effect";
import type { Question, QuestionResult } from "./domain.ts";
import {
  initialMachineState,
  isAtCompletionContext,
  openSuggestions,
  step,
  textBeforeCursor,
  type MachineState,
} from "./machine.ts";
import { FileSuggestions, Keyboard, Renderer } from "./services.ts";

export const runQuestionnaire = Effect.fn("inquiry.core.runQuestionnaire")(function* (
  questions: readonly Question[],
): Effect.fn.Return<QuestionResult, never, Keyboard | Renderer | FileSuggestions> {
  const keyboard = yield* Keyboard;
  const renderer = yield* Renderer;
  const fileSuggestions = yield* FileSuggestions;

  let state = initialMachineState(questions);
  yield* renderer.present(state);

  while (true) {
    const key = yield* keyboard.nextKey();
    const previousEditor = state.editor;
    const stepped = step(state, key);
    state = stepped.state;

    if (stepped.action.type === "complete") {
      const result = stepped.action.result;
      yield* renderer.complete(result);
      return result;
    }

    if (stepped.action.type === "applySuggestion") {
      const suggestion = state.suggestions;
      const item =
        suggestion?.items[Math.min(suggestion.selectedIndex, suggestion.items.length - 1)];
      if (suggestion && item) {
        const applied = yield* fileSuggestions.apply(
          state.editor.text,
          state.editor.cursor,
          item,
          suggestion.prefix,
        );
        state = { ...state, editor: applied, suggestions: null };
      }
    } else if (stepped.action.type === "forceSuggestion") {
      // Tab with no open popup: force file completion (plain paths, directory
      // continuation), like the pi editor.
      state = yield* refreshSuggestions(state, fileSuggestions, true);
    }

    // Keep the popup in sync with the editor: open it in an `@` context,
    // refresh it on every edit while open, and close it when the provider
    // reports no completion (e.g. the context was broken by a space).
    if (state.inputMode && state.editor !== previousEditor) {
      state = yield* refreshSuggestions(state, fileSuggestions, false);
    }

    yield* renderer.present(state);
  }
});

/**
 * Refresh the completion popup after an editor change (or a forced Tab).
 *
 * A closed popup only opens when the text before the cursor is an `@`
 * completion context; an open popup always re-queries so it refreshes with
 * the new prefix — or closes when the provider returns null. Forced queries
 * (Tab) skip the `@` gate so plain path tokens complete too. This mirrors
 * the pi editor's trigger/update behavior.
 */
const refreshSuggestions = Effect.fn("inquiry.core.refreshSuggestions")(function* (
  state: MachineState,
  fileSuggestions: FileSuggestions["Service"],
  force: boolean,
): Effect.fn.Return<MachineState> {
  if (!force && !state.suggestions && !isAtCompletionContext(textBeforeCursor(state.editor))) {
    return state;
  }
  const result = yield* fileSuggestions.query(state.editor.text, state.editor.cursor, force);
  if (result === null) {
    return { ...state, suggestions: null };
  }
  return openSuggestions(state, result.prefix, result.items);
});
