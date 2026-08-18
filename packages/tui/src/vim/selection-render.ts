import { visibleWidth } from "@earendil-works/pi-tui";
import type { Range } from "./text-model.ts";

/**
 * Selection highlight renderer: paints the logical {@link Range} onto the
 * editor's rendered content lines. It owns no state of its own — the range
 * is derived from the state machine's `selection` (design boundary).
 *
 * First cut (assumption 6): logical-line mapping. Interior lines are
 * highlighted in full, the first/last lines only over their column span.
 * The cursor marker (an OSC escape) and any SGR codes inside the span are
 * copied verbatim, so the paint wraps visible text without disturbing them.
 */

/** Length of the escape sequence starting at `i`, or 0 when not an escape. */
function escapeLength(line: string, i: number): number {
  const rest = line.slice(i);
  const csi = rest.match(/^\x1b\[[0-9;?]*[A-Za-z]/);
  if (csi) return csi[0].length;
  const osc = rest.match(/^\x1b\][^\x07]*(?:\x07|\x1b\\)/);
  if (osc) return osc[0].length;
  const oscu = rest.match(/^\x1b_[^\x07]*(?:\x07|\x1b\\)/);
  if (oscu) return oscu[0].length;
  return 0;
}

/**
 * Wrap the visible columns `[from, to)` of a rendered line in `paint`,
 * returning the line unchanged when the span is empty or out of bounds.
 * Escape sequences contribute zero visible width and are copied verbatim.
 */
export function paintVisibleSpan(
  line: string,
  from: number,
  to: number,
  paint: (s: string) => string,
): string {
  if (from >= to) return line;
  const n = line.length;
  let visible = 0;
  let startRaw = -1;
  let endRaw = -1;
  let lastVisibleEnd = 0;
  let i = 0;
  while (i < n) {
    const escLen = escapeLength(line, i);
    if (escLen > 0) {
      i += escLen;
      continue;
    }
    const width = visibleWidth(line[i]!);
    if (startRaw < 0 && visible + width > from) startRaw = i;
    visible += width;
    lastVisibleEnd = i + 1;
    if (endRaw < 0 && visible >= to) {
      endRaw = i + 1;
      break;
    }
    i++;
  }
  if (startRaw < 0) return line; // the selection starts beyond this line
  if (endRaw < 0) endRaw = lastVisibleEnd; // the selection runs past the line end
  const head = line.slice(0, startRaw);
  const span = line.slice(startRaw, endRaw);
  const tail = line.slice(endRaw);
  return `${head}${paint(span)}${tail}`;
}

export interface SelectionRenderInput {
  readonly lines: string[];
  readonly selection: Range | undefined;
  /** Theme paint applied to the selected span (e.g. `theme.inverse`). */
  readonly paint: (s: string) => string;
}

export function renderSelection({ lines, selection, paint }: SelectionRenderInput): string[] {
  if (!selection) return lines; // inert with no selection
  const { start, end } = selection;
  return lines.map((line, i) => {
    if (i < start.line || i > end.line) return line; // outside the range
    const from = i === start.line ? start.col : 0;
    const to = i === end.line ? end.col : line.length;
    return paintVisibleSpan(line, from, to, paint);
  });
}
