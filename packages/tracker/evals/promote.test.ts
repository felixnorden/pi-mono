import { assert, it } from "@effect/vitest";
import { readFileSync } from "node:fs";
import { ACCEPTED_RULES } from "../src/compaction/rules.ts";
import {
  applyAcceptedRules,
  corpusRefusal,
  diffAccepted,
  parseAcceptedRules,
  renderAcceptedRules,
  RULES_PATH,
} from "./promote.ts";

it("renderAcceptedRules writes the accepted block, sorted, with no trailing comma", () => {
  assert.strictEqual(
    renderAcceptedRules(new Set(["no-visible-link", "names-batch-output"])),
    `export const ACCEPTED_RULES: ReadonlySet<string> = new Set([
  "names-batch-output",
  "no-visible-link",
]);`,
  );
});

it("an empty set renders as an empty literal and parses back to nothing", () => {
  const source = renderAcceptedRules(new Set());
  assert.strictEqual(source, "export const ACCEPTED_RULES: ReadonlySet<string> = new Set([]);");
  assert.strictEqual(parseAcceptedRules(source).size, 0);
});

it("the checked-in ACCEPTED_RULES parses back to the constant", () => {
  const source = readFileSync(RULES_PATH, "utf8");
  assert.deepStrictEqual([...parseAcceptedRules(source)].sort(), [...ACCEPTED_RULES].sort());
});

it("applyAcceptedRules replaces only the accepted block", () => {
  const source = readFileSync(RULES_PATH, "utf8");
  const next = applyAcceptedRules(source, new Set(["only-row"]));
  assert.deepStrictEqual([...parseAcceptedRules(next)], ["only-row"]);
  // The rest of the module is untouched.
  assert.include(next, "export const acceptedRoute");
  assert.include(next, "export const route");
  assert.include(next, "export const ACCEPTED_RULES: ReadonlySet<string> = new Set([");
});

it("parseAcceptedRules throws when the block is missing", () => {
  assert.throws(() => parseAcceptedRules("const x = 1;\n"));
});

it("refuses to promote a corpus with no labeled decisions", () => {
  const entry = (truth: "needs" | "stands" | undefined) => ({
    caseId: "case#0",
    questionKey: "q.0",
    pass: "pass1" as const,
    rule: "no-visible-link",
    verdict: "compact" as const,
    truth,
  });
  assert.isNotNull(corpusRefusal([]));
  assert.isNotNull(corpusRefusal([entry(undefined)]));
  assert.isNull(corpusRefusal([entry("stands")]));
});

it("diffAccepted names the promoted and dropped rows", () => {
  assert.deepStrictEqual(diffAccepted(new Set(["a", "b"]), new Set(["b", "c"])), {
    promoted: ["c"],
    dropped: ["a"],
  });
  assert.deepStrictEqual(diffAccepted(new Set(["b"]), new Set(["b"])), {
    promoted: [],
    dropped: [],
  });
});
