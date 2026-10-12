import { assert, it } from "@effect/vitest";
import { Effect, PlatformError } from "effect";
import * as FileSystem from "effect/FileSystem";
import { readVimEnabled, VimSettingsService } from "./vim-settings.ts";

const TEST_PATH = "/tmp/tracker-vim-test/tui.json";

interface MemFs {
  readonly fs: Partial<FileSystem.FileSystem>;
  readonly files: Map<string, string>;
}

function makeMemFs(init: Record<string, string> = {}): MemFs {
  const files = new Map<string, string>(Object.entries(init));
  const fs: Partial<FileSystem.FileSystem> = {
    readFileString: (path) =>
      files.has(path)
        ? Effect.succeed(files.get(path)!)
        : Effect.fail(
            PlatformError.systemError({
              _tag: "NotFound",
              module: "FileSystem",
              method: "readFileString",
              pathOrDescriptor: path,
              description: "No such file",
            }),
          ),
  };
  return { fs, files };
}

const load = (): Effect.Effect<boolean, never, VimSettingsService> =>
  Effect.gen(function* () {
    const service = yield* VimSettingsService;
    return yield* service.load;
  });

const runWithMem = (
  mem: MemFs,
  program: Effect.Effect<boolean, never, VimSettingsService>,
): Effect.Effect<boolean, never> =>
  program.pipe(Effect.provide(VimSettingsService.layerTest(TEST_PATH, mem.fs)));

it.effect("load returns off when the file is missing", () =>
  Effect.gen(function* () {
    const enabled = yield* runWithMem(makeMemFs(), load());
    assert.strictEqual(enabled, false);
  }),
);

it.effect("load returns on when the file stores vim true", () =>
  Effect.gen(function* () {
    const mem = makeMemFs({ [TEST_PATH]: JSON.stringify({ vim: true }) });
    const enabled = yield* runWithMem(mem, load());
    assert.strictEqual(enabled, true);
  }),
);

it.effect("load returns off when the file stores vim false", () =>
  Effect.gen(function* () {
    const mem = makeMemFs({ [TEST_PATH]: JSON.stringify({ vim: false }) });
    const enabled = yield* runWithMem(mem, load());
    assert.strictEqual(enabled, false);
  }),
);

it.effect("load returns off when vim is not a boolean", () =>
  Effect.gen(function* () {
    const mem = makeMemFs({ [TEST_PATH]: JSON.stringify({ vim: "yes" }) });
    const enabled = yield* runWithMem(mem, load());
    assert.strictEqual(enabled, false);
  }),
);

it.effect("load returns off when the file is not valid JSON", () =>
  Effect.gen(function* () {
    const mem = makeMemFs({ [TEST_PATH]: "not json{" });
    const enabled = yield* runWithMem(mem, load());
    assert.strictEqual(enabled, false);
  }),
);

it.effect("load returns off when the file is not an object", () =>
  Effect.gen(function* () {
    const mem = makeMemFs({ [TEST_PATH]: JSON.stringify([true]) });
    const enabled = yield* runWithMem(mem, load());
    assert.strictEqual(enabled, false);
  }),
);

it("readVimEnabled reads only a boolean vim key", () => {
  assert.strictEqual(readVimEnabled({ vim: true }), true);
  assert.strictEqual(readVimEnabled({ vim: false }), false);
  assert.strictEqual(readVimEnabled({ vim: 1 }), false);
  assert.strictEqual(readVimEnabled({}), false);
  assert.strictEqual(readVimEnabled(null), false);
  assert.strictEqual(readVimEnabled("vim"), false);
});
