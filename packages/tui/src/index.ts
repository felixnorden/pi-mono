import { homedir } from "node:os";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type TuiConfig, DEFAULT_CONFIG, TuiConfigService } from "./config.ts";
import { installEditor } from "./ui/editor.ts";
import { installFooter } from "./ui/footer.ts";
import { installHeader } from "./ui/header.ts";
import { GitStatus, GitStatusService } from "./commands/git-status.ts";
import { GitExecutionService } from "./commands/git-execution.ts";
import { readRuntimeInfo } from "./runtime.ts";
import { SessionLifecycle } from "./session-lifecycle.ts";
import { PreviewService, registerPreview } from "./ui/preview.ts";
import { registerSettingsCommand } from "./ui/settings-command.ts";
import { formatTurnTelemetry, TurnTelemetryTracker } from "./telemetry.ts";
import {
  createInitialState,
  getModelMeta,
  invalidateUsageCache,
  type FooterState,
} from "./state.ts";

import { Effect, Layer } from "effect";
import { NodeServices } from "@effect/platform-node";

function isInteractiveLaunch(): boolean {
  if (!process.stdout.isTTY) return false;
  const args = process.argv.slice(2);
  const nonInteractiveFlags = [
    "-p",
    "--print",
    "--help",
    "-h",
    "--version",
    "-v",
    "--list-models",
    "--export",
  ];
  for (const arg of args) {
    if (nonInteractiveFlags.includes(arg)) return false;
    if (arg.startsWith("--mode")) return false;
  }
  return true;
}

function clearVisibleScreen(): void {
  if (process.stdout.isTTY) {
    process.stdout.write("\x1b[2J\x1b[H");
  }
}

function isTuiContext(ctx: ExtensionContext): boolean {
  try {
    const mode = (ctx as ExtensionContext & { mode?: string }).mode;
    return ctx.hasUI && (mode === undefined || mode === "tui");
  } catch {
    return false;
  }
}

const main = Effect.fn("tui/main")(function* (pi: ExtensionAPI) {
  const effectContext = yield* Effect.context<
    GitExecutionService | GitStatusService | PreviewService
  >();

  const sessionLifecycle = new SessionLifecycle();
  const state: FooterState = createInitialState();
  const turnTelemetry = new TurnTelemetryTracker();

  const conf = yield* TuiConfigService;

  let config: TuiConfig = structuredClone(DEFAULT_CONFIG);
  let active = false;
  let lastCtx: ExtensionContext | undefined;
  let requestFooterRender: (() => void) | undefined;
  let workingTimer: ReturnType<typeof setInterval> | undefined;
  // TODO: configure
  let cleanupHeader: (() => void) | undefined;
  let cleanupFooter: (() => void) | undefined;
  let cleanupEditor: (() => void) | undefined;

  const getThinkingLevel = () => (sessionLifecycle.isCurrent() ? pi.getThinkingLevel() : "off");

  const applyUi = (ctx: ExtensionContext) => {
    if (!isTuiContext(ctx)) return;
    if (!config.enabled) {
      uninstallUi(ctx);
      return;
    }
    if (!active) {
      cleanupHeader = installHeader(pi, ctx);
      cleanupFooter = installFooter(
        ctx,
        () => state,
        () => config,
        () => getModelMeta(ctx, getThinkingLevel),
        {
          setRequestRender: (fn) => {
            requestFooterRender = fn ?? undefined;
          },
          scheduleGitRefresh: () => {
            void scheduleGitRefresh(ctx);
          },
        },
      );
      cleanupEditor = installEditor(pi, ctx);
      active = true;
    }
  };

  const uninstallUi = (ctx: ExtensionContext) => {
    if (!isTuiContext(ctx)) return;
    if (active) {
      cleanupHeader?.();
      cleanupFooter?.();
      cleanupEditor?.();
      cleanupHeader = undefined;
      cleanupFooter = undefined;
      cleanupEditor = undefined;
      requestFooterRender = undefined;
      active = false;
    }
  };

  const scheduleGitRefresh = async (ctx: ExtensionContext) => {
    if (!sessionLifecycle.isCurrent()) return;
    const generation = sessionLifecycle.currentGeneration();
    const cwd = ctx.cwd;
    const git = await Effect.runPromiseWith(effectContext)(
      Effect.gen(function* () {
        const svc = yield* GitStatusService;
        return yield* svc.read(cwd, { readTag: config.footerSegments.gitCommit });
      }).pipe(
        Effect.catchTags({
          GitSpawnError: (err) =>
            Effect.logWarning(`git status spawn failed: ${err.message}`).pipe(
              Effect.as(GitStatus.empty()),
            ),
          GitTimeoutError: (err) =>
            Effect.logWarning(
              `git status timed out after ${err.durationMillis}ms (${err.command})`,
            ).pipe(Effect.as(GitStatus.empty())),
          GitStatusError: (err) =>
            Effect.logWarning(`git status unexpected output: ${err.stdout}`).pipe(
              Effect.as(GitStatus.empty()),
            ),
        }),
      ),
    );
    if (!sessionLifecycle.isCurrent(generation)) return;
    state.git = git;
    requestFooterRender?.();
  };

  const refreshRuntime = async (ctx: ExtensionContext) => {
    if (!sessionLifecycle.isCurrent()) return;
    const generation = sessionLifecycle.currentGeneration();
    const cwd = ctx.cwd;
    const runtime = await readRuntimeInfo(cwd);
    if (!sessionLifecycle.isCurrent(generation)) return;
    state.runtime = runtime;
    requestFooterRender?.();
  };

  const refreshInteractiveState = (ctx: ExtensionContext, project = false) => {
    if (!sessionLifecycle.isCurrent() || !ctx.hasUI) return;
    if (project) {
      void scheduleGitRefresh(ctx);
      void refreshRuntime(ctx);
    }
    requestFooterRender?.();
  };

  const startWorkingTimer = () => {
    stopWorkingTimer();
    const tick = () => {
      if (!sessionLifecycle.isCurrent() || !active) return;
      requestFooterRender?.();
    };
    tick();
    workingTimer = setInterval(tick, 250);
    workingTimer.unref?.();
  };

  const stopWorkingTimer = () => {
    if (workingTimer) {
      clearInterval(workingTimer);
      workingTimer = undefined;
    }
  };

  pi.on("session_start", async (_event, ctx) =>
    Effect.runPromiseWith(effectContext)(
      Effect.gen(function* () {
        sessionLifecycle.start();
        lastCtx = ctx;
        state.sessionStartEpoch = Date.now();
        state.workingSince = undefined;
        state.lastDoneIn = undefined;
        invalidateUsageCache();

        config = yield* conf.load.pipe(Effect.mapError((e) => ctx.ui.notify(e.message, "error")));

        if (isInteractiveLaunch() && config.enabled) {
          clearVisibleScreen();
        }

        applyUi(ctx);

        refreshInteractiveState(ctx, true);
      }),
    ),
  );

  pi.on("session_shutdown", async (_event, ctx) => {
    sessionLifecycle.shutdown();
    stopWorkingTimer();
    if (active) {
      uninstallUi(ctx);
    }
    lastCtx = undefined;
  });

  pi.on("agent_start", (event, _ctx) => {
    turnTelemetry.handle(event);
    if (!sessionLifecycle.isCurrent()) return;
    state.workingSince = Date.now();
    state.lastDoneIn = undefined;
    startWorkingTimer();
  });

  pi.on("agent_end", (_event, _ctx) => {
    if (!sessionLifecycle.isCurrent()) return;
    stopWorkingTimer();
    if (state.workingSince !== undefined) {
      state.lastDoneIn = Date.now() - state.workingSince;
      state.workingSince = undefined;
    }
    requestFooterRender?.();
  });

  pi.on("turn_start", (event) => {
    turnTelemetry.handle(event);
  });

  pi.on("message_start", (event) => {
    turnTelemetry.handle(event);
  });

  pi.on("message_update", (event) => {
    turnTelemetry.handle(event);
  });

  pi.on("tool_execution_start", (event) => {
    turnTelemetry.handle(event);
  });

  pi.on("turn_end", (event) => {
    turnTelemetry.handle(event);
  });

  pi.on("agent_settled", (event, ctx) => {
    const telemetry = turnTelemetry.handle(event);
    if (telemetry && config.enabled && config.telemetry.enabled && isTuiContext(ctx)) {
      const message = formatTurnTelemetry(
        telemetry,
        ctx.ui.theme,
        config.telemetry,
        config.icons.mode,
      );
      if (message) ctx.ui.notify(message, "info");
    }
  });

  pi.on("model_select", (_event, ctx) => {
    refreshInteractiveState(ctx);
  });

  pi.on("thinking_level_select", (_event, ctx) => {
    refreshInteractiveState(ctx);
  });

  pi.on("message_end", (event, ctx) => {
    turnTelemetry.handle(event);
    if (!sessionLifecycle.isCurrent()) return;
    invalidateUsageCache();
    refreshInteractiveState(ctx);
  });

  pi.on("tool_execution_end", (_event, ctx) => {
    refreshInteractiveState(ctx);
  });

  pi.on("session_compact", (_event, ctx) => {
    if (!sessionLifecycle.isCurrent()) return;
    invalidateUsageCache();
    refreshInteractiveState(ctx);
  });

  pi.on("session_tree", (_event, ctx) => {
    if (!sessionLifecycle.isCurrent()) return;
    invalidateUsageCache();
    refreshInteractiveState(ctx);
  });

  registerPreview(pi, effectContext);

  registerSettingsCommand(pi, {
    getConfig: () => config,
    onConfigChanged: (newConfig) =>
      Effect.runSyncWith(effectContext)(
        Effect.gen(function* () {
          {
            const wasEnabled = config.enabled;
            yield* conf.save(newConfig);
            config = newConfig;
            if (lastCtx && wasEnabled !== newConfig.enabled) {
              if (newConfig.enabled) {
                applyUi(lastCtx);
              } else {
                uninstallUi(lastCtx);
              }
            }
            requestFooterRender?.();
          }
        }),
      ),
  });
});

export default function (pi: ExtensionAPI) {
  const program = main(pi).pipe(
    Effect.provide(
      Layer.mergeAll(
        TuiConfigService.layer,
        GitStatusService.layer,
        PreviewService.make(homedir),
      ).pipe(Layer.provideMerge(GitExecutionService.layer), Layer.provideMerge(NodeServices.layer)),
    ),
  );

  Effect.runSync(program);
}
