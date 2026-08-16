import { JSONSchema } from "./types.js";

/**
 * Lightweight runtime shape check for providers that only guarantee valid JSON
 * (json_object mode), not schema-matching JSON (no constrained decoding). Checks
 * required keys and basic type match — not a full JSON-Schema validator (no min/max,
 * enum, pattern, etc). Reach for a real library (ajv) if these schemas grow beyond
 * the simple object/string/array shapes this platform's AI features currently use.
 */
export function matchesSchema(value: any, schema: JSONSchema): boolean {
  switch (schema.type) {
    case "object": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
      for (const key of schema.required || []) {
        if (!(key in value)) return false;
      }
      if (schema.properties) {
        for (const [key, propSchema] of Object.entries(schema.properties)) {
          if (key in value && !matchesSchema(value[key], propSchema)) return false;
        }
      }
      return true;
    }
    case "array":
      if (!Array.isArray(value)) return false;
      return schema.items ? value.every((v) => matchesSchema(v, schema.items!)) : true;
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number";
    case "boolean":
      return typeof value === "boolean";
    default:
      return true;
  }
}
