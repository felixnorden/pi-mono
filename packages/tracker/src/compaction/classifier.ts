import { Context, Effect, Layer, Option } from "effect";
import type {
  ClassifierApi,
  ClassifierModel,
  ClassifierQuestion,
  ClassifierResult,
  JsonObject,
} from "@earendil-works/pi-ai";

/**
 * One question the gateway asks a classifier about a candidate. Built by
 * `digest.ts`; owned here because it is the gateway's input contract.
 */
export interface CompactionQuestion {
  readonly key: string;
  readonly question: ClassifierQuestion;
}

/**
 * The slice of pi's `ModelRegistry` this gateway uses. Structural, so the
 * bridge passes `ctx.modelRegistry` and tests pass a plain object.
 */
export interface ClassifierRegistry {
  readonly getAvailableOfType: (
    type: "classifier",
  ) => Promise<readonly ClassifierModel<ClassifierApi>[]>;
  readonly classify: (
    model: ClassifierModel<ClassifierApi>,
    context: {
      readonly state: JsonObject;
      readonly questions: Record<string, ClassifierQuestion>;
    },
    options?: { readonly signal?: AbortSignal | undefined },
  ) => Promise<ClassifierResult>;
}

/** A `provider/modelId` classifier choice. */
export interface ClassifierIdentity {
  readonly provider: string;
  readonly modelId: string;
}

const CLASSIFICATION_VERDICT = {
  compact: { kind: "compact" },
  keep: { kind: "keep" },
  disabled: { kind: "disabled" },
} as const;

export type ClassificationVerdict =
  (typeof CLASSIFICATION_VERDICT)[keyof typeof CLASSIFICATION_VERDICT];

/**
 * Preference order, resolved against the credential-available classifiers at
 * runtime. Cloudflare first; then a direct TypeSafe key; then OpenCode's Jev
 * for the setups that configure OpenCode instead of `TYPESAFE_API_KEY`; the
 * OpenCode free tier last, so a rate-limited free model is the final fallback.
 */
export const PREFERRED_CLASSIFIERS: readonly ClassifierIdentity[] = [
  { provider: "cloudflare-workers-ai", modelId: "@cf/cloudflare/clef-flash" },
  { provider: "typesafe", modelId: "jev-latest" },
  { provider: "opencode", modelId: "jev-1.13" },
  { provider: "opencode", modelId: "jev-1.13-free" },
];

/**
 * The default probability at or above which the candidate is judged to need
 * the prior context. A user overrides it with
 * `smartCompaction.keepContextThreshold`; the default keeps context on an
 * uncertain answer.
 */
export const DEFAULT_KEEP_CONTEXT_THRESHOLD = 0.5;

/**
 * The default `confidence` below which the answer is distrusted and the context
 * is kept. A user overrides it with `smartCompaction.keepContextMinConfidence`.
 */
export const DEFAULT_KEEP_CONTEXT_MIN_CONFIDENCE = 0.5;

/** The `choice` label that means the candidate needs the completed context. */
export const NEEDS_CONTEXT_LABEL = "needs-context";
/** The `choice` label that means the candidate needs nothing from the work. */
export const NEEDS_NONE_LABEL = "stands-alone";

/** The settle boundary awaits this call, so it is bounded. */
export const CLASSIFY_TIMEOUT_MILLIS = 5_000;

export const resolveClassifier = (
  available: readonly ClassifierModel<ClassifierApi>[],
  chosen: Option.Option<ClassifierIdentity>,
): Option.Option<ClassifierModel<ClassifierApi>> => {
  const matches = (identity: ClassifierIdentity) =>
    available.find(
      (model) => model.provider === identity.provider && model.id === identity.modelId,
    );
  if (Option.isSome(chosen)) {
    const selected = matches(chosen.value);
    if (selected !== undefined) return Option.some(selected);
  }
  for (const identity of PREFERRED_CLASSIFIERS) {
    const preferred = matches(identity);
    if (preferred !== undefined) return Option.some(preferred);
  }
  return Option.none();
};

/**
 * The verdict over every judged candidate. Keep context when any candidate
 * needs the completed detail, or when an answer is below the confidence floor.
 * Compact only when every answer is above the floor and self-contained. A
 * non-stop or malformed answer, or an empty question set, keeps the context.
 */
export const classifyVerdict = (
  result: ClassifierResult,
  questionKeys: readonly string[],
  keepContextThreshold: number,
  keepContextMinConfidence: number,
): ClassificationVerdict => {
  if (result.stopReason !== "stop") return CLASSIFICATION_VERDICT.disabled;
  if (questionKeys.length === 0) return CLASSIFICATION_VERDICT.disabled;
  for (const questionKey of questionKeys) {
    const answer = result.answers[questionKey];
    if (answer === undefined || answer.type !== "choice") return CLASSIFICATION_VERDICT.disabled;
    if ((answer.probabilities[NEEDS_CONTEXT_LABEL] ?? 0) >= keepContextThreshold) {
      return CLASSIFICATION_VERDICT.keep;
    }
    // A provider that omits or mangles confidence keeps the context.
    const confidence = Number.isFinite(answer.confidence) ? answer.confidence : 0;
    if (confidence < keepContextMinConfidence) return CLASSIFICATION_VERDICT.keep;
  }
  return CLASSIFICATION_VERDICT.compact;
};

/** Fail-open boolean-classification gateway. Never fails its caller. */
export class ClassifierGateway extends Context.Service<
  ClassifierGateway,
  {
    readonly verdict: (input: {
      readonly registry: ClassifierRegistry;
      readonly enabled: boolean;
      readonly chosen: Option.Option<ClassifierIdentity>;
      readonly keepContextThreshold: number;
      readonly keepContextMinConfidence: number;
      readonly digest: JsonObject;
      readonly questions: readonly CompactionQuestion[];
      readonly signal?: AbortSignal | undefined;
    }) => Effect.Effect<ClassificationVerdict>;
  }
>()("tracker/ClassifierGateway") {
  static readonly layer: Layer.Layer<ClassifierGateway> = Layer.sync(ClassifierGateway, () => {
    const verdict = Effect.fn("ClassifierGateway.verdict")(function* (input: {
      readonly registry: ClassifierRegistry;
      readonly enabled: boolean;
      readonly chosen: Option.Option<ClassifierIdentity>;
      readonly keepContextThreshold: number;
      readonly keepContextMinConfidence: number;
      readonly digest: JsonObject;
      readonly questions: readonly CompactionQuestion[];
      readonly signal?: AbortSignal | undefined;
    }) {
      if (!input.enabled || input.signal?.aborted) return CLASSIFICATION_VERDICT.disabled;

      const available = yield* Effect.tryPromise(() =>
        input.registry.getAvailableOfType("classifier"),
      ).pipe(Effect.catchCause(() => Effect.succeed([])));
      const model = resolveClassifier(available, input.chosen);
      if (Option.isNone(model)) return CLASSIFICATION_VERDICT.disabled;
      const result = yield* Effect.tryPromise((signal) =>
        input.registry.classify(
          model.value,
          {
            state: input.digest,
            questions: Object.fromEntries(
              input.questions.map((question) => [question.key, question.question]),
            ),
          },
          {
            signal: input.signal === undefined ? signal : AbortSignal.any([signal, input.signal]),
          },
        ),
      ).pipe(
        Effect.timeoutOption(CLASSIFY_TIMEOUT_MILLIS),
        Effect.catchCause(() => Effect.succeedNone),
      );
      if (input.signal?.aborted) return CLASSIFICATION_VERDICT.disabled;
      return Option.isNone(result)
        ? CLASSIFICATION_VERDICT.disabled
        : classifyVerdict(
            result.value,
            input.questions.map((question) => question.key),
            input.keepContextThreshold,
            input.keepContextMinConfidence,
          );
    });
    return ClassifierGateway.of({ verdict });
  });
}
