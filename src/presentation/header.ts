import type { Theme } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import type { Component } from "@mariozechner/pi-tui";

interface TuiLike {
  requestRender: (force?: boolean) => void;
}

import type { GigaplanViewModel } from "./index.js";

type PipelineStep = "clarify" | "plan" | "critique" | "evaluate" | "gate" | "execute" | "review";

const PIPELINE_STEPS: PipelineStep[] = ["clarify", "plan", "critique", "evaluate", "gate", "execute", "review"];

const DISPLAY_LABELS: Record<PipelineStep, string> = {
  clarify: "clarify",
  plan: "plan",
  critique: "critique",
  evaluate: "evaluate",
  gate: "gate",
  execute: "exec",
  review: "review",
};

function historyStepIndex(vm: GigaplanViewModel): number {
  let index = -1;

  for (const step of vm.stepHistory) {
    const stepIndex = PIPELINE_STEPS.indexOf(step as PipelineStep);
    if (stepIndex > index) {
      index = stepIndex;
    }
  }

  return index;
}

function currentStep(vm: GigaplanViewModel): PipelineStep | null {
  switch (vm.state) {
    case "initialized":
      return "clarify";
    case "clarified":
      return "plan";
    case "planned":
      return "critique";
    case "critiqued":
      return "evaluate";
    case "evaluated":
      return vm.nextStep === "gate" ? "gate" : "evaluate";
    case "gated":
      return "execute";
    case "executed":
      return "review";
    default:
      return null;
  }
}

function completedStepIndex(vm: GigaplanViewModel, activeStep: PipelineStep | null): number {
  if (vm.state === "done") return PIPELINE_STEPS.length - 1;
  if (vm.state === "aborted") return historyStepIndex(vm);
  if (!activeStep) return historyStepIndex(vm);
  return Math.max(-1, PIPELINE_STEPS.indexOf(activeStep) - 1);
}

function robustness(vm: GigaplanViewModel): string {
  const value = (vm as GigaplanViewModel & { robustness?: unknown }).robustness;
  return typeof value === "string" && value.trim() ? value : "standard";
}

function styledStep(theme: Theme, step: PipelineStep, activeStep: PipelineStep | null, completeIndex: number): string {
  const index = PIPELINE_STEPS.indexOf(step);
  const label = DISPLAY_LABELS[step];

  if (step === activeStep) {
    return `${theme.fg("accent", "●")} ${theme.fg("accent", theme.bold(label))}`;
  }

  if (index <= completeIndex) {
    return `${theme.fg("success", "●")} ${theme.fg("success", label)}`;
  }

  return `${theme.fg("dim", "○")} ${theme.fg("dim", label)}`;
}

export class GigaplanHeader implements Component {
  private vm: GigaplanViewModel | null = null;
  private tui: TuiLike | null = null;
  private cachedWidth?: number;
  private cachedLines?: string[];

  constructor(private readonly theme: Theme) {}

  attachTui(tui: TuiLike): void {
    this.tui = tui;
  }

  setViewModel(vm: GigaplanViewModel): void {
    this.vm = vm;
    this.invalidate();
    this.tui?.requestRender();
  }

  render(width: number): string[] {
    if (!this.vm || width <= 0) return [];
    if (this.cachedLines && this.cachedWidth === width) {
      return this.cachedLines;
    }

    const activeStep = currentStep(this.vm);
    const completeIndex = completedStepIndex(this.vm, activeStep);
    const lines = [
      this.renderTopBorder(width),
      this.renderPipeline(width, activeStep, completeIndex),
      this.theme.fg("borderMuted", "─".repeat(width)),
    ];

    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }

  private renderTopBorder(width: number): string {
    const vm = this.vm!;
    const right = `${this.theme.fg("dim", "iter ")}${this.theme.fg("text", String(vm.iteration))}${this.theme.fg("borderMuted", " ── ")}${this.theme.fg("muted", robustness(vm))}${this.theme.fg("borderMuted", " ──")}`;
    const leftBorder = this.theme.fg("borderMuted", "─── ");
    const minGap = 1;
    const nameWidth = Math.max(1, width - visibleWidth(leftBorder) - visibleWidth(right) - minGap);
    const name = truncateToWidth(this.theme.bold(vm.name), nameWidth, "");
    const gapWidth = Math.max(minGap, width - visibleWidth(leftBorder) - visibleWidth(name) - visibleWidth(right));
    const gap = this.theme.fg("borderMuted", `${" ".repeat(minGap)}${"─".repeat(Math.max(0, gapWidth - minGap))}`);

    return truncateToWidth(`${leftBorder}${name}${gap}${right}`, width, "");
  }

  private renderPipeline(width: number, activeStep: PipelineStep | null, completeIndex: number): string {
    const steps = PIPELINE_STEPS.map((step) => styledStep(this.theme, step, activeStep, completeIndex)).join("  ");
    return truncateToWidth(`  ${steps}`, width, "");
  }
}
