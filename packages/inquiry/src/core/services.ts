/**
 * Services the question flow depends on.
 *
 * The core defines these as abstract capabilities; the fringe (`sdk/`)
 * implements them on top of pi's custom UI. Tests implement them with
 * scripted fakes.
 */

import { Context, Effect } from "effect";
import type { KeyEvent } from "./keyboard.ts";
import type { QuestionResult } from "./domain.ts";
import type { MachineState } from "./machine.ts";

/** One entry in the file-completion popup. */
export interface SuggestionItem {
  /** Full replacement text for the `@` token. */
  readonly value: string;
  /** Short label shown in the popup. */
  readonly label: string;
  readonly description?: string;
}

/** A live completion session: the token prefix to replace plus the candidates. */
export interface CompletionState {
  readonly prefix: string;
  readonly items: readonly SuggestionItem[];
}

export class Keyboard extends Context.Service<
  Keyboard,
  {
    /** Wait for the next key event from the user. Blocks until one is available. */
    nextKey(): Effect.Effect<KeyEvent>;
  }
>()("inquiry/core/services/Keyboard") {}

export class Renderer extends Context.Service<
  Renderer,
  {
    /** Request a redraw reflecting the given machine state. */
    present(state: MachineState): Effect.Effect<void>;
    /** Resolve the interaction with a final result. */
    complete(result: QuestionResult): Effect.Effect<void>;
  }
>()("inquiry/core/services/Renderer") {}

/**
 * File-reference completion for the inline editor (the `@`-token popup).
 *
 * The core only knows the interface; the fringe implements it on pi-tui's
 * `CombinedAutocompleteProvider`, which is the same machinery the main editor
 * uses, so suggestion contents and completion semantics stay identical.
 *
 * `cursor` is a code-point index into `text` (the core editor unit), like
 * every other editor API in this package.
 */
export class FileSuggestions extends Context.Service<
  FileSuggestions,
  {
    /**
     * Request completions for the text before the cursor.
     *
     * Returns null when the text is not a completion context or no candidate
     * matches. The popup closes when this returns null.
     *
     * `force` mirrors the pi editor's Tab behavior: query even outside an `@`
     * context so plain path tokens and directory continuations complete.
     */
    query(text: string, cursor: number, force?: boolean): Effect.Effect<CompletionState | null>;
    /**
     * Replace the `@` token with the chosen item, returning the new editor
     * text and cursor (code-point index).
     */
    apply(
      text: string,
      cursor: number,
      item: SuggestionItem,
      prefix: string,
    ): Effect.Effect<{ readonly text: string; readonly cursor: number }>;
  }
>()("inquiry/core/services/FileSuggestions") {}
