/**
 * Local (proxy-hosted) MCP tools — the media generation faces exposed on
 * `/mcp` as `{plugin}__{tool}` entries mirroring the official stdio plugins'
 * tool surfaces byte-for-byte (descriptions/inputSchema come verbatim from
 * official-media-tools.json, probed from the real plugin servers).
 *
 * Families (2026-11-22, user decision "API 路线换回 MCP 路线" — the four REST
 * faces this replaces are removed):
 *   image-generation  → generate_image              → toolhub image_generate
 *   video-generation  → generate_video/get_result  → toolhub video_generate
 *   happyhorse-video  → generate/get pair          → toolhub happyhorse_video
 *   hyper3d-3d        → submit/get/animations      → toolhub hyper3d_model3d
 *   meshy-3d          → submit/get/animations      → toolhub meshy_model3d
 *   hi3d-3d           → submit/get                 → toolhub hi3d_model3d
 *
 * Deliberate deviations vs the official plugins (declared per-tool via the
 * suffix appended to the official description):
 *   - no workspace: the plugin face saves products into the caller's project
 *     dir and accepts local-path materials (it runs with cwd = project). This
 *     face is server-side with no filesystem — products come back as
 *     temporary URLs (output_path/output_dir accepted and IGNORED), and
 *     local-path materials are rejected (https:// or data: only);
 *   - generate tools WAIT inside the call (official behavior: submit + poll,
 *     return task_id again when the budget lapses) — poll interval 12s per
 *     the plugin contract (upstream rate-limits account-wide);
 *   - hyper3d animations search filters locally (upstream has no search);
 *     meshy sends search server-side — both mirrored.
 *
 * Tool errors are MCP `isError` results with the message as text — NOT
 * JSON-RPC errors (the official host converts plugin ToolErrors the same way).
 *
 * @see official-media-tools.json（sidecar：13 工具官方原文）
 * @see ../media/toolhub-tasks.ts（happyhorse/3D 翻译层）
 * @see ../media/toolhub.ts（invokeImage/submitVideo/queryVideo/invokeToolLibrary）
 */
import officialRaw from "./official-media-tools.json" with { type: "json" };
import { MediaUpstreamError } from "../media/shared.js";
import { invokeImage, invokeToolLibrary, queryVideo, submitToolhubTask, type ToolHubDeps } from "../media/toolhub.js";
import { buildToolhubVideoBody, normalizeGenerateAudio, validateVideoMaterialUrls, VIDEO_RATIOS } from "../media/seed-video.js";
import { resolveReferenceImage } from "../media/seed-image.js";
import { createHappyhorseVideo, createModel3dTask, getHappyhorseVideo, getModel3dTask, MODEL3D_VENDORS, parseHappyhorseSubmit } from "../media/toolhub-tasks.js";

export interface LocalToolContext {
  origin: string;
  /** Official identity headers (buildOfficialMcpAuthHeaders output). */
  headers: Record<string, string>;
  fetchImpl: typeof fetch;
  /** Same-key retry backoff for ToolHub calls (production 5s; tests ~1ms). */
  retryDelayMs?: number;
  /** Task poll interval (production 12s per plugin contract; tests ~1ms). */
  pollIntervalMs?: number;
  /** Submit+wait budget per call (production 280s < the hosts' 330s timeoutMs). */
  waitBudgetMs?: number;
}

export interface LocalToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

export interface LocalToolDef {
  plugin: string;
  name: string;
  description: string;
  inputSchema: unknown;
  annotations?: Record<string, unknown>;
  handler(args: Record<string, unknown>, ctx: LocalToolContext): Promise<LocalToolResult>;
}

const DEVIATION_NOTE =
  "\n\n【zcode-proxy 差异】本面无工作区文件系统：产物以临时 URL 返回（不落盘，output_path/output_dir 仅忽略）；素材不支持本地路径，请用 https:// 或 data: URL。";

/** HappyHorse：官方契约 https-only，data: 直接拒（避免把 agent 引向必败输入，review 2026-11-22 minor） */
const DEVIATION_NOTE_HTTPS_ONLY =
  "\n\n【zcode-proxy 差异】本面无工作区文件系统：产物以临时 URL 返回（不落盘，output_path 仅忽略）；素材不支持本地路径且仅收 https:// URL（HappyHorse 不接受 data:）。";
/** SeedDance：图片/音频收 data:，参考视频仅 https/asset */
const DEVIATION_NOTE_VIDEO =
  "\n\n【zcode-proxy 差异】本面无工作区文件系统：产物以临时 URL 返回（不落盘，output_path 仅忽略）；素材不支持本地路径——图片/音频可用 https:// 或 data: URL，参考视频仅 https:// 或 asset://。";

/**
 * Billing-scenario header values (X-Usage-Scenario) for the Seed faces — the
 * official plugins' `USAGE_SCENARIO` constants, verbatim: image-generation
 * 0.1.2 → "seedream-image", video-generation 0.2.1/0.3.0 → "seedance-video".
 * Both plugins send the header on EVERY ToolHub call (submit, query and the
 * file upload go through one `apiRequest`). The 3D family carries its own
 * values on MODEL3D_VENDORS; the video-agent-kit uses "video-kit".
 *
 * Correction (2026-11-25): an earlier note here claimed the Seed plugins do
 * NOT send this header and that omitting it was the correct mirror. That was
 * a grep false negative — the header has been in both plugins all along, and
 * our Seed faces were the only ToolHub callers without it.
 */
const SEEDREAM_USAGE_SCENARIO = "seedream-image";
const SEEDANCE_USAGE_SCENARIO = "seedance-video";

const POLL_INTERVAL_MS = 12_000;
const WAIT_BUDGET_MS = 280_000;
const ANIMATION_LIST_LINES = 30;
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function ok(text: string, structured?: Record<string, unknown>): LocalToolResult {
  return { content: [{ type: "text", text }], ...(structured ? { structuredContent: structured } : {}) };
}

function fail(message: string): LocalToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Integer-or-numeric-string arg (plugin schemas type durations as ["integer","string"]). */
function intArg(value: unknown, label: string, min: number, max: number, extra?: Set<number>): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const n = typeof value === "string" && value.trim() !== "" ? Number(value.trim()) : value;
  if (typeof n !== "number" || !Number.isInteger(n) || (!extra?.has(n) && (n < min || n > max))) {
    throw new MediaUpstreamError(`${label} must be an integer ${min}..${max}${extra ? ` or ${[...extra].join("/")}` : ""}`, "param");
  }
  return n;
}

/** Material scheme gate for this face: local paths rejected (no filesystem). */
function remoteMaterial(value: string, label: string, schemes: Array<"https" | "data" | "asset">): string {
  const item = value.trim();
  const patterns: Array<[string, RegExp]> = [
    ["https", /^https:\/\//i],
    ["data", /^data:/i],
    ["asset", /^asset:\/\//i],
  ];
  for (const [name, re] of patterns) {
    if (schemes.includes(name as "https" | "data" | "asset") && re.test(item)) return item;
  }
  throw new MediaUpstreamError(
    `${label} 不支持本地路径（本面无工作区）——请用 ${schemes.join(" / ")} URL`,
    "param",
  );
}

/**
 * Wait loop mirroring the official submit+get semantics: poll until done /
 * terminal failure, return the still-running result (task_id handed back)
 * when the budget lapses. Query errors: terminal kinds surface immediately,
 * transient ones keep polling.
 */
async function waitLoop(
  ctx: LocalToolContext,
  taskId: string,
  poll: () => Promise<{ kind: "running"; status: string } | { kind: "done"; text: string; structured: Record<string, unknown> } | { kind: "failed"; text: string }>,
): Promise<LocalToolResult> {
  const interval = ctx.pollIntervalMs ?? POLL_INTERVAL_MS;
  const budget = ctx.waitBudgetMs ?? WAIT_BUDGET_MS;
  const deadline = Date.now() + budget;
  let lastStatus = "unknown";
  for (;;) {
    let step: { kind: "running"; status: string } | { kind: "done"; text: string; structured: Record<string, unknown> } | { kind: "failed"; text: string };
    try {
      step = await poll();
    } catch (err) {
      // Terminal kinds surface immediately: not_found/forbidden are task-level
      // verdicts; auth (HTTP 401, expired credential) and param can never
      // recover by polling — hiding them behind the budget would burn ~280s
      // per call and never name the cause (review 2026-11-22 #2).
      if (err instanceof MediaUpstreamError && (err.kind === "not_found" || err.kind === "forbidden" || err.kind === "auth" || err.kind === "param")) {
        return fail(`任务查询失败：${err.message}`);
      }
      // Transient query hiccup (network/2007/3702) — keep polling.
      step = { kind: "running", status: "query-retry" };
    }
    if (step.kind === "done") return ok(step.text, step.structured);
    if (step.kind === "failed") return fail(step.text);
    lastStatus = step.status;
    if (Date.now() + interval > deadline) {
      return ok(
        `任务还在生成（${lastStatus}），task_id：${taskId}\n请稍后调用对应的 get_*_result/task 查询工具继续等待，不要重新提交（会重复扣费）。`,
        { status: lastStatus, task_id: taskId },
      );
    }
    await sleep(interval);
  }
}

// ── image-generation ────────────────────────────────────────────────────────

async function generateImageHandler(args: Record<string, unknown>, ctx: LocalToolContext): Promise<LocalToolResult> {
  const deps: ToolHubDeps = { origin: ctx.origin, headers: ctx.headers, fetchImpl: ctx.fetchImpl, ...(ctx.retryDelayMs !== undefined ? { retryDelayMs: ctx.retryDelayMs } : {}), usageScenario: SEEDREAM_USAGE_SCENARIO };
  const prompt = str(args.prompt);
  if (!prompt) return fail("prompt 必须是非空字符串。");
  let image: string | undefined;
  if (args.reference_image !== undefined && args.reference_image !== null) {
    if (typeof args.reference_image !== "string" || !args.reference_image.trim()) {
      return fail("reference_image 必须是 https:// 或 data:image/...;base64 URL（本面不支持本地路径）。");
    }
    image = await resolveReferenceImage(deps, args.reference_image);
  }
  const { imageUrl } = await invokeImage(deps, image ? { query: prompt, image } : { query: prompt });
  return ok(
    `图片已生成（临时链接，会过期）：\n${imageUrl}\n【zcode-proxy：产物未保存到工作区——output_path 已忽略，请从链接下载。】`,
    { image_url: imageUrl },
  );
}

// ── video-generation (SeedDance) ────────────────────────────────────────────

const VIDEO_MATERIAL_SCHEMES: Array<"https" | "data" | "asset"> = ["https", "data", "asset"];
const VIDEO_STRICT_SCHEMES: Array<"https" | "asset"> = ["https", "asset"];

function videoPoller(ctx: LocalToolContext, taskId: string) {
  const deps: ToolHubDeps = { origin: ctx.origin, headers: ctx.headers, fetchImpl: ctx.fetchImpl, ...(ctx.retryDelayMs !== undefined ? { retryDelayMs: ctx.retryDelayMs } : {}), usageScenario: SEEDANCE_USAGE_SCENARIO };
  return async () => {
    const snapshot = await queryVideo(deps, taskId);
    if (snapshot.status === "succeeded" && snapshot.videoUrl) {
      return {
        kind: "done" as const,
        text: `视频已生成（临时链接，会过期）：\n${snapshot.videoUrl}\ntask_id：${taskId}\n【zcode-proxy：产物未保存到工作区——output_path 已忽略，请从链接下载。】`,
        structured: { status: "succeeded", task_id: taskId, video_url: snapshot.videoUrl },
      };
    }
    if (snapshot.status === "failed") {
      const f = snapshot.failure ?? {};
      return {
        kind: "failed" as const,
        text: `视频生成失败（${f.code ?? "upstream_failure"}：${f.message ?? "upstream reported failure"}）。`,
      };
    }
    return { kind: "running" as const, status: snapshot.status };
  };
}

async function generateVideoHandler(args: Record<string, unknown>, ctx: LocalToolContext): Promise<LocalToolResult> {
  const deps: ToolHubDeps = { origin: ctx.origin, headers: ctx.headers, fetchImpl: ctx.fetchImpl, ...(ctx.retryDelayMs !== undefined ? { retryDelayMs: ctx.retryDelayMs } : {}), usageScenario: SEEDANCE_USAGE_SCENARIO };
  const prompt = str(args.prompt);
  if (!prompt) return fail("prompt 必须是非空字符串。");

  const images = strList(args.images, "images", 9, VIDEO_MATERIAL_SCHEMES);
  const videos = strList(args.videos, "videos", 3, VIDEO_STRICT_SCHEMES);
  const audios = strList(args.audios, "audios", 3, VIDEO_MATERIAL_SCHEMES);
  let firstFrame: string | undefined;
  let lastFrame: string | undefined;
  if (args.first_frame !== undefined && args.first_frame !== null) {
    if (typeof args.first_frame !== "string" || !args.first_frame.trim()) return fail("first_frame 必须是非空字符串。");
    firstFrame = remoteMaterial(args.first_frame, "first_frame", VIDEO_MATERIAL_SCHEMES);
  }
  if (args.last_frame !== undefined && args.last_frame !== null) {
    if (typeof args.last_frame !== "string" || !args.last_frame.trim()) return fail("last_frame 必须是非空字符串。");
    lastFrame = remoteMaterial(args.last_frame, "last_frame", VIDEO_MATERIAL_SCHEMES);
  }
  if ((firstFrame || lastFrame) && images.length + videos.length + audios.length > 0) {
    return fail("first_frame/last_frame 与参考素材互斥（官方插件契约）。");
  }
  if (lastFrame && !firstFrame) return fail("last_frame 必须同时传 first_frame。");
  let ratio: string | undefined;
  if (args.ratio !== undefined && args.ratio !== null) {
    const candidate = typeof args.ratio === "string" ? args.ratio.trim().toLowerCase() : "";
    if (!VIDEO_RATIOS.has(candidate)) return fail(`ratio 必须是 ${[...VIDEO_RATIOS].join(" / ")} 之一。`);
    ratio = candidate;
  }
  let duration: number | undefined;
  try {
    duration = intArg(args.duration, "duration", 4, 30, new Set([-1]));
  } catch (err) {
    return fail(errText(err));
  }
  // 0.3.0 output-audio flag — same normalization as the plugin's generateAudioArg.
  let generateAudio: boolean | undefined;
  try {
    generateAudio = normalizeGenerateAudio(args.generate_audio);
  } catch (err) {
    return fail(errText(err));
  }

  const req = {
    prompt,
    ...(images.length ? { images } : {}),
    ...(videos.length ? { videos } : {}),
    ...(audios.length ? { audios } : {}),
    ...(firstFrame ? { firstFrame } : {}),
    ...(lastFrame ? { lastFrame } : {}),
    ...(duration !== undefined ? { duration } : {}),
    ...(ratio ? { ratio } : {}),
    ...(generateAudio !== undefined ? { generateAudio } : {}),
  };
  const materialCheck = validateVideoMaterialUrls(req);
  if (!materialCheck.ok) return fail(materialCheck.message);
  const requestId = str(args.request_id);
  let taskId: string;
  try {
    taskId = (await submitToolhubTask(deps, "video_generate", buildToolhubVideoBody(req), requestId)).taskId;
  } catch (err) {
    return fail(errText(err));
  }
  return waitLoop(ctx, taskId, videoPoller(ctx, taskId));
}

async function getVideoResultHandler(args: Record<string, unknown>, ctx: LocalToolContext): Promise<LocalToolResult> {
  const taskId = str(args.task_id);
  if (!taskId) return fail("task_id 必须是非空字符串。");
  return waitLoop(ctx, taskId, videoPoller(ctx, taskId));
}

function strList(value: unknown, label: string, max: number, schemes: Array<"https" | "data" | "asset">): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new MediaUpstreamError(`${label} 必须是字符串数组`, "param");
  if (value.length > max) throw new MediaUpstreamError(`${label} 最多 ${max} 个`, "param");
  return value.map((item, i) => {
    if (typeof item !== "string" || !item.trim()) {
      throw new MediaUpstreamError(`${label}[${i}] 必须是非空字符串`, "param");
    }
    return remoteMaterial(item, `${label}[${i}]`, schemes);
  });
}

// ── happyhorse ──────────────────────────────────────────────────────────────

function happyhorsePoller(ctx: LocalToolContext, taskId: string) {
  const deps: ToolHubDeps = { origin: ctx.origin, headers: ctx.headers, fetchImpl: ctx.fetchImpl, ...(ctx.retryDelayMs !== undefined ? { retryDelayMs: ctx.retryDelayMs } : {}) };
  return async () => {
    const snap = await getHappyhorseVideo(deps, taskId);
    if (snap.status === "succeeded" && snap.video_url) {
      return {
        kind: "done" as const,
        text: `视频已生成（临时链接，会过期）：\n${snap.video_url}\ntask_id：${taskId}\n【zcode-proxy：产物未保存到工作区——output_path 已忽略，请从链接下载。】`,
        structured: { status: "succeeded", task_id: taskId, video_url: snap.video_url },
      };
    }
    if (snap.status === "failed") {
      return {
        kind: "failed" as const,
        text: `视频生成失败（${snap.error?.code ?? "upstream_failure"}：${snap.error?.message ?? "upstream reported failure"}）。`,
      };
    }
    return { kind: "running" as const, status: snap.status };
  };
}

async function generateHappyhorseHandler(args: Record<string, unknown>, ctx: LocalToolContext): Promise<LocalToolResult> {
  const deps: ToolHubDeps = { origin: ctx.origin, headers: ctx.headers, fetchImpl: ctx.fetchImpl, ...(ctx.retryDelayMs !== undefined ? { retryDelayMs: ctx.retryDelayMs } : {}) };
  const parsed = parseHappyhorseSubmit(args);
  if (!parsed.ok) return fail(parsed.message);
  let taskId: string;
  try {
    taskId = (await createHappyhorseVideo(deps, parsed.req)).task_id;
  } catch (err) {
    return fail(errText(err));
  }
  return waitLoop(ctx, taskId, happyhorsePoller(ctx, taskId));
}

async function getHappyhorseResultHandler(args: Record<string, unknown>, ctx: LocalToolContext): Promise<LocalToolResult> {
  const taskId = str(args.task_id);
  if (!taskId) return fail("task_id 必须是非空字符串。");
  return waitLoop(ctx, taskId, happyhorsePoller(ctx, taskId));
}

// ── 3D family (hyper3d / meshy / hi3d) ──────────────────────────────────────

function model3dPoller(ctx: LocalToolContext, vendor: string, taskId: string) {
  const deps: ToolHubDeps = { origin: ctx.origin, headers: ctx.headers, fetchImpl: ctx.fetchImpl, ...(ctx.retryDelayMs !== undefined ? { retryDelayMs: ctx.retryDelayMs } : {}) };
  return async () => {
    const snap = await getModel3dTask(deps, vendor, taskId);
    if (snap.status === "succeeded" && snap.files?.length) {
      const lines = snap.files.map((f) => `- ${f.name || "file"}: ${f.url}`).join("\n");
      return {
        kind: "done" as const,
        text: `任务完成，产物（临时链接）：\n${lines}\ntask_id：${taskId}\n【zcode-proxy：产物未保存到工作区——output_dir 已忽略，请从链接下载。】`,
        structured: { status: "succeeded", task_id: taskId, files: snap.files },
      };
    }
    if (snap.status === "failed") {
      return {
        kind: "failed" as const,
        text: `任务失败（${snap.error?.code ?? "upstream_failure"}：${snap.error?.message ?? "upstream reported failure"}）——任务成功才扣费，失败不扣费。`,
      };
    }
    return { kind: "running" as const, status: snap.status };
  };
}

async function model3dSubmitHandler(vendor: string, args: Record<string, unknown>, ctx: LocalToolContext): Promise<LocalToolResult> {
  const deps: ToolHubDeps = { origin: ctx.origin, headers: ctx.headers, fetchImpl: ctx.fetchImpl, ...(ctx.retryDelayMs !== undefined ? { retryDelayMs: ctx.retryDelayMs } : {}) };
  let taskId: string;
  try {
    taskId = (await createModel3dTask(deps, vendor, args)).task_id;
  } catch (err) {
    return fail(errText(err));
  }
  return waitLoop(ctx, taskId, model3dPoller(ctx, vendor, taskId));
}

async function model3dGetHandler(vendor: string, args: Record<string, unknown>, ctx: LocalToolContext): Promise<LocalToolResult> {
  const taskId = str(args.task_id);
  if (!taskId) return fail("task_id 必须是非空字符串。");
  return waitLoop(ctx, taskId, model3dPoller(ctx, vendor, taskId));
}

const HYPER3D_ANIMATION_CATEGORIES = ["human", "canine", "bird", "fish", "heavyhooved", "leanhooved", "lizard", "rodentia", "seaturtle"];

interface AnimationEntry {
  id: string;
  name: string;
  category?: string;
}

function describeAnimation(item: unknown): AnimationEntry {
  // Verbatim mirror of the plugins' shared describeAnimation (hyper3d/meshy
  // server.mjs): primitives pass through as id-only; objects pick
  // action_id→id→animation_id and name→title (upstream `display_name` is NOT
  // read — the official renderer shows the blank name too; mirror-is-law).
  if (typeof item === "string" || typeof item === "number") return { id: String(item), name: "" };
  if (!item || typeof item !== "object" || Array.isArray(item)) return { id: "", name: "" };
  const o = item as Record<string, unknown>;
  const pick = (...keys: string[]): string => {
    for (const key of keys) {
      const value = o[key];
      if (typeof value === "string" || typeof value === "number") return String(value);
    }
    return "";
  };
  const category = [pick("category"), pick("subcategory")].filter(Boolean).join("/");
  return { id: pick("action_id", "id", "animation_id"), name: pick("name", "title"), ...(category ? { category } : {}) };
}

function renderAnimations(brand: string, category: string | undefined, search: string | undefined, animations: unknown[], localFilter: string | undefined): LocalToolResult {
  const needle = localFilter ? localFilter.toLowerCase() : "";
  const matched = needle
    ? animations
        .map(describeAnimation)
        .filter((a) => [a.id, a.name, a.category ?? ""].some((v) => v.toLowerCase().includes(needle)))
    : animations.map(describeAnimation);
  const filters = [category ? `category=${category}` : "", search ? `search=${search}` : ""].filter(Boolean).join("，");
  const lines = [`${brand} 预设动画库${filters ? `（${filters}）` : ""}：共 ${matched.length} 个。格式：id  名称  [分类]`];
  for (const item of matched.slice(0, ANIMATION_LIST_LINES)) {
    lines.push([item.id || "?", item.name, item.category ? `[${item.category}]` : ""].filter(Boolean).join("  "));
  }
  if (matched.length > ANIMATION_LIST_LINES) {
    lines.push(`……还有 ${matched.length - ANIMATION_LIST_LINES} 个，请用 category/search 缩小范围。`);
  }
  lines.push(matched.length ? "把选中的 id 填到对应 submit 工具（rig 的 animations / animate 的 action_ids）。" : "没有匹配的动画，可换个 search 关键词或去掉 category。");
  return ok(lines.join("\n"), { category: category ?? null, search: search ?? null, total: matched.length, animations: matched.slice(0, ANIMATION_LIST_LINES) });
}

async function hyper3dAnimationsHandler(args: Record<string, unknown>, ctx: LocalToolContext): Promise<LocalToolResult> {
  const deps: ToolHubDeps = { origin: ctx.origin, headers: ctx.headers, fetchImpl: ctx.fetchImpl, ...(ctx.retryDelayMs !== undefined ? { retryDelayMs: ctx.retryDelayMs } : {}), usageScenario: MODEL3D_VENDORS.hyper3d.usageScenario };
  const category = str(args.category);
  if (category && !HYPER3D_ANIMATION_CATEGORIES.includes(category)) {
    return fail(`category 必须是 ${HYPER3D_ANIMATION_CATEGORIES.join(" / ")} 之一。`);
  }
  const search = str(args.search);
  // Hyper3D upstream has no search — local filter (mirror animationRequest).
  const body: Record<string, unknown> = { action: "animation_library", ...(category ? { category } : {}) };
  const data = await invokeToolLibrary(deps, "hyper3d_model3d", body);
  const output = data.output && typeof data.output === "object" ? (data.output as Record<string, unknown>) : data;
  const animations = Array.isArray(output.animations) ? output.animations : [];
  return renderAnimations("Hyper3D", category, search, animations, search);
}

async function meshyAnimationsHandler(args: Record<string, unknown>, ctx: LocalToolContext): Promise<LocalToolResult> {
  const deps: ToolHubDeps = { origin: ctx.origin, headers: ctx.headers, fetchImpl: ctx.fetchImpl, ...(ctx.retryDelayMs !== undefined ? { retryDelayMs: ctx.retryDelayMs } : {}), usageScenario: MODEL3D_VENDORS.meshy.usageScenario };
  const category = str(args.category);
  const search = str(args.search);
  // Meshy sends both filters server-side (mirror animationRequest).
  const body: Record<string, unknown> = {
    action: "animation_library",
    ...(search ? { search } : {}),
    ...(category ? { category } : {}),
  };
  const data = await invokeToolLibrary(deps, "meshy_model3d", body);
  const output = data.output && typeof data.output === "object" ? (data.output as Record<string, unknown>) : data;
  const animations = Array.isArray(output.animations) ? output.animations : [];
  return renderAnimations("Meshy", category, search, animations, undefined);
}

// ── registry ────────────────────────────────────────────────────────────────

interface SidecarPlugin {
  tools: Array<{ name: string; description: string; inputSchema: unknown; annotations?: Record<string, unknown> }>;
}

const SIDECAR = officialRaw as unknown as { generatedAt: string; source: string; plugins: Record<string, SidecarPlugin> };

interface HandlerRef {
  plugin: string;
  handler: (args: Record<string, unknown>, ctx: LocalToolContext) => Promise<LocalToolResult>;
  /** Append the no-workspace deviation note (per-tool material wording). */
  deviation?: "default" | "https-only" | "video";
}

/** Handlers keyed by plugin — description/schema come from the sidecar verbatim. */
const HANDLERS: Array<HandlerRef & { tool: string }> = [
  { plugin: "image-generation", tool: "generate_image", handler: generateImageHandler, deviation: "default" },
  { plugin: "video-generation", tool: "generate_video", handler: generateVideoHandler, deviation: "video" },
  { plugin: "video-generation", tool: "get_video_result", handler: getVideoResultHandler, deviation: "video" },
  { plugin: "happyhorse-video", tool: "generate_happyhorse_video", handler: generateHappyhorseHandler, deviation: "https-only" },
  { plugin: "happyhorse-video", tool: "get_happyhorse_video_result", handler: getHappyhorseResultHandler, deviation: "https-only" },
  { plugin: "hyper3d-3d", tool: "submit_hyper3d_task", handler: (a, c) => model3dSubmitHandler("hyper3d", a, c), deviation: "default" },
  { plugin: "hyper3d-3d", tool: "get_hyper3d_task", handler: (a, c) => model3dGetHandler("hyper3d", a, c), deviation: "default" },
  { plugin: "hyper3d-3d", tool: "list_hyper3d_animations", handler: hyper3dAnimationsHandler },
  { plugin: "meshy-3d", tool: "submit_meshy_task", handler: (a, c) => model3dSubmitHandler("meshy", a, c), deviation: "default" },
  { plugin: "meshy-3d", tool: "get_meshy_task", handler: (a, c) => model3dGetHandler("meshy", a, c), deviation: "default" },
  { plugin: "meshy-3d", tool: "list_meshy_animations", handler: meshyAnimationsHandler },
  { plugin: "hi3d-3d", tool: "submit_hi3d_task", handler: (a, c) => model3dSubmitHandler("hi3d", a, c), deviation: "default" },
  { plugin: "hi3d-3d", tool: "get_hi3d_task", handler: (a, c) => model3dGetHandler("hi3d", a, c), deviation: "default" },
];

function buildLocalTools(): LocalToolDef[] {
  const out: LocalToolDef[] = [];
  for (const ref of HANDLERS) {
    const plugin = SIDECAR.plugins[ref.plugin];
    const tool = plugin?.tools.find((t) => t.name === ref.tool);
    if (!tool) {
      throw new Error(`official-media-tools.json: missing ${ref.plugin}/${ref.tool} — regenerate the sidecar via _reverse/analysis/dump-plugin-tools.mjs`);
    }
    out.push({
      plugin: ref.plugin,
      name: ref.tool,
      description: ref.deviation === "https-only" ? `${tool.description}${DEVIATION_NOTE_HTTPS_ONLY}`
        : ref.deviation === "video" ? `${tool.description}${DEVIATION_NOTE_VIDEO}`
        : ref.deviation === "default" ? `${tool.description}${DEVIATION_NOTE}`
        : tool.description,
      inputSchema: tool.inputSchema,
      ...(tool.annotations ? { annotations: tool.annotations } : {}),
      handler: ref.handler,
    });
  }
  return out;
}

/** All 13 local media tools (frozen — the aggregate treats them as static). */
export const LOCAL_MCP_TOOLS: readonly LocalToolDef[] = Object.freeze(buildLocalTools());

/** Namespaced lookup: `{plugin}__{tool}` → def. */
export function findLocalTool(namespaced: string): LocalToolDef | undefined {
  return LOCAL_MCP_TOOLS.find((t) => `${t.plugin}__${t.name}` === namespaced);
}

/** Run one local tool; handler throws become isError results (MCP semantics). */
export async function callLocalTool(def: LocalToolDef, args: Record<string, unknown> | undefined, ctx: LocalToolContext): Promise<LocalToolResult> {
  try {
    return await def.handler(args ?? {}, ctx);
  } catch (err) {
    return fail(errText(err));
  }
}
