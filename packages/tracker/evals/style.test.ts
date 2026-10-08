import { assert, it } from "@effect/vitest";
import {
  ansiPaint,
  fence,
  plainPaint,
  stripAnsi,
  useColor,
  type MarkdownRenderer,
} from "./style.ts";

/** Records what the renderer was asked for, and returns a marker. */
const spyRenderer = (): {
  render: MarkdownRenderer;
  calls: Array<{ text: string; colors: boolean; columns: number }>;
} => {
  const calls: Array<{ text: string; colors: boolean; columns: number }> = [];
  return {
    calls,
    render: (text, options) => {
      calls.push({ text, colors: options.colors, columns: options.columns });
      return "RENDERED";
    },
  };
};

it("plain paint returns its input unchanged", () => {
  for (const key of ["bold", "dim", "red", "green", "yellow", "cyan"] as const) {
    assert.strictEqual(plainPaint[key]("x"), "x");
  }
  assert.strictEqual(plainPaint.markdown("# Title", 40), "# Title");
  assert.strictEqual(plainPaint.code("const x = 1;", "ts", 40), "const x = 1;");
});

it("ansi paint wraps text in an escape code and resets", () => {
  const painted = ansiPaint().bold("x");
  // oxlint-disable-next-line no-control-regex
  assert.match(painted, /^\u001b\[1mx\u001b\[0m$/);
  assert.strictEqual(stripAnsi(painted), "x");
});

it("ansi paint sends prose to the markdown renderer with the colour and width", () => {
  const spy = spyRenderer();
  const paint = ansiPaint(true, spy.render);
  assert.strictEqual(paint.markdown("Some **bold** text.", 42), "RENDERED");
  assert.deepStrictEqual(spy.calls, [{ text: "Some **bold** text.", colors: true, columns: 42 }]);
});

it("ansi paint sends a code block as a fenced body", () => {
  const spy = spyRenderer();
  ansiPaint(true, spy.render).code('{"a":1}', "json", 60);
  assert.strictEqual(spy.calls.length, 1);
  assert.strictEqual(spy.calls[0]!.text, '```json\n{"a":1}\n```');
  assert.strictEqual(spy.calls[0]!.columns, 60);
});

it("ansi paint with colour off emits no escape codes and still renders markup", () => {
  const paint = ansiPaint(false, (text, options) =>
    options.colors ? "\u001b[1mrendered\u001b[0m" : "rendered",
  );
  assert.strictEqual(paint.bold("x"), "x");
  assert.strictEqual(paint.cyan("x"), "x");
  assert.strictEqual(paint.markdown("**x**", 40), "rendered");
  assert.strictEqual(paint.code("body", "json", 40), "rendered");
});

it("ansi paint degrades to plain text without a renderer", () => {
  const paint = ansiPaint(true, undefined);
  assert.strictEqual(paint.markdown("Some **bold** text.", 42), "Some **bold** text.");
  assert.strictEqual(paint.code("body", "json", 42), "body");
});

it("fence grows past the longest backtick run in the body", () => {
  assert.strictEqual(fence("plain"), "```");
  assert.strictEqual(fence("a ``` b"), "````");
  assert.strictEqual(fence("a ` b"), "```");
  assert.strictEqual(fence("a ```` b"), "`````");
});

it("a fence inside the body cannot close the block early", () => {
  const body = "before\n```\nafter";
  const spy = spyRenderer();
  ansiPaint(true, spy.render).code(body, "text", 80);
  assert.strictEqual(spy.calls[0]!.text, "````text\nbefore\n```\nafter\n````");
});

it("useColor honours FORCE_COLOR, then NO_COLOR, then the terminal", () => {
  assert.strictEqual(useColor({ FORCE_COLOR: "1" }, false), true);
  assert.strictEqual(useColor({ FORCE_COLOR: "0", NO_COLOR: "1" }, true), false);
  assert.strictEqual(useColor({ NO_COLOR: "1" }, true), false);
  assert.strictEqual(useColor({}, true), true);
  assert.strictEqual(useColor({}, false), false);
  assert.strictEqual(useColor({}, undefined), false);
});

it("stripAnsi removes every escape code", () => {
  assert.strictEqual(stripAnsi("\u001b[1mb\u001b[0m\u001b[38;5;242mc\u001b[39m"), "bc");
});
