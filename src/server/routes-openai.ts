/**
 * OpenAI-format route handlers: /v1/chat/completions + /v1/models.
 */
import { proxyRequest, type ProxyHandlerOptions } from "../proxy/handler.js";
import { MODELS } from "../provider/models.js";
import type { OpenAIModelList } from "../translator/types.js";
import type { ProxyConfig } from "../config/types.js";

/** Handle POST /v1/chat/completions — forward OpenAI-compatible chat requests upstream. */
export async function handleChatCompletions(
  req: Request,
  opts: ProxyHandlerOptions,
): Promise<Response> {
  return proxyRequest(req, "openai", opts);
}

/**
 * Catalog entry, or a minimal text-only stub for ids outside the MODELS catalog
 * (forwarding has no whitelist, so config.models may carry unknown ids; they
 * are advertised honestly without fabricated specs rather than dropped).
 */
type AdvertisedModel = {
  id: string;
  name: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  reasoning?: boolean;
  vision?: boolean;
};

/**
 * Advertised model list = config.models (deduped, order preserved), enriched
 * with the pinned MODELS catalog metadata where the id is known.
 */
function resolveAdvertisedModels(models: readonly string[]): AdvertisedModel[] {
  const seen = new Set<string>();
  const out: AdvertisedModel[] = [];
  for (const id of models) {
    if (seen.has(id)) continue;
    seen.add(id);
    const known = MODELS.find((m) => m.id === id);
    out.push(known ?? { id, name: id });
  }
  return out;
}

/**
 * Reasoning effort presets for reasoning-flagged catalog models. Codex's
 * `ReasoningEffortPreset` requires a non-empty `description` alongside the
 * effort (codex-rs/protocol/src/openai_models.rs).
 */
const REASONING_LEVEL_PRESETS: ReadonlyArray<{ effort: string; description: string }> = [
  { effort: "low", description: "Fastest responses with minimal reasoning." },
  { effort: "medium", description: "Balanced reasoning depth and latency." },
  { effort: "high", description: "Deeper reasoning for complex tasks." },
  { effort: "xhigh", description: "Maximum reasoning depth for the hardest problems." },
];

/**
 * Behavior knobs mirrored from OpenAI's bundled codex models.json GPT entries
 * (`codex-rs/models-manager/models.json`) so codex renders our models exactly
 * like its fallback did — the only capabilities that actually vary are the
 * catalog-derived specs (context window, modalities, reasoning levels).
 */
const CODEX_BEHAVIOR_DEFAULTS = {
  shell_type: "shell_command",
  support_verbosity: false,
  truncation_policy: { mode: "tokens", limit: 10_000 },
  experimental_supported_tools: [] as string[],
  apply_patch_tool_type: "freeform",
};

/** Handle GET /v1/models — return the advertised model list in OpenAI format. */
export function handleListModels(req: Request, config: ProxyConfig): Response {
  const advertised = resolveAdvertisedModels(config.models);
  // Rich catalog face, keyed on the `client_version` query param being present
  // (any value): codex always appends it when fetching its model catalog
  // (codex-rs/codex-api/src/endpoint/models.rs — GET {base_url}/models), and
  // DSH's better-basicfun synchronizer probes with ?client_version=pi. Codex
  // parses ONLY a top-level `models[]` envelope (ModelsResponse) — a plain
  // OpenAI `data[]` body is treated as invalid and the whole fetch falls back
  // to the bundled GPT catalog ("model capabilities read failed" symptom).
  // ModelInfo fields required by codex-rs/protocol/src/openai_models.rs (no
  // serde default): slug, display_name, supported_reasoning_levels (each with
  // a description), shell_type, visibility, supported_in_api, priority,
  // support_verbosity, truncation_policy, experimental_supported_tools. The
  // parse is all-or-nothing per response — every entry, including minimal
  // stubs for ids outside the MODELS catalog, must carry all of them.
  const clientVersion = new URL(req.url).searchParams.get("client_version");
  if (clientVersion !== null) {
    const body = {
      models: advertised.map((m, i) => ({
        slug: m.id,
        display_name: m.name,
        description: m.name,
        ...(m.reasoning ? { default_reasoning_level: "medium" } : {}),
        supported_reasoning_levels: m.reasoning ? REASONING_LEVEL_PRESETS : [],
        ...CODEX_BEHAVIOR_DEFAULTS,
        // config.models order drives the codex picker order (priority ascending).
        priority: i + 1,
        visibility: "list",
        supported_in_api: true,
        // Vision capability is an explicit catalog flag (glm-5.3-flash takes
        // images without a "v" in its id; glm-4.6v-style ids also carry it).
        input_modalities: m.vision ? ["text", "image"] : ["text"],
        ...(m.contextWindow === undefined
          ? {}
          : { context_window: m.contextWindow, max_context_window: m.contextWindow }),
        // DSH parity field (codex ModelInfo has no max_tokens; it ignores it).
        ...(m.maxOutputTokens === undefined ? {} : { max_tokens: m.maxOutputTokens }),
      })),
    };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  // Plain OpenAI Models API face: spec-required created (fixed epoch — never
  // randomized) + owned_by.
  const list: OpenAIModelList = {
    object: "list",
    data: advertised.map((m) => ({
      id: m.id,
      object: "model" as const,
      created: 0,
      owned_by: "zcode-proxy",
    })),
  };
  return new Response(JSON.stringify(list), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
