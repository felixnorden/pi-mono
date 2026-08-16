/**
 * Question Tool - the single entry point for interactive questions.
 *
 * Asks the user one or more questions with options, plus an optional
 * "Type something" free-text path. A single question renders a simple option
 * list; multiple questions render a tabbed interface with a submit tab.
 *
 * The core logic lives in `src/core/` (pure Effect) and `src/sdk/` (pi
 * adapter). This file only wires the tool definition to pi.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { TSchema } from "typebox";
import {
  QuestionListParamsJsonSchema,
  decodeParams,
  normalizeQuestions,
  prepareQuestionArgs,
} from "../core/domain.ts";
import { runQuestionUi } from "../sdk/pi-ui.ts";

/**
 * System prompt contribution. The snippet appears in the "Available tools"
 * section; the guidelines are appended to the Guidelines section when this
 * tool is active. Every bullet names the tool so the model associates the
 * guidance with it.
 */
const questionToolSystemPromptContribution = {
  snippet:
    "Ask the user to decide: interactive questions with selectable options or a typed answer",
  guidelines: [
    "Use question whenever you need the user to decide something, pick between options, or confirm a decision — instead of ending your reply with a question in plain text",
    "Ask all open questions in one question call, with one entry per question in questions[]; a single question shows a simple option list, multiple questions show a tabbed interface with a submit tab",
    "Keep options short: a label plus an optional one-line description, 2-5 options per question. The user can also type a free-text answer ('Type something.'), so only set allowOther: false when one of the listed options is required",
    "Treat a cancelled question result as the user declining to answer: do not re-ask unless the answer is essential, and then ask once more in a different form",
  ],
} as const;

const cancelledDetails = { questions: [], answers: [], cancelled: true };

type RenderableQuestion = {
  prompt?: unknown;
  label?: unknown;
  id?: unknown;
  options?: Array<{ label?: unknown }>;
};

const questionLabel = (q: RenderableQuestion): string => {
  if (typeof q.label === "string") return q.label;
  if (typeof q.id === "string") return q.id;
  return "";
};

export default function question(pi: ExtensionAPI) {
  pi.registerTool({
    name: "question",
    label: "Question",
    description:
      "Ask the user one or more multiple-choice questions and get their answers back. Use whenever you need input from the user: clarifying ambiguous requirements, choosing between approaches or options, or confirming a decision. Prefer this over asking in plain text — it renders as a selectable list (single question) or a tabbed form (multiple questions) and lets the user type a custom answer.",
    // Single source of truth: generated from the Effect schema in the core.
    parameters: QuestionListParamsJsonSchema as TSchema,
    promptSnippet: questionToolSystemPromptContribution.snippet,
    promptGuidelines: [...questionToolSystemPromptContribution.guidelines],
    executionMode: "sequential",

    prepareArguments(args: unknown): unknown {
      // Shim legacy calls from older sessions (old `question` tool shape).
      // The schema tolerates unknown keys, so extra fields pass through.
      return prepareQuestionArgs(args);
    },

    async execute(_toolCallId, params: unknown, _signal, _onUpdate, ctx) {
      if (ctx.mode !== "tui") {
        return {
          content: [
            { type: "text", text: "Error: UI not available (running in non-interactive mode)" },
          ],
          details: { ...cancelledDetails },
        };
      }

      let decoded;
      try {
        decoded = decodeParams(params);
      } catch (error) {
        return {
          content: [
            { type: "text", text: `Error: invalid parameters: ${(error as Error).message}` },
          ],
          details: { ...cancelledDetails },
        };
      }

      const questions = normalizeQuestions(decoded);
      if (questions.length === 0) {
        return {
          content: [{ type: "text", text: "Error: No questions provided" }],
          details: { ...cancelledDetails },
        };
      }

      const result = await runQuestionUi(ctx.ui, questions, ctx.cwd);

      if (result.cancelled) {
        return {
          content: [{ type: "text", text: "User cancelled the questionnaire" }],
          details: result,
        };
      }

      const answerLines = result.answers.map((a) => {
        const qLabel = questions.find((q) => q.id === a.id)?.label ?? a.id;
        if (a.wasCustom) {
          return `${qLabel}: user wrote: ${a.label}`;
        }
        return `${qLabel}: user selected: ${a.index}. ${a.label}`;
      });

      return {
        content: [{ type: "text", text: answerLines.join("\n") }],
        details: result,
      };
    },

    renderCall(args: unknown, theme, _context) {
      const qs = (args as { questions?: RenderableQuestion[] }).questions ?? [];
      if (qs.length === 1) {
        const q = qs[0];
        let text =
          theme.fg("toolTitle", theme.bold("question ")) +
          theme.fg("muted", typeof q?.prompt === "string" ? q.prompt : "");
        const opts = Array.isArray(q?.options) ? q.options : [];
        if (opts.length > 0) {
          const labels = opts.map((o) => (typeof o.label === "string" ? o.label : ""));
          const numbered = [...labels, "Type something."].map((o, i) => `${i + 1}. ${o}`);
          text += `\n${theme.fg("dim", `  Options: ${numbered.join(", ")}`)}`;
        }
        return new Text(text, 0, 0);
      }
      const labels = qs.map(questionLabel).join(", ");
      let text =
        theme.fg("toolTitle", theme.bold("question ")) +
        theme.fg("muted", `${qs.length} questions`);
      if (labels) {
        text += theme.fg("dim", ` (${labels})`);
      }
      return new Text(text, 0, 0);
    },

    renderResult(result, _options, theme, _context) {
      const details = result.details as
        | {
            questions?: unknown[];
            answers?: Array<{ id: string; label: string; wasCustom: boolean; index?: number }>;
            cancelled?: boolean;
          }
        | undefined;
      if (!details || !Array.isArray(details.answers)) {
        const text = result.content[0];
        return new Text(text?.type === "text" ? text.text : "", 0, 0);
      }
      if (details.cancelled) {
        return new Text(theme.fg("warning", "Cancelled"), 0, 0);
      }
      const lines = details.answers.map((a) => {
        if (a.wasCustom) {
          return `${theme.fg("success", "✓ ")}${theme.fg("accent", a.id)}: ${theme.fg("muted", "(wrote) ")}${a.label}`;
        }
        const display = a.index ? `${a.index}. ${a.label}` : a.label;
        return `${theme.fg("success", "✓ ")}${theme.fg("accent", a.id)}: ${display}`;
      });
      return new Text(lines.join("\n"), 0, 0);
    },
  });
}
