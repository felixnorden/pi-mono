import { assert, it } from "@effect/vitest";
import type { CompactionCandidate } from "./candidate.ts";
import {
  containsSymbol,
  emptyFootprint,
  productionFacts,
  type BatchFootprint,
  type FileProbe,
  type ResolvedProduct,
  type ResolvedReference,
} from "./observations.ts";
import {
  acceptedRoute,
  buildRuleInput,
  resolveCandidates,
  route,
  type RuleInput,
  type RuleVerdict,
} from "./rules.ts";

/** The four facts the legacy rows read. */
interface LegacyFacts {
  readonly writes: boolean;
  readonly reads: boolean;
  readonly dependent: boolean;
  readonly planDocument: boolean;
}

/** Build an input that realizes the facts, with no declarations. */
const legacyInput = (facts: LegacyFacts): RuleInput => ({
  references: [],
  products: [],
  candidatePaths: facts.writes ? ["src/missing.ts"] : facts.reads ? ["src/produced.ts"] : [],
  knownText: facts.reads ? "src/produced.ts" : "",
  producedText: facts.reads ? "src/produced.ts" : "",
  dependent: facts.dependent,
  planDocument: facts.planDocument,
});

/**
 * The frozen pre-revert rule table, kept here with its old rule ids so the
 * parity test proves the rename changed no verdict. Do not edit this to match
 * the new table; that would make the test circular.
 */
const frozenRoute = (facts: LegacyFacts): { verdict: RuleVerdict; rule: string } => {
  if (facts.writes) return { verdict: "keep", rule: "writes-missing-document" };
  if (facts.reads && !facts.dependent) {
    return { verdict: "compact", rule: "reads-produced-document" };
  }
  if (!facts.reads && !facts.dependent && !facts.planDocument) {
    return { verdict: "compact", rule: "nothing-in-play" };
  }
  if (facts.dependent && facts.planDocument) {
    return { verdict: "abstain", rule: "document-and-dependency" };
  }
  if (facts.dependent) return { verdict: "abstain", rule: "dependent-successor" };
  return { verdict: "abstain", rule: "plan-document" };
};

/** The two renamed compact rows; every other id is unchanged. */
const RENAMED: Readonly<Record<string, string>> = {
  "writes-missing-document": "names-unknown-path",
  "reads-produced-document": "names-batch-output",
  "nothing-in-play": "no-visible-link",
};

const reference = (
  state: ResolvedReference["state"],
  value: ResolvedReference["reference"] = { kind: "path", path: "src/a.ts" },
): ResolvedReference => ({ reference: value, state });

const product = (state: ResolvedProduct["state"], path = "src/out.ts"): ResolvedProduct => ({
  product: { path },
  state,
});

const declaredInput = (
  references: readonly ResolvedReference[],
  products: readonly ResolvedProduct[] = [],
): RuleInput => ({
  references,
  products,
  candidatePaths: [],
  knownText: "",
  producedText: "",
  dependent: false,
  planDocument: false,
});

it("the legacy rows reproduce the frozen table on all sixteen fact combinations", () => {
  for (const writes of [false, true]) {
    for (const reads of [false, true]) {
      for (const dependent of [false, true]) {
        for (const planDocument of [false, true]) {
          const facts = { writes, reads, dependent, planDocument };
          const frozen = frozenRoute(facts);
          const renamed = { verdict: frozen.verdict, rule: RENAMED[frozen.rule] ?? frozen.rule };
          assert.deepStrictEqual(route(legacyInput(facts)), renamed, JSON.stringify(facts));
        }
      }
    }
  }
});

it("a lost reference keeps the context before any other row", () => {
  const decision = route(
    declaredInput([reference("lost"), reference("readable", { kind: "path", path: "src/b.ts" })]),
  );
  assert.deepStrictEqual(decision, { verdict: "keep", rule: "reference-is-lost" });
});

it("an unwritten plan product keeps the context; a non-plan product does not", () => {
  assert.deepStrictEqual(route(declaredInput([], [product("missing", ".qrspi/plans/router.md")])), {
    verdict: "keep",
    rule: "product-is-unwritten-plan",
  });
  assert.deepStrictEqual(route(declaredInput([], [product("missing", "src/out.ts")])), {
    verdict: "abstain",
    rule: "declarations-unresolved",
  });
});

it("a declared decision routes to the classifier", () => {
  const decision = route(
    declaredInput([reference("unresolved", { kind: "decision", topic: "storage shape" })]),
  );
  assert.deepStrictEqual(decision, { verdict: "abstain", rule: "decision-is-declared" });
});

it("a drifted reference routes to the classifier", () => {
  assert.deepStrictEqual(route(declaredInput([reference("drifted")])), {
    verdict: "abstain",
    rule: "reference-has-drifted",
  });
});

it("all readable references compact", () => {
  assert.deepStrictEqual(route(declaredInput([reference("readable"), reference("readable")])), {
    verdict: "compact",
    rule: "reference-is-readable",
  });
});

it("an unresolved reference routes to the classifier, never to a legacy compact row", () => {
  const decision = route(declaredInput([reference("unresolved")]));
  assert.deepStrictEqual(decision, { verdict: "abstain", rule: "reference-is-unresolved" });
});

it("a declaration without a verdict does not fall through to no-visible-link", () => {
  const decision = route(declaredInput([], [product("exists", "docs/plan.md")]));
  assert.deepStrictEqual(decision, { verdict: "abstain", rule: "declarations-unresolved" });
});

it("acceptedRoute lets only the gated rows decide", () => {
  assert.deepStrictEqual(
    acceptedRoute(
      legacyInput({
        writes: false,
        reads: false,
        dependent: false,
        planDocument: false,
      }),
    ),
    { verdict: "compact", rule: "no-visible-link" },
  );
  assert.deepStrictEqual(
    acceptedRoute(
      legacyInput({
        writes: true,
        reads: false,
        dependent: false,
        planDocument: false,
      }),
    ),
    { verdict: "abstain", rule: "names-unknown-path" },
  );
  assert.deepStrictEqual(acceptedRoute(declaredInput([reference("readable")])), {
    verdict: "abstain",
    rule: "reference-is-readable",
  });
});

// ---------------------------------------------------------------------------
// resolveCandidates and buildRuleInput
// ---------------------------------------------------------------------------

const candidateOf = (overrides: Partial<CompactionCandidate>): CompactionCandidate => ({
  class: "ready-queue",
  listName: "Work",
  id: 2,
  text: "second step",
  completed: [],
  ...overrides,
});

const probeOf = (files: Readonly<Record<string, string>>): FileProbe => ({
  read: (path) => files[path],
  findSymbol: (symbol) =>
    Object.entries(files)
      .filter(([, text]) => containsSymbol(text, symbol))
      .map(([path]) => path),
});

const footprintWith = (overrides: Partial<BatchFootprint>): BatchFootprint => ({
  ...emptyFootprint(),
  ...overrides,
});

it("resolveCandidates abstains every reference without a footprint", () => {
  const candidate = candidateOf({ refs: [{ kind: "path", path: "src/a.ts" }] });
  const probe = probeOf({ "src/a.ts": "export {};" });
  assert.deepStrictEqual(resolveCandidates([candidate], emptyFootprint(), probe)[0]?.references, [
    { reference: { kind: "path", path: "src/a.ts" }, state: "unresolved" },
  ]);
  assert.deepStrictEqual(
    resolveCandidates([candidate], footprintWith({ read: ["src/a.ts"] }), probe)[0]?.references,
    [{ reference: { kind: "path", path: "src/a.ts" }, state: "readable" }],
  );
});

it("resolveCandidates checks a product against disk without a footprint", () => {
  const candidate = candidateOf({ produces: [{ path: "docs/plan.md" }] });
  assert.deepStrictEqual(
    resolveCandidates([candidate], emptyFootprint(), probeOf({ "docs/plan.md": "# Plan" }))[0]
      ?.products,
    [{ product: { path: "docs/plan.md" }, state: "exists" }],
  );
});

it("a candidate that names a batch output routes to names-batch-output", () => {
  const candidate = candidateOf({ text: "wire src/router.ts" });
  const footprint = footprintWith({ wrote: [{ path: "src/router.ts", spans: [] }] });
  const facts = resolveCandidates([candidate], footprint, probeOf({}))[0]!;
  const production = productionFacts([], footprint, candidate.text);
  assert.deepStrictEqual(acceptedRoute(buildRuleInput(facts, production)), {
    verdict: "compact",
    rule: "names-batch-output",
  });
});

it("a restored readable reference routes to reference-is-unresolved", () => {
  const candidate = candidateOf({ refs: [{ kind: "path", path: "src/a.ts" }] });
  const facts = resolveCandidates(
    [candidate],
    emptyFootprint(),
    probeOf({ "src/a.ts": "export {};" }),
  )[0]!;
  const production = productionFacts([], emptyFootprint(), candidate.text);
  assert.deepStrictEqual(acceptedRoute(buildRuleInput(facts, production)), {
    verdict: "abstain",
    rule: "reference-is-unresolved",
  });
});
