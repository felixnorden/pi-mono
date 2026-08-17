# pi-mono

A monorepo of [pi](https://pi.dev) packages built with
[Effect](https://effect.website). Each workspace package is a pi extension
shipped on npm under the `@ftrdotdev` scope.

## Packages

| Package | npm | What it does |
| ------- | --- | ------------ |
| [pi-tui](packages/tui/README.md) | [`@ftrdotdev/pi-tui`](https://www.npmjs.com/package/@ftrdotdev/pi-tui) | House TUI components (themed `BorderedBox`, the pure `box-frame` model) and the pi interface extension: header, footer, editor, `/settings`, preview, telemetry |
| [pi-tracker](packages/tracker/README.md) | [`@ftrdotdev/pi-tracker`](https://www.npmjs.com/package/@ftrdotdev/pi-tracker) | Session-persistent todolists: `tracker` tool, `/tracker` command, live widget above the editor |
| [pi-inquiry](packages/inquiry/README.md) | [`@ftrdotdev/pi-inquiry`](https://www.npmjs.com/package/@ftrdotdev/pi-inquiry) | Interactive `question` tool: option lists, tabbed forms, free-text answers |

## Install

Each package is a pi extension. Install it with pi:

```bash
pi install npm:@ftrdotdev/pi-tui
pi install npm:@ftrdotdev/pi-tracker
pi install npm:@ftrdotdev/pi-inquiry
```

To try one without installing it:

```bash
pi -e npm:@ftrdotdev/pi-inquiry
```

See each package README for usage.

## Development

```bash
bun install           # install workspaces
bun test              # run tests (in the package you're in)
bun lint              # oxlint, including the type-aware component-seam rule
bunx tsc --noEmit     # type check
```

The packages share a dev toolchain via the `catalogs` in the root
`package.json`: `effect`, `pi`, and `tooling`.

## Publishing

Packages are published with `bun publish` — npm cannot resolve the
`catalog:` and `workspace:` dependency refs this repo uses. The root scripts
publish in dependency order (pi-tui first):

```bash
bun run publish:packages        # tui -> tracker -> inquiry
bun run publish:tui             # or publish one  (tracker, inquiry)
```

`--ignore-scripts` is used because `bun publish` runs lifecycle scripts
without the workspace `.bin` on PATH; the `prepare` scripts only patch local
dev tooling and do not affect the tarball.

Packages declare `publishConfig.access: "public"` (scoped packages default
to restricted on npm) and carry the `pi-package` keyword for the
[pi package gallery](https://pi.dev/packages).

## License

[MIT](LICENSE) © 2025 Felix Nordén