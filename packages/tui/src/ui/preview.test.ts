import { assert, it } from "@effect/vitest";
import type {
  ExtensionAPI,
  ExtensionContext,
  Theme,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { initTheme } from "@earendil-works/pi-coding-agent";
import {
  Image,
  Markdown,
  resetCapabilitiesCache,
  setCapabilities,
  Text,
} from "@earendil-works/pi-tui";
import { Context, Effect, PlatformError } from "effect";
import * as FileSystem from "effect/FileSystem";
import type { Component } from "@earendil-works/pi-tui";
import {
  bytesToBase64,
  capContent,
  COLLAPSED_LINES,
  MAX_BYTES,
  MAX_LINES,
  mimeFromPath,
  getAvifDimensions,
  PreviewReadError,
  PreviewService,
  renderBodyComponent,
  registerPreview,
  sliceUtf8,
  type PreviewData,
  type TextPreview,
} from "./preview.ts";

// The Markdown component reads pi's global theme at render time.
initTheme();

const HOMEDIR = "/home/test";
const testHomedir = () => HOMEDIR;
const encode = (raw: string) => new TextEncoder().encode(raw);

/**
 * A minimal PNG header (signature + IHDR) carrying a 512x256 size. pi-tui's
 * `getPngDimensions` only inspects the signature and the width/height words at
 * offsets 16..23, so this suffices to exercise the dimension detection path.
 */
const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG signature
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, // IHDR chunk header
  0x00, 0x00, 0x02, 0x00, // width = 512 (big-endian uint32)
  0x00, 0x00, 0x01, 0x00, // height = 256
]);
const PNG_BASE64 = bytesToBase64(PNG_BYTES);

/**
 * Build an AVIF-shaped ISO-BMFF file carrying the given width/height in an
 * `ispe` box nested under meta → iprp → ipco (the standard AVIF layout).
 */
function buildAvif(width: number, height: number): Uint8Array {
  const box = (type: string, payload: number[]): number[] => {
    const size = 8 + payload.length;
    return [
      (size >>> 24) & 0xff,
      (size >>> 16) & 0xff,
      (size >>> 8) & 0xff,
      size & 0xff,
      ...Array.from(type, (c) => c.charCodeAt(0)),
      ...payload,
    ];
  };
  const fullbox = (): number[] => [0, 0, 0, 0];
  const u32 = (n: number): number[] => [
    (n >>> 24) & 0xff,
    (n >>> 16) & 0xff,
    (n >>> 8) & 0xff,
    n & 0xff,
  ];
  const ispe = box("ispe", [...fullbox(), ...u32(width), ...u32(height)]);
  const ipco = box("ipco", ispe);
  const iprp = box("iprp", [...fullbox(), ...ipco]);
  const meta = box("meta", [...fullbox(), ...iprp]);
  const ftyp = box("ftyp", [...Array.from("avif", (c) => c.charCodeAt(0)), 0, 0, 0, 0]);
  return new Uint8Array([...ftyp, ...meta]);
}
const AVIF_BYTES = buildAvif(512, 256);

/** Minimal shape guard: a renderable TUI component (replaces the former class check). */
const isComponent = (c: unknown): c is Component => typeof (c as Component)?.render === "function";
const decode = (buf: Uint8Array) => new TextDecoder().decode(buf);

// ---------------------------------------------------------------------------
// Slice 1 — byte-safe truncation and capping behavior
// ---------------------------------------------------------------------------

it("sliceUtf8 returns the buffer unchanged when its length is at or below the byte cap", () => {
  const buf = encode("abc");
  assert.strictEqual(decode(sliceUtf8(buf, 3)), "abc");
  assert.strictEqual(decode(sliceUtf8(buf, 5)), "abc");
});

it("sliceUtf8 cuts the buffer at the byte cap when the content exceeds it", () => {
  const buf = encode("abcdef");
  assert.strictEqual(decode(sliceUtf8(buf, 4)), "abcd");
});

it("sliceUtf8 does not split a multi-byte character at the byte boundary", () => {
  const buf = encode("a€b");
  assert.strictEqual(decode(sliceUtf8(buf, 4)), "a€");
  assert.strictEqual(decode(sliceUtf8(buf, 3)), "a");
});

it("sliceUtf8 returns an empty buffer when the cap lands inside the leading multi-byte character", () => {
  const buf = encode("€ab");
  assert.strictEqual(sliceUtf8(buf, 2).length, 0);
});

it("capContent returns the content unchanged with truncated false when both caps hold", () => {
  assert.deepStrictEqual(capContent("abcde", 5, 3), { content: "abcde", truncated: false });
});

it("capContent truncates at the byte cap and reports truncated when the content exceeds the byte cap", () => {
  assert.deepStrictEqual(capContent("abcdef", 5, 10), { content: "abcde", truncated: true });
});

it("capContent truncates at the line cap and reports truncated when the content exceeds the line cap", () => {
  assert.deepStrictEqual(capContent("a\nb\nc\nd", 100, 3), { content: "a\nb\nc", truncated: true });
});

it("capContent applies the byte cap before the line cap and reports truncated when both fire", () => {
  assert.deepStrictEqual(capContent("ab\ncd\nefgh", 6, 2), { content: "ab\ncd", truncated: true });
});

it("capContent does not split a multi-byte character at the byte cap", () => {
  assert.deepStrictEqual(capContent("€€€", 4, 10), { content: "€", truncated: true });
});

it("the truncation constants keep today's production values", () => {
  assert.strictEqual(MAX_BYTES, 50 * 1024);
  assert.strictEqual(MAX_LINES, 2000);
  assert.strictEqual(COLLAPSED_LINES, 40);
});

// ---------------------------------------------------------------------------
// Slice 2 — reference resolution behavior
// ---------------------------------------------------------------------------

const runResolve = (raw: string, cwd: string, mem: MemFs = makeMemFs()) =>
  Effect.gen(function* () {
    const svc = yield* PreviewService;
    return yield* svc.resolveFileRef(raw, cwd);
  }).pipe(Effect.provide(PreviewService.layerTest(mem.fs, testHomedir)));

it.effect("resolveFileRef strips the @ autocomplete prefix", () =>
  Effect.gen(function* () {
    const out = yield* runResolve("@src/main.ts", "/proj");
    assert.strictEqual(out, "/proj/src/main.ts");
  }),
);

it.effect("resolveFileRef strips surrounding double and single quotes", () =>
  Effect.gen(function* () {
    const double = yield* runResolve('"src/my file.ts"', "/proj");
    assert.strictEqual(double, "/proj/src/my file.ts");
    const single = yield* runResolve("'src/a.ts'", "/proj");
    assert.strictEqual(single, "/proj/src/a.ts");
  }),
);

it.effect("resolveFileRef expands a bare tilde to the home directory", () =>
  Effect.gen(function* () {
    const out = yield* runResolve("~", "/proj");
    assert.strictEqual(out, HOMEDIR);
  }),
);

it.effect("resolveFileRef expands a tilde-prefixed path against the home directory", () =>
  Effect.gen(function* () {
    const out = yield* runResolve("~/notes/a.md", "/proj");
    assert.strictEqual(out, "/home/test/notes/a.md");
  }),
);

it.effect("resolveFileRef converts a file URL to a path", () =>
  Effect.gen(function* () {
    const out = yield* runResolve("file:///tmp/a.md", "/proj");
    assert.strictEqual(out, "/tmp/a.md");
  }),
);

it.effect("resolveFileRef passes absolute paths through unchanged", () =>
  Effect.gen(function* () {
    const out = yield* runResolve("/abs/dir/a.ts", "/proj");
    assert.strictEqual(out, "/abs/dir/a.ts");
  }),
);

it.effect("resolveFileRef resolves relative paths against the working directory", () =>
  Effect.gen(function* () {
    const out = yield* runResolve("sub/b.md", "/proj");
    assert.strictEqual(out, "/proj/sub/b.md");
  }),
);

it.effect("resolveFileRef trims surrounding whitespace", () =>
  Effect.gen(function* () {
    const out = yield* runResolve("  src/a.ts  ", "/proj");
    assert.strictEqual(out, "/proj/src/a.ts");
  }),
);

// ---------------------------------------------------------------------------
// Slice 3 — preview read service behavior
// ---------------------------------------------------------------------------

interface MemFs {
  readonly fs: Partial<FileSystem.FileSystem>;
  readonly files: Map<string, Uint8Array>;
}

/**
 * In-memory FileSystem for tests. Text entries are keyed by path in the first
 * argument, binary entries (images) in the second. Both `readFileString` and
 * `readFile` are provided so PreviewService can read text and image files.
 */
function makeMemFs(
  init: Record<string, string> = {},
  binary: Record<string, Uint8Array> = {},
): MemFs {
  const files = new Map<string, Uint8Array>();
  for (const [p, raw] of Object.entries(init)) files.set(p, new TextEncoder().encode(raw));
  for (const [p, bytes] of Object.entries(binary)) files.set(p, bytes);
  const notFound = (method: string) => (path: string) =>
    Effect.fail(
      PlatformError.systemError({
        _tag: "NotFound",
        module: "FileSystem",
        method,
        pathOrDescriptor: path,
        description: "No such file",
      }),
    );
  const fs: Partial<FileSystem.FileSystem> = {
    readFile: (path) =>
      files.has(path)
        ? Effect.succeed(files.get(path)!)
        : notFound("readFile")(path),
    readFileString: (path) =>
      files.has(path)
        ? Effect.succeed(new TextDecoder().decode(files.get(path)!))
        : notFound("readFileString")(path),
  };
  return { fs, files };
}

const runRead = (mem: MemFs, absPath: string, maxBytes?: number, maxLines?: number) =>
  Effect.gen(function* () {
    const svc = yield* PreviewService;
    return yield* svc.read(absPath);
  }).pipe(Effect.provide(PreviewService.layerTest(mem.fs, testHomedir, maxBytes, maxLines)));

/** Narrow a read result to a text record, failing loudly if it came back as an image. */
const asText = (d: PreviewData): TextPreview => {
  if (d.kind !== "text") throw new Error(`expected text preview, got "${d.kind}"`);
  return d;
};

it.effect("read returns the display record for a readable file", () =>
  Effect.gen(function* () {
    const mem = makeMemFs({ "/abs/file.md": "# Hello" });
    const data = yield* runRead(mem, "/abs/file.md");
    assert.deepStrictEqual(data, {
      kind: "text",
      path: "/abs/file.md",
      content: "# Hello",
      lang: "markdown",
      truncated: false,
    });
  }),
);

it.effect("read computes a code language hint from the path", () =>
  Effect.gen(function* () {
    const mem = makeMemFs({ "/abs/main.ts": "const x = 1;\n" });
    const data = asText(yield* runRead(mem, "/abs/main.ts"));
    assert.strictEqual(data.lang, "typescript");
    assert.strictEqual(data.truncated, false);
  }),
);

it.effect("read truncates content at the injected byte cap and reports truncated", () =>
  Effect.gen(function* () {
    const mem = makeMemFs({ "/abs/big.txt": "abcdef" });
    const data = asText(yield* runRead(mem, "/abs/big.txt", 5));
    assert.strictEqual(data.content, "abcde");
    assert.strictEqual(data.truncated, true);
  }),
);

it.effect("read does not split a multi-byte character at the injected byte cap", () =>
  Effect.gen(function* () {
    const mem = makeMemFs({ "/abs/uni.txt": "€€€" });
    const data = asText(yield* runRead(mem, "/abs/uni.txt", 4));
    assert.strictEqual(data.content, "€");
    assert.strictEqual(data.truncated, true);
  }),
);

it.effect("read truncates content at the injected line cap and reports truncated", () =>
  Effect.gen(function* () {
    const mem = makeMemFs({ "/abs/lines.txt": "a\nb\nc\nd" });
    const data = asText(yield* runRead(mem, "/abs/lines.txt", 100, 3));
    assert.strictEqual(data.content, "a\nb\nc");
    assert.strictEqual(data.truncated, true);
  }),
);

it.effect("read leaves content untruncated at the exact byte and line caps", () =>
  Effect.gen(function* () {
    const mem = makeMemFs({ "/abs/at.txt": "abcde" });
    const data = asText(yield* runRead(mem, "/abs/at.txt", 5, 2000));
    assert.strictEqual(data.content, "abcde");
    assert.strictEqual(data.truncated, false);
  }),
);

// ---------------------------------------------------------------------------
// Image preview — mime detection and image read behavior
// ---------------------------------------------------------------------------

it("mimeFromPath maps supported image extensions to their MIME type", () => {
  assert.strictEqual(mimeFromPath("/a/pic.png"), "image/png");
  assert.strictEqual(mimeFromPath("/a/pic.jpg"), "image/jpeg");
  assert.strictEqual(mimeFromPath("/a/pic.jpeg"), "image/jpeg");
  assert.strictEqual(mimeFromPath("/a/pic.gif"), "image/gif");
  assert.strictEqual(mimeFromPath("/a/pic.webp"), "image/webp");
  assert.strictEqual(mimeFromPath("/a/pic.avif"), "image/avif");
  assert.strictEqual(mimeFromPath("/a/PIC.PNG"), "image/png"); // case-insensitive
  assert.strictEqual(mimeFromPath("/a/notes.txt"), undefined);
  assert.strictEqual(mimeFromPath("/a/noext"), undefined);
  assert.strictEqual(mimeFromPath("/a/pic.svg"), undefined); // unsupported by pi-tui Image
});

it("bytesToBase64 round-trips through atob for ASCII and binary bytes", () => {
  assert.strictEqual(bytesToBase64(encode("abc")), "YWJj");
  const round = new Uint8Array(atob(bytesToBase64(PNG_BYTES)).split("").map((c) => c.charCodeAt(0)));
  assert.deepStrictEqual(round, PNG_BYTES);
  assert.strictEqual(bytesToBase64(PNG_BYTES), PNG_BASE64);
});

it.effect("read returns an image record with mime, base64, and detected dimensions", () =>
  Effect.gen(function* () {
    const mem = makeMemFs({}, { "/abs/pic.png": PNG_BYTES });
    const data = yield* runRead(mem, "/abs/pic.png");
    assert.strictEqual(data.kind, "image");
    if (data.kind !== "image") return;
    assert.strictEqual(data.path, "/abs/pic.png");
    assert.strictEqual(data.mimeType, "image/png");
    assert.strictEqual(data.base64, PNG_BASE64);
    assert.deepStrictEqual(data.dimensions, { widthPx: 512, heightPx: 256 });
    assert.strictEqual(data.truncated, false);
  }),
);

it("getAvifDimensions parses the ispe box from an AVIF file", () => {
  assert.deepStrictEqual(getAvifDimensions(AVIF_BYTES), { widthPx: 512, heightPx: 256 });
  const tall = buildAvif(64, 128);
  assert.deepStrictEqual(getAvifDimensions(tall), { widthPx: 64, heightPx: 128 });
  assert.strictEqual(getAvifDimensions(new Uint8Array([1, 2, 3])), null); // no boxes
  assert.strictEqual(getAvifDimensions(new Uint8Array()), null);
  // A zero-sized ispe (width/height of 0) parses to null.
  const ftypOnly = buildAvif(0, 0);
  assert.strictEqual(getAvifDimensions(ftypOnly), null);
});

it.effect("read returns an AVIF image record with parsed dimensions", () =>
  Effect.gen(function* () {
    const mem = makeMemFs({}, { "/abs/pic.avif": AVIF_BYTES });
    const data = yield* runRead(mem, "/abs/pic.avif");
    assert.strictEqual(data.kind, "image");
    if (data.kind !== "image") return;
    assert.strictEqual(data.mimeType, "image/avif");
    assert.deepStrictEqual(data.dimensions, { widthPx: 512, heightPx: 256 });
    assert.strictEqual(data.truncated, false);
  }),
);


it.effect("read routes jpeg/gif/webp extensions to image records", () =>
  Effect.gen(function* () {
    const mem = makeMemFs({}, { "/a/x.jpg": PNG_BYTES, "/a/y.gif": PNG_BYTES, "/a/z.webp": PNG_BYTES });
    const jpeg = yield* runRead(mem, "/a/x.jpg");
    const gif = yield* runRead(mem, "/a/y.gif");
    const webp = yield* runRead(mem, "/a/z.webp");
    assert.strictEqual(jpeg.kind, "image");
    assert.strictEqual(gif.kind, "image");
    assert.strictEqual(webp.kind, "image");
    if (jpeg.kind === "image") assert.strictEqual(jpeg.mimeType, "image/jpeg");
    if (gif.kind === "image") assert.strictEqual(gif.mimeType, "image/gif");
    if (webp.kind === "image") assert.strictEqual(webp.mimeType, "image/webp");
  }),
);

it.effect("read does not apply byte/line caps to image files", () =>
  Effect.gen(function* () {
    const mem = makeMemFs({}, { "/a/big.png": PNG_BYTES });
    const data = yield* runRead(mem, "/a/big.png", 4);
    assert.strictEqual(data.kind, "image");
    if (data.kind !== "image") return;
    assert.strictEqual(data.base64, PNG_BASE64);
    assert.strictEqual(data.truncated, false);
  }),
);

it.effect("read fails with PreviewReadError when an image file is missing", () =>
  Effect.gen(function* () {
    const mem = makeMemFs();
    const err = yield* runRead(mem, "/missing.png").pipe(
      Effect.match({
        onFailure: (e) => e,
        onSuccess: () => undefined,
      }),
    );
    assert.ok(err instanceof PreviewReadError);
    assert.strictEqual(err.path, "/missing.png");
  }),
);

it.effect("read fails with PreviewReadError when the file is missing", () =>
  Effect.gen(function* () {
    const mem = makeMemFs();
    const tag = yield* runRead(mem, "/missing.md").pipe(
      Effect.match({
        onFailure: (err) => err._tag,
        onSuccess: () => "unexpected-success",
      }),
    );
    assert.strictEqual(tag, "PreviewReadError");

    const err = yield* runRead(mem, "/missing.md").pipe(
      Effect.match({
        onFailure: (e) => e,
        onSuccess: () => undefined,
      }),
    );
    assert.ok(err instanceof PreviewReadError);
    assert.strictEqual(err.path, "/missing.md");
    assert.strictEqual(typeof err.message === "string" && err.message.length > 0, true);
  }),
);

it.effect("read fails with PreviewReadError on a permission error", () =>
  Effect.gen(function* () {
    const deniedFs: Partial<FileSystem.FileSystem> = {
      readFileString: () =>
        Effect.fail(
          PlatformError.systemError({
            _tag: "PermissionDenied",
            module: "FileSystem",
            method: "readFileString",
            pathOrDescriptor: "/denied.md",
            description: "cannot read",
          }),
        ),
    };
    const mem: MemFs = { fs: deniedFs, files: new Map() };
    const err = yield* runRead(mem, "/denied.md").pipe(
      Effect.match({
        onFailure: (e) => e,
        onSuccess: () => undefined,
      }),
    );
    assert.ok(err instanceof PreviewReadError);
    assert.strictEqual(err.path, "/denied.md");
  }),
);

it("PreviewReadError carries the expected tag and fields", () => {
  const err = new PreviewReadError({ path: "/x", message: "boom" });
  assert.strictEqual(err._tag, "PreviewReadError");
  assert.instanceOf(err, PreviewReadError);
  assert.strictEqual(err.path, "/x");
  assert.strictEqual(err.message, "boom");
});

// ---------------------------------------------------------------------------
// Slice 4 — preview tool registration behavior
// ---------------------------------------------------------------------------

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

class FakePi {
  readonly tools: Array<ToolDefinition<any, any, any>> = [];
  readonly commands: Array<{
    name: string;
    handler: (args: string, ctx: any) => Promise<void>;
  }> = [];
  readonly renderers: Array<{
    type: string;
    renderer: (entry: any, options: any, theme: any) => any;
  }> = [];
  readonly entries: Array<{ type: string; data?: unknown }> = [];
  readonly toolResultHandlers: Array<(event: any) => any> = [];
  registerTool(tool: ToolDefinition<any, any, any>): void {
    this.tools.push(tool);
  }
  registerCommand(name: string, options: any): void {
    this.commands.push({ name, ...options });
  }
  registerEntryRenderer(type: string, renderer: any): void {
    this.renderers.push({ type, renderer });
  }
  appendEntry<T = unknown>(type: string, data?: T): void {
    this.entries.push({ type, data });
  }
  on(event: string, handler: any): void {
    if (event === "tool_result") this.toolResultHandlers.push(handler);
  }
}

/** Build a Context.Context containing a PreviewService over the injected mem fs. */
const makePreviewContext = (
  mem: MemFs,
  maxBytes?: number,
  maxLines?: number,
): Context.Context<PreviewService> =>
  Effect.runSync(
    Effect.context<PreviewService>().pipe(
      Effect.provide(PreviewService.layerTest(mem.fs, testHomedir, maxBytes, maxLines)),
    ),
  );

const registerTool = (mem: MemFs = makeMemFs()) => {
  const pi = new FakePi();
  registerPreview(pi as unknown as ExtensionAPI, makePreviewContext(mem));
  return pi.tools[0]!;
};

it("the preview tool registers with the preview name and a path parameter", () => {
  const tool = registerTool();
  assert.strictEqual(tool.name, "preview");
  assert.strictEqual(tool.parameters.properties.path.type, "string");
});

it("tool execute returns the exact confirmation stub and the display record for a readable file", async () => {
  const tool = registerTool(makeMemFs({ "/cwd/src/file.md": "# Title" }));
  const ctx = { cwd: "/cwd" } as ExtensionContext;
  const result = await tool.execute("call-1", { path: "src/file.md" }, undefined, undefined, ctx);
  assert.strictEqual(
    (result.content[0] as { type: "text"; text: string }).text,
    "[Preview shown to user: src/file.md]",
  );
  assert.deepStrictEqual(result.details, {
    kind: "text",
    path: "/cwd/src/file.md",
    content: "# Title",
    lang: "markdown",
    truncated: false,
  });
});

it("tool execute keeps the model stub for images and returns an image detail record", async () => {
  const tool = registerTool(makeMemFs({}, { "/cwd/pic.png": PNG_BYTES }));
  const ctx = { cwd: "/cwd" } as ExtensionContext;
  const result = await tool.execute("call-1", { path: "pic.png" }, undefined, undefined, ctx);
  assert.strictEqual(
    (result.content[0] as { type: "text"; text: string }).text,
    "[Preview shown to user: pic.png]",
  );
  // pi-native image block so the TUI renders the picture through its own pipeline.
  // The block is what the model sees too (pi auto-resizes it for provider requests).
  assert.deepStrictEqual(result.content[1], {
    type: "image",
    data: PNG_BASE64,
    mimeType: "image/png",
  });
  const details = result.details as { kind: string; base64?: string; mimeType?: string };
  assert.strictEqual(details.kind, "image");
  assert.strictEqual(details.mimeType, "image/png");
  assert.strictEqual(details.base64, PNG_BASE64);
});

it("tool execute returns only the text stub for text files (no image block)", async () => {
  const tool = registerTool(makeMemFs({ "/cwd/file.md": "# Title" }));
  const ctx = { cwd: "/cwd" } as ExtensionContext;
  const result = await tool.execute("call-1", { path: "file.md" }, undefined, undefined, ctx);
  assert.strictEqual(result.content.length, 1);
  assert.strictEqual((result.content[0] as { type: string }).type, "text");
});

it("tool execute resolves relative paths against the tool context cwd", async () => {
  const tool = registerTool(makeMemFs({ "/cwd/src/file.md": "# Title" }));
  const ctx = { cwd: "/cwd" } as ExtensionContext;
  const result = await tool.execute("call-1", { path: "src/file.md" }, undefined, undefined, ctx);
  assert.strictEqual(result.details.path, "/cwd/src/file.md");
});

it("tool execute returns the exact failure stub and error details when the read fails", async () => {
  const tool = registerTool();
  const ctx = { cwd: "/cwd" } as ExtensionContext;
  const result = await tool.execute("call-1", { path: "missing.md" }, undefined, undefined, ctx);
  const expectedMessage = PlatformError.systemError({
    _tag: "NotFound",
    module: "FileSystem",
    method: "readFileString",
    pathOrDescriptor: "/cwd/missing.md",
    description: "No such file",
  }).message;
  assert.strictEqual(
    (result.content[0] as { type: "text"; text: string }).text,
    `preview failed: ${expectedMessage}`,
  );
  assert.deepStrictEqual(result.details, {
    path: "missing.md",
    kind: "text",
    content: "",
    lang: undefined,
    truncated: false,
    error: expectedMessage,
  });
});

it("tool execute reports the failure stub when the reference is unresolvable", async () => {
  const tool = registerTool();
  const ctx = { cwd: "/cwd" } as ExtensionContext;
  const result = await tool.execute(
    "call-1",
    { path: "file://host/path" },
    undefined,
    undefined,
    ctx,
  );
  assert.strictEqual(
    (result.content[0] as { type: "text"; text: string }).text.startsWith("preview failed: "),
    true,
  );
  assert.strictEqual(
    typeof result.details.error === "string" && result.details.error.length > 0,
    true,
  );
});

it("renderBodyComponent renders markdown content with the Markdown component when the language hint is markdown", () => {
  const data = { kind: "text" as const, path: "/a.md", content: "# Hi", lang: "markdown", truncated: false };
  const out = renderBodyComponent(data, true, theme);
  assert.instanceOf(out, Markdown);
});

it("renderBodyComponent renders code content with the Text component when the language hint is not markdown", () => {
  const data = { kind: "text" as const, path: "/a.ts", content: "const x = 1;", lang: "typescript", truncated: false };
  const out = renderBodyComponent(data, true, theme);
  assert.instanceOf(out, Text);
});

it("renderBodyComponent collapses code content to the collapsed line count when not expanded", () => {
  const content = Array.from({ length: 45 }, (_, i) => `line ${i + 1}`).join("\n");
  const data = { kind: "text" as const, path: "/a.ts", content, lang: "typescript", truncated: false };
  const out = renderBodyComponent(data, false, theme);
  assert.instanceOf(out, Text);
  assert.strictEqual(
    out.render(200).join("\n").includes("... (5 lines shown, expand to view all)"),
    true,
  );
});

it("renderBodyComponent appends the truncated note for a truncated expanded record", () => {
  const data = { kind: "text" as const, path: "/a.md", content: "# Hi", lang: "markdown", truncated: true };
  const out = renderBodyComponent(data, true, theme);
  assert.instanceOf(out, Markdown);
  assert.strictEqual(out.render(200).join("\n").includes("... (truncated preview)"), true);
});

it("renderBodyComponent appends the more-lines note for a collapsed markdown record", () => {
  const content = Array.from({ length: 41 }, (_, i) => `line ${i + 1}`).join("\n");
  const data = { kind: "text" as const, path: "/a.md", content, lang: "markdown", truncated: false };
  const out = renderBodyComponent(data, false, theme);
  assert.instanceOf(out, Markdown);
  assert.strictEqual(
    out.render(200).join("\n").includes("... (1 more lines, expand to view all)"),
    true,
  );
});

it("renderBodyComponent renders image data with the Image component", () => {
  const data = {
    kind: "image" as const,
    path: "/a/pic.png",
    mimeType: "image/png",
    base64: PNG_BASE64,
    dimensions: { widthPx: 512, heightPx: 256 },
    truncated: false,
  };
  const out = renderBodyComponent(data, true, theme);
  assert.instanceOf(out, Image);
});

it("renderBodyComponent image falls back to a text notice when the terminal lacks image support", () => {
  setCapabilities({ images: null, trueColor: false, hyperlinks: false });
  try {
    const data = {
      kind: "image" as const,
      path: "/a/pic.png",
      mimeType: "image/png",
      base64: PNG_BASE64,
      dimensions: { widthPx: 512, heightPx: 256 },
      truncated: false,
    };
    const out = renderBodyComponent(data, true, theme);
    assert.instanceOf(out, Image);
    const lines = out.render(200).join("\n");
    assert.strictEqual(lines.includes("/a/pic.png"), true);
    assert.strictEqual(lines.includes("image/png"), true);
    assert.strictEqual(lines.includes("512x256"), true);
  } finally {
    resetCapabilitiesCache();
  }
});

it("renderBodyComponent image emits a kitty sequence when the terminal supports images", () => {
  setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
  try {
    const data = {
      kind: "image" as const,
      path: "/a/pic.png",
      mimeType: "image/png",
      base64: PNG_BASE64,
      dimensions: { widthPx: 512, heightPx: 256 },
      truncated: false,
    };
    const out = renderBodyComponent(data, true, theme);
    assert.instanceOf(out, Image);
    const lines = out.render(200);
    assert.strictEqual(lines[0]?.startsWith("\x1b_G"), true);
    assert.ok(lines.length >= 1);
  } finally {
    resetCapabilitiesCache();
  }
});

it("the preview tool renders its own shell instead of pi's standard tool box", () => {
  const tool = registerTool();
  assert.strictEqual(tool.renderShell, "self");
});

it("renderCall renders the preview tool title and the path argument", () => {
  const tool = registerTool();
  const out = tool.renderCall!({ path: "/abs/x.ts" }, theme, {} as any);
  assert.ok(isComponent(out));
  const rendered = out.render(200).join("\n");
  assert.strictEqual(rendered.startsWith("╭"), true); // borders, not raw text
  assert.strictEqual(rendered.includes("preview"), true);
  assert.strictEqual(rendered.includes("/abs/x.ts"), true);
});

it("renderResult falls back to the last component when the details are missing", () => {
  const tool = registerTool();
  const result = { content: [], details: undefined } as any;
  const last = new Text("last", 0, 0);
  const out = tool.renderResult!(result, { expanded: true, isPartial: false }, theme, {
    lastComponent: last,
  } as any);
  assert.strictEqual(out, last);
  const fallback = tool.renderResult!(
    result,
    { expanded: true, isPartial: false },
    theme,
    {} as any,
  );
  assert.instanceOf(fallback, Text);
});

it("renderResult renders the warning box for an error result", () => {
  const tool = registerTool();
  const result = {
    content: [],
    details: { kind: "text", path: "/x", content: "", lang: undefined, truncated: false, error: "boom" },
  } as any;
  const out = tool.renderResult!(result, { expanded: true, isPartial: false }, theme, {} as any);
  assert.ok(isComponent(out));
  assert.strictEqual(out.render(200).join("\n").startsWith("╭"), true); // bordered warning box
  assert.strictEqual(out.render(200).join("\n").includes("preview failed: boom"), true);
});

it("renderResult renders the body in a bordered box for a success result", () => {
  const tool = registerTool();
  const record = { kind: "text", path: "/a.md", content: "# Hi", lang: "markdown", truncated: false };
  const out = tool.renderResult!(
    { content: [], details: record } as any,
    { expanded: true, isPartial: false },
    theme,
    {} as any,
  );
  assert.ok(isComponent(out));
  assert.strictEqual(out.render(200).join("\n").startsWith("╭"), true); // bordered body
  assert.strictEqual(out.render(200).join("\n").includes("Hi"), true);
});

it("renderResult draws an image caption and leaves pixel drawing to pi's native content blocks", () => {
  const tool = registerTool();
  const record = {
    kind: "image" as const,
    path: "/a/pic.png",
    mimeType: "image/png",
    base64: PNG_BASE64,
    dimensions: { widthPx: 512, heightPx: 256 },
    truncated: false,
  };
  const out = tool.renderResult!(
    { content: [], details: record } as any,
    { expanded: true, isPartial: false },
    theme,
    {} as any,
  );
  assert.ok(isComponent(out));
  const rendered = out.render(200).join("\n");
  assert.strictEqual(rendered.startsWith("╭"), true); // caption box
  assert.strictEqual(rendered.includes("/a/pic.png"), true);
  assert.strictEqual(rendered.includes("512x256"), true);
  // No raw kitty transmission from the renderer — pi renders the image natively.
  assert.strictEqual(rendered.includes("\x1b_G"), false);
});

it("the model stub and image block both reach the model (image stays in content)", async () => {
  // The image block is intentional: it is what makes the TUI render the picture
  // through pi's native pipeline, and pi auto-resizes it for provider requests.
  const pi = new FakePi();
  registerPreview(pi as unknown as ExtensionAPI, makePreviewContext(makeMemFs()));
  assert.strictEqual(pi.toolResultHandlers.length, 0, "no tool_result hook registered");
});

// ---------------------------------------------------------------------------
// Slice 5 — preview command and entry renderer behavior
// ---------------------------------------------------------------------------

interface NotifySpy {
  readonly calls: Array<[string, string]>;
  readonly ctx: any;
}

const makeCommandCtx = (): NotifySpy => {
  const calls: Array<[string, string]> = [];
  const ctx = {
    cwd: "/cwd",
    ui: {
      notify: (msg: string, level: string) => {
        calls.push([msg, level]);
      },
    },
  };
  return { calls, ctx };
};

const registerCommand = (mem: MemFs = makeMemFs()) => {
  const pi = new FakePi();
  registerPreview(pi as unknown as ExtensionAPI, makePreviewContext(mem));
  return { pi, handler: pi.commands.find((c) => c.name === "preview")!.handler };
};

it("the preview command notifies the usage warning when the argument is empty", async () => {
  const { pi, handler } = registerCommand();
  const { calls, ctx } = makeCommandCtx();
  await handler("   ", ctx);
  assert.strictEqual(calls.length, 1);
  assert.deepStrictEqual(calls[0], ["usage: /preview <path>", "warning"]);
  assert.strictEqual(pi.entries.length, 0);
});

it("the preview command appends the display record as a custom entry on success", async () => {
  const mem = makeMemFs({ "/cwd/file.md": "# Hi" });
  const { pi, handler } = registerCommand(mem);
  const { calls, ctx } = makeCommandCtx();
  await handler("/cwd/file.md", ctx);
  assert.deepStrictEqual(pi.entries, [
    {
      type: "preview",
      data: { kind: "text", path: "/cwd/file.md", content: "# Hi", lang: "markdown", truncated: false },
    },
  ]);
  assert.strictEqual(calls.length, 0);
});

it("the preview command resolves relative paths before reading", async () => {
  const mem = makeMemFs({ "/cwd/file.md": "# Hi" });
  const { pi, handler } = registerCommand(mem);
  const { ctx } = makeCommandCtx();
  await handler("file.md", ctx);
  assert.strictEqual((pi.entries[0]!.data as { path: string }).path, "/cwd/file.md");
});

it("the preview command notifies the error message when the read fails", async () => {
  const { pi, handler } = registerCommand();
  const { calls, ctx } = makeCommandCtx();
  await handler("missing.md", ctx);
  const expectedMessage = PlatformError.systemError({
    _tag: "NotFound",
    module: "FileSystem",
    method: "readFileString",
    pathOrDescriptor: "/cwd/missing.md",
    description: "No such file",
  }).message;
  assert.strictEqual(calls.length, 1);
  assert.deepStrictEqual(calls[0], [`preview failed: ${expectedMessage}`, "error"]);
  assert.strictEqual(pi.entries.length, 0);
});

it("the preview command notifies the error message when the reference is unresolvable", async () => {
  const { pi, handler } = registerCommand();
  const { calls, ctx } = makeCommandCtx();
  await handler("file://host/path", ctx);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0]![0].startsWith("preview failed: "), true);
  assert.strictEqual(calls[0]![1], "error");
  assert.strictEqual(pi.entries.length, 0);
});

it("the entry renderer renders a warning bordered box when the entry has no data", () => {
  const pi = new FakePi();
  registerPreview(pi as unknown as ExtensionAPI, makePreviewContext(makeMemFs()));
  const renderer = pi.renderers.find((r) => r.type === "preview")!.renderer;
  const out = renderer({ data: undefined }, { expanded: true }, theme);
  assert.ok(isComponent(out));
  assert.strictEqual(out.render(200).join("\n").startsWith("╭"), true); // bordered warning box
  assert.strictEqual(out.render(200).join("\n").includes("[preview] no data"), true);
});

it("the entry renderer renders the path header and the body inside a bordered box when the entry has data", () => {
  const pi = new FakePi();
  registerPreview(pi as unknown as ExtensionAPI, makePreviewContext(makeMemFs()));
  const renderer = pi.renderers.find((r) => r.type === "preview")!.renderer;
  const out = renderer(
    { data: { kind: "text", path: "/abs/a.md", content: "# Hi", lang: "markdown", truncated: false } },
    { expanded: true },
    theme,
  );
  assert.ok(isComponent(out));
  const rendered = out.render(200).join("\n");
  assert.strictEqual(rendered.startsWith("╭"), true); // bordered body
  assert.strictEqual(rendered.includes("/abs/a.md"), true);
  assert.strictEqual(rendered.includes("Hi"), true);
});

it("the entry renderer draws image entries as caption box + spacer + bare kitty transmission", () => {
  setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
  try {
    const pi = new FakePi();
    registerPreview(pi as unknown as ExtensionAPI, makePreviewContext(makeMemFs()));
    const renderer = pi.renderers.find((r) => r.type === "preview")!.renderer;
    const out = renderer(
      {
        data: {
          kind: "image",
          path: "/abs/pic.png",
          mimeType: "image/png",
          base64: PNG_BASE64,
          dimensions: { widthPx: 512, heightPx: 256 },
          truncated: false,
        },
      },
      { expanded: true },
      theme,
    );
    assert.ok(isComponent(out));
    const lines = out.render(200);
    const rendered = lines.join("\n");
    // Caption box on top…
    assert.strictEqual(rendered.startsWith("╭"), true);
    assert.strictEqual(rendered.includes("/abs/pic.png"), true);
    // …then a blank spacer row…
    const boxRows = rendered.split("\n");
    assert.strictEqual(boxRows.includes(""), true);
    // …then the kitty transmission on its own line (no rail prefix, no box glyph before \x1b_G).
    assert.strictEqual(lines.some((l: string) => l.startsWith("\x1b_G")), true);
    assert.strictEqual(
      lines.some((l: string) => l.includes("│ \x1b_G") || l.includes("╭ \x1b_G") || /[╭─╰╯]\x1b_G/.test(l)),
      false,
    );
  } finally {
    resetCapabilitiesCache();
  }
});
