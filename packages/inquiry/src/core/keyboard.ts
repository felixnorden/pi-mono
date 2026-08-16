/**
 * Keyboard events understood by the core interaction machine.
 *
 * The fringe maps pi-tui key data into these events. The core never sees raw
 * terminal escape sequences.
 *
 * The union is defined as an Effect Schema so the type has a single source of
 * truth, is decodable at runtime (tests, serialization), and can be matched
 * exhaustively: every reducer must handle every tag, so adding a new event is
 * a compile-time prompt to decide what each mode does with it.
 */

import { Schema } from "effect";

export const KeyEventSchema = Schema.TaggedUnion({
  up: {},
  down: {},
  left: {},
  right: {},
  tab: {},
  shiftTab: {},
  enter: {},
  shiftEnter: {},
  escape: {},
  backspace: {},
  delete: {},
  home: {},
  end: {},
  char: { char: Schema.String },
  paste: { text: Schema.String },
});

export type KeyEvent = Schema.Schema.Type<typeof KeyEventSchema>;

/**
 * Canonical event instances, plus factories for the data-carrying variants.
 *
 * The tag-only events are singletons: the fringe and tests use `KeyEvent.up`,
 * `KeyEvent.escape`, … instead of re-typing `_tag` literals, so the event
 * vocabulary lives in exactly one place. `char` and `paste` carry data and are
 * built with `KeyEvent.char(text)` / `KeyEvent.paste(text)`.
 */
export const KeyEvent = {
  up: KeyEventSchema.make({ _tag: "up" }),
  down: KeyEventSchema.make({ _tag: "down" }),
  left: KeyEventSchema.make({ _tag: "left" }),
  right: KeyEventSchema.make({ _tag: "right" }),
  tab: KeyEventSchema.make({ _tag: "tab" }),
  shiftTab: KeyEventSchema.make({ _tag: "shiftTab" }),
  enter: KeyEventSchema.make({ _tag: "enter" }),
  shiftEnter: KeyEventSchema.make({ _tag: "shiftEnter" }),
  escape: KeyEventSchema.make({ _tag: "escape" }),
  backspace: KeyEventSchema.make({ _tag: "backspace" }),
  delete: KeyEventSchema.make({ _tag: "delete" }),
  home: KeyEventSchema.make({ _tag: "home" }),
  end: KeyEventSchema.make({ _tag: "end" }),
  char: (char: string): KeyEvent => KeyEventSchema.make({ _tag: "char", char }),
  paste: (text: string): KeyEvent => KeyEventSchema.make({ _tag: "paste", text }),
} as const;
