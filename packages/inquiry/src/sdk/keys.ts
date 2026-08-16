/**
 * Map raw pi-tui key data to core key events.
 *
 * The core never sees terminal escape sequences; this module translates them.
 * Unparseable or control input returns `null` and is ignored by the adapter.
 */

import { Key, matchesKey } from "@earendil-works/pi-tui";
import { KeyEvent } from "../core/keyboard.ts";

export const parseKey = (data: string): KeyEvent | null => {
  // Bracketed paste: the terminal layer re-wraps pastes in \x1b[200~ ... \x1b[201~
  // before they reach handleInput. Must be checked before key matching.
  const paste = extractPaste(data);
  if (paste !== null) return KeyEvent.paste(paste);

  if (matchesKey(data, Key.up)) return KeyEvent.up;
  if (matchesKey(data, Key.down)) return KeyEvent.down;
  if (matchesKey(data, Key.left)) return KeyEvent.left;
  if (matchesKey(data, Key.right)) return KeyEvent.right;

  // Shift+Enter must be matched before Enter: with the Kitty keyboard protocol
  // active, a bare \n is Ghostty's shift+enter mapping, and the pi editor treats
  // \x1b\r / \x1b[13;2~ / bare \n as newline input.
  if (
    matchesKey(data, Key.shift("enter")) ||
    data === "\x1b\r" ||
    data === "\x1b[13;2~" ||
    (data.length > 1 && data.includes("\x1b") && data.includes("\r")) ||
    data === "\n"
  ) {
    return KeyEvent.shiftEnter;
  }
  if (matchesKey(data, Key.enter)) return KeyEvent.enter;
  if (matchesKey(data, Key.shift("tab"))) return KeyEvent.shiftTab;
  if (matchesKey(data, Key.tab)) return KeyEvent.tab;
  if (matchesKey(data, Key.escape)) return KeyEvent.escape;
  if (matchesKey(data, Key.backspace)) return KeyEvent.backspace;
  if (matchesKey(data, Key.delete)) return KeyEvent.delete;
  if (matchesKey(data, Key.home)) return KeyEvent.home;
  if (matchesKey(data, Key.end)) return KeyEvent.end;
  if (data.length > 0 && !containsControl(data)) return KeyEvent.char(data);
  return null;
};

const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";

/**
 * Extract the content of a bracketed paste, or null when `data` is not one.
 *
 * Control bytes inside paste content may arrive re-encoded as CSI-u Ctrl+<letter>
 * sequences (e.g. tmux with extended-keys-format=csi-u); decode those back to
 * their literal byte so newlines survive (the core sanitizer strips the rest).
 */
const extractPaste = (data: string): string | null => {
  const start = data.indexOf(BRACKETED_PASTE_START);
  if (start === -1) return null;
  const end = data.indexOf(BRACKETED_PASTE_END, start);
  if (end === -1) return null;
  const content = data.slice(start + BRACKETED_PASTE_START.length, end);
  // eslint-disable-next-line no-control-regex -- intentional: CSI-u ctrl re-encoding (matches pi-tui)
  return content.replace(/\x1b\[(\d+);5u/g, (match, code: string) => {
    const cp = Number(code);
    if (cp >= 97 && cp <= 122) return String.fromCharCode(cp - 96);
    if (cp >= 65 && cp <= 90) return String.fromCharCode(cp - 64);
    return match;
  });
};

const containsControl = (data: string): boolean => {
  for (const ch of data) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
};
