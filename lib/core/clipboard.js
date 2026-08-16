/**
 * lib/clipboard.js — 剪贴板图片读取 (v2.3.0,Windows)
 * 用 PowerShell Get-Clipboard -Format Image 读取剪贴板图片,导出 PNG 到缓存目录。
 * 主模型拿到返回的路径后,可继续走 describe/scan/query_region 完整工具链。
 */
import { execFile } from "child_process";
import { promisify } from "util";
import { mkdir, stat } from "fs/promises";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const execFileAsync = promisify(execFile);

const CLIPBOARD_DIR =
  process.env.VISION_CLIPBOARD_DIR ||
  join(dirname(fileURLToPath(import.meta.url)), "..", "cache", "clipboard");

// PowerShell 路径(Windows 原生)
const PS_PATH = process.env.VISION_PS_PATH || "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";

/**
 * 读取剪贴板图片,导出 PNG 文件。
 * @returns {Promise<{path: string, width: number, height: number} | null>}
 *          null = 剪贴板无图片;抛错 = 读取失败
 */
export async function readClipboardImage() {
  await mkdir(CLIPBOARD_DIR, { recursive: true });
  const dest = join(CLIPBOARD_DIR, `clipboard-${Date.now()}.png`);

  // 用单引号包裹路径避免转义问题
  const psScript = [
    `$img = Get-Clipboard -Format Image -ErrorAction Stop`,
    `if ($null -eq $img) { exit 2 }`,
    `$img.Save('${dest.replace(/'/g, "''")}')`,
    `Write-Output "$($img.Width)x$($img.Height)"`,
  ].join("; ");

  try {
    const { stdout } = await execFileAsync(PS_PATH, ["-NoProfile", "-Command", psScript], {
      timeout: 15000,
      windowsHide: true,
    });
    const [w, h] = stdout.trim().split("x").map(Number);
    // 确认文件已写入
    const s = await stat(dest);
    if (!s.size) throw new Error("剪贴板导出文件为空");
    return { path: dest, width: w || 0, height: h || 0 };
  } catch (err) {
    if (err.code === 2) return null; // 剪贴板无图片
    throw err;
  }
}
