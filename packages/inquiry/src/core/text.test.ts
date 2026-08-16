import { describe, expect, it } from "vitest";
import { charWidth, visibleWidth, wrapText } from "./text.ts";

describe("visibleWidth", () => {
  it("counts ASCII as one column per character", () => {
    expect(visibleWidth("hello")).toBe(5);
    expect(visibleWidth("")).toBe(0);
  });

  it("counts wide CJK characters as two columns", () => {
    expect(visibleWidth("日本語")).toBe(6);
  });

  it("counts tabs as three columns", () => {
    expect(visibleWidth("\t")).toBe(3);
    expect(visibleWidth("a\tb")).toBe(5);
  });

  it("ignores control characters", () => {
    expect(visibleWidth("\x1b")).toBe(0);
    // the core never strips ANSI sequences; only the escape byte itself is zero-width
    expect(visibleWidth("\x1b[31m")).toBe(4);
  });

  it("counts emoji as two columns", () => {
    expect(visibleWidth("😀")).toBe(2);
  });

  it("counts combining marks as zero", () => {
    expect(visibleWidth("e\u0301")).toBe(1);
  });
});

describe("charWidth", () => {
  it("handles zero-width joiner and variation selectors", () => {
    expect(charWidth("\u200d")).toBe(0);
    expect(charWidth("\ufe0f")).toBe(0);
  });
});

describe("wrapText", () => {
  it("returns the text unchanged when it fits", () => {
    expect(wrapText("hello world", 20)).toEqual(["hello world"]);
  });

  it("wraps at word boundaries", () => {
    expect(wrapText("one two three", 7)).toEqual(["one two", "three"]);
  });

  it("breaks long words character by character", () => {
    expect(wrapText("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"]);
  });

  it("trims trailing whitespace", () => {
    expect(wrapText("one two  ", 7)).toEqual(["one two"]);
  });

  it("does not start a line with whitespace", () => {
    expect(wrapText("one  two three", 6)).toEqual(["one", "two", "three"]);
  });

  it("splits on literal newlines", () => {
    expect(wrapText("one\ntwo three", 20)).toEqual(["one", "two three"]);
  });

  it("returns an empty line for empty input", () => {
    expect(wrapText("", 10)).toEqual([""]);
  });

  it("handles width one", () => {
    expect(wrapText("ab", 1)).toEqual(["a", "b"]);
  });

  it("handles wide characters in wrapping", () => {
    expect(wrapText("あああ", 4)).toEqual(["ああ", "あ"]);
  });
});
