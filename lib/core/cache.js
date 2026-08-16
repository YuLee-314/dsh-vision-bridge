/**
 * lib/cache.js — 文件级结果缓存 (v2.1.0,LRU)
 * key = sha256(图片内容 hash + 工具名 + 参数)
 * 图片内容变化 → 内容 hash 变化 → key 变化 → 自动失效,无需 TTL。
 * 缓存失败(目录不可写等)不影响主流程。
 */
import { createHash } from "crypto";
import { mkdir, readFile, writeFile, readdir, stat, unlink } from "fs/promises";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const CACHE_DIR =
  process.env.VISION_CACHE_DIR ||
  join(dirname(fileURLToPath(import.meta.url)), "..", "cache");
const MAX_ENTRIES = parseInt(process.env.VISION_CACHE_MAX_ENTRIES || "200", 10);

export function cacheKey(contentHash, tool, args) {
  return createHash("sha256")
    .update(`${contentHash}|${tool}|${JSON.stringify(args || {})}`)
    .digest("hex");
}

export async function cacheGet(key) {
  try {
    return JSON.parse(await readFile(join(CACHE_DIR, key + ".json"), "utf8"));
  } catch {
    return null;
  }
}

/** 当前缓存条目数(check_health 用;失败返回 0) */
export async function countCacheEntries() {
  try {
    return (await readdir(CACHE_DIR)).length;
  } catch {
    return 0;
  }
}

export async function cacheSet(key, value) {
  try {
    await mkdir(CACHE_DIR, { recursive: true });
    await writeFile(join(CACHE_DIR, key + ".json"), JSON.stringify(value));
    await pruneIfNeeded();
  } catch {
    // 缓存写失败不影响主流程
  }
}

/** 超过 MAX_ENTRIES 时按 mtime 淘汰最旧条目 */
async function pruneIfNeeded() {
  try {
    const files = await readdir(CACHE_DIR);
    if (files.length <= MAX_ENTRIES) return;
    const stats = await Promise.all(
      files.map(async (f) => ({ f, m: (await stat(join(CACHE_DIR, f))).mtimeMs }))
    );
    stats.sort((a, b) => a.m - b.m);
    for (const { f } of stats.slice(0, files.length - MAX_ENTRIES)) {
      await unlink(join(CACHE_DIR, f)).catch(() => {});
    }
  } catch {
    // 清理失败不影响主流程
  }
}
