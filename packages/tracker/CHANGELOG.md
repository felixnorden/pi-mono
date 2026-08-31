# @ftrdotdev/pi-tracker

## 0.4.0

### Patch Changes

- 483f6f4: Tighten the agent-facing tool guidance.

  - Rewrite the `question` tool description and prompt guidelines: split long sentences, use the imperative, and make the "cancelled question" guidance concrete.
  - Update the `tracker` tool description so the working-state claim is concrete instead of "live".

- Updated dependencies [c89b1a6]
- Updated dependencies [2d3c636]
- Updated dependencies [a113d38]
  - @ftrdotdev/pi-tui@0.4.0

## 0.3.0

### Minor Changes

- Make `update_item` batching per-list and mirror `add_item`.

  - `update_item`'s batch form changed from `items=[{item_id, text?, done?}, ...]`
    (each id naming its own list) to `list_id` (required) + `items=[{index, text?,
done?}, ...]`, where `index` is the item's 1-based position in that list.
    This mirrors `add_item`'s `list_id + text[]` shape, so one batch stays within
    a single list.
  - The scalar `item_id` + `text`/`done` form is unchanged.
  - `doneMarkReminder` now fires only on the terminal batch — two or more items
    marked done with no open items left behind — instead of any multi-done call.

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
