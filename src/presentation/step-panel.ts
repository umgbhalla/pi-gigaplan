import type { MessageRenderer, Theme, ThemeColor } from "@mariozechner/pi-coding-agent";
import { Box, Container, Text, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

interface TextPart {
  type?: string;
  text?: string;
}

interface StepPanelFlag {
  concern?: string;
  severity?: string;
  severity_hint?: string;
  status?: string;
}

interface ReviewCriterion {
  name?: string;
  pass?: boolean;
}

export interface StepPanelDetails {
  step?: string;
  version?: number | string;
  duration?: number | string;
  summary?: string;
  intent_summary?: string;
  refined_idea?: string;
  changes_summary?: string;
  recommendation?: string;
  confidence?: string;
  score?: number | string;
  delta?: number | string;
  signals?: Record<string, unknown>;
  questions?: unknown[];
  success_criteria?: unknown[];
  assumptions?: unknown[];
  flags?: StepPanelFlag[];
  verified_flag_ids?: string[];
  disputed_flag_ids?: string[];
  checks?: Record<string, boolean>;
  preflight_results?: Record<string, boolean>;
  files_changed?: unknown[];
  deviations?: unknown[];
  criteria?: ReviewCriterion[];
  issues?: unknown[];
  [key: string]: unknown;
}

class DynamicText {
  private readonly text = new Text("", 0, 0);

  constructor(private readonly buildText: (width: number) => string) {}

  render(width: number): string[] {
    this.text.setText(this.buildText(width));
    return this.text.render(width);
  }

  invalidate(): void {
    this.text.invalidate();
  }
}

function arrayLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function asRecordOfBooleans(value: unknown): Record<string, boolean> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, boolean] => typeof entry[1] === "boolean"),
  );
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function messageText(content: string | TextPart[] | undefined): string | null {
  if (typeof content === "string") return content.trim() || null;
  if (!Array.isArray(content)) return null;
  const text = content
    .map((part) => (part?.type === "text" && typeof part.text === "string" ? part.text : ""))
    .join("\n")
    .trim();
  return text || null;
}

function capitalize(value: string): string {
  if (!value) return "step";
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function formatVersion(version: number | string | undefined): string {
  if (version === undefined || version === null || version === "") return "";
  if (typeof version === "string" && version.startsWith("v")) return version;
  return `v${String(version)}`;
}

function formatDuration(duration: number | string | undefined): string {
  if (typeof duration === "string" && duration.trim()) return duration.trim();
  if (typeof duration !== "number" || !Number.isFinite(duration) || duration < 0) return "";
  if (duration < 1000) return `${Math.round(duration)}ms`;
  if (duration < 60_000) {
    const seconds = duration / 1000;
    return seconds >= 10 ? `${Math.round(seconds)}s` : `${seconds.toFixed(1)}s`;
  }

  const totalSeconds = Math.round(duration / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${seconds}s`;

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h ${remainingMinutes}m`;
}

function recommendationColor(recommendation: string | null): ThemeColor {
  if (recommendation === "SKIP") return "success";
  if (recommendation === "ABORT") return "error";
  return "warning";
}

function numericValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function formatNumber(value: unknown): string | null {
  const numeric = numericValue(value);
  if (numeric === null) return null;
  return Number.isInteger(numeric) ? String(numeric) : numeric.toFixed(1);
}

function formatDelta(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  const numeric = numericValue(value);
  if (numeric === null) return null;
  const abs = Math.abs(numeric);
  const rounded = Number.isInteger(abs) ? String(abs) : abs.toFixed(1);
  if (numeric < 0) return `↓${rounded}%`;
  if (numeric > 0) return `↑${rounded}%`;
  return `→${rounded}%`;
}

function deltaColor(delta: string | null): ThemeColor {
  if (!delta) return "muted";
  if (delta.startsWith("↓")) return "success";
  if (delta.startsWith("↑")) return "error";
  return "muted";
}

function severityIndicator(flag: StepPanelFlag, theme: Theme): string {
  if (flag.status === "verified") return theme.fg("success", "✓");
  const severity = flag.severity ?? flag.severity_hint ?? "";
  if (severity === "significant" || severity === "likely-significant") {
    return theme.fg("error", "●");
  }
  return theme.fg("warning", "○");
}

function metric(label: string, value: string, theme: Theme, color: ThemeColor = "text"): string {
  return `${theme.fg("dim", `${label} `)}${theme.fg(color, value)}`;
}

function shorten(text: string, maxWidth = 56): string {
  const singleLine = text.replace(/\s+/g, " ").trim();
  if (singleLine.length <= maxWidth) return singleLine;
  return `${singleLine.slice(0, maxWidth - 1)}…`;
}

function formatCheckName(name: string): string {
  return name.replace(/_/g, " ");
}

function buildClarifyLines(details: StepPanelDetails, content: string | null, theme: Theme, expanded: boolean): string[] {
  const intent = firstString(details.intent_summary, details.summary, content);
  const lines: string[] = [];

  if (intent) lines.push(metric("intent", shorten(intent), theme));
  lines.push(metric("questions", String(arrayLength(details.questions)), theme));

  const refined = firstString(details.refined_idea);
  if (expanded && refined && refined !== intent) {
    lines.push(metric("refined", shorten(refined), theme));
  }

  return lines;
}

function buildPlanLines(details: StepPanelDetails, content: string | null, theme: Theme, expanded: boolean): string[] {
  const lines = [
    metric("criteria", String(arrayLength(details.success_criteria)), theme),
    metric("assumptions", String(arrayLength(details.assumptions)), theme),
  ];

  const summary = firstString(details.changes_summary, details.summary, content);
  if (expanded && summary) {
    lines.push(metric("summary", shorten(summary), theme));
  }

  return lines;
}

function buildCritiqueLines(details: StepPanelDetails, theme: Theme, expanded: boolean): string[] {
  const flags = Array.isArray(details.flags) ? details.flags : [];
  if (flags.length === 0) {
    const verified = arrayLength(details.verified_flag_ids);
    const disputed = arrayLength(details.disputed_flag_ids);
    const lines = [
      `${theme.fg("success", "✓")} ${theme.fg("text", "no new flags")}`,
    ];

    if (verified > 0 || disputed > 0) {
      lines.push(
        `${theme.fg("dim", "verified ")}${theme.fg("success", String(verified))}` +
        `${theme.fg("dim", " · disputed ")}${theme.fg(disputed > 0 ? "warning" : "muted", String(disputed))}`,
      );
    }

    return lines;
  }

  const visibleFlags = expanded ? flags : flags.slice(0, 3);
  const lines = visibleFlags.map((flag) => {
    const concern = shorten(firstString(flag.concern) ?? "flag");
    return `${severityIndicator(flag, theme)} ${theme.fg("text", concern)}`;
  });

  if (!expanded && flags.length > visibleFlags.length) {
    lines.push(metric("more", `+${flags.length - visibleFlags.length}`, theme, "muted"));
  }

  return lines;
}

function buildEvaluateLines(details: StepPanelDetails, theme: Theme, expanded: boolean): string[] {
  const recommendation = firstString(details.recommendation) ?? "CONTINUE";
  const confidence = firstString(details.confidence) ?? "unknown";
  const signals = details.signals ?? {};
  const score = formatNumber(details.score ?? signals.weighted_score);
  const delta = formatDelta(details.delta ?? details["score_delta"] ?? signals["score_delta"]);

  const lines = [
    `${theme.fg("dim", "recommendation ")}${theme.fg(recommendationColor(recommendation), recommendation)}`,
    `${theme.fg("dim", "confidence ")}${theme.fg("text", confidence)}` +
      (score ? `${theme.fg("dim", " · score ")}${theme.fg("text", score)}` : ""),
  ];

  if (delta) {
    lines.push(`${theme.fg("dim", "delta ")}${theme.fg(deltaColor(delta), delta)}`);
  } else if (expanded) {
    const summary = firstString(details.summary);
    if (summary) lines.push(metric("summary", shorten(summary), theme));
  }

  return lines;
}

function buildGateLines(details: StepPanelDetails, theme: Theme, expanded: boolean): string[] {
  const preflightResults = asRecordOfBooleans(details.preflight_results);
  const checks = Object.keys(preflightResults).length > 0
    ? preflightResults
    : asRecordOfBooleans(details.checks);
  const entries = Object.entries(checks);

  if (entries.length === 0) {
    const summary = firstString(details.summary) ?? "gate checks unavailable";
    return [metric("gate", shorten(summary), theme)];
  }

  const visibleEntries = expanded ? entries : entries.slice(0, 3);
  const lines = visibleEntries.map(([name, passed]) => {
    const indicator = passed ? theme.fg("success", "✓") : theme.fg("error", "✗");
    return `${indicator} ${theme.fg("text", formatCheckName(name))}`;
  });

  if (!expanded && entries.length > visibleEntries.length) {
    lines.push(metric("more", `+${entries.length - visibleEntries.length}`, theme, "muted"));
  }

  return lines;
}

function buildExecuteLines(details: StepPanelDetails, content: string | null, theme: Theme, expanded: boolean): string[] {
  const lines = [
    metric("files changed", String(arrayLength(details.files_changed)), theme),
    metric("deviations", String(arrayLength(details.deviations)), theme),
  ];

  const summary = firstString(details.summary, content);
  if (expanded && summary) {
    lines.push(metric("summary", shorten(summary), theme));
  }

  return lines;
}

function buildReviewLines(details: StepPanelDetails, content: string | null, theme: Theme, expanded: boolean): string[] {
  const criteria = Array.isArray(details.criteria) ? details.criteria : [];
  const passed = criteria.filter((criterion) => criterion?.pass === true).length;
  const failed = criteria.length - passed;
  const lines = [
    metric("criteria", `${passed}/${criteria.length} pass`, theme, failed > 0 ? "warning" : "success"),
    metric("issues", String(arrayLength(details.issues)), theme, arrayLength(details.issues) > 0 ? "warning" : "success"),
  ];

  if (expanded && criteria.length > 0) {
    const visible = criteria.slice(0, 2).map((criterion) => {
      const indicator = criterion?.pass ? theme.fg("success", "✓") : theme.fg("error", "✗");
      const name = firstString(criterion?.name) ?? "criterion";
      return `${indicator} ${theme.fg("text", shorten(name, 48))}`;
    });
    lines.push(...visible);
  } else if (expanded) {
    const summary = firstString(details.summary, content);
    if (summary) lines.push(metric("summary", shorten(summary), theme));
  }

  return lines;
}

function buildPanelLines(details: StepPanelDetails, content: string | null, theme: Theme, expanded: boolean): string[] {
  switch (details.step) {
    case "clarify":
      return buildClarifyLines(details, content, theme, expanded);
    case "plan":
    case "integrate":
      return buildPlanLines(details, content, theme, expanded);
    case "critique":
      return buildCritiqueLines(details, theme, expanded);
    case "evaluate":
      return buildEvaluateLines(details, theme, expanded);
    case "gate":
      return buildGateLines(details, theme, expanded);
    case "execute":
      return buildExecuteLines(details, content, theme, expanded);
    case "review":
      return buildReviewLines(details, content, theme, expanded);
    default: {
      const summary = firstString(details.summary, content) ?? "step complete";
      return [metric("summary", shorten(summary), theme)];
    }
  }
}

function padStyled(text: string, width: number): string {
  const truncated = truncateToWidth(text, width);
  const padding = Math.max(0, width - visibleWidth(truncated));
  return truncated + " ".repeat(padding);
}

function buildHeader(step: string, version: string, duration: string, innerWidth: number, theme: Theme): string {
  const border = (value: string) => theme.fg("borderMuted", value);
  let leftText = step;
  if (version) leftText += ` ${version}`;

  const rightWidth = duration ? 1 + visibleWidth(duration) : 0;
  const minDashWidth = 1;
  const maxLeftWidth = Math.max(1, innerWidth - 2 - rightWidth - minDashWidth);
  leftText = truncateToWidth(leftText, maxLeftWidth);

  const fillerWidth = Math.max(
    minDashWidth,
    innerWidth - 2 - visibleWidth(leftText) - rightWidth,
  );

  let line = border("┌");
  line += " ";
  line += theme.fg("accent", leftText);
  line += " ";
  line += border("─".repeat(fillerWidth));
  if (duration) {
    line += " ";
    line += theme.fg("muted", duration);
  }
  line += border("┐");
  return line;
}

function buildBody(lines: string[], innerWidth: number, theme: Theme): string[] {
  const border = (value: string) => theme.fg("borderMuted", value);
  return lines.map((line) => `${border("│")}${padStyled(`  ${line}`, innerWidth)}${border("│")}`);
}

function buildBottom(innerWidth: number, theme: Theme): string {
  return theme.fg("borderMuted", `└${"─".repeat(innerWidth)}┘`);
}

function buildPanelText(message: { content: string | TextPart[] }, details: StepPanelDetails, expanded: boolean, theme: Theme, width: number): string {
  const panelWidth = Math.max(24, width);
  const innerWidth = panelWidth - 2;
  const step = capitalize(firstString(details.step) ?? "step");
  const version = formatVersion(details.version);
  const duration = formatDuration(details.duration);
  const content = messageText(message.content);
  const bodyLines = buildPanelLines(details, content, theme, expanded);

  return [
    buildHeader(step, version, duration, innerWidth, theme),
    ...buildBody(bodyLines, innerWidth, theme),
    buildBottom(innerWidth, theme),
  ].join("\n");
}

export function createStepPanelRenderer(defaultTheme?: Theme): MessageRenderer<StepPanelDetails> {
  return (message, { expanded }, theme) => {
    const resolvedTheme = theme ?? defaultTheme!;
    const details = (message.details ?? {}) as StepPanelDetails;
    const container = new Container();
    const box = new Box(0, 0, (text) => resolvedTheme.bg("customMessageBg", text));
    box.addChild(new DynamicText((width) => buildPanelText(message, details, expanded, resolvedTheme, width)));
    container.addChild(box);
    return container;
  };
}
