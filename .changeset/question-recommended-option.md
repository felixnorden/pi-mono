---
"@ftrdotdev/pi-inquiry": minor
---

Add an optional per-option `recommended` flag to the `question` tool. The tool
shows a `✓` marker in a reserved column left of the option label.

- `options[].recommended` (default `false`) marks the option the model suggests.
  On a multi-select question (`multiple: true`), the model can recommend any
  number of options. On a single-choice question, the tool rejects two or more
  recommendations as invalid parameters. The tool does not trim the
  recommendations.
- This release changes the layout. Every option-block row now reserves a two-cell
  marker column. Option labels, the multi-select checkbox, and the
  "Add your own answer" row move two columns right. Option descriptions and the
  "Current answer" subtitle move two columns right too. Their offset from the
  label is unchanged.
- The tool description, the `recommended` field description, and the five prompt
  guidelines use short imperative sentences. The model reads the same rules and
  defaults as before.
