import { GoogleGenAI, Type } from "@google/genai";
import { AIProvider, GenerateJSONParams, JSONSchema } from "./types.js";

const isConfigured = () =>
  !!process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== "your_gemini_api_key_here";

const GEMINI_TYPE_MAP: Record<JSONSchema["type"], any> = {
  object: Type.OBJECT,
  string: Type.STRING,
  array: Type.ARRAY,
  number: Type.NUMBER,
  boolean: Type.BOOLEAN,
};

function toGeminiSchema(schema: JSONSchema): any {
  const out: any = { type: GEMINI_TYPE_MAP[schema.type] };
  if (schema.description) out.description = schema.description;
  if (schema.properties) {
    out.properties = {};
    for (const [key, value] of Object.entries(schema.properties)) {
      out.properties[key] = toGeminiSchema(value);
    }
  }
  if (schema.items) out.items = toGeminiSchema(schema.items);
  if (schema.required) out.required = schema.required;
  return out;
}

export const geminiProvider: AIProvider = {
  name: "gemini",
  isConfigured,
  supportsStrictSchema: true,

  async generateJSON<T = any>(params: GenerateJSONParams): Promise<T> {
    // Without an explicit timeout, a stuck network connection to Gemini hangs this
    // promise forever — the orchestrator never even reaches the Groq/GLM fallback,
    // since it's simply still awaiting this call. Groq and GLM's clients already set
    // one; Gemini's didn't, which is exactly the gap a real hung request surfaced.
    // This runs as a background job, not inline with the HTTP request, so it's safe to
    // give a long, detailed (~10-page) lesson note generation plenty of room to finish
    // rather than time out and force a fallback provider.
    const genAI = new GoogleGenAI({
      apiKey: process.env.GEMINI_API_KEY,
      httpOptions: { timeout: 120_000 },
    });
    const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";

    const response = await genAI.models.generateContent({
      model,
      contents: params.prompt,
      config: {
        responseMimeType: "application/json",
        responseSchema: toGeminiSchema(params.schema),
        ...(params.maxOutputTokens ? { maxOutputTokens: params.maxOutputTokens } : {}),
      },
    });

    return JSON.parse(response.text || "{}") as T;
  },
};
