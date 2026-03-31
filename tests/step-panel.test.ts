import { describe, expect, it } from "vitest";
import { visibleWidth } from "@mariozechner/pi-tui";
import { createStepPanelRenderer } from "../src/presentation/step-panel.js";

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as any;

function render(details: Record<string, unknown>, options: { expanded: boolean } = { expanded: false }, width = 64) {
  const renderer = createStepPanelRenderer(theme);
  const component = renderer({
    role: "custom",
    customType: "gigaplan-step",
    content: typeof details.summary === "string" ? details.summary : "",
    display: true,
    timestamp: 0,
    details,
  } as any, options, theme);

  return component?.render(width) ?? [];
}

describe("step panel renderer", () => {
  it("renders clarify panels with summary and question count", () => {
    const lines = render({
      step: "clarify",
      version: 2,
      duration: 125_000,
      intent_summary: "Turn step results into dashboard panels.",
      questions: [{}, {}, {}],
    });

    expect(lines[0]).toContain("Clarify v2");
    expect(lines[0]).toContain("2m 5s");
    expect(lines[1]).toContain("intent Turn step results into dashboard panels.");
    expect(lines[2]).toContain("questions 3");
    expect(lines[3]).toBe(`└${"─".repeat(62)}┘`);
    expect(lines.every((line) => visibleWidth(line) === 64)).toBe(true);
  });

  it("shows critique severity indicators and overflow summary when collapsed", () => {
    const lines = render({
      step: "critique",
      version: 3,
      flags: [
        { concern: "Missing gate validation", severity_hint: "likely-significant" },
        { concern: "Duration is not shown", severity_hint: "likely-minor" },
        { concern: "Panel width is inconsistent", severity_hint: "likely-minor" },
        { concern: "Review counts are unclear", severity_hint: "likely-minor" },
      ],
    });

    expect(lines[1]).toContain("● Missing gate validation");
    expect(lines[2]).toContain("○ Duration is not shown");
    expect(lines[3]).toContain("○ Panel width is inconsistent");
    expect(lines[4]).toContain("more +1");
  });

  it("renders gate panels with every check when expanded", () => {
    const lines = render({
      step: "gate",
      preflight_results: {
        project_exists: true,
        project_writable: true,
        plan_exists: true,
        no_unresolved_flags: false,
      },
    }, { expanded: true });

    expect(lines[1]).toContain("✓ project exists");
    expect(lines[2]).toContain("✓ project writable");
    expect(lines[3]).toContain("✓ plan exists");
    expect(lines[4]).toContain("✗ no unresolved flags");
  });
});
