import { Context, Effect, Layer, Option } from "effect";
import { formatItemRef } from "../core/deps.ts";
import { ClassifierGateway, type ClassifierRegistry } from "./classifier.ts";
import { selectCandidates } from "./candidate.ts";
import { CompletionObserver } from "./completion.ts";
import { buildDigests, compactQuestions } from "./digest.ts";
import { buildDecisionRecord, type DecisionRecord } from "./decision-record.ts";
import { FootprintRecorder } from "./footprint.ts";
import { productionFacts, type FileProbe } from "./observations.ts";
import { resumePointer } from "./pointer.ts";
import { acceptedRoute, buildRuleInput, resolveCandidates, route } from "./rules.ts";
import { SmartCompactionSettingsService } from "./settings.ts";

/** How the run that just reached the settle boundary ended. */
export type SettleOutcome = "completed" | "aborted" | "error";

const SETTLE_DECISION = {
  keep: { kind: "keep" } as { readonly kind: "keep" },
  compact: (pointer: string): { readonly kind: "compact"; readonly pointer: string } => ({
    kind: "compact",
    pointer,
  }),
};

/** What the bridge should do with the run's context. */
export type SettleDecision =
  | { readonly kind: "keep"; readonly record?: DecisionRecord }
  | {
      readonly kind: "compact";
      readonly pointer: string;
      readonly record?: DecisionRecord;
    };

/**
 * The settle decision. It consumes the completion record first, so every
 * terminal path clears it and one completion set yields at most one decision,
 * then requires a completed run before it classifies anything. It judges the
 * whole ready frontier and never fails: every failure path keeps the context.
 *
 * The reliance rule table runs before the classifier. A row in `ACCEPTED_RULES`
 * decides on its own. Every other row reports its name and hands the frontier
 * to the classifier, so an unmeasured row can never compact alone.
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
  static readonly layer = (
    probe: FileProbe,
  ): Layer.Layer<
    SettleDecider,
    never,
    CompletionObserver | SmartCompactionSettingsService | ClassifierGateway | FootprintRecorder
  > =>
    Layer.effect(
      SettleDecider,
      Effect.gen(function* () {
        const pending = yield* CompletionObserver;
        const settings = yield* SmartCompactionSettingsService;
        const gateway = yield* ClassifierGateway;
        const recorder = yield* FootprintRecorder;

        const decide = Effect.fn("SettleDecider.decide")(
          function* (input: {
            readonly registry: ClassifierRegistry;
            readonly outcome: SettleOutcome;
            readonly signal?: AbortSignal | undefined;
          }) {
            // Consume first: nothing below may run twice for one completion, and
            // every path from here clears both records. The footprint is
            // in-memory, so it goes with the completion that consumed it.
            const recorded = yield* pending.consume;
            const footprint = yield* recorder.consume;
            if (Option.isNone(recorded)) return SETTLE_DECISION.keep;
            // An aborted or errored run compacts nothing and produces no pointer.
            if (input.outcome !== "completed") return SETTLE_DECISION.keep;
            const values = yield* settings.load;
            // A disabled feature compacts nothing, whatever the rules say.
            if (!values.enabled) return SETTLE_DECISION.keep;
            // The whole ready frontier is judged, capped by the setting. The
            // first entry is the pointer target; the array is empty when nothing
            // is ready.
            const candidates = selectCandidates(recorded.value, values.maxCandidates);
            if (candidates.length === 0) return SETTLE_DECISION.keep;

            // The rule table reads the pointer candidate's declarations and the
            // batch's production facts. An accepted row decides the whole
            // frontier; every other row reports and asks the classifier.
            const head = candidates[0]!;
            const facts = resolveCandidates(candidates, footprint, probe);
            const batchTexts = head.completed.flatMap((item) =>
              item.description === undefined ? [item.text] : [item.text, item.description],
            );
            const ruleInput = buildRuleInput(
              facts[0]!,
              productionFacts(batchTexts, footprint, head.text),
            );
            const raw = route(ruleInput);
            const routed = acceptedRoute(ruleInput);
            // The record names the raw row, so a declared row's live coverage is
            // measurable without a second model call. It exists only when the
            // candidate declared something.
            const record = buildDecisionRecord({
              rule: raw.rule,
              verdict: raw.verdict,
              candidateRef: formatItemRef(head.listName, head.id),
              references: facts[0]!.references,
              products: facts[0]!.products,
            });
            const withRecord = (decision: SettleDecision): SettleDecision =>
              record === undefined ? decision : { ...decision, record };
            if (routed.verdict === "keep") return withRecord(SETTLE_DECISION.keep);
            if (routed.verdict === "compact") {
              return withRecord(SETTLE_DECISION.compact(resumePointer(head)));
            }
            yield* Effect.logInfo(
              `tracker: smart-compaction rule ${routed.rule} is observe-only for ${formatItemRef(head.listName, head.id)}; asking the classifier`,
            );

            const verdict = yield* gateway.verdict({
              registry: input.registry,
              enabled: values.enabled,
              chosen: values.chosen,
              needsContextProbabilityThreshold: values.needsContextProbabilityThreshold,
              minAnswerConfidence: values.minAnswerConfidence,
              digest: buildDigests(candidates, facts),
              questions: compactQuestions(candidates),
              signal: input.signal,
            });
            return verdict.kind === "compact"
              ? withRecord(SETTLE_DECISION.compact(resumePointer(head)))
              : withRecord(SETTLE_DECISION.keep);
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
