/**
 * Pins the tool registration contract: name, discovery content, the
 * parameter schema (single-sourced from the core), and the legacy
 * prepareArguments shim wiring.
 */
import { describe, expect, it, vi } from "vitest";
import type {
  ExtensionAPI,
  ExtensionToolContext,
  Theme,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import question from "./question.ts";
import {
  Answer,
  Option,
  Question,
  QuestionListParamsJsonSchema,
  QuestionResult,
} from "../core/domain.ts";

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

/** Theme double: every style and colour returns its text unchanged. */
const theme = {
  style: (text: string) => text,
  fg: (_color: string, text: string) => text,
} as unknown as Theme;

const rendered = (component: { render(width: number): string[] }): string =>
  component
    .render(200)
    .map((l) => l.trimEnd())
    .join("\n");

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

describe("question tool renderers and execute (unchanged surfaces)", () => {
  it("renderCall ignores the recommended flag", () => {
    const tool = register();
    const out = tool.renderCall!(
      {
        questions: [
          {
            prompt: "Pick one?",
            options: [{ label: "First", recommended: true }, { label: "Second" }],
          },
        ],
      } as any,
      theme,
      {} as any,
    );
    expect(rendered(out)).toBe(
      "question Pick one?\n  Options: 1. First, 2. Second, 3. Type something.",
    );
  });

  it("renderResult ignores the recommended flag", () => {
    const tool = register();
    const result = {
      content: [{ type: "text", text: "Q1: user selected: 1. First" }],
      details: {
        questions: [
          {
            id: "q1",
            label: "Q1",
            prompt: "Pick one?",
            options: [{ label: "First", recommended: true }],
            allowOther: false,
            multiple: false,
          },
        ],
        answers: [{ id: "q1", label: "First", wasCustom: false, index: 1 }],
        cancelled: false,
      },
    };
    const out = tool.renderResult!(result as any, {} as any, theme, {} as any);
    expect(rendered(out)).toBe("✓ q1: 1. First");
  });

  it("execute keeps the marker out of the answer text", async () => {
    const tool = register();
    const recorded = new Question({
      id: "q1",
      label: "Q1",
      prompt: "Pick one?",
      options: [new Option({ label: "First", recommended: true })],
      allowOther: false,
      multiple: false,
    });
    const result = new QuestionResult({
      questions: [recorded],
      answers: [new Answer({ id: "q1", label: "First", wasCustom: false, index: 1 })],
      cancelled: false,
    });
    const custom = vi.fn(() => Promise.resolve(result));
    const ctx = { mode: "tui", ui: { custom } } as unknown as ExtensionToolContext;
    const out = await tool.execute(
      "call-1",
      {
        questions: [
          {
            id: "q1",
            label: "Q1",
            prompt: "Pick one?",
            options: [{ label: "First", recommended: true }],
          },
        ],
      },
      undefined,
      undefined,
      ctx,
    );
    expect(out.content[0]).toEqual({ type: "text", text: "Q1: user selected: 1. First" });
    expect(out.details).toBe(result);
  });
});

describe("question tool execute: invalid recommendations", () => {
  it("returns one invalid-parameters message and cancelled details without opening the UI", async () => {
    const tool = register();
    const custom = vi.fn();
    const ctx = { mode: "tui", ui: { custom } } as unknown as ExtensionToolContext;
    const out = await tool.execute(
      "call-1",
      {
        questions: [
          {
            prompt: "Pick one?",
            options: [
              { label: "a", recommended: true },
              { label: "b", recommended: true },
            ],
          },
        ],
      },
      undefined,
      undefined,
      ctx,
    );
    expect(out.content).toHaveLength(1);
    const entry = out.content[0] as { type: string; text: string };
    expect(entry.type).toBe("text");
    expect(entry.text.startsWith("Error: invalid parameters: ")).toBe(true);
    expect(entry.text).toContain("keep at most one recommended option, or set multiple: true");
    expect(out.details).toEqual({ questions: [], answers: [], cancelled: true });
    expect(custom).not.toHaveBeenCalled();
  });
});
