import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type { CaseFacts } from "./facts.ts";
import {
  drawSample,
  formatSampleTable,
  type LabelSample,
  type SampleRow,
} from "./sample.ts";

const factsOf = (
  caseId: string,
  row: string,
  options?: {
    readonly verdict?: "compact" | "keep" | "abstain";
    readonly declaredHead?: boolean;
    readonly promotable?: boolean;
  },
): CaseFacts => ({
  caseId,
  at: "2026-10-01T00:00:00.000Z",
  sessionCwd: "/tmp",
  source: options?.promotable === false ? "mismatch" : "replayed",
  promotable: options?.promotable !== false,
  declaredHead: options?.declaredHead ?? true,
  head: {
    questionKey: "k0",
    candidateRef: "Work:2",
    row,
    verdict:
      options?.verdict ??
      (row === "reference-is-readable"
        ? "compact"
        : row === "product-is-unwritten-plan"
          ? "keep"
          : "abstain"),
    references: [],
    products: [],
    diagnostic: false,
  },
  diagnostics: [],
});

const corpusOf = (
  row: string,
  count: number,
  options?: {
    readonly verdict?: "compact" | "keep" | "abstain";
    readonly prefix?: string;
    readonly declaredHead?: boolean;
  },
): readonly CaseFacts[] =>
  Array.from({ length: count }, (_, index) =>
    factsOf(`${options?.prefix ?? row}-${index}`, row, {
      verdict: options?.verdict,
      declaredHead: options?.declaredHead ?? true,
    }),
  );

const controlsOf = (count: number): readonly CaseFacts[] =>
  Array.from({ length: count }, (_, index) =>
    factsOf(`control-${index}`, "no-visible-link", {
      verdict: "compact",
      declaredHead: false,
    }),
  );

const sampleOf = (facts: readonly CaseFacts[], seed = 7): LabelSample =>
  drawSample(facts, {
    seed,
    target: 660,
    targetPerRowPerPass: 25,
    floorPerRowPerPass: 10,
    now: "2026-10-24T12:00:00.000Z",
  }).sample;

const cardsOf = (sample: LabelSample): readonly string[] =>
  Object.values(sample.passes).flatMap((pass) =>
    pass.sittings.flatMap((sitting) => sitting.cards),
  );

describe("drawSample", () => {
  it("writes the same sample for the same seed", () => {
    const facts = [...corpusOf("reference-is-readable", 120), ...controlsOf(200)];
    assert.deepStrictEqual(sampleOf(facts, 7), sampleOf(facts, 7));
    assert.notDeepStrictEqual(sampleOf(facts, 7), sampleOf(facts, 8));
  });

  it("reserves the target firings per row and per pass", () => {
    const facts = [
      ...corpusOf("reference-is-readable", 120),
      ...corpusOf("product-is-unwritten-plan", 60),
      ...corpusOf("names-unknown-path", 6, { verdict: "keep", prefix: "thin" }),
    ];
    const { sample, rows } = drawSample(facts, {
      seed: 7,
      target: 660,
      targetPerRowPerPass: 25,
      floorPerRowPerPass: 10,
      now: "2026-10-24T12:00:00.000Z",
    });
    const readable = rows.find((row) => row.row === "reference-is-readable")!;
    assert.strictEqual(readable.firings["v2-a"], 25);
    assert.strictEqual(readable.firings["v2-b"], 25);
    assert.ok(sample.unmeasurable.includes("names-unknown-path"));
  });

  it("measures a row between the floor and the target", () => {
    const facts = [
      ...corpusOf("reference-is-readable", 24),
      ...corpusOf("product-is-unwritten-plan", 40),
    ];
    const { sample, rows } = drawSample(facts, {
      seed: 7,
      target: 660,
      targetPerRowPerPass: 25,
      floorPerRowPerPass: 10,
      now: "2026-10-24T12:00:00.000Z",
    });
    assert.ok(!sample.unmeasurable.includes("reference-is-readable"));
    assert.ok(sample.belowQuota.includes("reference-is-readable"));
    const sampled = new Set(cardsOf(sample));
    for (const entry of facts.filter((fact) => fact.head.row === "reference-is-readable")) {
      assert.ok(sampled.has(entry.caseId));
    }
    assert.ok(rows.some((row) => row.row === "reference-is-readable"));
  });

  it("gives an abstain row no reserved quota", () => {
    const facts = [
      ...corpusOf("declarations-unresolved", 40, { verdict: "abstain" }),
      ...controlsOf(100),
    ];
    const { sample, rows } = drawSample(facts, {
      seed: 7,
      target: 660,
      targetPerRowPerPass: 25,
      floorPerRowPerPass: 10,
      now: "2026-10-24T12:00:00.000Z",
    });
    const abstain = rows.find((row) => row.row === "declarations-unresolved")!;
    assert.strictEqual(abstain.firings["v2-a"], 0);
    assert.strictEqual(abstain.firings["v2-b"], 0);
    assert.strictEqual(abstain.heads, 40);
    assert.ok(!sample.unmeasurable.includes("declarations-unresolved"));
    const sampled = new Set(cardsOf(sample));
    for (const entry of facts.filter((fact) => fact.head.row === "declarations-unresolved")) {
      assert.ok(!sampled.has(entry.caseId));
    }
  });

  it("assigns a case to exactly one pass and keeps the pilot out of both", () => {
    const facts = [
      ...corpusOf("reference-is-readable", 120),
      ...controlsOf(200),
    ];
    const sample = sampleOf(facts);
    const seen = new Set<string>();
    for (const pass of Object.values(sample.passes)) {
      for (const sitting of pass.sittings) {
        for (const id of sitting.cards) {
          assert.ok(!seen.has(id), `${id} appears twice`);
          seen.add(id);
          assert.ok(!sample.pilot.includes(id), `${id} is a pilot seed and a card`);
        }
      }
    }
    assert.strictEqual(sample.pilot.length, 20);
  });

  it("never splits a pass into a sitting above 200 cards", () => {
    const facts = [...corpusOf("reference-is-readable", 120), ...controlsOf(520)];
    const sample = sampleOf(facts);
    for (const pass of Object.values(sample.passes)) {
      for (const sitting of pass.sittings) assert.ok(sitting.cards.length <= 200);
      assert.ok(pass.sittings.length >= 2);
    }
  });

  it("never samples an unresolved case", () => {
    const unresolved = factsOf("unresolved-1", "reference-is-unresolved", {
      promotable: false,
    });
    const sample = sampleOf([unresolved, ...corpusOf("reference-is-readable", 40)]);
    assert.ok(!cardsOf(sample).includes(unresolved.caseId));
  });

  it("fills the remainder with controls in both passes", () => {
    const facts = [
      ...Array.from({ length: 331 }, (_, index) =>
        factsOf(`declared-${index}`, "reference-is-readable"),
      ),
      ...controlsOf(521),
    ];
    const { sample } = drawSample(facts, {
      seed: 7,
      target: 660,
      targetPerRowPerPass: 25,
      floorPerRowPerPass: 10,
      now: "2026-10-24T12:00:00.000Z",
    });
    const factsById = new Map(facts.map((fact) => [fact.caseId, fact]));
    const total = cardsOf(sample).length;
    assert.ok(total <= 660);
    for (const pass of Object.values(sample.passes)) {
      const cards = pass.sittings.flatMap((sitting) => sitting.cards);
      assert.ok(cards.some((id) => factsById.get(id)?.declaredHead === false));
    }
  });

  it("interleaves declared and control cards", () => {
    const facts = [
      ...corpusOf("reference-is-readable", 30, { prefix: "declared" }),
      ...controlsOf(170),
    ];
    const { sample } = drawSample(facts, {
      seed: 7,
      target: 660,
      targetPerRowPerPass: 25,
      floorPerRowPerPass: 10,
      now: "2026-10-24T12:00:00.000Z",
    });
    const factsById = new Map(facts.map((fact) => [fact.caseId, fact]));
    for (const pass of Object.values(sample.passes)) {
      const cards = pass.sittings.flatMap((sitting) => sitting.cards);
      let run = 0;
      let last: boolean | undefined;
      for (const id of cards) {
        const declared = factsById.get(id)?.declaredHead === true;
        if (declared === last) run += 1;
        else {
          run = 1;
          last = declared;
        }
        assert.ok(run <= 10, `run of ${run} cards of one kind`);
      }
    }
  });

  it("names ten pilot seeds for every sitting", () => {
    const facts = [...corpusOf("reference-is-readable", 120), ...controlsOf(300)];
    const sample = sampleOf(facts);
    for (const pass of Object.values(sample.passes)) {
      for (const sitting of pass.sittings) {
        assert.strictEqual(sitting.seededWith.length, 10);
        for (const seed of sitting.seededWith) assert.ok(sample.pilot.includes(seed));
      }
    }
  });
});

describe("formatSampleTable", () => {
  it("prints every row with its verdict and status", () => {
    const rows: readonly SampleRow[] = [
      {
        row: "reference-is-readable",
        verdict: "compact",
        heads: 120,
        firings: { "v2-a": 25, "v2-b": 25 },
        status: "measure",
      },
      {
        row: "reference-has-drifted",
        verdict: "abstain",
        heads: 6,
        firings: { "v2-a": 0, "v2-b": 0 },
        status: "reported",
      },
    ];
    const text = formatSampleTable(rows, ["v2-a", "v2-b"]);
    assert.match(text, /reference-is-readable/);
    assert.match(text, /compact/);
    assert.match(text, /unmeasurable|measure/);
    assert.match(text, /reported/);
  });
});
