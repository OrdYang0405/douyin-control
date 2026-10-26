# feishu_login.ps1 — 启动带 DevTools 端口的专用 Chrome profile（飞书文档读取 + 目标系统抓包共用）
#
# 为什么用专用 profile：
#   Chrome 136+ 禁止在默认 profile 上开 --remote-debugging-port（安全限制），
#   因此这里单独开一个 profile 目录，登录一次飞书后 Cookie 长期有效。
#
# 用法：
#   pwsh -File tools/feishu_login.ps1                      # 打开飞书 wiki 页（默认）
#   pwsh -File tools/feishu_login.ps1 -Url "https://TARGET/" # 打开目标系统
#   pwsh -File tools/feishu_login.ps1 -Port 9223
param(
  [string]$Url  = "https://lcnsgu439rca.feishu.cn/wiki/Dhb0wn12XiGY6ekMqzTckYsRnPh",
  [int]   $Port = 9222,
  [string]$ProfileDir = "$env:LOCALAPPDATA\dsh-chrome-re-profile"
)

$chrome = @(
  "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe",
  "C:\Program Files\Google\Chrome\Application\chrome.exe",
  "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
  "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1

if (-not $chrome) { throw "未找到 Chrome / Edge 可执行文件" }
New-Item -ItemType Directory -Force -Path $ProfileDir | Out-Null

# 端口已占用则直接复用
$alive = $false
try { $null = Invoke-RestMethod "http://127.0.0.1:$Port/json/version" -TimeoutSec 2; $alive = $true } catch {}

if (-not $alive) {
  $args = @(
    "--remote-debugging-port=$Port",
    "--user-data-dir=$ProfileDir",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-features=Translate",
    $Url
  )
  Start-Process -FilePath $chrome -ArgumentList $args
  Write-Host "[i] 已启动: $chrome"
  for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 500
    try { $v = Invoke-RestMethod "http://127.0.0.1:$Port/json/version" -TimeoutSec 2; $alive = $true; break } catch {}
  }
} else {
  Write-Host "[i] 复用已运行的 DevTools 端口 $Port"
}

if ($alive) {
  $v = Invoke-RestMethod "http://127.0.0.1:$Port/json/version"
  Write-Host "[✓] DevTools 就绪: $($v.Browser)  ws=$($v.webSocketDebuggerUrl)"
  Write-Host ""
  Write-Host "下一步："
  Write-Host "  1) 在弹出的窗口里登录飞书（扫码/账号），打开目标文档确认能看到正文"
  Write-Host "  2) 抓取文档： node tools/capture.mjs --url `"$Url`" --scroll --wait 12000 --out captures/feishu-wiki"
  Write-Host "  3) 抓取目标系统： node tools/capture.mjs --url `"https://TARGET/`" --out captures/target-home"
} else {
  throw "DevTools 端口未就绪（$Port）"
}
