/**
 * Z.AI and Bigmodel provider definitions.
 * @see _reverse/NOTEPAD.md "Provider Endpoints"
 */
import type { ConfigProviderId, ProviderDef, ProviderId } from "./types.js";

export const ZAI_PROVIDER: ProviderDef = {
  id: "zai",
  displayName: "Z.AI",
  anthropicBaseURL: "https://api.z.ai/api/anthropic",
  openaiBaseURL: "https://api.z.ai/api/coding/paas/v4",
  bizHost: "https://api.z.ai",
};

/**
 * Z.ai China-region family (desktop 3.18.2 host `createZaiCnProviderRuntimeConfig`:
 * `{...TF(zai配置), id:zai_cn, displayName:"Z.ai (CN)"}`). The LOGIN face rides the
 * zai OAuth chain (zchat.z.ai authorize host issued server-side via cli/init,
 * `/cli/callback/zai_cn` callback) — the DOWNSTREAM is the BigModel
 * (open.bigmodel.cn) chain: a zai_cn login surfaces the user's BigModel
 * subscription (live-verified 2026-11-14). The polled token is used AS-IS
 * (no z/login) against the bigmodel.cn biz chain.
 *
 * 2026-11-22 (user decision): `zai_cn` IS the config/UI label for this family —
 * the `bigmodel` label is retired from the surface (it survives only in WIRE
 * namespaces: official entitlement keys `account:bigmodel-*`, the poll payload
 * `data.bigmodel` bucket) and as a legacy stored-credential value.
 */
export const ZAI_CN_PROVIDER: ProviderDef = {
  id: "zai_cn",
  displayName: "Z.AI (CN)",
  anthropicBaseURL: "https://open.bigmodel.cn/api/anthropic",
  openaiBaseURL: "https://open.bigmodel.cn/api/coding/paas/v4",
  bizHost: "https://open.bigmodel.cn",
};

/** LEGACY stored-credential def only (bigmodel OAuth logins, removed
 *  2026-11-20): same open.bigmodel.cn chain as ZAI_CN_PROVIDER; never
 *  surfaced in config/UI — `credentialFamily` folds it into zai_cn. */
export const BIGMODEL_PROVIDER: ProviderDef = {
  ...ZAI_CN_PROVIDER,
  id: "bigmodel",
  displayName: "BigModel / 智谱 (legacy)",
};

const PROVIDERS: Record<ProviderId, ProviderDef> = {
  zai: ZAI_PROVIDER,
  zai_cn: ZAI_CN_PROVIDER,
  bigmodel: BIGMODEL_PROVIDER,
};

/** Look up a provider definition by id. */
export function getProvider(id: ProviderId): ProviderDef {
  const def = PROVIDERS[id];
  if (!def) {
    throw new Error(`Unknown provider: "${id}"`);
  }
  return def;
}

/**
 * Credential → config-surface family. The desktop's
 * `resolveStartPlanFamilyFromOAuthProvider` (3.18.2 main chunk) folds
 * zai_cn → "bigmodel" on the WIRE — here the same fold lands on the
 * **zai_cn** config label (2026-11-22: the bigmodel label is retired from the
 * surface). A China-region Z.ai login resolves to the user's BigModel/智谱
 * subscription (live-verified 2026-11-14); everything downstream (biz host,
 * API-key resolution, signing, highspeed official keys) rides the
 * open.bigmodel.cn chain. Legacy `bigmodel` STORED credentials (removed
 * login flavor) fold into zai_cn too.
 */
export function credentialFamily(provider: ProviderId): ConfigProviderId {
  return provider === "zai" ? "zai" : "zai_cn";
}
