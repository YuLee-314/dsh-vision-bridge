/**
 * lib/errors.js — 错误分类器 (v2.2.0)
 * 把底层错误分类为可操作的类别,输出友好提示,排障从"猜"变"看"。
 */
export function classifyError(err, modelName) {
  const msg = err instanceof Error ? err.message : String(err);

  // Ollama 服务未运行:连接被拒 / 网络不可达
  if (
    /ECONNREFUSED|ENOTFOUND|fetch failed|ETIMEDOUT|EAI_AGAIN/i.test(msg) ||
    /127\.0\.0\.1:11434.*connect/i.test(msg)
  ) {
    return {
      category: "ollama_down",
      message: `Ollama 服务不可达(127.0.0.1:11434)。请启动 Ollama(Windows 托盘图标,右键"退出"后重新打开),再重试。`,
    };
  }

  // 模型不存在
  if (/model .* not found|no such model|404/i.test(msg)) {
    return {
      category: "model_not_found",
      message: `视觉模型 "${modelName}" 不存在。请运行: ollama pull ${modelName}`,
    };
  }

  // 图片读取失败(本地路径)
  if (/ENOENT/i.test(msg) && /open/i.test(msg)) {
    return {
      category: "image_read",
      message: `图片文件读取失败: ${msg}. 请检查路径是否正确(支持 Windows 路径与 Git Bash /d/... 路径)。`,
    };
  }

  // 其他网络错误
  if (/network|socket|timeout|aborted/i.test(msg)) {
    return { category: "network", message: `网络错误: ${msg}` };
  }

  // 其余(参数错误、内部错误等)
  return { category: "unknown", message: msg };
}
