import { Context, Effect, Layer, Option, Predicate, Schema } from "effect";
import * as FileSystem from "effect/FileSystem";

/**
 * The tracker's reader of the shared TUI settings file's `vim` toggle. The
 * toggle gates h/j/k/l navigation in the `/tracker` overlay. It fails closed:
 * a missing, unreadable, or malformed value reads as off, so the overlay keeps
 * its arrow-only behavior.
 *
 * The file is owned by `packages/tui/src/config.ts`; the tracker only reads the
 * one key. The caller passes the path, so the tracker never re-declares the
 * file name.
 */
export const VIM_KEY = "vim";

const FileSchema = Schema.fromJsonString(Schema.Unknown);
const BooleanSchema = Schema.Boolean;

/** The `vim` boolean, or `false` when the value is absent or not a boolean. */
export const readVimEnabled = (parsed: unknown): boolean => {
  if (!Predicate.isObject(parsed)) return false;
  const raw = Predicate.hasProperty(VIM_KEY)(parsed) ? parsed[VIM_KEY] : undefined;
  return Option.getOrElse(Schema.decodeUnknownOption(BooleanSchema)(raw), () => false);
};

export class VimSettingsService extends Context.Service<
  VimSettingsService,
  {
    readonly path: string;
    /** Never fails: every read, parse, or shape problem yields `false` (off). */
    readonly load: Effect.Effect<boolean>;
  }
>()("tracker/VimSettings") {
  static make(path: string): Layer.Layer<VimSettingsService, never, FileSystem.FileSystem> {
    return Layer.effect(
      VimSettingsService,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const load = Effect.gen(function* () {
          const raw = yield* fs.readFileString(path);
          // `Schema.Unknown` accepts any JSON value; `readVimEnabled` narrows it.
          const parsed = yield* Schema.decodeEffect(FileSchema)(raw);
          return readVimEnabled(parsed);
        }).pipe(
          Effect.catchCause(() =>
            Effect.logWarning("tracker: vim setting unreadable, using off").pipe(Effect.as(false)),
          ),
        );
        return VimSettingsService.of({ path, load });
      }),
    );
  }

  static readonly layerTest = (
    path: string,
    fileSystem: Partial<FileSystem.FileSystem>,
  ): Layer.Layer<VimSettingsService> =>
    VimSettingsService.make(path).pipe(Layer.provide(FileSystem.layerNoop(fileSystem)));
}
