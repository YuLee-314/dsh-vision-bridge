/**
 * vision-core — Agentic Vision 共享核心 (v2.4.0)
 * ---------------------------------------------------------------
 * 从 server.js 抽取的宿主无关视觉逻辑：配置、prompt、Ollama 调用、
 * 结构化校验/重试、缓存、队列，以及全部 9 个工具的实现。
 *
 * 单一事实源：本模块同时被
 *   1) server.js          —— ZCode / Claude Code 的 MCP 薄壳（协议适配）
 *   2) dsh-vision-bridge  —— DeepSeek Harness 原生 bundle 插件（ctx.tools）
 * 引用，因此两边的工具、prompt、行为永远一致。
 *
 * 本模块无副作用（import 安全）：不启动服务器、不监听端口。
 */

import OpenAI from "openai";

import { prepareImage } from "./image.js";
import {
  validateStructuredScan,
  validateOcrCoordinates,
  validateDetectElements,
  validBbox,
  RETRY_HINT,
} from "./validate.js";
import { cacheKey, cacheGet, cacheSet, countCacheEntries } from "./cache.js";
import { createQueue } from "./queue.js";
import { classifyError } from "./errors.js";
import { GROUNDING_PROMPT, FINE_PROMPT, cropToFull, expandRegion } from "./grounding.js";
import { composeCompareImage, COMPARE_PROMPT } from "./compare.js";
import { readClipboardImage } from "./clipboard.js";

// ── Configuration ──────────────────────────────────────────────
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434/v1";
const OLLAMA_MODEL = process.env.OLLAMA_VISION_MODEL || "qwen2.5vl:7b-q3_K_M";
const OLLAMA_API_KEY = process.env.OLLAMA_API_KEY || "ollama";
const MAX_TOKENS = parseInt(process.env.VISION_MAX_TOKENS || "8192", 10);
const TEMPERATURE = parseFloat(process.env.VISION_TEMPERATURE || "0.1");
const MAX_RETRIES = parseInt(process.env.VISION_MAX_RETRIES || "1", 10);
const CONCURRENCY = parseInt(process.env.VISION_CONCURRENCY || "1", 10);

// ── 坐标系与命名区域 ───────────────────────────────────────────
// 归一化坐标 [0,1000],原点左上角
const REGION_PRESETS = {
  "full":         [0, 0, 1000, 1000],
  "top-left":     [0, 0, 500, 500],
  "top-right":    [500, 0, 1000, 500],
  "bottom-left":  [0, 500, 500, 1000],
  "bottom-right": [500, 500, 1000, 1000],
  "center":       [250, 250, 750, 750],
  "top-half":     [0, 0, 1000, 500],
  "bottom-half":  [0, 500, 1000, 1000],
  "left-half":    [0, 0, 500, 1000],
  "right-half":   [500, 0, 1000, 1000],
};

const DEFAULT_ELEMENT_TYPES = ["text", "heading", "table", "image", "chart", "formula", "button", "list"];

// ── Prompts ────────────────────────────────────────────────────
const DESCRIBE_PROMPT = `请详细描述这张图片的内容。

要求：
1. 首先概括图片的类型（照片、截图、文档、图表、绘画等）
2. 描述图片中的主要物体、人物、场景
3. 描述布局、颜色、光影等视觉元素
4. 如果是文档截图，完整提取其中的所有文字内容
5. 如果是图表，描述数据的含义和趋势
6. 注意细节：文字、数字、标签、Logo等

请用中文回复。`;

const OCR_PROMPT = `请提取这张图片中的所有文字内容。

要求：
1. 保持原有的排版结构和层级关系
2. 如果是表格，用 Markdown 表格格式输出
3. 不要添加任何额外的解释或评论
4. 对于无法辨认的文字，用 [??] 标记
5. 保留数字、符号、公式的原始格式

只输出文字内容，不要任何前言后语。`;

const OCR_COORD_PROMPT = `请提取这张图片中的所有文字，并给出每个文字块的位置。

坐标系统：归一化坐标 [0,1000]，原点在图片左上角。每个文字块用 bbox:[x1,y1,x2,y2] 表示（左上角到右下角）。

输出格式：严格 JSON 数组，不要代码块围栏，不要任何解释文字：
[{"text":"文字内容","bbox":[x1,y1,x2,y2]}, ...]

要求：
1. 按视觉块合并相邻文字（同一行/同一段落）
2. 保留文字原始顺序（从上到下，从左到右）
3. 无法辨认的文字用 [??] 标记
4. 只输出 JSON，不要 Markdown 表格或额外说明`;

const STRUCTURED_SCAN_PROMPT = `你是文档/图像结构化分析引擎。请检测图片中的所有元素，返回严格 JSON。

坐标系统：归一化坐标 [0,1000]，原点在图片左上角。每个元素用 bbox:[x1,y1,x2,y2] 表示（左上角到右下角）。

元素类型定义：
- heading: 标题（字号较大、加粗或独立的标题行）
- text: 普通文本块（按视觉块合并）
- table: 表格（检测表格整体边界，不要逐单元格）
- image: 内嵌图片/插图
- chart: 图表（折线图、柱状图、饼图、流程图等）
- formula: 数学公式
- button: 按钮/可点击控件
- list: 列表（项目符号或编号列表）

输出格式：严格 JSON 数组，不要代码块围栏，不要任何解释文字：
[{"type":"heading","text":"标题文字","bbox":[x1,y1,x2,y2],"confidence":0.95}, ...]

要求：
1. 元素按视觉位置从左上到右下排序
2. 覆盖图片中所有可见元素，不要遗漏
3. 若某元素类型不确定，选择最接近的类型并降低 confidence
4. 只输出 JSON 数组本身，不要 Markdown 或前后说明`;

const DETECT_ELEMENTS_PROMPT = (types) => `请检测图片中的以下元素类型：${types.join("、")}。

坐标系统：归一化坐标 [0,1000]，原点在图片左上角。每个元素用 bbox:[x1,y1,x2,y2] 表示（左上角到右下角）。

输出格式：严格 JSON 数组，不要代码块围栏，不要任何解释文字：
[{"type":"table","bbox":[x1,y1,x2,y2],"confidence":0.9}, ...]

要求：
1. 只输出请求的元素类型，忽略其他元素
2. 元素按视觉位置排序
3. 只输出 JSON 数组本身`;

// query_region 裁剪版 prompt(图已被真裁剪,不再需要区域边界描述)
const QUERY_REGION_CROPPED_PROMPT = (question) => `这是一张从原图指定区域裁剪出来的图片。请严格基于图中可见内容回答下面的问题：

【要回答的问题】
${question}

请严格只基于图中内容回答。如果图中没有足够信息回答问题，请明确说明"该区域没有足够信息"。`;

// query_region 降级版 prompt(sharp 不可用、未裁剪时,靠 prompt 约束区域)
const QUERY_REGION_PROMPT = (region, question) => `图片中有一块区域需要你聚焦分析，请只关注该区域，忽略区域外的一切内容。

【区域边界】（归一化坐标 [0,1000]，原点在图片左上角）：
- 左上角：(${region[0]}, ${region[1]})
- 右下角：(${region[2]}, ${region[3]})

【要回答的问题】
${question}

请严格只基于该区域内的可见内容回答。如果区域内没有足够信息回答问题，请明确说明"该区域没有足够信息"。`;

// ── Helpers ────────────────────────────────────────────────────

/**
 * 解析 region 参数：命名预设 / [x,y,w,h] / [x1,y1,x2,y2] / {x1,y1,x2,y2} / {x,y,w,h}。
 * v2.4.0 起额外支持字符串形式（"[100,200,300,400]"、"{x:100,y:200,w:300,h:400}" 等 JSON 文本），
 * 以便 DeepSeek Harness 的 string-only 参数 schema 使用。
 */
export function resolveRegion(region) {
  // 字符串:先试命名预设,再试 JSON 文本
  if (typeof region === "string") {
    const key = region.toLowerCase();
    if (REGION_PRESETS[key]) return REGION_PRESETS[key];
    const trimmed = region.trim();
    try {
      const parsed = JSON.parse(trimmed);
      return resolveRegion(parsed); // 递归:数组/对象走下面的分支
    } catch {
      throw new Error(`未知的区域预设 "${region}"。可用：${Object.keys(REGION_PRESETS).join(", ")}，或传入 [x,y,w,h] 归一化坐标（数组、对象或 JSON 字符串）。`);
    }
  }
  // 数组形式
  if (Array.isArray(region)) {
    if (region.length !== 4) throw new Error("region 数组必须为4个数字：[x,y,w,h] 或 [x1,y1,x2,y2]");
    let [a, b, c, d] = region.map(Number);
    if ([a, b, c, d].some(n => isNaN(n))) throw new Error("region 数组必须为数字");
    // 判断是 w/h 还是 x2/y2：若 c,d 小于 a,b 则视为宽高
    if (c <= a && d <= b) {
      return [a, b, a + c, b + d]; // [x,y,w,h] → [x1,y1,x2,y2]
    }
    return [a, b, c, d]; // 已是 [x1,y1,x2,y2]
  }
  if (typeof region === "object" && region !== null) {
    if ("x1" in region && "y1" in region && "x2" in region && "y2" in region) {
      return [Number(region.x1), Number(region.y1), Number(region.x2), Number(region.y2)];
    }
    if ("x" in region && "y" in region && "w" in region && "h" in region) {
      return [Number(region.x), Number(region.y), Number(region.x) + Number(region.w), Number(region.y) + Number(region.h)];
    }
    throw new Error("region 对象需包含 x1,y1,x2,y2 或 x,y,w,h");
  }
  throw new Error("region 参数格式无效");
}

/** 从模型输出中提取 JSON（剥离代码块围栏，容错解析） */
function extractJSON(text) {
  let t = text.trim();
  // 剥离 ```json ... ``` 围栏
  const fenceMatch = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) t = fenceMatch[1].trim();
  // 剥离首尾非 JSON 字符
  const first = t.indexOf("[");
  const last = t.lastIndexOf("]");
  if (first >= 0 && last > first) {
    t = t.slice(first, last + 1);
  }
  try {
    return JSON.parse(t);
  } catch {
    // 尝试剥离尾部多余内容
    try {
      return JSON.parse(t.replace(/,?\s*}$/, "}"));
    } catch {
      return null;
    }
  }
}

/** 从模型输出中提取 JSON 对象（定位类输出 {"bbox": [...]} 用;兼容围栏与前后文字） */
function extractObjectJSON(text) {
  let t = text.trim();
  const fenceMatch = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) t = fenceMatch[1].trim();
  const first = t.indexOf("{");
  const last = t.lastIndexOf("}");
  if (first >= 0 && last > first) {
    try {
      return JSON.parse(t.slice(first, last + 1));
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * 带校验 + 重试的视觉调用:
 *   attempt 0 → 原 prompt;失败后追加 RETRY_HINT 修正提示词重试(默认 1 次)
 *   最终失败返回 { parsed: null, raw } 由调用方降级为原始文本
 */
async function callWithRetry(dataUrl, prompt, validator) {
  let raw = "";
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const p = attempt === 0 ? prompt : prompt + RETRY_HINT;
    raw = await callVisionAPI(dataUrl, p);
    const parsed = extractJSON(raw);
    if (parsed && validator(parsed)) return { parsed, raw };
  }
  return { parsed: null, raw };
}

/** 定位类调用:解析 {"bbox": [...]|null},校验 bbox;失败重试一次 */
async function callBoxWithRetry(dataUrl, prompt) {
  let raw = "";
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const p = attempt === 0 ? prompt : prompt + RETRY_HINT;
    raw = await callVisionAPI(dataUrl, p);
    const parsed = extractObjectJSON(raw);
    if (parsed && (parsed.bbox === null || validBbox(parsed.bbox))) {
      return { bbox: parsed.bbox, raw };
    }
  }
  return { bbox: undefined, raw };
}

/** 统一缓存查找:命中返回带 [cache-hit] 前缀的内容块 */
async function cached(contentHash, tool, args, missFn) {
  const key = cacheKey(contentHash, tool, args);
  const hit = await cacheGet(key);
  if (hit && typeof hit.text === "string") {
    return { content: [{ type: "text", text: "[cache-hit] " + hit.text }] };
  }
  const text = await missFn();
  await cacheSet(key, { text });
  return { content: [{ type: "text", text }] };
}

// ── OpenAI Client + 请求队列 ───────────────────────────────────
const visionQueue = createQueue(CONCURRENCY);

const client = new OpenAI({
  apiKey: OLLAMA_API_KEY,
  baseURL: OLLAMA_BASE_URL,
});

async function callVisionAPI(imageUrl, prompt) {
  // 全部视觉推理串行(FIFO),防 7B 模型被并发调用压垮
  return visionQueue(async () => {
    const response = await client.chat.completions.create({
      model: OLLAMA_MODEL,
      messages: [
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: imageUrl } },
            { type: "text", text: prompt },
          ],
        },
      ],
      max_tokens: MAX_TOKENS,
      temperature: TEMPERATURE,
    });

    return response.choices[0]?.message?.content || "";
  });
}

// ── 工具清单（单一事实源：MCP tools/list 与 DSH 插件共用） ──────
export const LIST_TOOLS = [
  {
    name: "describe_image",
    description:
      "描述图片内容（整体理解）。使用本地 Ollama + qwen2.5vl 视觉模型分析图片，返回详细中文描述。支持本地路径和 URL。适合先整体了解图片，再配合 query_region 深入细节。图片会自动缩放压缩后发送。",
    inputSchema: {
      type: "object",
      properties: {
        image_path: { type: "string", description: "图片本地路径或 URL" },
        custom_prompt: { type: "string", description: "可选自定义分析提示词（覆盖默认）" },
      },
      required: ["image_path"],
    },
  },
  {
    name: "extract_text",
    description:
      "提取图片中的文字（OCR）。with_coordinates=true 时返回带归一化坐标 [0,1000] 的 JSON 数组（每个文字块含 text + bbox，输出经结构校验）。适合文档、截图、表格。",
    inputSchema: {
      type: "object",
      properties: {
        image_path: { type: "string", description: "图片本地路径或 URL" },
        with_coordinates: {
          type: "boolean",
          description: "是否返回带坐标的结构化 JSON（默认 false，返回纯文本）",
        },
      },
      required: ["image_path"],
    },
  },
  {
    name: "structured_scan",
    description:
      "全图结构化扫描（Agentic Vision 核心）。检测图片中的所有元素并返回严格 JSON 数组，每项含 type（heading/text/table/image/chart/formula/button/list）、text（若有）、bbox（归一化坐标[0,1000]，[x1,y1,x2,y2]）、confidence。输出经结构校验（非法 bbox 自动重试）。适合先结构化理解整张图，再用 bbox 配合 query_region 深入查询。",
    inputSchema: {
      type: "object",
      properties: {
        image_path: { type: "string", description: "图片本地路径或 URL" },
        element_types: {
          type: "array",
          items: { type: "string" },
          description: "要检测的元素类型过滤（可选），默认全部：heading/text/table/image/chart/formula/button/list",
        },
      },
      required: ["image_path"],
    },
  },
  {
    name: "query_region",
    description:
      "区域聚焦查询（Agentic 核心能力）。只分析图片的指定区域并回答指定问题：该区域会被真正裁剪成小图后发送，忽略区域外内容。region 支持：命名预设（full/top-left/top-right/bottom-left/bottom-right/center/top-half/bottom-half/left-half/right-half）、归一化坐标数组 [x,y,w,h] 或 [x1,y1,x2,y2]（0-1000）、对象 {x,y,w,h} 或 {x1,y1,x2,y2}，或这些数组/对象的 JSON 字符串。典型用法：先用 structured_scan 得到某元素的 bbox，再传入该 bbox + 具体问题深入分析。",
    inputSchema: {
      type: "object",
      properties: {
        image_path: { type: "string", description: "图片本地路径或 URL" },
        region: {
          description: "区域。命名预设字符串，或归一化坐标（数组/对象形式，0-1000 坐标系）",
          anyOf: [
            { type: "string" },
            { type: "array", items: { type: "number" }, minItems: 4, maxItems: 4 },
            { type: "object" },
          ],
        },
        question: { type: "string", description: "针对该区域的聚焦问题" },
      },
      required: ["image_path", "region", "question"],
    },
  },
  {
    name: "detect_elements",
    description:
      "元素定位。只返回图片中指定类型元素的归一化坐标 bbox（[0,1000]）。输出经结构校验。适合快速定位表格、图表、图片、标题等的位置，再配合 query_region 深入分析。",
    inputSchema: {
      type: "object",
      properties: {
        image_path: { type: "string", description: "图片本地路径或 URL" },
        element_types: {
          type: "array",
          items: { type: "string" },
          description: "要定位的元素类型（必填，可多个）：heading/text/table/image/chart/formula/button/list",
        },
      },
      required: ["image_path", "element_types"],
    },
  },
  {
    name: "locate_object",
    description:
      "两阶段精确定位（高精度）。先在整图中粗定位对象，再按粗框裁剪放大后精定位，最后换算回全图归一化坐标（等效分辨率放大数倍，精度提升约 5 倍）。返回 {stage1_bbox, stage2_bbox, note}。object_desc 描述要定位的对象（如 '左侧的红色按钮'、'标题文字'）；可传 region 跳过粗定位直接精定位指定区域。",
    inputSchema: {
      type: "object",
      properties: {
        image_path: { type: "string", description: "图片本地路径或 URL" },
        object_desc: { type: "string", description: "要定位的对象描述" },
        region: {
          description: "可选。跳过粗定位，直接在该区域（归一化坐标，格式同 query_region）内精定位",
          anyOf: [
            { type: "string" },
            { type: "array", items: { type: "number" }, minItems: 4, maxItems: 4 },
            { type: "object" },
          ],
        },
      },
      required: ["image_path", "object_desc"],
    },
  },
  {
    name: "check_health",
    description:
      "健康检查（排障用）。验证 Ollama 服务是否可达、视觉模型是否存在、返回当前配置摘要与缓存条目数。调用无副作用、不消耗推理。",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "compare_images",
    description:
      "双图对比（视觉回归）。两张图缩放拼接成对比图后单次推理，返回结构化差异 JSON：changes 数组，每项含 type（added/removed/moved/changed/text_diff）、description、location（left/right/both）。适合 before/after 对比、Web GUI 视觉回归测试。支持本地路径和 URL。",
    inputSchema: {
      type: "object",
      properties: {
        image_a: { type: "string", description: "图 A(修改前/基线)路径或 URL" },
        image_b: { type: "string", description: "图 B(修改后/当前)路径或 URL" },
        focus: { type: "string", description: "可选。重点关注的方向(如 '表格区域'、'导航栏')" },
      },
      required: ["image_a", "image_b"],
    },
  },
  {
    name: "read_clipboard",
    description:
      "读取系统剪贴板中的图片（Windows），导出 PNG 到缓存目录并返回绝对路径。主模型拿到路径后可继续用 describe_image / structured_scan / query_region 分析。剪贴板无图片时返回提示。调用无推理消耗。",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
];

/**
 * 执行一个工具（单一事实源：MCP CallTool 与 DSH execute 共用）。
 * @param {string} name 工具名
 * @param {object} args 参数（已解析）
 * @returns {Promise<{content: {type:'text', text: string}[], isError?: boolean}>} MCP 形状的结果
 */
export async function runTool(name, args) {
  const args2 = args || {};

  try {
    switch (name) {
      case "describe_image": {
        const prompt = args2.custom_prompt || DESCRIBE_PROMPT;
        const { dataUrl, contentHash } = await prepareImage(args2.image_path);
        return await cached(contentHash, name, args2, async () => {
          return await callVisionAPI(dataUrl, prompt);
        });
      }

      case "extract_text": {
        const withCoords = !!args2.with_coordinates;
        const prompt = withCoords ? OCR_COORD_PROMPT : OCR_PROMPT;
        const { dataUrl, contentHash } = await prepareImage(args2.image_path);

        if (!withCoords) {
          return await cached(contentHash, name, { with_coordinates: false }, async () => {
            return await callVisionAPI(dataUrl, prompt);
          });
        }

        // 带坐标:校验 + 重试,通过后缓存
        const key = cacheKey(contentHash, name, { with_coordinates: true });
        const hit = await cacheGet(key);
        if (hit && typeof hit.text === "string") {
          return { content: [{ type: "text", text: "[cache-hit] " + hit.text }] };
        }
        const { parsed, raw } = await callWithRetry(dataUrl, prompt, validateOcrCoordinates);
        if (parsed) {
          const text = `已解析 ${parsed.length} 个文字块（归一化坐标 [0,1000]，bbox=[x1,y1,x2,y2]）：\n${JSON.stringify(parsed, null, 1)}`;
          await cacheSet(key, { text });
          return { content: [{ type: "text", text }] };
        }
        return {
          content: [{ type: "text", text: `模型输出无法解析为 JSON，返回原始内容：\n${raw}` }],
        };
      }

      case "structured_scan": {
        const types = (args2.element_types && args2.element_types.length)
          ? args2.element_types
          : DEFAULT_ELEMENT_TYPES;
        const prompt = STRUCTURED_SCAN_PROMPT + `\n\n本次仅检测类型：${types.join("、")}`;
        const { dataUrl, contentHash } = await prepareImage(args2.image_path);

        const key = cacheKey(contentHash, name, { element_types: args2.element_types || [] });
        const hit = await cacheGet(key);
        if (hit && typeof hit.text === "string") {
          return { content: [{ type: "text", text: "[cache-hit] " + hit.text }] };
        }
        const { parsed, raw } = await callWithRetry(dataUrl, prompt, validateStructuredScan);
        if (parsed) {
          const text = `检测到 ${parsed.length} 个元素（归一化坐标 [0,1000]，bbox=[x1,y1,x2,y2]）：\n${JSON.stringify(parsed, null, 1)}`;
          await cacheSet(key, { text });
          return { content: [{ type: "text", text }] };
        }
        return {
          content: [{ type: "text", text: `模型输出无法解析为 JSON，返回原始内容：\n${raw}` }],
        };
      }

      case "query_region": {
        const region = resolveRegion(args2.region);
        // 校验坐标在合理范围
        for (const n of region) {
          if (n < 0 || n > 1000) throw new Error(`区域坐标超出 [0,1000]：${region.join(",")}`);
        }
        const question = args2.question || "请描述该区域的内容";
        const { dataUrl, contentHash, cropped } = await prepareImage(args2.image_path, { cropRegion: region });

        return await cached(contentHash, name, { region, question }, async () => {
          const prompt = cropped
            ? QUERY_REGION_CROPPED_PROMPT(question)
            : QUERY_REGION_PROMPT(region, question); // 降级:未裁剪时靠 prompt 约束
          const result = await callVisionAPI(dataUrl, prompt);
          return `【区域 ${region.join(",")}（归一化坐标）】\n${result}`;
        });
      }

      case "detect_elements": {
        const types = args2.element_types;
        if (!types || !types.length) throw new Error("element_types 必填");
        const prompt = DETECT_ELEMENTS_PROMPT(types);
        const { dataUrl, contentHash } = await prepareImage(args2.image_path);

        const key = cacheKey(contentHash, name, { element_types: types });
        const hit = await cacheGet(key);
        if (hit && typeof hit.text === "string") {
          return { content: [{ type: "text", text: "[cache-hit] " + hit.text }] };
        }
        const { parsed, raw } = await callWithRetry(dataUrl, prompt, validateDetectElements);
        if (parsed) {
          const text = `检测到 ${parsed.length} 个元素（归一化坐标 [0,1000]，bbox=[x1,y1,x2,y2]）：\n${JSON.stringify(parsed, null, 1)}`;
          await cacheSet(key, { text });
          return { content: [{ type: "text", text }] };
        }
        return {
          content: [{ type: "text", text: `模型输出无法解析为 JSON，返回原始内容：\n${raw}` }],
        };
      }

      case "locate_object": {
        const objectDesc = args2.object_desc;
        if (!objectDesc || typeof objectDesc !== "string") throw new Error("object_desc 必填(字符串)");
        if (!args2.image_path) throw new Error("image_path 必填");

        // 阶段1:全图粗定位(或用户指定 region 跳过)
        let stage1Region = null;
        let stage1Note = "";
        if (args2.region) {
          stage1Region = resolveRegion(args2.region);
          for (const n of stage1Region) {
            if (n < 0 || n > 1000) throw new Error(`区域坐标超出 [0,1000]：${stage1Region.join(",")}`);
          }
          stage1Note = "使用用户指定区域(跳过粗定位)";
        } else {
          const { dataUrl, contentHash } = await prepareImage(args2.image_path);
          const k1 = cacheKey(contentHash, "locate_object_stage1", { object_desc: objectDesc });
          const hit1 = await cacheGet(k1);
          let stage1 = hit1 && Array.isArray(hit1.bbox) ? hit1.bbox : undefined;
          if (!stage1) {
            const { bbox, raw } = await callBoxWithRetry(dataUrl, GROUNDING_PROMPT(objectDesc));
            if (!bbox) {
              return {
                content: [{ type: "text", text: `未在图片中找到对象 "${objectDesc}"。\n模型原始输出:\n${raw.slice(0, 500)}` }],
              };
            }
            stage1 = bbox;
            await cacheSet(k1, { bbox: stage1 });
          }
          stage1Region = stage1;
          stage1Note = "两阶段定位(粗→精)";
        }

        // 阶段2:粗框膨胀 30% 后裁剪放大精定位(膨胀给上下文留余量,防细条区域不可辨)
        const stage2Region = expandRegion(stage1Region);
        const { dataUrl: cropUrl, contentHash: ch2, cropped } = await prepareImage(args2.image_path, { cropRegion: stage2Region });
        const k2 = cacheKey(ch2, "locate_object_stage2", { object_desc: objectDesc, region: stage2Region });
        const hit2 = await cacheGet(k2);
        let stage2 = hit2 && Array.isArray(hit2.bbox) ? hit2.bbox : undefined;
        if (!stage2) {
          const { bbox, raw } = await callBoxWithRetry(cropUrl, FINE_PROMPT(objectDesc));
          if (!bbox) {
            // 降级:精定位未确认,返回阶段1粗定位结果(保证有 bbox 可用)
            const text = `定位结果(精定位未确认,返回粗定位 bbox):\n${JSON.stringify({
              object: objectDesc,
              stage1_bbox: stage1Region.map((n) => Math.round(n * 10) / 10),
              stage2_bbox: null,
              note: "裁剪后精定位未确认对象,已降级返回阶段1粗框。模型原始输出: " + raw.slice(0, 200),
            }, null, 2)}`;
            return { content: [{ type: "text", text }] };
          }
          stage2 = bbox;
          await cacheSet(k2, { bbox: stage2 });
        }

        // 换算:裁剪图内 bbox → 全图坐标(未裁剪降级时,模型输出已是全图坐标)
        const fullBbox = cropped ? cropToFull(stage2Region, stage2) : stage2;
        const text = `定位结果（归一化坐标 [0,1000]）:\n${JSON.stringify({
          object: objectDesc,
          stage1_bbox: stage1Region.map((n) => Math.round(n * 10) / 10),
          stage2_bbox: fullBbox.map((n) => Math.round(n * 10) / 10),
          note: stage1Note + (cropped ? " (粗框膨胀 30% 后精定位)" : " (未裁剪降级,阶段2为全图坐标)"),
        }, null, 2)}`;
        return { content: [{ type: "text", text }] };
      }

      case "check_health": {
        const report = { status: "ok", ollama: {}, model: {}, config: {}, cache_entries: 0 };
        try {
          const origin = new URL(OLLAMA_BASE_URL).origin;
          const res = await fetch(`${origin}/api/tags`);
          if (res.ok) {
            const tags = await res.json();
            report.ollama = { reachable: true, version: (await fetch(`${origin}/api/version`).then(r => r.json()).catch(() => ({}))).version || "unknown" };
            const names = (tags.models || []).map((m) => m.name);
            report.model = {
              name: OLLAMA_MODEL,
              found: names.some((n) => n === OLLAMA_MODEL || n.startsWith(OLLAMA_MODEL.split(":")[0] + ":")),
            };
            if (!report.model.found) report.status = "degraded";
          } else {
            report.ollama = { reachable: false, http: res.status };
            report.status = "failed";
          }
        } catch {
          report.ollama = { reachable: false };
          report.status = "failed";
        }
        report.config = {
          base_url: OLLAMA_BASE_URL,
          model: OLLAMA_MODEL,
          concurrency: CONCURRENCY,
          retries: MAX_RETRIES,
        };
        report.cache_entries = await countCacheEntries();
        return { content: [{ type: "text", text: JSON.stringify(report, null, 2) }] };
      }

      case "compare_images": {
        if (!args2.image_a || !args2.image_b) throw new Error("image_a 和 image_b 必填");
        const { bytes, hash, preprocessed } = await composeCompareImage(args2.image_a, args2.image_b);
        const key = cacheKey(hash, name, { focus: args2.focus || "" });
        const hit = await cacheGet(key);
        if (hit && typeof hit.text === "string") {
          return { content: [{ type: "text", text: "[cache-hit] " + hit.text }] };
        }
        const prompt = COMPARE_PROMPT(args2.focus);
        const raw = await callVisionAPI(`data:image/jpeg;base64,${bytes.toString("base64")}`, prompt);
        // 解析差异 JSON(对象格式 {"changes":[...]},容错;失败降级返回原始文本)
        const parsed = extractObjectJSON(raw);
        const validChanges = parsed && Array.isArray(parsed.changes);
        const text = validChanges
          ? `对比结果（共 ${parsed.changes.length} 处差异）:\n${JSON.stringify(parsed, null, 1)}`
          : `模型输出无法解析为差异 JSON，返回原始内容：\n${raw}`;
        await cacheSet(key, { text });
        return {
          content: [{
            type: "text",
            text: `${text}\n${preprocessed ? "" : "(预处理不可用,原图直传)"}`,
          }],
        };
      }

      case "read_clipboard": {
        const img = await readClipboardImage();
        if (!img) {
          return { content: [{ type: "text", text: "剪贴板中没有图片。请先复制一张图片(Ctrl+C)再重试。" }] };
        }
        const text = `剪贴板图片已导出：\n${JSON.stringify({ path: img.path, width: img.width, height: img.height }, null, 2)}\n可直接用其他视觉工具(image_path=${img.path})继续分析。`;
        return { content: [{ type: "text", text }] };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (err) {
    const { category, message } = classifyError(err, OLLAMA_MODEL);
    return {
      content: [{ type: "text", text: `[${category}] ${message}` }],
      isError: true,
    };
  }
}
