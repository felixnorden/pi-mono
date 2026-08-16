/**
 * Domain model for the question toolkit, defined with Effect Schema.
 *
 * The wire schemas (`QuestionListParamsSchema`) describe the tool parameters
 * as the LLM sends them. The domain classes (`Option`, `Question`, `Answer`,
 * `QuestionResult`) are the validated internal representation.
 */

import { Schema } from "effect";

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
});

export type OptionParams = typeof OptionParamsSchema.Type;

export const QuestionParamsSchema = Schema.Struct({
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
});

export type QuestionParams = typeof QuestionParamsSchema.Type;

export const QuestionListParamsSchema = Schema.Struct({
  questions: Schema.Array(QuestionParamsSchema).annotate({
    description:
      "Questions to ask the user (1 or more). A single question shows a simple option list; multiple questions show a tabbed interface with a submit tab.",
  }),
});

export type QuestionListParams = typeof QuestionListParamsSchema.Type;

/**
 * JSON Schema form of the wire params, passed to pi as the tool's
 * `parameters`. `additionalProperties: true` mirrors the legacy typebox
 * contract (unknown keys such as the old `value` field are tolerated) and
 * matches Effect's own struct decoding, which ignores unknown keys.
 */
export const QuestionListParamsJsonSchema = Schema.toJsonSchemaDocument(QuestionListParamsSchema, {
  additionalProperties: true,
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

export class Option extends Schema.Class<Option>("inquiry/core/domain/Option")({
  label: Schema.String,
  description: Schema.optionalKey(Schema.String),
}) {}

export class Question extends Schema.Class<Question>("inquiry/core/domain/Question")({
  id: Schema.String,
  label: Schema.String,
  prompt: Schema.String,
  options: Schema.Array(Option),
  allowOther: Schema.Boolean,
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
 * `allowOther` defaults to `true`.
 */
export const normalizeQuestions = (params: QuestionListParams): readonly Question[] =>
  params.questions.map(
    (q, i) =>
      new Question({
        id: q.id ?? `q${i + 1}`,
        label: q.label ?? `Q${i + 1}`,
        prompt: q.prompt,
        options: q.options.map((o) =>
          o.description === undefined
            ? new Option({ label: o.label })
            : new Option({ label: o.label, description: o.description }),
        ),
        allowOther: q.allowOther !== false,
      }),
  );
