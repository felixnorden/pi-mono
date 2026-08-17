// Shared pure themed-string leaves for the widget render pipelines.
//
// Relocation, not redesign: the header leaves moved here verbatim from
// header.ts (Slice 1) and the footer leaves from footer.ts (Slice 3). Byte
// parity is gated by the frozen pixel tables in header.test.ts / footer.test.ts,
// so a moved-but-changed helper cannot ship.

import type { ExtensionContext, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { TuiConfig } from "../config.ts";
import type { IconGlyphs } from "../icons.ts";
import { resolveIconMode, runtimeSymbol } from "../icons.ts";
import type { GitStatus } from "../commands/git-status.ts";
import type { RuntimeInfo } from "../runtime.ts";
import {
  cacheHitColor,
  fmtTokens,
  formatCost,
  formatDuration,
  padRight,
  sanitizeStatus,
  stressColor,
  truncatePath,
} from "../utils.ts";
import type { FooterState, UsageTotals } from "../state.ts";

// ---------------------------------------------------------------------------
// Header leaves (relocated verbatim from header.ts, Slice 1)
// ---------------------------------------------------------------------------

const LOGO_CELL = "███";

/** Static house logo: painted cells as "row,col" (1-based), blank elsewhere. */
const LOGO_CELLS = new Set(["3,2", "3,3", "3,4", "4,2", "4,4", "5,2", "5,3", "5,5", "6,2", "6,5"]);

/**
 * The house logo grid as painted lines: painted cells rendered with
 * `paint(LOGO_CELL)` and blank cells padded to the same width, cropped to
 * the logo's bounding box.
 */
export function renderLogo(paint: (text: string) => string): string[] {
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

/**
 * One header body row: left column padded to `leftWidth`, a painted
 * column separator, and the right cell padded to `rightWidth` (with `…`
 * when the right cell overflows).
 */
export function twoColumn(
  left: string,
  right: string,
  leftWidth: number,
  rightWidth: number,
  paint: (text: string) => string,
): string {
  return `${padRight(left, leftWidth)} ${paint("│")} ${padRight(right, rightWidth, "…")}`;
}

// ---------------------------------------------------------------------------
// Footer leaves (relocated verbatim from footer.ts, Slice 3)
// ---------------------------------------------------------------------------

/**
 * A context-usage bar segment: `[####----]` (ascii) or `[████░░░░]`
 * (nerd) with the filled fraction colored by `stressColor`, framed by
 * dim brackets.
 */
export function renderBar(theme: Theme, pct: number, barWidth: number, ascii: boolean): string {
  const filled = Math.max(0, Math.min(barWidth, Math.round((pct / 100) * barWidth)));
  const empty = barWidth - filled;
  const color = stressColor(pct);
  const filledCell = ascii ? "#" : "█";
  const emptyCell = ascii ? "-" : "░";
  return (
    theme.fg("dim", "[") +
    theme.fg(color, filledCell.repeat(filled)) +
    theme.fg("dim", emptyCell.repeat(empty)) +
    theme.fg("dim", "]")
  );
}

/**
 * The git footer segment: branch (or detached HEAD short hash + tag) and,
 * when enabled, the bracketed status block (`[!3 A2 ?1 S1 ^v2/1]`). Each
 * count is gated by its `footerSegments` flag; an empty result returns
 * `""` so the caller drops the segment.
 */
export function renderGitSegment(
  theme: Theme,
  git: GitStatus,
  glyphs: IconGlyphs,
  segments: TuiConfig["footerSegments"],
  maxBranchLen = 20,
): string {
  const parts: string[] = [];
  if (segments.gitBranch) {
    if (git.branch) {
      parts.push(theme.fg("mdLink", glyphs.git));
      parts.push(theme.fg("mdLink", truncatePath(git.branch, maxBranchLen)));
    } else if (git.commit?.detached) {
      parts.push(theme.fg("warning", glyphs.git));
      parts.push(theme.fg("warning", "HEAD"));
      if (git.commit.oid) {
        const shortHash = git.commit.oid.slice(0, 7);
        const tag = git.commit.tag ? ` ${git.commit.tag}` : "";
        parts.push(theme.fg("dim", `${shortHash}${tag}`));
      }
    }
  }

  if (segments.gitStatus) {
    const statusIcons: string[] = [];
    const addStatus = (count: number, glyph: string, color: ThemeColor) => {
      if (count > 0) statusIcons.push(theme.fg(color, `${glyph}${count}`));
    };
    addStatus(git.conflicted, glyphs.conflicted, "error");
    addStatus(git.deleted, glyphs.deleted, "error");
    addStatus(git.modified, glyphs.modified, "warning");
    addStatus(git.renamed, glyphs.renamed, "warning");
    addStatus(git.staged, glyphs.staged, "success");
    addStatus(git.untracked, glyphs.untracked, "muted");
    addStatus(git.stashed, glyphs.stashed, "muted");

    if (git.ahead > 0 && git.behind > 0) {
      statusIcons.push(theme.fg("warning", `${glyphs.diverged}${git.ahead}/${git.behind}`));
    } else if (git.ahead > 0) {
      statusIcons.push(theme.fg("success", `${glyphs.ahead}${git.ahead}`));
      statusIcons.push(theme.fg("warning", `${glyphs.behind}${git.behind}`));
    }

    const statusBlock = statusIcons.join(" ");
    if (statusBlock) {
      parts.push(`${theme.fg("dim", "[")}${statusBlock}${theme.fg("dim", "]")}`);
    }
  }

  return parts.join(" ");
}

/**
 * The runtime footer segment: a runtime symbol (ascii or nerd per the
 * icon mode) plus its version when known. Returns `""` for no runtime.
 */
export function renderRuntimeSegment(
  theme: Theme,
  runtime: RuntimeInfo | null,
  iconMode: TuiConfig["icons"]["mode"],
): string {
  if (!runtime) return "";
  const symbol = theme.fg("success", runtimeSymbol(runtime.name, iconMode));
  const version = runtime.version ? theme.fg("muted", runtime.version) : "";
  const label = [symbol, version].filter(Boolean).join(" ");
  return label;
}

/**
 * The working/done timer footer segment, or `""` when neither timer
 * field is set. The working read calls `Date.now()` only while a timer
 * is active.
 */
export function renderTimerSegment(theme: Theme, state: FooterState, glyphs: IconGlyphs): string {
  if (state.workingSince !== undefined) {
    return `${theme.fg("accent", glyphs.working)} ${theme.fg("dim", "working")} ${theme.fg("accent", formatDuration(Date.now() - state.workingSince))}`;
  }
  if (state.lastDoneIn !== undefined) {
    return `${theme.fg("success", glyphs.done)} ${theme.fg("success", "done")} ${theme.fg("text", formatDuration(state.lastDoneIn))}`;
  }
  return "";
}

/**
 * The context-usage footer segment: icon, an ascii/nerd bar sized to
 * the remaining width, the percentage, and `tokens/window`. Returns
 * `""` when the window is unknown (empty session) so the caller drops it.
 */
export function renderContextBar(
  theme: Theme,
  ctx: ExtensionContext,
  width: number,
  glyphs: IconGlyphs,
  iconMode: TuiConfig["icons"]["mode"],
): string {
  const contextUsage = ctx.getContextUsage();
  const contextWindow = contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
  const contextTokens = contextUsage?.tokens ?? 0;
  const contextPct = contextUsage?.percent ?? 0;

  // populated instead of collapsing everything left in an empty session.
  if (contextWindow <= 0) return "";

  const pctText = theme.fg(stressColor(contextPct), `${contextPct.toFixed(1)}%`);
  const ctxText = `${theme.fg("text", fmtTokens(contextTokens))}${theme.fg("dim", "/")}${theme.fg("text", fmtTokens(contextWindow))}`;
  const contextIcon = theme.fg(stressColor(contextPct), glyphs.context);
  const reserved =
    visibleWidth(contextIcon) + visibleWidth(pctText) + visibleWidth(ctxText) + 5 + 2;
  const barWidth = Math.max(4, Math.min(12, width - reserved));
  return `${contextIcon} ${renderBar(theme, contextPct, barWidth, resolveIconMode(iconMode) === "ascii")} ${pctText} ${theme.fg("dim", "·")} ${ctxText}`;
}

/**
 * Token/cache/cost stats from the usage totals, each gated by its
 * `footerSegments` flag and joined with dim pipes. The cache-hit % is
 * shown only when the provider reports cache tokens.
 */
export function renderStatsBlock(
  theme: Theme,
  totals: UsageTotals,
  glyphs: IconGlyphs,
  segments: TuiConfig["footerSegments"],
): string {
  const stats: string[] = [];
  if (segments.tokens) {
    stats.push(theme.fg("accent", `${glyphs.input} ${fmtTokens(totals.input)}`));
    stats.push(theme.fg("success", `${glyphs.output} ${fmtTokens(totals.output)}`));
    // tokens — avoids a misleading "0%" on providers without prompt caching.
    const hasCacheTokens = totals.cacheRead > 0 || totals.cacheWrite > 0;
    if (hasCacheTokens && totals.latestCacheHitRate !== undefined) {
      stats.push(
        theme.fg(
          cacheHitColor(totals.latestCacheHitRate),
          `${glyphs.cacheHit} ${totals.latestCacheHitRate.toFixed(1)}%`,
        ),
      );
    }
  }
  if (segments.cost) {
    stats.push(theme.fg("warning", formatCost(glyphs.cost, totals.cost)));
  }

  return stats.join(` ${theme.fg("dim", "|")} `);
}

/**
 * Extension status lines (sorted by key, sanitized, wrapped to `width`),
 * prefixed with the extensions glyph. Returns `[]` when there are no
 * non-empty statuses.
 */
export function renderExtensionStatusLines(
  theme: Theme,
  extensionStatuses: ReadonlyMap<string, string>,
  glyphs: IconGlyphs,
  width: number,
): string[] {
  const statuses = Array.from(extensionStatuses.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, text]) => sanitizeStatus(text))
    .filter((text) => text.length > 0);
  if (statuses.length === 0) return [];

  const separator = ` ${theme.fg("dim", "|")} `;
  const statusText = statuses.map((status) => theme.fg("muted", status)).join(separator);
  const line = `${theme.fg("mdLink", glyphs.extensions)} ${statusText}`;
  return wrapTextWithAnsi(line, width);
}
