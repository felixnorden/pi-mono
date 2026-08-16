import type { Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { TodoList, TrackerState } from "./domain.ts";
import type { UpdateItemPatch } from "./store.ts";

const MAX_LISTS = 8;
const MAX_ITEMS = 12;

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);

/**
 * Width-keyed render cache (tui.md "Performance"). Rendered lines are
 * reused while the width is unchanged and the component's inputs are stable;
 * the TUI calls `invalidate()` on theme changes so stale themed output
 * (ANSI colors baked into the cached strings) is never served.
 */
export interface CachedRender {
  render(width: number): string[];
  invalidate(): void;
}

export const cachedRender = (render: (width: number) => string[]): CachedRender => {
  let cachedWidth: number | undefined;
  let cachedLines: string[] | undefined;
  return {
    render(width: number): string[] {
      if (cachedLines !== undefined && cachedWidth === width) return cachedLines;
      cachedWidth = width;
      cachedLines = render(width);
      return cachedLines;
    },
    invalidate(): void {
      cachedWidth = undefined;
      cachedLines = undefined;
    },
  };
};

// --------------------------------------------------------------------------
// Widget pane (ctx.ui.setWidget)
// --------------------------------------------------------------------------

/**
 * Lines for the always-visible widget pane above the editor. Shows the active
 * list with its items, framed by a complete
 * rounded-corner box in the `border` color. Returns an empty array when no
 * list is active — the bridge hides the widget in that case.
 */
export function renderTrackerWidget(state: TrackerState, theme: Theme, width: number): string[] {
  // Only render when a list is explicitly active; no fallback to the first
  // list — the widget is the user's opt-in view of the active list.
  const active = state.lists.find((list) => list.id === state.activeListId);
  if (!active) return [];

  const w = Math.max(4, width);
  const done = active.items.filter((item) => item.done).length;
  const lines: string[] = [];
  const frame = (char: string) => theme.fg("border", char);

  // Top border with title: ╭─ Work (1/3) ────────────╮
  const title =
    theme.fg("accent", theme.bold(active.name)) + theme.fg("dim", ` (${done}/${active.items.length})`);
  const topFill = Math.max(0, w - 2 - visibleWidth(`${frame("─")} ${title} `));
  lines.push(
    truncateToWidth(
      `${frame("╭")}${frame("─")} ${title} ${frame("─".repeat(topFill))}${frame("╮")}`,
      w,
    ),
  );

  // Item lines, padded so the right bar stays flush.
  for (const item of active.items.slice(0, MAX_ITEMS)) {
    const check = item.done ? theme.fg("success", "✓ ") : theme.fg("dim", "○ ");
    const text = item.done ? theme.fg("muted", theme.strikethrough(item.text)) : item.text;
    lines.push(frameLine(frame, `  ${check}${text}`, w));
  }
  if (active.items.length > MAX_ITEMS) {
    lines.push(frameLine(frame, theme.fg("dim", `  ... ${active.items.length - MAX_ITEMS} more`), w));
  }

  // Bottom border: ╰───────────────────────────────╯
  lines.push(truncateToWidth(`${frame("╰")}${frame("─".repeat(w - 2))}${frame("╯")}`, w));
  return lines;
}

/** Wrap one content line in the box's vertical bars, padded to the frame width. */
const frameLine = (frame: (char: string) => string, content: string, width: number): string => {
  const inner = truncateToWidth(content, width - 4, "");
  const pad = " ".repeat(Math.max(0, width - 4 - visibleWidth(inner)));
  return truncateToWidth(`${frame("│")} ${inner}${pad} ${frame("│")}`, width);
};

// --------------------------------------------------------------------------
// Interactive overlay (/tracker command)
// --------------------------------------------------------------------------

/** A mutation requested by the interactive UI. The bridge runs it on the store. */
export type TrackerUiAction =
  | { readonly type: "createList"; readonly name: string }
  | { readonly type: "deleteList"; readonly listId: number }
  | { readonly type: "setActive"; readonly listId: number | null }
  | { readonly type: "addItem"; readonly listId: number; readonly text: string }
  | { readonly type: "updateItem"; readonly itemId: string; readonly patch: UpdateItemPatch }
  | { readonly type: "removeItem"; readonly itemId: string };

type InputMode =
  | { readonly kind: "newList"; buffer: string }
  | { readonly kind: "addItem"; readonly listId: number; buffer: string }
  | { readonly kind: "editItem"; readonly itemId: string; buffer: string };

export interface TrackerOverlayOptions {
  /** Latest state snapshot (re-read on every render). */
  readonly getState: () => TrackerState;
  readonly theme: Theme;
  /** Ask the TUI to re-render after state changes. */
  readonly requestRender: () => void;
  /**
   * Run a mutation through the bridge. Resolves with an error message on
   * failure, or null on success (state already updated).
   */
  readonly onAction: (action: TrackerUiAction) => Promise<string | null>;
  /** Close the overlay. */
  readonly onClose: () => void;
}

/**
 * Interactive two-pane tracker: lists on top, items of the focused list
 * below. Moving the cursor in the lists pane previews that list's items;
 * `enter` commits it as the active list and opens the items pane. `tab`
 * switches panes. Inline text input for names/tasks (printable chars,
 * backspace, enter confirm, esc cancel).
 */
export class TrackerOverlay {
  private mode: "lists" | "items" = "lists";
  private listIndex = 0;
  private itemIndex = 0;
  private input: InputMode | null = null;
  private error: string | null = null;

  // Render cache (tui.md "Performance"): lines are reused while the inputs
  // (width, state snapshot, overlay state) are unchanged. The TUI calls
  // invalidate() on theme changes so stale themed output is never served.
  private cachedWidth?: number;
  private cachedLines?: string[];
  private cachedState?: TrackerState;
  private cachedSignature?: string;

  constructor(private readonly options: TrackerOverlayOptions) {}

  handleInput(data: string): void {
    if (this.input) {
      this.handleInputMode(data);
      return;
    }
    if (matchesKey(data, Key.escape)) {
      this.options.onClose();
      return;
    }
    if (matchesKey(data, Key.tab) || matchesKey(data, Key.shift("tab"))) {
      this.mode = this.mode === "lists" ? "items" : "lists";
      this.error = null;
      this.syncCursors();
      this.options.requestRender();
      return;
    }
    const state = this.options.getState();
    const handled =
      this.mode === "lists" ? this.handleListsKey(data, state) : this.handleItemsKey(data, state);
    if (handled) {
      this.error = null;
      this.options.requestRender();
    }
  }

  render(width: number): string[] {
    const theme = this.options.theme;
    const state = this.options.getState();
    const signature = this.signature();
    if (
      this.cachedLines !== undefined &&
      this.cachedWidth === width &&
      this.cachedState === state &&
      this.cachedSignature === signature
    ) {
      return this.cachedLines;
    }
    const lines: string[] = [];

    // Header
    const title = theme.fg("accent", " Tracker ");
    const border = theme.fg("border", "─".repeat(3));
    const fill = theme.fg("border", "─".repeat(Math.max(0, width - 3 - visibleWidth(title))));
    lines.push(truncateToWidth(`${border}${title}${fill}`, width));

    // Lists pane
    const listsHeader =
      this.mode === "lists" ? theme.fg("accent", theme.bold("Lists")) : theme.fg("muted", "Lists");
    lines.push(truncateToWidth(`  ${listsHeader}`, width));

    if (state.lists.length === 0) {
      lines.push(truncateToWidth(`  ${theme.fg("dim", "No lists yet — press n to create one")}`, width));
    } else {
      for (const [index, list] of state.lists.slice(0, MAX_LISTS).entries()) {
        const selected = this.mode === "lists" && index === this.listIndex;
        const isActive = list.id === state.activeListId;
        const counts = theme.fg("dim", ` (${list.items.filter((i) => i.done).length}/${list.items.length})`);
        const name = isActive ? `${theme.fg("success", "● ")}${list.name}` : list.name;
        if (selected) {
          lines.push(truncateToWidth(`  ${theme.fg("accent", "→ ")}${theme.fg("accent", name)}${counts}`, width));
        } else {
          lines.push(truncateToWidth(`  ${theme.fg("text", name)}${counts}`, width));
        }
      }
      if (state.lists.length > MAX_LISTS) {
        lines.push(truncateToWidth(`  ${theme.fg("dim", `... ${state.lists.length - MAX_LISTS} more`)}`, width));
      }
    }

    lines.push("");

    // Items pane
    const activeList = this.activeList(state);
    const itemsHeader = theme.fg(
      this.mode === "items" ? "accent" : "muted",
      this.mode === "items" ? theme.bold(`Items — ${activeList?.name ?? "(no list)"}`) : `Items — ${activeList?.name ?? "(no list)"}`,
    );
    lines.push(truncateToWidth(`  ${itemsHeader}`, width));

    if (!activeList) {
      const hint =
        state.lists.length === 0
          ? "No lists yet — press n to create one"
          : "No active list — select one in the lists pane (enter)";
      lines.push(truncateToWidth(`  ${theme.fg("dim", hint)}`, width));
    } else if (activeList.items.length === 0) {
      lines.push(truncateToWidth(`  ${theme.fg("dim", "No items — press a to add")}`, width));
    } else {
      for (const [index, item] of activeList.items.slice(0, MAX_ITEMS).entries()) {
        const selected = this.mode === "items" && index === this.itemIndex;
        const prefix = selected ? theme.fg("accent", "→ ") : "  ";
        const check = item.done ? theme.fg("success", "✓") : theme.fg("dim", "○");
        const text = item.done ? theme.fg("muted", theme.strikethrough(item.text)) : item.text;
        lines.push(truncateToWidth(`${prefix}${check} ${text}`, width));
      }
      if (activeList.items.length > MAX_ITEMS) {
        lines.push(truncateToWidth(`  ${theme.fg("dim", `... ${activeList.items.length - MAX_ITEMS} more`)}`, width));
      }
    }

    // Input prompt / error line
    if (this.input) {
      lines.push("");
      const prompt =
        this.input.kind === "newList"
          ? "New list name"
          : this.input.kind === "addItem"
            ? "Item text"
            : "Edit item text";
      lines.push(truncateToWidth(`  ${theme.fg("accent", `${prompt}:`)} ${this.input.buffer}▌`, width));
      lines.push(truncateToWidth(`  ${theme.fg("dim", "enter confirm · esc cancel")}`, width));
    } else if (this.error) {
      lines.push("");
      lines.push(truncateToWidth(`  ${theme.fg("warning", `! ${this.error}`)}`, width));
    }

    // Help
    lines.push("");
    const help =
      this.mode === "lists"
        ? "[tab] items · [n] new · [d] delete · [space] toggle · [↑↓] move · [enter] active · [esc] close"
        : "[tab] lists · [a] add · [x] toggle · [e] edit · [r] remove · [↑↓] move · [esc] close";
    lines.push(truncateToWidth(`  ${theme.fg("dim", help)}`, width));

    // Bottom border
    lines.push(truncateToWidth(theme.fg("border", "─".repeat(Math.max(0, width))), width));

    this.cachedWidth = width;
    this.cachedLines = lines;
    this.cachedState = state;
    this.cachedSignature = signature;
    return lines;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
    this.cachedState = undefined;
    this.cachedSignature = undefined;
  }

  /**
   * Fingerprint of the overlay's own mutable state, used as part of the
   * render-cache key. The state snapshot is compared by object identity:
   * the store is immutable, so any mutation produces a fresh snapshot.
   */
  private signature(): string {
    const input = this.input;
    const inputPart = input === null ? "" : `${input.kind}:${input.buffer}`;
    return `${this.mode}:${this.listIndex}:${this.itemIndex}:${this.error ?? ""}:${inputPart}`;
  }

  private activeList(state: TrackerState): TodoList | undefined {
    // The items pane previews the list under the cursor while browsing the
    // lists pane; in items mode it follows the explicitly active list (the
    // one committed with enter), so item edits always target the active list.
    if (this.mode === "lists") {
      return state.lists[this.listIndex];
    }
    return state.lists.find((list) => list.id === state.activeListId);
  }

  private handleListsKey(data: string, state: TrackerState): boolean {
    const lists = state.lists;
    if (lists.length === 0) {
      if (data === "n") {
        this.input = { kind: "newList", buffer: "" };
        return true;
      }
      return false;
    }
    if (matchesKey(data, Key.up)) {
      this.listIndex = (this.listIndex - 1 + lists.length) % lists.length;
      return true;
    }
    if (matchesKey(data, Key.down)) {
      this.listIndex = (this.listIndex + 1) % lists.length;
      return true;
    }
    if (matchesKey(data, Key.enter)) {
      const list = lists[this.listIndex]!;
      void this.runAction({ type: "setActive", listId: list.id }, () => {
        this.mode = "items";
        this.itemIndex = 0;
      });
      return true;
    }
    if (data === "n") {
      this.input = { kind: "newList", buffer: "" };
      return true;
    }
    if (data === "d") {
      const list = lists[this.listIndex]!;
      void this.runAction({ type: "deleteList", listId: list.id });
      return true;
    }
    if (data === " " || matchesKey(data, Key.space)) {
      // Toggle the highlighted list: selecting another list makes it active,
      // toggling the already-active list deselects it (hiding the widget).
      const list = lists[this.listIndex]!;
      const target = state.activeListId === list.id ? null : list.id;
      void this.runAction({ type: "setActive", listId: target });
      return true;
    }
    return false;
  }

  private handleItemsKey(data: string, state: TrackerState): boolean {
    const list = this.activeList(state);
    if (!list) {
      if (data === "n") {
        this.input = { kind: "newList", buffer: "" };
        return true;
      }
      return false;
    }
    const items = list.items;
    if (matchesKey(data, Key.up)) {
      if (items.length > 0) this.itemIndex = (this.itemIndex - 1 + items.length) % items.length;
      return true;
    }
    if (matchesKey(data, Key.down)) {
      if (items.length > 0) this.itemIndex = (this.itemIndex + 1) % items.length;
      return true;
    }
    if (matchesKey(data, Key.enter) || data === "x") {
      const item = items[this.itemIndex];
      if (!item) return true;
      void this.runAction({
        type: "updateItem",
        itemId: `${list.name}:${this.itemIndex + 1}`,
        patch: { done: !item.done },
      });
      return true;
    }
    if (data === "a") {
      this.input = { kind: "addItem", listId: list.id, buffer: "" };
      return true;
    }
    if (data === "e") {
      const item = items[this.itemIndex];
      if (!item) return true;
      this.input = { kind: "editItem", itemId: `${list.name}:${this.itemIndex + 1}`, buffer: item.text };
      return true;
    }
    if (data === "r") {
      const item = items[this.itemIndex];
      if (!item) return true;
      void this.runAction({ type: "removeItem", itemId: `${list.name}:${this.itemIndex + 1}` });
      return true;
    }
    if (data === "n") {
      this.input = { kind: "newList", buffer: "" };
      return true;
    }
    return false;
  }

  private handleInputMode(data: string): void {
    const input = this.input;
    if (!input) return;
    if (matchesKey(data, Key.escape)) {
      this.input = null;
      this.error = null;
    } else if (matchesKey(data, Key.enter)) {
      this.input = null;
      const action: TrackerUiAction =
        input.kind === "newList"
          ? { type: "createList", name: input.buffer }
          : input.kind === "addItem"
            ? { type: "addItem", listId: input.listId, text: input.buffer }
            : {
                type: "updateItem",
                itemId: input.itemId,
                patch: { text: input.buffer },
              };
      void this.runAction(action);
    } else if (matchesKey(data, Key.backspace)) {
      input.buffer = input.buffer.slice(0, -1);
    } else if (data.length === 1 && data.charCodeAt(0) >= 32) {
      // Printable character (single UTF-16 code unit).
      input.buffer += data;
    }
    this.options.requestRender();
  }

  private async runAction(action: TrackerUiAction, afterSuccess?: () => void): Promise<void> {
    const error = await this.options.onAction(action);
    if (error) {
      this.error = error;
    } else {
      this.error = null;
      afterSuccess?.();
      this.syncCursors();
    }
    this.options.requestRender();
  }

  private syncCursors(): void {
    const state = this.options.getState();
    const lists = state.lists;
    this.listIndex = lists.length === 0 ? 0 : clamp(this.listIndex, 0, lists.length - 1);
    const list = this.activeList(state);
    const items = list?.items ?? [];
    this.itemIndex = items.length === 0 ? 0 : clamp(this.itemIndex, 0, items.length - 1);
  }
}
