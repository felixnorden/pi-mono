---
"@ftrdotdev/pi-tui": patch
"@ftrdotdev/pi-tracker": patch
"@ftrdotdev/pi-inquiry": patch
---

Pin `@effect/platform-node-shared` and move the Effect packages to `4.0.0-rc.116`.

The 0.5.0 packages pinned `effect` and `@effect/platform-node` to `4.0.0-rc.108`. `@effect/platform-node` depends on `@effect/platform-node-shared` with a caret range. Every `4.0.0-rc.*` release shares the `4.0.0` base, so that range resolved to a newer `@effect/platform-node-shared` that imports `effect/ByteSize`. The pinned `effect` has no `ByteSize` module, so loading an extension failed with `Cannot find module '.../effect/dist/ByteSize.js'`.

- Move `effect`, `@effect/platform-node`, and `@effect/vitest` to `4.0.0-rc.116`.
- Add `@effect/platform-node-shared` to the `effect` catalog at an exact version, and depend on it directly from `pi-tui` and `pi-tracker`. This stops the transitive range from floating to a release that needs a newer `effect`.
