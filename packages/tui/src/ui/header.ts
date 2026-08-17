import {
  VERSION,
  type ExtensionAPI,
  type ExtensionContext,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { makeBorderedBox } from "../components/bordered-box.ts";
import {
  center,
  collectPiCommandNames,
  formatCwd,
  formatModelLabel,
  formatThinkingLabel,
  headerColumnWidths,
  padRight,
  pickSlashCommandTips,
} from "../utils.ts";

const LOGO_CELL = "███";

/** Static house logo: painted cells as "row,col" (1-based), blank elsewhere. */
const LOGO_CELLS = new Set(["3,2", "3,3", "3,4", "4,2", "4,4", "5,2", "5,3", "5,5", "6,2", "6,5"]);

function renderLogo(paint: (text: string) => string): string[] {
  const grid: boolean[][] = [];
  let minX = 7;
  let maxX = 0;
  for (let y = 1; y <= 7; y++) {
    const row: boolean[] = [];
    for (let x = 1; x <= 8; x++) {
      const on = LOGO_CELLS.has(`${y},${x}`);
      if (on) {
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
      }
      row.push(on);
    }
    grid.push(row);
  }
  return grid.map((row) =>
    row
      .slice(minX - 1, maxX)
      .map((on) => (on ? paint(LOGO_CELL) : " ".repeat(LOGO_CELL.length)))
      .join(""),
  );
}

function twoColumn(
  left: string,
  right: string,
  leftWidth: number,
  rightWidth: number,
  paint: (text: string) => string,
): string {
  return `${padRight(left, leftWidth)} ${paint("│")} ${padRight(right, rightWidth, "…")}`;
}

export interface TuiHeaderOptions {
  /**
   * Random source for the slash-command tips shuffle. Defaults to
   * `Math.random`; inject a fixed function for deterministic renders.
   */
  readonly random?: () => number;
}

/**
 * Pi header widget (`setHeader`), framed in the house rounded box.
 *
 * The frame (top border with the `Pi vVERSION` label, the `│` rails, the
 * bottom border) is rendered by {@link makeBorderedBox} so every view in
 * this package shares one border implementation. Only the body — logo, title,
 * model/effort/cwd column, and the slash-command tips — is composed here.
 * The header keeps the body rail-flush (`paddingX: 0`) to preserve a
 * zero-gap look between content and rails.
 */
export class TuiHeader implements Component {
  private readonly pi: ExtensionAPI;
  private readonly ctx: ExtensionContext;
  private readonly tipCommands: string[];

  constructor(pi: ExtensionAPI, ctx: ExtensionContext, _tui: TUI, options: TuiHeaderOptions = {}) {
    this.pi = pi;
    this.ctx = ctx;
    const pool = collectPiCommandNames(pi.getCommands());
    this.tipCommands = pickSlashCommandTips(pool, {
      fixed: ["tui"],
      count: 3,
      random: options.random,
    });
  }

  render(width: number): string[] {
    const theme = this.ctx.ui.theme;
    const paint = (s: string) => theme.fg("accent", s);

    if (width < 24) return [paint(`Pi v${VERSION}`)];

    const innerWidth = width - 2;
    const { leftWidth, rightWidth, useTips } = headerColumnWidths(innerWidth);
    const body: Component = {
      render: () => this.renderBody(theme, innerWidth, leftWidth, rightWidth, useTips),
      invalidate: () => {},
    };
    return makeBorderedBox(body, theme, {
      label: `${paint("Pi")} v${VERSION}`,
      paddingX: 0,
    }).render(width);
  }

  invalidate(): void {}

  dispose(): void {}

  /**
   * The header body: the left logo/title/model/cwd column and, when the
   * width allows, the right tips column. Rendered at `innerWidth` because
   * the frame owns the two rail columns (`paddingX: 0`).
   */
  private renderBody(
    theme: Theme,
    _: number,
    leftWidth: number,
    rightWidth: number,
    useTips: boolean,
  ): string[] {
    const paint = (s: string) => theme.fg("accent", s);
    const muted = (s: string) => theme.fg("muted", s);
    const dim = (s: string) => theme.fg("dim", s);
    const bold = (s: string) => theme.bold(s);

    const leftLines = [
      ...renderLogo(paint).map((line) => center(line, leftWidth)),
      center(bold("Let's make some Pi(e)"), leftWidth),
      center(
        muted(
          `${formatModelLabel(this.ctx.model)} · ${formatThinkingLabel(this.pi.getThinkingLevel())}`,
        ),
        leftWidth,
      ),
      center(dim(formatCwd(this.ctx.cwd)), leftWidth),
    ];

    const tipDivider = paint("─".repeat(Math.max(8, Math.min(rightWidth, 22))));
    const [cmd0 = "", cmd1 = "", cmd2 = "", cmd3 = ""] = this.tipCommands;
    const tipLines = [
      "",
      paint(bold("Welcome")),
      muted("Ask Pi anything"),
      tipDivider,
      paint(bold("Commands")),
      muted(cmd0),
      muted(cmd1),
      muted(cmd2),
      muted(cmd3),
      "",
    ];

    const rows: string[] = [];
    for (let i = 0; i < leftLines.length; i++) {
      const content = useTips
        ? twoColumn(leftLines[i] ?? "", tipLines[i] ?? "", leftWidth, rightWidth, paint)
        : padRight(leftLines[i] ?? "", leftWidth);
      rows.push(content);
    }
    return rows;
  }
}

export function installHeader(pi: ExtensionAPI, ctx: ExtensionContext): () => void {
  let header: TuiHeader | undefined;
  ctx.ui.setHeader((tui) => {
    header?.dispose();
    header = new TuiHeader(pi, ctx, tui);
    return header;
  });
  return () => {
    header?.dispose();
    header = undefined;
    ctx.ui.setHeader(undefined);
  };
}
