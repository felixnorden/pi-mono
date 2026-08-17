import type { Component } from "@earendil-works/pi-tui";

/**
 * Minimal surface a component must expose to the pi-tui runtime. `render`
 * and `invalidate` are required by the `Component` interface; the rest are
 * optional lifecycle hooks.
 */
export interface ComponentMethods {
  readonly render: (width: number) => string[];
  readonly invalidate: () => void;
  readonly handleInput?: (data: string) => void;
  readonly dispose?: () => void;
  readonly wantsKeyRelease?: boolean;
}

/**
 * Builds a TUI component from closures.
 *
 * The returned object's methods are the closures handed in — there is no
 * `this` anywhere, so pi-tui (and any bridge such as `setWidget`, `ui.custom`,
 * `setFooter` or `setHeader`) can invoke `render`/`invalidate`/`handleInput`
 * as methods of *any* wrapper object without losing state. This is the only
 * sanctioned way to construct a component that crosses the pi seam: never
 * hand pi a class-method reference (`{ render: widget.render }`), which
 * rebinds `this` to the wrapper and breaks the component.
 */
export const defineComponent = (methods: ComponentMethods): Component => ({ ...methods });