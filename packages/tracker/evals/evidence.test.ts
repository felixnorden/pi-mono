import { assert, it } from "@effect/vitest";
import {
  buildEvidence,
  capEvidence,
  lineRangesOf,
  renderEntry,
  type EvidenceEntry,
} from "./evidence.ts";

const assistantText = (text: string) => ({
  type: "message",
  timestamp: "t1",
  message: { role: "assistant", content: [{ type: "text", text }] },
});

const assistantTool = (name: string, args: unknown) => ({
  type: "message",
  timestamp: "t2",
  message: { role: "assistant", content: [{ type: "toolCall", name, arguments: args }] },
});

const toolResult = (name: string, text: string, isError = false) => ({
  type: "message",
  timestamp: "t3",
  message: { role: "toolResult", toolName: name, isError, content: [{ type: "text", text }] },
});

const editResult = (callId: string, patch: string) => ({
  type: "message",
  timestamp: "t3",
  message: {
    role: "toolResult",
    toolName: "edit",
    toolCallId: callId,
    isError: false,
    content: [{ type: "text", text: "Successfully replaced 1 block(s) in a.ts." }],
    details: { diff: "", patch, firstChangedLine: 8 },
  },
});

it("renders assistant text and tool calls in order", () => {
  const rendered = renderEntry({
    type: "message",
    timestamp: "t1",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", text: "internal" },
        { type: "text", text: "I will edit the file" },
        { type: "toolCall", name: "edit", arguments: { path: "a.ts" } },
      ],
    },
  });
  assert.deepStrictEqual(rendered, [
    { kind: "assistant", at: "t1", text: "I will edit the file" },
    { kind: "tool-call", at: "t1", name: "edit", text: '{"path":"a.ts"}', args: { path: "a.ts" } },
  ]);
});

it("drops a thinking part", () => {
  const rendered = renderEntry({
    type: "message",
    timestamp: "t1",
    message: { role: "assistant", content: [{ type: "thinking", text: "internal" }] },
  });
  assert.deepStrictEqual(rendered, []);
});

it("renders a tool result and marks an error", () => {
  assert.deepStrictEqual(renderEntry(toolResult("bash", "boom", true)), [
    { kind: "tool-result", at: "t3", name: "bash", text: "boom", isError: true },
  ]);
});

it("carries the call id and the new-side line range of an edit result", () => {
  const patch = [
    "--- a/a.ts",
    "+++ b/a.ts",
    "@@ -6,3 +6,4 @@",
    " context",
    "+added",
    "@@ -20,2 +21,1 @@",
  ].join("\n");
  assert.deepStrictEqual(renderEntry(editResult("call_1", patch)), [
    {
      kind: "tool-result",
      at: "t3",
      name: "edit",
      text: "Successfully replaced 1 block(s) in a.ts.",
      isError: false,
      callId: "call_1",
      lines: "6-9,21",
    },
  ]);
});

it("reads a single-line hunk and falls back to firstChangedLine", () => {
  assert.strictEqual(lineRangesOf({ patch: "@@ -1,0 +1,1 @@" }), "1");
  assert.strictEqual(lineRangesOf({ firstChangedLine: 12 }), "12");
  assert.strictEqual(lineRangesOf({}), undefined);
});

it("carries the call id of an assistant tool call", () => {
  const [rendered] = renderEntry({
    type: "message",
    timestamp: "t1",
    message: {
      role: "assistant",
      content: [{ type: "toolCall", id: "call_9", name: "write", arguments: { path: "a.ts" } }],
    },
  });
  assert.deepStrictEqual(rendered, {
    kind: "tool-call",
    at: "t1",
    name: "write",
    text: '{"path":"a.ts"}',
    callId: "call_9",
    args: { path: "a.ts" },
  });
});

it("keeps the path argument of a tool call", () => {
  const [rendered] = renderEntry({
    type: "message",
    timestamp: "t1",
    message: {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "c1",
          name: "write",
          arguments: { path: "src/a.ts", content: "x" },
        },
      ],
    },
  });
  assert.deepStrictEqual(rendered!.args, { path: "src/a.ts" });
});

it("keeps the command argument of a bash call", () => {
  const [rendered] = renderEntry({
    type: "message",
    timestamp: "t1",
    message: {
      role: "assistant",
      content: [
        { type: "toolCall", id: "c2", name: "bash", arguments: { command: "bun run test" } },
      ],
    },
  });
  assert.deepStrictEqual(rendered!.args, { command: "bun run test" });
});

it("omits args when the call carries neither field", () => {
  const [rendered] = renderEntry({
    type: "message",
    timestamp: "t1",
    message: {
      role: "assistant",
      content: [{ type: "toolCall", id: "c3", name: "grep", arguments: { pattern: "x" } }],
    },
  });
  assert.ok(!("args" in rendered!));
});

it("renders a user message and skips an empty one", () => {
  assert.deepStrictEqual(
    renderEntry({
      type: "message",
      timestamp: "t0",
      message: { role: "user", content: [{ type: "text", text: "do the thing" }] },
    }),
    [{ kind: "user", at: "t0", text: "do the thing" }],
  );
  assert.deepStrictEqual(
    renderEntry({ type: "message", timestamp: "t0", message: { role: "user", content: [] } }),
    [],
  );
});

it("renders a custom message in short form", () => {
  assert.deepStrictEqual(
    renderEntry({
      type: "custom_message",
      timestamp: "t4",
      customType: "subagent-slash-result",
      content: "the work product",
    }),
    [{ kind: "custom", at: "t4", name: "subagent-slash-result", text: "the work product" }],
  );
});

it("ignores an entry that carries no work", () => {
  for (const raw of [null, 42, {}, { type: "compaction" }, { type: "custom", customType: "x" }]) {
    assert.deepStrictEqual(renderEntry(raw), []);
  }
});

it("cuts a long field and names what it removed", () => {
  const [rendered] = renderEntry(assistantText("x".repeat(1000)));
  assert.match(rendered!.text, /\[600 more characters\]$/);
});

it("keeps the newest entries when the record is too long", () => {
  const entries: readonly EvidenceEntry[] = [
    { kind: "assistant", at: "t1", text: "a".repeat(10) },
    { kind: "assistant", at: "t2", text: "b".repeat(10) },
    { kind: "assistant", at: "t3", text: "c".repeat(10) },
  ];
  const capped = capEvidence(entries, 25);
  assert.deepStrictEqual(
    capped.entries.map((entry) => entry.at),
    ["t2", "t3"],
  );
  assert.strictEqual(capped.omitted, 1);
});

it("keeps one oversized entry rather than nothing", () => {
  const capped = capEvidence([{ kind: "assistant", at: "t1", text: "x".repeat(50) }], 10);
  assert.strictEqual(capped.entries.length, 1);
  assert.strictEqual(capped.omitted, 0);
});

it("builds a work record from raw entries", () => {
  const evidence = buildEvidence([
    assistantText("first"),
    assistantTool("edit", { path: "a.ts" }),
    toolResult("edit", "ok"),
  ]);
  assert.deepStrictEqual(
    evidence.entries.map((entry) => entry.kind),
    ["assistant", "tool-call", "tool-result"],
  );
  assert.strictEqual(evidence.omitted, 0);
});
