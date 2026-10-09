import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import type { ClassifierApi, ClassifierModel, ClassifierResult } from "@earendil-works/pi-ai";
import { NEEDS_CONTEXT_LABEL, NEEDS_NONE_LABEL } from "./classifier.ts";
import { ClassifierGateway, type ClassifierRegistry } from "./classifier.ts";
import type { CompactionCandidate } from "./candidate.ts";
import { CompletionObserver } from "./completion.ts";
import { FootprintRecorder } from "./footprint.ts";
import {
  containsSymbol,
  emptyFootprint,
  productionFacts,
  type BatchFootprint,
  type FileProbe,
} from "./observations.ts";
import { acceptedRoute, buildRuleInput, resolveCandidates } from "./rules.ts";
import { SettleDecider, type SettleDecision } from "./settle.ts";
import { SmartCompactionSettingsService, defaultSmartCompactionSettings } from "./settings.ts";
import { TodoItem, TodoList, TrackerState } from "../core/domain.ts";

const model: ClassifierModel<ClassifierApi> = {
  id: "@cf/cloudflare/clef-flash",
  name: "clef-flash",
  api: "typesafe-system-one",
  provider: "cloudflare-workers-ai",
  baseUrl: "https://example.invalid",
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  type: "classifier",
  contextWindow: 8192,
};

/** A probe over a path-to-text map. `findSymbol` scans the same map. */
const probeOf = (files: Readonly<Record<string, string>>): FileProbe => ({
  read: (path) => files[path],
  findSymbol: (symbol) =>
    Object.entries(files)
      .filter(([, text]) => containsSymbol(text, symbol))
      .map(([path]) => path),
});

interface RegistrySpy {
  readonly registry: ClassifierRegistry;
  readonly calls: () => number;
}

/** A registry that answers every question with the given `needs-context` mass. */
const registrySpy = (needsMass: number): RegistrySpy => {
  let calls = 0;
  return {
    calls: () => calls,
    registry: {
      getAvailableOfType: async () => [model],
      classify: async (_model, context) => {
        calls += 1;
        const answers: ClassifierResult["answers"] = {};
        for (const key of Object.keys(context.questions)) {
          answers[key] = {
            type: "choice",
            choice: needsMass >= 0.5 ? NEEDS_CONTEXT_LABEL : NEEDS_NONE_LABEL,
            probabilities: { [NEEDS_CONTEXT_LABEL]: needsMass, [NEEDS_NONE_LABEL]: 1 - needsMass },
            confidence: 1,
          };
        }
        return {
          api: "typesafe-system-one",
          provider: "typesafe",
          model: "jev-latest",
          answers,
          stopReason: "stop",
          timestamp: 0,
        };
      },
    },
  };
};

const settingsLayer = (
  overrides: Partial<ReturnType<typeof defaultSmartCompactionSettings>> = {},
): Layer.Layer<SmartCompactionSettingsService> =>
  Layer.succeed(
    SmartCompactionSettingsService,
    SmartCompactionSettingsService.of({
      path: "/tmp/smart-compaction.json",
      load: Effect.succeed({ ...defaultSmartCompactionSettings(), ...overrides }),
    }),
  );

const footprintLayer = (footprint: BatchFootprint): Layer.Layer<FootprintRecorder> =>
  Layer.succeed(
    FootprintRecorder,
    FootprintRecorder.of({
      capture: () => Effect.void,
      snapshot: Effect.succeed(footprint),
      consume: Effect.succeed(footprint),
    }),
  );

const item = (spec: {
  readonly id: number;
  readonly title: string;
  readonly description?: string;
  readonly done: boolean;
  readonly refs?: TodoItem["refs"];
  readonly produces?: TodoItem["produces"];
}): TodoItem =>
  new TodoItem({
    id: spec.id,
    title: spec.title,
    description: spec.description ?? "",
    done: spec.done,
    deps: [],
    refs: [...(spec.refs ?? [])],
    produces: [...(spec.produces ?? [])],
  });

const stateOf = (first: TodoItem, candidate: TodoItem, firstDone: boolean): TrackerState =>
  new TrackerState({
    lists: [
      new TodoList({
        id: 1,
        name: "Work",
        items: [
          new TodoItem({ ...first, done: firstDone }),
          new TodoItem({ ...candidate, done: false }),
        ],
        nextItemId: 3,
      }),
    ],
    activeListId: 1,
    nextListId: 2,
  });

/**
 * Record one completion (item 1) and decide. `candidate` is the ready item the
 * rule table and the classifier judge.
 */
const decide = (input: {
  readonly footprint: BatchFootprint;
  readonly probe: FileProbe;
  readonly spy: RegistrySpy;
  readonly candidate: TodoItem;
}): Effect.Effect<SettleDecision> => {
  const first = item({
    id: 1,
    title: "first slice",
    description: "the completed work",
    done: true,
  });
  const before = stateOf(first, input.candidate, false);
  const after = stateOf(first, input.candidate, true);
  return Effect.gen(function* () {
    const observer = yield* CompletionObserver;
    yield* observer.record(before, after);
    const decider = yield* SettleDecider;
    return yield* decider.decide({ registry: input.spy.registry, outcome: "completed" });
  }).pipe(
    Effect.provide(
      SettleDecider.layer(input.probe).pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            CompletionObserver.layer,
            ClassifierGateway.layer,
            footprintLayer(input.footprint),
            settingsLayer(),
          ),
        ),
      ),
    ),
  );
};

const candidate = (overrides: Partial<TodoItem> = {}): TodoItem =>
  item({ id: 2, title: "second step", done: false, ...overrides });

const wrote = (path: string): BatchFootprint => ({
  ...emptyFootprint(),
  wrote: [{ path, spans: [] }],
});

/** The decision compacts the head candidate; the pointer is a long resume text. */
const assertCompacts = (decision: SettleDecision): void => {
  if (decision.kind !== "compact") assert.fail(`expected compact, got ${decision.kind}`);
  assert.include(decision.pointer, "Work:2");
};

// ---------------------------------------------------------------------------
// The accepted rows decide without the classifier
// ---------------------------------------------------------------------------

it.effect("no declarations and no named batch output compact without a classifier call", () =>
  Effect.gen(function* () {
    const spy = registrySpy(0.1);
    const decision = yield* decide({
      footprint: emptyFootprint(),
      probe: probeOf({}),
      spy,
      candidate: candidate(),
    });
    assertCompacts(decision);
    assert.strictEqual(spy.calls(), 0);
    // No declarations: no decision record is written.
    assert.isUndefined(decision.record);
  }),
);

it.effect("a candidate that names a batch output compacts", () =>
  Effect.gen(function* () {
    const spy = registrySpy(0.1);
    const decision = yield* decide({
      footprint: wrote("src/router.ts"),
      probe: probeOf({}),
      spy,
      candidate: candidate({ title: "wire src/router.ts into the app" }),
    });
    assertCompacts(decision);
    assert.strictEqual(spy.calls(), 0);
  }),
);

// ---------------------------------------------------------------------------
// Observe-only rows keep the classifier in the loop
// ---------------------------------------------------------------------------

it.effect("a readable declared reference reports but does not compact", () =>
  Effect.gen(function* () {
    const spy = registrySpy(0.9);
    const decision = yield* decide({
      footprint: { ...emptyFootprint(), read: ["src/a.ts"] },
      probe: probeOf({ "src/a.ts": "export {};" }),
      spy,
      candidate: candidate({ refs: [{ kind: "path", path: "src/a.ts" }] }),
    });
    assert.strictEqual(spy.calls(), 1);
    assert.strictEqual(decision.kind, "keep");
    // The declared decision carries the raw row and the resolved state.
    assert.strictEqual(decision.record?.rule, "reference-is-readable");
    assert.deepStrictEqual(decision.record?.references, [
      { kind: "path", path: "src/a.ts", state: "readable" },
    ]);
  }),
);

it.effect("a lost declared reference is reported and the classifier decides", () =>
  Effect.gen(function* () {
    const spy = registrySpy(0.9);
    const decision = yield* decide({
      footprint: { ...emptyFootprint(), deleted: [{ path: "src/a.ts" }] },
      probe: probeOf({}),
      spy,
      candidate: candidate({ refs: [{ kind: "path", path: "src/a.ts" }] }),
    });
    assert.strictEqual(spy.calls(), 1);
    assert.strictEqual(decision.kind, "keep");
  }),
);

it.effect("after a restore, a declared reference abstains and the classifier decides", () =>
  Effect.gen(function* () {
    const spy = registrySpy(0.9);
    const decision = yield* decide({
      footprint: emptyFootprint(),
      probe: probeOf({ "src/a.ts": "export {};" }),
      spy,
      candidate: candidate({ refs: [{ kind: "path", path: "src/a.ts" }] }),
    });
    assert.strictEqual(spy.calls(), 1);
    assert.strictEqual(decision.kind, "keep");
  }),
);

it.effect("after a restore, a declared product resolves by disk existence", () =>
  Effect.gen(function* () {
    const spy = registrySpy(0.9);
    const decision = yield* decide({
      footprint: emptyFootprint(),
      probe: probeOf({ "docs/plan.md": "# Plan" }),
      spy,
      candidate: candidate({ produces: [{ path: "docs/plan.md" }] }),
    });
    assert.strictEqual(spy.calls(), 1);
    assert.strictEqual(decision.kind, "keep");
  }),
);

it.effect("a declared symbol found in two workspace files abstains", () =>
  Effect.gen(function* () {
    const spy = registrySpy(0.9);
    const decision = yield* decide({
      footprint: { ...emptyFootprint(), read: ["src/a.ts"] },
      probe: probeOf({ "src/a.ts": "nothing", "src/b.ts": "route()", "src/c.ts": "route()" }),
      spy,
      candidate: candidate({ refs: [{ kind: "path", path: "src/a.ts", symbol: "route" }] }),
    });
    assert.strictEqual(spy.calls(), 1);
    assert.strictEqual(decision.kind, "keep");
  }),
);

it.effect("a row outside the accepted set keeps the classifier in the loop", () =>
  Effect.gen(function* () {
    const spy = registrySpy(0.1);
    const decision = yield* decide({
      footprint: { ...emptyFootprint(), read: ["src/a.ts"] },
      probe: probeOf({ "src/a.ts": "export {};" }),
      spy,
      candidate: candidate({ refs: [{ kind: "path", path: "src/a.ts" }] }),
    });
    assert.strictEqual(spy.calls(), 1);
    assertCompacts(decision);
  }),
);

it.effect("a disabled setting keeps the context without a classifier call", () =>
  Effect.gen(function* () {
    const spy = registrySpy(0.1);
    const first = item({
      id: 1,
      title: "first slice",
      description: "the completed work",
      done: true,
    });
    const before = stateOf(first, candidate(), false);
    const after = stateOf(first, candidate(), true);
    const decision = yield* Effect.gen(function* () {
      const observer = yield* CompletionObserver;
      yield* observer.record(before, after);
      const decider = yield* SettleDecider;
      return yield* decider.decide({ registry: spy.registry, outcome: "completed" });
    }).pipe(
      Effect.provide(
        SettleDecider.layer(probeOf({})).pipe(
          Layer.provideMerge(
            Layer.mergeAll(
              CompletionObserver.layer,
              ClassifierGateway.layer,
              footprintLayer(emptyFootprint()),
              settingsLayer({ enabled: false }),
            ),
          ),
        ),
      ),
    );
    assert.strictEqual(spy.calls(), 0);
    assert.strictEqual(decision.kind, "keep");
  }),
);

// The product state must really be `exists`, so the restore test cannot pass
// by accident; `resolveCandidates` reads the disk for it.
it("a product that exists on disk resolves to exists and grants no compact row", () => {
  const candidate: CompactionCandidate = {
    class: "ready-queue",
    listName: "Work",
    id: 2,
    text: "second step",
    completed: [],
    produces: [{ path: "docs/plan.md" }],
  };
  const facts = resolveCandidates(
    [candidate],
    emptyFootprint(),
    probeOf({ "docs/plan.md": "# Plan" }),
  )[0]!;
  assert.deepStrictEqual(facts.products, [{ product: { path: "docs/plan.md" }, state: "exists" }]);
  assert.deepStrictEqual(
    acceptedRoute(buildRuleInput(facts, productionFacts([], emptyFootprint(), candidate.text))),
    { verdict: "abstain", rule: "declarations-unresolved" },
  );
});
