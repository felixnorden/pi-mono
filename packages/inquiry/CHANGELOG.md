# @ftrdotdev/pi-inquiry

## 0.7.0

### Patch Changes

- Updated dependencies [edb419d]
- Updated dependencies [f4213db]
  - @ftrdotdev/pi-tui@0.7.0

## 0.6.0

### Minor Changes

- 3803293: Add mouse-wheel navigation, clipboard copy, and new theme helpers.

  - The footer lists every runtime that matches the working directory, in table order, and joins them with a dim `·`. Previously it showed the first match only. An empty result stays an empty segment.
  - The editor's top border shows pi's working status indicator during a run: spinner and message when they fit, spinner alone on narrow widths. The mode glyph and the scroll hint move behind it in the label slot.
  - `makeBorderedBox` takes a theme background token for `bg` instead of a caller-supplied function. Pass `"customMessageBg"` where the code passed `(s) => theme.bg("customMessageBg", s)`. The border, the embedded label, and the body now paint the same background.
  - `@ftrdotdev/pi-tui` exports derived theme colors: `mixThemeTokens`, `recede`, `emphasize`, and `isDark`. Use them for shades that are not theme tokens, such as a dimmed border or a selected row. `recede` and `emphasize` follow `theme.appearance`, so a light theme needs no special case.
  - The `/tracker` overlay moves the cursor with the mouse wheel and wraps at either end. `[c]` copies the selected list or item and reports `Copied ...` in the overlay.
  - The selected row in the `/tracker` overlay uses the `selectedBg` token.
  - The inquiry questionnaire moves the cursor with the mouse wheel and copies the open question and its options with `ctrl+y`.
  - The header clears the visible screen once per process, on the first regular-mode mount, and never again. Fullscreen owns the alternate screen, where the clear only flickered. A re-mount (`reload`, `new`, `fork`, `/resume`, settings toggle) no longer clears: that write went outside pi-tui and desynced its differential redraw, which left the space for an extension widget blank until the next full repaint.

### Patch Changes

- Updated dependencies [3803293]
- Updated dependencies [6876f36]
  - @ftrdotdev/pi-tui@0.6.0

## 0.5.2

### Patch Changes

- a860f5b: Move the Effect packages to the stable `4.0.0` release and the Pi packages to `1.0.0`.

  - Bump `effect`, `@effect/platform-node`, `@effect/platform-node-shared`, and `@effect/vitest` to `4.0.0`, and `@effect/tsgo` to `0.47.2`.
  - Bump `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, and `@earendil-works/pi-tui` to `1.0.0`.
  - Follow the rc.118 module move: `effect/unstable/process` becomes `effect/process`.
  - Follow the Pi 0.99.0 tool API: tool execution contexts are now `ExtensionToolContext`.
  - `pi-inquiry` gains a `typecheck` script; its two latent type errors are fixed.

- Updated dependencies [a860f5b]
  - @ftrdotdev/pi-tui@0.5.2

## 0.5.1

### Patch Changes

- 4e101f0: Pin `@effect/platform-node-shared` and move the Effect packages to `4.0.0-rc.116`.

  The 0.5.0 packages pinned `effect` and `@effect/platform-node` to `4.0.0-rc.108`. `@effect/platform-node` depends on `@effect/platform-node-shared` with a caret range. Every `4.0.0-rc.*` release shares the `4.0.0` base, so that range resolved to a newer `@effect/platform-node-shared` that imports `effect/ByteSize`. The pinned `effect` has no `ByteSize` module, so loading an extension failed with `Cannot find module '.../effect/dist/ByteSize.js'`.

  - Move `effect`, `@effect/platform-node`, and `@effect/vitest` to `4.0.0-rc.116`.
  - Add `@effect/platform-node-shared` to the `effect` catalog at an exact version, and depend on it directly from `pi-tui` and `pi-tracker`. This stops the transitive range from floating to a release that needs a newer `effect`.

- Updated dependencies [4e101f0]
  - @ftrdotdev/pi-tui@0.5.1

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
