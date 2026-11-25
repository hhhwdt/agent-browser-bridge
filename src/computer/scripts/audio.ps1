# Agent Browser Bridge - computer host: master volume (read/set/mute) and
# media transport keys. Parameter file (JSON) as $Args[0]; results via Out-File
# utf8. ASCII only.
#
# Volume goes through IAudioEndpointVolume (zero deps). Interface declarations
# must keep exact vtable order documented in audiopolicy.h / mmdeviceapi.idl.

$ErrorActionPreference = 'Stop'

$p = Get-Content -Raw -Encoding UTF8 $Args[0] | ConvertFrom-Json

# Any uncaught error is written back as a structured result.
trap {
    $errInfo = @{ ok = $false; error = [string]$_.Exception.Message }
    $errInfo | ConvertTo-Json -Compress | Out-File -FilePath ([string]$p.result) -Encoding utf8
    exit 1
}

$audio = @'
using System;
using System.Runtime.InteropServices;

public static class AbbAudio {
    const uint CLSCTX_ALL = 23;

    // --- mmdeviceapi COM surface (vtable order is load-bearing) -----------

    [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IMMDeviceEnumerator {
        [PreserveSig]
        int EnumAudioEndpoints(uint dataFlow, uint stateMask, out IntPtr devices);
        [PreserveSig]
        int GetDefaultAudioEndpoint(uint dataFlow, uint role, out IMMDevice device);
    }

    [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IMMDevice {
        [PreserveSig]
        int Activate(ref Guid iid, uint clsCtx, IntPtr activationParams, out IAudioEndpointVolume endpoint);
    }

    [ComImport, Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IAudioEndpointVolume {
        [PreserveSig]
        int RegisterControlChangeNotify(IntPtr notify);
        [PreserveSig]
        int UnregisterControlChangeNotify(IntPtr notify);
        [PreserveSig]
        int GetChannelCount(out uint count);
        [PreserveSig]
        int SetMasterVolumeLevel(float level, ref Guid context);
        [PreserveSig]
        int SetMasterVolumeLevelScalar(float level, ref Guid context);
        [PreserveSig]
        int GetMasterVolumeLevel(out float level);
        [PreserveSig]
        int GetMasterVolumeLevelScalar(out float level);
        [PreserveSig]
        int SetChannelVolumeLevel(uint channel, float level, ref Guid context);
        [PreserveSig]
        int SetChannelVolumeLevelScalar(uint channel, float level, ref Guid context);
        [PreserveSig]
        int GetChannelVolumeLevel(uint channel, out float level);
        [PreserveSig]
        int GetChannelVolumeLevelScalar(uint channel, out float level);
        [PreserveSig]
        int SetMute(bool mute, ref Guid context);
        [PreserveSig]
        int GetMute(out bool mute);
    }

    static readonly Guid CLSID_MMDeviceEnumerator = new Guid("BCDE0395-E52F-467C-8E3D-C4579291692E");

    const uint eRender = 0, eMultimedia = 1;

    static IAudioEndpointVolume Endpoint() {
        var type = Type.GetTypeFromCLSID(CLSID_MMDeviceEnumerator);
        var enumerator = (IMMDeviceEnumerator)Activator.CreateInstance(type);
        IMMDevice device;
        int hr = enumerator.GetDefaultAudioEndpoint(eRender, eMultimedia, out device);
        if (hr < 0) { throw new ExternalException("GetDefaultAudioEndpoint hr=0x" + hr.ToString("X8")); }
        var iid = new Guid("5CDF2C82-841E-4546-9722-0CF74078229A");
        IAudioEndpointVolume endpoint;
        hr = device.Activate(ref iid, CLSCTX_ALL, IntPtr.Zero, out endpoint);
        if (hr < 0) { throw new ExternalException("IMMDevice.Activate hr=0x" + hr.ToString("X8")); }
        return endpoint;
    }

    // Mutable on purpose: COM setters take it by ref, and a static readonly
    // field cannot be passed as ref (CS0199).
    static Guid Silence = Guid.Empty;

    public static float GetVolume() {
        float v;
        int hr = Endpoint().GetMasterVolumeLevelScalar(out v);
        if (hr < 0) { throw new ExternalException("GetMasterVolumeLevelScalar hr=0x" + hr.ToString("X8")); }
        return v;
    }

    public static bool SetVolume(float scalar) {
        int hr = Endpoint().SetMasterVolumeLevelScalar(scalar, ref Silence);
        return hr >= 0;
    }

    public static bool GetMute() {
        bool m;
        int hr = Endpoint().GetMute(out m);
        if (hr < 0) { throw new ExternalException("GetMute hr=0x" + hr.ToString("X8")); }
        return m;
    }

    public static bool SetMute(bool value) {
        int hr = Endpoint().SetMute(value, ref Silence);
        return hr >= 0;
    }

    // --- media transport via virtual keys ---------------------------------

    [DllImport("user32.dll")]
    public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);

    public static void MediaKey(byte vk) {
        keybd_event(vk, 0, 0, UIntPtr.Zero);
        keybd_event(vk, 0, 2, UIntPtr.Zero);  // KEYUP
    }
}
'@

Add-Type -TypeDefinition $audio -ErrorAction SilentlyContinue

# Virtual key codes (winuser.h)
$vk = @{
    mute  = 0xAD; volup   = 0xAF; voldown = 0xAE
    play  = 0xB3; next    = 0xB0; prev    = 0xB1; stop = 0xB2
}

$mediaOps = @('play', 'pause', 'toggle', 'next', 'prev', 'stop', 'volup', 'voldown', 'mute', 'unmute')
$op = [string]$p.op

if ($mediaOps -contains $op) {
    switch ($op) {
        'play'   { [AbbAudio]::MediaKey([byte]$vk.play) }
        'pause'  { [AbbAudio]::MediaKey([byte]$vk.play) }  # VK_MEDIA_PLAY_PAUSE toggles
        'toggle' { [AbbAudio]::MediaKey([byte]$vk.play) }
        'next'   { [AbbAudio]::MediaKey([byte]$vk.next) }
        'prev'   { [AbbAudio]::MediaKey([byte]$vk.prev) }
        'stop'   { [AbbAudio]::MediaKey([byte]$vk.stop) }
        'volup'  { [AbbAudio]::MediaKey([byte]$vk.volup) }
        'voldown' { [AbbAudio]::MediaKey([byte]$vk.voldown) }
        'mute'   { [AbbAudio]::MediaKey([byte]$vk.mute) }
        'unmute' {
            if ([AbbAudio]::GetMute()) { [AbbAudio]::MediaKey([byte]$vk.mute) }
        }
    }
    # Read back best-effort so the caller learns the current state.
    $out = @{ ok = $true; op = $op }
    try {
        $out.volumePercent = [int][Math]::Round([AbbAudio]::GetVolume() * 100)
        $out.muted = [bool][AbbAudio]::GetMute()
    } catch { }
    $out | ConvertTo-Json -Compress | Out-File -FilePath ([string]$p.result) -Encoding utf8
}
elseif ($op -eq 'get') {
    $out = @{
        ok            = $true
        volumePercent = [int][Math]::Round([AbbAudio]::GetVolume() * 100)
        muted         = [bool][AbbAudio]::GetMute()
    }
    $out | ConvertTo-Json -Compress | Out-File -FilePath ([string]$p.result) -Encoding utf8
}
elseif ($op -eq 'volume') {
    $v = [Math]::Max(0, [Math]::Min(100, [int]$p.volume)) / 100.0
    $null = [AbbAudio]::SetVolume([float]$v)
    $out = @{
        ok            = $true
        volumePercent = [int][Math]::Round([AbbAudio]::GetVolume() * 100)
        muted         = [bool][AbbAudio]::GetMute()
    }
    $out | ConvertTo-Json -Compress | Out-File -FilePath ([string]$p.result) -Encoding utf8
}
else {
    throw 'unknown_op'
}
