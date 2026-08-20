/**
 * Static metadata for the tracker tool: action enum, parameter schema, result
 * contract, and the prompt-facing strings. Everything here is free of runtime
 * state; behavior (execute and rendering) lives in index.ts.
 */
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { Static } from "typebox";
import type { TodoItem, TodoList } from "./domain.ts";
import type { EncodedState } from "./persistence.ts";

/** Tracker tool actions, in the same order as the store operations. */
export const TOOL_ACTIONS = [
  "list",
  "create_list",
  "delete_list",
  "set_active",
  "add_item",
  "update_item",
  "remove_item",
] as const;

export type TrackerToolAction = (typeof TOOL_ACTIONS)[number];

export const TRACKER_TOOL_NAME = "tracker";
export const TRACKER_TOOL_LABEL = "Tracker";

/**
 * Parameter schema for the tracker tool.
 *
 * The schema enforces *types* (strings, numbers, array shapes, the action
 * enum) but stays permissive about field presence and unknown fields: those
 * are validated at runtime by `validateTrackerCall`, so every incorrect call
 * receives a precise, actionable error message instead of a generic schema
 * rejection.
 */
export const TrackerToolParams = Type.Object({
  action: StringEnum(TOOL_ACTIONS, { description: "Tracker operation to perform" }),
  list_id: Type.Optional(
    Type.Number({
      description:
        "List id, as shown by the list action. Required for delete_list, add_item, and for update_item's items={...} batch; optional for set_active (omit to deselect).",
    }),
  ),
  item_id: Type.Optional(
    Type.String({
      description:
        'Item id, as shown by the list action: listName:index (1-based position in the list, e.g. "Work:2"). Required for update_item (scalar form) and remove_item.',
    }),
  ),
  name: Type.Optional(
    Type.String({ description: "Name for the new list. Required for create_list." }),
  ),
  initial_items: Type.Optional(
    Type.Array(Type.String({ description: "Item text." }), {
      description: "For create_list: initial items, added when the list is created.",
      minItems: 1,
    }),
  ),
  activate: Type.Optional(
    Type.Boolean({
      description:
        "For create_list: switch the active list to the new list (defaults to true; pass false to keep the current active list).",
    }),
  ),
  text: Type.Optional(
    Type.Union(
      [
        Type.String({
          description:
            "Item text. For add_item: the text of a new item. For update_item: the replacement text.",
        }),
        Type.Array(Type.String({ description: "Item text." }), {
          description: "For add_item: several item texts to add in one call.",
          minItems: 1,
        }),
      ],
      { description: "Item text: a single string, or (add_item only) an array of strings." },
    ),
  ),
  done: Type.Optional(
    Type.Boolean({ description: "For update_item: true marks the item done, false reopens it." }),
  ),
  items: Type.Optional(
    Type.Array(
      Type.Object(
        {
          index: Type.Number({
            description:
              '1-based position of the item within list_id (e.g. 2 for the second item).',
          }),
          text: Type.Optional(Type.String({ description: "Replacement text for the item." })),
          done: Type.Optional(
            Type.Boolean({ description: "true marks the item done, false reopens it." }),
          ),
        },
        // Patch objects are strict: a typo inside an item update fails here.
        { additionalProperties: false },
      ),
      {
        description:
          "For update_item: one or more item updates within a single list_id (mirrors add_item's list_id + text[]). Alternative to item_id/text/done.",
        minItems: 1,
      },
    ),
  ),
});

export type TrackerToolParams = Static<typeof TrackerToolParams>;

/** Parameters each action accepts (besides `action` itself). */
const ACTION_PARAMS: Readonly<Record<TrackerToolAction, readonly string[]>> = {
  list: [],
  create_list: ["name", "initial_items", "activate"],
  delete_list: ["list_id"],
  set_active: ["list_id"],
  add_item: ["list_id", "text"],
  update_item: ["list_id", "item_id", "text", "done", "items"],
  remove_item: ["item_id"],
};

/** Outcome of `validateTrackerCall`; on success the params are safe to use. */
export type TrackerCallValidation =
  | { ok: true; params: TrackerToolParams }
  | { ok: false; message: string };

/**
 * Runtime validation for a tracker call — the error-nudging layer.
 *
 * The parameter schema only enforces types; this checks what the schema
 * cannot express (presence of required fields per action, unknown fields,
 * the mutually exclusive update_item forms) and returns an actionable error
 * message naming exactly what to fix. `execute` surfaces that message to the
 * agent, so an incorrect call self-corrects on the next attempt.
 */
export function validateTrackerCall(args: unknown): TrackerCallValidation {
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    return { ok: false, message: "tracker arguments must be an object with an 'action' field" };
  }
  const record = args as Record<string, unknown>;
  const action = record.action;
  if (typeof action !== "string" || !(TOOL_ACTIONS as readonly string[]).includes(action)) {
    return {
      ok: false,
      message: `Unknown tracker action ${JSON.stringify(action)} — expected one of: ${TOOL_ACTIONS.join(", ")}`,
    };
  }
  const typed = action as TrackerToolAction;
  const allowed = ACTION_PARAMS[typed];
  const unexpected = Object.keys(record).filter(
    (key) => key !== "action" && !allowed.includes(key),
  );
  if (unexpected.length > 0) {
    return {
      ok: false,
      message:
        allowed.length === 0
          ? `tracker ${typed} accepts no parameters — unexpected: ${unexpected.join(", ")}`
          : `tracker ${typed} does not accept ${unexpected.join(", ")} — it accepts: ${allowed.join(", ")}`,
    };
  }
  switch (typed) {
    case "create_list":
      if (record.name === undefined) {
        return {
          ok: false,
          message: "create_list requires the 'name' parameter (the new list's name).",
        };
      }
      break;
    case "delete_list":
      if (record.list_id === undefined) {
        return { ok: false, message: "delete_list requires the 'list_id' parameter." };
      }
      break;
    case "add_item":
      if (record.list_id === undefined) {
        return { ok: false, message: "add_item requires the 'list_id' parameter." };
      }
      if (record.text === undefined) {
        return {
          ok: false,
          message:
            "add_item requires the 'text' parameter (a string, or an array of strings for several items).",
        };
      }
      break;
    case "update_item":
      if (record.items !== undefined) {
        // Batch form: list_id + items (index-based, one list).
        if (
          record.item_id !== undefined ||
          record.text !== undefined ||
          record.done !== undefined
        ) {
          return {
            ok: false,
            message:
              "update_item: pass either item_id/text/done (one item) or list_id + items (several items in one list), not both.",
          };
        }
        if (record.list_id === undefined) {
          return {
            ok: false,
            message:
              "update_item with 'items' requires the 'list_id' parameter (the list whose items are being updated).",
          };
        }
      } else if (record.item_id === undefined) {
        return {
          ok: false,
          message:
            "update_item requires 'item_id' (one item) or 'list_id' + 'items' (several items in one list).",
        };
      } else if (Array.isArray(record.text)) {
        return {
          ok: false,
          message:
            "update_item: 'text' must be a single string — use 'items' to update several items in one call.",
        };
      }
      break;
    case "remove_item":
      if (record.item_id === undefined) {
        return { ok: false, message: "remove_item requires the 'item_id' parameter." };
      }
      break;

    default:
      // list and set_active need nothing beyond `action` (set_active may omit list_id to deselect).
      break;
  }
  return { ok: true, params: args as TrackerToolParams };
}

/** Structured result payload attached to tool calls, consumed by the renderers. */
export interface TrackerToolDetails {
  action: TrackerToolAction;
  error?: string;
  listId?: number;
  /** `listName:index`, as shown by the list action. */
  itemId?: string;
  list?: TodoList;
  /** Items affected by an add_item/update_item call, in creation/patch order. */
  items?: TodoItem[];
  /** Full state snapshot, only for the `list` action (for rendering). */
  snapshot?: EncodedState;
}

/**
 * Anti-pattern guard: the tracker guideline says to mark each item done in
 * the same turn it completes and never batch the marking at the end. A call
 * that marks two or more items done at once AND leaves no open items behind is
 * the terminal-batch signature — the agent did all its work, then finished the
 * list in one sweep. Returns a reminder (or null when the call is fine); it is
 * advisory text, never a rejection, so legitimate same-turn multi-completions
 * (when work is still open) still pass silently.
 *
 * @param patches the update_item patches in call order.
 * @param openRemaining number of not-done items across all lists *after* the
 *   call (0 means the batch cleared the whole tracker). Pass undefined when
 *   the post-call state isn't known.
 */
export const doneMarkReminder = (
  patches: readonly { readonly done?: boolean }[],
  openRemaining?: number,
): string | null => {
  const doneCount = patches.filter((patch) => patch.done === true).length;
  // Only the terminal batch — two or more done marks with nothing left open —
  // is flagged. Batches that finish several items while other work remains are
  // normal mid-turn progress and stay quiet. When the post-call open count is
  // unknown (not 0) we stay quiet rather than guess at a terminal batch.
  if (doneCount < 2) return null;
  if (openRemaining !== 0) return null;
  return (
    `Note: this call completed ${doneCount} items at once and left no open items — the tracker ` +
    "guideline is to mark each item done in the same turn it completes, not batch the marking at the end."
  );
};

const TRACKER_TOOL_DESCRIPTION =
  "Manage todolists and track progress. Use for task lists, checklists, milestones, and step-by-step " +
  "work; keep track of tasks with tracker instead of in chat or files. Work through items one at a " +
  "time, marking each done as it completes, so the list is the live working state.\n" +
  'Item ids are listName:index — the 1-based position of the item in its list, e.g. "Work:2" (copy ' +
  "them from the list action output). Removing an item renumbers the items after it, so list again " +
  "before referencing items after a removal.\n" +
  "The tracker tool is strict: each action accepts only its own parameters — any other argument is " +
  "rejected. Parameter contract per action:\n" +
  "- list: no parameters\n" +
  "- create_list: name (required), initial_items (optional array of item texts, added when the " +
  "list is created), activate (optional, defaults to true: the new list becomes active; pass false " +
  "to keep the current active list)\n" +
  "- delete_list: list_id (required)\n" +
  "- set_active: list_id (omit the field to deselect)\n" +
  "- add_item: list_id (required), text (required: a string, or an array of strings to add several " +
  "items in one call)\n" +
  "- update_item: update several items in one list with list_id (required) + items=[{index, " +
  "text?, done?}, ...] — just like add_item's list_id + text[] (index is the item's 1-based " +
  "position in that list), or one item with item_id + optional text/done. Never mix the two " +
  "forms. Example: update_item list_id=2 items=[{index: 2, done: true}, {index: 3, text: \"Ship " +
  "the fix\"}]\n" +
  "- remove_item: item_id (required, listName:index)";

const TRACKER_TOOL_PROMPT_SNIPPET =
  "Manage todolists and track progress: create lists with initial items, add/update/remove items. " +
  "Batch adds with text arrays and updates with update_item list_id + items=[...] in one call";

const TRACKER_TOOL_PROMPT_GUIDELINES = [
  "Use tracker for todo lists, checklists, and multi-step work. Put progress in tracker, not in prose.",
  "Break work into tracker items up front. One item per deliverable. Mark an item done in the same turn it completes. Never batch the marking at the end. Batch related adds and updates in one call — use update_item's list_id + items=[...] form to update several entries in one list at once.",
  "Before starting work, call tracker with action list. Work from the list, not from memory. Re-check it when the task drifts.",
  "Copy tracker item ids (listName:index, e.g. Work:2) from the list action output; removing an item renumbers the items after it.",
  "When a tracker call fails, read the error. It tells you what to fix. Not-found errors name the available ids. Retry with corrected parameters in the same turn. Never repeat the same failing call.",
  "The tracker widget shows the active list. create_list makes the new list active by default; pass activate: false to keep the current one. Use set_active to show or hide a list.",
];

/** Metadata block spread into `pi.registerTool` in index.ts. */
export const TRACKER_TOOL_METADATA = {
  name: TRACKER_TOOL_NAME,
  label: TRACKER_TOOL_LABEL,
  description: TRACKER_TOOL_DESCRIPTION,
  promptSnippet: TRACKER_TOOL_PROMPT_SNIPPET,
  promptGuidelines: TRACKER_TOOL_PROMPT_GUIDELINES,
  parameters: TrackerToolParams,
  executionMode: "sequential",
} as const;
