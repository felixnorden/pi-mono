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
import type { IconMode, TuiConfig, SettingsLanguage } from "../config.ts";

interface SettingItem {
  id: string;
  label: string;
  currentValue: string;
}

type Tab = "features" | "icons" | "segments" | "telemetry";

const TABS: Tab[] = ["features", "icons", "segments", "telemetry"];

const COPY = {
  en: {
    title: "TUI Settings",
    tabs: { features: "General", icons: "Icons", segments: "Footer", telemetry: "Telemetry" },
    hint: "Tab/Shift+Tab/←/→/h/l: tabs · ↑/↓/j/k: move · Enter/Space: change · Esc/q: close",
    labels: {
      enabled: "Enabled",
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

function toggleLanguage(config: TuiConfig): TuiConfig {
  return { ...config, settingsLanguage: config.settingsLanguage };
}

function toggleTelemetry(config: TuiConfig, key: keyof TuiConfig["telemetry"]): TuiConfig {
  return {
    ...config,
    telemetry: { ...config.telemetry, [key]: !config.telemetry[key] },
  };
}

function buildFeaturesItems(config: TuiConfig, copy: SettingsCopy): SettingItem[] {
  return [
    {
      id: "enabled",
      label: copy.labels.enabled,
      currentValue: config.enabled ? copy.values.on : copy.values.off,
    },
    {
      id: "settingsLanguage",
      label: copy.labels.language,
      currentValue: copy.values.languages[config.settingsLanguage],
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

function buildItems(tab: Tab, config: TuiConfig): SettingItem[] {
  const copy = COPY[config.settingsLanguage];
  switch (tab) {
    case "features":
      return buildFeaturesItems(config, copy);
    case "icons":
      return buildIconsItems(config, copy);
    case "segments":
      return buildSegmentsItems(config, copy);
    case "telemetry":
      return buildTelemetryItems(config, copy);
  }
}

function handleSettingChange(tab: Tab, itemId: string, config: TuiConfig): TuiConfig {
  if (tab === "features") {
    if (itemId === "enabled") return toggleEnabled(config);
    if (itemId === "settingsLanguage") return toggleLanguage(config);
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
  onChange: (config: TuiConfig) => void,
  onClose: () => void,
): SettingsUiHandle => {
  let tab: Tab = "features";
  let currentConfig = config;
  let selectList!: SelectList;
  let bordered!: ReturnType<typeof makeBorderedBox>;
  const selectedItemByTab: Partial<Record<Tab, string>> = {};
  const body = new Container();
  let cachedWidth: number | undefined;
  let cachedLines: string[] | undefined;
  let compact = false;

  const applySetting = (itemId: string): void => {
    selectedItemByTab[tab] = itemId;
    currentConfig = handleSettingChange(tab, itemId, currentConfig);
    onChange(currentConfig);
    rebuild(itemId);
  };

  const switchTab = (offset: number): void => {
    const idx = TABS.indexOf(tab);
    tab = TABS[(idx + offset + TABS.length) % TABS.length]!;
    rebuild();
  };

  const rebuild = (preferredItemId = selectedItemByTab[tab]): void => {
    const copy = COPY[currentConfig.settingsLanguage];
    body.clear();

    const tabBar = TABS.map((tabName) => {
      const active = tabName === tab;
      const label = active ? `[${copy.tabs[tabName]}]` : ` ${copy.tabs[tabName]} `;
      return active ? theme.fg("accent", label) : theme.fg("dim", label);
    }).join(" ");
    body.addChild(new Text(tabBar, 0, 0));
    body.addChild(new Text(theme.fg("dim", copy.hint), 0, 0));

    const items = buildItems(tab, currentConfig).map(
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
      label: theme.bold(theme.fg("accent", copy.title)),
      bg: (s: string) => theme.bg("customMessageBg", s),
    });
    cachedWidth = undefined;
    cachedLines = undefined;
  };

  /**
   * Move the list selection by `offset` items, wrapping around at both ends.
   * Mirrors SelectList's arrow-key behavior for the vim j/k keys.
   */
  const moveSelection = (offset: number): void => {
    const items = buildItems(tab, currentConfig);
    if (items.length === 0) return;
    const currentIndex = items.findIndex((item) => item.id === selectList.getSelectedItem()?.value);
    const nextIndex = (currentIndex + offset + items.length) % items.length;
    selectList.setSelectedIndex(nextIndex);
    const item = items[nextIndex];
    if (item) selectedItemByTab[tab] = item.id;
  };

  const handleInput = (data: string): void => {
    if (matchesKey(data, Key.tab) || matchesKey(data, Key.right) || matchesKey(data, "l")) {
      switchTab(1);
      invalidate();
      return;
    }
    if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left) || matchesKey(data, "h")) {
      switchTab(-1);
      invalidate();
      return;
    }
    if (matchesKey(data, Key.escape) || matchesKey(data, "q")) {
      onClose();
      return;
    }
    if (matchesKey(data, "j")) {
      moveSelection(1);
    } else if (matchesKey(data, "k")) {
      moveSelection(-1);
    } else if (matchesKey(data, Key.space) || data === " ") {
      const selected = selectList.getSelectedItem();
      if (selected) applySetting(selected.value);
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
): void {
  pi.registerCommand("tui", {
    description: "Open the tui settings UI",
    handler: async (_args, ctx: ExtensionContext) => {
      if (!ctx.hasUI) return;
      await ctx.ui.custom<void>(
        (tui: TUI, theme, _kb, done) => {
          const ui = makeSettingsUi(
            theme,
            hooks.getConfig(),
            (config) => hooks.onConfigChanged(config),
            () => done(undefined),
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
        { overlay: true },
      );
    },
  });
}
