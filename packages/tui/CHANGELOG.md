# @ftrdotdev/pi-tui

## 0.5.1

### Patch Changes

- 4e101f0: Pin `@effect/platform-node-shared` and move the Effect packages to `4.0.0-rc.116`.

  The 0.5.0 packages pinned `effect` and `@effect/platform-node` to `4.0.0-rc.108`. `@effect/platform-node` depends on `@effect/platform-node-shared` with a caret range. Every `4.0.0-rc.*` release shares the `4.0.0` base, so that range resolved to a newer `@effect/platform-node-shared` that imports `effect/ByteSize`. The pinned `effect` has no `ByteSize` module, so loading an extension failed with `Cannot find module '.../effect/dist/ByteSize.js'`.

  - Move `effect`, `@effect/platform-node`, and `@effect/vitest` to `4.0.0-rc.116`.
  - Add `@effect/platform-node-shared` to the `effect` catalog at an exact version, and depend on it directly from `pi-tui` and `pi-tracker`. This stops the transitive range from floating to a release that needs a newer `effect`.

## 0.5.0

## 0.4.0

### Minor Changes

- c89b1a6: Support inline image previews in the `preview` tool and the `/preview` command.

  - Render PNG, JPEG, GIF, WebP, and AVIF files inline via the terminal graphics protocol; the image bytes live only in the TUI and never reach the model's context.
  - Add an AVIF `ispe` box parser for dimensions, which pi-tui's `Image` component does not yet provide; other formats are sized from their base64 payload.
  - Base64-encode image bytes with Web APIs only, chunked so large files do not overflow the call stack.

### Patch Changes

- 2d3c636: Break the footer timer into live model-inference and tool-execution time.

  - Replace the working/done timer's hand-rolled interval fields with a pure, clock-injected activity state machine (`ActivityTracker`): every instant of an agent run is charged to exactly one of four exclusive buckets — inference, tool, wait, or implicit overhead — preserving the waiting-exclusion behavior from the previous changeset.
  - While a run is open, the timer segment shows the total plus a split of inference and tool time with one glyph per bucket (`~ 2s > 1s`); the split yields before the total on narrow widths. A finished run keeps a frozen split next to the done total.
  - Subscribe to pi `message_start`/`message_end` (assistant spans) and `tool_execution_start`/`tool_execution_end` (call-id-paired executions, one union interval for parallel tools) to populate the split live; `session_start`/`session_shutdown` reset it.

- a113d38: Refine the footer working/done timer to exclude time spent waiting on blocking `ctx.ui` prompts.

  - Subscribe to pi 0.84.4+ `ui_prompt_start`/`ui_prompt_end` events so wall-clock spans where the agent waits on the user (`select`, `confirm`, `input`, `editor`, `custom`) stop counting toward `working` and the finished `done` duration.
  - Show a `waiting` label with the wait duration while a prompt is open.
  - Bump the pi catalog to 0.84.4 so the new event types are available.

## 0.3.0

## 0.2.1

### Patch Changes

- Fix bundling issue of relying on ioredis when peer dep isn't needed

## 0.2.0

### Minor Changes

- fe0ac01: Solidify initial tooling, visuals, and configurability between packages
