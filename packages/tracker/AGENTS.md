# Learning more about the Effect

This repository uses the Effect Typescript library.

Before writing any Effect code, first read `node_modules/effect/AGENTS.md`
**completely**, and follow the links in the file when required.

If you need to learn more about particular Effect apis and concepts that the
guide doesn't cover, search through the source code in `node_modules/effect/src`.

# Pi extension notes

This extension integrates with Pi. See the Pi docs at
`docs/extensions.md` and `docs/tui.md` (under the pi-coding-agent package
`docs/` directory) for the extension and TUI component APIs. Reference
implementations live in `examples/extensions/todo.ts` (stateful tool with
session persistence) and `examples/extensions/plan-mode/index.ts` (widget
pane). The integration layer in `src/index.ts` deliberately stays thin:
domain logic lives in Effect services; only the bridge touches `pi` APIs.
