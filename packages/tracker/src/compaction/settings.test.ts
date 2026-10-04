import { assert, it } from "@effect/vitest";
import { Effect, Option, PlatformError } from "effect";
import * as FileSystem from "effect/FileSystem";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import { fileURLToPath } from "node:url";
import {
  CLASSIFIER_KEY,
  DEFAULT_MAX_CANDIDATES,
  ENABLED_KEY,
  KEEP_CONTEXT_MIN_CONFIDENCE_KEY,
  KEEP_CONTEXT_THRESHOLD_KEY,
  MAX_CANDIDATES_KEY,
  SMART_COMPACTION_KEY,
  SmartCompactionSettingsService,
  parseClassifierIdentity,
  type SmartCompactionSettings,
} from "./settings.ts";
import { DEFAULT_KEEP_CONTEXT_MIN_CONFIDENCE, DEFAULT_KEEP_CONTEXT_THRESHOLD } from "./classifier.ts";

const TEST_PATH = "/tmp/tracker-settings-test/tui.json";
const FIXTURE_PATH = fileURLToPath(
  new URL("../../test-fixtures/tui-config.contract.json", import.meta.url),
);

/** Read the shared contract fixture through the FileSystem service. */
const readFixture: Effect.Effect<string, PlatformError.PlatformError> = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.readFileString(FIXTURE_PATH);
}).pipe(Effect.provide(NodeFileSystem.layer));

interface MemFs {
  readonly fs: Partial<FileSystem.FileSystem>;
  readonly files: Map<string, string>;
  readonly writes: string[];
}

function makeMemFs(init: Record<string, string> = {}): MemFs {
  const files = new Map<string, string>(Object.entries(init));
  const writes: string[] = [];

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
    writeFileString: (path, data) =>
      Effect.sync(() => {
        writes.push(path);
        files.set(path, data);
      }),
  };

  return { fs, files, writes };
}

const load = (): Effect.Effect<
  SmartCompactionSettings,
  never,
  SmartCompactionSettingsService
> =>
  Effect.gen(function* () {
    const service = yield* SmartCompactionSettingsService;
    return yield* service.load;
  });

const runWithMem = <A, E>(
  mem: MemFs,
  program: Effect.Effect<A, E, SmartCompactionSettingsService>,
): Effect.Effect<A, E> =>
  program.pipe(Effect.provide(SmartCompactionSettingsService.layerTest(TEST_PATH, mem.fs)));

it.effect("load returns the fail-open defaults when the file is missing", () =>
  Effect.gen(function* () {
    const mem = makeMemFs();
    const settings = yield* runWithMem(mem, load());
    assert.strictEqual(settings.enabled, true);
    assert.strictEqual(Option.isNone(settings.chosen), true);
    assert.strictEqual(settings.keepContextThreshold, DEFAULT_KEEP_CONTEXT_THRESHOLD);
  }),
);

it.effect("load returns the fail-open defaults when the file is not JSON", () =>
  Effect.gen(function* () {
    const mem = makeMemFs({ [TEST_PATH]: "not json" });
    const settings = yield* runWithMem(mem, load());
    assert.strictEqual(settings.enabled, true);
    assert.strictEqual(Option.isNone(settings.chosen), true);
    assert.strictEqual(settings.keepContextThreshold, DEFAULT_KEEP_CONTEXT_THRESHOLD);
  }),
);

it.effect("load returns the fail-open defaults when the section has the wrong shape", () =>
  Effect.gen(function* () {
    const mem = makeMemFs({ [TEST_PATH]: JSON.stringify({ smartCompaction: "on" }) });
    const settings = yield* runWithMem(mem, load());
    assert.strictEqual(settings.enabled, true);
    assert.strictEqual(Option.isNone(settings.chosen), true);
    assert.strictEqual(settings.keepContextThreshold, DEFAULT_KEEP_CONTEXT_THRESHOLD);
  }),
);

it.effect("load ignores an unrecognized enabled value and keeps a valid chosen classifier", () =>
  Effect.gen(function* () {
    const mem = makeMemFs({
      [TEST_PATH]: JSON.stringify({
        smartCompaction: { enabled: "yes", classifier: "typesafe/jev-latest" },
      }),
    });
    const settings = yield* runWithMem(mem, load());
    assert.strictEqual(settings.enabled, true);
    assert.deepStrictEqual(Option.getOrThrow(settings.chosen), {
      provider: "typesafe",
      modelId: "jev-latest",
    });
    assert.strictEqual(settings.keepContextThreshold, DEFAULT_KEEP_CONTEXT_THRESHOLD);
  }),
);

it.effect("load reads a valid keep-context threshold from the section", () =>
  Effect.gen(function* () {
    const mem = makeMemFs({
      [TEST_PATH]: JSON.stringify({ smartCompaction: { keepContextThreshold: 0.72 } }),
    });
    const settings = yield* runWithMem(mem, load());
    assert.strictEqual(settings.keepContextThreshold, 0.72);
  }),
);

it.effect("load falls back alone when a threshold is outside the open unit interval", () =>
  Effect.gen(function* () {
    for (const invalid of [0, 1, -0.1, 1.5, "0.5"]) {
      const mem = makeMemFs({
        [TEST_PATH]: JSON.stringify({
          smartCompaction: { enabled: false, keepContextThreshold: invalid },
        }),
      });
      const settings = yield* runWithMem(mem, load());
      assert.strictEqual(settings.keepContextThreshold, DEFAULT_KEEP_CONTEXT_THRESHOLD);
      // The bad value must not discard the rest of the section.
      assert.strictEqual(settings.enabled, false);
    }
  }),
);

it.effect("load reads a valid keep-context min confidence from the section", () =>
  Effect.gen(function* () {
    const mem = makeMemFs({
      [TEST_PATH]: JSON.stringify({ smartCompaction: { keepContextMinConfidence: 0.72 } }),
    });
    const settings = yield* runWithMem(mem, load());
    assert.strictEqual(settings.keepContextMinConfidence, 0.72);
  }),
);

it.effect("load falls back alone when the min confidence is outside the open unit interval", () =>
  Effect.gen(function* () {
    for (const invalid of [0, 1, -0.1, 1.5, "0.5"]) {
      const mem = makeMemFs({
        [TEST_PATH]: JSON.stringify({
          smartCompaction: { enabled: false, keepContextMinConfidence: invalid },
        }),
      });
      const settings = yield* runWithMem(mem, load());
      assert.strictEqual(settings.keepContextMinConfidence, DEFAULT_KEEP_CONTEXT_MIN_CONFIDENCE);
      // The bad value must not discard the rest of the section.
      assert.strictEqual(settings.enabled, false);
    }
  }),
);

it.effect("load reads a valid max-candidates cap from the section", () =>
  Effect.gen(function* () {
    const mem = makeMemFs({
      [TEST_PATH]: JSON.stringify({ smartCompaction: { maxCandidates: 3 } }),
    });
    const settings = yield* runWithMem(mem, load());
    assert.strictEqual(settings.maxCandidates, 3);
  }),
);

it.effect("load falls back alone when the cap is not an integer in range", () =>
  Effect.gen(function* () {
    for (const invalid of [0, 21, 5.5, "8", null]) {
      const mem = makeMemFs({
        [TEST_PATH]: JSON.stringify({
          smartCompaction: { enabled: false, maxCandidates: invalid },
        }),
      });
      const settings = yield* runWithMem(mem, load());
      assert.strictEqual(settings.maxCandidates, DEFAULT_MAX_CANDIDATES);
      assert.strictEqual(settings.enabled, false);
    }
  }),
);

it.effect("load resolves every value from the shared contract fixture", () =>
  Effect.gen(function* () {
    const mem = makeMemFs({ [TEST_PATH]: yield* readFixture });
    const settings = yield* runWithMem(mem, load());
    assert.strictEqual(settings.enabled, true);
    assert.deepStrictEqual(Option.getOrThrow(settings.chosen), {
      provider: "typesafe",
      modelId: "jev-latest",
    });
    assert.strictEqual(settings.keepContextThreshold, 0.5);
    assert.strictEqual(settings.keepContextMinConfidence, 0.5);
    assert.strictEqual(settings.maxCandidates, 8);
  }),
);

it.effect("load reads the enabled, classifier, and threshold keys the contract names", () =>
  Effect.gen(function* () {
    const parsed = JSON.parse(yield* readFixture) as {
      smartCompaction: Record<string, unknown>;
    };
    assert.strictEqual(SMART_COMPACTION_KEY in parsed, true);
    assert.strictEqual(ENABLED_KEY in parsed.smartCompaction, true);
    assert.strictEqual(CLASSIFIER_KEY in parsed.smartCompaction, true);
    assert.strictEqual(KEEP_CONTEXT_THRESHOLD_KEY in parsed.smartCompaction, true);
    assert.strictEqual(KEEP_CONTEXT_MIN_CONFIDENCE_KEY in parsed.smartCompaction, true);
    assert.strictEqual(MAX_CANDIDATES_KEY in parsed.smartCompaction, true);
    assert.strictEqual(parsed.smartCompaction[ENABLED_KEY], true);
    assert.strictEqual(parsed.smartCompaction[CLASSIFIER_KEY], "typesafe/jev-latest");
    assert.strictEqual(parsed.smartCompaction[KEEP_CONTEXT_THRESHOLD_KEY], 0.5);
    assert.strictEqual(parsed.smartCompaction[KEEP_CONTEXT_MIN_CONFIDENCE_KEY], 0.5);
    assert.strictEqual(parsed.smartCompaction[MAX_CANDIDATES_KEY], 8);
  }),
);

it("parseClassifierIdentity splits provider and model id at the first slash", () => {
  const identity = parseClassifierIdentity("cloudflare-workers-ai/@cf/cloudflare/clef-flash");
  assert.deepStrictEqual(Option.getOrThrow(identity), {
    provider: "cloudflare-workers-ai",
    modelId: "@cf/cloudflare/clef-flash",
  });
});

it("parseClassifierIdentity rejects a value with no provider or no model id", () => {
  assert.strictEqual(Option.isNone(parseClassifierIdentity("jev-latest")), true);
  assert.strictEqual(Option.isNone(parseClassifierIdentity("typesafe/")), true);
});

it.effect("load never writes to the config file", () =>
  Effect.gen(function* () {
    const mem = makeMemFs({ [TEST_PATH]: yield* readFixture });
    const before = mem.files.get(TEST_PATH);
    yield* runWithMem(mem, load());
    assert.deepStrictEqual(mem.writes, []);
    assert.strictEqual(mem.files.get(TEST_PATH), before);
  }),
);
