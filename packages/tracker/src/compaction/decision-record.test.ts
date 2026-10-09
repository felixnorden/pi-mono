import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import {
  DECISION_CUSTOM_TYPE,
  buildDecisionRecord,
  decodeDecisionRecord,
  encodeDecisionRecord,
  type DecisionRecord,
} from "./decision-record.ts";
import type { ResolvedProduct, ResolvedReference } from "./observations.ts";

const reference = (
  value: ResolvedReference["reference"],
  state: ResolvedReference["state"],
): ResolvedReference => ({ reference: value, state });

const product = (path: string, state: ResolvedProduct["state"]): ResolvedProduct => ({
  product: { path },
  state,
});

const input = (overrides: {
  readonly references?: readonly ResolvedReference[];
  readonly products?: readonly ResolvedProduct[];
}): Parameters<typeof buildDecisionRecord>[0] => ({
  rule: "reference-is-readable",
  verdict: "compact",
  candidateRef: "Work:2",
  references: overrides.references ?? [],
  products: overrides.products ?? [],
});

it("the custom-entry type is the reliance-decision carrier", () => {
  assert.strictEqual(DECISION_CUSTOM_TYPE, "tracker/reliance-decision");
});

it("a decision records the fired row and the resolved states", () => {
  const record = buildDecisionRecord(
    input({
      references: [reference({ kind: "path", path: "src/a.ts", symbol: "route" }, "readable")],
      products: [product("docs/plan.md", "missing")],
    }),
  )!;
  assert.deepStrictEqual(record, {
    rule: "reference-is-readable",
    verdict: "compact",
    candidateRef: "Work:2",
    references: [{ kind: "path", path: "src/a.ts", symbol: "route", state: "readable" }],
    products: [{ path: "docs/plan.md", state: "missing" }],
  });
  assert.notInclude(JSON.stringify(record), "transcript");
});

it("a decision with no declarations records no decision entry", () => {
  assert.isUndefined(buildDecisionRecord(input({})));
});

it("a decision reference rides as a topic, not as an archived claim", () => {
  const record = buildDecisionRecord(
    input({ references: [reference({ kind: "decision", topic: "storage shape" }, "unresolved")] }),
  )!;
  assert.deepStrictEqual(record.references, [
    { kind: "decision", topic: "storage shape", state: "unresolved" },
  ]);
  assert.notInclude(JSON.stringify(record), "archived");
});

it("a record round-trips through the codec", () => {
  const record = buildDecisionRecord(
    input({ references: [reference({ kind: "path", path: "src/a.ts" }, "drifted")] }),
  )!;
  const decoded = Effect.runSync(decodeDecisionRecord(encodeDecisionRecord(record)));
  assert.deepStrictEqual(decoded as DecisionRecord, record);
});

it("a record caps references at eight and products at four", () => {
  const references = Array.from({ length: 10 }, (_value, index) =>
    reference({ kind: "path", path: `src/f${index}.ts` }, "readable"),
  );
  const products = Array.from({ length: 6 }, (_value, index) =>
    product(`src/p${index}.ts`, "exists"),
  );
  const record = buildDecisionRecord(input({ references, products }))!;
  assert.strictEqual(record.references.length, 8);
  assert.strictEqual(record.products.length, 4);
});

it("a malformed record fails to decode", () => {
  const exit = Effect.runSync(Effect.exit(decodeDecisionRecord({ rule: 42 })));
  assert.strictEqual(exit._tag, "Failure");
});
