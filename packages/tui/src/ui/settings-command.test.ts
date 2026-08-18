import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG, type TuiConfig } from "../config.ts";
import { VimRouter } from "../vim/vim-router.ts";
import { makeSettingsUi, type SettingsUiHandle } from "./settings-command.ts";

// Pass-through theme: selections and the active tab are detected via
// plain-text markers ("→ " prefix, "[Tab]" brackets) in the render output.
const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

const RENDER_WIDTH = 120;

// The settings UI injects an always-true gate for its own router instance
// (per-consumer gate injection), so its h/j/k/l stay unconditional regardless
// of the vim toggle.
const settingsRouter = Effect.runSync(
  Effect.service(VimRouter).pipe(Effect.provide(VimRouter.make(() => true))),
);

interface UiSpy {
  ui: SettingsUiHandle;
  changes: TuiConfig[];
  closes: number;
}

const makeUi = (overrides: Partial<TuiConfig> = {}): UiSpy => {
  const spy: UiSpy = { ui: undefined!, changes: [], closes: 0 };
  spy.ui = makeSettingsUi(
    theme,
    { ...structuredClone(DEFAULT_CONFIG), ...overrides },
    (config) => {
      spy.changes.push(config);
    },
    () => {
      spy.closes += 1;
    },
    settingsRouter,
  );
  return spy;
};

const rendered = (ui: SettingsUiHandle): string[] => ui.render(RENDER_WIDTH);

const selectedShows = (ui: SettingsUiHandle, label: string): boolean =>
  rendered(ui).some((line) => line.includes(`→ ${label}`));

const activeTab = (ui: SettingsUiHandle): string | undefined => {
  const line = rendered(ui).find((l) => l.includes("["));
  if (!line) return undefined;
  for (const tab of ["General", "Icons", "Footer", "Telemetry"] as const) {
    if (line.includes(`[${tab}]`)) return tab;
  }
  return undefined;
};

// ---------------------------------------------------------------------------
// Vim navigation: j/k move the list selection
// ---------------------------------------------------------------------------

it("starts with the first item of the features tab selected", () => {
  const { ui } = makeUi();
  assert.strictEqual(activeTab(ui), "General");
  assert.strictEqual(selectedShows(ui, "Enabled"), true);
  assert.strictEqual(selectedShows(ui, "Language"), false);
});

it("renders the Vim mode item on the features tab showing Off by default", () => {
  const { ui } = makeUi();
  const lines = rendered(ui);
  assert.strictEqual(lines.some((line) => line.includes("Vim mode") && line.includes("Off")), true);
});

it("Space toggles vim on and reports the change", () => {
  const { ui, changes } = makeUi();
  ui.handleInput("j"); // move from Enabled to Vim mode
  ui.handleInput(" ");
  assert.strictEqual(changes.length, 1);
  assert.strictEqual(changes[0]!.vim, true);
  assert.strictEqual(changes[0]!.enabled, true); // other fields untouched
  assert.strictEqual(rendered(ui).some((line) => line.includes("Vim mode") && line.includes("On")), true);
});

it("j moves the selection down and wraps to the first item at the end", () => {
  const { ui } = makeUi();
  ui.handleInput("j");
  assert.strictEqual(selectedShows(ui, "Vim mode"), true);
  ui.handleInput("j");
  assert.strictEqual(selectedShows(ui, "Language"), true);
  ui.handleInput("j");
  assert.strictEqual(selectedShows(ui, "Enabled"), true);
});

it("k moves the selection up and wraps to the last item at the top", () => {
  const { ui } = makeUi();
  ui.handleInput("k");
  assert.strictEqual(selectedShows(ui, "Language"), true);
  ui.handleInput("k");
  assert.strictEqual(selectedShows(ui, "Vim mode"), true);
  ui.handleInput("k");
  assert.strictEqual(selectedShows(ui, "Enabled"), true);
});

it("j moves the selection when vim is on too", () => {
  const { ui } = makeUi({ vim: true });
  ui.handleInput("j");
  assert.strictEqual(selectedShows(ui, "Vim mode"), true);
  ui.handleInput("j");
  assert.strictEqual(selectedShows(ui, "Language"), true);
});

it("h switches tabs with vim off (settings gate is unconditional)", () => {
  const { ui } = makeUi({ vim: false });
  ui.handleInput("h");
  assert.strictEqual(activeTab(ui), "Telemetry");
});

it("j moves the selection with vim off (settings gate is unconditional)", () => {
  const { ui } = makeUi({ vim: false });
  ui.handleInput("j");
  assert.strictEqual(selectedShows(ui, "Vim mode"), true);
});

// ---------------------------------------------------------------------------
// Vim navigation: h/l switch tabs
// ---------------------------------------------------------------------------

it("l switches to the next tab and wraps from the last tab to the first", () => {
  const { ui } = makeUi();
  ui.handleInput("l");
  assert.strictEqual(activeTab(ui), "Icons");
  ui.handleInput("l");
  assert.strictEqual(activeTab(ui), "Footer");
  ui.handleInput("l");
  assert.strictEqual(activeTab(ui), "Telemetry");
  ui.handleInput("l");
  assert.strictEqual(activeTab(ui), "General");
});

it("h switches to the previous tab and wraps from the first tab to the last", () => {
  const { ui } = makeUi();
  ui.handleInput("h");
  assert.strictEqual(activeTab(ui), "Telemetry");
  ui.handleInput("h");
  assert.strictEqual(activeTab(ui), "Footer");
  ui.handleInput("h");
  assert.strictEqual(activeTab(ui), "Icons");
  ui.handleInput("h");
  assert.strictEqual(activeTab(ui), "General");
});

it("remembers the selected item per tab when navigating with h/l", () => {
  const { ui } = makeUi();
  ui.handleInput("j"); // features: Vim mode
  ui.handleInput("j"); // features: Language
  ui.handleInput("l"); // → Icons
  ui.handleInput("h"); // → back to features
  assert.strictEqual(selectedShows(ui, "Language"), true);
});

// ---------------------------------------------------------------------------
// Regression: arrow keys, Tab, Enter, and q still behave as before
// ---------------------------------------------------------------------------

it("the arrow keys still move the selection", () => {
  const { ui } = makeUi();
  ui.handleInput("\x1b[B"); // down
  assert.strictEqual(selectedShows(ui, "Vim mode"), true);
  ui.handleInput("\x1b[A"); // up
  assert.strictEqual(selectedShows(ui, "Enabled"), true);
});

it("Tab and Shift+Tab still switch tabs", () => {
  const { ui } = makeUi();
  ui.handleInput("\t");
  assert.strictEqual(activeTab(ui), "Icons");
  ui.handleInput("\x1b[Z");
  assert.strictEqual(activeTab(ui), "General");
});

it("j and k work on tabs with more items than fit the visible list", () => {
  const { ui } = makeUi();
  ui.handleInput("l");
  ui.handleInput("l"); // → Footer (9 items)
  ui.handleInput("k"); // wrap to the bottom of the segments list
  assert.strictEqual(selectedShows(ui, "Extension status line"), true);
  ui.handleInput("j"); // wrap to the top
  assert.strictEqual(selectedShows(ui, "CWD"), true);
});

it("q and Escape close the settings UI", () => {
  const spy = makeUi();
  spy.ui.handleInput("q");
  assert.strictEqual(spy.closes, 1);
  spy.ui.handleInput("\x1b");
  assert.strictEqual(spy.closes, 2);
});

it("Space still toggles the selected setting", () => {
  const { ui, changes, closes } = makeUi();
  ui.handleInput(" ");
  assert.strictEqual(changes.length, 1);
  assert.strictEqual(changes[0]!.enabled, false);
  assert.strictEqual(closes, 0);
});

it("unrelated letters are ignored", () => {
  const { ui, changes, closes } = makeUi();
  ui.handleInput("x");
  ui.handleInput("z");
  assert.strictEqual(changes.length, 0);
  assert.strictEqual(closes, 0);
  assert.strictEqual(selectedShows(ui, "Enabled"), true);
});
