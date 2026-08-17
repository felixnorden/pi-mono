import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { makeBorderedBox } from "@ftrdotdev/pi-tui";
import { Effect, Layer, ManagedRuntime, Option, Result } from "effect";
import { TodoItem, TodoList, TrackerState, emptyState, encodeState } from "./domain.ts";
import { TrackerPersistence } from "./persistence.ts";
import { TrackerError, TrackerStore, type UpdateItemPatch } from "./store.ts";
import {
  TRACKER_TOOL_METADATA,
  doneMarkReminder,
  validateTrackerCall,
  type TrackerToolAction,
  type TrackerToolDetails,
  type TrackerToolParams,
} from "./tool-metadata.ts";
import { makeTrackerOverlay, makeTrackerWidget, type TrackerUiAction } from "./ui.ts";

/** Custom-entry type used to persist the tracker state in the session. */
const CUSTOM_TYPE = "tracker/state";

// --------------------------------------------------------------------------
// Effect bridge
// --------------------------------------------------------------------------

/**
 * Run a store operation: `TrackerStore` (the service key) is itself an
 * Effect that yields the service instance.
 */
const withStore = <A, E>(
  f: (store: TrackerStore["Service"]) => Effect.Effect<A, E>,
): Effect.Effect<A, E, TrackerStore> => Effect.flatMap(TrackerStore, f);

const withPersistence = <A, E>(
  f: (persistence: TrackerPersistence["Service"]) => Effect.Effect<A, E>,
): Effect.Effect<A, E, TrackerPersistence> => Effect.flatMap(TrackerPersistence, f);

/** Throw for a missing required tool parameter; caught in `execute`. */
const requireParam = <T>(value: T | undefined, name: string): T => {
  if (value === undefined) throw new Error(`${name} is required for this tracker action`);
  return value;
};

// --------------------------------------------------------------------------
// Extension
// --------------------------------------------------------------------------

export default function (pi: ExtensionAPI): void {
  const runtime = ManagedRuntime.make(
    TrackerStore.layer.pipe(
      Layer.provideMerge(
        TrackerPersistence.layer((encoded) => pi.appendEntry(CUSTOM_TYPE, encoded)),
      ),
    ),
  );

  /** Mirror of the store state, read by the widget and tool renderers. */
  let state: TrackerState = emptyState();

  const buildToolProgram = (
    params: TrackerToolParams,
  ): Effect.Effect<unknown, TrackerError, TrackerStore> => {
    switch (params.action) {
      case "list":
        return withStore((store) => store.state);
      case "create_list":
        return withStore((store) =>
          store.createList(requireParam(params.name, "name"), {
            activate: params.activate ?? true,
            ...(params.initial_items !== undefined ? { initialItems: params.initial_items } : {}),
          }),
        );
      case "delete_list":
        return withStore((store) => store.deleteList(requireParam(params.list_id, "list_id")));
      case "set_active":
        return withStore((store) => store.setActiveList(params.list_id ?? null));
      case "add_item": {
        const raw = requireParam(params.text, "text");
        const texts = Array.isArray(raw) ? raw : [raw];
        return withStore((store) => store.addItems(requireParam(params.list_id, "list_id"), texts));
      }
      case "update_item": {
        if (params.items !== undefined) {
          // Wire format is snake_case (item_id); the store uses itemId.
          const batch = params.items.map(({ item_id, ...patch }) => ({
            itemId: item_id,
            ...patch,
          }));
          return withStore((store) => store.updateItems(batch));
        }
        const patch: UpdateItemPatch = {
          ...(params.text !== undefined && !Array.isArray(params.text)
            ? { text: params.text }
            : {}),
          ...(params.done !== undefined ? { done: params.done } : {}),
        };
        return withStore((store) =>
          store.updateItems([{ itemId: requireParam(params.item_id, "item_id"), ...patch }]),
        );
      }
      case "remove_item":
        return withStore((store) => store.removeItem(requireParam(params.item_id, "item_id")));
    }
  };

  const uiActionProgram = (
    action: TrackerUiAction,
  ): Effect.Effect<unknown, TrackerError, TrackerStore> => {
    switch (action.type) {
      case "createList":
        return withStore((store) => store.createList(action.name));
      case "deleteList":
        return withStore((store) => store.deleteList(action.listId));
      case "setActive":
        return withStore((store) => store.setActiveList(action.listId));
      case "addItem":
        return withStore((store) => store.addItem(action.listId, action.text));
      case "updateItem":
        return withStore((store) => store.updateItem(action.itemId, action.patch));
      case "removeItem":
        return withStore((store) => store.removeItem(action.itemId));
    }
  };

  /**
   * Persist the current store state and refresh the widget pane. Called after
   * every successful mutation, from both the tool and the /tracker UI, so the
   * two entry points can never diverge.
   */
  const applyMutation = async (ctx: ExtensionContext): Promise<void> => {
    state = await runtime.runPromise(withStore((store) => store.state));
    await runtime.runPromise(
      withPersistence((p) => p.save(state)).pipe(
        Effect.catch((err) =>
          Effect.logWarning(
            `tracker: persist failed: ${err instanceof Error ? err.message : String(err)}`,
          ),
        ),
      ),
    );
    refreshWidget(ctx);
  };

  const refreshWidget = (ctx: ExtensionContext): void => {
    // The widget is the opt-in view of the *active* list: hidden when no list
    // is active (including after a deselect), regardless of list count.
    if (state.activeListId === null) {
      ctx.ui.setWidget("tracker", undefined);
      return;
    }
    ctx.ui.setWidget("tracker", (_tui, theme) => {
      // BorderedBox caches per width; the widget is re-registered on every
      // state change and invalidate() clears the cache on theme changes, so
      // stale themed output (ANSI colors baked into the cached strings) is
      // never served.
      const widget = makeTrackerWidget(state, theme);
      // pi calls render/invalidate as methods of the object returned here,
      // so hand over arrows, never detached methods — an unbound reference
      // would rebind `this` to this wrapper and crash inside BorderedBox.
      return {
        render: (width) => widget.render(width),
        invalidate: () => widget.invalidate(),
      };
    });
  };

  /** Rebuild state from the latest tracker custom entry on the current branch. */
  const reconstructState = async (ctx: ExtensionContext): Promise<void> => {
    let snapshot: unknown = null;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === CUSTOM_TYPE) {
        snapshot = entry.data;
      }
    }

    if (snapshot === null) {
      state = emptyState();
    } else {
      const result = await runtime.runPromise(
        Effect.result(withPersistence((p) => p.restore(snapshot))),
      );
      if (Result.isFailure(result)) {
        ctx.ui.notify("tracker: saved state could not be decoded — starting empty", "warning");
        state = emptyState();
      } else {
        state = Option.getOrThrow(Result.getSuccess(result));
      }
    }
    await runtime.runPromise(withStore((store) => store.reset(state)));
    refreshWidget(ctx);
  };

  // --- Session lifecycle -------------------------------------------------

  pi.on("session_start", async (_event, ctx) => {
    await reconstructState(ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    await reconstructState(ctx);
  });

  pi.on("session_shutdown", async () => {
    await runtime.dispose();
  });

  // --- Tool ---------------------------------------------------------------

  const listSummary = (current: TrackerState): string => {
    if (current.lists.length === 0) return "No lists";
    return current.lists
      .map((list) => {
        const done = list.items.filter((item) => item.done).length;
        const active = list.id === current.activeListId ? " (active)" : "";
        const items =
          list.items.length === 0
            ? "  (no items)"
            : list.items
                .map(
                  (item, i) => `  [${item.done ? "x" : " "}] #${list.name}:${i + 1}: ${item.text}`,
                )
                .join("\n");
        return `[${list.id}] ${list.name} — ${done}/${list.items.length}${active}\n${items}`;
      })
      .join("\n");
  };

  const toolSuccess = (
    params: TrackerToolParams,
    value: unknown,
    current: TrackerState,
  ): { content: Array<{ type: "text"; text: string }>; details: TrackerToolDetails } => {
    const details: TrackerToolDetails = { action: params.action };
    let text = "";
    switch (params.action) {
      case "list":
        details.snapshot = encodeState(current);
        text = listSummary(current);
        break;
      case "create_list": {
        const list = value as TodoList;
        details.list = list;
        text = `Created list #${list.id}: ${list.name}`;
        if (list.items.length > 0) {
          text += ` with ${list.items.length} initial item${list.items.length === 1 ? "" : "s"}`;
        }
        if (list.id === current.activeListId) text += " (active)";
        break;
      }
      case "delete_list":
        details.listId = params.list_id;
        text = `Deleted list #${params.list_id}`;
        break;
      case "set_active": {
        details.listId = params.list_id;
        if (params.list_id === undefined) {
          text = "Active list cleared (widget hidden)";
        } else {
          const list = current.lists.find((l) => l.id === params.list_id);
          text = `Active list: ${list ? list.name : `#${params.list_id}`}`;
        }
        break;
      }
      case "add_item": {
        const items = value as TodoItem[];
        const list = current.lists.find((l) => l.id === params.list_id);
        details.list = list;
        details.items = items;
        const listName = list ? list.name : `#${params.list_id}`;
        // The new items are the last ones in the list, so their ids follow
        // directly from the position they now occupy.
        const firstId = list ? list.items.length - items.length + 1 : 1;
        const ids = items.map((_, i) => `${listName}:${firstId + i}`);
        text =
          items.length === 1
            ? `Added item #${ids[0]} to ${listName}: ${items[0]!.text}`
            : `Added ${items.length} items to ${listName}: ${ids.map((id, i) => `#${id}: ${items[i]!.text}`).join(", ")}`;
        break;
      }
      case "update_item": {
        const items = value as TodoItem[];
        details.items = items;
        const patches =
          params.items !== undefined
            ? params.items
            : [{ item_id: params.item_id, text: params.text, done: params.done }];
        const parts = items.map((item, i) => {
          const patch = patches[i]!;
          const changes: string[] = [];
          if (patch.done !== undefined) changes.push(item.done ? "completed" : "uncompleted");
          if (patch.text !== undefined) changes.push(`text: ${item.text}`);
          return `${patch.item_id}${changes.length === 0 ? " (no change)" : ` (${changes.join(", ")})`}`;
        });
        text = `Updated ${items.length} item${items.length === 1 ? "" : "s"}: ${parts.join(", ")}`;
        // Anti-pattern guard: batch-marking done items at once is the
        // terminal-batch signature; the reminder lands in the result so the
        // caller sees it exactly where the behavior happens.
        const reminder = doneMarkReminder(patches);
        if (reminder !== null) text += `\n${reminder}`;
        break;
      }
      case "remove_item":
        details.itemId = params.item_id;
        text = `Removed item ${params.item_id} (items after it renumbered)`;
        break;
    }
    return { content: [{ type: "text", text }], details };
  };

  const toolError = (
    action: TrackerToolAction,
    message: string,
  ): { content: Array<{ type: "text"; text: string }>; details: TrackerToolDetails } => ({
    content: [{ type: "text", text: message }],
    details: { action, error: message },
  });

  pi.registerTool({
    ...TRACKER_TOOL_METADATA,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const action = params.action;
      // Error-nudging gate: reject incorrect calls (missing required fields,
      // unknown fields, mixed update_item forms) with a precise message that
      // tells the agent exactly what to fix, before any state is touched.
      const validation = validateTrackerCall(params);
      if (!validation.ok) {
        return toolError(action, validation.message);
      }
      let program: Effect.Effect<unknown, TrackerError, TrackerStore>;
      try {
        program = buildToolProgram(params);
      } catch (err) {
        return toolError(action, err instanceof Error ? err.message : String(err));
      }

      const result = await runtime.runPromise(Effect.result(program));
      if (Result.isFailure(result)) {
        const failure = Option.getOrThrow(Result.getFailure(result));
        return toolError(action, failure.message);
      }

      if (action !== "list") {
        await applyMutation(ctx);
      }
      return toolSuccess(params, Option.getOrThrow(Result.getSuccess(result)), state);
    },

    renderCall(args, theme, _context) {
      // Args can come from failed validation too, so read them loosely.
      const raw = args as unknown as Record<string, unknown>;
      const action = String(raw.action ?? "list");
      let text = theme.fg("toolTitle", theme.bold("tracker ")) + theme.fg("muted", action);
      if (typeof raw.name === "string") text += ` ${theme.fg("dim", `"${raw.name}"`)}`;
      if (typeof raw.text === "string") {
        text += ` ${theme.fg("dim", `"${raw.text}"`)}`;
      } else if (Array.isArray(raw.text)) {
        text += ` ${theme.fg("dim", raw.text.map((t) => `"${t}"`).join(" "))}`;
      }
      if (Array.isArray(raw.initial_items)) {
        text += ` ${theme.fg("dim", raw.initial_items.map((t) => `"${t}"`).join(" "))}`;
      }
      if (Array.isArray(raw.items)) text += ` ${theme.fg("accent", `${raw.items.length} items`)}`;
      if (raw.activate === false) text += ` ${theme.fg("muted", "(no auto-switch)")}`;
      if (typeof raw.list_id === "number") text += ` ${theme.fg("accent", `#${raw.list_id}`)}`;
      if (typeof raw.item_id === "string") text += ` ${theme.fg("accent", `item #${raw.item_id}`)}`;
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded }, theme, _context) {
      const details = result.details as TrackerToolDetails | undefined;
      if (!details) {
        const text = result.content[0];
        return new Text(text?.type === "text" ? text.text : "", 0, 0);
      }
      if (details.error) {
        return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
      }
      if (details.action === "list") {
        const snapshot = details.snapshot;
        if (!snapshot || snapshot.lists.length === 0) {
          return new Text(theme.fg("dim", "No lists"), 0, 0);
        }
        const parts: string[] = [];
        for (const list of snapshot.lists) {
          const done = list.items.filter((item) => item.done).length;
          const active = list.id === snapshot.activeListId ? " ●" : "";
          parts.push(
            theme.fg("accent", `[${list.id}] ${list.name}`) +
              theme.fg("muted", ` (${done}/${list.items.length})${active}`),
          );
          const display = expanded ? list.items : list.items.slice(0, 5);
          for (const [idx, item] of display.entries()) {
            const check = item.done ? theme.fg("success", "✓") : theme.fg("dim", "○");
            const itemText = item.done ? theme.fg("dim", item.text) : item.text;
            parts.push(`  ${check} ${theme.fg("accent", `#${list.name}:${idx + 1}`)} ${itemText}`);
          }
          if (!expanded && list.items.length > 5) {
            parts.push(theme.fg("dim", `  ... ${list.items.length - 5} more`));
          }
        }
        return new Text(parts.join("\n"), 0, 0);
      }
      const text = result.content[0];
      const msg = text?.type === "text" ? text.text : "";
      return new Text(theme.fg("success", "✓ ") + theme.fg("muted", msg), 0, 0);
    },
  });

  // --- Command ------------------------------------------------------------

  const runUiAction = async (
    ctx: ExtensionContext,
    action: TrackerUiAction,
  ): Promise<string | null> => {
    const result = await runtime.runPromise(Effect.result(uiActionProgram(action)));
    if (Result.isFailure(result)) {
      return Option.getOrThrow(Result.getFailure(result)).message;
    }
    await applyMutation(ctx);
    return null;
  };

  pi.registerCommand("tracker", {
    description: "Open the interactive tracker (lists and items)",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/tracker requires interactive mode", "error");
        return;
      }
      await ctx.ui.custom<void>((tui, theme, _kb, done) => {
        // The overlay content is framed by the same house rounded box as the
        // widget. makeBorderedBox's own cache is disabled so an overlay
        // mutation at an unchanged width is never served stale rails; the
        // overlay caches by its own (width, state, signature) fingerprint.
        const overlay = makeTrackerOverlay({
          getState: () => state,
          theme,
          requestRender: () => tui.requestRender(),
          onAction: (action) => runUiAction(ctx, action),
          onClose: () => done(),
        });
        const framed = makeBorderedBox(overlay, theme, {
          label: "Tracker",
          color: "border",
          cache: false,
        });
        return {
          render: (width) => framed.render(width),
          invalidate: () => framed.invalidate(),
          handleInput: (data) => overlay.handleInput(data),
        };
      });
    },
  });
}
