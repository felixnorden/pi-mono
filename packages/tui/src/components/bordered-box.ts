import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { composeBorderLine, buildBoxFrame } from "../frame/box-frame.ts";
import { padRight, visibleWidth } from "../utils.ts";
import { defineComponent } from "./define-component.ts";

export interface BorderedBoxOptions {
  /**
   * Text embedded in the top border (`╭─── label ─────╮`). May be a plain
   * string (optionally pre-themed) or a thunk that derives the label from
   * the current theme at render time — use the thunk when the label should
   * follow theme changes. When the box is too narrow the label is omitted.
   */
  readonly label?: string | ((theme: Theme) => string);
  /** Border color token. Defaults to "accent". */
  readonly color?: ThemeColor;
  /**
   * Decorative dash run after the label. Defaults to " ─────". Pass a
   * different tail (e.g. a single space for a scroll hint) when the label
   * should not trail with the full dash run.
   */
  readonly labelSuffix?: string;
  /** Background function applied to every rendered line. */
  readonly bg?: (s: string) => string;
  /** Horizontal padding between the rails and the content. Defaults to 1. */
  readonly paddingX?: number;
  /**
   * Disable the width-keyed render cache. Set false when the body carries
   * its own finer-grained caching keyed on mutable state (so the box never
   * serves stale rails at an unchanged width). Defaults to true.
   */
  readonly cache?: boolean;
}

/**
 * Frames a child component in the house rounded border (╭─╮│╰─╯), the same
 * style as the header and editor boxes: colored border with an optional label
 * embedded in the top border, and an optional per-line background.
 *
 * The frame geometry comes from the pure {@link buildBoxFrame} model, which
 * pi-free cores (e.g. the inquiry scene) share so every box in the codebase
 * is laid out identically. Border lines are composed with
 * {@link composeBorderLine} and body lines padded with `padRight`, the same
 * primitives the hand-rolled rails in the editor use.
 *
 * Factory (closure) form: the width cache lives in the factory closure, and
 * the returned component is a plain object of closures (`defineComponent`),
 * so `render`/`invalidate` carry no `this`. pi-tui and the extension bridges
 * may invoke them as methods of a wrapper object (e.g. a `setWidget` bridge
 * returns `{ render: widget.render, invalidate: widget.invalidate }`) without
 * losing the instance — the detached-reference crash class cannot occur.
 */
export const makeBorderedBox = (
  body: Component,
  theme: Theme,
  options: BorderedBoxOptions = {},
): Component => {
  const cacheEnabled = options.cache ?? true;
  let cachedWidth: number | undefined;
  let cachedLines: string[] | undefined;

  const computeLines = (width: number): string[] => {
    const label = typeof options.label === "function" ? options.label(theme) : options.label;
    const frame = buildBoxFrame(width, {
      label,
      labelWidth: label === undefined ? undefined : visibleWidth(label),
      labelSuffix: options.labelSuffix,
      paddingX: options.paddingX ?? 1,
    });
    if (!frame) return [];

    const paint = (s: string) => theme.fg(options.color ?? "accent", s);
    const bg = options.bg ?? ((s: string) => s);
    const pad = frame.padLeft;

    const top = bg(composeBorderLine(frame, "top", paint));
    const bottom = bg(composeBorderLine(frame, "bottom", paint));
    const bodyLines = body.render(frame.contentWidth).map((line) =>
      bg(`${paint(frame.railLeft)}${pad}${padRight(line, frame.contentWidth)}${pad}${paint(frame.railRight)}`),
    );
    return [top, ...bodyLines, bottom];
  };

  return defineComponent({
    render(width: number): string[] {
      if (cacheEnabled && cachedLines !== undefined && cachedWidth === width) {
        return cachedLines;
      }
      const lines = computeLines(width);
      if (cacheEnabled) {
        cachedWidth = width;
        cachedLines = lines;
      }
      return lines;
    },
    invalidate(): void {
      cachedWidth = undefined;
      cachedLines = undefined;
      body.invalidate();
    },
  });
};