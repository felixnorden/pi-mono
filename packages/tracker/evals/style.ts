/**
 * Terminal styling for the labeler.
 *
 * Bun ships a markdown renderer that emits ANSI: `Bun.markdown.ansi` handles
 * headings, lists, block quotes, fenced code frames, and syntax highlighting,
 * and its `columns` option wraps prose without touching a code fence. No
 * dependency is added.
 *
 * The renderers in `labeling.ts` receive a `Paint` object rather than reading
 * the terminal directly, so a test can assert on plain text and a non-TTY run
 * cannot emit escape codes. The markdown renderer is injectable because the
 * test runner is Node, where `Bun` is undefined; the labeler itself runs under
 * Bun and gets the real renderer.
 */

/** Escapes the terminal understands. */
const SGR = {
  reset: "\u001b[0m",
  bold: "\u001b[1m",
  dim: "\u001b[2m",
  underline: "\u001b[4m",
  red: "\u001b[31m",
  green: "\u001b[32m",
  yellow: "\u001b[33m",
  blue: "\u001b[34m",
  magenta: "\u001b[35m",
  cyan: "\u001b[36m",
  gray: "\u001b[90m",
} as const;

/** How to render markdown prose. */
export type MarkdownRenderer = (
  text: string,
  options: { readonly colors: boolean; readonly columns: number },
) => string;

/** Styling hooks the renderers use. A plain paint returns its input unchanged. */
export interface Paint {
  readonly bold: (text: string) => string;
  readonly dim: (text: string) => string;
  readonly underline: (text: string) => string;
  readonly red: (text: string) => string;
  readonly green: (text: string) => string;
  readonly yellow: (text: string) => string;
  readonly blue: (text: string) => string;
  readonly magenta: (text: string) => string;
  readonly cyan: (text: string) => string;
  readonly gray: (text: string) => string;
  /** Render markdown prose, wrapped to `columns` when the renderer supports it. */
  readonly markdown: (text: string, columns: number) => string;
  /** Render preformatted text as a framed code block. */
  readonly code: (text: string, language: string, columns: number) => string;
}

const plain = (text: string): string => text;

/** A tint that emits nothing when colour is off. */
const sgr =
  (open: string, color: boolean) =>
  (text: string): string =>
    color ? `${open}${text}${SGR.reset}` : text;

/** No escape codes. Used by tests and by a terminal without colour. */
export const plainPaint: Paint = {
  bold: plain,
  dim: plain,
  underline: plain,
  red: plain,
  green: plain,
  yellow: plain,
  blue: plain,
  magenta: plain,
  cyan: plain,
  gray: plain,
  markdown: plain,
  code: plain,
};

/** `Bun.markdown.ansi`, or undefined when the runtime has no such function. */
const bunMarkdown = (): MarkdownRenderer | undefined => {
  const bun = (globalThis as { Bun?: unknown }).Bun;
  if (typeof bun !== "object" || bun === null) return undefined;
  const markdown = (bun as { markdown?: unknown }).markdown;
  if (typeof markdown !== "object" || markdown === null) return undefined;
  const ansi = (markdown as { ansi?: unknown }).ansi;
  if (typeof ansi !== "function") return undefined;
  return (text, options) =>
    String((ansi as (value: string, settings: unknown) => unknown).call(markdown, text, options));
};

/**
 * A fence longer than any backtick run in `text`, so a body that contains a
 * fence cannot close the block early.
 */
export const fence = (text: string): string => {
  const runs = text.match(/`+/g) ?? [];
  const longest = runs.reduce((max, run) => Math.max(max, run.length), 0);
  return "`".repeat(Math.max(3, longest + 1));
};

/**
 * Escape codes on, rendering markdown through `render`.
 *
 * `render` defaults to Bun's renderer. It is a parameter so a Node test can
 * inject a stub, and so a runtime without it degrades to plain text.
 */
export const ansiPaint = (
  color = true,
  render: MarkdownRenderer | undefined = bunMarkdown(),
): Paint => {
  const tint = (open: string) => sgr(open, color);
  const markdown = (text: string, columns: number): string =>
    render === undefined ? text : render(text, { colors: color, columns });
  return {
    bold: tint(SGR.bold),
    dim: tint(SGR.dim),
    underline: tint(SGR.underline),
    red: tint(SGR.red),
    green: tint(SGR.green),
    yellow: tint(SGR.yellow),
    blue: tint(SGR.blue),
    magenta: tint(SGR.magenta),
    cyan: tint(SGR.cyan),
    gray: tint(SGR.gray),
    markdown,
    // Without a renderer, a raw fence would be printed literally, so fall back
    // to the bare text instead.
    code: (text, language, columns) =>
      render === undefined
        ? text
        : markdown(`${fence(text)}${language}\n${text}\n${fence(text)}`, columns).replace(
            /\n$/,
            "",
          ),
  };
};

/**
 * Whether to emit escape codes. `FORCE_COLOR` wins, then `NO_COLOR`, then
 * whether stdout is a terminal.
 */
export const useColor = (
  env: Readonly<Record<string, string | undefined>> = process.env,
  isTTY: boolean | undefined = process.stdout.isTTY,
): boolean => {
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== "0") return true;
  if (env.NO_COLOR !== undefined) return false;
  return isTTY === true;
};

/** Drop escape codes. Used by tests and to measure a rendered line. */
export const stripAnsi = (text: string): string => {
  const bun = (globalThis as { Bun?: { stripANSI?: unknown } }).Bun;
  if (typeof bun?.stripANSI === "function") {
    return (bun.stripANSI as (value: string) => string)(text);
  }
  // The control characters are the point: this matches escape codes.
  // oxlint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "");
};
