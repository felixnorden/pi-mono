---
description: QRSPI Research phase. Documents what exists in the codebase for a topic and produces a dated research artifact in `.qrspi/research/` with an inline summary.
argument-hint: '"<topic>" [slug] [scope-path]'
---

Load the `planning-workflow` skill → `templates/research.md`.

## Arguments

- `$1` — research topic (required). If the topic contains spaces, wrap it in quotes (`/qrspi-research "payment flow"`) — unquoted words split into separate arguments.
- `${2:-}` — slug: session identifier for artifact naming (e.g. `auth-refactor`). If absent, derive from the topic.
- `${3:-}` — scope path: optional path to an existing scope document.

If invoked without a topic, ask the user: "What area of the codebase should I research?"

---

## Orchestrated Mode

When invoked as a QRSPI phase subagent from `/qrspi`: skip Step 1 (Clarify) and the interactive completion gate — you cannot ask the user directly. Run the research roles inline in this session; do not spawn role subagents (the orchestrator owns subagent orchestration). Return the inline summary and any open questions in your final output for the orchestrator to relay. Interactive steps apply only when run standalone.

---

## Role

**Document what exists. Do not suggest improvements. Do not critique. Do not plan.**

## Tool Guidance

- Use your native file tools for reading and editing files.
- Use your search tool (e.g. ripgrep) for content search.
- Use shell commands only for read-only git inspection (`git diff`, `git log`, `git status`, `git show`).
- Never use shell commands for file operations.

## Workflow

### Step 1 — Clarify

If the topic scope or intent is ambiguous, ask the user before proceeding. Do not load skills or explore the codebase until the topic is confirmed.

### Step 2 — Skill Gate

Load every skill relevant to the research topic. Record loaded skills under `skills_consulted` in the research document frontmatter.

### Step 3 — Explore

Determine which research roles are warranted. Run each role as a separate agent session if your environment supports it; otherwise execute them in this session, one after another. Track progress with a task list if available. After all roles complete: resolve conflicts, note gaps, collect git metadata, write the document, and deliver the inline summary.

### Research Roles

**Locator** — maps where relevant code lives. Use when relevant files are unknown.

Mandate: find files related to the topic, return paths with one-line descriptions, omit code excerpts. Maximum 15 files.

**Analyzer** — documents responsibilities, interfaces, data structures, control flow, and integration points with `file:line` references. Use for most topics.

Mandate: read the most relevant files, document what they do and how they connect, return structured findings with `file:line` references. Do not read additional files unless directly imported by the target files.

**Pattern Finder** — identifies conventions: naming, error handling, test structure, abstraction layers. Use when planning requires adherence to existing conventions or the area is broadly unfamiliar.

Mandate: identify recurring idioms, cross-reference adjacent areas, return an annotated inventory with `file:line` examples. Maximum 10 entries.

---

Write the document to `<worktree-root>/.qrspi/research/{slug}.md` (the package extension stamps the `YYYYMMDD-` prefix), then output the inline summary from the template.
