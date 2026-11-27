/**
 * Pinned model catalog for GLM coding plan.
 *
 * Hardcoded to the exact models available on the Z.AI / Bigmodel coding-plan
 * tier. This replaces the previous `_reverse/models_catalog.json` import,
 * removing that runtime dependency. Update this list when new GLM models are
 * released or specs change.
 *
 */
import type { ModelDef } from "./types.js";

/** All models available on the GLM coding plan, pinned with verified specs. */
export const MODELS: ModelDef[] = [
  // Specs synced to ZCode 3.11.2 `_reverse/models_catalog.json` (zai/bigmodel
  // entries are identical): contextWindow + maxOutputTokens per model.
  // Order is a deliberate deviation from the upstream catalog: current-gen
  // defaults lead the advertised list; consumers are id-keyed, not positional.
  //
  // GLM-5.4 (2026-11-23): specs from the official provider config
  // zcode-builtin rev 47 (server-side hot update — the desktop app itself
  // stayed at 4.0.0, so there is no newer bundled models_catalog to sync
  // from). rev 47 added GLM-5.4 to all eight plan provider model lists
  // (coding/start/off-peak × zai/bigmodel) and routes it onto the generic
  // `glm[^/]*` model rule: 1M context / 128K max output / image+video+pdf
  // input / reasoningLevel low·high·max — identical to glm-5.3, hence
  // vision:true. NOT on the highspeed-card lists (rev 47 keeps those at
  // GLM-5.3 + GLM-5.3-Flash), so it is not a highspeed draw family.
  //
  // Live verification (coding-plan credential, 2026-11-25): glm-5.4 answers
  // 200 on the direct upstream and the effort channel works — output grew
  // monotonically with reasoning_effort (low 58 → high 289 → max 411 tokens;
  // omitted effort landed near max, matching defaultLevel "max"). Still
  // RULE-SOURCED, not measured: contextWindow / maxOutputTokens (a
  // max_tokens=200000 request was merely accepted, so that probe had no
  // discriminating power for the 128K ceiling) and vision input.
  // (_reverse/analysis/probe-glm54-coding.ts; the earlier 3006 "model not
  // allowed" was the trial Start-Plan entitlement, not the model.)
  { id: "glm-5.4", name: "GLM 5.4", contextWindow: 1_000_000, maxOutputTokens: 128_000, reasoning: true, vision: true },
  { id: "glm-5.3", name: "GLM 5.3", contextWindow: 1_000_000, maxOutputTokens: 128_000, reasoning: true },
  // start-plan gateway serves the -flash variant (used by claimed trial plans
  // like the weekend package); advertised so client-side discovery lists it.
  // Multimodal (text + image input).
  { id: "glm-5.3-flash", name: "GLM 5.3 Flash", contextWindow: 1_000_000, maxOutputTokens: 128_000, reasoning: true, vision: true },
  // glm-5.2 is absent from the 3.11.2 catalog (kept for forwarding compatibility).
  { id: "glm-5.2", name: "GLM 5.2", contextWindow: 1_000_000, maxOutputTokens: 128_000, reasoning: true },
  { id: "glm-5.1", name: "GLM 5.1", contextWindow: 200_000, maxOutputTokens: 64_000, reasoning: true },
  { id: "glm-5", name: "GLM 5", contextWindow: 200_000, maxOutputTokens: 64_000, reasoning: true },
  { id: "glm-5-turbo", name: "GLM 5 Turbo", contextWindow: 200_000, maxOutputTokens: 64_000, reasoning: true },
  { id: "glm-5v-turbo", name: "GLM 5V Turbo", contextWindow: 200_000, maxOutputTokens: 131_072, vision: true },
  { id: "glm-4.7", name: "GLM 4.7", contextWindow: 200_000, maxOutputTokens: 131_072, reasoning: true },
  { id: "glm-4.6", name: "GLM 4.6", contextWindow: 200_000, maxOutputTokens: 131_072, reasoning: true },
  { id: "glm-4.6v", name: "GLM 4.6V", contextWindow: 131_072, maxOutputTokens: 32_768, vision: true },
  { id: "glm-4.5-air", name: "GLM 4.5 Air", contextWindow: 131_072, maxOutputTokens: 98_304, reasoning: true },
];

/**
 * Default advertised pair for `/v1/models` and the webui picker, used when
 * config.yaml omits `models:` (mirrored by loader DEFAULTS.MODELS). Do not
 * trim MODELS itself to match: the translator still needs the full catalog
 * for maxOutputTokens clamps and reasoning detection on unadvertised (but
 * forwardable) models. The live advertised list is config.models —
 * handleListModels enriches it with MODELS catalog metadata.
 */
export const ADVERTISED_MODEL_IDS: readonly string[] = ["glm-5.3", "glm-5.3-flash"];
