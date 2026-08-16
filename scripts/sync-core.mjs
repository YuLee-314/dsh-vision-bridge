/**
 * sync-core — 从 zcode 视觉桥（vision-bridge-mcp）重新同步 lib/core/。
 *
 * lib/core/ 是内嵌的宿主无关视觉核心快照；zcode 侧更新视觉逻辑后，
 * 运行本脚本把最新核心搬进插件，重新打包即可。
 * 用法：node scripts/sync-core.mjs [源目录，默认 C:/Users/86183/.zcode/mcp-servers/vision-bridge]
 */
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('../', import.meta.url))
const source = resolve(process.argv[2] ?? 'C:/Users/86183/.zcode/mcp-servers/vision-bridge/lib')
const target = join(here, 'lib', 'core')
const CORE_FILES = ['vision-core.mjs', 'image.js', 'validate.js', 'cache.js', 'queue.js', 'errors.js', 'grounding.js', 'compare.js', 'clipboard.js']

if (!existsSync(source)) {
  console.error('源目录不存在: ' + source)
  process.exit(1)
}
rmSync(target, { recursive: true, force: true })
mkdirSync(target, { recursive: true })
for (const f of CORE_FILES) {
  const src = join(source, f)
  if (!existsSync(src)) { console.error('缺少 ' + f); process.exit(1) }
  cpSync(src, join(target, f))
}
console.log('已同步 ' + CORE_FILES.length + ' 个核心模块 -> ' + target)
