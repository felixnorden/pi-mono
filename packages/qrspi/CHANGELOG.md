# @ftrdotdev/pi-qrspi

## 0.2.3

### Patch Changes

- a860f5b: Move the Effect packages to the stable `4.0.0` release and the Pi packages to `1.0.0`.

  - Bump `effect`, `@effect/platform-node`, `@effect/platform-node-shared`, and `@effect/vitest` to `4.0.0`, and `@effect/tsgo` to `0.47.2`.
  - Bump `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, and `@earendil-works/pi-tui` to `1.0.0`.
  - Follow the rc.118 module move: `effect/unstable/process` becomes `effect/process`.
  - Follow the Pi 0.99.0 tool API: tool execution contexts are now `ExtensionToolContext`.
  - `pi-inquiry` gains a `typecheck` script; its two latent type errors are fixed.

## 0.2.2

### Patch Changes

- Add the `pi-package` keyword and related npm keywords to `package.json`.

  The keywords landed after the 0.2.1 publish, so the registry copy has no
  `keywords` field. Keyword-based discovery, including the `pi-package`
  convention, cannot find the package at 0.2.1.

## 0.2.1

### Patch Changes

- Update underlying skills to tag 0.1.2

## 0.2.0

### Minor Changes

- fe0ac01: Solidify initial tooling, visuals, and configurability between packages
