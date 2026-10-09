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
import { makeRedactionTally, redactPath, redactWith } from "./redact.ts";
import { contextAt, decisionsIn, MARKER, parseSession } from "./session.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));

interface Options {
  readonly root: string;
  readonly out: string;
  readonly limit: number;
}

const usage = `harvest.ts [--root <dir>] [--out <dir>] [--limit <n>]

  --root   session log root (default: $PI_SESSION_DIR or ~/.config/pi/agent/sessions)
  --out    output directory (default: evals/data)
  --limit  stored candidates per case (default: 64)`;

const parseOptions = (argv: readonly string[]): Options => {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]!;
    if (!flag.startsWith("--")) continue;
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`missing value for ${flag}\n\n${usage}`);
    }
    values.set(flag.slice(2), value);
    index += 1;
  }
  const limit = Number(values.get("limit") ?? 64);
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`--limit must be a positive integer\n\n${usage}`);
  }
  return {
    root:
      values.get("root") ??
      process.env.PI_SESSION_DIR ??
      join(homedir(), ".config", "pi", "agent", "sessions"),
    out: values.get("out") ?? join(HERE, "data"),
    limit,
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
}

/** One session's stored cases and work records. */
export interface HarvestedSession {
  readonly snapshots: number;
  readonly cases: readonly StoredCase[];
  readonly evidence: readonly StoredEvidence[];
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

  const cases = events.map((event): StoredCase => {
    const decision = decisionFor(
      parsed.snapshotLines[event.snapshotIndex]!,
      event.candidates[0]?.ref,
    );
    return {
      caseId: `${redactedDir}/${redactedFile}#${event.index}`,
      session: { dir: redactedDir, file: redactedFile },
      at: event.at,
      index: event.index,
      list: {
        id: event.listId,
        name: redactText(event.listName),
        items: event.items.map((item) => ({
          id: item.id,
          text: redactText(item.text),
          ...(item.description === undefined ? {} : { description: redactText(item.description) }),
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
  for (const event of events) {
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

  return { snapshots: parsed.snapshots.length, cases, evidence };
};

interface SessionResult {
  readonly file: string;
  readonly dir: string;
  readonly snapshots: number;
  readonly events: readonly StoredCase[];
}

const main = (): void => {
  const options = parseOptions(process.argv.slice(2));
  const tally = makeRedactionTally();
  const redactText = (value: string): string => redactWith(value, tally);

  const files = jsonlFiles(options.root);
  const sessions: SessionResult[] = [];
  const evidence: StoredEvidence[] = [];
  let snapshotsParsed = 0;
  let snapshotsSkipped = 0;
  let sessionsWithTracker = 0;

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
      { limit: options.limit, redact: redactText },
      () => {
        snapshotsSkipped += 1;
      },
    );
    if (harvested === undefined) continue;
    sessionsWithTracker += 1;
    snapshotsParsed += harvested.snapshots;
    if (harvested.cases.length === 0) continue;
    evidence.push(...harvested.evidence);
    sessions.push({ file: name, dir, snapshots: harvested.snapshots, events: harvested.cases });
  }

  const cases = sessions.flatMap((session) => session.events);
  const candidates = cases.flatMap((entry) => entry.candidates);
  const listNames = new Map<string, number>();
  for (const entry of cases)
    listNames.set(entry.list.name, (listNames.get(entry.list.name) ?? 0) + 1);

  const manifest = {
    generatedAt: new Date().toISOString(),
    root: redactPath(options.root, homedir()),
    candidateLimit: options.limit,
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
    outputs: { cases: "cases.jsonl", evidence: "evidence.jsonl", manifest: "manifest.json" },
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
  process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
};

if (import.meta.main) main();
