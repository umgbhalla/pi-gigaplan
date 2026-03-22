import { describe, it, expect } from "vitest";
import { flagWeight, computePlanDeltaPercent } from "../src/evaluation.js";
import type { FlagRecord } from "../src/core.js";

describe("flagWeight", () => {
  it("returns 3.0 for security", () => {
    const flag: FlagRecord = { category: "security" };
    expect(flagWeight(flag)).toBe(3.0);
  });

  it("returns 2.0 for correctness", () => {
    const flag: FlagRecord = { category: "correctness" };
    expect(flagWeight(flag)).toBe(2.0);
  });

  it("returns 1.5 for completeness", () => {
    const flag: FlagRecord = { category: "completeness" };
    expect(flagWeight(flag)).toBe(1.5);
  });

  it("returns 1.0 for performance", () => {
    const flag: FlagRecord = { category: "performance" };
    expect(flagWeight(flag)).toBe(1.0);
  });

  it("returns 0.75 for maintainability", () => {
    const flag: FlagRecord = { category: "maintainability" };
    expect(flagWeight(flag)).toBe(0.75);
  });

  it("returns 1.0 for other", () => {
    const flag: FlagRecord = { category: "other" };
    expect(flagWeight(flag)).toBe(1.0);
  });

  it("returns 1.0 for unknown category", () => {
    const flag: FlagRecord = { category: "unknown-category" };
    expect(flagWeight(flag)).toBe(1.0);
  });

  it("returns 0.5 for implementation detail signals in concern", () => {
    const flag: FlagRecord = { category: "correctness", concern: "The column is missing" };
    expect(flagWeight(flag)).toBe(0.5);
  });

  it("returns 0.5 for schema-related concern", () => {
    const flag: FlagRecord = { category: "completeness", concern: "schema not defined" };
    expect(flagWeight(flag)).toBe(0.5);
  });
});

describe("computePlanDeltaPercent", () => {
  it("returns 0 for identical strings", () => {
    const text = "This is a plan with some content.";
    expect(computePlanDeltaPercent(text, text)).toBe(0);
  });

  it("returns null when previousText is null", () => {
    expect(computePlanDeltaPercent(null, "anything")).toBeNull();
  });

  it("returns a positive number for different strings", () => {
    const prev = "old plan content here";
    const curr = "completely different new plan";
    const result = computePlanDeltaPercent(prev, curr);
    expect(result).not.toBeNull();
    expect(result!).toBeGreaterThan(0);
  });

  it("returns 0 for two empty strings", () => {
    expect(computePlanDeltaPercent("", "")).toBe(0);
  });

  it("returns high delta for very different strings", () => {
    const result = computePlanDeltaPercent("aaaa", "zzzz");
    expect(result!).toBeGreaterThan(50);
  });
});
