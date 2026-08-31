import { describe, expect, it } from "vitest";
import {
  charWidth,
  stripLeadingEmoji,
  truncateToWidth,
  visibleWidth,
  wrapText,
} from "./text.ts";

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

  // pi-tui measures these (its `visibleWidth` backs pi's crash guard, which
  // hard-exits on any custom-UI line wider than the terminal), so inquiry must
  // agree to the column. Explored cases: models prefix prompts and option text
  // with `➡️`/`⚠️`/`❓`; the crash that started this work was a `➡️` under-
  // measured as one column, producing a line pi refused to render.
  it("counts emoji with variation selector as two columns (crash parity)", () => {
    expect(visibleWidth("➡️")).toBe(2);
    expect(visibleWidth("⚠️")).toBe(2);
    expect(visibleWidth("❓")).toBe(2);
    expect(visibleWidth("✈️")).toBe(2);
  });

  it("counts bare text-presentation arrows and checks as one column (pi-tui parity)", () => {
    expect(visibleWidth("➡")).toBe(1);
    expect(visibleWidth("⚠")).toBe(1);
    expect(visibleWidth("✔")).toBe(1);
  });

  it("counts flags as two columns", () => {
    expect(visibleWidth("🇺🇸")).toBe(2);
  });

  it("counts zwj family emoji per cluster like pi-tui", () => {
    // 2 when the runtime groups the family into one grapheme, 6 when it
    // segments the members (both are what pi-tui's rule yields on that engine).
    expect([2, 6]).toContain(visibleWidth("👨‍👩‍👧"));
  });

  it("widths add up across the crash prompt continuation", () => {
    const text =
      "➡️ Recommended: A — document-only. Zero mechanics, and (b) is a 10-line add if you want the operator signal.";
    // Exactly what pi-tui measured: 108 columns, one more than our old
    // per-code-point measure (107), which made the renderer skip wrapping.
    expect(visibleWidth(text)).toBe(108);
  });

  it("wraps the crash prompt continuation at the render width", () => {
    const text =
      "➡️ Recommended: A — document-only. Zero mechanics, and (b) is a 10-line add if you want the operator signal.";
    // Render width: 110-col terminal, 1 rail each side, 1-column prompt gutter.
    const wrapped = wrapText(text, 107);
    expect(wrapped.length).toBeGreaterThan(1);
    for (const line of wrapped) expect(visibleWidth(line)).toBeLessThanOrEqual(107);
  });

  it("truncates on grapheme boundaries", () => {
    expect(truncateToWidth("➡️ xy", 3)).toBe("➡️ ");
    expect(truncateToWidth("➡️ xy", 2)).toBe("➡️");
  });
});

describe("stripLeadingEmoji", () => {
  it("strips a leading marker emoji and the following space", () => {
    expect(stripLeadingEmoji("❓ Q7 — deployBlock guard?")).toBe("Q7 — deployBlock guard?");
    expect(stripLeadingEmoji("➡️ Recommended: A — document-only.")).toBe(
      "Recommended: A — document-only.",
    );
    expect(stripLeadingEmoji("⚠️ careful")).toBe("careful");
  });

  it("strips a run of emoji, not just one", () => {
    expect(stripLeadingEmoji("➡️ ➡️ twice")).toBe("twice");
  });

  it("strips from each line independently", () => {
    expect(stripLeadingEmoji("❓ Question?\n\n➡️ Recommended: A.")).toBe(
      "Question?\n\nRecommended: A.",
    );
  });

  it("leaves non-emoji prefixes alone", () => {
    expect(stripLeadingEmoji("→ text")).toBe("→ text");
    expect(stripLeadingEmoji("• bullet")).toBe("• bullet");
    expect(stripLeadingEmoji("Q7 deployBlock")).toBe("Q7 deployBlock");
    expect(stripLeadingEmoji("1. First")).toBe("1. First");
    expect(stripLeadingEmoji("")).toBe("");
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
