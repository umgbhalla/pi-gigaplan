import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { PlanState } from "../src/core.js";
import { buildStepDetails, formatDuration } from "../src/presentation/step-details.js";

function createState(overrides: Partial<PlanState> = {}): PlanState {
  return {
    name: "demo-plan",
    idea: "Build a deployable daemon",
    current_state: "planned",
    iteration: 1,
    created_at: "2026-03-31T00:00:00Z",
    config: {},
    sessions: {},
    plan_versions: [],
    history: [],
    meta: {},
    last_evaluation: {},
    ...overrides,
  };
}

describe("formatDuration", () => {
  it("formats seconds and minutes", () => {
    expect(formatDuration(45_000)).toBe("45s");
    expect(formatDuration(134_000)).toBe("2m 14s");
  });

  it("formats empty and hour durations", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(3_720_000)).toBe("1h 2m");
  });
});

describe("buildStepDetails", () => {
  let planDir: string;

  beforeEach(() => {
    planDir = fs.mkdtempSync(path.join(os.tmpdir(), "gigaplan-step-details-"));
  });

  afterEach(() => {
    fs.rmSync(planDir, { recursive: true, force: true });
  });

  it("builds clarify details from state clarification", () => {
    const state = createState({
      iteration: 0,
      clarification: {
        intent_summary: "Ship a small daemon",
        refined_idea: "Build a daemon that can be deployed",
        questions: [{ question: "Target OS?", context: "Packaging" }],
      },
    });

    const details = buildStepDetails("clarify", planDir, state, { success: true, summary: "Clarified: Ship a small daemon" }, 14_000);

    expect(details.version).toBe(0);
    expect(details.durationFormatted).toBe("14s");
    expect(details.clarify).toEqual({
      intentSummary: "Ship a small daemon",
      questionCount: 1,
      refinedIdea: "Build a daemon that can be deployed",
    });
  });

  it("reads plan metadata counts for plan and integrate steps", () => {
    fs.writeFileSync(
      path.join(planDir, "plan_v2.meta.json"),
      JSON.stringify({
        success_criteria: ["Starts", "Deploys"],
        assumptions: ["Linux", "Systemd"],
        questions: ["Need logs?"],
      }, null, 2),
    );

    const state = createState({ iteration: 2 });
    const details = buildStepDetails("integrate", planDir, state, { success: true, summary: "Plan v2 created" }, 5_000);

    expect(details.plan).toEqual({
      criteriaCount: 2,
      assumptionCount: 2,
      questionCount: 1,
    });
  });

  it("enriches critique flags with registry status and severity", () => {
    fs.writeFileSync(
      path.join(planDir, "critique_v1.json"),
      JSON.stringify({
        flags: [
          {
            id: "FLAG-1",
            concern: "Missing retry handling",
            severity_hint: "likely-significant",
          },
        ],
        verified_flag_ids: ["FLAG-0"],
        disputed_flag_ids: [],
      }, null, 2),
    );
    fs.writeFileSync(
      path.join(planDir, "faults.json"),
      JSON.stringify({
        flags: [
          {
            id: "FLAG-1",
            concern: "Missing retry handling",
            status: "open",
            severity: "significant",
          },
        ],
      }, null, 2),
    );

    const details = buildStepDetails("critique", planDir, createState(), { success: true, summary: "Critique complete" }, 9_000);

    expect(details.critique).toEqual({
      flags: [
        {
          id: "FLAG-1",
          concern: "Missing retry handling",
          severity: "significant",
          status: "open",
        },
      ],
      verifiedCount: 1,
      newCount: 1,
    });
  });

  it("reads evaluation and gate artifacts", () => {
    fs.writeFileSync(
      path.join(planDir, "evaluation_v1.json"),
      JSON.stringify({
        recommendation: "SKIP",
        confidence: "high",
        rationale: "No unresolved significant flags remain.",
        signals: { weighted_score: 0 },
      }, null, 2),
    );
    fs.writeFileSync(
      path.join(planDir, "gate.json"),
      JSON.stringify({
        passed: false,
        preflight_results: {
          project_exists: true,
          no_unresolved_flags: false,
        },
        unresolved_flags: [{ id: "FLAG-1" }],
      }, null, 2),
    );

    const state = createState();
    const evaluate = buildStepDetails("evaluate", planDir, state, { success: true, summary: "Evaluation complete" }, 0);
    const gate = buildStepDetails("gate", planDir, state, { success: false, summary: "Gate failed" }, 3_000);

    expect(evaluate.evaluate).toEqual({
      recommendation: "SKIP",
      confidence: "high",
      weightedScore: 0,
      rationale: "No unresolved significant flags remain.",
    });
    expect(gate.success).toBe(false);
    expect(gate.gate).toEqual({
      passed: false,
      checks: {
        project_exists: true,
        no_unresolved_flags: false,
      },
      unresolvedCount: 1,
    });
  });

  it("reads execution and review artifacts", () => {
    fs.writeFileSync(
      path.join(planDir, "execution.json"),
      JSON.stringify({
        output: "Done",
        files_changed: ["src/a.ts", "src/b.ts"],
        commands_run: ["npm test"],
        deviations: ["Used existing API"],
      }, null, 2),
    );
    fs.writeFileSync(
      path.join(planDir, "review.json"),
      JSON.stringify({
        criteria: [
          { name: "Build passes", pass: true, evidence: "npm test" },
          { name: "No regressions", pass: false, evidence: "Missing case" },
        ],
        issues: ["Missing edge case"],
        summary: "One issue found",
      }, null, 2),
    );

    const state = createState();
    const execute = buildStepDetails("execute", planDir, state, { success: true, summary: "Executed" }, 12_000);
    const review = buildStepDetails("review", planDir, state, { success: true, summary: "Reviewed" }, 7_000);

    expect(execute.execute).toEqual({
      filesChanged: 2,
      commandsRun: 1,
      deviations: 1,
    });
    expect(review.review).toEqual({
      criteriaResults: [
        { name: "Build passes", pass: true },
        { name: "No regressions", pass: false },
      ],
      issueCount: 1,
    });
  });

  it("returns partial data when artifacts are missing", () => {
    const details = buildStepDetails("execute", planDir, createState(), { success: true, summary: "Executed" }, 1_000);

    expect(details.summary).toBe("Executed");
    expect(details.execute).toEqual({
      filesChanged: 0,
      commandsRun: 0,
      deviations: 0,
    });
  });
});
