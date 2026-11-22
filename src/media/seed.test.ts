/**
 * Seed-family mapping tests: the outgoing ToolHub / video_edit payload
 * builders and the reference-material contract are the compatibility surface
 * (the Ark REST parse layers moved to the MCP media tools on 2026-11-22 —
 * their successors live in src/mcp/local-tools.test.ts).
 */
import { describe, it, expect } from "bun:test";
import { OFFICIAL_MCP_CATALOGUE } from "../mcp/catalogue.js";
import { resolveReferenceImage } from "./seed-image.js";
import {
  buildToolhubVideoBody,
  validateVideoMaterialUrls,
} from "./seed-video.js";
import { buildTranscribeArguments, mapTranscriptToFlash, parseAsrFlashRequest } from "./seed-asr.js";
import { buildSynthesizeArguments, mapSynthesizeResponse, parseTtsCreateRequest } from "./seed-tts.js";
import type { ToolHubDeps } from "./toolhub.js";
import { MediaUpstreamError, type MediaUpstreamKind } from "./shared.js";

const okParse = <T>(result: { ok: true; req: T } | { ok: false; kind: MediaUpstreamKind; message: string }): T => {
  if (!result.ok) throw new Error(`expected ok parse, got: ${result.message}`);
  return result.req;
};

const errParse = (result: { ok: true } | { ok: false; kind: MediaUpstreamKind; message: string }): { kind: MediaUpstreamKind; message: string } => {
  if (result.ok) throw new Error("expected error parse");
  return { kind: result.kind, message: result.message };
};

describe("official-catalogue — video_edit manual entry", () => {
  it("exposes the video_edit route through the /mcp aggregate", () => {
    const entry = OFFICIAL_MCP_CATALOGUE.servers.find((s) => s.routeId === "video_edit");
    expect(entry).toBeDefined();
    expect(entry!.key).toBe("video-edit");
    expect(entry!.plugin).toBe("video-agent-kit");
    expect(entry!.path).toBe("/api/v1/mcp/server/video_edit");
    expect(entry!.requiresPaidPlan).toBe(true);
  });
});

describe("resolveReferenceImage — ToolHub reference contract", () => {
  function stubToolhub(handlers: Array<(call: { url: string; body: string | FormData }) => Response>) {
    const calls: Array<{ url: string; body: string | FormData; headers: Record<string, string> }> = [];
    let n = 0;
    const impl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const call = { url: String(input), body: (init?.body as string | FormData) ?? "", headers: Object.fromEntries(new Headers(init?.headers).entries()) };
      calls.push(call);
      const handler = handlers[Math.min(n, handlers.length - 1)];
      n += 1;
      return handler(call);
    }) as unknown as typeof fetch;
    const deps: ToolHubDeps = { origin: "https://zcode.test", headers: { Authorization: "Bearer jwt" }, fetchImpl: impl, retryDelayMs: 1 };
    return { deps, calls };
  }

  const invokeOk = () => new Response(JSON.stringify({ code: 0, data: { state: "SUCCEEDED", output: { image_url: "https://img.test/out.png" } } }), { headers: { "content-type": "application/json" } });

  it("passes https references through WITHOUT an upload round-trip", async () => {
    const { deps, calls } = stubToolhub([invokeOk]);
    const resolved = await resolveReferenceImage(deps, "https://r.test/a.png");
    expect(resolved).toBe("https://r.test/a.png");
    expect(calls.length).toBe(0);
  });

  it("uploads a data: reference first, then invokes with the presigned url", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64");
    const { deps, calls } = stubToolhub([
      () => new Response(JSON.stringify({ code: 0, data: { url: "https://files.test/ref.png" } }), { headers: { "content-type": "application/json" } }),
      invokeOk,
    ]);
    const resolved = await resolveReferenceImage(deps, `data:image/png;base64,${png}`);
    expect(resolved).toBe("https://files.test/ref.png");
    expect(calls[0].url).toContain("/api/v1/toolhub/files");
    expect(calls[0].body instanceof FormData).toBe(true);
  });

  it("rejects non-https non-data references before any upstream call", async () => {
    const { deps, calls } = stubToolhub([invokeOk]);
    await expect(resolveReferenceImage(deps, "http://r.test/a.png")).rejects.toThrow(/https/);
    expect(calls.length).toBe(0);
  });

  it("rejects non-standard base64 data: references before any upstream call (mirror of the plugin's strict check)", async () => {
    const { deps, calls } = stubToolhub([invokeOk]);
    const bad = [
      "data:image/png;base64,AA-A", // URL-safe alphabet char
      "data:image/png;base64,A", // length % 4 == 1
      "data:image/png;base64,QUJD=", // non-canonical padding on a full group
      "data:image/png;base64,QU%2BD", // percent-encoded
    ];
    for (const image of bad) {
      await expect(resolveReferenceImage(deps, image)).rejects.toThrow(/standard base64/);
    }
    expect(calls.length).toBe(0);
  });
});

describe("seed-video — outgoing body + validation", () => {
  it("buildToolhubVideoBody mirrors buildSubmitBody field-for-field (first/last frames exclusive)", () => {
    const body = buildToolhubVideoBody({ prompt: "x", images: ["https://r.test/a.png"], videos: ["asset://v"], duration: 8 });
    expect(body).toEqual({ query: "x", duration: 8, images: ["https://r.test/a.png"], videos: ["asset://v"] });
    const frames = buildToolhubVideoBody({ prompt: "x", firstFrame: "https://r.test/f.png", lastFrame: "https://r.test/l.png" });
    expect(frames).toEqual({ query: "x", first_frame: "https://r.test/f.png", last_frame: "https://r.test/l.png" });
  });

  it("validateVideoMaterialUrls rejects data:/http: videos and oversized inline audio", () => {
    expect(validateVideoMaterialUrls({ prompt: "x", videos: ["data:video/mp4;base64,AAA"] })).toEqual({
      ok: false,
      message: expect.stringContaining("https:// or asset://"),
    });
    const bigAudio = validateVideoMaterialUrls({ prompt: "x", audios: [`data:audio/wav;base64,${"A".repeat(3 * 1024 * 1024)}`] });
    expect(bigAudio.ok).toBe(false);
    const good = validateVideoMaterialUrls({ prompt: "x", audios: [`data:audio/wav;base64,${"A".repeat(64)}`] });
    expect(good.ok).toBe(true);
  });

});

describe("seed-asr — flash mapping", () => {
  it("parses audio.data/format/language and ignores user/request", () => {
    const req = okParse(parseAsrFlashRequest({ user: { uid: "u" }, audio: { data: "QUJD", format: "mp3", language: "zh-CN" }, request: { model_name: "bigmodel", enable_itn: true } }));
    expect(req).toEqual({ audioBase64: "QUJD", audioFormat: "mp3", language: "zh-CN" });
    expect(errParse(parseAsrFlashRequest({ audio: { format: "mp3" } })).message).toContain("audio.data");
    expect(errParse(parseAsrFlashRequest({ audio: { data: "QUJD" } })).message).toContain("audio.format");
  });

  it("buildTranscribeArguments fills ALL 8 required fields (server dropped omitempty)", () => {
    const args = buildTranscribeArguments({ audioBase64: "QUJD", audioFormat: "wav", language: "en-US" });
    expect(Object.keys(args).sort()).toEqual([
      "audio_base64", "chunk_seconds", "input_format", "input_path", "language", "retries", "retry_backoff_seconds", "timeout_seconds",
    ]);
    expect(args).toEqual({
      audio_base64: "QUJD",
      input_format: "wav",
      input_path: "",
      language: "en-US",
      timeout_seconds: 0,
      chunk_seconds: 0,
      retries: 0,
      retry_backoff_seconds: 0,
    });
  });

  it("mapTranscriptToFlash converts seconds→ms and threads speakers through additions", () => {
    const mapped = mapTranscriptToFlash({
      transcript: {
        text: "你好",
        audio_duration_seconds: 1.5,
        segments: [
          { speaker: "1", text: "你好", start: 0.1, end: 0.9, words: [{ text: "你", start: 0.1, end: 0.5 }, { text: "好", start: 0.5, end: 0.9 }] },
        ],
      },
      usage: { seconds: 2 },
    });
    expect(mapped.silent).toBeUndefined();
    expect(mapped.response!.result.text).toBe("你好");
    expect(mapped.response!.audio_info).toEqual({ duration: 1500 });
    const u = mapped.response!.result.utterances[0];
    expect(u.start_time).toBe(100);
    expect(u.end_time).toBe(900);
    expect(u.additions).toEqual({ speaker: "1" });
    expect(u.words).toEqual([{ text: "你", start_time: 100, end_time: 500 }, { text: "好", start_time: 500, end_time: 900 }]);
  });

  it("reports silent audio instead of an empty transcript", () => {
    expect(mapTranscriptToFlash({ silent_audio: true }).silent).toBe(true);
  });
});

describe("seed-tts — create mapping", () => {
  it("parses defaults (mp3/48000/neutral rates) and the voice reference", () => {
    const req = okParse(parseTtsCreateRequest({ model: "seed-tts-2", text_prompt: "你好", references: [{ speaker: "zh_female_1" }] }));
    expect(req.outputFormat).toBe("mp3");
    expect(req.sampleRate).toBe(48000);
    expect(req.speechRate).toBe(0);
    expect(req.pitchRate).toBe(0);
    expect(req.loudnessRate).toBe(0);
    expect(req.voice).toBe("zh_female_1");
  });

  it("validates ranges and formats", () => {
    expect(errParse(parseTtsCreateRequest({ text_prompt: "" })).kind).toBe("param");
    expect(errParse(parseTtsCreateRequest({ model: "m", text_prompt: "x", audio_config: { format: "flac" } })).message).toContain("format");
    expect(errParse(parseTtsCreateRequest({ model: "m", text_prompt: "x", audio_config: { sample_rate: 11025 } })).message).toContain("sample_rate");
    expect(errParse(parseTtsCreateRequest({ model: "m", text_prompt: "x", audio_config: { pitch_rate: 13 } })).message).toContain("pitch_rate");
    expect(errParse(parseTtsCreateRequest({ model: "m", text_prompt: "x", audio_config: { speech_rate: 101 } })).message).toContain("speech_rate");
    expect(errParse(parseTtsCreateRequest({ model: "m", text_prompt: "x", audio_config: { loudness_rate: -51 } })).message).toContain("loudness_rate");
    expect(okParse(parseTtsCreateRequest({ model: "m", text_prompt: "x", audio_config: { format: "ogg_opus", sample_rate: 24000, speech_rate: 50, pitch_rate: -12, loudness_rate: 100 } })).outputFormat).toBe("ogg_opus");
  });

  it("rewrites the client model to \"\" on the proxy side (video_edit only accepts empty) and rejects >1 voice references", () => {
    const noModel = okParse(parseTtsCreateRequest({ text_prompt: "x" }));
    expect(noModel.model).toBe("");
    // 实弹 2026-11-14：任何非空 model（"bigmodel"/"seed-tts-2"）→ upstream internal_error——
    // 无论用户带什么 model 来，出线一律改写成空串。
    const anyModel = okParse(parseTtsCreateRequest({ model: "seed-tts-2", text_prompt: "x" }));
    expect(anyModel.model).toBe("");
    expect(errParse(parseTtsCreateRequest({ model: "m", text_prompt: "x", references: [{ speaker: "a" }, { speaker: "b" }] })).message).toContain("one voice reference");
  });

  it("buildSynthesizeArguments fills ALL 11 required fields, zero-values included", () => {
    const args = buildSynthesizeArguments({ model: "m", text: "hi", outputFormat: "mp3", sampleRate: 48000, speechRate: 10, pitchRate: -3, loudnessRate: 0 });
    expect(Object.keys(args).sort()).toEqual([
      "loudness_rate", "model", "output_format", "pitch_rate", "sample_mode", "sample_rate", "speech_rate", "speed", "style_instructions", "text", "voice",
    ]);
    expect(args.voice).toBe("");
    expect(args.speed).toBe(0);
    expect(args.style_instructions).toBe("");
    expect(args.sample_mode).toBe(false);
  });

  it("mapSynthesizeResponse passes audio/duration/subtitle/usage through", () => {
    const out = mapSynthesizeResponse({ audio_base64: "AAA=", duration: 2.5, subtitle: { words: [] }, usage: { chars: 2 } });
    expect(out).toEqual({ code: 0, data: "AAA=", duration: 2.5, subtitle: { words: [] }, usage: { chars: 2 } });
    let err: unknown;
    try {
      mapSynthesizeResponse({});
    } catch (caught) {
      err = caught;
    }
    expect(err).toBeInstanceOf(MediaUpstreamError);
    expect((err as MediaUpstreamError).kind).toBe("upstream");
  });
});
