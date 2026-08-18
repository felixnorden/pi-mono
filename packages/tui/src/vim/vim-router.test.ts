import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import { VimRouter } from "./vim-router.ts";

it.effect("emits a down intent for j when vim is on", () =>
  Effect.gen(function* () {
    const router = yield* VimRouter;
    assert.deepStrictEqual(router.decodeNavigation("j"), { kind: "move", dir: "down" });
  }).pipe(Effect.provide(VimRouter.layerTest(() => true))),
);

it.effect("emits an up intent for k when vim is on", () =>
  Effect.gen(function* () {
    const router = yield* VimRouter;
    assert.deepStrictEqual(router.decodeNavigation("k"), { kind: "move", dir: "up" });
  }).pipe(Effect.provide(VimRouter.layerTest(() => true))),
);

it.effect("emits a left intent for h when vim is on", () =>
  Effect.gen(function* () {
    const router = yield* VimRouter;
    assert.deepStrictEqual(router.decodeNavigation("h"), { kind: "move", dir: "left" });
  }).pipe(Effect.provide(VimRouter.layerTest(() => true))),
);

it.effect("emits a right intent for l when vim is on", () =>
  Effect.gen(function* () {
    const router = yield* VimRouter;
    assert.deepStrictEqual(router.decodeNavigation("l"), { kind: "move", dir: "right" });
  }).pipe(Effect.provide(VimRouter.layerTest(() => true))),
);

it.effect("is inert and returns no intent for vim keys when vim is off", () =>
  Effect.gen(function* () {
    const router = yield* VimRouter;
    for (const key of ["j", "k", "h", "l"]) {
      assert.strictEqual(router.decodeNavigation(key), undefined);
    }
  }).pipe(Effect.provide(VimRouter.layerTest(() => false))),
);

it.effect("passes through non-vim input unchanged", () =>
  Effect.gen(function* () {
    const router = yield* VimRouter;
    const inputs = ["\x1b[B", "\x1b[A", "\t", "\x1b", "\x1b[Z", " ", "\r"];
    for (const data of inputs) {
      assert.strictEqual(router.decodeNavigation(data), undefined);
    }
  }).pipe(Effect.provide(VimRouter.layerTest(() => true))),
);
