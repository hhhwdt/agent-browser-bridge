# Agent Browser Bridge - computer host: top-level window enumeration & actions.
# Parameter file (JSON) as $Args[0]; results via Out-File utf8. ASCII only.

$ErrorActionPreference = 'Stop'

$p = Get-Content -Raw -Encoding UTF8 $Args[0] | ConvertFrom-Json

# Any uncaught error is written back as a structured result, so the caller
# sees codes like window_not_found instead of an unreadable crash.
trap {
    $errInfo = @{ ok = $false; error = [string]$_.Exception.Message }
    $errInfo | ConvertTo-Json -Compress | Out-File -FilePath ([string]$p.result) -Encoding utf8
    exit 1
}

$win = @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class AbbWin {
    public delegate bool EnumProc(IntPtr hwnd, IntPtr lparam);

    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lparam);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hwnd, StringBuilder sb, int max);
    [DllImport("user32.dll", SetLastError = true)] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hwnd, int cmd);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hwnd, uint msg, IntPtr wparam, IntPtr lparam);
    [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
    [DllImport("user32.dll")] public static extern IntPtr GetShellWindow();
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();

    public struct RECT { public int Left, Top, Right, Bottom; }
    public const int SW_MINIMIZE = 6, SW_MAXIMIZE = 3, SW_RESTORE = 9;
    public const uint WM_CLOSE = 0x0010;

    // Windows filters out SetForegroundWindow from background processes; the
    // classic workaround taps Alt (without releasing it in our context) so the
    // call is allowed. Harmless: the physical Alt state is restored at once.
    public static bool Activate(IntPtr hwnd) {
        keybd_event(0x12, 0, 0, UIntPtr.Zero);             // ALT down
        var ok = SetForegroundWindow(hwnd);
        keybd_event(0x12, 0, 2, UIntPtr.Zero);             // ALT up (KEYEVENTF_KEYUP)
        return ok;
    }

    public static IntPtr[] Smoke(Func<IntPtr, bool> keep) {
        var found = new List<IntPtr>();
        EnumWindows((h, l) => { try { if (keep(h)) { found.Add(h); } } catch { } return true; }, IntPtr.Zero);
        return found.ToArray();
    }
}
'@

Add-Type -TypeDefinition $win -ErrorAction SilentlyContinue

# Window bounds must be physical pixels, matching screen capture and the mouse
# coordinates; an unaware process gets virtualised rects.
$null = [AbbWin]::SetProcessDPIAware()

$shellHwnd = [AbbWin]::GetShellWindow()

function Info-For([IntPtr]$h) {
    $sb = New-Object System.Text.StringBuilder 512
    $null = [AbbWin]::GetWindowText($h, $sb, 512)
    $title = $sb.ToString()
    $pidv = [uint32]0
    $null = [AbbWin]::GetWindowThreadProcessId($h, [ref]$pidv)
    $rect = New-Object AbbWin+RECT
    $null = [AbbWin]::GetWindowRect($h, [ref]$rect)
    $procName = ''
    if ($pidv -gt 0) {
        try { $procName = (Get-Process -Id $pidv -ErrorAction Stop).ProcessName } catch { }
    }
    @{
        hwnd    = [int64]$h
        title   = $title
        process = $procName
        pid     = [int]$pidv
        bounds  = @{ x = $rect.Left; y = $rect.Top; w = $rect.Right - $rect.Left; h = $rect.Bottom - $rect.Top }
        visible = [bool][AbbWin]::IsWindowVisible($h)
        minimized = [bool][AbbWin]::IsIconic($h)
        maximized = [bool][AbbWin]::IsZoomed($h)
    }
}

function Resolve-Target {
    # Returns one IntPtr or throws when nothing matches. Priority: hwnd, pid, title.
    if ($p.hwnd -and [int64]$p.hwnd -ne 0) {
        return [IntPtr][int64]$p.hwnd
    }
    $targets = [AbbWin]::Smoke({ param($h) [AbbWin]::IsWindowVisible($h) -and $h -ne $shellHwnd })
    if ($targetPid = $p.pid) {
        foreach ($h in $targets) {
            $pidv = [uint32]0
            $null = [AbbWin]::GetWindowThreadProcessId($h, [ref]$pidv)
            if ([int]$pidv -eq [int]$targetPid) { return $h }
        }
        throw 'window_not_found'
    }
    if ($t = $p.title) {
        foreach ($h in $targets) {
            $sb = New-Object System.Text.StringBuilder 512
            $null = [AbbWin]::GetWindowText($h, $sb, 512)
            if ($sb.ToString().ToLower().Contains(([string]$t).ToLower())) { return $h }
        }
        throw 'window_not_found'
    }
    throw 'missing_target'
}

switch ($p.op) {
    'list' {
        $targets = [AbbWin]::Smoke({ param($h) [AbbWin]::IsWindowVisible($h) -and $h -ne $shellHwnd })
        $rows = @(foreach ($h in $targets) { Info-For $h })
        $rows = @($rows | Where-Object { $_.title -ne '' -and $_.bounds.w -gt 0 -and $_.bounds.h -gt 0 })
        $out = @{ ok = $true; windows = $rows }
        $out | ConvertTo-Json -Compress -Depth 4 | Out-File -FilePath ([string]$p.result) -Encoding utf8
    }
    'activate' {
        $h = Resolve-Target
        if ([AbbWin]::IsIconic($h)) { $null = [AbbWin]::ShowWindow($h, [AbbWin]::SW_RESTORE); Start-Sleep -Milliseconds 180 }
        $ok = [AbbWin]::Activate($h)
        $out = @{ ok = $ok; hwnd = [int64]$h }
        $out | ConvertTo-Json -Compress | Out-File -FilePath ([string]$p.result) -Encoding utf8
    }
    'minimize' {
        $h = Resolve-Target
        $ok = [AbbWin]::ShowWindow($h, [AbbWin]::SW_MINIMIZE)
        $out = @{ ok = $ok; hwnd = [int64]$h }
        $out | ConvertTo-Json -Compress | Out-File -FilePath ([string]$p.result) -Encoding utf8
    }
    'maximize' {
        $h = Resolve-Target
        $ok = [AbbWin]::ShowWindow($h, [AbbWin]::SW_MAXIMIZE)
        $out = @{ ok = $ok; hwnd = [int64]$h }
        $out | ConvertTo-Json -Compress | Out-File -FilePath ([string]$p.result) -Encoding utf8
    }
    'close' {
        $h = Resolve-Target
        $sb = New-Object System.Text.StringBuilder 512
        $null = [AbbWin]::GetWindowText($h, $sb, 512)
        $ok = [AbbWin]::PostMessage($h, [AbbWin]::WM_CLOSE, [IntPtr]::Zero, [IntPtr]::Zero)
        $out = @{ ok = [bool]$ok; hwnd = [int64]$h; title = $sb.ToString() }
        $out | ConvertTo-Json -Compress | Out-File -FilePath ([string]$p.result) -Encoding utf8
    }
    'info' {
        $h = Resolve-Target
        $out = Info-For $h
        $out.ok = $true
        $out | ConvertTo-Json -Compress -Depth 4 | Out-File -FilePath ([string]$p.result) -Encoding utf8
    }
}
