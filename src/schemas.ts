/** JSON schema definitions for gigaplan step outputs. */

export const SCHEMAS: Record<string, Record<string, unknown>> = {
  "clarify.json": {
    type: "object",
    properties: {
      questions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            question: { type: "string" },
            context: { type: "string" },
          },
          required: ["question", "context"],
        },
      },
      refined_idea: { type: "string" },
      intent_summary: { type: "string" },
    },
    required: ["questions", "refined_idea", "intent_summary"],
  },
  "plan.json": {
    type: "object",
    properties: {
      plan: { type: "string" },
      questions: { type: "array", items: { type: "string" } },
      success_criteria: { type: "array", items: { type: "string" } },
      assumptions: { type: "array", items: { type: "string" } },
    },
    required: ["plan", "questions", "success_criteria", "assumptions"],
  },
  "integrate.json": {
    type: "object",
    properties: {
      plan: { type: "string" },
      changes_summary: { type: "string" },
      flags_addressed: { type: "array", items: { type: "string" } },
      assumptions: { type: "array", items: { type: "string" } },
      success_criteria: { type: "array", items: { type: "string" } },
      questions: { type: "array", items: { type: "string" } },
    },
    required: ["plan", "changes_summary", "flags_addressed"],
  },
  "critique.json": {
    type: "object",
    properties: {
      flags: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            concern: { type: "string" },
            category: {
              type: "string",
              enum: [
                "correctness",
                "security",
                "completeness",
                "performance",
                "maintainability",
                "other",
              ],
            },
            severity_hint: {
              type: "string",
              enum: ["likely-significant", "likely-minor", "uncertain"],
            },
            evidence: { type: "string" },
          },
          required: ["id", "concern", "category", "severity_hint", "evidence"],
        },
      },
      verified_flag_ids: { type: "array", items: { type: "string" } },
      disputed_flag_ids: { type: "array", items: { type: "string" } },
    },
    required: ["flags"],
  },
  "execution.json": {
    type: "object",
    properties: {
      output: { type: "string" },
      files_changed: { type: "array", items: { type: "string" } },
      commands_run: { type: "array", items: { type: "string" } },
      deviations: { type: "array", items: { type: "string" } },
    },
    required: ["output", "files_changed", "commands_run", "deviations"],
  },
  "review.json": {
    type: "object",
    properties: {
      criteria: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            pass: { type: "boolean" },
            evidence: { type: "string" },
          },
          required: ["name", "pass", "evidence"],
        },
      },
      issues: { type: "array", items: { type: "string" } },
      summary: { type: "string" },
    },
    required: ["criteria", "issues"],
  },
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function strictSchema(schema: any): any {
  if (Array.isArray(schema)) {
    return schema.map(strictSchema);
  }
  if (schema !== null && typeof schema === "object") {
    const updated: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(schema)) {
      updated[key] = strictSchema(value);
    }
    if (updated["type"] === "object") {
      if (!("additionalProperties" in updated)) {
        updated["additionalProperties"] = false;
      }
      if ("properties" in updated && updated["properties"] !== null) {
        updated["required"] = Object.keys(updated["properties"] as object);
      }
    }
    return updated;
  }
  return schema;
}
