/**
 * deepseek-vision — DeepSeek 视觉孪生路由（一个系统：原生图片体验 + 视觉桥补位）
 *
 * 把 deepseek-official 的官方路由包装为 'deepseek-vision' 孪生：
 *   - listModels / resolveModel：模型声明 inputModalities ['text','image']
 *     → DSH 全部原生视觉配置解锁：粘贴准入放行、缩略图、图片块进会话、
 *       read_image 门控放行。
 *   - stream()：请求里出现 ImageBlock 时**不发给 DeepSeek API**（纯文本
 *     端点收不了图），而是先经视觉桥（vision-core → 本地 Ollama）分析成
 *     文本，替换图片块后再转发给同一个 DeepSeek 端点。模型（DeepSeek）
 *     从上下文拿到"桥的分析 + 图片本地路径"，可继续用 query_region 等
 *     工具深挖。缓存命中时零推理。
 *
 * 凭据/端点/重试策略与官方路由完全同源（resolveAdapterOptions），
 * 端点遵循 $DEEPSEEK_BASE_URL / 公共 API，密钥走 credentials 服务
 * （默认 DEEPSEEK_API_KEY）。
 */

import { appendFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { createHash } from 'node:crypto'
import { contentHasImage, LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import { DeepSeekAdapter, PUBLIC_BASE_URL, resolveAdapterOptions } from '@deepseek-ai/dsh-llm-deepseek'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { getOrCreateAnonymousUserId } from '@deepseek-ai/dsh-anonymous-user-id'
import { runTool } from './core/vision-core.mjs'

const PROVIDER = 'deepseek-vision'
const SUFFIX = ' (视觉桥)'
const VISION_ID_SUFFIX = '-vision'
const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const IMAGE_DIR = join(DSH_HOME, 'vision-bridge', 'images')

/** 追加一行活动日志（best-effort，与 lib/index.js 同源；孪生路径的成败从此可观测）。 */
function log(entry) {
  try {
    appendFileSync(join(DSH_HOME, 'vision-bridge-activity.jsonl'), JSON.stringify({ t: new Date().toISOString(), ...entry }) + '\n', 'utf8')
  } catch { /* observability is best-effort */ }
}

/** 提取一个 user 消息里全部图片块的字节（经 attachments 服务）。 */
async function resolveImageBlocks(ctx, message, signal) {
  const attachments = ctx.get('attachments')
  if (attachments === undefined || typeof attachments.readImage !== 'function') {
    throw new LlmError('attachments service unavailable — cannot read image bytes', 'TRANSPORT')
  }
  const images = []
  for (const block of message.content) {
    if (block.type !== 'image') continue
    let stored
    try {
      stored = await attachments.readImage(block.attachment, signal)
    } catch (error) {
      log({ event: 'twin-image', ok: false, reason: 'read-error', mediaType: block.attachment.mediaType, attachmentId: String(block.attachment.attachmentId), error: String(error && error.message ? error.message : error) })
      stored = null
    }
    images.push({ block, bytes: stored && typeof stored.data !== 'undefined' ? stored.data : null })
  }
  return images
}

/** 内容寻址落盘 + 视觉桥分析 → 替换文本。 */
async function visionTextFor(ctx, image, signal) {
  const { block, bytes } = image
  if (bytes === null || bytes.length === 0) {
    log({ event: 'twin-image', ok: false, reason: 'unreadable-bytes', mediaType: block.attachment.mediaType, attachmentId: String(block.attachment.attachmentId) })
    return '[图片]（视觉桥：无法读取图片字节）'
  }
  const hash = createHash('sha1').update(bytes).digest('hex').slice(0, 24)
  const ext = (block.attachment.mediaType === 'image/jpeg') ? '.jpg'
    : block.attachment.mediaType === 'image/webp' ? '.webp'
      : block.attachment.mediaType === 'image/gif' ? '.gif' : '.png'
  const path = join(IMAGE_DIR, hash + ext)
  try {
    await mkdir(IMAGE_DIR, { recursive: true })
    await writeFile(path, bytes, { flag: 'wx' })
  } catch (error) {
    if (!error || error.code !== 'EEXIST') throw error
  }
  // 视觉桥分析（vision-core 自带内容 hash 缓存：同图重复出现零推理）
  const result = await runTool('describe_image', { image_path: path })
  const text = (result.content || []).map((c) => c.text ?? '').join('\n')
  log({ event: 'twin-image', ok: !result.isError, path, bytes: bytes.length, bridged: !result.isError })
  if (result.isError) {
    return '[图片已保存到 ' + path + '，视觉桥暂不可用：' + text
  }
  return '[图片（视觉桥分析）]\n' + text + '\n图片本地路径：' + path
    + '（如需更细信息，可用 query_region / extract_text / structured_scan 分析该路径）'
}

/**
 * 视觉孪生：继承官方 DeepSeek adapter，重写模型元数据并拦截图片块。
 */
export class VisionDeepSeekAdapter extends DeepSeekAdapter {
  constructor(options, ctx) {
    super(options)
    this.ctx = ctx
  }

  providerInfo(provider) {
    return { id: provider, name: 'DeepSeek (视觉桥)' }
  }

  async listModels(provider) {
    const models = await super.listModels(provider)
    return models.map((m) => ({
      ...m,
      id: m.id + VISION_ID_SUFFIX,
      name: m.name + SUFFIX,
      inputModalities: ['text', 'image'],
    }))
  }

  async resolveModel(provider, model, signal) {
    // 孪生 id = base id + 后缀；还原后取官方元数据（context/reasoning 等）
    const base = model.endsWith(VISION_ID_SUFFIX)
      ? model.slice(0, -VISION_ID_SUFFIX.length)
      : model
    const info = await super.resolveModel(provider, base, signal)
    return {
      ...info,
      id: model,
      name: (info.name ?? base) + SUFFIX,
      inputModalities: ['text', 'image'],
    }
  }

  /** 图片块 → 视觉桥分析文本；无图原样放行。 */
  async sanitize(ctx, options) {
    if (options.messages.every((m) => !contentHasImage(m.content))) return options
    const messages = []
    for (const message of options.messages) {
      if (!contentHasImage(message.content)) {
        messages.push(message)
        continue
      }
      const images = await resolveImageBlocks(ctx, message, options.signal)
      if (images.length === 0) {
        messages.push(message)
        continue
      }
      const replacements = new Map()
      for (const image of images) {
        replacements.set(image.block, await visionTextFor(ctx, image, options.signal))
      }
      const content = message.content.map((b) => replacements.has(b)
        ? { type: 'text', text: replacements.get(b) }
        : b)
      messages.push({ ...message, content })
    }
    return { ...options, messages }
  }

  async * stream(options) {
    const sanitized = await this.sanitize(this.ctx, options)
    // wire model 必须还原为官方 id（DeepSeek API 不认识 -vision 后缀）
    const wireModel = sanitized.model.endsWith(VISION_ID_SUFFIX)
      ? sanitized.model.slice(0, -VISION_ID_SUFFIX.length)
      : sanitized.model
    yield * super.stream(wireModel === sanitized.model ? sanitized : { ...sanitized, model: wireModel })
  }
}

/** 注册 'deepseek-vision' 孪生路由。返回 false 表示无法注册（缺 llm 服务）。 */
export function registerDeepSeekVision(ctx) {
  const llm = ctx.get('llm')
  if (llm === undefined || typeof llm.registerAdapter !== 'function') return false
  // 与官方路由同源解析连接事实（端点遵循 $DEEPSEEK_BASE_URL → 公共 API）。
  // 注意：必须是 thunk（每次请求重新解析），与官方插件的 options() 一致。
  const options = () => {
    const envBase = process.env.DEEPSEEK_BASE_URL
    return resolveAdapterOptions(envBase ? { baseURL: envBase } : {})
  }
  const resolveApiKey = async (connection) => {
    const ref = connection.apiKeyEnv
    const credentials = ctx.get('credentials')
    if (credentials !== undefined) {
      const hit = await credentials.resolve(ref)
      if (hit !== undefined && typeof hit.value === 'string' && hit.value.length > 0) return hit.value
    }
    const ambient = process.env[ref]
    if (typeof ambient === 'string' && ambient.length > 0) return ambient
    throw new LlmError(
      'llm-deepseek: no API key for provider route "' + PROVIDER + '"; store ' + ref
      + ' through the credentials service, or export ' + ref + ' in the environment',
      'MISSING_CREDENTIAL',
    )
  }
  let userId
  const resolveUserId = () => userId ??= getOrCreateAnonymousUserId()
  const adapter = new VisionDeepSeekAdapter({ options, resolveApiKey, resolveUserId }, ctx)
  ctx.effect(
    () => llm.registerAdapter([PROVIDER], adapter),
    'vision-bridge: deepseek-vision twin',
  )
  return true
}
