---
"@ftrdotdev/pi-tracker": minor
---

Start smart compaction when a tracker item completes.

- Completing an item in the active list starts one classifier call at the settle boundary. The call asks one two-label choice question per judged item: `needs-context` or `stands-alone`. It judges the whole ready frontier, dependents first, up to `smartCompaction.maxCandidates` items. It keeps the context when any item needs the completed work. When no item needs it, the extension starts Pi's own compaction. It then resumes the session with a pointer that names the next ready item.
- Classification reads five keys from `tui.json`: `smartCompaction.enabled`, `smartCompaction.classifier`, `smartCompaction.keepContextThreshold`, `smartCompaction.keepContextMinConfidence`, and `smartCompaction.maxCandidates`. It fails open. A disabled feature, no credential-available classifier, an error, a timeout, an aborted run, or an unready list keeps the full context.
- `smartCompaction.keepContextThreshold` sets the probability of `needs-context` at or above which the context is kept. The default is `0.5`. A value outside `(0, 1)` falls back to the default.
- `smartCompaction.keepContextMinConfidence` sets the answer confidence below which the context is kept. The default is `0.5`. A value outside `(0, 1)` falls back to the default. The floor only adds keeping, so an unsure answer cannot cause a premature compaction.
- `smartCompaction.maxCandidates` caps how many ready items one classification judges. The default is `8`. An integer outside `1..20` falls back to the default.
- The preference order is Cloudflare Clef Flash, then TypeSafe Jev, then OpenCode's Jev. The OpenCode entries are the fallback when only OpenCode credentials are configured. `smartCompaction.classifier` overrides the order. The shared config keys are pinned by `test-fixtures/tui-config.contract.json`.
