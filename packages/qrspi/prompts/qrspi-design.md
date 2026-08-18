---
description: QRSPI Design phase. Turns the research document into a solution design concept with evaluated options, written to `.qrspi/designs/`.
argument-hint: "<research-path> [slug] [scope-path]"
---

Load the `planning-workflow` skill → `templates/design-concept.md`.

## Arguments

- `$1` — research path: path to the research document from the R phase (required).
- `${2:-}` — slug: session identifier for artifact naming (optional; derive from the research document if absent).
- `${3:-}` — scope path: path to the scope document (optional; only needed if the research document lacks a scope summary).

If `$1` is not provided, ask the user for it before proceeding.

---

## Orchestrated Mode

When invoked as a QRSPI phase subagent from `/qrspi`: do not ask the user directly. Return your clarifying questions and the 2–3 design options in your final output; the orchestrator relays the user's direction before you write. Skip the Direction Checkpoint and Completion Gate interactions — the orchestrator runs those. Interactive steps apply only when run standalone.

---

## Role

Facilitate solution design discussion, evaluate options, and produce a design concept document. **Architecture and boundaries only — no implementation detail. No file paths, no function names, no pseudo-code, no code blocks.**

## Workflow

### 1 — Clarify

If any requirement is ambiguous, ask the user before proceeding. State the ambiguity, list interpretations, give your recommended interpretation, and ask specific questions. Never assume.

### 2 — Read Research Silently

Read the research document silently. Do not summarise it back.

### 3 — Resolve Ambiguity

Identify what is still ambiguous about the solution shape. Ask the user — maximum 3 questions at once. Do not proceed until ambiguities are resolved.

### 4 — Evaluate Options

Present 2–3 distinct design options. For each state: what it optimises for, what it gives up, and which constraints from the scope it satisfies.

### 5 — Direction Checkpoint

Ask the user: "Does this direction feel right, or should we adjust?"

### 6 — Produce the Design Concept

Once direction is agreed, follow `templates/design-concept.md` from the `planning-workflow` skill:

- Usually 150–250 lines — no hard minimum or maximum; completeness matters, not length
- Status remains `draft` until the user confirms approval

Write to `<worktree-root>/.qrspi/designs/{slug}.md` (the package extension stamps the `YYYYMMDD-` prefix).

### 7 — Completion Gate

Preview the written artifact to the user with a user-facing preview tool (fall back to `read` only if none exists), then ask the user to confirm the design concept is sufficient before proceeding.

- If confirmed: finalize and save the document.
- If not confirmed: revise according to the requested changes, then preview the revision and ask again for confirmation.

---

Return the artifact path and a one-paragraph summary of the chosen direction.
