/**
 * Pure helpers for interactive labeling.
 *
 * `label.ts` owns the terminal and the file writes. This module owns the parts
 * that can be tested without a terminal: the label file format, the work queue,
 * the card rendering, and the key mapping.
 */

import { readiness } from "../src/core/deps.ts";
import type { EvidenceEntry } from "./evidence.ts";
import type { CaseFacts } from "./facts.ts";
import { passOfRecord } from "./pass.ts";
import type { LabelSample } from "./sample.ts";
import { plainPaint, type Paint } from "./style.ts";
import type { StoredCase, StoredEvidence, StoredItem } from "./case-file.ts";

/** One surfaced disagreement between the answer and the revealed row. */
export interface StoredSurprise {
  readonly caseId: string;
  readonly questionKey: string;
  readonly rule: string;
  readonly label: string;
  readonly at: string;
}

/** Append one surprise row. The caller owns the file. */
export const recordSurprise = (records: StoredSurprise[], surprise: StoredSurprise): void => {
  records.push(surprise);
};

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
  /** The corpus the label belongs to. Absent on an old record. */
  readonly corpus?: string;
  /** The explicit pass. Absent on an old record; `passOfRecord` derives one. */
  readonly pass?: string;
  /** The replayed rule row the case's head fired, when facts were loaded. */
  readonly rule?: string;
  /** Where the facts came from: `live`, `replayed`, `mismatch`, `unresolved`. */
  readonly source?: string;
  /** True on a blind pilot seed. A pilot record never enters a pass. */
  readonly pilot?: true;
  /** 2 on a second-wave refill card. */
  readonly wave?: number;
  /** Show the row, the verdict, and the source after the answer locks. */
  readonly reveal?: boolean;
  /** Called when the labeler marks the revealed row surprising. */
  readonly onSurprise?: (surprise: StoredSurprise) => void;
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
      ...(typeof record.corpus === "string" ? { corpus: record.corpus } : {}),
      ...(typeof record.pass === "string" ? { pass: record.pass } : {}),
      ...(typeof record.rule === "string" ? { rule: record.rule } : {}),
      ...(typeof record.source === "string" ? { source: record.source } : {}),
      ...(record.pilot === true ? { pilot: true as const } : {}),
      ...(typeof record.wave === "number" ? { wave: record.wave } : {}),
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

/** One label joined to its question, inside one pass. */
export interface LabeledPair {
  readonly caseId: string;
  readonly key: string;
  readonly label: LabelValue;
  readonly at: string;
  readonly pass: string;
}

/**
 * Join the labeled questions of one pass. A `pilot: true` record is a blind
 * repeat and never enters a pass measurement, and a record for a case outside
 * the corpus is dropped.
 */
export const labeledPairs = (
  cases: readonly StoredCase[],
  records: readonly LabelRecord[],
  pass: string,
): readonly LabeledPair[] => {
  const keys = new Map<string, ReadonlySet<string>>();
  for (const entry of cases) {
    keys.set(entry.caseId, new Set(entry.questions.map((question) => question.key)));
  }
  const pairs: LabeledPair[] = [];
  for (const record of records) {
    if (record.pilot === true) continue;
    if (passOfRecord(record) !== pass) continue;
    if (keys.get(record.caseId)?.has(record.key) !== true) continue;
    pairs.push({
      caseId: record.caseId,
      key: record.key,
      label: record.label,
      at: record.at,
      pass,
    });
  }
  return pairs;
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
  /** True when this card is a blind pilot seed. */
  readonly pilot?: boolean;
}

/** What to queue. */
export interface QueueOptions {
  /** Keep only these candidate classes. All classes when absent. */
  readonly classes?: readonly string[];
  /** Stop after this many candidates. All when absent. */
  readonly limit?: number;
  /** Answers to skip. */
  readonly answered: ReadonlyMap<string, LabelValue>;
  /** Walk this sample's stored order. Corpus order when absent. */
  readonly sample?: LabelSample;
  /** Keep only the given pass of the sample. All its passes when absent. */
  readonly pass?: string;
  /** Queue the sample's pilot ids as an ordinary sitting, before any pass. */
  readonly pilot?: boolean;
  /** Keep only declared heads, only controls, or both. */
  readonly focus?: "declared" | "control" | "all";
}

/** True when a candidate carries a declared reference or product. */
const declaredCandidate = (candidate: {
  readonly refs?: readonly unknown[];
  readonly produces?: readonly unknown[];
}): boolean => (candidate.refs?.length ?? 0) + (candidate.produces?.length ?? 0) > 0;

const matchesFocus = (
  candidate: { readonly refs?: readonly unknown[]; readonly produces?: readonly unknown[] },
  focus: QueueOptions["focus"],
): boolean =>
  focus === undefined || focus === "all" || (focus === "declared") === declaredCandidate(candidate);

/**
 * Walk the sample's stored order. A sitting contributes its pilot seeds first,
 * then its cards; a sampled case contributes its head question only.
 */
const buildSampledQueue = (
  cases: readonly StoredCase[],
  evidence: ReadonlyMap<string, StoredEvidence>,
  options: QueueOptions & { readonly sample: LabelSample },
): readonly QueueCase[] => {
  const byId = new Map(cases.map((entry) => [entry.caseId, entry]));
  const queue: QueueCase[] = [];
  let candidates = 0;
  const named =
    options.pass === undefined
      ? undefined
      : options.sample.passes[options.pass as keyof LabelSample["passes"]];
  const passes = named === undefined ? Object.values(options.sample.passes) : [named];
  const push = (caseId: string, pilot: boolean): boolean => {
    const entry = byId.get(caseId);
    if (entry === undefined) return true;
    const candidate = entry.candidates[0];
    const question = entry.questions[0];
    if (candidate === undefined || question === undefined) return true;
    if (options.classes !== undefined && !options.classes.includes(candidate.class)) return true;
    if (!matchesFocus(candidate, options.focus)) return true;
    const labelKey = labelKeyOf(entry.caseId, question.key);
    if (options.answered.has(labelKey)) return true;
    if (options.limit !== undefined && candidates >= options.limit) return false;
    candidates += 1;
    queue.push({
      entry,
      evidence: evidence.get(entry.caseId),
      position: queue.length + 1,
      pending: [{ labelKey, questionKey: question.key, index: 0 }],
      ...(pilot ? { pilot: true } : {}),
    });
    return true;
  };
  if (options.pilot === true) {
    for (const caseId of options.sample.pilot) if (!push(caseId, false)) return queue;
    return queue;
  }
  for (const pass of passes) {
    for (const sitting of pass.sittings) {
      for (const seed of sitting.seededWith) if (!push(seed, true)) return queue;
      for (const card of sitting.cards) if (!push(card, false)) return queue;
    }
  }
  return queue;
};

/** Build the work queue: every unanswered question, in corpus order. */
export const buildQueue = (
  cases: readonly StoredCase[],
  evidence: ReadonlyMap<string, StoredEvidence>,
  options: QueueOptions,
): readonly QueueCase[] => {
  if (options.sample !== undefined)
    return buildSampledQueue(cases, evidence, {
      ...options,
      sample: options.sample,
    });
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
    if (item.description !== undefined && item.description.length > 0) {
      lines.push(
        `  ${" ".repeat(idWidth)}  ${" ".repeat(19)}${paint.dim(oneLine(item.description, size))}`,
      );
    }
    const declarations = [
      ...(item.refs ?? []).map((reference) => `refs: ${describeReference(reference)}`),
      ...(item.produces ?? []).map((product) => `produces: ${product.path}`),
    ].join("  ");
    if (declarations.length > 0) {
      lines.push(
        `  ${" ".repeat(idWidth)}  ${" ".repeat(19)}${paint.dim(oneLine(declarations, size))}`,
      );
    }
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
    if (item.description !== undefined && item.description.length > 0) {
      lines.push(indented(item.description, width, "    ", paint.dim));
    }
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

/** One declared or resolved reference, flattened for display. */
interface ReferenceView {
  readonly kind: string;
  readonly path?: string;
  readonly symbol?: string;
  readonly span?: string;
  readonly topic?: string;
}

/** One reference line: the kind, then the fields that kind owns. */
const describeReference = (reference: ReferenceView): string => {
  if (reference.kind === "decision") return `decision: ${reference.topic ?? ""}`;
  const symbol = reference.symbol === undefined ? "" : ` (${reference.symbol})`;
  const span = reference.span === undefined ? "" : ` [${reference.span}]`;
  return `path: ${reference.path ?? ""}${symbol}${span}`;
};

/** What the card may show. Facts are hidden until the answer locks. */
export interface CandidateCard {
  readonly facts?: CaseFacts;
  /** True after the answer: shows the row, the verdict, and the provenance. */
  readonly revealed?: boolean;
}

/** One question, with its two criteria. */
export const renderCandidate = (
  queueCase: QueueCase,
  candidate: QueueCandidate,
  position: number,
  width: number,
  paint: Paint = plainPaint,
  card: CandidateCard = {},
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
    ...(view.description === undefined || view.description.length === 0
      ? []
      : [indented(view.description, width, "  ", paint.dim)]),
    indented(`relationship: ${view.relationship}`, width, "  ", paint.dim),
  ];
  if (view.refs !== undefined && view.refs.length > 0) {
    lines.push(indented("refs:", width, "  ", paint.dim));
    for (const reference of view.refs) {
      lines.push(indented(describeReference(reference), width, "    ", paint.dim));
    }
  }
  if (view.produces !== undefined && view.produces.length > 0) {
    lines.push(indented("produces:", width, "  ", paint.dim));
    for (const product of view.produces) {
      lines.push(indented(product.path, width, "    ", paint.dim));
    }
  }
  const facts = card.facts;
  const shownFacts =
    facts === undefined
      ? undefined
      : candidate.index === 0
        ? facts.head
        : facts.diagnostics[candidate.index - 1];
  const revealed = card.revealed === true;
  if (facts !== undefined) {
    lines.push("", indented("RESOLUTION", width, "  ", paint.dim));
    if (facts.source === "unresolved") {
      lines.push(indented("unresolved", width, "    ", paint.yellow));
    }
    for (const reference of shownFacts?.references ?? []) {
      lines.push(
        indented(
          `${describeReference(reference.reference)}: ${reference.state}`,
          width,
          "    ",
          paint.dim,
        ),
      );
    }
    for (const product of shownFacts?.products ?? []) {
      lines.push(indented(`${product.path}: ${product.state}`, width, "    ", paint.dim));
    }
    if (revealed && shownFacts !== undefined) {
      lines.push("", indented("ROW", width, "  ", paint.dim));
      lines.push(indented(`${shownFacts.row} (${shownFacts.verdict})`, width, "    ", paint.bold));
      lines.push(indented(`resolution: ${facts.source}`, width, "    ", paint.dim));
    }
  }
  const decision = entry.decision;
  if (
    revealed &&
    facts === undefined &&
    decision !== undefined &&
    decision.candidateRef === view.ref
  ) {
    lines.push(
      indented(`decision: ${decision.rule} (${decision.verdict})`, width, "  ", paint.dim),
    );
    for (const reference of decision.references) {
      lines.push(
        indented(`${describeReference(reference)}: ${reference.state}`, width, "    ", paint.dim),
      );
    }
    for (const product of decision.products) {
      lines.push(indented(`${product.path}: ${product.state}`, width, "    ", paint.dim));
    }
  }
  lines.push("", indented(`question: ${question.instructions}`, width));
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

/** Why a pass name cannot be labeled, or null when the sample lists it. */
export const passRefusal = (
  sample: LabelSample | undefined,
  pass: string | undefined,
): string | null => {
  if (pass === undefined) return null;
  const passes = sample === undefined ? [] : Object.keys(sample.passes);
  return passes.includes(pass)
    ? null
    : `unknown pass ${pass}; the sample lists ${passes.join(", ") || "(none)"}`;
};

/** The sample's pass split and its declared/control mix, for `--report`. */
export const formatSampleSplit = (sample: LabelSample, cases: readonly StoredCase[]): string => {
  const declared = new Set(
    cases
      .filter((entry) => {
        const candidate = entry.candidates[0];
        return (
          candidate !== undefined &&
          (candidate.refs?.length ?? 0) + (candidate.produces?.length ?? 0) > 0
        );
      })
      .map((entry) => entry.caseId),
  );
  const counts = Object.entries(sample.passes).map(([name, pass]) => {
    const cards = pass.sittings.flatMap((sitting) => sitting.cards);
    return { name, cards, declared: cards.filter((id) => declared.has(id)).length };
  });
  const all = new Set(counts.flatMap((pass) => pass.cards));
  const declaredTotal = [...all].filter((id) => declared.has(id)).length;
  return [
    `sample: ${counts.map((pass) => `${pass.name} ${pass.cards.length} cards`).join(", ")}, ${sample.pilot.length} pilot seeds`,
    `declared ${declaredTotal}, controls ${all.size - declaredTotal}`,
  ].join("\n");
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
  /** The corpus a record names. Absent for an old-corpus run. */
  readonly corpus?: string;
  /** The explicit pass a record names. */
  readonly pass?: string;
  /** The frozen facts, so a record names its replayed row and source. */
  readonly facts?: ReadonlyMap<string, CaseFacts>;
  /** 2 on a second-wave refill card. */
  readonly wave?: number;
  /** Show the row, the verdict, and the source after the answer locks. */
  readonly reveal?: boolean;
  /** Called when the labeler marks the revealed row surprising. */
  readonly onSurprise?: (surprise: StoredSurprise) => void;
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
  const factsOf = (queueCase: QueueCase): CaseFacts | undefined =>
    options.facts?.get(queueCase.entry.caseId);
  const ask = (queueCase: QueueCase, candidate: QueueCandidate, pendingPos: number): string => {
    const facts = factsOf(queueCase);
    const card: CandidateCard = facts === undefined ? {} : { facts };
    return renderCandidate(queueCase, candidate, pendingPos + 1, options.width, paint, card);
  };
  const reveal = async (
    queueCase: QueueCase,
    candidate: QueueCandidate,
    label: LabelValue,
  ): Promise<void> => {
    if (options.reveal !== true) return;
    const facts = factsOf(queueCase);
    if (facts === undefined) return;
    session.write(
      `\n${renderCandidate(queueCase, candidate, 1, options.width, paint, { facts, revealed: true })}`,
    );
    session.write(`\n${paint.dim("[!] surprise  [any] continue")}\n${paint.dim(">")} `);
    const key = await session.nextKey();
    if (key !== "!") return;
    options.onSurprise?.({
      caseId: queueCase.entry.caseId,
      questionKey: candidate.questionKey,
      rule: facts.head.row,
      label,
      at: options.now(),
    });
    session.write(`  ${paint.dim("recorded a surprise")}\n`);
  };
  const record = (queueCase: QueueCase, candidate: QueueCandidate, label: LabelValue): void => {
    const facts = options.facts?.get(queueCase.entry.caseId);
    store.append({
      caseId: queueCase.entry.caseId,
      key: candidate.questionKey,
      label,
      at: options.now(),
      ...(options.corpus === undefined ? {} : { corpus: options.corpus }),
      ...(options.pass === undefined ? {} : { pass: options.pass }),
      ...(facts === undefined ? {} : { rule: facts.head.row, source: facts.source }),
      ...(queueCase.pilot === true ? { pilot: true } : {}),
      ...(options.wave === undefined ? {} : { wave: options.wave }),
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
      await reveal(queueCase, candidate, suggestion.label);
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
      await reveal(queueCase, candidate, action.label);
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
    await reveal(queueCase, candidate, action.label);
    pendingPos = queueCase.pending.length;
  }
  return { answered, quit: false };
};
