# @ftrdotdev/pi-tui

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

- 6876f36: Add smart-compaction settings to the `/tui` dialog.

  - A dedicated `Compaction` tab holds the smart-compaction settings. It shows five rows: `Smart compaction` (On/Off toggle), `Compaction classifier` (picker), `Keep-context confidence` (number), `Min confidence` (number), and `Max candidates` (integer).
  - The `+` and `-` keys step `Keep-context confidence` and `Min confidence` by `0.05`, clamped to `0.05..0.95`. The same keys step `Max candidates` by `1`, clamped to `1..20`.
  - The `Compaction classifier` picker cycles credential-available classifiers. `Automatic` is first and means "prefer Clef Flash, then Jev". When no classifier has credentials, the picker falls back to the full catalog.
  - The Compaction tab appears only while the tracker extension is loaded. A session without it never shows tracker-only settings.
  - All five values persist to `tui.json` as `smartCompaction.enabled`, `smartCompaction.classifier`, `smartCompaction.keepContextThreshold`, `smartCompaction.keepContextMinConfidence`, and `smartCompaction.maxCandidates`. The tracker reads these keys.

## 0.5.2

### Patch Changes

- a860f5b: Move the Effect packages to the stable `4.0.0` release and the Pi packages to `1.0.0`.

  - Bump `effect`, `@effect/platform-node`, `@effect/platform-node-shared`, and `@effect/vitest` to `4.0.0`, and `@effect/tsgo` to `0.47.2`.
  - Bump `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, and `@earendil-works/pi-tui` to `1.0.0`.
  - Follow the rc.118 module move: `effect/unstable/process` becomes `effect/process`.
  - Follow the Pi 0.99.0 tool API: tool execution contexts are now `ExtensionToolContext`.
  - `pi-inquiry` gains a `typecheck` script; its two latent type errors are fixed.

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
