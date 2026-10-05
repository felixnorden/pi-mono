---
"@ftrdotdev/pi-tui": patch
---

Render the preview widget when the preview tool runs inside a codemode script. Nested tool calls get no TUI row, so the tool now appends its display record as a `preview` custom entry, which the entry renderer draws.
