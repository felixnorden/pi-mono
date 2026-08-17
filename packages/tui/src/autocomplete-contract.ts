import { Result, Schema, SchemaIssue } from "effect";

/**
 * Runtime contract for the parts of pi's built-in editor we reach into.
 *
 * The suggestion dropdown is rendered inside the pi-tui `Editor` component,
 * which keeps its autocomplete state in private fields (`autocompleteList`,
 * `autocompletePrefix`). The extension API exposes no renderer hook for that
 * dropdown, so this extension frames the suggestions itself (see editor.ts).
 *
 * Instead of an unchecked `(this as any).autocompleteList` cast, we validate
 * the exact surface we depend on with an Effect Schema. If pi renames or
 * reshapes these internals, decoding fails softly and the editor falls back
 * to the unframed passthrough instead of crashing with a TypeError.
 *
 * The schema checks a duck-type contract, not pi's real (private) types:
 * - `autocompleteList`, when present, must be render-able to lines.
 * - `autocompletePrefix`, when present, must be a string.
 * Both fields are optional: `autocompleteList` is absent while no
 * suggestions are showing.
 */

/** The only surface we read off the built-in list: render lines at a width. */
export interface AutocompleteListLike {
  render(width: number): string[];
}

/**
 * Structural refinement: has a `render` property that is a function.
 *
 * Deliberately NOT a `Schema.Struct({ render: ... })`: field decode only sees
 * own enumerable properties, and pi's list is a class instance whose `render`
 * lives on the prototype. A Struct would both reject the instance and wrap it
 * in a plain object, which would break `this` binding when calling `render`.
 * `ObjectKeyword` accepts the raw instance and the refine keeps its identity.
 */
const Renderable = Schema.ObjectKeyword.pipe(
  Schema.refine(
    (input): input is AutocompleteListLike =>
      typeof (input as { render?: unknown }).render === "function",
  ),
);

export const AutocompleteInternals = Schema.Struct({
  autocompleteList: Schema.optional(Renderable),
  autocompletePrefix: Schema.optional(Schema.String),
});

export type AutocompleteInternals = (typeof AutocompleteInternals)["Type"];

/**
 * Decode an editor instance against the contract.
 * Returns `undefined` when the internals do not match (pi internals changed).
 */
export function decodeAutocompleteInternals(target: unknown): AutocompleteInternals | undefined {
  const inspection = inspectAutocompleteInternals(target);
  return inspection.ok ? inspection.view : undefined;
}

export type AutocompleteInternalsInspection =
  | { readonly ok: true; readonly view: AutocompleteInternals }
  | { readonly ok: false; readonly issue: string };

/**
 * Decode an editor instance against the contract, keeping the failure
 * detail for diagnostics. The rc.108 default formatter crashes on some
 * filter issues, so we render a compact path summary ourselves.
 */
export function inspectAutocompleteInternals(target: unknown): AutocompleteInternalsInspection {
  const result = Schema.decodeUnknownResult(AutocompleteInternals)(target);
  if (Result.isSuccess(result)) return { ok: true, view: result.success };
  return { ok: false, issue: describeIssue(result.failure.issue) };
}

function describeIssue(issue: SchemaIssue.Issue, depth = 0): string {
  if (depth > 4) return "...";
  switch (issue._tag) {
    case "Pointer":
      return `${issue.path.join(".")}: ${describeIssue(issue.issue, depth + 1)}`;
    case "Composite":
      return issue.issues.map((sub) => describeIssue(sub, depth + 1)).join("; ");
    case "AnyOf":
      return issue.issues.map((sub) => describeIssue(sub, depth + 1)).join(" | ");
    case "Filter":
      return `filter failed (${describeIssue(issue.issue, depth + 1)})`;
    case "Encoding":
      return `encoding failed (${describeIssue(issue.issue, depth + 1)})`;
    default:
      return issue._tag;
  }
}
