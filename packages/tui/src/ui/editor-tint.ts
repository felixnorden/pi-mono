import { Context, Layer } from "effect";
import type { ThemeColor } from "@earendil-works/pi-coding-agent";

/**
 * A border-tint contribution. `id` stamps the contributor so a later
 * `.configure` can replace a specific one (e.g. another extension overriding
 * vim's tint); `getTint` is evaluated live, so a provider whose color changes
 * over time (vim: normal/visual/insert) reflects the current state on every
 * editor render.
 */
export interface BorderTintProvider {
  readonly id: string;
  readonly getTint: () => ThemeColor | undefined;
}

/**
 * Effect service for editor border coloring — generic, not vim-specific.
 * Any extension can inject or override border tints through
 * `configure`; the editor just asks `getTint` and applies the result (or
 * falls back to pi's own border color when none is defined).
 *
 * Providers are ordered; the last provider with a defined tint wins, so a
 * later `.configure` can override an earlier one. The default layer exposes a
 * shared (module-level) registry, so the editor and any extension that
 * resolves the same service see the same providers.
 *
 * House service pattern (config.ts, vim-router.ts): `Context.Service` class,
 * instance type `EditorTintService["Service"]`, defaulted via a layer.
 */
export class EditorTintService extends Context.Service<
  EditorTintService,
  {
    readonly configure: (
      update: (current: readonly BorderTintProvider[]) => readonly BorderTintProvider[],
    ) => void;
    readonly getTint: () => ThemeColor | undefined;
  }
>()("tui/editor/EditorTintService") {
  static readonly layer = Layer.sync(EditorTintService, () => {
    let providers: readonly BorderTintProvider[] = [];

    const implementation = EditorTintService.of({
      configure(update) {
        providers = update(providers);
      },
      getTint() {
        for (let i = providers.length - 1; i >= 0; i--) {
          const tint = providers[i]?.getTint();
          if (tint !== undefined) return tint;
        }
        return undefined;
      },
    });
    return implementation;
  });
}

/** Resolved instance shape (what `Effect.service(EditorTintService)` returns). */
export type EditorTintServiceHandle = EditorTintService["Service"];

/**
 * Upsert a provider by `id`: drop any existing provider with the same id,
 * then append `provider` so it takes precedence from now on.
 */
export function upsertBorderTintProvider(
  current: readonly BorderTintProvider[],
  provider: BorderTintProvider,
): readonly BorderTintProvider[] {
  return [...current.filter((p) => p.id !== provider.id), provider];
}
