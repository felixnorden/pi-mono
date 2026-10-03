import { assert, it } from "@effect/vitest";
import type { Theme, ThemeToken } from "@earendil-works/pi-coding-agent";
import { type Color, mixColors, rgbColor } from "@earendil-works/pi-tui";
import { emphasize, isDark, mixThemeTokens, recede } from "./theme-color.ts";

// Stub theme: only the tokens the helpers read, plus the appearance branch.
const colors = {
  accent: rgbColor(200, 60, 60),
  text: rgbColor(230, 230, 230),
  userMessageBg: rgbColor(30, 30, 30),
} as unknown as Readonly<Record<ThemeToken, Color>>;
const darkTheme = { colors, appearance: "dark" } as unknown as Theme;
const lightTheme = { colors, appearance: "light" } as unknown as Theme;

it("mixThemeTokens mixes the two tokens in OKLCH", () => {
  assert.deepStrictEqual(
    mixThemeTokens(darkTheme, "accent", "text", 0.25),
    mixColors(colors.accent, colors.text, 0.25, "oklch"),
  );
});

it("recede mixes toward the theme surface token", () => {
  assert.deepStrictEqual(
    recede(darkTheme, "accent", 0.5),
    mixColors(colors.accent, colors.userMessageBg, 0.5, "oklch"),
  );
});

it("emphasize mixes toward the theme text token", () => {
  assert.deepStrictEqual(
    emphasize(darkTheme, "accent", 0.5),
    mixColors(colors.accent, colors.text, 0.5, "oklch"),
  );
});

it("isDark reports the theme appearance", () => {
  assert.strictEqual(isDark(darkTheme), true);
  assert.strictEqual(isDark(lightTheme), false);
});
