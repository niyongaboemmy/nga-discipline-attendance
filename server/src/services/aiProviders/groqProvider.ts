import OpenAI from "openai";
import { AIProvider, GenerateJSONParams } from "./types.js";
import { toStrictJsonSchema } from "./strictJsonSchema.js";

const isConfigured = () => !!process.env.GROQ_API_KEY;

let client: OpenAI | null = null;
function getClient(): OpenAI {
  if (!client) {
    client = new OpenAI({
      apiKey: process.env.GROQ_API_KEY,
      baseURL: "https://api.groq.com/openai/v1",
      // Runs as a background job, not inline with the HTTP request — safe to give a
      // long, detailed lesson-note prompt more room than the old short-note timeout.
      timeout: 60_000,
    });
  }
  return client;
}

export const groqProvider: AIProvider = {
  name: "groq",
  isConfigured,
  supportsStrictSchema: true,

  async generateJSON<T = any>(params: GenerateJSONParams): Promise<T> {
    const model = process.env.GROQ_MODEL || "openai/gpt-oss-20b";

    const completion = await getClient().chat.completions.create({
      model,
      messages: [{ role: "user", content: params.prompt }],
      // gpt-oss models spend part of the completion budget on internal reasoning tokens
      // before the actual JSON — a low default max_completion_tokens truncates long lesson
      // notes mid-string, producing invalid JSON that fails strict-schema validation.
      // reasoning_effort:"low" keeps more of that budget for the actual content.
      // Free-tier Groq accounts cap total tokens-per-minute (prompt + completion) quite
      // low (seen: 8,000 TPM for gpt-oss-20b) — leave headroom for the prompt itself.
      max_completion_tokens: Math.min(params.maxOutputTokens ?? 3000, 6000),
      reasoning_effort: "low",
      response_format: {
        type: "json_schema",
        json_schema: {
          name: params.schemaName || "response",
          strict: true,
          schema: toStrictJsonSchema(params.schema),
        },
      } as any,
    } as any);

    const text = completion.choices[0]?.message?.content || "{}";
    return JSON.parse(text) as T;
  },
};
