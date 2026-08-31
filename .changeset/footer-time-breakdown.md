---
"@ftrdotdev/pi-tui": patch
---

Break the footer timer into live model-inference and tool-execution time.

- Replace the working/done timer's hand-rolled interval fields with a pure, clock-injected activity state machine (`ActivityTracker`): every instant of an agent run is charged to exactly one of four exclusive buckets — inference, tool, wait, or implicit overhead — preserving the waiting-exclusion behavior from the previous changeset.
- While a run is open, the timer segment shows the total plus a split of inference and tool time with one glyph per bucket (`~ 2s > 1s`); the split yields before the total on narrow widths. A finished run keeps a frozen split next to the done total.
- Subscribe to pi `message_start`/`message_end` (assistant spans) and `tool_execution_start`/`tool_execution_end` (call-id-paired executions, one union interval for parallel tools) to populate the split live; `session_start`/`session_shutdown` reset it.