/**
 * lib/validate.js — 结构化输出校验器 (v2.1.0,零依赖)
 * 校验视觉模型返回的元素/bbox/置信度;校验失败由 server.js 触发带修正提示词的重试。
 */

export const ELEMENT_TYPES = new Set([
  "heading", "text", "table", "image", "chart", "formula", "button", "list",
]);

/** bbox 合法:4 个有限数字、范围 [0,1000]、x1<=x2 且 y1<=y2 */
export function validBbox(b) {
  return (
    Array.isArray(b) && b.length === 4 &&
    b.every((n) => typeof n === "number" && Number.isFinite(n)) &&
    b.every((n) => n >= 0 && n <= 1000) &&
    b[0] <= b[2] && b[1] <= b[3]
  );
}

function validConfidence(c) {
  return c === undefined || (typeof c === "number" && Number.isFinite(c) && c >= 0 && c <= 1);
}

export function validateStructuredScan(items) {
  return (
    Array.isArray(items) &&
    items.every(
      (i) =>
        i && typeof i === "object" &&
        ELEMENT_TYPES.has(i.type) &&
        validBbox(i.bbox) &&
        validConfidence(i.confidence) &&
        (i.text === undefined || typeof i.text === "string")
    )
  );
}

export function validateOcrCoordinates(items) {
  return (
    Array.isArray(items) &&
    items.every(
      (i) => i && typeof i === "object" && typeof i.text === "string" && validBbox(i.bbox)
    )
  );
}

export function validateDetectElements(items) {
  return (
    Array.isArray(items) &&
    items.every(
      (i) =>
        i && typeof i === "object" &&
        ELEMENT_TYPES.has(i.type) &&
        validBbox(i.bbox) &&
        validConfidence(i.confidence)
    )
  );
}

/** 重试时追加在原始 prompt 之后的修正提示词 */
export const RETRY_HINT =
  "\n\n注意:你上次的输出未通过格式校验。必须严格输出 JSON 数组,每个元素的 bbox 必须是 4 个数字 [x1,y1,x2,y2],坐标范围 0-1000(归一化),且 x1<=x2、y1<=y2。不要输出代码块围栏,不要任何解释文字。";
