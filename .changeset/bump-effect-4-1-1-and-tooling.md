---
"@ftrdotdev/pi-tui": patch
"@ftrdotdev/pi-tracker": patch
"@ftrdotdev/pi-inquiry": patch
"@ftrdotdev/pi-qrspi": patch
---

Bump the Effect packages to `4.1.1`, `@effect/tsgo` to `0.63.0`, `vitest` to
`5.0.5`, and the Pi packages to `1.4.0`.

- `effect`, `@effect/platform-node`, `@effect/platform-node-shared`, and
  `@effect/vitest` move from `4.0.0` to `4.1.1`; `@effect/tsgo` moves from
  `0.47.2` to `0.63.0`.
- `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, and
  `@earendil-works/pi-tui` move from `1.1.0` to `1.4.0`. No extension API
  changes were needed.
- `vitest` moves from the 4.1 line to `5.0.5`, the range that
  `@effect/vitest` declares as its peer. `oxlint` moves to `1.90.0` and
  `oxlint-tsgolint` to `7.0.2005`, the pair that `@effect/tsgo` 0.63.0 supports.
- Effect 4.1.1 marks `effect/FileSystem`, `effect/Path`, `effect/PlatformError`,
  `effect/Graph`, `@effect/platform-node*`, and `@effect/vitest` as unstable.
  Each package `tsconfig.json` now lists them in the language-service plugin
  option `allowedUnstableApis`, so typecheck stays green without per-file
  `@effect-diagnostics` directives.
- The internal `TuiConfig` schema in `pi-tui` is now a `Schema.Struct` with a type
  alias instead of a `Schema.Class`. The class was only ever used as plain data,
  and the 4.1.1 `schemaClassObjectLiteral` rule flagged every literal and spread.
  `TuiConfig` is not part of the package exports, so no consumer code changes.
