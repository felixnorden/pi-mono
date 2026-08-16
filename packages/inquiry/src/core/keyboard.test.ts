import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import { KeyEvent, KeyEventSchema } from "./keyboard.ts";

describe("KeyEvent", () => {
  it("exports a canonical singleton for every tag-only variant", () => {
    const events = [
      KeyEvent.up,
      KeyEvent.down,
      KeyEvent.left,
      KeyEvent.right,
      KeyEvent.tab,
      KeyEvent.shiftTab,
      KeyEvent.enter,
      KeyEvent.shiftEnter,
      KeyEvent.escape,
      KeyEvent.backspace,
      KeyEvent.delete,
      KeyEvent.home,
      KeyEvent.end,
    ];
    expect(events).toHaveLength(13);
    expect(new Set(events).size).toBe(13); // distinct instances
    // each singleton survives a decode round-trip
    for (const event of events) {
      expect(Schema.decodeUnknownSync(KeyEventSchema)(event)).toEqual(event);
    }
  });

  it("builds data-carrying variants through the char and paste factories", () => {
    const typed = KeyEvent.char("a");
    const pasted = KeyEvent.paste("hello\nworld");
    expect(typed).toEqual({ _tag: "char", char: "a" });
    expect(pasted).toEqual({ _tag: "paste", text: "hello\nworld" });
    expect(Schema.decodeUnknownSync(KeyEventSchema)(typed)).toEqual(typed);
    expect(Schema.decodeUnknownSync(KeyEventSchema)(pasted)).toEqual(pasted);
  });

  it("rejects unknown tags and missing payloads", () => {
    expect(() => Schema.decodeUnknownSync(KeyEventSchema)({ _tag: "nope" })).toThrow();
    expect(() => Schema.decodeUnknownSync(KeyEventSchema)({ _tag: "char" })).toThrow();
    expect(() => Schema.decodeUnknownSync(KeyEventSchema)({ _tag: "paste" })).toThrow();
  });
});
