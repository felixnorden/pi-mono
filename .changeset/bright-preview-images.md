---
"@ftrdotdev/pi-tui": minor
---

Support inline image previews in the `preview` tool and the `/preview` command.

- Render PNG, JPEG, GIF, WebP, and AVIF files inline via the terminal graphics protocol; the image bytes live only in the TUI and never reach the model's context.
- Add an AVIF `ispe` box parser for dimensions, which pi-tui's `Image` component does not yet provide; other formats are sized from their base64 payload.
- Base64-encode image bytes with Web APIs only, chunked so large files do not overflow the call stack.