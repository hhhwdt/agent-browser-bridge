# 启动 Agent Browser Bridge 桥接服务
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\start-server.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\start-server.ps1 -Port 18778
#
# 服务只监听 127.0.0.1，不对局域网或外网开放。
# 关闭：在本窗口按 Ctrl+C，或结束对应 node 进程。

param(
  [int]$Port = 18777
)

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) {
  Write-Error '未找到 node，请先安装 Node.js 18+ 并加入 PATH'
  exit 1
}

$server = Join-Path $PSScriptRoot 'server.js'
if (-not (Test-Path $server)) {
  Write-Error "未找到 $server"
  exit 1
}

Write-Output "启动桥接服务，端口 $Port ..."
& $node $server --port $Port
