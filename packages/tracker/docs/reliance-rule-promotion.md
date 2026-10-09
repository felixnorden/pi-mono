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

## Review

1. Read the gate table. Confirm each promoted row cleared the gate.
2. Confirm the harvest corpus is current. The command reads `evals/data/`, which
   is git-ignored, so the corpus stays local.
3. Run `bun run eval:rules`. The final line must print
   `ACCEPTED_RULES: … — MATCH`.
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
