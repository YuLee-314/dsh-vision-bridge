# dsh-vision-bridge

A DeepSeek Harness plugin that lets text-only models receive and understand images. The vision work is done by a local model on your machine.

[![Plugin](https://img.shields.io/badge/dsh-bundle%20plugin-blue)](https://github.com/deepseek-ai/deepseek-harness)
[![Version](https://img.shields.io/badge/version-2.0.0-green)](#)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22.19-43853d)](#)
[![Platform](https://img.shields.io/badge/platform-win%20%7C%20macOS%20%7C%20linux-lightgrey)](#)

**English** · [简体中文](README.zh-CN.md)

---

## What is this?

DeepSeek Harness (dsh) is an open-source AI coding environment built entirely from plugins. Its chat models — `deepseek-v4-flash` and `deepseek-v4-pro` — are **text-only**: their API rejects image data. As a result, in Harness you cannot paste a screenshot into a session that uses them, attach an image to a message, or use the built-in `read_image` tool.

This plugin fixes that. It works in three layers:

1. **A second model route that accepts images.** The same DeepSeek models are registered again as a "twin" provider (`deepseek-vision`). Because the twin declares image support, the normal image features work: pasting produces a thumbnail and an image block, and `read_image` is allowed. Before each request is sent to the DeepSeek API, the plugin converts every image in the conversation into a text description produced by a local vision model. The API only ever receives text; the model answers as if it had seen the image.
2. **Nine inspection tools.** `describe_image`, `extract_text`, `structured_scan`, `query_region`, `detect_elements`, `locate_object`, `compare_images`, `read_clipboard`, and `check_health` let the model look at an image at different levels of detail — from a general description down to per-element coordinates — and let you do the same through chat.
3. **Paste routing.** When you paste an image, a small browser component asks the server whether the current model can handle images. If yes (twin route), the paste stays a normal image. If no (official text-only route), the image is saved to a private local file and the path is inserted as text, which the inspection tools can then read.

The vision model (Ollama + `qwen2.5vl`) runs on your machine. No image bytes are ever sent to DeepSeek's API or to any cloud vision service.

If you only use the official route, the plugin still helps: pasted images become local paths and the inspection tools work on them. If you only want the tools, you can ignore the twin route entirely.

## Table of Contents

- [What is this?](#what-is-this)
- [The Problem](#the-problem)
- [The Solution](#the-solution)
- [Features](#features)
- [Architecture](#architecture)
- [Interaction Logic](#interaction-logic)
- [Installation](#installation)
- [Usage](#usage)
- [Configuration](#configuration)
- [Vision Tools](#vision-tools)
- [Project Structure](#project-structure)
- [Security & Privacy](#security--privacy)
- [Requirements](#requirements)
- [Troubleshooting](#troubleshooting)
- [License](#license)

---

## The Problem

DeepSeek's flagship chat models (`deepseek-v4-flash`, `deepseek-v4-pro`) are **text-only**: their API
endpoints cannot receive image bytes, and their model metadata declares `inputModalities: ['text']`.
DeepSeek Harness builds on that metadata in three hard places:

| Gate | Location | Effect |
| --- | --- | --- |
| **Composer admission** | `api-proxy` `prompt` handler | Pasting an image is rejected: "the current model does not support images" — the image part never enters the conversation |
| **`read_image` tool** | `dsh-tool-fs` | Refuses to read an image into context unless the active route declares image input |
| **Adapter serializer** | `llm-deepseek` | Core image blocks are rejected (`UNSUPPORTED_CONTENT`) — images physically cannot reach the provider |

Workarounds in the wild either **fork presets** (fragile), require **cloud vision keys** (Gemini etc.), or
force you to **switch to a weaker vision model** for the whole session — losing DeepSeek's coding
ability. None of them deliver what users actually want: *DeepSeek, plus native image UX, plus the
ability to see.*

## The Solution

One self-contained plugin, three cooperating layers:

1. **Vision twin route** (`deepseek-vision`) — the same DeepSeek models re-registered with
   `inputModalities: ['text', 'image']`. Every native gate opens: paste admission, thumbnails,
   durable image blocks, `read_image`. Under the hood the twin **intercepts image blocks at the
   request layer**, runs the local vision bridge, and forwards only text to DeepSeek's API.
2. **Agentic vision tools** — nine native tools (`describe_image`, `structured_scan`, `query_region`,
   ...) powered by a local Ollama vision model, with structured output, validation-with-retry, and
   content-addressed caching.
3. **Paste router** — a browser half that asks the host for a verdict based on *real model
   metadata*: vision-capable routes keep the native photo flow; text-only routes fall back to a
   local path so the bridge tools can take over.

## Features

- **Native image experience for text-only models** — paste a screenshot, get a thumbnail, image
  block, and a DeepSeek that actually saw it, without a single image byte ever reaching the API.
- **No cloud keys required** — the vision engine is local Ollama (`qwen2.5vl`); the twin reuses your
  existing `DEEPSEEK_API_KEY` credential with the official route's own resolution logic.
- **Request-layer transparency** — no prompt hacks, no preset forks, no dynamic injection that can
  race; the interception happens in the adapter, exactly once, per request.
- **Structured output with coordinates** — element bounding boxes (`[0,1000]` normalized), region
  cropping, two-stage localization, image comparison, clipboard reads, schema-validated output
  with automatic retry on malformed responses.
- **Repeated images are cached** — repeated images hit the content-hash cache: zero extra inference, stable
  prefix-cache behavior.
- **Self-contained & distributable** — a single 29 KB tarball with no machine-specific paths;
  installs on any Harness via `dsh plugin --profile web add`.
- **Coexists with the official route** — the official provider stays untouched as the fallback;
  the paste verdict decides per session, from live metadata, which flow runs.

## Architecture

```
┌──────────────────────────── Browser · client.js ────────────────────────────┐
│ paste / drop image                                                          │
│   → capture-phase listener (before the composer's own)                      │
│   → GET /vision-bridge/paste?model=<selector label>   (host verdict)        │
│        ├─ takeover:true   (confirmed text-only route)                       │
│        │    → POST bytes → host saves private temp file → path text         │
│        │      inserted into the composer; bridge tools take over            │
│        └─ takeover:false  (image-capable route)                             │
│             → native paste: image part + thumbnail, untouched               │
└─────────────────────────────────────┬───────────────────────────────────────┘
                                      ▼
┌──────────────────────── Host plugin · lib/index.js ────────────────────────┐
│  · POST /vision-bridge/paste → magic-byte sniff → 0600 temp file → {path}  │
│  · 9 tools registered into ctx.tools (native catalog, no mcp__ prefix)     │
│  · registerAdapter('deepseek-vision', VisionDeepSeekAdapter)               │
└──────────────┬───────────────────────────────────────────┬─────────────────┘
               ▼                                           ▼
     ┌────────────────────┐                  ┌──────────────────────────────┐
     │ vision-core         │                  │ VisionDeepSeekAdapter (twin) │
     │ · prepare/validate  │                  │ · listModels/resolveModel:  │
     │ · queue (serial)    │                  │   image-capable metadata     │
     │ · LRU cache         │                  │ · stream(): ImageBlock ──►   │
     │ · 9 tool handlers   │                  │   bridge analysis text ──►   │
     │                     │                  │   DeepSeek API (text-only)  │
     └──────────┬──────────┘                  └───────────────┬──────────────┘
                ▼                                              ▼
        Ollama · qwen2.5vl                        DeepSeek API · same endpoint,
        localhost · private · free                same credential as official
```

`lib/core/` is the host-agnostic vision core shared with the author's MCP vision bridge
(`scripts/sync-core.mjs` re-syncs it — one source of truth, two delivery forms).

## Interaction Logic

### 1. Paste routing (per paste, decided by live model metadata)

| Session model | Verdict | What happens when you paste |
| --- | --- | --- |
| `DeepSeek-V4-Flash/Pro (视觉桥)` (twin) | `takeover:false` | **Native photo**: thumbnail + image block; the twin analyses it at the request layer |
| `DeepSeek-V4-Flash` (official) | `takeover:true` | Paste bytes → private temp file → path text; the model calls bridge tools on the path |
| Any future vision-capable route | `takeover:false` | Native paste preserved automatically — the verdict is evidence-based, never a name regex |

The client caches verdicts per selector label (60 s TTL) and refreshes on focus, so the first paste
of a session is already correct. Unknown metadata **never** hijacks a paste — the native path is
the safe default.

### 2. Request-layer interception (vision twin only)

```
user pastes image ──► durable image block in session history
        │
        ▼
next model request ──► VisionDeepSeekAdapter.stream()
        │
        ▼
sanitize(): for every image block ──► attachments.readImage(bytes)
        │                                 │
        │                                 ▼
        │               write content-addressed file
        │               (~/.dsh/vision-bridge/images/<sha1>.png)
        │                                 │
        │                                 ▼
        │               vision-core.describe_image(path)   ← cache hit ⇒ zero inference
        │                                 │
        │                                 ▼
        │               text: [图片（视觉桥分析）] … + local path
        │
        ▼
text-only request ──► DeepSeek API (identical endpoint/credential as official route)
        │
        ▼
DeepSeek answers WITH the vision analysis; it may also call query_region / extract_text
on the embedded path for deeper, coordinate-accurate inspection.
```

### 3. Tool chain (evidence workflow)

```
structured_scan ──► element list with bboxes (heading/table/chart/button/…)
        │
        ├──► query_region(bbox) ──► the region is REALLY cropped and analyzed alone
        ├──► extract_text(with_coordinates) ──► OCR blocks with normalized coordinates
        └──► locate_object(desc) ──► coarse locate → crop ×1.3 → fine locate → full-image bbox
```

## Installation

```powershell
# 1. Prerequisites: Ollama running with a vision model (e.g. qwen2.5vl:7b),
#    and DEEPSEEK_API_KEY stored (for the twin route).

# 2. Install the plugin (any form works)
dsh plugin --profile web add .\dsh-external-dsh-vision-bridge-2.0.0.tgz   # tarball
#   dsh plugin --profile web add <directory>                             # checkout
#   dsh plugin --profile web add @yulee314/dsh-vision-bridge            # npm

# 3. Restart dsh web (bundle layers load at boot)
```

## Usage

1. In any session, open the **model selector** and pick:
   - **DeepSeek (视觉桥) → DeepSeek-V4-Flash (视觉桥)** — recommended: coding + native image UX,
     vision supplied by the bridge.
   - Official `DeepSeek` route — paste falls back to path text; bridge tools remain available.
2. Paste or drop an image. A thumbnail appears (twin) or a path is inserted (official).
3. Ask normally. DeepSeek answers from the bridge analysis; use `query_region` / `extract_text`
   for coordinate-level detail.

To make the twin the default for every new session:

```yaml
# ~/.dsh/settings.yaml
agent-default-model:
  provider: deepseek-vision
  model: deepseek-v4-flash-vision
  reasoningEffort: max
```

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `OLLAMA_BASE_URL` | `http://127.0.0.1:11434/v1` | Vision engine endpoint (OpenAI-compatible) |
| `OLLAMA_VISION_MODEL` | `qwen2.5vl:7b-q3_K_M` | Vision model used by the bridge tools |
| `OLLAMA_API_KEY` | `ollama` | Compatible key for the engine |
| `VISION_MAX_TOKENS` / `VISION_TEMPERATURE` / `VISION_MAX_RETRIES` / `VISION_CONCURRENCY` | `8192` / `0.1` / `1` / `1` | Inference parameters |
| `DEEPSEEK_API_KEY` | credentials service | Twin-route key — same source as the official route |
| `DEEPSEEK_BASE_URL` | public API | Twin-route endpoint — same resolution as the official route |

Tool rows are disabled by setting `pasteToPath: false` on the bundle row if the paste router is
undesired on a specific deployment.

## Vision Tools

| Tool | What it does |
| --- | --- |
| `describe_image` | Full-image understanding in Chinese; accepts paths and URLs |
| `extract_text` | OCR — plain text, or block-level JSON with normalized coordinates |
| `structured_scan` | Element detection (heading/text/table/image/chart/formula/button/list) with bboxes + confidence, schema-validated |
| `query_region` | Region-focused query — the region is **really cropped** before inference |
| `detect_elements` | Bbox-only localization for selected element types |
| `locate_object` | Two-stage localization: coarse full-image → ×1.3 crop → fine → full-image bbox |
| `compare_images` | Before/after visual regression: side-by-side composite, structured diff JSON |
| `read_clipboard` | Windows clipboard image → exported PNG path |
| `check_health` | Ollama reachability, model presence, config summary, cache size — zero inference |

## Project Structure

```
dsh-vision-bridge/
├── package.json              # dsh.bundle + dsh.client manifests, self-contained deps
├── cordis.patch.yml          # loader row (bundle layer)
├── client.js                 # browser half: paste interception + verdict protocol
├── README.md / README.zh-CN.md
├── scripts/sync-core.mjs     # re-sync lib/core from the MCP vision bridge
└── lib/
    ├── index.js              # host plugin: tools, paste route, adapter registration
    ├── deepseek-vision.mjs   # vision twin route (extends the official DeepSeek adapter)
    └── core/                 # host-agnostic vision core (vendored, self-contained)
        ├── vision-core.mjs   #   tools + prompts + retry/validation orchestration
        ├── image.js          #   preprocessing, crop, data URLs
        ├── validate.js       #   schema validation + retry hints
        ├── cache.js          #   content-hash LRU
        ├── queue.js          #   serial inference queue
        ├── errors.js         #   error taxonomy (ollama_down / model_not_found / …)
        ├── grounding.js      #   two-stage localization math
        ├── compare.js        #   side-by-side comparison composition
        └── clipboard.js      #   Windows clipboard reader
```

## Security & Privacy

- **Images never leave your machine.** The vision engine is localhost Ollama; the twin route
  sends only the bridge's **text analysis** to DeepSeek's API.
- Pasted bytes are magic-byte checked (PNG/JPEG/WebP/GIF), size-capped (25 MB), and stored `0600`
  in fresh unpredictable temp directories.
- The twin reuses the official route's credential resolution — no second key, no plaintext config.
- Paste hijacking is strictly evidence-based: without a positive text-only confirmation the native
  path stays untouched.

## Requirements

| Component | Requirement |
| --- | --- |
| DeepSeek Harness | web profile, rc.5+ (tested on 0.1.0-rc.5) |
| Node.js | ≥ 22.19 |
| Ollama | running, with a vision model (tested: `qwen2.5vl:7b`) |
| API key | `DEEPSEEK_API_KEY` for the twin route (same as official) |

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| Paste still inserts a path text | The session is on the **official** route — select the `(视觉桥)` variant, or check the latest `verdict` entry in `~/.dsh/vision-bridge-activity.jsonl` for the real selector label |
| Tools report `[ollama_down]` | `ollama serve` not running, or the model missing (`ollama pull qwen2.5vl:7b`) |
| Twin route fails with `MISSING_CREDENTIAL` | Store `DEEPSEEK_API_KEY` on the Web Models page or export it in the environment |
| `read_image` refuses on the twin | Only possible if the twin's metadata is not loaded — restart dsh after installing |
| Plugin changes not active | Bundle layers load at boot; restart dsh web after `dsh plugin` operations |

## License

MIT. The vision core originates from the author's MCP vision bridge project.
