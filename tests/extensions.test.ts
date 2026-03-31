import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import gigaplanExtension from "../extensions/index.js";

function createExtensionHarness() {
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const eventHandlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
  const messageRenderers = new Map<string, any>();
  const sentUserMessages: Array<{ message: string; options?: { deliverAs?: string } }> = [];
  const sentMessages: Array<{ message: any; options?: { deliverAs?: string; triggerTurn?: boolean } }> = [];

  gigaplanExtension({
    on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
      const handlers = eventHandlers.get(event) ?? [];
      handlers.push(handler);
      eventHandlers.set(event, handlers);
    },
    registerTool(tool: any) {
      tools.set(tool.name, tool);
    },
    registerCommand(name: string, command: any) {
      commands.set(name, command);
    },
    registerMessageRenderer(type: string, renderer: any) {
      messageRenderers.set(type, renderer);
    },
    sendUserMessage(message: string, options?: { deliverAs?: string }) {
      sentUserMessages.push({ message, options });
    },
    sendMessage(message: any, options?: { deliverAs?: string; triggerTurn?: boolean }) {
      sentMessages.push({ message, options });
    },
  } as any);

  return { tools, commands, eventHandlers, messageRenderers, sentUserMessages, sentMessages };
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

  it("initializes via tool for self-started agent flows", async () => {
    const harness = createExtensionHarness();
    const init = harness.tools.get("gigaplan_init");
    expect(init).toBeTruthy();

    const result = await init.execute("test", {
      idea: "Build a deployable daemon",
      autoApprove: true,
      robustness: "standard",
    }, undefined, undefined, {
      cwd: root,
      ui: {
        notify: () => {},
        setStatus: () => {},
      },
    });

    expect(result.details?.error).toBeFalsy();
    expect(result.details?.planName).toBe("build-a-deployable-daemon");
    expect(result.details?.promptQueued).toBe(true);
    expect(harness.sentUserMessages[0]?.message).toContain("Start now with the **clarify** step.");
    expect(harness.sentUserMessages[0]?.options?.deliverAs).toBe("steer");
    expect(harness.sentMessages[0]?.message.customType).toBe("gigaplan-step");
    expect(harness.sentMessages[0]?.message.details?.step).toBe("init");
    expect(fs.existsSync(path.join(root, ".gigaplan", "plans", "build-a-deployable-daemon", "state.json"))).toBe(true);
  });

  it("registers the gigaplan step renderer", () => {
    const harness = createExtensionHarness();
    expect(harness.messageRenderers.has("gigaplan-step")).toBe(true);
  });

  it("sends a custom step message after advance", async () => {
    const { tools, planDir, sentMessages } = await initPlan(root);

    fs.writeFileSync(
      path.join(planDir, "clarify_output.json"),
      JSON.stringify({
        questions: [],
        refined_idea: "Build a deployable daemon",
        intent_summary: "Build a deployable daemon",
      }, null, 2),
    );

    await tools.get("gigaplan_advance").execute("test", { planDir, step: "clarify", durationMs: 2500 });

    expect(sentMessages.at(-1)?.message.customType).toBe("gigaplan-step");
    expect(sentMessages.at(-1)?.message.details?.step).toBe("clarify");
    expect(sentMessages.at(-1)?.message.details?.durationMs).toBe(2500);
    expect(sentMessages.at(-1)?.options?.triggerTurn).toBe(false);
  });

  it("restores active plan status on session_start", async () => {
    const { eventHandlers, planDir } = await initPlan(root);
    const setStatusCalls: Array<{ key: string; text: string | undefined }> = [];

    fs.writeFileSync(
      path.join(planDir, "state.json"),
      JSON.stringify({
        ...JSON.parse(fs.readFileSync(path.join(planDir, "state.json"), "utf8")),
        current_state: "planned",
      }, null, 2),
    );

    const sessionStart = eventHandlers.get("session_start")?.[0];
    expect(sessionStart).toBeTruthy();
    await sessionStart?.({}, {
      cwd: root,
      ui: {
        setStatus(key: string, text: string | undefined) {
          setStatusCalls.push({ key, text });
        },
      },
    });

    expect(setStatusCalls.at(-1)?.key).toBe("gigaplan");
    expect(setStatusCalls.at(-1)?.text).toContain("→ critique");
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

  it("updates the widget with the persisted plan state after advancing", async () => {
    const { tools, planDir } = await initPlan(root);
    const setStatusCalls: Array<{ key: string; text: string | undefined }> = [];

    fs.writeFileSync(
      path.join(planDir, "clarify_output.json"),
      JSON.stringify({
        questions: [],
        refined_idea: "Build a deployable daemon",
        intent_summary: "Build a deployable daemon",
      }, null, 2),
    );

    const advance = tools.get("gigaplan_advance");
    const result = await advance.execute("test", { planDir, step: "clarify" }, undefined, undefined, {
      cwd: root,
      ui: {
        setStatus(key: string, text: string | undefined) {
          setStatusCalls.push({ key, text });
        },
      },
    });

    expect(result.details?.error).toBeFalsy();
    expect(setStatusCalls.at(-1)?.key).toBe("gigaplan");
    expect(setStatusCalls.at(-1)?.text).toContain("clarified");
    expect(setStatusCalls.at(-1)?.text).toContain("→ plan");
    expect(setStatusCalls.at(-1)?.text).not.toContain("→ clarify");
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

  it("rejects out-of-order steps before mutating plan state", async () => {
    const { tools, planDir } = await initPlan(root);

    fs.writeFileSync(
      path.join(planDir, "plan_output.json"),
      JSON.stringify({
        plan: "# Plan\n\nImplement the daemon.",
        questions: [],
        success_criteria: ["Daemon starts"],
        assumptions: ["Linux host"],
      }, null, 2),
    );

    const stepResult = await tools.get("gigaplan_step").execute("test", { planDir, step: "plan" });
    expect(stepResult.details?.error).toBe(true);
    expect(stepResult.content[0].text).toContain('Step "plan" is not valid from state initialized');

    const advanceResult = await tools.get("gigaplan_advance").execute("test", { planDir, step: "plan" });
    expect(advanceResult.details?.error).toBe(true);
    expect(advanceResult.content[0].text).toContain('Step "plan" is not valid from state initialized');
  });

  it("advances through clarify, plan, critique, evaluate, and gate with expected next steps", async () => {
    const { tools, planDir, sentUserMessages, sentMessages } = await initPlan(root);
    const advance = tools.get("gigaplan_advance");

    expect(sentUserMessages[0]?.message).toContain("Start now with the **clarify** step.");
    expect(sentUserMessages[0]?.options?.deliverAs).toBe("steer");
    expect(sentMessages[0]?.message.details?.step).toBe("init");

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

  it("routes failed gate checks back to integrate", async () => {
    const { tools, planDir } = await initPlan(root);
    const advance = tools.get("gigaplan_advance");
    const stepTool = tools.get("gigaplan_step");

    fs.writeFileSync(
      path.join(planDir, "clarify_output.json"),
      JSON.stringify({
        questions: [],
        refined_idea: "Build a deployable daemon",
        intent_summary: "Build a deployable daemon",
      }, null, 2),
    );
    await advance.execute("test", { planDir, step: "clarify" });

    fs.writeFileSync(
      path.join(planDir, "plan_output.json"),
      JSON.stringify({
        plan: "# Plan\n\nImplement the daemon.",
        questions: [],
        success_criteria: [],
        assumptions: ["Linux host"],
      }, null, 2),
    );
    await advance.execute("test", { planDir, step: "plan" });

    fs.writeFileSync(
      path.join(planDir, "critique_output.json"),
      JSON.stringify({
        flags: [],
        verified_flag_ids: [],
        disputed_flag_ids: [],
      }, null, 2),
    );
    await advance.execute("test", { planDir, step: "critique" });
    await advance.execute("test", { planDir, step: "evaluate" });

    const gate = await advance.execute("test", { planDir, step: "gate" });
    expect(gate.details?.nextSteps).toEqual(["integrate"]);

    const integrateStep = await stepTool.execute("test", { planDir, step: "integrate" });
    expect(integrateStep.details?.error).toBeFalsy();
  });

  it("doctor repairs parseable next-step output and returns recovery config", async () => {
    const { tools, planDir } = await initPlan(root);

    fs.writeFileSync(
      path.join(planDir, "clarify_output.json"),
      `Here is the output:\n${JSON.stringify({
        questions: [],
        refined_idea: "Build a deployable daemon",
        intent_summary: "Build a deployable daemon",
      })}\nDone.`,
    );

    const doctor = await tools.get("gigaplan_doctor").execute("test", { fix: true }, undefined, undefined, { cwd: root });
    expect(doctor.details?.issues.length).toBe(0);
    expect(doctor.details?.fixes[0]).toContain("clarify_output.json");
    expect(doctor.details?.nextStep).toBe("clarify");
    expect(doctor.details?.nextStepConfig?.outputPath).toContain("clarify_output.json");

    const normalized = JSON.parse(fs.readFileSync(path.join(planDir, "clarify_output.json"), "utf8"));
    expect(normalized.intent_summary).toBe("Build a deployable daemon");
  });

  it("rejects skip override before evaluation", async () => {
    const { tools, planDir } = await initPlan(root);
    const result = await tools.get("gigaplan_override").execute("test", { planDir, action: "skip" });

    expect(result.details?.error).toBe(true);
    expect(result.content[0].text).toContain("Expected state evaluated");
  });
});
