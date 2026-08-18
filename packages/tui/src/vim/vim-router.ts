import { matchesKey } from "@earendil-works/pi-tui";
import { Context, Layer } from "effect";

/**
 * Uniform movement intent decoded from raw terminal bytes for list-like
 * widgets (settings list, tracker overlay, etc.). The router emits movement
 * intent only — no cursor or editor state — so any selectable surface can
 * consume it without dragging in editor machinery.
 */
export type NavigationIntent = {
  readonly kind: "move";
  readonly dir: "up" | "down" | "left" | "right";
};

/**
 * Single interception point for vim navigation semantics on list surfaces.
 *
 * Self-gating (binding decision 1): the router holds a live `getVimEnabled`
 * getter and applies the gate inside `decodeNavigation`; consumers never
 * check `config.vim` themselves. When the gate is off the router is inert and
 * returns no intent, so the consumer falls back to its own handling (arrows,
 * Tab, etc. keep working on every surface).
 *
 * Consumers may deliberately opt out of the gate by injecting an always-true
 * getter — the settings UI does this so its h/j/k/l stay unconditional.
 *
 * House service pattern (config.ts, header.ts): `Context.Service` class with
 * `static make(...)` → `Layer`. Importable by tracker/inquiry — they already
 * depend on `effect` via the catalog.
 */
export class VimRouter extends Context.Service<
  VimRouter,
  { readonly decodeNavigation: (data: string) => NavigationIntent | undefined }
>()("tui/vim/VimRouter") {
  static make(getVimEnabled: () => boolean): Layer.Layer<VimRouter> {
    return Layer.succeed(
      VimRouter,
      VimRouter.of({
        decodeNavigation: (data) => {
          if (!getVimEnabled()) return undefined; // inert when off
          if (matchesKey(data, "j")) return { kind: "move", dir: "down" };
          if (matchesKey(data, "k")) return { kind: "move", dir: "up" };
          if (matchesKey(data, "h")) return { kind: "move", dir: "left" };
          if (matchesKey(data, "l")) return { kind: "move", dir: "right" };
          return undefined; // pass through: consumer delegates
        },
      }),
    );
  }

  /** Test layer with a stub getter for the toggle (London school). */
  static layerTest(getVimEnabled: () => boolean): Layer.Layer<VimRouter> {
    return VimRouter.make(getVimEnabled);
  }
}
