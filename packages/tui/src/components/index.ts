/**
 * Public component surface of the tui package.
 *
 * Extensions and workspace packages import the shared house UI from this
 * entry (`import { makeBorderedBox } from "@ftrdotdev/pi-tui"`). The pi extension
 * itself is registered through the `pi.extensions` field and loads
 * `./src/index.ts` directly; it is intentionally not re-exported here so
 * importing a component never drags in the extension's side effects.
 *
 * This folder holds the composable components and the primitives they share.
 * `defineComponent` lives in its own leaf module (`./define-component.ts`):
 * components import it directly, never this barrel, so the layout is acyclic.
 *
 * The pure frame model is available at `@ftrdotdev/pi-tui/box-frame` for
 * pi-free cores that must not depend on terminal styling.
 */
export { makeBorderedBox, type BorderedBoxOptions } from "./bordered-box.ts";
export { defineComponent, type ComponentMethods } from "./define-component.ts";
export {
  buildBoxFrame,
  composeBorderLine,
  type BoxFrame,
  type BoxFrameOptions,
  type BoxBorderLine,
  type BoxTopBorder,
} from "../frame/box-frame.ts";
export { VimRouter, type NavigationIntent } from "../vim/vim-router.ts";
// Editor customization: a generic Effect service other extensions can import
// and `.configure` to inject/override the editor's border tint.
export {
  EditorTintService,
  upsertBorderTintProvider,
  type BorderTintProvider,
} from "../ui/editor-tint.ts";
