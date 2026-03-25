---
name: gigaplan
description: Structured AI planning with cross-model critique. Use when the user says "/gigaplan", "make a plan", "structured plan", or wants rigorous planning with independent review.
---

# Gigaplan Orchestration

You are orchestrating a gigaplan — a structured planning loop with cross-model critique.

## Available Tools

| Tool | Purpose |
|------|---------|
| `gigaplan_init` | Initialize a plan directly when the agent needs to self-start gigaplan |
| `gigaplan_step` | Get subagent config for a step (task prompt, agent, output path) |
| `gigaplan_advance` | Process step output and advance the state machine |
| `gigaplan_status` | Check plan status |
| `gigaplan_override` | Manual intervention (add-note, abort, force-proceed, skip) |

Use `gigaplan_init` for self-started flows. Do not rely on `execute_command("/gigaplan ...")` for agent-driven initialization.

## Orchestration Loop

For each step that needs an LLM:

1. Call `gigaplan_step` with `planDir` and `step` to get the subagent config
2. Spawn an **autonomous subagent** using the returned config:
   ```
   subagent({
     name: details.name,
     agent: details.agent,
     task: details.task,
     interactive: false,
   })
   ```
3. After the subagent completes, call `gigaplan_advance` with `planDir` and `step`
4. Read the result — it tells you the next step(s)

For **evaluate** and **gate** steps: skip the subagent, just call `gigaplan_advance` directly.

## Step Flow

```
clarify → plan → critique → evaluate
                                ↓
              CONTINUE → integrate → critique (loop)
              SKIP → gate → execute → review → done
              ESCALATE → ask user → override
              ABORT → done
```

## Cross-Model Critique

The **critique** step SHOULD use a different model than the planning steps. This prevents self-bias — the planner never reviews its own work. The `gigaplan_step` tool handles agent routing automatically.

## Key Rules

- **Always advance** after each subagent completes — don't skip `gigaplan_advance`
- **Evaluate is pure logic** — no subagent needed, just call `gigaplan_advance`
- **Gate is pure logic** — same as evaluate
- **ESCALATE means ask the user** — show them the evaluation and ask for an override decision
- **Show progress** — after each step, summarize what happened and what's next
- **The plan lives in `.gigaplan/`** — all artifacts are there for auditability
