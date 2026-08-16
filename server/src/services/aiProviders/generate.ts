import { GenerateJSONParams } from "./types.js";
import { orderedProviders, isCoolingDown, markCoolingDown } from "./registry.js";
import { isQuotaError, friendlyAIErrorMessage } from "./errors.js";

/** Thrown when no provider could answer. Carries a message already safe to
 *  show a user (see friendlyAIErrorMessage). */
export class AIUnavailableError extends Error {
  readonly status = 503;
  constructor(message: string) {
    super(message);
    this.name = "AIUnavailableError";
  }
}

export interface GenerateStructuredContentResult<T> {
  data: T;
  providerUsed: string;
}

export interface GenerateStructuredContentOptions {
  /** Try these providers, in this order, instead of AI_PROVIDER_ORDER — see orderedProviders(). */
  providerOrder?: string[];
}

/**
 * Tries each configured provider in AI_PROVIDER_ORDER (or `options.providerOrder` when given),
 * skipping any currently cooling down from a recent quota error. Returns the first success.
 * Callers never need to know which provider actually answered unless they want to (providerUsed).
 *
 * Ported from nga_central_mis's services/aiProviders so this app shares the same
 * provider set, fallback order and quota-cooldown behaviour; the only changes are
 * dropping that app's logger/CustomError dependencies for this app's conventions.
 */
export async function generateStructuredContent<T = any>(
  params: GenerateJSONParams,
  options?: GenerateStructuredContentOptions,
): Promise<GenerateStructuredContentResult<T>> {
  const providers = orderedProviders(options?.providerOrder);
  let lastErr: any = null;
  let attempted = 0;

  for (const provider of providers) {
    if (!provider.isConfigured()) continue;
    if (isCoolingDown(provider.name)) {
      console.info(`AI provider ${provider.name} is cooling down, skipping`);
      continue;
    }

    attempted++;
    try {
      const data = await provider.generateJSON<T>(params);
      return { data, providerUsed: provider.name };
    } catch (err: any) {
      lastErr = err;
      console.warn(`AI provider ${provider.name} failed:`, err?.message);
      if (isQuotaError(err)) {
        markCoolingDown(provider.name);
      }
    }
  }

  if (attempted === 0) {
    throw new AIUnavailableError(
      "AI generation is not configured. Add an API key for at least one AI provider to the server environment.",
    );
  }
  throw new AIUnavailableError(friendlyAIErrorMessage(lastErr));
}
