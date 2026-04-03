/**
 * pi-gigaplan extension
 *
 * Structured AI planning with cross-model critique.
 * Registers /gigaplan command and gigaplan_status tool.
 */

import type { ExtensionAPI, Theme } from "@mariozechner/pi-coding-agent";
import { DynamicBorder } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Container, Key, SelectList, Text, matchesKey, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
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
  repairStepOutputFile,
  validatePayload,
  sessionKeyFor,
} from "../src/workers.js";
import {
  type GigaplanViewModel,
  buildStatusText,
  buildViewModel,
  buildWidgetLines,
  compactIdea,
  describeIssues,
  formatAdvanceResult,
  formatDoctorResult,
  formatInitResult,
  formatOverrideResult,
  formatStatusResult,
  formatStepResult,
  isRenderableState,
  resolveFocusedPlan,
  toolCallArg,
} from "../src/presentation/index.js";
import { GigaplanHeader } from "../src/presentation/header.js";
import { createStepPanelRenderer, type StepPanelDetails } from "../src/presentation/step-panel.js";

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
      const lastHistory = state.history[state.history.length - 1];
      if (lastHistory?.step === "gate" && lastHistory.result === "failed") {
        return ["integrate"];
      }

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

const LLM_STEPS = new Set(["clarify", "plan", "critique", "integrate", "execute", "review"]);
const LOGIC_STEPS = new Set(["evaluate", "gate"]);

function requireAllowedStep(state: PlanState, step: string): void {
  const nextSteps = inferNextSteps(state);
  if (!nextSteps.includes(step)) {
    throw new GigaplanError(
      "invalid_state",
      `Step "${step}" is not valid from state ${state.current_state}. Expected next step: ${nextSteps.join(", ") || "none"}`,
    );
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
 * Process a step's output after an agent completes.
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
      requireState(state, STATE_INITIALIZED);
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
      if (step === "plan") requireState(state, STATE_CLARIFIED);
      else requireState(state, STATE_EVALUATED);

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
      requireState(state, STATE_PLANNED);

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
      requireState(state, STATE_GATED);
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
      requireState(state, STATE_EXECUTED);
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

const ROBUSTNESS_OPTIONS = ["Light — pragmatic, fast", "Standard — balanced (default)", "Thorough — exhaustive review"] as const;
const ROBUSTNESS_MAP: Record<string, string> = {
  [ROBUSTNESS_OPTIONS[0]]: "light",
  [ROBUSTNESS_OPTIONS[1]]: "standard",
  [ROBUSTNESS_OPTIONS[2]]: "thorough",
};
const VALID_ROBUSTNESS = new Set(["light", "standard", "thorough"]);

export default function gigaplanExtension(pi: ExtensionAPI) {

  pi.registerMessageRenderer("gigaplan-step", createStepPanelRenderer());

  let activePlan: GigaplanViewModel | null = null;
  let header: GigaplanHeader | null = null;
  let headerRegistered = false;

  function themeFor(ctx?: any): Theme | undefined {
    return (ctx?.ui as { theme?: Theme } | undefined)?.theme;
  }

  function buildViewModelForPlan(root: string, planDir: string, state: PlanState, issues?: string[]): GigaplanViewModel {
    let focused = null as ReturnType<typeof resolveFocusedPlan>;
    try {
      focused = resolveFocusedPlan(root, state.name);
    } catch {
      focused = null;
    }
    return buildViewModel(planDir, state, {
      totalPlans: focused?.totalPlans ?? 1,
      focusIndex: focused?.focusIndex ?? 1,
      alternates: focused?.alternates ?? [],
      issues,
    });
  }

  function updateHeader(ctx?: any): void {
    if (!ctx?.ui?.setHeader) return;

    if (!activePlan) {
      header = null;
      headerRegistered = false;
      ctx.ui.setHeader(undefined);
      return;
    }

    if (!headerRegistered) {
      const viewModel = activePlan;
      ctx.ui.setHeader((tui: any, theme: Theme) => {
        const nextHeader = new GigaplanHeader(theme);
        nextHeader.attachTui(tui);
        nextHeader.setViewModel(viewModel);
        header = nextHeader;
        return nextHeader;
      });
      headerRegistered = true;
    }

    header?.setViewModel(activePlan);
  }

  function syncActivePlan(root: string, ctx?: any): void {
    const focused = resolveFocusedPlan(root);
    if (!focused || !isRenderableState(focused.state.current_state)) {
      activePlan = null;
      updateHeader(ctx);
      return;
    }
    activePlan = buildViewModel(focused.planDir, focused.state, {
      totalPlans: focused.totalPlans,
      focusIndex: focused.focusIndex,
      alternates: focused.alternates,
    });
    updateHeader(ctx);
  }

  function buildStepMessageDetails(
    root: string,
    planDir: string,
    state: PlanState,
    result: StepResult,
    durationMs?: number | null,
    issues?: string[],
    extraDetails: Record<string, unknown> = {},
  ): StepPanelDetails {
    const viewModel = buildViewModelForPlan(root, planDir, state, issues);
    return {
      ...extraDetails,
      step: result.step,
      planDir,
      planName: state.name,
      state: state.current_state,
      version: state.iteration,
      iteration: state.iteration,
      duration: durationMs ?? undefined,
      durationMs: durationMs ?? undefined,
      summary: result.summary,
      nextSteps: result.nextSteps,
      stepResult: {
        success: result.success,
        step: result.step,
        summary: result.summary,
        nextSteps: result.nextSteps,
        artifacts: result.artifacts,
      },
      viewModel,
      recommendation: viewModel.recommendation ?? undefined,
      confidence: viewModel.confidence ?? undefined,
      score: viewModel.weightedScore ?? undefined,
      delta: viewModel.scoreDelta ?? undefined,
      verifiedFlags: viewModel.verifiedFlags,
      openFlags: viewModel.openSignificant + viewModel.openMinor,
    };
  }

  function sendStepMessage(details: StepPanelDetails): void {
    pi.sendMessage({
      customType: "gigaplan-step",
      content: details.summary ?? ((details.stepResult as Record<string, unknown> | undefined)?.summary as string | undefined) ?? details.step ?? "step",
      display: true,
      details,
    }, { triggerTurn: false });
  }

  /**
   * Check if a plan directory is owned by (contained within) the current working directory.
   * Uses proper path resolution to avoid false positives from prefix matches
   * (e.g., /projects/A2 should NOT be considered inside /projects/A).
   */
  function isPlanOwnedByCwd(planDir: string, cwd: string): boolean {
    const resolvedPlanDir = path.resolve(planDir);
    const resolvedCwd = path.resolve(cwd);
    const rel = path.relative(resolvedCwd, resolvedPlanDir);
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  }

  function updateWidget(ctx?: any) {
    if (!ctx?.ui) return;
    // Only show/update header if plan belongs to current directory
    if (!activePlan || !isPlanOwnedByCwd(activePlan.planDir, ctx.cwd)) {
      ctx.ui.setStatus("gigaplan", undefined);
      ctx.ui.setWidget?.("gigaplan", undefined);
      updateHeader(ctx);
      return;
    }


    updateHeader(ctx);

    if (ctx.ui.setWidget) {
      ctx.ui.setStatus("gigaplan", undefined);
      ctx.ui.setWidget("gigaplan", (_tui: unknown, widgetTheme: Theme) => ({
        render(width: number) {
          return buildWidgetLines(activePlan!, widgetTheme, width);
        },
        invalidate() {},
      }));
      return;
    }

    const theme = themeFor(ctx);
    const statusWidth = 120;
    ctx.ui.setStatus(
      "gigaplan",
      buildStatusText(activePlan, theme, statusWidth),
    );
  }

  async function showDoctorOverlay(result: ReturnType<typeof diagnosePlan>, ctx: any): Promise<string | null> {
    if (!ctx?.ui?.custom) return null;

    const items = [
      { value: "fix", label: "Fix JSON", description: "Normalize the next step output when a safe repair exists" },
      { value: "respawn", label: "Respawn agent", description: "Use the next-step config to rerun the current agent step" },
      { value: "abort", label: "Abort plan", description: "Mark the focused plan as aborted" },
    ];

    return ctx.ui.custom((tui: any, overlayTheme: Theme, _kb: unknown, done: (result: string | null) => void) => {
      const container = new Container();
      container.addChild(new DynamicBorder((str) => overlayTheme.fg("accent", str)));

      const viewModel = buildViewModelForPlan(ctx.cwd, result.planDir, result.state, result.issues);
      const planInfo = new Text(
        `${overlayTheme.bold(viewModel.name)}  ${overlayTheme.fg(viewModel.stateColor, viewModel.state)}${overlayTheme.fg("dim", " → ")}${overlayTheme.fg("accent", viewModel.nextStep ?? "done")}`,
        1,
        0,
      );
      container.addChild(planInfo);

      const issueLines = result.issues.length === 0
        ? `${overlayTheme.fg("success", "✓")} ${overlayTheme.fg("text", "No issues detected")}`
        : [
            `${overlayTheme.fg("dim", `Issues (${result.issues.length}):`)}`,
            ...result.issues.map((issue) => `  ${overlayTheme.fg("warning", "●")} ${overlayTheme.fg("text", issue)}`),
          ].join("\n");
      container.addChild(new Text(issueLines, 1, 0));

      const selectList = new SelectList(items, items.length, {
        selectedPrefix: (text) => overlayTheme.fg("accent", text),
        selectedText: (text) => overlayTheme.fg("accent", text),
        description: (text) => overlayTheme.fg("muted", text),
        scrollInfo: (text) => overlayTheme.fg("dim", text),
        noMatch: (text) => overlayTheme.fg("warning", text),
      });

      selectList.onSelect = (item) => done(item.value);
      selectList.onCancel = () => done(null);
      container.addChild(selectList);
      container.addChild(new Text(overlayTheme.fg("dim", "↑↓ navigate · enter select · esc cancel"), 1, 0));
      container.addChild(new DynamicBorder((str) => overlayTheme.fg("accent", str)));

      return {
        render(width: number) {
          return container.render(width);
        },
        invalidate() {
          container.invalidate();
        },
        handleInput(data: string) {
          if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
            done(null);
            return;
          }
          selectList.handleInput(data);
          tui.requestRender();
        },
      };
    }, { overlay: true });
  }

  function buildOrchestrationPrompt(args: {
    idea: string;
    planDir: string;
    state: PlanState;
    robustness: string;
    autoApprove: boolean;
  }): string {
    return `You are now in **gigaplan mode**. A structured plan has been initialized.

## Plan: ${args.state.name}
- **Idea:** ${args.idea}
- **Robustness:** ${args.robustness}
- **Auto-approve:** ${args.autoApprove}
- **Plan directory:** ${args.planDir}

## Workflow

Execute each step by spawning agents using \`agent_group\`. After each group completes, use \`gigaplan_advance\` to process the output and advance the state machine.

### Steps (in order):
1. **clarify** → Spawn agent to clarify the idea
2. **plan** → Spawn agent to create implementation plan
3. **critique** → Spawn agent (different model!) to independently critique
4. **evaluate** → Use \`gigaplan_advance\` with step="evaluate" (no agent needed)
5. Based on evaluation:
   - CONTINUE → **integrate** (spawn agent to revise plan) → back to critique
   - SKIP → **gate** (use \`gigaplan_advance\` with step="gate")
   - ESCALATE → Ask user for override decision
   - ABORT → Stop
6. After gate passes: **execute** → Spawn agent to implement
7. **review** → Spawn agent to validate

### Agent spawning pattern:
For each LLM step, use \`gigaplan_step\` to get the agent config, then spawn it via \`agent_group\` with \`wait: true\`:

\`\`\`typescript
agent_group({
  name: "Gigaplan: <step>",
  wait: true,
  agents: [{ name: "<step config name>", agent: "<step config agent>", task: "<step config task>" }]
})
\`\`\`

Start now with the **clarify** step.`;
  }

  function initializeGigaplan(
    root: string,
    idea: string,
    options: {
      name?: string;
      maxIterations?: number;
      budgetUsd?: number;
      autoApprove?: boolean;
      robustness?: string;
    },
    ctx?: any,
  ) {
    const robustness = options.robustness ?? "standard";
    const autoApprove = options.autoApprove ?? false;
    const { planDir, state } = initPlan(root, idea, {
      ...options,
      robustness,
      autoApprove,
    });

    activePlan = buildViewModelForPlan(root, planDir, state);
    updateWidget(ctx);
    sendStepMessage({
      step: "init",
      planDir,
      planName: state.name,
      state: state.current_state,
      version: state.iteration,
      iteration: state.iteration,
      duration: undefined,
      durationMs: undefined,
      summary: `Initialized plan ${state.name}`,
      nextSteps: ["clarify"],
      stepResult: {
        success: true,
        step: "init",
        summary: `Initialized plan ${state.name}`,
        nextSteps: ["clarify"],
      },
      viewModel: activePlan,
    });
    ctx?.ui?.notify?.(`Plan "${state.name}" initialized. Starting orchestration...`, "info");

    return {
      planDir,
      state,
      robustness,
      autoApprove,
      orchestrationPrompt: buildOrchestrationPrompt({
        idea,
        planDir,
        state,
        robustness,
        autoApprove,
      }),
    };
  }

  function diagnosePlan(root: string, requestedPlanName?: string, fix = false) {
    ensureRuntimeLayout(root);
    const planDir = resolvePlanDir(root, requestedPlanName);
    const state = readJson(path.join(planDir, "state.json")) as PlanState;
    const issues: string[] = [];
    const fixes: string[] = [];
    const nextSteps = inferNextSteps(state);
    const nextStep = nextSteps[0] ?? null;

    const configured = state.config.robustness;
    if (configured && !VALID_ROBUSTNESS.has(configured)) {
      issues.push(`Invalid robustness \`${configured}\` in state.json.`);
      if (fix) {
        state.config.robustness = "standard";
        savePlanState(planDir, state);
        fixes.push("Reset invalid robustness to `standard`.");
      }
    }

    const requiredJsonFiles = ["state.json", "faults.json"];
    for (const filename of requiredJsonFiles) {
      const filePath = path.join(planDir, filename);
      if (!fs.existsSync(filePath)) {
        issues.push(`Missing required file: ${filename}`);
      } else {
        try {
          readJson(filePath);
        } catch (e) {
          issues.push(`Malformed JSON in ${filename}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }

    if (state.iteration > 0) {
      const planFile = path.join(planDir, `plan_v${state.iteration}.md`);
      const planMetaFile = path.join(planDir, `plan_v${state.iteration}.meta.json`);
      if (!fs.existsSync(planFile)) {
        issues.push(`Missing current plan file: ${path.basename(planFile)}`);
      }
      if (!fs.existsSync(planMetaFile)) {
        issues.push(`Missing current plan metadata: ${path.basename(planMetaFile)}`);
      } else {
        try {
          readJson(planMetaFile);
        } catch (e) {
          issues.push(`Malformed plan metadata JSON: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }

    let nextStepConfig: Record<string, unknown> | null = null;
    if (nextStep && LLM_STEPS.has(nextStep)) {
      const outputPath = path.join(planDir, `${nextStep}_output.json`);
      nextStepConfig = buildStepConfig(nextStep, state, planDir) as unknown as Record<string, unknown>;
      if (fs.existsSync(outputPath)) {
        try {
          parseStepOutput(nextStep, outputPath);
          if (fix) {
            const repair = repairStepOutputFile(nextStep, outputPath);
            if (repair.repaired) {
              fixes.push(`Normalized ${nextStep}_output.json into valid canonical JSON.`);
            }
          }
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          issues.push(`Invalid ${nextStep} output JSON: ${message}`);
          if (fix) {
            try {
              const repair = repairStepOutputFile(nextStep, outputPath);
              fixes.push(
                repair.repaired
                  ? `Normalized ${nextStep}_output.json into valid canonical JSON.`
                  : `${nextStep}_output.json was already machine-parseable; no rewrite needed.`,
              );
            } catch (repairError) {
              issues.push(`Automatic repair failed for ${nextStep}_output.json: ${repairError instanceof Error ? repairError.message : String(repairError)}`);
            }
          }
        }
      }
    }

    if (nextStep === "evaluate") {
      const critiqueFile = path.join(planDir, `critique_v${state.iteration}.json`);
      if (!fs.existsSync(critiqueFile)) {
        issues.push(`Cannot evaluate: missing ${path.basename(critiqueFile)}.`);
      }
    }

    if (nextStep === "gate") {
      const evaluationFile = path.join(planDir, `evaluation_v${state.iteration}.json`);
      if (!fs.existsSync(evaluationFile)) {
        issues.push(`Cannot gate: missing ${path.basename(evaluationFile)}.`);
      }
    }

    return {
      planDir,
      state,
      nextSteps,
      nextStep,
      issues,
      fixes,
      nextStepConfig,
    };
  }

  pi.on("session_start", (_event, ctx) => {
    syncActivePlan(ctx.cwd, ctx);
    updateWidget(ctx);
  });

  pi.on("session_switch", (_event, ctx) => {
    syncActivePlan(ctx.cwd, ctx);
    updateWidget(ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    // Only clear if the shutting down session owns the active plan
    if (activePlan && isPlanOwnedByCwd(activePlan.planDir, ctx.cwd)) {
      activePlan = null;
    }
    updateWidget(ctx);
  });

  // ── /gigaplan command ──
  pi.registerCommand("gigaplan", {
    description: "Start a structured planning session: /gigaplan <idea>",
    handler: async (args, ctx) => {
      const idea = (args ?? "").trim();
      if (!idea) {
        ctx.ui.notify("Usage: /gigaplan <description of what to build>", "warning");
        return;
      }

      const robustnessChoice = await ctx.ui.select("Robustness level", [...ROBUSTNESS_OPTIONS]);
      const robustness = ROBUSTNESS_MAP[robustnessChoice ?? ""] ?? "standard";

      const autoApprove = await ctx.ui.confirm(
        "Auto-approve?",
        "Skip manual gate approval and auto-advance through all steps?",
      );

      const { orchestrationPrompt } = initializeGigaplan(
        ctx.cwd,
        idea,
        { robustness, autoApprove },
        ctx,
      );

      pi.sendUserMessage(orchestrationPrompt, { deliverAs: "steer" });
    },
  });

  // ── gigaplan_init tool — initialize a plan without slash-command UI ──
  pi.registerTool({
    name: "gigaplan_init",
    label: "Gigaplan Init",
    description:
      "Initialize a gigaplan directly from a tool call. Use this when the agent needs to self-start " +
      "a plan without relying on /gigaplan or interactive command UI. Optionally queues the orchestration prompt.",
    parameters: Type.Object({
      idea: Type.String({ description: "What to build" }),
      name: Type.Optional(Type.String({ description: "Optional explicit plan name" })),
      maxIterations: Type.Optional(Type.Number({ description: "Maximum critique/integrate iterations" })),
      budgetUsd: Type.Optional(Type.Number({ description: "Budget cap in USD" })),
      autoApprove: Type.Optional(Type.Boolean({ description: "Skip manual gate approval" })),
      robustness: Type.Optional(Type.String({ description: "light, standard, or thorough" })),
      startOrchestration: Type.Optional(Type.Boolean({ description: "Queue the follow-up orchestration prompt (default: true)" })),
    }),

    async execute(_id, params, _signal, _onUpdate, ctx) {
      try {
        const idea = params.idea.trim();
        if (!idea) {
          throw new GigaplanError("missing_idea", "idea is required");
        }

        const robustness = params.robustness ?? "standard";
        if (!VALID_ROBUSTNESS.has(robustness)) {
          throw new GigaplanError("invalid_robustness", `Invalid robustness: ${robustness}`);
        }

        const { planDir, state, orchestrationPrompt, autoApprove: resolvedAutoApprove } = initializeGigaplan(
          ctx.cwd,
          idea,
          {
            name: params.name,
            maxIterations: params.maxIterations,
            budgetUsd: params.budgetUsd,
            autoApprove: params.autoApprove,
            robustness,
          },
          ctx,
        );

        const startOrchestration = params.startOrchestration ?? true;
        if (startOrchestration) {
          pi.sendUserMessage(orchestrationPrompt, { deliverAs: "steer" });
        }

        return {
          content: [{
            type: "text",
            text:
              `Initialized plan **${state.name}** at \`${planDir}\`.` +
              (startOrchestration ? " Orchestration prompt queued." : " Orchestration prompt not queued."),
          }],
          details: {
            planDir,
            planName: state.name,
            idea,
            robustness,
            autoApprove: resolvedAutoApprove,
            nextStep: "clarify",
            promptQueued: startOrchestration,
            viewModel: buildViewModelForPlan(ctx.cwd, planDir, state),
          },
        };
      } catch (e) {
        return {
          content: [{ type: "text", text: `Error initializing gigaplan: ${e instanceof Error ? e.message : String(e)}` }],
          details: { error: true, message: e instanceof Error ? e.message : String(e) } as any,
        };
      }
    },

    renderCall(args, theme) {
      return new Text(toolCallArg("gigaplan_init", compactIdea(args.idea), theme), 0, 0);
    },

    renderResult(result, { expanded, isPartial }, theme) {
      if (isPartial) return new Text(theme.fg("dim", "Processing..."), 0, 0);
      return new Text(formatInitResult((result.details ?? {}) as Record<string, unknown>, expanded, theme), 0, 0);
    },
  });

  // ── /gigaplan-doctor command ──
  pi.registerCommand("gigaplan-doctor", {
    description: "Validate the active gigaplan and suggest or apply recoverable fixes",
    handler: async (args, ctx) => {
      try {
        const requested = (args ?? "").trim() || undefined;
        const result = diagnosePlan(ctx.cwd, requested, false);
        const selectedAction = await showDoctorOverlay(result, ctx);

        if (selectedAction === "fix") {
          const fixed = diagnosePlan(ctx.cwd, requested, true);
          syncActivePlan(ctx.cwd, ctx);
          updateWidget(ctx);
          ctx.ui.notify(fixed.fixes.length > 0 ? `Gigaplan doctor fixed ${fixed.fixes.length} issue(s)` : "Gigaplan doctor found nothing to fix", fixed.fixes.length > 0 ? "info" : "warning");
          pi.sendUserMessage([
            `Gigaplan doctor repaired **${fixed.state.name}**.`,
            fixed.fixes.length > 0 ? `Fixes: ${fixed.fixes.join(" · ")}` : "No automatic fixes applied.",
            fixed.nextStepConfig ? `Respawn: ${fixed.nextStep}` : "",
          ].filter(Boolean).join("\n"), { deliverAs: "steer" });
          return;
        }

        if (selectedAction === "respawn") {
          ctx.ui.notify(result.nextStepConfig ? `Use gigaplan_step or tool details to respawn ${result.nextStep}` : "No next-step config available", result.nextStepConfig ? "info" : "warning");
          pi.sendUserMessage([
            `Doctor summary for **${result.state.name}**`,
            result.issues.length > 0 ? result.issues.map((issue) => `- ${issue}`).join("\n") : "- No issues detected",
            result.nextStepConfig ? `Respawn next step: ${result.nextStep}` : "",
          ].filter(Boolean).join("\n"), { deliverAs: "steer" });
          return;
        }

        if (selectedAction === "abort") {
          result.state.current_state = STATE_ABORTED;
          result.state.history.push({ step: "override", timestamp: nowUtc(), message: "aborted via doctor" });
          savePlanState(result.planDir, result.state);
          syncActivePlan(ctx.cwd, ctx);
          updateWidget(ctx);
          ctx.ui.notify(`Plan \"${result.state.name}\" aborted`, "warning");
          return;
        }

        ctx.ui.notify(result.issues.length === 0 ? "Gigaplan doctor: no issues found" : "Gigaplan doctor found issues", result.issues.length === 0 ? "info" : "warning");
      } catch (e) {
        ctx.ui.notify(`Gigaplan doctor failed: ${e instanceof Error ? e.message : String(e)}`, "error");
      }
    },
  });

  // ── gigaplan_doctor tool ──
  pi.registerTool({
    name: "gigaplan_doctor",
    label: "Gigaplan Doctor",
    description: "Validate the current gigaplan, detect broken/missing artifacts, and optionally apply safe repairs for common JSON/output issues.",
    parameters: Type.Object({
      planName: Type.Optional(Type.String({ description: "Specific plan name (optional)" })),
      fix: Type.Optional(Type.Boolean({ description: "Apply safe repairs when possible" })),
    }),

    async execute(_id, params, _signal, _onUpdate, ctx) {
      try {
        const result = diagnosePlan(ctx.cwd, params.planName, params.fix ?? false);
        syncActivePlan(ctx.cwd, ctx);
        updateWidget(ctx);

        const lines = [
          `# Gigaplan Doctor`,
          `**Plan:** ${result.state.name}`,
          `**State:** ${result.state.current_state}`,
          `**Robustness:** ${result.state.config.robustness ?? "standard"}`,
          `**Next step:** ${result.nextStep ?? "done"}`,
          `**Issues:** ${result.issues.length}`,
        ];

        if (result.issues.length > 0) {
          lines.push("", "## Problems", ...result.issues.map((issue) => `- ${issue}`));
        }
        if (result.fixes.length > 0) {
          lines.push("", "## Fixes applied", ...result.fixes.map((item) => `- ${item}`));
        }
        if (result.nextStepConfig) {
          lines.push("", "## Recovery", `Next LLM step is **${result.nextStep}**.`, `Use the returned details to respawn that agent.`);
        }

        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: {
            planDir: result.planDir,
            planName: result.state.name,
            state: result.state.current_state,
            nextSteps: result.nextSteps,
            nextStep: result.nextStep,
            issues: result.issues,
            fixes: result.fixes,
            nextStepConfig: result.nextStepConfig,
            viewModel: buildViewModelForPlan(ctx.cwd, result.planDir, result.state, result.issues),
          },
        };
      } catch (e) {
        return {
          content: [{ type: "text", text: `Error running doctor: ${e instanceof Error ? e.message : String(e)}` }],
          details: { error: true, message: e instanceof Error ? e.message : String(e) } as any,
        };
      }
    },

    renderCall(args, theme) {
      const suffix = args.fix ? "--fix" : args.planName ?? "";
      return new Text(toolCallArg("gigaplan_doctor", suffix, theme), 0, 0);
    },

    renderResult(result, { expanded, isPartial }, theme) {
      if (isPartial) return new Text(theme.fg("dim", "Processing..."), 0, 0);
      return new Text(formatDoctorResult((result.details ?? {}) as Record<string, unknown>, expanded, theme), 0, 0);
    },
  });

  // ── gigaplan_step tool — get agent config for a step ──
  pi.registerTool({
    name: "gigaplan_step",
    label: "Gigaplan Step",
    description:
      "Get the agent configuration for a gigaplan step. Returns the task prompt, " +
      "agent name, and output path. Use this before spawning an agent for each step.",
    parameters: Type.Object({
      planDir: Type.String({ description: "Path to the plan directory (.gigaplan/plans/<name>)" }),
      step: Type.String({ description: "Step to run: clarify, plan, critique, integrate, execute, review" }),
    }),

    async execute(_id, params, _signal, _onUpdate, ctx) {
      try {
        const state = readJson(path.join(params.planDir, "state.json")) as PlanState;
        if (!LLM_STEPS.has(params.step)) {
          throw new GigaplanError("unsupported_step", `Unknown LLM step: ${params.step}`);
        }
        requireAllowedStep(state, params.step);
        const config = buildStepConfig(params.step, state, params.planDir);
        const root = ctx?.cwd ?? state.config.project_dir ?? process.cwd();
        syncActivePlan(root, ctx);
        updateWidget(ctx);

        return {
          content: [{
            type: "text",
            text: `Subagent config for step "${params.step}":\n\n` +
              `**Name:** ${config.name}\n` +
              `**Agent:** ${config.agent}\n` +
              `**Output path:** ${config.outputPath}\n` +
              `**Tools:** ${config.tools}\n\n` +
              `Spawn this via agent_group with the task below. ` +
              `After it completes, call gigaplan_advance with step="${params.step}".`,
          }],
          details: {
            step: params.step,
            name: config.name,
            agent: config.agent,
            task: config.task,
            model: config.model,
            tools: config.tools,
            outputPath: config.outputPath,
            interactive: false,
            viewModel: buildViewModelForPlan(root, params.planDir, state),
          },
        };
      } catch (e) {
        return {
          content: [{ type: "text", text: `Error: ${e instanceof Error ? e.message : String(e)}` }],
          details: { error: true, message: e instanceof Error ? e.message : String(e), step: params.step } as any,
        };
      }
    },

    renderCall(args, theme) {
      return new Text(toolCallArg("gigaplan_step", args.step, theme), 0, 0);
    },

    renderResult(result, { expanded, isPartial }, theme) {
      if (isPartial) return new Text(theme.fg("dim", "Processing..."), 0, 0);
      return new Text(formatStepResult((result.details ?? {}) as Record<string, unknown>, expanded, theme), 0, 0);
    },
  });

  // ── gigaplan_advance tool — process output and advance state ──
  pi.registerTool({
    name: "gigaplan_advance",
    label: "Gigaplan Advance",
    description:
      "Process a completed gigaplan step and advance the state machine. " +
      "For LLM steps (clarify, plan, critique, integrate, execute, review): reads the output file written by the agent. " +
      "For logic steps (evaluate, gate): runs the logic directly.",
    parameters: Type.Object({
      planDir: Type.String({ description: "Path to the plan directory" }),
      step: Type.String({ description: "Step that just completed" }),
      durationMs: Type.Optional(Type.Number({ description: "How long the step took in ms" })),
    }),

    async execute(_id, params, _signal, _onUpdate, ctx) {
      const widgetRoot = ctx?.cwd ?? process.cwd();
      try {
        const state = readJson(path.join(params.planDir, "state.json")) as PlanState;
        if (!LLM_STEPS.has(params.step) && !LOGIC_STEPS.has(params.step)) {
          throw new GigaplanError("unsupported_step", `Unknown step: ${params.step}`);
        }
        requireAllowedStep(state, params.step);

        let result: StepResult;
        let stepPayload: Record<string, unknown> = {};

        if (params.step === "evaluate") {
          result = runEvaluate(params.planDir, state);
        } else if (params.step === "gate") {
          result = runGate(params.planDir, state);
        } else {
          const outputPath = path.join(params.planDir, `${params.step}_output.json`);
          const payload = parseStepOutput(params.step, outputPath);
          stepPayload = payload;
          result = processStepOutput(
            params.step,
            params.planDir,
            state,
            payload,
            params.durationMs ?? 0,
          );
        }

        const persistedState = readJson(path.join(params.planDir, "state.json")) as PlanState;
        if (params.step === "evaluate") {
          stepPayload = { ...(persistedState.last_evaluation as Record<string, unknown>) };
        } else if (params.step === "gate") {
          try {
            stepPayload = readJson(path.join(params.planDir, "gate.json")) as Record<string, unknown>;
          } catch {
            stepPayload = {};
          }
        }
        syncActivePlan(widgetRoot, ctx);
        updateWidget(ctx);

        const stepDetails = buildStepMessageDetails(
          widgetRoot,
          params.planDir,
          persistedState,
          result,
          params.durationMs ?? null,
          undefined,
          stepPayload,
        );
        sendStepMessage(stepDetails);

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
            planDir: params.planDir,
            planName: persistedState.name,
            state: persistedState.current_state,
            viewModel: stepDetails.viewModel,
          },
        };
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        let recoveryDetails: Record<string, unknown> = { error: true, doctorSuggested: true, step: params.step, message };
        try {
          const fallbackState = readJson(path.join(params.planDir, "state.json")) as PlanState;
          const diagnosis = diagnosePlan(widgetRoot, fallbackState.name, false);
          recoveryDetails = {
            ...recoveryDetails,
            planDir: params.planDir,
            planName: fallbackState.name,
            state: fallbackState.current_state,
            issues: diagnosis.issues,
            recovery: buildViewModelForPlan(widgetRoot, params.planDir, fallbackState, diagnosis.issues).recovery,
          };
        } catch {
          // ignore secondary diagnosis failures
        }
        syncActivePlan(widgetRoot, ctx);
        updateWidget(ctx);
        return {
          content: [{
            type: "text",
            text: `Error advancing: ${message}\n\nRun \`gigaplan_doctor({ fix: true })\` to validate the plan, repair common JSON issues, and regenerate the next-step handoff.`,
          }],
          details: recoveryDetails as any,
        };
      }
    },

    renderCall(args, theme) {
      return new Text(toolCallArg("gigaplan_advance", args.step, theme), 0, 0);
    },

    renderResult(result, { expanded, isPartial }, theme) {
      if (isPartial) return new Text(theme.fg("dim", "Processing..."), 0, 0);
      return new Text(formatAdvanceResult((result.details ?? {}) as Record<string, unknown>, expanded, theme), 0, 0);
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
        syncActivePlan(root, ctx);
        updateWidget(ctx);

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
          details: {
            state,
            planDir,
            planName: state.name,
            viewModel: buildViewModelForPlan(root, planDir, state),
          },
        };
      }

      const focused = resolveFocusedPlan(root);
      syncActivePlan(root, ctx);
      updateWidget(ctx);

      const lines = dirs.map((d) => {
        const s = readJson(path.join(d, "state.json")) as PlanState;
        const next = inferNextSteps(s);
        return `• **${s.name}** [${s.current_state}] iter=${s.iteration} → ${next[0] ?? "done"}`;
      });

      return {
        content: [{ type: "text", text: `## Gigaplan Plans\n\n${lines.join("\n")}` }],
        details: {
          plans: dirs.map((d) => path.basename(d)),
          viewModel: focused ? buildViewModel(focused.planDir, focused.state, {
            totalPlans: focused.totalPlans,
            focusIndex: focused.focusIndex,
            alternates: focused.alternates,
          }) : undefined,
        },
      };
    },

    renderCall(args, theme) {
      return new Text(toolCallArg("gigaplan_status", args.planName ?? "", theme), 0, 0);
    },

    renderResult(result, { expanded, isPartial }, theme) {
      if (isPartial) return new Text(theme.fg("dim", "Processing..."), 0, 0);
      return new Text(formatStatusResult((result.details ?? {}) as Record<string, unknown>, expanded, theme), 0, 0);
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

    async execute(_id, params, _signal, _onUpdate, ctx) {
      try {
        const state = readJson(path.join(params.planDir, "state.json")) as PlanState;
        const root = ctx?.cwd ?? state.config.project_dir ?? process.cwd();

        switch (params.action) {
          case "add-note": {
            if (!params.note) {
              return { content: [{ type: "text", text: "Error: note text required for add-note" }], details: { error: true, action: params.action } };
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
            syncActivePlan(root, ctx);
            updateWidget(ctx);
            return {
              content: [{ type: "text", text: `Note added. Continue with the current step.` }],
              details: { action: params.action, planDir: params.planDir, viewModel: buildViewModelForPlan(root, params.planDir, state) },
            };
          }

          case "abort": {
            state.current_state = STATE_ABORTED;
            state.history.push({ step: "override", timestamp: nowUtc(), message: "aborted" });
            savePlanState(params.planDir, state);
            syncActivePlan(root, ctx);
            updateWidget(ctx);
            return {
              content: [{ type: "text", text: `Plan "${state.name}" aborted.` }],
              details: { action: params.action, planDir: params.planDir, viewModel: buildViewModelForPlan(root, params.planDir, state) },
            };
          }

          case "force-proceed": {
            requireState(state, STATE_EVALUATED);
            state.current_state = STATE_GATED;
            state.meta.user_approved_gate = true;
            state.history.push({
              step: "override",
              timestamp: nowUtc(),
              message: "force-proceed (bypassed gate)",
            });
            savePlanState(params.planDir, state);
            syncActivePlan(root, ctx);
            updateWidget(ctx);
            return {
              content: [{ type: "text", text: "Force-proceeded to gate. Next step: execute." }],
              details: { action: params.action, nextSteps: ["execute"], planDir: params.planDir, viewModel: buildViewModelForPlan(root, params.planDir, state) } as any,
            };
          }

          case "skip": {
            requireState(state, STATE_EVALUATED);
            state.last_evaluation = { recommendation: "SKIP" };
            state.current_state = STATE_EVALUATED;
            state.history.push({
              step: "override",
              timestamp: nowUtc(),
              message: "skip (user override to SKIP)",
            });
            savePlanState(params.planDir, state);
            syncActivePlan(root, ctx);
            updateWidget(ctx);
            return {
              content: [{ type: "text", text: "Skipped to gate. Next step: gate." }],
              details: { action: params.action, nextSteps: ["gate"], planDir: params.planDir, viewModel: buildViewModelForPlan(root, params.planDir, state) } as any,
            };
          }

          default:
            return {
              content: [{ type: "text", text: `Unknown action: ${params.action}. Use: add-note, abort, force-proceed, skip` }],
              details: { error: true, action: params.action },
            };
        }
      } catch (e) {
        return {
          content: [{ type: "text", text: `Error: ${e instanceof Error ? e.message : String(e)}` }],
          details: { error: true, action: params.action, message: e instanceof Error ? e.message : String(e) } as any,
        };
      }
    },

    renderCall(args, theme) {
      return new Text(toolCallArg("gigaplan_override", args.action, theme), 0, 0);
    },

    renderResult(result, { expanded, isPartial }, theme) {
      if (isPartial) return new Text(theme.fg("dim", "Processing..."), 0, 0);
      return new Text(formatOverrideResult((result.details ?? {}) as Record<string, unknown>, expanded, theme), 0, 0);
    },
  });
}
