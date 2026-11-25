# UI Automation for the persistent host: element tree, find, act, wait.
#
# Why UIA: pixel coordinates break when a window moves, a dialog appears, or the
# display scale changes. UIA addresses controls by role/name/id, and invokes them
# through their own patterns instead of moving the mouse.
#
# ASCII only: Windows PowerShell 5.1 reads BOM-less files as ANSI.
#
# Element refs are host-process scoped. A ref that no longer resolves (window
# redrawn, control destroyed, host restarted) answers element_stale; callers
# re-run find or pass a selector alongside the ref.

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$script:AbbUiaRefs = @{}
$script:AbbUiaRefSeq = 0
$script:AbbUiaRefTtlSeconds = 180
$script:AbbUiaRefMax = 5000

function Get-AbbUiaRoot {
    param($p)

    $h = Resolve-AbbWindowTarget $p
    try {
        $root = [System.Windows.Automation.AutomationElement]::FromHandle($h)
    }
    catch {
        throw 'window_not_found'
    }
    if ($null -eq $root) { throw 'window_not_found' }
    return @{ hwnd = $h; root = $root }
}

function Get-AbbUiaProps {
    param($El)

    $r = @{}
    $ct = $El.Current.ControlType
    $r.controlType = ([string]$ct.ProgrammaticName) -replace '^ControlType\.', ''
    $name = [string]$El.Current.Name
    if ($name.Length -gt 200) { $name = $name.Substring(0, 200) }
    $r.name = $name
    $r.automationId = [string]$El.Current.AutomationId
    $r.className = [string]$El.Current.ClassName
    $r.frameworkId = [string]$El.Current.FrameworkId
    $b = $El.Current.BoundingRectangle
    if ($b.IsEmpty) {
        $r.bounds = @{ x = 0; y = 0; w = 0; h = 0 }
    }
    else {
        $r.bounds = @{ x = [int]$b.X; y = [int]$b.Y; w = [int]$b.Width; h = [int]$b.Height }
    }
    $r.enabled = [bool]$El.Current.IsEnabled
    $r.offscreen = [bool]$El.Current.IsOffscreen
    $r.focused = [bool]$El.Current.HasKeyboardFocus
    return $r
}

function Get-AbbUiaPatterns {
    param($El)

    $names = @()
    try {
        foreach ($pat in $El.GetSupportedPatterns()) {
            $names += ([string]$pat.ProgrammaticName) -replace 'PatternIdentifiers\.Pattern$', ''
        }
    }
    catch { }
    return $names
}

function Get-AbbUiaPattern {
    param($El, $Pattern)

    try { return $El.GetCurrentPattern($Pattern) } catch { return $null }
}

function Get-AbbUiaFingerprint {
    param($Props)

    return ([string]$Props.controlType) + '|' + ([string]$Props.automationId) + '|' + ([string]$Props.name)
}

function Resolve-AbbUiaPath {
    param($Entry)

    if (-not $Entry.hwnd -or -not $Entry.path) { return $null }
    try {
        $root = [System.Windows.Automation.AutomationElement]::FromHandle($Entry.hwnd)
    }
    catch { return $null }
    if ($null -eq $root) { return $null }

    $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
    $parts = ([string]$Entry.path).Split('/')
    $el = $root
    for ($i = 1; $i -lt $parts.Length; $i++) {
        $idx = [int]$parts[$i]
        try { $child = $walker.GetFirstChild($el) } catch { return $null }
        $n = 0
        while ($null -ne $child -and $n -lt $idx) {
            try { $child = $walker.GetNextSibling($child) } catch { return $null }
            $n++
        }
        if ($null -eq $child) { return $null }
        $el = $child
    }

    # WPF recreates some peers on layout; the same path can now hold a
    # different control. Only accept it when the fingerprint still matches.
    try { $props = Get-AbbUiaProps $el } catch { return $null }
    $fp = Get-AbbUiaFingerprint $props
    if ($Entry.fp -and $fp -ne $Entry.fp) { return $null }
    return $el
}

function Add-AbbUiaRef {
    param($El, $Hwnd, $Path, $Fp)

    $script:AbbUiaRefSeq++
    $ref = 'e' + $script:AbbUiaRefSeq
    $script:AbbUiaRefs[$ref] = @{
        el   = $El
        at   = [DateTime]::UtcNow
        hwnd = $Hwnd
        path = $Path
        fp   = $Fp
    }
    return $ref
}

function Remove-AbbUiaExpiredRefs {
    $now = [DateTime]::UtcNow
    foreach ($k in @($script:AbbUiaRefs.Keys)) {
        $e = $script:AbbUiaRefs[$k]
        if (($now - $e.at).TotalSeconds -gt $script:AbbUiaRefTtlSeconds) {
            $script:AbbUiaRefs.Remove($k)
        }
    }
    if ($script:AbbUiaRefs.Count -gt $script:AbbUiaRefMax) {
        $script:AbbUiaRefs.Clear()
    }
}

function Get-AbbUiaRefEntry {
    param([string]$Ref)

    $entry = $script:AbbUiaRefs[$Ref]
    if ($null -eq $entry) { throw 'element_stale' }
    if (([DateTime]::UtcNow - $entry.at).TotalSeconds -gt $script:AbbUiaRefTtlSeconds) {
        $script:AbbUiaRefs.Remove($Ref)
        throw 'element_stale'
    }
    try {
        $null = $entry.el.Current.ControlType
    }
    catch {
        $fresh = Resolve-AbbUiaPath $entry
        if ($null -ne $fresh) {
            $entry.el = $fresh
            $entry.at = [DateTime]::UtcNow
            $entry.reResolved = $true
            return $entry
        }
        $script:AbbUiaRefs.Remove($Ref)
        throw 'element_stale'
    }
    return $entry
}

function Get-AbbUiaNodes {
    param(
        $Root,
        $Hwnd,
        [int]$MaxDepth,
        [int]$MaxNodes,
        [int]$MaxResults,
        [bool]$IncludeOffscreen,
        [bool]$WithPatterns,
        $Match
    )

    $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
    $rows = New-Object System.Collections.ArrayList
    $stack = New-Object System.Collections.Stack
    $stack.Push(@{ el = $Root; depth = 0; path = '0' })
    $visited = 0
    $truncated = $false

    while ($stack.Count -gt 0) {
        if ($rows.Count -ge $MaxResults) {
            if ($stack.Count -gt 0) { $truncated = $true }
            break
        }
        if ($visited -ge $MaxNodes) { $truncated = $true; break }

        $item = $stack.Pop()
        $visited++
        $el = $item.el

        # Props may be unreadable (self-drawn UI, permission mismatch). The old
        # code aborted the whole subtree in that case; keep descending so every
        # readable branch still comes back, and only skip the row itself.
        $props = $null
        try { $props = Get-AbbUiaProps $el } catch { }
        $eligible = $false
        if ($null -ne $props) {
            $eligible = $IncludeOffscreen -or (-not $props.offscreen)
        }

        $isMatch = $false
        if ($props -and $eligible) {
            if ($null -eq $Match) { $isMatch = $true }
            else { $isMatch = [bool](& $Match $props $el) }
        }

        if ($isMatch) {
            $fp = Get-AbbUiaFingerprint $props
            $ref = Add-AbbUiaRef $el $Hwnd $item.path $fp
            $row = @{
                ref          = $ref
                depth        = $item.depth
                path         = $item.path
                controlType  = $props.controlType
                name         = $props.name
                automationId = $props.automationId
                className    = $props.className
                frameworkId  = $props.frameworkId
                bounds       = $props.bounds
                enabled      = $props.enabled
                offscreen    = $props.offscreen
                focused      = $props.focused
            }
            if ($WithPatterns) { $row.patterns = @(Get-AbbUiaPatterns $el) }
            $rows.Add($row) | Out-Null
        }

        if ($item.depth -ge $MaxDepth) { continue }

        $kids = New-Object System.Collections.ArrayList
        try {
            $child = $walker.GetFirstChild($el)
            while ($null -ne $child) {
                $kids.Add($child) | Out-Null
                $child = $walker.GetNextSibling($child)
            }
        }
        catch { }

        # Stack is LIFO: push in reverse so the first child is visited first.
        for ($i = $kids.Count - 1; $i -ge 0; $i--) {
            $stack.Push(@{ el = $kids[$i]; depth = $item.depth + 1; path = ($item.path + '/' + $i) })
        }
    }

    return @{ rows = $rows; truncated = $truncated; visited = $visited }
}

function Find-AbbUiaEntry {
    param($p)

    if (-not $p.name -and -not $p.automationId -and -not $p.controlType -and -not $p.className) {
        throw 'missing_filter'
    }
    $rootInfo = Get-AbbUiaRoot $p
    $match = {
        param($props, $el)
        if ($p.controlType -and $props.controlType -ne [string]$p.controlType) { return $false }
        if ($p.automationId -and $props.automationId -ne [string]$p.automationId) { return $false }
        if ($p.className -and -not $props.className.ToLower().Contains(([string]$p.className).ToLower())) { return $false }
        if ($p.name -and [string]$p.name -ne '') {
            $want = ([string]$p.name).ToLower()
            $have = ([string]$props.name).ToLower()
            if ($p.nameExact) {
                if ($have -ne $want) { return $false }
            }
            else {
                if (-not $have.Contains($want)) { return $false }
            }
        }
        return $true
    }

    $depth = 12
    if ($null -ne $p.depth) { $depth = [int]$p.depth }

    $res = Get-AbbUiaNodes -Root $rootInfo.root -Hwnd $rootInfo.hwnd -MaxDepth $depth `
        -MaxNodes 3000 -MaxResults 1 -IncludeOffscreen $true -WithPatterns $false -Match $match
    if ($res.rows.Count -eq 0) { throw 'element_not_found' }

    $row = $res.rows[0]
    return @{
        el    = $script:AbbUiaRefs[$row.ref].el
        ref   = $row.ref
        hwnd  = $rootInfo.hwnd
        props = $row
    }
}

function Invoke-AbbUiaAction {
    param($p)

    $entry = $null
    $reResolved = $false
    if ($p.ref) {
        try {
            $entry = Get-AbbUiaRefEntry ([string]$p.ref)
        }
        catch {
            # A stale ref plus a selector and a window target can be re-resolved;
            # otherwise the caller must run find again.
            $hasSelector = $p.name -or $p.automationId -or $p.controlType -or $p.className
            $hasWindow = $p.hwnd -or $p.pid -or $p.title
            if ($hasSelector -and $hasWindow) {
                $entry = Find-AbbUiaEntry $p
                $reResolved = $true
            }
            else {
                throw
            }
        }
    }
    else {
        $entry = Find-AbbUiaEntry $p
    }

    $el = $entry.el
    $ref = [string]$entry.ref
    if (-not $ref) { $ref = [string]$p.ref }
    $action = [string]$p.action
    if (-not $action) { throw 'missing_action' }

    $patterns = @(Get-AbbUiaPatterns $el)
    $base = @{ ref = $ref; action = $action }
    if ($reResolved -or $entry.reResolved) { $base.reResolved = $true }

    switch ($action) {
        'invoke' {
            $pat = Get-AbbUiaPattern $el ([System.Windows.Automation.InvokePattern]::Pattern)
            if ($null -eq $pat) {
                return @{ ok = $false; error = 'pattern_unavailable'; ref = $ref; action = $action; patterns = $patterns
                    hint = 'Element does not support Invoke; try click (falls back to a coordinate click) or toggle/select.' }
            }
            ([System.Windows.Automation.InvokePattern]$pat).Invoke()
            $base.ok = $true
            return $base
        }
        'toggle' {
            $pat = Get-AbbUiaPattern $el ([System.Windows.Automation.TogglePattern]::Pattern)
            if ($null -eq $pat) {
                return @{ ok = $false; error = 'pattern_unavailable'; ref = $ref; action = $action; patterns = $patterns
                    hint = 'Element does not support Toggle.' }
            }
            $tp = [System.Windows.Automation.TogglePattern]$pat
            $tp.Toggle()
            $base.ok = $true
            try { $base.state = [string]$tp.Current.ToggleState } catch { }
            return $base
        }
        'setValue' {
            if ($null -eq $p.text) {
                return @{ ok = $false; error = 'missing_text'; ref = $ref; action = $action
                    hint = 'setValue needs text.' }
            }
            $pat = Get-AbbUiaPattern $el ([System.Windows.Automation.ValuePattern]::Pattern)
            if ($null -eq $pat) {
                return @{ ok = $false; error = 'pattern_unavailable'; ref = $ref; action = $action; patterns = $patterns
                    hint = 'Element does not support Value; cannot assign text.' }
            }
            ([System.Windows.Automation.ValuePattern]$pat).SetValue([string]$p.text)
            $base.ok = $true
            $base.textChars = ([string]$p.text).Length
            return $base
        }
        'getValue' {
            $pat = Get-AbbUiaPattern $el ([System.Windows.Automation.ValuePattern]::Pattern)
            if ($null -eq $pat) {
                return @{ ok = $false; error = 'pattern_unavailable'; ref = $ref; action = $action; patterns = $patterns
                    hint = 'Element does not support Value; cannot read text.' }
            }
            $value = [string]([System.Windows.Automation.ValuePattern]$pat).Current.Value
            $cut = $false
            if ($value.Length -gt 10000) { $value = $value.Substring(0, 10000); $cut = $true }
            $base.ok = $true
            $base.value = $value
            $base.truncated = $cut
            return $base
        }
        'select' {
            $pat = Get-AbbUiaPattern $el ([System.Windows.Automation.SelectionItemPattern]::Pattern)
            if ($null -eq $pat) {
                return @{ ok = $false; error = 'pattern_unavailable'; ref = $ref; action = $action; patterns = $patterns
                    hint = 'Element does not support SelectionItem.' }
            }
            ([System.Windows.Automation.SelectionItemPattern]$pat).Select()
            $base.ok = $true
            return $base
        }
        'expand' {
            $pat = Get-AbbUiaPattern $el ([System.Windows.Automation.ExpandCollapsePattern]::Pattern)
            if ($null -eq $pat) {
                return @{ ok = $false; error = 'pattern_unavailable'; ref = $ref; action = $action; patterns = $patterns
                    hint = 'Element does not support ExpandCollapse.' }
            }
            ([System.Windows.Automation.ExpandCollapsePattern]$pat).Expand()
            $base.ok = $true
            return $base
        }
        'collapse' {
            $pat = Get-AbbUiaPattern $el ([System.Windows.Automation.ExpandCollapsePattern]::Pattern)
            if ($null -eq $pat) {
                return @{ ok = $false; error = 'pattern_unavailable'; ref = $ref; action = $action; patterns = $patterns
                    hint = 'Element does not support ExpandCollapse.' }
            }
            ([System.Windows.Automation.ExpandCollapsePattern]$pat).Collapse()
            $base.ok = $true
            return $base
        }
        'focus' {
            $el.SetFocus()
            $base.ok = $true
            return $base
        }
        'scrollIntoView' {
            $pat = Get-AbbUiaPattern $el ([System.Windows.Automation.ScrollItemPattern]::Pattern)
            if ($null -eq $pat) {
                return @{ ok = $false; error = 'pattern_unavailable'; ref = $ref; action = $action; patterns = $patterns
                    hint = 'Element does not support ScrollItem.' }
            }
            ([System.Windows.Automation.ScrollItemPattern]$pat).ScrollIntoView()
            $base.ok = $true
            return $base
        }
        'click' {
            $inv = Get-AbbUiaPattern $el ([System.Windows.Automation.InvokePattern]::Pattern)
            if ($null -ne $inv) {
                ([System.Windows.Automation.InvokePattern]$inv).Invoke()
                $base.ok = $true
                $base.method = 'invoke'
                return $base
            }
            $tog = Get-AbbUiaPattern $el ([System.Windows.Automation.TogglePattern]::Pattern)
            if ($null -ne $tog) {
                ([System.Windows.Automation.TogglePattern]$tog).Toggle()
                $base.ok = $true
                $base.method = 'toggle'
                return $base
            }
            $sel = Get-AbbUiaPattern $el ([System.Windows.Automation.SelectionItemPattern]::Pattern)
            if ($null -ne $sel) {
                ([System.Windows.Automation.SelectionItemPattern]$sel).Select()
                $base.ok = $true
                $base.method = 'select'
                return $base
            }

            $b = $el.Current.BoundingRectangle
            if ($b.IsEmpty -or $b.Width -le 0 -or $b.Height -le 0) {
                return @{ ok = $false; error = 'no_click_point'; ref = $ref; action = $action; patterns = $patterns
                    hint = 'Element has no clickable area.' }
            }
            if ($entry.hwnd -and [AbbWin]::IsIconic($entry.hwnd)) {
                $null = [AbbWin]::ShowWindow($entry.hwnd, [AbbWin]::SW_RESTORE)
                Start-Sleep -Milliseconds 180
            }
            if ($entry.hwnd) { $null = [AbbWin]::Activate($entry.hwnd) }
            Start-Sleep -Milliseconds 60
            $cx = $b.X + ($b.Width / 2)
            $cy = $b.Y + ($b.Height / 2)
            $abs = ConvertTo-AbbAbsolute $cx $cy
            [AbbInput]::ClickAt($abs[0], $abs[1],
                [uint32][AbbInput+MOUSEEVENTF]::LEFTDOWN,
                [uint32][AbbInput+MOUSEEVENTF]::LEFTUP, $false)
            $base.ok = $true
            $base.method = 'click'
            $base.x = [int]$cx
            $base.y = [int]$cy
            return $base
        }
        default {
            return @{ ok = $false; error = 'unknown_action'; ref = $ref; action = $action; patterns = $patterns
                hint = 'action is one of invoke/toggle/setValue/getValue/select/expand/collapse/focus/scrollIntoView/click.' }
        }
    }
}

function Invoke-AbbUiaWait {
    param($p)

    $timeout = 10000
    if ($null -ne $p.timeoutMs) { $timeout = [int]$p.timeoutMs }
    if ($timeout -lt 100) { $timeout = 100 }
    if ($timeout -gt 60000) { $timeout = 60000 }

    $interval = 200
    if ($null -ne $p.intervalMs) { $interval = [int]$p.intervalMs }
    if ($interval -lt 50) { $interval = 50 }
    if ($interval -gt 5000) { $interval = 5000 }

    $condition = [string]$p.condition
    if (-not $condition) { $condition = 'exists' }

    $started = [DateTime]::UtcNow
    $deadline = $started.AddMilliseconds($timeout)
    $lastError = $null

    while ($true) {
        $entry = $null
        $found = $false
        try {
            if ($p.ref) {
                try {
                    $entry = Get-AbbUiaRefEntry ([string]$p.ref)
                }
                catch {
                    $hasSelector = $p.name -or $p.automationId -or $p.controlType -or $p.className
                    $hasWindow = $p.hwnd -or $p.pid -or $p.title
                    if ($hasSelector -and $hasWindow) { $entry = Find-AbbUiaEntry $p } else { throw }
                }
                $found = $true
            }
            else {
                $entry = Find-AbbUiaEntry $p
                $found = $true
            }
        }
        catch {
            $found = $false
            $lastError = [string]$_.Exception.Message
        }

        $hit = $false
        if ($condition -eq 'gone') {
            $hit = -not $found
        }
        elseif ($found) {
            if ($condition -eq 'enabled') {
                try { $hit = [bool]$entry.el.Current.IsEnabled } catch { $hit = $false }
            }
            elseif ($condition -eq 'value') {
                $value = $null
                try {
                    $pat = Get-AbbUiaPattern $entry.el ([System.Windows.Automation.ValuePattern]::Pattern)
                    if ($null -ne $pat) { $value = [string]([System.Windows.Automation.ValuePattern]$pat).Current.Value }
                }
                catch { }
                $hit = ($value -eq [string]$p.value)
            }
            else {
                $hit = $true
            }
        }

        if ($hit) {
            $elapsed = [int](([DateTime]::UtcNow - $started).TotalMilliseconds)
            $result = @{ ok = $true; found = $true; condition = $condition; elapsedMs = $elapsed }
            if ($null -ne $entry) {
                $result.ref = [string]$entry.ref
                try { $result.element = Get-AbbUiaProps $entry.el } catch { }
            }
            return $result
        }

        if ([DateTime]::UtcNow -ge $deadline) { break }
        Start-Sleep -Milliseconds $interval
    }

    $ms = [int](([DateTime]::UtcNow - $started).TotalMilliseconds)
    if ($condition -eq 'gone') {
        return @{ ok = $false; error = 'wait_timeout'; found = $true; condition = 'gone'; elapsedMs = $ms
            hint = 'The element did not disappear before the timeout.' }
    }
    return @{ ok = $false; error = 'wait_timeout'; found = $false; condition = $condition; elapsedMs = $ms
        hint = $lastError }
}

function Invoke-AbbUia {
    param($p)

    switch ($p.op) {
        'tree' {
            $rootInfo = Get-AbbUiaRoot $p
            $depth = 6
            if ($null -ne $p.depth) { $depth = [int]$p.depth }
            if ($depth -lt 0) { $depth = 0 }
            if ($depth -gt 12) { $depth = 12 }
            $maxNodes = 400
            if ($null -ne $p.maxNodes) { $maxNodes = [int]$p.maxNodes }
            if ($maxNodes -lt 1) { $maxNodes = 1 }
            if ($maxNodes -gt 2000) { $maxNodes = 2000 }

            $includeOffscreen = $true
            if ($null -ne $p.includeOffscreen) { $includeOffscreen = [bool]$p.includeOffscreen }

            Remove-AbbUiaExpiredRefs
            $res = Get-AbbUiaNodes -Root $rootInfo.root -Hwnd $rootInfo.hwnd -MaxDepth $depth `
                -MaxNodes $maxNodes -MaxResults $maxNodes -IncludeOffscreen $includeOffscreen `
                -WithPatterns ([bool]$p.patterns) -Match $null

            $out = @{
                ok        = $true
                hwnd      = [int64]$rootInfo.hwnd
                title     = Get-AbbWindowText $rootInfo.hwnd
                depth     = $depth
                count     = $res.rows.Count
                visited   = $res.visited
                truncated = $res.truncated
                nodes     = $res.rows
            }

            # Empty tree with machine-readable diagnosis: distinguish a self-
            # drawn UI (root readable, no children) from an unreadable root
            # (permission mismatch / provider not responding).
            if ($res.rows.Count -eq 0) {
                $diag = @{ rootFound = $false }
                try {
                    $rp = Get-AbbUiaProps $rootInfo.root
                    $diag.rootFound = $true
                    $diag.rootControlType = $rp.controlType
                    $diag.rootClassName = $rp.className
                    $diag.rootFramework = $rp.frameworkId
                    $diag.rootOffscreen = $rp.offscreen
                }
                catch { }
                $diag.reason = if ($diag.rootFound) { 'subtree_unreadable_or_self_drawn' } else { 'root_props_unreadable' }
                $out.diagnostics = $diag
            }
            return $out
        }
        'find' {
            if (-not $p.name -and -not $p.automationId -and -not $p.controlType -and -not $p.className) {
                throw 'missing_filter'
            }
            $rootInfo = Get-AbbUiaRoot $p
            $depth = 12
            if ($null -ne $p.depth) { $depth = [int]$p.depth }
            if ($depth -lt 0) { $depth = 0 }
            if ($depth -gt 12) { $depth = 12 }
            $maxResults = 20
            if ($null -ne $p.maxResults) { $maxResults = [int]$p.maxResults }
            if ($maxResults -lt 1) { $maxResults = 1 }
            if ($maxResults -gt 200) { $maxResults = 200 }

            $match = {
                param($props, $el)
                if ($p.controlType -and $props.controlType -ne [string]$p.controlType) { return $false }
                if ($p.automationId -and $props.automationId -ne [string]$p.automationId) { return $false }
                if ($p.className -and -not $props.className.ToLower().Contains(([string]$p.className).ToLower())) { return $false }
                if ($p.name -and [string]$p.name -ne '') {
                    $want = ([string]$p.name).ToLower()
                    $have = ([string]$props.name).ToLower()
                    if ($p.nameExact) {
                        if ($have -ne $want) { return $false }
                    }
                    else {
                        if (-not $have.Contains($want)) { return $false }
                    }
                }
                return $true
            }

            Remove-AbbUiaExpiredRefs
            $res = Get-AbbUiaNodes -Root $rootInfo.root -Hwnd $rootInfo.hwnd -MaxDepth $depth `
                -MaxNodes 3000 -MaxResults $maxResults -IncludeOffscreen ([bool]$p.includeOffscreen) `
                -WithPatterns ([bool]$p.patterns) -Match $match

            return @{
                ok        = $true
                hwnd      = [int64]$rootInfo.hwnd
                title     = Get-AbbWindowText $rootInfo.hwnd
                count     = $res.rows.Count
                visited   = $res.visited
                truncated = $res.truncated
                matches   = $res.rows
            }
        }
        'act' {
            return Invoke-AbbUiaAction $p
        }
        'wait' {
            return Invoke-AbbUiaWait $p
        }
        default { throw ('unknown_op:' + [string]$p.op) }
    }
}
