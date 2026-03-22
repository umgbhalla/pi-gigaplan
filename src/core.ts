/**
 * Shared utilities, types, and constants for gigaplan.
 *
 * This module exists to break circular dependencies. Every symbol that
 * workers, prompts, or evaluation needs from the package lives here.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as child_process from "node:child_process";

// ---------------------------------------------------------------------------
// Re-export schemas (ported from schemas.py)
// ---------------------------------------------------------------------------

export type JsonSchema = Record<string, unknown>;

export const SCHEMAS: Record<string, JsonSchema> = {
  "clarify.json": {
    type: "object",
    properties: {
      questions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            question: { type: "string" },
            context: { type: "string" },
          },
          required: ["question", "context"],
        },
      },
      refined_idea: { type: "string" },
      intent_summary: { type: "string" },
    },
    required: ["questions", "refined_idea", "intent_summary"],
  },
  "plan.json": {
    type: "object",
    properties: {
      plan: { type: "string" },
      questions: { type: "array", items: { type: "string" } },
      success_criteria: { type: "array", items: { type: "string" } },
      assumptions: { type: "array", items: { type: "string" } },
    },
    required: ["plan", "questions", "success_criteria", "assumptions"],
  },
  "integrate.json": {
    type: "object",
    properties: {
      plan: { type: "string" },
      changes_summary: { type: "string" },
      flags_addressed: { type: "array", items: { type: "string" } },
      assumptions: { type: "array", items: { type: "string" } },
      success_criteria: { type: "array", items: { type: "string" } },
      questions: { type: "array", items: { type: "string" } },
    },
    required: ["plan", "changes_summary", "flags_addressed"],
  },
  "critique.json": {
    type: "object",
    properties: {
      flags: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            concern: { type: "string" },
            category: {
              type: "string",
              enum: [
                "correctness",
                "security",
                "completeness",
                "performance",
                "maintainability",
                "other",
              ],
            },
            severity_hint: {
              type: "string",
              enum: ["likely-significant", "likely-minor", "uncertain"],
            },
            evidence: { type: "string" },
          },
          required: ["id", "concern", "category", "severity_hint", "evidence"],
        },
      },
      verified_flag_ids: { type: "array", items: { type: "string" } },
      disputed_flag_ids: { type: "array", items: { type: "string" } },
    },
    required: ["flags"],
  },
  "execution.json": {
    type: "object",
    properties: {
      output: { type: "string" },
      files_changed: { type: "array", items: { type: "string" } },
      commands_run: { type: "array", items: { type: "string" } },
      deviations: { type: "array", items: { type: "string" } },
    },
    required: ["output", "files_changed", "commands_run", "deviations"],
  },
  "review.json": {
    type: "object",
    properties: {
      criteria: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            pass: { type: "boolean" },
            evidence: { type: "string" },
          },
          required: ["name", "pass", "evidence"],
        },
      },
      issues: { type: "array", items: { type: "string" } },
      summary: { type: "string" },
    },
    required: ["criteria", "issues"],
  },
};

export function strictSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) {
    return schema.map(strictSchema);
  }
  if (schema !== null && typeof schema === "object") {
    const updated: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
      updated[key] = strictSchema(value);
    }
    if (updated["type"] === "object") {
      if (!("additionalProperties" in updated)) {
        updated["additionalProperties"] = false;
      }
      if ("properties" in updated && typeof updated["properties"] === "object") {
        updated["required"] = Object.keys(updated["properties"] as object);
      }
    }
    return updated;
  }
  return schema;
}

// ---------------------------------------------------------------------------
// State constants
// ---------------------------------------------------------------------------

export const STATE_INITIALIZED = "initialized";
export const STATE_CLARIFIED = "clarified";
export const STATE_PLANNED = "planned";
export const STATE_CRITIQUED = "critiqued";
export const STATE_EVALUATED = "evaluated";
export const STATE_GATED = "gated";
export const STATE_EXECUTED = "executed";
export const STATE_DONE = "done";
export const STATE_ABORTED = "aborted";
export const TERMINAL_STATES = new Set([STATE_DONE, STATE_ABORTED]);

// ---------------------------------------------------------------------------
// Type definitions
// ---------------------------------------------------------------------------

export interface PlanConfig {
  max_iterations?: number;
  budget_usd?: number;
  project_dir?: string;
  auto_approve?: boolean;
  robustness?: string;
  agents?: Record<string, string>;
}

export interface PlanMeta {
  significant_counts?: number[];
  weighted_scores?: number[];
  plan_deltas?: (number | null)[];
  recurring_critiques?: string[];
  total_cost_usd?: number;
  overrides?: Record<string, unknown>[];
  notes?: Record<string, unknown>[];
  user_approved_gate?: boolean;
}

export interface PlanState {
  name: string;
  idea: string;
  current_state: string;
  iteration: number;
  created_at: string;
  config: PlanConfig;
  sessions: Record<string, SessionInfo>;
  plan_versions: PlanVersionRecord[];
  history: HistoryEntry[];
  meta: PlanMeta;
  last_evaluation: Record<string, unknown>;
  clarification?: Record<string, unknown>;
}

export interface FlagRecord {
  id?: string;
  concern?: string;
  category?: string;
  severity_hint?: string;
  evidence?: string;
  raised_in?: string;
  status?: string;
  severity?: string;
  verified?: boolean;
  verified_in?: string;
  addressed_in?: string;
}

export interface SessionInfo {
  id?: string;
  mode?: string;
  created_at?: string;
  last_used_at?: string;
  refreshed?: boolean;
}

export interface PlanVersionRecord {
  version?: number;
  file?: string;
  hash?: string;
  timestamp?: string;
}

export interface HistoryEntry {
  step?: string;
  timestamp?: string;
  duration_ms?: number;
  cost_usd?: number;
  result?: string;
  session_mode?: string;
  session_id?: string;
  agent?: string;
  output_file?: string;
  artifact_hash?: string;
  raw_output_file?: string;
  message?: string;
  flags_count?: number;
  flags_addressed?: string[];
  recommendation?: string;
  approval_mode?: string;
  environment?: Record<string, boolean>;
}

export interface FlagRegistry {
  flags: FlagRecord[];
}

export interface EvaluationResult {
  recommendation?: string;
  confidence?: string;
  robustness?: string;
  signals?: Record<string, unknown>;
  rationale?: string;
  valid_next_steps?: string[];
  warnings?: string[];
  suggested_override?: string;
  override_rationale?: string;
}

export interface StepResponse {
  success?: boolean;
  step?: string;
  summary?: string;
  artifacts?: string[];
  next_step?: string | null;
  state?: string;
  auto_approve?: boolean;
  robustness?: string;
  iteration?: number;
  plan?: string;
  plan_dir?: string;
  questions?: string[];
  verified_flags?: string[];
  open_flags?: string[];
  scope_creep_flags?: string[];
  warnings?: string[];
  files_changed?: string[];
  deviations?: string[];
  user_approved_gate?: boolean;
  issues?: string[];
  valid_next?: string[];
  mode?: string;
  installed?: Record<string, unknown>[];
  config_path?: string;
  routing?: Record<string, string>;
  raw_config?: Record<string, unknown>;
  action?: string;
  key?: string;
  value?: string;
  skipped?: boolean;
  file?: string;
  plans?: Record<string, unknown>[];
  recommendation?: string;
  confidence?: string;
  signals?: Record<string, unknown>;
  rationale?: string;
  valid_next_steps?: string[];
  suggested_override?: string;
  override_rationale?: string;
  passed?: boolean;
  criteria_check?: Record<string, unknown>;
  preflight_results?: Record<string, boolean>;
  unresolved_flags?: unknown[];
  error?: string;
  message?: string;
  details?: Record<string, unknown>;
  agent_fallback?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const FLAG_BLOCKING_STATUSES = new Set(["open", "disputed"]);
export const MOCK_ENV_VAR = "GIGAPLAN_MOCK_WORKERS";

export const DEFAULT_AGENT_ROUTING: Record<string, string> = {
  clarify: "claude",
  plan: "claude",
  critique: "codex",
  integrate: "claude",
  execute: "codex",
  review: "codex",
};

export const KNOWN_AGENTS = ["claude", "codex"];
export const ROBUSTNESS_LEVELS = ["light", "standard", "thorough"] as const;
export type RobustnessLevel = (typeof ROBUSTNESS_LEVELS)[number];

export const ROBUSTNESS_SKIP_THRESHOLDS: Record<string, number> = {
  light: 4.0,
  standard: 2.0,
  thorough: 1.0,
};

export const ROBUSTNESS_STAGNATION_FACTORS: Record<string, number> = {
  light: 0.8,
  standard: 0.9,
  thorough: 0.95,
};

export const SCOPE_CREEP_TERMS = [
  "scope creep",
  "out of scope",
  "beyond the original idea",
  "beyond original idea",
  "beyond user intent",
  "expanded scope",
] as const;

// ---------------------------------------------------------------------------
// Exception
// ---------------------------------------------------------------------------

export class GigaplanError extends Error {
  code: string;
  validNext: string[];
  extra: Record<string, unknown>;
  exitCode: number;

  constructor(
    code: string,
    message: string,
    {
      validNext,
      extra,
      exitCode,
    }: {
      validNext?: string[];
      extra?: Record<string, unknown>;
      exitCode?: number;
    } = {}
  ) {
    super(message);
    this.name = "GigaplanError";
    this.code = code;
    this.validNext = validNext ?? [];
    this.extra = extra ?? {};
    this.exitCode = exitCode ?? 1;
  }
}

// ---------------------------------------------------------------------------
// Pure utilities
// ---------------------------------------------------------------------------

export function nowUtc(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function slugify(text: string, maxLength = 30): string {
  let slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (slug.length <= maxLength) {
    return slug || "plan";
  }
  let truncated = slug.slice(0, maxLength);
  const lastHyphen = truncated.lastIndexOf("-");
  if (lastHyphen > 10) {
    truncated = truncated.slice(0, lastHyphen);
  }
  return truncated || "plan";
}

export function jsonDump(obj: unknown): string {
  return JSON.stringify(obj, null, 2) + "\n";
}

export function normalizeText(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

export function sha256Text(content: string): string {
  return "sha256:" + crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

export function sha256File(filePath: string): string {
  return sha256Text(fs.readFileSync(filePath, "utf8"));
}

// ---------------------------------------------------------------------------
// Atomic I/O
// ---------------------------------------------------------------------------

export function atomicWriteText(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(dir, `.tmp_${process.pid}_${Date.now()}`);
  fs.writeFileSync(tmpPath, content, "utf8");
  fs.renameSync(tmpPath, filePath);
}

export function atomicWriteJson(filePath: string, data: unknown): void {
  atomicWriteText(filePath, jsonDump(data));
}

export function readJson(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

export function configDir(home?: string): string {
  const xdg = process.env["XDG_CONFIG_HOME"];
  if (xdg) {
    return path.join(xdg, "gigaplan");
  }
  const homeDir = home ?? os.homedir();
  return path.join(homeDir, ".config", "gigaplan");
}

export function loadConfig(home?: string): Record<string, unknown> {
  const configPath = path.join(configDir(home), "config.json");
  if (!fs.existsSync(configPath)) {
    return {};
  }
  try {
    const data = JSON.parse(fs.readFileSync(configPath, "utf8"));
    if (data === null || typeof data !== "object" || Array.isArray(data)) {
      return {};
    }
    return data as Record<string, unknown>;
  } catch (err) {
    process.stderr.write(`gigaplan: warning: ignoring malformed config at ${configPath}: ${err}\n`);
    return {};
  }
}

export function saveConfig(config: Record<string, unknown>, home?: string): string {
  const configPath = path.join(configDir(home), "config.json");
  atomicWriteJson(configPath, config);
  return configPath;
}

export function detectAvailableAgents(): string[] {
  return KNOWN_AGENTS.filter((agent) => {
    try {
      child_process.execSync(`which ${agent}`, { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  });
}

// ---------------------------------------------------------------------------
// Runtime layout / path helpers
// ---------------------------------------------------------------------------

export function ensureRuntimeLayout(root: string): void {
  const gigaplanRt = path.join(root, ".gigaplan");
  fs.mkdirSync(path.join(gigaplanRt, "plans"), { recursive: true });
  const schemasDir = path.join(gigaplanRt, "schemas");
  fs.mkdirSync(schemasDir, { recursive: true });
  for (const [filename, schema] of Object.entries(SCHEMAS)) {
    atomicWriteJson(path.join(schemasDir, filename), strictSchema(schema));
  }
}

export function gigaplanRoot(root: string): string {
  return path.join(root, ".gigaplan");
}

export function plansRoot(root: string): string {
  return path.join(gigaplanRoot(root), "plans");
}

export function schemasRoot(root: string): string {
  return path.join(gigaplanRoot(root), "schemas");
}

export function artifactPath(planDir: string, filename: string): string {
  return path.join(planDir, filename);
}

export function currentIterationArtifact(planDir: string, prefix: string, iteration: number): string {
  return path.join(planDir, `${prefix}_v${iteration}.json`);
}

export function currentIterationRawArtifact(planDir: string, prefix: string, iteration: number): string {
  return path.join(planDir, `${prefix}_v${iteration}_raw.txt`);
}

// ---------------------------------------------------------------------------
// Plan state helpers
// ---------------------------------------------------------------------------

export function activePlanDirs(root: string): string[] {
  const pr = plansRoot(root);
  if (!fs.existsSync(pr)) return [];
  const dirs: string[] = [];
  for (const child of fs.readdirSync(pr)) {
    const childPath = path.join(pr, child);
    if (
      fs.statSync(childPath).isDirectory() &&
      fs.existsSync(path.join(childPath, "state.json"))
    ) {
      dirs.push(childPath);
    }
  }
  return dirs.sort();
}

export function resolvePlanDir(root: string, requestedName?: string | null): string {
  const planDirs = activePlanDirs(root);
  if (requestedName) {
    const planDir = path.join(plansRoot(root), requestedName);
    if (!fs.existsSync(path.join(planDir, "state.json"))) {
      throw new GigaplanError("missing_plan", `Plan '${requestedName}' does not exist`);
    }
    return planDir;
  }
  if (planDirs.length === 0) {
    throw new GigaplanError("missing_plan", "No plans found. Run init first.");
  }
  const active = planDirs.filter((d) => {
    const state = readJson(path.join(d, "state.json")) as PlanState;
    return !TERMINAL_STATES.has(state.current_state);
  });
  if (active.length === 1) return active[0];
  if (planDirs.length === 1) return planDirs[0];
  const names = (active.length > 0 ? active : planDirs).map((p) => path.basename(p));
  throw new GigaplanError("ambiguous_plan", "Multiple plans exist; pass --plan explicitly", {
    extra: { plans: names },
  });
}

export function loadPlan(root: string, requestedName?: string | null): [string, PlanState] {
  const planDir = resolvePlanDir(root, requestedName);
  return [planDir, readJson(path.join(planDir, "state.json")) as PlanState];
}

export function savePlanState(planDir: string, state: PlanState): void {
  atomicWriteJson(path.join(planDir, "state.json"), state);
}

export function latestPlanRecord(state: PlanState): PlanVersionRecord {
  const versions = state.plan_versions;
  if (!versions || versions.length === 0) {
    throw new GigaplanError("missing_plan_version", "No plan version exists yet");
  }
  return versions[versions.length - 1];
}

export function latestPlanPath(planDir: string, state: PlanState): string {
  return path.join(planDir, latestPlanRecord(state).file!);
}

export function latestPlanMetaPath(planDir: string, state: PlanState): string {
  const record = latestPlanRecord(state);
  const metaName = record.file!.replace(".md", ".meta.json");
  return path.join(planDir, metaName);
}

// ---------------------------------------------------------------------------
// Flag registry
// ---------------------------------------------------------------------------

export function loadFlagRegistry(planDir: string): FlagRegistry {
  const flagPath = path.join(planDir, "faults.json");
  if (fs.existsSync(flagPath)) {
    return readJson(flagPath) as FlagRegistry;
  }
  return { flags: [] };
}

export function saveFlagRegistry(planDir: string, registry: FlagRegistry): void {
  atomicWriteJson(path.join(planDir, "faults.json"), registry);
}

export function unresolvedSignificantFlags(flagRegistry: FlagRegistry): FlagRecord[] {
  return flagRegistry.flags.filter(
    (flag) => flag.severity === "significant" && FLAG_BLOCKING_STATUSES.has(flag.status ?? "")
  );
}

export function isScopeCreepFlag(flag: FlagRecord): boolean {
  const text = `${flag.concern ?? ""} ${flag.evidence ?? ""}`.toLowerCase();
  return SCOPE_CREEP_TERMS.some((term) => text.includes(term));
}

export function scopeCreepFlags(
  flagRegistry: FlagRegistry,
  { statuses }: { statuses?: Set<string> } = {}
): FlagRecord[] {
  return flagRegistry.flags.filter((flag) => {
    if (statuses !== undefined && !statuses.has(flag.status ?? "")) return false;
    return isScopeCreepFlag(flag);
  });
}

// ---------------------------------------------------------------------------
// Robustness helpers
// ---------------------------------------------------------------------------

export function configuredRobustness(state: PlanState): string {
  const robustness = state.config.robustness ?? "standard";
  if (!(ROBUSTNESS_LEVELS as readonly string[]).includes(robustness)) {
    return "standard";
  }
  return robustness;
}

export function robustnessCritiqueInstruction(robustness: string): string {
  if (robustness === "light") {
    return "Be pragmatic. Only flag issues that would cause real failures. Ignore style, minor edge cases, and issues the executor will naturally resolve.";
  }
  if (robustness === "thorough") {
    return "Be exhaustive. Flag edge cases, missing error handling, performance concerns, and anything that could cause problems in production even if unlikely.";
  }
  return "Use balanced judgment. Flag significant risks, but do not spend flags on minor polish or executor-obvious boilerplate.";
}

// ---------------------------------------------------------------------------
// Intent / notes block for prompts
// ---------------------------------------------------------------------------

export function intentAndNotesBlock(state: PlanState): string {
  const sections: string[] = [];
  const clarification = state.clarification ?? {};
  if (clarification["intent_summary"]) {
    sections.push(`User intent summary:\n${clarification["intent_summary"]}`);
    sections.push(`Original idea:\n${state.idea}`);
  } else {
    sections.push(`Idea:\n${state.idea}`);
  }
  const notes = state.meta.notes ?? [];
  if (notes.length > 0) {
    const notesText = notes.map((note) => `- ${(note as Record<string, unknown>)["note"]}`).join("\n");
    sections.push(`User notes and answers:\n${notesText}`);
  }
  return sections.join("\n\n");
}

// ---------------------------------------------------------------------------
// Git diff summary
// ---------------------------------------------------------------------------

export function collectGitDiffSummary(projectDir: string): string {
  if (!fs.existsSync(path.join(projectDir, ".git"))) {
    return "Project directory is not a git repository.";
  }
  try {
    const result = child_process.spawnSync("git", ["status", "--short"], {
      cwd: projectDir,
      encoding: "utf8",
      timeout: 30_000,
    });
    if (result.error) {
      if ((result.error as NodeJS.ErrnoException).code === "ENOENT") {
        return "git not found on PATH.";
      }
      return `Unable to read git status: ${result.error.message}`;
    }
    if (result.status !== 0) {
      const errMsg = (result.stderr ?? result.stdout ?? "").trim();
      return `Unable to read git status: ${errMsg}`;
    }
    return (result.stdout ?? "").trim() || "No git changes detected.";
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ETIMEDOUT") {
      return "git status timed out.";
    }
    return `Unable to read git status: ${err}`;
  }
}
