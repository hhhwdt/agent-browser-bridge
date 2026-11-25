# Agent Browser Bridge - computer host: clipboard read/write (text only).
# Parameter file (JSON) as $Args[0]; results via Out-File utf8. ASCII only.

$ErrorActionPreference = 'Stop'

$p = Get-Content -Raw -Encoding UTF8 $Args[0] | ConvertFrom-Json

# Any uncaught error is written back as a structured result.
trap {
    $errInfo = @{ ok = $false; error = [string]$_.Exception.Message }
    $errInfo | ConvertTo-Json -Compress | Out-File -FilePath ([string]$p.result) -Encoding utf8
    exit 1
}

# get/set is the script vocabulary, read/write is the HTTP one: accept both so a
# caller cannot get it wrong silently.
$op = [string]$p.op
if ($op -eq 'read') { $op = 'get' }
if ($op -eq 'write') { $op = 'set' }

switch ($op) {
    'get' {
        $text = Get-Clipboard -Raw -ErrorAction Stop
        # A very large clipboard would flood the caller; cap to the same budget
        # the server uses elsewhere and tell the caller it was truncated.
        $cap = 200000
        $truncated = $false
        if ($text) {
            if ($text.Length -gt $cap) {
                $text = $text.Substring(0, $cap)
                $truncated = $true
            }
        }
        $out = @{ ok = $true; text = $text; length = if ($text) { $text.Length } else { 0 }; truncated = $truncated }
        $out | ConvertTo-Json -Compress | Out-File -FilePath ([string]$p.result) -Encoding utf8
    }
    'set' {
        $value = [string]$p.text
        if ($value.Length -eq 0) {
            # Set-Clipboard -Value '' throws (ArgumentNullException, parameter "text");
            # clearing through WinForms is the only way to write an empty clipboard.
            Add-Type -AssemblyName System.Windows.Forms
            [System.Windows.Forms.Clipboard]::Clear()
        }
        else {
            Set-Clipboard -Value $value -ErrorAction Stop
        }
        $out = @{ ok = $true }
        $out | ConvertTo-Json -Compress | Out-File -FilePath ([string]$p.result) -Encoding utf8
    }
    default {
        $out = @{ ok = $false; error = 'unknown_op'; op = [string]$p.op }
        $out | ConvertTo-Json -Compress | Out-File -FilePath ([string]$p.result) -Encoding utf8
        exit 1
    }
}
