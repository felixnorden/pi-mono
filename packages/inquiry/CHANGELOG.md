# @ftrdotdev/pi-inquiry

## 0.5.0

### Patch Changes

- @ftrdotdev/pi-tui@0.5.0

## 0.4.0

### Patch Changes

- Fix terminal-width crashes from emoji and strip model marker emoji from question text.

  - Measure visible widths per grapheme with pi-tui's emoji rule (`RGI_Emoji`, flags, CJK fallback). The old per-code-point table counted `➡️` (U+27A1 + VS16) as one column while pi's crash guard counts two, so a model-written prompt continuation that exactly filled a line overflowed by one column and pi exited hard ("Rendered line exceeds terminal width"). Widths, truncation, and wrapping now match pi-tui's `visibleWidth` exactly.
  - Strip leading marker emoji (`❓`, `➡️`, `⚠️`, …) from question prompts, labels, and option labels/descriptions: the UI already provides selection affordances, so the markers are pure noise (`❓ Q7 — …` renders as `Q7 — …`). Bare text-presentation glyphs (`→`, `•`, `✔`) are left alone.
  - Clamp framed body rows to the content width so a future measurement mismatch can never push a rail past the terminal again.

- 483f6f4: Tighten the agent-facing tool guidance.

  - Rewrite the `question` tool description and prompt guidelines: split long sentences, use the imperative, and make the "cancelled question" guidance concrete.
  - Update the `tracker` tool description so the working-state claim is concrete instead of "live".

- Updated dependencies [c89b1a6]
- Updated dependencies [2d3c636]
- Updated dependencies [a113d38]
  - @ftrdotdev/pi-tui@0.4.0

## 0.3.0

### Minor Changes

- Add multi-select questions so one question can collect several answers.

  - New `multiple` question parameter (default `false`). When `true` the
    question renders as checkboxes and the user picks several options: Space
    toggles a box on or off, Enter confirms the selection and moves on.
  - `allowOther` still applies to multi-select questions: the user can add
    custom alternatives one at a time through the "Add your own answer" entry.
  - A multi-select question contributes one `Answer` per chosen option or typed
    alternative in the result, all sharing the question's `id`; the tool groups
    them together in its output.

### Patch Changes

- @ftrdotdev/pi-tui@0.3.0

## 0.2.1

### Patch Changes

- Updated dependencies
  - @ftrdotdev/pi-tui@0.2.1

## 0.2.0

### Minor Changes

- fe0ac01: Solidify initial tooling, visuals, and configurability between packages

### Patch Changes

- Updated dependencies [fe0ac01]
  - @ftrdotdev/pi-tui@0.2.0
