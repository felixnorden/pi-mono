---
description: QRSPI Iterate phase. Surgically revises an existing plan based on feedback, updating only the slices the feedback implicates.
argument-hint: '<plan-path> "<feedback>"'
---

Load the `planning-workflow` skill → `templates/iterate.md`. Load the `tdd` skill.

## Arguments

- `$1` — plan path: path to the existing plan to revise (required).
- `${@:2}` — feedback: the feedback string describing what needs to change (required). Everything after the plan path is joined as one feedback string; quoting is optional but recommended.

If `$1` is not provided, ask the user for it.
If no feedback string is present, ask the user: "What needs to change in the plan?"

---

## Orchestrated Mode

When invoked as a QRSPI phase subagent from `/qrspi`: the feedback arrives in the orchestrator's task, not from the user. Skip Step 1 (Clarify) and Step 5 (Completion Gate) — state any assumption explicitly in the revision note and return the revision summary. Interactive steps apply only when run standalone.

---

## Role

Surgically revise an existing plan based on feedback. **Update only affected slices — never regenerate the full plan for a partial change.**

## Workflow

### 1 — Clarify

If the plan path or feedback is ambiguous, ask the user before proceeding. Never assume.

### 2 — Read Inputs Silently

Read the existing plan, outline, and research documents silently. Identify which slices the feedback implicates. State them explicitly before making any changes.

### 3 — Design Escalation Check

Check whether the feedback implies a **design change** — a change to solution shape, component boundaries, or technology choices. If it does, stop and return:

```
This feedback requires a design change. Return to the D phase before revising the plan.
Reason: {specific design decision affected}
```

### 4 — Revise

For each implicated slice, rewrite it completely following `templates/iterate.md` from the `planning-workflow` skill. Leave all other slices verbatim.

- If the feedback requires a new slice, add it; do not repurpose an existing slice to absorb new behavior
- Re-verify any Quality Gate for all modified slices before saving
- If two or more rounds of iteration have been applied to the same slice, flag it: repeated revision signals a design ambiguity that should be resolved at the D or S phase rather than patched incrementally

Add a revision note to the plan header:

```
Revised: {YYYY-MM-DD} — {one-line summary of what changed}
```

Write the revised plan to the same path, overwriting the original.

### 5 — Completion Gate

Preview the revised plan to the user with a user-facing preview tool (fall back to `read` only if none exists), state which slices changed, and ask the user to confirm the revision before finishing.

- If confirmed: done.
- If not confirmed: revise according to the feedback, then preview the revision and ask again for confirmation.

---

Return the revision summary and plan path.
