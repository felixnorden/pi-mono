/**
 * Close the built-in editor's autocomplete popup on vim Normal entry
 * (binding decision 2).
 *
 * pi-tui's `Editor` keeps its autocomplete state in private fields and its
 * close methods (`cancelAutocomplete`, `clearAutocompleteUi`) are private.
 * Mirroring `autocomplete-contract.ts`, we guard the private surface and
 * degrade softly (no-op) if pi's internals change shape, instead of crashing
 * with a TypeError.
 */
export function closeAutocomplete(editor: {
  readonly isShowingAutocomplete: () => boolean;
}): void {
  if (!editor.isShowingAutocomplete()) return;
  const internal = editor as unknown as {
    readonly cancelAutocomplete?: () => void;
    readonly clearAutocompleteUi?: () => void;
  };
  // cancelAutocomplete also aborts an in-flight request; clearAutocompleteUi
  // is the minimal fallback if the former is renamed/reshaped.
  if (typeof internal.cancelAutocomplete === "function") {
    internal.cancelAutocomplete();
  } else {
    internal.clearAutocompleteUi?.();
  }
}
