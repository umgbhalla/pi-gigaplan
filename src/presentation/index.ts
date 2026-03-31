import type { Theme, ThemeColor } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  type EvaluationResult,
  type FlagRecord,
  type PlanState,
  FLAG_BLOCKING_STATUSES,
  STATE_ABORTED,
  STATE_CLARIFIED,
  STATE_CRITIQUED,
  STATE_DONE,
  STATE_EVALUATED,
  STATE_EXECUTED,
  STATE_GATED,
  STATE_INITIALIZED,
  STATE_PLANNED,
  TERMINAL_STATES,
  activePlanDirs,
  loadFlagRegistry,
  plansRoot,
  readJson,
  resolvePlanDir,
  scopeCreepFlags,
  unresolvedSignificantFlags,
} from "../core.js";

export interface IterationRow {
  version: number;
  recommendation: string;
  recColor: ThemeColor;
  confidence: string;
  score: string;
  scoreColor: ThemeColor;
  sigFlags: string;
  sigColor: ThemeColor;
  delta: string;
  deltaColor: ThemeColor;
  raisedFlags: number;
  verifiedFlags: number;
  addressedFlags: number;
}

export interface RecoveryInfo {
  failedStep: string | null;
  issue: string;
  file: string | null;
  autoFixAvailable: boolean;
  suggestedAction: string;
}

export interface GigaplanViewModel {
  name: string;
  planDir: string;
  totalPlans: number;
  focusIndex: number;
  alternates: string[];
  state: string;
  stateColor: ThemeColor;
  nextStep: string | null;
  iteration: number;
  totalFlags: number;
  verifiedFlags: number;
  openSignificant: number;
  openMinor: number;
  addressedFlags: number;
  recommendation: string | null;
  recColor: ThemeColor;
  confidence: string | null;
  weightedScore: number | null;
  prevScore: number | null;
  scoreTrend: string | null;
  scoreDelta: string | null;
  deltaColor: ThemeColor;
  stepHistory: string[];
  lastStepDuration: number | null;
  iterations: IterationRow[];
  recovery: RecoveryInfo | null;
}

export interface FocusedPlanResolution {
  planDir: string;
  state: PlanState;
  totalPlans: number;
  focusIndex: number;
  alternates: string[];
}

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
      const rec = (state.last_evaluation as Record<string, unknown>)?.recommendation as string | undefined;
      if (rec === "CONTINUE") return ["integrate"];
      if (rec === "SKIP") return ["gate"];
      if (rec === "ABORT") return ["abort"];
      return ["override"];
    }
    case STATE_GATED: return ["execute"];
    case STATE_EXECUTED: return ["review"];
    default: return [];
  }
}

function stateColor(state: string): ThemeColor {
  if (state === STATE_ABORTED) return "error";
  if (state === STATE_GATED || state === STATE_EXECUTED || state === STATE_DONE) return "success";
  if (state === STATE_CRITIQUED || state === STATE_EVALUATED) return "warning";
  return "accent";
}

function recommendationColor(recommendation?: string | null): ThemeColor {
  if (recommendation === "SKIP") return "success";
  if (recommendation === "ABORT") return "error";
  if (recommendation === "ESCALATE") return "warning";
  return "warning";
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function fixed(value: number | null): string {
  if (value === null) return "—";
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function deltaPercent(prev: number | null, curr: number | null): { trend: string | null; delta: string | null; color: ThemeColor } {
  if (prev === null || curr === null || prev === 0) {
    return { trend: null, delta: null, color: "muted" };
  }
  const change = ((curr - prev) / prev) * 100;
  if (Math.abs(change) < 0.5) {
    return { trend: "→", delta: "→0%", color: "muted" };
  }
  if (change < 0) {
    return { trend: "↓", delta: `↓${Math.round(Math.abs(change))}%`, color: "success" };
  }
  return { trend: "↑", delta: `↑${Math.round(Math.abs(change))}%`, color: "error" };
}

function padRight(text: string, width: number): string {
  const padding = Math.max(0, width - visibleWidth(text));
  return text + " ".repeat(padding);
}

function updatedAt(state: PlanState): string {
  const history = state.history[state.history.length - 1]?.timestamp;
  return history ?? state.created_at;
}

function readEvaluation(planDir: string, version: number): EvaluationResult | null {
  const evaluationFile = path.join(planDir, `evaluation_v${version}.json`);
  if (!fs.existsSync(evaluationFile)) return null;
  return readJson(evaluationFile) as EvaluationResult;
}

function readCritiqueCounts(planDir: string, version: number): { raised: number; verified: number } {
  const critiqueFile = path.join(planDir, `critique_v${version}.json`);
  if (!fs.existsSync(critiqueFile)) return { raised: 0, verified: 0 };
  const critique = readJson(critiqueFile) as Record<string, unknown>;
  return {
    raised: Array.isArray(critique.flags) ? critique.flags.length : 0,
    verified: Array.isArray(critique.verified_flag_ids) ? critique.verified_flag_ids.length : 0,
  };
}

function readAddressedCount(planDir: string, version: number): number {
  const metaFile = path.join(planDir, `plan_v${version}.meta.json`);
  if (!fs.existsSync(metaFile)) return 0;
  const meta = readJson(metaFile) as Record<string, unknown>;
  return Array.isArray(meta.flags_addressed) ? meta.flags_addressed.length : 0;
}

function buildIterationRows(planDir: string, state: PlanState): IterationRow[] {
  const rows: IterationRow[] = [];
  let previousScore: number | null = null;

  for (let version = 1; version <= state.iteration; version += 1) {
    const evaluation = readEvaluation(planDir, version);
    if (!evaluation) continue;
    const signals = (evaluation.signals ?? {}) as Record<string, unknown>;
    const score = numberOrNull(signals.weighted_score);
    const sigFlags = numberOrNull(signals.significant_flags) ?? 0;
    const delta = deltaPercent(previousScore, score);
    const critiqueCounts = readCritiqueCounts(planDir, version);

    rows.push({
      version,
      recommendation: evaluation.recommendation ?? "—",
      recColor: recommendationColor(evaluation.recommendation),
      confidence: evaluation.confidence ?? "—",
      score: fixed(score),
      scoreColor: score === null ? "muted" : score > 0 ? "warning" : "success",
      sigFlags: sigFlags === 0 ? "0 open" : `${sigFlags} open`,
      sigColor: sigFlags === 0 ? "success" : "warning",
      delta: delta.delta ?? "—",
      deltaColor: delta.color,
      raisedFlags: critiqueCounts.raised,
      verifiedFlags: critiqueCounts.verified,
      addressedFlags: readAddressedCount(planDir, version),
    });

    previousScore = score;
  }

  return rows;
}

function buildRecoveryInfo(planDir: string, state: PlanState, issues: string[] = []): RecoveryInfo | null {
  const nextStep = inferNextSteps(state)[0] ?? null;
  const nextHistory = [...state.history].reverse().find((entry) => entry.result === "failed");
  const nextOutputFile = nextStep ? `${nextStep}_output.json` : null;
  const outputPath = nextOutputFile ? path.join(planDir, nextOutputFile) : null;
  const hasOutput = outputPath ? fs.existsSync(outputPath) : false;

  if (issues.length > 0) {
    return {
      failedStep: nextHistory?.step ?? nextStep,
      issue: issues[0],
      file: nextOutputFile,
      autoFixAvailable: issues.some((issue) => /json|output/i.test(issue)) && hasOutput,
      suggestedAction: issues.some((issue) => /json|output/i.test(issue)) ? "Fix JSON" : "Respawn agent",
    };
  }

  if (hasOutput) {
    return {
      failedStep: nextStep,
      issue: `${nextOutputFile} present for next step`,
      file: nextOutputFile,
      autoFixAvailable: true,
      suggestedAction: "Fix JSON",
    };
  }

  return null;
}

export function resolveFocusedPlan(root: string, requestedPlanName?: string | null): FocusedPlanResolution | null {
  const planDirs = activePlanDirs(root);
  if (planDirs.length === 0) return null;

  if (requestedPlanName) {
    const planDir = resolvePlanDir(root, requestedPlanName);
    const state = readJson(path.join(planDir, "state.json")) as PlanState;
    const candidates = planDirs
      .map((dir) => ({ dir, state: readJson(path.join(dir, "state.json")) as PlanState }))
      .filter(({ state: candidateState }) => !TERMINAL_STATES.has(candidateState.current_state));
    return {
      planDir,
      state,
      totalPlans: candidates.length > 0 ? candidates.length : planDirs.length,
      focusIndex: 1,
      alternates: candidates.map(({ state: candidateState }) => candidateState.name).filter((name) => name !== state.name),
    };
  }

  const candidates = planDirs
    .map((dir) => ({ dir, state: readJson(path.join(dir, "state.json")) as PlanState }))
    .filter(({ state }) => !TERMINAL_STATES.has(state.current_state));
  const pool = candidates.length > 0 ? candidates : planDirs.map((dir) => ({ dir, state: readJson(path.join(dir, "state.json")) as PlanState }));

  pool.sort((a, b) => {
    const timeCompare = updatedAt(b.state).localeCompare(updatedAt(a.state));
    if (timeCompare !== 0) return timeCompare;
    return a.state.name.localeCompare(b.state.name);
  });

  const focused = pool[0];
  return {
    planDir: focused.dir,
    state: focused.state,
    totalPlans: pool.length,
    focusIndex: 1,
    alternates: pool.slice(1).map(({ state }) => state.name),
  };
}

export function buildViewModel(
  planDir: string,
  state: PlanState,
  options: { totalPlans?: number; focusIndex?: number; alternates?: string[]; issues?: string[] } = {},
): GigaplanViewModel {
  const registry = loadFlagRegistry(planDir);
  const unresolved = unresolvedSignificantFlags(registry);
  const openFlags = registry.flags.filter((flag) => FLAG_BLOCKING_STATUSES.has(flag.status ?? ""));
  const verifiedFlags = registry.flags.filter((flag) => flag.status === "verified").length;
  const addressedFlags = registry.flags.filter((flag) => flag.status === "addressed").length;
  const openMinor = openFlags.filter((flag) => flag.severity !== "significant").length;
  const evaluation = (state.last_evaluation ?? {}) as Record<string, unknown>;
  const recommendation = typeof evaluation.recommendation === "string" ? evaluation.recommendation : null;
  const confidence = typeof evaluation.confidence === "string" ? evaluation.confidence : null;
  const signals = (evaluation.signals ?? {}) as Record<string, unknown>;
  const scoreHistory = Array.isArray(state.meta.weighted_scores)
    ? state.meta.weighted_scores.map((value) => numberOrNull(value)).filter((value): value is number => value !== null)
    : [];
  const weightedScore = numberOrNull(signals.weighted_score) ?? scoreHistory.at(-1) ?? null;
  const prevScore = scoreHistory.length >= 2 ? scoreHistory.at(-2) ?? null : null;
  const delta = deltaPercent(prevScore, weightedScore);
  const iterations = buildIterationRows(planDir, state);
  const nextStep = inferNextSteps(state)[0] ?? null;

  return {
    name: state.name,
    planDir,
    totalPlans: options.totalPlans ?? 1,
    focusIndex: options.focusIndex ?? 1,
    alternates: options.alternates ?? [],
    state: state.current_state,
    stateColor: stateColor(state.current_state),
    nextStep,
    iteration: state.iteration,
    totalFlags: registry.flags.length,
    verifiedFlags,
    openSignificant: unresolved.length,
    openMinor,
    addressedFlags,
    recommendation,
    recColor: recommendationColor(recommendation),
    confidence,
    weightedScore,
    prevScore,
    scoreTrend: delta.trend,
    scoreDelta: delta.delta,
    deltaColor: delta.color,
    stepHistory: state.history.map((entry) => entry.step ?? "?").filter(Boolean),
    lastStepDuration: state.history.at(-1)?.duration_ms ?? null,
    iterations,
    recovery: buildRecoveryInfo(planDir, state, options.issues),
  };
}

function styledState(vm: GigaplanViewModel, theme: Theme): string {
  return theme.fg(vm.stateColor, vm.state);
}

function styledRecommendation(vm: GigaplanViewModel, theme: Theme): string {
  if (!vm.recommendation) return theme.fg("muted", "—");
  const text = vm.recommendation === "ESCALATE" ? theme.bold(vm.recommendation) : vm.recommendation;
  return theme.fg(vm.recColor, text);
}

export function buildStatusText(vm: GigaplanViewModel, theme?: Theme, width = 120): string {
  const stateText = theme ? styledState(vm, theme) : vm.state;
  const nextText = theme ? theme.fg("accent", vm.nextStep ?? "done") : (vm.nextStep ?? "done");
  const label = theme ? theme.bold(vm.name) : vm.name;
  const separator = theme ? theme.fg("dim", " → ") : " → ";
  let text = `${label} ${stateText}${separator}${nextText}`;

  if (width >= 100) {
    const flagSummary = `${vm.verifiedFlags}✓ ${vm.openSignificant + vm.openMinor}!`;
    const dim = (value: string) => theme ? theme.fg("dim", value) : value;
    const val = (value: string) => theme ? theme.fg("text", value) : value;
    text += `${dim("  iter:")}${val(String(vm.iteration))}`;
    text += `  ${dim("flags ")}${theme ? theme.fg("success", `${vm.verifiedFlags}✓`) : `${vm.verifiedFlags}✓`} ${theme ? theme.fg("warning", `${vm.openSignificant + vm.openMinor}!`) : `${vm.openSignificant + vm.openMinor}!`}`;
    if (vm.recommendation) {
      text += `  ${dim("eval ")}${theme ? styledRecommendation(vm, theme) : vm.recommendation}`;
    }
  }

  return text;
}

export function buildWidgetLines(vm: GigaplanViewModel, theme: Theme, width: number): string[] {
  const lines: string[] = [];
  let line1 = `${theme.fg("accent", "◆")} ${theme.bold(vm.name)}`;
  line1 += `  ${theme.fg(vm.stateColor, vm.state)}`;
  line1 += `${theme.fg("dim", " → ")}${theme.fg("accent", vm.nextStep ?? "done")}`;
  line1 += `  ${theme.fg("dim", "iter ")}${theme.fg("text", String(vm.iteration))}`;
  if (vm.totalPlans > 1) {
    line1 += `  ${theme.fg("muted", `(${vm.focusIndex} of ${vm.totalPlans} plans)` )}`;
  }
  lines.push(truncateToWidth(line1, width));

  if (width < 100) return lines;

  let line2 = `  ${theme.fg("dim", "flags ")}${theme.fg("success", `${vm.verifiedFlags}✓`)}`;
  line2 += ` ${theme.fg("warning", `${vm.openSignificant + vm.openMinor}!`)}`;

  if (vm.recommendation) {
    line2 += `  ${theme.fg("dim", "eval ")}${styledRecommendation(vm, theme)}`;
    if (vm.confidence) {
      line2 += ` ${theme.fg("muted", vm.confidence)}`;
    }
  }

  if (width >= 120 && vm.weightedScore !== null) {
    const scoreText = vm.prevScore !== null ? `${fixed(vm.prevScore)}→${fixed(vm.weightedScore)}` : fixed(vm.weightedScore);
    line2 += `  ${theme.fg("dim", "score ")}${theme.fg("text", scoreText)}`;
    if (vm.scoreDelta) {
      line2 += `  ${theme.fg("dim", "delta ")}${theme.fg(vm.deltaColor, vm.scoreDelta)}`;
    }
  }

  lines.push(truncateToWidth(line2, width));
  return lines;
}

export function formatInitResult(details: Record<string, unknown>, expanded: boolean, theme: Theme): string {
  if (details.error) return theme.fg("error", "✗ init");
  const vm = details.viewModel as GigaplanViewModel | undefined;
  const planName = (details.planName as string | undefined) ?? vm?.name ?? "plan";
  const collapsed = `${theme.fg("success", "✓")} ${theme.fg("text", planName)}${theme.fg("dim", " · ")}${theme.fg("accent", "created")}`;
  if (!expanded) return collapsed;
  let text = collapsed;
  text += `\n  ${theme.fg("dim", "next   ")}${theme.fg("accent", (details.nextStep as string | undefined) ?? vm?.nextStep ?? "clarify")}`;
  text += `\n  ${theme.fg("dim", "prompt ")}${theme.fg((details.promptQueued as boolean | undefined) ? "success" : "muted", (details.promptQueued as boolean | undefined) ? "queued" : "not queued")}`;
  if (typeof details.robustness === "string") {
    text += `\n  ${theme.fg("dim", "mode   ")}${theme.fg("text", details.robustness)}`;
  }
  return text;
}

export function formatAdvanceResult(details: Record<string, unknown>, expanded: boolean, theme: Theme): string {
  if (details.error) {
    const message = typeof details.message === "string" ? details.message : "advance failed";
    let text = `${theme.fg("error", "✗")} ${theme.fg("text", (details.step as string | undefined) ?? "advance")}${theme.fg("dim", " · ")}${theme.fg("error", message)}`;
    const recovery = details.recovery as RecoveryInfo | undefined;
    if (expanded && recovery) {
      text += `\n  ${theme.fg("dim", "file   ")}${theme.fg("text", recovery.file ?? "—")}`;
      text += `\n  ${theme.fg("dim", "fix    ")}${theme.fg(recovery.autoFixAvailable ? "success" : "warning", recovery.suggestedAction)}`;
    }
    return text;
  }

  const vm = details.viewModel as GigaplanViewModel | undefined;
  const success = details.success !== false;
  const step = (details.step as string | undefined) ?? vm?.nextStep ?? "step";
  let metric = theme.fg("muted", (details.summary as string | undefined) ?? (vm?.nextStep ?? "updated"));
  if (step === "evaluate" && vm?.recommendation) {
    metric = `${theme.fg("dim", "→ ")}${styledRecommendation(vm, theme)} ${theme.fg("muted", vm.confidence ?? "")}`.trimEnd();
  } else if (step === "gate") {
    metric = theme.fg(success ? "success" : "error", success ? "passed" : "failed");
  }
  const collapsed = `${theme.fg(success ? "success" : "error", success ? "✓" : "✗")} ${theme.fg("text", step)}${theme.fg("dim", " · ")}${metric}`;
  if (!expanded) return collapsed;

  let text = collapsed;
  if (vm) {
    text += `\n  ${theme.fg("dim", "flags  ")}${theme.fg("warning", `${vm.openSignificant} significant open`)}${theme.fg("dim", " · ")}${theme.fg("success", `${vm.verifiedFlags} verified`)}`;
    if (vm.recommendation) {
      text += `\n  ${theme.fg("dim", "eval   ")}${styledRecommendation(vm, theme)} ${theme.fg("muted", vm.confidence ?? "")}`.trimEnd();
    }
    if (vm.weightedScore !== null) {
      const scoreText = vm.prevScore !== null ? `${fixed(vm.prevScore)} → ${fixed(vm.weightedScore)}` : fixed(vm.weightedScore);
      text += `\n  ${theme.fg("dim", "score  ")}${theme.fg("text", scoreText)}`;
      if (vm.scoreDelta) {
        text += ` ${theme.fg(vm.deltaColor, `(${vm.scoreDelta})`)}`;
      }
    }
    text += `\n  ${theme.fg("dim", "next   ")}${theme.fg("accent", vm.nextStep ?? "done")}`;
  }
  return text;
}

export function formatStatusResult(details: Record<string, unknown>, expanded: boolean, theme: Theme): string {
  const vm = details.viewModel as GigaplanViewModel | undefined;
  if (!vm) {
    if (Array.isArray(details.plans) && details.plans.length > 0) {
      return theme.fg("text", `${details.plans.length} plan(s)`);
    }
    return theme.fg("muted", "No plan state");
  }

  const collapsed = `${theme.fg("text", vm.name)} ${theme.fg(vm.stateColor, vm.state)}${theme.fg("dim", " → ")}${theme.fg("accent", vm.nextStep ?? "done")}`;
  if (!expanded) return collapsed;

  let text = `${theme.bold(vm.name)}  ${theme.fg(vm.stateColor, vm.state)}${theme.fg("dim", " → ")}${theme.fg("accent", vm.nextStep ?? "done")}  ${theme.fg("dim", "iter ")}${theme.fg("text", String(vm.iteration))}`;
  text += `\n  ${theme.fg("dim", "flags   ")}${theme.fg("text", String(vm.totalFlags))} total${theme.fg("dim", " · ")}${theme.fg("success", `${vm.verifiedFlags}✓`)}${theme.fg("dim", " · ")}${theme.fg("warning", `${vm.openSignificant + vm.openMinor}!`)}${theme.fg("dim", " · ")}${theme.fg("muted", `${vm.addressedFlags} addressed`)}`;
  if (vm.recommendation) {
    text += `\n  ${theme.fg("dim", "eval    ")}${styledRecommendation(vm, theme)}${theme.fg("dim", " · ")}${theme.fg("muted", vm.confidence ?? "—")}`;
    if (vm.weightedScore !== null) {
      text += `${theme.fg("dim", " · score ")}${theme.fg("text", fixed(vm.weightedScore))}`;
    }
  }
  if (vm.stepHistory.length > 0) {
    text += `\n  ${theme.fg("dim", "history ")}${theme.fg("muted", vm.stepHistory.join(" → "))}`;
  }

  if (vm.iterations.length > 1) {
    text += `\n\n  ${theme.fg("dim", padRight("iter", 6))}${theme.fg("dim", padRight("recommendation", 16))}${theme.fg("dim", padRight("confidence", 12))}${theme.fg("dim", padRight("score", 8))}${theme.fg("dim", padRight("significant", 14))}${theme.fg("dim", "delta")}`;
    for (const row of vm.iterations) {
      text += `\n  ${theme.fg("text", padRight(`v${row.version}`, 6))}${theme.fg(row.recColor, padRight(row.recommendation, 16))}${theme.fg("muted", padRight(row.confidence, 12))}${theme.fg(row.scoreColor, padRight(row.score, 8))}${theme.fg(row.sigColor, padRight(row.sigFlags, 14))}${theme.fg(row.deltaColor, row.delta)}`;
    }
    const latest = vm.iterations.at(-1);
    if (latest) {
      text += `\n\n  ${theme.fg("muted", `latest  ${latest.verifiedFlags} verified · ${latest.raisedFlags} raised · ${latest.addressedFlags} addressed`)}`;
    }
  }

  if (vm.totalPlans > 1) {
    text += `\n  ${theme.fg("muted", `focused ${vm.focusIndex} of ${vm.totalPlans} active plans`)}`;
  }

  return text;
}

export function formatStepResult(details: Record<string, unknown>, expanded: boolean, theme: Theme): string {
  if (details.error) return theme.fg("error", "✗ step");
  const step = (details.step as string | undefined) ?? "step";
  const agent = (details.agent as string | undefined) ?? "agent";
  const collapsed = `${theme.fg("success", "✓")} ${theme.fg("text", step)}${theme.fg("dim", " · ")}${theme.fg("muted", agent)}`;
  if (!expanded) return collapsed;
  let text = collapsed;
  text += `\n  ${theme.fg("dim", "agent  ")}${theme.fg("text", agent)}`;
  if (typeof details.model === "string") {
    text += `\n  ${theme.fg("dim", "model  ")}${theme.fg("muted", details.model)}`;
  }
  if (typeof details.outputPath === "string") {
    text += `\n  ${theme.fg("dim", "output ")}${theme.fg("accent", details.outputPath)}`;
  }
  return text;
}

export function formatDoctorResult(details: Record<string, unknown>, expanded: boolean, theme: Theme): string {
  if (details.error) return theme.fg("error", "✗ doctor");
  const issues = Array.isArray(details.issues) ? details.issues as string[] : [];
  const fixes = Array.isArray(details.fixes) ? details.fixes as string[] : [];
  const issueColor: ThemeColor = issues.length > 0 ? "warning" : "success";
  const collapsed = `${theme.fg(issueColor, issues.length > 0 ? `${issues.length} issues` : "clean")}${fixes.length > 0 ? theme.fg("success", ` · ${fixes.length} fixed`) : ""}`;
  if (!expanded) return collapsed;
  let text = collapsed;
  const vm = details.viewModel as GigaplanViewModel | undefined;
  if (vm) {
    text = `${theme.bold(vm.name)}  ${theme.fg(vm.stateColor, vm.state)}${theme.fg("dim", " → ")}${theme.fg("accent", vm.nextStep ?? "done")}`;
    text += `\n  ${theme.fg("dim", "issues ")}${theme.fg(issueColor, String(issues.length))}`;
  }
  if (issues.length > 0) {
    text += `\n  ${theme.fg("dim", "problem")}${issues.length === 1 ? " " : "s"}`;
    for (const issue of issues) {
      text += `\n    ${theme.fg("warning", "●")} ${theme.fg("text", issue)}`;
    }
  }
  if (fixes.length > 0) {
    text += `\n  ${theme.fg("dim", "fixes  ")}${theme.fg("success", fixes.join(" · "))}`;
  }
  if (details.nextStepConfig) {
    text += `\n  ${theme.fg("dim", "next   ")}${theme.fg("accent", (details.nextStep as string | undefined) ?? "respawn")}`;
  }
  return text;
}

export function formatOverrideResult(details: Record<string, unknown>, expanded: boolean, theme: Theme): string {
  if (details.error) return theme.fg("error", "✗ override");
  const action = (details.action as string | undefined) ?? "override";
  const vm = details.viewModel as GigaplanViewModel | undefined;
  const collapsed = `${theme.fg("success", "✓")} ${theme.fg("text", action)}${vm ? `${theme.fg("dim", " · ")}${theme.fg(vm.stateColor, vm.state)}` : ""}`;
  if (!expanded || !vm) return collapsed;
  let text = collapsed;
  text += `\n  ${theme.fg("dim", "plan   ")}${theme.fg("text", vm.name)}`;
  text += `\n  ${theme.fg("dim", "next   ")}${theme.fg("accent", vm.nextStep ?? "done")}`;
  if (vm.recommendation) {
    text += `\n  ${theme.fg("dim", "eval   ")}${styledRecommendation(vm, theme)}`;
  }
  return text;
}

export function toolCallArg(name: string, arg: string | null | undefined, theme: Theme): string {
  return theme.fg("toolTitle", theme.bold(name)) + (arg ? ` ${theme.fg("accent", arg)}` : "");
}

export function compactIdea(text: string | undefined, maxWidth = 60): string {
  if (!text) return "";
  return text.length > maxWidth ? `${text.slice(0, maxWidth - 1)}…` : text;
}

export function describeIssues(issues: unknown): string[] {
  return Array.isArray(issues) ? issues.filter((issue): issue is string => typeof issue === "string") : [];
}

export function summarizeFlag(flag: FlagRecord): string {
  return flag.id ? `${flag.id}: ${flag.concern ?? "flag"}` : (flag.concern ?? "flag");
}

export function isRenderableState(state: string): boolean {
  return !TERMINAL_STATES.has(state);
}

export function scopedFocusViewModel(root: string, requestedPlanName?: string | null): GigaplanViewModel | null {
  const focused = resolveFocusedPlan(root, requestedPlanName);
  if (!focused) return null;
  return buildViewModel(focused.planDir, focused.state, {
    totalPlans: focused.totalPlans,
    focusIndex: focused.focusIndex,
    alternates: focused.alternates,
  });
}
