# pi-inquiry

Interactive questions for the [pi coding agent](https://pi.dev). Registers a
single `question` tool that asks the user one or more multiple-choice
questions: a selectable option list for a single question, a tabbed form with
a submit tab for several. Every question keeps an open "Type something." path,
so the user can type a custom answer when the listed options do not fit.

Package: `@ftrdotdev/pi-inquiry` · [MIT](LICENSE)

## What it is

`inquiry` is a pi extension. It is a package named `@ftrdotdev/pi-inquiry` and
registers exactly one tool: `question`.

The `question` tool asks the user to decide: pick between options, or confirm
a decision. It renders as a selectable list (single question) or a tabbed form
(multiple questions). Use it instead of ending a reply with a question in
plain text — the model guidance is contributed through `promptSnippet` and
`promptGuidelines` at tool registration, so the agent knows when to call it
and how to present questions.

The tool renders in pi's TUI. Outside TUI mode it returns an error instead of
showing a question.

## Installation

Install from npm:

```bash
pi install npm:@ftrdotdev/pi-inquiry
```

From git or a local checkout:

```bash
pi install git:github.com/felixnorden/pi-mono
pi install ./path/to/pi-mono/packages/inquiry
```

To try the package without installing it, use `-e` (temporary, current run
only):

```bash
pi -e npm:@ftrdotdev/pi-inquiry
```

Registration lives in `package.json` under the `pi` field:

```json
"pi": {
  "extensions": ["./src/tool/question.ts"]
}
```

The extension entry is `src/tool/question.ts`. It wires the tool definition
(name, JSON Schema parameters, prompt contributions, renderers) to pi's
`ExtensionAPI`. The core logic lives in pure Effect modules under `src/core/`,
with pi-specific adapters under `src/sdk/`.

## Using the `question` tool

The model calls `question` whenever it needs the user to decide something,
pick between options, or confirm a decision. Ask all open questions in one
`question` call, with one entry per question in `questions[]`.

### Parameters

```json
{
  "questions": [
    {
      "prompt": "The full question text to display",
      "options": [{ "label": "Short label", "description": "Optional one-line description" }],
      "id": "optional-unique-id", // defaults to q1, q2, ...
      "label": "Scope", // short tab-bar label, defaults to Q1, Q2
      "allowOther": true, // defaults to true; false forces the listed options
      "multiple": false // defaults to false; true asks for one or more answers
    }
  ]
}
```

- `questions` — one or more questions. A single question shows a simple
  option list; multiple questions show a tabbed interface with a submit tab.
- `options` — 2–5 short options per question, each a `label` plus an optional
  one-line `description`.
- `allowOther` — when `true` (default), the user can also type a free-text
  answer ("Type something."). Set it to `false` only when one of the listed
  options is required.
- `multiple` — when `true`, the question is multi-select: the options render
  as checkboxes and the user picks one or more of them, then presses Enter to
  confirm the selection instead of choosing a single one. Space toggles a
  checkbox on or off; Enter confirms. This is the natural way to ask "which
  of these apply?" without turning each option into its own binary question.

### Multi-select answers

A multi-select question keeps an "Add your own answer" entry (when
`allowOther` is true) so the user can type additional alternatives; each typed
answer becomes one more chosen value. Space toggles each option and removes a
typed chip; Enter confirms and records the whole selection. As with a
single-select question, pressing Enter on the "Add your own answer" row opens
the type mode (Space does too). In the result, a multi-select question
contributes one `Answer` per chosen option or typed alternative, all sharing
the question's `id`.

### Result

The tool returns its answers both as human-readable content and in
`details`:

```ts
{
  questions: [...],                  // the normalized questions asked
  answers: [
    {
      id: "q1",
      label: "the chosen option or typed answer",
      wasCustom: false,              // true when the user typed a free-text answer
      index: 2                       // option index, absent for custom answers
    }
    // A multi-select question contributes one entry per chosen value.
  ],
  cancelled: false                   // true when the user dismissed the form
}
```

The tool groups a question's answers together in its output, so a
multi-select question reads as e.g. `Q1: user selected: 1. A, 2. B, user
wrote: X` rather than several detached rows.

Treat a cancelled result as the user declining to answer. Do not re-ask
unless the answer is essential; then ask once more in a different form.

## Pairing with the tracker

`question` is a decision tool, not a tracker. Pair it with pi's `tracker`
tool when a session spans several pieces of work. Keep one tracker list per
piece of work, and use `question` when you need the user to steer the session:

- which task list to work on next, when several pieces of work are open
- which option or approach to take for the current item
- whether to change scope, reprioritize, or drop an item
- confirm a decision instead of guessing

Group related decisions into one `question` call with multiple entries in
`questions[]`. They render as a single tabbed form with a submit tab, so the
user resolves several open points in one pass.

## Architecture

The core is a pure Effect toolkit with zero pi imports; all pi interaction
lives on the fringe.

- `src/core/` — pure Effect, no pi imports
  - `domain.ts` — Effect Schema wire contract. The single source of truth:
    the tool's `parameters` JSON Schema is generated from it, and `decodeParams`
    validates every call.
  - `machine.ts` — pure reducer `step(state, key)`. Exhaustive tests pin the
    legacy UX contract (tab navigation, editor mode, cancel semantics).
  - `flow.ts` — the interaction program: keyboard events in, machine steps,
    result out, via the `Keyboard` and `Renderer` services.
  - `keyboard.ts`, `editor.ts`, `scene.ts`, `text.ts` — key event model,
    code-point editor, style-token scene model, width-aware wrapping.
- `src/sdk/` — the pi fringe (all pi imports live here)
  - `pi-ui.ts` — `ctx.ui.custom` bridge: key events via a queue, scene painting
    at the current width, result completion.
  - `keys.ts` — raw pi key data to core `KeyEvent`s.
  - `painter.ts` — scene style tokens to pi theme ANSI.
  - `schema.test.ts` — pins pi's runtime validation against the generated schema.
- `src/tool/question.ts` — tool registration: discovery content
  (`promptSnippet`/`promptGuidelines`), the legacy `prepareArguments` shim,
  renderers.

## Development

```bash
bun install
bun run test       # vitest (pure tests + @effect/vitest flow tests)
bun run lint       # oxlint
bunx tsc --noEmit  # typecheck
```
