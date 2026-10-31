import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { FileProbe } from "../src/compaction/observations.ts";

/**
 * The disk probe the eval replay reads through.
 *
 * A declared path is relative to the session header's `cwd`, because that is
 * the directory the product resolved it against. There is no repository-root
 * fallback: a fallback would resolve a path the session never saw and turn a
 * lost reference into a readable one.
 *
 * `available` is false when the cwd is missing, so the caller can mark the case
 * `unresolved` without probing every path.
 */
export interface ReplayProbe extends FileProbe {
  readonly available: boolean;
}

/** A probe that resolves relative paths against `cwd` and reads them now. */
export const sessionProbe = (cwd: string | undefined): ReplayProbe => {
  const available = cwd !== undefined && existsSync(cwd);
  return {
    available,
    read: (path) => {
      if (!available) return undefined;
      try {
        return readFileSync(isAbsolute(path) ? path : resolve(cwd, path), "utf8");
      } catch {
        return undefined;
      }
    },
    // The replay names one file at a time. A workspace-wide symbol search would
    // read paths the session never opened, so a symbol outside its named file
    // stays unresolved.
    findSymbol: () => [],
  };
};
