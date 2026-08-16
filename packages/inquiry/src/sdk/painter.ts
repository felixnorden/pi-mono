/**
 * Paint core scenes to ANSI lines using the pi theme.
 *
 * The only place the core's style palette becomes terminal colors. The core
 * scene model guarantees lines are already wrapped; this module applies the
 * theme and emits ready-to-render strings.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Scene, Span } from "../core/scene.ts";

export const paintScene = (scene: Scene, theme: Theme): string[] => {
  const lines: string[] = [];
  for (const sceneLine of scene.lines) {
    let out = "";
    for (const span of sceneLine) {
      out += paintSpan(span, theme);
    }
    lines.push(out);
  }
  return lines;
};

const paintSpan = (span: Span, theme: Theme): string => {
  if (span.style === "cursor") {
    const inner = span.bold ? theme.bold(span.text) : span.text;
    return theme.inverse(inner);
  }
  let text = span.text;
  if (span.bold) text = theme.bold(text);
  if (span.style) return theme.fg(span.style, text);
  return text;
};
