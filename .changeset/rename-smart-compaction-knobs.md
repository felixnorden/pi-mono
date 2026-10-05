---
"@ftrdotdev/pi-tracker": patch
"@ftrdotdev/pi-tui": patch
---

Rename the two smart-compaction confidence knobs so each name states what it measures.

- `smartCompaction.keepContextThreshold` becomes `smartCompaction.needsContextProbabilityThreshold`. It cuts on the classifier's `needs-context` probability. Raise it to compact more often.
- `smartCompaction.keepContextMinConfidence` becomes `smartCompaction.minAnswerConfidence`. It floors the answer's self-reported confidence. Raise it to keep context more often.
- Both old keys still resolve as aliases, so an existing `tui.json` keeps working. The new key wins when both are present.
- The `/tui` Compaction tab labels become `Needs-context probability` and `Answer confidence floor`.
- The tracker README no longer states the inverted direction for the probability knob.
