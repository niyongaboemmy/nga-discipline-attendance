import OpenAI from "openai";
import { AIProvider, GenerateJSONParams } from "./types.js";
import { matchesSchema } from "./schemaValidator.js";

const isConfigured = () => !!process.env.GLM_API_KEY;

let client: OpenAI | null = null;
function getClient(): OpenAI {
  if (!client) {
    // GLM-4.5-Flash defaults to "thinking" (chain-of-thought) mode on, which measured
    // 30-60s+ for a lesson-note-length prompt — an explicit timeout stops a stuck
    // request from hanging the job indefinitely; thinking is disabled below instead
    // of relied on for speed, since even with it off this is the slowest provider.
    // Generation now targets ~10 pages of content rather than a single short note, which
    // routinely exceeds 45s on this, the slowest provider — this runs as a background
    // job (not inline with the HTTP request), so it's safe to give it much more room.
    client = new OpenAI({
      apiKey: process.env.GLM_API_KEY,
      baseURL: "https://api.z.ai/api/paas/v4",
      timeout: 150_000,
    });
  }
  return client;
}

export const glmProvider: AIProvider = {
  name: "glm",
  isConfigured,
  // GLM's json_object mode guarantees valid JSON, not schema-matching JSON (no
  // constrained decoding) — the schema is only conveyed via the prompt, so the
  // response must be checked against it after the fact (see matchesSchema below).
  supportsStrictSchema: false,

  async generateJSON<T = any>(params: GenerateJSONParams): Promise<T> {
    const model = process.env.GLM_MODEL || "glm-4.5-flash";

    const completion = await getClient().chat.completions.create({
      model,
      thinking: { type: "disabled" },
      ...(params.maxOutputTokens ? { max_tokens: params.maxOutputTokens } : {}),
      messages: [
        {
          role: "system",
          content: `Respond with ONLY a single JSON object matching this JSON Schema — no markdown fences, no commentary, no explanation:\n${JSON.stringify(params.schema)}`,
        },
        { role: "user", content: params.prompt },
      ],
      response_format: { type: "json_object" },
    } as any);

    const text = completion.choices[0]?.message?.content || "{}";
    const parsed = JSON.parse(text) as T;

    if (!matchesSchema(parsed, params.schema)) {
      throw new Error("GLM response did not match the expected schema");
    }

    return parsed;
  },
};
