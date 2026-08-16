# publish.ps1 — 一键发布到 GitHub 并加入 dsh-plugin 社群
# 用法：在 GitHub 网页创建空仓库后运行：
#   powershell -ExecutionPolicy Bypass -File scripts/publish.ps1 -Owner <你的GitHub用户名> [-Repo dsh-vision-bridge]
#
# 社群机制：dsh-plugin-marketplace / dshmarket 实时同步 GitHub 的 dsh-plugin
# topic（1800+ 仓库），无需任何申请——公开仓库 + 打上 dsh-plugin topic 即被收录。

param(
  [Parameter(Mandatory = $true)][string]$Owner,
  [string]$Repo = "dsh-vision-bridge"
)

$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")

# 1. 校验仓库状态
$status = git status --porcelain
if ($status) { Write-Host "工作树不干净，先提交或 stash：" -ForegroundColor Yellow; $status; exit 1 }
$branch = git branch --show-current
if ($branch -ne "main") { Write-Host "当前分支是 $branch，发布用 main" -ForegroundColor Yellow }

# 2. 关联远程（已存在则更新 URL）
$remote = "https://github.com/$Owner/$Repo.git"
git remote remove origin 2>$null
git remote add origin $remote
Write-Host "remote -> $remote" -ForegroundColor Green

# 3. 推送（会弹出 GitHub 登录：浏览器 / token）
git push -u origin main

# 4. 打 topics（GitHub 网页：仓库 Settings -> General -> Topics，或 gh CLI）
Write-Host ""
Write-Host "发布成功！最后一步：给仓库设置 topics（设置页底部或 gh 命令）：" -ForegroundColor Cyan
Write-Host "  gh repo edit $Owner/$Repo --add-topic dsh-plugin --add-topic deepseek-harness --add-topic vision --add-topic ollama"
Write-Host ""
Write-Host "验证被社群收录（market_search / 市场会自动出现）：" -ForegroundColor Cyan
Write-Host "  https://api.github.com/search/repositories?q=topic:dsh-plugin+$Repo"
