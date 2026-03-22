/**
 * Evaluation logic: buildEvaluation(), decision table, predicates, and scoring.
 * Port of gigaplan/evaluation.py
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { PlanState, FlagRecord, FlagRegistry, EvaluationResult } from "./core.js";
import {
  FLAG_BLOCKING_STATUSES,
  ROBUSTNESS_SKIP_THRESHOLDS,
  ROBUSTNESS_STAGNATION_FACTORS,
  SCOPE_CREEP_TERMS,
  readJson,
  normalizeText,
  currentIterationArtifact,
  latestPlanPath,
  loadFlagRegistry,
  unresolvedSignificantFlags,
  isScopeCreepFlag,
  scopeCreepFlags,
  configuredRobustness,
} from "./core.js";

// ---------------------------------------------------------------------------
// flagWeight
// ---------------------------------------------------------------------------

export function flagWeight(flag: FlagRecord): number {
  const category = flag.category ?? "other";
  const concern = (flag.concern ?? "").toLowerCase();

  if (category === "security") return 3.0;

  const implementationDetailSignals = [
    "column", "schema", "field", "as written",
    "pseudocode", "seed sql", "placeholder",
  ];
  if (implementationDetailSignals.some((s) => concern.includes(s))) return 0.5;

  const weights: Record<string, number> = {
    correctness: 2.0,
    completeness: 1.5,
    performance: 1.0,
    maintainability: 0.75,
    other: 1.0,
  };
  return weights[category] ?? 1.0;
}

// ---------------------------------------------------------------------------
// computePlanDeltaPercent — simple line-diff ratio
// ---------------------------------------------------------------------------

export function computePlanDeltaPercent(
  previousText: string | null,
  currentText: string,
): number | null {
  if (previousText === null) return null;
  // Simple character-level similarity ratio (like SequenceMatcher)
  const longer = Math.max(previousText.length, currentText.length);
  if (longer === 0) return 0;
  const distance = levenshteinDistance(previousText, currentText);
  const ratio = 1.0 - distance / longer;
  return Math.round((1.0 - ratio) * 100.0 * 100) / 100;
}

/** Compute Levenshtein distance between two strings (character level). */
function levenshteinDistance(a: string, b: string): number {
  // Use a memory-efficient two-row approach
  const m = a.length;
  const n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let curr = new Array<number>(n + 1);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      curr[j] =
        a[i - 1] === b[j - 1]
          ? prev[j - 1]
          : 1 + Math.min(prev[j - 1], prev[j], curr[j - 1]);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

// ---------------------------------------------------------------------------
// computeRecurringCritiques
// ---------------------------------------------------------------------------

export function computeRecurringCritiques(planDir: string, iteration: number): string[] {
  if (iteration < 2) return [];
  const prev = readJson(currentIterationArtifact(planDir, "critique", iteration - 1)) as {
    flags?: Array<{ concern?: string }>;
  };
  const curr = readJson(currentIterationArtifact(planDir, "critique", iteration)) as {
    flags?: Array<{ concern?: string }>;
  };
  const prevConcerns = new Set((prev.flags ?? []).map((f) => normalizeText(f.concern ?? "")));
  const currConcerns = new Set((curr.flags ?? []).map((f) => normalizeText(f.concern ?? "")));
  const recurring: string[] = [];
  for (const c of prevConcerns) {
    if (currConcerns.has(c)) recurring.push(c);
  }
  return recurring.sort();
}

// ---------------------------------------------------------------------------
// Predicate functions for the decision table
// ---------------------------------------------------------------------------

interface Signals {
  iteration: number;
  unresolved: FlagRecord[];
  significant_count: number;
  weighted_score: number;
  weighted_history: number[];
  plan_delta: number | null;
  recurring: string[];
  total_cost: number;
  budget: number;
  skip_threshold: number;
  stagnation_factor: number;
  state: PlanState;
}

function isOverBudget({ total_cost, budget }: Signals): boolean {
  return total_cost > budget;
}

function isAllFlagsResolved({ significant_count, unresolved }: Signals): boolean {
  return significant_count === 0 && unresolved.length === 0;
}

function isLowWeightTrendingDown({
  iteration,
  weighted_score,
  skip_threshold,
  weighted_history,
}: Signals): boolean {
  return (
    iteration > 1 &&
    weighted_score < skip_threshold &&
    weighted_history.length >= 1 &&
    weighted_score < weighted_history[weighted_history.length - 1]
  );
}

function isStagnantWithUnresolved({ plan_delta, unresolved }: Signals): boolean {
  return plan_delta !== null && plan_delta < 5.0 && unresolved.length > 0;
}

function isStagnantAllAddressed({ plan_delta, unresolved }: Signals): boolean {
  return plan_delta !== null && plan_delta < 5.0 && unresolved.length === 0;
}

function isFirstIterationWithFlags({ iteration, significant_count }: Signals): boolean {
  return iteration === 1 && significant_count > 0;
}

function hasRecurringCritiques({ recurring }: Signals): boolean {
  return recurring.length > 0;
}

function isScoreStagnating({ weighted_score, weighted_history, stagnation_factor }: Signals): boolean {
  return (
    weighted_history.length >= 1 &&
    weighted_score >= weighted_history[weighted_history.length - 1] * stagnation_factor
  );
}

function isScoreImproving({ weighted_score, weighted_history, stagnation_factor }: Signals): boolean {
  return (
    weighted_history.length >= 1 &&
    weighted_score < weighted_history[weighted_history.length - 1] * stagnation_factor
  );
}

function isMaxIterationsWithUnresolved({ iteration, state, unresolved }: Signals): boolean {
  return iteration >= (state.config.max_iterations ?? 3) && unresolved.length > 0;
}

// ---------------------------------------------------------------------------
// Decision table
// ---------------------------------------------------------------------------

type RationaleFn = (s: Signals) => string;

interface DecisionEntry {
  predicate: (s: Signals) => boolean;
  recommendation: string;
  confidence: string;
  rationale: string | RationaleFn;
}

const EVALUATION_DECISION_TABLE: DecisionEntry[] = [
  {
    predicate: isOverBudget,
    recommendation: "ABORT",
    confidence: "high",
    rationale: (s) =>
      `Cost $${s.total_cost.toFixed(3)} exceeded configured budget $${s.budget.toFixed(3)}.`,
  },
  {
    predicate: isAllFlagsResolved,
    recommendation: "SKIP",
    confidence: "high",
    rationale: "No unresolved significant flags remain.",
  },
  {
    predicate: isLowWeightTrendingDown,
    recommendation: "SKIP",
    confidence: "medium",
    rationale: (s) =>
      `Remaining flags are low-weight (${s.weighted_score}) and trending down. Executor can resolve.`,
  },
  {
    predicate: isStagnantWithUnresolved,
    recommendation: "ESCALATE",
    confidence: "high",
    rationale: "Plan stagnated with unresolved significant risks.",
  },
  {
    predicate: isStagnantAllAddressed,
    recommendation: "SKIP",
    confidence: "high",
    rationale: "Plan changes are small and all significant risks appear addressed.",
  },
  {
    predicate: isFirstIterationWithFlags,
    recommendation: "CONTINUE",
    confidence: "high",
    rationale: (s) => `First iteration still has ${s.significant_count} significant flags.`,
  },
  {
    predicate: hasRecurringCritiques,
    recommendation: "ESCALATE",
    confidence: "high",
    rationale: "The same critique concerns repeated across iterations.",
  },
  {
    predicate: isScoreStagnating,
    recommendation: "ESCALATE",
    confidence: "medium",
    rationale: "Weighted flag score is not improving.",
  },
  {
    predicate: isScoreImproving,
    recommendation: "CONTINUE",
    confidence: "medium",
    rationale: "Weighted flag score is trending down.",
  },
  {
    predicate: isMaxIterationsWithUnresolved,
    recommendation: "ESCALATE",
    confidence: "high",
    rationale: "Reached max iterations with unresolved significant risks.",
  },
];

// ---------------------------------------------------------------------------
// buildEvaluation
// ---------------------------------------------------------------------------

export function buildEvaluation(planDir: string, state: PlanState): EvaluationResult {
  const iteration = state.iteration;
  const flagRegistry = loadFlagRegistry(planDir);
  const unresolved = unresolvedSignificantFlags(flagRegistry);
  const robustness = configuredRobustness(state);
  const skipThreshold = ROBUSTNESS_SKIP_THRESHOLDS[robustness] ?? 2.0;
  const stagnationFactor = ROBUSTNESS_STAGNATION_FACTORS[robustness] ?? 0.9;
  const openScopeCreep = scopeCreepFlags(flagRegistry, { statuses: FLAG_BLOCKING_STATUSES });
  const significantCount = flagRegistry.flags.filter(
    (f) => f.severity === "significant" && f.status !== "verified",
  ).length;
  const weightedScore =
    Math.round(unresolved.reduce((sum, f) => sum + flagWeight(f), 0) * 100) / 100;
  const weightedHistory: number[] = (state.meta.weighted_scores as number[] | undefined) ?? [];

  const latestPlanText = fs.readFileSync(latestPlanPath(planDir, state), "utf-8");
  let previousText: string | null = null;
  if (iteration > 1) {
    previousText = fs.readFileSync(
      path.join(planDir, `plan_v${iteration - 1}.md`),
      "utf-8",
    );
  }

  const planDelta = computePlanDeltaPercent(previousText, latestPlanText);
  const recurring = computeRecurringCritiques(planDir, iteration);
  const budget = parseFloat(String(state.config.budget_usd ?? 25.0));
  const totalCost = parseFloat(String(state.meta.total_cost_usd ?? 0.0));

  const signals: Signals = {
    iteration,
    unresolved,
    significant_count: significantCount,
    weighted_score: weightedScore,
    weighted_history: weightedHistory,
    plan_delta: planDelta,
    recurring,
    total_cost: totalCost,
    budget,
    skip_threshold: skipThreshold,
    stagnation_factor: stagnationFactor,
    state,
  };

  // Walk the decision table — first matching predicate wins.
  let recommendation = "CONTINUE";
  let confidence = "medium";
  let rationale = "Continue refining the plan.";

  for (const entry of EVALUATION_DECISION_TABLE) {
    if (entry.predicate(signals)) {
      recommendation = entry.recommendation;
      confidence = entry.confidence;
      rationale =
        typeof entry.rationale === "function" ? entry.rationale(signals) : entry.rationale;
      break;
    }
  }

  const validNext =
    recommendation === "CONTINUE"
      ? ["integrate"]
      : recommendation === "SKIP"
        ? ["gate"]
        : ["override add-note", "override force-proceed", "override abort"];

  const result: EvaluationResult = {
    recommendation,
    confidence,
    robustness,
    signals: {
      iteration,
      max_iterations: state.config.max_iterations,
      significant_flags: significantCount,
      weighted_score: weightedScore,
      weighted_history: weightedHistory,
      plan_delta_from_previous: planDelta,
      recurring_critiques: recurring,
      cost_so_far_usd: totalCost,
      scope_creep_flags: openScopeCreep.map((f) => f.id),
    },
    rationale,
    valid_next_steps: validNext,
  };

  if (openScopeCreep.length > 0) {
    result.warnings = [
      "Scope creep detected: the plan appears to be expanding beyond the original idea or recorded user notes.",
    ];
  }

  if (recommendation === "ESCALATE" || recommendation === "ABORT") {
    if (recommendation === "ABORT") {
      result.suggested_override = "abort";
      result.override_rationale = "Budget exceeded. Abort or increase budget.";
    } else if (unresolved.every((f) => flagWeight(f) <= 1.0)) {
      result.suggested_override = "force-proceed";
      result.override_rationale =
        "Remaining flags are implementation details (pseudocode accuracy, " +
        "schema column names) that the executor will resolve by reading " +
        "the actual code. Safe to proceed.";
    } else if (
      weightedHistory.length >= 1 &&
      weightedScore > weightedHistory[weightedHistory.length - 1] * 1.5
    ) {
      result.suggested_override = "abort";
      result.override_rationale =
        "Weighted flag score is increasing — the plan may be fundamentally misaligned.";
    } else {
      result.suggested_override = "add-note";
      result.override_rationale =
        "Significant flags remain. Add context to help the next iteration, " +
        "or force-proceed if you believe the executor can handle them.";
    }
  }

  return result;
}
