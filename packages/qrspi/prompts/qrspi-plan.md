---
description: QRSPI Plan phase. Turns the outline into a vertically-sliced, TDD-aligned implementation plan for a downstream build agent, written to `.qrspi/plans/`.
argument-hint: "<outline-path> [research-path] [design-path] [slug]"
---

Load the `planning-workflow` skill → `templates/plan.md`. Load the `tdd` skill.

## Arguments

- `$1` — outline path: path to the structure outline from the S phase (required).
- `${2:-}` — research path: path to the research document from the R phase (optional).
- `${3:-}` — design path: path to the design concept (optional; for additional context).
- `${4:-}` — slug: session identifier for artifact naming (optional; derive from the outline if absent).

If `$1` is not provided, ask the user for it before proceeding.

---

## Orchestrated Mode

When invoked as a QRSPI phase subagent from `/qrspi`: skip Step 1 (Clarify) and the Completion Gate interaction — you cannot ask the user directly. State any ambiguity as an explicit assumption in the plan and return it in your output for the orchestrator to relay. Interactive steps apply only when run standalone.

---

## Role

Produce a vertically-sliced, TDD-aligned implementation plan for Build Agent to execute.

## Workflow

### 1 — Clarify

If any requirement is ambiguous, ask the user before proceeding. State the ambiguity, list interpretations, give your recommended interpretation, and ask specific questions. Never assume.

### 2 — Read Inputs Silently

Read the outline (required), research document, and design concept (if provided) silently. Do not summarise them back.

### 3 — Skill Gate (REQUIRED)

Load every skill relevant to the task domain. At minimum, load:

- `planning-workflow` — for the plan template and vertical slice structure
- `tdd` — for test-first phase authoring and double selection

Record what each skill contributes under **Skills Consulted** in the plan output.

### 4 — Research Gate (REQUIRED)

**Stop before designing any solution.** For any library, framework, API, or pattern not verified in this session: consult skills for domain knowledge and, if web access is available, official docs. Document findings under **Research Summary**. Do not skip even for familiar-seeming technology — versions and best practices change.

### 5 — Design

Verify a design concept exists for this task. If not, pause and state that the design phase must be completed before a plan can be produced.

Evaluate 2–3 approaches to decomposing the work into **vertical slices** — each slice delivering one complete, observable behavior end-to-end. Vertical slicing criteria:

- Each slice produces a demonstrable outcome (not a technical layer)
- The highest-risk or most uncertain behavior appears in an early slice
- Each slice's tests can be written before its implementation begins
- Slices are ordered by dependency: no slice relies on behavior from a later slice

State your recommended slice ordering and why alternatives were rejected.

### 6 — Plan

Follow `templates/plan.md` from the `planning-workflow` skill. For each slice's "Tests First" section, consult the `tdd` skill (`references/test-doubles.md`, `assets/test-template.md`) to select appropriate doubles and scaffold the test structure.

**CRITICAL**:

- Every "Tests First" section must name specific tests with "Arrange / Act / Assert" structure.
- "Write tests for this component" is not acceptable — the tests must be specified precisely enough that Build Agent can write them without design decisions.

Write to `<worktree-root>/.qrspi/plans/{slug}.md` (the package extension stamps the `YYYYMMDD-` prefix).

### 7 — Completion Gate

Preview the written plan to the user with a user-facing preview tool (fall back to `read` only if none exists), then ask the user to confirm the plan is sufficient before proceeding.

- If confirmed: finalize and save the plan.
- If not confirmed: revise according to the requested changes, then preview the revision and ask again for confirmation.

---

## Quality Gate (CRITICAL)

Do not save or deliver a plan until every item is satisfied:

- [ ] Skill Gate completed: `planning-workflow` and `tdd` loaded and documented
- [ ] Research Gate completed and documented
- [ ] Design concept referenced and exists
- [ ] No ambiguous requirements remaining
- [ ] All phases are vertical slices — no phase is a technical layer
- [ ] Each slice has a "Tests First" section with named tests and Arrange/Act/Assert structure
- [ ] Each slice's Verification Gate leads with "all tests written in Tests First pass"
- [ ] Every change specifies exact file path and action (create / modify / delete)
- [ ] Every "implement X" includes enough code context to locate the insertion point
- [ ] Slice order rationale is documented
- [ ] All risks have mitigations
- [ ] Out of Scope section is populated
- [ ] If an issue is referenced, a clean branch is used and referenced in the ticket upon git push

---

Return the artifact path and a one-paragraph summary of the plan.
