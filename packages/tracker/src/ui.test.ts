import { assert, it } from "@effect/vitest";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { TodoItem, TodoList, TrackerState } from "./domain.ts";
import {
  makeTrackerOverlay,
  makeTrackerWidget,
  planWidgetItems,
  renderTrackerWidget,
  type TrackerOverlayHandle,
  type TrackerUiAction,
  type WidgetRow,
} from "./ui.ts";

/**
 * Identity theme: styles pass text through unchanged, so render output is
 * plain text that assertions can search. The overlay and widget only use
 * `fg`, `bold` and `strikethrough`, which this stub covers.
 */
const identityTheme = {
  fg: (_color: string, text: string): string => text,
  bold: (text: string): string => text,
  strikethrough: (text: string): string => text,
} as unknown as Theme;

/** A realistic two-list state: Work is the active list. */
const twoListState = (): TrackerState =>
  new TrackerState({
    lists: [
      new TodoList({
        id: 1,
        name: "Work",
        items: [
          new TodoItem({ text: "write plan", done: true }),
          new TodoItem({ text: "implement tracker", done: false }),
        ],
      }),
      new TodoList({
        id: 2,
        name: "Home",
        items: [new TodoItem({ text: "water plants", done: false })],
      }),
    ],
    activeListId: 1,
    nextListId: 3,
  });

/** Assert `text` does not contain `needle` (@effect/vitest lacks doesNotMatch). */
const notContain = (text: string, needle: string): void => {
  assert.equal(
    text.includes(needle),
    false,
    `expected text not to contain ${JSON.stringify(needle)}`,
  );
};

interface OverlayHarness {
  readonly overlay: TrackerOverlayHandle;
  readonly actions: TrackerUiAction[];
}

/**
 * Build an overlay over a scripted state. `onAction` mirrors the real
 * bridge's `set_active` handling (the only action the tests exercise), so
 * the snapshot passed to `getState` follows the same object-identity rules
 * as the live mirror in `src/index.ts`.
 */
const makeOverlay = (initial: TrackerState): OverlayHarness => {
  let current = initial;
  const actions: TrackerUiAction[] = [];
  const overlay = makeTrackerOverlay({
    getState: () => current,
    theme: identityTheme,
    requestRender: () => {},
    onAction: async (action) => {
      actions.push(action);
      if (action.type === "setActive") {
        current = new TrackerState({ ...current, activeListId: action.listId });
      }
      return null;
    },
    onClose: () => {},
  });
  return { overlay, actions };
};

/** Flush the microtask queue so fire-and-forget `runAction` continuations land. */
const flushAsync = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

// --------------------------------------------------------------------------
// Interactive overlay: items pane follows the focused list
// --------------------------------------------------------------------------

it("previews the focused list's items while navigating the lists pane", () => {
  const h = makeOverlay(twoListState());
  const text = () => h.overlay.render(80).join("\n");

  // The cursor starts on the active list (Work) and previews its items.
  assert.match(text(), /Items — Work/);
  assert.match(text(), /write plan/);

  // Moving the cursor to Home previews Home's items instead of the active
  // list's — the reported bug (items pane stuck on the active list).
  h.overlay.handleInput("\x1b[B");
  assert.match(text(), /Items — Home/);
  assert.match(text(), /water plants/);
  notContain(text(), "write plan");

  // And back.
  h.overlay.handleInput("\x1b[A");
  assert.match(text(), /Items — Work/);
  assert.match(text(), /write plan/);
});

it("enter commits the focused list as active and opens its items", async () => {
  const h = makeOverlay(twoListState());
  h.overlay.handleInput("\x1b[B"); // focus Home
  h.overlay.handleInput("\r"); // commit
  await flushAsync();

  assert.deepStrictEqual(h.actions, [{ type: "setActive", listId: 2 }]);
  const text = h.overlay.render(80).join("\n");
  assert.match(text, /Items — Home/);
  assert.match(text, /water plants/);
});

it("items pane follows the active list in items mode (preview is not a commit)", () => {
  const h = makeOverlay(twoListState());
  h.overlay.handleInput("\x1b[B"); // preview Home
  h.overlay.handleInput("\t"); // switch to items without committing
  const text = h.overlay.render(80).join("\n");

  // No enter was pressed, so the items pane still targets the active list.
  assert.match(text, /Items — Work/);
  assert.match(text, /write plan/);
});

// --------------------------------------------------------------------------
// Render caching (tui.md "Performance" / "Invalidation and Theme Changes")
// --------------------------------------------------------------------------

it("overlay caches render output and clears it on invalidate (theme change)", () => {
  const h = makeOverlay(twoListState());
  const first = h.overlay.render(80);

  // Same width, unchanged inputs: the exact cached lines are returned.
  assert.strictEqual(h.overlay.render(80), first);

  // Width change: recomputed.
  assert.notStrictEqual(h.overlay.render(120), first);

  // invalidate() (called by the TUI on theme changes) clears the cache.
  h.overlay.invalidate();
  assert.notStrictEqual(h.overlay.render(80), first);
});

it("overlay recomputes when the state snapshot changes", () => {
  const h = makeOverlay(twoListState());
  const first = h.overlay.render(80);

  // Space toggles the active list; the bridge swaps in a fresh snapshot.
  // Same width and overlay signature, but new state identity: recompute.
  h.overlay.handleInput(" ");
  assert.notStrictEqual(h.overlay.render(80), first);
});

it("overlay recomputes when the cursor moves", () => {
  const h = makeOverlay(twoListState());
  const first = h.overlay.render(80);

  h.overlay.handleInput("\x1b[B"); // listIndex changed → signature changed
  assert.notStrictEqual(h.overlay.render(80), first);
  assert.match(h.overlay.render(80).join("\n"), /Items — Home/);
});

// --------------------------------------------------------------------------
// Widget pane
// --------------------------------------------------------------------------

it("widget renders the active list's items", () => {
  const lines = renderTrackerWidget(twoListState(), identityTheme, 40);
  const text = lines.join("\n");
  assert.match(text, /Work \(1\/2\)/);
  assert.match(text, /write plan/);
  notContain(text, "water plants");
});

it("widget renders nothing when no list is active (bridge hides it)", () => {
  const state = new TrackerState({ ...twoListState(), activeListId: null });
  assert.deepStrictEqual(renderTrackerWidget(state, identityTheme, 40), []);
});

it("widget survives the setWidget bridge wrapper (render/invalidate handed off by reference)", () => {
  // Mirrors the tracker bridge: `return { render: widget.render, invalidate: widget.invalidate }`.
  // pi calls render as a method of the wrapper; closure components carry no
  // `this`, so the hand-off is safe by construction (resume-crash regression).
  // oxlint-disable typescript/unbound-method -- intentional seam regression:
  // closure components must survive detached hand-off.
  const widget = makeTrackerWidget(twoListState(), identityTheme);
  const wrapper = { render: widget.render, invalidate: widget.invalidate };
  // oxlint-enable typescript/unbound-method
  const lines = wrapper.render(40);
  assert.match(lines.join("\n"), /Work \(1\/2\)/);
  wrapper.invalidate();
  assert.match(wrapper.render(40).join("\n"), /Work \(1\/2\)/);
  assert.deepStrictEqual(wrapper.render(40), lines);
});

// --------------------------------------------------------------------------
// Widget collapse planning (lists larger than the row budget)
// --------------------------------------------------------------------------

/** A list of `count` items; the first `done` items are done. */
const listOfCount = (count: number, done: number): TodoList =>
  new TodoList({
    id: 1,
    name: "Work",
    items: Array.from(
      { length: count },
      (_, index) => new TodoItem({ text: `item ${index + 1}`, done: index < done }),
    ),
  });

const stateWith = (list: TodoList): TrackerState =>
  new TrackerState({ lists: [list], activeListId: list.id, nextListId: 2 });

const shownIndexes = (rows: readonly WidgetRow[]): number[] =>
  rows.flatMap((row) => (row.kind === "item" ? [row.index] : []));

const ellipsisCount = (rows: readonly WidgetRow[]): number =>
  rows.filter((row) => row.kind === "ellipsis").length;

it("planner returns every item with no ellipsis when the list fits", () => {
  const plan = planWidgetItems(listOfCount(3, 1).items, 12);
  assert.deepStrictEqual(shownIndexes(plan), [0, 1, 2]);
  assert.strictEqual(ellipsisCount(plan), 0);
});

it("planner keeps the first item, the current item, and the last item inside the budget", () => {
  // The first 12 items are done, so item 13 (index 12) is current.
  const plan = planWidgetItems(listOfCount(30, 12).items, 12);
  const shown = shownIndexes(plan);

  assert.isAtMost(plan.length, 12);
  assert.include(shown, 0);
  assert.include(shown, 12);
  assert.include(shown, 29);
  // The window leaves a hidden gap on each side of itself.
  assert.strictEqual(ellipsisCount(plan), 2);
});

it("planner omits the leading ellipsis when the window touches the first item", () => {
  // Nothing is done, so item 1 (index 0) is current and the window starts there.
  const plan = planWidgetItems(listOfCount(30, 0).items, 12);
  const shown = shownIndexes(plan);

  assert.deepStrictEqual(shown.slice(0, 2), [0, 1]);
  assert.include(shown, 29);
  assert.strictEqual(ellipsisCount(plan), 1);
});

it("planner follows the current item as work progresses", () => {
  const early = planWidgetItems(listOfCount(40, 3).items, 12);
  const late = planWidgetItems(listOfCount(40, 35).items, 12);

  assert.include(shownIndexes(early), 3);
  assert.include(shownIndexes(late), 35);
  // The window moves with the current item, so each plan hides the other's
  // current position.
  assert.equal(shownIndexes(early).includes(35), false);
  assert.equal(shownIndexes(late).includes(3), false);
});

it("planner anchors the last item when every item is done", () => {
  const plan = planWidgetItems(listOfCount(30, 30).items, 12);
  assert.include(shownIndexes(plan), 0);
  assert.include(shownIndexes(plan), 29);
  assert.isAtMost(plan.length, 12);
});

it("planner emits an ellipsis between rendered items only when items are hidden", () => {
  // Property: each gap between consecutive rendered items is at least two
  // indexes wide, and every such gap has exactly one ellipsis row.
  for (const done of [0, 5, 17, 29]) {
    const plan = planWidgetItems(listOfCount(30, done).items, 12);
    const shown = shownIndexes(plan);
    let expectedEllipses = 0;
    for (let i = 1; i < shown.length; i += 1) {
      if (shown[i]! > shown[i - 1]! + 1) expectedEllipses += 1;
    }
    assert.strictEqual(ellipsisCount(plan), expectedEllipses, `done=${done}`);
  }
});

it("widget renders a vertical ellipsis and hides collapsed items", () => {
  const list = listOfCount(30, 5);
  const text = renderTrackerWidget(stateWith(list), identityTheme, 60).join("\n");

  assert.match(text, /⋮/);
  // The rendered item rows stay within the budget instead of printing all 30.
  const itemLines = text.split("\n").filter((line) => /item \d+/.test(line));
  assert.isAtMost(itemLines.length, 12);
});

// --------------------------------------------------------------------------
// Current item marker
// --------------------------------------------------------------------------

it("marks the current item (first not-done) with a filled circle", () => {
  // Item 1 is done, so item 2 is the current item.
  const text = renderTrackerWidget(stateWith(listOfCount(4, 1)), identityTheme, 40).join("\n");

  assert.match(text, /● item 2/);
  assert.match(text, /○ item 3/);
  assert.match(text, /✓ item 1/);
  // Only the current item carries the filled circle.
  assert.equal(text.includes("● item 1"), false);
  assert.equal(text.includes("● item 3"), false);
});

it("marks no item as current when every item is done", () => {
  const text = renderTrackerWidget(stateWith(listOfCount(3, 3)), identityTheme, 40).join("\n");
  assert.equal(text.includes("●"), false);
});
