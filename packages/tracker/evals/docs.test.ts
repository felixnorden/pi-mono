import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";

const HERE = fileURLToPath(new URL(".", import.meta.url));

const read = (name: string): string => readFileSync(join(HERE, "..", name), "utf8");

describe("the README eval table", () => {
  it("names every registered eval script", () => {
    const scripts = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
    const readme = read("README.md");
    const evalScripts = Object.keys(scripts.scripts).filter((name) => name.startsWith("eval:"));
    for (const name of evalScripts) {
      assert.ok(readme.includes(`bun run ${name}`), `README is missing ${name}`);
    }
  });

  it("describes both corpora and the union promotion", () => {
    const readme = read("README.md");
    assert.match(readme, /evals\/data`? is frozen/);
    assert.match(readme, /evals\/data\/v2/);
    assert.match(readme, /v2-evidence/);
    assert.match(readme, /local audit trail/);
    assert.match(readme, /privacy\.test\.ts/);
    assert.match(readme, /union/i);
  });
});
