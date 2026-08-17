import type {
  ExtensionContext,
  ReadonlyFooterDataProvider,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { Context, Effect, Layer } from "effect";
import type { TuiConfig } from "../config.ts";
import type { IconGlyphs } from "../icons.ts";
import { resolveGlyphs } from "../icons.ts";
import {
  alignRight,
  effortColor,
  fitSegmentsByPriority,
  formatCwd,
  providerColor,
  truncatePath,
} from "../utils.ts";
import type { FooterState, ModelMeta, UsageTotals } from "../state.ts";
import { getUsageTotals } from "../state.ts";
import { defineComponent } from "../components/define-component.ts";
import {
  renderContextBar,
  renderExtensionStatusLines,
  renderGitSegment,
  renderRuntimeSegment,
  renderStatsBlock,
  renderTimerSegment,
} from "./render-helpers.ts";

/**
 * Live hooks the extension injects into the footer so the widget can
 * request re-renders and git refreshes without owning their scheduling.
 */
export interface FooterHooks {
  setRequestRender: (fn: (() => void) | undefined) => void;
  scheduleGitRefresh: () => void;
}

/**
 * The footer render pipeline as an Effect service (house pattern, preview.ts):
 * a `Layer.effect` factory capturing the context and the injected live
 * getters, named synchronous total steps for each line, and a single public
 * `render` member. Live inputs (theme, state, config, model meta, usage
 * totals) are re-read on every run; nothing is snapshotted at service build.
 */
export class FooterRenderService extends Context.Service<
  FooterRenderService,
  { readonly render: (width: number) => Effect.Effect<string[]> }
>()("tui/footer/FooterRenderService") {
  static make(
    ctx: ExtensionContext,
    getState: () => FooterState,
    getConfig: () => TuiConfig,
    getModelMeta: () => ModelMeta,
    footerData: ReadonlyFooterDataProvider,
  ): Layer.Layer<FooterRenderService> {
    return Layer.effect(
      FooterRenderService,
      Effect.sync(function () {
        // Named synchronous total step: line 1 (cwd/git/runtime/timer segments
        // and the context bar), packed by priority and aligned to the width.
        const renderLine1 = (
          theme: Theme,
          state: FooterState,
          config: TuiConfig,
          glyphs: IconGlyphs,
          segments: TuiConfig["footerSegments"],
          width: number,
        ): Effect.Effect<string> =>
          Effect.sync(function () {
            const leftParts: { text: string; priority: number }[] = [];
            if (segments.cwd) {
              const maxCwd = Math.min(30, Math.max(10, Math.floor(width * 0.4)));
              leftParts.push({
                text: `${theme.fg("mdLink", glyphs.cwd)} ${theme.fg("accent", truncatePath(formatCwd(ctx.sessionManager.getCwd()), maxCwd))}`,
                priority: 0,
              });
            }
            const gitSeg = renderGitSegment(theme, state.git, glyphs, segments);
            if (gitSeg) leftParts.push({ text: gitSeg, priority: 3 });
            if (segments.runtime) {
              const runtimeSeg = renderRuntimeSegment(theme, state.runtime, config.icons.mode);
              if (runtimeSeg) leftParts.push({ text: runtimeSeg, priority: 1 });
            }
            const timerSeg = renderTimerSegment(theme, state, glyphs);
            if (timerSeg) leftParts.push({ text: timerSeg, priority: 2 });

            let rightBlock = "";
            if (segments.context) {
              rightBlock = renderContextBar(theme, ctx, width, glyphs, config.icons.mode);
            }

            const rightW = visibleWidth(rightBlock);
            const availLeft = Math.max(0, width - rightW - (rightBlock ? 1 : 0));
            const fittedLeft = fitSegmentsByPriority(leftParts, availLeft, theme.fg("dim", "..."));
            return alignRight(fittedLeft.join(" "), rightBlock, width, theme);
          });

        // Named synchronous total step: line 2 (model block and stats block).
        const renderLine2 = (
          theme: Theme,
          totals: UsageTotals,
          meta: ModelMeta,
          glyphs: IconGlyphs,
          segments: TuiConfig["footerSegments"],
          width: number,
        ): Effect.Effect<string> =>
          Effect.sync(function () {
            const modelParts: string[] = [];
            modelParts.push(theme.fg("mdLink", glyphs.model));
            if (meta.provider && meta.provider !== "Unknown") {
              modelParts.push(
                theme.fg(providerColor(ctx.model?.provider ?? "none"), meta.provider),
              );
            }
            modelParts.push(theme.fg("text", meta.model));
            if (meta.effort && meta.effort !== "off") {
              modelParts.push(
                theme.fg(effortColor(meta.effort), `${glyphs.thinking} ${meta.effort}`),
              );
            }
            const modelBlock = modelParts.join(theme.fg("dim", " · "));

            const statsBlock = renderStatsBlock(theme, totals, glyphs, segments);

            return alignRight(modelBlock, statsBlock, width, theme);
          });

        // Named synchronous total step: wrapped extension status lines.
        const renderExtensionLines = (
          theme: Theme,
          extensionStatuses: ReadonlyMap<string, string>,
          glyphs: IconGlyphs,
          width: number,
        ) =>
          Effect.sync(function () {
            return renderExtensionStatusLines(theme, extensionStatuses, glyphs, width);
          });

        const render = Effect.fn("FooterRenderService.render")(function* (
          width: number,
        ): Effect.fn.Return<string[]> {
          if (width <= 0) return [""]; // guard, keeps the seam safe on tiny widths

          const theme = ctx.ui.theme; // per-render live read (single theme source)
          const state = getState(); // live getters re-invoked per run
          const config = getConfig();
          const glyphs = resolveGlyphs(config.icons.mode);
          const segments = config.footerSegments;
          const meta = getModelMeta();
          const totals = getUsageTotals(ctx); // sync module cache, unchanged

          const line1 = yield* renderLine1(theme, state, config, glyphs, segments, width);
          const line2 = yield* renderLine2(theme, totals, meta, glyphs, segments, width);
          const mainLines = [line1, line2].map((line) =>
            truncateToWidth(line, width, theme.fg("dim", "...")),
          );
          if (!segments.extensionStatuses) return mainLines;
          const ext = yield* renderExtensionLines(
            theme,
            footerData.getExtensionStatuses(),
            glyphs,
            width,
          );
          return [...mainLines, ...ext];
        });

        return FooterRenderService.of({ render });
      }),
    );
  }
}

/**
 * Register the footer widget with `ctx.ui.setFooter` and return a cleanup
 * that unregisters it. The mount factory keeps the plain mount-time side
 * effects (request-render hook + branch-change subscription), builds the
 * service layer synchronously at mount, and hands pi a closure component
 * whose `render` runs the service's render effect synchronously and whose
 * `dispose` clears the subscription and the hook.
 */
export function installFooter(
  ctx: ExtensionContext,
  getState: () => FooterState,
  getConfig: () => TuiConfig,
  getModelMeta: () => ModelMeta,
  hooks: FooterHooks,
): () => void {
  ctx.ui.setFooter((_tui, _theme, footerData) => {
    hooks.setRequestRender(() => _tui.requestRender());
    const unsubBranch = footerData.onBranchChange(() => {
      hooks.scheduleGitRefresh();
      _tui.requestRender();
    });

    // Build the service layer and run construction synchronously at mount;
    // the render effect runs per invocation at the seam below.
    const svc = Context.get(
      Effect.runSync(
        Effect.context<FooterRenderService>().pipe(
          Effect.provide(
            FooterRenderService.make(ctx, getState, getConfig, getModelMeta, footerData),
          ),
        ),
      ),
      FooterRenderService,
    );

    return defineComponent({
      dispose() {
        unsubBranch();
        hooks.setRequestRender(undefined);
      },
      invalidate() {},
      render(width: number): string[] {
        return Effect.runSync(svc.render(width)); // only sync run at the seam
      },
    });
  });

  return () => {
    ctx.ui.setFooter(undefined);
  };
}
