# Master volume and media transport keys for the persistent host.
# ASCII only.
#
# Volume goes through IAudioEndpointVolume (zero deps). Interface declarations
# must keep exact vtable order from audiopolicy.h / mmdeviceapi.idl.

$script:AbbAudioCs = @'
using System;
using System.Runtime.InteropServices;

public static class AbbAudio {
    const uint CLSCTX_ALL = 23;

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

    [DllImport("user32.dll")]
    public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);

    public static void MediaKey(byte vk) {
        keybd_event(vk, 0, 0, UIntPtr.Zero);
        keybd_event(vk, 0, 2, UIntPtr.Zero);
    }
}
'@
$null = Add-Type -TypeDefinition $script:AbbAudioCs -ErrorAction SilentlyContinue

# Virtual key codes (winuser.h)
$script:AbbMediaVk = @{
    mute = 0xAD; volup = 0xAF; voldown = 0xAE
    play = 0xB3; next = 0xB0; prev = 0xB1; stop = 0xB2
}

function Get-AbbAudioState {
    return @{
        volumePercent = [int][Math]::Round([AbbAudio]::GetVolume() * 100)
        muted         = [bool][AbbAudio]::GetMute()
    }
}

function Invoke-AbbAudio {
    param($p)

    $op = [string]$p.op
    $mediaOps = @('play', 'pause', 'toggle', 'next', 'prev', 'stop', 'volup', 'voldown', 'mute', 'unmute')

    if ($mediaOps -contains $op) {
        switch ($op) {
            'play'    { [AbbAudio]::MediaKey([byte]$script:AbbMediaVk.play) }
            'pause'   { [AbbAudio]::MediaKey([byte]$script:AbbMediaVk.play) }
            'toggle'  { [AbbAudio]::MediaKey([byte]$script:AbbMediaVk.play) }
            'next'    { [AbbAudio]::MediaKey([byte]$script:AbbMediaVk.next) }
            'prev'    { [AbbAudio]::MediaKey([byte]$script:AbbMediaVk.prev) }
            'stop'    { [AbbAudio]::MediaKey([byte]$script:AbbMediaVk.stop) }
            'volup'   { [AbbAudio]::MediaKey([byte]$script:AbbMediaVk.volup) }
            'voldown' { [AbbAudio]::MediaKey([byte]$script:AbbMediaVk.voldown) }
            'mute'    { [AbbAudio]::MediaKey([byte]$script:AbbMediaVk.mute) }
            'unmute' {
                if ([AbbAudio]::GetMute()) { [AbbAudio]::MediaKey([byte]$script:AbbMediaVk.mute) }
            }
        }
        $out = @{ ok = $true; op = $op }
        try {
            $state = Get-AbbAudioState
            $out.volumePercent = $state.volumePercent
            $out.muted = $state.muted
        }
        catch { }
        return $out
    }

    if ($op -eq 'get') {
        $out = @{ ok = $true }
        $state = Get-AbbAudioState
        $out.volumePercent = $state.volumePercent
        $out.muted = $state.muted
        return $out
    }

    if ($op -eq 'volume') {
        $v = [Math]::Max(0, [Math]::Min(100, [int]$p.volume)) / 100.0
        $null = [AbbAudio]::SetVolume([float]$v)
        $out = @{ ok = $true }
        $state = Get-AbbAudioState
        $out.volumePercent = $state.volumePercent
        $out.muted = $state.muted
        return $out
    }

    throw ('unknown_op:' + $op)
}
