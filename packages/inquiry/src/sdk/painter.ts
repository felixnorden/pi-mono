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
  // One `theme.style()` call per span: fg (or the cursor's inverse) and bold
  // combine into a single SGR wrapper instead of nested fg(bold(text)).
  if (span.style === "cursor") {
    return theme.style(span.text, { inverse: true, bold: span.bold });
  }
  if (span.style !== undefined) {
    return theme.style(span.text, { fg: span.style, bold: span.bold });
  }
  return span.bold ? theme.bold(span.text) : span.text;
};
