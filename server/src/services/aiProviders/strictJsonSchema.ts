import { JSONSchema } from "./types.js";

// Shared by every provider using OpenAI-compatible `strict: true` JSON Schema mode
// (console.groq.com/docs/structured-outputs / platform.openai.com structured outputs),
// which requires every object to set `additionalProperties: false` and list every
// property under `required` — our shared JSONSchema type doesn't carry that
// OpenAI-specific flag, so inject it here rather than polluting the other providers.
export function toStrictJsonSchema(schema: JSONSchema): any {
  const out: any = { type: schema.type };
  if (schema.description) out.description = schema.description;
  if (schema.type === "object") {
    out.properties = {};
    for (const [key, value] of Object.entries(schema.properties || {})) {
      out.properties[key] = toStrictJsonSchema(value);
    }
    out.required = Object.keys(schema.properties || {});
    out.additionalProperties = false;
  }
  if (schema.type === "array" && schema.items) {
    out.items = toStrictJsonSchema(schema.items);
  }
  return out;
}
