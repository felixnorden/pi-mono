/**
 * Pins the tool registration contract: name, discovery content, the
 * parameter schema (single-sourced from the core), and the legacy
 * prepareArguments shim wiring.
 */
import { describe, expect, it } from "vitest";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import question from "./question.ts";
import { QuestionListParamsJsonSchema } from "../core/domain.ts";

const register = (): ToolDefinition<any, unknown, any> => {
  let captured: ToolDefinition<any, unknown, any> | undefined;
  const fakeApi = {
    registerTool: (tool: ToolDefinition<any, unknown, any>) => {
      captured = tool;
    },
  } as unknown as ExtensionAPI;
  question(fakeApi);
  if (!captured) throw new Error("registerTool was not called");
  return captured;
};

describe("question tool registration", () => {
  it("registers under the legacy name with a stable label", () => {
    const tool = register();
    expect(tool.name).toBe("question");
    expect(tool.label).toBe("Question");
    expect(tool.executionMode).toBe("sequential");
  });

  it("describes when to use the tool", () => {
    const tool = register();
    expect(tool.description).toContain("multiple-choice questions");
    expect(tool.description).toContain("Prefer this over asking in plain text");
  });

  it("provides a prompt snippet naming the tool", () => {
    const tool = register();
    expect(tool.promptSnippet).toBeTruthy();
    expect(tool.promptSnippet).toContain("question");
  });

  it("provides guidelines that each name the tool", () => {
    const tool = register();
    expect(tool.promptGuidelines).toHaveLength(5);
    for (const bullet of tool.promptGuidelines ?? []) {
      expect(bullet).toContain("question");
    }
    expect(tool.promptGuidelines?.join("\n")).toContain(
      "instead of ending your reply with a question",
    );
  });

  it("uses the core-generated schema as parameters (single source)", () => {
    const tool = register();
    expect(tool.parameters).toBe(QuestionListParamsJsonSchema);
    expect(JSON.stringify(tool.parameters)).toBe(JSON.stringify(QuestionListParamsJsonSchema));
  });

  it("wires the legacy prepareArguments shim", () => {
    const tool = register();
    const prepared = tool.prepareArguments?.({
      question: "Go?",
      options: [{ label: "Yes" }],
    });
    expect(prepared).toEqual({ questions: [{ prompt: "Go?", options: [{ label: "Yes" }] }] });
    const passthrough = { questions: [{ prompt: "p", options: [{ label: "a" }] }] };
    expect(tool.prepareArguments?.(passthrough)).toBe(passthrough);
  });
});
