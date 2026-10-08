/**
 * Render the harvested corpus as a review pack for hand labeling.
 *
 * `cases.jsonl` is built for machines. This script turns it into one markdown
 * file per decision, in session order, so consecutive decisions sit together.
 * Each file carries the list at the decision, the completed batch, the
 * candidates with their question, and the work record.
 *
 * Run: `bun run eval:review`.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readiness } from "../src/core/deps.ts";
import { readJsonl, type StoredCase, type StoredEvidence, type StoredItem } from "./case-file.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));

/** A markdown table cell cannot hold a pipe or a newline. */
const cell = (text: string): string => text.replace(/\|/g, "\\|").replace(/\n+/g, " ");

/** `2026-09-29T16:31:03.551Z` becomes `16:31:03`. */
const clock = (iso: string): string => iso.slice(11, 19);

/** A file name that sorts by session, then by decision. */
const fileName = (position: number, caseEntry: StoredCase): string => {
  const stamp = caseEntry.session.file.replace(/\.jsonl$/, "").slice(0, 24);
  return `${String(position).padStart(4, "0")}_${stamp}_e${caseEntry.index}.md`;
};

const stateOf = (
  item: StoredItem,
  blockers: readonly string[],
  batch: ReadonlySet<string>,
  ref: string,
  candidates: ReadonlySet<string>,
): string => {
  if (item.done) return batch.has(ref) ? "done, this batch" : "done";
  if (candidates.has(ref)) return "candidate";
  return blockers.length > 0 ? `blocked by ${blockers.join(", ")}` : "ready, unjudged";
};

const listTable = (caseEntry: StoredCase): string => {
  const batch = new Set(caseEntry.completed.map((item) => item.ref));
  const candidates = new Set(caseEntry.candidates.map((item) => item.ref));
  const view = readiness({ name: caseEntry.list.name, items: caseEntry.list.items });
  const rows = caseEntry.list.items.map((item, index) => {
    const ref = `${caseEntry.list.name}:${item.id}`;
    const blockers = view[index]?.blockers ?? [];
    return `| ${item.id} | ${stateOf(item, blockers, batch, ref, candidates)} | ${item.deps.join(", ")} | ${cell(item.text)} |`;
  });
  return ["| id | state | deps | text |", "| --- | --- | --- | --- |", ...rows].join("\n");
};

const batchSection = (caseEntry: StoredCase): string =>
  caseEntry.completed.map((item) => `- \`${item.ref}\` ${item.text}`).join("\n");

const candidateSection = (caseEntry: StoredCase): string =>
  caseEntry.candidates
    .map((candidate, index) => {
      const question = caseEntry.questions[index];
      const criteria = question?.criteria ?? {};
      return [
        `### ${index + 1}. \`${candidate.ref}\` (${candidate.class}, ${candidate.relationship})`,
        "",
        `> ${cell(candidate.text)}`,
        "",
        question?.instructions ?? "",
        "",
        ...Object.entries(criteria).map(([label, description]) => `- \`${label}\`: ${description}`),
        "",
        `Label key: \`${question?.key ?? ""}\``,
        "",
      ].join("\n");
    })
    .join("\n");

const evidenceSection = (evidence: StoredEvidence | undefined): string => {
  if (evidence === undefined || evidence.entries.length === 0) return "_No work record._";
  const lines = evidence.entries.map((entry, index) => {
    const clockText = clock(entry.at);
    const name = entry.name === undefined ? "" : ` \`${entry.name}\``;
    const error = entry.isError === true ? " **error**" : "";
    return `${index + 1}. [${clockText}] **${entry.kind}**${name}${error} ${entry.text.replace(/\n+/g, " ")}`;
  });
  const omitted =
    evidence.omitted === 0 ? "" : `\n\n_${evidence.omitted} earlier entries omitted by the cap._`;
  return `${lines.join("\n")}${omitted}`;
};

const labelSkeleton = (caseEntry: StoredCase): string =>
  [
    "```json",
    ...caseEntry.questions.map((question) =>
      JSON.stringify({ caseId: caseEntry.caseId, key: question.key, label: "", at: "" }),
    ),
    "```",
  ].join("\n");

const renderCase = (
  position: number,
  caseEntry: StoredCase,
  evidence: StoredEvidence | undefined,
  sessionCount: number,
): string =>
  [
    `# Case ${position}: ${caseEntry.list.name} e${caseEntry.index}`,
    "",
    `- case: \`${caseEntry.caseId}\``,
    `- at: ${caseEntry.at}`,
    `- list: ${caseEntry.list.name} (${caseEntry.itemCount} items, ${caseEntry.openCount} open, ${caseEntry.doneCount} done, ${caseEntry.declaredDeps} with deps)`,
    `- decision ${caseEntry.index + 1} of ${sessionCount} in this session`,
    "",
    "## List at the decision",
    "",
    listTable(caseEntry),
    "",
    "## Just completed",
    "",
    batchSection(caseEntry),
    "",
    "## Judge these",
    "",
    candidateSection(caseEntry),
    "## Work record",
    "",
    evidenceSection(evidence),
    "",
    "## Label",
    "",
    "Fill in `needs-context` or `stands-alone` on each line, then append the block to `data/labels.jsonl`.",
    "The `bun run eval:label` script writes the same lines for you.",
    "",
    labelSkeleton(caseEntry),
    "",
  ].join("\n");

const main = (): void => {
  const out = join(HERE, "data");
  const review = join(out, "review");
  const cases = readJsonl<StoredCase>(join(out, "cases.jsonl"));
  const evidence = new Map(
    readJsonl<StoredEvidence>(join(out, "evidence.jsonl")).map((record) => [record.caseId, record]),
  );
  if (cases.length === 0) {
    process.stderr.write(`no cases in ${out}; run bun run eval:harvest first\n`);
    process.exit(1);
  }

  const totals = new Map<string, number>();
  for (const caseEntry of cases) {
    const key = `${caseEntry.session.file}`;
    totals.set(key, (totals.get(key) ?? 0) + 1);
  }

  rmSync(review, { recursive: true, force: true });
  mkdirSync(review, { recursive: true });

  const index: string[] = ["# Review pack", ""];
  let position = 0;
  let currentSession = "";
  for (const caseEntry of cases) {
    position += 1;
    if (caseEntry.session.file !== currentSession) {
      currentSession = caseEntry.session.file;
      index.push("", `## ${currentSession}`, "");
    }
    const name = fileName(position, caseEntry);
    writeFileSync(
      join(review, name),
      renderCase(
        position,
        caseEntry,
        evidence.get(caseEntry.caseId),
        totals.get(currentSession) ?? 0,
      ),
    );
    index.push(
      `- [${name}](${name}) ${caseEntry.list.name} e${caseEntry.index} (${caseEntry.candidates.length} candidates)`,
    );
  }
  writeFileSync(join(review, "0000-index.md"), `${index.join("\n")}\n`);
  process.stdout.write(`wrote ${position} case files and an index to ${review}\n`);
};

main();
