/**
 * Pins the contract between the Effect-generated parameter schema and pi's
 * runtime validation. `validateToolCall` is the real pipeline pi runs on
 * every tool call: prepareArguments -> typebox Convert/Compile/Check.
 */
import { describe, expect, it } from "vitest";
import { validateToolCall } from "@earendil-works/pi-ai";
import { QuestionListParamsJsonSchema } from "../core/domain.ts";

type ToolLike = Parameters<typeof validateToolCall>[0];
type ToolCallLike = Parameters<typeof validateToolCall>[1];

const tools = [
  { name: "question", parameters: QuestionListParamsJsonSchema },
] as unknown as ToolLike;
const call = (arguments_: unknown) =>
  ({ name: "question", arguments: arguments_ }) as unknown as ToolCallLike;

describe("pi validation of the generated schema", () => {
  it("accepts valid arguments", () => {
    const args = { questions: [{ prompt: "Pick?", options: [{ label: "Yes" }] }] };
    expect(validateToolCall(tools, call(args))).toEqual(args);
  });

  it("accepts full arguments with ids, labels and allowOther", () => {
    const args = {
      questions: [
        {
          id: "scope",
          label: "Scope",
          prompt: "Pick?",
          options: [{ label: "A", description: "desc" }],
          allowOther: false,
        },
      ],
    };
    expect(validateToolCall(tools, call(args))).toEqual(args);
  });

  it("tolerates legacy extra option keys such as value", () => {
    const args = { questions: [{ prompt: "p", options: [{ value: "yes", label: "Yes" }] }] };
    expect(validateToolCall(tools, call(args))).toEqual(args);
  });

  it("accepts the multiple flag for multi-select questions", () => {
    const args = {
      questions: [{ prompt: "Pick any?", options: [{ label: "A" }], multiple: true }],
    };
    expect(validateToolCall(tools, call(args))).toEqual(args);
    expect(() =>
      validateToolCall(tools, call({ ...args, questions: [{ multiple: "yes" }] })),
    ).toThrow();
  });

  it("coerces stringified booleans", () => {
    const args = { questions: [{ prompt: "p", options: [{ label: "a" }], allowOther: "false" }] };
    expect(validateToolCall(tools, call(args))).toEqual({
      questions: [{ prompt: "p", options: [{ label: "a" }], allowOther: false }],
    });
  });

  it("accepts an empty questions array (handled in execute)", () => {
    expect(validateToolCall(tools, call({ questions: [] }))).toEqual({ questions: [] });
  });

  it("rejects arguments missing questions", () => {
    expect(() => validateToolCall(tools, call({}))).toThrow(
      /Validation failed for tool "question"/,
    );
  });

  it("rejects a question missing its options", () => {
    expect(() => validateToolCall(tools, call({ questions: [{ prompt: "p" }] }))).toThrow(
      /questions\.0\.options/,
    );
  });
});
