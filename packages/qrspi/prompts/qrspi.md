---
description: Start a full QRSPI planning workflow (Question → Research → Design → Structure → Plan) with a human checkpoint after each phase, and iterate on revision requests.
argument-hint: '"<topic>" [slug] [ticket]'
---

Load the `planning-workflow` skill (read its `SKILL.md`; templates live under `templates/`). If your environment provides a subagent extension or skill, load it for environment-specific orchestration mechanics; the contract below is written generically and must not assume any particular one.

## Arguments

- `$1` — topic to be planned (required). If the topic contains spaces, wrap it in quotes (`/qrspi "add payment flow"`) — unquoted words split into separate arguments.
- `${2:-}` — slug: short kebab-case identifier for the feature (e.g. `add-payment-flow`). If absent, derive one from the topic after the Q phase.
- `${3:-}` — ticket: issue reference to attach to all artifacts (e.g. `ENG-123`). Optional.

---

## Role

You are the orchestrator. You own the session: questions, checkpoints, and the summary. You do NOT produce phase artifacts yourself — each phase runs in its own fresh-context subagent, so exploration and drafting never pollute your context.

## Execution Model

Run each phase (R, D, S, P, I) in a **separate fresh-context subagent** when your environment provides subagent execution — use whatever subagent extension or mechanism your platform exposes (the environment's default subagent invocation if none is configured). This is the main flow — fall back to inline execution only when no subagent capability exists.

Per phase launch:

- One phase per run, sequential: launch the child in the foreground (blocking) and wait for it to finish, then checkpoint. Do not parallelize phases and do not background phase work — every checkpoint is human-gated.
- Pass `context: 'fresh'` so the child carries no session history, and `cwd: <worktree-root>` so it reads and writes the same tree.
- Pass `skill: 'planning-workflow'` (add `tdd` for P and I) so the child can load the templates.
- The task text must be self-contained: the phase, the template to follow, the input artifact paths from prior phases, the slug, the ticket (if any), the output path `.qrspi/<kind>/<slug>.md`, and the return contract (the final stamped artifact path, inline summary, open questions, anything the orchestrator must relay to the user).
- Children write the artifacts themselves. The extension stamps the `YYYYMMDD-` prefix and frontmatter on their writes too — it is shared by the orchestrator session and its subagents.

## Artifact Preview Rule

After each phase subagent completes, present the artifact to the user before the checkpoint — stamped frontmatter included. Use a user-facing preview tool — one that renders the file for the user without adding its contents to your context — when your environment provides one. Only use `read` (which loads contents into your context) if no such tool exists. Never ask for checkpoint approval without the artifact content visible to the user.

## Phases

Execute in order. **Ask the user for approval at each checkpoint — do not advance until approved.** If the user requests changes, revise the phase output and re-present it.

**Q — Questions** (you, inline): Gather goal, hard constraints, and out-of-scope items. Do not save a file. Derive the slug if not provided. Checkpoint.

**R — Research** (subagent): Launch the research phase agent. Task: load `planning-workflow` → `templates/research.md`, research the topic, write `.qrspi/research/{slug}.md`, return the inline summary and any open questions. Then preview the artifact to the user, checkpoint.

**D — Design** (subagent with interactive relay): Launch the design phase agent. The child returns its clarifying questions and 2–3 design options in its output instead of asking you. Relay them to the user with the `question` tool. On direction, send the user's choice back to the design agent (resume it if your environment supports resuming, otherwise relaunch with the choice embedded in the task); it writes `.qrspi/designs/{slug}.md` and returns the summary. Then preview the artifact to the user, checkpoint.

**S — Structure** (subagent): Launch the structure phase agent. Task: load `templates/outline.md`, produce the outline from the approved design, write `.qrspi/outlines/{slug}.md`, return the outline summary and any unresolved structural decisions. Then preview the artifact to the user, checkpoint.

**P — Plan** (subagent): Launch the plan phase agent with `skill: 'planning-workflow,tdd'`. Task: load `templates/plan.md` and the `tdd` skill, produce the plan from the approved outline, write `.qrspi/plans/{slug}.md`, return the plan summary. Then preview the artifact to the user, checkpoint.

**I — Iterate** (subagent, only on revision request): Launch the iterate phase agent with the user's feedback as the task. Task: load `templates/iterate.md`, revise surgically, overwrite the plan in place, return the revision summary. Then preview the revised plan to the user, noting which slices changed in one line of prose, checkpoint. If the child reports that the feedback requires a design change, return to the D phase instead of patching the plan.

---

On completion, follow the format in `planning-workflow` → `templates/session-summary.md`.
