# pi-tracker

pi-tracker is an extension for Pi. It manages todolists in your session.

## Features

- Create and delete todolists.
- Add, update, and remove items in a todolist.
- Give an item a short title, a longer description, and optional declarations.
- Mark an item as complete or incomplete.
- Declare dependencies between items, so work happens in order.
- Declare the references and products an item needs, so the next step survives compaction.
- Persist todolists with the session.
- Show the active todolist in a widget above the editor.
- Start Pi's compaction when a completed item's detail is no longer needed.

## How it works

pi-tracker stores its state in an Effect service. It writes a snapshot to the
session after every change. It restores the state when the session resumes.

The snapshot does not enter the LLM context.

## Usage

### The tracker tool

Ask Pi to manage your todolists. Pi calls the `tracker` tool. The tool
supports these actions:

| Action         | Purpose                                   | Parameters                                 |
| -------------- | ----------------------------------------- | ------------------------------------------ |
| `list`         | Show all lists and items                  | None                                       |
| `create_list`  | Create a list (becomes active by default) | `name`, `initial_items?`, `activate?`      |
| `delete_list`  | Delete a list                             | `list_id`                                  |
| `set_active`   | Set or clear the active list              | `list_id` (optional)                       |
| `add_items`    | Add one or more items                     | `list_id`, `items` (array of item objects) |
| `update_items` | Update one or more items                  | `item_id` + fields, or `list_id` + `items` |
| `remove_item`  | Remove an item                            | `item_id`                                  |

`create_list` accepts `initial_items` to create the list with its first
items in one call, so the list and its items are created atomically. Every
item is an object `{title, description?, refs?, produces?, deps?}`, and
`add_items` takes the same objects in its `items` array, so an item is
always declared the same way. A title is one short action line, at most 200
characters; put the longer detail in `description`.

Item ids are `listName:id`, as the `list` action shows them (e.g. `Work:2`).
An id is permanent: it is stored on the item, it is unique within its list,
and it is never reused. Removing an item leaves a gap in the numbering
instead of shifting the items after it, so a reference you already hold stays
valid. `update_items` accepts the scalar form (`item_id` with optional
`title`/`description`/`refs`/`produces`/`done`/`deps`) or a per-list batched
form: `list_id` plus an `items`
array (`[{item_id, title?, description?, refs?, produces?, done?, deps?}, ...]`),
mirroring `add_items`' `list_id + items` shape, so one batch stays within a
single list. Creating a list makes it the active list (the widget switches to
it); pass `activate: false` to keep the current active list.

The tool validates every call and returns an error that names exactly what to
fix: each action accepts only its own parameters, required fields are
enforced, and the two `update_items` forms never mix. Read the error and retry
with corrected parameters. Not-found errors also list the available ids.
`update_items` also appends a reminder when one call marks two or more items
done and leaves no open items behind (the terminal batch): the working
rhythm is to mark each item done in the same turn it completes, never batch
the marking at the end.

Example prompt:

> Create a list called "Work" and add "write plan" to it.

Call `set_active` without `list_id` to deselect. The widget hides when no
list is active.

### Titles, descriptions, and declarations

Every item has a required `title`: one short action line, at most 200
characters. An item may also carry a `description` with the longer detail. The
widget shows the title, with the description dimmed on the line below; the
`/tracker` items pane shows the full description.

An item may declare two optional lists:

- `refs`: what the item must read after the completed work. Each entry is
  `{kind: "path", path, symbol?, span?}` or `{kind: "decision", topic}`.
- `produces`: every document the item will write. Each entry is `{path}`.

Declarations tell the tracker what the next step needs. At the settle boundary
the tracker resolves a declared path against disk. If the detail is readable
there, the rule table can compact the completed work and keep the next step
moving without a classifier call. After a session restore there is no tool
footprint, so references resolve as unresolved and only products check disk.

### Dependencies and readiness

An item can wait for other items. Pass `deps` on the item object when you
create it, or through `update_items`, as a list of `listName:id` references to
items in the same list. `deps` replaces the whole dependency set, so pass `[]`
to clear it. The result names the set before and after whenever the two
differ, so a dependency the call dropped does not disappear silently.

Dependencies must form a DAG. A dependency must exist, it must be in the same
list, and it must not close a cycle. A call that would close one is rejected,
and the error names the cycle path (e.g. `Work:1 → Work:2 → Work:1`).

Two rules gate mutations:

- You can only complete an item after every dependency is done. Completing a
  blocked item fails, and the error names the blockers. Reopening is never
  blocked, so you can always repair a mistake.
- You cannot remove an item that other items depend on. The error names the
  dependents.

Reopening does not cascade. If you reopen a dependency whose dependents are
already done, those dependents stay done and the result adds a note that they
are now done but blocked. Giving a done item an open dependency produces the
same state and the same note, because a dependency edit would otherwise leave
the item silently unsatisfied. The `list` action marks such a row with
`(waiting on #Work:1)`: the item is finished, so it is not called blocked.

Readiness is derived on every read, never stored. The `list` action marks each
blocked item, and it ends every list that has dependencies with a `Ready now`
line. A list without a `blocked by` marker has nothing blocked, so an edge-free
list is not silent about readiness: it simply has nothing to report, and it
keeps the output it had before dependencies existed. A dependency reference
that does not resolve counts as a blocker, so a hand-edited snapshot cannot
silently unblock work.

An `update_items` batch applies its patches in order, so it behaves like the
same calls in sequence: one call can complete a chain, and a completion that
comes before its blocker in the array is refused.

Items render in a stable dependency order: a dependency comes before the items
that wait for it. A list with no dependencies keeps its stored order. The
stored order itself never changes; only the display order does. The `list`
action, the widget, and the `/tracker` items pane all use that order.

### Working through a list

The intended rhythm: break multi-step work into items up front (one item per
deliverable), work through them one at a time, and mark each done as it
completes. The list in the widget always shows current progress. The agent
reads it with `list` before starting and after finishing, and updates an item's
title or description with `update_items` when scope changes.

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
| `e`     | Edit the item title                    |
| `r`     | Remove an item                         |
| `esc`   | Close the view                         |

### The widget

The widget shows the active list above the editor. It appears when a list is
active. It hides when no list is active.

The widget has a rounded border. The border uses the theme's `border` color.

When the list holds more items than the widget can show, the widget keeps the
first item, the current item (the first ready item), and the last item
visible, then fills the remaining rows around the current item. Items outside
that window collapse into a `⋮` row. The `⋮` row appears only when items are
hidden between the visible rows. The border label still shows the done and
total counts.

Each item line starts with one marker:

| Marker | Meaning                                                      |
| ------ | ------------------------------------------------------------ |
| `✓`    | Done.                                                        |
| `●`    | The current item: the first ready item, in the accent color. |
| `○`    | Another open item that is ready.                             |
| `⊘`    | An open item that waits for an unfinished dependency.        |

The marker field is two columns wide for every marker, so the text stays
flush. The widget and the `list` action show the same derived order and the
same readiness, so the two surfaces never disagree. The marker is the widget's
whole report of an item's state, so a done item whose dependency was reopened
keeps the `✓` there; the `(waiting on ...)` annotation appears in the `list`
output and the `/tracker` items pane, which have room for it.

### Smart compaction

When you complete an item in the active list, pi-tracker decides whether the
**ready items** need the completed work. A measured rule row runs first. When
an accepted row fires, it decides the whole ready frontier on its own. Every
other row reports its name and hands the frontier to the classifier, which
judges up to `maxCandidates` entries, dependents first. Each candidate gets one
two-label choice question: `needs-context` or `stands-alone`. The answer carries
a probability and a `confidence`. When no ready item needs the detail,
pi-tracker starts Pi's compaction at the settle boundary and then resumes the
session with a pointer to the next ready item.

The feature reads five keys from `tui.json`, under `smartCompaction`:

| Key                                | Type             | Default | Meaning                                                                                                              |
| ---------------------------------- | ---------------- | ------- | -------------------------------------------------------------------------------------------------------------------- |
| `enabled`                          | boolean          | `true`  | Turn smart compaction on or off.                                                                                     |
| `classifier`                       | string or null   | `null`  | A `provider/modelId` classifier. `null` uses the preference order: Clef Flash, then TypeSafe Jev, then OpenCode Jev. |
| `needsContextProbabilityThreshold` | number in (0, 1) | `0.5`   | The `needs-context` probability at or above which the context is kept.                                               |
| `minAnswerConfidence`              | number in (0, 1) | `0.5`   | The answer's self-reported confidence below which the context is kept.                                               |
| `maxCandidates`                    | integer 1..20    | `8`     | How many ready items one classification judges.                                                                      |

`needsContextProbabilityThreshold` is the probability knob: raise it to compact
more often, lower it to keep context more often. It cuts on the probability the
classifier assigns to `needs-context`, not on its confidence. `minAnswerConfidence`
is a separate guard on the answer's self-reported confidence: when the model is
less confident than the floor, pi-tracker keeps the context. This guard only
adds keeping, so it can never cause a premature compaction. Both keys still
accept their pre-rename names (`keepContextThreshold`, `keepContextMinConfidence`)
as aliases; the current key wins when both are present. `maxCandidates` bounds the
classifier input; when more items are ready than the cap, the first
`maxCandidates` are judged, dependents first.

A value outside the range in the table falls back to the default. The feature
fails open. A disabled feature, no credential-available classifier, a classifier
error or timeout, an aborted run, or a list with no ready item keeps the full
context. The classifier input is the item list only. The transcript never leaves
the session. An unaccepted rule row abstains, so it never compacts on its own.

The rule table lives in `src/compaction/rules.ts`. Only rows in
`ACCEPTED_RULES` compact on their own. A row enters that set only when the eval
gate accepts it on labeled decisions: at least 10 labeled firings, at least 95%
agreement, above the pass base rate, in at least two passes. Every decision on
an item with declarations records the fired row and the resolved states as a
`tracker/reliance-decision` session entry, which the eval reads back.
`bun run eval:rules` prints the tables and the gate.

The `/tui` command edits all five on a **Compaction** tab: `Smart compaction`
(toggle), `Compaction classifier` (picker), `Needs-context probability`, `Answer
confidence floor`, and `Max candidates` (`+` and `-` adjust the numeric rows).
The Compaction tab appears only while the tracker extension is loaded.

## Persistence

The state lives in the session file. Pi writes a snapshot after every change.
The state restores on resume, fork, and tree navigation. Changes are applied
and written in order, and each result reports the state its own call produced
instead of a value another surface cached.

A snapshot saved before item ids existed loads with each item id equal to its
position, so references in that format still resolve. A snapshot written before
the title/description split loads with the first line as the title and the rest
as the description.

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
  "extensions": ["./index.ts"]
}
```

## Development

| Command                | Purpose                                      |
| ---------------------- | -------------------------------------------- |
| `bun run test`         | Run the test suite (vitest + @effect/vitest) |
| `bun run test:watch`   | Run the test suite in watch mode             |
| `bun run typecheck`    | Type check with `tsc --noEmit`               |
| `bun run lint`         | Lint with oxlint                             |
| `bun run eval:harvest` | Harvest the eval corpus from local sessions  |
| `bun run eval:rules`   | Print the rule tables and the promotion gate |
| `bun run eval:promote` | Align `ACCEPTED_RULES` with the measured set |

## Project structure

| File                                | Purpose                                                          |
| ----------------------------------- | ---------------------------------------------------------------- |
| `src/core/domain.ts`                | Schema domain model (`TodoItem`, `TodoList`, `TrackerState`)     |
| `src/core/deps.ts`                  | Dependency references, cycle detection, readiness, derived order |
| `src/core/store.ts`                 | `TrackerStore` service with `Effect.Ref` state                   |
| `src/core/persistence.ts`           | `TrackerPersistence` service (save and restore snapshots)        |
| `src/compaction/observations.ts`    | Resolves declared references and products against disk           |
| `src/compaction/rules.ts`           | The rule table, `ACCEPTED_RULES`, and the gate constants         |
| `src/compaction/footprint.ts`       | Records what each batch wrote, read, and ran                     |
| `src/compaction/settle.ts`          | The settle decision: rules first, then the classifier            |
| `src/compaction/digest.ts`          | The bounded classifier input                                     |
| `src/compaction/decision-record.ts` | The `tracker/reliance-decision` session entry                    |
| `src/compaction/classifier.ts`      | The classifier gateway                                           |
| `src/compaction/pointer.ts`         | The resume pointer and its custom entry                          |
| `src/compaction/settings.ts`        | The `tui.json` reader                                            |
| `src/presentation/ui.ts`            | Widget pane and interactive `/tracker` component                 |
| `src/presentation/tool-metadata.ts` | Tool parameters, result details, and display labels              |
| `src/index.ts`                      | Pi bridge: tool, command, session hooks, widget refresh          |
| `src/**/*.test.ts`                  | Test suites, colocated with each module                          |
