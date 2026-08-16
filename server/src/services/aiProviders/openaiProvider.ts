import OpenAI from "openai";
import { AIProvider, GenerateJSONParams } from "./types.js";
import { toStrictJsonSchema } from "./strictJsonSchema.js";

const isConfigured = () =>
  !!process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY !== "your_openai_api_key_here";

let client: OpenAI | null = null;
function getClient(): OpenAI {
  if (!client) {
    client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 60_000 });
  }
  return client;
}

export const openaiProvider: AIProvider = {
  name: "openai",
  isConfigured,
  supportsStrictSchema: true,

  async generateJSON<T = any>(params: GenerateJSONParams): Promise<T> {
    const model = process.env.OPENAI_MODEL || "gpt-4o";

    const completion = await getClient().chat.completions.create({
      model,
      messages: [{ role: "user", content: params.prompt }],
      ...(params.maxOutputTokens ? { max_completion_tokens: params.maxOutputTokens } : {}),
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
