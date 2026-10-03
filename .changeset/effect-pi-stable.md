---
"@ftrdotdev/pi-tui": patch
"@ftrdotdev/pi-tracker": patch
"@ftrdotdev/pi-inquiry": patch
"@ftrdotdev/pi-qrspi": patch
---

Move the Effect packages to the stable `4.0.0` release and the Pi packages to `1.0.0`.

- Bump `effect`, `@effect/platform-node`, `@effect/platform-node-shared`, and `@effect/vitest` to `4.0.0`, and `@effect/tsgo` to `0.47.2`.
- Bump `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, and `@earendil-works/pi-tui` to `1.0.0`.
- Follow the rc.118 module move: `effect/unstable/process` becomes `effect/process`.
- Follow the Pi 0.99.0 tool API: tool execution contexts are now `ExtensionToolContext`.
- `pi-inquiry` gains a `typecheck` script; its two latent type errors are fixed.
