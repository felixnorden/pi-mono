import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const PROMPTS_DIR = join(import.meta.dir, "..", "prompts");

/** Replicates pi's frontmatter parsing for prompt templates. */
function parseFrontmatter(raw: string) {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) return null;
  const fm: Record<string, string> = {};
  for (const line of m[1]!.split("\n")) {
    const kv = line.match(/^([a-z-]+):\s*(.*)$/);
    if (kv) fm[kv[1]!] = kv[2]!;
  }
  return { fm, body: m[2]! };
}

/** Replicates pi's argument substitution to verify placeholders resolve. */
function substitute(content: string, args: string[]) {
  const allArgs = args.join(" ");
  return content.replace(
    /\$\{(\d+|ARGUMENTS|@):-([^}]*)\}|\$\{@:(\d+)(?::(\d+))?\}|\$(ARGUMENTS|@|\d+)/g,
    (_m, dt, dv, ss, sl, s) => {
      if (dt)
        return (dt === "@" || dt === "ARGUMENTS" ? allArgs : args[parseInt(dt, 10) - 1]) || dv;
      if (ss) {
        let start = parseInt(ss, 10) - 1;
        if (start < 0) start = 0;
        return sl
          ? args.slice(start, start + parseInt(sl, 10)).join(" ")
          : args.slice(start).join(" ");
      }
      if (s === "ARGUMENTS" || s === "@") return allArgs;
      return args[parseInt(s, 10) - 1] ?? "";
    },
  );
}

const promptFiles = readdirSync(PROMPTS_DIR).filter((f) => f.endsWith(".md"));

describe("prompt templates", () => {
  test("prompts directory contains the six QRSPI commands", () => {
    expect(promptFiles.toSorted()).toEqual([
      "qrspi-design.md",
      "qrspi-iterate.md",
      "qrspi-plan.md",
      "qrspi-research.md",
      "qrspi-structure.md",
      "qrspi.md",
    ]);
  });

  for (const file of promptFiles) {
    describe(file, () => {
      const raw = readFileSync(join(PROMPTS_DIR, file), "utf-8");
      const parsed = parseFrontmatter(raw);

      test("has valid frontmatter with description and argument-hint", () => {
        expect(parsed).not.toBeNull();
        expect(parsed!.fm.description).toBeTruthy();
        expect(parsed!.fm["argument-hint"]).toBeTruthy();
      });

      test("all placeholders resolve with representative arguments", () => {
        const out = substitute(parsed!.body, [
          "add-payment-flow",
          "Implement Stripe payments",
          "ENG-123",
        ]);
        expect(out).not.toMatch(/\$\S/);
      });

      test("references only existing skill templates", () => {
        const refs = [...raw.matchAll(/templates\/([a-z-]+)\.md/g)].map((m) => m[1]!);
        const existing = readdirSync(
          join(import.meta.dir, "..", "skills", "planning-workflow", "templates"),
        ).map((f) => f.replace(/\.md$/, ""));
        for (const ref of refs) {
          expect(existing).toContain(ref);
        }
      });

      test("uses .qrspi artifact paths, not .opencode", () => {
        expect(raw).not.toMatch(/\.opencode/);
      });
    });
  }
});
