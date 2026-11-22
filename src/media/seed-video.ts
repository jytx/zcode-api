/**
 * SeedDance body-building for the MCP media tools
 * (`src/mcp/local-tools.ts`, video-generation__generate_video) → ToolHub
 * `video_generate` invoke/tasks-query. The REST face this module used to
 * serve (`POST|GET /api/v3/contents/generations/tasks`) moved to `/mcp` on
 * 2026-11-22 ("API 路线换回 MCP 路线") — the Ark content[] parse layer and
 * the Ark response mapping went with it; what survives is the body builder
 * and material validation (the plugin tool args map 1:1 onto the ToolHub
 * material params — video-generation/0.2.1/mcp/server.mjs `buildSubmitBody`:
 *   images ≤9 https/data:, videos ≤3 https/asset:// ONLY (ToolHub rejects
 *   data: videos), audios ≤3 https/asset/data: ≤2 MiB inline, first/last
 *   frame the exclusive pair).
 *
 * Deliberate deviations vs the plugin's own submit body: none — the MCP
 * handler maps the plugin tool args 1:1 (prompt→query, first_frame→first_frame…);
 * the plugin-schema defaults (16:9 / 4s) are upstream defaults, so an omitted
 * ratio/duration is mirrored as OMITTED.
 *
 * @see src/media/toolhub.ts（submitVideo / queryVideo 语义来源）
 */

export interface SeedVideoCreateRequest {
  model?: string;
  prompt: string;
  images?: string[];
  videos?: string[];
  audios?: string[];
  firstFrame?: string;
  lastFrame?: string;
  duration?: number;
  ratio?: string;
}

export const VIDEO_RATIOS = new Set(["16:9", "4:3", "1:1", "3:4", "9:16", "21:9", "adaptive"]);
const MAX_INLINE_AUDIO_BYTES = 2 * 1024 * 1024;


/** Build the ToolHub submit body (mirrors buildSubmitBody field-for-field). */
export function buildToolhubVideoBody(req: SeedVideoCreateRequest): Record<string, unknown> {
  const body: Record<string, unknown> = { query: req.prompt };
  if (req.duration !== undefined) body.duration = req.duration;
  if (req.ratio !== undefined) body.ratio = req.ratio;
  if (req.firstFrame) {
    body.first_frame = req.firstFrame;
    if (req.lastFrame) body.last_frame = req.lastFrame;
    return body;
  }
  if (req.images?.length) body.images = req.images;
  if (req.videos?.length) body.videos = req.videos;
  if (req.audios?.length) body.audios = req.audios;
  return body;
}

/** ToolHub videos only accept https/asset:// (audio/image data: URLs pass through). */
export function validateVideoMaterialUrls(req: SeedVideoCreateRequest): { ok: true } | { ok: false; message: string } {
  for (const video of req.videos ?? []) {
    if (!/^(https|asset):\/\//i.test(video)) {
      return { ok: false, message: "reference videos only accept https:// or asset:// URLs (data:/http: and local paths are rejected upstream)" };
    }
  }
  for (const audio of req.audios ?? []) {
    if (/^data:/i.test(audio)) {
      // base64 ≈ 4/3 inflation — bound the decoded size before the request
      // body cap turns it into an opaque 413.
      const comma = audio.indexOf(",", 5);
      const encoded = comma >= 0 ? audio.slice(comma + 1).replace(/[ \t\r\n\f]+/g, "") : "";
      if (Math.floor((encoded.length * 3) / 4) > MAX_INLINE_AUDIO_BYTES) {
        return { ok: false, message: "inline data: reference audio exceeds 2 MiB — provide an https URL instead" };
      }
    } else if (!/^(https|asset):\/\//i.test(audio)) {
      return { ok: false, message: "reference audios only accept https://, asset:// or data:audio/... URLs" };
    }
  }
  return { ok: true };
}
