/**
 * Harvest the smart-compaction eval corpus from real Pi sessions.
 *
 * Every Pi session appends the whole tracker state to its JSONL log as a
 * `tracker/state` custom entry. Replaying those snapshots reproduces the exact
 * decision the live settle path faced, without a classifier call: this script
 * writes one case per decision to `evals/data/cases.jsonl` and a summary to
 * `evals/data/manifest.json`. A `tracker/reliance-decision` entry, when the
 * candidate declared something, is read back into its case so declared rows
 * carry live coverage.
 *
 * The corpus holds real session text, so `evals/data/` is git-ignored and every
 * string is passed through `redact.ts` first. The manifest reports what the
 * redaction rules removed.
 *
 * Run: `bun run eval:harvest` (options below).
 */

import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DecisionRecord } from "../src/compaction/decision-record.ts";
import type { DeclaredReference } from "../src/core/domain.ts";
import type { StoredCase, StoredEvidence } from "./case-file.ts";
import { deriveEvents } from "./derive.ts";
import { buildEvidence } from "./evidence.ts";
import { privateManifest } from "./evidence-redact.ts";
import { makeRedactionTally, redactPath, redactWith } from "./redact.ts";
import {
  contextAt,
  decisionsIn,
  FORMAT_RULE,
  MARKER,
  parseSession,
  type SnapshotFormat,
} from "./session.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));

interface Options {
  readonly root: string;
  readonly out: string;
  readonly evidence?: string;
  readonly limit: number;
  readonly format?: SnapshotFormat;
  readonly force: boolean;
}

const usage = `harvest.ts [--root <dir>] [--out <dir>] [--evidence <dir>] [--limit <n>]
                 [--format declared|legacy] [--force]

  --root      session log root (default: $PI_SESSION_DIR or ~/.config/pi/agent/sessions)
  --out       output directory (default: evals/data)
  --evidence  also write the manifest to <dir>/manifest.json
  --limit     stored candidates per case (default: 64)
  --format    store only cases whose snapshot matches this format (default: both)
  --force     rewrite a directory that holds freeze.json`;

const parseOptions = (argv: readonly string[]): Options => {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]!;
    if (!flag.startsWith("--")) continue;
    const name = flag.slice(2);
    if (name === "force") {
      flags.add(name);
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`missing value for ${flag}\n\n${usage}`);
    }
    values.set(name, value);
    index += 1;
  }
  const limit = Number(values.get("limit") ?? 64);
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`--limit must be a positive integer\n\n${usage}`);
  }
  const format = values.get("format");
  if (format !== undefined && format !== "declared" && format !== "legacy") {
    throw new Error(`--format must be declared or legacy\n\n${usage}`);
  }
  return {
    root:
      values.get("root") ??
      process.env.PI_SESSION_DIR ??
      join(homedir(), ".config", "pi", "agent", "sessions"),
    out: values.get("out") ?? join(HERE, "data"),
    ...(values.get("evidence") === undefined ? {} : { evidence: values.get("evidence") }),
    limit,
    ...(format === undefined ? {} : { format }),
    force: flags.has("force"),
  };
};

/** Every `.jsonl` file under `dir`, depth-first. */
const jsonlFiles = (dir: string): readonly string[] => {
  const found: string[] = [];
  const walk = (current: string): void => {
    let entries: readonly string[];
    try {
      entries = readdirSync(current);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(current, entry);
      const stats = statSync(full);
      if (stats.isDirectory()) walk(full);
      else if (entry.endsWith(".jsonl")) found.push(full);
    }
  };
  walk(dir);
  return found;
};

/** The redaction and cap settings one session harvest uses. */
export interface HarvestOptions {
  readonly limit: number;
  readonly redact: (value: string) => string;
  /** Store only cases whose snapshot matches this format. Both when absent. */
  readonly format?: SnapshotFormat;
}

/** One session's stored cases and work records. */
export interface HarvestedSession {
  readonly snapshots: number;
  readonly cases: readonly StoredCase[];
  readonly evidence: readonly StoredEvidence[];
  /** Cases the format filter dropped because their snapshot was legacy. */
  readonly excludedLegacy: number;
  /** Cases the format filter dropped because their snapshot was declared. */
  readonly excludedDeclared: number;
  /** The earliest and latest snapshot timestamp in the log, when it holds one. */
  readonly from: string | undefined;
  readonly to: string | undefined;
  /** Stored cases whose snapshot matches the snapshot rule. */
  readonly snapshotRuleDeclared: number;
  /** Stored cases whose every completed item carries a declared key. */
  readonly completedItemRuleDeclared: number;
}

/**
 * Derive one session's cases and work records. Returns undefined when the log
 * holds no tracker snapshot. Every stored string passes through `redact`, so
 * the caller decides the policy; the synthetic fixture passes identity.
 */
export const harvestSession = (
  text: string,
  dir: string,
  file: string,
  options: HarvestOptions,
  onSkipped: () => void,
): HarvestedSession | undefined => {
  if (!text.includes(MARKER)) return undefined;
  const parsed = parseSession(text, onSkipped);
  if (parsed.snapshots.length === 0) return undefined;

  const redactText = options.redact;
  /** Redact a declared reference's author text; a span is a line range. */
  const redactReference = (reference: DeclaredReference): DeclaredReference =>
    reference.kind === "decision"
      ? { kind: "decision", topic: redactText(reference.topic) }
      : {
          kind: "path",
          path: redactText(reference.path),
          ...(reference.symbol === undefined ? {} : { symbol: redactText(reference.symbol) }),
          ...(reference.span === undefined ? {} : { span: reference.span }),
        };
  const decisions = decisionsIn(parsed.entries, onSkipped);
  const events = deriveEvents(parsed.snapshots, options.limit);
  // The format filter runs on the snapshot that produced each case, before any
  // case is redacted or stored. A mixed session contributes only its matches.
  const storedEvents = events.filter((event) => {
    if (options.format === undefined) return true;
    return parsed.snapshotFormats[event.snapshotIndex] === options.format;
  });
  const excludedLegacy =
    options.format === "declared"
      ? events.filter((event) => parsed.snapshotFormats[event.snapshotIndex] === "legacy").length
      : 0;
  const excludedDeclared =
    options.format === "legacy"
      ? events.filter((event) => parsed.snapshotFormats[event.snapshotIndex] === "declared").length
      : 0;
  // Redact the source once, then build every string from the redacted parts, so
  // the case id cannot carry the raw path that `session.dir` hides.
  const redactedDir = redactText(dir);
  const redactedFile = redactText(file);

  /**
   * The first decision entry after the case's snapshot that names the same
   * candidate. A decision from a different completion never attaches.
   */
  const decisionFor = (
    snapshotLine: number,
    ref: string | undefined,
  ): DecisionRecord | undefined => {
    if (ref === undefined) return undefined;
    return decisions
      .filter((entry) => entry.line > snapshotLine && entry.record.candidateRef === ref)
      .map((entry) => entry.record)[0];
  };

  const cases = storedEvents.map((event): StoredCase => {
    const decision = decisionFor(
      parsed.snapshotLines[event.snapshotIndex]!,
      event.candidates[0]?.ref,
    );
    return {
      caseId: `${redactedDir}/${redactedFile}#${event.index}`,
      session: { dir: redactedDir, file: redactedFile },
      // The cwd stays raw: the replay resolves declared paths against it, and
      // the corpus directory is local. The manifest redacts the session root.
      ...(parsed.cwd === undefined ? {} : { sessionCwd: parsed.cwd }),
      at: event.at,
      index: event.index,
      list: {
        id: event.listId,
        name: redactText(event.listName),
        items: event.items.map((item) => ({
          id: item.id,
          text: redactText(item.text),
          ...(item.description === undefined ? {} : { description: redactText(item.description) }),
          ...(item.refs === undefined ? {} : { refs: item.refs.map(redactReference) }),
          ...(item.produces === undefined
            ? {}
            : { produces: item.produces.map((product) => ({ path: redactText(product.path) })) }),
          done: item.done,
          deps: item.deps.map(redactText),
        })),
      },
      completed: event.completed.map((item) => ({
        ref: redactText(item.ref),
        text: redactText(item.text),
        ...(item.description === undefined ? {} : { description: redactText(item.description) }),
      })),
      candidates: event.candidates.map((candidate) => ({
        ref: redactText(candidate.ref),
        text: redactText(candidate.text),
        ...(candidate.description === undefined
          ? {}
          : { description: redactText(candidate.description) }),
        class: candidate.class,
        relationship: redactText(candidate.relationship),
        ...(candidate.refs === undefined ? {} : { refs: candidate.refs.map(redactReference) }),
        ...(candidate.produces === undefined
          ? {}
          : {
              produces: candidate.produces.map((product) => ({ path: redactText(product.path) })),
            }),
      })),
      questions: event.questions.map((question) => ({
        key: redactText(question.key),
        instructions: redactText(question.instructions),
        criteria: Object.fromEntries(
          Object.entries(question.criteria).map(([label, description]) => [
            label,
            redactText(description),
          ]),
        ),
      })),
      frontier: event.frontier,
      itemCount: event.itemCount,
      openCount: event.openCount,
      doneCount: event.doneCount,
      declaredDeps: event.declaredDeps,
      ...(decision === undefined ? {} : { decision }),
      context: contextAt(parsed.entries, parsed.snapshotLines[event.snapshotIndex]!),
    };
  });

  // The work for a batch runs from the snapshot that produced the previous
  // decision to this one, so an unrelated mutation in between cannot cut it.
  const evidence: StoredEvidence[] = [];
  let previousEventLine = -1;
  for (const event of storedEvents) {
    const endLine = parsed.snapshotLines[event.snapshotIndex]!;
    const window: unknown[] = [];
    for (let line = previousEventLine + 1; line <= endLine; line += 1) {
      const entry = parsed.entries[line];
      if (entry !== undefined) window.push(entry);
    }
    const record = buildEvidence(window);
    evidence.push({
      caseId: `${redactedDir}/${redactedFile}#${event.index}`,
      // The work record is redacted here too. `buildEvidence` renders raw
      // session text, so nothing else in the pipeline would clean it.
      entries: record.entries.map((entry) => ({
        kind: entry.kind,
        at: entry.at,
        text: redactText(entry.text),
        ...(entry.name === undefined ? {} : { name: redactText(entry.name) }),
        ...(entry.isError === undefined ? {} : { isError: entry.isError }),
        ...(entry.callId === undefined ? {} : { callId: redactText(entry.callId) }),
        ...(entry.args === undefined
          ? {}
          : {
              args: {
                ...(entry.args.path === undefined ? {} : { path: redactText(entry.args.path) }),
                ...(entry.args.command === undefined
                  ? {}
                  : { command: redactText(entry.args.command) }),
              },
            }),
        ...(entry.lines === undefined ? {} : { lines: entry.lines }),
      })),
      omitted: record.omitted,
    });
    previousEventLine = endLine;
  }

  const times = parsed.snapshots.map((snapshot) => snapshot.at).filter((at) => at.length > 0);
  const snapshotRuleDeclared = storedEvents.filter(
    (event) => parsed.snapshotFormats[event.snapshotIndex] === "declared",
  ).length;
  const completedItemRuleDeclared = storedEvents.filter((event) =>
    event.completedItemIds.every(
      (id) => parsed.snapshotDeclaredIds[event.snapshotIndex]?.has(id) === true,
    ),
  ).length;
  return {
    snapshots: parsed.snapshots.length,
    cases,
    evidence,
    excludedLegacy,
    excludedDeclared,
    from: times[0],
    to: times[times.length - 1],
    snapshotRuleDeclared,
    completedItemRuleDeclared,
  };
};

interface SessionResult {
  readonly file: string;
  readonly dir: string;
  readonly snapshots: number;
  readonly events: readonly StoredCase[];
  readonly from: string | undefined;
  readonly to: string | undefined;
  readonly snapshotRuleDeclared: number;
  readonly completedItemRuleDeclared: number;
}

/** Everything one harvest run reads and writes. */
export interface HarvestRunOptions {
  readonly root: string;
  readonly out: string;
  /** Also write the manifest to `<evidence>/manifest.json`. */
  readonly evidence?: string;
  readonly limit: number;
  readonly format?: SnapshotFormat;
  /** Rewrite a directory that holds `freeze.json`. */
  readonly force?: boolean;
}

/** The manifest one harvest run wrote. */
export interface HarvestManifest {
  readonly [key: string]: unknown;
  readonly trackerVersion: string;
  readonly format: SnapshotFormat | "all";
  readonly formatRule: string;
  readonly formatCounts: {
    readonly snapshotRule: number;
    readonly completedItemRule: number;
  };
  readonly excluded: { readonly legacy: number; readonly declared: number };
  readonly source: { readonly from: string | null; readonly to: string | null };
  readonly forced?: true;
}

/**
 * The reason a directory cannot be rewritten, or null when it is not frozen.
 * The case ids are the join key for every label, so a frozen corpus is a
 * promise that its cases will not move under its labels.
 */
export const freezeRefusal = (out: string): string | null => {
  let text: string;
  try {
    text = readFileSync(join(out, "freeze.json"), "utf8");
  } catch {
    return null;
  }
  let frozenAt = "unknown";
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    frozenAt = String(parsed.frozenAt ?? parsed.at ?? "unknown");
  } catch {
    // A malformed freeze file still freezes the directory.
  }
  return `${out} is frozen since ${frozenAt}; later harvests write a dated directory. Pass --force to rewrite.`;
};

/** The package version the manifest records. */
const trackerVersion = (): string => {
  try {
    const parsed = JSON.parse(readFileSync(join(HERE, "..", "package.json"), "utf8")) as {
      version?: unknown;
    };
    return typeof parsed.version === "string" ? parsed.version : "unknown";
  } catch {
    return "unknown";
  }
};

/** Scan the root, store the matching cases, and return the manifest. */
export const runHarvest = (options: HarvestRunOptions): { readonly manifest: HarvestManifest } => {
  const refusal = options.force === true ? null : freezeRefusal(options.out);
  if (refusal !== null) throw new Error(refusal);

  const tally = makeRedactionTally();
  const redactText = (value: string): string => redactWith(value, tally);

  const files = jsonlFiles(options.root);
  const sessions: SessionResult[] = [];
  const evidence: StoredEvidence[] = [];
  let snapshotsParsed = 0;
  let snapshotsSkipped = 0;
  let sessionsWithTracker = 0;
  let excludedLegacy = 0;
  let excludedDeclared = 0;
  let snapshotRuleDeclared = 0;
  let completedItemRuleDeclared = 0;
  let from: string | undefined;
  let to: string | undefined;

  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const relativePath = file.slice(options.root.length).replace(/^\//, "");
    const slash = relativePath.indexOf("/");
    const dir = slash === -1 ? "." : relativePath.slice(0, slash);
    const name = slash === -1 ? relativePath : relativePath.slice(slash + 1);
    const harvested = harvestSession(
      text,
      dir,
      name,
      {
        limit: options.limit,
        redact: redactText,
        ...(options.format === undefined ? {} : { format: options.format }),
      },
      () => {
        snapshotsSkipped += 1;
      },
    );
    if (harvested === undefined) continue;
    sessionsWithTracker += 1;
    snapshotsParsed += harvested.snapshots;
    excludedLegacy += harvested.excludedLegacy;
    excludedDeclared += harvested.excludedDeclared;
    snapshotRuleDeclared += harvested.snapshotRuleDeclared;
    completedItemRuleDeclared += harvested.completedItemRuleDeclared;
    if (harvested.from !== undefined && (from === undefined || harvested.from < from)) {
      from = harvested.from;
    }
    if (harvested.to !== undefined && (to === undefined || harvested.to > to)) to = harvested.to;
    if (harvested.cases.length === 0) continue;
    evidence.push(...harvested.evidence);
    sessions.push({
      file: name,
      dir,
      snapshots: harvested.snapshots,
      events: harvested.cases,
      from: harvested.from,
      to: harvested.to,
      snapshotRuleDeclared: harvested.snapshotRuleDeclared,
      completedItemRuleDeclared: harvested.completedItemRuleDeclared,
    });
  }

  const cases = sessions.flatMap((session) => session.events);
  const candidates = cases.flatMap((entry) => entry.candidates);
  const listNames = new Map<string, number>();
  for (const entry of cases)
    listNames.set(entry.list.name, (listNames.get(entry.list.name) ?? 0) + 1);

  const manifest: HarvestManifest = {
    generatedAt: new Date().toISOString(),
    trackerVersion: trackerVersion(),
    root: redactPath(options.root, homedir()),
    candidateLimit: options.limit,
    format: options.format ?? "all",
    formatRule: FORMAT_RULE,
    formatCounts: {
      snapshotRule: snapshotRuleDeclared,
      completedItemRule: completedItemRuleDeclared,
    },
    excluded: { legacy: excludedLegacy, declared: excludedDeclared },
    source: { from: from ?? null, to: to ?? null },
    ...(options.force === true ? { forced: true as const } : {}),
    sessions: {
      filesScanned: files.length,
      withTrackerState: sessionsWithTracker,
      withEvents: sessions.length,
    },
    snapshots: {
      parsed: snapshotsParsed,
      skipped: snapshotsSkipped,
    },
    events: {
      total: cases.length,
      withCandidates: cases.filter((entry) => entry.candidates.length > 0).length,
      emptyFrontier: cases.filter((entry) => entry.frontier === 0).length,
      truncated: cases.filter((entry) => entry.frontier > entry.candidates.length).length,
      withDecision: cases.filter((entry) => entry.decision !== undefined).length,
    },
    candidates: {
      total: candidates.length,
      dependentSuccessor: candidates.filter((entry) => entry.class === "dependent-successor")
        .length,
      readyQueue: candidates.filter((entry) => entry.class === "ready-queue").length,
    },
    lists: {
      distinct: listNames.size,
      top: [...listNames.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20),
    },
    sessionsTop: sessions
      .map((session) => ({
        dir: redactText(session.dir),
        file: redactText(session.file),
        snapshots: session.snapshots,
        events: session.events.length,
      }))
      .sort((a, b) => b.events - a.events)
      .slice(0, 20),
    redaction: tally.totals(),
    evidence: {
      cases: evidence.length,
      entries: evidence.reduce((total, record) => total + record.entries.length, 0),
      casesWithOmissions: evidence.filter((record) => record.omitted > 0).length,
    },
  };

  mkdirSync(options.out, { recursive: true });
  writeFileSync(
    join(options.out, "cases.jsonl"),
    cases
      .map((entry) => JSON.stringify(entry))
      .join("\n")
      .concat("\n"),
  );
  writeFileSync(
    join(options.out, "evidence.jsonl"),
    evidence
      .map((record) => JSON.stringify(record))
      .join("\n")
      .concat("\n"),
  );
  writeFileSync(join(options.out, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  if (options.evidence !== undefined) {
    mkdirSync(options.evidence, { recursive: true });
    writeFileSync(
      join(options.evidence, "manifest.json"),
      `${JSON.stringify(privateManifest(manifest), null, 2)}\n`,
    );
  }
  return { manifest };
};

const main = (): void => {
  const options = parseOptions(process.argv.slice(2));
  const { manifest } = runHarvest(options);
  process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
};

if (import.meta.main) main();
