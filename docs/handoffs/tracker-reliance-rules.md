# Handoff: tracker reliance rules

## Goal

Ship the tracker update that implements the reliance-rules plan: item authoring
with `title` + `description` + declared `refs`/`produces`, the batch footprint,
the observe-only rule table with a measured `ACCEPTED_RULES`, the
`tracker/reliance-decision` record, and the rule-promotion tooling. The work
must land as one releasable commit, then publish `@ftrdotdev/pi-tracker` so real
sessions start gathering declared-row data.

## Status

- Plan slices 1-7 and the plan's final verification: done.
- Promotion tooling (plan-external tracker item 9): done.
- Publish prep (pi deps bumped to 1.1.0, changeset added, 18 new files staged): done.
- Tool copy review, including the `update_items` batch `refs`/`produces` drop fix: done.
- Item shape redesign (`add_items` / `update_items`, `items` array of item objects, `initial_items` objects only): done.
- Commit of the working tree: not started.
- Release (`changeset version`, `bun run publish:packages`, `changeset git-tag`): not started.
- `.qrspi` plan and outline still name the old shapes: not started (decision needed).

## Next action

Commit the release from this working tree. Start at the staged changeset
`.changeset/reliance-rules-and-item-metadata.md`. Then stage the 29 modified
files (`git diff --name-only`). Review the split first: 18 files are staged and
29 are not. Do not publish from an uncommitted tree.

## Verification

Run in `packages/tracker` unless noted. Results observed on 2026-10-08.

| Command | Observed result |
| --- | --- |
| `bun run test` | 28 files, 495 tests passed |
| `bun run typecheck` | exit 0, no output |
| `bun run lint` | exit 0, no output |
| `bun run eval:rules` | `frozen parity: 3327 candidates against verdicts.jsonl — exact`; `ACCEPTED_RULES: names-batch-output, no-visible-link — MATCH` |
| `bun run eval:promote` | exit 0; `ACCEPTED_RULES is in sync.` |
| `packages/tui`: `bun run typecheck` + `bun run test` | typecheck exit 0; 351 tests passed |
| `packages/inquiry`: `bun run typecheck` + `bun run test` | typecheck exit 0; 220 tests passed |
| `packages/qrspi`: `bun run typecheck` + `bun run test` | typecheck exit 0; 63 tests pass |
| `bunx changeset status` (repo root) | minor bump pending for `@ftrdotdev/pi-tracker`, `@ftrdotdev/pi-tui`, `@ftrdotdev/pi-inquiry` |
| `git status --short` (repo root) | 18 staged, 29 modified, 1 untracked (`.worktrees/`) |

`eval:rules` and `eval:promote` read the git-ignored corpus at
`packages/tracker/evals/data/`. A fresh checkout needs that directory, or
`bun run eval:harvest` plus labels, before either command runs.

## Files

- `.changeset/reliance-rules-and-item-metadata.md` (staged) - release notes and bump level.
- `packages/tracker/src/presentation/tool-metadata.ts` - tool contract, validation, tool copy.
- `packages/tracker/src/index.ts` - the pi bridge and the `add_items` / `update_items` cases.
- `packages/tracker/src/compaction/rules.ts` - the rule table and `ACCEPTED_RULES`.
- `packages/tracker/README.md` - published user docs.
- `packages/tracker/docs/reliance-rule-promotion.md` (staged) - promotion runbook.
- `packages/tracker/evals/promote.ts` (staged) - the promotion command.
- `package.json` (repo root) and `bun.lock` - pi catalog 1.1.0 and typebox 1.3.36.

## Open questions

1. Bump level. The changeset is `minor`, so the fixed group goes 0.6.0 -> 0.7.0.
   Confirm `minor` before running `bun run release`.
2. Historical docs. `packages/tracker/.qrspi/plans/20261008-reliance-rules-metadata.md`
   and `packages/tracker/.qrspi/outlines/20261008-reliance-rules-metadata.md`
   still describe `add_item`, `update_item`, and the `title` container. Update
   them, or leave them as history?
3. Unrelated changes. `packages/qrspi/scripts/fetch-skills.ts` (modified) and
   `.worktrees/` (untracked) are not part of this work. Include or exclude them
   from the release commit?
4. Unused catalog entry. Root `package.json` pins `typebox` 1.3.36, but no
   package declares `typebox: catalog:pi`. Wire it in, or drop it?
5. Publish credentials. npm auth is `[redacted]`; the real values live in the
   publisher's npm config, by convention `~/.npmrc`. Blocker: the release step
   cannot run without them. Do not copy the values into this document or any
   commit.

## References

- Plan: `packages/tracker/.qrspi/plans/20261008-reliance-rules-metadata.md`
- Design: `packages/tracker/.qrspi/designs/20261008-reliance-rules-metadata.md`
- Outline: `packages/tracker/.qrspi/outlines/20261008-reliance-rules-metadata.md`
- Promotion runbook: `packages/tracker/docs/reliance-rule-promotion.md`
- Changeset: `.changeset/reliance-rules-and-item-metadata.md`
- Base commit: `dae0528`
- Local eval corpus: `packages/tracker/evals/data/` (git-ignored)
- Package guide: `packages/tracker/AGENTS.md`

## Skills

- `effect-ts` (`.agents/skills/effect-ts/SKILL.md`) - invoke before changing any
  Effect code in `packages/tracker/src`. `packages/tracker/AGENTS.md` requires
  reading `node_modules/effect/AGENTS.md` first.
- `writing-for-agents` (`~/.agents/skills/writing-for-agents/SKILL.md`) -
  invoke when editing the changelog, README, or tool copy during the release.
- Neither is needed for the commit and publish steps themselves.
