/**
 * dsh-vision-bridge — DeepSeek Harness 原生视觉桥 (bundle plugin)
 *
 * 把 Agentic Vision 工具注册为 DSH 原生工具：describe_image / extract_text /
 * structured_scan / query_region / detect_elements / locate_object /
 * compare_images / read_clipboard / check_health。全部实现来自内嵌的
 * lib/core/vision-core.mjs（宿主无关视觉核心，可经 scripts/sync-core.mjs
 * 从 vision-bridge MCP 版重新同步）。
 *
 * 引擎：本地 Ollama（默认 http://127.0.0.1:11434/v1 + qwen2.5vl:7b），
 * 环境变量 OLLAMA_BASE_URL / OLLAMA_VISION_MODEL / VISION_* 可覆盖。
 *
 * 装配：dsh plugin --profile <name> add <此包>；因 package.json 声明了
 * dsh.bundle.patch，CLI 会把它加入 dsh.profile.bundles 层，HMR 热生效。
 *
 * Web 附加能力（pasteToPath，仅 web profile，可 config 关闭）：
 *   POST /vision-bridge/paste —— 浏览器粘贴图片时上传字节，存为私有临时
 *   文件并返回绝对路径；GET /vision-bridge/paste?model=<标签> —— 依据
 *   真实模型元数据判定是否接管粘贴（仅当所选模型确认纯文本时才接管）。
 *   浏览器半部见 client.js（window.__ModuleLoader__ 协议），把路径插入
 *   输入框，纯文本模型即可用 describe_image 等工具看图。
 */

import { appendFileSync } from 'node:fs'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { runTool } from './core/vision-core.mjs'
import { registerDeepSeekVision } from './deepseek-vision.mjs'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'vision-bridge'

/** The tools registry must exist. */
export const inject = ['tools', 'llm']

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')

/** Append one line to the activity log (best-effort, never throws). */
function log(entry) {
  try {
    appendFileSync(join(DSH_HOME, 'vision-bridge-activity.jsonl'), JSON.stringify({ t: new Date().toISOString(), ...entry }) + '\n', 'utf8')
  } catch { /* observability is best-effort */ }
}

// ── DSH 参数 schema（DSH 强制子集：type/properties/required/items/enum/const/oneOf；
//    region 用 string——vision-core 的 resolveRegion 支持命名预设与 JSON 文本） ──
const TOOLS = [
  {
    name: 'describe_image',
    description: '描述图片内容（整体理解）。使用本地 Ollama + qwen2.5vl 视觉模型分析图片，返回详细中文描述。支持本地路径和 URL。适合先整体了解图片，再配合 query_region 深入细节。图片会自动缩放压缩后发送。',
    parameters: {
      type: 'object',
      properties: {
        image_path: { type: 'string', description: '图片本地路径或 URL' },
        custom_prompt: { type: 'string', description: '可选自定义分析提示词（覆盖默认）' },
      },
      required: ['image_path'],
      additionalProperties: false,
    },
  },
  {
    name: 'extract_text',
    description: '提取图片中的文字（OCR）。with_coordinates=true 时返回带归一化坐标 [0,1000] 的 JSON 数组（每个文字块含 text + bbox，输出经结构校验）。适合文档、截图、表格。',
    parameters: {
      type: 'object',
      properties: {
        image_path: { type: 'string', description: '图片本地路径或 URL' },
        with_coordinates: { type: 'boolean', description: '是否返回带坐标的结构化 JSON（默认 false，返回纯文本）' },
      },
      required: ['image_path'],
      additionalProperties: false,
    },
  },
  {
    name: 'structured_scan',
    description: '全图结构化扫描（Agentic Vision 核心）。检测图片中的所有元素并返回严格 JSON 数组，每项含 type（heading/text/table/image/chart/formula/button/list）、text（若有）、bbox（归一化坐标[0,1000]，[x1,y1,x2,y2]）、confidence。输出经结构校验（非法 bbox 自动重试）。适合先结构化理解整张图，再用 bbox 配合 query_region 深入查询。',
    parameters: {
      type: 'object',
      properties: {
        image_path: { type: 'string', description: '图片本地路径或 URL' },
        element_types: { type: 'array', items: { type: 'string' }, description: '要检测的元素类型过滤（可选），默认全部：heading/text/table/image/chart/formula/button/list' },
      },
      required: ['image_path'],
      additionalProperties: false,
    },
  },
  {
    name: 'query_region',
    description: '区域聚焦查询（Agentic 核心能力）。只分析图片的指定区域并回答指定问题：该区域会被真正裁剪成小图后发送，忽略区域外内容。region 支持命名预设（full/top-left/top-right/bottom-left/bottom-right/center/top-half/bottom-half/left-half/right-half），或 JSON 文本坐标（如 "[100,200,300,400]" 为 [x,y,w,h] 或 [x1,y1,x2,y2]，"{x:100,y:200,w:300,h:400}" 等，0-1000 坐标系）。典型用法：先用 structured_scan 得到某元素的 bbox，再传入该 bbox + 具体问题深入分析。',
    parameters: {
      type: 'object',
      properties: {
        image_path: { type: 'string', description: '图片本地路径或 URL' },
        region: { type: 'string', description: '区域。命名预设字符串，或 JSON 文本坐标（0-1000 坐标系）' },
        question: { type: 'string', description: '针对该区域的聚焦问题' },
      },
      required: ['image_path', 'region', 'question'],
      additionalProperties: false,
    },
  },
  {
    name: 'detect_elements',
    description: '元素定位。只返回图片中指定类型元素的归一化坐标 bbox（[0,1000]）。输出经结构校验。适合快速定位表格、图表、图片、标题等的位置，再配合 query_region 深入分析。',
    parameters: {
      type: 'object',
      properties: {
        image_path: { type: 'string', description: '图片本地路径或 URL' },
        element_types: { type: 'array', items: { type: 'string' }, description: '要定位的元素类型（必填，可多个）：heading/text/table/image/chart/formula/button/list' },
      },
      required: ['image_path', 'element_types'],
      additionalProperties: false,
    },
  },
  {
    name: 'locate_object',
    description: '两阶段精确定位（高精度）。先在整图中粗定位对象，再按粗框裁剪放大后精定位，最后换算回全图归一化坐标（等效分辨率放大数倍，精度提升约 5 倍）。返回 {stage1_bbox, stage2_bbox, note}。object_desc 描述要定位的对象（如 左侧的红色按钮、标题文字）；可传 region（格式同 query_region）跳过粗定位直接精定位指定区域。',
    parameters: {
      type: 'object',
      properties: {
        image_path: { type: 'string', description: '图片本地路径或 URL' },
        object_desc: { type: 'string', description: '要定位的对象描述' },
        region: { type: 'string', description: '可选。跳过粗定位，直接在该区域（命名预设或 JSON 文本坐标）内精定位' },
      },
      required: ['image_path', 'object_desc'],
      additionalProperties: false,
    },
  },
  {
    name: 'check_health',
    description: '健康检查（排障用）。验证 Ollama 服务是否可达、视觉模型是否存在、返回当前配置摘要与缓存条目数。调用无副作用、不消耗推理。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'compare_images',
    description: '双图对比（视觉回归）。两张图缩放拼接成对比图后单次推理，返回结构化差异 JSON：changes 数组，每项含 type（added/removed/moved/changed/text_diff）、description、location（left/right/both）。适合 before/after 对比、Web GUI 视觉回归测试。支持本地路径和 URL。',
    parameters: {
      type: 'object',
      properties: {
        image_a: { type: 'string', description: '图 A(修改前/基线)路径或 URL' },
        image_b: { type: 'string', description: '图 B(修改后/当前)路径或 URL' },
        focus: { type: 'string', description: '可选。重点关注的方向(如 表格区域、导航栏)' },
      },
      required: ['image_a', 'image_b'],
      additionalProperties: false,
    },
  },
  {
    name: 'read_clipboard',
    description: '读取系统剪贴板中的图片（Windows），导出 PNG 到缓存目录并返回绝对路径。主模型拿到路径后可继续用 describe_image / structured_scan / query_region 分析。剪贴板无图片时返回提示。调用无推理消耗。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
]

const OUTPUT = { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] }

/** Run one vision tool and return the canonical string value. */
async function executeTool(toolName, args) {
  const result = await runTool(toolName, args)
  const text = (result.content || []).map((c) => c.text ?? '').join('\n')
  log({ event: 'call', tool: toolName, ok: !result.isError })
  if (result.isError) throw new Error(text)
  return text
}

// ── Web: paste-to-path（仅 web profile 有 webServer 时注册） ────────────────
const PASTE_MAX_BYTES = 25 * 1024 * 1024
const PASTE_SNIFFS = [
  { magic: [0x89, 0x50, 0x4e, 0x47], ext: '.png' },
  { magic: [0xff, 0xd8, 0xff], ext: '.jpg' },
  { magic: [0x52, 0x49, 0x46, 0x46], ext: '.webp' },
  { magic: [0x47, 0x49, 0x46, 0x38], ext: '.gif' },
]

function sniffImage(buffer) {
  for (const probe of PASTE_SNIFFS) {
    const ok = probe.magic.every((byte, i) => buffer[i] === byte)
    if (!ok) continue
    if (probe.ext === '.webp' && buffer.toString('latin1', 8, 12) !== 'WEBP') continue
    return probe.ext
  }
  return null
}

/**
 * 是否接管粘贴：仅当所选模型标签中的每个匹配模型都被确认为纯文本时才
 * 返回 true；任何可能支持图片的匹配（或无法确认）都返回 false——原生粘贴
 * 是安全默认，纯文本模型只会保留它原有的"不支持图片"提示。
 */
async function pasteTakeoverVerdict(ctx, label) {
  if (typeof label !== 'string' || label.trim() === '') return false
  const llm = ctx.get('llm')
  if (llm === undefined || typeof llm.listProviders !== 'function' || typeof llm.listModels !== 'function') return false
  // 归一化：去掉空格/连字符/下划线，让 "DeepSeek V4 Flash" 匹配
  // "deepseek-v4-flash"（GUI 选择器标签与模型 id 的书写形式不同）。
  const norm = (s) => String(s).toLowerCase().replace(/[\s_-]+/g, '')
  const lowered = norm(label)
  let matchedAny = false
  for (const info of llm.listProviders()) {
    const providerId = info?.id
    if (!providerId) continue
    let models
    try { models = await llm.listModels(providerId) } catch { return false }
    for (const model of models ?? []) {
      for (const candidate of [model?.name, model?.id]) {
        if (typeof candidate !== 'string' || candidate.length === 0) continue
        if (!lowered.includes(norm(candidate))) continue
        const modalities = model?.inputModalities
        if (!Array.isArray(modalities) || modalities.includes('image')) return false
        if (candidate.length >= 3) matchedAny = true
      }
    }
  }
  return matchedAny
}

/** 收集请求体字节（带大小上限）。 */
function collectBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let total = 0
    req.on('data', (chunk) => {
      total += chunk.length
      if (total > limit) {
        reject(new Error('payload too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/** 注册 /vision-bridge/paste 路由（仅当 webServer 服务存在）。 */
function registerPasteRoute(ctx) {
  const webServer = ctx.get('webServer')
  if (webServer === undefined) return false
  const handler = async (req, res) => {
    if (req.method === 'GET') {
      const url = new URL(req.url, 'http://localhost')
      const label = url.searchParams.get('model') ?? ''
      try {
        const takeover = await pasteTakeoverVerdict(ctx, label)
        log({ event: 'verdict', label: label.slice(0, 120), takeover })
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ takeover }))
      } catch (error) {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: String(error?.message ?? error) }))
      }
      return
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST' }).end()
      return
    }
    try {
      const buffer = await collectBody(req, PASTE_MAX_BYTES)
      if (buffer.length === 0) throw new Error('empty body')
      const ext = sniffImage(buffer)
      if (ext === null) throw new Error('not an image (magic bytes mismatch)')
      const dir = await mkdtemp(join(tmpdir(), 'vision-bridge-paste-'))
      const file = join(dir, 'paste' + ext)
      await writeFile(file, buffer, { mode: 0o600 })
      log({ event: 'paste-saved', path: file, bytes: buffer.length })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ path: file }))
    } catch (error) {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: String(error?.message ?? error) }))
    }
  }
  ctx.effect(
    () => webServer.register({ kind: 'exact', path: '/vision-bridge/paste', handler }),
    'vision-bridge: paste route',
  )
  log({ event: 'paste-route', path: '/vision-bridge/paste' })
  return true
}

export function apply(ctx, config) {
  for (const tool of TOOLS) {
    // effect 回调必须返回 register() 的 disposer（或 null）；不得在回调内吞错。
    try {
      ctx.effect(() => ctx.tools.register({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        output: OUTPUT,
        execute: (args) => executeTool(tool.name, args),
      }))
    } catch (error) {
      log({ event: 'register-failed', tool: tool.name, error: String(error && error.message ? error.message : error) })
    }
  }
  // DeepSeek 视觉孪生路由（'deepseek-vision'）：DeepSeek 主脑 + 原生图片体验，
  // 图片块在请求层经视觉桥分析成文本后转发——一个系统，不再需要切换模型。
  try {
    registerDeepSeekVision(ctx)
  } catch (error) {
    log({ event: 'twin-failed', error: String(error && error.message ? error.message : error) })
  }
  // Paste 路由懒注册：兄弟行并行挂载，webServer 的 provider fiber 可能尚未
  // active（ctx.get 严格模式返回 undefined）。立即试一次 + 监听 internal/plugin，
  // webServer 一就绪就挂路由；headless（无 webServer）静默跳过。
  if (config === undefined || config.pasteToPath !== false) {
    let registered = false
    const tryRegister = () => {
      if (registered) return
      try {
        registered = registerPasteRoute(ctx)
      } catch (error) {
        log({ event: 'paste-route-failed', error: String(error && error.message ? error.message : error) })
      }
    }
    tryRegister()
    ctx.on('internal/plugin', tryRegister)
  }
  log({ event: 'apply', plugin: name, tools: TOOLS.map((t) => t.name) })
}
