/**
 * lib/compare.js — 双图对比 (v2.3.0)
 * 两张图各自缩放后横向拼接成一张对比图,单次推理让视觉模型输出结构化差异。
 * 用途:before/after 视觉回归、Web GUI 测试布局 diff。
 */
import sharp from "sharp";
import { resolveImageBytes, contentHash, PREPROCESS_ENABLED } from "./image.js";

// 拼接目标:每张图统一高度后左右拼接,总宽 ≤ MAX_DIM*2 由 sharp 自动控制
const COMPARE_HEIGHT = parseInt(process.env.VISION_COMPARE_HEIGHT || "640", 10);

/**
 * 拼接两张图 → 单张 JPEG bytes
 * 失败(解码错误等)抛错,由调用方降级
 */
export async function composeCompareImage(imageA, imageB) {
  const a = await resolveImageBytes(imageA);
  const b = await resolveImageBytes(imageB);

  // 统一高度(不放大),保留各自宽高比
  const mk = (bytes) =>
    sharp(bytes)
      .resize(null, COMPARE_HEIGHT, { fit: "inside", withoutEnlargement: true })
      .png()
      .toBuffer();

  let [aBuf, bBuf] = [await mk(a.bytes), await mk(b.bytes)];
  // 拼接前统一高度(缩放后可能因取整差 1px)
  const [aMeta, bMeta] = await Promise.all([sharp(aBuf).metadata(), sharp(bBuf).metadata()]);
  const h = Math.min(aMeta.height, bMeta.height);
  if (aMeta.height !== h) aBuf = await sharp(aBuf).resize(null, h).png().toBuffer();
  if (bMeta.height !== h) bBuf = await sharp(bBuf).resize(null, h).png().toBuffer();

  // 中间加 10px 白色分隔线,帮助模型区分左右图
  const divider = await sharp({
    create: { width: 10, height: h, channels: 3, background: { r: 255, g: 255, b: 255 } },
  }).png().toBuffer();

  const combined = await sharp({
    create: { width: (aMeta.width + bMeta.width + 10), height: h, channels: 3, background: { r: 255, g: 255, b: 255 } },
  })
    .composite([
      { input: aBuf, left: 0, top: 0 },
      { input: divider, left: aMeta.width, top: 0 },
      { input: bBuf, left: aMeta.width + 10, top: 0 },
    ])
    .jpeg({ quality: 85 })
    .toBuffer();

  return {
    bytes: combined,
    hash: contentHash(Buffer.concat([a.bytes, b.bytes])),
    preprocessed: PREPROCESS_ENABLED,
  };
}

export const COMPARE_PROMPT = (focus) => `这张图片由左右两张图拼接而成,中间有一条白色竖线分隔：
- 左侧 = 图 A(修改前/基线)
- 右侧 = 图 B(修改后/当前)

请对比两张图的差异，输出严格 JSON（不要代码块围栏，不要任何解释文字）：
{"changes":[{"type":"added|removed|moved|changed|text_diff","description":"差异描述","location":"left|right|both"}]}

要求：
1. 只报告有意义的视觉差异（布局、元素、文字、颜色），忽略细微噪声
2. 文字差异用 text_diff，说明从什么变成什么
3. 没有差异时输出 {"changes":[]}
4. 中间的白色竖线是拼接分隔符，永远不是差异，不得报告
${focus ? `5. 重点关注：${focus}` : ""}`;
