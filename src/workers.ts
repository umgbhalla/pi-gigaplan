/**
 * Worker orchestration: running plan steps via pi subagents.
 *
 * Replaces the pi gigaplan's subprocess calls to claude/codex CLIs
 * with pi's native subagent system. Each step spawns an autonomous
 * subagent in a cmux pane that writes structured JSON output to
 * .gigaplan/plans/<name>/<step>.json.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { PlanState } from "./core.js";
import {
  SCHEMAS,
  strictSchema,
  readJson,
  jsonDump,
  atomicWriteJson,
  nowUtc,
  schemasRoot,
  latestPlanMetaPath,
  GigaplanError,
  DEFAULT_AGENT_ROUTING,
  loadConfig,
} from "./core.js";
import { createPrompt } from "./prompts.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WorkerResult {
  payload: Record<string, unknown>;
  rawOutput: string;
  durationMs: number;
  costUsd: number;
  sessionId?: string;
}

/**
 * Maps step names to the schema filename used for validation.
 */
export const STEP_SCHEMA_FILENAMES: Record<string, string> = {
  clarify: "clarify.json",
  plan: "plan.json",
  integrate: "integrate.json",
  critique: "critique.json",
  execute: "execution.json",
  review: "review.json",
};

/**
 * Derive required keys per step from SCHEMAS.
 */
function getRequiredKeys(step: string): string[] {
  const filename = STEP_SCHEMA_FILENAMES[step];
  if (!filename) return [];
  const schema = SCHEMAS[filename] as Record<string, unknown> | undefined;
  return (schema?.required as string[] | undefined) ?? [];
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export function validatePayload(step: string, payload: Record<string, unknown>): void {
  const required = getRequiredKeys(step);
  const missing = required.filter((k) => !(k in payload));
  if (missing.length > 0) {
    throw new GigaplanError(
      "parse_error",
      `${step} output missing required keys: ${missing.join(", ")}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Agent routing
// ---------------------------------------------------------------------------

export interface AgentRouting {
  agent: string;
  model?: string;
}

/**
 * Resolve which agent/model to use for a given step.
 * Uses gigaplan config, falls back to DEFAULT_AGENT_ROUTING.
 */
export function resolveAgent(step: string, state: PlanState): AgentRouting {
  const config = state.config;
  const agentMap = config.agents ?? {};
  const agent = agentMap[step] ?? DEFAULT_AGENT_ROUTING[step] ?? "claude";

  // In pi-gigaplan, "agent" maps to pi agent definitions.
  // The default routing maps to model preferences:
  // - "claude" steps → use a Claude model (e.g. sonnet for planning)
  // - "codex" steps → use a different model for independent critique
  return { agent };
}

// ---------------------------------------------------------------------------
// Build subagent task
// ---------------------------------------------------------------------------

/**
 * Build the full task prompt for a subagent.
 * Includes the step prompt + instructions to write structured output.
 */
export function buildSubagentTask(
  step: string,
  state: PlanState,
  planDir: string,
  outputPath: string,
): string {
  const agent = resolveAgent(step, state).agent;
  const prompt = createPrompt(step, agent, state, planDir);
  const schemaFilename = STEP_SCHEMA_FILENAMES[step];
  const schema = SCHEMAS[schemaFilename];
  const strict = strictSchema(schema);

  const task = `You are executing a gigaplan step: **${step}** (iteration ${state.iteration}).

## Your Task

${prompt}

## Output Requirements

You MUST write your response as a valid JSON object to this file:
\`${outputPath}\`

The JSON must conform to this schema:
\`\`\`json
${JSON.stringify(strict, null, 2)}
\`\`\`

Use the \`write\` tool to write the JSON file. Do NOT include any text outside the JSON object.
Do NOT wrap in markdown code fences in the file — write raw JSON only.

After writing the output file, you are done. Call subagent_done to exit.`;

  return task;
}

// ---------------------------------------------------------------------------
// Parse output
// ---------------------------------------------------------------------------

/**
 * Read and validate the structured output from a subagent.
 */
export function parseStepOutput(
  step: string,
  outputPath: string,
): Record<string, unknown> {
  if (!fs.existsSync(outputPath)) {
    throw new GigaplanError(
      "parse_error",
      `Step output file was not created: ${outputPath}`,
    );
  }

  const raw = fs.readFileSync(outputPath, "utf-8").trim();
  if (!raw) {
    throw new GigaplanError("parse_error", `Step output file is empty: ${outputPath}`);
  }

  // Try to parse — handle potential markdown fencing
  let text = raw;
  const fenceMatch = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  if (fenceMatch) {
    text = fenceMatch[1];
  }

  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch (e) {
    throw new GigaplanError(
      "parse_error",
      `Step output is not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new GigaplanError("parse_error", "Step output is not a JSON object");
  }

  const obj = payload as Record<string, unknown>;
  validatePayload(step, obj);
  return obj;
}

// ---------------------------------------------------------------------------
// Subagent config per step
// ---------------------------------------------------------------------------

export interface SubagentStepConfig {
  name: string;
  agent: string;
  task: string;
  model?: string;
  tools: string;
  outputPath: string;
}

/**
 * Determine the pi agent definition name for a gigaplan agent role.
 * Maps gigaplan's "claude"/"codex" routing to pi agent definitions.
 */
function piAgentForRole(role: string, step: string): string {
  // For planning steps (clarify, plan, integrate) → use planner agent
  if (["clarify", "plan", "integrate"].includes(step)) return "planner";
  // For critique → use reviewer agent (independent)
  if (step === "critique") return "reviewer";
  // For execute → use worker agent
  if (step === "execute") return "worker";
  // For review → use reviewer agent
  if (step === "review") return "reviewer";
  return "worker";
}

/**
 * Build the subagent configuration for a given step.
 */
export function buildStepConfig(
  step: string,
  state: PlanState,
  planDir: string,
): SubagentStepConfig {
  const routing = resolveAgent(step, state);
  const outputPath = path.join(planDir, `${step}_output.json`);
  const task = buildSubagentTask(step, state, planDir, outputPath);
  const piAgent = piAgentForRole(routing.agent, step);

  return {
    name: `gigaplan:${step}:v${state.iteration}`,
    agent: piAgent,
    task,
    model: routing.model,
    tools: "read,bash,edit,write",
    outputPath,
  };
}

// ---------------------------------------------------------------------------
// Session tracking (mirrors Python's session_key_for + update_session_state)
// ---------------------------------------------------------------------------

export function sessionKeyFor(step: string, agent: string): string {
  if (["clarify", "plan", "integrate"].includes(step)) return `${agent}_planner`;
  if (step === "critique") return `${agent}_critic`;
  if (step === "execute") return `${agent}_executor`;
  if (step === "review") return `${agent}_reviewer`;
  return `${agent}_${step}`;
}
