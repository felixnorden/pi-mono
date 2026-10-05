import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  Container,
  Key,
  matchesKey,
  SelectList,
  type SelectItem,
  type TUI,
  Text,
} from "@earendil-works/pi-tui";
import { makeBorderedBox } from "../components/bordered-box.ts";
import {
  adjustSmartCompactionProbability,
  adjustMaxCandidates,
  SMART_COMPACTION_PROBABILITY_STEP,
  MAX_CANDIDATES_STEP,
  type IconMode,
  type TuiConfig,
  type SettingsLanguage,
} from "../config.ts";
import { VimRouter } from "../vim/vim-router.ts";

interface SettingItem {
  id: string;
  label: string;
  currentValue: string;
}

type Tab = "features" | "compaction" | "icons" | "segments" | "telemetry";

const BASE_TABS: readonly Tab[] = ["features", "icons", "segments", "telemetry"];
const COMPACTION_TAB: Tab = "compaction";

/**
 * The tab order. The Compaction tab exists only while the tracker extension is
 * loaded, so a session without it never shows tracker-only settings.
 */
const tabsFor = (hasTracker: boolean): readonly Tab[] =>
  hasTracker ? ["features", COMPACTION_TAB, "icons", "segments", "telemetry"] : BASE_TABS;

const COPY = {
  en: {
    title: "TUI Settings",
    tabs: {
      features: "General",
      compaction: "Compaction",
      icons: "Icons",
      segments: "Footer",
      telemetry: "Telemetry",
    },
    hint: "Tab/Shift+Tab/←/→/h/l: tabs · ↑/↓/j/k: move · Enter/Space: change · +/−: step value · Esc/q: close",
    labels: {
      enabled: "Enabled",
      vim: "Vim mode",
      language: "Language",
      iconMode: "Icon mode",
      cwd: "CWD",
      gitBranch: "Git branch",
      gitStatus: "Git status",
      gitCommit: "Git commit (detached)",
      runtime: "Runtime",
      context: "Context bar",
      tokens: "Tokens",
      cost: "Cost",
      extensionStatuses: "Extension status line",
      totalDuration: "Total duration",
      tokenCounts: "Token counts",
      stallDetails: "Stall details",
      costRate: "Cost rate",
      smartCompactionEnabled: "Smart compaction",
      smartCompactionClassifier: "Compaction classifier",
      smartCompactionNeedsContextProbability: "Needs-context probability",
      smartCompactionMinAnswerConfidence: "Answer confidence floor",
      smartCompactionMaxCandidates: "Max candidates",
    },
    values: {
      on: "On",
      off: "Off",
      languages: { en: "English" },
      icons: { auto: "Auto", nerd: "Nerd", ascii: "ASCII" },
    },
  },
} as const;

type SettingsCopy = (typeof COPY)[SettingsLanguage];

function toggleSetting(config: TuiConfig, key: keyof TuiConfig["footerSegments"]): TuiConfig {
  return {
    ...config,
    footerSegments: {
      ...config.footerSegments,
      [key]: !config.footerSegments[key],
    },
  };
}

function cycleIconMode(config: TuiConfig): TuiConfig {
  const order: IconMode[] = ["auto", "nerd", "ascii"];
  const currentIdx = order.indexOf(config.icons.mode);
  const next = order[(currentIdx + 1) % order.length]!;
  return { ...config, icons: { mode: next } };
}

function toggleEnabled(config: TuiConfig): TuiConfig {
  return { ...config, enabled: !config.enabled };
}

function toggleVim(config: TuiConfig): TuiConfig {
  return { ...config, vim: !config.vim };
}

function toggleLanguage(config: TuiConfig): TuiConfig {
  return { ...config, settingsLanguage: config.settingsLanguage };
}

function toggleTelemetry(config: TuiConfig, key: keyof TuiConfig["telemetry"]): TuiConfig {
  return {
    ...config,
    telemetry: { ...config.telemetry, [key]: !config.telemetry[key] },
  };
}

/** A classifier the picker can offer. Structural, so a registry model fits. */
export interface ClassifierDescriptor {
  readonly provider: string;
  readonly id: string;
  readonly name?: string | undefined;
}

/** The classifier fields this dialog needs from the model registry. Structural,
 *  so `ctx.modelRegistry` satisfies it and tests pass a plain object. */
export interface ClassifierSource {
  readonly getAvailableOfType: (
    type: "classifier",
  ) => Promise<readonly ClassifierDescriptor[]>;
  readonly getModelsOfType: (type: "classifier") => readonly ClassifierDescriptor[];
}

/** The slice of `ExtensionAPI` the dialog needs to detect the tracker. */
export interface TrackerProbe {
  readonly getAllTools: () => readonly { readonly name: string }[];
  readonly getCommands: () => readonly { readonly name: string; readonly source: string }[];
}

/**
 * Whether the tracker extension is loaded in this session. The tracker
 * registers a tool and a command named `tracker`; either one proves presence,
 * so the Compaction tab is hidden when it is not installed.
 */
export const hasTrackerExtension = (probe: TrackerProbe): boolean =>
  probe.getAllTools().some((tool) => tool.name === "tracker") ||
  probe
    .getCommands()
    .some((command) => command.name === "tracker" && command.source === "extension");

export interface ClassifierChoice {
  /** `"provider/modelId"`, or null for the preference order. */
  readonly value: string | null;
  readonly label: string;
}

const AUTOMATIC_CLASSIFIER_CHOICE: ClassifierChoice = {
  value: null,
  label: "Automatic (prefer Clef Flash, then Jev)",
};

/**
 * Credential-available classifiers, else the whole catalog. `Automatic` is
 * always first, so a chosen classifier is reversible.
 */
export const loadClassifierChoices = async (
  source: ClassifierSource,
): Promise<ClassifierChoice[]> => {
  let models: readonly ClassifierDescriptor[];
  try {
    const available = await source.getAvailableOfType("classifier");
    models = available.length > 0 ? available : source.getModelsOfType("classifier");
  } catch {
    // Discovery failure must not empty the picker.
    models = source.getModelsOfType("classifier");
  }
  const choices: ClassifierChoice[] = [AUTOMATIC_CLASSIFIER_CHOICE];
  const seen = new Set<string>();
  for (const model of models) {
    const value = `${model.provider}/${model.id}`;
    if (seen.has(value)) continue;
    seen.add(value);
    choices.push({ value, label: model.name ?? value });
  }
  return choices;
};

function classifierLabel(choices: readonly ClassifierChoice[], value: string | null): string {
  if (value === null) return AUTOMATIC_CLASSIFIER_CHOICE.label;
  return choices.find((choice) => choice.value === value)?.label ?? value;
}

function toggleSmartCompaction(config: TuiConfig): TuiConfig {
  return {
    ...config,
    smartCompaction: { ...config.smartCompaction, enabled: !config.smartCompaction.enabled },
  };
}

function cycleClassifier(config: TuiConfig, choices: readonly ClassifierChoice[]): TuiConfig {
  const currentIndex = choices.findIndex(
    (choice) => choice.value === config.smartCompaction.classifier,
  );
  const next = choices[(currentIndex + 1) % choices.length] ?? AUTOMATIC_CLASSIFIER_CHOICE;
  return { ...config, smartCompaction: { ...config.smartCompaction, classifier: next.value } };
}

/** Two-decimal display for the probability rows. */
const formatProbability = (value: number): string => value.toFixed(2);

function buildFeaturesItems(config: TuiConfig, copy: SettingsCopy): SettingItem[] {
  return [
    {
      id: "enabled",
      label: copy.labels.enabled,
      currentValue: config.enabled ? copy.values.on : copy.values.off,
    },
    {
      id: "vim",
      label: copy.labels.vim,
      currentValue: config.vim ? copy.values.on : copy.values.off,
    },
    {
      id: "settingsLanguage",
      label: copy.labels.language,
      currentValue: copy.values.languages[config.settingsLanguage],
    },
  ];
}

/** Integer display for the max-candidates row. */
const formatMaxCandidates = (value: number): string => String(value);

function buildCompactionItems(
  config: TuiConfig,
  copy: SettingsCopy,
  choices: readonly ClassifierChoice[],
): SettingItem[] {
  return [
    {
      id: "smartCompactionEnabled",
      label: copy.labels.smartCompactionEnabled,
      currentValue: config.smartCompaction.enabled ? copy.values.on : copy.values.off,
    },
    {
      id: "smartCompactionClassifier",
      label: copy.labels.smartCompactionClassifier,
      currentValue: classifierLabel(choices, config.smartCompaction.classifier),
    },
    {
      id: "smartCompactionNeedsContextProbability",
      label: copy.labels.smartCompactionNeedsContextProbability,
      currentValue: formatProbability(config.smartCompaction.needsContextProbabilityThreshold),
    },
    {
      id: "smartCompactionMinAnswerConfidence",
      label: copy.labels.smartCompactionMinAnswerConfidence,
      currentValue: formatProbability(config.smartCompaction.minAnswerConfidence),
    },
    {
      id: "smartCompactionMaxCandidates",
      label: copy.labels.smartCompactionMaxCandidates,
      currentValue: formatMaxCandidates(config.smartCompaction.maxCandidates),
    },
  ];
}

function buildIconsItems(config: TuiConfig, copy: SettingsCopy): SettingItem[] {
  return [
    { id: "mode", label: copy.labels.iconMode, currentValue: copy.values.icons[config.icons.mode] },
  ];
}

function buildSegmentsItems(config: TuiConfig, copy: SettingsCopy): SettingItem[] {
  const segs = config.footerSegments;
  const flag = (value: boolean) => (value ? copy.values.on : copy.values.off);
  return [
    { id: "cwd", label: copy.labels.cwd, currentValue: flag(segs.cwd) },
    { id: "gitBranch", label: copy.labels.gitBranch, currentValue: flag(segs.gitBranch) },
    { id: "gitStatus", label: copy.labels.gitStatus, currentValue: flag(segs.gitStatus) },
    { id: "gitCommit", label: copy.labels.gitCommit, currentValue: flag(segs.gitCommit) },
    { id: "runtime", label: copy.labels.runtime, currentValue: flag(segs.runtime) },
    { id: "context", label: copy.labels.context, currentValue: flag(segs.context) },
    { id: "tokens", label: copy.labels.tokens, currentValue: flag(segs.tokens) },
    { id: "cost", label: copy.labels.cost, currentValue: flag(segs.cost) },
    {
      id: "extensionStatuses",
      label: copy.labels.extensionStatuses,
      currentValue: flag(segs.extensionStatuses),
    },
  ];
}

function buildTelemetryItems(config: TuiConfig, copy: SettingsCopy): SettingItem[] {
  const telemetry = config.telemetry;
  const flag = (value: boolean) => (value ? copy.values.on : copy.values.off);
  return [
    { id: "enabled", label: copy.labels.enabled, currentValue: flag(telemetry.enabled) },
    { id: "tps", label: "TPS", currentValue: flag(telemetry.tps) },
    { id: "ttft", label: "TTFT", currentValue: flag(telemetry.ttft) },
    { id: "duration", label: copy.labels.totalDuration, currentValue: flag(telemetry.duration) },
    { id: "tokens", label: copy.labels.tokenCounts, currentValue: flag(telemetry.tokens) },
    { id: "stalls", label: copy.labels.stallDetails, currentValue: flag(telemetry.stalls) },
    { id: "cost", label: copy.labels.costRate, currentValue: flag(telemetry.cost) },
  ];
}

function buildItems(
  tab: Tab,
  config: TuiConfig,
  choices: readonly ClassifierChoice[],
): SettingItem[] {
  const copy = COPY[config.settingsLanguage];
  switch (tab) {
    case "features":
      return buildFeaturesItems(config, copy);
    case "compaction":
      return buildCompactionItems(config, copy, choices);
    case "icons":
      return buildIconsItems(config, copy);
    case "segments":
      return buildSegmentsItems(config, copy);
    case "telemetry":
      return buildTelemetryItems(config, copy);
  }
}

function handleSettingChange(
  tab: Tab,
  itemId: string,
  config: TuiConfig,
  choices: readonly ClassifierChoice[],
): TuiConfig {
  if (tab === "features") {
    if (itemId === "enabled") return toggleEnabled(config);
    if (itemId === "vim") return toggleVim(config);
    if (itemId === "settingsLanguage") return toggleLanguage(config);
  }
  if (tab === "compaction") {
    if (itemId === "smartCompactionEnabled") return toggleSmartCompaction(config);
    if (itemId === "smartCompactionClassifier") return cycleClassifier(config, choices);
  }
  if (tab === "icons" && itemId === "mode") return cycleIconMode(config);
  if (tab === "segments") {
    return toggleSetting(config, itemId as keyof TuiConfig["footerSegments"]);
  }
  if (tab === "telemetry") {
    return toggleTelemetry(config, itemId as keyof TuiConfig["telemetry"]);
  }
  return config;
}

export interface SettingsUiHandle {
  render: (width: number) => string[];
  invalidate: () => void;
  handleInput: (data: string) => void;
}

/**
 * Settings dialog for the tui extension (`/tui` command): tabbed list of
 * feature/icon/footer/telemetry switches, framed in the house rounded box.
 *
 * Closure factory: all mutable state (tab, config, selection, render cache)
 * lives in the factory closure, so the returned handle uses no `this` and
 * survives any wrapper-style hand-off into pi.
 */
export const makeSettingsUi = (
  theme: Theme,
  config: TuiConfig,
  classifierChoices: readonly ClassifierChoice[],
  hasTracker: boolean,
  onChange: (config: TuiConfig) => void,
  onClose: () => void,
  router: VimRouter["Service"],
): SettingsUiHandle => {
  const tabs = tabsFor(hasTracker);
  let tab: Tab = "features";
  let currentConfig = config;
  let selectList!: SelectList;
  let bordered!: ReturnType<typeof makeBorderedBox>;
  const selectedItemByTab: Partial<Record<Tab, string>> = {};
  const body = new Container();
  let cachedWidth: number | undefined;
  let cachedLines: string[] | undefined;
  let compact = false;

  const adjustNeedsContextProbability = (delta: number): void => {
    currentConfig = {
      ...currentConfig,
      smartCompaction: {
        ...currentConfig.smartCompaction,
        needsContextProbabilityThreshold: adjustSmartCompactionProbability(
          currentConfig.smartCompaction.needsContextProbabilityThreshold,
          delta,
        ),
      },
    };
    onChange(currentConfig);
    rebuild("smartCompactionNeedsContextProbability");
  };

  const adjustMinAnswerConfidence = (delta: number): void => {
    currentConfig = {
      ...currentConfig,
      smartCompaction: {
        ...currentConfig.smartCompaction,
        minAnswerConfidence: adjustSmartCompactionProbability(
          currentConfig.smartCompaction.minAnswerConfidence,
          delta,
        ),
      },
    };
    onChange(currentConfig);
    rebuild("smartCompactionMinAnswerConfidence");
  };

  const adjustMaxCandidatesBy = (delta: number): void => {
    currentConfig = {
      ...currentConfig,
      smartCompaction: {
        ...currentConfig.smartCompaction,
        maxCandidates: adjustMaxCandidates(currentConfig.smartCompaction.maxCandidates, delta),
      },
    };
    onChange(currentConfig);
    rebuild("smartCompactionMaxCandidates");
  };

  const applySetting = (itemId: string): void => {
    selectedItemByTab[tab] = itemId;
    // The numeric rows have no enumerated value: Enter/Space steps them up, and
    // the +/− keys step them either way.
    if (itemId === "smartCompactionNeedsContextProbability") {
      adjustNeedsContextProbability(SMART_COMPACTION_PROBABILITY_STEP);
      return;
    }
    if (itemId === "smartCompactionMinAnswerConfidence") {
      adjustMinAnswerConfidence(SMART_COMPACTION_PROBABILITY_STEP);
      return;
    }
    if (itemId === "smartCompactionMaxCandidates") {
      adjustMaxCandidatesBy(MAX_CANDIDATES_STEP);
      return;
    }
    currentConfig = handleSettingChange(tab, itemId, currentConfig, classifierChoices);
    onChange(currentConfig);
    rebuild(itemId);
  };

  const switchTab = (offset: number): void => {
    const idx = tabs.indexOf(tab);
    tab = tabs[(idx + offset + tabs.length) % tabs.length]!;
    rebuild();
  };

  const rebuild = (preferredItemId = selectedItemByTab[tab]): void => {
    const copy = COPY[currentConfig.settingsLanguage];
    body.clear();

    const tabBar = tabs.map((tabName) => {
      const active = tabName === tab;
      const label = active ? `[${copy.tabs[tabName]}]` : ` ${copy.tabs[tabName]} `;
      return active ? theme.fg("accent", label) : theme.fg("dim", label);
    }).join(" ");
    body.addChild(new Text(tabBar, 0, 0));
    body.addChild(new Text(theme.fg("dim", copy.hint), 0, 0));

    const items = buildItems(tab, currentConfig, classifierChoices).map(
      (item) =>
        ({
          value: item.id,
          label: compact ? `${item.label}: ${item.currentValue}` : item.label,
          description: compact ? undefined : item.currentValue,
        }) as SelectItem,
    );
    selectList = new SelectList(items, Math.min(items.length, 10), {
      selectedPrefix: (t) => theme.fg("accent", t),
      selectedText: (t) => theme.fg("accent", t),
      description: (t) => theme.fg("muted", t),
      scrollInfo: (t) => theme.fg("dim", t),
      noMatch: (t) => theme.fg("warning", t),
    });
    const selectedIndex = items.findIndex((item) => item.value === preferredItemId);
    if (selectedIndex >= 0) {
      selectList.setSelectedIndex(selectedIndex);
    }
    selectedItemByTab[tab] = selectList.getSelectedItem()?.value;
    selectList.onSelectionChange = (item) => {
      selectedItemByTab[tab] = item.value;
    };
    selectList.onSelect = (item) => {
      applySetting(item.value);
    };
    selectList.onCancel = () => {
      onClose();
    };
    body.addChild(selectList);

    bordered = makeBorderedBox(body, theme, {
      label: theme.style(copy.title, { fg: "accent", bold: true }),
      bg: "customMessageBg",
    });
    cachedWidth = undefined;
    cachedLines = undefined;
  };

  /**
   * Move the list selection by `offset` items, wrapping around at both ends.
   * This is the consumer that maps a router navigation intent onto the
   * widget's own cursor/wrap state. The settings UI injects an always-true
   * gate for its own router instance, so j/k drive this unconditionally
   * (h/l drive switchTab) with or without the vim toggle.
   */
  const moveSelection = (offset: number): void => {
    const items = buildItems(tab, currentConfig, classifierChoices);
    if (items.length === 0) return;
    const currentIndex = items.findIndex((item) => item.id === selectList.getSelectedItem()?.value);
    const nextIndex = (currentIndex + offset + items.length) % items.length;
    selectList.setSelectedIndex(nextIndex);
    const item = items[nextIndex];
    if (item) selectedItemByTab[tab] = item.id;
  };

  const handleInput = (data: string): void => {
    const intent = router.decodeNavigation(data);
    if (intent?.kind === "move") {
      if (intent.dir === "down") moveSelection(1);
      else if (intent.dir === "up") moveSelection(-1);
      else if (intent.dir === "right") switchTab(1);
      else if (intent.dir === "left") switchTab(-1);
      invalidate();
      return;
    }
    if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
      switchTab(1);
      invalidate();
      return;
    }
    if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
      switchTab(-1);
      invalidate();
      return;
    }
    if (matchesKey(data, Key.escape) || matchesKey(data, "q")) {
      onClose();
      return;
    }
    if (matchesKey(data, Key.space) || data === " ") {
      const selected = selectList.getSelectedItem();
      if (selected) applySetting(selected.value);
    } else if (data === "+" || data === "=" || data === "-" || data === "_") {
      const selected = selectList.getSelectedItem()?.value;
      const sign = data === "+" || data === "=" ? 1 : -1;
      if (selected === "smartCompactionNeedsContextProbability") {
        adjustNeedsContextProbability(sign * SMART_COMPACTION_PROBABILITY_STEP);
      } else if (selected === "smartCompactionMinAnswerConfidence") {
        adjustMinAnswerConfidence(sign * SMART_COMPACTION_PROBABILITY_STEP);
      } else if (selected === "smartCompactionMaxCandidates") {
        adjustMaxCandidatesBy(sign * MAX_CANDIDATES_STEP);
      } else {
        selectList.handleInput?.(data);
      }
    } else {
      selectList.handleInput?.(data);
    }
    invalidate();
  };

  const render = (width: number): string[] => {
    // The body renders at contentWidth = width - 4 (2 rails + 2×paddingX),
    // mirroring makeBorderedBox's default paddingX of 1.
    const widthCompact = Math.max(1, width - 4) <= 60;
    if (widthCompact !== compact) {
      compact = widthCompact;
      rebuild();
    }
    if (cachedLines && cachedWidth === width) return cachedLines;
    cachedWidth = width;
    cachedLines = bordered.render(width);
    return cachedLines;
  };

  const invalidate = (): void => {
    cachedWidth = undefined;
    cachedLines = undefined;
    bordered.invalidate();
  };

  rebuild();

  return { render, invalidate, handleInput };
};

export function registerSettingsCommand(
  pi: ExtensionAPI,
  hooks: {
    getConfig: () => TuiConfig;
    onConfigChanged: (config: TuiConfig) => void;
  },
  router: VimRouter["Service"],
): void {
  pi.registerCommand("tui", {
    description: "Open the tui settings UI",
    handler: async (_args, ctx: ExtensionContext) => {
      if (!ctx.hasUI) return;
      const choices = await loadClassifierChoices(ctx.modelRegistry);
      const hasTracker = hasTrackerExtension(pi);
      await ctx.ui.custom<void>(
        (tui: TUI, theme, _kb, done) => {
          const ui = makeSettingsUi(
            theme,
            hooks.getConfig(),
            choices,
            hasTracker,
            (config) => hooks.onConfigChanged(config),
            () => done(undefined),
            router,
          );
          return {
            render: (w: number) => ui.render(w),
            invalidate: () => ui.invalidate(),
            handleInput: (data: string) => {
              ui.handleInput(data);
              tui.requestRender();
            },
          };
        },
        {
          overlay: true,
          overlayOptions: {
            width: "60%",
            minWidth: 44,
            maxHeight: "80%",
            anchor: "center",
            margin: 1,
          },
        },
      );
    },
  });
}
