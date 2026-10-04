---
"@ftrdotdev/pi-tui": minor
---

Add smart-compaction settings to the `/tui` dialog.

- A dedicated `Compaction` tab holds the smart-compaction settings. It shows five rows: `Smart compaction` (On/Off toggle), `Compaction classifier` (picker), `Keep-context confidence` (number), `Min confidence` (number), and `Max candidates` (integer).
- The `+` and `-` keys step `Keep-context confidence` and `Min confidence` by `0.05`, clamped to `0.05..0.95`. The same keys step `Max candidates` by `1`, clamped to `1..20`.
- The `Compaction classifier` picker cycles credential-available classifiers. `Automatic` is first and means "prefer Clef Flash, then Jev". When no classifier has credentials, the picker falls back to the full catalog.
- The Compaction tab appears only while the tracker extension is loaded. A session without it never shows tracker-only settings.
- All five values persist to `tui.json` as `smartCompaction.enabled`, `smartCompaction.classifier`, `smartCompaction.keepContextThreshold`, `smartCompaction.keepContextMinConfidence`, and `smartCompaction.maxCandidates`. The tracker reads these keys.
