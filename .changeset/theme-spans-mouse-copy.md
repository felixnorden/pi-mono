---
"@ftrdotdev/pi-tui": minor
"@ftrdotdev/pi-tracker": minor
"@ftrdotdev/pi-inquiry": minor
---

Add mouse-wheel navigation, clipboard copy, and new theme helpers.

- The footer lists every runtime that matches the working directory, in table order, and joins them with a dim ` · `. Previously it showed the first match only. An empty result stays an empty segment.
- The editor's top border shows pi's working status indicator during a run: spinner and message when they fit, spinner alone on narrow widths. The mode glyph and the scroll hint move behind it in the label slot.
- `makeBorderedBox` takes a theme background token for `bg` instead of a caller-supplied function. Pass `"customMessageBg"` where the code passed `(s) => theme.bg("customMessageBg", s)`. The border, the embedded label, and the body now paint the same background.
- `@ftrdotdev/pi-tui` exports derived theme colors: `mixThemeTokens`, `recede`, `emphasize`, and `isDark`. Use them for shades that are not theme tokens, such as a dimmed border or a selected row. `recede` and `emphasize` follow `theme.appearance`, so a light theme needs no special case.
- The `/tracker` overlay moves the cursor with the mouse wheel and wraps at either end. `[c]` copies the selected list or item and reports `Copied ...` in the overlay.
- The selected row in the `/tracker` overlay uses the `selectedBg` token.
- The inquiry questionnaire moves the cursor with the mouse wheel and copies the open question and its options with `ctrl+y`.
- The header clears the visible screen once per process, on the first regular-mode mount, and never again. Fullscreen owns the alternate screen, where the clear only flickered. A re-mount (`reload`, `new`, `fork`, `/resume`, settings toggle) no longer clears: that write went outside pi-tui and desynced its differential redraw, which left the space for an extension widget blank until the next full repaint.
