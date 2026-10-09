import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import { fingerprintOf, type FileProbe } from "./observations.ts";
import { makeFootprintRecorder, newSideSpans, pendingOf, type ToolEvent } from "./footprint.ts";

/** A probe over a path-to-text map that records every read path. */
const countingProbe = (
  files: Readonly<Record<string, string>>,
): { readonly probe: FileProbe; readonly reads: string[] } => {
  const reads: string[] = [];
  return {
    reads,
    probe: {
      read: (path) => {
        reads.push(path);
        return files[path];
      },
      findSymbol: () => [],
    },
  };
};

const write = (path: string, patch: string): ToolEvent => ({
  phase: "end",
  toolName: "write",
  args: { path },
  details: { patch },
});

const paths = (entries: readonly { readonly path: string }[]): readonly string[] =>
  entries.map((entry) => entry.path);

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

it("capture projects a write call into a path and its spans", () => {
  const pending = pendingOf({
    phase: "end",
    toolName: "write",
    args: { path: "src/a.ts" },
    details: { patch: "@@ -1,2 +3,4 @@\n context" },
  });
  assert.deepStrictEqual(pending, { kind: "write", path: "src/a.ts", spans: ["3-6"] });
});

it("newSideSpans reads the new-side range of each hunk and caps at four", () => {
  assert.deepStrictEqual(
    newSideSpans({ patch: "@@ -1,0 +1,1 @@\n@@ -4,2 +8 @@\n@@ -9 +20,3 @@" }),
    ["1", "8", "20-22"],
  );
  assert.deepStrictEqual(newSideSpans({ firstChangedLine: 12 }), ["12"]);
  assert.deepStrictEqual(newSideSpans({}), []);
});

// ---------------------------------------------------------------------------
// The recorder
// ---------------------------------------------------------------------------

it.effect("capture never reads the disk", () =>
  Effect.gen(function* () {
    const files = Object.fromEntries(
      Array.from({ length: 10 }, (_value, index) => [`src/f${index}.ts`, "one\ntwo"]),
    );
    const { probe, reads } = countingProbe(files);
    const parts = yield* makeFootprintRecorder(probe);
    for (let index = 0; index < 10; index += 1) {
      yield* parts.recorder.capture(write(`src/f${index}.ts`, "@@ -1,0 +1,2 @@"));
    }
    assert.strictEqual(reads.length, 0);
    // The snapshot is the drain: only now does the probe see a read.
    yield* parts.recorder.snapshot;
    assert.strictEqual(reads.length, 10);
  }),
);

it.effect("repeated writes to one path coalesce into one derivation read", () =>
  Effect.gen(function* () {
    const { probe, reads } = countingProbe({ "src/a.ts": "1\n2\n3\n4\n5\n6\n7\n8" });
    const parts = yield* makeFootprintRecorder(probe);
    yield* parts.recorder.capture(write("src/a.ts", "@@ -1,1 +1,2 @@"));
    yield* parts.recorder.capture(write("src/a.ts", "@@ -1,1 +3,2 @@"));
    yield* parts.recorder.capture(write("src/a.ts", "@@ -1,1 +5,2 @@"));
    const footprint = yield* parts.recorder.snapshot;
    assert.deepStrictEqual(reads, ["src/a.ts"]);
    assert.deepStrictEqual(footprint.wrote, [
      { path: "src/a.ts", spans: ["5-6"], fingerprint: fingerprintOf("5\n6") },
    ]);
  }),
);

it.effect("parallel events for two paths derive independently", () =>
  Effect.gen(function* () {
    const { probe } = countingProbe({
      "src/a.ts": "1\n2\n3\n4\n5\n6",
      "src/b.ts": "x\n1\n2",
    });
    const parts = yield* makeFootprintRecorder(probe);
    yield* parts.recorder.capture(write("src/a.ts", "@@ -1,2 +3,4 @@"));
    yield* parts.recorder.capture(write("src/b.ts", "@@ -1,1 +1,2 @@"));
    const footprint = yield* parts.recorder.snapshot;
    assert.deepStrictEqual(paths(footprint.wrote), ["src/a.ts", "src/b.ts"]);
    assert.deepStrictEqual(footprint.wrote[0]?.spans, ["3-6"]);
    assert.deepStrictEqual(footprint.wrote[1]?.spans, ["1-2"]);
    assert.strictEqual(footprint.wrote[0]?.fingerprint, fingerprintOf("3\n4\n5\n6"));
    assert.strictEqual(footprint.wrote[1]?.fingerprint, fingerprintOf("x\n1"));
  }),
);

it.effect("a snapshot returns only ready facts and clears on consume", () =>
  Effect.gen(function* () {
    const { probe } = countingProbe({ "src/a.ts": "1\n2\n3\n4\n5\n6" });
    // `src/b.ts` cannot be derived: the probe throws, which leaves its fact out
    // of the snapshot. The resolver abstains on the missing path.
    const failing: FileProbe = {
      read: (path) => {
        if (path === "src/b.ts") throw new Error("not ready");
        return probe.read(path);
      },
      findSymbol: () => [],
    };
    const parts = yield* makeFootprintRecorder(failing);
    yield* parts.recorder.capture(write("src/a.ts", "@@ -1,1 +1,2 @@"));
    yield* parts.recorder.capture(write("src/b.ts", "@@ -1,1 +1,2 @@"));

    const first = yield* parts.recorder.snapshot;
    assert.deepStrictEqual(paths(first.wrote), ["src/a.ts"]);

    const consumed = yield* parts.recorder.consume;
    assert.deepStrictEqual(paths(consumed.wrote), ["src/a.ts"]);

    const second = yield* parts.recorder.snapshot;
    assert.deepStrictEqual(second.wrote, []);
  }),
);
