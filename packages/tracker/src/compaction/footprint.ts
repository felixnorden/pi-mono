import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { Context, Effect, Layer, Queue, Ref } from "effect";
import {
  emptyFootprint,
  fingerprintOf,
  PRODUCING_TOOLS,
  spanTextOf,
  type BatchFootprint,
  type FileProbe,
  type WrittenPath,
} from "./observations.ts";

/**
 * The batch footprint recorder.
 *
 * The event path is hot, so `capture` does one thing: project the event into a
 * small record and fold it into the pending batch. It never reads the disk and
 * never yields. `snapshot` drains the pending batch, reads each written file
 * once through the injected `FileProbe`, and returns the ready facts; `consume`
 * returns and clears them. A later event for a path supersedes an earlier one,
 * and two paths derive independently. A path the probe cannot read is absent,
 * and the resolver abstains on it.
 *
 * Deletions and workspace-wide symbol moves are not parsed: `deleted` stays
 * empty, and the resolver reports those references as unresolved, which keeps
 * the context.
 */

// --------------------------------------------------------------------------
// Event projection
// --------------------------------------------------------------------------

/**
 * The bounded projection of one tool event. The bridge builds it from pi's
 * `tool_execution_start` and `tool_execution_end` events: the args are the
 * call's `path` and `command`, and `details` is the tool result's `details`
 * (the object that carries the unified `patch`).
 */
export interface ToolEvent {
  readonly phase: "start" | "end";
  readonly toolName: string;
  readonly args?: {
    readonly path?: string;
    readonly command?: string;
  };
  readonly details?: unknown;
}

/** One path the batch wrote, before the file is read. */
interface PendingWrite {
  readonly kind: "write";
  readonly path: string;
  readonly spans: readonly string[];
}

/** One path the batch read. */
interface PendingRead {
  readonly kind: "read";
  readonly path: string;
}

/** One command the batch ran. */
interface PendingCommand {
  readonly kind: "command";
  readonly command: string;
}

type Pending = PendingWrite | PendingRead | PendingCommand;

/** One new-side hunk header of a unified patch: `@@ -a,b +c,d @@`. */
const HUNK = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

const textOf = (value: unknown): string => (typeof value === "string" ? value : "");

/**
 * The new-side line range(s) a tool result touched, e.g. `["3-6", "20"]`.
 * Mirrors `evals/evidence.ts` `lineRangesOf`, since the eval record and the
 * live footprint must read the same patch shape. Four ranges is the cap.
 */
export const newSideSpans = (details: unknown): readonly string[] => {
  const patch = textOf((details as { readonly patch?: unknown } | undefined)?.patch);
  const spans: string[] = [];
  for (const line of patch.split("\n")) {
    const match = HUNK.exec(line);
    if (match === null) continue;
    const start = Number(match[1]);
    const count = match[2] === undefined ? 1 : Number(match[2]);
    const end = count <= 1 ? start : start + count - 1;
    spans.push(start === end ? String(start) : `${start}-${end}`);
  }
  if (spans.length > 0) return spans.slice(0, 4);
  const first = (details as { readonly firstChangedLine?: unknown } | undefined)?.firstChangedLine;
  return typeof first === "number" && Number.isFinite(first) ? [String(first)] : [];
};

/**
 * Project one event into the record the batch holds, or undefined when the
 * event names nothing the footprint records. A producing tool contributes a
 * write only at the end phase, because only then does the result carry spans.
 */
export const pendingOf = (event: ToolEvent): Pending | undefined => {
  const path = event.args?.path;
  const command = event.args?.command;
  if (path !== undefined && PRODUCING_TOOLS.has(event.toolName)) {
    if (event.phase !== "end") return undefined;
    return { kind: "write", path, spans: newSideSpans(event.details) };
  }
  if (path !== undefined && event.toolName === "read") return { kind: "read", path };
  if (command !== undefined) return { kind: "command", command };
  return undefined;
};

// --------------------------------------------------------------------------
// Derived facts
// --------------------------------------------------------------------------

/** The batch captured but not yet derived, keyed by path. Last write wins. */
interface PendingBatch {
  readonly writes: ReadonlyMap<string, PendingWrite>;
  readonly reads: ReadonlySet<string>;
  readonly commands: ReadonlySet<string>;
}

const emptyPending = (): PendingBatch => ({
  writes: new Map(),
  reads: new Set(),
  commands: new Set(),
});

/** The derived facts, keyed by path. Insertion order is the order of derivation. */
interface Facts {
  readonly wrote: ReadonlyMap<string, WrittenPath>;
  readonly read: ReadonlySet<string>;
  readonly commands: ReadonlySet<string>;
}

const emptyFacts = (): Facts => ({ wrote: new Map(), read: new Set(), commands: new Set() });

const footprintOf = (facts: Facts): BatchFootprint => ({
  ...emptyFootprint(),
  wrote: [...facts.wrote.values()],
  read: [...facts.read],
  commands: [...facts.commands],
});

/**
 * The fingerprint of a written region: the whole file when no span is known,
 * the declared ranges when there are any, and no fingerprint when the file is
 * shorter than the ranges. A missing fingerprint never reports drift.
 */
const fingerprintOfWrite = (text: string, spans: readonly string[]): string | undefined => {
  if (spans.length === 0) return fingerprintOf(text);
  const region = spanTextOf(text, spans.join(","));
  return region === undefined ? undefined : fingerprintOf(region);
};

/** Read each written path once and derive its spans and fingerprint. */
const deriveWrites = (
  probe: FileProbe,
  writes: ReadonlyMap<string, PendingWrite>,
): readonly WrittenPath[] => {
  const derived: WrittenPath[] = [];
  for (const [path, entry] of writes) {
    let text: string | undefined;
    try {
      text = probe.read(path);
    } catch {
      // A path the probe cannot read is not ready; the resolver abstains on it.
      text = undefined;
    }
    if (text === undefined) continue;
    const fingerprint = fingerprintOfWrite(text, entry.spans);
    derived.push({
      path,
      spans: entry.spans,
      ...(fingerprint === undefined ? {} : { fingerprint }),
    });
  }
  return derived;
};

// --------------------------------------------------------------------------
// The recorder service
// --------------------------------------------------------------------------

/** The recorder plus its background worker, for a caller that wants one. */
export interface FootprintRecorderParts {
  readonly recorder: FootprintRecorder["Service"];
  /** Drains the pending batch whenever capture signals new work. */
  readonly worker: Effect.Effect<never>;
}

/**
 * Build the recorder and a background drain worker. A test uses the recorder
 * directly and drains it with `snapshot`; the layer forks the worker so
 * production derives in the background as well.
 */
export const makeFootprintRecorder = (probe: FileProbe): Effect.Effect<FootprintRecorderParts> =>
  Effect.gen(function* () {
    const pending = yield* Ref.make<PendingBatch>(emptyPending());
    const facts = yield* Ref.make<Facts>(emptyFacts());
    const signal = yield* Queue.unbounded<void>();

    /**
     * Take the pending batch in one step and turn it into facts. Atomically
     * clearing first means two concurrent drains cannot double-read a path.
     */
    const drain = Ref.modify(pending, (current) => [current, emptyPending()]).pipe(
      Effect.flatMap((batch) =>
        Effect.sync(() => deriveWrites(probe, batch.writes)).pipe(
          Effect.flatMap((derived) =>
            Ref.update(facts, (current) => ({
              wrote: new Map([
                ...current.wrote,
                ...derived.map((entry) => [entry.path, entry] as const),
              ]),
              read: new Set([...current.read, ...batch.reads]),
              commands: new Set([...current.commands, ...batch.commands]),
            })).pipe(
              Effect.andThen(
                derived.length === 0
                  ? Effect.void
                  : Effect.logDebug(
                      `tracker: footprint derived ${derived
                        .map(
                          (entry) =>
                            `${entry.path} [${entry.spans.join(",") || "all"}] ${entry.fingerprint ?? "no-fingerprint"}`,
                        )
                        .join(", ")}`,
                    ),
              ),
            ),
          ),
        ),
      ),
    );

    const drainAll = Effect.gen(function* () {
      // A signal per capture may collapse into one drain; loop until the batch
      // is empty so nothing captured before the last signal is left behind.
      let drained = false;
      do {
        const before = yield* Ref.get(pending);
        drained = before.writes.size > 0 || before.reads.size > 0 || before.commands.size > 0;
        yield* drain;
      } while (drained);
    });

    const capture = Effect.fnUntraced(function* (event: ToolEvent) {
      const entry = pendingOf(event);
      if (entry === undefined) return;
      yield* Ref.update(pending, (current) => {
        if (entry.kind === "write") {
          return { ...current, writes: new Map([...current.writes, [entry.path, entry]]) };
        }
        if (entry.kind === "read") {
          return { ...current, reads: new Set([...current.reads, entry.path]) };
        }
        return { ...current, commands: new Set([...current.commands, entry.command]) };
      });
      yield* Queue.offer(signal, undefined);
    });

    const snapshot = drainAll.pipe(Effect.andThen(Ref.get(facts)), Effect.map(footprintOf));

    const consume = snapshot.pipe(
      Effect.flatMap((footprint) => Ref.set(facts, emptyFacts()).pipe(Effect.as(footprint))),
    );

    const worker = Effect.forever(
      Effect.gen(function* () {
        // Extra signals collapse into an empty drain, which is harmless.
        yield* Queue.take(signal);
        yield* drainAll;
      }),
    );

    return {
      recorder: FootprintRecorder.of({ capture, snapshot, consume }),
      worker,
    };
  });

/**
 * The batch footprint recorder. `capture` folds an event into the batch and
 * never reads the disk; `snapshot` drains and returns the ready facts;
 * `consume` returns and clears them.
 */
export class FootprintRecorder extends Context.Service<
  FootprintRecorder,
  {
    readonly capture: (event: ToolEvent) => Effect.Effect<void>;
    readonly snapshot: Effect.Effect<BatchFootprint>;
    readonly consume: Effect.Effect<BatchFootprint>;
  }
>()("tracker/FootprintRecorder") {
  static readonly layer = (probe: FileProbe): Layer.Layer<FootprintRecorder> =>
    Layer.effect(
      FootprintRecorder,
      Effect.gen(function* () {
        const parts = yield* makeFootprintRecorder(probe);
        yield* Effect.forkScoped(parts.worker);
        return parts.recorder;
      }),
    );
}

// --------------------------------------------------------------------------
// The production probe
// --------------------------------------------------------------------------

/** The bounds the production probe keeps on every disk read. */
export const PROBE_DEFAULTS = {
  maxReadBytes: 256 * 1024,
  findSymbolTimeoutMillis: 2_000,
  findSymbolMaxPaths: 64,
  findSymbolMaxBufferBytes: 1024 * 1024,
} as const;

export interface ProductionProbeOptions {
  /** The workspace root every relative path resolves against. Defaults to cwd. */
  readonly root?: string;
  readonly maxReadBytes?: number;
  readonly findSymbolTimeoutMillis?: number;
  readonly findSymbolMaxPaths?: number;
}

/**
 * The probe the product passes: one bounded `readFileSync` per path and one
 * bounded `rg --files-with-matches` per symbol. Every failure — a missing
 * `rg`, a nonzero exit, a timeout, a file over the size cap — returns an empty
 * result, which resolves to `unresolved` and never compacts.
 */
export const productionProbe = (options: ProductionProbeOptions = {}): FileProbe => {
  const root = options.root ?? process.cwd();
  const maxReadBytes = options.maxReadBytes ?? PROBE_DEFAULTS.maxReadBytes;
  const findSymbolTimeoutMillis =
    options.findSymbolTimeoutMillis ?? PROBE_DEFAULTS.findSymbolTimeoutMillis;
  const findSymbolMaxPaths = options.findSymbolMaxPaths ?? PROBE_DEFAULTS.findSymbolMaxPaths;

  return {
    read: (path) => {
      try {
        const full = resolve(root, path);
        const stat = statSync(full);
        if (!stat.isFile() || stat.size > maxReadBytes) return undefined;
        return readFileSync(full, "utf8");
      } catch {
        return undefined;
      }
    },
    findSymbol: (symbol) => {
      if (symbol.trim().length === 0) return [];
      try {
        const output = execFileSync(
          "rg",
          [
            "--files-with-matches",
            "--fixed-strings",
            "--glob",
            "!**/node_modules/**",
            "--",
            symbol,
            ".",
          ],
          {
            cwd: root,
            timeout: findSymbolTimeoutMillis,
            maxBuffer: PROBE_DEFAULTS.findSymbolMaxBufferBytes,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
          },
        );
        return output
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.length > 0)
          .map((line) => line.replace(/^\.\//, ""))
          .slice(0, findSymbolMaxPaths);
      } catch {
        return [];
      }
    },
  };
};
