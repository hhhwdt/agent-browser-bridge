# Mouse and keyboard input for the persistent host.
# ASCII only.

$script:AbbInputCs = @'
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
    [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);

    [StructLayout(LayoutKind.Sequential)]
    public struct POINT { public int X, Y; }

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
        // mods down + every tap pressed/released + mods released
        var list = new INPUT[mods.Length * 2 + taps.Length * 2];
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
$null = Add-Type -TypeDefinition $script:AbbInputCs -ErrorAction SilentlyContinue

Add-Type -AssemblyName System.Windows.Forms

# Absolute coordinates are 0..65535 over the whole virtual desktop. The virtual
# desktop is read per call: display changes (dock, RDP resize) must not leave a
# stale scale factor behind.
function ConvertTo-AbbAbsolute {
    param([double]$x, [double]$y)

    $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
    $scaleX = 65535 / [Math]::Max(1, $vs.Width - 1)
    $scaleY = 65535 / [Math]::Max(1, $vs.Height - 1)
    $ax = [int][Math]::Round(($x - $vs.Left) * $scaleX)
    $ay = [int][Math]::Round(($y - $vs.Top) * $scaleY)
    return , @([Math]::Max(0, [Math]::Min(65535, $ax)), [Math]::Max(0, [Math]::Min(65535, $ay)))
}

# The topmost window a physical click at a screen point would actually land on:
# SendInput follows only the coordinate, so a covered window can never receive
# the click. Report the hit window to the caller so they can verify before
# trusting the click. Requires windows.ps1 (Get-AbbWindowInfo, [AbbWin]).
function Get-AbbInputHit {
    param([double]$x, [double]$y)

    $pt = New-Object AbbInput+POINT
    $pt.X = [int]$x
    $pt.Y = [int]$y
    $h = [AbbInput]::WindowFromPoint($pt)
    if ($h -eq [IntPtr]::Zero) { return $null }
    $root = [AbbWin]::GetAncestor($h, 2)  # GA_ROOT
    if ($root -ne [IntPtr]::Zero) { $h = $root }
    return Get-AbbWindowInfo $h
}

function Invoke-AbbInput {
    param($p)

    switch ($p.op) {
        'move' {
            $a = ConvertTo-AbbAbsolute ([double]$p.x) ([double]$p.y)
            [AbbInput]::MoveAbs($a[0], $a[1])
            return @{ ok = $true; x = [int]$p.x; y = [int]$p.y }
        }
        'click' {
            $a = ConvertTo-AbbAbsolute ([double]$p.x) ([double]$p.y)
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

            # Probe first: which top-level window would this point actually hit.
            $hit = $null
            try { $hit = Get-AbbInputHit ([double]$p.x) ([double]$p.y) } catch { }

            # With ensureForeground the click refuses to fire blind: activate
            # the topmost window under the point first, verify the foreground,
            # and cancel without clicking when that fails. This is what keeps
            # covered windows from eating the click (and the click from
            # landing in whatever happens to be on top).
            if ($p.ensureForeground) {
                if ($null -eq $hit) {
                    return @{ ok = $false; error = 'click_no_target'
                              hint = 'No reachable window at this point; check the coordinates.' }
                }
                $null = [AbbWin]::Activate([IntPtr][int64]$hit.hwnd)
                Start-Sleep -Milliseconds 120
                if ([AbbWin]::GetForegroundWindow() -ne ([IntPtr][int64]$hit.hwnd)) {
                    return @{ ok = $false; error = 'not_foreground'; hitWindow = $hit
                              hint = 'Could not bring the window under the point to the foreground; click was cancelled.' }
                }
            }

            [AbbInput]::ClickAt($a[0], $a[1], [uint32]$down, [uint32]$up, [bool]$p.double)
            $r = @{ ok = $true; x = [int]$p.x; y = [int]$p.y; button = [string]$p.button }
            if ($null -ne $hit) { $r.hitWindow = $hit }
            return $r
        }
        'scroll' {
            if ($null -ne $p.x) {
                $a = ConvertTo-AbbAbsolute ([double]$p.x) ([double]$p.y)
                [AbbInput]::MoveAbs($a[0], $a[1])
                Start-Sleep -Milliseconds 30
            }
            [AbbInput]::Wheel([int]$p.amount)
            return @{ ok = $true; amount = [int]$p.amount }
        }
        'drag' {
            $a1 = ConvertTo-AbbAbsolute ([double]$p.x1) ([double]$p.y1)
            $a2 = ConvertTo-AbbAbsolute ([double]$p.x2) ([double]$p.y2)
            $steps = [Math]::Max(2, [int]$p.steps)
            [AbbInput]::Drag($a1[0], $a1[1], $a2[0], $a2[1], $steps, [int]$p.stepMs)
            return @{ ok = $true; from = @([int]$p.x1, [int]$p.y1); to = @([int]$p.x2, [int]$p.y2) }
        }
        'key' {
            $mods = @(); if ($p.mods) { $mods = @(foreach ($m in @($p.mods)) { [uint16][int]$m }) }
            $taps = @(); if ($p.vks) { $taps = @(foreach ($v in @($p.vks)) { [uint16][int]$v }) }
            [AbbInput]::Combo([uint16[]]$mods, [uint16[]]$taps)
            return @{ ok = $true; keys = $taps.Count }
        }
        'text' {
            $sent = [AbbInput]::TypeText([string]$p.text)
            return @{ ok = $true; chars = $sent }
        }
        default { throw ('unknown_op:' + [string]$p.op) }
    }
}
