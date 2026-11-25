# Clipboard read/write for the persistent host (text only).
# ASCII only.

Add-Type -AssemblyName System.Windows.Forms

function Invoke-AbbClip {
    param($p)

    # get/set is the script vocabulary, read/write is the HTTP one.
    $op = [string]$p.op
    if ($op -eq 'read') { $op = 'get' }
    if ($op -eq 'write') { $op = 'set' }

    switch ($op) {
        'get' {
            $text = Get-Clipboard -Raw -ErrorAction Stop
            $cap = 200000
            $truncated = $false
            if ($text -and $text.Length -gt $cap) {
                $text = $text.Substring(0, $cap)
                $truncated = $true
            }
            return @{
                ok        = $true
                text      = $text
                length    = if ($text) { $text.Length } else { 0 }
                truncated = $truncated
            }
        }
        'set' {
            $value = [string]$p.text
            if ($value.Length -eq 0) {
                # Set-Clipboard -Value '' throws (ArgumentNullException, "text");
                # WinForms is the only way to write an empty clipboard here.
                [System.Windows.Forms.Clipboard]::Clear()
            }
            else {
                Set-Clipboard -Value $value -ErrorAction Stop
            }
            return @{ ok = $true }
        }
        default { throw ('unknown_op:' + [string]$p.op) }
    }
}
