import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Context, Effect, Layer, Schema } from "effect";
import * as FileSystem from "effect/FileSystem";
import * as PlatformError from "effect/PlatformError";
export type { IconMode } from "./icons.ts";

export type SettingsLanguage = "en";

const CONFIG_FILE_NAME = "tui.json";

const IconModeSchema = Schema.Literals(["auto", "nerd", "ascii"] as const);
const SettingsLanguageSchema = Schema.Literals(["en"] as const);

export class TuiConfig extends Schema.Class<TuiConfig>("tui/config/TuiConfig")({
  enabled: Schema.Boolean,
  settingsLanguage: SettingsLanguageSchema,
  vim: Schema.Boolean,
  icons: Schema.Struct({ mode: IconModeSchema }),
  footerSegments: Schema.Struct({
    cwd: Schema.Boolean,
    gitBranch: Schema.Boolean,
    gitStatus: Schema.Boolean,
    gitCommit: Schema.Boolean,
    runtime: Schema.Boolean,
    context: Schema.Boolean,
    tokens: Schema.Boolean,
    cost: Schema.Boolean,
    extensionStatuses: Schema.Boolean,
  }),
  telemetry: Schema.Struct({
    enabled: Schema.Boolean,
    tps: Schema.Boolean,
    ttft: Schema.Boolean,
    duration: Schema.Boolean,
    tokens: Schema.Boolean,
    stalls: Schema.Boolean,
    cost: Schema.Boolean,
  }),
}) {}

export type TelemetryConfig = TuiConfig["telemetry"];

export const DEFAULT_CONFIG: TuiConfig = {
  enabled: true,
  settingsLanguage: "en",
  vim: false,
  icons: { mode: "auto" },
  footerSegments: {
    cwd: true,
    gitBranch: true,
    gitStatus: true,
    gitCommit: false,
    runtime: true,
    context: true,
    tokens: true,
    cost: true,
    extensionStatuses: true,
  },
  telemetry: {
    enabled: true,
    tps: true,
    ttft: true,
    duration: true,
    tokens: true,
    stalls: true,
    cost: true,
  },
};

export function getConfigPath(): string {
  return join(getAgentDir(), CONFIG_FILE_NAME);
}

// On-disk format is a partial config: every field may be absent, but any
// present field must have the correct type. Extra keys are ignored so the
// file stays forward-compatible.
const OptionalBoolean = Schema.optional(Schema.Boolean);
const OptionalIconMode = Schema.optional(IconModeSchema);
const OptionalSettingsLanguage = Schema.optional(SettingsLanguageSchema);

const FileSchema = Schema.fromJsonString(
  Schema.Struct({
    enabled: OptionalBoolean,
    settingsLanguage: OptionalSettingsLanguage,
    vim: OptionalBoolean,
    icons: Schema.optional(Schema.Struct({ mode: OptionalIconMode })),
    footerSegments: Schema.optional(
      Schema.Struct({
        cwd: OptionalBoolean,
        gitBranch: OptionalBoolean,
        gitStatus: OptionalBoolean,
        gitCommit: OptionalBoolean,
        runtime: OptionalBoolean,
        context: OptionalBoolean,
        tokens: OptionalBoolean,
        cost: OptionalBoolean,
        extensionStatuses: OptionalBoolean,
      }),
    ),
    telemetry: Schema.optional(
      Schema.Struct({
        enabled: OptionalBoolean,
        tps: OptionalBoolean,
        ttft: OptionalBoolean,
        duration: OptionalBoolean,
        tokens: OptionalBoolean,
        stalls: OptionalBoolean,
        cost: OptionalBoolean,
      }),
    ),
  }),
  { space: 2 },
);

type TuiConfigFile = typeof FileSchema.Type;

export const encodeConfig = Schema.encodeSync(FileSchema);
export const decodeConfig = Schema.decodeSync(FileSchema);

export const decodeConfigEffect = Schema.decodeEffect(FileSchema);

export function applyDefaults(partial: TuiConfigFile): TuiConfig {
  return {
    enabled: partial.enabled ?? DEFAULT_CONFIG.enabled,
    settingsLanguage: partial.settingsLanguage ?? DEFAULT_CONFIG.settingsLanguage,
    vim: partial.vim ?? DEFAULT_CONFIG.vim,
    icons: {
      mode: partial.icons?.mode ?? DEFAULT_CONFIG.icons.mode,
    },
    footerSegments: {
      cwd: partial.footerSegments?.cwd ?? DEFAULT_CONFIG.footerSegments.cwd,
      gitBranch: partial.footerSegments?.gitBranch ?? DEFAULT_CONFIG.footerSegments.gitBranch,
      gitStatus: partial.footerSegments?.gitStatus ?? DEFAULT_CONFIG.footerSegments.gitStatus,
      gitCommit: partial.footerSegments?.gitCommit ?? DEFAULT_CONFIG.footerSegments.gitCommit,
      runtime: partial.footerSegments?.runtime ?? DEFAULT_CONFIG.footerSegments.runtime,
      context: partial.footerSegments?.context ?? DEFAULT_CONFIG.footerSegments.context,
      tokens: partial.footerSegments?.tokens ?? DEFAULT_CONFIG.footerSegments.tokens,
      cost: partial.footerSegments?.cost ?? DEFAULT_CONFIG.footerSegments.cost,
      extensionStatuses:
        partial.footerSegments?.extensionStatuses ??
        DEFAULT_CONFIG.footerSegments.extensionStatuses,
    },
    telemetry: {
      enabled: partial.telemetry?.enabled ?? DEFAULT_CONFIG.telemetry.enabled,
      tps: partial.telemetry?.tps ?? DEFAULT_CONFIG.telemetry.tps,
      ttft: partial.telemetry?.ttft ?? DEFAULT_CONFIG.telemetry.ttft,
      duration: partial.telemetry?.duration ?? DEFAULT_CONFIG.telemetry.duration,
      tokens: partial.telemetry?.tokens ?? DEFAULT_CONFIG.telemetry.tokens,
      stalls: partial.telemetry?.stalls ?? DEFAULT_CONFIG.telemetry.stalls,
      cost: partial.telemetry?.cost ?? DEFAULT_CONFIG.telemetry.cost,
    },
  };
}

export class ConfigReadError extends Schema.TaggedError<ConfigReadError>()("ConfigReadError", {
  path: Schema.String,
  message: Schema.String,
}) {}

export class ConfigParseError extends Schema.TaggedError<ConfigParseError>()("ConfigParseError", {
  path: Schema.String,
  message: Schema.String,
}) {}

export class ConfigWriteError extends Schema.TaggedError<ConfigWriteError>()("ConfigWriteError", {
  path: Schema.String,
  message: Schema.String,
}) {}

export type ConfigError = ConfigReadError | ConfigParseError | ConfigWriteError;

export class TuiConfigService extends Context.Service<
  TuiConfigService,
  {
    readonly path: string;
    readonly load: Effect.Effect<TuiConfig, ConfigError, never>;
    readonly loadOrDefault: Effect.Effect<TuiConfig, never, never>;
    readonly save: (config: TuiConfig) => Effect.Effect<void, ConfigWriteError>;
  }
>()("tui/config/TuiConfigService") {
  static make(path: string): Layer.Layer<TuiConfigService, never, FileSystem.FileSystem> {
    return Layer.effect(
      TuiConfigService,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;

        const load = Effect.gen(function* () {
          const exists = yield* fs
            .exists(path)
            .pipe(
              Effect.catch(
                (err: PlatformError.PlatformError) =>
                  new ConfigReadError({ path, message: err.message }),
              ),
            );

          if (!exists) {
            yield* fs.makeDirectory(dirname(path), { recursive: true }).pipe(
              Effect.andThen(() => fs.writeFileString(path, encodeConfig(DEFAULT_CONFIG) + "\n")),
              Effect.catch(
                (err: PlatformError.PlatformError) =>
                  new ConfigWriteError({ path, message: err.message }),
              ),
            );
            return applyDefaults({});
          }

          const config = yield* fs.readFileString(path).pipe(
            Effect.flatMap(decodeConfigEffect),
            Effect.catchTags({
              SchemaError: (err) => new ConfigParseError({ path, message: err.message }),
              PlatformError: (err) => new ConfigReadError({ path, message: err.message }),
            }),
          );

          return applyDefaults(config);
        });

        const loadOrDefault = load.pipe(
          Effect.catch((err: ConfigError) =>
            Effect.gen(function* () {
              yield* Effect.logWarning(`TUI config load failed: ${err.message}`);
              return applyDefaults({});
            }),
          ),
        );

        const save = Effect.fn("save")(function* (config: TuiConfig) {
          yield* fs
            .makeDirectory(dirname(path), { recursive: true })
            .pipe(
              Effect.catch(
                (err: PlatformError.PlatformError) =>
                  new ConfigWriteError({ path, message: err.message }),
              ),
            );
          yield* fs
            .writeFileString(path, JSON.stringify(config, null, 2) + "\n")
            .pipe(
              Effect.catch(
                (err: PlatformError.PlatformError) =>
                  new ConfigWriteError({ path, message: err.message }),
              ),
            );
        });

        return TuiConfigService.of({ path, load, loadOrDefault, save });
      }),
    );
  }

  static readonly layer: Layer.Layer<TuiConfigService, never, FileSystem.FileSystem> =
    TuiConfigService.make(getConfigPath());

  static readonly layerTest = (
    path: string,
    fileSystem: Partial<FileSystem.FileSystem>,
  ): Layer.Layer<TuiConfigService> =>
    TuiConfigService.make(path).pipe(Layer.provide(FileSystem.layerNoop(fileSystem)));
}

// // ------------------------------------------------------------------
// // Temporary imperative wrappers for backwards compatibility.
// // TODO: remove these once src/index.ts is wired to TuiConfigService.
// // ------------------------------------------------------------------
//
// export function ensureConfigExists(): void {
//   const path = getConfigPath();
//   if (existsSync(path)) return;
//   try {
//     const agentDir = getAgentDir();
//     if (!existsSync(agentDir)) mkdirSync(agentDir, { recursive: true });
//     writeFileSync(path, JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n", "utf8");
//   } catch {}
// }
//
// export function loadConfig(notify?: (msg: string, level: "warning" | "info") => void): TuiConfig {
//   const path = getConfigPath();
//   if (!existsSync(path)) {
//     ensureConfigExists();
//     return applyDefaults({});
//   }
//
//   try {
//     const raw = readFileSync(path, "utf8");
//     const parsed: unknown = JSON.parse(raw);
//     const partial = Schema.decodeUnknownSync(FileSchema, { onExcessProperty: "ignore" })(parsed);
//     return applyDefaults(partial);
//   } catch (err) {
//     notify?.(
//       `tui config parse error: ${err instanceof Error ? err.message : String(err)}`,
//       "warning",
//     );
//     return applyDefaults({});
//   }
// }
//
// export function saveConfig(config: TuiConfig): void {
//   const path = getConfigPath();
//   try {
//     const agentDir = getAgentDir();
//     if (!existsSync(agentDir)) mkdirSync(agentDir, { recursive: true });
//     writeFileSync(path, JSON.stringify(config, null, 2) + "\n", "utf8");
//   } catch {}
// }
