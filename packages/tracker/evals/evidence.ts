/**
 * Bound the session work record for one eval case.
 *
 * A case holds the list, the batch, and the frontier. That tells a labeler the
 * plan, not what the completed work produced. The classifier asks whether a
 * candidate needs the detail of that work, so a judge needs the work record:
 * the assistant messages and tool calls between the previous decision and this
 * one.
 *
 * This module turns raw session entries into that record. It keeps the tail
 * when the record is too long, because the work immediately before the
 * completion is what the batch produced.
 */

/** The tool-call fields the work signals read. A bounded projection, so a
 *  whole argument object never enters the corpus. */
export interface EvidenceArgs {
  readonly path?: string;
  readonly command?: string;
}

/** One rendered session event. */
export interface EvidenceEntry {
  readonly kind: "user" | "assistant" | "tool-call" | "tool-result" | "custom";
  readonly at: string;
  /** Tool name, or custom entry type. Absent for a message. */
  readonly name?: string;
  readonly text: string;
  readonly isError?: boolean;
  /** The tool call this result answers, when the entry carries one. */
  readonly callId?: string;
  /** The bounded `path` and `command` projection of a tool call. */
  readonly args?: EvidenceArgs;
  /**
   * New-side line range(s) of an edit result, e.g. `8` or `12-14,30-31`.
   * Parsed from the tool result's unified patch; absent without one.
   */
  readonly lines?: string;
}

/** The work record for one case, capped. */
export interface CaseEvidence {
  readonly entries: readonly EvidenceEntry[];
  /** Earlier entries dropped by the cap. */
  readonly omitted: number;
}

/** Characters allowed in one rendered field before it is cut. */
export const FIELD_LIMIT = 400;
/** Characters allowed in one case's whole work record. */
export const RECORD_LIMIT = 8_000;

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const asArray = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : []);

const textOf = (value: unknown): string => (typeof value === "string" ? value : "");

const cut = (text: string, limit = FIELD_LIMIT): string =>
  text.length <= limit ? text : `${text.slice(0, limit)}… [${text.length - limit} more characters]`;

/** Join the text parts of a message content array. */
const contentText = (content: unknown): string =>
  asArray(content)
    .map((part) => textOf(asRecord(part).text))
    .filter((text) => text.length > 0)
    .join("\n");

/** One new-side hunk header of a unified patch: `@@ -a,b +c,d @@`. */
const HUNK = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

/**
 * The new-side line range(s) an edit result touched, as `12-14` or `8`.
 * Reads the tool result's unified patch, and falls back to
 * `details.firstChangedLine`. Absent when neither is present.
 */
export const lineRangesOf = (details: unknown): string | undefined => {
  const patch = textOf(asRecord(details).patch);
  const ranges: string[] = [];
  for (const line of patch.split("\n")) {
    const match = HUNK.exec(line);
    if (match === null) continue;
    const start = Number(match[1]);
    const count = match[2] === undefined ? 1 : Number(match[2]);
    const end = count <= 1 ? start : start + count - 1;
    ranges.push(start === end ? String(start) : `${start}-${end}`);
  }
  if (ranges.length > 0) return ranges.slice(0, 4).join(",");
  const first = asRecord(details).firstChangedLine;
  return typeof first === "number" && Number.isFinite(first) ? String(first) : undefined;
};

/**
 * The bounded projection of a tool call's arguments: only a non-empty `path`
 * and a non-empty `command`. Absent when neither is present.
 */
const argsOf = (value: unknown): EvidenceArgs | undefined => {
  const record = asRecord(value);
  const path = textOf(record.path);
  const command = textOf(record.command);
  const args: EvidenceArgs = {
    ...(path.length === 0 ? {} : { path }),
    ...(command.length === 0 ? {} : { command }),
  };
  return Object.keys(args).length === 0 ? undefined : args;
};

/**
 * Render one parsed session entry into zero or more evidence entries.
 *
 * Thinking parts are dropped: they are long and they do not state what the work
 * produced. A `custom_message` entry is kept in a short form, because a
 * subagent result often carries the work product.
 */
export const renderEntry = (raw: unknown): readonly EvidenceEntry[] => {
  const entry = asRecord(raw);
  const at = textOf(entry.timestamp);
  const type = textOf(entry.type);

  if (type === "custom_message") {
    const name = textOf(entry.customType);
    const text = textOf(entry.content);
    return text.length === 0 ? [] : [{ kind: "custom", at, name, text: cut(text) }];
  }
  if (type !== "message") return [];

  const message = asRecord(entry.message);
  const role = textOf(message.role);

  if (role === "assistant") {
    const rendered: EvidenceEntry[] = [];
    for (const part of asArray(message.content)) {
      const record = asRecord(part);
      const partType = textOf(record.type);
      if (partType === "text") {
        const text = textOf(record.text);
        if (text.length > 0) rendered.push({ kind: "assistant", at, text: cut(text) });
      } else if (partType === "toolCall") {
        const callId = textOf(record.id);
        const args = argsOf(record.arguments);
        rendered.push({
          kind: "tool-call",
          at,
          name: textOf(record.name),
          text: cut(JSON.stringify(record.arguments ?? {})),
          ...(callId.length === 0 ? {} : { callId }),
          ...(args === undefined ? {} : { args }),
        });
      }
    }
    return rendered;
  }

  if (role === "toolResult") {
    const text = contentText(message.content);
    const callId = textOf(message.toolCallId);
    const lines = lineRangesOf(message.details);
    return [
      {
        kind: "tool-result",
        at,
        name: textOf(message.toolName),
        text: cut(text),
        isError: message.isError === true,
        ...(callId.length === 0 ? {} : { callId }),
        ...(lines === undefined ? {} : { lines }),
      },
    ];
  }

  if (role === "user" || role === "system") {
    const text = contentText(message.content);
    return text.length === 0 ? [] : [{ kind: "user", at, text: cut(text) }];
  }
  return [];
};

/**
 * Keep the newest entries that fit in `limit` characters, so the record ends
 * just before the completion. `omitted` names how many earlier entries the cap
 * dropped.
 */
export const capEvidence = (
  entries: readonly EvidenceEntry[],
  limit = RECORD_LIMIT,
): CaseEvidence => {
  let used = 0;
  let kept = 0;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const size = entries[index]!.text.length;
    if (used + size > limit && kept > 0) break;
    used += size;
    kept += 1;
  }
  return { entries: entries.slice(entries.length - kept), omitted: entries.length - kept };
};

/** Render a run of raw session entries into a capped work record. */
export const buildEvidence = (raw: readonly unknown[], limit = RECORD_LIMIT): CaseEvidence =>
  capEvidence(raw.flatMap(renderEntry), limit);
