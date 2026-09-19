# @ftrdotdev/pi-tracker

## 0.5.0

### Minor Changes

- 8b7b62b: Add item dependencies as a DAG, with readiness gates and a derived display order.

  - Every item carries a permanent id, unique within its list and never reused.
    Removing an item leaves a gap in the numbering instead of renumbering the
    items after it, so a reference you already hold stays valid.
  - The `update_item` batch form now takes `item_id` per patch. It replaced the
    positional `index` field, so callers that used positions must switch. A batch
    applies its patches in order, so one call can complete a chain; a completion
    that comes before its blocker in the array is refused.
  - Declare dependencies with `deps`: same-list `listName:id` references, either
    on the item object or through `update_item`. `deps` replaces the set, so pass
    `[]` to clear it. A dependency that would close a cycle is rejected, and the
    error names the cycle.
  - Completing a blocked item fails and the error names the blockers. Removing an
    item that other items depend on fails and the error names the dependents.
    Reopening never fails and does not cascade: the result notes any dependents
    that are now done but blocked, and a `deps` edit that leaves a done item
    waiting is reported the same way.
  - The `deps` report names the set before and after whenever the two differ, so a
    dependency that a call dropped is visible.
  - The `list` action marks blocked items with `(blocked by ...)` and done items
    whose dependency is open with `(waiting on ...)`. It ends every list that has
    dependencies with a `Ready now` line; a list with no `blocked by` marker has
    nothing blocked, and an edge-free list keeps the output it had before.
  - The widget marks the current (first ready) item with `●`, other ready items
    with `○`, blocked items with `⊘`, and done items with `✓`.
  - The widget, the `list` action, and the `/tracker` items pane render items in
    a stable dependency order. A list with no dependencies keeps its stored
    order, and its output is byte-identical to before.
  - A session saved before this change loads with each item id equal to its
    position, so its references still resolve.

### Patch Changes

- 964a496: Collapse long lists in the widget and fix the scalar `update_item` crash.

  - Keep the first item, the current item (the first item still open), and the last item visible when the active list has more items than the widget can show. Collapse the items outside that window into a `⋮` row, and show the row only when items are hidden between the visible rows.
  - Mark the current item with a filled `●` in the accent color, so the item being worked on stands out from the other open items.
  - Fix `update_item` with `item_id`, which failed with `items.map is not a function`. Both `update_item` forms now return an affected-items array.

- @ftrdotdev/pi-tui@0.5.0

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
