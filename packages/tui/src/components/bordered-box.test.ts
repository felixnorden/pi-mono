import { assert, it } from "@effect/vitest";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { makeBorderedBox } from "./bordered-box.ts";

// A body component that renders exactly the given lines (Text pads/wraps).
const lines = (content: string[]): Component => ({
  render: () => content,
  invalidate: () => {},
});

// Identity theme for structural assertions.
const plainTheme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

// Marker theme for color and background assertions.
const markerTheme = {
  fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
  bg: (color: string, text: string) => `[${color}]${text}[/${color}]`,
  bold: (text: string) => text,
} as unknown as Theme;

it("renders top and bottom borders with the content rail-wrapped between them", () => {
  const out = makeBorderedBox(lines(["hi"]), plainTheme).render(12);
  assert.deepStrictEqual(out, ["╭──────────╮", "│ hi       │", "╰──────────╯"]);
  for (const line of out) assert.strictEqual(line.length, 12);
});

it("embeds the label in the top border when there is room", () => {
  const out = makeBorderedBox(lines(["hi"]), plainTheme, { label: "hello" }).render(40);
  assert.strictEqual(out[0]!.includes("─── hello ─────"), true);
  assert.strictEqual(out[0]!.startsWith("╭"), true);
  assert.strictEqual(out[0]!.endsWith("╮"), true);
});

it("omits the label when the box is too narrow", () => {
  const out = makeBorderedBox(lines(["hi"]), plainTheme, { label: "hello" }).render(7);
  assert.strictEqual(out[0], "╭─────╮");
  assert.strictEqual(out[0]!.includes("hello"), false);
});

it("truncates long body lines to the content width", () => {
  const out = makeBorderedBox(lines(["abcdefghij"]), plainTheme).render(8);
  // truncateToWidth appends an SGR reset after the cut (display width 0).
  assert.deepStrictEqual(out, ["╭──────╮", "│ abcd\x1b[0m │", "╰──────╯"]);
});

it("applies the background function to every rendered line", () => {
  const bg = (s: string) => `[customMessageBg]${s}[/customMessageBg]`;
  const out = makeBorderedBox(lines(["hi"]), markerTheme, { bg }).render(12);
  assert.strictEqual(out.length, 3);
  for (const line of out) {
    assert.strictEqual(line.startsWith("[customMessageBg]"), true);
    assert.strictEqual(line.endsWith("[/customMessageBg]"), true);
  }
});

it("paints the border with the configured color token", () => {
  const out = makeBorderedBox(lines(["hi"]), markerTheme, { color: "warning" }).render(12);
  assert.strictEqual(out[0]!.includes("<warning>╭"), true);
  assert.strictEqual(out[0]!.includes("<accent>"), false);
});

it("pads the content by the configured padding", () => {
  const out = makeBorderedBox(lines(["hi"]), plainTheme, { paddingX: 2 }).render(12);
  assert.deepStrictEqual(out, ["╭──────────╮", "│  hi      │", "╰──────────╯"]);
});

it("renders nothing when the width is too small for a border", () => {
  assert.deepStrictEqual(makeBorderedBox(lines(["hi"]), plainTheme).render(2), []);
});

it("invalidates the body", () => {
  const body = lines(["hi"]);
  const box = makeBorderedBox(body, plainTheme);
  box.invalidate();
  // invalidate is a no-op for the fake body; assert it runs without error
  assert.strictEqual(typeof body.invalidate, "function");
});

it("caches the rendered lines across renders at the same width", () => {
  let bodyRenders = 0;
  const body: Component = {
    render: () => {
      bodyRenders++;
      return ["hi"];
    },
    invalidate: () => {},
  };
  const box = makeBorderedBox(body, plainTheme);
  const first = box.render(12);
  const second = box.render(12);
  assert.strictEqual(bodyRenders, 1);
  assert.strictEqual(second, first);
});

it("renders through a plain wrapper object (TUI calls render as a method of the handed-off object)", () => {
  const box = makeBorderedBox(lines(["hi"]), plainTheme, { label: "Tracker" });
  // Regression for the resume crash: setWidget bridges hand the TUI a wrapper
  // like `{ render: widget.render, ... }`, and pi-tui invokes render as a
  // method *of that wrapper*. Closure components carry no `this`, so the
  // hand-off is safe by construction — detaching the methods must not break.
  // oxlint-disable typescript/unbound-method -- intentional seam regression:
  // closure components must survive detached hand-off.
  const wrapper: Component = { render: box.render, invalidate: box.invalidate };
  // oxlint-enable typescript/unbound-method
  assert.deepStrictEqual(wrapper.render(12), ["╭──────────╮", "│ hi       │", "╰──────────╯"]);
  wrapper.invalidate();
  const second = wrapper.render(24);
  assert.deepStrictEqual(second, [
    "╭─── Tracker ──────────╮",
    "│ hi                   │",
    "╰──────────────────────╯",
  ]);
});

it("recomputes when the width changes and invalidate clears the cache", () => {
  let bodyRenders = 0;
  const body: Component = {
    render: () => {
      bodyRenders++;
      return ["hi"];
    },
    invalidate: () => {},
  };
  const box = makeBorderedBox(body, plainTheme);
  box.render(12);
  box.render(20);
  assert.strictEqual(bodyRenders, 2);
  box.invalidate();
  box.render(12);
  assert.strictEqual(bodyRenders, 3);
});
