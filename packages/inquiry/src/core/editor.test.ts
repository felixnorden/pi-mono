import { describe, expect, it } from "vitest";
import {
  editorBackspace,
  editorDelete,
  editorFromText,
  editorInsert,
  editorMoveEnd,
  editorMoveHome,
  editorMoveLeft,
  editorMoveRight,
  emptyEditor,
  sanitizePaste,
} from "./editor.ts";

describe("editorFromText", () => {
  it("places the cursor at the end of the text", () => {
    expect(editorFromText("hey")).toEqual({ text: "hey", cursor: 3 });
    expect(editorFromText("a\nb")).toEqual({ text: "a\nb", cursor: 3 });
  });

  it("counts code points, not UTF-16 units", () => {
    expect(editorFromText("😀").cursor).toBe(1);
  });
});

describe("editorInsert", () => {
  it("inserts into an empty editor", () => {
    const s = editorInsert(emptyEditor(), "ab");
    expect(s.text).toBe("ab");
    expect(s.cursor).toBe(2);
  });

  it("inserts at the cursor position", () => {
    const s = editorInsert(editorInsert(emptyEditor(), "ab"), "X");
    expect(s.text).toBe("abX");
    const moved = editorMoveLeft(editorInsert(emptyEditor(), "ab"));
    const inserted = editorInsert(moved, "X");
    expect(inserted.text).toBe("aXb");
    expect(inserted.cursor).toBe(2);
  });

  it("treats surrogate pairs as single characters", () => {
    const s = editorInsert(emptyEditor(), "😀");
    expect(s.cursor).toBe(1);
    expect(s.text).toBe("😀");
  });
});

describe("editorBackspace", () => {
  it("deletes the character before the cursor", () => {
    const s = editorBackspace(editorInsert(emptyEditor(), "abc"));
    expect(s.text).toBe("ab");
    expect(s.cursor).toBe(2);
  });

  it("is a no-op at the start", () => {
    const s = editorBackspace(emptyEditor());
    expect(s).toEqual(emptyEditor());
  });

  it("deletes whole code points", () => {
    // insert "😀a", move left of the trailing "a", then backspace deletes the emoji
    const base = editorInsert(emptyEditor(), "😀a");
    const s = editorBackspace(editorMoveLeft(base));
    expect(s.text).toBe("a");
    expect(s.cursor).toBe(0);
  });
});

describe("editorDelete", () => {
  it("deletes the character at the cursor", () => {
    const s = editorDelete(editorMoveHome(editorInsert(emptyEditor(), "abc")));
    expect(s.text).toBe("bc");
    expect(s.cursor).toBe(0);
  });

  it("is a no-op at the end", () => {
    const s = editorDelete({ text: "ab", cursor: 2 });
    expect(s.text).toBe("ab");
  });
});

describe("editor movement", () => {
  it("moves left and right", () => {
    const base = editorInsert(emptyEditor(), "abc");
    expect(editorMoveLeft(base).cursor).toBe(2);
    expect(editorMoveRight(emptyEditor()).cursor).toBe(0);
  });

  it("clamps at the boundaries", () => {
    expect(editorMoveLeft(emptyEditor()).cursor).toBe(0);
    expect(editorMoveRight({ text: "ab", cursor: 2 }).cursor).toBe(2);
  });

  it("moves by code points", () => {
    const base = editorInsert(emptyEditor(), "😀a");
    expect(editorMoveLeft(base).cursor).toBe(1);
    expect(editorMoveRight(editorMoveLeft(base)).cursor).toBe(2);
  });

  it("jumps home and end", () => {
    const base = { text: "abc", cursor: 1 };
    expect(editorMoveHome(base).cursor).toBe(0);
    expect(editorMoveEnd(base).cursor).toBe(3);
  });
});

describe("sanitizePaste", () => {
  it("normalizes line endings to newlines", () => {
    expect(sanitizePaste("a\r\nb\rc")).toBe("a\nb\nc");
  });

  it("expands tabs to four spaces", () => {
    expect(sanitizePaste("a\tb")).toBe("a    b");
  });

  it("keeps newlines and printable characters", () => {
    expect(sanitizePaste("line1\nline2 😀")).toBe("line1\nline2 😀");
  });

  it("drops other control characters", () => {
    expect(sanitizePaste("\x03a\x07\x1bb")).toBe("ab");
  });
});
