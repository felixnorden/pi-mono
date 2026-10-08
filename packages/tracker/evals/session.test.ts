import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { contextAt, MARKER, parseSession } from "./session.ts";

const user = (text: string) => ({ type: "message", message: { role: "user", content: text } });

const assistant = (usage: Record<string, number>, text = "ok") => ({
  type: "message",
  message: { role: "assistant", content: text, usage },
});

describe("parseSession", () => {
  it("indexes entries by line, skipping empty and unparseable ones", () => {
    const log = [
      JSON.stringify(user("hello")),
      "{not json",
      "",
      JSON.stringify({ type: "custom", customType: "something/else" }),
    ].join("\n");
    const parsed = parseSession(log, () => undefined);
    assert.strictEqual(parsed.entries.length, 4);
    assert.strictEqual((parsed.entries[0] as { type: string }).type, "message");
    assert.strictEqual(parsed.entries[1], undefined);
    assert.strictEqual(parsed.entries[2], undefined);
    assert.strictEqual(parsed.snapshots.length, 0);
  });

  it("reports a tracker snapshot whose state will not decode", () => {
    const log = JSON.stringify({ type: "custom", customType: MARKER, data: {} });
    let skipped = 0;
    const parsed = parseSession(log, () => {
      skipped += 1;
    });
    assert.strictEqual(skipped, 1);
    assert.strictEqual(parsed.snapshots.length, 0);
    assert.strictEqual(parsed.snapshotLines.length, 0);
  });
});

describe("contextAt", () => {
  it("counts entries and messages before the line", () => {
    const entries = [user("a"), assistant({ input: 10 }), user("b"), assistant({ input: 20 })];
    const size = contextAt(entries, 3);
    assert.strictEqual(size.entries, 3);
    assert.strictEqual(size.messages, 3);
    assert.ok(size.chars > 0);
  });

  it("takes the prompt size of the last assistant turn", () => {
    const entries = [
      assistant({ input: 879, cacheRead: 14_336, cacheWrite: 0 }),
      user("next"),
      assistant({ input: 2_827, cacheRead: 15_104, cacheWrite: 5 }),
    ];
    assert.strictEqual(contextAt(entries, 3).inputTokens, 17_936);
  });

  it("ignores a turn with no reported usage", () => {
    const entries = [assistant({ input: 100, cacheRead: 50 }), assistant({})];
    assert.strictEqual(contextAt(entries, 2).inputTokens, 150);
  });

  it("stops at the line index and tolerates a line beyond the log", () => {
    const entries = [user("a"), assistant({ input: 10 })];
    assert.strictEqual(contextAt(entries, 0).entries, 0);
    assert.strictEqual(contextAt(entries, 99).entries, 2);
  });

  it("skips undefined lines that a parse gap left behind", () => {
    const entries = [user("a"), undefined, assistant({ input: 7 })];
    const size = contextAt(entries, 3);
    assert.strictEqual(size.entries, 2);
    assert.strictEqual(size.messages, 2);
  });
});
