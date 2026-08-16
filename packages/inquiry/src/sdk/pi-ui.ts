/**
 * Bridge between the pure Effect core and pi's custom UI.
 *
 * The flow program runs on a forked fiber. `handleInput` parses raw key data
 * into core key events and feeds them through a queue; `render` builds the
 * scene from the latest machine state at the current terminal width; `done`
 * resolves the custom-UI promise when the flow completes.
 *
 * This is the thickest part of the fringe. Everything above this file in the
 * core is pi-free.
 */

import { Effect, Fiber, Queue } from "effect";
import { existsSync } from "fs";
import { homedir } from "os";
import { delimiter, join } from "path";
import { CombinedAutocompleteProvider } from "@earendil-works/pi-tui";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { QuestionResult, type Question } from "../core/domain.ts";
import { initialMachineState, type MachineState } from "../core/machine.ts";
import { buildScene } from "../core/scene.ts";
import { FileSuggestions, Keyboard, Renderer } from "../core/services.ts";
import { runQuestionnaire } from "../core/flow.ts";
import type { KeyEvent } from "../core/keyboard.ts";
import { parseKey } from "./keys.ts";
import { paintScene } from "./painter.ts";

export const runQuestionUi = (
  ui: ExtensionUIContext,
  questions: readonly Question[],
  cwd: string,
): Promise<QuestionResult> =>
  ui.custom<QuestionResult>((tui, theme, _keybindings, done) => {
    const keys = Effect.runSync(Queue.unbounded<KeyEvent>());
    const cell: { state: MachineState } = { state: initialMachineState(questions) };

    const keyboard: Keyboard["Service"] = {
      nextKey: () => Queue.take(keys),
    };
    const renderer: Renderer["Service"] = {
      present: (state) =>
        Effect.sync(() => {
          cell.state = state;
          tui.requestRender();
        }),
      complete: (result) =>
        Effect.sync(() => {
          done(result);
        }),
    };

    const fiber = Effect.runFork(
      runQuestionnaire(questions).pipe(
        Effect.provideService(Keyboard, keyboard),
        Effect.provideService(Renderer, renderer),
        Effect.provideService(FileSuggestions, makeFileSuggestions(cwd)),
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            console.error("question flow failed", cause);
            done(new QuestionResult({ questions: [...questions], answers: [], cancelled: true }));
          }),
        ),
      ),
    );

    return {
      render: (width) => paintScene(buildScene(cell.state, width), theme),
      invalidate: () => tui.requestRender(),
      handleInput: (data) => {
        const key = parseKey(data);
        if (key) Effect.runSync(Queue.offer(keys, key));
      },
      dispose: () => {
        Effect.runSync(Fiber.interrupt(fiber));
      },
    };
  });

/**
 * File completion for the inline editor, backed by pi-tui's
 * `CombinedAutocompleteProvider` — the same machinery the main editor uses —
 * so `@` suggestions (fuzzy search, `~` expansion, quoted prefixes, directory
 * continuation) behave identically. Slash commands are not offered: the
 * editor takes a free-text answer.
 *
 * The core editor addresses characters by code point; the provider works in
 * UTF-16 code units, so both directions are converted at this seam.
 */
const makeFileSuggestions = (cwd: string): FileSuggestions["Service"] => {
  const provider = new CombinedAutocompleteProvider([], cwd, resolveFdPath());
  return {
    query: (text, cursor, force) =>
      Effect.tryPromise(() =>
        provider.getSuggestions([text], 0, codePointToUtf16(text, cursor), {
          signal: new AbortController().signal,
          force: force ?? false,
        }),
      ).pipe(
        Effect.map((result) =>
          result === null ? null : { prefix: result.prefix, items: result.items },
        ),
        // A failed lookup just closes the popup; it must never break the flow.
        Effect.catch(() => Effect.succeed(null)),
      ),
    apply: (text, cursor, item, prefix) =>
      Effect.sync(() => {
        const applied = provider.applyCompletion(
          [text],
          0,
          codePointToUtf16(text, cursor),
          item,
          prefix,
        );
        const line = applied.lines[0] ?? "";
        return { text: line, cursor: utf16ToCodePoint(line, applied.cursorCol) };
      }),
  };
};

/** Code-point index (core editor unit) -> UTF-16 code-unit offset. */
export const codePointToUtf16 = (text: string, cursor: number): number =>
  Array.from(text)
    .slice(0, Math.max(0, Math.min(cursor, Array.from(text).length)))
    .join("").length;

/** UTF-16 code-unit offset -> code-point index. */
export const utf16ToCodePoint = (text: string, offset: number): number =>
  Array.from(text.slice(0, Math.max(0, Math.min(offset, text.length)))).length;

/**
 * Locate the `fd` binary used by the provider for fuzzy file search.
 *
 * pi ensures `fd` is available at startup (downloading it into the agent bin
 * dir when the system lacks it), so check the system PATH first, then pi's
 * managed bin dirs. Returns undefined when unavailable; the provider then
 * yields no `@` candidates, matching the main editor without fd.
 */
const resolveFdPath = (): string | undefined => {
  for (const name of ["fd", "fdfind"]) {
    for (const dir of (process.env.PATH ?? "").split(delimiter)) {
      if (dir !== "" && existsSync(join(dir, name))) return name;
    }
  }
  const agentDirs = [
    process.env.PI_CODING_AGENT_DIR,
    process.env.TAU_CODING_AGENT_DIR,
    join(homedir(), ".pi", "agent"),
    join(homedir(), ".config", "pi", "agent"),
  ];
  for (const dir of agentDirs) {
    if (!dir) continue;
    for (const name of ["fd", "fdfind"]) {
      const candidate = join(dir, "bin", name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
};
