import OpenAI from "openai";
import { AIProvider, GenerateJSONParams } from "./types.js";
import { matchesSchema } from "./schemaValidator.js";

const isConfigured = () => !!process.env.DEEPSEEK_API_KEY;

let client: OpenAI | null = null;
function getClient(): OpenAI {
  if (!client) {
    // DeepSeek's API is OpenAI-compatible. Long generations (multi-page lesson content)
    // run as background jobs, so give it the same generous timeout as GLM.
    client = new OpenAI({
      apiKey: process.env.DEEPSEEK_API_KEY,
      baseURL: process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com",
      timeout: 150_000,
    });
  }
  return client;
}

// deepseek-chat caps output at 8K tokens — asking for more is rejected outright
// rather than clamped, so clamp here instead of failing the whole request.
const MAX_OUTPUT_TOKENS = 8192;

export const deepseekProvider: AIProvider = {
  name: "deepseek",
  isConfigured,
  // Like GLM, DeepSeek's json_object mode guarantees valid JSON but not a schema match
  // (no constrained decoding), so the response is checked with matchesSchema below.
  supportsStrictSchema: false,

  async generateJSON<T = any>(params: GenerateJSONParams): Promise<T> {
    const model = process.env.DEEPSEEK_MODEL || "deepseek-chat";

    const completion = await getClient().chat.completions.create({
      model,
      ...(params.maxOutputTokens
        ? { max_tokens: Math.min(params.maxOutputTokens, MAX_OUTPUT_TOKENS) }
        : {}),
      messages: [
        {
          role: "system",
          // json_object mode requires the word "json" in the prompt, which this satisfies.
          content: `Respond with ONLY a single JSON object matching this JSON Schema — no markdown fences, no commentary, no explanation:\n${JSON.stringify(params.schema)}`,
        },
        { role: "user", content: params.prompt },
      ],
      response_format: { type: "json_object" },
    });

    const text = completion.choices[0]?.message?.content || "{}";
    const parsed = JSON.parse(text) as T;

    if (!matchesSchema(parsed, params.schema)) {
      throw new Error("DeepSeek response did not match the expected schema");
    }

    return parsed;
  },
};
