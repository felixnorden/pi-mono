/**
 * Pure helpers for interactive labeling.
 *
 * `label.ts` owns the terminal and the file writes. This module owns the parts
 * that can be tested without a terminal: the label file format, the work queue,
 * the card rendering, and the key mapping.
 */

import { readiness } from "../src/core/deps.ts";
import type { EvidenceEntry } from "./evidence.ts";
import { plainPaint, type Paint } from "./style.ts";
import type { StoredCase, StoredEvidence, StoredItem } from "./case-file.ts";

/** The two answers the classifier question allows. */
export const LABELS = {
  needsContext: "needs-context",
  standsAlone: "stands-alone",
} as const;

export type LabelValue = (typeof LABELS)[keyof typeof LABELS];

/** One answer, appended to `data/labels.jsonl`. */
export interface LabelRecord {
  readonly caseId: string;
  readonly key: string;
  readonly label: LabelValue;
  readonly at: string;
}

/** Key for one answered question. The separator cannot appear in either part. */
export const labelKeyOf = (caseId: string, questionKey: string): string =>
  `${caseId}\u0000${questionKey}`;

export const formatLabelRecord = (record: LabelRecord): string => JSON.stringify(record);

/**
 * Parse a labels file. A malformed line is skipped rather than fatal, so a
 * crash mid-write cannot block the next run.
 */
export const parseLabels = (text: string): readonly LabelRecord[] => {
  const records: LabelRecord[] = [];
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const record = parsed as Record<string, unknown>;
    const label = record.label;
    if (label !== LABELS.needsContext && label !== LABELS.standsAlone) continue;
    if (typeof record.caseId !== "string" || typeof record.key !== "string") continue;
    records.push({
      caseId: record.caseId,
      key: record.key,
      label,
      at: typeof record.at === "string" ? record.at : "",
    });
  }
  return records;
};

/** Answer by label key. A later record wins, so a re-label replaces the first. */
export const labelIndex = (records: readonly LabelRecord[]): ReadonlyMap<string, LabelValue> => {
  const index = new Map<string, LabelValue>();
  for (const record of records) index.set(labelKeyOf(record.caseId, record.key), record.label);
  return index;
};

/** One unanswered question, ready to ask. */
export interface QueueCandidate {
  readonly labelKey: string;
  readonly questionKey: string;
  /** Index into the case's `candidates` array. */
  readonly index: number;
}

/** One case with at least one unanswered question. */
export interface QueueCase {
  readonly entry: StoredCase;
  readonly evidence: StoredEvidence | undefined;
  /** Position in the queue, 1-based. */
  readonly position: number;
  readonly pending: readonly QueueCandidate[];
}

/** What to queue. */
export interface QueueOptions {
  /** Keep only these candidate classes. All classes when absent. */
  readonly classes?: readonly string[];
  /** Stop after this many candidates. All when absent. */
  readonly limit?: number;
  /** Answers to skip. */
  readonly answered: ReadonlyMap<string, LabelValue>;
}

/** Build the work queue: every unanswered question, in corpus order. */
export const buildQueue = (
  cases: readonly StoredCase[],
  evidence: ReadonlyMap<string, StoredEvidence>,
  options: QueueOptions,
): readonly QueueCase[] => {
  const queue: QueueCase[] = [];
  let candidates = 0;
  for (const entry of cases) {
    const pending: QueueCandidate[] = [];
    entry.candidates.forEach((candidate, index) => {
      const question = entry.questions[index];
      if (question === undefined) return;
      if (options.classes !== undefined && !options.classes.includes(candidate.class)) return;
      const labelKey = labelKeyOf(entry.caseId, question.key);
      if (options.answered.has(labelKey)) return;
      pending.push({ labelKey, questionKey: question.key, index });
    });
    if (pending.length === 0) continue;
    const remaining =
      options.limit === undefined ? pending.length : Math.max(0, options.limit - candidates);
    if (remaining === 0) break;
    const kept = pending.slice(0, remaining);
    candidates += kept.length;
    queue.push({
      entry,
      evidence: evidence.get(entry.caseId),
      position: queue.length + 1,
      pending: kept,
    });
    if (options.limit !== undefined && candidates >= options.limit) break;
  }
  return queue;
};

/** Total unanswered questions in the queue. */
export const queueSize = (queue: readonly QueueCase[]): number =>
  queue.reduce((total, entry) => total + entry.pending.length, 0);

/** Greedy word wrap. A word longer than the width is hard-split. */
export const wrap = (text: string, width: number): string => {
  const safeWidth = Math.max(1, width);
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter((part) => part.length > 0)) {
    const pieces =
      word.length <= safeWidth
        ? [word]
        : (word.match(new RegExp(`.{1,${safeWidth}}`, "g")) ?? [word]);
    for (const piece of pieces) {
      if (line.length === 0) line = piece;
      else if (line.length + 1 + piece.length <= safeWidth) line += ` ${piece}`;
      else {
        lines.push(line);
        line = piece;
      }
    }
  }
  if (line.length > 0) lines.push(line);
  return lines.join("\n");
};

const oneLine = (text: string, width: number): string =>
  text.length <= width ? text : `${text.slice(0, Math.max(0, width - 1))}…`;

const noTint = (text: string): string => text;

/** Wrap, indent, then tint. Tinting after wrapping keeps escape codes out of the width count. */
const indented = (
  text: string,
  width: number,
  prefix = "  ",
  tint: (text: string) => string = noTint,
): string =>
  tint(
    wrap(text, width - prefix.length)
      .split("\n")
      .map((line) => `${prefix}${line}`)
      .join("\n"),
  );

/** How many work-record entries and lines per entry a card shows. */
export interface EvidenceView {
  /** Entries shown from the end of the record. */
  readonly entries: number;
  /** Lines kept per entry. */
  readonly lines: number;
}

/** The default card: the newest entries, since those are what the batch produced. */
export const compactView: EvidenceView = { entries: 8, lines: 8 };

/** What `p` shows: the whole record, with long entries intact. */
export const fullView: EvidenceView = { entries: Number.MAX_SAFE_INTEGER, lines: 200 };

/** Per-kind line budget. A tool result is usually noise, so it gets fewer. */
const KIND_LINES: Readonly<Record<EvidenceEntry["kind"], number>> = {
  assistant: 10,
  user: 10,
  custom: 10,
  "tool-call": 10,
  "tool-result": 5,
};

/** Data-driven state text. Painted after padding, so the tone is read from the trimmed text. */
const itemStatePaint = (state: string, paint: Paint): string => {
  const bare = state.trim();
  if (bare === "done, this batch") return paint.yellow(state);
  if (bare === "candidate") return paint.bold(paint.cyan(state));
  if (bare.startsWith("blocked")) return paint.red(state);
  if (bare === "done") return paint.dim(state);
  return paint.green(state);
};

const itemState = (
  item: StoredItem,
  ref: string,
  blockers: readonly string[],
  batch: ReadonlySet<string>,
  candidates: ReadonlySet<string>,
): string => {
  if (item.done) return batch.has(ref) ? "done, this batch" : "done";
  if (candidates.has(ref)) return "candidate";
  return blockers.length > 0 ? `blocked by ${blockers.join(", ")}` : "ready";
};

/**
 * The plan at the decision: every item with its state, and the judged
 * candidates marked. Printed directly above each candidate question.
 */
export const renderList = (
  queueCase: QueueCase,
  width: number,
  paint: Paint = plainPaint,
): string => {
  const { entry } = queueCase;
  const batch = new Set(entry.completed.map((item) => item.ref));
  const candidates = new Set(entry.candidates.map((item) => item.ref));
  const view = readiness({ name: entry.list.name, items: entry.list.items });
  const idWidth = Math.max(...entry.list.items.map((item) => String(item.id).length), 2);
  const lines = ["", paint.dim("THE LIST")];
  entry.list.items.forEach((item, index) => {
    const ref = `${entry.list.name}:${item.id}`;
    const id = String(item.id).padStart(idWidth, " ");
    const state = itemState(item, ref, view[index]?.blockers ?? [], batch, candidates).padEnd(
      19,
      " ",
    );
    const size = Math.max(12, width - idWidth - state.length - 8);
    lines.push(`  ${paint.dim(id)}  ${itemStatePaint(state, paint)}${oneLine(item.text, size)}`);
  });
  return lines.join("\n");
};

/**
 * The context for the decision: which case this is, and the work that just left
 * the context. Printed once per case, above the list and the candidate.
 */
export const renderCaseContext = (
  queueCase: QueueCase,
  totalCases: number,
  width: number,
  paint: Paint = plainPaint,
  evidenceView: EvidenceView = compactView,
): string => {
  const { entry } = queueCase;
  const lines = [
    "",
    paint.dim("═".repeat(width)),
    paint.bold(
      `case ${queueCase.position}/${totalCases} · ${entry.list.name} · ${queueCase.pending.length} to label`,
    ),
    paint.dim("═".repeat(width)),
    `${paint.dim("id:  ")} ${entry.caseId}`,
    `${paint.dim("at:  ")} ${entry.at}`,
    `${paint.dim("list:")} ${entry.itemCount} items, ${entry.openCount} open, ${entry.doneCount} done, ${entry.declaredDeps} with deps`,
    "",
    paint.dim("JUST COMPLETED"),
  ];
  for (const item of entry.completed) {
    lines.push(indented(`${item.ref}  ${item.text}`, width, "  ", paint.yellow));
  }
  lines.push("", renderEvidence(queueCase.evidence, width, paint, evidenceView));
  return lines.join("\n");
};

const KIND_PAINT = (kind: EvidenceEntry["kind"], paint: Paint): ((text: string) => string) => {
  switch (kind) {
    case "assistant":
      return paint.cyan;
    case "tool-call":
      return paint.magenta;
    case "tool-result":
      return paint.gray;
    case "user":
      return paint.green;
    default:
      return paint.blue;
  }
};

/** Pretty-print JSON arguments. A truncated body is not valid JSON and stays as it is. */
const prettyJson = (text: string): string => {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
};

/** Cut a source body to `max` lines, naming what was dropped. */
const limitSourceLines = (text: string, max: number, paint: Paint): string => {
  const lines = text.split("\n");
  if (lines.length <= max) return text;
  return [...lines.slice(0, max), paint.dim(`… ${lines.length - max} more line(s)`)].join("\n");
};

/** Cut rendered markdown to `max` lines. Rendering expands markup, so this runs after. */
const limitRenderedLines = (text: string, max: number, paint: Paint): string => {
  const lines = text.split("\n");
  if (lines.length <= max) return text;
  return [...lines.slice(0, max), paint.dim(`… ${lines.length - max} more line(s)`)].join("\n");
};

/**
 * Body of one entry: markdown for prose, a framed block for tool traffic.
 *
 * Tool traffic is cut before framing, so the frame's own two lines can never
 * be trimmed off.
 */
const entryBody = (
  entry: EvidenceEntry,
  columns: number,
  maxLines: number,
  paint: Paint,
): string => {
  if (entry.kind === "assistant" || entry.kind === "user" || entry.kind === "custom") {
    return limitRenderedLines(paint.markdown(entry.text, columns), maxLines, paint);
  }
  const source = entry.kind === "tool-call" ? prettyJson(entry.text) : entry.text;
  const language = entry.kind === "tool-call" ? "json" : "text";
  return paint.code(limitSourceLines(source, maxLines, paint), language, columns);
};

/** The work record: markdown prose and framed tool blocks, newest entries last. */
export const renderEvidence = (
  evidence: StoredEvidence | undefined,
  width: number,
  paint: Paint = plainPaint,
  view: EvidenceView = compactView,
): string => {
  if (evidence === undefined || evidence.entries.length === 0) {
    return `${paint.dim("WORK RECORD")}\n  ${paint.dim("(empty)")}`;
  }
  const total = evidence.entries.length;
  const shown =
    total <= view.entries ? evidence.entries : evidence.entries.slice(total - view.entries);
  const hidden = total - shown.length;
  const shownLabel =
    hidden === 0 ? `${total} entries` : `${total} entries, newest ${shown.length}; press p for all`;
  const header = `WORK RECORD (${shownLabel})`;
  const lines = [paint.dim(header)];
  const columns = Math.max(20, width - 6);
  shown.forEach((entry, offset) => {
    const index = hidden + offset + 1;
    const name = entry.name === undefined ? "" : ` ${paint.yellow(entry.name)}`;
    const error = entry.isError === true ? ` ${paint.red("ERROR")}` : "";
    lines.push(
      `  ${paint.dim(String(index).padStart(3, " "))}. ${paint.dim(`[${entry.at.slice(11, 19)}]`)} ${KIND_PAINT(entry.kind, paint)(entry.kind)}${name}${error}`,
    );
    const body = entryBody(entry, columns, Math.min(KIND_LINES[entry.kind], view.lines), paint);
    lines.push(
      body
        .split("\n")
        .map((line) => `      ${line}`)
        .join("\n"),
    );
  });
  if (evidence.omitted > 0) {
    lines.push(`  ${paint.dim(`(${evidence.omitted} earlier entries omitted by the cap)`)}`);
  }
  return lines.join("\n");
};

/** One question, with its two criteria. */
export const renderCandidate = (
  queueCase: QueueCase,
  candidate: QueueCandidate,
  position: number,
  width: number,
  paint: Paint = plainPaint,
): string => {
  const entry = queueCase.entry;
  const view = entry.candidates[candidate.index];
  const question = entry.questions[candidate.index];
  if (view === undefined || question === undefined) return "";
  const lines = [
    "",
    paint.bold(
      `CANDIDATE ${position}/${queueCase.pending.length}  ${paint.cyan(view.ref)}  (${view.class})`,
    ),
    indented(view.text, width, "  ", paint.bold),
    indented(`relationship: ${view.relationship}`, width, "  ", paint.dim),
    "",
    indented(`question: ${question.instructions}`, width),
  ];
  for (const [label, description] of Object.entries(question.criteria)) {
    const tint = label === LABELS.needsContext ? paint.yellow : paint.green;
    lines.push(indented(`${label}: ${description}`, width, "  ", tint));
  }
  return lines.join("\n");
};

/** The prompt without escape codes, for tests and measurement. */
export const PROMPT_KEYS =
  "[n]eeds-context  [s]tands-alone  [a]ll stands  [A]ll needs  [p]rint  [u]ndo  [k]ip case  [q]uit";

/** The key prompt. */
export const PROMPT = `${PROMPT_KEYS}\n> `;

/**
 * A structural pre-label for one question, shown above the prompt.
 *
 * A suggestion is a default, not an answer. Enter accepts it and writes a
 * normal label, so the ground truth still passes through a human keypress.
 */
export interface LabelSuggestion {
  readonly label: LabelValue;
  /** The rule that produced it, in one phrase. */
  readonly reason: string;
  readonly confidence: string;
}

/** The key prompt with the keys in bold, and the suggestion when one exists. */
export const renderPrompt = (paint: Paint, suggestion?: LabelSuggestion): string => {
  const keys = PROMPT_KEYS.replace(/\[.\]/g, (key) => paint.bold(key));
  if (suggestion === undefined) return `${keys}\n${paint.dim(">")} `;
  const tint =
    suggestion.label === LABELS.needsContext
      ? paint.yellow(suggestion.label)
      : paint.green(suggestion.label);
  return `${keys}\n${paint.dim("suggested:")} ${tint} ${paint.dim(`— ${suggestion.reason} (${suggestion.confidence})`)}${paint.dim("  [enter] accepts")}\n${paint.dim(">")} `;
};

/** What a keypress means. */
export type LabelAction =
  | { readonly kind: "answer"; readonly label: LabelValue }
  | { readonly kind: "answer-all"; readonly label: LabelValue }
  | { readonly kind: "accept" }
  | { readonly kind: "reprint" }
  | { readonly kind: "undo" }
  | { readonly kind: "skip-case" }
  | { readonly kind: "quit" }
  | { readonly kind: "unknown" };

export const keyToAction = (key: string): LabelAction => {
  switch (key) {
    case "n":
    case "1":
      return { kind: "answer", label: LABELS.needsContext };
    case "s":
    case "2":
      return { kind: "answer", label: LABELS.standsAlone };
    case "A":
      return { kind: "answer-all", label: LABELS.needsContext };
    case "a":
      return { kind: "answer-all", label: LABELS.standsAlone };
    case "\r":
    case "\n":
    case "return":
    case "enter":
      return { kind: "accept" };
    case "p":
    case "r":
    case "?":
      return { kind: "reprint" };
    case "u":
      return { kind: "undo" };
    case "k":
      return { kind: "skip-case" };
    case "q":
      return { kind: "quit" };
    default:
      return { kind: "unknown" };
  }
};

/** Counts for the report and the end-of-run summary. */
export interface LabelCounts {
  readonly total: number;
  readonly needsContext: number;
  readonly standsAlone: number;
  readonly needsContextByClass: Readonly<Record<string, number>>;
  readonly totalByClass: Readonly<Record<string, number>>;
}

const bump = (record: Record<string, number>, key: string): void => {
  record[key] = (record[key] ?? 0) + 1;
};

/** Count answers, grouped by candidate class, using the corpus for the classes. */
export const countLabels = (
  cases: readonly StoredCase[],
  records: readonly LabelRecord[],
): LabelCounts => {
  const classOf = new Map<string, string>();
  for (const entry of cases) {
    entry.candidates.forEach((candidate, index) => {
      const question = entry.questions[index];
      if (question === undefined) return;
      classOf.set(labelKeyOf(entry.caseId, question.key), candidate.class);
    });
  }
  const needsContextByClass: Record<string, number> = {};
  const totalByClass: Record<string, number> = {};
  let needsContext = 0;
  let standsAlone = 0;
  for (const record of records) {
    const cls = classOf.get(labelKeyOf(record.caseId, record.key)) ?? "unknown";
    bump(totalByClass, cls);
    if (record.label === LABELS.needsContext) {
      needsContext += 1;
      bump(needsContextByClass, cls);
    } else {
      standsAlone += 1;
    }
  }
  return {
    total: records.length,
    needsContext,
    standsAlone,
    needsContextByClass,
    totalByClass,
  };
};

/** One line per class, with the share that needs context. */
export const formatCounts = (counts: LabelCounts): string => {
  const classes = [...new Set(Object.keys(counts.totalByClass))].sort();
  const lines = [
    `labeled ${counts.total}: ${counts.needsContext} needs-context, ${counts.standsAlone} stands-alone`,
  ];
  for (const cls of classes) {
    const total = counts.totalByClass[cls] ?? 0;
    const needs = counts.needsContextByClass[cls] ?? 0;
    const share = total === 0 ? 0 : Math.round((needs / total) * 100);
    lines.push(`  ${cls}: ${needs}/${total} needs-context (${share}%)`);
  }
  return lines.join("\n");
};

// --------------------------------------------------------------------------
// Run loop
// --------------------------------------------------------------------------

/** Terminal input and output. Injected so a test can script a session. */
export interface LabelSession {
  readonly write: (text: string) => void;
  /** Resolve with the next key. `q` means quit. */
  readonly nextKey: () => Promise<string>;
}

/** The answers file. Injected so a test can keep it in memory. */
export interface LabelStore {
  readonly records: LabelRecord[];
  readonly append: (record: LabelRecord) => void;
  /** Write `records` over the file. Used by undo. */
  readonly rewrite: () => void;
}

export interface RunOptions {
  readonly width: number;
  readonly now: () => string;
  /** Styling. Plain by default, so a test sees no escape codes. */
  readonly paint?: Paint | undefined;
  /** Structural pre-labels, keyed by `labelKeyOf(caseId, key)`. Enter accepts one. */
  readonly suggestions?: ReadonlyMap<string, LabelSuggestion> | undefined;
}

/** Where one queued question sits. */
interface Cursor {
  readonly casePos: number;
  readonly pendingPos: number;
}

const locate = (queue: readonly QueueCase[], labelKey: string): Cursor | undefined => {
  for (const [casePos, queueCase] of queue.entries()) {
    const pendingPos = queueCase.pending.findIndex((entry) => entry.labelKey === labelKey);
    if (pendingPos >= 0) return { casePos, pendingPos };
  }
  return undefined;
};

export interface RunResult {
  readonly answered: number;
  readonly quit: boolean;
}

/**
 * Ask every queued question in order, and record each answer.
 *
 * The cursor is flat rather than nested, so undo can move it backwards to the
 * question whose answer was removed, across a case boundary.
 */
export const runLabeling = async (
  queue: readonly QueueCase[],
  store: LabelStore,
  session: LabelSession,
  options: RunOptions,
): Promise<RunResult> => {
  const paint = options.paint ?? plainPaint;
  const tint = (label: LabelValue): string =>
    label === LABELS.needsContext ? paint.yellow(label) : paint.green(label);
  const ask = (queueCase: QueueCase, candidate: QueueCandidate, pendingPos: number): string =>
    renderCandidate(queueCase, candidate, pendingPos + 1, options.width, paint);
  const record = (queueCase: QueueCase, candidate: QueueCandidate, label: LabelValue): void => {
    store.append({
      caseId: queueCase.entry.caseId,
      key: candidate.questionKey,
      label,
      at: options.now(),
    });
  };

  let casePos = 0;
  let pendingPos = 0;
  let printedFor = -1;
  let printedCase = -1;
  let full = false;
  let answered = 0;

  while (casePos < queue.length) {
    const queueCase = queue[casePos]!;
    if (printedFor !== casePos) {
      // `p` shows the whole work record for the case it was pressed in; moving
      // to another case returns to the compact card.
      if (printedCase !== casePos) {
        full = false;
        printedCase = casePos;
      }
      session.write(
        renderCaseContext(
          queueCase,
          queue.length,
          options.width,
          paint,
          full ? fullView : compactView,
        ),
      );
      printedFor = casePos;
    }
    if (pendingPos >= queueCase.pending.length) {
      casePos += 1;
      pendingPos = 0;
      continue;
    }

    const candidate = queueCase.pending[pendingPos]!;
    // The list is printed for every question, so the plan state sits directly
    // above the item being judged instead of scrolling away behind it.
    session.write(renderList(queueCase, options.width, paint));
    session.write(ask(queueCase, candidate, pendingPos));
    const suggestion = options.suggestions?.get(
      labelKeyOf(queueCase.entry.caseId, candidate.questionKey),
    );
    session.write(`\n${renderPrompt(paint, suggestion)}`);
    const action = keyToAction(await session.nextKey());

    if (action.kind === "quit") return { answered, quit: true };
    if (action.kind === "unknown") {
      session.write("  unknown key\n");
      continue;
    }
    if (action.kind === "accept") {
      if (suggestion === undefined) {
        session.write("  no suggestion for this question\n");
        continue;
      }
      record(queueCase, candidate, suggestion.label);
      session.write(`  ${paint.dim("→")} ${tint(suggestion.label)}\n`);
      answered += 1;
      pendingPos += 1;
      continue;
    }
    if (action.kind === "reprint") {
      // Show the full work record, then re-ask the same question.
      full = true;
      printedFor = -1;
      continue;
    }
    if (action.kind === "skip-case") {
      session.write(`  skipped ${queueCase.pending.length - pendingPos} question(s)\n`);
      pendingPos = queueCase.pending.length;
      continue;
    }
    if (action.kind === "undo") {
      // Answers from an earlier run can be undone too: `records` holds the whole
      // file, and the last one is the most recent answer. Undo stops at empty.
      if (store.records.length === 0) {
        session.write("  nothing to undo\n");
        continue;
      }
      const removed = store.records.pop()!;
      store.rewrite();
      session.write(`  undid answer for ${removed.key}\n`);
      answered = Math.max(0, answered - 1);
      const target = locate(queue, labelKeyOf(removed.caseId, removed.key));
      if (target !== undefined) {
        casePos = target.casePos;
        pendingPos = target.pendingPos;
        printedFor = -1;
      }
      continue;
    }
    if (action.kind === "answer") {
      record(queueCase, candidate, action.label);
      session.write(`  ${paint.dim("→")} ${tint(action.label)}\n`);
      answered += 1;
      pendingPos += 1;
      continue;
    }
    // answer-all: the rest of this case takes the same label.
    let bulk = 0;
    for (let index = pendingPos; index < queueCase.pending.length; index += 1) {
      record(queueCase, queueCase.pending[index]!, action.label);
      bulk += 1;
    }
    answered += bulk;
    session.write(
      `  ${paint.dim("→")} ${tint(action.label)} ${paint.dim(`for ${bulk} question(s)`)}\n`,
    );
    pendingPos = queueCase.pending.length;
  }
  return { answered, quit: false };
};
