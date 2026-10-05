import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG, type TuiConfig } from "../config.ts";
import { VimRouter } from "../vim/vim-router.ts";
import {
  hasTrackerExtension,
  loadClassifierChoices,
  makeSettingsUi,
  type ClassifierChoice,
  type ClassifierDescriptor,
  type ClassifierSource,
  type SettingsUiHandle,
} from "./settings-command.ts";

// Pass-through theme: selections and the active tab are detected via
// plain-text markers ("→ " prefix, "[Tab]" brackets) in the render output.
const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  style: (text: string) => text,
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

const defaultChoices: ClassifierChoice[] = [
  { value: null, label: "Automatic (prefer Clef Flash, then Jev)" },
  { value: "typesafe/jev-latest", label: "Safe" },
  { value: "cloudflare-workers-ai/@cf/cloudflare/clef-flash", label: "Fast" },
];

const makeUi = (
  overrides: Partial<TuiConfig> = {},
  choices: readonly ClassifierChoice[] = defaultChoices,
  hasTracker = true,
): UiSpy => {
  const spy: UiSpy = { ui: undefined!, changes: [], closes: 0 };
  spy.ui = makeSettingsUi(
    theme,
    { ...structuredClone(DEFAULT_CONFIG), ...overrides },
    choices,
    hasTracker,
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
  for (const tab of ["General", "Compaction", "Icons", "Footer", "Telemetry"] as const) {
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
  assert.strictEqual(
    lines.some((line) => line.includes("Vim mode") && line.includes("Off")),
    true,
  );
});

it("Space toggles vim on and reports the change", () => {
  const { ui, changes } = makeUi();
  ui.handleInput("j"); // move from Enabled to Vim mode
  ui.handleInput(" ");
  assert.strictEqual(changes.length, 1);
  assert.strictEqual(changes[0]!.vim, true);
  assert.strictEqual(changes[0]!.enabled, true); // other fields untouched
  assert.strictEqual(
    rendered(ui).some((line) => line.includes("Vim mode") && line.includes("On")),
    true,
  );
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
  assert.strictEqual(activeTab(ui), "Compaction");
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
  assert.strictEqual(activeTab(ui), "Compaction");
  ui.handleInput("h");
  assert.strictEqual(activeTab(ui), "General");
});

it("remembers the selected item per tab when navigating with h/l", () => {
  const { ui } = makeUi();
  ui.handleInput("j"); // features: Vim mode
  ui.handleInput("j"); // features: Language
  ui.handleInput("l"); // → Compaction
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
  assert.strictEqual(activeTab(ui), "Compaction");
  ui.handleInput("\x1b[Z");
  assert.strictEqual(activeTab(ui), "General");
});

it("j and k work on tabs with more items than fit the visible list", () => {
  const { ui } = makeUi();
  ui.handleInput("l");
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

// ---------------------------------------------------------------------------
// Compaction tab: gated on the tracker extension, five rows
// ---------------------------------------------------------------------------

/** Switch from the General tab to the Compaction tab. */
const goToCompaction = (ui: SettingsUiHandle): void => {
  ui.handleInput("\t");
};

type CompactionRow = "toggle" | "classifier" | "probability" | "answerConfidence" | "cap";
const ROW_OFFSET: Record<CompactionRow, number> = {
  toggle: 0,
  classifier: 1,
  probability: 2,
  answerConfidence: 3,
  cap: 4,
};

/** Switch to the Compaction tab and move to the named row. */
const selectCompactionRow = (ui: SettingsUiHandle, row: CompactionRow): void => {
  goToCompaction(ui);
  for (let step = 0; step < ROW_OFFSET[row]; step += 1) ui.handleInput("j");
};

it("the Compaction tab is hidden when the tracker extension is not loaded", () => {
  const { ui } = makeUi({}, defaultChoices, false);
  assert.strictEqual(activeTab(ui), "General");
  ui.handleInput("l");
  assert.strictEqual(activeTab(ui), "Icons");
  assert.strictEqual(
    rendered(ui).some((line) => line.includes("Smart compaction")),
    false,
  );
});

it("the Compaction tab shows the toggle, classifier, two probability knobs, and cap", () => {
  const { ui } = makeUi();
  goToCompaction(ui);
  const lines = rendered(ui);
  for (const label of [
    "Smart compaction",
    "Compaction classifier",
    "Needs-context probability",
    "Answer confidence floor",
    "Max candidates",
  ]) {
    assert.strictEqual(lines.some((line) => line.includes(label)), true);
  }
});

it("pressing enter toggles smart compaction On -> Off -> On", () => {
  const { ui, changes } = makeUi();
  selectCompactionRow(ui, "toggle");
  assert.strictEqual(selectedShows(ui, "Smart compaction"), true);

  ui.handleInput("\r");
  assert.strictEqual(changes.at(-1)?.smartCompaction.enabled, false);
  ui.handleInput("\r");
  assert.strictEqual(changes.at(-1)?.smartCompaction.enabled, true);
  assert.deepStrictEqual(
    changes.map((config) => config.smartCompaction.enabled),
    [false, true],
  );
});

it("cycling the classifier row advances to the next enumerated choice", () => {
  const { ui, changes } = makeUi();
  selectCompactionRow(ui, "classifier");

  ui.handleInput("\r");

  assert.strictEqual(changes.length, 1);
  assert.strictEqual(changes[0]!.smartCompaction.classifier, "typesafe/jev-latest");
});

it("cycling past the last classifier choice returns to Automatic", () => {
  const { ui, changes } = makeUi({
    smartCompaction: {
      ...DEFAULT_CONFIG.smartCompaction,
      classifier: "cloudflare-workers-ai/@cf/cloudflare/clef-flash",
    },
  });
  selectCompactionRow(ui, "classifier");

  ui.handleInput("\r");

  assert.strictEqual(changes.at(-1)?.smartCompaction.classifier, null);
});

it("the classifier row shows the label of the chosen model", () => {
  const { ui } = makeUi({
    smartCompaction: { ...DEFAULT_CONFIG.smartCompaction, classifier: "typesafe/jev-latest" },
  });
  selectCompactionRow(ui, "classifier");
  const lines = rendered(ui);
  assert.strictEqual(
    lines.some((line) => line.includes("Compaction classifier") && line.includes("Safe")),
    true,
  );
});

it("the Compaction tab adds exactly the five smart-compaction rows", () => {
  const { ui } = makeUi();
  selectCompactionRow(ui, "cap");
  assert.strictEqual(selectedShows(ui, "Max candidates"), true);
  ui.handleInput("j"); // wraps to the first item, proving no extra row follows
  assert.strictEqual(selectedShows(ui, "Smart compaction"), true);
});

it("the needs-context probability row shows the current value with two decimals", () => {
  const { ui } = makeUi({
    smartCompaction: { ...DEFAULT_CONFIG.smartCompaction, needsContextProbabilityThreshold: 0.7 },
  });
  goToCompaction(ui);
  assert.strictEqual(
    rendered(ui).some((line) => line.includes("Needs-context probability") && line.includes("0.70")),
    true,
  );
});

it("Enter on the needs-context probability row steps the value up by 0.05", () => {
  const { ui, changes } = makeUi();
  selectCompactionRow(ui, "probability");
  assert.strictEqual(selectedShows(ui, "Needs-context probability"), true);

  ui.handleInput("\r");

  assert.strictEqual(changes.length, 1);
  assert.strictEqual(changes[0]!.smartCompaction.needsContextProbabilityThreshold, 0.55);
});

it("the +/- keys adjust the needs-context probability row and clamp inside the open interval", () => {
  const { ui, changes } = makeUi({
    smartCompaction: { ...DEFAULT_CONFIG.smartCompaction, needsContextProbabilityThreshold: 0.95 },
  });
  selectCompactionRow(ui, "probability");

  ui.handleInput("+");
  assert.strictEqual(changes.at(-1)?.smartCompaction.needsContextProbabilityThreshold, 0.95);
  ui.handleInput("-");
  assert.strictEqual(changes.at(-1)?.smartCompaction.needsContextProbabilityThreshold, 0.9);
});

it("the answer confidence floor row shows the current value with two decimals", () => {
  const { ui } = makeUi({
    smartCompaction: { ...DEFAULT_CONFIG.smartCompaction, minAnswerConfidence: 0.7 },
  });
  goToCompaction(ui);
  assert.strictEqual(
    rendered(ui).some((line) => line.includes("Answer confidence floor") && line.includes("0.70")),
    true,
  );
});

it("Enter on the answer confidence floor row steps the value up by 0.05", () => {
  const { ui, changes } = makeUi();
  selectCompactionRow(ui, "answerConfidence");
  assert.strictEqual(selectedShows(ui, "Answer confidence floor"), true);

  ui.handleInput("\r");

  assert.strictEqual(changes.length, 1);
  assert.strictEqual(changes[0]!.smartCompaction.minAnswerConfidence, 0.55);
});

it("the +/- keys adjust the answer confidence floor row and clamp inside the open interval", () => {
  const { ui, changes } = makeUi({
    smartCompaction: { ...DEFAULT_CONFIG.smartCompaction, minAnswerConfidence: 0.95 },
  });
  selectCompactionRow(ui, "answerConfidence");

  ui.handleInput("+");
  assert.strictEqual(changes.at(-1)?.smartCompaction.minAnswerConfidence, 0.95);
  ui.handleInput("-");
  assert.strictEqual(changes.at(-1)?.smartCompaction.minAnswerConfidence, 0.9);
});

it("the cap row shows the integer value", () => {
  const { ui } = makeUi({
    smartCompaction: { ...DEFAULT_CONFIG.smartCompaction, maxCandidates: 3 },
  });
  goToCompaction(ui);
  assert.strictEqual(
    rendered(ui).some((line) => line.includes("Max candidates") && line.includes("3")),
    true,
  );
});

it("Enter on the cap row steps the value up by one", () => {
  const { ui, changes } = makeUi();
  selectCompactionRow(ui, "cap");

  ui.handleInput("\r");

  assert.strictEqual(changes.length, 1);
  assert.strictEqual(changes[0]!.smartCompaction.maxCandidates, 9);
});

it("the +/- keys adjust the cap row and clamp to the bounds", () => {
  const { ui, changes } = makeUi({
    smartCompaction: { ...DEFAULT_CONFIG.smartCompaction, maxCandidates: 20 },
  });
  selectCompactionRow(ui, "cap");

  ui.handleInput("+");
  assert.strictEqual(changes.at(-1)?.smartCompaction.maxCandidates, 20);
  ui.handleInput("-");
  assert.strictEqual(changes.at(-1)?.smartCompaction.maxCandidates, 19);
});

// ---------------------------------------------------------------------------
// hasTrackerExtension: the gate itself
// ---------------------------------------------------------------------------

const probe = (
  tools: readonly string[],
  commands: readonly { name: string; source: string }[],
): {
  getAllTools: () => readonly { name: string }[];
  getCommands: () => readonly { name: string; source: string }[];
} => ({
  getAllTools: () => tools.map((name) => ({ name })),
  getCommands: () => commands,
});

it("hasTrackerExtension is true when the tracker tool is registered", () => {
  assert.strictEqual(hasTrackerExtension(probe(["read", "tracker"], [])), true);
});

it("hasTrackerExtension is true when the tracker extension command is registered", () => {
  assert.strictEqual(
    hasTrackerExtension(probe([], [{ name: "tracker", source: "extension" }])),
    true,
  );
});

it("hasTrackerExtension ignores a non-extension command named tracker", () => {
  assert.strictEqual(hasTrackerExtension(probe([], [{ name: "tracker", source: "prompt" }])), false);
});

it("hasTrackerExtension is false when the tracker is not loaded", () => {
  assert.strictEqual(
    hasTrackerExtension(probe(["read", "bash"], [{ name: "tui", source: "extension" }])),
    false,
  );
});

// ---------------------------------------------------------------------------
// loadClassifierChoices: credential-available models, else the catalog
// ---------------------------------------------------------------------------

const descriptor = (provider: string, id: string, name: string): ClassifierDescriptor => ({
  provider,
  id,
  name,
});

const catalogModels: readonly ClassifierDescriptor[] = [
  descriptor("cloudflare-workers-ai", "@cf/cloudflare/clef-flash", "Clef Flash"),
  descriptor("typesafe", "jev-latest", "Jev"),
  descriptor("other", "alpha", "Alpha"),
  descriptor("other", "beta", "Beta"),
];

const source = (available: readonly ClassifierDescriptor[]): ClassifierSource => ({
  getAvailableOfType: async () => available,
  getModelsOfType: () => catalogModels,
});

it("loadClassifierChoices prefers credential-available classifiers", async () => {
  const choices = await loadClassifierChoices(source([catalogModels[0]!, catalogModels[1]!]));
  assert.deepStrictEqual(
    choices.map((choice) => choice.value),
    [null, "cloudflare-workers-ai/@cf/cloudflare/clef-flash", "typesafe/jev-latest"],
  );
  assert.strictEqual(choices[0]!.label, "Automatic (prefer Clef Flash, then Jev)");
});

it("loadClassifierChoices falls back to the full catalog when none are available", async () => {
  const choices = await loadClassifierChoices(source([]));
  assert.strictEqual(choices.length, catalogModels.length + 1);
  assert.deepStrictEqual(
    choices.map((choice) => choice.value),
    [
      null,
      "cloudflare-workers-ai/@cf/cloudflare/clef-flash",
      "typesafe/jev-latest",
      "other/alpha",
      "other/beta",
    ],
  );
});

it("loadClassifierChoices survives a discovery failure", async () => {
  const failing: ClassifierSource = {
    getAvailableOfType: async () => {
      throw new Error("no credentials");
    },
    getModelsOfType: () => catalogModels,
  };
  const choices = await loadClassifierChoices(failing);
  assert.strictEqual(choices.length, catalogModels.length + 1);
});
