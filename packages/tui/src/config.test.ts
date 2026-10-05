import { assert, it } from "@effect/vitest";
import { Effect, PlatformError, Schema } from "effect";
import * as FileSystem from "effect/FileSystem";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  adjustSmartCompactionProbability,
  adjustMaxCandidates,
  applyDefaults,
  ConfigParseError,
  ConfigWriteError,
  DEFAULT_CONFIG,
  decodeConfig,
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

it.effect("load returns vim on when the file stores it", () =>
  Effect.gen(function* () {
    const mem = makeMemFs({ [TEST_PATH]: JSON.stringify({ vim: true }) });
    const cfg = yield* runWithMem(
      mem,
      Effect.gen(function* () {
        const svc = yield* TuiConfigService;
        return yield* svc.load;
      }),
    );
    assert.strictEqual(cfg.vim, true);
    assert.strictEqual(cfg.enabled, DEFAULT_CONFIG.enabled);
    assert.strictEqual(cfg.settingsLanguage, DEFAULT_CONFIG.settingsLanguage);
    assert.deepStrictEqual(cfg.icons, DEFAULT_CONFIG.icons);
    assert.deepStrictEqual(cfg.footerSegments, DEFAULT_CONFIG.footerSegments);
    assert.deepStrictEqual(cfg.telemetry, DEFAULT_CONFIG.telemetry);
  }),
);

it.effect("load defaults vim to off when the file omits it", () =>
  Effect.gen(function* () {
    const mem = makeMemFs({ [TEST_PATH]: JSON.stringify({ enabled: true }) });
    const cfg = yield* runWithMem(
      mem,
      Effect.gen(function* () {
        const svc = yield* TuiConfigService;
        return yield* svc.load;
      }),
    );
    assert.strictEqual(cfg.vim, false);
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

it.effect("save round-trips the vim field", () =>
  Effect.gen(function* () {
    const mem = makeMemFs();
    const cfg = yield* runWithMem(
      mem,
      Effect.gen(function* () {
        const svc = yield* TuiConfigService;
        yield* svc.save({ ...DEFAULT_CONFIG, vim: true });
        return yield* svc.load;
      }),
    );
    assert.strictEqual(cfg.vim, true);
    const encoded = mem.files.get(TEST_PATH)!;
    assert.strictEqual(encoded.includes('"vim": true'), true);
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

it("default config is vim-off", () => {
  assert.strictEqual(DEFAULT_CONFIG.vim, false);
});

it("applyDefaults defaults vim to off from a partial file", () => {
  const partial = { footerSegments: { cwd: false } } as const;
  const cfg: TuiConfigType = applyDefaults(partial);
  assert.strictEqual(cfg.vim, false);
  assert.strictEqual(cfg.enabled, DEFAULT_CONFIG.enabled);
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

// ---------------------------------------------------------------------------
// Smart compaction: shared with the tracker reader
// ---------------------------------------------------------------------------

const CONTRACT_FIXTURE = new URL(
  "../../tracker/test-fixtures/tui-config.contract.json",
  import.meta.url,
);

it.effect("the shared contract fixture decodes into the smart-compaction section", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const raw = yield* fs.readFileString(fileURLToPath(CONTRACT_FIXTURE));
    const config = applyDefaults(decodeConfig(raw));
    assert.strictEqual(config.smartCompaction.enabled, true);
    assert.strictEqual(config.smartCompaction.classifier, "typesafe/jev-latest");
    assert.strictEqual(config.smartCompaction.needsContextProbabilityThreshold, 0.5);
    assert.strictEqual(config.smartCompaction.minAnswerConfidence, 0.5);
    assert.strictEqual(config.smartCompaction.maxCandidates, 8);
  }).pipe(Effect.provide(NodeFileSystem.layer)),
);

it("a config file without the smart-compaction section applies the smart-compaction defaults", () => {
  const config = applyDefaults({ enabled: false });
  assert.deepStrictEqual(config.smartCompaction, {
    enabled: true,
    classifier: null,
    needsContextProbabilityThreshold: 0.5,
    minAnswerConfidence: 0.5,
    maxCandidates: 8,
  });
});

it("an encoded default config carries all smart-compaction keys", () => {
  const encoded = JSON.parse(encodeConfig(DEFAULT_CONFIG)) as {
    smartCompaction: unknown;
  };
  assert.deepStrictEqual(encoded.smartCompaction, {
    enabled: true,
    classifier: null,
    needsContextProbabilityThreshold: 0.5,
    minAnswerConfidence: 0.5,
    maxCandidates: 8,
  });
});

it("an encoded default config omits the legacy probability aliases", () => {
  const encoded = JSON.parse(encodeConfig(DEFAULT_CONFIG)) as {
    smartCompaction: Record<string, unknown>;
  };
  assert.strictEqual("keepContextThreshold" in encoded.smartCompaction, false);
  assert.strictEqual("keepContextMinConfidence" in encoded.smartCompaction, false);
});

it("a config file keeps a valid needs-context probability threshold", () => {
  const config = applyDefaults({ smartCompaction: { needsContextProbabilityThreshold: 0.72 } });
  assert.strictEqual(config.smartCompaction.needsContextProbabilityThreshold, 0.72);
});

it("an out-of-range needs-context probability threshold falls back to the default", () => {
  for (const invalid of [0, 1, -0.1, 1.5]) {
    const config = applyDefaults({
      smartCompaction: { needsContextProbabilityThreshold: invalid },
    });
    assert.strictEqual(config.smartCompaction.needsContextProbabilityThreshold, 0.5);
  }
});

it("a config file keeps a valid min answer confidence", () => {
  const config = applyDefaults({ smartCompaction: { minAnswerConfidence: 0.72 } });
  assert.strictEqual(config.smartCompaction.minAnswerConfidence, 0.72);
});

it("an out-of-range min answer confidence falls back to the default", () => {
  for (const invalid of [0, 1, -0.1, 1.5]) {
    const config = applyDefaults({ smartCompaction: { minAnswerConfidence: invalid } });
    assert.strictEqual(config.smartCompaction.minAnswerConfidence, 0.5);
  }
});

it("a config file with only the legacy probability keys decodes and resolves", () => {
  const config = applyDefaults(
    decodeConfig(
      JSON.stringify({
        smartCompaction: { keepContextThreshold: 0.72, keepContextMinConfidence: 0.31 },
      }),
    ),
  );
  assert.strictEqual(config.smartCompaction.needsContextProbabilityThreshold, 0.72);
  assert.strictEqual(config.smartCompaction.minAnswerConfidence, 0.31);
});

it("the current probability keys win over their legacy aliases", () => {
  const config = applyDefaults({
    smartCompaction: {
      needsContextProbabilityThreshold: 0.72,
      keepContextThreshold: 0.31,
      minAnswerConfidence: 0.41,
      keepContextMinConfidence: 0.21,
    },
  });
  assert.strictEqual(config.smartCompaction.needsContextProbabilityThreshold, 0.72);
  assert.strictEqual(config.smartCompaction.minAnswerConfidence, 0.41);
});

it("adjustSmartCompactionProbability steps by 0.05 and clamps inside the open interval", () => {
  assert.strictEqual(adjustSmartCompactionProbability(0.5, 0.05), 0.55);
  assert.strictEqual(adjustSmartCompactionProbability(0.5, -0.05), 0.45);
  assert.strictEqual(adjustSmartCompactionProbability(0.95, 0.05), 0.95);
  assert.strictEqual(adjustSmartCompactionProbability(0.05, -0.05), 0.05);
});

it("a config file keeps a valid max-candidates cap", () => {
  const config = applyDefaults({ smartCompaction: { maxCandidates: 3 } });
  assert.strictEqual(config.smartCompaction.maxCandidates, 3);
});

it("a cap that is not an integer in range falls back to the default", () => {
  for (const invalid of [0, 21, 5.5, -1]) {
    const config = applyDefaults({ smartCompaction: { maxCandidates: invalid } });
    assert.strictEqual(config.smartCompaction.maxCandidates, 8);
  }
});

it("adjustMaxCandidates steps by one and clamps to the bounds", () => {
  assert.strictEqual(adjustMaxCandidates(8, 1), 9);
  assert.strictEqual(adjustMaxCandidates(8, -1), 7);
  assert.strictEqual(adjustMaxCandidates(20, 1), 20);
  assert.strictEqual(adjustMaxCandidates(1, -1), 1);
});

it.effect("save keeps a chosen classifier through a load round trip", () =>
  Effect.gen(function* () {
    const mem = makeMemFs();
    const config = yield* runWithMem(
      mem,
      Effect.gen(function* () {
        const svc = yield* TuiConfigService;
        yield* svc.save({
          ...DEFAULT_CONFIG,
          smartCompaction: {
            enabled: false,
            classifier: "typesafe/jev-latest",
            needsContextProbabilityThreshold: 0.8,
            minAnswerConfidence: 0.8,
            maxCandidates: 3,
          },
        });
        return yield* svc.load;
      }),
    );
    assert.deepStrictEqual(config.smartCompaction, {
      enabled: false,
      classifier: "typesafe/jev-latest",
      needsContextProbabilityThreshold: 0.8,
      minAnswerConfidence: 0.8,
      maxCandidates: 3,
    });
  }),
);
