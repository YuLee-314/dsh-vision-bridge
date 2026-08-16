/**
 * lib/image.js — 图像管线 (v2.1.0)
 * 统一处理:本地路径/URL → 字节 → 内容 hash → 可选真裁剪 → 缩放/JPEG 压缩 → base64 dataUrl
 * sharp 不可用时(解码失败等)自动降级返回原始字节,不中断服务。
 */
import { readFile } from "fs/promises";
import { extname, resolve } from "path";
import { createHash } from "crypto";
import sharp from "sharp";

const MAX_DIM = parseInt(process.env.VISION_MAX_DIM || "1024", 10);
const JPEG_QUALITY = parseInt(process.env.VISION_JPEG_QUALITY || "80", 10);
export const PREPROCESS_ENABLED = process.env.VISION_PREPROCESS !== "0";

export function getImageMimeType(source) {
  if (source.startsWith("http://") || source.startsWith("https://")) {
    const ext = extname(new URL(source).pathname).toLowerCase();
    return ext === ".png" ? "image/png" : "image/jpeg";
  }
  const ext = extname(source).toLowerCase();
  switch (ext) {
    case ".png": return "image/png";
    case ".gif": return "image/gif";
    case ".webp": return "image/webp";
    case ".bmp": return "image/bmp";
    default: return "image/jpeg";
  }
}

/** 将 Git Bash MSYS 风格路径 (/d/foo → D:\foo) 转为 Windows 路径,提升跨终端健壮性 */
export function normalizePath(p) {
  if (typeof p !== "string") return p;
  if (/^\/[a-zA-Z]\//.test(p)) {
    return p.slice(1, 2).toUpperCase() + ":" + p.slice(2).replace(/\//g, "\\");
  }
  return p;
}

/** 解析图片来源为字节 + mime:本地路径读取 / URL 下载 */
export async function resolveImageBytes(imageSource) {
  if (imageSource.startsWith("http://") || imageSource.startsWith("https://")) {
    const res = await fetch(imageSource);
    if (!res.ok) throw new Error(`下载图片失败: HTTP ${res.status}`);
    const mime = res.headers.get("content-type") || getImageMimeType(imageSource);
    return { bytes: Buffer.from(await res.arrayBuffer()), mime };
  }
  const filePath = resolve(normalizePath(imageSource));
  return { bytes: await readFile(filePath), mime: getImageMimeType(filePath) };
}

/** 图片内容指纹(缓存 key 组成部分:内容变化 → 指纹变化 → 缓存自动失效) */
export function contentHash(bytes) {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 32);
}

/** 归一化 bbox [x1,y1,x2,y2] (0-1000) → 像素裁剪区域;越界 clamp,保证最小 1px */
export function regionToPixels(region, width, height) {
  let left = Math.round((region[0] / 1000) * width);
  let top = Math.round((region[1] / 1000) * height);
  let right = Math.round((region[2] / 1000) * width);
  let bottom = Math.round((region[3] / 1000) * height);
  left = Math.max(0, Math.min(left, width - 1));
  top = Math.max(0, Math.min(top, height - 1));
  right = Math.max(left + 1, Math.min(right, width));
  bottom = Math.max(top + 1, Math.min(bottom, height));
  return { left, top, width: right - left, height: bottom - top };
}

/**
 * 预处理:可选真裁剪(extract)+ 缩放(≤MAX_DIM,不放大)+ JPEG 压缩。
 * 解码失败/格式不支持时抛错,由调用方回退旧路径(原图 base64,无裁剪)。
 */
export async function preprocessImage(bytes, { crop = null } = {}) {
  let pipeline = sharp(bytes);
  if (crop) pipeline = pipeline.extract(crop);
  const out = await pipeline
    .resize(MAX_DIM, MAX_DIM, { fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: JPEG_QUALITY })
    .toBuffer();
  return { bytes: out, mime: "image/jpeg" };
}

export function toDataUrl(bytes, mime) {
  return `data:${mime};base64,${bytes.toString("base64")}`;
}

/**
 * 完整图像准备管线(5 个工具共用):
 *   解析来源 → 内容 hash → (可选)按归一化区域真裁剪 → 缩放/JPEG 预处理 → dataUrl
 * 返回 cropped 标记,供 query_region 选择裁剪版/降级版 prompt。
 */
export async function prepareImage(imageSource, { cropRegion = null } = {}) {
  const { bytes, mime } = await resolveImageBytes(imageSource);
  const hash = contentHash(bytes);
  let out = { bytes, mime };
  let cropped = false;

  if (PREPROCESS_ENABLED) {
    try {
      const meta = await sharp(bytes).metadata();
      const crop = cropRegion ? regionToPixels(cropRegion, meta.width, meta.height) : null;
      out = await preprocessImage(bytes, { crop });
      cropped = cropRegion !== null && crop !== null;
    } catch {
      // sharp 解码失败 → 回退原始字节(旧行为:整图发送,不裁剪不压缩)
    }
  }

  return { dataUrl: toDataUrl(out.bytes, out.mime), contentHash: hash, cropped };
}
