#!/usr/bin/env npx tsx
/**
 * Demo CLI — renders gigaplan TUI components with mock data.
 * Run: npx tsx demo.ts
 */

import { GigaplanHeader } from "./src/presentation/header.js";
import { createStepPanelRenderer } from "./src/presentation/step-panel.js";
import type { GigaplanViewModel } from "./src/presentation/index.js";

// ── Mock theme that outputs real ANSI ──

const COLORS: Record<string, string> = {
  text: "\x1b[37m",
  accent: "\x1b[36m",
  success: "\x1b[32m",
  warning: "\x1b[33m",
  error: "\x1b[31m",
  dim: "\x1b[90m",
  muted: "\x1b[90m",
  borderMuted: "\x1b[90m",
  toolTitle: "\x1b[1;36m",
  border: "\x1b[90m",
  borderAccent: "\x1b[36m",
};

const RST = "\x1b[0m";

const theme: any = {
  fg(color: string, text: string) {
    return `${COLORS[color] ?? ""}${text}${RST}`;
  },
  bg(color: string, text: string) {
    return text;
  },
  bold(text: string) {
    return `\x1b[1m${text}${RST}`;
  },
  italic(text: string) {
    return `\x1b[3m${text}${RST}`;
  },
  strikethrough(text: string) {
    return `\x1b[9m${text}${RST}`;
  },
  underline(text: string) {
    return `\x1b[4m${text}${RST}`;
  },
};

// ── Mock view models at different stages ──

const vmInitialized: GigaplanViewModel = {
  name: "auth-middleware-refactor",
  planDir: ".gigaplan/plans/auth-middleware-refactor",
  totalPlans: 1,
  focusIndex: 1,
  state: "initialized",
  stateColor: "accent",
  nextStep: "clarify",
  iteration: 0,
  totalFlags: 0,
  verifiedFlags: 0,
  openSignificant: 0,
  openMinor: 0,
  addressedFlags: 0,
  recommendation: null,
  recColor: "muted",
  confidence: null,
  weightedScore: null,
  prevScore: null,
  scoreDelta: null,
  deltaColor: "muted",
  stepHistory: [],
  lastStepDuration: null,
  iterations: [],
  recovery: null,
};

const vmAfterCritique: GigaplanViewModel = {
  ...vmInitialized,
  state: "critiqued",
  stateColor: "warning",
  nextStep: "evaluate",
  iteration: 1,
  totalFlags: 5,
  verifiedFlags: 0,
  openSignificant: 2,
  openMinor: 3,
  addressedFlags: 0,
  stepHistory: ["clarify", "plan", "critique"],
  lastStepDuration: 208000,
};

const vmAfterEvaluate: GigaplanViewModel = {
  ...vmAfterCritique,
  state: "evaluated",
  stateColor: "warning",
  nextStep: "gate",
  recommendation: "SKIP",
  recColor: "success",
  confidence: "medium",
  weightedScore: 1.5,
  prevScore: 3.5,
  scoreDelta: "↓57%",
  deltaColor: "success",
  stepHistory: ["clarify", "plan", "critique", "evaluate"],
  iterations: [
    { version: 1, recommendation: "CONTINUE", recColor: "warning", confidence: "high", score: "3.5", scoreColor: "error", sigFlags: "2 open", sigColor: "error", delta: "—", deltaColor: "muted", newFlags: 3, verifiedFlags: 0, addressedFlags: 0, raisedFlags: 3 },
    { version: 2, recommendation: "SKIP", recColor: "success", confidence: "medium", score: "1.5", scoreColor: "success", sigFlags: "1 open", sigColor: "warning", delta: "↓57%", deltaColor: "success", newFlags: 2, verifiedFlags: 3, addressedFlags: 2, raisedFlags: 2 },
  ],
};

const vmGated: GigaplanViewModel = {
  ...vmAfterEvaluate,
  state: "gated",
  stateColor: "success",
  nextStep: "execute",
  stepHistory: ["clarify", "plan", "critique", "evaluate", "gate"],
};

const vmDone: GigaplanViewModel = {
  ...vmGated,
  state: "done",
  stateColor: "success",
  nextStep: null,
  stepHistory: ["clarify", "plan", "critique", "evaluate", "gate", "execute", "review"],
};

const vmMultiPlan: GigaplanViewModel = {
  ...vmAfterEvaluate,
  totalPlans: 3,
  focusIndex: 1,
};

// ── Step panel mock messages ──

const stepMessages = [
  {
    content: "Clarified intent",
    details: { step: "clarify", version: 1, duration: 134000, intent_summary: "Refactor auth middleware to use JWT validation with role-based access control", questions: [1, 2, 3], refined_idea: "Replace session-based auth with stateless JWT tokens, add RBAC middleware layer" },
  },
  {
    content: "Plan created",
    details: { step: "plan", version: 1, duration: 242000, success_criteria: [1, 2, 3, 4, 5], assumptions: [1, 2, 3], questions: [1, 2] },
  },
  {
    content: "Critique complete",
    details: {
      step: "critique", version: 1, duration: 208000,
      flags: [
        { concern: "JWT secret rotation strategy not addressed", severity: "significant", status: "open" },
        { concern: "Missing rate limiting on token refresh endpoint", severity: "significant", status: "open" },
        { concern: "Error response format inconsistency", severity: "minor", status: "open" },
      ],
      verified_flag_ids: [],
    },
  },
  {
    content: "Evaluation complete",
    details: { step: "evaluate", version: 1, duration: 50, recommendation: "SKIP", confidence: "medium", score: 1.5, delta: -57, signals: { weighted_score: 1.5 } },
  },
  {
    content: "Gate passed",
    details: { step: "gate", version: 2, duration: 30, preflight_results: { project_exists: true, project_writable: true, plan_exists: true, has_success_criteria: true, no_unresolved_flags: true } },
  },
  {
    content: "Execution complete",
    details: { step: "execute", version: 2, duration: 540000, files_changed: ["src/auth/jwt.ts", "src/auth/rbac.ts", "src/middleware/auth.ts", "tests/auth.test.ts"], deviations: ["Added rate limiting middleware not in original plan"] },
  },
  {
    content: "Review complete",
    details: {
      step: "review", version: 2, duration: 180000,
      criteria: [
        { name: "JWT validation works for all routes", pass: true },
        { name: "Role-based access control enforced", pass: true },
        { name: "Token refresh endpoint secured", pass: true },
        { name: "Backwards compatibility maintained", pass: false },
      ],
      issues: ["Legacy session endpoints still referenced in 2 files"],
    },
  },
];

// ── Render ──

const width = Math.min(process.stdout.columns ?? 100, 120);

function hr() {
  console.log("");
}

function section(title: string) {
  hr();
  console.log(`${theme.fg("accent", "━".repeat(width))}`);
  console.log(`${theme.fg("accent", theme.bold(`  ${title}`))}`);
  console.log(`${theme.fg("accent", "━".repeat(width))}`);
  hr();
}

// 1. Headers at different states
section("HEADER — initialized");
const h1 = new GigaplanHeader(theme);
h1.setViewModel(vmInitialized);
h1.render(width).forEach((line) => console.log(line));

section("HEADER — after critique (iter 1)");
const h2 = new GigaplanHeader(theme);
h2.setViewModel(vmAfterCritique);
h2.render(width).forEach((line) => console.log(line));

section("HEADER — evaluated → gate (iter 2, SKIP)");
const h3 = new GigaplanHeader(theme);
h3.setViewModel(vmAfterEvaluate);
h3.render(width).forEach((line) => console.log(line));

section("HEADER — gated → execute");
const h4 = new GigaplanHeader(theme);
h4.setViewModel(vmGated);
h4.render(width).forEach((line) => console.log(line));

section("HEADER — done");
const h5 = new GigaplanHeader(theme);
h5.setViewModel(vmDone);
h5.render(width).forEach((line) => console.log(line));

section("HEADER — multi-plan (1 of 3)");
const h6 = new GigaplanHeader(theme);
h6.setViewModel(vmMultiPlan);
h6.render(width).forEach((line) => console.log(line));

// 2. Step panels
section("STEP PANELS — full pipeline");

const renderer = createStepPanelRenderer(theme);
for (const msg of stepMessages) {
  const component = renderer(msg as any, { expanded: true } as any, theme);
  const lines = component.render(width);
  for (const line of lines) {
    console.log(line);
  }
  console.log("");
}

// 3. Widget mockup
section("WIDGET — above editor (wide terminal)");

import { buildWidgetLines } from "./src/presentation/index.js";
const widgetLines = buildWidgetLines(vmAfterEvaluate, theme, width);
for (const line of widgetLines) {
  console.log(line);
}

hr();
console.log(theme.fg("dim", "  (editor input area would be here)"));
hr();

// 4. Full composed view
section("FULL VIEW — header + panels + widget + editor");

const headerFull = new GigaplanHeader(theme);
headerFull.setViewModel(vmGated);
headerFull.render(width).forEach((line) => console.log(line));
console.log("");

// Show a few panels
for (const msg of stepMessages.slice(0, 4)) {
  const component = renderer(msg as any, { expanded: false } as any, theme);
  component.render(width).forEach((line) => console.log(line));
  console.log("");
}

console.log("");
const wl = buildWidgetLines(vmGated, theme, width);
for (const line of wl) {
  console.log(line);
}
console.log("");
console.log(theme.fg("dim", `  > █`));
console.log("");
console.log(theme.fg("dim", `${"─".repeat(width)}`));
console.log(`${theme.fg("accent", "claude-opus-4-6")} ${theme.fg("dim", "│")} ${theme.fg("dim", "117/60.6k")} ${theme.fg("success", "$10.47")} ${theme.fg("dim", "│ ⎇ main")}`);
