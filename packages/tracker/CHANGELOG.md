# @ftrdotdev/pi-tracker

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
