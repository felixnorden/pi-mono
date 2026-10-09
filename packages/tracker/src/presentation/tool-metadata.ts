/**
 * Static metadata for the tracker tool: action enum, parameter schema, result
 * contract, and the prompt-facing strings. Everything here is free of runtime
 * state; behavior (execute and rendering) lives in index.ts.
 */
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { Static } from "typebox";
import { dependentsOf, formatItemRef, parseItemRef, unsatisfiedDeps } from "../core/deps.ts";
import type { TodoItem, TodoList, TrackerState } from "../core/domain.ts";
import type { EncodedState } from "../core/persistence.ts";

/** Tracker tool actions, in the same order as the store operations. */
export const TOOL_ACTIONS = [
  "list",
  "create_list",
  "delete_list",
  "set_active",
  "add_items",
  "update_items",
  "remove_item",
] as const;

export type TrackerToolAction = (typeof TOOL_ACTIONS)[number];

export const TRACKER_TOOL_NAME = "tracker";
export const TRACKER_TOOL_LABEL = "Tracker";

/**
 * How an item is declared when it is created: bare text, or an object that
 * also carries the same-list items it must wait for.
 */
const depsSchema = Type.Array(
  Type.String({ description: 'A dependency as listName:id, e.g. "Work:1".' }),
  { description: "Same-list items that must be done before this one." },
);

/** The item-title cap. Enforced only at the tool input, never persisted. */
export const TITLE_LIMIT = 200;

const titleField = Type.String({
  description:
    "Item title: one short action line (max 200 characters). Move longer detail into 'description'.",
});

const descriptionField = Type.String({
  description:
    "Optional: the longer explanation of the item. Put the essential detail in the first paragraph.",
});

/** A declared reference: a path (optionally narrowed to a symbol or span) or a decision topic. */
const referenceSchema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal("path"),
      path: Type.String({ description: "The file path this item must read next." }),
      symbol: Type.Optional(Type.String({ description: "A symbol inside the path." })),
      span: Type.Optional(Type.String({ description: 'A line span, e.g. "12-14" or "12".' })),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("decision"),
      topic: Type.String({ description: "The decision the item depends on." }),
    },
    { additionalProperties: false },
  ),
]);

const refsSchema = Type.Array(referenceSchema, {
  description:
    "Optional: the files, symbols, regions, or decisions this item must read after the completed item finishes.",
});

const producesSchema = Type.Array(
  Type.Object(
    { path: Type.String({ description: "A document the item will write." }) },
    { additionalProperties: false },
  ),
  { description: "Optional: every document this item will write." },
);

/** One new item, as the strict item object both add paths accept. */
const ItemObjectSchema = Type.Object(
  {
    title: titleField,
    description: Type.Optional(descriptionField),
    refs: Type.Optional(refsSchema),
    produces: Type.Optional(producesSchema),
    deps: Type.Optional(depsSchema),
  },
  // Item objects are strict: a typo inside one fails here.
  { additionalProperties: false },
);

/** One `update_items` patch: the item id plus the fields to replace. */
const UpdatePatchSchema = Type.Object(
  {
    item_id: Type.String({
      description:
        'The id of the item within list_id, as shown by the list action (e.g. "Work:2").',
    }),
    title: Type.Optional(Type.String({ description: "Replacement title for the item." })),
    description: Type.Optional(
      Type.String({ description: "Replacement description for the item." }),
    ),
    refs: Type.Optional(refsSchema),
    produces: Type.Optional(producesSchema),
    done: Type.Optional(
      Type.Boolean({ description: "true marks the item done, false reopens it." }),
    ),
    deps: Type.Optional(
      Type.Array(Type.String({ description: 'A dependency as listName:id, e.g. "Work:1".' }), {
        description:
          "Replacement dependency set for this item. Pass [] to clear. Must not form a cycle.",
      }),
    ),
  },
  // Patch objects are strict: a typo inside an item update fails here.
  { additionalProperties: false },
);

/** One item to add, as the tool accepts it. */
export type TrackerItemSpec = Static<typeof ItemObjectSchema>;
/** One update_items patch, as the tool accepts it. */
export type TrackerUpdatePatch = Static<typeof UpdatePatchSchema>;

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
        "List id, as shown by the list action. Required for delete_list, add_items, and for update_items' items={...} batch; optional for set_active (omit to deselect).",
    }),
  ),
  item_id: Type.Optional(
    Type.String({
      description:
        'Item id, as shown by the list action: listName:id (e.g. "Work:2"). Ids are permanent: removing an item does not change the other ids. Required for update_items (scalar form) and remove_item.',
    }),
  ),
  name: Type.Optional(
    Type.String({ description: "Name for the new list. Required for create_list." }),
  ),
  initial_items: Type.Optional(
    Type.Array(ItemObjectSchema, {
      description:
        "For create_list: initial items, each {title, description?, refs?, produces?, deps?}, added when the list is created.",
      minItems: 1,
    }),
  ),
  activate: Type.Optional(
    Type.Boolean({
      description:
        "For create_list: switch the active list to the new list (defaults to true; pass false to keep the current active list).",
    }),
  ),
  title: Type.Optional(
    Type.String({
      description: "For update_items: the replacement title for the item (max 200 characters).",
    }),
  ),
  description: Type.Optional(descriptionField),
  refs: Type.Optional(refsSchema),
  produces: Type.Optional(producesSchema),
  done: Type.Optional(
    Type.Boolean({ description: "For update_items: true marks the item done, false reopens it." }),
  ),
  deps: Type.Optional(
    Type.Array(Type.String({ description: 'A dependency as listName:id, e.g. "Work:1".' }), {
      description:
        "For update_items: the replacement dependency set (same-list items that must be done first). Pass [] to clear. Must not form a cycle.",
    }),
  ),
  items: Type.Optional(
    Type.Array(Type.Union([ItemObjectSchema, UpdatePatchSchema]), {
      description:
        "For add_items: the item objects to add, each {title, description?, refs?, produces?, deps?}. For update_items: the item patches, each with an item_id.",
      minItems: 1,
    }),
  ),
});

export type TrackerToolParams = Static<typeof TrackerToolParams>;

/** Parameters each action accepts (besides `action` itself). */
const ACTION_PARAMS: Readonly<Record<TrackerToolAction, readonly string[]>> = {
  list: [],
  create_list: ["name", "initial_items", "activate"],
  delete_list: ["list_id"],
  set_active: ["list_id"],
  add_items: ["list_id", "items"],
  update_items: [
    "list_id",
    "item_id",
    "title",
    "description",
    "refs",
    "produces",
    "done",
    "deps",
    "items",
  ],
  remove_item: ["item_id"],
};

/** Outcome of `validateTrackerCall`; on success the params are safe to use. */
export type TrackerCallValidation =
  | { ok: true; params: TrackerToolParams }
  | { ok: false; message: string };

/** Every title a call declares, in any accepted shape. */
const declaredTitles = (record: Record<string, unknown>): readonly string[] => {
  const titles: string[] = [];
  const collect = (value: unknown): void => {
    if (typeof value === "string") titles.push(value);
    else if (Array.isArray(value)) value.forEach(collect);
    else if (typeof value === "object" && value !== null) {
      const title = (value as Record<string, unknown>).title;
      if (typeof title === "string") titles.push(title);
    }
  };
  collect(record.title);
  collect(record.initial_items);
  if (Array.isArray(record.items)) {
    for (const patch of record.items) {
      if (typeof patch !== "object" || patch === null) continue;
      const title = (patch as Record<string, unknown>).title;
      if (typeof title === "string") titles.push(title);
    }
  }
  return titles;
};

/** The title-cap error, naming where the detail belongs. */
const titleLimitError = (title: string): string =>
  `Item title is ${title.length} characters, over the ${TITLE_LIMIT}-character limit. ` +
  "Move the detail into 'description'.";

/** The first declared title over the cap, or undefined. */
const firstLongTitle = (record: Record<string, unknown>): string | undefined =>
  declaredTitles(record).find((title) => title.length > TITLE_LIMIT);

/** The first malformed declared reference, or null. Names the field to fix. */
const referenceError = (refs: unknown, where = "refs"): string | null => {
  if (refs === undefined) return null;
  if (!Array.isArray(refs)) return `${where} must be an array of declared references`;
  for (const [index, ref] of refs.entries()) {
    if (typeof ref !== "object" || ref === null || Array.isArray(ref)) {
      return `${where}[${index}] must be an object with a 'kind' of "path" or "decision"`;
    }
    const record = ref as Record<string, unknown>;
    if (record.kind === "path") {
      if (typeof record.path !== "string" || record.path.length === 0) {
        return `${where}[${index}] is a path reference and requires a 'path' string`;
      }
    } else if (record.kind === "decision") {
      if (typeof record.topic !== "string" || record.topic.length === 0) {
        return `${where}[${index}] is a decision reference and requires a 'topic' string`;
      }
    } else {
      return `${where}[${index}].kind must be "path" or "decision" (got ${JSON.stringify(record.kind)})`;
    }
  }
  return null;
};

/** The first malformed declared product, or null. */
const producesError = (produces: unknown, where = "produces"): string | null => {
  if (produces === undefined) return null;
  if (!Array.isArray(produces)) return `${where} must be an array of declared products`;
  for (const [index, product] of produces.entries()) {
    if (
      typeof product !== "object" ||
      product === null ||
      typeof (product as Record<string, unknown>).path !== "string"
    ) {
      return `${where}[${index}] requires a 'path' string`;
    }
  }
  return null;
};

/** The first declaration problem anywhere in the call, or null. */
const firstDeclarationError = (record: Record<string, unknown>): string | null => {
  const direct = referenceError(record.refs) ?? producesError(record.produces);
  if (direct !== null) return direct;
  const containers = [
    ...(Array.isArray(record.items) ? record.items : []),
    ...(Array.isArray(record.initial_items) ? record.initial_items : []),
  ];
  for (const entry of containers) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
    const nested = firstDeclarationError(entry as Record<string, unknown>);
    if (nested !== null) return nested;
  }
  return null;
};

/** The first entry that is not an item object with a title, or null. */
const firstItemObjectError = (items: readonly unknown[], where: string): string | null => {
  for (const [index, entry] of items.entries()) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return `${where}[${index}] must be an item object {title, description?, refs?, produces?, deps?}`;
    }
    if (typeof (entry as Record<string, unknown>).title !== "string") {
      return `${where}[${index}] requires a 'title' string (one short action line; put longer detail in 'description')`;
    }
  }
  return null;
};

/**
 * The first `add_items` entry that is not an item object with a title, or
 * null. The `items` field is shared with `update_items`, whose entries carry
 * `item_id`; that field belongs to the patch form and is rejected here.
 */
const firstAddEntryError = (items: readonly unknown[]): string | null => {
  for (const [index, entry] of items.entries()) {
    if (
      typeof entry === "object" &&
      entry !== null &&
      !Array.isArray(entry) &&
      (entry as Record<string, unknown>).item_id !== undefined
    ) {
      return `items[${index}] carries 'item_id', which update_items uses; add_items entries are {title, ...}`;
    }
  }
  return firstItemObjectError(items, "items");
};

/** The first `update_items` entry that carries no `item_id`, or null. */
const firstUpdateEntryError = (items: readonly unknown[]): string | null => {
  for (const [index, entry] of items.entries()) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return `items[${index}] must be an item patch {item_id, ...}`;
    }
    if (typeof (entry as Record<string, unknown>).item_id !== "string") {
      return `items[${index}] requires an 'item_id' string`;
    }
  }
  return null;
};

/**
 * Runtime validation for a tracker call — the error-nudging layer.
 *
 * The parameter schema only enforces types; this checks what the schema
 * cannot express (presence of required fields per action, unknown fields,
 * the mutually exclusive update_items forms) and returns an actionable error
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
      message: `Unknown tracker action ${JSON.stringify(action)}; expected one of: ${TOOL_ACTIONS.join(", ")}`,
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
          ? `tracker ${typed} accepts no parameters; unexpected: ${unexpected.join(", ")}`
          : `tracker ${typed} does not accept ${unexpected.join(", ")}; it accepts: ${allowed.join(", ")}`,
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
      if (Array.isArray(record.initial_items)) {
        const problem = firstItemObjectError(record.initial_items, "initial_items");
        if (problem !== null) return { ok: false, message: problem };
      }
      break;
    case "delete_list":
      if (record.list_id === undefined) {
        return { ok: false, message: "delete_list requires the 'list_id' parameter." };
      }
      break;
    case "add_items": {
      if (record.list_id === undefined) {
        return { ok: false, message: "add_items requires the 'list_id' parameter." };
      }
      if (!Array.isArray(record.items) || record.items.length === 0) {
        return {
          ok: false,
          message:
            "add_items requires the 'items' parameter: one or more item objects " +
            "{title, description?, refs?, produces?, deps?}.",
        };
      }
      const problem = firstAddEntryError(record.items);
      if (problem !== null) return { ok: false, message: problem };
      break;
    }
    case "update_items":
      if (record.items !== undefined) {
        // Batch form: list_id + items (id-based, one list).
        if (
          record.item_id !== undefined ||
          record.title !== undefined ||
          record.description !== undefined ||
          record.refs !== undefined ||
          record.produces !== undefined ||
          record.done !== undefined ||
          record.deps !== undefined
        ) {
          return {
            ok: false,
            message:
              "update_items: pass either item_id with title/description/refs/produces/done/deps (one item) or list_id + items (several items in one list), not both.",
          };
        }
        if (record.list_id === undefined) {
          return {
            ok: false,
            message:
              "update_items with 'items' requires the 'list_id' parameter (the list whose items are being updated).",
          };
        }
        if (Array.isArray(record.items)) {
          const problem = firstUpdateEntryError(record.items);
          if (problem !== null) return { ok: false, message: problem };
        }
      } else if (record.item_id === undefined) {
        return {
          ok: false,
          message:
            "update_items requires 'item_id' (one item) or 'list_id' + 'items' (several items in one list).",
        };
      } else if (record.title !== undefined && typeof record.title !== "string") {
        return {
          ok: false,
          message:
            "update_items: 'title' must be a single string; use 'items' to update several items in one call.",
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
  const long = firstLongTitle(record);
  if (long !== undefined) return { ok: false, message: titleLimitError(long) };
  const declaration = firstDeclarationError(record);
  if (declaration !== null) return { ok: false, message: declaration };
  return { ok: true, params: args as TrackerToolParams };
}

/** Structured result payload attached to tool calls, consumed by the renderers. */
export interface TrackerToolDetails {
  action: TrackerToolAction;
  error?: string;
  listId?: number;
  /** `listName:id`, as shown by the list action. */
  itemId?: string;
  list?: TodoList;
  /** Items affected by an add_items/update_items call, in creation/patch order. */
  items?: TodoItem[];
  /** Full state snapshot, only for the `list` action (for rendering). */
  snapshot?: EncodedState;
}

/**
 * One applied `update_items` patch, as the advisory helpers need it: the display
 * id plus whatever fields the caller changed.
 */
export interface AppliedUpdatePatch {
  readonly id: string;
  readonly title?: string;
  readonly description?: string;
  readonly done?: boolean;
  readonly deps?: readonly string[];
}

/**
 * Advisory note for a call that leaves a done item unsatisfied, which the two
 * edit paths can do:
 *
 * - A reopen (`done: false`): the reopen does not cascade, so its done
 *   dependents stay done and are now blocked.
 * - A dependency edit (`deps`): a done item can be given a dependency that is
 *   still open, and nothing else would report it.
 *
 * Returns null when neither applies. Advisory text, never a rejection. Each
 * affected item is named once, so a batch that hits both paths still produces
 * one sentence about it.
 *
 * @param patches the update_items patches that were applied, in call order.
 * @param state the state after the call. A reopen only changes the reopened
 *   item and a dependency edit only changes the patched item, so the other
 *   items' done flags are the same before and after.
 */
export const blockedDoneNote = (
  patches: readonly AppliedUpdatePatch[],
  state: TrackerState,
): string | null => {
  const notes: string[] = [];
  const reported = new Set<string>();
  for (const patch of patches) {
    const parsed = parseItemRef(patch.id);
    if (parsed === null) continue;
    const list = state.lists.find((candidate) => candidate.name === parsed.name);
    if (list === undefined) continue;
    const index = list.items.findIndex((item) => item.id === parsed.id);
    if (index === -1) continue;
    if (patch.done === false) {
      const blocked = dependentsOf(list, index)
        .filter((dependent) => list.items[dependent]!.done)
        .map((dependent) => formatItemRef(list.name, list.items[dependent]!.id))
        .filter((ref) => !reported.has(ref));
      if (blocked.length > 0) {
        for (const ref of blocked) reported.add(ref);
        const one = blocked.length === 1;
        notes.push(
          `Note: ${patch.id} is open again, so ${blocked.join(", ")} ` +
            `${one ? "is" : "are"} done but blocked. Reopen or re-plan ${one ? "it" : "them"}.`,
        );
      }
    }
    if (patch.deps !== undefined && list.items[index]!.done && !reported.has(patch.id)) {
      const open = unsatisfiedDeps(list, index);
      if (open.length > 0) {
        reported.add(patch.id);
        const one = open.length === 1;
        notes.push(
          `Note: ${patch.id} is done but now waits on ${open.join(", ")}, ` +
            `${one ? "which is" : "which are"} still open. Reopen it or clear ` +
            `${one ? "that dependency" : "those dependencies"}.`,
        );
      }
    }
  }
  return notes.length === 0 ? null : notes.join("\n");
};

/**
 * Anti-pattern guard: the tracker guideline says to mark each item done in
 * the same turn it completes and never batch the marking at the end. A call
 * that marks two or more items done at once AND leaves no open items behind is
 * the terminal-batch signature — the agent did all its work, then finished the
 * list in one sweep. Returns a reminder (or null when the call is fine); it is
 * advisory text, never a rejection, so legitimate same-turn multi-completions
 * (when work is still open) still pass silently.
 *
 * @param patches the update_items patches in call order.
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
    `Note: this call completed ${doneCount} items and left no open items. ` +
    "Mark each item done in the same turn it completes, not in a batch at the end."
  );
};

const TRACKER_TOOL_DESCRIPTION =
  "Manage todolists and track progress. Use for task lists, checklists, milestones, and step-by-step " +
  "work; keep track of tasks with tracker instead of in chat or files. Work through items one at a " +
  "time, marking each done as it completes, so the list always shows current progress.\n" +
  "Every item has a required title: one short action line. An item may also carry a description " +
  "with the longer detail, kept out of the title so the list stays scannable. Put the essential " +
  "detail in the description's first paragraph.\n" +
  "Declare a reference when the item must read a specific file, symbol, region, or decision after " +
  "the completed work; declare a product for each document the item will write. Both are optional " +
  "and may be empty. A declaration tells the tracker what the next step needs, so completed work " +
  "can be compacted without losing it.\n" +
  'Item ids are listName:id, e.g. "Work:2" (copy them from the list action output). Ids are ' +
  "permanent: removing an item does not change the other ids, so a reference you already hold " +
  "stays valid.\n" +
  "An item takes an optional deps list of same-list ids that must be done before it. Dependencies " +
  "must form a DAG: a dependency that would close a cycle is rejected and the error names the " +
  "cycle. The list action marks an open item that waits with (blocked by ...), marks a done item " +
  "whose dependency is open with (waiting on ...), and ends each list that has dependencies with " +
  "a Ready now line. A list without a blocked-by marker has nothing blocked; the Ready now line " +
  "appears once a list carries dependencies.\n" +
  "Completing a blocked item is refused, so an item can only be picked up once its dependencies " +
  "are done. An item that other items depend on cannot be removed until those dependencies change. " +
  "Reopening an item does not cascade, and a deps edit can leave a done item waiting: the result " +
  "notes any done item left unsatisfied.\n" +
  "Each action accepts only its own parameters; any other argument is rejected with the accepted " +
  "list. Parameter rules the schema cannot express:\n" +
  "- list: no parameters\n" +
  "- create_list: name (required), initial_items (optional array of item objects), activate " +
  "(optional, defaults to true: the new list becomes active; pass false to keep the current " +
  "active list)\n" +
  "- delete_list: list_id (required); remove_item: item_id (required, listName:id)\n" +
  "- set_active: list_id (omit the field to deselect, which hides the widget)\n" +
  "- add_items: list_id and items (required). items is a non-empty array of item objects, each " +
  "{title, description?, refs?, produces?, deps?}.\n" +
  "- update_items: one item with item_id plus optional title/description/refs/produces/done/deps, " +
  "or several items in one list with list_id (required) + items=[{item_id, title?, description?, " +
  "refs?, produces?, done?, deps?}, ...]. Never mix the two forms. deps replaces the dependency " +
  "set (pass [] to clear it) and the result names what was removed. Patches apply in order, so " +
  "later patches win and a blocker can be completed in the same call, before the dependent. " +
  'Example: update_items list_id=2 items=[{item_id: "Work:2", done: true}, {item_id: "Work:3", ' +
  'deps: ["Work:1"]}]';

const TRACKER_TOOL_PROMPT_SNIPPET =
  "Manage todolists and track progress: create lists with initial items, add/update/remove items. " +
  "Each item has a required title (one short line), an optional description, and optional refs and " +
  "produces declarations. Batch adds with add_items items=[{title, ...}]; batch updates with " +
  "update_items list_id + items=[...] in one call.";

const TRACKER_TOOL_PROMPT_GUIDELINES = [
  "Use tracker for todo lists, checklists, and multi-step work. Put progress in tracker, not in prose.",
  "Break work into tracker items up front. One item per deliverable.",
  "Mark each tracker item done in the same turn it completes. Never batch the marking at the end.",
  "Batch related tracker adds and updates in one call: use add_items items=[{title, ...}] and update_items' list_id + items=[...] forms.",
  "Before starting work, call tracker with action list. Work from the list, not from memory. Re-check it when the task drifts.",
  "Copy tracker item ids (listName:id, e.g. Work:2) from the list action output. Ids are permanent, so a reference stays valid after a removal.",
  "Declare refs and produces when you create or update a tracker item: the files, symbols, or decisions the item must read next, and each document it will write. A declaration lets tracker keep the next step moving after completed work leaves the context.",
  "Declare tracker dependencies when one item must wait for another: pass deps (listName:id) on the item, or use the {title, deps} form when creating items.",
  "Dependencies in tracker live in the same list and must not form a cycle.",
  "Pick up an unblocked tracker item: the list output marks blocked items and ends each list that has dependencies with a Ready now line. Completing a blocked item fails, so finish its dependencies first.",
  "When a tracker call fails, read the error. It tells you what to fix. Not-found errors name the available ids. Retry with corrected parameters in the same turn. Never repeat the same failing call.",
  "The tracker widget shows the active list. create_list makes the new list active by default; pass activate: false to keep the current one.",
  "Use set_active to show a tracker list in the widget, or omit list_id to hide it.",
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
