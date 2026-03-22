import { describe, it, expect } from "vitest";
import { SCHEMAS, strictSchema } from "../src/schemas.js";

describe("SCHEMAS", () => {
  it("contains all 6 schemas", () => {
    const keys = Object.keys(SCHEMAS);
    expect(keys).toContain("clarify.json");
    expect(keys).toContain("plan.json");
    expect(keys).toContain("integrate.json");
    expect(keys).toContain("critique.json");
    expect(keys).toContain("execution.json");
    expect(keys).toContain("review.json");
    expect(keys).toHaveLength(6);
  });
});

describe("strictSchema", () => {
  it("adds additionalProperties: false to object schemas", () => {
    const schema = {
      type: "object",
      properties: { name: { type: "string" } },
    };
    const result = strictSchema(schema) as Record<string, unknown>;
    expect(result["additionalProperties"]).toBe(false);
  });

  it("sets required to all property keys", () => {
    const schema = {
      type: "object",
      properties: {
        foo: { type: "string" },
        bar: { type: "number" },
      },
    };
    const result = strictSchema(schema) as Record<string, unknown>;
    expect(result["required"]).toEqual(["foo", "bar"]);
  });

  it("does not override existing additionalProperties", () => {
    const schema = {
      type: "object",
      additionalProperties: true,
      properties: { x: { type: "string" } },
    };
    const result = strictSchema(schema) as Record<string, unknown>;
    expect(result["additionalProperties"]).toBe(true);
  });

  it("handles nested objects recursively", () => {
    const schema = {
      type: "object",
      properties: {
        nested: {
          type: "object",
          properties: { a: { type: "string" } },
        },
      },
    };
    const result = strictSchema(schema) as Record<string, unknown>;
    const nested = (result["properties"] as Record<string, unknown>)["nested"] as Record<string, unknown>;
    expect(nested["additionalProperties"]).toBe(false);
    expect(nested["required"]).toEqual(["a"]);
  });

  it("handles arrays", () => {
    const schema = [{ type: "object", properties: { a: { type: "string" } } }];
    const result = strictSchema(schema) as unknown[];
    expect(Array.isArray(result)).toBe(true);
    expect((result[0] as Record<string, unknown>)["additionalProperties"]).toBe(false);
  });

  it("passes through non-object primitives", () => {
    expect(strictSchema("hello")).toBe("hello");
    expect(strictSchema(42)).toBe(42);
    expect(strictSchema(null)).toBe(null);
  });
});
