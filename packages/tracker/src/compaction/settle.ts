import { Context, Effect, Layer, Option } from "effect";
import { ClassifierGateway, type ClassifierRegistry } from "./classifier.ts";
import { selectCandidates } from "./candidate.ts";
import { CompletionObserver } from "./completion.ts";
import { buildDigests, compactQuestions } from "./digest.ts";
import { resumePointer } from "./pointer.ts";
import { SmartCompactionSettingsService } from "./settings.ts";

/** How the run that just reached the settle boundary ended. */
export type SettleOutcome = "completed" | "aborted" | "error";

const SETTLE_DECISION = {
  keep: { kind: "keep" },
  compact: (pointer: string) => ({
    kind: "compact",
    pointer,
  }),
} as const;

/** What the bridge should do with the run's context. */
export type SettleDecision =
  | (typeof SETTLE_DECISION)["keep"]
  | ReturnType<(typeof SETTLE_DECISION)["compact"]>;

/**
 * The settle decision. It consumes the completion record first, so every
 * terminal path clears it and one completion set yields at most one decision,
 * then requires a completed run before it classifies anything. It judges the
 * whole ready frontier and never fails: every failure path keeps the context.
 */
export class SettleDecider extends Context.Service<
  SettleDecider,
  {
    readonly decide: (input: {
      readonly registry: ClassifierRegistry;
      readonly outcome: SettleOutcome;
      readonly signal?: AbortSignal | undefined;
    }) => Effect.Effect<SettleDecision>;
  }
>()("tracker/SettleDecider") {
  static readonly layer: Layer.Layer<
    SettleDecider,
    never,
    CompletionObserver | SmartCompactionSettingsService | ClassifierGateway
  > = Layer.effect(
    SettleDecider,
    Effect.gen(function* () {
      const pending = yield* CompletionObserver;
      const settings = yield* SmartCompactionSettingsService;
      const gateway = yield* ClassifierGateway;

      const decide = Effect.fn("SettleDecider.decide")(
        function* (input: {
          readonly registry: ClassifierRegistry;
          readonly outcome: SettleOutcome;
          readonly signal?: AbortSignal | undefined;
        }) {
          // Consume first: nothing below may run twice for one completion, and
          // every path from here clears the record.
          const recorded = yield* pending.consume;
          if (Option.isNone(recorded)) return SETTLE_DECISION.keep;
          // An aborted or errored run compacts nothing and produces no pointer.
          if (input.outcome !== "completed") return SETTLE_DECISION.keep;
          const values = yield* settings.load;
          // The whole ready frontier is judged, capped by the setting. The
          // first entry is the pointer target; the array is empty when nothing
          // is ready.
          const candidates = selectCandidates(recorded.value, values.maxCandidates);
          if (candidates.length === 0) return SETTLE_DECISION.keep;
          const verdict = yield* gateway.verdict({
            registry: input.registry,
            enabled: values.enabled,
            chosen: values.chosen,
            keepContextThreshold: values.keepContextThreshold,
            keepContextMinConfidence: values.keepContextMinConfidence,
            digest: buildDigests(candidates),
            questions: compactQuestions(candidates),
            signal: input.signal,
          });
          return verdict.kind === "compact"
            ? SETTLE_DECISION.compact(resumePointer(candidates[0]!))
            : SETTLE_DECISION.keep;
        },
        Effect.catchCause(() =>
          Effect.logWarning("tracker: smart-compaction decision failed, keeping context").pipe(
            Effect.as(SETTLE_DECISION.keep),
          ),
        ),
      );

      return SettleDecider.of({ decide });
    }),
  );
}
