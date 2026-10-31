import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";
import type { StoredCase } from "./case-file.ts";
import { freezeRefusal, harvestSession, runHarvest } from "./harvest.ts";
import { MARKER, snapshotFormat } from "./session.ts";

const scratch: string[] = [];

const tempDir = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const item = (
  id: number,
  text: string,
  done: boolean,
  declared: boolean,
): Record<string, unknown> =>
  declared
    ? { id, title: text, description: "", refs: [], produces: [], done, deps: [] }
    : { id, text, done, deps: [] };

const stateOf = (declared: boolean, done1: boolean, done2: boolean) => ({
  lists: [
    {
      id: 1,
      name: "Work",
      nextItemId: 3,
      items: [item(1, "first", done1, declared), item(2, "second", done2, declared)],
    },
  ],
  activeListId: 1,
  nextListId: 2,
});

const snapshot = (at: string, state: unknown) =>
  JSON.stringify({ type: "custom", customType: MARKER, timestamp: at, data: state });

/** One session: a legacy pair, then a declared pair, in file order. */
const mixedSession = (cwd = "/tmp/work"): string =>
  [
    JSON.stringify({ type: "session", cwd, timestamp: "2026-10-01T00:00:00.000Z" }),
    snapshot("2026-10-01T00:00:01.000Z", stateOf(false, false, false)),
    snapshot("2026-10-01T00:00:02.000Z", stateOf(false, true, false)),
    snapshot("2026-10-01T00:00:03.000Z", stateOf(true, true, false)),
    snapshot("2026-10-01T00:00:04.000Z", stateOf(true, true, true)),
  ].join("\n");

const harvest = (dir: string, format?: "declared" | "legacy") =>
  harvestSession(
    mixedSession(),
    "session",
    "log.jsonl",
    { limit: 64, redact: (value) => value, ...(format === undefined ? {} : { format }) },
    () => undefined,
  );

const writeSession = (root: string): void => {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "log.jsonl"), mixedSession());
};

describe("snapshotFormat", () => {
  it("marks a raw snapshot with a description key as declared", () => {
    const raw = { lists: [{ items: [{ id: 1, title: "a", description: "", done: false }] }] };
    assert.strictEqual(snapshotFormat(raw), "declared");
  });

  it("marks a legacy text item as legacy", () => {
    const raw = { lists: [{ items: [{ id: 1, text: "a", done: false }] }] };
    assert.strictEqual(snapshotFormat(raw), "legacy");
  });
});

describe("harvestSession", () => {
  it("drops legacy cases from a mixed session", () => {
    const harvested = harvest(tempDir("harvest-"), "declared");
    assert.strictEqual(harvested?.cases.length, 1);
    assert.strictEqual(harvested?.excludedLegacy, 1);
    assert.strictEqual(harvested?.excludedDeclared, 0);
  });

  it("stores both cases with no format option", () => {
    const harvested = harvest(tempDir("harvest-"));
    assert.strictEqual(harvested?.cases.length, 2);
    assert.strictEqual(harvested?.excludedLegacy, 0);
    assert.strictEqual(harvested?.excludedDeclared, 0);
  });
});

describe("runHarvest", () => {
  it("prints both shape counts and the rule text", () => {
    const root = tempDir("harvest-root-");
    const out = tempDir("harvest-out-");
    writeSession(root);
    const { manifest } = runHarvest({
      root,
      out,
      limit: 64,
      format: "declared",
    });
    assert.strictEqual(manifest.format, "declared");
    assert.match(manifest.formatRule, /description/);
    assert.deepStrictEqual(manifest.formatCounts, { snapshotRule: 1, completedItemRule: 1 });
    assert.deepStrictEqual(manifest.excluded, { legacy: 1, declared: 0 });
  });

  it("refuses a frozen directory and names the date and dated-directory rule", () => {
    const root = tempDir("harvest-root-");
    const out = tempDir("harvest-out-");
    writeSession(root);
    writeFileSync(
      join(out, "freeze.json"),
      `${JSON.stringify({ frozenAt: "2026-10-24T12:00:00.000Z" })}\n`,
    );
    assert.throws(
      () => runHarvest({ root, out, limit: 64 }),
      /2026-10-24T12:00:00\.000Z[\s\S]*dated directory/,
    );
  });

  it("writes over a frozen directory with force and records it", () => {
    const root = tempDir("harvest-root-");
    const out = tempDir("harvest-out-");
    writeSession(root);
    writeFileSync(join(out, "freeze.json"), `${JSON.stringify({ frozenAt: "2026-10-24" })}\n`);
    const { manifest } = runHarvest({
      root,
      out,
      limit: 64,
      force: true,
    });
    assert.strictEqual(manifest.forced, true);
    assert.ok(readFileSync(join(out, "cases.jsonl"), "utf8").length > 0);
  });

  it("writes a private manifest to the evidence directory", () => {
    const root = tempDir("harvest-root-");
    const out = tempDir("harvest-out-");
    const evidence = tempDir("harvest-evidence-");
    writeSession(root);
    const { manifest } = runHarvest({
      root,
      out,
      evidence,
      limit: 64,
      format: "declared",
    });
    const local = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8")) as {
      root: string;
      events: { total: number };
    };
    const written = JSON.parse(readFileSync(join(evidence, "manifest.json"), "utf8")) as {
      root: string;
      events: { total: number };
      lists: { top?: unknown; topCounts?: readonly number[] };
    };
    assert.strictEqual(local.root, manifest.root);
    assert.strictEqual(written.root, "<SESSION-ROOT>");
    assert.strictEqual(written.events.total, local.events.total);
    assert.strictEqual(written.lists.top, undefined);
    assert.ok(Array.isArray(written.lists.topCounts));
  });

  it("reports the freeze refusal as null for an unfrozen directory", () => {
    assert.strictEqual(freezeRefusal(tempDir("harvest-")), null);
  });
});

describe("stored item declarations", () => {
  it("round-trips item declarations through the stored case", () => {
    const declaredState = {
      lists: [
        {
          id: 1,
          name: "Work",
          nextItemId: 3,
          items: [
            {
              id: 1,
              title: "first",
              description: "",
              refs: [],
              produces: [],
              done: false,
              deps: [],
            },
            {
              id: 2,
              title: "second",
              description: "",
              refs: [{ kind: "path", path: "src/a.ts" }],
              produces: [{ path: "docs/out.md" }],
              done: false,
              deps: [],
            },
          ],
        },
      ],
      activeListId: 1,
      nextListId: 2,
    };
    const log = [
      snapshot("2026-10-01T00:00:01.000Z", declaredState),
      snapshot("2026-10-01T00:00:02.000Z", {
        ...declaredState,
        lists: [
          {
            ...declaredState.lists[0]!,
            items: [{ ...declaredState.lists[0]!.items[0]!, done: true }, declaredState.lists[0]!.items[1]!],
          },
        ],
      }),
    ].join("\n");
    const harvested = harvestSession(
      log,
      "session",
      "log.jsonl",
      { limit: 64, redact: (value) => value, format: "declared" },
      () => undefined,
    );
    const item = harvested!.cases[0]!.list.items[1]!;
    assert.deepStrictEqual(item.refs, [{ kind: "path", path: "src/a.ts" }]);
    assert.deepStrictEqual(item.produces, [{ path: "docs/out.md" }]);
    const roundTripped = JSON.parse(JSON.stringify(harvested!.cases[0])) as StoredCase;
    assert.deepStrictEqual(roundTripped.list.items[1]!.refs, item.refs);
    assert.deepStrictEqual(roundTripped.list.items[1]!.produces, item.produces);
  });
});
