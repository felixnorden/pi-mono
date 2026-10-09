---
"@ftrdotdev/pi-tracker": minor
---

Author items with a title, a description, and declarations, and let a measured
rule decide a compaction before the classifier.

- `add_item` becomes `add_items` and takes `items`, a non-empty array of item
  objects. Every item is declared the same way, as
  `{title, description?, refs?, produces?, deps?}`. `create_list`'s
  `initial_items` takes the same objects. The old `text` field and the `title`
  container are rejected, so a field can never nest as `title.title`.
- `update_items` keeps its scalar form (`item_id` plus fields) and its batch form
  (`list_id` + `items` patches, each with an `item_id`).
- A legacy item with one `text` string still loads: the first line becomes the
  title and the rest becomes the description.
- The widget shows the title, with the description dimmed on the line below. The
  `/tracker` overlay shows the full description.
- The extension records what each batch wrote, read, and ran, and resolves an
  item's declared references and products against disk at the settle boundary. A
  rule row that cleared the eval gate compacts the ready frontier on its own.
  Every other row reports its name and hands the frontier to the classifier.
- An item with a declaration records the fired row and the resolved states as a
  compact `tracker/reliance-decision` session entry. The entry feeds the rule
  eval, so a declared row's live coverage is measurable.
- `update_items` now rejects a top-level `refs` or `produces` alongside `items`.
  The call was accepted before, and the declarations were dropped.
