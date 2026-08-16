/**
 * lib/grounding.js — 两阶段精确定位 (v2.2.0)
 * 阶段1: 全图粗定位(允许 bbox 偏大,只求召回)
 * 阶段2: 按粗 bbox 裁剪放大后精定位(小图 bbox)
 * 换算: 小图 [0,1000] → 裁剪区域 → 全图 [0,1000]
 *
 * 依据 qlens 生产验证方案:JSON 归一化坐标 + 低温度,放弃 <|box_start|> 特殊 token
 * (Ollama 下输出不稳定;归一化坐标免疫 smart_resize 处理图尺寸换算问题)。
 */

// 粗定位 prompt:全图范围内找对象,允许框偏大
export const GROUNDING_PROMPT = (objectDesc) => `你是精确定位助手。在整张图片中定位以下对象：${objectDesc}

坐标系统：归一化坐标 [0,1000]，原点在图片左上角。bbox 为紧贴对象的最小矩形 [x1,y1,x2,y2]（左上角 → 右下角），x1<x2，y1<y2。若存在多个同名对象，框住最显眼的一个。

输出格式：严格 JSON，不要代码块围栏，不要任何解释文字：
{"bbox":[x1,y1,x2,y2]}

如果图片中找不到该对象，输出：
{"bbox":null}`;

// 精定位 prompt:只在裁剪后的局部图中定位,边界更紧
export const FINE_PROMPT = (objectDesc) => `这是一张从原图裁剪出的局部区域图片。请在图中精确定位以下对象：${objectDesc}

坐标系统：归一化坐标 [0,1000]，原点在图片左上角（相对于这张裁剪图）。bbox 为紧贴对象的最小矩形 [x1,y1,x2,y2]，x1<x2，y1<y2。

输出格式：严格 JSON，不要代码块围栏，不要任何解释文字：
{"bbox":[x1,y1,x2,y2]}

如果该区域中找不到该对象，输出：
{"bbox":null}`;

/**
 * 裁剪内 bbox → 全图 bbox 换算
 * @param region 裁剪区域(全图归一化 [x1,y1,x2,y2])
 * @param cropBbox 裁剪图内 bbox(裁剪图归一化 [x1,y1,x2,y2])
 * @returns 全图归一化 bbox(经 clamp,保证合法)
 */
export function cropToFull(region, cropBbox) {
  const [rx1, ry1, rx2, ry2] = region;
  const [cx1, cy1, cx2, cy2] = cropBbox;
  const rw = rx2 - rx1;
  const rh = ry2 - ry1;
  const out = [
    rx1 + (cx1 / 1000) * rw,
    ry1 + (cy1 / 1000) * rh,
    rx1 + (cx2 / 1000) * rw,
    ry1 + (cy2 / 1000) * rh,
  ];
  // clamp 到 [0,1000] 且 x1<x2, y1<y2
  for (let i = 0; i < 4; i++) out[i] = Math.min(1000, Math.max(0, out[i]));
  return [Math.min(out[0], out[2] - 0.1), Math.min(out[1], out[3] - 0.1), Math.max(out[2], out[0] + 0.1), Math.max(out[3], out[1] + 0.1)];
}

/**
 * 区域膨胀:按宽高比例外扩,给精定位裁剪留余量
 * (检测框膨胀是标准做法;粗定位框"紧贴对象"时,直接裁剪会丢失上下文导致精定位失败)
 */
export function expandRegion(region, ratio = 0.3) {
  const [x1, y1, x2, y2] = region;
  const ex = (x2 - x1) * ratio;
  const ey = (y2 - y1) * ratio;
  return [
    Math.max(0, x1 - ex),
    Math.max(0, y1 - ey),
    Math.min(1000, x2 + ex),
    Math.min(1000, y2 + ey),
  ];
}
