/**
 * preview — display a file in the chat for the human only.
 *
 * Two entry points:
 *  - `preview` tool: the model calls it. The TUI renders the full file — text
 *    with syntax highlighting, images inline via the terminal's graphics
 *    protocol — while the model only receives a one-line confirmation (image
 *    bytes live only in the TUI `details`, never in model context). Use when
 *    the user needs to review a file that the model does not need in its
 *    context.
 *  - `/preview <path>` command: the human invokes it. The content is stored as
 *    a custom entry that never participates in LLM context.
 *
 * The module has no direct Node dependencies: file reads go through the
 * platform `FileSystem` service, path operations through the `Path` service,
 * and byte slicing/base64 encoding uses the standard `Uint8Array`/`TextEncoder`
 * /`btoa` Web APIs. The
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
import {
  Container,
  getImageDimensions,
  Image,
  Markdown,
  Spacer,
  Text,
  type ImageDimensions,
} from "@earendil-works/pi-tui";
import { makeBorderedBox } from "../components/bordered-box.ts";
import { Type } from "typebox";

export const MAX_BYTES = 50 * 1024; // 50KB, matching the built-in read limits
export const MAX_LINES = 2000;
export const COLLAPSED_LINES = 40;

/** MIME types pi-tui's Image component can size and render (PNG/JPEG/GIF/WebP
 * plus AVIF, whose size this module parses itself). */
const IMAGE_MIME_BY_EXT: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
};

/**
 * Map a path's extension to a renderable image MIME type, or undefined when
 * the file is not one pi-tui's Image component can display. Comparison is
 * case-insensitive.
 */
export function mimeFromPath(path: string): string | undefined {
  const lower = path.toLowerCase();
  for (const ext of Object.keys(IMAGE_MIME_BY_EXT)) {
    if (lower.endsWith(ext)) return IMAGE_MIME_BY_EXT[ext]!;
  }
  return undefined;
}

/**
 * Encode raw bytes as base64 using Web APIs only. Chunked so large files do
 * not exceed the engine's spread-argument limit on `String.fromCharCode`.
 */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** Read a big-endian u32 from a byte array (no DataView needed on a subarray). */
function readU32BE(bytes: Uint8Array, offset: number): number {
  return (
    (((bytes[offset] ?? 0) << 24) |
      ((bytes[offset + 1] ?? 0) << 16) |
      ((bytes[offset + 2] ?? 0) << 8) |
      (bytes[offset + 3] ?? 0)) >>>
    0
  );
}

/** The 4-char ASCII box type at an ISO-BMFF box header. */
function boxType(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(
    bytes[offset + 4] ?? 0,
    bytes[offset + 5] ?? 0,
    bytes[offset + 6] ?? 0,
    bytes[offset + 7] ?? 0,
  );
}

/** ISO-BMFF boxes that are FullBoxes (payload begins with a 4-byte version/flags header). */
const FULLBOX_CONTAINERS = new Set(["meta", "iprp", "ipma", "iinf", "iref", "iloc", "pitm"]);

/** ISO-BMFF container boxes to descend into when hunting `ispe` (skips `mdat`/image payloads). */
const CONTAINER_BOXES = new Set(["meta", "iprp", "ipco", "ipma", "iinf", "iref", "iloc", "pitm"]);

/**
 * Recursively locate the first `ispe` box in an ISO-BMFF file (AVIF/HEIC),
 * returning its payload offset and length, or null when absent. `ispe` holds
 * the image's spatial extents. Only known container boxes are descended, so
 * `mdat` image payloads are never scanned.
 */
function findIspe(
  bytes: Uint8Array,
  start: number,
  end: number,
): { offset: number; length: number } | null {
  let offset = start;
  while (offset + 8 <= end) {
    const type = boxType(bytes, offset);
    let sizeField = readU32BE(bytes, offset);
    let headerLen = 8;
    if (sizeField === 1) {
      // 64-bit largesize follows the 8-byte type.
      headerLen = 16;
      sizeField = readU32BE(bytes, offset + 12); // low 32 bits (high is effectively 0 for images)
      if (offset + 16 > end) break;
    } else if (sizeField === 0) {
      sizeField = end - offset; // box extends to the end of the file
    }
    if (sizeField < headerLen) break; // malformed box
    const payloadStart = offset + headerLen;
    const payloadEnd = offset + sizeField;

    if (type === "ispe") return { offset: payloadStart, length: sizeField - headerLen };

    if (CONTAINER_BOXES.has(type)) {
      // FullBox children skip their 4-byte version/flags header.
      const childStart = FULLBOX_CONTAINERS.has(type) ? payloadStart + 4 : payloadStart;
      const found = findIspe(bytes, childStart, payloadEnd);
      if (found) return found;
    }
    if (payloadEnd <= offset) break;
    offset = payloadEnd;
  }
  return null;
}

/**
 * Parse the pixel dimensions of an AVIF file from its ISO-BMFF `ispe` box, or
 * null when the size cannot be found. pi-tui's `getImageDimensions` has no AVIF
 * support, so this module computes the size itself and hands it to the `Image`.
 */
export function getAvifDimensions(bytes: Uint8Array): ImageDimensions | null {
  const ispe = findIspe(bytes, 0, bytes.length);
  if (!ispe || ispe.length < 12) return null;
  // ispe payload: version/flags (4) + width (4) + height (4).
  const width = readU32BE(bytes, ispe.offset + 4);
  const height = readU32BE(bytes, ispe.offset + 8);
  if (width === 0 || height === 0) return null;
  return { widthPx: width, heightPx: height };
}

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

/** A text record: read as a string, rendered as Markdown or highlighted code. */
export interface TextPreview {
  readonly kind: "text";
  readonly path: string;
  readonly content: string;
  readonly lang?: string;
  readonly truncated: boolean;
}

/** An image record: raw bytes base64-encoded, rendered via pi-tui's Image. */
export interface ImagePreview {
  readonly kind: "image";
  readonly path: string;
  readonly mimeType: string;
  readonly base64: string;
  readonly dimensions?: ImageDimensions;
  readonly truncated: boolean;
}

/** The display record the preview tool, command, and entry renderer consume. */
export type PreviewData = TextPreview | ImagePreview;

/** The failure-details variant: a text record plus the user-facing error message. */
export type PreviewDataError = TextPreview & { readonly error: string };

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
          if (ref.startsWith("file://")) {
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
          const mime = mimeFromPath(absPath);
          if (mime) {
            // Image: read raw bytes (no string decoding, no byte/line capping), then
            // base64-encode and dimension-detect for pi-tui's Image component. The
            // base64 only lives in `details` for TUI rendering — it never reaches the
            // model, which sees the same one-line confirmation stub.
            const bytes = yield* fs
              .readFile(absPath)
              .pipe(
                Effect.catch(
                  (err: PlatformError.PlatformError) =>
                    new PreviewReadError({ path: absPath, message: err.message }),
                ),
              );
            const base64 = bytesToBase64(bytes);
            // AVIF/HEIC sizes come from the ISO-BMFF `ispe` box (pi-tui has no
            // AVIF parser); every other supported format is sized from base64.
            const dimensions =
              mime === "image/avif"
                ? (getAvifDimensions(bytes) ?? undefined)
                : (getImageDimensions(base64, mime) ?? undefined);
            return {
              kind: "image",
              path: absPath,
              mimeType: mime,
              base64,
              dimensions,
              truncated: false,
            };
          }
          const raw = yield* fs
            .readFileString(absPath)
            .pipe(
              Effect.catch(
                (err: PlatformError.PlatformError) =>
                  new PreviewReadError({ path: absPath, message: err.message }),
              ),
            );
          const { content, truncated } = capContent(raw, maxBytes, maxLines);
          return {
            kind: "text",
            path: absPath,
            content,
            lang: getLanguageFromPath(absPath),
            truncated,
          };
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
  if (data.kind === "image") {
    // The Image component detects terminal support itself: real pixels on
    // kitty/ghostty/wezterm/iTerm2, a `[Image: path [mime] WxH]` text fallback
    // (OSC-8 hyperlinked when available) elsewhere. `expanded`/collapse do not
    // apply — there is no text to truncate.
    return new Image(
      data.base64,
      data.mimeType,
      { fallbackColor: (s) => theme.fg("muted", s) },
      { filename: data.path },
      data.dimensions,
    );
  }
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

/**
 * Wrap a preview body in the house frame. Text records use the bordered box.
 * Image records must NOT draw their own pixels: ad-hoc kitty transmissions from
 * a custom renderer are not part of pi's managed image pipeline and corrupt the
 * screen. Instead the tool delivers images as native `type: "image"` content
 * blocks (see execute) which pi's ToolExecution renders below our caption `——`
 * so here we only draw the path/dimensions caption.
 */
function makePreviewComponent(data: PreviewData, expanded: boolean, theme: Theme): Component {
  if (data.kind === "image") {
    const caption = data.dimensions
      ? `${data.path} (${data.dimensions.widthPx}x${data.dimensions.heightPx})`
      : data.path;
    return makeBorderedBox(new Text(theme.fg("accent", caption), 0, 0), theme, {
      label: theme.fg("accent", theme.bold("preview")),
      bg: (s) => theme.bg("customMessageBg", s),
    });
  }
  return makeBorderedBox(renderBodyComponent(data, expanded, theme), theme, {
    label: theme.fg("accent", theme.bold("preview")),
    bg: (s) => theme.bg("customMessageBg", s),
  });
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

    // What the MODEL sees — a stub plus, for images, a pi-native `type: "image"`
    // content block. The block is what makes the TUI render the picture through
    // pi's own managed image pipeline (the same path the built-in `read` tool
    // uses); pi auto-resizes it for provider requests, so the model receives a
    // compressed thumbnail rather than raw bytes. Text previews stay stub-only.
    async execute(_toolCallId, { path }, _signal, _onUpdate, ctx) {
      return Effect.runPromiseWith(effectContext)(
        Effect.gen(function* () {
          const svc = yield* PreviewService;
          const absPath = yield* svc.resolveFileRef(path, ctx.cwd);
          return yield* svc.read(absPath);
        }).pipe(
          Effect.match({
            onSuccess: (data) => ({
              content: [
                { type: "text" as const, text: `[Preview shown to user: ${path}]` },
                ...(data.kind === "image"
                  ? [{ type: "image" as const, data: data.base64, mimeType: data.mimeType }]
                  : []),
              ],
              details: data,
            }),
            onFailure: (err: unknown) => {
              const message = errorMessage(err);
              return {
                content: [{ type: "text", text: `preview failed: ${message}` }],
                details: {
                  kind: "text",
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
      return makePreviewComponent(data, options.expanded, theme);
    },
  });

  // =========================================================================
  // `/preview <path>` command — human-invoked, strictly TUI-only
  // =========================================================================
  pi.registerEntryRenderer("preview", (entry, { expanded }, theme) => {
    const data = entry.data as PreviewData | undefined;
    if (!data) {
      const noData = new Container();
      noData.addChild(new Text(theme.fg("warning", "[preview] no data"), 0, 0));
      return makeBorderedBox(noData, theme, {
        label: theme.fg("warning", theme.bold("preview")),
        color: "warning",
        bg: (s) => theme.bg("customMessageBg", s),
      });
    }
    // Image entries mirror pi's native tool-image layout exactly: the bordered
    // caption box, one blank spacer row, then the bare Image. pi's own images
    // always emit a spacer row before the kitty transmission; our earlier boxed
    // attempts lacked it, which is what broke Ghostty decoding. Entries have no
    // content-block pipeline, so the Image is drawn by this renderer.
    if (data.kind === "image") {
      const c = new Container();
      c.addChild(makePreviewComponent(data, expanded, theme));
      c.addChild(new Spacer(1));
      c.addChild(
        new Image(
          data.base64,
          data.mimeType,
          { fallbackColor: (s) => theme.fg("toolOutput", s) },
          { filename: data.path, maxWidthCells: 60 },
          data.dimensions,
        ),
      );
      return c;
    }
    const body = new Container();
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
