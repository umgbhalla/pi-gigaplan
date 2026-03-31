import * as fs from "node:fs";
import * as path from "node:path";

import type { EvaluationResult, FlagRegistry, PlanState, StepResponse } from "../core.js";
import { readJson } from "../core.js";

export interface StepDetails {
  step: string;
  version: number;
  durationMs: number;
  durationFormatted: string;
  success: boolean;
  summary: string;
  clarify?: { intentSummary: string; questionCount: number; refinedIdea: string };
  plan?: { criteriaCount: number; assumptionCount: number; questionCount: number };
  critique?: {
    flags: Array<{ id: string; severity: string; concern: string; status: string }>;
    verifiedCount: number;
    newCount: number;
  };
  evaluate?: {
    recommendation: string;
    confidence: string;
    weightedScore: number;
    rationale: string;
  };
  gate?: { passed: boolean; checks: Record<string, boolean>; unresolvedCount: number };
  execute?: { filesChanged: number; commandsRun: number; deviations: number };
  review?: { criteriaResults: Array<{ name: string; pass: boolean }>; issueCount: number };
}

type StepResultLike = Pick<StepResponse, "success" | "summary">;

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0s";

  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;

  const totalMinutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (totalMinutes < 60) {
    return seconds > 0 ? `${totalMinutes}m ${seconds}s` : `${totalMinutes}m`;
  }

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (minutes > 0) return `${hours}h ${minutes}m`;
  return `${hours}h`;
}

export function buildStepDetails(
  step: string,
  planDir: string,
  state: PlanState,
  result: StepResultLike,
  durationMs: number,
): StepDetails {
  const version = state.iteration;
  const details: StepDetails = {
    step,
    version,
    durationMs,
    durationFormatted: formatDuration(durationMs),
    success: inferSuccess(step, planDir, result),
    summary: buildSummary(step, planDir, state, result, version),
  };

  if (step === "clarify") {
    const clarification = asRecord(state.clarification);
    details.clarify = {
      intentSummary: asString(clarification.intent_summary) ?? cleanSummary(result.summary) ?? "",
      questionCount: asArray(clarification.questions).length,
      refinedIdea: asString(clarification.refined_idea) ?? state.idea,
    };
    return details;
  }

  if (step === "plan" || step === "integrate") {
    const meta = readJsonFile(path.join(planDir, `plan_v${version}.meta.json`));
    details.plan = {
      criteriaCount: asArray(meta?.success_criteria).length,
      assumptionCount: asArray(meta?.assumptions).length,
      questionCount: asArray(meta?.questions).length,
    };
    return details;
  }

  if (step === "critique") {
    const critique = readJsonFile(path.join(planDir, `critique_v${version}.json`));
    const registry = readJsonFile(path.join(planDir, "faults.json")) as FlagRegistry | null;
    const flags = asArray(critique?.flags)
      .map((flag) => asRecord(flag))
      .filter((flag) => Object.keys(flag).length > 0)
      .map((flag) => {
        const id = asString(flag.id) ?? "unknown";
        const registryFlag = registry?.flags?.find((candidate) => candidate.id === id);
        return {
          id,
          concern: asString(registryFlag?.concern) ?? asString(flag.concern) ?? "",
          severity: asString(registryFlag?.severity) ?? severityFromHint(asString(flag.severity_hint)),
          status: asString(registryFlag?.status) ?? "open",
        };
      });

    details.critique = {
      flags,
      verifiedCount: asArray(critique?.verified_flag_ids).length,
      newCount: asArray(critique?.flags).length,
    };
    return details;
  }

  if (step === "evaluate") {
    const evaluation = readJsonFile(path.join(planDir, `evaluation_v${version}.json`)) as EvaluationResult | null;
    const signals = asRecord(evaluation?.signals);
    details.evaluate = {
      recommendation: evaluation?.recommendation ?? "",
      confidence: evaluation?.confidence ?? "",
      weightedScore: asNumber(signals.weighted_score) ?? 0,
      rationale: evaluation?.rationale ?? "",
    };
    return details;
  }

  if (step === "gate") {
    const gate = readJsonFile(path.join(planDir, "gate.json"));
    details.gate = {
      passed: asBoolean(gate?.passed),
      checks: booleanRecord(gate?.preflight_results),
      unresolvedCount: asArray(gate?.unresolved_flags).length,
    };
    return details;
  }

  if (step === "execute") {
    const execution = readJsonFile(path.join(planDir, "execution.json"));
    details.execute = {
      filesChanged: asArray(execution?.files_changed).length,
      commandsRun: asArray(execution?.commands_run).length,
      deviations: asArray(execution?.deviations).length,
    };
    return details;
  }

  if (step === "review") {
    const review = readJsonFile(path.join(planDir, "review.json"));
    details.review = {
      criteriaResults: asArray(review?.criteria)
        .map((criterion) => asRecord(criterion))
        .filter((criterion) => typeof criterion.name === "string")
        .map((criterion) => ({
          name: asString(criterion.name) ?? "",
          pass: asBoolean(criterion.pass),
        })),
      issueCount: asArray(review?.issues).length,
    };
    return details;
  }

  return details;
}

function inferSuccess(step: string, planDir: string, result: StepResultLike): boolean {
  if (typeof result.success === "boolean") return result.success;
  if (step !== "gate") return true;
  const gate = readJsonFile(path.join(planDir, "gate.json"));
  return asBoolean(gate?.passed);
}

function buildSummary(
  step: string,
  planDir: string,
  state: PlanState,
  result: StepResultLike,
  version: number,
): string {
  const explicit = cleanSummary(result.summary);
  if (explicit) return explicit;

  if (step === "clarify") {
    const clarification = asRecord(state.clarification);
    const intentSummary = asString(clarification.intent_summary) ?? "Clarified";
    return cleanSummary(`Clarified: ${intentSummary}`) ?? "Clarified";
  }

  if (step === "plan" || step === "integrate") {
    return `${step === "integrate" ? "Integrated" : "Plan"} v${version}`;
  }

  if (step === "critique") {
    const critique = readJsonFile(path.join(planDir, `critique_v${version}.json`));
    return `Critique: ${asArray(critique?.flags).length} flags raised, ${asArray(critique?.verified_flag_ids).length} verified`;
  }

  if (step === "evaluate") {
    const evaluation = readJsonFile(path.join(planDir, `evaluation_v${version}.json`)) as EvaluationResult | null;
    const recommendation = evaluation?.recommendation ?? "EVALUATED";
    const confidence = evaluation?.confidence ?? "unknown";
    return `Evaluation: ${recommendation} (${confidence})`;
  }

  if (step === "gate") {
    const gate = readJsonFile(path.join(planDir, "gate.json"));
    return asBoolean(gate?.passed) ? "Gate passed" : "Gate failed";
  }

  if (step === "execute") {
    const execution = readJsonFile(path.join(planDir, "execution.json"));
    return `Executed: ${asArray(execution?.files_changed).length} files changed`;
  }

  if (step === "review") {
    const review = readJsonFile(path.join(planDir, "review.json"));
    const criteria = asArray(review?.criteria).map((criterion) => asRecord(criterion));
    const passed = criteria.filter((criterion) => asBoolean(criterion.pass)).length;
    return `Review: ${passed}/${criteria.length} criteria passed`;
  }

  return cleanSummary(step) ?? step;
}

function cleanSummary(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized || null;
}

function readJsonFile(filePath: string): Record<string, unknown> | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    const value = readJson(filePath);
    return asRecord(value);
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asBoolean(value: unknown): boolean {
  return value === true;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function booleanRecord(value: unknown): Record<string, boolean> {
  const record = asRecord(value);
  const entries = Object.entries(record)
    .filter(([, entryValue]) => typeof entryValue === "boolean")
    .map(([key, entryValue]) => [key, entryValue as boolean]);
  return Object.fromEntries(entries);
}

function severityFromHint(value: string | undefined): string {
  if (value === "likely-significant") return "significant";
  if (value === "likely-minor") return "minor";
  return "unknown";
}
