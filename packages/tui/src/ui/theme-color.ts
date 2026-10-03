/**
 * Derived theme colors for the house UI.
 *
 * `theme.colors` exposes a concrete `Color` for every theme token, and
 * pi-tui's `mixColors()` does the color math. Use these helpers when a
 * component needs a shade that is not a theme token: a dimmed border, a
 * hovered row, or a blended track. `theme.appearance` (`"dark"` or
 * `"light"`) is available when a caller must choose a direction itself.
 *
 * Convert once and reuse: OKLCH mixes are more expensive than rendering a
 * ready color, so callers should compute a shade outside the render path
 * when it is stable.
 */
import type { Theme, ThemeToken } from "@earendil-works/pi-coding-agent";
import { type Color, mixColors } from "@earendil-works/pi-tui";

/** Mix a theme token toward another theme token by `amount` (0..1) in OKLCH. */
export const mixThemeTokens = (
  theme: Theme,
  from: ThemeToken,
  toward: ThemeToken,
  amount: number,
): Color => mixColors(theme.colors[from], theme.colors[toward], amount, "oklch");

/** A shade of `token` that recedes into the theme surface (`userMessageBg`). */
export const recede = (theme: Theme, token: ThemeToken, amount: number): Color =>
  mixThemeTokens(theme, token, "userMessageBg", amount);

/** A shade of `token` with more contrast against the theme surface (`text`). */
export const emphasize = (theme: Theme, token: ThemeToken, amount: number): Color =>
  mixThemeTokens(theme, token, "text", amount);

/**
 * The theme's target appearance, for callers that must branch themselves.
 * `recede()` and `emphasize()` already follow the palette, because the
 * `userMessageBg` and `text` tokens are appearance-relative.
 */
export const isDark = (theme: Theme): boolean => theme.appearance === "dark";
