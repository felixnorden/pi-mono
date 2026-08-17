import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { GitStatus } from "../commands/git-status.ts";
import type { TuiConfig } from "../config.ts";
import type { FooterState } from "../state.ts";
import { FooterRenderService, installFooter, type FooterHooks } from "./footer.ts";

// ---------------------------------------------------------------------------
// Deterministic fixture — the footer's current pixels are frozen here BEFORE
// its pipeline is rewritten (Slice 3), so the refactor can be proven
// byte-identical. Determinism requirements:
//  - icon mode pinned to "ascii" (env-free glyphs, icons.ts:119-123)
//  - no active timer and no runtime (no wall-clock or subprocess dependence)
//  - fixed session entries under a constant cache key (state.ts:24-30)
//  - cwd outside any plausible HOME so formatCwd renders the literal path
//  - the same identity theme instance passed as both the factory theme
//    argument and ctx.ui.theme (the recorded identity assumption)
// ---------------------------------------------------------------------------

const plainTheme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => `*${text}*`,
} as unknown as Theme;

const WIDTHS = [30, 40, 60, 80, 100, 120];

const state: FooterState = {
  git: GitStatus.make({
    branch: "feature/refactor",
    ahead: 2,
    behind: 1,
    modified: 3,
    untracked: 1,
    staged: 2,
    stashed: 1,
    conflicted: 0,
    renamed: 0,
    deleted: 0,
    commit: null,
  }),
  runtime: null,
  sessionStartEpoch: 1_700_000_000_000,
  workingSince: undefined,
  lastDoneIn: undefined,
};

const getState = () => state;

const config: TuiConfig = {
  enabled: true,
  settingsLanguage: "en",
  icons: { mode: "ascii" },
  footerSegments: {
    cwd: true,
    gitBranch: true,
    gitStatus: true,
    gitCommit: true,
    runtime: true,
    context: true,
    tokens: true,
    cost: true,
    extensionStatuses: true,
  },
  telemetry: {
    enabled: true,
    tps: true,
    ttft: true,
    duration: true,
    tokens: true,
    stalls: true,
    cost: true,
  },
};
const getConfig = () => config;

const getModelMeta = () => ({
  provider: "Anthropic",
  model: "claude-sonnet-4-0",
  effort: "medium",
});

// One user message and two assistant messages with fixed usage values; the
// list (and therefore the module usage-cache key) never changes.
const ENTRIES = [
  { type: "message", id: "u1", parentId: null, timestamp: "t0", message: { role: "user", content: "hi" } },
  {
    type: "message",
    id: "a1",
    parentId: "u1",
    timestamp: "t1",
    message: {
      role: "assistant",
      content: [],
      usage: { input: 1200, output: 400, cacheRead: 800, cacheWrite: 100, totalTokens: 2500, cost: { input: 0.02, output: 0.01, cacheRead: 0.01, cacheWrite: 0.002, total: 0.042 } },
      timestamp: 1_700_000_001_000,
    },
  },
  {
    type: "message",
    id: "a2",
    parentId: "a1",
    timestamp: "t2",
    message: {
      role: "assistant",
      content: [],
      usage: { input: 1200, output: 400, cacheRead: 800, cacheWrite: 100, totalTokens: 2500, cost: { input: 0.02, output: 0.01, cacheRead: 0.01, cacheWrite: 0.002, total: 0.042 } },
      timestamp: 1_700_000_002_000,
    },
  },
];

const ctxFixture = {
  model: { provider: "anthropic", id: "claude-sonnet-4-0", contextWindow: 200000, reasoning: true },
  cwd: "/workspace/pi-mono",
  getContextUsage: () => ({ contextWindow: 200000, tokens: 100000, percent: 50.0 }),
  sessionManager: {
    getCwd: () => "/workspace/pi-mono",
    getEntries: () => ENTRIES,
  },
  theme: plainTheme,
};

// Fake ctx.ui.setFooter captures the factory; the SAME identity theme
// instance is passed as both the factory theme argument and ctx.ui.theme
// (the recorded identity assumption).
const makeMountCtx = (captureFactory: (f: unknown) => void) => ({
  model: ctxFixture.model,
  cwd: ctxFixture.cwd,
  getContextUsage: ctxFixture.getContextUsage,
  sessionManager: ctxFixture.sessionManager,
  ui: {
    theme: plainTheme,
    setFooter(factory: unknown) {
      captureFactory(factory);
    },
  },
});

const runMount = (): { component: { render(width: number): string[] } } => {
  let capturedFactory: ((tui: unknown, theme: Theme, data: unknown) => unknown) | undefined;
  const mountCtx = makeMountCtx((factory) => {
    capturedFactory = factory as typeof capturedFactory;
  });
  const hooks: FooterHooks = {
    setRequestRender: () => {},
    scheduleGitRefresh: () => {},
  };
  const cleanup = installFooter(mountCtx as never, getState, getConfig, getModelMeta, hooks);
  void cleanup;
  const component = capturedFactory!(undefined, plainTheme, footerData()) as {
    render(width: number): string[];
  };
  return { component };
};

const footerData = () => ({
  getGitBranch: () => null,
  getExtensionStatuses: () => new Map([["lint", "running"], ["build", "2 errors"]]),
  getAvailableProviderCount: () => 0,
  onBranchChange: () => () => {},
});

const FOOTER_EXPECTED: Record<string, string[]> = {
  30: ["% [####----] 50.0% \u00b7 100k/200k", "\u2191 2.4k | \u2193 800 | c 38.1% | \u001b[0m...\u001b[0m", "& 2 errors | running"],
  40: ["* \u001b[0m...\u001b[0m % [######------] 50.0% \u00b7 100k/200k", "M\u001b[0m...\u001b[0m \u2191 2.4k | \u2193 800 | c 38.1% | $ $0.084", "& 2 errors | running"],
  60: ["* feature/refactor [!3\u001b[0m...\u001b[0m % [######------] 50.0% \u00b7 100k/200k", "M \u00b7 Anthropic \u00b7 claud\u001b[0m...\u001b[0m \u2191 2.4k | \u2193 800 | c 38.1% | $ $0.084", "& 2 errors | running"],
  80: ["@ /\u001b[0m...\u001b[0m * feature/refactor [!3 A2 ?1 S1 ^v2/1] % [######------] 50.0% \u00b7 100k/200k", "M \u00b7 Anthropic \u00b7 claude-sonnet-4-0 \u00b7 ~ medium \u2191 2.4k | \u2193 800 | c 38.1% | $ $0.084", "& 2 errors | running"],
  100: ["@ /workspace/pi-mono * feature/refactor [!3 A2 ?1 S1 ^v2/1]       % [######------] 50.0% \u00b7 100k/200k", "M \u00b7 Anthropic \u00b7 claude-sonnet-4-0 \u00b7 ~ medium                     \u2191 2.4k | \u2193 800 | c 38.1% | $ $0.084", "& 2 errors | running"],
  120: ["@ /workspace/pi-mono * feature/refactor [!3 A2 ?1 S1 ^v2/1]                           % [######------] 50.0% \u00b7 100k/200k", "M \u00b7 Anthropic \u00b7 claude-sonnet-4-0 \u00b7 ~ medium                                         \u2191 2.4k | \u2193 800 | c 38.1% | $ $0.084", "& 2 errors | running"],
};

it("the footer renders identical lines across repeated runs under the deterministic fixture", () => {
  const { component } = runMount();
  const first = WIDTHS.map((w) => component.render(w));
  const mirror = WIDTHS.map((w) => component.render(w));
  assert.deepStrictEqual(mirror, first);
});

it("regresses the current footer output byte-for-byte at every fixed width", () => {
  const { component } = runMount();
  for (const w of WIDTHS) {
    assert.deepStrictEqual(component.render(w), FOOTER_EXPECTED[String(w)]);
    assert.deepStrictEqual(component.render(w), FOOTER_EXPECTED[String(w)]);
  }
});

it("installFooter registers the request-render hook and branch subscriber at mount and clears both on dispose", () => {
  let capturedFactory: ((tui: unknown, theme: Theme, data: unknown) => unknown) | undefined;
  const mountCtx = makeMountCtx((factory) => {
    capturedFactory = factory as typeof capturedFactory;
  });

  let renders = 0;
  let refreshCalls = 0;
  const requestRenderFns: ((() => void) | undefined)[] = [];
  const hooks: FooterHooks = {
    setRequestRender: (fn) => {
      requestRenderFns.push(fn);
    },
    scheduleGitRefresh: () => {
      refreshCalls += 1;
    },
  };
  const branchCbs: (() => void)[] = [];
  let unsubCalls = 0;
  const data = {
    getExtensionStatuses: () => new Map(),
    onBranchChange(cb: () => void) {
      branchCbs.push(cb);
      return () => {
        unsubCalls += 1;
      };
    },
  };

  const cleanup = installFooter(mountCtx as never, getState, getConfig, getModelMeta, hooks);
  void cleanup;
  const tui = { requestRender: () => void renders++ };
  const component = capturedFactory!(tui, plainTheme, data) as { dispose: () => void };

  // Mount side effects (footer.ts:196-200): one recorded request-render
  // function and exactly one branch-change subscription.
  assert.strictEqual(requestRenderFns.length, 1);
  assert.strictEqual(typeof requestRenderFns[0], "function");
  assert.strictEqual(branchCbs.length, 1);

  // The request-render hook drives the tui re-render.
  requestRenderFns[0]!();
  assert.strictEqual(renders, 1);

  // A branch change triggers a git refresh and a tui re-render (footer.ts:197-200).
  branchCbs[0]!();
  assert.strictEqual(refreshCalls, 1);
  assert.strictEqual(renders, 2);

  // dispose clears the branch subscription and the hook (footer.ts:203-207).
  component.dispose();
  assert.strictEqual(unsubCalls, 1);
  assert.deepStrictEqual(requestRenderFns.slice(1), [undefined]);
});
// ---------------------------------------------------------------------------
// FooterRenderService — direct service-level tests (Slice 3)
// ---------------------------------------------------------------------------

// The context the service reads: same fixture, no setFooter seam involved.
const svcCtx = {
  model: ctxFixture.model,
  cwd: ctxFixture.cwd,
  getContextUsage: ctxFixture.getContextUsage,
  sessionManager: ctxFixture.sessionManager,
  ui: { theme: plainTheme },
};

const buildFooterService = (getConfigOverride: () => TuiConfig = getConfig) =>
  Effect.runSync(
    Effect.gen(function* () {
      const svc = yield* FooterRenderService;
      return svc;
    }).pipe(
      Effect.provide(
        FooterRenderService.make(
          svcCtx as never,
          getState,
          getConfigOverride,
          getModelMeta,
          footerData(),
        ),
      ),
    ),
  );

it("FooterRenderService.render reproduces the frozen golden lines at every pinned width", () => {
  const svc = buildFooterService();
  for (const w of WIDTHS) {
    assert.deepStrictEqual(Effect.runSync(svc.render(w)), FOOTER_EXPECTED[String(w)]);
  }
});

it("FooterRenderService.render returns a single empty line for non-positive widths", () => {
  const svc = buildFooterService();
  assert.deepStrictEqual(Effect.runSync(svc.render(0)), [""]);
  assert.deepStrictEqual(Effect.runSync(svc.render(-1)), [""]);
});

it("FooterRenderService.render re-invokes the live getters on every run", () => {
  let liveConfig: TuiConfig = config;
  const svc = buildFooterService(() => liveConfig);

  const withContext = Effect.runSync(svc.render(80));
  assert.ok(withContext[0]!.includes("%"));

  liveConfig = {
    ...config,
    footerSegments: { ...config.footerSegments, context: false },
  };
  const withoutContext = Effect.runSync(svc.render(80));
  assert.ok(!withoutContext[0]!.includes("%"));
  assert.ok(withoutContext[0]!.includes("feature/refactor"));
});
