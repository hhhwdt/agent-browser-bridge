# Windows toast notification for the persistent host.
# ASCII only.
#
# Uses the built-in Windows PowerShell AUMID so no app registration is needed.

$script:AbbToastReady = $false

function Invoke-AbbNotify {
    param($p)

    if (-not $script:AbbToastReady) {
        $null = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
        $null = [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]
        $script:AbbToastReady = $true
    }

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
    $appId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell'
    [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show($toast)

    return @{ ok = $true; via = 'toast' }
}
