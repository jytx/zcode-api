/**
 * Provider and model type definitions.
 */

/**
 * Supported provider identifiers.
 *
 * `zai_cn` is the desktop 3.18.0+ "Z.ai (CN)" login flavor (host bundle
 * `createZaiCnProviderRuntimeConfig`): it walks the zai OAuth/token chain with
 * a China-region authorize host (zchat.z.ai, server-issued via cli/init) and
 * folds into the zai family everywhere downstream — the config surface
 * (`ProxyConfig.provider`) is `"zai" | "zai_cn"` — 2026-11-22 (user decision):
 * the `bigmodel` label is retired from the config/UI surface entirely (it
 * survives only in WIRE namespaces: official entitlement keys
 * `account:bigmodel-*`, the poll payload `data.bigmodel` bucket, and legacy
 * stored credentials, which fold into the zai_cn family via
 * `credentialFamily`). See NOTEPAD「2026-11-14 增补」 +「4.0.0 增补」§I.
 */
export type ProviderId = "zai" | "zai_cn" | "bigmodel";

/** Providers selectable in config.yaml / setConfig (config surface: zai | zai_cn —
 *  2026-11-22 the bigmodel label is retired; legacy bigmodel credentials fold
 *  into zai_cn via `credentialFamily`). */
export type ConfigProviderId = Exclude<ProviderId, "bigmodel">;

/**
 * OAuth LOGIN methods (zai | zai_cn). The bigmodel OAuth login
 * (bigmodel.cn auth-code + poll) is REMOVED (decision 2026-11-14, surface
 * purge 2026-11-22); legacy bigmodel STORED credentials remain valid and
 * resolve through the same open.bigmodel.cn chain as zai_cn.
 */
export type LoginProviderId = Exclude<ProviderId, "bigmodel">;

/** Static provider definition with endpoint URLs. */
export interface ProviderDef {
  id: ProviderId;
  displayName: string;
  /** Base URL for Anthropic-format requests (no trailing slash). */
  anthropicBaseURL: string;
  /** Base URL for OpenAI-format requests (no trailing slash). */
  openaiBaseURL: string;
  /** Host for OAuth/API-key resolution business APIs. */
  bizHost: string;
}

/** Model definition derived from the catalog. */
export interface ModelDef {
  id: string;
  name: string;
  contextWindow: number;
  maxOutputTokens?: number;
  /** Whether the model supports reasoning/thinking mode. */
  reasoning?: boolean;
  /** Whether the model accepts image input (explicit — no id-shape heuristic). */
  vision?: boolean;
}
