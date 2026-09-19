---
"@ftrdotdev/pi-tracker": minor
---

Add item dependencies as a DAG, with readiness gates and a derived display order.

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
