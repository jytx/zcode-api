/**
 * GLM-5.3 / GLM-5.4 family reasoning-effort contract.
 *
 * 2026-11-23: GLM-5.4 joined the family — the official provider config
 * (zcode-builtin rev 47, server-side hot update; the desktop bundle stayed at
 * 4.0.0) routes GLM-5.4 onto the generic `glm[^/]*` model rule: 1M context /
 * 128K max output / `reasoningLevel: ["low","high","max"]` / image+video+pdf
 * input — the SAME three-level effort contract as GLM-5.3 (whose dedicated
 * `glm-5\.3` rule carries identical values). The rev also narrowed the old
 * catch-all `.*glm-5.*` (200K/64K, disabled|enabled) to bare `glm-5` + dated
 * suffixes precisely so it no longer swallows 5.4.
 *
 * The 5.4 membership mirrors the official rule AND is live-verified for the
 * effort channel (coding-plan, 2026-11-25): glm-5.4 output grew monotonically
 * with reasoning_effort (low 58 → high 289 → max 411 tokens), so
 * `output_config.effort` steers its thinking exactly as for 5.3. The exact
 * budget→thinking ratio per level was measured for glm-5.3 only.
 *
 * The Anthropic upstream ignores the OpenAI `reasoning_effort` field entirely
 * for this model family — `output_config.effort` is the only channel that
 * actually changes how much the model thinks, and it must be paired with a
 * matching `thinking.budget_tokens` (the effort label alone still produces
 * near-zero thinking). Values below come from ZCode's own model catalog
 * entry for `glm-5.3` (`defaultLevel: "max"`, three effort levels each
 * setting both fields) plus live upstream verification.
 */

/** The three legal `output_config.effort` levels for GLM-5.3 / GLM-5.4 models (module-local; the type below is the public contract). */
const GLM53_EFFORT_LEVELS = ["low", "high", "max"] as const;

/** One of the three legal GLM-5.3 effort levels. */
export type Glm53Effort = (typeof GLM53_EFFORT_LEVELS)[number];

/** ZCode catalog's `defaultLevel` for glm-5.3 — used when no effort is requested. */
export const GLM53_DEFAULT_EFFORT: Glm53Effort = "max";

/**
 * Thinking token budgets ZCode's catalog pairs with each effort level.
 * Sending `output_config.effort` without a matching `thinking.budget_tokens`
 * leaves the upstream at its own near-zero default.
 */
export const GLM53_THINKING_BUDGETS: Readonly<Record<Glm53Effort, number>> = {
  low: 8_000,
  high: 16_000,
  max: 32_000,
};

/**
 * Floor below which a thinking budget stops being useful — measured live
 * against the upstream (a budget this small collapses back to near-zero
 * thinking output). Doubles as the SDK's default budget: the bundle's
 * anthropic request builder forces `budget_tokens: 1024` whenever thinking
 * is enabled without one ("thinking budget is required when thinking is
 * enabled. using default budget of 1024 tokens.").
 */
export const GLM53_MIN_THINKING_BUDGET = 1_024;

/**
 * Match the GLM-5.3 / GLM-5.4 model family, including `glm-5.3-flash`,
 * case-insensitively (the upstream also accepts `GLM-5.3`). Deliberately
 * excludes `glm-5`, `glm-5.1`, and `glm-5.2` — the negative lookahead rejects
 * a trailing digit so `glm-5.30` / `glm-5.40` (were either ever added) would
 * not falsely match either. `glm-5.4` joined on 2026-11-23 (same three-level
 * contract, see the module header).
 */
const GLM53_MODEL_PATTERN = /glm-5\.[34](?![0-9])/i;

/** True when `model` belongs to the GLM-5.3 / GLM-5.4 family (`glm-5.3`, `glm-5.3-flash`, `glm-5.4`, ...). The
 *  exported name keeps its `Glm53` prefix: the contract is one family, the
 *  5.4 models share it unchanged. */
export function isGlm53Model(model: string | undefined): boolean {
  if (!model) return false;
  return GLM53_MODEL_PATTERN.test(model);
}

/**
 * Map an OpenAI `reasoning_effort` value onto the three GLM-5.3 effort
 * levels, per Z.AI's official mapping table. Unrecognized or absent values
 * fall back to the catalog default (`max`) rather than the OpenAI-side
 * default (`medium`), since ZCode's own `defaultLevel` for this family is
 * `max`. The mapping rounds UP, not to nearest — `medium` maps to `high`,
 * not `low`.
 */
export function normalizeGlm53Effort(effort: string | undefined): Glm53Effort {
  switch (effort) {
    case "none":
    case "minimal":
    case "light":
    case "low":
      return "low";
    case "medium":
    case "high":
      return "high";
    case "xhigh":
    case "max":
    case "ultra":
      return "max";
    default:
      return GLM53_DEFAULT_EFFORT;
  }
}

/** Build the paired `thinking` + `output_config` fields for a GLM-5.3 effort level. */
export function buildGlm53Reasoning(effort: Glm53Effort): {
  thinking: { type: "enabled"; budget_tokens: number };
  output_config: { effort: Glm53Effort };
} {
  return {
    thinking: { type: "enabled", budget_tokens: GLM53_THINKING_BUDGETS[effort] },
    output_config: { effort },
  };
}

/**
 * Clamp a thinking budget against the MODEL's maxOutputTokens ceiling —
 * mirrors ZCode's catalog-patch clamp (`Math.min(budgetTokens,
 * maxOutputTokens - 1)`, applied against the large fixed model ceiling, not
 * the per-request `max_tokens`). The request-level budget-vs-answer split is
 * NOT clamped here: the bundle's anthropic builder instead ADDS the budget on
 * top of `max_tokens` (see applyAnthropicThinkingCompat in
 * openai-to-anthropic.ts), which is how real traffic keeps answer room.
 * Passes `budget` through unchanged when `modelMaxTokens` isn't a finite
 * number (unknown model ids — nothing to clamp against).
 */
export function clampGlm53BudgetToModel(budget: number, modelMaxTokens: unknown): number {
  if (typeof modelMaxTokens !== "number" || !Number.isFinite(modelMaxTokens)) return budget;
  return Math.min(budget, Math.floor(modelMaxTokens) - 1);
}
