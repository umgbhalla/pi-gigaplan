import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import gigaplanExtension from "../extensions/index.js";

function createExtensionHarness() {
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const sentMessages: string[] = [];

  gigaplanExtension({
    registerTool(tool: any) {
      tools.set(tool.name, tool);
    },
    registerCommand(name: string, command: any) {
      commands.set(name, command);
    },
    sendUserMessage(message: string) {
      sentMessages.push(message);
    },
  } as any);

  return { tools, commands, sentMessages };
}

async function initPlan(root: string) {
  const harness = createExtensionHarness();
  const gigaplan = harness.commands.get("gigaplan");
  expect(gigaplan).toBeTruthy();

  await gigaplan.handler("Build a deployable daemon", {
    cwd: root,
    ui: {
      select: async () => "Standard — balanced (default)",
      confirm: async () => false,
      notify: () => {},
      setStatus: () => {},
    },
  });

  const plansRoot = path.join(root, ".gigaplan", "plans");
  const [planName] = fs.readdirSync(plansRoot);
  const planDir = path.join(plansRoot, planName);

  return { ...harness, planDir };
}

describe("gigaplan orchestration", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "gigaplan-ext-"));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("does not crash when called without ctx.ui after a plan was initialized", async () => {
    const { tools, planDir } = await initPlan(root);

    fs.writeFileSync(
      path.join(planDir, "clarify_output.json"),
      JSON.stringify({
        questions: [],
        refined_idea: "Build a deployable daemon",
        intent_summary: "Build a deployable daemon",
      }, null, 2),
    );

    const advance = tools.get("gigaplan_advance");
    const result = await advance.execute("test", { planDir, step: "clarify" });

    expect(result.details?.error).toBeFalsy();
    expect(result.details?.step).toBe("clarify");
  });

  it("guides critique subagents toward the required flags schema", async () => {
    const { tools, planDir } = await initPlan(root);
    const stepTool = tools.get("gigaplan_step");

    fs.writeFileSync(
      path.join(planDir, "clarify_output.json"),
      JSON.stringify({
        questions: [],
        refined_idea: "Build a deployable daemon",
        intent_summary: "Build a deployable daemon",
      }, null, 2),
    );
    await tools.get("gigaplan_advance").execute("test", { planDir, step: "clarify" });

    fs.writeFileSync(
      path.join(planDir, "plan_output.json"),
      JSON.stringify({
        plan: "# Plan\n\nImplement the daemon.",
        questions: [],
        success_criteria: ["Daemon starts"],
        assumptions: ["Linux host"],
      }, null, 2),
    );
    await tools.get("gigaplan_advance").execute("test", { planDir, step: "plan" });

    const stepResult = await stepTool.execute("test", { planDir, step: "critique" });
    const task = stepResult.details?.task as string;

    expect(task).toContain("Top-level keys: `flags`, `verified_flag_ids`, `disputed_flag_ids`.");
    expect(task).toContain("Use `flags`, not `significant_issues`");
  });

  it("advances through clarify, plan, critique, evaluate, and gate with expected next steps", async () => {
    const { tools, planDir, sentMessages } = await initPlan(root);
    const advance = tools.get("gigaplan_advance");

    expect(sentMessages[0]).toContain("Start now with the **clarify** step.");

    fs.writeFileSync(
      path.join(planDir, "clarify_output.json"),
      JSON.stringify({
        questions: [],
        refined_idea: "Build a deployable daemon",
        intent_summary: "Build a deployable daemon",
      }, null, 2),
    );
    const clarify = await advance.execute("test", { planDir, step: "clarify" });
    expect(clarify.details?.nextSteps).toEqual(["plan"]);

    fs.writeFileSync(
      path.join(planDir, "plan_output.json"),
      JSON.stringify({
        plan: "# Plan\n\nImplement the daemon.",
        questions: [],
        success_criteria: ["Daemon starts"],
        assumptions: ["Linux host"],
      }, null, 2),
    );
    const plan = await advance.execute("test", { planDir, step: "plan" });
    expect(plan.details?.nextSteps).toEqual(["critique"]);

    fs.writeFileSync(
      path.join(planDir, "critique_output.json"),
      JSON.stringify({
        flags: [],
        verified_flag_ids: [],
        disputed_flag_ids: [],
      }, null, 2),
    );
    const critique = await advance.execute("test", { planDir, step: "critique" });
    expect(critique.details?.nextSteps).toEqual(["evaluate"]);

    const evaluate = await advance.execute("test", { planDir, step: "evaluate" });
    expect(evaluate.details?.nextSteps).toEqual(["gate"]);

    const gate = await advance.execute("test", { planDir, step: "gate" });
    expect(gate.details?.nextSteps).toEqual(["execute"]);
  });
});
