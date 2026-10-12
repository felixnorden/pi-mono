---
"@ftrdotdev/pi-tracker": patch
---

Stop the observe-only rule report from writing to the console.

The settle decider logged the fired rule with `Effect.logInfo` before asking the
classifier. Effect's default logger writes to stdout; pi's TUI redirects that to
stderr, which bypasses the differential renderer, so the line stuck in the
editor area. The fired rule and its verdict stay available in the
`tracker/reliance-decision` session entry.
