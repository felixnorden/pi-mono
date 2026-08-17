import {
  VERSION,
  type ExtensionAPI,
  type ExtensionContext,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { Context, Effect, Layer } from "effect";
import { makeBorderedBox } from "../components/bordered-box.ts";
import { defineComponent, type DisposableComponent } from "../components/define-component.ts";
import { renderLogo, twoColumn } from "./render-helpers.ts";
import {
  center,
  collectPiCommandNames,
  formatCwd,
  formatModelLabel,
  formatThinkingLabel,
  headerColumnWidths,
  padRight,
  pickSlashCommandTips,
} from "../utils.ts";

/**
 * Pi header widget (`setHeader`), framed in the house rounded box.
 *
 * The frame (top border with the `Pi vVERSION` label, the `│` rails, the
 * bottom border) is rendered by {@link makeBorderedBox} so every view in
 * this package shares one border implementation. Only the body — logo, title,
 * model/effort/cwd column, and the slash-command tips — is composed here.
 * The header keeps the body rail-flush (`paddingX: 0`) to preserve a
 * zero-gap look between content and rails.
 *
 * Construction follows the house service pattern (preview.ts): the service
 * builds through a `Layer.effect` factory, its render is a named synchronous
 * total effect, tips are computed once at service build from the command pool
 * and never re-read, and the closure component handed to pi runs the render
 * effect with `Effect.runSync` per invocation.
 */
export class HeaderRenderService extends Context.Service<
  HeaderRenderService,
  { readonly render: (width: number) => Effect.Effect<string[]> }
>()("tui/header/HeaderRenderService") {
  static make(pi: ExtensionAPI, ctx: ExtensionContext): Layer.Layer<HeaderRenderService> {
    return Layer.effect(
      HeaderRenderService,
      Effect.gen(function* () {
        // Construction-once tips (preserves the former constructor semantics):
        // computed from `pi.getCommands()` at service build, never re-read.
        const tipCommands = yield* pickSlashCommandTips(collectPiCommandNames(pi.getCommands()), {
          fixed: ["tui"],
          count: 3,
        });

        // Named synchronous total step: the body column composition, rendered
        // at `innerWidth` because the frame owns the two rail columns.
        const renderBody = (
          theme: Theme,
          _innerWidth: number,
          leftWidth: number,
          rightWidth: number,
          useTips: boolean,
        ) =>
          Effect.sync(function () {
            const paint = (s: string) => theme.fg("accent", s);
            const muted = (s: string) => theme.fg("muted", s);
            const dim = (s: string) => theme.fg("dim", s);
            const bold = (s: string) => theme.bold(s);

            const leftLines = [
              ...renderLogo(paint).map((line) => center(line, leftWidth)),
              center(bold("Let's make some Pi(e)"), leftWidth),
              center(
                muted(
                  `${formatModelLabel(ctx.model)} · ${formatThinkingLabel(pi.getThinkingLevel())}`,
                ),
                leftWidth,
              ),
              center(dim(formatCwd(ctx.cwd)), leftWidth),
            ];

            const tipDivider = paint("─".repeat(Math.max(8, Math.min(rightWidth, 22))));
            const [cmd0 = "", cmd1 = "", cmd2 = "", cmd3 = ""] = tipCommands;
            const tipLines = [
              "",
              paint(bold("Welcome")),
              muted("Ask Pi anything"),
              tipDivider,
              paint(bold("Commands")),
              muted(cmd0),
              muted(cmd1),
              muted(cmd2),
              muted(cmd3),
              "",
            ];

            const rows: string[] = [];
            for (let i = 0; i < leftLines.length; i++) {
              const content = useTips
                ? twoColumn(leftLines[i] ?? "", tipLines[i] ?? "", leftWidth, rightWidth, paint)
                : padRight(leftLines[i] ?? "", leftWidth);
              rows.push(content);
            }
            return rows;
          });

        const render = Effect.fn("HeaderRenderService.render")(function* (width: number) {
          const theme = ctx.ui.theme; // per-render live read
          const paint = (s: string) => theme.fg("accent", s);

          if (width < 24) return [paint(`Pi v${VERSION}`)]; // short-circuit

          const innerWidth = width - 2;
          const { leftWidth, rightWidth, useTips } = headerColumnWidths(innerWidth);
          const bodyLines = yield* renderBody(theme, innerWidth, leftWidth, rightWidth, useTips);
          // The body component renders the precomputed column lines;
          // makeBorderedBox pads them into the frame rails.
          const body = defineComponent({
            render: () => bodyLines,
            invalidate: () => {},
          });
          return makeBorderedBox(body, theme, {
            label: `${paint("Pi")} v${VERSION}`,
            paddingX: 0,
          }).render(width);
        });

        return HeaderRenderService.of({ render });
      }),
    );
  }
}

/**
 * Register the header widget with `ctx.ui.setHeader` and return a cleanup
 * that unregisters it. The mount factory builds the service layer
 * synchronously at mount (tips drawn once from `pi.getCommands()`),
 * disposes the previous mount on re-mount, and hands pi a closure
 * component whose `render` runs the service's render effect synchronously.
 */
export function installHeader(pi: ExtensionAPI, ctx: ExtensionContext): () => void {
  let header: DisposableComponent | undefined;
  ctx.ui.setHeader(() => {
    // Re-mount: dispose the previous instance before building the new one.
    if (header?.dispose) header.dispose();
    // Build the service layer and run construction synchronously at mount.
    const svc = Context.get(
      Effect.runSync(
        Effect.context<HeaderRenderService>().pipe(
          Effect.provide(HeaderRenderService.make(pi, ctx)),
        ),
      ),
      HeaderRenderService,
    );
    header = defineComponent({
      render: (width: number) => Effect.runSync(svc.render(width)), // only sync run at the seam
      invalidate: () => {},
      dispose: () => {},
    });
    return header;
  });
  return () => {
    if (header?.dispose) header.dispose();
    header = undefined;
    ctx.ui.setHeader(undefined);
  };
}
