# 注册登录时自动启动桥接服务的计划任务
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\install-autostart.ps1
#
# 不需要管理员权限（注册当前用户的计划任务）。
# 卸载：运行 .\uninstall-autostart.ps1

$ErrorActionPreference = 'Stop'

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) {
    Write-Error '未找到 node，请先安装 Node.js 18+ 并加入 PATH'
    exit 1
}

$repo = Split-Path $PSScriptRoot -Parent
$server = Join-Path $repo 'src\server.js'
if (-not (Test-Path $server)) {
    Write-Error "未找到 $server"
    exit 1
}

$taskName = 'AgentBrowserBridge'

# 如果已存在，先卸载
try {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction Stop
    Write-Output "已移除旧的计划任务: $taskName"
} catch {
    # 不存在则忽略
}

$action = New-ScheduledTaskAction -Execute $node -Argument $server -WorkingDirectory $repo
$trigger = New-ScheduledTaskTrigger -AtLogOn
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Agent Browser Bridge 桥接服务' | Out-Null

Write-Output "已注册计划任务: $taskName"
Write-Output "登录时将自动启动桥接服务。"
Write-Output "卸载: 运行 .\uninstall-autostart.ps1"
