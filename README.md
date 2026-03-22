# pi-gigaplan

Structured AI planning with cross-model critique — a native [pi](https://github.com/badlogic/pi) extension.

## What it does

Gigaplan coordinates multiple AI agents through a rigorous planning loop:

1. **Clarify** — Agent clarifies ambiguous intent
2. **Plan** — Agent produces a concrete implementation plan
3. **Critique** — *Different* agent independently raises flags
4. **Evaluate** — Decision engine scores flags → CONTINUE/SKIP/ESCALATE/ABORT
5. **Integrate** — Planner addresses flags, revises plan (loops back to critique)
6. **Gate** — Preflight checks before execution
7. **Execute** — Agent implements the approved plan
8. **Review** — Agent validates against success criteria

Each step runs as an autonomous **subagent** in a visible cmux terminal pane. You can watch agents work in real-time.

## Install

```bash
pi install git:github.com/umgbhalla/pi-gigaplan
```

## Usage

```
/gigaplan build a rate limiter for the API endpoints
```

This will:
1. Ask for robustness level (light/standard/thorough) and auto-approve preference
2. Initialize a `.gigaplan/` directory with plan artifacts
3. Enter gigaplan mode — orchestrating subagents through the full loop
4. Pause at gate for your approval (unless auto-approve)
5. Execute and review

## Tools

| Tool | Description |
|------|-------------|
| `gigaplan_step` | Get subagent config for a step |
| `gigaplan_advance` | Process output and advance state machine |
| `gigaplan_status` | Show plan status |
| `gigaplan_override` | Manual intervention (add-note, abort, force-proceed, skip) |

## Artifacts

All state lives in `.gigaplan/plans/<plan-name>/`:

```
.gigaplan/plans/rate-limiter/
├── state.json           # Mutable plan state
├── faults.json          # Flag registry
├── plan_v1.md           # Versioned plan (markdown)
├── plan_v1.meta.json    # Plan metadata (criteria, assumptions)
├── critique_v1.json     # Critique flags
├── evaluation_v1.json   # Decision engine output
├── gate.json            # Gate preflight results
├── execution.json       # Execution output
└── review.json          # Review results
```

## Configuration

Robustness levels control how strict the critique is:

| Level | Behavior |
|-------|----------|
| **light** | Pragmatic. Only flags real failures. |
| **standard** | Balanced judgment. Significant risks flagged. |
| **thorough** | Exhaustive. Edge cases, performance, production concerns. |
