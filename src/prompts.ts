/** Prompt builders for each gigaplan step and dispatch tables. */

import * as fs from "fs";
import * as path from "path";
import {
  PlanState,
  FlagRecord,
  GigaplanError,
  latestPlanPath,
  readJson,
  latestPlanMetaPath,
  loadFlagRegistry,
  unresolvedSignificantFlags,
  intentAndNotesBlock,
  jsonDump,
  currentIterationArtifact,
  configuredRobustness,
  robustnessCritiqueInstruction,
  collectGitDiffSummary,
} from "./core.js";

function clarifyPrompt(state: PlanState, planDir: string): string {
  const projectDir = state.config.project_dir;
  const notes = state.meta?.notes ?? [];
  const notesBlock =
    notes.length > 0
      ? notes.map((n: Record<string, unknown>) => `- ${n.note}`).join("\n")
      : "- None";
  return `
You are a planning assistant. The user has proposed the following idea:

Idea:
${state.idea}

Project directory:
${projectDir}

User notes:
${notesBlock}

Requirements:
- Read the project directory to understand the codebase.
- Restate the idea in your own words as a precise intent summary.
- Identify ambiguities, underspecified aspects, or implicit assumptions.
- For each ambiguity, produce a question that, if answered, would materially change the implementation plan.
- Propose a refined version of the idea that resolves obvious ambiguities.
- Do NOT plan the implementation - only clarify the intent.
`.trim();
}

function planPrompt(state: PlanState, planDir: string): string {
  const projectDir = state.config.project_dir;
  const notes = state.meta?.notes ?? [];
  const notesBlock =
    notes.length > 0
      ? notes.map((n: Record<string, unknown>) => `- ${n.note}`).join("\n")
      : "- None";
  const clarification = state.clarification ?? {};
  const refined = clarification.refined_idea ?? "";
  const intent = clarification.intent_summary ?? "";
  const clarifyBlock = refined
    ? `Refined idea (from clarification):
${refined}

Intent summary:
${intent}

Original idea (for reference):
${state.idea}`
    : `Idea:
${state.idea}`;
  return `
You are creating an implementation plan for the following idea.

${clarifyBlock}

Project directory:
${projectDir}

User notes:
${notesBlock}

Requirements:
- Inspect the actual repository before planning.
- Produce a concrete implementation plan in markdown.
- Define observable success criteria.
- Call out assumptions and open questions.
- Prefer cheap validation steps early.
`.trim();
}

function integratePrompt(state: PlanState, planDir: string): string {
  const projectDir = state.config.project_dir;
  const latestPlan = fs.readFileSync(
    latestPlanPath(planDir, state),
    "utf-8"
  );
  const latestMeta = readJson(latestPlanMetaPath(planDir, state));
  const flagRegistry = loadFlagRegistry(planDir);
  const evaluatePath = currentIterationArtifact(
    planDir,
    "evaluation",
    state.iteration
  );
  const evaluation = readJson(evaluatePath);
  const unresolved = unresolvedSignificantFlags(flagRegistry);
  const openFlags = unresolved.map((flag) => ({
    id: flag.id,
    severity: flag.severity,
    status: flag.status,
    concern: flag.concern,
    evidence: flag.evidence,
  }));
  return `
You are updating an implementation plan based on critique and evaluation.

Project directory:
${projectDir}

${intentAndNotesBlock(state)}

Current plan (markdown):
${latestPlan}

Current plan metadata:
${jsonDump(latestMeta).trim()}

Evaluation:
${jsonDump(evaluation).trim()}

Open significant flags:
${jsonDump(openFlags).trim()}

Requirements:
- Update the plan to address the significant issues.
- Keep the plan readable and executable.
- Return flags_addressed with the exact flag IDs you addressed.
- Preserve or improve success criteria quality.
- Verify that the plan remains aligned with the user's original intent (above), not just internal plan quality.
- Remove unjustified scope growth. If the critique raised scope creep, narrow the plan back to the original idea unless the broader work is strictly required.
- If a broader change is truly necessary, explain that dependency explicitly in changes_summary instead of silently expanding the plan.
`.trim();
}

function critiquePrompt(state: PlanState, planDir: string): string {
  const projectDir = state.config.project_dir;
  const latestPlan = fs.readFileSync(
    latestPlanPath(planDir, state),
    "utf-8"
  );
  const latestMeta = readJson(latestPlanMetaPath(planDir, state));
  const flagRegistry = loadFlagRegistry(planDir);
  const robustness = configuredRobustness(state);
  const unresolved = flagRegistry.flags
    .filter((flag) =>
      ["addressed", "open", "disputed"].includes(flag.status as string)
    )
    .map((flag) => ({
      id: flag.id,
      concern: flag.concern,
      status: flag.status,
      severity: flag.severity,
    }));
  return `
You are an independent reviewer. Critique the plan against the actual repository.

Project directory:
${projectDir}

${intentAndNotesBlock(state)}

Plan:
${latestPlan}

Plan metadata:
${jsonDump(latestMeta).trim()}

Existing flags:
${jsonDump(unresolved).trim()}

Requirements:
- Consider whether the plan is at the right level of abstraction. If it
  patches multiple systems for one goal, it may be too low — flag whether
  a simpler design would eliminate the problem class. If it redesigns
  architecture for a simple bug, it may be too high. Push the plan up or
  down the abstraction ladder as needed.
- Reuse existing flag IDs when the same concern is still open.
- verified_flag_ids should list previously addressed flags that now appear resolved.
- Focus on concrete issues that would cause real problems.
- Robustness level: ${robustness}. ${robustnessCritiqueInstruction(robustness)}
- Verify that the plan remains aligned with the user's original intent (above), not just internal plan quality.
- Flag scope creep explicitly when the plan grows beyond the original idea or recorded user notes. Use the phrase "Scope creep:" in the concern so the orchestrator can surface it.
- Do not rubber-stamp the plan.
- Assign severity_hint carefully: "likely-significant" for issues that would
  cause real product or implementation problems. "likely-minor" for cosmetic,
  nice-to-have, issues already covered elsewhere, or implementation details
  the executor will naturally resolve by reading the actual code (e.g. exact
  line numbers, missing boilerplate, export lists).
`.trim();
}

function executePrompt(state: PlanState, planDir: string): string {
  const projectDir = state.config.project_dir;
  const latestPlan = fs.readFileSync(
    latestPlanPath(planDir, state),
    "utf-8"
  );
  const latestMeta = readJson(latestPlanMetaPath(planDir, state));
  const robustness = configuredRobustness(state);
  const gate = readJson(path.join(planDir, "gate.json"));
  let approvalNote: string;
  if (state.config.auto_approve) {
    approvalNote =
      "Note: User chose auto-approve mode. This execution was not manually reviewed at the gate. Exercise extra caution on destructive operations.";
  } else if (state.meta?.user_approved_gate) {
    approvalNote =
      "Note: User explicitly approved this plan at the gate checkpoint.";
  } else {
    approvalNote =
      "Note: Review mode is enabled. Execute should only be running after explicit gate approval.";
  }
  return `
Execute the approved plan in the repository.

Project directory:
${projectDir}

${intentAndNotesBlock(state)}

Approved plan:
${latestPlan}

Plan metadata:
${jsonDump(latestMeta).trim()}

Gate summary:
${jsonDump(gate).trim()}

${approvalNote}
Robustness level: ${robustness}.

Requirements:
- Implement the intent, not just the text.
- Adapt if repository reality contradicts the plan.
- Report deviations explicitly.
- Output concrete files changed and commands run.
`.trim();
}

function reviewClaudePrompt(state: PlanState, planDir: string): string {
  const projectDir = state.config.project_dir;
  const latestPlan = fs.readFileSync(
    latestPlanPath(planDir, state),
    "utf-8"
  );
  const latestMeta = readJson(latestPlanMetaPath(planDir, state));
  const execution = readJson(path.join(planDir, "execution.json"));
  const gate = readJson(path.join(planDir, "gate.json"));
  const diffSummary = collectGitDiffSummary(projectDir ?? process.cwd());
  return `
Review the execution critically against user intent and observable success criteria.

Project directory:
${projectDir}

${intentAndNotesBlock(state)}

Approved plan:
${latestPlan}

Plan metadata:
${jsonDump(latestMeta).trim()}

Gate summary:
${jsonDump(gate).trim()}

Execution summary:
${jsonDump(execution).trim()}

Git diff summary:
${diffSummary}

Requirements:
- Judge against the success criteria, not plan elegance.
- Be critical and call out real misses.
- If there are failures, describe them as issues.
`.trim();
}

function reviewCodexPrompt(state: PlanState, planDir: string): string {
  const projectDir = state.config.project_dir;
  const latestPlan = fs.readFileSync(
    latestPlanPath(planDir, state),
    "utf-8"
  );
  const latestMeta = readJson(latestPlanMetaPath(planDir, state));
  const execution = readJson(path.join(planDir, "execution.json"));
  const diffSummary = collectGitDiffSummary(projectDir ?? process.cwd());
  return `
Review the implementation against the success criteria.

Project directory:
${projectDir}

${intentAndNotesBlock(state)}

Approved plan:
${latestPlan}

Plan metadata:
${jsonDump(latestMeta).trim()}

Execution summary:
${jsonDump(execution).trim()}

Git diff summary:
${diffSummary}

Requirements:
- Be critical.
- Verify each success criterion explicitly.
- Call out any concrete gaps or regressions in issues.
`.trim();
}

// Step-to-builder dispatch tables per agent.
// Steps shared across agents point to the same builder function.
export const CLAUDE_PROMPT_BUILDERS: Record<
  string,
  (state: PlanState, planDir: string) => string
> = {
  clarify: clarifyPrompt,
  plan: planPrompt,
  integrate: integratePrompt,
  critique: critiquePrompt,
  execute: executePrompt,
  review: reviewClaudePrompt,
};

export const CODEX_PROMPT_BUILDERS: Record<
  string,
  (state: PlanState, planDir: string) => string
> = {
  clarify: clarifyPrompt,
  plan: planPrompt,
  integrate: integratePrompt,
  critique: critiquePrompt,
  execute: executePrompt,
  review: reviewCodexPrompt,
};

export function createPrompt(
  step: string,
  agent: string,
  state: PlanState,
  planDir: string
): string {
  const builders =
    agent === "codex" ? CODEX_PROMPT_BUILDERS : CLAUDE_PROMPT_BUILDERS;
  const builder = builders[step];
  if (!builder) {
    throw new GigaplanError(
      "unsupported_step",
      `Unsupported ${agent} step '${step}'`
    );
  }
  return builder(state, planDir);
}
