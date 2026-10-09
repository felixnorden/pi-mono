# Promote a reliance rule

A reliance rule decides a compaction question without a classifier call. The
product runs a rule only when the rule is in `ACCEPTED_RULES` in
`src/compaction/rules.ts`. Promote a rule after the production gate accepts it
on real labeled decisions.

## The gate

`evals/rules.ts` computes the gate. A rule promotes when it clears the gate in 2
or more passes. A pass qualifies when all three conditions hold:

- the rule has 10 or more labeled firings,
- agreement is 95% or more,
- agreement is above the pass base rate.

The constants are `GATE_MIN_LABELED`, `GATE_MIN_AGREEMENT`, and
`GATE_MIN_PASSES` in `evals/rules.ts`.

## Measure

Run the dry run:

    bun run eval:promote

The command prints the gate table, the current accepted set, the measured set,
and each `+ promote` or `- drop` row. The dry run exits 1 when the two sets
differ.

## Apply

Run the write:

    bun run eval:promote --write

The command rewrites the `ACCEPTED_RULES` block to the measured set. It then
re-reads the file and compares the set. A mismatch throws.

## New decisions

`verdicts.jsonl` is the frozen rename oracle. It holds one row per candidate
from the pre-revert router. Do not regenerate it. A harvest after the release
adds cases with no frozen verdict.

`bun run eval:rules` reports those candidates as unjudged. The parity line reads
`frozen parity: <judged> candidates against verdicts.jsonl — exact (<unjudged>
new candidates without a frozen verdict)`. An unjudged candidate never fails the
parity check.

Label the new questions with `bun run eval:label`. The queue skips a question
that already has an answer for its case id and key. The gate reads labels only,
so it includes a new case after the label lands. Run `bun run eval:promote`
against the same corpus directory (`evals/data` by default).

## Review

1. Read the gate table. Confirm each promoted row cleared the gate.
2. Confirm the harvest corpus is current. The command reads `evals/data/`, which
   is git-ignored, so the corpus stays local.
3. Run `bun run eval:rules`. The parity line must say `exact`, and the final
   line must print `ACCEPTED_RULES: … — MATCH`. An unjudged count is expected
   after a new harvest.
4. Commit `src/compaction/rules.ts`.

## Limits

- Promote from the real corpus only. The command ignores the synthetic fixture
  in `evals/data/synthetic/`. That fixture proves the record path; it cannot
  promote a rule.
- A promotion ships exactly the measured set. `bun run eval:rules` exits
  nonzero when `ACCEPTED_RULES` differs from the gate, so a hand edit cannot
  drift.

## Rollback

Revert the commit, or restore the file:

    git checkout -- src/compaction/rules.ts

Then run `bun run eval:rules` and confirm `MATCH`.
