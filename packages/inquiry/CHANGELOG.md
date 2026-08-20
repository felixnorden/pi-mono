# @ftrdotdev/pi-inquiry

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
