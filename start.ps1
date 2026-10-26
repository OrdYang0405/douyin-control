# start.ps1 — 一键启动本地复刻服务（外加可选：拉起改好的采集端）
#
#   pwsh -File start.ps1                 # 只启动服务
#   pwsh -File start.ps1 -Client         # 服务 + 客户端一起起
#   pwsh -File start.ps1 -Port 9000
param(
  [int]$Port = 8080,
  [switch]$Client,
  [switch]$Repack
)

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

# 若环境里带着 ELECTRON_RUN_AS_NODE，Electron 会退化成 node 命令行（客户端一闪而过），必须先清掉
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

if (-not (Test-Path "$PSScriptRoot\server\db.json")) {
  Write-Host "[i] 首次启动，将自动生成 db.json 与测试账号 admin / admin123"
}

if ($Repack -or -not (Test-Path "$PSScriptRoot\build\client\resources\app\platforms.json")) {
  Write-Host "[i] 打包客户端（改回调地址到本地）..."
  node tools/repack_client.mjs --host "http://127.0.0.1:$Port"
}

Write-Host "[i] 启动服务 http://127.0.0.1:$Port"
if ($Client) {
  Start-Process -FilePath "$PSScriptRoot\build\client\星辰弹幕助手.exe"
  Start-Sleep -Milliseconds 800
  Start-Process "http://127.0.0.1:$Port/"
}
$env:PORT = "$Port"
node server/index.mjs
