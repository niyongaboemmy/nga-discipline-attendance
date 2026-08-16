// Every provider SDK throws its own shape of error (the @google/genai SDK puts the raw
// provider error JSON straight into `.message`; OpenAI-compatible clients set `.status`).
// Centralize "is this a quota/rate-limit error" and "what should the teacher see" here so
// every provider adapter and the orchestrator agree on the same classification.
export const isQuotaError = (err: any): boolean => {
  if (err?.status === 429 || err?.status === 413) return true;
  const raw = String(err?.message || err?.error?.message || "");
  return (
    raw.includes("RESOURCE_EXHAUSTED") ||
    raw.includes("429") ||
    raw.includes("413") ||
    /quota/i.test(raw) ||
    /rate.?limit/i.test(raw) ||
    /tokens per minute|tokens per day|TPM|TPD/i.test(raw)
  );
};

const isSafetyBlock = (err: any): boolean => {
  const raw = String(err?.message || err?.error?.message || "");
  return raw.includes("SAFETY") || raw.includes("blockReason") || /content.?filter/i.test(raw);
};

export const friendlyAIErrorMessage = (err: any): string => {
  if (isQuotaError(err)) {
    return "The AI is temporarily rate-limited. Please try again in a few minutes.";
  }
  if (isSafetyBlock(err)) {
    return "The AI declined to generate content for this request. Try rephrasing or picking a different topic.";
  }
  return "AI generation failed. Please try again.";
};
