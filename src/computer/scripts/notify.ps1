# Agent Browser Bridge - computer host: Windows toast notification.
# Parameter file (JSON) as $Args[0]; results via Out-File utf8. ASCII only.
#
# Uses the built-in Windows PowerShell AUMID so no app registration is needed.
# On Windows 10/11 this pops a normal action-center toast; no third-party module.

$ErrorActionPreference = 'Stop'

$p = Get-Content -Raw -Encoding UTF8 $Args[0] | ConvertFrom-Json

try {
    $null = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
    $null = [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]

    $title = [string]$p.title
    $message = [string]$p.message
    $template = @"
<toast duration="short">
  <visual>
    <binding template="ToastText02">
      <text id="1">$( [System.Security.SecurityElement]::Escape($title) )</text>
      <text id="2">$( [System.Security.SecurityElement]::Escape($message) )</text>
    </binding>
  </visual>
  <audio src="ms-winsoundevent:Notification.Default"/>
</toast>
"@

    $xml = New-Object Windows.Data.Xml.Dom.XmlDocument
    $xml.LoadXml($template)
    $toast = New-Object Windows.UI.Notifications.ToastNotification $xml
    # The AUMID of Windows PowerShell itself: registered by the OS, no setup needed.
    $appId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell'
    [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show($toast)

    $out = @{ ok = $true; via = 'toast' }
    $out | ConvertTo-Json -Compress | Out-File -FilePath ([string]$p.result) -Encoding utf8
}
catch {
    $out = @{ ok = $false; error = 'toast_failed'; detail = $_.Exception.Message }
    $out | ConvertTo-Json -Compress | Out-File -FilePath ([string]$p.result) -Encoding utf8
    exit 1
}
