import { describe, it, expect } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs";
import {
  slugify,
  nowUtc,
  sha256Text,
  jsonDump,
  normalizeText,
  atomicWriteText,
  atomicWriteJson,
  readJson,
  STATE_INITIALIZED,
  STATE_CLARIFIED,
  STATE_PLANNED,
  STATE_CRITIQUED,
  STATE_EVALUATED,
  STATE_GATED,
  STATE_EXECUTED,
  STATE_DONE,
  STATE_ABORTED,
  TERMINAL_STATES,
} from "../src/core.js";

describe("slugify", () => {
  it("lowercases and replaces spaces with hyphens", () => {
    expect(slugify("Hello World")).toBe("hello-world");
  });

  it("strips leading/trailing hyphens", () => {
    expect(slugify("  --hello--  ")).toBe("hello");
  });

  it("replaces special chars with hyphens", () => {
    expect(slugify("foo!bar@baz")).toBe("foo-bar-baz");
  });

  it("returns 'plan' for empty string", () => {
    expect(slugify("")).toBe("plan");
  });

  it("truncates to maxLength", () => {
    const result = slugify("a".repeat(50), 30);
    expect(result.length).toBeLessThanOrEqual(30);
  });

  it("respects custom maxLength", () => {
    expect(slugify("hello world foo bar", 10).length).toBeLessThanOrEqual(10);
  });
});

describe("nowUtc", () => {
  it("returns ISO format string", () => {
    const result = nowUtc();
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  it("ends with Z not milliseconds", () => {
    expect(nowUtc()).not.toContain(".");
  });
});

describe("sha256Text", () => {
  it("returns consistent hashes", () => {
    expect(sha256Text("hello")).toBe(sha256Text("hello"));
  });

  it("starts with sha256:", () => {
    expect(sha256Text("hello")).toMatch(/^sha256:/);
  });

  it("returns different hashes for different inputs", () => {
    expect(sha256Text("hello")).not.toBe(sha256Text("world"));
  });

  it("is deterministic", () => {
    const expected = "sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
    expect(sha256Text("hello")).toBe(expected);
  });
});

describe("jsonDump", () => {
  it("produces formatted JSON with newline", () => {
    const result = jsonDump({ a: 1, b: "two" });
    expect(result).toBe('{\n  "a": 1,\n  "b": "two"\n}\n');
  });

  it("handles arrays", () => {
    const result = jsonDump([1, 2, 3]);
    expect(result).toContain("[\n");
    expect(result.endsWith("\n")).toBe(true);
  });
});

describe("normalizeText", () => {
  it("trims whitespace", () => {
    expect(normalizeText("  hello  ")).toBe("hello");
  });

  it("lowercases", () => {
    expect(normalizeText("HELLO World")).toBe("hello world");
  });

  it("collapses multiple spaces", () => {
    expect(normalizeText("hello   world")).toBe("hello world");
  });
});

describe("atomicWriteText and readJson roundtrip", () => {
  const tmpFile = path.join("/tmp", `gigaplan-test-${process.pid}.txt`);

  it("writes and reads back text", () => {
    atomicWriteText(tmpFile, "hello world");
    expect(fs.readFileSync(tmpFile, "utf8")).toBe("hello world");
    fs.unlinkSync(tmpFile);
  });
});

describe("atomicWriteJson and readJson roundtrip", () => {
  const tmpFile = path.join("/tmp", `gigaplan-test-json-${process.pid}.json`);

  it("writes and reads back JSON", () => {
    const data = { foo: "bar", count: 42 };
    atomicWriteJson(tmpFile, data);
    const result = readJson(tmpFile);
    expect(result).toEqual(data);
    fs.unlinkSync(tmpFile);
  });
});

describe("state machine constants", () => {
  it("all states exist", () => {
    expect(STATE_INITIALIZED).toBe("initialized");
    expect(STATE_CLARIFIED).toBe("clarified");
    expect(STATE_PLANNED).toBe("planned");
    expect(STATE_CRITIQUED).toBe("critiqued");
    expect(STATE_EVALUATED).toBe("evaluated");
    expect(STATE_GATED).toBe("gated");
    expect(STATE_EXECUTED).toBe("executed");
    expect(STATE_DONE).toBe("done");
    expect(STATE_ABORTED).toBe("aborted");
  });

  it("TERMINAL_STATES contains done and aborted", () => {
    expect(TERMINAL_STATES.has(STATE_DONE)).toBe(true);
    expect(TERMINAL_STATES.has(STATE_ABORTED)).toBe(true);
    expect(TERMINAL_STATES.has(STATE_PLANNED)).toBe(false);
  });
});
