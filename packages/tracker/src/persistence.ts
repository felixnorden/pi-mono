import { Context, Effect, Layer, Schema } from "effect";
import { TrackerState, decodeStateEffect, encodeStateEffect } from "./domain.ts";

/** The plain JSON shape of a `TrackerState` (what goes into the session). */
export type EncodedState = Schema.Codec.Encoded<typeof TrackerState>;

/**
 * Persistence boundary for the tracker state.
 *
 * `save` encodes a `TrackerState` into its plain JSON shape and hands it to an
 * injected `append` callback — the live wiring in `src/index.ts` passes
 * `(encoded) => pi.appendEntry("tracker/state", encoded)`, so the state is
 * stored in the session file and survives restarts, resumes, and forks.
 *
 * `restore` decodes an untrusted snapshot (e.g. `data` from a session custom
 * entry) back into a validated `TrackerState`, failing with a `SchemaError`
 * on malformed input.
 *
 * The service has no Pi dependency: `append` is injected, which keeps the
 * whole persistence path testable with an in-memory capture.
 */
export class TrackerPersistence extends Context.Service<
  TrackerPersistence,
  {
    readonly save: (state: TrackerState) => Effect.Effect<void, Schema.SchemaError>;
    readonly restore: (snapshot: unknown) => Effect.Effect<TrackerState, Schema.SchemaError>;
  }
>()("tracker/TrackerPersistence") {
  static readonly layer = (
    append: (encoded: EncodedState) => void,
  ): Layer.Layer<TrackerPersistence> =>
    Layer.sync(TrackerPersistence, () => {
      const save = Effect.fn("TrackerPersistence.save")(function* (state: TrackerState) {
        // encodeState throws only on invalid input; state comes from the
        // store, so a throw here is a defect (fail loudly, never persist
        // garbage).
        const encoded = yield* encodeStateEffect(state);
        yield* Effect.sync(() => append(encoded));
      });

      const restore = Effect.fn("TrackerPersistence.restore")(function* (snapshot: unknown) {
        return yield* decodeStateEffect(snapshot);
      });

      return TrackerPersistence.of({ save, restore });
    });
}
