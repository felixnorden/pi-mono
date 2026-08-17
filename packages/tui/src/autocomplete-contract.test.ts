import { assert, it } from "@effect/vitest";
import { SelectList } from "@earendil-works/pi-tui";
import {
  decodeAutocompleteInternals,
  inspectAutocompleteInternals,
} from "./autocomplete-contract.ts";

const editorWith = (internals: Record<string, unknown>) => internals as unknown;

it("decodes a valid editor with a renderable list and prefix", () => {
  const view = decodeAutocompleteInternals(
    editorWith({
      autocompleteList: { render: (_width: number) => ["item"] },
      autocompletePrefix: "@src/",
    }),
  );
  assert.strictEqual(view?.autocompleteList?.render(10)[0], "item");
  assert.strictEqual(view?.autocompletePrefix, "@src/");
});

it("decodes an editor with no autocomplete active", () => {
  const view = decodeAutocompleteInternals(editorWith({ autocompleteList: null }));
  assert.strictEqual(view?.autocompleteList, undefined);
  assert.strictEqual(view?.autocompletePrefix, undefined);
});

it("rejects a list whose render is not a function", () => {
  const view = decodeAutocompleteInternals(
    editorWith({
      autocompleteList: { render: "not a function" },
      autocompletePrefix: "@src/",
    }),
  );
  assert.strictEqual(view, undefined);
});

it("rejects a non-object list", () => {
  const view = decodeAutocompleteInternals(
    editorWith({ autocompleteList: 42, autocompletePrefix: "@src/" }),
  );
  assert.strictEqual(view, undefined);
});

it("rejects a non-string prefix", () => {
  const view = decodeAutocompleteInternals(
    editorWith({
      autocompleteList: { render: () => ["item"] },
      autocompletePrefix: 42,
    }),
  );
  assert.strictEqual(view, undefined);
});

it("degrades to an empty view when internals were renamed", () => {
  const view = decodeAutocompleteInternals(
    editorWith({
      suggestionList: { render: () => ["item"] },
      suggestionPrefix: "@src/",
    }),
  );
  // Unknown keys are ignored and optional fields are absent: no list to frame,
  // so the editor falls back to the unframed passthrough.
  assert.strictEqual(view?.autocompleteList, undefined);
  assert.strictEqual(view?.autocompletePrefix, undefined);
});

it("inspect reports ok with the decoded view on a matching editor", () => {
  const inspection = inspectAutocompleteInternals(
    editorWith({ autocompleteList: { render: () => ["item"] } }),
  );
  assert.strictEqual(inspection.ok, true);
  if (inspection.ok) assert.strictEqual(inspection.view.autocompleteList?.render(10)[0], "item");
});

it("inspect reports a non-empty issue with the field path on a mismatch", () => {
  const inspection = inspectAutocompleteInternals(
    editorWith({
      autocompleteList: { render: "not a function" },
      autocompletePrefix: "@src/",
    }),
  );
  assert.strictEqual(inspection.ok, false);
  if (!inspection.ok) {
    assert.strictEqual(inspection.issue.length > 0, true);
    assert.strictEqual(inspection.issue.includes("autocompleteList"), true);
  }
});

const selectListTheme = {
  selectedPrefix: (t: string) => t,
  selectedText: (t: string) => t,
  description: (t: string) => t,
  scrollInfo: (t: string) => t,
  noMatch: (t: string) => t,
};

it("accepts a real SelectList instance (prototype render) and preserves identity", () => {
  // Regression: pi's editor stores a SelectList class instance whose `render`
  // is a prototype method. Field decode must not wrap it, or `this` binding
  // breaks when the editor calls render on the decoded value.
  const list = new SelectList([{ value: "a", label: "A" }], 5, selectListTheme);
  const inspection = inspectAutocompleteInternals({
    autocompleteList: list,
    autocompletePrefix: "@",
  });
  assert.strictEqual(inspection.ok, true);
  if (inspection.ok) {
    assert.strictEqual(inspection.view.autocompleteList, list);
    const lines = inspection.view.autocompleteList?.render(20) ?? [];
    assert.strictEqual(lines.length > 0, true);
    assert.strictEqual(
      lines.some((line) => line.includes("A")),
      true,
    );
  }
});

it("decode accepts an editor holding a real SelectList", () => {
  const list = new SelectList([{ value: "a", label: "A" }], 5, selectListTheme);
  const view = decodeAutocompleteInternals({
    autocompleteList: list,
    autocompletePrefix: "@",
  });
  assert.strictEqual(view?.autocompleteList?.render(20).length, 1);
  assert.strictEqual(view?.autocompletePrefix, "@");
});
