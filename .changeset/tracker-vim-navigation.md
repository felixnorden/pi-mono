---
"@ftrdotdev/pi-tracker": minor
---

Add h/j/k/l navigation to the `/tracker` overlay, gated on the TUI `vim` toggle.

- `j`/`k` move the cursor and `h`/`l` switch panes, in both the lists pane and
  the items pane.
- Arrow keys always work. Arrow left and right now switch panes as well.
- The vim keys are live only when `vim` is on in the shared `tui.json`. The
  overlay reads that toggle when it opens and shows the vim keys in its help
  line only when they are active.
