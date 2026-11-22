/**
 * Media route tests (speech faces — ASR flash + TTS; the four generation
 * families moved to /mcp MCP tools on 2026-11-22, covered by
 * src/mcp/local-tools.test.ts + aggregate.test.ts): full fetch-handler
 * dispatch — proxyApiKey gate, plan / credential gates with the Ark error
 * shape, body caps, 501 surfaces, and one happy path per face.
 */
import { describe, it, expect } from "bun:test";
import { createFetchHandler } from "./server.js";
import type { ProxyConfig } from "../config/types.js";
import { AuthManager } from "../auth/manager.js";
import type { Credential } from "../auth/types.js";

function makeConfig(overrides: Partial<ProxyConfig> = {}): ProxyConfig {
  return {
    server: { port: 0, host: "127.0.0.1" },
    auth: {},
    provider: "zai",
    plan: "coding-plan",
    providers: {
      zai: { anthropicBase: "https://api.z.ai/api/anthropic", openaiBase: "https://api.z.ai/api/coding/paas/v4" },
      zai_cn: { anthropicBase: "https://open.bigmodel.cn/api/anthropic", openaiBase: "https://open.bigmodel.cn/api/coding/paas/v4" },
    },
    defaultModel: "glm-4.6",
    models: ["glm-4.6"],
    identity: { appVersion: "test-1.0.0", sourceTitle: "cli", refererOrigin: "https://zcode.z.ai" },
    clientIdentity: { mode: "observe", ttlSeconds: 900, maxSessions: 1024 },
    responses: { enabled: true, storeMaxEntries: 1000, storeTtlMs: 86400000 },
    endpointRouting: { enabled: false, origin: "https://zcode.z.ai" },
    clientSigning: { enabled: false },
    highspeed: { enabled: false, origin: "https://zcode.z.ai", models: [] },
    mcp: { enabled: true, webSearch: true, webReader: false, zread: false, gateway: { enabled: true, upstreamOrigin: "https://zcode.test" } },
    media: { enabled: true, upstreamOrigin: "https://zcode.test" },
    async: { enabled: false, origin: "https://zcode.z.ai", pollIntervalMs: 5000, keepAliveIntervalMs: 3000, maxWaitMs: 0, maxRetries: 3, settleTimeoutMs: 8000, controlTimeoutMs: 15000, defaultModel: "" },
    claim: { enabled: false, auto: true, origin: "https://zcode.z.ai", pollIntervalMs: 300000, cooldownMs: 600000, planId: "" },
    logging: { level: "info" },
    ...overrides,
  };
}

function authed(credFields: Partial<Credential> = {}): AuthManager {
  const auth = new AuthManager();
  auth.setOAuthCredential({ apiKey: "sk-x.sec", provider: "zai", jwt: "jwt-1", ...credFields });
  return auth;
}

const json = (payload: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json", ...headers } });

/** Upstream stub that answers ToolHub invokes and video_edit tools/call by URL. */
function mediaUpstreamStub(handlers: {
  toolhub?: (url: string, body: Record<string, unknown>) => Response;
  videoEdit?: (body: Record<string, unknown>) => Response;
}) {
  const calls: Array<{ url: string; body: Record<string, unknown>; headers: Record<string, string> }> = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    // multipart uploads (FormData) and non-JSON bodies parse to {} — URL-based
    // dispatch below is what matters.
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    calls.push({ url, body, headers });
    if (url.includes("/api/v1/mcp/server/video_edit")) {
      const resp = handlers.videoEdit?.(body) ?? json({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "stub missing videoEdit handler" } });
      return resp;
    }
    return handlers.toolhub?.(url, body) ?? json({ code: 1, msg: "stub missing toolhub handler" });
  }) as unknown as typeof fetch;
  return { fetch: impl, calls };
}

function handler(config: ProxyConfig, auth: AuthManager, fetchImpl?: typeof fetch) {
  return createFetchHandler({ config, auth, ...(fetchImpl ? { fetchImpl } : {}) });
}

describe("media routes — gating", () => {
  it("requires the proxy API key when configured (shared gate)", async () => {
    const config = makeConfig({ auth: { proxyApiKey: "sk-proxy" } });
    const resp = await handler(config, authed())(new Request("http://localhost/api/v3/tts/create", { method: "POST", body: "{}" }));
    expect(resp.status).toBe(401);
  });

  it("400s for start-plan with an Ark-shaped plan_unsupported error", async () => {
    const config = makeConfig({ plan: "start-plan" });
    const resp = await handler(config, authed())(new Request("http://localhost/api/v3/tts/create", { method: "POST", body: JSON.stringify({ text: "x" }) }));
    expect(resp.status).toBe(400);
    const body = (await resp.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("plan_unsupported");
    expect(body.error.message).toContain("coding-plan");
    expect("type" in body.error).toBe(false);
  });

  it("400s credentials_unavailable when the credential lacks a JWT", async () => {
    const auth = authed({ jwt: undefined });
    const resp = await handler(makeConfig(), auth)(new Request("http://localhost/api/v3/tts/create", { method: "POST", body: JSON.stringify({ text_prompt: "hi" }) }));
    expect(resp.status).toBe(400);
    const body = (await resp.json()) as { error: { code: string } };
    expect(body.error.code).toBe("credentials_unavailable");
  });

  it("404s every media face when media.enabled=false", async () => {
    const config = makeConfig({ media: { enabled: false, upstreamOrigin: "https://zcode.test" } });
    for (const [path, method] of [
      ["/api/v3/auc/bigmodel/recognize/flash", "POST"],
      ["/api/v3/auc/bigmodel/submit", "POST"],
      ["/api/v3/tts/create", "POST"],
    ] as const) {
      const resp = await handler(config, authed())(new Request(`http://localhost${path}`, { method, body: method === "POST" ? "{}" : undefined }));
      expect(resp.status).toBe(404);
    }
  });
});

describe("media routes — unsupported surfaces", () => {
  it("501s the async ASR pair with the sync alternative spelled out", async () => {
    const h = handler(makeConfig(), authed());
    for (const path of ["/api/v3/auc/bigmodel/submit", "/api/v3/auc/bigmodel/query"]) {
      const resp = await h(new Request(`http://localhost${path}`, { method: "POST", body: "{}" }));
      expect(resp.status).toBe(501);
      const body = (await resp.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("not_supported");
      expect(body.error.message).toContain("recognize/flash");
    }
  });

});

describe("media routes — happy paths", () => {
  it("POST /api/v3/auc/bigmodel/recognize/flash → video_edit → X-Api-Status-Code + ms utterances", async () => {
    const stub = mediaUpstreamStub({
      videoEdit: (body) => {
        // 8 required fields, zero-values included.
        expect(Object.keys((body.params as { arguments: Record<string, unknown> }).arguments).length).toBe(8);
        const sseBody = `data: ${JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: { structuredContent: { transcript: { text: "你好", audio_duration_seconds: 1.2, segments: [{ speaker: "1", text: "你好", start: 0.1, end: 1.2, words: [] }] } } },
        })}\n\n`;
        return new Response(sseBody, { status: 200, headers: { "content-type": "text/event-stream", "x-request-id": "req-77" } });
      },
    });
    const resp = await handler(makeConfig(), authed(), stub.fetch)(
      new Request("http://localhost/api/v3/auc/bigmodel/recognize/flash", {
        method: "POST",
        headers: { "x-api-request-id": "caller-req-1", "x-api-resource-id": "volc.bigasr.auc", "x-api-key": "ignored" },
        body: JSON.stringify({ user: { uid: "u" }, audio: { data: "QUJD", format: "mp3", language: "zh-CN" }, request: { model_name: "bigmodel" } }),
      }),
    );
    expect(resp.status).toBe(200);
    expect(resp.headers.get("x-api-status-code")).toBe("20000000");
    expect(resp.headers.get("x-api-request-id")).toBe("caller-req-1");
    const body = (await resp.json()) as { result: { text: string; utterances: Array<{ text: string; start_time: number; end_time: number; additions?: { speaker: string } }> }; audio_info?: { duration: number } };
    expect(body.result.text).toBe("你好");
    expect(body.result.utterances[0]).toMatchObject({ text: "你好", start_time: 100, end_time: 1200, additions: { speaker: "1" } });
    expect(body.audio_info).toEqual({ duration: 1200 });
    // identity headers reached the speech gateway (not the caller's x-api-key)
    expect(stub.calls[0].headers["authorization"]).toBe("Bearer jwt-1");
    expect(stub.calls[0].headers["x-bigmodel-authorization"]).toBe("Bearer sk-x.sec");
  });

  it("silent audio answers X-Api-Status-Code 20000003 with an empty body", async () => {
    const stub = mediaUpstreamStub({
      videoEdit: () => {
        const sseBody = `data: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { structuredContent: { silent_audio: true } } })}\n\n`;
        return new Response(sseBody, { status: 200, headers: { "content-type": "text/event-stream" } });
      },
    });
    const resp = await handler(makeConfig(), authed(), stub.fetch)(
      new Request("http://localhost/api/v3/auc/bigmodel/recognize/flash", { method: "POST", body: JSON.stringify({ audio: { data: "QUJD", format: "wav" } }) }),
    );
    expect(resp.status).toBe(200);
    expect(resp.headers.get("x-api-status-code")).toBe("20000003");
    expect(await resp.json()).toEqual({});
  });

  it("POST /api/v3/tts/create → video_edit speech_synthesize → {code:0,data}", async () => {
    const stub = mediaUpstreamStub({
      videoEdit: (body) => {
        const args = (body.params as { arguments: Record<string, unknown> }).arguments;
        expect(Object.keys(args).length).toBe(11);
        expect(args.voice).toBe("zh_female_1");
        // 客户端带来的非空 model 必须在反代侧改写成 ""——video_edit 只吃空 model
        // （实弹 2026-11-14：任何非空 model → internal_error）。
        expect(args.model).toBe("");
        return json({ jsonrpc: "2.0", id: 1, result: { structuredContent: { audio_base64: "AAA=", duration: 1.5 } } });
      },
    });
    const resp = await handler(makeConfig(), authed(), stub.fetch)(
      new Request("http://localhost/api/v3/tts/create", {
        method: "POST",
        body: JSON.stringify({ model: "seed-tts-2", text_prompt: "你好", audio_config: { format: "mp3" }, references: [{ speaker: "zh_female_1" }] }),
      }),
    );
    expect(resp.status).toBe(200);
    expect(resp.headers.get("x-api-request-id")).toMatch(/[0-9a-f-]{36}/);
    const body = (await resp.json()) as { code: number; data: string; duration: number };
    expect(body).toEqual({ code: 0, data: "AAA=", duration: 1.5 });
  });

  it("TTS: omitted model flows upstream as empty string (kit mirror); >1 voice references answer 400 locally", async () => {
    const stub = mediaUpstreamStub({
      videoEdit: (body) => {
        const args = (body.params as { arguments: Record<string, unknown> }).arguments;
        expect(args.model).toBe("");
        return json({ jsonrpc: "2.0", id: 1, result: { structuredContent: { audio_base64: "AAA=" } } });
      },
    });
    const h = handler(makeConfig(), authed(), stub.fetch);
    const noModel = await h(new Request("http://localhost/api/v3/tts/create", { method: "POST", body: JSON.stringify({ text_prompt: "hi" }) }));
    expect(noModel.status).toBe(200);
    const twoRefs = await h(new Request("http://localhost/api/v3/tts/create", {
      method: "POST",
      body: JSON.stringify({ model: "m", text_prompt: "hi", references: [{ speaker: "a" }, { speaker: "b" }] }),
    }));
    expect(twoRefs.status).toBe(400);
    expect(((await twoRefs.json()) as { error: { message: string } }).error.message).toContain("one voice reference");
  });

});

describe("media routes — body caps and upstream error surfacing", () => {
  it("413s an ASR body over 45 MiB with the chunking hint", async () => {
    const stub = mediaUpstreamStub({});
    const resp = await handler(makeConfig(), authed(), stub.fetch)(
      new Request("http://localhost/api/v3/auc/bigmodel/recognize/flash", {
        method: "POST",
        headers: { "content-length": String(50 * 1024 * 1024) },
        body: "{}",
      }),
    );
    expect(resp.status).toBe(413);
    const body = (await resp.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("request_too_large");
    expect(body.error.message).toContain("45 MiB");
    expect(body.error.message).toContain("chunk");
    expect(stub.calls.length).toBe(0);
  });

  it("maps a speech-gateway 429 to 429 rate_limit_exceeded", async () => {
    const stub = mediaUpstreamStub({ videoEdit: () => new Response("slow down", { status: 429 }) });
    const resp = await handler(makeConfig(), authed(), stub.fetch)(
      new Request("http://localhost/api/v3/tts/create", { method: "POST", body: JSON.stringify({ model: "seed-tts-2", text_prompt: "hi" }) }),
    );
    expect(resp.status).toBe(429);
    const body = (await resp.json()) as { error: { code: string } };
    expect(body.error.code).toBe("rate_limit_exceeded");
    expect(stub.calls.length).toBe(1);
  });

  it("invalid JSON bodies answer 400 invalid_parameter (Ark shape)", async () => {
    const resp = await handler(makeConfig(), authed())(
      new Request("http://localhost/api/v3/tts/create", { method: "POST", body: "not-json" }),
    );
    expect(resp.status).toBe(400);
    const body = (await resp.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invalid_parameter");
  });
});

