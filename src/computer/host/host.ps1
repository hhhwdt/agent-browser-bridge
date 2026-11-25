# Agent Browser Bridge - persistent desktop host.
#
# One PowerShell process stays alive and serves many commands over stdin/stdout:
#   request  {"id":1,"fn":"screen","params":{...}}
#   response {"id":1,"ok":true,"data":{...}}
#   error    {"id":1,"ok":false,"error":"window_not_found","detail":"..."}
#
# Why: spawning powershell.exe per action costs ~330ms. Loading the types once
# and looping brings the hot path down to a few milliseconds.
#
# ASCII only: Windows PowerShell 5.1 reads BOM-less files as ANSI.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# UTF-8 both ways, no BOM.
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

# DPI awareness before anything reads screen metrics: on a scaled display an
# unaware process sees a smaller virtual desktop and every coordinate is off.
Add-Type -Namespace AbbHost -Name Native -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
'@
$null = [AbbHost.Native]::SetProcessDPIAware()

# Capability libraries are dot-sourced on first use of the matching fn (see the
# dispatch loop), not at startup. Loading UIA's two assemblies plus Drawing/Forms
# up front costs ~600ms on every host start/restart; per-capability first use is
# a few hundred ms once, and ping stays instant. uia.ps1 needs windows.ps1
# (window resolution, activation, [AbbWin]); input.ps1 also needs windows.ps1
# for the click hit report (Get-AbbWindowInfo, [AbbWin]::GetAncestor).

$script:AbbLoaded = @{}

$script:AbbHandlers = @{
    'screen'  = { param($p) Invoke-AbbScreen $p }
    'windows' = { param($p) Invoke-AbbWindows $p }
    'input'   = { param($p) Invoke-AbbInput $p }
    'clip'    = { param($p) Invoke-AbbClip $p }
    'notify'  = { param($p) Invoke-AbbNotify $p }
    'audio'   = { param($p) Invoke-AbbAudio $p }
    'uia'     = { param($p) Invoke-AbbUia $p }
    'ping'    = { param($p) @{ ok = $true; pong = [DateTime]::UtcNow.ToString('o') } }
}

function Send-AbbLine {
    param($Obj)
    [Console]::Out.WriteLine(($Obj | ConvertTo-Json -Compress -Depth 8))
    [Console]::Out.Flush()
}

# Handshake: the client waits for this before sending the first request.
Send-AbbLine @{ ready = $true; pid = $PID; version = '1' }

while ($true) {
    $line = $null
    try {
        $line = [Console]::In.ReadLine()
    }
    catch {
        break
    }
    # Parent closed the pipe: exit instead of lingering as an orphan.
    if ($null -eq $line) { break }
    if ($line.Trim().Length -eq 0) { continue }

    $id = $null
    try {
        $req = $line | ConvertFrom-Json
        $id = $req.id
        $fn = [string]$req.fn

        # Dot-source at this scope on purpose: inside a function the function
        # definitions would die with that function.
        if (-not $script:AbbLoaded.ContainsKey($fn)) {
            switch ($fn) {
                'screen'  { . (Join-Path $PSScriptRoot 'lib\screen.ps1') }
                'windows' { . (Join-Path $PSScriptRoot 'lib\windows.ps1') }
                'input'   {
                    . (Join-Path $PSScriptRoot 'lib\windows.ps1')
                    . (Join-Path $PSScriptRoot 'lib\input.ps1')
                }
                'clip'    { . (Join-Path $PSScriptRoot 'lib\clip.ps1') }
                'notify'  { . (Join-Path $PSScriptRoot 'lib\notify.ps1') }
                'audio'   { . (Join-Path $PSScriptRoot 'lib\audio.ps1') }
                'uia' {
                    . (Join-Path $PSScriptRoot 'lib\windows.ps1')
                    . (Join-Path $PSScriptRoot 'lib\uia.ps1')
                }
                default { }
            }
            $script:AbbLoaded[$fn] = $true
        }

        $handler = $script:AbbHandlers[$fn]
        if ($null -eq $handler) { throw ('unknown_fn:' + $fn) }

        $params = $req.params
        if ($null -eq $params) { $params = [pscustomobject]@{} }

        $data = & $handler $params
        if ($null -eq $data) { $data = @{ ok = $true } }
        Send-AbbLine @{ id = $id; ok = $true; data = $data }
    }
    catch {
        Send-AbbLine @{
            id     = $id
            ok     = $false
            error  = [string]$_.Exception.Message
            detail = [string]$_.ScriptStackTrace
        }
    }
}
