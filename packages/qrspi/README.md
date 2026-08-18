# pi-qrspi

A planning workflow for [Pi](https://pi.dev) coding agents. The agent works in six phases. You approve each phase before the next one starts. Nothing gets implemented until you approve the plan.

## The problem

AI agents plan badly when they plan alone. They rush to code. Their designs disappear when the session ends. Their plans drift from the code they describe.

QRSPI fixes this. It keeps you in the loop at every step. It writes each phase to a file you can review and commit.

## How it works

QRSPI stands for **Q**uestions → **R**esearch → **D**esign → **S**tructure → **P**lan → **I**terate.

Each phase produces an artifact: a file under `.qrspi/` in your project. The next phase reads the artifact from the previous phase.

The agent pauses at every checkpoint and asks for your approval. It does not advance until you approve. If you request changes, the agent revises the phase output and shows it to you again. You never approve blind: after each phase writes its artifact, the orchestrator presents the full content to you — stamped frontmatter included — before asking for approval, rendered by a user-facing preview tool so it never enters the agent's context.

This package is the Pi version of the [opencode-qrspi](https://github.com/felixnorden/skills/tree/main/packages/opencode-qrspi) plugin for OpenCode. Both tools use the same `.qrspi/` artifact format, so you can switch between them without losing your research or plans.

## Credits

The framework is inspired by **Harness Engineering** — the practice of customizing a coding agent's configuration (skills, agents, commands, hooks) to improve reliability and output quality. This concept was coined by [Viv Trivedy](https://x.com/Vtrivedy10) and popularized by [Dex Horthy](https://x.com/dexhorthy) and the team at [HumanLayer](https://humanlayer.dev).

- **Blog post**: [Skill Issue: Harness Engineering for Coding Agents](https://humanlayer.dev/blog/skill-issue-harness-engineering-for-coding-agents)
- **Talk**: Dex Horthy on context engineering and agent harnesses ([YouTube](https://www.youtube.com/watch?v=YwZR6tc7qYg))

## Installation

Install from npm, git, or a local path:

```bash
pi install npm:@ftrdotdev/pi-qrspi
pi install git:github.com/felixnorden/skills   # installs the whole skills repo
pi install /absolute/path/to/packages/pi-qrspi
pi install ./packages/pi-qrspi                 # local checkout
```

### Install with npm

The package is published on the npm registry. If your project already manages dependencies with npm, you can pin the version in your `package.json` and lockfile:

```bash
npm install --save-dev @ftrdotdev/pi-qrspi
pi install -l ./node_modules/@ftrdotdev/pi-qrspi   # run from the project root
```

The `pi install -l` command registers the npm-managed copy in your project's `.pi/settings.json`. Pi then loads the prompts, skills, and extension from your project's `node_modules`. Pi asks you to trust the project the first time it loads project packages.

## Usage

### Full workflow

Run the complete workflow with one command:

```bash
/qrspi add-payment-flow "Implement Stripe payment processing"
```

| Phase             | Command            | What it does                                                          | Artifact                    |
| ----------------- | ------------------ | --------------------------------------------------------------------- | --------------------------- |
| **Q** — Questions | `/qrspi`           | Gathers goals, constraints, and out-of-scope items                    | none — inline               |
| **R** — Research  | `/qrspi-research`  | Maps the codebase; documents existing implementations                 | `.qrspi/research/{slug}.md` |
| **D** — Design    | `/qrspi-design`    | Evaluates options; produces a design concept                          | `.qrspi/designs/{slug}.md`  |
| **S** — Structure | `/qrspi-structure` | Produces a component-level outline                                    | `.qrspi/outlines/{slug}.md` |
| **P** — Plan      | `/qrspi-plan`      | Produces a TDD-aligned implementation plan                            | `.qrspi/plans/{slug}.md`    |
| **I** — Iterate   | `/qrspi-iterate`   | Revises the plan from your feedback; updates only the affected slices | updates the plan file       |

### Orchestrated flow

`/qrspi` is an orchestrator. It does not draft artifacts itself; each phase runs in a **separate fresh-context subagent**, so exploration and drafting stay out of your main session's context. The orchestrator owns the session: the Q phase, launching one phase agent at a time, relaying your answers to the Design phase, presenting each artifact in full at every checkpoint without loading it into its own context, and producing the session summary.

Each phase agent is told exactly what to do: which template to follow, which prior artifacts to read, where to write (`.qrspi/<kind>/<slug>.md`), and what to return (the inline summary plus any open questions). Phase agents never ask you questions directly — they return questions and design options to the orchestrator, which relays them to you.

If no subagent capability is available in your environment, `/qrspi` falls back to running phases inline.

### Individual phases

You can run each phase separately. Arguments are positional:

```bash
# Research only
/qrspi-research "Authentication system" auth-refactor

# Design from research
/qrspi-design .qrspi/research/auth-refactor.md auth-refactor

# Structure from design
/qrspi-structure .qrspi/designs/20260101-auth-refactor.md .qrspi/research/auth-refactor.md

# Plan from outline and research
/qrspi-plan .qrspi/outlines/20260101-auth-refactor.md .qrspi/research/auth-refactor.md

# Iterate on an existing plan
/qrspi-iterate .qrspi/plans/20260101-auth-refactor.md "Add OAuth2 support"
```

The OpenCode plugin uses flags (`--slug`, `--research`, `--design`, `--outline`, `--plan`, `--scope`, `--ticket`) instead of positional arguments.

## What's included

### Prompt templates

Six prompt templates in `prompts/`, one per phase:

| Template                     | Command                  |
| ---------------------------- | ------------------------ |
| `prompts/qrspi.md`           | `/qrspi` (full workflow) |
| `prompts/qrspi-research.md`  | `/qrspi-research`        |
| `prompts/qrspi-design.md`    | `/qrspi-design`          |
| `prompts/qrspi-structure.md` | `/qrspi-structure`       |
| `prompts/qrspi-plan.md`      | `/qrspi-plan`            |
| `prompts/qrspi-iterate.md`   | `/qrspi-iterate`         |

The `/qrspi` orchestrator runs each phase in a fresh subagent session, so earlier phases do not clutter your main session's context. After each phase, the orchestrator presents the full content to you before the checkpoint — what you approve is exactly what was written, including the extension-stamped frontmatter — rendered by a user-facing preview tool so it never enters the orchestrator's context. The phase prompts double as standalone commands; when run standalone they keep their interactive steps (clarify, options, completion gate), and when invoked by the orchestrator they run in orchestrated mode (no direct user interaction; questions relayed through the orchestrator).

### Extension

`extensions/qrspi-artifacts.ts` keeps artifact names consistent. It intercepts every `write` and `edit` call that targets a path under `.qrspi/`:

- **Adds the date** — a filename without a `YYYYMMDD-` prefix gets today's date from the host clock. Write to `.qrspi/plans/add-payment-flow.md` and you get `.qrspi/plans/20260101-add-payment-flow.md`
- **Fills frontmatter dates** — a `date:` key in the YAML frontmatter of a new artifact is set to the real ISO datetime
- **Fills git metadata** — `git_commit`, `branch`, and `repository` keys are filled from the repository at `cwd` (the research template requires them)
- **Slugifies** — `Add Payment Flow.md` becomes `20260101-add-payment-flow.md`; malformed date prefixes (`2026-1-1-…`) are replaced with the canonical form
- **Keeps existing files** — writes to an existing artifact path are left untouched (used by iterate)
- **Blocks traversal** — paths that escape `.qrspi/` with `..` are rejected

### Skills

- **`planning-workflow`** — templates for each phase (research, design-concept, outline, plan, iterate). Enforces two rules: no implementation detail in the design phase, no design decisions in the plan phase.
- **`tdd`** — test-driven development guidance: red-green-refactor workflow, test doubles, dependency injection, and London/Chicago school mock boundaries.

## Artifacts

All artifacts live under `.qrspi/` in your project:

```
.qrspi/research/   # R
.qrspi/designs/    # D
.qrspi/outlines/   # S
.qrspi/plans/      # P
```

Commit these files. Research and plans are project knowledge, not temporary state. Unlike OpenCode's `.opencode/` directory, `.qrspi/` is meant to be shared.

## Development

The `planning-workflow` and `tdd` skills are authored in the separate [`felixnorden/skills`](https://github.com/felixnorden/skills) repo. `scripts/fetch-skills.ts` shallow-clones that repo at a pinned tag (`v0.1.0`) and copies the two skill directories into `./skills`. It runs from `prepare` (on `bun install`, so skills are present for tests) and from `prepack` (before `bun pm pack`, so they land in the tarball). `./skills` is generated, git-ignored, and never committed.

The git metadata cache resolves lazily on the first artifact write and caches per working directory for 60 seconds. The orchestrator session and its subagents share the cache, so later writes never re-run git. A bash command that changes git state (`commit`, `checkout`, `rebase`, `pull`, …) resets the cache.

```bash
bun run pack       # or: npm pack — builds the tarball into dist/
bun test           # extension + prompt template tests
bun run typecheck  # tsc --noEmit
bun run lint       # oxlint
bun run fmt:check  # oxfmt --check (run bun run fmt to write)
```
