// Plain JSON-Schema (subset) shared across all AI providers, so callers describe the
// shape they want once and each provider adapter translates it into whatever request
// format that vendor needs (Gemini's Type.* enum schema, OpenAI-style json_schema, etc).
export type JSONSchemaType = "object" | "string" | "array" | "number" | "boolean";

export interface JSONSchema {
  type: JSONSchemaType;
  description?: string;
  properties?: Record<string, JSONSchema>;
  items?: JSONSchema;
  required?: string[];
}

export interface GenerateJSONParams {
  prompt: string;
  schema: JSONSchema;
  /** Short machine name for the schema (used by providers that require a json_schema "name", e.g. Groq). */
  schemaName?: string;
  /**
   * Output token budget hint. Providers default this low to stay inside free-tier rate
   * limits, which silently truncates output (and therefore the JSON) for anything larger
   * than a short snippet — callers revising or generating a full lesson note must raise
   * this to fit the actual content size.
   */
  maxOutputTokens?: number;
}

export interface AIProvider {
  name: string;
  /** Whether this provider has the env vars it needs (an API key, etc). */
  isConfigured(): boolean;
  /**
   * true only for providers that guarantee the response matches `schema` via constrained
   * decoding (Gemini's responseSchema, Groq's strict json_schema on gpt-oss models).
   * false for providers that only guarantee valid JSON (e.g. GLM's json_object mode) —
   * those need a runtime shape check on the response, see schemaValidator.ts.
   */
  supportsStrictSchema: boolean;
  generateJSON<T = any>(params: GenerateJSONParams): Promise<T>;
}
