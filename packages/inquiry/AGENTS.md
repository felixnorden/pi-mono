# Learning more about Effect

This repository uses the Effect Typescript library.

Before writing any Effect code, first read `node_modules/effect/AGENTS.md`
**completely**, and follow the links in the file when required.

If you need to learn more about particular Effect apis and concepts that the
guide doesn't cover, search through the source code in `node_modules/effect/src`.

# Search Tooling

Use `rg` (ripgrep) for all searches. Never use `grep`.

- Prefer `rg -n "pattern" <path>` with explicit paths
- Use `rg` for recursive search: `rg -n "pattern" dir/`
- Use `find` for filename listing, not grep

## Architecture

The `src/` directory is an Effect-based toolkit for interactive question tools.

- `src/core/` is pure Effect. It must never import from pi packages
  (`@earendil-works/*`). It contains the domain model, the interaction state
  machine, the scene (rendering model), and the flow programs.
- `src/sdk/` is the pi fringe. It adapts pi's extension SDK and TUI to the
  core services. All pi imports live here.
- `src/tool/` contains thin extension entry points that register tools.

Keep pi imports on the fringe: core code must stay testable without a TUI.
