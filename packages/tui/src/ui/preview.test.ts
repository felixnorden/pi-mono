import { assert, it } from "@effect/vitest";
import type {
  ExtensionAPI,
  ExtensionContext,
  Theme,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { Markdown, Text } from "@earendil-works/pi-tui";
import { Context, Effect, PlatformError } from "effect";
import * as FileSystem from "effect/FileSystem";
import type { Component } from "@earendil-works/pi-tui";
import {
  capContent,
  COLLAPSED_LINES,
  MAX_BYTES,
  MAX_LINES,
  PreviewReadError,
  PreviewService,
  renderBodyComponent,
  registerPreview,
  sliceUtf8,
} from "./preview.ts";

// The Markdown component reads pi's global theme at render time.
initTheme();

const HOMEDIR = "/home/test";
const testHomedir = () => HOMEDIR;
const encode = (raw: string) => new TextEncoder().encode(raw);

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

const runRead = (mem: MemFs, absPath: string, maxBytes?: number, maxLines?: number) =>
  Effect.gen(function* () {
    const svc = yield* PreviewService;
    return yield* svc.read(absPath);
  }).pipe(Effect.provide(PreviewService.layerTest(mem.fs, testHomedir, maxBytes, maxLines)));

it.effect("read returns the display record for a readable file", () =>
  Effect.gen(function* () {
    const mem = makeMemFs({ "/abs/file.md": "# Hello" });
    const data = yield* runRead(mem, "/abs/file.md");
    assert.deepStrictEqual(data, {
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
    const data = yield* runRead(mem, "/abs/main.ts");
    assert.strictEqual(data.lang, "typescript");
    assert.strictEqual(data.truncated, false);
  }),
);

it.effect("read truncates content at the injected byte cap and reports truncated", () =>
  Effect.gen(function* () {
    const mem = makeMemFs({ "/abs/big.txt": "abcdef" });
    const data = yield* runRead(mem, "/abs/big.txt", 5);
    assert.strictEqual(data.content, "abcde");
    assert.strictEqual(data.truncated, true);
  }),
);

it.effect("read does not split a multi-byte character at the injected byte cap", () =>
  Effect.gen(function* () {
    const mem = makeMemFs({ "/abs/uni.txt": "€€€" });
    const data = yield* runRead(mem, "/abs/uni.txt", 4);
    assert.strictEqual(data.content, "€");
    assert.strictEqual(data.truncated, true);
  }),
);

it.effect("read truncates content at the injected line cap and reports truncated", () =>
  Effect.gen(function* () {
    const mem = makeMemFs({ "/abs/lines.txt": "a\nb\nc\nd" });
    const data = yield* runRead(mem, "/abs/lines.txt", 100, 3);
    assert.strictEqual(data.content, "a\nb\nc");
    assert.strictEqual(data.truncated, true);
  }),
);

it.effect("read leaves content untruncated at the exact byte and line caps", () =>
  Effect.gen(function* () {
    const mem = makeMemFs({ "/abs/at.txt": "abcde" });
    const data = yield* runRead(mem, "/abs/at.txt", 5, 2000);
    assert.strictEqual(data.content, "abcde");
    assert.strictEqual(data.truncated, false);
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
    path: "/cwd/src/file.md",
    content: "# Title",
    lang: "markdown",
    truncated: false,
  });
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
  const data = { path: "/a.md", content: "# Hi", lang: "markdown", truncated: false };
  const out = renderBodyComponent(data, true, theme);
  assert.instanceOf(out, Markdown);
});

it("renderBodyComponent renders code content with the Text component when the language hint is not markdown", () => {
  const data = { path: "/a.ts", content: "const x = 1;", lang: "typescript", truncated: false };
  const out = renderBodyComponent(data, true, theme);
  assert.instanceOf(out, Text);
});

it("renderBodyComponent collapses code content to the collapsed line count when not expanded", () => {
  const content = Array.from({ length: 45 }, (_, i) => `line ${i + 1}`).join("\n");
  const data = { path: "/a.ts", content, lang: "typescript", truncated: false };
  const out = renderBodyComponent(data, false, theme);
  assert.instanceOf(out, Text);
  assert.strictEqual(
    out.render(200).join("\n").includes("... (5 lines shown, expand to view all)"),
    true,
  );
});

it("renderBodyComponent appends the truncated note for a truncated expanded record", () => {
  const data = { path: "/a.md", content: "# Hi", lang: "markdown", truncated: true };
  const out = renderBodyComponent(data, true, theme);
  assert.instanceOf(out, Markdown);
  assert.strictEqual(out.render(200).join("\n").includes("... (truncated preview)"), true);
});

it("renderBodyComponent appends the more-lines note for a collapsed markdown record", () => {
  const content = Array.from({ length: 41 }, (_, i) => `line ${i + 1}`).join("\n");
  const data = { path: "/a.md", content, lang: "markdown", truncated: false };
  const out = renderBodyComponent(data, false, theme);
  assert.instanceOf(out, Markdown);
  assert.strictEqual(
    out.render(200).join("\n").includes("... (1 more lines, expand to view all)"),
    true,
  );
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
    details: { path: "/x", content: "", lang: undefined, truncated: false, error: "boom" },
  } as any;
  const out = tool.renderResult!(result, { expanded: true, isPartial: false }, theme, {} as any);
  assert.ok(isComponent(out));
  assert.strictEqual(out.render(200).join("\n").startsWith("╭"), true); // bordered warning box
  assert.strictEqual(out.render(200).join("\n").includes("preview failed: boom"), true);
});

it("renderResult renders the body in a bordered box for a success result", () => {
  const tool = registerTool();
  const record = { path: "/a.md", content: "# Hi", lang: "markdown", truncated: false };
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
      data: { path: "/cwd/file.md", content: "# Hi", lang: "markdown", truncated: false },
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
    { data: { path: "/abs/a.md", content: "# Hi", lang: "markdown", truncated: false } },
    { expanded: true },
    theme,
  );
  assert.ok(isComponent(out));
  const rendered = out.render(200).join("\n");
  assert.strictEqual(rendered.startsWith("╭"), true); // bordered body
  assert.strictEqual(rendered.includes("/abs/a.md"), true);
  assert.strictEqual(rendered.includes("Hi"), true);
});
