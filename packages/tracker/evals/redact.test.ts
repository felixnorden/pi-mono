import { assert, it } from "@effect/vitest";
import { makeRedactionTally, redact, redactPath, redactWith } from "./redact.ts";

/** The rule names that fired, in order. */
const rulesOf = (text: string): readonly string[] => redact(text).hits.map((hit) => hit.rule);

it("redacts an encoded session directory whose project folder has a space", () => {
  const result = redact("--Users-someone-Downloads-Archer Book Project--/log.jsonl");
  assert.strictEqual(result.text, "<SESSION-DIR>/log.jsonl");
  assert.deepStrictEqual(result.hits, [{ rule: "session-dir", count: 1 }]);
});

it("redacts a session directory that a log line cut short", () => {
  for (const fragment of ["--Users-fe", "--Users-someone-development-cooking-i"]) {
    const result = redact(`path ${fragment}`);
    assert.strictEqual(result.text, "path <SESSION-DIR>");
    assert.deepStrictEqual(result.hits, [{ rule: "session-dir-truncated", count: 1 }]);
  }
});

it("redacts a home directory path", () => {
  const result = redact("wrote /Users/someone/development/app/src/index.ts");
  assert.strictEqual(result.text, "wrote <HOME>/development/app/src/index.ts");
  assert.deepStrictEqual(result.hits, [{ rule: "home-path", count: 1 }]);
});

it("redacts an encoded session directory before the home rule sees it", () => {
  const result = redact("sessions/--Users-someone-development-app--/log.jsonl");
  assert.strictEqual(result.text, "sessions/<SESSION-DIR>/log.jsonl");
  assert.deepStrictEqual(result.hits, [{ rule: "session-dir", count: 1 }]);
});

it("redacts a home path that a cut line left without a name", () => {
  assert.strictEqual(redact("listing /Users/…").text, "listing <HOME>…");
});

it("redacts a Windows home path", () => {
  const result = redact("C:\\Users\\someone\\app\\main.ts");
  assert.strictEqual(result.text, "<HOME>\\app\\main.ts");
});

it("redacts the credential families by name", () => {
  assert.strictEqual(redact("sk-abcdefghijklmnopqrstuvwx").text, "<REDACTED>");
  assert.strictEqual(redact("ghp_abcdefghijklmnopqrst").text, "<REDACTED>");
  assert.strictEqual(redact("github_pat_abcdefghijklmnopqrstuvwx").text, "<REDACTED>");
  assert.strictEqual(redact("xoxb-1234567890-abcdefghijkl").text, "<REDACTED>");
  assert.strictEqual(redact("AKIAIOSFODNN7EXAMPLE").text, "<REDACTED>");
  assert.strictEqual(redact(`AIza${"a".repeat(35)}`).text, "<REDACTED>");
});

it("names the rule for each credential family", () => {
  assert.deepStrictEqual(rulesOf("sk-abcdefghijklmnopqrstuvwx"), ["openai-key"]);
  assert.deepStrictEqual(rulesOf("ghp_abcdefghijklmnopqrst"), ["github-token"]);
  assert.deepStrictEqual(rulesOf("xoxb-1234567890-abcdefghijkl"), ["slack-token"]);
  assert.deepStrictEqual(rulesOf("AKIAIOSFODNN7EXAMPLE"), ["aws-access-key"]);
});

it("redacts a JWT", () => {
  const jwt =
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk";
  assert.strictEqual(redact(`Authorization: ${jwt}`).text, "Authorization: <REDACTED-JWT>");
});

it("redacts a private key block as one unit", () => {
  const block = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----";
  const result = redact(`key:\n${block}\n`);
  assert.strictEqual(result.text, "key:\n<REDACTED-PRIVATE-KEY>\n");
  assert.strictEqual(result.hits.length, 1);
});

it("redacts a bearer token", () => {
  assert.strictEqual(
    redact("Authorization: Bearer abcdefghijklmnop.qrstuvwx").text,
    "Authorization: Bearer <REDACTED>",
  );
});

it("redacts an assigned secret value and keeps the key", () => {
  assert.strictEqual(redact("API_KEY=abcdef1234567890").text, "API_KEY=<REDACTED>");
  assert.strictEqual(redact(`"apiKey": "abcdef1234567890"`).text, `"apiKey": "<REDACTED>"`);
  assert.strictEqual(redact("clientSecret: abcdefghijklmnop").text, "clientSecret: <REDACTED>");
});

it("keeps a reference to a secret instead of redacting it", () => {
  for (const line of [
    "const apiKey = process.env.OPENAI_API_KEY;",
    "token: readTokenFromKeychain()",
    "password = await prompt()",
    "secret = ${{ secrets.CI_TOKEN }}",
  ]) {
    assert.strictEqual(redact(line).text, line);
  }
});

it("redacts an email address", () => {
  assert.strictEqual(redact("contact felix@example.com now").text, "contact <EMAIL> now");
});

it("leaves ordinary task text untouched and reports no hits", () => {
  const line = "Slice 3: wire the SettleDecider into the bridge and run the tracker tests";
  const result = redact(line);
  assert.strictEqual(result.text, line);
  assert.deepStrictEqual(result.hits, []);
});

it("counts every occurrence of one rule", () => {
  const result = redact("a sk-abcdefghijklmnopqrstuvwx b sk-zyxwvutsrqponmlkjihgfe");
  assert.deepStrictEqual(result.hits, [{ rule: "openai-key", count: 2 }]);
});

it("redactPath replaces a home prefix and redacts any other path", () => {
  assert.strictEqual(redactPath("/Users/someone/dev/app", "/Users/someone"), "<HOME>/dev/app");
  assert.strictEqual(redactPath("/opt/other/app", "/Users/someone"), "/opt/other/app");
});

it("the tally sums per rule across calls", () => {
  const tally = makeRedactionTally();
  redactWith("sk-abcdefghijklmnopqrstuvwx and felix@example.com", tally);
  redactWith("ghp_abcdefghijklmnopqrst", tally);
  assert.deepStrictEqual(tally.totals(), { "openai-key": 1, email: 1, "github-token": 1 });
});
