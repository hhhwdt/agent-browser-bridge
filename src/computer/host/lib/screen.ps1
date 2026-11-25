# Screen capture for the persistent host: same math as scripts/screen.ps1,
# returns a hashtable instead of writing a result file.
# ASCII only: Windows PowerShell 5.1 reads BOM-less files as ANSI.

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

$script:AbbScreenCs = @'
using System;
using System.Runtime.InteropServices;
public static class AbbScreen {
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hwnd, int cmd);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
    [DllImport("user32.dll")] public static extern IntPtr GetDC(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr hwnd, IntPtr hdc);
    [DllImport("gdi32.dll")] public static extern bool BitBlt(IntPtr dst, int x, int y, int w, int h,
        IntPtr src, int sx, int sy, uint rop);
    public struct RECT { public int Left, Top, Right, Bottom; }
}
'@
$null = Add-Type -TypeDefinition $script:AbbScreenCs -ErrorAction SilentlyContinue

function Invoke-AbbScreen {
    param($p)

    $bitmap = $null
    $graphics = $null
    try {
        if ($p.mode -eq 'window') {
            $hwnd = [IntPtr][int64]$p.hwnd
            if ($hwnd -eq [IntPtr]::Zero) { throw 'window_not_found' }

            # PrintWindow misses hardware-accelerated content unless we ask for
            # the full-render variant.
            $rect = New-Object AbbScreen+RECT
            $null = [AbbScreen]::GetWindowRect($hwnd, [ref]$rect)
            $w = $rect.Right - $rect.Left
            $h = $rect.Bottom - $rect.Top
            if ($w -le 0 -or $h -le 0) { throw 'window_has_no_area' }

            # A minimised window prints as an 8x8 blank frame; restore it first.
            if ([AbbScreen]::IsIconic($hwnd)) {
                $null = [AbbScreen]::ShowWindow($hwnd, 9)  # SW_RESTORE
                Start-Sleep -Milliseconds 250
                $null = [AbbScreen]::GetWindowRect($hwnd, [ref]$rect)
                $w = $rect.Right - $rect.Left
                $h = $rect.Bottom - $rect.Top
            }
            if ($w -gt 8000 -or $h -gt 8000) { throw 'window_too_large' }

            $bitmap = New-Object System.Drawing.Bitmap $w, $h
            $g = [System.Drawing.Graphics]::FromImage($bitmap)
            $hdc = $g.GetHdc()
            # PW_RENDERFULLCONTENT (2) renders Chromium / DirectComposition windows.
            $null = [AbbScreen]::PrintWindow($hwnd, $hdc, 2)
            $g.ReleaseHdc($hdc)
            $g.Dispose()
        }
        else {
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
            # Graphics.CopyFromScreen passes SRCCOPY, which skips WS_EX_LAYERED
            # windows (WeChat 4.x main window, some UWP-ish apps): they are
            # foreground yet vanish from the image. The CopyPixelOperation enum
            # refuses the combined value, so BitBlt directly with
            # SRCCOPY (0x00CC0020) | CAPTUREBLT (0x40000000).
            $dstHdc = $graphics.GetHdc()
            $srcHdc = [AbbScreen]::GetDC([IntPtr]::Zero)
            try {
                $null = [AbbScreen]::BitBlt($dstHdc, 0, 0, $w, $h, $srcHdc, $x, $y, [uint32]1087111200)
            }
            finally {
                $null = [AbbScreen]::ReleaseDC([IntPtr]::Zero, $srcHdc)
                $graphics.ReleaseHdc($dstHdc)
            }
            $graphics.Dispose()
            $graphics = $null
        }

        $outPath = [string]$p.out
        $bitmap.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)

        # Window captures can come back as a single flat color (window not yet
        # rendered / unfocused / content PrintWindow could not get). Sample a
        # grid and flag it so the caller cannot mistake blank output for what
        # the window actually shows. Desktop (CopyFromScreen) skips this.
        $blank = $false
        if ($p.mode -eq 'window') {
            try {
                if ($bitmap.Width -ge 8 -and $bitmap.Height -ge 8) {
                    $grays = New-Object 'System.Collections.Generic.HashSet[int]'
                    $stepX = [Math]::Max(1, [int]($bitmap.Width / 8))
                    $stepY = [Math]::Max(1, [int]($bitmap.Height / 8))
                    for ($sy = $stepY; $sy -lt $bitmap.Height - 1; $sy += $stepY) {
                        for ($sx = $stepX; $sx -lt $bitmap.Width - 1; $sx += $stepX) {
                            $c = $bitmap.GetPixel($sx, $sy)
                            $null = $grays.Add(([int]($c.R -shr 3)) * 64 + ([int]($c.G -shr 3)) * 8 + ([int]($c.B -shr 3)))
                            if ($grays.Count -gt 2) { break }
                        }
                        if ($grays.Count -gt 2) { break }
                    }
                    if ($grays.Count -le 2) { $blank = $true }
                }
            }
            catch { }
        }

        $result = @{
            ok     = $true
            width  = $bitmap.Width
            height = $bitmap.Height
            mode   = [string]$p.mode
            bytes  = (Get-Item -LiteralPath $outPath).Length
            path   = $outPath
        }
        if ($blank) { $result.blank = $true }
        return $result
    }
    finally {
        if ($bitmap) { $bitmap.Dispose() }
        if ($graphics) { $graphics.Dispose() }
    }
}
