/**
 * Redaction for harvested session text.
 *
 * The corpus is built from real sessions, so every string that reaches
 * `evals/data/` passes through `redact` first. The rules are conservative on
 * purpose: they target credentials and local user paths, and they leave code,
 * identifiers, and prose intact, because the labels depend on that text
 * staying readable.
 *
 * Every rule reports a hit count, so `harvest.ts` can publish what it removed
 * instead of asserting that it removed nothing.
 */

/** How often one rule fired. */
export interface RedactionHit {
  readonly rule: string;
  readonly count: number;
}

/** Redacted text plus the tally of what was removed. */
export interface RedactionResult {
  readonly text: string;
  readonly hits: readonly RedactionHit[];
}

interface Rule {
  readonly name: string;
  /** Global, so `match` counts every occurrence. */
  readonly pattern: RegExp;
  /** Replacement string; uses `$<name>` groups, never a callback. */
  readonly replace: string;
}

/**
 * Rule order is load-bearing. A specific credential shape (a JWT, a private key
 * block) runs before the generic `key = value` rule, so the specific rule names
 * the hit and the generic rule cannot half-consume the token.
 */
const RULES: readonly Rule[] = [
  {
    name: "private-key-block",
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replace: "<REDACTED-PRIVATE-KEY>",
  },
  { name: "openai-key", pattern: /\bsk-[A-Za-z0-9_-]{16,}/g, replace: "<REDACTED>" },
  {
    name: "github-token",
    pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}/g,
    replace: "<REDACTED>",
  },
  { name: "github-pat", pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}/g, replace: "<REDACTED>" },
  { name: "slack-token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g, replace: "<REDACTED>" },
  { name: "aws-access-key", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, replace: "<REDACTED>" },
  { name: "google-api-key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g, replace: "<REDACTED>" },
  {
    name: "jwt",
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
    replace: "<REDACTED-JWT>",
  },
  {
    name: "bearer-token",
    pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
    replace: "Bearer <REDACTED>",
  },
  {
    // A dotted value is left alone: `process.env.OPENAI_KEY` is a reference, and
    // redacting it would delete the one useful fact in the line. The optional
    // closing quote keeps the JSON form (`"apiKey": "..."`) in scope, and the
    // trailing delimiter keeps a call such as `readTokenFromKeychain()` out of it.
    name: "secret-assignment",
    pattern:
      /(?<key>apiKey|api[_-]?key|apikey|accessToken|access[_-]?token|authToken|auth[_-]?token|clientSecret|client[_-]?secret|privateKey|private[_-]?key|secret|token|password|passwd)(?<close>["']?)(?<sep>\s*[:=]\s*)(?<quote>["']?)[A-Za-z0-9_\-+/=]{12,}(?=[\s"',;)}\]]|$)/gi,
    replace: "$<key>$<close>$<sep>$<quote><REDACTED>",
  },
  {
    name: "session-dir",
    // Bounded form first: the closing `--` lets the class include spaces, which
    // a project folder may contain.
    pattern: /--Users-[A-Za-z0-9._ -]+?--/g,
    replace: "<SESSION-DIR>",
  },
  {
    // A log line can be cut mid-path, so the closing `--` may be missing. The
    // class excludes spaces here, so the rule cannot eat the words after it.
    name: "session-dir-truncated",
    pattern: /--Users-[A-Za-z0-9._-]+/g,
    replace: "<SESSION-DIR>",
  },
  // `*`, not `+`: a cut log line can end at `/Users/` with the name removed,
  // and the fragment is still worth clearing.
  { name: "home-path", pattern: /\/(?:Users|home)\/[A-Za-z0-9._-]*/g, replace: "<HOME>" },
  { name: "windows-home", pattern: /[A-Za-z]:\\Users\\[A-Za-z0-9._-]*/g, replace: "<HOME>" },
  { name: "email", pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, replace: "<EMAIL>" },
];

/** Redact one string and report what each rule removed. */
export const redact = (text: string): RedactionResult => {
  const hits: RedactionHit[] = [];
  let current = text;
  for (const rule of RULES) {
    const matches = current.match(rule.pattern);
    if (matches === null || matches.length === 0) continue;
    hits.push({ rule: rule.name, count: matches.length });
    current = current.replace(rule.pattern, rule.replace);
  }
  return { text: current, hits };
};

/** Redact a filesystem path. Used for the manifest, where the text is a path. */
export const redactPath = (path: string, home: string): string =>
  path.startsWith(home) ? `<HOME>${path.slice(home.length)}` : redact(path).text;

/** A running total over many `redact` calls, keyed by rule name. */
export interface RedactionTally {
  readonly add: (hits: readonly RedactionHit[]) => void;
  /** Rule name to total count, with the busiest rule first. */
  readonly totals: () => Readonly<Record<string, number>>;
}

export const makeRedactionTally = (): RedactionTally => {
  const counts = new Map<string, number>();
  return {
    add: (hits) => {
      for (const hit of hits) counts.set(hit.rule, (counts.get(hit.rule) ?? 0) + hit.count);
    },
    totals: () =>
      Object.fromEntries(
        [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
      ),
  };
};

/** `redact` plus a tally, for the harvest's inner loops. */
export const redactWith = (text: string, tally: RedactionTally): string => {
  const result = redact(text);
  tally.add(result.hits);
  return result.text;
};
