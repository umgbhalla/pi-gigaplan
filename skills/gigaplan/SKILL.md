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
| `gigaplan_doctor` | Validate plan state, repair common JSON/output issues, and return recovery handoff |
| `gigaplan_step` | Get agent config for a step (task prompt, agent, output path) |
| `gigaplan_advance` | Process step output and advance the state machine |
| `gigaplan_status` | Check plan status |
| `gigaplan_override` | Manual intervention (add-note, abort, force-proceed, skip) |

Use `gigaplan_init` for self-started flows. Do not rely on `execute_command("/gigaplan ...")` for agent-driven initialization.
If `gigaplan_advance` fails on malformed JSON or a broken handoff, run `gigaplan_doctor({ fix: true })` before retrying.

## Orchestration Loop

For each step that needs an LLM:

1. Call `gigaplan_step` with `planDir` and `step` to get the agent config
2. Spawn the agent via `agent_group` with the returned config:
   ```
   agent_group({
     name: "Gigaplan: <step>",
     wait: true,
     agents: [{
       name: details.name,
       agent: details.agent,
       task: details.task,
     }]
   })
   ```
3. After the group completes, call `gigaplan_advance` with `planDir` and `step`
4. Read the result — it tells you the next step(s)

For **evaluate** and **gate** steps: skip the agent, just call `gigaplan_advance` directly.

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

- **Always advance** after each agent completes — don't skip `gigaplan_advance`
- **Evaluate is pure logic** — no agent needed, just call `gigaplan_advance`
- **Gate is pure logic** — same as evaluate
- **ESCALATE means ask the user** — show them the evaluation and ask for an override decision
- **Show progress** — after each step, summarize what happened and what's next
- **The plan lives in `.gigaplan/`** — all artifacts are there for auditability
