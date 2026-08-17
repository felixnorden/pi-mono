import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { makeBorderedBox } from "@ftrdotdev/pi-tui";
import type { TodoList, TrackerState } from "./domain.ts";
import type { UpdateItemPatch } from "./store.ts";

const MAX_LISTS = 8;
const MAX_ITEMS = 12;

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);

// --------------------------------------------------------------------------
// Widget pane (ctx.ui.setWidget)
// --------------------------------------------------------------------------

/** The active list, or undefined when the widget should render nothing. */
const activeList = (state: TrackerState): TodoList | undefined =>
  state.lists.find((list) => list.id === state.activeListId);

/** The label embedded in the widget's top border, derived per render so it follows theme changes. */
const widgetLabel =
  (list: TodoList) =>
  (theme: Theme): string => {
    const done = list.items.filter((item) => item.done).length;
    return (
      theme.fg("accent", theme.bold(list.name)) + theme.fg("dim", ` (${done}/${list.items.length})`)
    );
  };

/** The item lines inside the widget frame, rendered per width so they stay flush. */
const widgetRows =
  (list: TodoList, theme: Theme) =>
  (_width: number): string[] => {
    const rows: string[] = [];
    for (const item of list.items.slice(0, MAX_ITEMS)) {
      const check = item.done ? theme.fg("success", "✓ ") : theme.fg("dim", "○ ");
      const text = item.done ? theme.fg("muted", theme.strikethrough(item.text)) : item.text;
      rows.push(`  ${check}${text}`);
    }
    if (list.items.length > MAX_ITEMS) {
      rows.push(theme.fg("dim", `  ... ${list.items.length - MAX_ITEMS} more`));
    }
    return rows;
  };

/**
 * Component for the always-visible widget pane above the editor: the active
 * list framed in the house rounded box (`makeBorderedBox`), with the list
 * name and counts embedded in the top border. The same frame the tui, inquiry,
 * and preview surfaces use, so the widget reads as part of the house UI.
 *
 * Closure component: the returned object carries no `this`, so the bridge can
 * hand it to pi-tui through any wrapper without losing state.
 */
export const makeTrackerWidget = (state: TrackerState, theme: Theme): Component => {
  const list = activeList(state);
  if (!list) {
    // No list is active: render nothing. The bridge hides the widget in this
    // case; an empty component keeps the seam safe regardless.
    return { render: () => [], invalidate: () => {} };
  }
  // makeBorderedBox caches per width; a fresh component is registered on
  // every state change (refreshWidget), and invalidate() clears it on theme
  // changes so stale themed output is never served.
  return makeBorderedBox({ render: widgetRows(list, theme), invalidate: () => {} }, theme, {
    label: widgetLabel(list),
    color: "border",
  });
};

/**
 * Lines for the widget pane, or an empty array when no list is active — the
 * bridge hides the widget in that case. Kept as a convenience for tests.
 */
export const renderTrackerWidget = (state: TrackerState, theme: Theme, width: number): string[] =>
  makeTrackerWidget(state, theme).render(Math.max(4, width));

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

/** The interactive overlay surface: render + input + cache invalidation. */
export interface TrackerOverlayHandle {
  readonly render: (width: number) => string[];
  readonly invalidate: () => void;
  readonly handleInput: (data: string) => void;
}

/**
 * Interactive two-pane tracker: lists on top, items of the focused list
 * below. Moving the cursor in the lists pane previews that list's items;
 * `enter` commits it as the active list and opens the items pane. `tab`
 * switches panes. Inline text input for names/tasks (printable chars,
 * backspace, enter confirm, esc cancel).
 *
 * Closure factory: all mutable state (mode, cursors, input buffer, render
 * cache) lives in the factory closure, so the returned handle uses no `this`
 * and survives any wrapper-style hand-off into pi.
 */
export const makeTrackerOverlay = (options: TrackerOverlayOptions): TrackerOverlayHandle => {
  let mode: "lists" | "items" = "lists";
  let listIndex = 0;
  let itemIndex = 0;
  let input: InputMode | null = null;
  let error: string | null = null;

  // Render cache (tui.md "Performance"): lines are reused while the inputs
  // (width, state snapshot, overlay state) are unchanged.
  let cachedWidth: number | undefined;
  let cachedLines: string[] | undefined;
  let cachedState: TrackerState | undefined;
  let cachedSignature: string | undefined;

  const handleInput = (data: string): void => {
    if (input) {
      handleInputMode(data);
      return;
    }
    if (matchesKey(data, Key.escape)) {
      options.onClose();
      return;
    }
    if (matchesKey(data, Key.tab) || matchesKey(data, Key.shift("tab"))) {
      mode = mode === "lists" ? "items" : "lists";
      error = null;
      syncCursors();
      options.requestRender();
      return;
    }
    const state = options.getState();
    const handled = mode === "lists" ? handleListsKey(data, state) : handleItemsKey(data, state);
    if (handled) {
      error = null;
      options.requestRender();
    }
  };

  const render = (width: number): string[] => {
    const theme = options.theme;
    const state = options.getState();
    const signature = thisSignature();
    if (
      cachedLines !== undefined &&
      cachedWidth === width &&
      cachedState === state &&
      cachedSignature === signature
    ) {
      return cachedLines;
    }
    const lines: string[] = [];

    // Lists pane
    const listsHeader =
      mode === "lists" ? theme.fg("accent", theme.bold("Lists")) : theme.fg("muted", "Lists");
    lines.push(truncateToWidth(`  ${listsHeader}`, width));

    if (state.lists.length === 0) {
      lines.push(
        truncateToWidth(`  ${theme.fg("dim", "No lists yet — press n to create one")}`, width),
      );
    } else {
      for (const [index, list] of state.lists.slice(0, MAX_LISTS).entries()) {
        const selected = mode === "lists" && index === listIndex;
        const isActive = list.id === state.activeListId;
        const counts = theme.fg(
          "dim",
          ` (${list.items.filter((i) => i.done).length}/${list.items.length})`,
        );
        const name = isActive ? `${theme.fg("success", "● ")}${list.name}` : list.name;
        if (selected) {
          lines.push(
            truncateToWidth(
              `  ${theme.fg("accent", "→ ")}${theme.fg("accent", name)}${counts}`,
              width,
            ),
          );
        } else {
          lines.push(truncateToWidth(`  ${theme.fg("text", name)}${counts}`, width));
        }
      }
      if (state.lists.length > MAX_LISTS) {
        lines.push(
          truncateToWidth(
            `  ${theme.fg("dim", `... ${state.lists.length - MAX_LISTS} more`)}`,
            width,
          ),
        );
      }
    }

    lines.push("");

    // Items pane
    const activeListFor = activeList(state);
    const itemsHeader = theme.fg(
      mode === "items" ? "accent" : "muted",
      mode === "items"
        ? theme.bold(`Items — ${activeListFor?.name ?? "(no list)"}`)
        : `Items — ${activeListFor?.name ?? "(no list)"}`,
    );
    lines.push(truncateToWidth(`  ${itemsHeader}`, width));

    if (!activeListFor) {
      const hint =
        state.lists.length === 0
          ? "No lists yet — press n to create one"
          : "No active list — select one in the lists pane (enter)";
      lines.push(truncateToWidth(`  ${theme.fg("dim", hint)}`, width));
    } else if (activeListFor.items.length === 0) {
      lines.push(truncateToWidth(`  ${theme.fg("dim", "No items — press a to add")}`, width));
    } else {
      for (const [index, item] of activeListFor.items.slice(0, MAX_ITEMS).entries()) {
        const selected = mode === "items" && index === itemIndex;
        const prefix = selected ? theme.fg("accent", "→ ") : "  ";
        const check = item.done ? theme.fg("success", "✓") : theme.fg("dim", "○");
        const text = item.done ? theme.fg("muted", theme.strikethrough(item.text)) : item.text;
        lines.push(truncateToWidth(`${prefix}${check} ${text}`, width));
      }
      if (activeListFor.items.length > MAX_ITEMS) {
        lines.push(
          truncateToWidth(
            `  ${theme.fg("dim", `... ${activeListFor.items.length - MAX_ITEMS} more`)}`,
            width,
          ),
        );
      }
    }

    // Input prompt / error line
    if (input) {
      lines.push("");
      const prompt =
        input.kind === "newList"
          ? "New list name"
          : input.kind === "addItem"
            ? "Item text"
            : "Edit item text";
      lines.push(truncateToWidth(`  ${theme.fg("accent", `${prompt}:`)} ${input.buffer}▌`, width));
      lines.push(truncateToWidth(`  ${theme.fg("dim", "enter confirm · esc cancel")}`, width));
    } else if (error) {
      lines.push("");
      lines.push(truncateToWidth(`  ${theme.fg("warning", `! ${error}`)}`, width));
    }

    // Help
    lines.push("");
    const help =
      mode === "lists"
        ? "[tab] items · [n] new · [d] delete · [space] toggle · [↑↓] move · [enter] active · [esc] close"
        : "[tab] lists · [a] add · [x] toggle · [e] edit · [r] remove · [↑↓] move · [esc] close";
    lines.push(truncateToWidth(`  ${theme.fg("dim", help)}`, width));

    cachedWidth = width;
    cachedLines = lines;
    cachedState = state;
    cachedSignature = signature;
    return lines;
  };

  const invalidate = (): void => {
    cachedWidth = undefined;
    cachedLines = undefined;
    cachedState = undefined;
    cachedSignature = undefined;
  };

  /**
   * Fingerprint of the overlay's own mutable state, used as part of the
   * render-cache key. The state snapshot is compared by object identity:
   * the store is immutable, so any mutation produces a fresh snapshot.
   */
  const thisSignature = (): string => {
    const inputPart = input === null ? "" : `${input.kind}:${input.buffer}`;
    return `${mode}:${listIndex}:${itemIndex}:${error ?? ""}:${inputPart}`;
  };

  const activeList = (state: TrackerState): TodoList | undefined => {
    // The items pane previews the list under the cursor while browsing the
    // lists pane; in items mode it follows the explicitly active list (the
    // one committed with enter), so item edits always target the active list.
    if (mode === "lists") {
      return state.lists[listIndex];
    }
    return state.lists.find((list) => list.id === state.activeListId);
  };

  const handleListsKey = (data: string, state: TrackerState): boolean => {
    const lists = state.lists;
    if (lists.length === 0) {
      if (data === "n") {
        input = { kind: "newList", buffer: "" };
        return true;
      }
      return false;
    }
    if (matchesKey(data, Key.up)) {
      listIndex = (listIndex - 1 + lists.length) % lists.length;
      return true;
    }
    if (matchesKey(data, Key.down)) {
      listIndex = (listIndex + 1) % lists.length;
      return true;
    }
    if (matchesKey(data, Key.enter)) {
      const list = lists[listIndex]!;
      void runAction({ type: "setActive", listId: list.id }, () => {
        mode = "items";
        itemIndex = 0;
      });
      return true;
    }
    if (data === "n") {
      input = { kind: "newList", buffer: "" };
      return true;
    }
    if (data === "d") {
      const list = lists[listIndex]!;
      void runAction({ type: "deleteList", listId: list.id });
      return true;
    }
    if (data === " " || matchesKey(data, Key.space)) {
      // Toggle the highlighted list: selecting another list makes it active,
      // toggling the already-active list deselects it (hiding the widget).
      const list = lists[listIndex]!;
      const target = state.activeListId === list.id ? null : list.id;
      void runAction({ type: "setActive", listId: target });
      return true;
    }
    return false;
  };

  const handleItemsKey = (data: string, state: TrackerState): boolean => {
    const list = activeList(state);
    if (!list) {
      if (data === "n") {
        input = { kind: "newList", buffer: "" };
        return true;
      }
      return false;
    }
    const items = list.items;
    if (matchesKey(data, Key.up)) {
      if (items.length > 0) itemIndex = (itemIndex - 1 + items.length) % items.length;
      return true;
    }
    if (matchesKey(data, Key.down)) {
      if (items.length > 0) itemIndex = (itemIndex + 1) % items.length;
      return true;
    }
    if (matchesKey(data, Key.enter) || data === "x") {
      const item = items[itemIndex];
      if (!item) return true;
      void runAction({
        type: "updateItem",
        itemId: `${list.name}:${itemIndex + 1}`,
        patch: { done: !item.done },
      });
      return true;
    }
    if (data === "a") {
      input = { kind: "addItem", listId: list.id, buffer: "" };
      return true;
    }
    if (data === "e") {
      const item = items[itemIndex];
      if (!item) return true;
      input = {
        kind: "editItem",
        itemId: `${list.name}:${itemIndex + 1}`,
        buffer: item.text,
      };
      return true;
    }
    if (data === "r") {
      const item = items[itemIndex];
      if (!item) return true;
      void runAction({ type: "removeItem", itemId: `${list.name}:${itemIndex + 1}` });
      return true;
    }
    if (data === "n") {
      input = { kind: "newList", buffer: "" };
      return true;
    }
    return false;
  };

  const handleInputMode = (data: string): void => {
    const current = input;
    if (!current) return;
    if (matchesKey(data, Key.escape)) {
      input = null;
      error = null;
    } else if (matchesKey(data, Key.enter)) {
      input = null;
      const action: TrackerUiAction =
        current.kind === "newList"
          ? { type: "createList", name: current.buffer }
          : current.kind === "addItem"
            ? { type: "addItem", listId: current.listId, text: current.buffer }
            : {
                type: "updateItem",
                itemId: current.itemId,
                patch: { text: current.buffer },
              };
      void runAction(action);
    } else if (matchesKey(data, Key.backspace)) {
      current.buffer = current.buffer.slice(0, -1);
    } else if (data.length === 1 && data.charCodeAt(0) >= 32) {
      // Printable character (single UTF-16 code unit).
      current.buffer += data;
    }
    options.requestRender();
  };

  const runAction = async (action: TrackerUiAction, afterSuccess?: () => void): Promise<void> => {
    const actionError = await options.onAction(action);
    if (actionError) {
      error = actionError;
    } else {
      error = null;
      afterSuccess?.();
      syncCursors();
    }
    options.requestRender();
  };

  const syncCursors = (): void => {
    const state = options.getState();
    const lists = state.lists;
    listIndex = lists.length === 0 ? 0 : clamp(listIndex, 0, lists.length - 1);
    const list = activeList(state);
    const items = list?.items ?? [];
    itemIndex = items.length === 0 ? 0 : clamp(itemIndex, 0, items.length - 1);
  };

  return { render, invalidate, handleInput };
};
