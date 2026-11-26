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

# Built-in Windows OCR (Windows.Media.Ocr). WinRT is initialised only when the
# caller asks for it, so a plain capture pays nothing. Line coordinates are
# image pixels; adding the capture origin makes them screen coordinates that
# can be fed straight to click.
function Invoke-AbbOcrFile {
    param([string]$Path, [string]$Language)

    Add-Type -AssemblyName System.Runtime.WindowsRuntime -ErrorAction Stop
    [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
    [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
    [Windows.Storage.StorageFile, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null

    # PS 5.1 has no await: turn WinRT's IAsyncOperation into a Task
    $asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
            $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
            $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
    function Await($op, $type) {
        $task = $asTask.MakeGenericMethod($type).Invoke($null, @($op))
        $null = $task.Wait(-1)
        return $task.Result
    }

    if ($Language) {
        $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage(
            (New-Object Windows.Globalization.Language $Language))
    }
    else {
        $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
    }
    if (-not $engine) { throw 'ocr_language_unavailable' }

    $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($Path)) ([Windows.Storage.StorageFile])
    $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
    $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
    $result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])

    $lines = @()
    foreach ($line in $result.Lines) {
        $minX = [double]::MaxValue; $minY = [double]::MaxValue
        $maxX = 0.0; $maxY = 0.0
        foreach ($word in $line.Words) {
            $r = $word.BoundingRect
            if ($r.X -lt $minX) { $minX = $r.X }
            if ($r.Y -lt $minY) { $minY = $r.Y }
            if (($r.X + $r.Width) -gt $maxX) { $maxX = $r.X + $r.Width }
            if (($r.Y + $r.Height) -gt $maxY) { $maxY = $r.Y + $r.Height }
        }
        if ($minX -eq [double]::MaxValue) { continue }
        $lines += @{
            text = [string]$line.Text
            x    = [int]$minX
            y    = [int]$minY
            w    = [int]($maxX - $minX)
            h    = [int]($maxY - $minY)
        }
    }
    return @{ language = $engine.RecognizerLanguage.LanguageTag; lines = $lines }
}

function Invoke-AbbScreen {
    param($p)

    $bitmap = $null
    $graphics = $null
    $originX = 0
    $originY = 0
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
            $originX = $rect.Left
            $originY = $rect.Top

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
            $originX = $x
            $originY = $y

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
            origin = @{ x = [int]$originX; y = [int]$originY }
        }
        if ($blank) { $result.blank = $true }

        # Optional OCR: text plus screen coordinates, for UIs without UIA
        if ($p.ocr) {
            $ocr = Invoke-AbbOcrFile -Path $outPath -Language ([string]$p.language)
            $result.ocrLanguage = $ocr.language
            $result.lines = @($ocr.lines | ForEach-Object {
                    @{
                        text = $_.text
                        x    = [int]($_.x + $originX)
                        y    = [int]($_.y + $originY)
                        w    = $_.w
                        h    = $_.h
                    }
                })
            $result.text = (@($ocr.lines | ForEach-Object { $_.text }) -join "`n")
        }

        return $result
    }
    finally {
        if ($bitmap) { $bitmap.Dispose() }
        if ($graphics) { $graphics.Dispose() }
    }
}
