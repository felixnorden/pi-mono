---
"@ftrdotdev/pi-tracker": patch
---

Collapse long lists in the widget and fix the scalar `update_item` crash.

- Keep the first item, the current item (the first item still open), and the last item visible when the active list has more items than the widget can show. Collapse the items outside that window into a `⋮` row, and show the row only when items are hidden between the visible rows.
- Mark the current item with a filled `●` in the accent color, so the item being worked on stands out from the other open items.
- Fix `update_item` with `item_id`, which failed with `items.map is not a function`. Both `update_item` forms now return an affected-items array.
