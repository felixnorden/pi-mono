import { describe, expect, it } from "vitest";
import { parseKey } from "./keys.ts";
import { KeyEvent } from "../core/keyboard.ts";

describe("parseKey", () => {
  it("maps legacy arrow and navigation sequences", () => {
    expect(parseKey("\x1b[A")).toEqual(KeyEvent.up);
    expect(parseKey("\x1b[B")).toEqual(KeyEvent.down);
    expect(parseKey("\x1b[C")).toEqual(KeyEvent.right);
    expect(parseKey("\x1b[D")).toEqual(KeyEvent.left);
    expect(parseKey("\x1b[H")).toEqual(KeyEvent.home);
    expect(parseKey("\x1b[F")).toEqual(KeyEvent.end);
  });

  it("maps tab, shift-tab, enter and escape", () => {
    expect(parseKey("\t")).toEqual(KeyEvent.tab);
    expect(parseKey("\x1b[Z")).toEqual(KeyEvent.shiftTab);
    expect(parseKey("\r")).toEqual(KeyEvent.enter);
    expect(parseKey("\x1b")).toEqual(KeyEvent.escape);
  });

  it("maps shift+enter sequences to shiftEnter", () => {
    expect(parseKey("\n")).toEqual(KeyEvent.shiftEnter);
    expect(parseKey("\x1b\r")).toEqual(KeyEvent.shiftEnter);
    expect(parseKey("\x1b[13;2~")).toEqual(KeyEvent.shiftEnter);
    expect(parseKey("\x1b[13;2u")).toEqual(KeyEvent.shiftEnter);
  });

  it("keeps plain enter as enter", () => {
    expect(parseKey("\r")).toEqual(KeyEvent.enter);
  });

  it("extracts bracketed paste content", () => {
    expect(parseKey("\x1b[200~hello world\x1b[201~")).toEqual(KeyEvent.paste("hello world"));
    expect(parseKey("\x1b[200~line1\nline2\x1b[201~")).toEqual(KeyEvent.paste("line1\nline2"));
  });

  it("decodes CSI-u re-encoded control bytes inside pastes", () => {
    // tmux re-encodes a newline (ctrl+j) inside bracketed paste as \x1b[106;5u
    expect(parseKey("\x1b[200~a\x1b[106;5ub\x1b[201~")).toEqual(KeyEvent.paste("a\nb"));
  });

  it("maps backspace and delete", () => {
    expect(parseKey("\x7f")).toEqual(KeyEvent.backspace);
    expect(parseKey("\x1b[3~")).toEqual(KeyEvent.delete);
  });

  it("passes printable characters through as char events", () => {
    expect(parseKey("a")).toEqual(KeyEvent.char("a"));
    expect(parseKey("😀")).toEqual(KeyEvent.char("😀"));
    expect(parseKey("paste")).toEqual(KeyEvent.char("paste"));
  });

  it("rejects control input", () => {
    expect(parseKey("\x03")).toBeNull(); // ctrl+c
    expect(parseKey("\x00")).toBeNull();
    expect(parseKey("\x1b[1;5C")).toBeNull(); // ctrl+right, unsupported
  });
});
