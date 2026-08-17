import { assert, it } from "@effect/vitest";
import { buildBoxFrame, composeBorderLine } from "./box-frame.ts";

const compose = (
  frame: NonNullable<ReturnType<typeof buildBoxFrame>>,
  kind: "top" | "bottom" = "top",
) => composeBorderLine(frame, kind);

it("defaults to the decorative ───── tail", () => {
  const frame = buildBoxFrame(20, { label: "hi", labelWidth: 2 })!;
  assert.strictEqual(frame.top.labelPrefix, "─── ");
  assert.strictEqual(frame.top.labelSuffix, " ─────");
  // 4 (─── ) + 2 (label) + 6 ( ─────) = 12 fixed; 18 - 12 = 6 fill dashes.
  assert.strictEqual(compose(frame), `╭─── hi ${"─".repeat(11)}╮`);
});

it("honors a custom label suffix", () => {
  const frame = buildBoxFrame(20, { label: "↓ 5 more", labelWidth: 8, labelSuffix: " " })!;
  assert.strictEqual(frame.top.labelPrefix, "─── ");
  assert.strictEqual(frame.top.labelSuffix, " ");
  // 4 + 8 + 1 = 13 fixed; 18 - 13 = 5 fill dashes.
  assert.strictEqual(compose(frame), `╭─── ↓ 5 more ${"─".repeat(5)}╮`);
});

it("clips to a plain frame when the label plus a custom suffix would overflow", () => {
  // 4 (─── ) + 8 (label) + 1 (suffix) = 13 > width - 2 = 10 → label dropped.
  const frame = buildBoxFrame(12, { label: "↓ 5 more", labelWidth: 8, labelSuffix: " " });
  assert.strictEqual(frame!.top.label, null);
  assert.strictEqual(`${frame!.top.left}${frame!.top.fill}${frame!.top.right}`, "╭──────────╮");
});

it("leaves the bottom border untouched by the label options", () => {
  const frame = buildBoxFrame(20, { label: "hi", labelWidth: 2, labelSuffix: " " })!;
  assert.strictEqual(frame.bottom.left, "╰");
  assert.strictEqual(frame.bottom.right, "╯");
  assert.strictEqual(frame.bottom.fill, "─".repeat(18));
});

it("paints the chrome but passes the label through raw", () => {
  const frame = buildBoxFrame(20, { label: "hi", labelWidth: 2 })!;
  const paint = (text: string) => `<${text}>`;
  assert.strictEqual(composeBorderLine(frame, "top", paint), `<╭><─── >hi< ─────><──────><╮>`);
  assert.strictEqual(composeBorderLine(frame, "bottom", paint), `<╰><──────────────────><╯>`);
});
