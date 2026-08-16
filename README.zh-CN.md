# dsh-vision-bridge

**为 DeepSeek Harness 中的纯文本模型解锁原生图片体验与智能体视觉。**

[![Plugin](https://img.shields.io/badge/dsh-bundle%20plugin-blue)](https://github.com/deepseek-ai/deepseek-harness)
[![Version](https://img.shields.io/badge/version-2.0.0-green)](#)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22.19-43853d)](#)
[![Platform](https://img.shields.io/badge/platform-win%20%7C%20macOS%20%7C%20linux-lightgrey)](#)

> DeepSeek 继续当大脑。解锁 Harness 的**原生图片管线**——粘贴、缩略图、图片块、`read_image`——
> 再由**本地视觉桥**在请求层透明地替纯文本模型"看见"。一个系统，不是两个。

[English](README.md) · **简体中文**

---

## 目录

- [解决的问题](#解决的问题)
- [解决方案](#解决方案)
- [功能特性](#功能特性)
- [系统架构](#系统架构)
- [交互逻辑](#交互逻辑)
- [安装](#安装)
- [使用](#使用)
- [配置](#配置)
- [视觉工具](#视觉工具)
- [项目结构](#项目结构)
- [安全与隐私](#安全与隐私)
- [环境要求](#环境要求)
- [故障排查](#故障排查)
- [许可证](#许可证)

---

## 解决的问题

DeepSeek 旗舰对话模型（`deepseek-v4-flash`、`deepseek-v4-pro`）是**纯文本模型**：API 端点无法接收
图片字节，模型元数据也声明 `inputModalities: ['text']`。DeepSeek Harness 在三个硬关卡上依赖这份元数据：

| 关卡 | 位置 | 后果 |
| --- | --- | --- |
| **输入准入** | `api-proxy` 的 `prompt` 处理器 | 粘贴图片被拒绝："当前模型不支持图片"——图片块根本进不了会话 |
| **`read_image` 工具** | `dsh-tool-fs` | 除非当前路由声明图片输入，否则拒绝把图片读入上下文 |
| **适配器序列化** | `llm-deepseek` | 核心图片块被拒绝（`UNSUPPORTED_CONTENT`）——图片物理上到不了模型 |

市面上的变通方案要么**fork preset**（脆弱）、要么依赖**云端视觉 key**（Gemini 等）、要么迫使你
**为整个会话切换成更弱的视觉模型**——丢掉 DeepSeek 的编码能力。没有一种真正满足需求：
*DeepSeek 主脑 + 原生图片体验 + 看得见。*

## 解决方案

一个自包含插件，三层协同：

1. **视觉孪生路由**（`deepseek-vision`）——同一批 DeepSeek 模型以 `inputModalities: ['text','image']`
   重新注册。所有原生关卡随之打开：粘贴准入、缩略图、持久图片块、`read_image`。底层，孪生
   在**请求层拦截图片块**，交给本地视觉桥分析，只把文本转发给 DeepSeek API。
2. **智能体视觉工具**——九个原生工具（`describe_image`、`structured_scan`、`query_region` …），
   由本地 Ollama 视觉模型驱动：结构化输出、校验+重试、内容寻址缓存。
3. **粘贴分流器**——浏览器半部向宿主请求判定，依据**真实模型元数据**：视觉能力路由保留原生
   照片流；纯文本路由回退到本地路径，由桥工具接管。

## 功能特性

- **纯文本模型的原生图片体验**——粘贴截图 → 缩略图、图片块、真正"看见"的 DeepSeek，全程没有
  一个图片字节到达 API。
- **零云端 key**——视觉引擎是本地 Ollama（`qwen2.5vl`）；孪生复用你已有的 `DEEPSEEK_API_KEY`
  凭据，解析逻辑与官方路由完全同源。
- **请求层透明**——无提示词 hack、无 preset fork、无可能竞态的动态注入；拦截发生在适配器内，
  每个请求恰好一次。
- **证据级结构化视觉**——元素边界框（`[0,1000]` 归一化）、区域真裁剪、两级定位、双图对比、
  剪贴板读取、schema 校验输出 + 格式错误自动重试。
- **缓存中性**——重复图片命中内容哈希缓存：零额外推理，前缀缓存行为稳定。
- **自包含、可分发**——单个 29KB tarball，无任何本机路径依赖；任何机器 `dsh plugin --profile web add` 即装。
- **与官方路由共存**——官方 provider 原样保留作兜底；粘贴判定按会话、按实时元数据决定走哪条流。

## 系统架构

```
┌──────────────────────────── 浏览器 · client.js ────────────────────────────┐
│ 粘贴 / 拖拽图片                                                            │
│   → 捕获阶段监听（先于 composer 自身处理器）                                │
│   → GET /vision-bridge/paste?model=<选择器标签>   （宿主判定）              │
│        ├─ takeover:true   （确认纯文本路由）                                │
│        │    → POST 字节 → 宿主存私有临时文件 → 路径文本                      │
│        │      插入输入框；桥工具接管                                        │
│        └─ takeover:false  （图片能力路由）                                  │
│             → 原生粘贴：图片块 + 缩略图，原样保留                           │
└─────────────────────────────────────┬───────────────────────────────────────┘
                                      ▼
┌──────────────────────── 宿主插件 · lib/index.js ───────────────────────────┐
│  · POST /vision-bridge/paste → 魔数嗅探 → 0600 临时文件 → {path}           │
│  · 9 个工具注册进 ctx.tools（原生编目，无 mcp__ 前缀）                      │
│  · registerAdapter('deepseek-vision', VisionDeepSeekAdapter)               │
└──────────────┬───────────────────────────────────────────┬─────────────────┘
               ▼                                           ▼
     ┌────────────────────┐                  ┌──────────────────────────────┐
     │ vision-core         │                  │ VisionDeepSeekAdapter（孪生） │
     │ · 预处理/校验        │                  │ · listModels/resolveModel：  │
     │ · 串行队列           │                  │   图片能力元数据              │
     │ · LRU 缓存          │                  │ · stream()：图片块 ──►        │
     │ · 9 个工具处理器     │                  │   桥分析文本 ──►              │
     │                     │                  │   DeepSeek API（纯文本）      │
     └──────────┬──────────┘                  └───────────────┬──────────────┘
                ▼                                              ▼
        Ollama · qwen2.5vl                        DeepSeek API · 与官方同端点、
        本地 · 私有 · 免费                         同凭据
```

`lib/core/` 是与作者 MCP 视觉桥共享的宿主无关视觉核心（`scripts/sync-core.mjs` 可重新同步——
单一事实源，两种交付形态）。

## 交互逻辑

### 1. 粘贴分流（每次粘贴，按实时模型元数据判定）

| 会话模型 | 判定 | 粘贴后发生什么 |
| --- | --- | --- |
| `DeepSeek-V4-Flash/Pro (视觉桥)`（孪生） | `takeover:false` | **原生照片**：缩略图 + 图片块；孪生在请求层自动分析 |
| `DeepSeek-V4-Flash`（官方） | `takeover:true` | 字节 → 私有临时文件 → 路径文本；模型对路径调用桥工具 |
| 未来任何视觉能力路由 | `takeover:false` | 自动保留原生粘贴——判定基于证据，绝非名字正则 |

客户端按选择器标签缓存判定（60 秒 TTL）并在聚焦时刷新，会话的第一次粘贴就已正确。元数据未知
时**绝不劫持**粘贴——原生路径是安全默认。

### 2. 请求层拦截（仅视觉孪生）

```
用户粘贴图片 ──► 会话历史中的持久图片块
        │
        ▼
下一次模型请求 ──► VisionDeepSeekAdapter.stream()
        │
        ▼
sanitize()：对每个图片块 ──► attachments.readImage(字节)
        │                                 │
        │                                 ▼
        │               内容寻址落盘
        │               (~/.dsh/vision-bridge/images/<sha1>.png)
        │                                 │
        │                                 ▼
        │               vision-core.describe_image(路径)   ← 缓存命中 ⇒ 零推理
        │                                 │
        │                                 ▼
        │               文本：[图片（视觉桥分析）] … + 本地路径
        │
        ▼
纯文本请求 ──► DeepSeek API（与官方路由同端点、同凭据）
        │
        ▼
DeepSeek 基于视觉分析回答；也可对嵌入路径继续调用 query_region / extract_text
做更深、坐标级精确的检查。
```

### 3. 工具链（证据工作流）

```
structured_scan ──► 带 bbox 的元素清单（heading/table/chart/button/…）
        │
        ├──► query_region(bbox) ──► 区域被真正裁剪后单独分析
        ├──► extract_text(with_coordinates) ──► 带归一化坐标的 OCR 块
        └──► locate_object(描述) ──► 粗定位 → ×1.3 裁剪 → 精定位 → 全图 bbox
```

## 安装

```powershell
# 1. 前置：Ollama 运行中且有视觉模型（如 qwen2.5vl:7b）；
#    孪生路由需要 DEEPSEEK_API_KEY。

# 2. 安装插件（任选一种形式）
dsh plugin --profile web add .\dsh-external-dsh-vision-bridge-2.0.0.tgz   # tarball
#   dsh plugin --profile web add <包目录>                                # 本地 checkout
#   dsh plugin --profile web add <git 仓库> | <npm 包>                   # 远程

# 3. 重启 dsh web（bundle 层在启动时加载）
```

## 使用

1. 任意会话中打开**模型选择器**：
   - **DeepSeek (视觉桥) → DeepSeek-V4-Flash (视觉桥)** —— 推荐：编码 + 原生图片体验，视觉由桥供给。
   - 官方 `DeepSeek` 路由 —— 粘贴回退为路径文本；桥工具照常可用。
2. 粘贴或拖拽图片。孪生路由出现缩略图；官方路由插入路径。
3. 正常提问即可。DeepSeek 基于桥的分析回答；需要坐标级细节时用 `query_region` / `extract_text`。

让孪生成为每个新会话的默认：

```yaml
# ~/.dsh/settings.yaml
agent-default-model:
  provider: deepseek-vision
  model: deepseek-v4-flash-vision
  reasoningEffort: max
```

## 配置

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `OLLAMA_BASE_URL` | `http://127.0.0.1:11434/v1` | 视觉引擎端点（OpenAI 兼容） |
| `OLLAMA_VISION_MODEL` | `qwen2.5vl:7b-q3_K_M` | 桥工具使用的视觉模型 |
| `OLLAMA_API_KEY` | `ollama` | 引擎兼容密钥 |
| `VISION_MAX_TOKENS` / `VISION_TEMPERATURE` / `VISION_MAX_RETRIES` / `VISION_CONCURRENCY` | `8192` / `0.1` / `1` / `1` | 推理参数 |
| `DEEPSEEK_API_KEY` | credentials 服务 | 孪生路由密钥——与官方路由同源 |
| `DEEPSEEK_BASE_URL` | 公共 API | 孪生路由端点——与官方路由同源解析 |

若某部署不需要粘贴分流，可在 bundle 行配置 `pasteToPath: false` 关闭。

## 视觉工具

| 工具 | 作用 |
| --- | --- |
| `describe_image` | 全图理解（中文描述）；支持路径与 URL |
| `extract_text` | OCR——纯文本，或带归一化坐标的块级 JSON |
| `structured_scan` | 元素检测（heading/text/table/image/chart/formula/button/list），bbox + confidence，schema 校验 |
| `query_region` | 区域聚焦查询——推理前该区域被**真正裁剪** |
| `detect_elements` | 按类型返回纯 bbox 定位 |
| `locate_object` | 两级定位：全图粗定位 → ×1.3 裁剪 → 精定位 → 全图 bbox |
| `compare_images` | 前后视觉回归：并排拼接、结构化差异 JSON |
| `read_clipboard` | Windows 剪贴板图片 → 导出 PNG 路径 |
| `check_health` | Ollama 可达性、模型存在性、配置摘要、缓存大小——零推理 |

## 项目结构

```
dsh-vision-bridge/
├── package.json              # dsh.bundle + dsh.client 双清单，自包含依赖
├── cordis.patch.yml          # loader 行（bundle 层）
├── client.js                 # 浏览器半部：粘贴拦截 + verdict 协议
├── README.md / README.zh-CN.md
├── scripts/sync-core.mjs     # 从 MCP 视觉桥重新同步 lib/core
└── lib/
    ├── index.js              # 宿主插件：工具、粘贴路由、适配器注册
    ├── deepseek-vision.mjs   # 视觉孪生路由（继承官方 DeepSeek 适配器）
    └── core/                 # 宿主无关视觉核心（内嵌、自包含）
        ├── vision-core.mjs   #   工具 + prompt + 重试/校验编排
        ├── image.js          #   预处理、裁剪、data URL
        ├── validate.js       #   schema 校验 + 重试提示
        ├── cache.js          #   内容哈希 LRU
        ├── queue.js          #   串行推理队列
        ├── errors.js         #   错误分类（ollama_down / model_not_found / …）
        ├── grounding.js      #   两级定位换算
        ├── compare.js        #   并排对比图合成
        └── clipboard.js      #   Windows 剪贴板读取
```

## 安全与隐私

- **图片永不出机器。** 视觉引擎是本机 Ollama；孪生路由只把桥的**文本分析**发给 DeepSeek API。
- 粘贴字节经魔数校验（PNG/JPEG/WebP/GIF）、大小上限（25MB）、以 `0600` 存入全新不可预测的临时目录。
- 孪生复用官方路由的凭据解析——无第二把 key、无明文配置。
- 粘贴劫持严格基于证据：没有纯文本的正面确认，原生路径绝不动。

## 环境要求

| 组件 | 要求 |
| --- | --- |
| DeepSeek Harness | web profile，rc.5+（已在 0.1.0-rc.5 实测） |
| Node.js | ≥ 22.19 |
| Ollama | 运行中且有视觉模型（实测 `qwen2.5vl:7b`） |
| API key | 孪生路由需要 `DEEPSEEK_API_KEY`（与官方相同） |

## 故障排查

| 现象 | 原因 / 解决 |
| --- | --- |
| 粘贴仍插入路径文本 | 会话在**官方**路由上——选择 `(视觉桥)` 变体；或查看 `~/.dsh/vision-bridge-activity.jsonl` 最新 `verdict` 条目的真实标签 |
| 工具报 `[ollama_down]` | `ollama serve` 未运行，或模型缺失（`ollama pull qwen2.5vl:7b`） |
| 孪生路由报 `MISSING_CREDENTIAL` | 在 Web 模型设置页写入 `DEEPSEEK_API_KEY` 或导出环境变量 |
| 孪生上 `read_image` 被拒 | 只可能是孪生元数据未加载——安装后重启 dsh |
| 插件改动不生效 | bundle 层在启动时加载；`dsh plugin` 操作后重启 dsh web |

## 许可证

MIT。视觉核心源自作者自研的 MCP 视觉桥项目。
