import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import {
  Option,
  QuestionListParamsJsonSchema,
  decodeParams,
  normalizeQuestions,
  prepareQuestionArgs,
} from "./domain.ts";

describe("decodeParams", () => {
  /** Message of the `SchemaError` the decoder throws, for wording pins. */
  const decodeError = (input: unknown): string => {
    try {
      decodeParams(input);
    } catch (error) {
      return (error as Error).message;
    }
    throw new Error("expected decodeParams to throw");
  };

  it("decodes valid params", () => {
    const params = decodeParams({
      questions: [{ prompt: "Pick one?", options: [{ label: "Yes" }] }],
    });
    expect(params.questions).toHaveLength(1);
    expect(params.questions[0]?.prompt).toBe("Pick one?");
  });

  it("decodes optional fields", () => {
    const params = decodeParams({
      questions: [
        {
          id: "scope",
          label: "Scope",
          prompt: "Pick one?",
          options: [{ label: "Yes", description: "Go ahead" }],
          allowOther: false,
          multiple: true,
        },
      ],
    });
    expect(params.questions[0]?.id).toBe("scope");
    expect(params.questions[0]?.label).toBe("Scope");
    expect(params.questions[0]?.allowOther).toBe(false);
    expect(params.questions[0]?.multiple).toBe(true);
    expect(params.questions[0]?.options[0]?.description).toBe("Go ahead");
  });

  it("decodes the optional recommended flag on an option", () => {
    const params = decodeParams({
      questions: [{ prompt: "p", options: [{ label: "a", recommended: true }, { label: "b" }] }],
    });
    const options = params.questions[0]?.options as readonly { recommended?: boolean }[];
    expect(options[0]?.recommended).toBe(true);
    expect(options[1]?.recommended).toBeUndefined();
  });

  it("rejects invalid input with a SchemaError", () => {
    expect(() => decodeParams({ questions: [{ prompt: "p", options: [{ label: 42 }] }] })).toThrow(
      Schema.SchemaError,
    );
  });

  it("rejects a missing questions array", () => {
    expect(() => decodeParams({})).toThrow(Schema.SchemaError);
  });

  it("ignores legacy extra option fields such as value", () => {
    const params = decodeParams({
      questions: [{ prompt: "p", options: [{ value: "yes", label: "Yes" }] }],
    });
    expect(params.questions[0]?.options[0]?.label).toBe("Yes");
  });

  it("rejects two recommendations when multiple is absent", () => {
    const params = {
      questions: [
        {
          label: "Scope",
          prompt: "p",
          options: [
            { label: "a", recommended: true },
            { label: "b", recommended: true },
          ],
        },
      ],
    };
    expect(() => decodeParams(params)).toThrow(Schema.SchemaError);
    const message = decodeError(params);
    expect(message).toContain('question "Scope" is single-choice but has 2 recommended options');
    expect(message).toContain("keep at most one recommended option, or set multiple: true");
    expect(message).toContain('at ["questions"][0]["options"][1]');
  });

  it("rejects two recommendations when multiple is false", () => {
    const params = {
      questions: [
        {
          label: "Scope",
          prompt: "p",
          multiple: false,
          options: [
            { label: "a", recommended: true },
            { label: "b", recommended: true },
          ],
        },
      ],
    };
    expect(() => decodeParams(params)).toThrow(Schema.SchemaError);
    expect(decodeError(params)).toContain('at ["questions"][0]["options"][1]');
  });

  it("counts three recommendations", () => {
    const params = {
      questions: [
        {
          prompt: "p",
          options: [
            { label: "a", recommended: true },
            { label: "b", recommended: true },
            { label: "c", recommended: true },
          ],
        },
      ],
    };
    const message = decodeError(params);
    expect(message).toContain("has 3 recommended options");
    expect(message.startsWith("this question is single-choice")).toBe(true);
    expect(message).toContain('at ["questions"][0]["options"][1]');
  });

  it("names the second question's pointer when it is invalid", () => {
    const params = {
      questions: [
        { prompt: "ok", options: [{ label: "a", recommended: true }] },
        {
          prompt: "bad",
          options: [
            { label: "b", recommended: true },
            { label: "c", recommended: true },
          ],
        },
      ],
    };
    expect(decodeError(params)).toContain('at ["questions"][1]["options"][1]');
  });

  it("accepts two recommendations when multiple is true", () => {
    const params = decodeParams({
      questions: [
        {
          prompt: "p",
          multiple: true,
          options: [
            { label: "a", recommended: true },
            { label: "b", recommended: true },
          ],
        },
      ],
    });
    expect(params.questions[0]?.options.map((o) => o.recommended)).toEqual([true, true]);
  });

  it("rejects a legacy-shaped call with two recommendations", () => {
    const prepared = prepareQuestionArgs({
      question: "Pick one?",
      options: [
        { label: "a", recommended: true },
        { label: "b", recommended: true },
      ],
    });
    expect(decodeError(prepared)).toContain('at ["questions"][0]["options"][1]');
  });
});

describe("prepareQuestionArgs", () => {
  it("shims legacy question-tool args into the questions array", () => {
    const prepared = prepareQuestionArgs({ question: "Go?", options: [{ label: "Yes" }] });
    expect(prepared).toEqual({ questions: [{ prompt: "Go?", options: [{ label: "Yes" }] }] });
  });

  it("shims legacy args without options", () => {
    expect(prepareQuestionArgs({ question: "Go?" })).toEqual({
      questions: [{ prompt: "Go?", options: [] }],
    });
  });

  it("passes the current questionnaire shape through unchanged", () => {
    const args = { questions: [{ prompt: "p", options: [{ label: "a" }] }] };
    expect(prepareQuestionArgs(args)).toBe(args);
  });

  it("passes non-objects through unchanged", () => {
    expect(prepareQuestionArgs(undefined)).toBeUndefined();
    expect(prepareQuestionArgs(null)).toBeNull();
    expect(prepareQuestionArgs("nope")).toBe("nope");
  });
});

describe("QuestionListParamsJsonSchema", () => {
  const schema = QuestionListParamsJsonSchema as Record<string, any>;

  it("is an object schema requiring questions", () => {
    expect(schema.type).toBe("object");
    expect(schema.required).toEqual(["questions"]);
    expect(schema.properties.questions.type).toBe("array");
  });

  it("tolerates additional properties at every level (legacy contract)", () => {
    expect(schema.additionalProperties).toBe(true);
    const question = schema.properties.questions.items;
    expect(question.additionalProperties).toBe(true);
    const option = question.properties.options.items;
    expect(option.additionalProperties).toBe(true);
    expect(option.required).toEqual(["label"]);
    expect(Object.keys(option.properties)).toEqual(["label", "description", "recommended"]);
  });

  it("does not project the recommendation rule", () => {
    const question = schema.properties.questions.items;
    const option = question.properties.options.items;
    expect(option.required).toEqual(["label"]);
    expect(option.additionalProperties).toBe(true);
    for (const node of [option, question]) {
      for (const artifact of ["allOf", "anyOf", "oneOf", "not", "minItems"]) {
        expect(node).not.toHaveProperty(artifact);
      }
    }
  });

  it("carries the field descriptions the LLM sees", () => {
    expect(schema.properties.questions.description).toContain(
      "single question shows a simple option list",
    );
    const q = schema.properties.questions.items.properties;
    expect(q.prompt.description).toBe("The full question text to display");
    expect(q.options.description).toBe("Available options to choose from");
    expect(q.label.description).toContain("Short contextual label for tab bar");
    expect(q.allowOther.description).toContain("default: true");
    expect(q.options.items.properties.label.description).toBe("Display label for the option");
    expect(q.options.items.properties.recommended).toEqual({
      type: "boolean",
      description:
        "Recommend this option to the user (default: false). On a single-choice question, recommend at most one option. Set multiple: true to recommend more than one option.",
    });
  });
});

describe("normalizeQuestions", () => {
  it("applies id, label and allowOther defaults", () => {
    const questions = normalizeQuestions(
      decodeParams({ questions: [{ prompt: "p", options: [{ label: "a" }] }] }),
    );
    expect(questions).toHaveLength(1);
    expect(questions[0]?.id).toBe("q1");
    expect(questions[0]?.label).toBe("Q1");
    expect(questions[0]?.allowOther).toBe(true);
  });

  it("numbers multiple questions", () => {
    const questions = normalizeQuestions(
      decodeParams({
        questions: [
          { prompt: "p1", options: [{ label: "a" }] },
          { prompt: "p2", options: [{ label: "b" }] },
        ],
      }),
    );
    expect(questions.map((q) => q.id)).toEqual(["q1", "q2"]);
    expect(questions.map((q) => q.label)).toEqual(["Q1", "Q2"]);
  });

  it("preserves explicit values", () => {
    const questions = normalizeQuestions(
      decodeParams({
        questions: [
          {
            id: "x",
            label: "Scope",
            prompt: "p",
            options: [{ label: "a" }],
            allowOther: false,
            multiple: true,
          },
        ],
      }),
    );
    expect(questions[0]?.id).toBe("x");
    expect(questions[0]?.label).toBe("Scope");
    expect(questions[0]?.allowOther).toBe(false);
    expect(questions[0]?.multiple).toBe(true);
  });

  it("defaults multiple to false", () => {
    const questions = normalizeQuestions(
      decodeParams({ questions: [{ prompt: "p", options: [{ label: "a" }] }] }),
    );
    expect(questions[0]?.multiple).toBe(false);
  });

  it("maps option labels and descriptions", () => {
    const questions = normalizeQuestions(
      decodeParams({ questions: [{ prompt: "p", options: [{ label: "a", description: "d" }] }] }),
    );
    expect(questions[0]?.options[0]?.label).toBe("a");
    expect(questions[0]?.options[0]?.description).toBe("d");
  });

  it("strips leading marker emoji from prompt, label and options", () => {
    const questions = normalizeQuestions(
      decodeParams({
        questions: [
          {
            id: "q7",
            label: "❓ Q7 deployBlock",
            prompt:
              "❓ Q7 — deployBlock guard: should anything guard it?\n\n➡️ Recommended: A — document-only.",
            options: [
              {
                label: "✅ Document-only",
                description:
                  "➡️ Recommended. Zero mechanics; the Slice-13 gate + docs cover operator responsibility.",
              },
              { label: "One-shot warning log" },
            ],
          },
        ],
      }),
    );
    const q = questions[0]!;
    expect(q.label).toBe("Q7 deployBlock");
    expect(q.prompt).toBe(
      "Q7 — deployBlock guard: should anything guard it?\n\nRecommended: A — document-only.",
    );
    expect(q.options[0]?.label).toBe("Document-only");
    expect(q.options[0]?.description).toBe(
      "Recommended. Zero mechanics; the Slice-13 gate + docs cover operator responsibility.",
    );
    expect(q.options[1]?.label).toBe("One-shot warning log");
  });

  it("collapses the wire recommendation to a concrete boolean", () => {
    const questions = normalizeQuestions(
      decodeParams({
        questions: [{ prompt: "p", options: [{ label: "a", recommended: true }, { label: "b" }] }],
      }),
    );
    expect(questions[0]?.options[0]?.recommended).toBe(true);
    expect(questions[0]?.options[1]?.recommended).toBe(false);
  });

  it("strips label emoji without touching the recommendation", () => {
    const questions = normalizeQuestions(
      decodeParams({
        questions: [{ prompt: "p", options: [{ label: "✅ Document-only", recommended: true }] }],
      }),
    );
    expect(questions[0]?.options[0]?.label).toBe("Document-only");
    expect(questions[0]?.options[0]?.recommended).toBe(true);
  });

  it("drops option descriptions that strip to empty", () => {
    const questions = normalizeQuestions(
      decodeParams({ questions: [{ prompt: "p", options: [{ label: "a", description: "➡️" }] }] }),
    );
    expect(questions[0]?.options[0]?.description).toBeUndefined();
  });
});

describe("Option", () => {
  it("defaults recommended to false when constructed without it", () => {
    expect(new Option({ label: "Yes" }).recommended).toBe(false);
    expect(new Option({ label: "Yes", recommended: true }).recommended).toBe(true);
  });
});
