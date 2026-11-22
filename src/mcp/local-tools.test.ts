/**
 * Local MCP media tool tests — the handler layer over the ToolHub
 * translation (src/media/*): argument mapping per the official plugin tool
 * schemas, the submit+wait semantics (submit → poll → task_id handed back),
 * animations libraries, and the no-workspace deviation (local paths rejected,
 * output_path/output_dir ignored).
 *
 * Wait loops are collapsed via injected pollIntervalMs/waitBudgetMs (no fake
 * timers); the fetchImpl stub answers invoke → query sequences by URL.
 */
import { describe, it, expect } from "bun:test";
import { callLocalTool, findLocalTool, LOCAL_MCP_TOOLS } from "./local-tools.js";
import type { LocalToolContext } from "./local-tools.js";
import { submitToolhubTask, type ToolHubDeps } from "../media/toolhub.js";

const json = (data: unknown, code = 0) => new Response(JSON.stringify({ code, data }), { status: 200, headers: { "content-type": "application/json" } });
const submitOk = (taskId: string) => json({ state: "SUCCEEDED", output: { task_id: taskId } });

interface RecordedCall {
  url: string;
  headers: Record<string, string>;
  body: string | FormData;
}

function makeCtx(responder: (call: { url: string; headers: Record<string, string>; body: string | FormData }) => Response) {
  const calls: RecordedCall[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const call: RecordedCall = {
      url: String(input),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: (init?.body as string | FormData) ?? "",
    };
    calls.push(call);
    return responder(call);
  }) as unknown as typeof fetch;
  const ctx: LocalToolContext = {
    origin: "https://media.test",
    headers: { Authorization: "Bearer jwt" },
    fetchImpl: impl,
    retryDelayMs: 1,
    pollIntervalMs: 1,
    waitBudgetMs: 50,
  };
  return { ctx, calls };
}

function makeDeps(responder: (call: { url: string; body: string | FormData }) => Response): ToolHubDeps & { calls: RecordedCall[] } {
  const { ctx, calls } = makeCtx(responder);
  return { origin: ctx.origin, headers: ctx.headers, fetchImpl: ctx.fetchImpl, retryDelayMs: 1, calls };
}

const invokeUrl = (tool: string) => `https://media.test/api/v1/toolhub/tool/${tool}/invoke`;
const queryUrl = (tool: string) => `https://media.test/api/v1/toolhub/tool/${tool}/tasks/query`;

describe("registry", () => {
  it("exposes exactly 13 tools across the six official plugin names", () => {
    expect(LOCAL_MCP_TOOLS.length).toBe(13);
    const plugins = new Set(LOCAL_MCP_TOOLS.map((t) => t.plugin));
    expect([...plugins].sort()).toEqual(["hi3d-3d", "happyhorse-video", "hyper3d-3d", "image-generation", "meshy-3d", "video-generation"].sort());
    for (const t of LOCAL_MCP_TOOLS) {
      expect(findLocalTool(`${t.plugin}__${t.name}`)).toBe(t);
      expect(typeof t.description).toBe("string");
      expect((t.inputSchema as { type: string }).type).toBe("object");
    }
  });

  it("findLocalTool returns undefined for upstream-only or malformed names", () => {
    expect(findLocalTool("wind__quote")).toBeUndefined();
    expect(findLocalTool("happyhorse-video__generate_video")).toBeUndefined();
    expect(findLocalTool("generate_image")).toBeUndefined();
  });
});

describe("image-generation__generate_image", () => {
  it("invokes image_generate with the query and returns the URL", async () => {
    const { ctx, calls } = makeCtx(() => json({ state: "SUCCEEDED", output: { image_url: "https://img.test/x.png" } }));
    const out = await callLocalTool(findLocalTool("image-generation__generate_image")!, { prompt: "a cat" }, ctx);
    expect(out.isError).toBeUndefined();
    expect(out.content[0].text).toContain("https://img.test/x.png");
    expect(out.structuredContent).toEqual({ image_url: "https://img.test/x.png" });
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe(invokeUrl("image_generate"));
    expect(JSON.parse(calls[0].body as string)).toEqual({ query: "a cat" });
    expect(calls[0].headers["idempotency-key"]).toMatch(/[0-9a-f-]{36}/);
  });

  it("uploads a data: reference first, then invokes with the presigned url (strict base64)", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64");
    const { ctx, calls } = makeCtx((call) =>
      call.url.endsWith("/toolhub/files") ? json({ url: "https://files.test/ref.png" }) : json({ state: "SUCCEEDED", output: { image_url: "https://img.test/x.png" } }),
    );
    const out = await callLocalTool(findLocalTool("image-generation__generate_image")!, { prompt: "x", reference_image: `data:image/png;base64,${png}` }, ctx);
    expect(out.isError).toBeUndefined();
    expect(calls[0].url).toContain("/toolhub/files");
    expect(JSON.parse(calls[1].body as string).image).toBe("https://files.test/ref.png");
  });

  it("rejects local-path references and empty prompts before any upstream call", async () => {
    const { ctx, calls } = makeCtx(() => json({}));
    const localPath = await callLocalTool(findLocalTool("image-generation__generate_image")!, { prompt: "x", reference_image: "C:/tmp/a.png" }, ctx);
    expect(localPath.isError).toBe(true);
    expect(localPath.content[0].text).toContain("https");
    const noPrompt = await callLocalTool(findLocalTool("image-generation__generate_image")!, {}, ctx);
    expect(noPrompt.isError).toBe(true);
    expect(calls.length).toBe(0);
  });
});

describe("video-generation__generate_video / get_video_result", () => {
  it("maps plugin args 1:1 onto the ToolHub body and waits to succeeded", async () => {
    const { ctx, calls } = makeCtx((call) => {
      if (call.url.endsWith("/invoke")) return submitOk("task-v1");
      return json({ status: "succeeded", output: { video_url: "https://v.test/a.mp4" } });
    });
    const out = await callLocalTool(
      findLocalTool("video-generation__generate_video")!,
      { prompt: "x", duration: 8, ratio: "9:16", images: ["https://r.test/a.png"] },
      ctx,
    );
    expect(out.isError).toBeUndefined();
    expect(out.structuredContent).toEqual({ status: "succeeded", task_id: "task-v1", video_url: "https://v.test/a.mp4" });
    const body = JSON.parse(calls[0].body as string) as Record<string, unknown>;
    expect(body).toEqual({ query: "x", duration: 8, ratio: "9:16", images: ["https://r.test/a.png"] });
    expect(calls[0].url).toBe(invokeUrl("video_generate"));
    expect(calls[calls.length - 1].url).toBe(queryUrl("video_generate"));
  });

  it("honors request_id as the Idempotency-Key (replay contract)", async () => {
    const { ctx, calls } = makeCtx(() => submitOk("task-v2"));
    await callLocalTool(findLocalTool("video-generation__generate_video")!, { prompt: "x", request_id: "req_1" }, ctx);
    expect(calls[0].headers["idempotency-key"]).toBe("req_1");
  });

  it("returns the task_id when the wait budget lapses (never resubmits)", async () => {
    const { ctx, calls } = makeCtx((call) => (call.url.endsWith("/invoke") ? submitOk("task-v3") : json({ status: "running" })));
    const out = await callLocalTool(findLocalTool("video-generation__generate_video")!, { prompt: "x" }, ctx);
    expect(out.isError).toBeUndefined();
    expect(out.structuredContent).toEqual({ status: "running", task_id: "task-v3" });
    expect(out.content[0].text).toContain("task-v3");
    expect(out.content[0].text).toContain("不要重新提交");
    // exactly one submit, then repeated queries
    expect(calls.filter((c) => c.url.endsWith("/invoke")).length).toBe(1);
    expect(calls.filter((c) => c.url.endsWith("/tasks/query")).length).toBeGreaterThan(1);
  });

  it("surfaces failure as an isError result (no retry, no resubmit)", async () => {
    const { ctx, calls } = makeCtx((call) => (call.url.endsWith("/invoke") ? submitOk("task-v4") : json({ status: "failed", failure: { code: "MODERATION", message: "rejected" } })));
    const out = await callLocalTool(findLocalTool("video-generation__generate_video")!, { prompt: "x" }, ctx);
    expect(out.isError).toBe(true);
    expect(out.content[0].text).toContain("MODERATION");
    expect(calls.filter((c) => c.url.endsWith("/invoke")).length).toBe(1);
  });

  it("validates plugin-schema rules locally (frames exclusivity, duration, local paths)", async () => {
    const { ctx, calls } = makeCtx(() => submitOk("t"));
    const frames = await callLocalTool(
      findLocalTool("video-generation__generate_video")!,
      { prompt: "x", first_frame: "https://r.test/f.png", images: ["https://r.test/a.png"] },
      ctx,
    );
    expect(frames.isError).toBe(true);
    expect(frames.content[0].text).toContain("互斥");
    const lastOnly = await callLocalTool(findLocalTool("video-generation__generate_video")!, { prompt: "x", last_frame: "https://r.test/l.png" }, ctx);
    expect(lastOnly.isError).toBe(true);
    const badDuration = await callLocalTool(findLocalTool("video-generation__generate_video")!, { prompt: "x", duration: 31 }, ctx);
    expect(badDuration.isError).toBe(true);
    const localPath = await callLocalTool(findLocalTool("video-generation__generate_video")!, { prompt: "x", images: ["C:/tmp/a.png"] }, ctx);
    expect(localPath.isError).toBe(true);
    expect(localPath.content[0].text).toContain("本地路径");
    expect(calls.length).toBe(0);
  });

  it("get_video_result waits on the given task and maps succeeded", async () => {
    const { ctx, calls } = makeCtx(() => json({ status: "succeeded", output: { video_url: "https://v.test/b.mp4" } }));
    const out = await callLocalTool(findLocalTool("video-generation__get_video_result")!, { task_id: "task-9" }, ctx);
    expect(out.structuredContent).toEqual({ status: "succeeded", task_id: "task-9", video_url: "https://v.test/b.mp4" });
    expect(calls.every((c) => c.url === queryUrl("video_generate"))).toBe(true);
  });
});

describe("happyhorse-video tools", () => {
  it("generate parses via the REST-era contract (mutual exclusion, enums) and waits", async () => {
    const { ctx, calls } = makeCtx((call) => {
      if (call.url.endsWith("/invoke")) return submitOk("hh-1");
      return json({ status: "succeeded", output: { video_url: "https://v.test/hh.mp4" } });
    });
    const out = await callLocalTool(
      findLocalTool("happyhorse-video__generate_happyhorse_video")!,
      { prompt: "x", duration: 3, resolution: "480p", first_frame: "https://r.test/f.png" },
      ctx,
    );
    expect(out.isError).toBeUndefined();
    expect(out.structuredContent).toEqual({ status: "succeeded", task_id: "hh-1", video_url: "https://v.test/hh.mp4" });
    const body = JSON.parse(calls[0].body as string) as Record<string, unknown>;
    expect(body).toEqual({ prompt: "x", duration: 3, resolution: "480P", image_url_list: ["https://r.test/f.png"] });
    expect(calls[0].url).toBe(invokeUrl("happyhorse_video"));
  });

  it("rejects first_frame + reference_images together before submit", async () => {
    const { ctx, calls } = makeCtx(() => submitOk("t"));
    const out = await callLocalTool(
      findLocalTool("happyhorse-video__generate_happyhorse_video")!,
      { prompt: "x", first_frame: "https://a.test/f.png", reference_images: ["https://a.test/r.png"] },
      ctx,
    );
    expect(out.isError).toBe(true);
    expect(out.content[0].text).toContain("mutually exclusive");
    expect(calls.length).toBe(0);
  });
});

describe("3D family (hyper3d / meshy / hi3d)", () => {
  it("submit forwards action fields, strips local fields, uploads data: materials", async () => {
    const png = Buffer.from([1, 2, 3]).toString("base64");
    const { ctx, calls } = makeCtx((call) => {
      if (call.url.endsWith("/toolhub/files")) return json({ url: "https://files.test/u.png" });
      if (call.url.endsWith("/invoke")) return submitOk("gen:abc~sub");
      return json({ status: "succeeded", output: { files: [{ name: "m.glb", url: "https://d.test/m.glb" }] } });
    });
    const out = await callLocalTool(
      findLocalTool("hyper3d-3d__submit_hyper3d_task")!,
      { action: "generate", prompt: "a sword", images: [`data:image/png;base64,${png}`], output_dir: "gen/", request_id: "r1" },
      ctx,
    );
    expect(out.isError).toBeUndefined();
    expect(out.structuredContent).toEqual({ status: "succeeded", task_id: "gen:abc~sub", files: [{ name: "m.glb", url: "https://d.test/m.glb" }] });
    const body = JSON.parse(calls[1].body as string) as Record<string, unknown>;
    // output_dir/request_id are local — never reach the upstream body (负向抑制)
    expect(body).toEqual({ action: "generate", prompt: "a sword", images: ["https://files.test/u.png"] });
    expect(calls[1].headers["idempotency-key"]).toBe("r1");
    expect(calls[1].headers["x-usage-scenario"]).toBe("hyper3d_model3d");
  });

  it("get keeps polling while products are unwritten, then maps the vendor shape (meshy model_urls)", async () => {
    let n = 0;
    const { ctx, calls } = makeCtx(() => {
      n += 1;
      // first poll: status flipped but products not written yet (plugin
      // contract — keep polling); second: the meshy success shape.
      return n === 1
        ? json({ status: "succeeded", output: {} })
        : json({ status: "succeeded", output: { model_urls: { glb: "https://d.test/a.glb", fbx: "" } } });
    });
    const out = await callLocalTool(findLocalTool("meshy-3d__get_meshy_task")!, { task_id: "preview:x" }, ctx);
    expect(out.isError).toBeUndefined();
    expect(out.structuredContent).toEqual({ status: "succeeded", task_id: "preview:x", files: [{ name: "glb", url: "https://d.test/a.glb" }] });
    expect(calls.length).toBe(2);
    expect(calls.every((c) => c.url === queryUrl("meshy_model3d"))).toBe(true);
  });

  it("hyper3d animations: invoke with action=animation_library, local search filter", async () => {
    const { ctx, calls } = makeCtx(() =>
      json({ state: "SUCCEEDED", output: { animations: [{ id: "walk_01", name: "Walk", category: "human" }, { id: "run_01", name: "Run", category: "human" }] } }),
    );
    const out = await callLocalTool(findLocalTool("hyper3d-3d__list_hyper3d_animations")!, { search: "walk" }, ctx);
    expect(out.isError).toBeUndefined();
    expect(out.content[0].text).toContain("walk_01");
    expect(out.content[0].text).not.toContain("run_01");
    expect(out.structuredContent).toEqual({ category: null, search: "walk", total: 1, animations: [{ id: "walk_01", name: "Walk", category: "human" }] });
    const body = JSON.parse(calls[0].body as string) as Record<string, unknown>;
    expect(body).toEqual({ action: "animation_library" });
    expect(calls[0].url).toBe(invokeUrl("hyper3d_model3d"));
  });

  it("meshy animations send search server-side", async () => {
    const { ctx, calls } = makeCtx(() => json({ state: "SUCCEEDED", output: { animations: [{ id: 5, name: "Walk" }] } }));
    await callLocalTool(findLocalTool("meshy-3d__list_meshy_animations")!, { search: "walk", category: "DailyActions" }, ctx);
    const body = JSON.parse(calls[0].body as string) as Record<string, unknown>;
    expect(body).toEqual({ action: "animation_library", search: "walk", category: "DailyActions" });
    expect(calls[0].headers["x-usage-scenario"]).toBe("meshy_model3d");
  });

  it("rejects unknown vendors via the vendor configs (no submit leak)", async () => {
    const { ctx, calls } = makeCtx(() => submitOk("t"));
    const out = await callLocalTool(findLocalTool("hi3d-3d__submit_hi3d_task")!, { action: "rig" }, ctx);
    expect(out.isError).toBe(true);
    expect(out.content[0].text).toContain("action must be one of");
    expect(calls.length).toBe(0);
  });
});

describe("submitToolhubTask — request_id shapes", () => {
  it("fails loudly on header-unsafe request_id (no silent re-key)", async () => {
    const deps = makeDeps(() => submitOk("t"));
    await expect(submitToolhubTask(deps, "happyhorse_video", { prompt: "x" }, "has space")).rejects.toThrow(/printable ASCII/);
    expect(deps.calls.length).toBe(0);
  });
});
