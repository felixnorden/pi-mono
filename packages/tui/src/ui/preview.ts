/**
 * preview — display a file in the chat for the human only.
 *
 * Two entry points:
 *  - `preview` tool: the model calls it. The TUI renders the full file (with
 *    syntax highlighting) while the model only receives a one-line
 *    confirmation. Use when the user needs to review a file that the model
 *    does not need in its context.
 *  - `/preview <path>` command: the human invokes it. The content is stored as
 *    a custom entry that never participates in LLM context.
 *
 * The module has no direct Node dependencies: file reads go through the
 * platform `FileSystem` service, path operations through the `Path` service,
 * and byte slicing uses the standard `Uint8Array`/`TextEncoder` Web APIs. The
 * only platform primitive without an Effect service — the home directory used
 * for `~` expansion — is injected into {@link PreviewService.make} and bound
 * at the entry point (src/index.ts). The registrations run the pipeline
 * through the effect context captured there.
 */

import { Context, Effect, Layer, Schema, Path, FileSystem, PlatformError } from "effect";
import type { Component } from "@earendil-works/pi-tui";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import {
  getLanguageFromPath,
  getMarkdownTheme,
  highlightCode,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Text } from "@earendil-works/pi-tui";
import { makeBorderedBox } from "../components/bordered-box.ts";
import { Type } from "typebox";

export const MAX_BYTES = 50 * 1024; // 50KB, matching the built-in read limits
export const MAX_LINES = 2000;
export const COLLAPSED_LINES = 40;

/** Slice a byte array without splitting a multi-byte UTF-8 character. */
export function sliceUtf8(buf: Uint8Array, maxBytes: number): Uint8Array {
  if (buf.length <= maxBytes) return buf;
  let end = maxBytes;
  while (end > 0) {
    const b = buf[end];
    if (b === undefined || (b & 0xc0) !== 0x80) break;
    end--;
  }
  return buf.subarray(0, end);
}

export function capContent(
  raw: string,
  maxBytes: number,
  maxLines: number,
): { content: string; truncated: boolean } {
  const buf = new TextEncoder().encode(raw);
  const truncatedBytes = buf.length > maxBytes;
  let content = truncatedBytes ? new TextDecoder().decode(sliceUtf8(buf, maxBytes)) : raw;
  const lines = content.split("\n");
  const truncatedLines = lines.length > maxLines;
  if (truncatedLines) content = lines.slice(0, maxLines).join("\n");
  return { content, truncated: truncatedBytes || truncatedLines };
}

// ---------------------------------------------------------------------------
// Preview service
// ---------------------------------------------------------------------------

/** The display record the preview tool, command, and entry renderer consume. */
export interface PreviewData {
  path: string;
  content: string;
  lang?: string;
  truncated: boolean;
}

/** The failure-details variant: the record plus the user-facing error message. */
export type PreviewDataError = PreviewData & { readonly error: string };

/** A file read failed; carries the path and the underlying platform message. */
export class PreviewReadError extends Schema.TaggedError<PreviewReadError>()("PreviewReadError", {
  path: Schema.String,
  message: Schema.String,
}) {}

/**
 * Owns the whole preview pipeline: reference resolution (through the `Path`
 * service and the injected home directory), the platform `FileSystem` read,
 * byte/line capping, and the language hint. The only component in the module
 * that can fail; every platform failure maps to a tagged error.
 */
export class PreviewService extends Context.Service<
  PreviewService,
  {
    readonly resolveFileRef: (
      raw: string,
      cwd: string,
    ) => Effect.Effect<string, PlatformError.BadArgument>;
    readonly read: (absPath: string) => Effect.Effect<PreviewData, PreviewReadError>;
  }
>()("tui/preview/PreviewService") {
  /**
   * @param homedir - provider for the user's home directory (`~` expansion).
   *   Effect has no home-directory service, so the platform implementation is
   *   bound at the entry point.
   */
  static make(
    homedir: () => string,
    maxBytes: number = MAX_BYTES,
    maxLines: number = MAX_LINES,
    _collapsedLines: number = COLLAPSED_LINES,
  ): Layer.Layer<PreviewService, never, FileSystem.FileSystem | Path.Path> {
    return Layer.effect(
      PreviewService,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;

        /**
         * Resolve a file reference the same way pi's built-in tools do:
         * - strips a leading `@` (the @-autocomplete inserts `@path` or `@"path with spaces"`)
         * - expands `~` to the home directory
         * - handles `file://` URLs
         * - resolves relative paths against cwd
         */
        const resolveFileRef = Effect.fn("PreviewService.resolveFileRef")(function* (
          raw: string,
          cwd: string,
        ): Effect.fn.Return<string, PlatformError.BadArgument> {
          let ref = raw.trim();
          if (ref.startsWith("@")) ref = ref.slice(1);
          if (
            ref.length >= 2 &&
            ((ref.startsWith('"') && ref.endsWith('"')) ||
              (ref.startsWith("'") && ref.endsWith("'")))
          ) {
            ref = ref.slice(1, -1);
          }
          if (ref === "~") return homedir();
          if (ref.startsWith("~/")) return path.join(homedir(), ref.slice(2));
          if (/^file:\/\//.test(ref)) {
            const url = yield* Effect.try({
              try: () => new URL(ref),
              catch: () =>
                new PlatformError.BadArgument({
                  module: "Path",
                  method: "fromFileUrl",
                  description: `invalid file URL: ${ref}`,
                }),
            });
            return yield* path.fromFileUrl(url);
          }
          return path.isAbsolute(ref) ? ref : path.resolve(cwd, ref);
        });

        const read = Effect.fn("PreviewService.read")(function* (
          absPath: string,
        ): Effect.fn.Return<PreviewData, PreviewReadError> {
          const raw = yield* fs
            .readFileString(absPath)
            .pipe(
              Effect.catch(
                (err: PlatformError.PlatformError) =>
                  new PreviewReadError({ path: absPath, message: err.message }),
              ),
            );
          const { content, truncated } = capContent(raw, maxBytes, maxLines);
          return { path: absPath, content, lang: getLanguageFromPath(absPath), truncated };
        });

        return PreviewService.of({ resolveFileRef, read });
      }),
    );
  }

  static readonly layerTest = (
    fileSystem: Partial<FileSystem.FileSystem>,
    homedir: () => string,
    maxBytes: number = MAX_BYTES,
    maxLines: number = MAX_LINES,
    collapsedLines: number = COLLAPSED_LINES,
  ): Layer.Layer<PreviewService> =>
    PreviewService.make(homedir, maxBytes, maxLines, collapsedLines).pipe(
      Layer.provide(FileSystem.layerNoop(fileSystem)),
      Layer.provide(Path.layer),
    );
}

/**
 * Shared body renderer.
 *
 * Markdown files use pi's Markdown component (mdHeading/mdCode/mdLink colors,
 * highlighted fenced code blocks). Everything else uses highlightCode(), whose
 * hljs scope -> theme mapping covers code languages but not markdown's scopes
 * (section, code, bullet, quote...), which would render uncolored.
 */
export function renderBodyComponent(
  data: PreviewData,
  expanded: boolean,
  theme: Theme,
  collapsedLines: number = COLLAPSED_LINES,
): Component {
  const isMarkdown = data.lang === "markdown";
  if (isMarkdown) {
    const content = expanded
      ? data.content
      : data.content.split("\n").slice(0, collapsedLines).join("\n");
    const lines = data.content.split("\n");
    const note =
      expanded && data.truncated
        ? "\n... (truncated preview)"
        : !expanded && lines.length > collapsedLines
          ? `\n... (${lines.length - collapsedLines} more lines, expand to view all)`
          : "";
    return new Markdown(content + note, 0, 0, getMarkdownTheme());
  }

  const lines = data.lang ? highlightCode(data.content, data.lang) : data.content.split("\n");
  const max = expanded ? lines.length : Math.min(collapsedLines, lines.length);
  const out = lines.slice(0, max);
  if (max < lines.length || data.truncated) {
    out.push(theme.fg("muted", `... (${lines.length - max} lines shown, expand to view all)`));
  }
  return new Text(`\n${out.join("\n")}`, 0, 0);
}

/** Extract the user-facing message exactly like the legacy catch blocks. */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Registers the `preview` tool, the `/preview` command, and the `preview`
 * entry renderer. All three run the pipeline through the captured effect
 * context at the async call sites.
 */
export function registerPreview(
  pi: ExtensionAPI,
  effectContext: Context.Context<PreviewService>,
): void {
  // =========================================================================
  // `preview` tool — agent-invokable, display-only
  // =========================================================================
  pi.registerTool({
    name: "preview",
    label: "Preview file for user",
    description:
      "Display a file's contents in the chat for the user to read. " +
      "The full contents are rendered in the TUI only; the model receives just " +
      "a confirmation and the path. Use only when the user needs to see the file " +
      "and the model does not need its contents.",
    promptGuidelines: [
      "Use preview instead of read when ONLY the user needs to see the file contents. " +
        "Example: asking the user to approve a file another agent wrote. " +
        "Example: showing a file whose contents are not in the recent conversation history.",
      "Do not use preview when the model needs the contents, such as to edit, summarize, " +
        "or reason about the file. Use read instead.",
      "The model never receives the file contents. Treat preview as display-only.",
    ],
    // The custom renderers draw their own framed box; skip pi's standard
    // tool shell so the element is not double-framed.
    renderShell: "self",
    parameters: Type.Object({
      path: Type.String({
        description:
          "File path to display. Accepts @-references (@src/main.ts), ~ expansion, relative or absolute paths.",
      }),
    }),

    // What the MODEL sees — a stub, not the file.
    async execute(_toolCallId, { path }, _signal, _onUpdate, ctx) {
      return Effect.runPromiseWith(effectContext)(
        Effect.gen(function* () {
          const svc = yield* PreviewService;
          const absPath = yield* svc.resolveFileRef(path, ctx.cwd);
          return yield* svc.read(absPath);
        }).pipe(
          Effect.match({
            onSuccess: (data) => ({
              content: [{ type: "text", text: `[Preview shown to user: ${path}]` }],
              details: data,
            }),
            onFailure: (err: unknown) => {
              const message = errorMessage(err);
              return {
                content: [{ type: "text", text: `preview failed: ${message}` }],
                details: {
                  path,
                  content: "",
                  lang: undefined,
                  truncated: false,
                  error: message,
                } satisfies PreviewDataError,
              };
            },
          }),
        ),
      );
    },

    renderCall(args, theme) {
      return makeBorderedBox(new Text(args.path, 0, 0), theme, {
        label: theme.fg("toolTitle", theme.bold("preview")),
        bg: (s) => theme.bg("customMessageBg", s),
      });
    },

    // What the TUI renders — the full highlighted file.
    renderResult(result, options, theme, context) {
      const data = result.details as (PreviewData & { error?: string }) | undefined;
      if (!data) return context.lastComponent ?? new Text("", 0, 0);
      if (data.error) {
        return makeBorderedBox(new Text(`preview failed: ${data.error}`, 0, 0), theme, {
          label: theme.fg("warning", theme.bold("preview")),
          color: "warning",
          bg: (s) => theme.bg("customMessageBg", s),
        });
      }
      return makeBorderedBox(renderBodyComponent(data, options.expanded, theme), theme, {
        label: theme.fg("accent", theme.bold("preview")),
        bg: (s) => theme.bg("customMessageBg", s),
      });
    },
  });

  // =========================================================================
  // `/preview <path>` command — human-invoked, strictly TUI-only
  // =========================================================================
  pi.registerEntryRenderer("preview", (entry, { expanded }, theme) => {
    const data = entry.data as PreviewData | undefined;
    const body = new Container();
    if (!data) {
      body.addChild(new Text(theme.fg("warning", "[preview] no data"), 0, 0));
      return makeBorderedBox(body, theme, {
        label: theme.fg("warning", theme.bold("preview")),
        color: "warning",
        bg: (s) => theme.bg("customMessageBg", s),
      });
    }
    body.addChild(new Text(theme.fg("accent", data.path), 0, 0));
    body.addChild(renderBodyComponent(data, expanded, theme));
    return makeBorderedBox(body, theme, {
      label: theme.fg("accent", theme.bold("preview")),
      bg: (s) => theme.bg("customMessageBg", s),
    });
  });

  pi.registerCommand("preview", {
    description:
      "Display a file in the chat for the user to read (TUI only, not sent to the model).",
    handler: async (args, ctx) => {
      const path = args.trim();
      if (!path) {
        ctx.ui.notify("usage: /preview <path>", "warning");
        return;
      }
      const outcome = await Effect.runPromiseWith(effectContext)(
        Effect.gen(function* () {
          const svc = yield* PreviewService;
          const absPath = yield* svc.resolveFileRef(path, ctx.cwd);
          return yield* svc.read(absPath);
        }).pipe(
          Effect.match({
            onSuccess: (data) => ({ ok: true as const, data }),
            onFailure: (err: unknown) => ({ ok: false as const, message: errorMessage(err) }),
          }),
        ),
      );
      if (outcome.ok) {
        pi.appendEntry("preview", outcome.data);
      } else {
        ctx.ui.notify(`preview failed: ${outcome.message}`, "error");
      }
    },
  });
}
