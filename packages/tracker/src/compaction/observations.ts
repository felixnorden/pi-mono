/**
 * The observation vocabulary for the reliance rules.
 *
 * Two kinds of fact live here. The declaration side is authored metadata on an
 * item: the files, symbols, regions, and decisions it expects to read, and the
 * documents it will write. The footprint side is what the batch actually did,
 * recorded by the extension: paths written with their touched spans and a
 * content fingerprint, paths read, symbols deleted, and commands run.
 *
 * The resolver turns a declaration and the footprint against the disk into a
 * small typed state. It reads through an injected `FileProbe`, so the product
 * passes a real filesystem and the tests pass a map. No rule decides anything
 * here; `rules.ts` owns the policy rows.
 *
 * The path grammar and the two text projections are kept from the pre-revert
 * rule branch, because the corpus parity test scores the renamed rows against
 * the old measured behavior.
 */
import type { DeclaredProduct, DeclaredReference } from "../core/domain.ts";

export type { DeclaredProduct, DeclaredReference };

// --------------------------------------------------------------------------
// The legacy path grammar and text facts
// --------------------------------------------------------------------------

/**
 * File extensions worth naming, longest first. The order matters: `.jsonc` must
 * win over `.json`, and `.json` must not match the start of `.jsonx`.
 */
const EXTENSIONS = [
  "tsbuildinfo",
  "jsonc",
  "json",
  "tsx",
  "jsx",
  "mdx",
  "mts",
  "cts",
  "toml",
  "yaml",
  "html",
  "mjs",
  "cjs",
  "css",
  "sql",
  "yml",
  "txt",
  "md",
  "ts",
  "js",
  "sh",
  "rs",
  "py",
  "go",
] as const;

/** Any file-like token, with an extension the work is likely to touch. */
export const PATH_TOKEN = new RegExp(
  `(?:\\.{0,2}\\/)?(?:[\\w.@-]+\\/)*[\\w.@-]+\\.(?:${EXTENSIONS.join("|")})(?!\\w)`,
  "g",
);

/** A QRSPI plan, design, or outline document. */
export const QRSPI_PLAN_DOCUMENT = /\.qrspi\/(?:plans|designs|outlines)\//;

/** Every file path named in a string, distinct and in match order. */
export const documentPathsOf = (text: string): readonly string[] => [
  ...new Set(text.match(PATH_TOKEN) ?? []),
];

/** The fields the text projections read from a recorded work entry. */
export interface RecordText {
  readonly kind?: string;
  readonly text: string;
  readonly name?: string;
  readonly args?: {
    readonly path?: string;
    readonly command?: string;
  };
}

/** The tool names that produce a file. */
export const PRODUCING_TOOLS: ReadonlySet<string> = new Set(["write", "edit"]);

/** One entry's text plus its bounded path and command. */
const entryTexts = (entry: RecordText): readonly string[] => [
  entry.text,
  ...(entry.args?.path === undefined ? [] : [entry.args.path]),
  ...(entry.args?.command === undefined ? [] : [entry.args.command]),
];

/** The batch plus the record, joined. A document named here was named at some point. */
export const knownTextOf = (batch: readonly string[], record: readonly RecordText[]): string =>
  [...batch, ...record.flatMap(entryTexts)].join("\n");

/**
 * The `write` and `edit` call paths, joined. A path named here was produced.
 * Only the call's `path` argument counts: the call's full JSON can mention
 * other files, and a tool result repeats a path without being the call.
 */
export const producedTextOf = (record: readonly RecordText[]): string =>
  record
    .filter((entry) => entry.kind === "tool-call" && PRODUCING_TOOLS.has(entry.name ?? ""))
    .flatMap((entry) => (entry.args?.path === undefined ? [] : [entry.args.path]))
    .join("\n");

// --------------------------------------------------------------------------
// Footprint
// --------------------------------------------------------------------------

/** One path the batch wrote or edited. */
export interface WrittenPath {
  readonly path: string;
  /** New-side line ranges the batch touched, e.g. `12-14,30`. */
  readonly spans: readonly string[];
  /** Fingerprint of the written region after the write. */
  readonly fingerprint?: string;
}

/** A path or symbol the batch removed. */
export interface DeletedReference {
  readonly path: string;
  readonly symbol?: string;
}

/** What the batch did between two settle decisions. */
export interface BatchFootprint {
  readonly wrote: readonly WrittenPath[];
  readonly read: readonly string[];
  readonly deleted: readonly DeletedReference[];
  readonly commands: readonly string[];
}

/** An empty footprint, for a decision with no recorded work. */
export const emptyFootprint = (): BatchFootprint => ({
  wrote: [],
  read: [],
  deleted: [],
  commands: [],
});

/**
 * What the product can see at settle: the batch item texts plus the footprint,
 * with no transcript prose. One projection, shared by the eval report and the
 * live settle decision, so the measured facts and the live facts cannot drift.
 *
 * `knownText` joins the batch texts, every read path, every written path, every
 * deleted path, and every command. `producedText` joins the written paths only:
 * a command never marks a path produced.
 */
export const productionFacts = (
  batchTexts: readonly string[],
  footprint: BatchFootprint,
  candidateText: string,
): {
  readonly knownText: string;
  readonly producedText: string;
  readonly candidatePaths: readonly string[];
  readonly planDocument: boolean;
} => {
  const knownText = [
    ...batchTexts,
    ...footprint.read,
    ...footprint.wrote.map((entry) => entry.path),
    ...footprint.deleted.map((entry) => entry.path),
    ...footprint.commands,
  ].join("\n");
  return {
    knownText,
    producedText: footprint.wrote.map((entry) => entry.path).join("\n"),
    candidatePaths: documentPathsOf(candidateText),
    planDocument: QRSPI_PLAN_DOCUMENT.test(knownText),
  };
};

/**
 * The disk probe the resolver reads through. The product resolves a relative
 * path against the workspace root; the tests pass a map. Everything a probe
 * returns is already bounded by the caller.
 */
export interface FileProbe {
  /** The file's text, or undefined when the path does not exist. */
  readonly read: (path: string) => string | undefined;
  /** Every path that contains the symbol, workspace wide. */
  readonly findSymbol: (symbol: string) => readonly string[];
}

// --------------------------------------------------------------------------
// Resolution
// --------------------------------------------------------------------------

/** How a declared reference resolves against the disk now. */
export type ReferenceState = "readable" | "lost" | "drifted" | "unresolved";

/** How a declared product resolves against the disk now. */
export type ProductState = "exists" | "missing";

export interface ResolvedReference {
  readonly reference: DeclaredReference;
  readonly state: ReferenceState;
}

export interface ResolvedProduct {
  readonly product: DeclaredProduct;
  readonly state: ProductState;
}

/**
 * A small, deterministic fingerprint of a text region: FNV-1a over UTF-16
 * units. The recorder and the resolver must use this one function, or a drift
 * check would compare two different scales.
 */
export const fingerprintOf = (text: string): string => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
};

/** One parsed `start-end` or `start` line range, 1-based and inclusive. */
interface LineRange {
  readonly start: number;
  readonly end: number;
}

/** Parse `12-14,30`; undefined when any part is malformed or inverted. */
const parseSpan = (span: string): readonly LineRange[] | undefined => {
  const ranges: LineRange[] = [];
  for (const part of span.split(",")) {
    const match = /^(\d+)(?:-(\d+))?$/.exec(part.trim());
    if (match === null) return undefined;
    const start = Number(match[1]);
    const end = match[2] === undefined ? start : Number(match[2]);
    if (start < 1 || end < start) return undefined;
    ranges.push({ start, end });
  }
  return ranges.length === 0 ? undefined : ranges;
};

/** The text the declared span covers, or undefined when the file is too short. */
export const spanTextOf = (text: string, span: string): string | undefined => {
  const ranges = parseSpan(span);
  if (ranges === undefined) return undefined;
  const lines = text.split("\n");
  const parts: string[] = [];
  for (const range of ranges) {
    if (range.end > lines.length) return undefined;
    parts.push(lines.slice(range.start - 1, range.end).join("\n"));
  }
  return parts.join("\n");
};

/** True when the symbol appears as a token, not as part of a longer word. */
export const containsSymbol = (text: string, symbol: string): boolean => {
  if (symbol.length === 0) return false;
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\w$])${escaped}([^\\w$]|$)`).test(text);
};

const deletedPath = (footprint: BatchFootprint, path: string): boolean =>
  footprint.deleted.some((entry) => entry.path === path && entry.symbol === undefined);

const deletedSymbol = (footprint: BatchFootprint, symbol: string): boolean =>
  footprint.deleted.some((entry) => entry.symbol === symbol);

/**
 * The span state: drifted when the region is gone or the batch wrote that exact
 * span and its content no longer matches the recorded fingerprint; readable
 * otherwise. A drift we cannot check is not called a drift.
 */
const spanState = (
  text: string,
  path: string,
  span: string,
  footprint: BatchFootprint,
): ReferenceState => {
  const current = spanTextOf(text, span);
  if (current === undefined) return "drifted";
  const written = footprint.wrote.find(
    (entry) => entry.path === path && entry.spans.includes(span) && entry.fingerprint !== undefined,
  );
  if (written?.fingerprint !== undefined && written.fingerprint !== fingerprintOf(current)) {
    return "drifted";
  }
  return "readable";
};

/** Resolve one declared reference against the footprint and the disk. */
export const resolveReference = (
  reference: DeclaredReference,
  footprint: BatchFootprint,
  probe: FileProbe,
): ResolvedReference => {
  if (reference.kind === "decision") {
    // A decision is a semantic claim. No deterministic check exists, so it
    // stays unresolved and the rule layer routes it to the classifier.
    return { reference, state: "unresolved" };
  }
  const text = probe.read(reference.path);
  if (text === undefined) {
    return { reference, state: deletedPath(footprint, reference.path) ? "lost" : "unresolved" };
  }
  if (reference.symbol !== undefined) {
    if (containsSymbol(text, reference.symbol)) {
      return {
        reference,
        state:
          reference.span === undefined
            ? "readable"
            : spanState(text, reference.path, reference.span, footprint),
      };
    }
    // The named file no longer carries it. The declared scope is named file
    // first, then the workspace, so one moved symbol is still readable. Two or
    // more matches do not name one file, so the reference abstains.
    const matches = probe.findSymbol(reference.symbol);
    if (matches.length === 1) return { reference, state: "readable" };
    if (matches.length > 1) return { reference, state: "unresolved" };
    return { reference, state: deletedSymbol(footprint, reference.symbol) ? "lost" : "unresolved" };
  }
  if (reference.span !== undefined) {
    return { reference, state: spanState(text, reference.path, reference.span, footprint) };
  }
  return { reference, state: "readable" };
};

/** Resolve every declared reference, in declaration order. */
export const resolveReferences = (
  references: readonly DeclaredReference[],
  footprint: BatchFootprint,
  probe: FileProbe,
): readonly ResolvedReference[] =>
  references.map((reference) => resolveReference(reference, footprint, probe));

/** Resolve one declared product: it exists on disk or it does not. */
export const resolveProduct = (product: DeclaredProduct, probe: FileProbe): ResolvedProduct => ({
  product,
  state: probe.read(product.path) === undefined ? "missing" : "exists",
});

/** Resolve every declared product, in declaration order. */
export const resolveProducts = (
  products: readonly DeclaredProduct[],
  probe: FileProbe,
): readonly ResolvedProduct[] => products.map((product) => resolveProduct(product, probe));
