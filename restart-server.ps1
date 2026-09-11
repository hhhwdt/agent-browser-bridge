# 重启 Agent Browser Bridge 桥接服务
#
# 先停止占用端口的旧实例，再以新进程启动，用于加载 server.js 的改动。
# 只处理监听指定端口的 node 进程，不影响其他 node 程序。
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\restart-server.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\restart-server.ps1 -Port 18778

param(
  [int]$Port = 18777
)

$ErrorActionPreference = 'Continue'

# 停止旧实例
$listeners = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($listeners) {
  foreach ($l in $listeners) {
    $proc = Get-Process -Id $l.OwningProcess -ErrorAction SilentlyContinue
    if ($proc -and $proc.ProcessName -eq 'node') {
      Stop-Process -Id $l.OwningProcess -Force
      Write-Output "已停止旧实例 PID=$($l.OwningProcess)"
    } else {
      Write-Output "警告：端口 $Port 被非 node 进程占用（PID=$($l.OwningProcess)），未做处理"
    }
  }
  Start-Sleep -Seconds 1
} else {
  Write-Output '端口空闲，无需停止'
}

# 启动新实例
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) {
  Write-Error '未找到 node，请先安装 Node.js 18+ 并加入 PATH'
  exit 1
}

$server = Join-Path $PSScriptRoot 'server.js'
$logDir = Join-Path $PSScriptRoot 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$log = Join-Path $logDir 'browser-bridge.log'

Start-Process -FilePath $node `
  -ArgumentList @($server, '--port', "$Port") `
  -RedirectStandardOutput $log `
  -RedirectStandardError "$log.err" `
  -WindowStyle Hidden

# 等待服务就绪
for ($i = 1; $i -le 15; $i++) {
  Start-Sleep -Milliseconds 700
  try {
    $r = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 3
    Write-Output "服务已启动 port=$Port apiVersion=$($r.apiVersion) browsers=$($r.browsers -join ',')"
    Write-Output "日志：$log"
    exit 0
  } catch {
    # 继续等待
  }
}

Write-Output "服务启动后未在预期时间内响应，请检查日志：$log"
exit 2
