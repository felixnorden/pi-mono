/**
 * Pure box-frame model for the house rounded border (╭─╮│╰─╯).
 *
 * This module is deliberately free of pi imports (`@earendil-works/*`,
 * `effect`) so pi-free cores — the inquiry scene model in particular — can
 * build the same frame without dragging in a terminal runtime. `BorderedBox`
 * is the themed component wrapper around it: it paints the segments with the
 * Theme, applies an optional per-line background, and caches.
 */

export interface BoxFrameOptions {
  /**
   * Text embedded in the top border (`╭─── label ─────╮`). May be pre-themed
   * (ANSI); pass `labelWidth` so the fill accounts for it. Omitted when the
   * box is too narrow to fit `─── label ─────` without overflowing.
   */
  readonly label?: string;
  /**
   * Visible width of the label in terminal columns. Measured by the caller
   * (ANSI-aware renderers pass their own width function; pi-free cores pass
   * theirs). Defaults to the code-point length of the SGR-stripped label.
   */
  readonly labelWidth?: number;
  /** Horizontal padding between the rails and the content. Defaults to 1. */
  readonly paddingX?: number;
  /** Width below which the label is never attempted. Defaults to 8. */
  readonly minLabelWidth?: number;
  /**
   * Decorative dash run after the label (` ─────`). Overridable so callers
   * with a different tail (e.g. a scroll-hint that trails with a single
   * space) can reuse the same layout arithmetic. Defaults to " ─────".
   */
  readonly labelSuffix?: string;
}

/** One border line split into the three segments a renderer styles together. */
export interface BoxBorderLine {
  readonly left: string;
  readonly fill: string;
  readonly right: string;
}

/** Top border, additionally carrying the label and its decorative dashes. */
export interface BoxTopBorder extends BoxBorderLine {
  /** The embedded label text (as passed); null when absent or too narrow. */
  readonly label: string | null;
  /** The `─── ` run before the label; null when the label is omitted. */
  readonly labelPrefix: string | null;
  /** The ` ─────` run after the label; null when the label is omitted. */
  readonly labelSuffix: string | null;
}

/**
 * The computed frame: ready-to-compose segments plus the geometry a body
 * needs (content width and per-side rails/padding). All strings are raw
 * border characters — no ANSI, no styling.
 */
export interface BoxFrame {
  readonly top: BoxTopBorder;
  readonly bottom: BoxBorderLine;
  readonly railLeft: string;
  readonly railRight: string;
  readonly padLeft: string;
  readonly padRight: string;
  readonly contentWidth: number;
}

const LABEL_PREFIX = "─── ";
const LABEL_SUFFIX = " ─────";

/**
 * Build the frame segments for a box of the given width, or null when the
 * width is too small to hold a border at all (≤ 2 columns).
 */
export const buildBoxFrame = (width: number, options: BoxFrameOptions = {}): BoxFrame | null => {
  if (width <= 2) return null;
  const paddingX = options.paddingX ?? 1;
  const contentWidth = Math.max(1, width - 2 - paddingX * 2);
  const pad = " ".repeat(Math.max(0, paddingX));
  const fill = "─".repeat(width - 2);
  const plain: BoxTopBorder = {
    left: "╭",
    fill,
    right: "╮",
    label: null,
    labelPrefix: null,
    labelSuffix: null,
  };
  const bottom: BoxBorderLine = { left: "╰", fill, right: "╯" };
  const base = {
    bottom,
    railLeft: "│",
    railRight: "│",
    padLeft: pad,
    padRight: pad,
    contentWidth,
  };

  const label = options.label;
  const minLabelWidth = options.minLabelWidth ?? 8;
  if (label === undefined || width < minLabelWidth) {
    return { top: plain, ...base };
  }
  const labelWidth = options.labelWidth ?? sgrFreeCodePointLength(stripSgr(label));
  const labelSuffix = options.labelSuffix ?? LABEL_SUFFIX;
  // Fixed chrome: corners + the decorative dash runs around the label.
  const fixed = LABEL_PREFIX.length + labelWidth + labelSuffix.length;
  if (fixed > width - 2) {
    // The label would overflow the top border; render a plain frame instead.
    return { top: plain, ...base };
  }
  return {
    top: {
      left: "╭",
      fill: "─".repeat(width - 2 - fixed),
      right: "╮",
      label,
      labelPrefix: LABEL_PREFIX,
      labelSuffix,
    },
    ...base,
  };
};

/**
 * Compose one finished border line from a frame, applying `paint` to the
 * chrome (corners, decorative dash runs, fill) and passing the embedded
 * label through raw. Themed wrappers use this to keep the label un-painted
 * (they pre-style it); pi-free renderers can inject their own text styling
 * or pass the identity function.
 */
export const composeBorderLine = (
  frame: BoxFrame,
  kind: "top" | "bottom",
  paint: (text: string) => string = (text) => text,
): string => {
  if (kind === "bottom") {
    return paint(frame.bottom.left) + paint(frame.bottom.fill) + paint(frame.bottom.right);
  }
  const top = frame.top;
  return (
    paint(top.left) +
    paint(top.labelPrefix ?? "") +
    (top.label ?? "") +
    paint(top.labelSuffix ?? "") +
    paint(top.fill) +
    paint(top.right)
  );
};

/** Strip SGR (color/style) escape sequences only — cosmetic, not styling. */
const stripSgr = (text: string): string =>
  text.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g"), "");

/**
 * Fallback label measurement: code points of the SGR-stripped text. Accurate
 * for ASCII and most labels; callers with wide/emoji or tab-heavy labels pass
 * `labelWidth` explicitly.
 */
const sgrFreeCodePointLength = (text: string): number => Array.from(text).length;
