# Positioning — dsh-vision-bridge 市场定位

> 定位文档 · [English](#positioning--dsh-vision-bridge) 双语版见各节。

## One-liner

> 对使用 DeepSeek 纯文本模型、想要原生图片体验的 DSH 用户，dsh-vision-bridge 是让 DeepSeek 官方模型
> "声明图片能力"、并在请求层用本地 Ollama 完成视觉理解的视觉补全插件——不同于 ModLens / vision-router
> 的"粘贴转 JSON/路径"工具桥，也不同于 DeepSee 的云端 Gemini。
>
> *For DeepSeek Harness users on text-only DeepSeek models who want a native image experience,
> dsh-vision-bridge is the vision plugin that re-registers the official DeepSeek route as
> image-capable and does the seeing locally at the request layer — unlike ModLens/vision-router
> tool bridges and unlike DeepSee's cloud Gemini.*

## Market snapshot (2026-08, live data)

| Dimension | Number |
| --- | --- |
| `dsh-plugin` topic repositories | 4904 |
| vision-related among them | 197 |
| Head-to-head competitors | ModLens (2203★), agent-vision-toolkit (933★), dsh-vision-toolkit (487★), dsh-vision-router (317★), DeepSee |

## Differentiation (three axes)

| Axis | Mainstream | dsh-vision-bridge |
| --- | --- | --- |
| **Interaction layer** | paste → JSON evidence / path (tool bridge, changes the interaction) | **the model itself declares image capability** — native paste, thumbnails, image blocks, `read_image` all work; interaction unchanged |
| **Engine layer** | cloud API (ModLens/DeepSee Gemini), keyless chains (vision-router) | **local Ollama**: zero keys, zero quota, image bytes never leave the machine |
| **Capability layer** | mainstream: OCR + layout JSON | coordinate-grade full stack: normalized bboxes, real region cropping, two-stage localization, image comparison, clipboard reads |

## Competitor comparison

| Project | Form | Engine | Native UX | Structured | Privacy |
| --- | --- | --- | --- | --- | --- |
| ModLens (2203★) | tool bridge | cloud | ❌ paste→JSON | OCR/layout/semantics | images leave machine |
| agent-vision-toolkit (933★) | tools+skill | multiple | ❌ | multi-image/long OCR/UI restore | depends |
| dsh-vision-router (317★) | toolchain | keyless chain | ❌ | pixel-level (grounding/pixel diff) | depends |
| DeepSee | twin + client conversion | Gemini cloud | partial (thumbnail kept, still path) | block transcription | images leave machine |
| **dsh-vision-bridge** | **twin route + tools** | **local Ollama** | ✅ **fully native** | coordinate-grade full stack | **images never leave the machine** |

## Target users & scenarios

1. deepseek-v4-flash/pro users who want paste-to-use without switching models or cloud keys.
2. Privacy-sensitive workflows — screenshots contain internal documents/secrets.
3. UI/front-end developers — visual regression (`compare_images`), coordinate-grade localization
   (`structured_scan` → `query_region`), screenshot-driven debugging.
4. Zero-cost preference — local GPU with Ollama, no vision subscriptions.

## Market landing

- Discovery: `topic:dsh-plugin` + keywords `vision` `local` `native` `ollama`; npm: `dsh-vision-bridge`.
- Tagline: *Native image pipeline + local agentic vision for text-only DeepSeek models in
  DeepSeek Harness. No cloud keys, no preset forks.*
- Core memory point: **the only vision plugin in the market with "model-level native +
  engine-level local"** — others add tools, this one adds the capability itself.
