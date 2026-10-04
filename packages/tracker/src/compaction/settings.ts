import { Context, Effect, Layer, Option, Predicate, Schema } from "effect";
import * as FileSystem from "effect/FileSystem";
import {
  DEFAULT_KEEP_CONTEXT_MIN_CONFIDENCE,
  DEFAULT_KEEP_CONTEXT_THRESHOLD,
  type ClassifierIdentity,
} from "./classifier.ts";

/**
 * The tracker's reader of the shared TUI settings file. It owns the
 * interpretation of the three keys that smart compaction uses, and it fails open
 * on every read, parse, or shape problem: the feature is active by default, the
 * classifier preference order applies when no identity is chosen, and the
 * default threshold applies when the value is missing or invalid.
 *
 * Co-owned with `packages/tui/src/config.ts`; the key names and value shapes
 * are pinned by `test-fixtures/tui-config.contract.json`, read by both suites.
 */
export const SMART_COMPACTION_CONFIG_FILE = "tui.json";
export const SMART_COMPACTION_KEY = "smartCompaction";
export const ENABLED_KEY = "enabled";
export const CLASSIFIER_KEY = "classifier";
export const KEEP_CONTEXT_THRESHOLD_KEY = "keepContextThreshold";
export const KEEP_CONTEXT_MIN_CONFIDENCE_KEY = "keepContextMinConfidence";
export const MAX_CANDIDATES_KEY = "maxCandidates";

/** Default number of ready items one classification judges. */
export const DEFAULT_MAX_CANDIDATES = 8;
/** Upper bound for the configured cap; a larger value falls back to the default. */
export const MAX_CANDIDATES_LIMIT = 20;

const FileSchema = Schema.fromJsonString(Schema.Unknown);
const EnabledSchema = Schema.Boolean;
const ClassifierSchema = Schema.NullOr(Schema.String);
const KeepContextThresholdSchema = Schema.Finite;
const KeepContextMinConfidenceSchema = Schema.Finite;
const MaxCandidatesSchema = Schema.Int;

export interface SmartCompactionSettings {
  readonly enabled: boolean;
  readonly chosen: Option.Option<ClassifierIdentity>;
  readonly keepContextThreshold: number;
  readonly keepContextMinConfidence: number;
  readonly maxCandidates: number;
}

export const defaultSmartCompactionSettings = (): SmartCompactionSettings => ({
  enabled: true,
  chosen: Option.none(),
  keepContextThreshold: DEFAULT_KEEP_CONTEXT_THRESHOLD,
  keepContextMinConfidence: DEFAULT_KEEP_CONTEXT_MIN_CONFIDENCE,
  maxCandidates: DEFAULT_MAX_CANDIDATES,
});

/**
 * Split a `"provider/modelId"` value at the first slash, so a model id that
 * itself contains slashes — the Cloudflare id `@cf/cloudflare/clef-flash` —
 * stays whole. A value without both parts is not an identity.
 */
export const parseClassifierIdentity = (value: string): Option.Option<ClassifierIdentity> => {
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) return Option.none();
  return Option.some({ provider: value.slice(0, slash), modelId: value.slice(slash + 1) });
};

/** The `smartCompaction` object, when the parsed file has one of that shape. */
const smartSection = (parsed: unknown): Record<string, unknown> | undefined => {
  if (!Predicate.isObject(parsed)) return undefined;
  if (!Predicate.hasProperty(SMART_COMPACTION_KEY)(parsed)) return undefined;
  const section = parsed[SMART_COMPACTION_KEY];
  return Predicate.isObject(section) ? section : undefined;
};

export class SmartCompactionSettingsService extends Context.Service<
  SmartCompactionSettingsService,
  {
    readonly path: string;
    /** Never fails: every read, parse, or shape problem yields the defaults. */
    readonly load: Effect.Effect<SmartCompactionSettings>;
  }
>()("tracker/SmartCompactionSettings") {
  static make(
    path: string,
  ): Layer.Layer<SmartCompactionSettingsService, never, FileSystem.FileSystem> {
    return Layer.effect(
      SmartCompactionSettingsService,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const load = Effect.gen(function* () {
          const raw = yield* fs.readFileString(path);
          // `Schema.Unknown` accepts any JSON value; the guards below narrow it.
          const parsed = yield* Schema.decodeEffect(FileSchema)(raw);
          const section = smartSection(parsed);
          // Each key decodes independently, so an unrecognized value falls back
          // alone instead of discarding the rest of the section.
          const enabled = Option.getOrElse(
            Schema.decodeUnknownOption(EnabledSchema)(
              section === undefined ? undefined : section[ENABLED_KEY],
            ),
            () => true,
          );
          const chosen = Option.flatMap(
            Schema.decodeUnknownOption(ClassifierSchema)(
              section === undefined ? undefined : section[CLASSIFIER_KEY],
            ),
            (value) => (value === null ? Option.none() : parseClassifierIdentity(value)),
          );
          // A threshold must stay strictly inside (0, 1); anything else falls
          // back alone, so a bad value cannot disable the whole feature.
          const keepContextThreshold = Option.getOrElse(
            Option.filter(
              Schema.decodeUnknownOption(KeepContextThresholdSchema)(
                section === undefined ? undefined : section[KEEP_CONTEXT_THRESHOLD_KEY],
              ),
              (value) => value > 0 && value < 1,
            ),
            () => DEFAULT_KEEP_CONTEXT_THRESHOLD,
          );
          const keepContextMinConfidence = Option.getOrElse(
            Option.filter(
              Schema.decodeUnknownOption(KeepContextMinConfidenceSchema)(
                section === undefined ? undefined : section[KEEP_CONTEXT_MIN_CONFIDENCE_KEY],
              ),
              (value) => value > 0 && value < 1,
            ),
            () => DEFAULT_KEEP_CONTEXT_MIN_CONFIDENCE,
          );
          // The cap must be an integer in [1, MAX_CANDIDATES_LIMIT]; anything
          // else falls back alone.
          const maxCandidates = Option.getOrElse(
            Option.filter(
              Schema.decodeUnknownOption(MaxCandidatesSchema)(
                section === undefined ? undefined : section[MAX_CANDIDATES_KEY],
              ),
              (value) => value >= 1 && value <= MAX_CANDIDATES_LIMIT,
            ),
            () => DEFAULT_MAX_CANDIDATES,
          );
          return {
            enabled,
            chosen,
            keepContextThreshold,
            keepContextMinConfidence,
            maxCandidates,
          } satisfies SmartCompactionSettings;
        }).pipe(
          Effect.catchCause(() =>
            Effect.logWarning("tracker: smart-compaction settings unreadable, using defaults").pipe(
              Effect.as(defaultSmartCompactionSettings()),
            ),
          ),
        );
        return SmartCompactionSettingsService.of({ path, load });
      }),
    );
  }

  static readonly layerTest = (
    path: string,
    fileSystem: Partial<FileSystem.FileSystem>,
  ): Layer.Layer<SmartCompactionSettingsService> =>
    SmartCompactionSettingsService.make(path).pipe(Layer.provide(FileSystem.layerNoop(fileSystem)));
}
