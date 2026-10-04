# @ftrdotdev/pi-tracker

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

- 56780b8: Start smart compaction when a tracker item completes.

  - Completing an item in the active list starts one classifier call at the settle boundary. The call asks one two-label choice question per judged item: `needs-context` or `stands-alone`. It judges the whole ready frontier, dependents first, up to `smartCompaction.maxCandidates` items. It keeps the context when any item needs the completed work. When no item needs it, the extension starts Pi's own compaction. It then resumes the session with a pointer that names the next ready item.
  - Classification reads five keys from `tui.json`: `smartCompaction.enabled`, `smartCompaction.classifier`, `smartCompaction.keepContextThreshold`, `smartCompaction.keepContextMinConfidence`, and `smartCompaction.maxCandidates`. It fails open. A disabled feature, no credential-available classifier, an error, a timeout, an aborted run, or an unready list keeps the full context.
  - `smartCompaction.keepContextThreshold` sets the probability of `needs-context` at or above which the context is kept. The default is `0.5`. A value outside `(0, 1)` falls back to the default.
  - `smartCompaction.keepContextMinConfidence` sets the answer confidence below which the context is kept. The default is `0.5`. A value outside `(0, 1)` falls back to the default. The floor only adds keeping, so an unsure answer cannot cause a premature compaction.
  - `smartCompaction.maxCandidates` caps how many ready items one classification judges. The default is `8`. An integer outside `1..20` falls back to the default.
  - The preference order is Cloudflare Clef Flash, then TypeSafe Jev, then OpenCode's Jev. The OpenCode entries are the fallback when only OpenCode credentials are configured. `smartCompaction.classifier` overrides the order. The shared config keys are pinned by `test-fixtures/tui-config.contract.json`.

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
