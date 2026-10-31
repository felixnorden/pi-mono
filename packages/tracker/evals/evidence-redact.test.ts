import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  hideSessionIds,
  hideSessionIdsDeep,
  privateManifest,
  sessionAlias,
} from "./evidence-redact.ts";
import type { HarvestManifest } from "./harvest.ts";

const FILE = "2026-10-12T11-11-25-644Z_01a12fcf-6dcb-75eb-a687-0525118681be.jsonl";
const OTHER = "2026-10-13T09-00-00-000Z_01a13786-e788-744d-96c7-01b44126c5bf.jsonl";

describe("sessionAlias", () => {
  it("is stable for the same file", () => {
    assert.strictEqual(sessionAlias(FILE), sessionAlias(FILE));
  });

  it("is a short hex alias with no timestamp or uuid", () => {
    const alias = sessionAlias(FILE);
    assert.match(alias, /^session-[0-9a-f]{12}$/);
    assert.ok(!alias.includes("2026-"));
    assert.ok(!alias.includes("01a12fcf"));
  });

  it("differs between files", () => {
    assert.notStrictEqual(sessionAlias(FILE), sessionAlias(OTHER));
  });
});

describe("hideSessionIds", () => {
  it("replaces a case id and keeps the event index", () => {
    const hidden = hideSessionIds(`<SESSION-DIR>/${FILE}#3`);
    assert.strictEqual(hidden, `<SESSION-DIR>/${sessionAlias(FILE)}#3`);
  });

  it("replaces a bare file name", () => {
    assert.strictEqual(hideSessionIds(FILE), sessionAlias(FILE));
  });

  it("leaves text without a session file alone", () => {
    const text = "src/a.ts and a plain sentence";
    assert.strictEqual(hideSessionIds(text), text);
  });
});

describe("hideSessionIdsDeep", () => {
  it("walks objects and arrays", () => {
    const hidden = hideSessionIdsDeep({
      pilot: [`<SESSION-DIR>/${FILE}#0`],
      nested: { file: OTHER, count: 2 },
    });
    assert.deepStrictEqual(hidden, {
      pilot: [`<SESSION-DIR>/${sessionAlias(FILE)}#0`],
      nested: { file: sessionAlias(OTHER), count: 2 },
    });
  });
});

describe("privateManifest", () => {
  const manifest: HarvestManifest = {
    trackerVersion: "0.7.0",
    format: "declared",
    formatRule: "a case is declared when it holds a declaration",
    formatCounts: { snapshotRule: 2, completedItemRule: 2 },
    excluded: { legacy: 0, declared: 0 },
    source: { from: null, to: null },
    root: "<HOME>/.config/pi/agent/sessions",
    lists: {
      distinct: 2,
      top: [
        ["DeFi swap band rev6", 12],
        ["Work", 7],
      ],
    },
    sessionsTop: [{ dir: "<SESSION-DIR>", file: FILE, snapshots: 3, events: 2 }],
  };

  it("hides the session root and session file names", () => {
    const hidden = privateManifest(manifest);
    assert.strictEqual(hidden.root, "<SESSION-ROOT>");
    const sessions = (hidden as { readonly sessionsTop?: readonly { readonly file?: string }[] })
      .sessionsTop;
    assert.deepStrictEqual(
      sessions?.map((entry) => entry.file),
      [sessionAlias(FILE)],
    );
  });

  it("drops real list names but keeps their counts", () => {
    const hidden = privateManifest(manifest);
    assert.deepStrictEqual(hidden.lists, { distinct: 2, topCounts: [12, 7] });
    const text = JSON.stringify(hidden);
    assert.ok(!text.includes("DeFi swap band rev6"));
    assert.ok(!text.includes(FILE));
  });
});
