# 移除登录时自动启动桥接服务的计划任务
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\uninstall-autostart.ps1

$taskName = 'AgentBrowserBridge'

try {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction Stop
    Write-Output "已移除计划任务: $taskName"
} catch {
    Write-Output "计划任务 $taskName 不存在，无需卸载。"
}
