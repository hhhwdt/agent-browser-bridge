# Keep the Agent Browser Bridge server alive on a fixed port.
#
# Why this exists: restart-server.ps1 starts the server once. A 7x24 unattended
# machine also needs something that notices the process is gone or wedged, and
# starts it again. This loop polls /health and calls restart-server.ps1 after a
# few consecutive failures.
#
# Run it from a scheduled task, a service wrapper, or a terminal that stays open:
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\supervise-server.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\supervise-server.ps1 -IntervalSeconds 15
#
# Parameters:
#   -Port                   port to watch (default 18777)
#   -IntervalSeconds        seconds between health checks (default 30)
#   -FailuresBeforeRestart  consecutive failures before a restart (default 3)
#   -LogFile                defaults to <repo>\logs\supervisor.log
#   -Once                   run one check and exit (0 healthy, 1 not)
#
# ASCII only: Windows PowerShell 5.1 reads BOM-less files as ANSI.

param(
  [int]$Port = 18777,
  [int]$IntervalSeconds = 30,
  [int]$FailuresBeforeRestart = 3,
  [string]$LogFile = '',
  [switch]$Once
)

$ErrorActionPreference = 'Continue'
$repo = Split-Path $PSScriptRoot -Parent
if (-not $LogFile) { $LogFile = Join-Path $repo 'logs\supervisor.log' }
$logDir = Split-Path $LogFile -Parent
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }

function Write-Log([string]$Message) {
  $line = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss') + ' ' + $Message
  Write-Output $line
  try { Add-Content -Path $LogFile -Value $line -Encoding utf8 } catch { }
}

function Test-Health {
  try {
    $r = Invoke-WebRequest -Uri ("http://127.0.0.1:$Port/health") -UseBasicParsing -TimeoutSec 5
    return ($r.StatusCode -eq 200)
  }
  catch {
    return $false
  }
}

$failures = 0
if ($Once) {
  if (Test-Health) {
    Write-Log "health ok port=$Port"
    exit 0
  }
  Write-Log "health failed port=$Port"
  exit 1
}

Write-Log "supervisor start port=$Port interval=${IntervalSeconds}s threshold=$FailuresBeforeRestart"

while ($true) {
  if (Test-Health) {
    if ($failures -gt 0) { Write-Log "health recovered after $failures failure(s)" }
    $failures = 0
  }
  else {
    $failures++
    Write-Log "health check failed ($failures/$FailuresBeforeRestart)"
    if ($failures -ge $FailuresBeforeRestart) {
      Write-Log 'restarting server'
      try {
        & (Join-Path $PSScriptRoot 'restart-server.ps1') -Port $Port 2>&1 |
          ForEach-Object { Write-Log ('restart: ' + $_) }
      }
      catch {
        Write-Log ('restart failed: ' + $_.Exception.Message)
      }
      Start-Sleep -Seconds 3
      if (Test-Health) {
        Write-Log 'restart succeeded'
        $failures = 0
      }
      else {
        Write-Log 'restart did not bring health back'
      }
    }
  }
  Start-Sleep -Seconds $IntervalSeconds
}
