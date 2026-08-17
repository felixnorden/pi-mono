import { assert, it } from "@effect/vitest";
import { Effect, PlatformError, Schema } from "effect";
import * as FileSystem from "effect/FileSystem";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  applyDefaults,
  ConfigParseError,
  ConfigWriteError,
  DEFAULT_CONFIG,
  encodeConfig,
  getConfigPath,
  TuiConfig,
  TuiConfigService,
  type TuiConfig as TuiConfigType,
} from "./config.ts";

const TEST_PATH = "/tmp/tui-test/tui.json";

interface MemFs {
  readonly fs: Partial<FileSystem.FileSystem>;
  readonly files: Map<string, string>;
  readonly dirs: Set<string>;
}

function makeMemFs(init: Record<string, string> = {}, dirs: ReadonlyArray<string> = []): MemFs {
  const files = new Map<string, string>(Object.entries(init));
  const dirSet = new Set<string>(dirs);

  const fs: Partial<FileSystem.FileSystem> = {
    exists: (path) => Effect.succeed(files.has(path) || dirSet.has(path)),
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
    writeFileString: (path, data) =>
      Effect.sync(() => {
        files.set(path, data);
      }),
    makeDirectory: (path, options) =>
      Effect.sync(() => {
        if (options?.recursive) {
          let current = path;
          while (current !== "/" && current !== ".") {
            dirSet.add(current);
            const idx = current.lastIndexOf("/");
            current = idx <= 0 ? "/" : current.slice(0, idx);
          }
          dirSet.add(current);
        } else {
          dirSet.add(path);
        }
      }),
  };

  return { fs, files, dirs: dirSet };
}

function runWithMem<A, E>(
  mem: MemFs,
  program: Effect.Effect<A, E, TuiConfigService>,
): Effect.Effect<A, E> {
  return program.pipe(Effect.provide(TuiConfigService.layerTest(TEST_PATH, mem.fs)));
}

it.effect("load creates defaults when the config file is missing", () =>
  Effect.gen(function* () {
    const mem = makeMemFs();
    const cfg = yield* runWithMem(
      mem,
      Effect.gen(function* () {
        const svc = yield* TuiConfigService;
        return yield* svc.load;
      }),
    );
    assert.deepStrictEqual(cfg, DEFAULT_CONFIG);
    assert.strictEqual(mem.files.has(TEST_PATH), true);
    assert.strictEqual(mem.files.get(TEST_PATH), encodeConfig(DEFAULT_CONFIG) + "\n");
  }),
);

it.effect("load twice returns the same defaults", () =>
  Effect.gen(function* () {
    const mem = makeMemFs();
    const program = Effect.gen(function* () {
      const svc = yield* TuiConfigService;
      const first = yield* svc.load;
      const second = yield* svc.load;
      return [first, second] as const;
    });
    const [first, second] = yield* runWithMem(mem, program);
    assert.deepStrictEqual(first, DEFAULT_CONFIG);
    assert.deepStrictEqual(second, DEFAULT_CONFIG);
    assert.strictEqual(mem.files.has(TEST_PATH), true);
  }),
);

it.effect("load applies a top-level partial override", () =>
  Effect.gen(function* () {
    const mem = makeMemFs({ [TEST_PATH]: JSON.stringify({ enabled: false }) });
    const cfg = yield* runWithMem(
      mem,
      Effect.gen(function* () {
        const svc = yield* TuiConfigService;
        return yield* svc.load;
      }),
    );
    assert.strictEqual(cfg.enabled, false);
    assert.strictEqual(cfg.settingsLanguage, DEFAULT_CONFIG.settingsLanguage);
    assert.deepStrictEqual(cfg.icons, DEFAULT_CONFIG.icons);
    assert.deepStrictEqual(cfg.footerSegments, DEFAULT_CONFIG.footerSegments);
    assert.deepStrictEqual(cfg.telemetry, DEFAULT_CONFIG.telemetry);
  }),
);

it.effect("load applies a nested partial override", () =>
  Effect.gen(function* () {
    const mem = makeMemFs({ [TEST_PATH]: JSON.stringify({ icons: { mode: "nerd" } }) });
    const cfg = yield* runWithMem(
      mem,
      Effect.gen(function* () {
        const svc = yield* TuiConfigService;
        return yield* svc.load;
      }),
    );
    assert.strictEqual(cfg.icons.mode, "nerd");
    assert.strictEqual(cfg.enabled, DEFAULT_CONFIG.enabled);
    assert.deepStrictEqual(cfg.footerSegments, DEFAULT_CONFIG.footerSegments);
  }),
);

it.effect("load applies a partial footer override", () =>
  Effect.gen(function* () {
    const mem = makeMemFs({
      [TEST_PATH]: JSON.stringify({ footerSegments: { cwd: false, gitCommit: true } }),
    });
    const cfg = yield* runWithMem(
      mem,
      Effect.gen(function* () {
        const svc = yield* TuiConfigService;
        return yield* svc.load;
      }),
    );
    assert.strictEqual(cfg.footerSegments.cwd, false);
    assert.strictEqual(cfg.footerSegments.gitCommit, true);
    assert.strictEqual(cfg.footerSegments.gitBranch, DEFAULT_CONFIG.footerSegments.gitBranch);
    assert.strictEqual(cfg.footerSegments.runtime, DEFAULT_CONFIG.footerSegments.runtime);
  }),
);

it.effect("load accepts an explicit valid settingsLanguage", () =>
  Effect.gen(function* () {
    const mem = makeMemFs({ [TEST_PATH]: JSON.stringify({ settingsLanguage: "en" }) });
    const cfg = yield* runWithMem(
      mem,
      Effect.gen(function* () {
        const svc = yield* TuiConfigService;
        return yield* svc.load;
      }),
    );
    assert.strictEqual(cfg.settingsLanguage, "en");
    assert.deepStrictEqual(cfg, DEFAULT_CONFIG);
  }),
);

it.effect("load fails with ConfigParseError for an invalid icon mode", () =>
  Effect.gen(function* () {
    const mem = makeMemFs({ [TEST_PATH]: JSON.stringify({ icons: { mode: "bogus" } }) });
    const tag = yield* runWithMem(
      mem,
      Effect.gen(function* () {
        const svc = yield* TuiConfigService;
        return yield* svc.load;
      }),
    ).pipe(
      Effect.match({
        onFailure: (err) => err._tag,
        onSuccess: () => "unexpected-success",
      }),
    );
    assert.strictEqual(tag, "ConfigParseError");
  }),
);

it.effect("load fails with ConfigParseError for invalid JSON", () =>
  Effect.gen(function* () {
    const mem = makeMemFs({ [TEST_PATH]: "not json{" });
    const tag = yield* runWithMem(
      mem,
      Effect.gen(function* () {
        const svc = yield* TuiConfigService;
        return yield* svc.load;
      }),
    ).pipe(
      Effect.match({
        onFailure: (err) => err._tag,
        onSuccess: () => "unexpected-success",
      }),
    );
    assert.strictEqual(tag, "ConfigParseError");
  }),
);

it.effect("load fails with ConfigParseError for a wrong-typed field", () =>
  Effect.gen(function* () {
    const mem = makeMemFs({ [TEST_PATH]: JSON.stringify({ enabled: "yes" }) });
    const tag = yield* runWithMem(
      mem,
      Effect.gen(function* () {
        const svc = yield* TuiConfigService;
        return yield* svc.load;
      }),
    ).pipe(
      Effect.match({
        onFailure: (err) => err._tag,
        onSuccess: () => "unexpected-success",
      }),
    );
    assert.strictEqual(tag, "ConfigParseError");
  }),
);

it.effect("load ignores unknown keys", () =>
  Effect.gen(function* () {
    const mem = makeMemFs({ [TEST_PATH]: JSON.stringify({ enabled: true, futureKey: 1 }) });
    const cfg = yield* runWithMem(
      mem,
      Effect.gen(function* () {
        const svc = yield* TuiConfigService;
        return yield* svc.load;
      }),
    );
    assert.deepStrictEqual(cfg, DEFAULT_CONFIG);
    assert.strictEqual("futureKey" in cfg, false);
  }),
);

it.effect("load fails with ConfigWriteError when creating the default file fails", () =>
  Effect.gen(function* () {
    const mem = makeMemFs();
    const failingMem: MemFs = {
      ...mem,
      fs: {
        ...mem.fs,
        writeFileString: () =>
          Effect.fail(
            PlatformError.systemError({
              _tag: "PermissionDenied",
              module: "FileSystem",
              method: "writeFileString",
              pathOrDescriptor: TEST_PATH,
              description: "cannot write",
            }),
          ),
      },
    };
    const tag = yield* runWithMem(
      failingMem,
      Effect.gen(function* () {
        const svc = yield* TuiConfigService;
        return yield* svc.load;
      }),
    ).pipe(
      Effect.match({
        onFailure: (err) => err._tag,
        onSuccess: () => "unexpected-success",
      }),
    );
    assert.strictEqual(tag, "ConfigWriteError");
  }),
);

it.effect("load fails with ConfigParseError for an unsupported settingsLanguage", () =>
  Effect.gen(function* () {
    const mem = makeMemFs({ [TEST_PATH]: JSON.stringify({ settingsLanguage: "zh" }) });
    const tag = yield* runWithMem(
      mem,
      Effect.gen(function* () {
        const svc = yield* TuiConfigService;
        return yield* svc.load;
      }),
    ).pipe(
      Effect.match({
        onFailure: (err) => err._tag,
        onSuccess: () => "unexpected-success",
      }),
    );
    assert.strictEqual(tag, "ConfigParseError");
  }),
);

it.effect("save writes the config and load reads it back", () =>
  Effect.gen(function* () {
    const mem = makeMemFs();
    const cfg = yield* runWithMem(
      mem,
      Effect.gen(function* () {
        const svc = yield* TuiConfigService;
        yield* svc.save(DEFAULT_CONFIG);
        return yield* svc.load;
      }),
    );
    assert.deepStrictEqual(cfg, DEFAULT_CONFIG);
    assert.strictEqual(mem.files.get(TEST_PATH), JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n");
  }),
);

it.effect("save creates missing directories recursively", () =>
  Effect.gen(function* () {
    const mem = makeMemFs();
    const deepPath = "/tmp/tui-test/deep/tui.json";
    const program = Effect.gen(function* () {
      const svc = yield* TuiConfigService;
      yield* svc.save(DEFAULT_CONFIG);
      return yield* svc.load;
    });
    const cfg = yield* program.pipe(Effect.provide(TuiConfigService.layerTest(deepPath, mem.fs)));
    assert.deepStrictEqual(cfg, DEFAULT_CONFIG);
    assert.strictEqual(mem.files.has(deepPath), true);
    assert.strictEqual(mem.dirs.has("/tmp/tui-test/deep"), true);
  }),
);

it.effect("save fails with ConfigWriteError when the filesystem rejects the write", () =>
  Effect.gen(function* () {
    const mem = makeMemFs();
    const failingMem: MemFs = {
      ...mem,
      fs: {
        ...mem.fs,
        writeFileString: () =>
          Effect.fail(
            PlatformError.systemError({
              _tag: "PermissionDenied",
              module: "FileSystem",
              method: "writeFileString",
              pathOrDescriptor: TEST_PATH,
              description: "cannot write",
            }),
          ),
      },
    };
    const tag = yield* runWithMem(
      failingMem,
      Effect.gen(function* () {
        const svc = yield* TuiConfigService;
        return yield* svc.save(DEFAULT_CONFIG);
      }),
    ).pipe(
      Effect.match({
        onFailure: (err) => err._tag,
        onSuccess: () => "unexpected-success",
      }),
    );
    assert.strictEqual(tag, "ConfigWriteError");
  }),
);

it.effect("loadOrDefault falls back to defaults and logs on failure", () =>
  Effect.gen(function* () {
    const mem = makeMemFs({ [TEST_PATH]: "not json{" });
    const cfg = yield* runWithMem(
      mem,
      Effect.gen(function* () {
        const svc = yield* TuiConfigService;
        return yield* svc.loadOrDefault;
      }),
    );
    assert.deepStrictEqual(cfg, DEFAULT_CONFIG);
  }),
);

it("getConfigPath returns tui.json inside the agent directory", () => {
  assert.strictEqual(getConfigPath(), join(getAgentDir(), "tui.json"));
});

it("DEFAULT_CONFIG decodes cleanly through the TuiConfig schema", () => {
  const decoded = Schema.decodeSync(TuiConfig)(DEFAULT_CONFIG);
  assert.deepStrictEqual({ ...decoded }, DEFAULT_CONFIG);
});

it("applyDefaults fills in every field from a partial file", () => {
  const partial = { footerSegments: { cwd: false } } as const;
  const cfg: TuiConfigType = applyDefaults(partial);
  assert.strictEqual(cfg.enabled, DEFAULT_CONFIG.enabled);
  assert.strictEqual(cfg.footerSegments.cwd, false);
  assert.strictEqual(cfg.footerSegments.gitBranch, DEFAULT_CONFIG.footerSegments.gitBranch);
});

it("ConfigParseError carries the expected tag", () => {
  const err = new ConfigParseError({ path: "x", message: "bad" });
  assert.strictEqual(err._tag, "ConfigParseError");
  assert.instanceOf(err, ConfigParseError);
});

it("ConfigWriteError carries the expected tag", () => {
  const err = new ConfigWriteError({ path: "x", message: "bad" });
  assert.strictEqual(err._tag, "ConfigWriteError");
  assert.instanceOf(err, ConfigWriteError);
});
