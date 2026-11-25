# Window enumeration and actions for the persistent host.
# ASCII only.

$script:AbbWinCs = @'
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
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hwnd, int cmd);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hwnd, uint msg, IntPtr wparam, IntPtr lparam);
    [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
    [DllImport("user32.dll")] public static extern IntPtr GetShellWindow();

    public struct RECT { public int Left, Top, Right, Bottom; }
    public const int SW_MINIMIZE = 6, SW_MAXIMIZE = 3, SW_RESTORE = 9;
    public const uint WM_CLOSE = 0x0010;

    // Windows filters out SetForegroundWindow from background processes; the
    // classic workaround taps Alt so the call is allowed. The physical Alt state
    // is restored immediately.
    public static bool Activate(IntPtr hwnd) {
        keybd_event(0x12, 0, 0, UIntPtr.Zero);
        var ok = SetForegroundWindow(hwnd);
        keybd_event(0x12, 0, 2, UIntPtr.Zero);
        return ok;
    }

    public static IntPtr[] Smoke(Func<IntPtr, bool> keep) {
        var found = new List<IntPtr>();
        EnumWindows((h, l) => { try { if (keep(h)) { found.Add(h); } } catch { } return true; }, IntPtr.Zero);
        return found.ToArray();
    }
}
'@
$null = Add-Type -TypeDefinition $script:AbbWinCs -ErrorAction SilentlyContinue

$script:AbbShellHwnd = [AbbWin]::GetShellWindow()

# Process-name lookup is the expensive part of a window list: one Get-Process per
# pid, about 10ms each. Cache names per pid for 60s; pids are reused, so no
# permanent cache.
$script:AbbProcCache = @{}
$script:AbbProcCacheTtlSeconds = 60
$script:AbbProcCacheMax = 512

function Get-AbbWindowText {
    param([IntPtr]$h)
    $sb = New-Object System.Text.StringBuilder 512
    $null = [AbbWin]::GetWindowText($h, $sb, 512)
    return $sb.ToString()
}

function Get-AbbWindowInfo {
    param([IntPtr]$h)

    $title = Get-AbbWindowText $h
    $pidv = [uint32]0
    $null = [AbbWin]::GetWindowThreadProcessId($h, [ref]$pidv)

    $procName = ''
    if ($pidv -gt 0) {
        $key = [int]$pidv
        $now = [DateTime]::UtcNow
        $hit = $script:AbbProcCache[$key]
        if ($hit -and ($now - $hit.at).TotalSeconds -lt $script:AbbProcCacheTtlSeconds) {
            $procName = $hit.name
        }
        else {
            try { $procName = (Get-Process -Id $pidv -ErrorAction Stop).ProcessName } catch { }
            if ($script:AbbProcCache.Count -ge $script:AbbProcCacheMax) { $script:AbbProcCache.Clear() }
            $script:AbbProcCache[$key] = @{ name = $procName; at = $now }
        }
    }

    $rect = New-Object AbbWin+RECT
    $null = [AbbWin]::GetWindowRect($h, [ref]$rect)

    return @{
        hwnd      = [int64]$h
        title     = $title
        process   = $procName
        pid       = [int]$pidv
        bounds    = @{ x = $rect.Left; y = $rect.Top; w = $rect.Right - $rect.Left; h = $rect.Bottom - $rect.Top }
        visible   = [bool][AbbWin]::IsWindowVisible($h)
        minimized = [bool][AbbWin]::IsIconic($h)
        maximized = [bool][AbbWin]::IsZoomed($h)
    }
}

function Resolve-AbbWindowTarget {
    param($p)

    if ($p.hwnd -and [int64]$p.hwnd -ne 0) {
        return [IntPtr][int64]$p.hwnd
    }

    $targets = [AbbWin]::Smoke({ param($h) [AbbWin]::IsWindowVisible($h) -and $h -ne $script:AbbShellHwnd })

    if ($targetPid = $p.pid) {
        foreach ($h in $targets) {
            $pidv = [uint32]0
            $null = [AbbWin]::GetWindowThreadProcessId($h, [ref]$pidv)
            if ([int]$pidv -eq [int]$targetPid) { return $h }
        }
        throw 'window_not_found'
    }

    if ($t = $p.title) {
        $want = ([string]$t).ToLower()
        foreach ($h in $targets) {
            if ((Get-AbbWindowText $h).ToLower().Contains($want)) { return $h }
        }
        throw 'window_not_found'
    }

    throw 'missing_target'
}

function Invoke-AbbWindows {
    param($p)

    switch ($p.op) {
        'list' {
            $targets = [AbbWin]::Smoke({ param($h) [AbbWin]::IsWindowVisible($h) -and $h -ne $script:AbbShellHwnd })
            $rows = @()
            foreach ($h in $targets) {
                $row = Get-AbbWindowInfo $h
                if ($row.title -ne '' -and $row.bounds.w -gt 0 -and $row.bounds.h -gt 0) {
                    $rows += $row
                }
            }
            return @{ ok = $true; windows = $rows }
        }
        'activate' {
            $h = Resolve-AbbWindowTarget $p
            if ([AbbWin]::IsIconic($h)) {
                $null = [AbbWin]::ShowWindow($h, [AbbWin]::SW_RESTORE)
                Start-Sleep -Milliseconds 180
            }
            $ok = [AbbWin]::Activate($h)
            Start-Sleep -Milliseconds 60
            # Verify for real: SetForegroundWindow's return value may overstate
            # success, so re-check that the actual foreground window is the
            # target (compare root hwnd so owned windows count as the target).
            $foreground = $false
            try {
                $fg = [AbbWin]::GetForegroundWindow()
                if ($fg -ne [IntPtr]::Zero) {
                    $root = [AbbWin]::GetAncestor($fg, 2)  # GA_ROOT
                    if ($root -eq [IntPtr]::Zero) { $root = $fg }
                    $foreground = $root -eq $h
                }
            }
            catch { }
            return @{ ok = [bool]$ok; foreground = $foreground; hwnd = [int64]$h }
        }
        'minimize' {
            $h = Resolve-AbbWindowTarget $p
            return @{ ok = [bool][AbbWin]::ShowWindow($h, [AbbWin]::SW_MINIMIZE); hwnd = [int64]$h }
        }
        'maximize' {
            $h = Resolve-AbbWindowTarget $p
            return @{ ok = [bool][AbbWin]::ShowWindow($h, [AbbWin]::SW_MAXIMIZE); hwnd = [int64]$h }
        }
        'close' {
            $h = Resolve-AbbWindowTarget $p
            $title = Get-AbbWindowText $h
            $ok = [AbbWin]::PostMessage($h, [AbbWin]::WM_CLOSE, [IntPtr]::Zero, [IntPtr]::Zero)
            return @{ ok = [bool]$ok; hwnd = [int64]$h; title = $title }
        }
        'info' {
            $h = Resolve-AbbWindowTarget $p
            $info = Get-AbbWindowInfo $h
            $info.ok = $true
            return $info
        }
        default { throw ('unknown_op:' + [string]$p.op) }
    }
}
