<#
.SYNOPSIS
  Bridge relay. Notifies the ONE enrolled, existing Claude coordinator session
  when Codex writes the Markdown mailbox, and lists (never sends) the items that need Codex.

.DESCRIPTION
  Inbound (Codex -> Claude):
    - Watches CODEX-QUEUE.md, tasks\*\assignment.md, answers.md and review.md (FileSystemWatcher, a periodic rescan and a
      startup scan). It also watches terminal states in tasks\*\workers\*.run.json. Worker reports and Claude-owned files
      never trigger a dispatch.
    - Debounces write bursts. Every change is keyed by a stable path/task id plus a SHA-256 content revision.
    - Resumes the enrolled session: claude -p <notice> --resume <id> --output-format json ...
      One turn at a time; new revisions queue while busy. Never uses --continue, --fork-session or
      --no-session-persistence, never resumes a session that looks open elsewhere, and never kills a process.
  Return direction (Claude -> Codex): lists unanswered BLOCKING questions and unreviewed IN_REVIEW handoffs in
    .relay\codex-attention.md. CodexWake=NOT_CONFIGURED: nothing here wakes the Codex desktop chat.
  Billing: the existing Claude Code subscription login. No --bare, API-key injection or API
    fallback. Funding overrides are removed only for the child launch, then the original environment is restored.
  State: <MailboxRoot>\.relay\ only, one serialized writer (relay.lock). No secrets and no transcripts are stored.
  Settings: <MailboxRoot>\bin\cost-limits.json and bin\relay-settings.json (projects_dir, owner_name), both optional.
  The mailbox is the folder above bin\, where this script lives, unless -MailboxRoot names another one.
  No installation: no scheduled task, service, registry entry or permanent background process.
  Windows PowerShell 5.1 compatible. ASCII only.

.EXAMPLE
  .\bridge-relay.ps1 -Status
  .\bridge-relay.ps1 -DryRun
  .\bridge-relay.ps1 -Enroll -SessionId 01234567-89ab-4def-8123-456789abcdef
  .\bridge-relay.ps1 -Enroll -SessionId <uuid> -AllowCheck 'php -l','powershell -NoProfile -File C:/Users/ada/checks/lint.ps1'
      (operator only: extra check-command prefixes the coordinator may run, granted as Bash(<prefix>*). Stored in
       .relay\coordinator.json. To change them, exit the coordinator session and run -Enroll again; no other mode
       accepts -AllowCheck. Refused: '*', empty, git/claude/codex/npm/npx/rm/del, pwsh, cmd, powershell without
       -File <script>, node without a script path or with -e/-p.)
  .\bridge-relay.ps1 -ShowCoordinatorArgs   (read-only: prints the coordinator's allowed/denied tools and rules as JSON)
  .\bridge-relay.ps1 -Once
  .\bridge-relay.ps1 -Start        (foreground; stop with -Stop from another window, or Ctrl+C)
  .\bridge-relay.ps1 -Stop
#>
[CmdletBinding()]
param(
    [switch]$Start,
    [switch]$Once,
    [switch]$Status,
    [switch]$Stop,
    [switch]$DryRun,
    [switch]$Enroll,
    [switch]$ClearHalt,
    [switch]$ShowCoordinatorArgs,
    [string]$SessionId,
    [string]$CoordinatorCwd,
    [string]$MailboxRoot,   # default: the folder above bin\, where this script lives
    [switch]$NoWait,
    [ValidateRange(0, 3600)][int]$DebounceSeconds = 20,
    [ValidateRange(1, 3600)][int]$PollSeconds = 10,
    [ValidateRange(0, 86400)][int]$QuietSeconds = 90,
    [ValidateRange(0.05, 5)][double]$TurnBudgetUsd = 1,
    [ValidateRange(0.05, 50)][double]$DailyBudgetUsd = 5,
    [ValidateRange(0, 500)][int]$MaxWakesPerDay = 12, # 0 = unlimited coordinator wakes
    [ValidateRange(1, 20)][int]$MaxFailures = 3,
    [ValidateRange(1, 86400)][int]$BackoffSeconds = 120,
    [ValidateRange(1, 1440)][int]$WaitMinutes = 30,
    [string]$ClaudeExe = (Join-Path $env:APPDATA 'npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe'),
    [string]$KeyFile = (Join-Path $env:USERPROFILE '.claude-coordinator\anthropic-key.dpapi'), # legacy argument; never read
    [string]$ClaudeConfigDir,
    [string]$ProjectsDir,   # default: projects_dir in bin\relay-settings.json
    [string]$Model,
    [string]$Effort,
    [string[]]$AllowCheck
)

$ErrorActionPreference = 'Stop'
$Inv  = [Globalization.CultureInfo]::InvariantCulture
$Utf8 = New-Object System.Text.UTF8Encoding($false)

function Fail([string]$Message, [int]$Code = 2) {
    Write-Host "ERROR: $Message"
    exit $Code
}

# ---------- mode ----------
$modes = @()
if ($Start)     { $modes += 'Start' }
if ($Once)      { $modes += 'Once' }
if ($Status)    { $modes += 'Status' }
if ($Stop)      { $modes += 'Stop' }
if ($DryRun)    { $modes += 'DryRun' }
if ($Enroll)    { $modes += 'Enroll' }
if ($ClearHalt) { $modes += 'ClearHalt' }
if ($ShowCoordinatorArgs) { $modes += 'ShowCoordinatorArgs' }
if ($modes.Count -gt 1) { Fail ('Pick one mode, got: ' + ($modes -join ', ')) 64 }
if ($modes.Count -eq 0) { $modes = @('Status') }
$Mode = $modes[0]
if ($Effort -and @('low', 'medium', 'high', 'xhigh', 'max') -notcontains $Effort) { Fail "-Effort must be low, medium, high, xhigh or max (got '$Effort')" 64 }

# The mailbox is the folder above bin\ unless -MailboxRoot names another one.
if (-not $MailboxRoot) {
    $hereDir = $PSScriptRoot
    if (-not $hereDir) { $hereDir = Split-Path -Parent $MyInvocation.MyCommand.Path }
    $MailboxRoot = Split-Path -Parent $hereDir
}

# Cost-limit switch: <MailboxRoot>\bin\cost-limits.json {"enabled":false}. When disabled, the per-turn
# --max-budget-usd and the daily USD cap are not applied; costs are still recorded. Wake limits are independent:
# "relay_max_wakes_per_day": 0 means unlimited coordinator wakes (MaxWakesPerDay = 0).
$script:CostLimits = $true
$clFile = Join-Path ([IO.Path]::GetFullPath($MailboxRoot).TrimEnd('\')) 'bin\cost-limits.json'
if (Test-Path -LiteralPath $clFile -PathType Leaf) {
    try {
        $cl = Get-Content -LiteralPath $clFile -Raw | ConvertFrom-Json
        if ($null -ne $cl.enabled) { $script:CostLimits = [bool]$cl.enabled }
        if (-not $PSBoundParameters.ContainsKey('MaxWakesPerDay') -and $null -ne $cl.relay_max_wakes_per_day) { $MaxWakesPerDay = [int]$cl.relay_max_wakes_per_day }
    } catch { Write-Host "WARNING: could not read $clFile; cost limits stay ON" }
}

# Local settings: <MailboxRoot>\bin\relay-settings.json. projects_dir is the folder that holds the application
# repositories (the coordinator may read it; -ProjectsDir wins). owner_name is the person the coordinator's notes
# ask for help; without it they ask "the owner" and use the tag NEEDS-OWNER.
$OwnerName = 'the owner'
$OwnerTag = 'NEEDS-OWNER'
$rsFile = Join-Path ([IO.Path]::GetFullPath($MailboxRoot).TrimEnd('\')) 'bin\relay-settings.json'
if (Test-Path -LiteralPath $rsFile -PathType Leaf) {
    try {
        $rs = Get-Content -LiteralPath $rsFile -Raw | ConvertFrom-Json
        if (-not $ProjectsDir -and $rs.projects_dir) { $ProjectsDir = [string]$rs.projects_dir }
        $on = ([string]$rs.owner_name).Trim()
        if ($on -match '^[A-Za-z][A-Za-z .''-]{0,39}$') {
            $OwnerName = $on
            $OwnerTag = 'NEEDS-' + (($on -replace '[^A-Za-z]+', '-').Trim('-').ToUpperInvariant())
        } elseif ($on) { Write-Host "WARNING: owner_name in $rsFile must be 1-40 letters, spaces, dots, apostrophes or hyphens; using 'the owner'" }
    } catch { Write-Host "WARNING: could not read $rsFile; using the defaults" }
}
if ($ProjectsDir) { $ProjectsDir = [IO.Path]::GetFullPath($ProjectsDir).TrimEnd('\') }

function Get-CheckPrefixError([string]$Prefix) {
    # An -AllowCheck entry becomes Bash(<prefix>*) for the unattended coordinator. Returns '' when acceptable.
    # A guard rail, not a sandbox: the operator must enroll prefixes that run one fixed check.
    $p = ([string]$Prefix).Trim()
    if (-not $p) { return 'it is empty' }
    if ($p.Contains('*')) { return "it contains '*' (the relay appends the only wildcard)" }
    if ($p -match '[\x00-\x1f;&|<>()`]|\$\(') { return 'it contains a shell operator, parenthesis, backtick or control character' }
    if ($p.Contains(',')) { return "it contains ',' (powershell -File passes a list as one string; for several checks run -Enroll from a PowerShell prompt with -AllowCheck 'a','b')" }
    if ($p -match '^(git|claude|codex|npm|npx|rm|del)') { return "it starts with '$($Matches[1])', which is never granted to the coordinator" }
    $t = @($p -split '\s+')
    $exe = $t[0]
    if ($p -match '^"([^"]*)"') { $exe = $Matches[1] } elseif ($p -match "^'([^']*)'") { $exe = $Matches[1] }
    $leaf = (($exe -replace '^.*[\\/]', '') -replace '\.(exe|cmd|bat|com|ps1)$', '').ToLowerInvariant()
    if (@('git', 'claude', 'codex', 'npm', 'npx', 'rm', 'del') -contains $leaf) { return "it runs '$leaf', which is never granted to the coordinator" }
    if (@('pwsh', 'cmd') -contains $leaf) { return "'$leaf' is on the coordinator's deny list; enroll powershell -NoProfile -File <script> instead" }
    if ($leaf -eq 'powershell') {
        $i = 1
        while ($i -lt $t.Count -and $t[$i] -match '^-(nop|noprofile|noni|noninteractive|nol|nologo|ex|exec|ep|executionpolicy)$') {
            if ($t[$i] -match '^-(ex|exec|ep|executionpolicy)$') { $i++ }
            $i++
        }
        if (-not ($i + 1 -lt $t.Count -and $t[$i] -match '^-f(i|il|ile)?$' -and $t[$i + 1] -notmatch '^-')) {
            return 'powershell needs -File <script path> (only -NoProfile, -NonInteractive, -NoLogo or -ExecutionPolicy <policy> may come before it)'
        }
    }
    if ($leaf -eq 'node') {
        if (@($t | Where-Object { $_ -match '^(-e|--eval|-p|--print|-i|--interactive|-)$|^--(eval|print)=' }).Count) { return 'node -e/-p/-i or stdin runs code that is not in a file' }
        if (@($t | Select-Object -Skip 1 | Where-Object { $_ -notmatch '^-' }).Count -eq 0) { return 'node needs a script or test path' }
    }
    return ''
}

# -AllowCheck is operator-controlled and accepted only with -Enroll (which needs the coordinator session closed).
# Refused entries save nothing: this runs before the writer lock.
$CheckList = New-Object System.Collections.Generic.List[string]
if ($PSBoundParameters.ContainsKey('AllowCheck')) {
    if ($Mode -ne 'Enroll') { Fail '-AllowCheck is accepted only with -Enroll. To change the allowed checks, exit the coordinator session and enroll again.' 64 }
    foreach ($acEntry in @($AllowCheck)) {
        $acWhy = Get-CheckPrefixError $acEntry
        if ($acWhy) { Fail "-AllowCheck '$acEntry' refused: $acWhy. Nothing was saved." 64 }
        $acTrim = ([string]$acEntry).Trim()
        if (-not $CheckList.Contains($acTrim)) { $CheckList.Add($acTrim) }
    }
}

# ---------- paths (all relay state lives under <MailboxRoot>\.relay) ----------
$Root = [IO.Path]::GetFullPath($MailboxRoot).TrimEnd('\')
if (-not (Test-Path -LiteralPath $Root -PathType Container)) { Fail "MailboxRoot not found: $Root" }
if (-not ((Test-Path -LiteralPath (Join-Path $Root 'CODEX-QUEUE.md')) -or (Test-Path -LiteralPath (Join-Path $Root 'tasks')))) {
    Fail "MailboxRoot does not look like the bridge (no CODEX-QUEUE.md and no tasks folder): $Root. Run the copy in <mailbox>\bin, or pass -MailboxRoot <mailbox folder>."
}
if (-not $ClaudeConfigDir) {
    if ($env:CLAUDE_CONFIG_DIR) { $ClaudeConfigDir = $env:CLAUDE_CONFIG_DIR } else { $ClaudeConfigDir = Join-Path $env:USERPROFILE '.claude' }
}
$RelayDir    = Join-Path $Root '.relay'
$StateFile   = Join-Path $RelayDir 'state.json'
$CoordFile   = Join-Path $RelayDir 'coordinator.json'
$LockFile    = Join-Path $RelayDir 'relay.lock'
$StopFile    = Join-Path $RelayDir 'STOP'
$PauseFile   = Join-Path $RelayDir 'PAUSE'
$LogFile     = Join-Path $RelayDir 'relay.log'
$AlertFile   = Join-Path $RelayDir 'alerts.md'
$LedgerFile  = Join-Path $RelayDir 'dispatches.md'
$AttnFile    = Join-Path $RelayDir 'codex-attention.md'
$DispatchDir = Join-Path $RelayDir 'dispatch'

$script:CanWrite     = $false   # true only while this process holds relay.lock (the single writer)
$script:LockStream   = $null
$script:Procs        = @{}      # dispatch id -> Process started by THIS relay process
$script:LastLaunched = $null

# ---------- small helpers ----------
function Get-Now { return [int64][DateTimeOffset]::UtcNow.ToUnixTimeSeconds() }
function ConvertTo-Unix([datetime]$Value) { return [int64](New-Object DateTimeOffset ($Value.ToUniversalTime())).ToUnixTimeSeconds() }
function Format-Unix($Value) {
    if (-not $Value) { return '-' }
    return [DateTimeOffset]::FromUnixTimeSeconds([int64]$Value).ToLocalTime().ToString('yyyy-MM-dd HH:mm:ss', $Inv)
}
function Get-Short([string]$Text, [int]$Max) {
    if (-not $Text) { return '' }
    $t = ($Text -replace '\s+', ' ').Trim()
    if ($t.Length -gt $Max) { $t = $t.Substring(0, $Max) + '...' }
    return $t
}

function ConvertTo-HT($Object) {
    if ($null -eq $Object) { return $null }
    if ($Object -is [System.Management.Automation.PSCustomObject]) {
        $h = @{}
        foreach ($p in $Object.PSObject.Properties) { $h[$p.Name] = ConvertTo-HT $p.Value }
        return $h
    }
    if (($Object -is [System.Collections.IList]) -and -not ($Object -is [string])) {
        $a = New-Object System.Collections.ArrayList
        foreach ($i in $Object) { [void]$a.Add((ConvertTo-HT $i)) }
        return , $a
    }
    return $Object
}

function Read-SharedText([string]$Path) {
    $share = [IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete
    $fs = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, $share)
    try {
        $sr = New-Object System.IO.StreamReader($fs, $true)
        try { return $sr.ReadToEnd() } finally { $sr.Dispose() }
    } finally { $fs.Dispose() }
}

function Read-TailText([string]$Path, [int]$MaxBytes) {
    $share = [IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete
    $fs = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, $share)
    try {
        $len = $fs.Length
        $from = [Math]::Max([int64]0, $len - $MaxBytes)
        [void]$fs.Seek($from, [IO.SeekOrigin]::Begin)
        $buf = New-Object byte[] ([int]($len - $from))
        $read = 0
        while ($read -lt $buf.Length) {
            $n = $fs.Read($buf, $read, $buf.Length - $read)
            if ($n -le 0) { break }
            $read += $n
        }
        return [Text.Encoding]::UTF8.GetString($buf, 0, $read)
    } finally { $fs.Dispose() }
}

function Get-FileSha256([string]$Path) {
    $fs = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
    try {
        $sha = [Security.Cryptography.SHA256]::Create()
        try { $bytes = $sha.ComputeHash($fs) } finally { $sha.Dispose() }
    } finally { $fs.Dispose() }
    return ([BitConverter]::ToString($bytes) -replace '-', '').ToLowerInvariant()
}

function Get-TextSha256([string]$Text) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $bytes = $sha.ComputeHash($Utf8.GetBytes([string]$Text)) } finally { $sha.Dispose() }
    return ([BitConverter]::ToString($bytes) -replace '-', '').ToLowerInvariant()
}

function Write-Note([string]$Message) {
    Write-Host ('{0}  {1}' -f (Get-Date).ToString('yyyy-MM-dd HH:mm:ss', $Inv), $Message)
}

function Write-Log([string]$Message) {
    $line = '{0}  {1}' -f (Get-Date).ToString('yyyy-MM-dd HH:mm:ss', $Inv), $Message
    Write-Host $line
    if ($script:CanWrite) { [IO.File]::AppendAllText($LogFile, $line + "`r`n", $Utf8) }
}

function Read-Json([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    $t = Read-SharedText $Path
    if (-not $t -or -not $t.Trim()) { return $null }
    return (ConvertTo-HT (ConvertFrom-Json -InputObject $t))
}

function Save-Json([string]$Path, $Object) {
    if (-not $script:CanWrite) { return }
    $json = ConvertTo-Json -InputObject $Object -Depth 12
    $tmp = $Path + '.tmp'
    [IO.File]::WriteAllText($tmp, $json, $Utf8)
    for ($i = 0; $i -lt 30; $i++) {
        try {
            if (Test-Path -LiteralPath $Path) { [IO.File]::Replace($tmp, $Path, [NullString]::Value) } else { [IO.File]::Move($tmp, $Path) }
            return
        } catch { Start-Sleep -Milliseconds 100 }
    }
    throw "Could not replace $Path"
}

# ---------- single writer lock ----------
function Enter-WriterLock([string]$ModeName) {
    if (-not (Test-Path -LiteralPath $RelayDir)) { New-Item -ItemType Directory -Path $RelayDir -Force | Out-Null }
    for ($i = 0; $i -lt 3; $i++) {
        try {
            $fs = [IO.File]::Open($LockFile, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::Read)
            $info = ConvertTo-Json -Compress -InputObject @{ pid = $PID; mode = $ModeName; started = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss', $Inv);
                started_utc = (Get-Now); poll_seconds = $PollSeconds }
            $b = $Utf8.GetBytes($info)
            $fs.SetLength(0)
            $fs.Write($b, 0, $b.Length)
            $fs.Flush()
            $script:LockStream = $fs
            $script:CanWrite = $true
            return $true
        } catch { Start-Sleep -Milliseconds 200 }
    }
    return $false
}

function Exit-WriterLock {
    if ($script:LockStream) { $script:LockStream.Dispose(); $script:LockStream = $null }
    $script:CanWrite = $false
}

function Get-LockInfo {
    $r = @{ held = $false; info = @{} }
    if (-not (Test-Path -LiteralPath $LockFile)) { return $r }
    try {
        $t = [IO.File]::Open($LockFile, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::ReadWrite)
        $t.Dispose()
    } catch { $r.held = $true }
    try {
        $txt = Read-SharedText $LockFile
        if ($txt.Trim()) { $r.info = ConvertTo-HT (ConvertFrom-Json -InputObject $txt) }
    } catch { }
    return $r
}

# ---------- state ----------
function Get-State {
    $s = $null
    try { $s = Read-Json $StateFile } catch { Fail "Relay state is unreadable ($StateFile): $($_.Exception.Message). Not overwriting it; move it aside to start fresh." }
    if (-not $s) { $s = @{} }
    $defaults = @{ version = 1; baseline_utc = 0; seq = 0; files = @{}; workers = @{}; notes = @{}; dispatches = @{}; attention = @{};
        daily = @{ date = ''; wakes = 0; cost = 0.0 }; failures = 0; next_attempt_utc = 0; halt = ''; last_finish_utc = 0; flags = @{} }
    foreach ($k in @($defaults.Keys)) { if (-not $s.ContainsKey($k) -or $null -eq $s[$k]) { $s[$k] = $defaults[$k] } }
    return $s
}

function Save-State([hashtable]$State) {
    $done = @($State.dispatches.Values | Where-Object { $_.state -ne 'running' -and $_.state -ne 'launching' } | Sort-Object { [int64]$_.seq } -Descending)
    if ($done.Count -gt 50) { foreach ($d in $done[50..($done.Count - 1)]) { [void]$State.dispatches.Remove($d.id) } }
    $old = @($State.notes.Values | Where-Object { $_.state -eq 'completed' } | Sort-Object { [int64]$_.detected_utc } -Descending)
    if ($old.Count -gt 200) { foreach ($n in $old[200..($old.Count - 1)]) { [void]$State.notes.Remove($n.id) } }
    Save-Json $StateFile $State
}

function Get-Coordinator {
    $c = $null
    try { $c = Read-Json $CoordFile } catch { $c = $null }
    if ($c -and $c.session_id) { return $c }
    return $null
}

function Update-Daily([hashtable]$State) {
    $today = (Get-Date).ToString('yyyy-MM-dd', $Inv)
    if ($State.daily.date -ne $today) { $State.daily = @{ date = $today; wakes = 0; cost = 0.0 } }
}

function Add-Alert([hashtable]$State, [string]$Flag, [string]$Message) {
    if ($Flag) {
        if ($State.flags.ContainsKey($Flag)) { return }
        $State.flags[$Flag] = Get-Now
    }
    Write-Warning "$($OwnerTag -replace '-', ' '): $Message"
    Write-Log "ALERT: $Message"
    if ($script:CanWrite) {
        if (-not (Test-Path -LiteralPath $AlertFile)) {
            [IO.File]::WriteAllText($AlertFile, "# Relay alerts for $OwnerName (machine-written by bin/bridge-relay.ps1; owner: relay; newest at bottom)`r`n`r`n", $Utf8)
        }
        [IO.File]::AppendAllText($AlertFile, ('- {0} - {1}' -f (Get-Date).ToString('yyyy-MM-dd HH:mm', $Inv), $Message) + "`r`n", $Utf8)
    }
}

# ---------- inbound detection: Codex-owned files ----------
function Update-Inbound([hashtable]$State, [bool]$Baseline) {
    $settling = 0
    $now = Get-Now
    $items = New-Object System.Collections.ArrayList
    $q = Join-Path $Root 'CODEX-QUEUE.md'
    if (Test-Path -LiteralPath $q -PathType Leaf) { [void]$items.Add(@{ key = 'CODEX-QUEUE.md'; task = '(queue)'; path = $q }) }
    $td = Join-Path $Root 'tasks'
    if (Test-Path -LiteralPath $td -PathType Container) {
        foreach ($d in @(Get-ChildItem -LiteralPath $td -Directory -ErrorAction SilentlyContinue)) {
            foreach ($n in @('assignment.md', 'answers.md', 'review.md')) {
                $f = Join-Path $d.FullName $n
                if (Test-Path -LiteralPath $f -PathType Leaf) { [void]$items.Add(@{ key = "tasks/$($d.Name)/$n"; task = $d.Name; path = $f }) }
            }
        }
    }
    foreach ($it in $items) {
        try {
            $fi = Get-Item -LiteralPath $it.path
            if (([DateTime]::UtcNow - $fi.LastWriteTimeUtc).TotalSeconds -lt $DebounceSeconds) { $settling++; continue }
            $h = Get-FileSha256 $it.path
        } catch { $settling++; continue }
        $prev = $State.files[$it.key]
        if ($prev -and $prev.hash -eq $h) { continue }
        $State.files[$it.key] = @{ hash = $h; seen_utc = $now }
        if ($Baseline) { continue }
        Add-CodexNote $State $it $h
    }
    return $settling
}

function Add-CodexNote([hashtable]$State, [hashtable]$Item, [string]$Hash) {
    $rev = $Hash.Substring(0, 12)
    $superseded = ''
    foreach ($n in @($State.notes.Values)) {
        if ($n.key -eq $Item.key -and $n.state -eq 'pending') { [void]$State.notes.Remove($n.id); $superseded = $n.rev }
    }
    $id = "$($Item.key)@$rev"
    if ($State.notes.ContainsKey($id)) { $id = $id + '#' + (Get-Now) }
    $detail = "Codex changed $($Item.key) (rev $rev)"
    $State.notes[$id] = @{ id = $id; key = $Item.key; kind = 'codex-file'; task = $Item.task; rev = $rev; detail = $detail; state = 'pending';
        detected_utc = (Get-Now); dispatch_id = ''; attempts = 0; outcome = ''; accepted_utc = 0; completed_utc = 0 }
    $msg = "Detected: $detail"
    if ($superseded) { $msg += " (replaces the not-yet-sent rev $superseded)" }
    Write-Log $msg
}

# ---------- inbound detection: worker runs that ended ----------
function Update-Workers([hashtable]$State, [bool]$Baseline) {
    $td = Join-Path $Root 'tasks'
    if (-not (Test-Path -LiteralPath $td -PathType Container)) { return }
    foreach ($rf in @(Get-ChildItem -Path (Join-Path $td '*\workers\*.run.json') -File -ErrorAction SilentlyContinue)) {
        $s = $null
        try { $s = ConvertTo-HT (ConvertFrom-Json -InputObject (Read-SharedText $rf.FullName)) } catch { continue }
        if (-not ($s -is [hashtable])) { continue }
        $task = [string]$s['task']
        if (-not $task) { $task = $rf.Directory.Parent.Name }
        $w = [string]$s['worker']
        if (-not $w) { $w = $rf.Name -replace '\.run\.json$', '' }
        $key = "worker:$task/$w"
        $runId = [string]$s['started']
        $prev = $State.workers[$key]
        if ($prev -and $prev.run -eq $runId -and $prev.notified) { continue }
        $st = [string]$s['state']
        $desc = ''
        if ($st -and $st -ne 'running') {
            $desc = "recorded state $st, exit $($s['exit_code']), cost $($s['cost_usd']) USD, finished $($s['finished'])"
        } elseif ($s['pid'] -and -not (Get-Process -Id ([int]$s['pid']) -ErrorAction SilentlyContinue) -and
            ([DateTime]::UtcNow - $rf.LastWriteTimeUtc).TotalSeconds -ge 60) {
            $desc = "recorded state running, but runner pid $($s['pid']) is gone (no terminal state was recorded)"
        }
        if (-not $desc) {
            if (-not $prev -or $prev.run -ne $runId) { $State.workers[$key] = @{ run = $runId; notified = $false } }
            continue
        }
        $State.workers[$key] = @{ run = $runId; notified = $true; state = $st; seen_utc = (Get-Now) }
        if ($Baseline) { continue }
        $id = "$key@" + (Get-TextSha256 $runId).Substring(0, 12)
        $detail = "Worker $w of $task ended: $desc. Read its report and run.json"
        $State.notes[$id] = @{ id = $id; key = $key; kind = 'worker-end'; task = $task; rev = $runId; detail = $detail; state = 'pending';
            detected_utc = (Get-Now); dispatch_id = ''; attempts = 0; outcome = ''; accepted_utc = 0; completed_utc = 0 }
        Write-Log "Detected: $detail"
    }
}

# ---------- return direction: what needs Codex (listed, never sent) ----------
function Get-AttentionItems {
    $list = @{}
    $td = Join-Path $Root 'tasks'
    if (-not (Test-Path -LiteralPath $td -PathType Container)) { return $list }
    foreach ($d in @(Get-ChildItem -LiteralPath $td -Directory -ErrorAction SilentlyContinue)) {
        $task = $d.Name
        try {
            $sf0 = Join-Path $d.FullName 'status.md'
            if ((Test-Path -LiteralPath $sf0 -PathType Leaf) -and
                [regex]::IsMatch((Read-SharedText $sf0), '(?m)^\*\*Current state:\*\*\s*(DONE|CANCELLED)')) { continue }   # closed task: nothing for Codex
            $answered = @{}
            $af = Join-Path $d.FullName 'answers.md'
            if (Test-Path -LiteralPath $af -PathType Leaf) {
                foreach ($m in [regex]::Matches((Read-SharedText $af), '(?m)^#{2,}\s+A(\d+)\b')) { $answered[$m.Groups[1].Value] = $true }
            }
            $qf = Join-Path $d.FullName 'questions.md'
            if (Test-Path -LiteralPath $qf -PathType Leaf) {
                foreach ($m in [regex]::Matches((Read-SharedText $qf), '(?m)^##\s+Q(\d+)\b(.*)$')) {
                    $n = $m.Groups[1].Value
                    if ($m.Groups[2].Value -match '(?<!NON-)\bBLOCKING\b' -and -not $answered.ContainsKey($n)) {
                        $list["$task/Q$n"] = @{ task = $task; what = "BLOCKING question Q$n has no A$n in answers.md" }
                    }
                }
            }
            $sf = Join-Path $d.FullName 'status.md'
            $hf = Join-Path $d.FullName 'handoff.md'
            $rv = Join-Path $d.FullName 'review.md'
            if ((Test-Path -LiteralPath $sf -PathType Leaf) -and (Test-Path -LiteralPath $hf -PathType Leaf)) {
                $sm = [regex]::Match((Read-SharedText $sf), '(?m)^\*\*Current state:\*\*\s*([A-Z_]+)')
                if ($sm.Success -and $sm.Groups[1].Value -eq 'IN_REVIEW') {
                    $hi = Get-Item -LiteralPath $hf
                    $reviewed = (Test-Path -LiteralPath $rv -PathType Leaf) -and ((Get-Item -LiteralPath $rv).LastWriteTimeUtc -gt $hi.LastWriteTimeUtc)
                    if (-not $reviewed) {
                        $rev = (Get-FileSha256 $hf).Substring(0, 12)
                        $list["$task/handoff@$rev"] = @{ task = $task; what = "IN_REVIEW: handoff.md (rev $rev) has no newer review.md" }
                    }
                }
            }
        } catch { }
    }
    return $list
}

function Write-AttentionFile([hashtable]$State) {
    if (-not $script:CanWrite) { return }
    $sb = New-Object System.Text.StringBuilder
    [void]$sb.AppendLine('# Codex attention (machine-generated by bin/bridge-relay.ps1; owner: relay; not a conversation file)')
    [void]$sb.AppendLine('')
    [void]$sb.AppendLine('CodexWake=NOT_CONFIGURED - the relay cannot wake the Codex desktop chat. Codex reads STATUS.md first on its own schedule;')
    [void]$sb.AppendLine('this list is only a hint derived from questions.md, answers.md, status.md, handoff.md and review.md.')
    [void]$sb.AppendLine('')
    [void]$sb.AppendLine('Generated: ' + (Get-Date).ToString('yyyy-MM-dd HH:mm:ss', $Inv))
    [void]$sb.AppendLine('')
    [void]$sb.AppendLine('| Item | Task | What | First seen by relay |')
    [void]$sb.AppendLine('|---|---|---|---|')
    $keys = @($State.attention.Keys | Sort-Object)
    foreach ($k in $keys) {
        $a = $State.attention[$k]
        [void]$sb.AppendLine(('| {0} | {1} | {2} | {3} |' -f $k, $a.task, $a.what, (Format-Unix $a.first_seen_utc)))
    }
    if ($keys.Count -eq 0) { [void]$sb.AppendLine('| (none) | | | |') }
    [IO.File]::WriteAllText($AttnFile, $sb.ToString(), $Utf8)
}

function Update-Attention([hashtable]$State) {
    $cur = Get-AttentionItems
    $changed = $false
    foreach ($k in @($cur.Keys)) {
        if (-not $State.attention.ContainsKey($k)) {
            $State.attention[$k] = @{ task = $cur[$k].task; what = $cur[$k].what; first_seen_utc = (Get-Now) }
            Write-Log "Return direction: NEW for Codex - $($cur[$k].task): $($cur[$k].what) (listed in .relay\codex-attention.md; CodexWake=NOT_CONFIGURED, not delivered)"
            $changed = $true
        }
    }
    foreach ($k in @($State.attention.Keys)) {
        if (-not $cur.ContainsKey($k)) {
            [void]$State.attention.Remove($k)
            Write-Log "Return direction: no longer pending for Codex - $k"
            $changed = $true
        }
    }
    if ($changed -or -not (Test-Path -LiteralPath $AttnFile)) { Write-AttentionFile $State }
}

# ---------- session evidence ----------
function Get-SessionProcesses([string]$Id) {
    # Processes (other than this one) whose command line names the session id, e.g. 'claude --resume <id>'.
    # Returns an array (possibly empty), or $null when the process list cannot be read (treated as busy).
    if ($Id -notmatch '^[0-9a-fA-F-]{36}$') { return , @() }
    try {
        $found = @(Get-CimInstance -ClassName Win32_Process -Filter ("CommandLine LIKE '%" + $Id + "%'") -ErrorAction Stop |
            Where-Object { $_.ProcessId -ne $PID })
        return , $found
    } catch { return $null }
}

function Test-TranscriptMarker([hashtable]$D) {
    # True when the dispatch marker is in the session transcript: the CLI accepted the notification into the session.
    $t = [string]$D.transcript
    if (-not $t -or -not (Test-Path -LiteralPath $t -PathType Leaf)) { return $false }
    try { return ((Read-TailText $t 8388608).IndexOf("[bridge-relay $($D.id)]", [StringComparison]::Ordinal) -ge 0) } catch { return $false }
}

function Test-DispatchAlive([hashtable]$D) {
    if ($script:Procs.ContainsKey($D.id)) { return (-not $script:Procs[$D.id].HasExited) }
    if (-not $D.pid) { return $false }
    $p = Get-Process -Id ([int]$D.pid) -ErrorAction SilentlyContinue
    if (-not $p) { return $false }
    if ($D.proc_start) {
        try { if ([string]$p.StartTime.ToUniversalTime().Ticks -ne [string]$D.proc_start) { return $false } } catch { }
    }
    return $true
}

function Get-BusyReason([hashtable]$State, [hashtable]$Coord) {
    foreach ($d in @($State.dispatches.Values)) {
        if ($d.state -eq 'running' -or $d.state -eq 'launching') { return "relay dispatch $($d.id) is still running (pid $($d.pid))" }
    }
    $procs = Get-SessionProcesses $Coord.session_id
    if ($null -eq $procs) { return 'the process list could not be read to confirm the session is idle' }
    if ($procs.Count -gt 0) { return ('session ' + $Coord.session_id + ' is open in pid ' + (($procs | ForEach-Object { $_.ProcessId }) -join ',')) }
    if ($QuietSeconds -gt 0 -and $Coord.transcript_path -and (Test-Path -LiteralPath $Coord.transcript_path -PathType Leaf)) {
        $tw = ConvertTo-Unix (Get-Item -LiteralPath $Coord.transcript_path).LastWriteTimeUtc
        $now = Get-Now
        if ($tw -gt ($now - $QuietSeconds) -and $tw -gt ([int64]$State.last_finish_utc + 15)) {
            return "the session transcript was written $($now - $tw) s ago by another client (quiet window $QuietSeconds s)"
        }
    }
    return ''
}

# ---------- dispatch ----------
function Get-AllowedChecks($Coord) {
    # Operator-enrolled check prefixes (-Enroll -AllowCheck), re-validated on every read. Never set by the coordinator.
    $out = New-Object System.Collections.Generic.List[string]
    if ($Coord -and $Coord.allowed_checks) {
        foreach ($x in @($Coord.allowed_checks)) {
            $v = ([string]$x).Trim()
            if (-not (Get-CheckPrefixError $v) -and -not $out.Contains($v)) { $out.Add($v) }
        }
    }
    return $out.ToArray()
}

function Get-RelayRules($Coord) {
    $r = $Root -replace '\\', '/'
    $spawn = $r + '/bin/spawn-worker.ps1'
    $checks = @(Get-AllowedChecks $Coord)
    $enrolled = 'none'
    if ($checks.Count) { $enrolled = ($checks | ForEach-Object { "'" + $_ + "'" }) -join ', ' }
    return ("BRIDGE RELAY TURN. bin/bridge-relay.ps1 started this turn automatically ($OwnerName did not type it) to deliver a mailbox notification to you, the existing Claude coordinator. " +
        "The protocol is unchanged: README.md and CLAUDE.md in $Root (read them now if they are not in your context). " +
        'Act only within current authorization. Write only Claude-owned files; never edit Codex-owned files, worker reports or anything under .relay, bin or tests. ' +
        'You can read application repositories but write only Claude-owned files in the mailbox; workers make all code changes. ' +
        "Start workers only with: powershell -NoProfile -ExecutionPolicy Bypass -File $spawn -TaskId <TASK-ID> -Worker W<n> [-Type review] [-MaxBudgetUsd <n>] . " +
        'Workers run detached: do not wait for, poll or interrupt them; the relay notifies you once when a worker ends. ' +
        "Checks you may run yourself: the relay harness, powershell -NoProfile -ExecutionPolicy Bypass -File $r/bin/bridge-relay-check.ps1 (no arguments); node --test <test path>; and these operator-enrolled check prefixes: $enrolled. " +
        "Any other command needs $OwnerName. Never ask for approval mid-turn (nobody can answer; the request is refused) and never work around a refusal (other shells, node -e, a new script, edits under bin, tests or .relay). " +
        "Instead record a $OwnerTag/BLOCKED note naming the exact command and why in the Claude-owned task status, then end the turn. " +
        'No app coding, tracker changes or deployments. GitHub: only when an acknowledged task brief authorizes it, a non-force push of that task''s claude/ branch (git -C <worktree> push -u origin claude/<branch>) and gh draft PR create/edit for it, after your own full-diff review and focused checks (CLAUDE.md rule 12); never merge, mark ready, close, tag or touch other branches. ' +
        'Do not invent tasks or raise budgets. If nothing is actionable, change nothing. End the turn with a one to three sentence summary.')
}

function ConvertTo-RulePath([string]$Path) {
    # Claude Code path-rule form on Windows: C:\work\x -> //c/work/x (two slashes, lowercase drive letter,
    # no colon, forward slashes). The //D:/... form is not matched by the CLI.
    $p = $Path.TrimEnd('\', '/') -replace '\\', '/'
    if ($p -match '^([A-Za-z]):(/.*)?$') { return '//' + $Matches[1].ToLowerInvariant() + $Matches[2] }
    return '//' + $p
}

function Get-CoordinatorTools($Coord) {
    # Command permissions for the unattended (-p, acceptEdits) turn. Anything not listed here is refused, never prompted.
    # git -C <dir> gets exactly the plain-git subcommand list (read-only ones plus worktree add/list), not a blanket allow.
    $ps = 'powershell -NoProfile -ExecutionPolicy Bypass -File '
    $r = $Root -replace '\\', '/'
    $tools = @('Read', "Edit($(ConvertTo-RulePath $Root)/**)", "Write($(ConvertTo-RulePath $Root)/**)", 'Glob', 'Grep',
        'Bash(git status*)', 'Bash(git log*)', 'Bash(git diff*)', 'Bash(git show*)', 'Bash(git rev-parse*)',
        'Bash(git branch --list*)', 'Bash(git ls-tree*)', 'Bash(git grep*)', 'Bash(git cat-file*)',
        'Bash(git worktree add*)', 'Bash(git worktree list*)',
        'Bash(git -C * status*)', 'Bash(git -C * log*)', 'Bash(git -C * diff*)', 'Bash(git -C * show*)', 'Bash(git -C * rev-parse*)',
        'Bash(git -C * branch --list*)', 'Bash(git -C * ls-tree*)', 'Bash(git -C * grep*)', 'Bash(git -C * cat-file*)',
        'Bash(git -C * worktree list*)', 'Bash(git -C * worktree add*)',
        # CLAUDE.md rule 12: one fixed non-force push form for a claude/ task branch, and draft PRs only.
        'Bash(git -C * push -u origin claude/*)',
        'Bash(gh auth status*)', 'Bash(gh pr view*)', 'Bash(gh pr list*)', 'Bash(gh pr diff*)',
        'Bash(gh pr create --draft *)', 'Bash(gh pr edit *)',
        'Bash(node --test *)', 'Bash(ls*)', 'Bash(mkdir*)',
        "Bash($ps$r/bin/spawn-worker.ps1 *)", "Bash($ps$Root\bin\spawn-worker.ps1 *)",
        "Bash($ps$r/bin/bridge-relay-check.ps1*)", "Bash($ps$Root\bin\bridge-relay-check.ps1*)")
    # Application repositories are readable only when a projects folder is set (-ProjectsDir or relay-settings.json).
    if ($ProjectsDir) { $tools += "Read($(ConvertTo-RulePath $ProjectsDir)/**)" }
    foreach ($c in @(Get-AllowedChecks $Coord)) { $tools += "Bash($c*)" }
    return $tools
}

function Get-CoordinatorDeny {
    # The coordinator may not edit relay code, harness, tests or relay state (its own allow-list lives in .relay),
    # may not write scripts into the mailbox (task folders hold Markdown only) and may not pass git configuration options.
    $a = ConvertTo-RulePath $Root
    return @('WebFetch', 'WebSearch',
        "Edit($a/bin/**)", "Write($a/bin/**)", "Edit($a/.relay/**)", "Write($a/.relay/**)", "Edit($a/tests/**)", "Write($a/tests/**)",
        "Edit($a/**/*.js)", "Write($a/**/*.js)", "Edit($a/**/*.mjs)", "Write($a/**/*.mjs)", "Edit($a/**/*.cjs)", "Write($a/**/*.cjs)",
        'Bash(git -c *)', 'Bash(git * -c *)', 'Bash(git * --config-env*)', 'Bash(git * --exec-path*)',
        'Bash(powershell -Command*)', 'Bash(powershell -c *)', 'Bash(pwsh*)', 'Bash(cmd *)', 'Bash(node -e*)', 'Bash(node --eval*)',
        'Bash(git push*)', 'Bash(git merge*)', 'Bash(git rebase*)', 'Bash(git reset*)', 'Bash(git checkout*)', 'Bash(git switch*)',
        'Bash(git commit*)', 'Bash(git tag*)', 'Bash(git stash*)', 'Bash(git config*)', 'Bash(git fetch*)', 'Bash(git pull*)',
        'Bash(git worktree remove*)', 'Bash(git branch -d*)', 'Bash(git branch -D*)',
        # The only allowed push is 'git -C <dir> push -u origin claude/<branch>'; these deny everything riskier.
        'Bash(git -C * push * --force*)', 'Bash(git -C * push * -f*)', 'Bash(git -C * push * --force-with-lease*)',
        'Bash(git -C * push * +*)', 'Bash(git -C * push * *:*)', 'Bash(git -C * push * --delete*)', 'Bash(git -C * push * -d *)',
        'Bash(git -C * push * --tags*)', 'Bash(git -C * push * --mirror*)', 'Bash(git -C * push * --all*)',
        'Bash(git -C * push -u origin claude/* *)',
        'Bash(gh pr merge*)', 'Bash(gh pr ready*)', 'Bash(gh pr close*)', 'Bash(gh pr reopen*)', 'Bash(gh pr review*)',
        'Bash(gh api*)', 'Bash(gh repo*)', 'Bash(gh release*)', 'Bash(gh secret*)', 'Bash(gh variable*)',
        'Bash(gh workflow*)', 'Bash(gh run*)', 'Bash(gh auth login*)', 'Bash(gh auth logout*)', 'Bash(gh auth token*)',
        'Bash(gh auth refresh*)', 'Bash(gh config*)', 'Bash(gh alias*)', 'Bash(gh extension*)',
        'Bash(git -C * merge*)', 'Bash(git -C * rebase*)', 'Bash(git -C * reset*)', 'Bash(git -C * checkout*)',
        'Bash(git -C * switch*)', 'Bash(git -C * commit*)', 'Bash(git -C * tag*)', 'Bash(git -C * stash*)', 'Bash(git -C * config*)',
        'Bash(git -C * fetch*)', 'Bash(git -C * pull*)', 'Bash(git -C * worktree remove*)', 'Bash(git -C * branch -d*)', 'Bash(git -C * branch -D*)',
        'Bash(claude*)', 'Bash(codex*)', 'Bash(npm *)', 'Bash(npx *)', 'Bash(rm *)')
}

function New-Prompt([string]$Id, [object[]]$Batch) {
    $parts = New-Object System.Collections.Generic.List[string]
    $i = 0
    foreach ($n in $Batch) { $i++; $parts.Add(('{0}) {1}' -f $i, $n.detail)) }
    $p = "[bridge-relay $Id] Mailbox notification for the Claude coordinator ($i item(s)): " + ($parts -join '; ') +
        ". Read CODEX-QUEUE.md and the named files, then continue under the README.md and CLAUDE.md protocol in $Root."
    return (($p -replace '[\r\n]+', ' ') -replace '"', "'")
}

function ConvertTo-ArgToken([string]$A) {
    if ($A -eq '') { return '""' }
    if ($A -notmatch '[\s"]') { return $A }
    $q = $A -replace '(\\*)"', '$1$1\"'
    $q = $q -replace '(\\+)$', '$1$1'
    return '"' + $q + '"'
}

function Get-CoordinatorAddDirs($Coord) {
    # Extra writable directories (--add-dir) for the turn: only the mailbox root, and only when the session's cwd is
    # elsewhere. Application repositories are reached read-only through the Read(...) rule in Get-CoordinatorTools.
    if ([string]$Coord.cwd -ne $Root) { return @($Root) }
    return @()
}

function Get-CliArguments([hashtable]$Coord, [string]$Prompt) {
    $a = New-Object System.Collections.Generic.List[string]
    foreach ($x in @('-p', $Prompt, '--resume', [string]$Coord.session_id, '--output-format', 'json',
            '--setting-sources', '', '--strict-mcp-config', '--disable-slash-commands', '--tools', 'Read,Edit,Write,Glob,Grep,Bash',
            '--permission-mode', 'acceptEdits', '--append-system-prompt', (Get-RelayRules $Coord))) { $a.Add([string]$x) }
    if ($script:CostLimits) { $a.Add('--max-budget-usd'); $a.Add($TurnBudgetUsd.ToString($Inv)) }
    foreach ($d in @(Get-CoordinatorAddDirs $Coord)) { $a.Add('--add-dir'); $a.Add([string]$d) }
    if ($Coord.model) { $a.Add('--model'); $a.Add([string]$Coord.model) }
    if ($Coord.effort) { $a.Add('--effort'); $a.Add([string]$Coord.effort) }
    $a.Add('--allowedTools')
    foreach ($t in (Get-CoordinatorTools $Coord)) { $a.Add($t) }
    $a.Add('--disallowedTools')
    foreach ($t in (Get-CoordinatorDeny)) { $a.Add($t) }
    return , $a
}

function Get-PreflightError([hashtable]$Coord) {
    if ($ClaudeExe -match '\.js$') {
        if (-not (Test-Path -LiteralPath $ClaudeExe -PathType Leaf)) { return "stub CLI not found at $ClaudeExe" }
        if (-not (Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue)) { return 'node.exe not found (needed only for a .js stub CLI)' }
    } elseif (-not (Test-Path -LiteralPath $ClaudeExe -PathType Leaf)) {
        return "claude CLI not found at $ClaudeExe"
    }
    if (-not $Coord.cwd -or -not (Test-Path -LiteralPath ([string]$Coord.cwd) -PathType Container)) { return "coordinator working directory not found: $($Coord.cwd)" }
    if (-not $Coord.transcript_path -or -not (Test-Path -LiteralPath ([string]$Coord.transcript_path) -PathType Leaf)) {
        return "enrolled coordinator session $($Coord.session_id) not found (no local transcript at $($Coord.transcript_path)); re-enroll"
    }
    return ''
}

function Set-SubscriptionEnvironment {
    # Process-local only; use the normal saved login, never an inherited API/gateway credential.
    $previous = @{}
    foreach ($name in @('ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN',
            'ANTHROPIC_PROFILE', 'ANTHROPIC_FEDERATION_RULE_ID', 'ANTHROPIC_ORGANIZATION_ID',
            'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY')) {
        $previous[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
        [Environment]::SetEnvironmentVariable($name, $null, 'Process')
    }
    $previous['CLAUDE_CONFIG_DIR'] = [Environment]::GetEnvironmentVariable('CLAUDE_CONFIG_DIR', 'Process')
    $env:CLAUDE_CONFIG_DIR = $ClaudeConfigDir
    return $previous
}

function Restore-SubscriptionEnvironment([hashtable]$Previous) {
    if ($null -eq $Previous) { return }
    foreach ($name in $Previous.Keys) { [Environment]::SetEnvironmentVariable($name, $Previous[$name], 'Process') }
}

function Add-LedgerLine([hashtable]$D) {
    if (-not $script:CanWrite) { return }
    if (-not (Test-Path -LiteralPath $LedgerFile)) {
        [IO.File]::WriteAllText($LedgerFile, "| Started | Finished | Dispatch | Items | State | Outcome | Exit | Cost USD | Turns | Budget |`r`n|---|---|---|---|---|---|---|---|---|---|`r`n", $Utf8)
    }
    $outcome = [string]$D.outcome
    if ($D.error) { $outcome = $outcome + ' / ' + [string]$D.error }
    $outcome = (Get-Short $outcome 300) -replace '\|', '/'
    $line = '| {0} | {1} | {2} | {3} | {4} | {5} | {6} | {7} | {8} | {9} |' -f (Format-Unix $D.started_utc), (Format-Unix $D.finished_utc), $D.id,
        @($D.items).Count, $D.state, $outcome, $D.exit_code, $D.cost, $D.turns, $TurnBudgetUsd.ToString($Inv)
    [IO.File]::AppendAllText($LedgerFile, $line + "`r`n", $Utf8)
}

function Remove-DispatchFiles([hashtable]$D) {
    # The raw CLI output is reduced to metadata in state.json; the prompt file is kept (our own notice text).
    if (-not $script:CanWrite) { return }
    foreach ($f in @($D.out, $D.err, $D.stdin)) {
        if ($f -and (Test-Path -LiteralPath $f)) { Remove-Item -LiteralPath $f -Force -ErrorAction SilentlyContinue }
    }
}

function Set-ItemsDone([hashtable]$State, [hashtable]$D, [string]$Outcome) {
    $now = Get-Now
    foreach ($nid in @($D.items)) {
        $n = $State.notes[$nid]
        if ($n) {
            $n.state = 'completed'; $n.outcome = $Outcome; $n.completed_utc = $now
            if (-not $n.accepted_utc) { $n.accepted_utc = $now }
        }
    }
}

function Set-Accepted([hashtable]$State, [hashtable]$D) {
    $D.accepted_utc = Get-Now
    foreach ($nid in @($D.items)) {
        $n = $State.notes[$nid]
        if ($n -and $n.state -eq 'launched') { $n.state = 'accepted'; $n.accepted_utc = $D.accepted_utc }
    }
    Write-Log "Dispatch $($D.id) accepted: the notice is in session $($D.session_id); the turn is still running"
}

function Add-Backoff([hashtable]$State) {
    $State.failures = [int]$State.failures + 1
    $delay = [Math]::Min(3600, $BackoffSeconds * [Math]::Pow(2, [int]$State.failures - 1))
    $State.next_attempt_utc = (Get-Now) + [int64]$delay
}

function Set-DispatchFailed([hashtable]$State, [hashtable]$D, [string]$Message) {
    $D.state = 'failed'; $D.error = $Message; $D.finished_utc = Get-Now; $D.outcome = 'not delivered'
    foreach ($nid in @($D.items)) {
        $n = $State.notes[$nid]
        if ($n) { $n.state = 'pending'; $n.dispatch_id = ''; $n.outcome = "previous attempt not delivered: $Message" }
    }
    Add-Backoff $State
    Write-Log ('Dispatch {0} FAILED (not delivered): {1}. {2} notification(s) kept pending; failure {3}/{4}; next attempt not before {5}.' -f
        $D.id, $Message, @($D.items).Count, $State.failures, $MaxFailures, (Format-Unix $State.next_attempt_utc))
    if ([int]$State.failures -ge $MaxFailures) {
        $State.halt = "$($State.failures) consecutive dispatch failures; last: $Message"
        Add-Alert $State '' "Relay halted after $($State.failures) consecutive dispatch failures. Last error: $Message. Pending notifications are kept. Fix the cause, then run bridge-relay.ps1 -ClearHalt."
    }
    Add-LedgerLine $D
    Remove-DispatchFiles $D
}

function Read-CliResult([string]$Path) {
    if (-not $Path -or -not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    $raw = ''
    try { $raw = Read-SharedText $Path } catch { return $null }
    $i = $raw.IndexOf('{')
    if ($i -lt 0) { return $null }
    try {
        $r = ConvertTo-HT (ConvertFrom-Json -InputObject $raw.Substring($i))
        if (($r -is [hashtable]) -and $r.ContainsKey('subtype')) { return $r }
    } catch { }
    $lines = $raw -split "`r?`n"
    for ($k = $lines.Count - 1; $k -ge 0; $k--) {
        $l = $lines[$k].Trim()
        if (-not $l.StartsWith('{')) { continue }
        try { $r = ConvertTo-HT (ConvertFrom-Json -InputObject $l) } catch { continue }
        if (($r -is [hashtable]) -and $r['type'] -eq 'result') { return $r }
    }
    return $null
}

function Start-Dispatch([hashtable]$State, [hashtable]$Coord, [object[]]$Pending) {
    $script:LastLaunched = $null
    $now = Get-Now
    if (-not (Test-Path -LiteralPath $DispatchDir)) { New-Item -ItemType Directory -Path $DispatchDir -Force | Out-Null }
    $id = 'R' + (Get-Date).ToString('yyyyMMdd-HHmmss', $Inv) + '-' + [guid]::NewGuid().ToString('N').Substring(0, 4)
    $batch = @($Pending | Select-Object -First 20)
    $prompt = New-Prompt $id $batch
    $promptFile = Join-Path $DispatchDir "$id.prompt.txt"
    $stdin = Join-Path $DispatchDir "$id.stdin.txt"
    $out = Join-Path $DispatchDir "$id.out.json"
    $err = Join-Path $DispatchDir "$id.err.txt"
    [IO.File]::WriteAllText($promptFile, $prompt, $Utf8)
    [IO.File]::WriteAllText($stdin, '', $Utf8)
    $State.seq = [int64]$State.seq + 1
    $d = @{ id = $id; seq = $State.seq; state = 'launching'; items = @($batch | ForEach-Object { $_.id }); started_utc = $now; finished_utc = 0;
        session_id = [string]$Coord.session_id; transcript = [string]$Coord.transcript_path; cwd = [string]$Coord.cwd; pid = 0; proc_start = '';
        out = $out; err = $err; stdin = $stdin; prompt_file = $promptFile; accepted_utc = 0; exit_code = $null; outcome = ''; error = '';
        cost = 0.0; turns = $null; duration_ms = $null; subtype = ''; result_session = ''; summary = ''; billing = 'claude-code-subscription' }
    $State.dispatches[$id] = $d
    foreach ($n in $batch) { $n.state = 'launched'; $n.dispatch_id = $id; $n.attempts = [int]$n.attempts + 1 }
    Save-State $State   # write-ahead: from here on a crash is recovered from evidence, never blindly replayed

    $pf = Get-PreflightError $Coord
    if ($pf) { Set-DispatchFailed $State $d $pf; return }

    $cliArgs = Get-CliArguments $Coord $prompt
    $file = $ClaudeExe
    $prefix = @()
    if ($ClaudeExe -match '\.js$') {
        $file = (Get-Command node.exe -CommandType Application | Select-Object -First 1).Path
        $prefix = @($ClaudeExe)
    }
    $argString = ((@($prefix) + @($cliArgs)) | ForEach-Object { ConvertTo-ArgToken $_ }) -join ' '
    $proc = $null
    $launchError = ''
    $previousEnvironment = $null
    try {
        try {
            $previousEnvironment = Set-SubscriptionEnvironment
            # Windows PowerShell 5.1 turns native stderr into errors even when redirected.
            # Capture the probe's stdout and exit code before restoring strict error handling.
            $authErrorActionPreference = $ErrorActionPreference
            try {
                $ErrorActionPreference = 'Continue'
                $authRaw = ((& $file @prefix auth status 2>$null) | Out-String)
                $authExitCode = $LASTEXITCODE
            } finally { $ErrorActionPreference = $authErrorActionPreference }
            $auth = $authRaw | ConvertFrom-Json
            if ($authExitCode -ne 0 -or -not $auth.loggedIn -or $auth.authMethod -ne 'claude.ai' -or -not $auth.subscriptionType) {
                $launchError = 'Claude Code subscription login is unavailable; run claude auth login and select your Claude subscription (no API fallback)'
            }
        } catch { $launchError = 'could not verify Claude Code subscription login (no API fallback)' }
        if (-not $launchError) {
            try {
                # Hidden own console: Ctrl+C in the relay window must never reach the coordinator turn.
                $proc = Start-Process -FilePath $file -ArgumentList $argString -WorkingDirectory ([string]$Coord.cwd) -WindowStyle Hidden -PassThru `
                    -RedirectStandardInput $stdin -RedirectStandardOutput $out -RedirectStandardError $err
            } catch { $launchError = 'could not start the CLI: ' + $_.Exception.Message }
        }
    } finally {
        Restore-SubscriptionEnvironment $previousEnvironment
    }
    if ($launchError -or -not $proc) {
        if (-not $launchError) { $launchError = 'could not start the CLI (no process returned)' }
        Set-DispatchFailed $State $d $launchError
        return
    }
    try { $null = $proc.Handle } catch { }   # keep a handle so the exit code stays readable
    $d.pid = $proc.Id
    try { $d.proc_start = [string]$proc.StartTime.ToUniversalTime().Ticks } catch { $d.proc_start = '' }
    $d.state = 'running'
    $State.daily.wakes = [int]$State.daily.wakes + 1
    $script:Procs[$id] = $proc
    $script:LastLaunched = $id
    [void]$State.flags.Remove('last_block')
    Save-State $State
    Write-Log ('Dispatched {0} to session {1} (pid {2}; {3} item(s); budget {4} USD): {5}' -f $id, $Coord.session_id, $proc.Id, $batch.Count,
        $TurnBudgetUsd.ToString($Inv), (($batch | ForEach-Object { $_.detail }) -join '; '))
}

function Complete-Dispatch([hashtable]$State, [hashtable]$D) {
    $now = Get-Now
    $exit = $null
    if ($script:Procs.ContainsKey($D.id)) {
        $p = $script:Procs[$D.id]
        try { $p.WaitForExit(); $exit = $p.ExitCode } catch { }
        [void]$script:Procs.Remove($D.id)
    }
    $D.exit_code = $exit
    $res = Read-CliResult $D.out
    if (-not $res) {
        $errText = ''
        try { if ($D.err -and (Test-Path -LiteralPath $D.err)) { $errText = Get-Short (Read-SharedText $D.err) 300 } } catch { }
        if (Test-TranscriptMarker $D) {
            $D.state = 'completed'; $D.finished_utc = $now
            $D.outcome = 'unknown: the CLI ended without a result, but the notice is in the session transcript (delivered; not replayed)'
            if ($errText) { $D.error = $errText }
            Set-ItemsDone $State $D 'delivered; terminal outcome unknown (not replayed)'
            $State.last_finish_utc = $now
            Write-Log "Dispatch $($D.id) ended without a CLI result (exit $exit), but the session transcript holds its notice: recorded as delivered, outcome unknown; not replayed."
            Add-Alert $State '' "Coordinator turn $($D.id) ended without a CLI result (exit $exit) after its notice reached the session. Not replayed. Check the coordinator's status files."
            Add-LedgerLine $D
            Remove-DispatchFiles $D
            return
        }
        $msg = "CLI ended without a result (exit $exit)"
        if ($errText) { $msg += ": $errText" }
        Set-DispatchFailed $State $D $msg
        return
    }
    $D.finished_utc = $now
    $D.subtype = [string]$res['subtype']
    $D.result_session = [string]$res['session_id']
    $cost = 0.0
    if ($null -ne $res['total_cost_usd']) { $cost = [math]::Round([double]$res['total_cost_usd'], 4) }
    $D.cost = $cost
    $D.turns = $res['num_turns']
    $D.duration_ms = $res['duration_ms']
    $D.summary = Get-Short ([string]$res['result']) 300
    $State.daily.cost = [math]::Round([double]$State.daily.cost + $cost, 4)
    $State.last_finish_utc = $now
    $isErr = [bool]$res['is_error']
    if ($D.result_session -and $D.result_session -ne $D.session_id) {
        $D.state = 'completed'
        $D.outcome = "SESSION MISMATCH: the CLI used $($D.result_session), enrolled is $($D.session_id)"
        Set-ItemsDone $State $D 'delivered to a different session id (copy or fork); not replayed'
        $State.halt = "session mismatch on $($D.id): the CLI reported session $($D.result_session) instead of the enrolled $($D.session_id)"
        Add-Alert $State '' "Relay halted: dispatch $($D.id) ran in session $($D.result_session), not the enrolled $($D.session_id). Re-check the enrollment, then run -ClearHalt."
    } elseif (-not $isErr -and $D.subtype -eq 'success') {
        $D.state = 'completed'
        $D.outcome = 'success'
        Set-ItemsDone $State $D 'completed: the coordinator turn ended successfully (task state stays with Claude)'
        $State.failures = 0
        $State.next_attempt_utc = 0
    } elseif ($isErr -and $cost -eq 0 -and -not (Test-TranscriptMarker $D)) {
        Set-DispatchFailed $State $D ('the CLI returned an error before the turn ran: ' + (Get-Short ([string]$res['result']) 200))
        return
    } else {
        $D.state = 'completed'
        $D.outcome = "turn ended with an error ($($D.subtype)); delivered, not replayed"
        Set-ItemsDone $State $D "delivered; the turn ended with an error ($($D.subtype)); not replayed"
        Add-Backoff $State
        Add-Alert $State '' "Coordinator turn $($D.id) ended with an error ($($D.subtype); cost $cost USD): $($D.summary). Not replayed."
        if ([int]$State.failures -ge $MaxFailures) {
            $State.halt = "$($State.failures) consecutive failed coordinator turns; last: $($D.subtype)"
            Add-Alert $State '' "Relay halted after $($State.failures) consecutive failed coordinator turns. Run -ClearHalt after checking."
        }
    }
    Write-Log ('Dispatch {0} {1}: {2}; cost {3} USD; turns {4}; exit {5}' -f $D.id, $D.state, $D.outcome, $D.cost, $D.turns, $exit)
    Add-LedgerLine $D
    Remove-DispatchFiles $D
}

function Update-Dispatches([hashtable]$State) {
    foreach ($d in @($State.dispatches.Values | Where-Object { $_.state -eq 'running' -or $_.state -eq 'launching' })) {
        if ($d.state -eq 'launching' -and -not $d.pid) {
            # The relay stopped after the write-ahead but before it recorded a process id.
            $ps = Get-SessionProcesses $d.session_id
            if ($ps -and $ps.Count -gt 0) {
                $d.pid = [int]$ps[0].ProcessId
                $d.state = 'running'
                Write-Log "Recovered dispatch $($d.id): a process (pid $($d.pid)) has the session open; waiting for it, never killing it"
                continue
            }
            if (-not (Test-Path -LiteralPath $d.out) -and -not (Test-TranscriptMarker $d)) {
                $d.state = 'abandoned'
                $d.finished_utc = Get-Now
                $d.outcome = 'the relay stopped before the CLI started; items re-queued'
                foreach ($nid in @($d.items)) { $n = $State.notes[$nid]; if ($n) { $n.state = 'pending'; $n.dispatch_id = '' } }
                Write-Log "Dispatch $($d.id) never started (the relay stopped first); $(@($d.items).Count) notification(s) re-queued"
                Add-LedgerLine $d
                continue
            }
        }
        if ($d.state -eq 'launching') { $d.state = 'running' }
        if (Test-DispatchAlive $d) {
            if (-not $d.accepted_utc -and (Test-TranscriptMarker $d)) { Set-Accepted $State $d }
            $mins = [int][Math]::Floor(((Get-Now) - [int64]$d.started_utc) / 60)
            if ($mins -ge $WaitMinutes) {
                Add-Alert $State ('long:' + $d.id) "Coordinator turn $($d.id) is still running after $mins min (pid $($d.pid)). The relay never kills it; new notifications stay queued."
            }
            continue
        }
        Complete-Dispatch $State $d
    }
}

function Get-BlockReason([hashtable]$State, $Coord, [int]$Settling) {
    $now = Get-Now
    if (Test-Path -LiteralPath $PauseFile) { return @{ code = 'paused'; text = "PAUSED ($PauseFile exists); pending notifications are kept" } }
    if ($State.halt) { return @{ code = 'halted'; text = "HALTED: $($State.halt). Pending notifications are kept; check .relay\alerts.md, then run -ClearHalt" } }
    if (-not $Coord) { return @{ code = 'not-enrolled'; text = 'NOT ENROLLED: no coordinator session is registered, so nothing is sent; pending notifications are kept. One-time step: bridge-relay.ps1 -Enroll -SessionId <uuid>' } }
    if ($Settling -gt 0) { return @{ code = 'settling'; text = "settling: $Settling inbound file(s) changed less than $DebounceSeconds s ago (debounce)" } }
    if ($State.next_attempt_utc -and $now -lt [int64]$State.next_attempt_utc) {
        return @{ code = 'backoff'; text = "backoff after failure $($State.failures)/$MaxFailures; next attempt not before $(Format-Unix $State.next_attempt_utc)" }
    }
    if ($MaxWakesPerDay -gt 0 -and [int]$State.daily.wakes -ge $MaxWakesPerDay) {
        Add-Alert $State ('cap-wakes-' + $State.daily.date) "Daily wake limit reached ($MaxWakesPerDay coordinator turns). Notifications stay queued until tomorrow. Possible loop: check .relay\relay.log."
        return @{ code = 'cap-wakes'; text = "daily wake limit reached ($($State.daily.wakes)/$MaxWakesPerDay)" }
    }
    if ($script:CostLimits -and ([double]$State.daily.cost + $TurnBudgetUsd) -gt $DailyBudgetUsd) {
        Add-Alert $State ('cap-cost-' + $State.daily.date) "Daily relay budget reached ($($State.daily.cost) of $DailyBudgetUsd USD; one more turn could cost $TurnBudgetUsd). Notifications stay queued until tomorrow; the relay never raises budgets."
        return @{ code = 'cap-cost'; text = "daily budget reached ($($State.daily.cost) + $TurnBudgetUsd > $DailyBudgetUsd USD)" }
    }
    $busy = Get-BusyReason $State $Coord
    if ($busy) { return @{ code = 'busy'; text = "coordinator busy: $busy. Queued; no new process" } }
    return $null
}

# ---------- one tick ----------
function Invoke-Tick([hashtable]$State, [bool]$ReadOnly) {
    $script:LastLaunched = $null
    $coord = Get-Coordinator
    $baseline = (-not $State.baseline_utc)
    Update-Daily $State
    Update-Dispatches $State
    $settling = Update-Inbound $State $baseline
    Update-Workers $State $baseline
    Update-Attention $State
    if ($settling -gt 0) { Write-Note "Debounce: $settling inbound file(s) still settling (changed less than $DebounceSeconds s ago); looking again later" }
    if ($baseline) {
        $State.baseline_utc = Get-Now
        if ($ReadOnly) { Write-Note ('DRY-RUN: no baseline yet; the first -Once/-Start will mark {0} Codex file revision(s) and {1} worker run(s) as already seen.' -f $State.files.Count, $State.workers.Count) }
        else { Write-Log ('Baseline recorded: {0} Codex file revision(s) and {1} worker run(s) marked as already seen; nothing dispatched.' -f $State.files.Count, $State.workers.Count) }
    }
    $pending = @($State.notes.Values | Where-Object { $_.state -eq 'pending' } | Sort-Object { [int64]$_.detected_utc })
    if ($pending.Count -eq 0) {
        [void]$State.flags.Remove('last_block')
        if ($ReadOnly) { Write-Note 'DRY-RUN: nothing to dispatch.' }
    } else {
        $why = Get-BlockReason $State $coord $settling
        if ($why) {
            $text = "$($pending.Count) notification(s) queued, not sent: $($why.text)"
            if ($ReadOnly) { Write-Note "DRY-RUN: would not dispatch now. $text" }
            elseif ($State.flags['last_block'] -ne $why.code) { $State.flags['last_block'] = $why.code; Write-Log $text }
            else { Write-Note $text }
        } elseif ($ReadOnly) {
            $id = 'R<dry-run>'
            $batch = @($pending | Select-Object -First 20)
            $prompt = New-Prompt $id $batch
            Write-Note ("DRY-RUN: would dispatch {0} item(s) to session {1} (cwd {2}). No CLI started, no key decrypted, no API credit used." -f $batch.Count, $coord.session_id, $coord.cwd)
            Write-Host ('  command: ' + $ClaudeExe + ' ' + (((Get-CliArguments $coord $prompt) | ForEach-Object { ConvertTo-ArgToken $_ }) -join ' '))
        } else {
            Start-Dispatch $State $coord $pending
        }
    }
    Save-State $State
}

# ---------- modes ----------
function Invoke-OnceMode {
    $state = Get-State
    Invoke-Tick $state $false
    $id = $script:LastLaunched
    if ($id -and -not $NoWait) {
        Write-Note "Waiting for dispatch $id to end (up to $WaitMinutes min; the turn is never killed)..."
        $deadline = (Get-Now) + $WaitMinutes * 60
        while ((Get-Now) -lt $deadline) {
            $p = $script:Procs[$id]
            if (-not $p -or $p.HasExited) { break }
            Start-Sleep -Milliseconds 500
        }
        Update-Dispatches $state
        Save-State $state
    }
    $pend = @($state.notes.Values | Where-Object { $_.state -eq 'pending' }).Count
    $fly = @($state.dispatches.Values | Where-Object { $_.state -eq 'running' -or $_.state -eq 'launching' } | ForEach-Object { $_.id })
    Write-Note ("Once done: {0} pending; in flight: {1}" -f $pend, $(if ($fly.Count) { $fly -join ',' } else { 'none' }))
}

function Invoke-Loop {
    if (Test-Path -LiteralPath $StopFile) { Remove-Item -LiteralPath $StopFile -Force -ErrorAction SilentlyContinue }
    $fsw = New-Object System.IO.FileSystemWatcher($Root)
    $fsw.IncludeSubdirectories = $true
    $fsw.NotifyFilter = [IO.NotifyFilters]::FileName -bor [IO.NotifyFilters]::DirectoryName -bor [IO.NotifyFilters]::LastWrite -bor [IO.NotifyFilters]::Size
    Write-Log "Relay loop started (pid $PID; mailbox $Root; poll $PollSeconds s; debounce $DebounceSeconds s). Stop: bridge-relay.ps1 -Stop, or Ctrl+C here. CodexWake=NOT_CONFIGURED."
    $state = Get-State
    try {
        try { Invoke-Tick $state $false } catch { Write-Log "Tick error: $($_.Exception.Message)" }
        $last = Get-Now
        $dirty = $false
        while ($true) {
            if (Test-Path -LiteralPath $StopFile) { Write-Log 'Stop requested; leaving the loop. An in-flight coordinator turn keeps running and is reconciled on the next start.'; break }
            $r = $fsw.WaitForChanged([IO.WatcherChangeTypes]::All, 1000)
            if (-not $r.TimedOut -and $r.Name -and -not $r.Name.StartsWith('.relay', [StringComparison]::OrdinalIgnoreCase)) { $dirty = $true }
            $now = Get-Now
            if (($dirty -and ($now - $last) -ge 2) -or ($now - $last) -ge $PollSeconds) {
                $dirty = $false
                try { Invoke-Tick $state $false } catch { Write-Log "Tick error: $($_.Exception.Message)" }
                $last = Get-Now
            }
        }
    } finally {
        $fsw.Dispose()
        if (Test-Path -LiteralPath $StopFile) { Remove-Item -LiteralPath $StopFile -Force -ErrorAction SilentlyContinue }
        Write-Log 'Relay loop stopped.'
    }
}

function Invoke-Enroll {
    if ($SessionId -notmatch '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$') {
        Fail "-SessionId must be the coordinator session UUID (got '$SessionId'). The relay never guesses it."
    }
    $sid = $SessionId.ToLowerInvariant()
    $cwd = $Root
    if ($CoordinatorCwd) { $cwd = [IO.Path]::GetFullPath($CoordinatorCwd).TrimEnd('\') }
    if (-not (Test-Path -LiteralPath $cwd -PathType Container)) { Fail "Coordinator working directory not found: $cwd" }
    $projects = Join-Path $ClaudeConfigDir 'projects'
    $expectedDir = Join-Path $projects ($cwd -replace '[^A-Za-z0-9]', '-')
    $transcript = Join-Path $expectedDir "$sid.jsonl"
    if (-not (Test-Path -LiteralPath $transcript -PathType Leaf)) {
        $other = @(Get-ChildItem -Path (Join-Path $projects "*\$sid.jsonl") -File -ErrorAction SilentlyContinue)
        if ($other.Count -gt 0) {
            Fail ("Session $sid exists under '" + $other[0].Directory.Name + "', not under '" + (Split-Path -Leaf $expectedDir) +
                "' (working directory $cwd). claude --resume only finds sessions of its working directory; re-run -Enroll with -CoordinatorCwd set to that session's directory.")
        }
        Fail "No local session $sid found for working directory $cwd (looked for $transcript). Take the ID from the coordinator session itself; the relay never guesses it."
    }
    $procs = Get-SessionProcesses $sid
    if ($null -eq $procs) { Fail 'Could not read the process list to confirm the session is not running. Not enrolled.' }
    if ($procs.Count -gt 0) {
        Fail ("Session $sid is open right now (pid " + (($procs | ForEach-Object { $_.ProcessId }) -join ',') + '). Exit that Claude session first: the relay must never resume a running session.')
    }
    if ($QuietSeconds -gt 0) {
        $age = (Get-Now) - (ConvertTo-Unix (Get-Item -LiteralPath $transcript).LastWriteTimeUtc)
        if ($age -lt $QuietSeconds) { Fail "Session $sid was written $age s ago; it may still be open. Exit it, wait $QuietSeconds s, then enroll again." }
    }
    $coord = @{ session_id = $sid; cwd = $cwd; transcript_path = $transcript; enrolled_utc = (Get-Now); enrolled = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss', $Inv);
        verified = 'local transcript present for this working directory; no process had the session id on its command line; transcript quiet';
        model = [string]$Model; effort = [string]$Effort;
        allowed_checks = $CheckList.ToArray();
        resume_rule = 'claude -p <notice> --resume <session_id> using subscription login only; never --continue, --fork-session or --no-session-persistence' }
    Save-Json $CoordFile $coord
    $state = Get-State
    [void]$state.flags.Remove('last_block')
    Save-State $state
    Write-Log "Enrolled coordinator session $sid (cwd $cwd). Verified: transcript present, not running. Model: $(if ($Model) { $Model } else { 'CLI default' }); effort: $(if ($Effort) { $Effort } else { 'CLI default' })."
    Write-Log ('Allowed checks (operator-enrolled, granted as Bash(<prefix>*)): ' + $(if ($CheckList.Count) { ($CheckList | ForEach-Object { "'" + $_ + "'" }) -join ', ' } else { 'none' }) +
        '. To change them, exit the coordinator session and run -Enroll again.')
}

function Invoke-ClearHalt {
    $state = Get-State
    $was = $state.halt
    $state.halt = ''
    $state.failures = 0
    $state.next_attempt_utc = 0
    [void]$state.flags.Remove('last_block')
    Save-State $state
    Write-Log ("Halt cleared by the operator (was: {0})." -f $(if ($was) { $was } else { 'not halted' }))
}

function Invoke-Stop {
    $li = Get-LockInfo
    if (-not $li.held) { Write-Host 'Relay loop is not running (no process holds .relay\relay.lock).'; return }
    if ($li.info.mode -ne 'Start') { Write-Host "A short relay command (pid $($li.info.pid), mode $($li.info.mode)) holds the lock and exits by itself. No loop to stop."; return }
    if (-not (Test-Path -LiteralPath $RelayDir)) { New-Item -ItemType Directory -Path $RelayDir -Force | Out-Null }
    [IO.File]::WriteAllText($StopFile, (Get-Date).ToString('yyyy-MM-dd HH:mm:ss', $Inv), $Utf8)
    Write-Host "Stop requested for the relay loop (pid $($li.info.pid)). An in-flight coordinator turn is never killed; it is reconciled on the next start."
    $wait = 10 + 3 * [int]$li.info.poll_seconds
    $deadline = (Get-Date).AddSeconds($wait)
    while ((Get-Date) -lt $deadline) {
        if (-not (Get-LockInfo).held) { Write-Host 'Relay loop stopped.'; return }
        Start-Sleep -Milliseconds 500
    }
    Write-Host "The loop has not exited after $wait s. It may be finishing a tick. Check -Status."
}

function Show-Status {
    $li = Get-LockInfo
    $state = Get-State
    $coord = Get-Coordinator
    Write-Host "Bridge relay - mailbox $Root"
    if ($li.held -and $li.info.mode -eq 'Start') { Write-Host "Loop: RUNNING (pid $($li.info.pid), since $($li.info.started))" }
    elseif ($li.held) { Write-Host "Loop: STOPPED (a short '$($li.info.mode)' command, pid $($li.info.pid), holds the writer lock)" }
    else { Write-Host 'Loop: STOPPED' }
    if ($coord) {
        $tp = [bool]($coord.transcript_path -and (Test-Path -LiteralPath ([string]$coord.transcript_path) -PathType Leaf))
        Write-Host "Coordinator: ENROLLED session $($coord.session_id) (cwd $($coord.cwd); enrolled $($coord.enrolled); transcript present: $tp)"
    } else {
        Write-Host 'Coordinator: NOT ENROLLED. One-time step: exit the coordinator session, then run'
        Write-Host '             bridge-relay.ps1 -Enroll -SessionId <that session uuid>. Nothing is sent until then.'
    }
    Write-Host ('Projects folder (the coordinator may read it): ' + $(if ($ProjectsDir) { $ProjectsDir } else { 'not set (projects_dir in bin\relay-settings.json)' }))
    Write-Host ('Baseline: ' + $(if ($state.baseline_utc) { Format-Unix $state.baseline_utc } else { 'not yet recorded (the first -Once/-Start records it)' }))
    $fly = @($state.dispatches.Values | Where-Object { $_.state -eq 'running' -or $_.state -eq 'launching' })
    if ($fly.Count -eq 0) { Write-Host 'In flight: none' }
    foreach ($d in $fly) { Write-Host ("In flight: {0} pid {1} started {2} alive {3}" -f $d.id, $d.pid, (Format-Unix $d.started_utc), (Test-DispatchAlive $d)) }
    $pend = @($state.notes.Values | Where-Object { $_.state -eq 'pending' } | Sort-Object { [int64]$_.detected_utc })
    Write-Host "Pending notifications: $($pend.Count)"
    foreach ($n in $pend) { Write-Host ("  - {0} (detected {1}, attempts {2})" -f $n.detail, (Format-Unix $n.detected_utc), $n.attempts) }
    Write-Host ('Halt: ' + $(if ($state.halt) { $state.halt } else { 'none' }) + "; consecutive failures: $($state.failures)" +
        $(if ($state.next_attempt_utc) { '; next attempt not before ' + (Format-Unix $state.next_attempt_utc) } else { '' }))
    $wakeLimit = $(if ($MaxWakesPerDay -eq 0) { 'unlimited' } else { [string]$MaxWakesPerDay })
    if ($script:CostLimits) { Write-Host ("Today ({0}): {1}/{2} coordinator turns, {3} of {4} USD" -f $state.daily.date, $state.daily.wakes, $wakeLimit, $state.daily.cost, $DailyBudgetUsd) }
    else { Write-Host ("Today ({0}): {1}/{2} coordinator turns, {3} USD spent (cost limits OFF: bin\cost-limits.json)" -f $state.daily.date, $state.daily.wakes, $wakeLimit, $state.daily.cost) }
    Write-Host ('PAUSE file: ' + $(if (Test-Path -LiteralPath $PauseFile) { 'present (dispatch paused)' } else { 'absent' }))
    $recent = @($state.dispatches.Values | Sort-Object { [int64]$_.seq } -Descending | Select-Object -First 5)
    if ($recent.Count) { Write-Host 'Recent dispatches:' }
    foreach ($d in $recent) { Write-Host ("  - {0} {1}: {2} (cost {3} USD, items {4})" -f $d.id, $d.state, (Get-Short ([string]$d.outcome + ' ' + [string]$d.error) 160), $d.cost, @($d.items).Count) }
    $att = Get-AttentionItems
    Write-Host "Codex attention (return direction, listed only): $($att.Count)"
    foreach ($k in @($att.Keys | Sort-Object)) { Write-Host ("  - {0}: {1}" -f $k, $att[$k].what) }
    Write-Host 'CodexWake=NOT_CONFIGURED (the relay never wakes the Codex desktop chat; Codex needs its own supported scheduled review)'
}

function Show-CoordinatorArgs {
    # Read-only (no lock, no CLI, no key): the exact permission values and --add-dir directories Get-CliArguments passes
    # to a coordinator turn, for the enrolled coordinator, or the MailboxRoot defaults when none is enrolled.
    $coord = Get-Coordinator
    $o = [ordered]@{ allowedTools = @(Get-CoordinatorTools $coord); disallowedTools = @(Get-CoordinatorDeny); addDirs = @(Get-CoordinatorAddDirs $coord);
        appendSystemPrompt = (Get-RelayRules $coord) }
    Write-Output (ConvertTo-Json -InputObject $o -Depth 4)
}

# ---------- main ----------
switch ($Mode) {
    'Status' { Show-Status; exit 0 }
    'Stop'   { Invoke-Stop; exit 0 }
    'ShowCoordinatorArgs' { Show-CoordinatorArgs; exit 0 }
    'DryRun' {
        $dry = Get-State   # in-memory copy only; CanWrite stays false, so nothing is written
        Write-Note "DRY-RUN on $Root (read-only; no CLI, no key, no API credit)."
        Invoke-Tick $dry $true
        exit 0
    }
}

if (-not (Enter-WriterLock $Mode)) {
    $li = Get-LockInfo
    Write-Host "ERROR: another relay writer is already running (pid $($li.info.pid), mode $($li.info.mode)). Use -Status, or -Stop for a loop."
    exit 3
}
try {
    switch ($Mode) {
        'Start'     { Invoke-Loop }
        'Once'      { Invoke-OnceMode }
        'Enroll'    { Invoke-Enroll }
        'ClearHalt' { Invoke-ClearHalt }
    }
} finally {
    Exit-WriterLock
}
exit 0
