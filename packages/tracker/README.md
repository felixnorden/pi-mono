# pi-tracker

pi-tracker is an extension for Pi. It manages todolists in your session.

## Features

- Create and delete todolists.
- Add, update, and remove items in a todolist.
- Mark an item as complete or incomplete.
- Change the task text of an item.
- Persist todolists with the session.
- Show the active todolist in a widget above the editor.

## How it works

pi-tracker stores its state in an Effect service. It writes a snapshot to the
session after every change. It restores the state when the session resumes.

The snapshot does not enter the LLM context.

## Usage

### The tracker tool

Ask Pi to manage your todolists. Pi calls the `tracker` tool. The tool
supports these actions:

| Action        | Purpose                                   | Parameters                                     |
| ------------- | ----------------------------------------- | ---------------------------------------------- |
| `list`        | Show all lists and items                  | —                                              |
| `create_list` | Create a list (becomes active by default) | `name`, `initial_items?`, `activate?`          |
| `delete_list` | Delete a list                             | `list_id`                                      |
| `set_active`  | Set or clear the active list              | `list_id` (optional)                           |
| `add_item`    | Add one or more items                     | `list_id`, `text` (string or array of strings) |
| `update_item` | Update one or more items                  | `item_id`/`text?`/`done?` or `items`           |
| `remove_item` | Remove an item                            | `item_id`                                      |

`create_list` accepts `initial_items` (an array of item texts) to create the
list with its first items in one call — list and items are created atomically.
`add_item` accepts a single `text` or an array of texts — several items are
added in one call.

Item ids are `listName:index` — the 1-based position of the item in its
list, as shown by the `list` action (e.g. `Work:2`). They are not stored on
items: an id is just the list name plus the array position, so ids are
unique across lists because list names are unique, and ids shift when items
are removed (`Work:3` becomes `Work:2`) — re-list before referencing items
after a removal. `update_item` accepts the scalar form (`item_id` with
optional `text`/`done`) or a batched `items` array
(`[{item_id, text?, done?}, ...]`); batches may span lists, since each
`item_id` names its own list. Creating a list makes it the active list (the
widget switches to it); pass `activate: false` to keep the current active
list.

The tool validates every call and returns an error that names exactly what to
fix: each action accepts only its own parameters, required fields are
enforced, and the two `update_item` forms never mix. Read the error and retry
with corrected parameters — not-found errors also list the available ids.
`update_item` also appends a reminder when one call marks two or more items
done at once: the working rhythm is to mark each item done in the same turn
it completes, never batch the marking at the end.

Example prompt:

> Create a list called "Work" and add "write plan" to it.

Call `set_active` without `list_id` to deselect. The widget hides when no
list is active.

### Working through a list

The intended rhythm: break multi-step work into items up front (one item per
deliverable), work through them one at a time, and mark each done as it
completes. The list — shown in the widget — is the live working state; the
agent should read it with `list` before starting and after finishing, and
update item text with `update_item` when scope changes.

Failed calls are recoverable: the tool's errors say what to fix, and
not-found errors name the available ids. The agent corrects the call and
retries in the same turn instead of repeating the same failing call.

### The /tracker command

Open `/tracker` to manage lists interactively.

While the cursor moves over the lists, the items pane below previews the
focused list. `enter` commits it as the active list and opens the items
pane for editing.

| Key     | Action                                 |
| ------- | -------------------------------------- |
| `tab`   | Switch between the lists and the items |
| `↑` `↓` | Move the cursor                        |
| `enter` | Select a list and open its items       |
| `space` | Toggle the active list                 |
| `n`     | Create a list                          |
| `d`     | Delete a list                          |
| `a`     | Add an item                            |
| `x`     | Toggle an item complete or incomplete  |
| `e`     | Edit the item text                     |
| `r`     | Remove an item                         |
| `esc`   | Close the view                         |

### The widget

The widget shows the active list above the editor. It appears when a list is
active. It hides when no list is active.

The widget has a rounded border. The border uses the theme's `border` color.

## Persistence

The state lives in the session file. Pi writes a snapshot after every change.
The state restores on resume, fork, and tree navigation.

## Installation

Install from npm:

```bash
pi install npm:@ftrdotdev/pi-tracker
```

From git or a local checkout:

```bash
pi install git:github.com/felixnorden/pi-mono
pi install ./path/to/pi-mono/packages/tracker
```

To try the package without installing it, use `-e` (temporary, current run
only):

```bash
pi -e npm:@ftrdotdev/pi-tracker
```

Registration lives in `package.json` under the `pi` field:

```json
"pi": {
  "extensions": ["./src/index.ts"]
}
```

## Development

| Command             | Purpose                                      |
| ------------------- | -------------------------------------------- |
| `bun test`          | Run the test suite (vitest + @effect/vitest) |
| `bun test:watch`    | Run the test suite in watch mode             |
| `bunx tsc --noEmit` | Type check                                   |
| `bun lint`          | Lint with oxlint                             |

## Project structure

| File                 | Purpose                                                      |
| -------------------- | ------------------------------------------------------------ |
| `src/domain.ts`      | Schema domain model (`TodoItem`, `TodoList`, `TrackerState`) |
| `src/store.ts`       | `TrackerStore` service with `Effect.Ref` state               |
| `src/persistence.ts` | `TrackerPersistence` service (save and restore snapshots)    |
| `src/ui.ts`          | Widget pane and interactive `/tracker` component             |
| `src/index.ts`       | Pi bridge: tool, command, session hooks, widget refresh      |
| `src/*.test.ts`      | Test suites                                                  |
