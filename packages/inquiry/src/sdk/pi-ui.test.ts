import { describe, expect, it } from "vitest";
import { codePointToUtf16, utf16ToCodePoint } from "./pi-ui.ts";

describe("cursor unit conversion", () => {
  it("round-trips ASCII text", () => {
    const text = "@src/main.ts";
    for (let i = 0; i <= text.length; i++) {
      expect(utf16ToCodePoint(text, codePointToUtf16(text, i))).toBe(i);
    }
  });

  it("counts surrogate pairs as single code points", () => {
    // 😀 is 2 UTF-16 code units but 1 code point
    const text = "😀 @s";
    expect(codePointToUtf16(text, 0)).toBe(0);
    expect(codePointToUtf16(text, 1)).toBe(2); // after the emoji
    expect(codePointToUtf16(text, 2)).toBe(3); // after the space
    expect(codePointToUtf16(text, 4)).toBe(5); // end of text
    expect(utf16ToCodePoint(text, 5)).toBe(4);
    expect(utf16ToCodePoint(text, 2)).toBe(1);
  });

  it("clamps out-of-range cursors", () => {
    expect(codePointToUtf16("ab", 99)).toBe(2);
    expect(codePointToUtf16("ab", -1)).toBe(0);
    expect(utf16ToCodePoint("ab", 99)).toBe(2);
    expect(utf16ToCodePoint("ab", -1)).toBe(0);
  });
});
