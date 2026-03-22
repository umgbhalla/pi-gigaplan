/**
 * pi-gigaplan extension
 *
 * Structured AI planning with cross-model critique.
 * Registers /gigaplan command and gigaplan_status tool.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Text } from "@mariozechner/pi-tui";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  PlanState,
  PlanConfig,
  FlagRecord,
  FlagRegistry,
  EvaluationResult,
  STATE_INITIALIZED,
  STATE_CLARIFIED,
  STATE_PLANNED,
  STATE_CRITIQUED,
  STATE_EVALUATED,
  STATE_GATED,
  STATE_EXECUTED,
  STATE_DONE,
  STATE_ABORTED,
  TERMINAL_STATES,
  DEFAULT_AGENT_ROUTING,
  ROBUSTNESS_LEVELS,
  nowUtc,
  slugify,
  jsonDump,
  sha256Text,
  atomicWriteText,
  atomicWriteJson,
  readJson,
  ensureRuntimeLayout,
  gigaplanRoot,
  plansRoot,
  schemasRoot,
  activePlanDirs,
  resolvePlanDir,
  loadPlan,
  savePlanState,
  latestPlanRecord,
  latestPlanPath,
  latestPlanMetaPath,
  loadFlagRegistry,
  saveFlagRegistry,
  unresolvedSignificantFlags,
  scopeCreepFlags,
  FLAG_BLOCKING_STATUSES,
  GigaplanError,
} from "../src/core.js";

import { buildEvaluation } from "../src/evaluation.js";
import {
  buildStepConfig,
  parseStepOutput,
  validatePayload,
  sessionKeyFor,
} from "../src/workers.js";

// ---------------------------------------------------------------------------
// State machine: valid transitions
// ---------------------------------------------------------------------------

const VALID_TRANSITIONS: Record<string, string[]> = {
  [STATE_INITIALIZED]: [STATE_CLARIFIED],
  [STATE_CLARIFIED]: [STATE_PLANNED],
  [STATE_PLANNED]: [STATE_CRITIQUED],
  [STATE_CRITIQUED]: [STATE_EVALUATED],
  [STATE_EVALUATED]: [STATE_PLANNED, STATE_GATED, STATE_ABORTED], // integrate→planned, skip→gated, abort
  [STATE_GATED]: [STATE_EXECUTED],
  [STATE_EXECUTED]: [STATE_DONE],
};

function requireState(state: PlanState, ...expected: string[]): void {
  if (!expected.includes(state.current_state)) {
    throw new GigaplanError(
      "invalid_state",
      `Expected state ${expected.join(" or ")}, got ${state.current_state}`,
    );
  }
}

/**
 * Infer the next step(s) from the current state.
 */
function inferNextSteps(state: PlanState): string[] {
  switch (state.current_state) {
    case STATE_INITIALIZED: return ["clarify"];
    case STATE_CLARIFIED: return ["plan"];
    case STATE_PLANNED: return ["critique"];
    case STATE_CRITIQUED: return ["evaluate"];
    case STATE_EVALUATED: {
      const rec = (state.last_evaluation as Record<string, unknown>)?.recommendation as string;
      if (rec === "CONTINUE") return ["integrate"];
      if (rec === "SKIP") return ["gate"];
      if (rec === "ABORT") return ["abort"];
      return ["override"]; // ESCALATE
    }
    case STATE_GATED: return ["execute"];
    case STATE_EXECUTED: return ["review"];
    default: return [];
  }
}

// ---------------------------------------------------------------------------
// Step handlers
// ---------------------------------------------------------------------------

interface StepResult {
  success: boolean;
  step: string;
  summary: string;
  nextSteps: string[];
  artifacts?: string[];
}

/**
 * Initialize a new plan.
 */
function initPlan(
  root: string,
  idea: string,
  options: {
    name?: string;
    maxIterations?: number;
    budgetUsd?: number;
    autoApprove?: boolean;
    robustness?: string;
  } = {},
): { planDir: string; state: PlanState } {
  ensureRuntimeLayout(root);

  const name = options.name ?? slugify(idea);
  const planDir = path.join(plansRoot(root), name);

  if (fs.existsSync(path.join(planDir, "state.json"))) {
    throw new GigaplanError("plan_exists", `Plan "${name}" already exists`);
  }

  fs.mkdirSync(planDir, { recursive: true });

  const state: PlanState = {
    name,
    idea,
    current_state: STATE_INITIALIZED,
    iteration: 0,
    created_at: nowUtc(),
    config: {
      max_iterations: options.maxIterations ?? 3,
      budget_usd: options.budgetUsd ?? 25.0,
      project_dir: root,
      auto_approve: options.autoApprove ?? false,
      robustness: options.robustness ?? "standard",
    },
    sessions: {},
    plan_versions: [],
    history: [],
    meta: {
      significant_counts: [],
      weighted_scores: [],
      plan_deltas: [],
      recurring_critiques: [],
      total_cost_usd: 0,
      overrides: [],
      notes: [],
    },
    last_evaluation: {},
  };

  savePlanState(planDir, state);
  saveFlagRegistry(planDir, { flags: [] });

  return { planDir, state };
}

/**
 * Process a step's output after a subagent completes.
 * Updates state, saves artifacts, advances the state machine.
 */
function processStepOutput(
  step: string,
  planDir: string,
  state: PlanState,
  payload: Record<string, unknown>,
  durationMs: number,
): StepResult {
  const iteration = state.iteration;

  switch (step) {
    case "clarify": {
      state.clarification = payload;
      state.current_state = STATE_CLARIFIED;
      state.history.push({
        step: "clarify",
        timestamp: nowUtc(),
        duration_ms: durationMs,
        result: "success",
      });
      savePlanState(planDir, state);
      return {
        success: true,
        step: "clarify",
        summary: `Clarified: ${(payload.intent_summary as string) ?? "done"}`,
        nextSteps: ["plan"],
        artifacts: [],
      };
    }

    case "plan":
    case "integrate": {
      const newIteration = iteration + 1;
      state.iteration = newIteration;

      // Save plan markdown
      const planText = (payload.plan as string) ?? "";
      const planFile = `plan_v${newIteration}.md`;
      atomicWriteText(path.join(planDir, planFile), planText);

      // Save plan metadata
      const meta = {
        success_criteria: payload.success_criteria ?? [],
        assumptions: payload.assumptions ?? [],
        questions: payload.questions ?? [],
        changes_summary: payload.changes_summary,
        flags_addressed: payload.flags_addressed,
      };
      atomicWriteJson(
        path.join(planDir, `plan_v${newIteration}.meta.json`),
        meta,
      );

      // Update plan versions
      state.plan_versions.push({
        version: newIteration,
        file: planFile,
        hash: sha256Text(planText),
        timestamp: nowUtc(),
      });

      // Handle flags addressed (integrate only)
      if (step === "integrate" && Array.isArray(payload.flags_addressed)) {
        const registry = loadFlagRegistry(planDir);
        for (const flagId of payload.flags_addressed as string[]) {
          const flag = registry.flags.find((f) => f.id === flagId);
          if (flag) {
            flag.status = "addressed";
            flag.addressed_in = `plan_v${newIteration}`;
          }
        }
        saveFlagRegistry(planDir, registry);
      }

      state.current_state = STATE_PLANNED;
      state.history.push({
        step,
        timestamp: nowUtc(),
        duration_ms: durationMs,
        result: "success",
        output_file: planFile,
      });
      savePlanState(planDir, state);

      return {
        success: true,
        step,
        summary: `Plan v${newIteration} created`,
        nextSteps: ["critique"],
        artifacts: [planFile],
      };
    }

    case "critique": {
      // Save critique artifact
      const critiqueFile = `critique_v${iteration}.json`;
      atomicWriteJson(path.join(planDir, critiqueFile), payload);

      // Update flag registry
      const registry = loadFlagRegistry(planDir);
      const newFlags = (payload.flags as FlagRecord[]) ?? [];
      const verifiedIds = new Set((payload.verified_flag_ids as string[]) ?? []);

      // Mark verified flags
      for (const flag of registry.flags) {
        if (flag.id && verifiedIds.has(flag.id)) {
          flag.status = "verified";
          flag.verified = true;
          flag.verified_in = `critique_v${iteration}`;
        }
      }

      // Add new flags
      for (const newFlag of newFlags) {
        const existing = registry.flags.find((f) => f.id === newFlag.id);
        if (existing) {
          existing.concern = newFlag.concern;
          existing.category = newFlag.category;
          existing.severity_hint = newFlag.severity_hint;
          existing.evidence = newFlag.evidence;
          existing.status = "open";
          existing.severity = newFlag.severity_hint === "likely-significant" ? "significant" : "minor";
        } else {
          registry.flags.push({
            ...newFlag,
            raised_in: `critique_v${iteration}`,
            status: "open",
            severity: newFlag.severity_hint === "likely-significant" ? "significant" : "minor",
          });
        }
      }
      saveFlagRegistry(planDir, registry);

      state.current_state = STATE_CRITIQUED;
      state.history.push({
        step: "critique",
        timestamp: nowUtc(),
        duration_ms: durationMs,
        result: "success",
        output_file: critiqueFile,
        flags_count: newFlags.length,
      });
      savePlanState(planDir, state);

      return {
        success: true,
        step: "critique",
        summary: `Critique: ${newFlags.length} flags raised, ${verifiedIds.size} verified`,
        nextSteps: ["evaluate"],
        artifacts: [critiqueFile],
      };
    }

    case "execute": {
      atomicWriteJson(path.join(planDir, "execution.json"), payload);
      state.current_state = STATE_EXECUTED;
      state.history.push({
        step: "execute",
        timestamp: nowUtc(),
        duration_ms: durationMs,
        result: "success",
        output_file: "execution.json",
      });
      savePlanState(planDir, state);

      return {
        success: true,
        step: "execute",
        summary: `Executed. Files changed: ${(payload.files_changed as string[])?.length ?? 0}`,
        nextSteps: ["review"],
        artifacts: ["execution.json"],
      };
    }

    case "review": {
      atomicWriteJson(path.join(planDir, "review.json"), payload);
      state.current_state = STATE_DONE;
      state.history.push({
        step: "review",
        timestamp: nowUtc(),
        duration_ms: durationMs,
        result: "success",
        output_file: "review.json",
      });
      savePlanState(planDir, state);

      const criteria = (payload.criteria as Array<{ name: string; pass: boolean }>) ?? [];
      const passed = criteria.filter((c) => c.pass).length;
      return {
        success: true,
        step: "review",
        summary: `Review: ${passed}/${criteria.length} criteria passed. ${(payload.issues as string[])?.length ?? 0} issues.`,
        nextSteps: [],
        artifacts: ["review.json"],
      };
    }

    default:
      throw new GigaplanError("unsupported_step", `Unknown step: ${step}`);
  }
}

/**
 * Run the evaluate step (pure logic, no LLM needed).
 */
function runEvaluate(planDir: string, state: PlanState): StepResult {
  requireState(state, STATE_CRITIQUED);

  const evaluation = buildEvaluation(planDir, state);
  const evalFile = `evaluation_v${state.iteration}.json`;
  atomicWriteJson(path.join(planDir, evalFile), evaluation);

  // Update meta tracking
  const registry = loadFlagRegistry(planDir);
  const sigCount = registry.flags.filter(
    (f) => f.severity === "significant" && f.status !== "verified",
  ).length;
  state.meta.significant_counts = [...(state.meta.significant_counts ?? []), sigCount];
  state.meta.weighted_scores = [
    ...(state.meta.weighted_scores ?? []),
    (evaluation.signals as Record<string, unknown>).weighted_score as number,
  ];

  state.last_evaluation = evaluation as unknown as Record<string, unknown>;
  state.current_state = STATE_EVALUATED;
  state.history.push({
    step: "evaluate",
    timestamp: nowUtc(),
    result: "success",
    recommendation: evaluation.recommendation,
    output_file: evalFile,
  });
  savePlanState(planDir, state);

  return {
    success: true,
    step: "evaluate",
    summary: `Evaluation: ${evaluation.recommendation} (${evaluation.confidence} confidence). ${evaluation.rationale}`,
    nextSteps: evaluation.valid_next_steps ?? [],
    artifacts: [evalFile],
  };
}

/**
 * Run gate checks (pure logic).
 */
function runGate(planDir: string, state: PlanState): StepResult {
  requireState(state, STATE_EVALUATED);

  const projectDir = state.config.project_dir ?? process.cwd();
  const checks: Record<string, boolean> = {
    project_exists: fs.existsSync(projectDir),
    project_writable: (() => {
      try { fs.accessSync(projectDir, fs.constants.W_OK); return true; } catch { return false; }
    })(),
    plan_exists: state.plan_versions.length > 0,
    has_success_criteria: (() => {
      try {
        const meta = readJson(latestPlanMetaPath(planDir, state)) as Record<string, unknown>;
        return Array.isArray(meta.success_criteria) && meta.success_criteria.length > 0;
      } catch { return false; }
    })(),
  };

  const registry = loadFlagRegistry(planDir);
  const unresolved = unresolvedSignificantFlags(registry);
  checks.no_unresolved_flags = unresolved.length === 0;

  const passed = Object.values(checks).every(Boolean);

  const gate = {
    passed,
    preflight_results: checks,
    unresolved_flags: unresolved.map((f) => ({ id: f.id, concern: f.concern })),
    timestamp: nowUtc(),
  };

  atomicWriteJson(path.join(planDir, "gate.json"), gate);

  if (passed) {
    state.current_state = STATE_GATED;
  }

  state.history.push({
    step: "gate",
    timestamp: nowUtc(),
    result: passed ? "success" : "failed",
  });
  savePlanState(planDir, state);

  return {
    success: passed,
    step: "gate",
    summary: passed
      ? "Gate passed. Ready for execution."
      : `Gate failed: ${Object.entries(checks).filter(([, v]) => !v).map(([k]) => k).join(", ")}`,
    nextSteps: passed ? ["execute"] : ["integrate"],
    artifacts: ["gate.json"],
  };
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function gigaplanExtension(pi: ExtensionAPI) {

  // Widget state
  let activePlan: { name: string; state: string; step: string } | null = null;

  function updateWidget(ctx?: any) {
    if (!ctx?.ui) return;
    if (!activePlan) {
      ctx.ui.setStatus("gigaplan", "");
      return;
    }
    ctx.ui.setStatus(
      "gigaplan",
      `📋 ${activePlan.name} [${activePlan.state}] → ${activePlan.step}`,
    );
  }

  // ── /gigaplan command ──
  pi.registerCommand("gigaplan", {
    description: "Start a structured planning session: /gigaplan <idea>",
    handler: async (args, ctx) => {
      const idea = (args ?? "").trim();
      if (!idea) {
        ctx.ui.notify("Usage: /gigaplan <description of what to build>", "warning");
        return;
      }

      // Ask for configuration
      const ROBUSTNESS_OPTIONS = ["Light — pragmatic, fast", "Standard — balanced (default)", "Thorough — exhaustive review"];
      const ROBUSTNESS_MAP: Record<string, string> = {
        [ROBUSTNESS_OPTIONS[0]]: "light",
        [ROBUSTNESS_OPTIONS[1]]: "standard",
        [ROBUSTNESS_OPTIONS[2]]: "thorough",
      };
      const robustnessChoice = await ctx.ui.select("Robustness level", ROBUSTNESS_OPTIONS);
      const robustness = ROBUSTNESS_MAP[robustnessChoice ?? ""] ?? "standard";

      const autoApprove = await ctx.ui.confirm(
        "Auto-approve?",
        "Skip manual gate approval and auto-advance through all steps?",
      );

      // Initialize
      const root = ctx.cwd;
      const { planDir, state } = initPlan(root, idea, {
        robustness,
        autoApprove,
      });

      activePlan = { name: state.name, state: state.current_state, step: "clarify" };
      updateWidget(ctx);

      ctx.ui.notify(`Plan "${state.name}" initialized. Starting orchestration...`, "info");

      // Send orchestration prompt to the LLM
      const orchestrationPrompt = `You are now in **gigaplan mode**. A structured plan has been initialized.

## Plan: ${state.name}
- **Idea:** ${idea}
- **Robustness:** ${robustness}
- **Auto-approve:** ${autoApprove}
- **Plan directory:** ${planDir}

## Workflow

Execute each step by spawning a subagent using the \`subagent\` tool. After each subagent completes, use the \`gigaplan_advance\` tool to process the output and advance the state machine.

### Steps (in order):
1. **clarify** → Spawn subagent to clarify the idea
2. **plan** → Spawn subagent to create implementation plan
3. **critique** → Spawn subagent (different model!) to independently critique
4. **evaluate** → Use \`gigaplan_advance\` with step="evaluate" (no subagent needed)
5. Based on evaluation:
   - CONTINUE → **integrate** (spawn subagent to revise plan) → back to critique
   - SKIP → **gate** (use \`gigaplan_advance\` with step="gate")
   - ESCALATE → Ask user for override decision
   - ABORT → Stop
6. After gate passes: **execute** → Spawn subagent to implement
7. **review** → Spawn subagent to validate

### Subagent spawning pattern:
For each LLM step, use the \`gigaplan_step\` tool which returns the subagent config, then spawn it.

Start now with the **clarify** step.`;

      pi.sendUserMessage(orchestrationPrompt);
    },
  });

  // ── gigaplan_step tool — get subagent config for a step ──
  pi.registerTool({
    name: "gigaplan_step",
    label: "Gigaplan Step",
    description:
      "Get the subagent configuration for a gigaplan step. Returns the task prompt, " +
      "agent name, and output path. Use this before spawning a subagent for each step.",
    parameters: Type.Object({
      planDir: Type.String({ description: "Path to the plan directory (.gigaplan/plans/<name>)" }),
      step: Type.String({ description: "Step to run: clarify, plan, critique, integrate, execute, review" }),
    }),

    async execute(_id, params) {
      try {
        const state = readJson(path.join(params.planDir, "state.json")) as PlanState;
        const config = buildStepConfig(params.step, state, params.planDir);

        return {
          content: [{
            type: "text",
            text: `Subagent config for step "${params.step}":\n\n` +
              `**Name:** ${config.name}\n` +
              `**Agent:** ${config.agent}\n` +
              `**Output path:** ${config.outputPath}\n` +
              `**Tools:** ${config.tools}\n\n` +
              `Spawn this as an autonomous subagent with the task below. ` +
              `After it completes, call gigaplan_advance with step="${params.step}".`,
          }],
          details: {
            name: config.name,
            agent: config.agent,
            task: config.task,
            model: config.model,
            tools: config.tools,
            outputPath: config.outputPath,
            interactive: false,
          },
        };
      } catch (e) {
        return {
          content: [{ type: "text", text: `Error: ${e instanceof Error ? e.message : String(e)}` }],
          details: { error: true } as any,
        };
      }
    },
  });

  // ── gigaplan_advance tool — process output and advance state ──
  pi.registerTool({
    name: "gigaplan_advance",
    label: "Gigaplan Advance",
    description:
      "Process a completed gigaplan step and advance the state machine. " +
      "For LLM steps (clarify, plan, critique, integrate, execute, review): reads the output file written by the subagent. " +
      "For logic steps (evaluate, gate): runs the logic directly.",
    parameters: Type.Object({
      planDir: Type.String({ description: "Path to the plan directory" }),
      step: Type.String({ description: "Step that just completed" }),
      durationMs: Type.Optional(Type.Number({ description: "How long the step took in ms" })),
    }),

    async execute(_id, params, _signal, _onUpdate, ctx) {
      try {
        const state = readJson(path.join(params.planDir, "state.json")) as PlanState;
        let result: StepResult;

        if (params.step === "evaluate") {
          result = runEvaluate(params.planDir, state);
        } else if (params.step === "gate") {
          result = runGate(params.planDir, state);
        } else {
          // LLM step — read subagent output
          const outputPath = path.join(params.planDir, `${params.step}_output.json`);
          const payload = parseStepOutput(params.step, outputPath);
          result = processStepOutput(
            params.step,
            params.planDir,
            state,
            payload,
            params.durationMs ?? 0,
          );
        }

        // Update widget
        if (activePlan) {
          activePlan.state = result.step;
          activePlan.step = result.nextSteps[0] ?? "done";
          updateWidget(ctx);
        }

        const nextAction = result.nextSteps.length > 0
          ? `\n\n**Next step(s):** ${result.nextSteps.join(", ")}`
          : "\n\n**Plan complete!**";

        return {
          content: [{
            type: "text",
            text: `**${result.step}** — ${result.summary}${nextAction}`,
          }],
          details: {
            success: result.success,
            step: result.step,
            summary: result.summary,
            nextSteps: result.nextSteps,
            artifacts: result.artifacts,
          },
        };
      } catch (e) {
        return {
          content: [{ type: "text", text: `Error advancing: ${e instanceof Error ? e.message : String(e)}` }],
          details: { error: true } as any,
        };
      }
    },
  });

  // ── gigaplan_status tool ──
  pi.registerTool({
    name: "gigaplan_status",
    label: "Gigaplan Status",
    description: "Show the status of gigaplan plans in the current project.",
    parameters: Type.Object({
      planName: Type.Optional(Type.String({ description: "Specific plan name (optional)" })),
    }),

    async execute(_id, params, _signal, _onUpdate, ctx) {
      const root = ctx.cwd;
      const gigaplan = gigaplanRoot(root);

      if (!fs.existsSync(gigaplan)) {
        return {
          content: [{ type: "text", text: "No .gigaplan directory found. Run /gigaplan to start." }],
          details: {},
        };
      }

      const dirs = activePlanDirs(root);
      if (dirs.length === 0) {
        return {
          content: [{ type: "text", text: "No plans found." }],
          details: {},
        };
      }

      if (params.planName) {
        const planDir = path.join(plansRoot(root), params.planName);
        if (!fs.existsSync(path.join(planDir, "state.json"))) {
          return {
            content: [{ type: "text", text: `Plan "${params.planName}" not found.` }],
            details: {},
          };
        }
        const state = readJson(path.join(planDir, "state.json")) as PlanState;
        const registry = loadFlagRegistry(planDir);
        const unresolved = unresolvedSignificantFlags(registry);
        const nextSteps = inferNextSteps(state);

        const lines = [
          `# Plan: ${state.name}`,
          `**State:** ${state.current_state}`,
          `**Iteration:** ${state.iteration}`,
          `**Idea:** ${state.idea}`,
          `**Robustness:** ${state.config.robustness ?? "standard"}`,
          `**Next steps:** ${nextSteps.join(", ") || "none"}`,
          `**Total flags:** ${registry.flags.length} (${unresolved.length} unresolved significant)`,
          `**History:** ${state.history.map((h) => h.step).join(" → ")}`,
        ];

        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: { state, planDir },
        };
      }

      // List all plans
      const lines = dirs.map((d) => {
        const s = readJson(path.join(d, "state.json")) as PlanState;
        const next = inferNextSteps(s);
        return `• **${s.name}** [${s.current_state}] iter=${s.iteration} → ${next[0] ?? "done"}`;
      });

      return {
        content: [{ type: "text", text: `## Gigaplan Plans\n\n${lines.join("\n")}` }],
        details: { plans: dirs.map((d) => path.basename(d)) },
      };
    },
  });

  // ── gigaplan_override tool ──
  pi.registerTool({
    name: "gigaplan_override",
    label: "Gigaplan Override",
    description: "Manual intervention on a gigaplan: add-note, abort, force-proceed, or skip.",
    parameters: Type.Object({
      planDir: Type.String({ description: "Path to the plan directory" }),
      action: Type.String({ description: "Override action: add-note, abort, force-proceed, skip" }),
      note: Type.Optional(Type.String({ description: "Note text (for add-note action)" })),
    }),

    async execute(_id, params) {
      try {
        const state = readJson(path.join(params.planDir, "state.json")) as PlanState;

        switch (params.action) {
          case "add-note": {
            if (!params.note) {
              return { content: [{ type: "text", text: "Error: note text required for add-note" }], details: {} };
            }
            state.meta.notes = [
              ...(state.meta.notes ?? []),
              { note: params.note, timestamp: nowUtc() },
            ];
            state.history.push({
              step: "override",
              timestamp: nowUtc(),
              message: `add-note: ${params.note}`,
            });
            savePlanState(params.planDir, state);
            return { content: [{ type: "text", text: `Note added. Continue with the current step.` }], details: {} };
          }

          case "abort": {
            state.current_state = STATE_ABORTED;
            state.history.push({ step: "override", timestamp: nowUtc(), message: "aborted" });
            savePlanState(params.planDir, state);
            return { content: [{ type: "text", text: `Plan "${state.name}" aborted.` }], details: {} };
          }

          case "force-proceed": {
            state.current_state = STATE_GATED;
            state.meta.user_approved_gate = true;
            state.history.push({
              step: "override",
              timestamp: nowUtc(),
              message: "force-proceed (bypassed gate)",
            });
            savePlanState(params.planDir, state);
            return {
              content: [{ type: "text", text: "Force-proceeded to gate. Next step: execute." }],
              details: { nextSteps: ["execute"] } as any,
            };
          }

          case "skip": {
            state.last_evaluation = { recommendation: "SKIP" };
            state.current_state = STATE_EVALUATED;
            state.history.push({
              step: "override",
              timestamp: nowUtc(),
              message: "skip (user override to SKIP)",
            });
            savePlanState(params.planDir, state);
            return {
              content: [{ type: "text", text: "Skipped to gate. Next step: gate." }],
              details: { nextSteps: ["gate"] } as any,
            };
          }

          default:
            return {
              content: [{ type: "text", text: `Unknown action: ${params.action}. Use: add-note, abort, force-proceed, skip` }],
              details: {},
            };
        }
      } catch (e) {
        return {
          content: [{ type: "text", text: `Error: ${e instanceof Error ? e.message : String(e)}` }],
          details: { error: true } as any,
        };
      }
    },
  });
}
