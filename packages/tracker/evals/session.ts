import { Effect } from "effect";
import { decodeStateEffect, migrateState } from "../src/core/domain.ts";
import type { TimedSnapshot } from "./derive.ts";

/**
 * Read a Pi session log.
 *
 * `harvest.ts` uses this to turn a log into tracker snapshots and a work
 * record; the context-size pass uses the same parse to size the conversation at
 * a decision. Both read raw lines, so the parsing lives in one place.
 */

/** The marker every tracker snapshot line carries. */
export const MARKER = "tracker/state";

/** The fields this module reads from a raw session line. */
export interface RawEntry {
  readonly type?: unknown;
  readonly customType?: unknown;
  readonly timestamp?: unknown;
  readonly data?: unknown;
}

export const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

export const textOf = (value: unknown): string => (typeof value === "string" ? value : "");

const numberOf = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

/** One parsed session log: the tracker snapshots, and every entry by line. */
export interface ParsedSession {
  readonly snapshots: readonly TimedSnapshot[];
  /** Line index of each snapshot, parallel to `snapshots`. */
  readonly snapshotLines: readonly number[];
  /** Parsed entry by line index. Undefined for an empty or unparseable line. */
  readonly entries: readonly (unknown | undefined)[];
}

/**
 * Parse one session log in file order. Every line is parsed, because the work
 * record needs the assistant and tool entries, not only the tracker snapshots.
 */
export const parseSession = (text: string, onSkipped: () => void): ParsedSession => {
  const lines = text.split("\n");
  const entries: (unknown | undefined)[] = Array.from({ length: lines.length });
  const snapshots: TimedSnapshot[] = [];
  const snapshotLines: number[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    entries[index] = parsed;
    const entry = asRecord(parsed) as RawEntry;
    if (entry.type !== "custom" || entry.customType !== MARKER) continue;
    try {
      snapshots.push({
        at: typeof entry.timestamp === "string" ? entry.timestamp : "",
        // Decode then migrate, exactly as `TrackerPersistence.restore` does, so
        // every item carries a real id before the transition is computed.
        state: migrateState(Effect.runSync(decodeStateEffect(entry.data))),
      });
      snapshotLines.push(index);
    } catch {
      onSkipped();
    }
  }
  return { snapshots, snapshotLines, entries };
};

/**
 * How large the conversation was at one line of the log: everything the model
 * would have been charged to read on the next turn.
 *
 * `inputTokens` is the prompt size of the last assistant turn before the line,
 * which is `input + cacheRead + cacheWrite`. A turn's `output` is its answer,
 * not the context it was given.
 */
export interface ContextSize {
  /** Parsed session entries before the line. */
  readonly entries: number;
  /** User and assistant messages before the line. */
  readonly messages: number;
  /** Characters of raw entry JSON before the line. */
  readonly chars: number;
  /** Prompt tokens on the last assistant turn before the line. */
  readonly inputTokens: number;
}

export const contextAt = (
  entries: readonly (unknown | undefined)[],
  lineIndex: number,
): ContextSize => {
  let count = 0;
  let messages = 0;
  let chars = 0;
  let inputTokens = 0;
  const end = Math.min(lineIndex, entries.length);
  for (let index = 0; index < end; index += 1) {
    const raw = entries[index];
    if (raw === undefined) continue;
    count += 1;
    chars += JSON.stringify(raw).length;
    const entry = asRecord(raw);
    if (textOf(entry.type) !== "message") continue;
    const message = asRecord(entry.message);
    const role = textOf(message.role);
    if (role === "user" || role === "assistant") messages += 1;
    if (role !== "assistant") continue;
    const usage = asRecord(message.usage);
    const prompt = numberOf(usage.input) + numberOf(usage.cacheRead) + numberOf(usage.cacheWrite);
    if (prompt > 0) inputTokens = prompt;
  }
  return { entries: count, messages, chars, inputTokens };
};
