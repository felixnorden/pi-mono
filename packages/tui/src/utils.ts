import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-ai";
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { Effect, Random } from "effect";

export { truncateToWidth, visibleWidth };

/**
 * Strip ANSI escape sequences (SGR color/style, OSC, and underscore-OSC
 * variants) from a themed string. Used for plain-text comparisons and for
 * measuring content without styling noise.
 */
export function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\[[0-9;]*m/g, "")
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b_[^\x07]*\x07/g, "");
}

/**
 * Collapse a working directory inside the user's home to a `~`-relative
 * path (`/Users/x/dev` -> `~/dev`, the home itself -> `~`). Paths outside
 * the home (or with no home resolvable) render literally.
 */
export function formatCwd(cwd: string): string {
  const home = process.env.HOME || process.env.USERPROFILE;
  if (!home) return cwd;
  const resolvedCwd = resolve(cwd);
  const resolvedHome = resolve(home);
  const rel = relative(resolvedHome, resolvedCwd);
  const insideHome =
    rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
  if (!insideHome) return cwd;
  return rel === "" ? "~" : `~${sep}${rel}`;
}

/**
 * Truncate a path to `maxLen` visible columns while keeping the first
 * segment (e.g. `~`) and as many trailing segments as fit, joined by
 * `...` — e.g. `~/dev/.../packages/tui`.
 */
export function truncatePath(path: string, maxLen: number): string {
  if (path.length <= maxLen) return path;
  if (maxLen <= 3) return "...".slice(0, maxLen);
  const sepChar = path.includes("/") ? "/" : "\\";
  const parts = path.split(/[\\/]/);
  if (parts.length <= 2) return path.slice(0, maxLen - 3) + "...";
  // Keep first segment (e.g. ~) and as many trailing segments as fit.
  const tail: string[] = [];
  let tailLen = 0;
  for (let i = parts.length - 1; i >= 1; i--) {
    const seg = parts[i]!;
    if (tailLen + seg.length + 4 > maxLen) break;
    tail.unshift(seg);
    tailLen += seg.length + 1;
  }
  const head = parts[0]!;
  const result = `${head}${sepChar}...${sepChar}${tail.join(sepChar)}`;
  return result.length > maxLen ? result.slice(0, maxLen - 3) + "..." : result;
}

/**
 * Compact token-count formatting: plain digits below 1k, one decimal in
 * the 1k–10k band, whole `k` below 1M, then `M` (one decimal below 10M).
 */
export function fmtTokens(n: number): string {
  if (n < 1000) return n.toString();
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  if (n < 10_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  return `${Math.round(n / 1_000_000)}M`;
}

/**
 * Cost display: the ascii cost glyph already is a `$`, so the currency
 * sign is appended only when the glyph does not carry it (nerd glyphs).
 */
export function formatCost(glyph: string, value: number, digits = 3): string {
  const currency = glyph.includes("$") ? "" : "$";
  return `${glyph} ${currency}${value.toFixed(digits)}`;
}

/**
 * Human duration formatting from milliseconds: `42s`, `5m 12s`, `2h 3m 4s`.
 * Negative inputs clamp to zero.
 */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const s = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m ${s}s`;
  const m = totalMinutes % 60;
  const h = Math.floor(totalMinutes / 60);
  return `${h}h ${m}m ${s}s`;
}

/**
 * The `provider/model` label shown in the header and footer, or
 * `no-model` when no model is selected.
 */
export function formatModelLabel(
  model: { provider?: string; id?: string } | null | undefined,
): string {
  if (!model?.id) return "no-model";
  return model.provider ? `${model.provider}/${model.id}` : model.id;
}

/**
 * Capitalized provider display label; `Unknown` when absent.
 */
export function formatProviderLabel(provider: string | undefined): string {
  if (!provider) return "Unknown";
  return provider.charAt(0).toUpperCase() + provider.slice(1);
}

/**
 * Compose a single line from a left block and a right block: the right
 * block is right-aligned (truncated with ellipsis when it alone exceeds
 * `width`), and the left block fills the remainder — truncated if it
 * does not fit — separated by one space.
 */
export function alignRight(left: string, right: string, width: number, theme: Theme): string {
  const rightW = visibleWidth(right);
  if (rightW > width) {
    right = truncateToWidth(right, width, theme.fg("dim", "..."));
  }
  const leftW = visibleWidth(left);
  const rightW2 = visibleWidth(right);
  const pad = width - leftW - rightW2;
  if (pad >= 1) {
    return left + " ".repeat(pad) + right;
  }
  const availableForLeft = Math.max(0, width - rightW2 - 1);
  const truncatedLeft =
    availableForLeft > 0 ? truncateToWidth(left, availableForLeft, theme.fg("dim", "...")) : "";
  return truncatedLeft ? truncatedLeft + " " + right : right;
}

/** A text segment with a survival priority; higher survives longer. */
export type PrioritizedSegment = {
  text: string;
  priority: number;
};

/**
 * Pack segments into maxWidth, shrinking/dropping lowest-priority segments first.
 * Higher priority = survives longer. Returns the surviving segment texts in
 * original order, space-joined. Each segment is either kept whole, truncated
 * with ellipsis, or dropped entirely.
 */
export function fitSegmentsByPriority(
  segs: readonly PrioritizedSegment[],
  maxW: number,
  ellipsis = "...",
): string[] {
  const items = segs.map((s) => ({ text: s.text, priority: s.priority, w: visibleWidth(s.text) }));
  const totalW = () => {
    const active = items.filter((it) => it.text !== "");
    return active.reduce((a, it) => a + it.w, 0) + Math.max(0, active.length - 1);
  };
  while (totalW() > maxW) {
    let target = -1;
    for (let i = 0; i < items.length; i++) {
      if (
        items[i]?.text !== "" &&
        (target === -1 || (items[i]?.priority ?? -1) < (items[target]?.priority ?? -1))
      ) {
        target = i;
      }
    }
    if (target === -1) break;
    const item = items[target];
    if (!item) break;

    const others = items.filter((_, i) => i !== target && items[i]?.text !== "");
    const otherW = others.reduce((a, it) => a + it.w, 0) + Math.max(0, others.length - 1);
    const avail = maxW - otherW - (others.length > 0 ? 1 : 0);
    if (avail <= visibleWidth(ellipsis)) {
      item.text = "";
      item.w = 0;
    } else if (avail < item.w) {
      item.text = truncateToWidth(item.text, avail, ellipsis);
      item.w = visibleWidth(item.text);
    } else {
      break;
    }
  }
  return items.filter((it) => it.text !== "").map((it) => it.text);
}

/**
 * Color token for a utilization percentage (accent under `warn`, warning
 * up to `danger`, error from there).
 */
export function stressColor(value: number, warn = 70, danger = 90): ThemeColor {
  if (value >= danger) return "error";
  if (value >= warn) return "warning";
  return "accent";
}

/**
 * Color token for a cache-hit rate: error below 30%, warning below 70%,
 * success from there.
 */
export function cacheHitColor(value: number): ThemeColor {
  if (value < 30) return "error";
  if (value < 70) return "warning";
  return "success";
}

/**
 * Color token for a provider name (identity styling); `muted` for
 * unlisted providers.
 */
export function providerColor(provider: string): ThemeColor {
  switch (provider.toLowerCase()) {
    case "anthropic":
      return "accent";
    case "openai":
    case "openai-codex":
      return "success";
    case "google":
    case "google-vertex":
      return "warning";
    case "opencode":
    case "opencode-go":
      return "success";
    case "amazon-bedrock":
      return "thinkingHigh";
    case "github-copilot":
      return "mdLink";
    case "deepseek":
      return "thinkingLow";
    case "xai":
    case "groq":
      return "error";
    default:
      return "muted";
  }
}

/**
 * Color token for a thinking-effort label; unknown levels fall back to
 * `thinkingMedium`.
 */
export function effortColor(level: ThinkingLevel | string | undefined): ThemeColor {
  switch (level) {
    case "minimal":
      return "thinkingMinimal";
    case "low":
      return "thinkingLow";
    case "medium":
      return "thinkingMedium";
    case "high":
      return "thinkingHigh";
    case "xhigh":
      return "thinkingXhigh";
    default:
      return "thinkingMedium";
  }
}

/**
 * True when a line is one of the editor's border rows: a pure dash run, or
 * a dash-framed `↑ n more`/`↓ n more` collapsed-messages hint.
 */
export function isEditorBorderLine(line: string): boolean {
  const plain = stripAnsi(line);
  if (/^─+$/.test(plain)) return true;
  if (/^─*\s*[↑↓]\s+\d+\s+more\s*─*$/.test(plain)) return true;
  return false;
}

/**
 * Index of the editor's bottom border (last border row); falls back to
 * the last line when none is found.
 */
export function findBottomBorderIndex(lines: string[]): number {
  for (let i = lines.length - 1; i >= 1; i--) {
    if (isEditorBorderLine(lines[i]!)) return i;
  }
  return Math.max(0, lines.length - 1);
}

/**
 * Pad `text` to `width` columns, truncating with `ellipsis` when it
 * overflows. The returned string is exactly `width` terminal columns wide.
 */
export function padRight(text: string, width: number, ellipsis = ""): string {
  const clipped = truncateToWidth(text, width, ellipsis);
  return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

/**
 * Center `text` within `width` columns (left-biased on odd padding),
 * truncating with `...` when the text is wider than the width.
 */
export function center(text: string, width: number): string {
  if (width <= 0) return "";
  const w = visibleWidth(text);
  if (w >= width) return truncateToWidth(text, width, "...");
  return `${" ".repeat(Math.floor((width - w) / 2))}${text}`;
}

/**
 * Normalize an extension status text for footer display: strip ANSI and
 * control characters, collapse whitespace runs, trim.
 */
export function sanitizeStatus(text: string): string {
  return stripAnsi(text)
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/ +/g, " ")
    .trim();
}

/**
 * Human label for a thinking level: `thinking off` for "off", otherwise
 * `<level> effort`.
 */
export function formatThinkingLabel(level: string): string {
  if (level === "off") return "thinking off";
  return `${level} effort`;
}

/**
 * Slash-command names pi ships built-in (without a leading `/`). Merged
 * with the session-command names to form the header tips pool.
 */
export const PI_BUILTIN_SLASH_COMMAND_NAMES = [
  "settings",
  "model",
  "scoped-models",
  "export",
  "import",
  "share",
  "copy",
  "name",
  "session",
  "changelog",
  "hotkeys",
  "fork",
  "clone",
  "tree",
  "trust",
  "login",
  "logout",
  "new",
  "compact",
  "resume",
  "reload",
  "quit",
] as const;

/**
 * The full slash-command name pool: pi's builtin names plus any session
 * commands (deduplicated, no leading `/`).
 */
export function collectPiCommandNames(sessionCommands: readonly { name: string }[]): string[] {
  const names = new Set<string>(PI_BUILTIN_SLASH_COMMAND_NAMES);
  for (const command of sessionCommands) {
    if (command.name) names.add(command.name);
  }
  return [...names];
}

/**
 * Select the header's slash-command tips: the fixed commands (always
 * first) followed by `count` commands shuffled from the remaining pool
 * (Fisher–Yates) using Effect's Random service. The shuffle draws from
 * the ambient seed, so runners must wrap the program in
 * `Random.withSeed(seed)` for deterministic output.
 */
export const pickSlashCommandTips = Effect.fn("tui/utils/pickSlashCommandTips")(function* (
  availableNames: readonly string[],
  options: {
    fixed?: readonly string[];
    count?: number;
    exclude?: readonly string[];
  } = {},
) {
  const fixed = [...(options.fixed ?? [])];
  const count = options.count ?? 3;
  const exclude = new Set<string>([...(options.exclude ?? []), ...fixed]);

  const pool = [...new Set(availableNames.map((n) => n.trim()).filter(Boolean))].filter(
    (name) => !exclude.has(name),
  );

  for (let i = pool.length - 1; i > 0; i--) {
    const j = yield* Random.nextIntBetween(0, i);
    const [pi, pj] = [String(pool[i]), String(pool[j])];
    pool[j] = pi;
    pool[i] = pj;
  }

  const picked = pool.slice(0, Math.max(0, count));
  return [...fixed, ...picked].map((name) => (name.startsWith("/") ? name : `/${name}`));
});

/** Minimum left-column width for the two-column header body. */
export const MIN_LEFT_WIDTH = 28;
/** Minimum tips-column width before the tips are dropped. */
export const MIN_TIPS_WIDTH = 16;
/** Maximum tips-column width; excess goes to the left column. */
export const MAX_TIPS_WIDTH = 28;
const COLUMN_GAP = 3;

/**
 * Split an inner (rail-to-rail) width into left/tips columns for the
 * header body. Returns `useTips: false` with a single full-width left
 * column when the width cannot hold both columns at their minimums.
 */
export function headerColumnWidths(
  innerWidth: number,
  minTipsWidth = MIN_TIPS_WIDTH,
  maxTipsWidth = MAX_TIPS_WIDTH,
  minLeftWidth = MIN_LEFT_WIDTH,
): { leftWidth: number; rightWidth: number; useTips: boolean } {
  if (innerWidth <= 0) {
    return { leftWidth: 0, rightWidth: 0, useTips: false };
  }

  const gap = COLUMN_GAP;
  if (innerWidth < minLeftWidth + gap + minTipsWidth) {
    return { leftWidth: innerWidth, rightWidth: 0, useTips: false };
  }

  let rightWidth = Math.min(maxTipsWidth, Math.max(minTipsWidth, Math.round(innerWidth * 0.28)));
  let leftWidth = innerWidth - gap - rightWidth;

  if (leftWidth < minLeftWidth) {
    leftWidth = minLeftWidth;
    rightWidth = innerWidth - gap - leftWidth;
  }

  if (leftWidth <= rightWidth) {
    leftWidth = Math.ceil((innerWidth - gap) * 0.65);
    rightWidth = innerWidth - gap - leftWidth;
  }

  if (rightWidth < minTipsWidth || leftWidth < minLeftWidth) {
    return { leftWidth: innerWidth, rightWidth: 0, useTips: false };
  }

  return { leftWidth, rightWidth, useTips: true };
}
