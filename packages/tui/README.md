# pi-tui

House TUI components and the pi interface extension, built on the
[pi coding agent](https://pi.dev) and Effect.

Package: `@ftrdotdev/pi-tui` · [MIT](LICENSE)

## What it is

`pi-tui` has two sides:

1. **Components** — composable, theme-aware UI pieces that other `@ftrdotdev`
   packages and pi extensions import as code: `makeBorderedBox` for themed
   boxes, `defineComponent` for closure-based components, and a pure
   box-frame model that does string/geometry arithmetic without pi or effect
   imports (available at `@ftrdotdev/pi-tui/box-frame`).

2. **The interface extension** — a pi extension that installs the session
   chrome: header, footer (git status, runtime info, thinking level, usage,
   cost), editor autocomplete, the `/settings` command, preview, and turn
   telemetry. It registers through the `pi` field in `package.json` and loads
   `src/index.ts`; it is deliberately not re-exported from the component
   barrel, so importing a component never drags in the extension's side
   effects.

## Installation

Install the extension from npm:

```bash
pi install npm:@ftrdotdev/pi-tui
```

To use only the components without the extension, depend on it from your own
package:

```bash
bun add @ftrdotdev/pi-tui
npm i @ftrdotdev/pi-tui
```

```ts
import { makeBorderedBox, type BorderedBoxOptions } from "@ftrdotdev/pi-tui";
import { buildBoxFrame, type BoxFrameOptions } from "@ftrdotdev/pi-tui/box-frame";
```

## Component model

Components handed to pi (`setWidget`, `ui.custom`, `setFooter`,
`setHeader`, `setEditorComponent`, entry renderers) must be plain objects
built from closures: pi-tui invokes `render`/`invalidate` as methods of the
wrapper object it was given, so an unbound class method would lose `this`.
`makeBorderedBox` and `defineComponent` build closure components that carry
no `this` and survive any hand-off.

## Development

| Command             | Purpose                                      |
| ------------------- | -------------------------------------------- |
| `bun test`          | Run the test suite (vitest + @effect/vitest) |
| `bun test:watch`    | Run the test suite in watch mode             |
| `bunx tsc --noEmit` | Type check                                   |
| `bun lint`          | Lint with oxlint                             |