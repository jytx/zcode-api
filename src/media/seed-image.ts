/**
 * Seedream reference-material resolution — shared by the MCP media tools
 * (`src/mcp/local-tools.ts`, image-generation__generate_image). The REST face
 * this module used to serve (POST /api/v3/images/generations) moved to `/mcp`
 * on 2026-11-22 ("API 路线换回 MCP 路线") — the Ark parse/response layers went
 * with it; what survives is the ToolHub reference contract:
 *
 * Upstream reality (image-generation/0.1.2/mcp/server.mjs): ToolHub supports
 * exactly ONE reference image (`image` param), accepts https references, and
 * returns a single `output.image_url`.
 *
 * @see src/media/toolhub.ts（invokeImage / uploadFile 语义来源）
 */
import { MediaUpstreamError } from "./shared.js";
import { uploadFile, type ToolHubDeps } from "./toolhub.js";

const MAX_REFERENCE_BYTES = 10 * 1024 * 1024;

/** https only, no credentials, no whitespace/control characters (mirror plugin httpsHref). */
function httpsHref(value: string): string | undefined {
  if (/[\s\p{Cc}]/u.test(value)) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  return url.protocol === "https:" && url.hostname && !url.username && !url.password ? url.href : undefined;
}

/**
 * data:image/...;base64 → upload to ToolHub files for a presigned https URL
 * (ToolHub references are https-only since 2025-11-08 — plugin comment
 * "ToolHub 自 11-08 起参考图只收 https，data: URL 先经上传接口换成预签名地址").
 */
export async function resolveReferenceImage(deps: ToolHubDeps, image: string): Promise<string> {
  if (/^https:\/\//i.test(image)) {
    const href = httpsHref(image);
    if (!href) throw new MediaUpstreamError("reference image URL must be a valid https URL (no whitespace or credentials)", "param");
    return href;
  }
  if (/^data:/i.test(image)) return uploadDataUrl(deps, image);
  throw new MediaUpstreamError("reference image must be an https URL or a data:image/...;base64 URL (http, file: and bare paths are not accepted)", "param");
}

async function uploadDataUrl(deps: ToolHubDeps, value: string): Promise<string> {
  const comma = value.indexOf(",", 5);
  if (comma < 0) throw new MediaUpstreamError("data: reference image is malformed (missing header/data comma)", "param");
  const header = value.slice(5, comma);
  if (!header.trimEnd().toLowerCase().endsWith(";base64")) {
    throw new MediaUpstreamError("data: reference image must be base64 encoded (data:image/png;base64,...)", "param");
  }
  const mime = header.slice(0, header.indexOf(";")).trim().toLowerCase();
  const resolvedMime = mime === "image/jpg" ? "image/jpeg" : mime;
  const extension = resolvedMime === "image/png" ? ".png" : resolvedMime === "image/webp" ? ".webp" : resolvedMime === "image/jpeg" ? ".jpg" : undefined;
  if (!extension) throw new MediaUpstreamError("data: reference image only supports png / jpeg / webp", "param");
  const encoded = value.slice(comma + 1).replace(/[ \t\r\n\f]+/g, "");
  // 镜像插件的严格 base64 结构校验（image-generation server.mjs）：Buffer.from
  // 会静默丢掉非法字符，URL-safe 字母表/坏 padding 不在这里拦住，就会解成垃圾
  // 字节上传 ToolHub——一次费解的上游失败，而不是干净的 400。线性检查（尾数填充
  // 计数 + 无分组的字符集正则），不做会平方级回溯的重正则。
  let end = encoded.length;
  while (end > 0 && encoded.charCodeAt(end - 1) === 61 /* = */) end--;
  const body = encoded.slice(0, end);
  const padding = encoded.length - end;
  const wellFormed = /^[A-Za-z0-9+/]*$/.test(body) && body.length % 4 !== 1 && (padding === 0 || (padding <= 2 && encoded.length % 4 === 0));
  if (!wellFormed) {
    throw new MediaUpstreamError("data: reference image is not valid standard base64 (URL-safe alphabets, percent-encoding and broken padding are not accepted)", "param");
  }
  const bytes = new Uint8Array(Buffer.from(encoded, "base64"));
  if (!bytes.length) throw new MediaUpstreamError("data: reference image content is empty", "param");
  if (bytes.length > MAX_REFERENCE_BYTES) throw new MediaUpstreamError("reference image exceeds 10 MiB", "param");
  return uploadFile(deps, bytes, resolvedMime, `reference${extension}`);
}
