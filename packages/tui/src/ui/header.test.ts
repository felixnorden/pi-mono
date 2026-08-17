import { assert, it } from "@effect/vitest";
import { Effect, Random } from "effect";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { HeaderRenderService, installHeader } from "./header.ts";

// Pixel parity: the header must render byte-identically through makeBorderedBox
// as it did with its hand-rolled box (captured before the refactor). The tips
// shuffle draws from Effect's Random service, so every construction in this
// file runs under a fixed seed to keep the tips cells — and therefore the
// frozen tables — deterministic.
const plainTheme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => `*${text}*`,
} as unknown as Theme;

const pi = {
  getCommands: () => [{ name: "tui" }, { name: "settings" }, { name: "model" }, { name: "preview" }],
  getThinkingLevel: () => "off",
} as never;

const ctx = {
  model: { provider: "anthropic", id: "claude-sonnet-4" },
  cwd: "/projects/pi-mono/packages/tui",
  ui: { theme: plainTheme },
} as never;

const TIPS_SEED = "pixel-parity";

const EXPECTED: Record<string, string[]> = {
  20: ["Pi v0.84.2"],
  24: ["\u256d\u2500\u2500\u2500 Pi v0.84.2 \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u256e", "\u2502                      \u2502", "\u2502                      \u2502", "\u2502     \u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588        \u2502", "\u2502     \u2588\u2588\u2588   \u2588\u2588\u2588        \u2502", "\u2502     \u2588\u2588\u2588\u2588\u2588\u2588   \u2588\u2588\u2588     \u2502", "\u2502     \u2588\u2588\u2588      \u2588\u2588\u2588     \u2502", "\u2502                      \u2502", "\u2502*Let's make some Pi\u001b[0m...\u001b[0m\u2502", "\u2502anthropic/claude-so\u001b[0m...\u001b[0m\u2502", "\u2502/projects/pi-mono/p\u001b[0m...\u001b[0m\u2502", "\u2570\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u256f"],
  30: ["\u256d\u2500\u2500\u2500 Pi v0.84.2 \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u256e", "\u2502                            \u2502", "\u2502                            \u2502", "\u2502        \u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588           \u2502", "\u2502        \u2588\u2588\u2588   \u2588\u2588\u2588           \u2502", "\u2502        \u2588\u2588\u2588\u2588\u2588\u2588   \u2588\u2588\u2588        \u2502", "\u2502        \u2588\u2588\u2588      \u2588\u2588\u2588        \u2502", "\u2502                            \u2502", "\u2502  *Let's make some Pi(e)*   \u2502", "\u2502anthropic/claude-sonnet-4\u001b[0m...\u001b[0m\u2502", "\u2502/projects/pi-mono/package\u001b[0m...\u001b[0m\u2502", "\u2570\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u256f"],
  40: ["\u256d\u2500\u2500\u2500 Pi v0.84.2 \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u256e", "\u2502                                      \u2502", "\u2502                                      \u2502", "\u2502             \u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588                \u2502", "\u2502             \u2588\u2588\u2588   \u2588\u2588\u2588                \u2502", "\u2502             \u2588\u2588\u2588\u2588\u2588\u2588   \u2588\u2588\u2588             \u2502", "\u2502             \u2588\u2588\u2588      \u2588\u2588\u2588             \u2502", "\u2502                                      \u2502", "\u2502       *Let's make some Pi(e)*        \u2502", "\u2502anthropic/claude-sonnet-4 \u00b7 thinkin\u001b[0m...\u001b[0m\u2502", "\u2502    /projects/pi-mono/packages/tui    \u2502", "\u2570\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u256f"],
  60: ["\u256d\u2500\u2500\u2500 Pi v0.84.2 \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u256e", "\u2502                                        \u2502                 \u2502", "\u2502                                        \u2502 *Welcome*       \u2502", "\u2502             \u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588                  \u2502 Ask Pi anything \u2502", "\u2502             \u2588\u2588\u2588   \u2588\u2588\u2588                  \u2502 \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2502", "\u2502             \u2588\u2588\u2588\u2588\u2588\u2588   \u2588\u2588\u2588               \u2502 *Commands*      \u2502", "\u2502             \u2588\u2588\u2588      \u2588\u2588\u2588               \u2502 /tui            \u2502", "\u2502                                        \u2502 /copy           \u2502", "\u2502        *Let's make some Pi(e)*         \u2502 /logout         \u2502", "\u2502anthropic/claude-sonnet-4 \u00b7 thinking\u001b[0m...\u001b[0m \u2502 /scoped-models  \u2502", "\u2502    /projects/pi-mono/packages/tui      \u2502                 \u2502", "\u2570\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u256f"],
  80: ["\u256d\u2500\u2500\u2500 Pi v0.84.2 \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u256e", "\u2502                                                      \u2502                       \u2502", "\u2502                                                      \u2502 *Welcome*             \u2502", "\u2502                    \u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588                         \u2502 Ask Pi anything       \u2502", "\u2502                    \u2588\u2588\u2588   \u2588\u2588\u2588                         \u2502 \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2502", "\u2502                    \u2588\u2588\u2588\u2588\u2588\u2588   \u2588\u2588\u2588                      \u2502 *Commands*            \u2502", "\u2502                    \u2588\u2588\u2588      \u2588\u2588\u2588                      \u2502 /tui                  \u2502", "\u2502                                                      \u2502 /copy                 \u2502", "\u2502               *Let's make some Pi(e)*                \u2502 /logout               \u2502", "\u2502      anthropic/claude-sonnet-4 \u00b7 thinking off        \u2502 /scoped-models        \u2502", "\u2502           /projects/pi-mono/packages/tui             \u2502                       \u2502", "\u2570\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u256f"],
  100: ["\u256d\u2500\u2500\u2500 Pi v0.84.2 \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u256e", "\u2502                                                                     \u2502                            \u2502", "\u2502                                                                     \u2502 *Welcome*                  \u2502", "\u2502                            \u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588                                \u2502 Ask Pi anything            \u2502", "\u2502                            \u2588\u2588\u2588   \u2588\u2588\u2588                                \u2502 \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500     \u2502", "\u2502                            \u2588\u2588\u2588\u2588\u2588\u2588   \u2588\u2588\u2588                             \u2502 *Commands*                 \u2502", "\u2502                            \u2588\u2588\u2588      \u2588\u2588\u2588                             \u2502 /tui                       \u2502", "\u2502                                                                     \u2502 /copy                      \u2502", "\u2502                      *Let's make some Pi(e)*                        \u2502 /logout                    \u2502", "\u2502              anthropic/claude-sonnet-4 \u00b7 thinking off               \u2502 /scoped-models             \u2502", "\u2502                   /projects/pi-mono/packages/tui                    \u2502                            \u2502", "\u2570\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u256f"],
  120: ["\u256d\u2500\u2500\u2500 Pi v0.84.2 \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u256e", "\u2502                                                                                        \u2502                             \u2502", "\u2502                                                                                        \u2502 *Welcome*                   \u2502", "\u2502                                     \u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588                                          \u2502 Ask Pi anything             \u2502", "\u2502                                     \u2588\u2588\u2588   \u2588\u2588\u2588                                          \u2502 \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500      \u2502", "\u2502                                     \u2588\u2588\u2588\u2588\u2588\u2588   \u2588\u2588\u2588                                       \u2502 *Commands*                  \u2502", "\u2502                                     \u2588\u2588\u2588      \u2588\u2588\u2588                                       \u2502 /tui                        \u2502", "\u2502                                                                                        \u2502 /copy                       \u2502", "\u2502                                *Let's make some Pi(e)*                                 \u2502 /logout                     \u2502", "\u2502                       anthropic/claude-sonnet-4 \u00b7 thinking off                         \u2502 /scoped-models              \u2502", "\u2502                            /projects/pi-mono/packages/tui                              \u2502                             \u2502", "\u2570\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u256f"],
};

// Render one width through the service layer entry under the fixed seed.
const renderHeader = (width: number) =>
  Effect.runSync(
    Effect.gen(function* () {
      const svc = yield* HeaderRenderService;
      return yield* svc.render(width);
    })
      .pipe(Effect.provide(HeaderRenderService.make(pi, ctx)))
      .pipe(Random.withSeed(TIPS_SEED)),
  );

for (const width of Object.keys(EXPECTED)) {
  it(`renders the boxed header identically at width ${width}`, () => {
    assert.deepStrictEqual(renderHeader(Number(width)), EXPECTED[width]);
  });
}

it("header tips are fixed at service build while live inputs are re-read per run", () => {
  let thinking = "off";
  const mutablePi = {
    getCommands: () => [
      { name: "tui" },
      { name: "settings" },
      { name: "model" },
      { name: "preview" },
    ],
    getThinkingLevel: () => thinking,
  } as never;
  const mutableCtx = {
    model: { provider: "anthropic", id: "claude-sonnet-4" },
    cwd: "/projects/pi-mono/packages/tui",
    ui: { theme: plainTheme },
  } as never;

  const layer = HeaderRenderService.make(mutablePi, mutableCtx);
  const render = (width: number) =>
    Effect.runSync(
      Effect.gen(function* () {
        const svc = yield* HeaderRenderService;
        return yield* svc.render(width);
      })
        .pipe(Effect.provide(layer))
        .pipe(Random.withSeed(TIPS_SEED)),
    );

  const first = render(60);
  thinking = "high";
  (mutableCtx as { cwd: string }).cwd = "/workspace/elsewhere";
  const second = render(60);

  // The tips cells (everything after the column separator) are frozen at
  // service build: identical across both runs, including the four slash
  // commands. The left cells re-read live inputs per run.
  // Row shape: rail │ LEFT cell │ tips cell │ rail — the tips cell is the
  // second split part after the rail-separated LEFT cell.
  const tipsCells = (lines: string[]) =>
    lines.map((line) => {
      const parts = line.split("│");
      const cell = parts.length >= 3 ? parts[2] : undefined;
      return cell?.trim() ?? "";
    });
  assert.deepStrictEqual(tipsCells(second), tipsCells(first));
  assert.deepStrictEqual(tipsCells(first).slice(6, 10), ["/tui", "/copy", "/logout", "/scoped-models"]);

  // Live re-reads per run: the model/thinking row (index 9) and the cwd row
  // (index 10) change when the fake live inputs change.
  assert.notStrictEqual(second[9], first[9]);
  assert.notStrictEqual(second[10], first[10]);
});

it("installHeader registers a closure component at mount and unregisters on cleanup", () => {
  let captured: ((tui: unknown, theme: unknown) => unknown) | undefined;
  let unregistered = false;
  const mountCtx = {
    model: { provider: "anthropic", id: "claude-sonnet-4" },
    cwd: "/projects/pi-mono/packages/tui",
    ui: {
      theme: plainTheme,
      setHeader(factory: ((tui: unknown, theme: unknown) => unknown) | undefined) {
        captured = factory;
        if (factory === undefined) unregistered = true;
      },
    },
  } as never;

  const cleanup = installHeader(pi, mountCtx);

  assert.strictEqual(typeof captured, "function");
  const componentA = captured!(undefined, plainTheme) as {
    render: (width: number) => string[];
  };
  const linesA = componentA.render(80);

  // Re-mount swaps the slot to a fresh component; both render the header.
  const componentB = captured!(undefined, plainTheme) as {
    render: (width: number) => string[];
  };
  assert.notStrictEqual(componentA, componentB);
  const linesB = componentB.render(80);

  // The seam uses the ambient Random service for the tips shuffle, so only
  // the tips cells of rows 6-9 are non-deterministic. Everything else must be
  // byte-identical to the frozen table: borders, logo rows, title, and the
  // empty rail rows.
  const expected80 = EXPECTED[80]!;
  for (const [label, lines] of [
    ["first mount", linesA],
    ["remount", linesB],
  ] as const) {
    assert.strictEqual(lines.length, expected80.length, `${label}: line count`);
    for (const i of [0, 1, 2, 3, 4, 5, 10, 11]) {
      assert.deepStrictEqual(lines[i], expected80[i], `${label}: row ${i}`);
    }
  }

  cleanup();
  assert.strictEqual(unregistered, true);
  assert.strictEqual(captured, undefined);
});
