/**
 * Media REST routes — the THIN layer (zero business logic per
 * src/server/AGENTS.md): auth gate → body cap → parse → call the src/media
 * service → shape the Ark error surface on failure.
 *
 * 2026-11-22 (user decision "API 路线换回 MCP 路线"): the four generation
 * families (Seedream / SeedDance / HappyHorse / 3D) moved from these REST
 * faces to MCP tools on `/mcp` — see src/mcp/local-tools.ts. What remains
 * here is the speech pair (Seed-ASR flash + Seed-Audio TTS), which is backed
 * by the official video_edit MCP upstream and has no stdio-plugin equivalent
 * to mirror.
 *
 * Error shape is the Volcano Ark dialect `{"error":{"code":"<string>",
 * "message"}}` — NOT proxy/handler.ts errorResponse's `{error:{type}}`:
 * these routes are consumed by clients written against the official Volcano
 * docs.
 *
 * @see src/media/shared.ts（门禁/错误分类/体限）
 */
import type { ProxyConfig } from "../config/types.js";
import type { AuthManager } from "../auth/manager.js";
import { randomUUID } from "node:crypto";
import {
  arkErrorFor,
  arkErrorResponse,
  MediaBodyTooLargeError,
  MediaUpstreamError,
  readJsonBodyWithCap,
  resolveMediaAuthFrom,
} from "../media/shared.js";
import { flashTranscribe, parseAsrFlashRequest } from "../media/seed-asr.js";
import { parseTtsCreateRequest, synthesizeSpeech } from "../media/seed-tts.js";
import type { ToolHubDeps } from "../media/toolhub.js";
import { VideoEditClient, type VideoEditDeps } from "../media/video-edit.js";

export interface MediaRouteOptions {
  config: ProxyConfig;
  auth: AuthManager;
  fetchImpl?: typeof fetch;
  /** Same-key retry backoff for ToolHub calls (production 5s; tests inject ~1ms). */
  retryDelayMs?: number;
}

/** Request-body caps per face. ASR 45 MiB = the upstream entry-nginx cap
 *  (video_edit speech plane). */
const BODY_CAPS = {
  asr: 45 * 1024 * 1024,
  tts: 1024 * 1024,
} as const;

type AuthedResult = { ok: true; origin: string; headers: Record<string, string> } | { response: Response };

async function resolveAuth(opts: MediaRouteOptions): Promise<AuthedResult> {
  const status = await resolveMediaAuthFrom(opts.auth, opts.config.plan);
  if (!status.ok) {
    const code = status.reason === "plan_unsupported" ? "plan_unsupported" : "credentials_unavailable";
    return { response: arkErrorResponse(400, code, status.message) };
  }
  return { ok: true, origin: opts.config.media.upstreamOrigin, headers: status.auth.headers };
}

function depsFor(opts: MediaRouteOptions, authed: { origin: string; headers: Record<string, string> }): {
  toolhub: ToolHubDeps;
  videoEdit: VideoEditDeps;
  fetchImpl: typeof fetch;
} {
  const fetchImpl = opts.fetchImpl ?? fetch;
  return {
    toolhub: {
      origin: authed.origin,
      headers: authed.headers,
      fetchImpl,
      ...(opts.retryDelayMs !== undefined ? { retryDelayMs: opts.retryDelayMs } : {}),
    },
    videoEdit: { origin: authed.origin, headers: authed.headers, fetchImpl },
    fetchImpl,
  };
}

async function asArkError(err: unknown): Promise<Response> {
  if (err instanceof MediaUpstreamError) return arkErrorFor(err);
  if (err instanceof MediaBodyTooLargeError) return arkErrorResponse(413, "request_too_large", err.message);
  return arkErrorResponse(502, "upstream_error", `media request failed: ${(err as Error).message}`);
}

function isBodyTooLargeMessage(err: unknown): err is MediaBodyTooLargeError {
  return err instanceof MediaBodyTooLargeError;
}

/** POST /api/v3/auc/bigmodel/recognize/flash — Seed-ASR sync face. */
export async function handleAsrFlash(req: Request, opts: MediaRouteOptions): Promise<Response> {
  const authed = await resolveAuth(opts);
  if ("response" in authed) return authed.response;
  // 官方姿势是 X-Api-Request-Id 自带；缺失时本地生成一个（响应头回显）。
  const requestId = req.headers.get("x-api-request-id")?.trim() || randomUUID();
  try {
    const body = await readJsonBodyWithCap(req, BODY_CAPS.asr);
    const parsed = parseAsrFlashRequest(body);
    if (!parsed.ok) throw new MediaUpstreamError(parsed.message, parsed.kind);
    const client = new VideoEditClient(depsFor(opts, authed).videoEdit);
    const result = await flashTranscribe(client, parsed.req);
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-api-request-id": requestId,
      // Status header, the plugin's cloud_asr reads: ok / silent-audio.
      "x-api-status-code": result.silent ? "20000003" : "20000000",
    };
    const payload = result.silent ? {} : result.response;
    return new Response(JSON.stringify(payload), { status: 200, headers });
  } catch (err) {
    if (isBodyTooLargeMessage(err)) {
      return arkErrorResponse(
        413,
        "request_too_large",
        `request body exceeds the 45 MiB upstream cap — split the audio client-side and send one flash request per chunk`,
        { "x-api-request-id": requestId },
      );
    }
    return asArkError(err);
  }
}

/**
 * POST /api/v3/auc/bigmodel/{submit,query} — the official async ASR pair.
 * Deliberately NOT emulated: the upstream speech plane is a single blocking
 * call (the plugin sends one speech_transcribe per chunk, zero server-side
 * tasking), so an async face would be a fake task table over synchronous
 * work. 501 with the sync alternative spelled out.
 */
export function handleAsrSubmitQueryUnsupported(): Response {
  return arkErrorResponse(
    501,
    "not_supported",
    "async submit/query is not supported by this proxy — the speech plane is synchronous; use POST /api/v3/auc/bigmodel/recognize/flash (chunk oversized audio client-side, 45 MiB per request)",
  );
}

/** POST /api/v3/tts/create — Seed-Audio face. */
export async function handleTtsCreate(req: Request, opts: MediaRouteOptions): Promise<Response> {
  const authed = await resolveAuth(opts);
  if ("response" in authed) return authed.response;
  const requestId = req.headers.get("x-api-request-id")?.trim() || randomUUID();
  try {
    const body = await readJsonBodyWithCap(req, BODY_CAPS.tts);
    const parsed = parseTtsCreateRequest(body);
    if (!parsed.ok) throw new MediaUpstreamError(parsed.message, parsed.kind);
    const client = new VideoEditClient(depsFor(opts, authed).videoEdit);
    const result = await synthesizeSpeech(client, parsed.req);
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { "content-type": "application/json", "x-api-request-id": requestId },
    });
  } catch (err) {
    return asArkError(err);
  }
}
