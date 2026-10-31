/**
 * Privacy for the evidence directory.
 *
 * `evals/data/v2/` stays local and keeps the raw case ids, because labels and
 * the gate join on them. The evidence copies are the files a human may read
 * outside the repo, so they carry no session file name and no real list name.
 *
 * A session file name is replaced by a stable alias: the same file always maps
 * to the same `session-<hash>` value, so two evidence files can still be
 * compared without revealing which session produced them.
 */

import { createHash } from "node:crypto";
import type { HarvestManifest } from "./harvest.ts";

/** One Pi session log: `<timestamp>_<uuid>.jsonl`, at any depth. */
const SESSION_FILE =
  /[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}-[0-9]{2}-[0-9]{2}-[0-9]{3}Z_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl/g;

/** The stable public alias for one session file. */
export const sessionAlias = (file: string): string =>
  `session-${createHash("sha256").update(file).digest("hex").slice(0, 12)}`;

/** Replace every session file name in one string, keeping any `#index` suffix. */
export const hideSessionIds = (text: string): string =>
  text.replace(SESSION_FILE, (file) => sessionAlias(file));

/** `hideSessionIds` over every string in a JSON value. */
export const hideSessionIdsDeep = <T>(value: T): T => {
  if (typeof value === "string") return hideSessionIds(value) as unknown as T;
  if (Array.isArray(value)) {
    return value.map((entry) => hideSessionIdsDeep(entry)) as unknown as T;
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        hideSessionIdsDeep(entry),
      ]),
    ) as unknown as T;
  }
  return value;
};

/** The manifest fields the evidence copy rewrites. */
interface ManifestLists {
  readonly distinct: number;
  readonly top: readonly (readonly [string, number])[];
}

/**
 * The evidence copy of the harvest manifest.
 *
 * Session file names become aliases, the session root becomes a placeholder,
 * and the top list names become counts only. The out copy keeps the real names
 * for local work.
 */
export const privateManifest = (manifest: HarvestManifest): HarvestManifest => {
  const hidden = hideSessionIdsDeep(manifest) as Record<string, unknown>;
  const lists = (manifest as { readonly lists?: ManifestLists }).lists;
  return {
    ...hidden,
    root: "<SESSION-ROOT>",
    ...(lists === undefined
      ? {}
      : { lists: { distinct: lists.distinct, topCounts: lists.top.map(([, count]) => count) } }),
  } as unknown as HarvestManifest;
};
