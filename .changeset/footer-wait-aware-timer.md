---
"@ftrdotdev/pi-tui": patch
---

Refine the footer working/done timer to exclude time spent waiting on blocking `ctx.ui` prompts.

- Subscribe to pi 0.84.4+ `ui_prompt_start`/`ui_prompt_end` events so wall-clock spans where the agent waits on the user (`select`, `confirm`, `input`, `editor`, `custom`) stop counting toward `working` and the finished `done` duration.
- Show a `waiting` label with the wait duration while a prompt is open.
- Bump the pi catalog to 0.84.4 so the new event types are available.