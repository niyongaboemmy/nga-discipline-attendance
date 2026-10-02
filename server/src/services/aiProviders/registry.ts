import { AIProvider } from "./types.js";
import { geminiProvider } from "./geminiProvider.js";
import { groqProvider } from "./groqProvider.js";
import { glmProvider } from "./glmProvider.js";
import { openaiProvider } from "./openaiProvider.js";
import { deepseekProvider } from "./deepseekProvider.js";
import { openrouterProvider } from "./openrouterProvider.js";

const ALL_PROVIDERS: Record<string, AIProvider> = {
  gemini: geminiProvider,
  groq: groqProvider,
  glm: glmProvider,
  openai: openaiProvider,
  deepseek: deepseekProvider,
  openrouter: openrouterProvider,
};

const DEFAULT_ORDER = "gemini,groq,deepseek,openrouter,glm";

/**
 * Providers to try, in order. Defaults to AI_PROVIDER_ORDER (comma-separated env var,
 * falling back to DEFAULT_ORDER) — pass `overrideOrder` only when a specific feature has
 * a genuine reason to prefer a different provider first (e.g. one provider is measurably
 * better at a particular task), which still falls through to the rest of the configured
 * providers rather than being limited to just the override.
 */
export function orderedProviders(overrideOrder?: string[]): AIProvider[] {
  const names = (overrideOrder ?? (process.env.AI_PROVIDER_ORDER || DEFAULT_ORDER).split(","))
    .map((s) => s.trim())
    .filter(Boolean);
  return names.map((name) => ALL_PROVIDERS[name]).filter((p): p is AIProvider => !!p);
}

export function isAnyProviderConfigured(): boolean {
  return orderedProviders().some((p) => p.isConfigured());
}

// --- Cooldown / circuit breaker ---------------------------------------------------
// A provider that just returned a quota/rate-limit error is skipped for COOLDOWN_MS
// rather than retried every request — daily/per-minute quotas do reset, so this is a
// temporary skip, not a permanent disable. In-memory only, same pattern as
// aiNotesJobStore's job map (acceptable to reset on process restart).
const COOLDOWN_MS = 5 * 60 * 1000;
const cooldownUntil = new Map<string, number>();

export function isCoolingDown(providerName: string): boolean {
  const until = cooldownUntil.get(providerName);
  return !!until && until > Date.now();
}

export function markCoolingDown(providerName: string, ms: number = COOLDOWN_MS): void {
  cooldownUntil.set(providerName, Date.now() + ms);
}
