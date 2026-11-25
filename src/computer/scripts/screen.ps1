# Agent Browser Bridge - computer host: screen capture (screen / window / region).
# Parameter file (JSON) is passed as $Args[0]; results are written via Out-File utf8.
# ASCII only: Windows PowerShell 5.1 reads BOM-less files as ANSI.

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$p = Get-Content -Raw -Encoding UTF8 $Args[0] | ConvertFrom-Json

# Any uncaught error is written back as a structured result.
trap {
    $errInfo = @{ ok = $false; error = [string]$_.Exception.Message }
    $errInfo | ConvertTo-Json -Compress | Out-File -FilePath ([string]$p.result) -Encoding utf8
    exit 1
}

$sig = @'
using System;
using System.Runtime.InteropServices;
public static class AbbScreen {
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hwnd, int cmd);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
    public struct RECT { public int Left, Top, Right, Bottom; }
}
'@
$null = Add-Type -TypeDefinition $sig -ErrorAction SilentlyContinue
# Add-Type twice with the same name throws; keep going either way.
$ErrorActionPreference = 'Continue'

# Physical pixels for both modes: window rects and screen rects must share the
# space the mouse coordinates use (see input.ps1).
$null = [AbbScreen]::SetProcessDPIAware()

$bitmap = $null
$graphics = $null
try {
    if ($p.mode -eq 'window') {
        $hwnd = [IntPtr][int64]$p.hwnd
        if ($hwnd -eq [IntPtr]::Zero) { throw 'window_not_found' }
        # PrintWindow misses hardware-accelerated content unless we ask for the full-render variant.
        $rect = New-Object AbbScreen+RECT
        $null = [AbbScreen]::GetWindowRect($hwnd, [ref]$rect)
        $w = $rect.Right - $rect.Left
        $h = $rect.Bottom - $rect.Top
        if ($w -le 0 -or $h -le 0) { throw 'window_has_no_area' }
        if ([AbbScreen]::IsIconic($hwnd)) {
            $null = [AbbScreen]::ShowWindow($hwnd, 9)  # SW_RESTORE, otherwise PrintWindow sees 8x8
            Start-Sleep -Milliseconds 250
            $null = [AbbScreen]::GetWindowRect($hwnd, [ref]$rect)
            $w = $rect.Right - $rect.Left
            $h = $rect.Bottom - $rect.Top
        }
        if ($w -gt 8000 -or $h -gt 8000) { throw 'window_too_large' }
        $bitmap = New-Object System.Drawing.Bitmap $w, $h
        $g = [System.Drawing.Graphics]::FromImage($bitmap)
        $hdc = $g.GetHdc()
        # PW_RENDERFULLCONTENT (2) renders Chromium / DirectComposition windows too.
        $ok = [AbbScreen]::PrintWindow($hwnd, $hdc, 2)
        $g.ReleaseHdc($hdc)
        $g.Dispose()
    }
    else {
        # System.Windows.Forms for the virtual screen across all monitors.
        $null = Add-Type -AssemblyName System.Windows.Forms
        $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
        $x = $vs.Left
        $y = $vs.Top
        $w = $vs.Width
        $h = $vs.Height
        if ($p.region) {
            $x = [Math]::Max($x, [int]$p.region.x)
            $y = [Math]::Max($y, [int]$p.region.y)
            $w = [int]$p.region.w
            $h = [int]$p.region.h
            if ($x + $w -gt $vs.Left + $vs.Width) { $w = $vs.Left + $vs.Width - $x }
            if ($y + $h -gt $vs.Top + $vs.Height) { $h = $vs.Top + $vs.Height - $y }
        }
        if ($w -le 0 -or $h -le 0) { throw 'empty_region' }
        $bitmap = New-Object System.Drawing.Bitmap $w, $h
        $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
        $graphics.CopyFromScreen($x, $y, 0, 0, (New-Object System.Drawing.Size $w, $h))
        $graphics.Dispose()
    }

    $bitmap.Save([string]$p.out, [System.Drawing.Imaging.ImageFormat]::Png)

    $info = @{
        ok      = $true
        width   = $bitmap.Width
        height  = $bitmap.Height
        mode    = [string]$p.mode
        bytes   = (Get-Item -LiteralPath $p.out).Length
    }
    $info | ConvertTo-Json -Compress | Out-File -FilePath ([string]$p.result) -Encoding utf8
}
finally {
    if ($bitmap) { $bitmap.Dispose() }
    if ($graphics) { $graphics.Dispose() }
}
