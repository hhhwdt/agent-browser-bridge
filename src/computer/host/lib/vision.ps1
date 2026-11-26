# Image matching and before/after comparison for the persistent host.
# ASCII only: Windows PowerShell 5.1 reads BOM-less files as ANSI.
#
# Why this exists: UIA covers structured controls and OCR covers text, but an
# icon or a graphical button has neither. A template cropped once (through
# computer_screen with a region and savePath) can then be located again on the
# same screen, which turns "that little gear icon" into a repeatable click.

Add-Type -AssemblyName System.Drawing

$script:AbbVisionCs = @'
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;

public static class AbbVision {
    static Bitmap Load(string path) {
        using (var src = new Bitmap(path)) {
            var bmp = new Bitmap(src.Width, src.Height, PixelFormat.Format32bppArgb);
            using (var g = Graphics.FromImage(bmp)) { g.DrawImage(src, 0, 0, src.Width, src.Height); }
            return bmp;
        }
    }

    static byte[] Raw(Bitmap bmp, out int w, out int h, out int stride) {
        w = bmp.Width; h = bmp.Height;
        var data = bmp.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
        stride = data.Stride;
        var buf = new byte[stride * h];
        Marshal.Copy(data.Scan0, buf, 0, buf.Length);
        bmp.UnlockBits(data);
        return buf;
    }

    static byte[] Gray(byte[] buf, int w, int h, int stride) {
        var gray = new byte[w * h];
        for (int y = 0; y < h; y++) {
            int row = y * stride;
            for (int x = 0; x < w; x++) {
                int i = row + x * 4;
                gray[y * w + x] = (byte)((buf[i] * 29 + buf[i + 1] * 150 + buf[i + 2] * 77) >> 8);
            }
        }
        return gray;
    }

    // Coarse-to-fine normalised similarity. Returns { x, y, score }.
    public static double[] Match(string screenPath, string templatePath) {
        using (var s = Load(screenPath))
        using (var t = Load(templatePath)) {
            int sw, sh, ss, tw, th, ts;
            byte[] sb = Raw(s, out sw, out sh, out ss);
            byte[] tb = Raw(t, out tw, out th, out ts);
            if (tw >= sw || th >= sh) { return new double[] { -1, -1, 0 }; }

            byte[] sg = Gray(sb, sw, sh, ss);
            byte[] tg = Gray(tb, tw, th, ts);

            int sample = Math.Max(1, Math.Min(tw, th) / 16);
            int step = Math.Max(1, Math.Min(tw, th) / 8);
            int samples = 0;
            for (int ty = 0; ty < th; ty += sample) for (int tx = 0; tx < tw; tx += sample) samples++;

            double best = double.MaxValue;
            int bx = 0, by = 0;
            for (int y = 0; y <= sh - th; y += step) {
                for (int x = 0; x <= sw - tw; x += step) {
                    double sad = 0;
                    for (int ty = 0; ty < th; ty += sample) {
                        int srow = (y + ty) * sw;
                        int trow = ty * tw;
                        for (int tx = 0; tx < tw; tx += sample) {
                            sad += Math.Abs(sg[srow + x + tx] - tg[trow + tx]);
                        }
                    }
                    if (sad < best) { best = sad; bx = x; by = y; }
                }
            }

            int x0 = Math.Max(0, bx - step), x1 = Math.Min(sw - tw, bx + step);
            int y0 = Math.Max(0, by - step), y1 = Math.Min(sh - th, by + step);
            for (int y = y0; y <= y1; y++) {
                for (int x = x0; x <= x1; x++) {
                    double sad = 0;
                    for (int ty = 0; ty < th; ty += sample) {
                        int srow = (y + ty) * sw;
                        int trow = ty * tw;
                        for (int tx = 0; tx < tw; tx += sample) {
                            sad += Math.Abs(sg[srow + x + tx] - tg[trow + tx]);
                        }
                    }
                    if (sad < best) { best = sad; bx = x; by = y; }
                }
            }

            double score = 1.0 - (best / (255.0 * Math.Max(1, samples)));
            return new double[] { bx, by, score };
        }
    }

    // Per-pixel comparison on the colour channels. Returns
    // { minX, minY, w, h, screenW, screenH, sizeMismatch, changedPixels }
    public static double[] Diff(string beforePath, string afterPath, int threshold) {
        using (var a = Load(beforePath))
        using (var b = Load(afterPath)) {
            int aw, ah, as_, bw, bh, bs;
            byte[] ab = Raw(a, out aw, out ah, out as_);
            byte[] bb = Raw(b, out bw, out bh, out bs);
            if (aw != bw || ah != bh) {
                return new double[] { 0, 0, 0, 0, aw, ah, 1, 0 };
            }

            int minX = aw, minY = ah, maxX = -1, maxY = -1;
            long changed = 0;
            for (int y = 0; y < ah; y++) {
                int arow = y * as_, brow = y * bs;
                for (int x = 0; x < aw; x++) {
                    int i = arow + x * 4, j = brow + x * 4;
                    int d = Math.Abs(ab[i] - bb[j]);
                    int dg = Math.Abs(ab[i + 1] - bb[j + 1]);
                    int dr = Math.Abs(ab[i + 2] - bb[j + 2]);
                    if (dg > d) { d = dg; }
                    if (dr > d) { d = dr; }
                    if (d > threshold) {
                        changed++;
                        if (x < minX) { minX = x; }
                        if (y < minY) { minY = y; }
                        if (x > maxX) { maxX = x; }
                        if (y > maxY) { maxY = y; }
                    }
                }
            }
            if (maxX < 0) { return new double[] { 0, 0, 0, 0, aw, ah, 0, 0 }; }
            return new double[] {
                minX, minY, maxX - minX + 1, maxY - minY + 1, aw, ah, 0, changed
            };
        }
    }
}
'@

$null = Add-Type -TypeDefinition $script:AbbVisionCs -ReferencedAssemblies System.Drawing -ErrorAction SilentlyContinue

function Get-AbbImageSize {
    param([string]$Path)
    $img = [System.Drawing.Image]::FromFile($Path)
    try {
        return @{ w = [int]$img.Width; h = [int]$img.Height }
    }
    finally {
        $img.Dispose()
    }
}

function Invoke-AbbVision {
    param($p)

    if (-not $p.op) { throw 'missing_op' }

    if ($p.op -eq 'match') {
        $screen = [string]$p.screen
        $template = [string]$p.template
        if (-not $screen -or -not $template) { throw 'missing_args' }
        if (-not (Test-Path -LiteralPath $screen)) { throw 'screen_not_found' }
        if (-not (Test-Path -LiteralPath $template)) { throw 'template_not_found' }

        $size = Get-AbbImageSize -Path $template
        $r = [AbbVision]::Match($screen, $template)
        $threshold = if ($null -ne $p.threshold) { [double]$p.threshold } else { 0.85 }
        $score = [Math]::Round([double]$r[2], 4)
        if ($r[2] -lt $threshold) {
            return @{ ok = $true; found = $false; score = $score; threshold = $threshold; template = $size }
        }
        return @{
            ok       = $true
            found    = $true
            x        = [int]$r[0]
            y        = [int]$r[1]
            w        = $size.w
            h        = $size.h
            score    = $score
            threshold = $threshold
        }
    }

    if ($p.op -eq 'diff') {
        $before = [string]$p.before
        $after = [string]$p.after
        if (-not $before -or -not $after) { throw 'missing_args' }
        if (-not (Test-Path -LiteralPath $before)) { throw 'before_not_found' }
        if (-not (Test-Path -LiteralPath $after)) { throw 'after_not_found' }

        $threshold = if ($null -ne $p.threshold) { [int]$p.threshold } else { 24 }
        $r = [AbbVision]::Diff($before, $after, $threshold)
        if ($r[6] -eq 1) {
            return @{
                ok           = $true
                sizeMismatch = $true
                before       = @{ w = [int]$r[4]; h = [int]$r[5] }
                note         = 'The two images differ in size; capture the same window or region twice.'
            }
        }
        $changed = [int]$r[7]
        if ($changed -eq 0) {
            return @{ ok = $true; changed = $false; ratio = 0; threshold = $threshold }
        }
        return @{
            ok        = $true
            changed   = $true
            ratio     = [Math]::Round($changed / ([double]$r[4] * [double]$r[5]), 5)
            box       = @{ x = [int]$r[0]; y = [int]$r[1]; w = [int]$r[2]; h = [int]$r[3] }
            width     = [int]$r[4]
            height    = [int]$r[5]
            threshold = $threshold
        }
    }

    throw 'unknown_op'
}
