import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs";
import { validatePayload, buildSubagentTask, parseStepOutput, repairStepOutputFile } from "../src/workers.js";
import { GigaplanError } from "../src/core.js";
import type { PlanState } from "../src/core.js";

const mockState: PlanState = {
  name: "test-plan",
  idea: "Build a test plan",
  current_state: "planned",
  iteration: 1,
  created_at: "2026-01-01T00:00:00Z",
  config: { max_iterations: 3, budget_usd: 25 },
  sessions: {},
  plan_versions: [{ version: 1, file: "plan_v1.md", hash: "sha256:abc", timestamp: "2026-01-01T00:00:00Z" }],
  history: [],
  meta: {},
  last_evaluation: {},
};

describe("validatePayload", () => {
  it("does not throw for valid payload", () => {
    const payload = { questions: [], refined_idea: "x", intent_summary: "y" };
    expect(() => validatePayload("clarify", payload)).not.toThrow();
  });

  it("throws GigaplanError for missing keys", () => {
    const payload = { questions: [] };
    expect(() => validatePayload("clarify", payload)).toThrow(GigaplanError);
  });

  it("includes missing key names in error message", () => {
    const payload = {};
    try {
      validatePayload("plan", payload);
      expect.fail("should have thrown");
    } catch (e) {
      expect((e as Error).message).toContain("plan");
    }
  });

  it("rejects wrong top-level types with a clear error", () => {
    const payload = { plan: [], questions: [], success_criteria: [], assumptions: [] };
    expect(() => validatePayload("plan", payload as any)).toThrow(/plan must be a string, got array/);
  });

  it("rejects wrong nested item types with a clear error", () => {
    const payload = { plan: "ok", questions: [123], success_criteria: [], assumptions: [] };
    expect(() => validatePayload("plan", payload as any)).toThrow(/questions\[0\] must be a string, got number/);
  });

  it("does nothing for unknown step", () => {
    expect(() => validatePayload("unknown-step", {})).not.toThrow();
  });
});

describe("buildSubagentTask", () => {
  const planDir = "/tmp/gigaplan-test-plan";

  beforeAll(() => {
    fs.mkdirSync(planDir, { recursive: true });
    fs.writeFileSync(path.join(planDir, "plan_v1.md"), "# Test Plan\n\nSome content.");
    fs.writeFileSync(path.join(planDir, "state.json"), JSON.stringify(mockState, null, 2));
  });

  afterAll(() => {
    fs.rmSync(planDir, { recursive: true, force: true });
  });

  it("returns a string containing the step name", () => {
    const outputPath = path.join(planDir, "clarify_output.json");
    const task = buildSubagentTask("clarify", mockState, planDir, outputPath);
    expect(typeof task).toBe("string");
    expect(task).toContain("clarify");
  });

  it("includes the output path in the task", () => {
    const outputPath = "/tmp/some-output.json";
    const task = buildSubagentTask("plan", mockState, planDir, outputPath);
    expect(task).toContain(outputPath);
  });
});

describe("parseStepOutput", () => {
  it("parses valid JSON from file", () => {
    const tmpFile = path.join("/tmp", `parse-test-${process.pid}.json`);
    const payload = { plan: "do stuff", questions: [], success_criteria: [], assumptions: [] };
    fs.writeFileSync(tmpFile, JSON.stringify(payload, null, 2));
    const result = parseStepOutput("plan", tmpFile);
    expect(result).toEqual(payload);
    fs.unlinkSync(tmpFile);
  });

  it("throws if file does not exist", () => {
    expect(() => parseStepOutput("plan", "/tmp/nonexistent-12345.json")).toThrow(GigaplanError);
  });

  it("throws if file is empty", () => {
    const tmpFile = path.join("/tmp", `empty-test-${process.pid}.json`);
    fs.writeFileSync(tmpFile, "");
    expect(() => parseStepOutput("plan", tmpFile)).toThrow(GigaplanError);
    fs.unlinkSync(tmpFile);
  });

  it("strips markdown fences before parsing", () => {
    const tmpFile = path.join("/tmp", `fenced-test-${process.pid}.json`);
    const payload = { plan: "fenced plan", questions: [], success_criteria: [], assumptions: [] };
    const fenced = "```json\n" + JSON.stringify(payload) + "\n```";
    fs.writeFileSync(tmpFile, fenced);
    const result = parseStepOutput("plan", tmpFile);
    expect(result["plan"]).toBe("fenced plan");
    fs.unlinkSync(tmpFile);
  });

  it("extracts JSON from surrounding prose", () => {
    const tmpFile = path.join("/tmp", `prose-test-${process.pid}.json`);
    const payload = { plan: "embedded plan", questions: [], success_criteria: [], assumptions: [] };
    fs.writeFileSync(tmpFile, `Here is the result:\n${JSON.stringify(payload, null, 2)}\nDone.`);
    const result = parseStepOutput("plan", tmpFile);
    expect(result["plan"]).toBe("embedded plan");
    fs.unlinkSync(tmpFile);
  });

  it("repairs parseable but non-canonical output files", () => {
    const tmpFile = path.join("/tmp", `repair-test-${process.pid}.json`);
    const payload = { plan: "repair me", questions: [], success_criteria: [], assumptions: [] };
    fs.writeFileSync(tmpFile, `Sure:\n\n${JSON.stringify(payload)}\nDone.`);
    const result = repairStepOutputFile("plan", tmpFile);
    expect(result.repaired).toBe(true);
    expect(JSON.parse(fs.readFileSync(tmpFile, "utf8"))["plan"]).toBe("repair me");
    fs.unlinkSync(tmpFile);
  });
});
