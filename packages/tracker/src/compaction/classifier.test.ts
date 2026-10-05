import { assert, it } from "@effect/vitest";
import { Effect, Fiber, Option } from "effect";
import { TestClock } from "effect/testing";
import type {
  ClassifierApi,
  ClassifierChoiceAnswer,
  ClassifierModel,
  ClassifierQuestion,
  ClassifierResult,
  JsonObject,
} from "@earendil-works/pi-ai";
import {
  CLASSIFY_TIMEOUT_MILLIS,
  DEFAULT_MIN_ANSWER_CONFIDENCE,
  DEFAULT_NEEDS_CONTEXT_PROBABILITY_THRESHOLD,
  NEEDS_CONTEXT_LABEL,
  NEEDS_NONE_LABEL,
  ClassifierGateway,
  classifyVerdict,
  resolveClassifier,
  type ClassifierIdentity,
  type ClassifierRegistry,
  type CompactionQuestion,
} from "./classifier.ts";

const model = (provider: string, id: string): ClassifierModel<ClassifierApi> => ({
  id,
  name: id,
  api: "typesafe-system-one",
  provider,
  baseUrl: "https://example.invalid",
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  type: "classifier",
  contextWindow: 8192,
});

const clefFlash = model("cloudflare-workers-ai", "@cf/cloudflare/clef-flash");
const jev = model("typesafe", "jev-latest");
const opencodeJev = model("opencode", "jev-1.13");
const opencodeJevFree = model("opencode", "jev-1.13-free");

const QUESTION_KEY = "successorNeedsCompletedContext";
const DIGEST: JsonObject = { candidate: { ref: "Work:2" } };

const question: CompactionQuestion = {
  key: QUESTION_KEY,
  question: {
    type: "choice",
    instructions: "Does the next item need the completed item's detail?",
    criteria: {
      [NEEDS_CONTEXT_LABEL]: "It needs the detail",
      [NEEDS_NONE_LABEL]: "It does not need the detail",
    },
  },
};

const choiceAnswer = (needsMass: number, confidence = 1): ClassifierChoiceAnswer => ({
  type: "choice",
  choice: needsMass >= 0.5 ? NEEDS_CONTEXT_LABEL : NEEDS_NONE_LABEL,
  probabilities: { [NEEDS_CONTEXT_LABEL]: needsMass, [NEEDS_NONE_LABEL]: 1 - needsMass },
  confidence,
});

const choiceResult = (needsMass: number, confidence = 1, key = QUESTION_KEY): ClassifierResult => ({
  api: "typesafe-system-one",
  provider: "typesafe",
  model: "jev-latest",
  answers: { [key]: choiceAnswer(needsMass, confidence) },
  stopReason: "stop",
  timestamp: 0,
});

const verdict = (
  result: ClassifierResult,
  questionKeys: readonly string[],
  needsContextProbabilityThreshold = DEFAULT_NEEDS_CONTEXT_PROBABILITY_THRESHOLD,
  minAnswerConfidence = DEFAULT_MIN_ANSWER_CONFIDENCE,
) => classifyVerdict(result, questionKeys, needsContextProbabilityThreshold, minAnswerConfidence);

const input = (
  registry: ClassifierRegistry,
  overrides: {
    enabled?: boolean;
    chosen?: Option.Option<ClassifierIdentity>;
    needsContextProbabilityThreshold?: number;
    minAnswerConfidence?: number;
    digest?: JsonObject;
    questions?: readonly CompactionQuestion[];
    signal?: AbortSignal;
  } = {},
) => ({
  registry,
  enabled: overrides.enabled ?? true,
  chosen: overrides.chosen ?? Option.none(),
  needsContextProbabilityThreshold:
    overrides.needsContextProbabilityThreshold ?? DEFAULT_NEEDS_CONTEXT_PROBABILITY_THRESHOLD,
  minAnswerConfidence: overrides.minAnswerConfidence ?? DEFAULT_MIN_ANSWER_CONFIDENCE,
  digest: overrides.digest ?? DIGEST,
  questions: overrides.questions ?? [question],
  signal: overrides.signal,
});

const withGateway = <A, E>(program: Effect.Effect<A, E, ClassifierGateway>): Effect.Effect<A, E> =>
  program.pipe(Effect.provide(ClassifierGateway.layer));

// ---------------------------------------------------------------------------
// resolveClassifier
// ---------------------------------------------------------------------------

it("resolveClassifier prefers Clef Flash over Jev when both are credential-available", () => {
  const resolved = resolveClassifier([clefFlash, jev], Option.none());
  assert.strictEqual(Option.isSome(resolved), true);
  assert.strictEqual(Option.getOrThrow(resolved).provider, "cloudflare-workers-ai");
  assert.strictEqual(Option.getOrThrow(resolved).id, "@cf/cloudflare/clef-flash");
});

it("resolveClassifier falls back to Jev when Clef Flash is not credential-available", () => {
  const resolved = resolveClassifier([jev], Option.none());
  assert.strictEqual(Option.getOrThrow(resolved).provider, "typesafe");
  assert.strictEqual(Option.getOrThrow(resolved).id, "jev-latest");
});

it("resolveClassifier prefers TypeSafe Jev over OpenCode Jev when both are credential-available", () => {
  const resolved = resolveClassifier([opencodeJev, jev], Option.none());
  assert.strictEqual(Option.getOrThrow(resolved).provider, "typesafe");
  assert.strictEqual(Option.getOrThrow(resolved).id, "jev-latest");
});

it("resolveClassifier falls back to OpenCode Jev when Cloudflare and TypeSafe are not credential-available", () => {
  const resolved = resolveClassifier([opencodeJev], Option.none());
  assert.strictEqual(Option.getOrThrow(resolved).provider, "opencode");
  assert.strictEqual(Option.getOrThrow(resolved).id, "jev-1.13");
});

it("resolveClassifier prefers the OpenCode Jev standard tier over the free tier", () => {
  const resolved = resolveClassifier([opencodeJevFree, opencodeJev], Option.none());
  assert.strictEqual(Option.getOrThrow(resolved).provider, "opencode");
  assert.strictEqual(Option.getOrThrow(resolved).id, "jev-1.13");
});

it("resolveClassifier falls back to the OpenCode free Jev tier as the last preference", () => {
  const resolved = resolveClassifier([opencodeJevFree], Option.none());
  assert.strictEqual(Option.getOrThrow(resolved).provider, "opencode");
  assert.strictEqual(Option.getOrThrow(resolved).id, "jev-1.13-free");
});

it("resolveClassifier uses the chosen identity ahead of the preference order", () => {
  const chosen: Option.Option<ClassifierIdentity> = Option.some({
    provider: "typesafe",
    modelId: "jev-latest",
  });
  const resolved = resolveClassifier([clefFlash, jev], chosen);
  assert.strictEqual(Option.getOrThrow(resolved).provider, "typesafe");
  assert.strictEqual(Option.getOrThrow(resolved).id, "jev-latest");
});

it("resolveClassifier falls back to the preference order when the chosen identity is not available", () => {
  const chosen: Option.Option<ClassifierIdentity> = Option.some({
    provider: "typesafe",
    modelId: "jev-latest",
  });
  const resolved = resolveClassifier([clefFlash], chosen);
  assert.strictEqual(Option.getOrThrow(resolved).provider, "cloudflare-workers-ai");
  assert.strictEqual(Option.getOrThrow(resolved).id, "@cf/cloudflare/clef-flash");
});

it("resolveClassifier returns none when no classifier is credential-available", () => {
  const chosen: Option.Option<ClassifierIdentity> = Option.some({
    provider: "typesafe",
    modelId: "jev-latest",
  });
  assert.strictEqual(Option.isNone(resolveClassifier([], chosen)), true);
});

// ---------------------------------------------------------------------------
// classifyVerdict
// ---------------------------------------------------------------------------

it("classifyVerdict keeps context at the threshold", () => {
  assert.deepStrictEqual(
    verdict(choiceResult(DEFAULT_NEEDS_CONTEXT_PROBABILITY_THRESHOLD), [QUESTION_KEY]),
    {
      kind: "keep",
    },
  );
});

it("classifyVerdict compacts below the threshold", () => {
  assert.deepStrictEqual(verdict(choiceResult(0.2), [QUESTION_KEY]), { kind: "compact" });
});

it("classifyVerdict honors a raised threshold by compacting an answer the default would keep", () => {
  assert.deepStrictEqual(verdict(choiceResult(0.6), [QUESTION_KEY], 0.9), { kind: "compact" });
});

it("classifyVerdict honors a lowered threshold by keeping an answer the default would compact", () => {
  assert.deepStrictEqual(verdict(choiceResult(0.6), [QUESTION_KEY], 0.2), { kind: "keep" });
});

it("classifyVerdict keeps context when any judged candidate needs the detail", () => {
  const result: ClassifierResult = {
    ...choiceResult(0.1, 1, "a"),
    answers: { a: choiceAnswer(0.1), b: choiceAnswer(0.9) },
  };
  assert.deepStrictEqual(verdict(result, ["a", "b"]), { kind: "keep" });
});

it("classifyVerdict keeps context when an answer is below the confidence floor", () => {
  assert.deepStrictEqual(verdict(choiceResult(0.1, 0.2), [QUESTION_KEY]), { kind: "keep" });
});

it("classifyVerdict compacts when the answer reaches the confidence floor", () => {
  assert.deepStrictEqual(
    verdict(choiceResult(0.1, DEFAULT_MIN_ANSWER_CONFIDENCE), [QUESTION_KEY]),
    { kind: "compact" },
  );
});

it("classifyVerdict keeps context when the answer does not carry a usable confidence", () => {
  const result: ClassifierResult = {
    ...choiceResult(0.1),
    answers: { [QUESTION_KEY]: { ...choiceAnswer(0.1), confidence: Number.NaN } },
  };
  assert.deepStrictEqual(verdict(result, [QUESTION_KEY]), { kind: "keep" });
});

it("classifyVerdict is disabled when any judged candidate has no choice answer", () => {
  const result: ClassifierResult = {
    ...choiceResult(0.1, 1, "a"),
    answers: { a: choiceAnswer(0.1) },
  };
  assert.deepStrictEqual(verdict(result, ["a", "b"]), { kind: "disabled" });
});

it("classifyVerdict is disabled when there is no candidate to judge", () => {
  assert.deepStrictEqual(verdict(choiceResult(0.1), []), { kind: "disabled" });
});

it("classifyVerdict is disabled when the service did not stop", () => {
  const result: ClassifierResult = { ...choiceResult(0.1), stopReason: "error" };
  assert.deepStrictEqual(verdict(result, [QUESTION_KEY]), { kind: "disabled" });
});

it("classifyVerdict is disabled when the answer for the question key is missing", () => {
  const result: ClassifierResult = { ...choiceResult(0.1), answers: {} };
  assert.deepStrictEqual(verdict(result, [QUESTION_KEY]), { kind: "disabled" });
});

it("classifyVerdict is disabled when the answer is not a choice answer", () => {
  const result: ClassifierResult = {
    ...choiceResult(0.1),
    answers: { [QUESTION_KEY]: { type: "bool", probability: 1 } },
  };
  assert.deepStrictEqual(verdict(result, [QUESTION_KEY]), { kind: "disabled" });
});

// ---------------------------------------------------------------------------
// ClassifierGateway
// ---------------------------------------------------------------------------

it.effect("gateway disables discovery when the feature is disabled", () =>
  withGateway(
    Effect.gen(function* () {
      const gateway = yield* ClassifierGateway;
      let discoveryCalls = 0;
      const registry: ClassifierRegistry = {
        getAvailableOfType: async () => {
          discoveryCalls += 1;
          return [jev];
        },
        classify: async () => choiceResult(0.1),
      };
      const result = yield* gateway.verdict(input(registry, { enabled: false }));
      assert.deepStrictEqual(result, { kind: "disabled" });
      assert.strictEqual(discoveryCalls, 0);
    }),
  ),
);

it.effect("gateway requires a credential-available classifier when the feature is enabled", () =>
  withGateway(
    Effect.gen(function* () {
      const gateway = yield* ClassifierGateway;
      let classifyCalls = 0;
      const registry: ClassifierRegistry = {
        getAvailableOfType: async () => [],
        classify: async () => {
          classifyCalls += 1;
          return choiceResult(0.1);
        },
      };
      const result = yield* gateway.verdict(input(registry));
      assert.deepStrictEqual(result, { kind: "disabled" });
      assert.strictEqual(classifyCalls, 0);
    }),
  ),
);

it.effect("gateway returns disabled when the classifier call throws", () =>
  withGateway(
    Effect.gen(function* () {
      const gateway = yield* ClassifierGateway;
      const registry: ClassifierRegistry = {
        getAvailableOfType: async () => [jev],
        classify: async () => {
          throw new Error("provider unreachable");
        },
      };
      const result = yield* gateway.verdict(input(registry));
      assert.deepStrictEqual(result, { kind: "disabled" });
    }),
  ),
);

it.effect("gateway returns disabled when the classifier call exceeds the deadline", () =>
  withGateway(
    Effect.gen(function* () {
      const gateway = yield* ClassifierGateway;
      const captured: { signal?: AbortSignal } = {};
      const registry: ClassifierRegistry = {
        getAvailableOfType: async () => [jev],
        classify: (_model, _context, options) => {
          captured.signal = options?.signal;
          return new Promise((_resolve, reject) => {
            options?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
          });
        },
      };
      const fiber = yield* Effect.forkChild(gateway.verdict(input(registry)));
      yield* TestClock.adjust(CLASSIFY_TIMEOUT_MILLIS);
      const result = yield* Fiber.join(fiber);
      assert.deepStrictEqual(result, { kind: "disabled" });
      assert.strictEqual(captured.signal?.aborted, true);
    }),
  ),
);

it.effect(
  "gateway returns a compact verdict for an available classifier and a low probability",
  () =>
    withGateway(
      Effect.gen(function* () {
        const gateway = yield* ClassifierGateway;
        const registry: ClassifierRegistry = {
          getAvailableOfType: async () => [clefFlash, jev],
          classify: async () => choiceResult(0.1, 0.9),
        };
        const result = yield* gateway.verdict(input(registry));
        assert.deepStrictEqual(result, { kind: "compact" });
      }),
    ),
);

it.effect(
  "gateway forwards the run signal to the classifier call and returns disabled on abort",
  () => {
    // Constructed outside the Effect program so the run signal is a plain value.
    const controller = new AbortController();
    return withGateway(
      Effect.gen(function* () {
        const gateway = yield* ClassifierGateway;
        const captured: { signal?: AbortSignal } = {};
        const registry: ClassifierRegistry = {
          getAvailableOfType: async () => [jev],
          classify: (_model, _context, options) => {
            captured.signal = options?.signal;
            return new Promise((_resolve, reject) => {
              options?.signal?.addEventListener("abort", () => reject(new Error("run abort")));
            });
          },
        };
        const fiber = yield* Effect.forkChild(
          gateway.verdict(input(registry, { signal: controller.signal })),
        );
        let attempts = 0;
        while (captured.signal === undefined && attempts < 1000) {
          yield* Effect.yieldNow;
          attempts += 1;
        }
        controller.abort();
        const result = yield* Fiber.join(fiber);
        assert.deepStrictEqual(result, { kind: "disabled" });
        assert.strictEqual(captured.signal?.aborted, true);
      }),
    );
  },
);

it.effect("gateway sends exactly one choice question with the digest as the classifier state", () =>
  withGateway(
    Effect.gen(function* () {
      const gateway = yield* ClassifierGateway;
      const captured: {
        state?: JsonObject;
        questions?: Record<string, ClassifierQuestion>;
      } = {};
      const registry: ClassifierRegistry = {
        getAvailableOfType: async () => [jev],
        classify: async (_model, context) => {
          captured.state = context.state;
          captured.questions = context.questions;
          return choiceResult(0.1);
        },
      };
      const result = yield* gateway.verdict(input(registry));
      assert.deepStrictEqual(result, { kind: "compact" });
      assert.deepStrictEqual(captured.state, DIGEST);
      const questions = captured.questions ?? {};
      const keys = Object.keys(questions);
      assert.strictEqual(keys.length, 1);
      assert.strictEqual(keys[0], QUESTION_KEY);
      const asked = questions[QUESTION_KEY];
      assert.strictEqual(asked?.type, "choice");
      const criteria = asked?.type === "choice" ? asked.criteria : {};
      assert.strictEqual(typeof asked?.instructions, "string");
      assert.isAtLeast(asked?.instructions.length ?? 0, 1);
      assert.isAtLeast((criteria[NEEDS_CONTEXT_LABEL] ?? "").length, 1);
      assert.isAtLeast((criteria[NEEDS_NONE_LABEL] ?? "").length, 1);
    }),
  ),
);
