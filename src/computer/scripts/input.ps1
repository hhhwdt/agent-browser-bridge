# Agent Browser Bridge - computer host: mouse & keyboard input via SendInput.
# Parameter file (JSON) as $Args[0]; results via Out-File utf8. ASCII only.
# Batching lives in the C# helper because PowerShell copies structs on indexing.

$ErrorActionPreference = 'Stop'

$win = @'
using System;
using System.Runtime.InteropServices;

public static class AbbInput {
    [Flags] public enum MOUSEEVENTF : uint {
        MOVE = 1, LEFTDOWN = 2, LEFTUP = 4, RIGHTDOWN = 8, RIGHTUP = 16,
        MIDDLEDOWN = 32, MIDDLEUP = 64, WHEEL = 2048, ABSOLUTE = 32768, VIRTUALDESK = 16384
    }
    [Flags] public enum KEYEVENTF : uint { KEYDOWN = 0, KEYUP = 2, UNICODE = 4 }
    [StructLayout(LayoutKind.Sequential)]
    public struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)]
    public struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Explicit)]
    public struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
    [StructLayout(LayoutKind.Sequential)]
    public struct INPUT { public uint type; public INPUTUNION u; }

    const uint INPUT_MOUSE = 0, INPUT_KEYBOARD = 1;

    [DllImport("user32.dll")] public static extern uint SendInput(uint n, INPUT[] inputs, int size);
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();

    static INPUT MouseInput(int x, int y, uint flags, uint data) {
        var i = new INPUT();
        i.type = INPUT_MOUSE;
        i.u.mi.dx = x;
        i.u.mi.dy = y;
        i.u.mi.mouseData = data;
        i.u.mi.dwFlags = flags;
        return i;
    }

    static INPUT KeyInput(ushort vk, uint flags) {
        var i = new INPUT();
        i.type = INPUT_KEYBOARD;
        i.u.ki.wVk = vk;
        i.u.ki.dwFlags = flags;
        return i;
    }

    static uint Send(INPUT[] full, int n) {
        var slice = new INPUT[n];
        Array.Copy(full, slice, n);
        return SendInput((uint)n, slice, Marshal.SizeOf(typeof(INPUT)));
    }

    public static void MoveAbs(int ax, int ay) {
        var one = new INPUT[1];
        one[0] = MouseInput(ax, ay, (uint)(MOUSEEVENTF.MOVE | MOUSEEVENTF.ABSOLUTE | MOUSEEVENTF.VIRTUALDESK), 0);
        Send(one, 1);
    }

    public static void ClickAt(int ax, int ay, uint downFlag, uint upFlag, bool isDouble) {
        MoveAbs(ax, ay);
        System.Threading.Thread.Sleep(40);
        var down = new INPUT[1];
        down[0] = MouseInput(0, 0, downFlag, 0);
        Send(down, 1);
        System.Threading.Thread.Sleep(25);
        var up = new INPUT[1];
        up[0] = MouseInput(0, 0, upFlag, 0);
        Send(up, 1);
        if (isDouble) {
            System.Threading.Thread.Sleep(90);
            Send(down, 1);
            System.Threading.Thread.Sleep(25);
            Send(up, 1);
        }
    }

    public static void Wheel(int notches) {
        // wheel delta 120 per notch; negative notches become a large uint reinterpreted as negative
        var one = new INPUT[1];
        one[0] = MouseInput(0, 0, (uint)MOUSEEVENTF.WHEEL, unchecked((uint)(notches * 120)));
        Send(one, 1);
    }

    public static void Drag(int ax1, int ay1, int ax2, int ay2, int steps, int stepMs) {
        MoveAbs(ax1, ay1);
        System.Threading.Thread.Sleep(60);
        var d = new INPUT[1];
        d[0] = MouseInput(0, 0, (uint)MOUSEEVENTF.LEFTDOWN, 0);
        Send(d, 1);
        System.Threading.Thread.Sleep(80);
        for (int i = 1; i <= steps; i++) {
            int x = ax1 + (ax2 - ax1) * i / steps;
            int y = ay1 + (ay2 - ay1) * i / steps;
            MoveAbs(x, y);
            System.Threading.Thread.Sleep(stepMs);
        }
        System.Threading.Thread.Sleep(80);
        var u = new INPUT[1];
        u[0] = MouseInput(0, 0, (uint)MOUSEEVENTF.LEFTUP, 0);
        Send(u, 1);
    }

    public static void Combo(ushort[] mods, ushort[] taps) {
        var list = new INPUT[mods.Length + taps.Length * 2];
        int n = 0;
        foreach (var vk in mods) { list[n++] = KeyInput(vk, 0); }
        foreach (var vk in taps) {
            list[n++] = KeyInput(vk, 0);
            list[n++] = KeyInput(vk, (uint)KEYEVENTF.KEYUP);
        }
        foreach (var vk in mods) { list[n++] = KeyInput(vk, (uint)KEYEVENTF.KEYUP); }
        Send(list, n);
    }

    // Unicode injection: types into the focused window without the clipboard.
    public static int TypeText(string text) {
        int sent = 0;
        var list = new INPUT[128];
        int n = 0;
        foreach (char c in text) {
            if (n + 2 > list.Length) { Send(list, n); n = 0; }
            var down = KeyInput(0, (uint)KEYEVENTF.UNICODE);
            down.u.ki.wScan = c;
            list[n++] = down;
            var up = KeyInput(0, (uint)(KEYEVENTF.UNICODE | KEYEVENTF.KEYUP));
            up.u.ki.wScan = c;
            list[n++] = up;
            sent++;
        }
        if (n > 0) { Send(list, n); }
        return sent;
    }
}
'@

Add-Type -TypeDefinition $win -ErrorAction SilentlyContinue

$p = Get-Content -Raw -Encoding UTF8 $Args[0] | ConvertFrom-Json

# Any uncaught error is written back as a structured result, so the caller
# sees codes like window_not_found instead of an unreadable crash.
trap {
    $errInfo = @{ ok = $false; error = [string]$_.Exception.Message }
    $errInfo | ConvertTo-Json -Compress | Out-File -FilePath ([string]$p.result) -Encoding utf8
    exit 1
}

Add-Type -AssemblyName System.Windows.Forms
# DPI awareness first: on a scaled display an unaware process sees a smaller
# virtual desktop and every absolute coordinate would be off by the scale factor.
$null = [AbbInput]::SetProcessDPIAware()
$vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
# Absolute coordinates are 0..65535 over the whole virtual desktop.
$scaleX = 65535 / [Math]::Max(1, $vs.Width - 1)
$scaleY = 65535 / [Math]::Max(1, $vs.Height - 1)
function ToAbs([double]$x, [double]$y) {
    $ax = [int][Math]::Round(($x - $vs.Left) * $scaleX)
    $ay = [int][Math]::Round(($y - $vs.Top) * $scaleY)
    return ,@([Math]::Max(0, [Math]::Min(65535, $ax)), [Math]::Max(0, [Math]::Min(65535, $ay)))
}

switch ($p.op) {
    'move' {
        $a = ToAbs ([double]$p.x) ([double]$p.y)
        [AbbInput]::MoveAbs($a[0], $a[1])
    }
    'click' {
        $a = ToAbs ([double]$p.x) ([double]$p.y)
        $down = [AbbInput+MOUSEEVENTF]::LEFTDOWN
        $up = [AbbInput+MOUSEEVENTF]::LEFTUP
        if ($p.button -eq 'right') {
            $down = [AbbInput+MOUSEEVENTF]::RIGHTDOWN
            $up = [AbbInput+MOUSEEVENTF]::RIGHTUP
        }
        elseif ($p.button -eq 'middle') {
            $down = [AbbInput+MOUSEEVENTF]::MIDDLEDOWN
            $up = [AbbInput+MOUSEEVENTF]::MIDDLEUP
        }
        [AbbInput]::ClickAt($a[0], $a[1], [uint32]$down, [uint32]$up, [bool]$p.double)
    }
    'scroll' {
        if ($null -ne $p.x) {
            $a = ToAbs ([double]$p.x) ([double]$p.y)
            [AbbInput]::MoveAbs($a[0], $a[1])
            Start-Sleep -Milliseconds 30
        }
        [AbbInput]::Wheel([int]$p.amount)
    }
    'drag' {
        $a1 = ToAbs ([double]$p.x1) ([double]$p.y1)
        $a2 = ToAbs ([double]$p.x2) ([double]$p.y2)
        $steps = [Math]::Max(2, [int]$p.steps)
        [AbbInput]::Drag($a1[0], $a1[1], $a2[0], $a2[1], $steps, [int]$p.stepMs)
    }
    'key' {
        $mods = @(); if ($p.mods) { $mods = @(foreach ($m in @($p.mods)) { [uint16][int]$m }) }
        $taps = @(); if ($p.vks) { $taps = @(foreach ($v in @($p.vks)) { [uint16][int]$v }) }
        [AbbInput]::Combo([ushort[]]$mods, [ushort[]]$taps)
    }
    'text' {
        $sent = [AbbInput]::TypeText([string]$p.text)
        $done = @{ ok = $true; chars = $sent }
        $done | ConvertTo-Json -Compress | Out-File -FilePath ([string]$p.result) -Encoding utf8
        return
    }
}

$done = @{ ok = $true }
$done | ConvertTo-Json -Compress | Out-File -FilePath ([string]$p.result) -Encoding utf8
