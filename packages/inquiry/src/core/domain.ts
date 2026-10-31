/**
 * Domain model for the question toolkit, defined with Effect Schema.
 *
 * The wire schemas (`QuestionListParamsSchema`) describe the tool parameters
 * as the LLM sends them. The domain classes (`Option`, `Question`, `Answer`,
 * `QuestionResult`) are the validated internal representation.
 */

import { Effect, Schema } from "effect";
import { stripLeadingEmoji } from "./text.ts";

// ---------------------------------------------------------------------------
// Wire schemas (tool parameters) — the single source of truth. The tool's
// `parameters` JSON schema is generated from these via `toJsonSchemaDocument`
// (see `QuestionListParamsJsonSchema` below), so field descriptions written
// here are exactly what the LLM sees.
// ---------------------------------------------------------------------------

export const OptionParamsSchema = Schema.Struct({
  label: Schema.String.annotate({ description: "Display label for the option" }),
  description: Schema.optionalKey(
    Schema.String.annotate({ description: "Optional description shown below label" }),
  ),
  recommended: Schema.optionalKey(
    Schema.Boolean.annotate({
      description:
        "Recommend this option to the user (default: false). On a single-choice question, recommend at most one option. Set multiple: true to recommend more than one option.",
    }),
  ),
});

export type OptionParams = typeof OptionParamsSchema.Type;

const QuestionParamsStruct = Schema.Struct({
  prompt: Schema.String.annotate({ description: "The full question text to display" }),
  options: Schema.Array(OptionParamsSchema).annotate({
    description: "Available options to choose from",
  }),
  id: Schema.optionalKey(
    Schema.String.annotate({
      description: "Unique identifier for this question (defaults to q1, q2, ...)",
    }),
  ),
  label: Schema.optionalKey(
    Schema.String.annotate({
      description:
        "Short contextual label for tab bar, e.g. 'Scope', 'Priority' (defaults to Q1, Q2)",
    }),
  ),
  allowOther: Schema.optionalKey(
    Schema.Boolean.annotate({ description: "Allow 'Type something' option (default: true)" }),
  ),
  multiple: Schema.optionalKey(
    Schema.Boolean.annotate({
      description:
        "Ask for one or more answers instead of a single choice; renders checkboxes and lets the user add custom alternatives (default: false)",
    }),
  ),
});

export type QuestionParams = typeof QuestionParamsStruct.Type;

/**
 * A single-choice question can recommend at most one option. The rule lives on
 * the wire record. `decodeParams` is then the only rejection point, and its
 * failure text is the message the model already receives. The rule rejects the
 * call and does not trim options. An absent or false `multiple` counts as
 * single-choice. The pointer names the second recommended option. The decoder
 * appends the pointer.
 */
const atMostOneRecommendation = Schema.makeFilter((q: QuestionParams): Schema.FilterOutput => {
  if (q.multiple === true) return undefined;
  const recommended = q.options.flatMap((option, index) =>
    option.recommended === true ? [index] : [],
  );
  if (recommended.length <= 1) return undefined;
  const name = q.label ?? q.id;
  const subject = name === undefined ? "this question" : `question "${name}"`;
  return {
    path: ["options", recommended[1]!],
    issue:
      `${subject} is single-choice but has ${recommended.length} recommended options; ` +
      `keep at most one recommended option, or set multiple: true`,
  };
});

export const QuestionParamsSchema = QuestionParamsStruct.check(atMostOneRecommendation);

export const QuestionListParamsSchema = Schema.Struct({
  questions: Schema.Array(QuestionParamsSchema).annotate({
    description:
      "Questions to ask the user (1 or more). A single question shows a simple option list; multiple questions show a tabbed interface with a submit tab.",
  }),
});

export type QuestionListParams = typeof QuestionListParamsSchema.Type;

/**
 * JSON Schema form of the wire params, passed to pi as the tool's
 * `parameters`. `onExcessProperty: "ignore"` mirrors the legacy typebox
 * contract (unknown keys such as the old `value` field are tolerated) and
 * matches Effect's own struct decoding, which ignores unknown keys.
 */
export const QuestionListParamsJsonSchema = Schema.toJsonSchemaDocument(QuestionListParamsSchema, {
  onExcessProperty: "ignore",
}).schema;

/** Decode raw tool arguments into validated params. Throws `Schema.SchemaError` on invalid input. */
export const decodeParams = (input: unknown): QuestionListParams =>
  Schema.decodeUnknownSync(QuestionListParamsSchema)(input);

/**
 * Shim legacy tool arguments into the current wire shape.
 *
 * Old `question` tool calls used `{ question, options }`; old `questionnaire`
 * calls already used `{ questions }` and pass through unchanged. Called by
 * the tool's `prepareArguments` before schema validation.
 */
export const prepareQuestionArgs = (args: unknown): unknown => {
  if (args && typeof args === "object") {
    const legacy = args as { question?: unknown; options?: unknown; questions?: unknown };
    if (!Array.isArray(legacy.questions) && typeof legacy.question === "string") {
      return {
        questions: [
          {
            prompt: legacy.question,
            options: Array.isArray(legacy.options) ? legacy.options : [],
          },
        ],
      };
    }
  }
  return args;
};

// ---------------------------------------------------------------------------
// Domain model
// ---------------------------------------------------------------------------

/**
 * Collapse the wire recommendation to a concrete boolean at the wire-to-domain
 * boundary. Nothing downstream then distinguishes "absent" from "false". The
 * constructor default keeps hand-built `new Option({ label })` values working.
 */
const optionRecommended = Schema.Boolean.pipe(
  Schema.withDecodingDefaultType(Effect.succeed(false)),
  Schema.withConstructorDefault(Effect.succeed(false)),
);

export class Option extends Schema.Class<Option>("inquiry/core/domain/Option")({
  label: Schema.String,
  description: Schema.optionalKey(Schema.String),
  recommended: optionRecommended,
}) {}

export class Question extends Schema.Class<Question>("inquiry/core/domain/Question")({
  id: Schema.String,
  label: Schema.String,
  prompt: Schema.String,
  options: Schema.Array(Option),
  allowOther: Schema.Boolean,
  multiple: Schema.Boolean,
}) {}

export class Answer extends Schema.Class<Answer>("inquiry/core/domain/Answer")({
  id: Schema.String,
  label: Schema.String,
  wasCustom: Schema.Boolean,
  index: Schema.optionalKey(Schema.Int),
}) {}

export class QuestionResult extends Schema.Class<QuestionResult>(
  "inquiry/core/domain/QuestionResult",
)({
  questions: Schema.Array(Question),
  answers: Schema.Array(Answer),
  cancelled: Schema.Boolean,
}) {}

/**
 * Normalize wire params into domain questions.
 *
 * Applies the defaults: `id` falls back to `q{n}`, `label` to `Q{n}`,
 * `allowOther` defaults to `true`, `multiple` to `false`. Model-authored
 * display text (prompt, label, option label/description) has leading marker
 * emoji stripped — the UI already provides the selection affordances those
 * markers duplicate.
 */
export const normalizeQuestions = (params: QuestionListParams): readonly Question[] =>
  params.questions.map(
    (q, i) =>
      new Question({
        id: q.id ?? `q${i + 1}`,
        label: stripLeadingEmoji(q.label ?? `Q${i + 1}`),
        prompt: stripLeadingEmoji(q.prompt),
        options: q.options.map((o) => {
          const label = stripLeadingEmoji(o.label);
          const description =
            o.description === undefined ? undefined : stripLeadingEmoji(o.description);
          const recommended = o.recommended === true;
          return description
            ? new Option({ label, description, recommended })
            : new Option({ label, recommended });
        }),
        allowOther: q.allowOther !== false,
        multiple: q.multiple === true,
      }),
  );
