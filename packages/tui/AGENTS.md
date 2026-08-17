# Learning more about the Effect

This repository uses the Effect Typescript library.

Before writing any Effect code, first read `node_modules/effect/AGENTS.md`
**completely**, and follow the links in the file when required.

If you need to learn more about particular Effect apis and concepts that the
guide doesn't cover, search through the source code in `node_modules/effect/src`.

## Repository-specific notes

- The Effect version is pinned to `4.0.0-beta.105` (see `package.json`). Several
  APIs differ from stable Effect 3.x — verify against the installed package
  source before relying on prior Effect knowledge (e.g. there is no
  `Effect.trySync`, `Effect.catchAll`, `Schema.parseJson`, `Schema.optionalWith`,
  or decode-time schema defaults in this beta).
- `PLAN.md` documents the planned Effect rewrite of `src/config.ts` (Schema-first
  domain model, `TuiConfigService` with a `FileSystem` layer, tagged errors,
  `@effect/vitest` tests) and the beta-specific API facts verified during
  planning. Follow it when working on that module.

## Component seam rule

Components that cross the pi seam (`setWidget`, `ui.custom`, `setFooter`,
`setHeader`, `setEditorComponent`, entry renderers) must be plain objects
built from closures — use the factories in this package (`makeBorderedBox`,
`makeSettingsUi`, `defineComponent`) or equivalent `makeX` factories. Never
hand pi a class-method reference (`{ render: widget.render }`): pi-tui
invokes `render`/`invalidate` as methods of the wrapper object it was given,
so an unbound method loses `this` and crashes. Closure components carry no
`this`, so they survive any hand-off by construction. This is enforced by
the `typescript/unbound-method` lint rule (`oxlint --type-aware`).

## Bordered view rule

Every bordered view in this package must draw its frame through
`makeBorderedBox` (themed components) or `buildBoxFrame` (pi-free cores) —
the header, editor, preview, settings dialog, and autocomplete box all do.
Never hand-assemble box glyphs (`╭ ╮ │ ╰ ╯ ─`) or re-derive the
`─── label ─────` label geometry: the frame model in `src/box-frame.ts` is
the single source of truth for box layout. If a view needs a different
label tail (e.g. the editor's scroll hint), extend the model with an option
rather than hard-coding a parallel layout.
