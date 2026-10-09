import { assert, it } from "@effect/vitest";
import {
  containsSymbol,
  documentPathsOf,
  emptyFootprint,
  fingerprintOf,
  knownTextOf,
  producedTextOf,
  resolveProduct,
  resolveReference,
  spanTextOf,
  type BatchFootprint,
  type FileProbe,
} from "./observations.ts";

/** A probe over a path-to-text map. `findSymbol` scans the same map. */
const probeOf = (files: Readonly<Record<string, string>>): FileProbe => ({
  read: (path) => files[path],
  findSymbol: (symbol) =>
    Object.entries(files)
      .filter(([, text]) => containsSymbol(text, symbol))
      .map(([path]) => path),
});

const footprintWith = (overrides: Partial<BatchFootprint>): BatchFootprint => ({
  ...emptyFootprint(),
  ...overrides,
});

it("documentPathsOf dedupes paths and prefers the longest extension", () => {
  assert.deepStrictEqual(documentPathsOf("see .qrspi/designs/a.md and src/b.jsonc, src/b.jsonc"), [
    ".qrspi/designs/a.md",
    "src/b.jsonc",
  ]);
  assert.deepStrictEqual(documentPathsOf("no paths here"), []);
});

it("knownTextOf joins the batch and the bounded record fields", () => {
  const known = knownTextOf(
    ["batch text"],
    [
      { kind: "tool-call", text: "{}", name: "write", args: { path: "src/written.ts" } },
      { kind: "assistant", text: "prose" },
    ],
  );
  assert.include(known, "batch text");
  assert.include(known, "src/written.ts");
  assert.include(known, "prose");
});

it("producedTextOf reads only write and edit call paths", () => {
  const produced = producedTextOf([
    { kind: "tool-call", text: "{}", name: "write", args: { path: "src/written.ts" } },
    { kind: "tool-call", text: "{}", name: "edit", args: { path: "src/edited.ts" } },
    { kind: "tool-call", text: "{}", name: "read", args: { path: "src/read.ts" } },
    { kind: "tool-result", text: "src/result.ts" },
  ]);
  assert.include(produced, "src/written.ts");
  assert.include(produced, "src/edited.ts");
  assert.notInclude(produced, "src/read.ts");
  assert.notInclude(produced, "src/result.ts");
});

it("fingerprintOf is stable and separates different text", () => {
  assert.strictEqual(fingerprintOf("const a = 1;"), fingerprintOf("const a = 1;"));
  assert.notStrictEqual(fingerprintOf("const a = 1;"), fingerprintOf("const a = 2;"));
});

it("spanTextOf reads one range and several, and rejects a short file", () => {
  const text = ["one", "two", "three", "four"].join("\n");
  assert.strictEqual(spanTextOf(text, "2"), "two");
  assert.strictEqual(spanTextOf(text, "2-3"), "two\nthree");
  assert.strictEqual(spanTextOf(text, "1,4"), "one\nfour");
  assert.isUndefined(spanTextOf(text, "5"));
  assert.isUndefined(spanTextOf(text, "3-2"));
  assert.isUndefined(spanTextOf(text, "x"));
});

it("containsSymbol matches tokens, not substrings", () => {
  assert.isTrue(containsSymbol("const route = 1;", "route"));
  assert.isTrue(containsSymbol("route(x)", "route"));
  assert.isFalse(containsSymbol("const router = 1;", "route"));
  assert.isFalse(containsSymbol("", "route"));
});

it("a path reference is readable when the file exists", () => {
  const resolved = resolveReference(
    { kind: "path", path: "src/a.ts" },
    emptyFootprint(),
    probeOf({ "src/a.ts": "export {};" }),
  );
  assert.strictEqual(resolved.state, "readable");
});

it("a missing path is lost only when the batch removed it", () => {
  const reference = { kind: "path", path: "src/a.ts" } as const;
  assert.strictEqual(
    resolveReference(reference, footprintWith({ deleted: [{ path: "src/a.ts" }] }), probeOf({}))
      .state,
    "lost",
  );
  assert.strictEqual(
    resolveReference(reference, emptyFootprint(), probeOf({})).state,
    "unresolved",
  );
});

it("a declared span resolves against the recorded fingerprint", () => {
  const reference = { kind: "path", path: "src/a.ts", span: "1-1" } as const;
  const probe = probeOf({ "src/a.ts": "new" });
  assert.strictEqual(
    resolveReference(
      reference,
      footprintWith({
        wrote: [{ path: "src/a.ts", spans: ["1-1"], fingerprint: fingerprintOf("old") }],
      }),
      probe,
    ).state,
    "drifted",
  );
  assert.strictEqual(
    resolveReference(
      reference,
      footprintWith({
        wrote: [{ path: "src/a.ts", spans: ["1-1"], fingerprint: fingerprintOf("new") }],
      }),
      probe,
    ).state,
    "readable",
  );
});

it("a span past the end of the file is drifted", () => {
  const resolved = resolveReference(
    { kind: "path", path: "src/a.ts", span: "9" },
    emptyFootprint(),
    probeOf({ "src/a.ts": "one" }),
  );
  assert.strictEqual(resolved.state, "drifted");
});

it("a symbol resolves in the named file first, then one workspace file", () => {
  const reference = { kind: "path", path: "src/a.ts", symbol: "route" } as const;
  assert.strictEqual(
    resolveReference(reference, emptyFootprint(), probeOf({ "src/a.ts": "route()" })).state,
    "readable",
  );
  assert.strictEqual(
    resolveReference(
      reference,
      emptyFootprint(),
      probeOf({ "src/a.ts": "nothing", "src/b.ts": "route()" }),
    ).state,
    "readable",
  );
});

it("a symbol found in two workspace files abstains", () => {
  const reference = { kind: "path", path: "src/a.ts", symbol: "route" } as const;
  assert.strictEqual(
    resolveReference(
      reference,
      emptyFootprint(),
      probeOf({ "src/a.ts": "nothing", "src/b.ts": "route()", "src/c.ts": "route()" }),
    ).state,
    "unresolved",
  );
});

it("a symbol absent everywhere is lost when deleted, unresolved otherwise", () => {
  const reference = { kind: "path", path: "src/a.ts", symbol: "gone" } as const;
  const probe = probeOf({ "src/a.ts": "nothing" });
  assert.strictEqual(
    resolveReference(
      reference,
      footprintWith({ deleted: [{ path: "src/a.ts", symbol: "gone" }] }),
      probe,
    ).state,
    "lost",
  );
  assert.strictEqual(resolveReference(reference, emptyFootprint(), probe).state, "unresolved");
});

it("a decision reference stays unresolved, because no check exists", () => {
  const resolved = resolveReference(
    { kind: "decision", topic: "storage shape" },
    emptyFootprint(),
    probeOf({}),
  );
  assert.strictEqual(resolved.state, "unresolved");
});

it("a product exists or is missing", () => {
  assert.strictEqual(
    resolveProduct({ path: "docs/plan.md" }, probeOf({ "docs/plan.md": "# Plan" })).state,
    "exists",
  );
  assert.strictEqual(resolveProduct({ path: "docs/plan.md" }, probeOf({})).state, "missing");
});
