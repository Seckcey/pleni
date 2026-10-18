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
      --no-session-persistence, never resumes a session that looks open elsewhere (its id on a process's command line,
      or in Claude Code's own list of running sessions, <config>\sessions\<pid>.json), and never kills a process.
  Return direction (Claude -> Codex): lists unanswered BLOCKING questions and unreviewed IN_REVIEW handoffs in
    .relay\codex-attention.md. Optional CodexWake (off until -EnrollCodex): each new item wakes ONE enrolled Codex
    thread once, with codex exec --json --skip-git-repo-check resume <thread id> <notice>, in the thread's folder.
    One wake at a time, never while another Codex program holds the thread (the Codex app keeps every thread it
    opened), while a process has the thread id on its command line, or while a coordinator turn runs.
    ChatGPT sign-in only (codex login status); OpenAI/Codex API keys are removed for the child launch.
  Rollovers: enrolled by name (-Enroll -SessionName, -EnrollCodex -ThreadName), the relay wakes the newest session
    with that name and switches on its own when a newer one takes the name over: forward in time only, between turns.
  Agent mail (off until -EnrollAgent): agents send each other messages by name with bin\agent-mail.ps1, one file per
    message in mail\<name key>\new. For each enrolled agent (a Codex thread followed by its name), new mail wakes the
    thread once with the same codex exec resume command, in its own folder: one turn at a time per agent, at most
    -MaxAgentTurnsAtOnce at once, never while another program has the thread open. Mail the agent read by itself
    (agent-mail.ps1 -Wait or -Read in its own window) needs no wake.
  Billing: the existing Claude Code subscription login. No --bare, API-key injection or API
    fallback. Funding overrides are removed only for the child launch, then the original environment is restored.
  State: <MailboxRoot>\.relay\ only, one serialized writer (relay.lock). No secrets and no transcripts are stored.
  Settings: <MailboxRoot>\bin\cost-limits.json and bin\relay-settings.json (projects_dir, owner_name, and for the
    Codex wake codex_exe and codex_exec_args), both optional.
  The mailbox is the folder above bin\, where this script lives, unless -MailboxRoot names another one.
  No installation: no scheduled task, service, registry entry or permanent background process.
  Windows PowerShell 5.1 compatible. ASCII only.

.EXAMPLE
  .\bridge-relay.ps1 -Status
  .\bridge-relay.ps1 -DryRun
  .\bridge-relay.ps1 -Enroll -SessionId 01234567-89ab-4def-8123-456789abcdef
  .\bridge-relay.ps1 -Enroll -SessionName 'Sergeant'   (follow a name: a newer session named Sergeant takes over)
  .\bridge-relay.ps1 -Enroll -SessionId <uuid> -AllowCheck 'php -l','powershell -NoProfile -File C:/Users/ada/checks/lint.ps1'
      (operator only: extra check-command prefixes the coordinator may run, granted as Bash(<prefix>*). Stored in
       .relay\coordinator.json. To change them, exit the coordinator session and run -Enroll again; no other mode
       accepts -AllowCheck. Refused: '*', empty, git/claude/codex/npm/npx/rm/del, pwsh, cmd, powershell without
       -File <script>, node without a script path or with -e/-p.)
  .\bridge-relay.ps1 -ShowCoordinatorArgs   (read-only: prints the coordinator's allowed/denied tools and rules as JSON)
  .\bridge-relay.ps1 -EnrollCodex -ThreadId 01234567-89ab-4def-8123-456789abcdef   (optional: wake that Codex thread)
  .\bridge-relay.ps1 -EnrollCodex -ThreadName 'Planner'   (or follow a name: a newer thread named Planner takes over)
  .\bridge-relay.ps1 -UnenrollCodex          (turn the Codex wake off again)
  .\bridge-relay.ps1 -EnrollAgent -AgentName 'Sergeant Milepost'   (wake that agent's Codex thread when mail waits for it)
  .\bridge-relay.ps1 -UnenrollAgent -AgentName 'Sergeant Milepost' (stop waking it for its mail)
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
    [switch]$EnrollCodex,
    [switch]$UnenrollCodex,
    [switch]$EnrollAgent,
    [switch]$UnenrollAgent,
    [string]$AgentName,     # -EnrollAgent, -UnenrollAgent: the agent's name, the same as its Codex thread's name
    [string]$SessionId,
    [string]$ThreadId,      # -EnrollCodex: the Codex thread to wake
    [string]$CodexCwd,      # -EnrollCodex: the thread's folder, when its first line does not name it
    [string]$SessionName,   # -Enroll: follow the newest Claude Code session with this name (instead of -SessionId)
    [string]$ThreadName,    # -EnrollCodex: follow the newest Codex thread with this name (instead of -ThreadId)
    [string]$DesktopRoot,   # the Claude desktop app's data folder (default %APPDATA%\Claude), for names set in the app
    [string]$CoordinatorCwd,
    [string]$MailboxRoot,   # default: the folder above bin\, where this script lives
    [switch]$NoWait,
    [ValidateRange(0, 3600)][int]$DebounceSeconds = 20,
    [ValidateRange(1, 3600)][int]$PollSeconds = 10,
    [ValidateRange(0, 86400)][int]$QuietSeconds = 90,
    [ValidateRange(0.05, 5)][double]$TurnBudgetUsd = 1,
    [ValidateRange(0.05, 50)][double]$DailyBudgetUsd = 5,
    [ValidateRange(0, 500)][int]$MaxWakesPerDay = 12, # 0 = unlimited coordinator wakes
    [ValidateRange(0, 500)][int]$MaxCodexWakesPerDay = 12, # 0 = unlimited Codex wakes
    [ValidateRange(0, 500)][int]$MaxAgentWakesPerDay = 12, # mail wakes per agent; 0 = unlimited
    [ValidateRange(1, 10)][int]$MaxAgentTurnsAtOnce = 3,
    [ValidateRange(1, 20)][int]$MaxFailures = 3,
    [ValidateRange(1, 86400)][int]$BackoffSeconds = 120,
    [ValidateRange(1, 1440)][int]$WaitMinutes = 30,
    [string]$ClaudeExe = (Join-Path $env:APPDATA 'npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe'),
    [string]$KeyFile = (Join-Path $env:USERPROFILE '.claude-coordinator\anthropic-key.dpapi'), # legacy argument; never read
    [string]$ClaudeConfigDir,
    [string]$CodexExe,      # default: codex_exe in bin\relay-settings.json, else codex.exe or codex.cmd on PATH
    [string]$CodexHome,     # default: $env:CODEX_HOME, else %USERPROFILE%\.codex
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
if ($EnrollCodex) { $modes += 'EnrollCodex' }
if ($UnenrollCodex) { $modes += 'UnenrollCodex' }
if ($EnrollAgent) { $modes += 'EnrollAgent' }
if ($UnenrollAgent) { $modes += 'UnenrollAgent' }
if ($modes.Count -gt 1) { Fail ('Pick one mode, got: ' + ($modes -join ', ')) 64 }
if ($modes.Count -eq 0) { $modes = @('Status') }
$Mode = $modes[0]
if ($Effort -and @('low', 'medium', 'high', 'xhigh', 'max') -notcontains $Effort) { Fail "-Effort must be low, medium, high, xhigh or max (got '$Effort')" 64 }
if (($ThreadId -or $CodexCwd -or $ThreadName) -and $Mode -ne 'EnrollCodex') { Fail '-ThreadId, -ThreadName and -CodexCwd are accepted only with -EnrollCodex.' 64 }
if ($SessionName -and $Mode -ne 'Enroll') { Fail '-SessionName is accepted only with -Enroll.' 64 }
if ($SessionId -and $SessionName) { Fail 'Give -SessionId or -SessionName, not both.' 64 }
if ($ThreadId -and $ThreadName) { Fail 'Give -ThreadId or -ThreadName, not both.' 64 }
if ($AgentName -and @('EnrollAgent', 'UnenrollAgent') -notcontains $Mode) { Fail '-AgentName is accepted only with -EnrollAgent or -UnenrollAgent.' 64 }
if (@('EnrollAgent', 'UnenrollAgent') -contains $Mode -and -not $AgentName) { Fail "-$Mode needs -AgentName <the agent's name>." 64 }

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
        if (-not $PSBoundParameters.ContainsKey('MaxCodexWakesPerDay') -and $null -ne $cl.relay_max_codex_wakes_per_day) { $MaxCodexWakesPerDay = [int]$cl.relay_max_codex_wakes_per_day }
        if (-not $PSBoundParameters.ContainsKey('MaxAgentWakesPerDay') -and $null -ne $cl.relay_max_agent_wakes_per_day) { $MaxAgentWakesPerDay = [int]$cl.relay_max_agent_wakes_per_day }
        if (-not $PSBoundParameters.ContainsKey('MaxAgentTurnsAtOnce') -and $null -ne $cl.relay_max_agent_turns_at_once) {
            $MaxAgentTurnsAtOnce = [int][Math]::Max(1, [Math]::Min(10, [int]$cl.relay_max_agent_turns_at_once))
        }
    } catch { Write-Host "WARNING: could not read $clFile; cost limits stay ON" }
}

# Local settings: <MailboxRoot>\bin\relay-settings.json. projects_dir is the folder that holds the application
# repositories (the coordinator may read it; -ProjectsDir wins). owner_name is the person the coordinator's notes
# ask for help; without it they ask "the owner" and use the tag NEEDS-OWNER.
$OwnerName = 'the owner'
$OwnerTag = 'NEEDS-OWNER'
$CodexArgsRaw = @()   # codex_exec_args: extra codex exec options for the Codex wake (checked below)
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
        if (-not $CodexExe -and $rs.codex_exe) { $CodexExe = [string]$rs.codex_exe }
        if ($null -ne $rs.codex_exec_args) { $CodexArgsRaw = @($rs.codex_exec_args) }
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

function Get-CodexArgError($Value) {
    # A codex_exec_args entry is passed to 'codex exec' before 'resume'. The owner sets them (bin\ is out of the
    # sessions' reach); the relay still refuses anything that turns the sandbox off or changes what it controls.
    if (-not ($Value -is [string])) { return 'it is not a string' }
    $v = [string]$Value
    if (-not $v) { return 'it is empty' }
    if ($v -match '[\x00-\x20"%!^&|<>`]') { return 'it holds a space, a quote, a control character or a character cmd.exe treats specially (put each option and each value in its own entry)' }
    if ($v -match '(?i)danger|bypass|yolo') { return 'it would turn the Codex sandbox off, which the relay never does' }
    if (@('resume', '--last', '--json', '--skip-git-repo-check', '--cd') -contains $v -or $v -ceq '-C' -or $v -match '^--cd=') {
        return 'the relay sets it itself (it always resumes the enrolled thread, in its own folder, with JSON output)'
    }
    return ''
}

$CodexArgs = New-Object System.Collections.Generic.List[string]
$CodexArgsError = ''
foreach ($caEntry in @($CodexArgsRaw)) {
    $caWhy = Get-CodexArgError $caEntry
    if ($caWhy) { $CodexArgsError = "codex_exec_args entry '$caEntry' in bin\relay-settings.json refused: $caWhy"; break }
    $CodexArgs.Add([string]$caEntry)
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
if (-not $CodexHome) {
    if ($env:CODEX_HOME) { $CodexHome = $env:CODEX_HOME } else { $CodexHome = Join-Path $env:USERPROFILE '.codex' }
}
$CodexHomeDir = [IO.Path]::GetFullPath($CodexHome).TrimEnd('\')
$RelayDir    = Join-Path $Root '.relay'
$StateFile   = Join-Path $RelayDir 'state.json'
$CoordFile   = Join-Path $RelayDir 'coordinator.json'
$CodexFile   = Join-Path $RelayDir 'codex.json'
$LockFile    = Join-Path $RelayDir 'relay.lock'
$StopFile    = Join-Path $RelayDir 'STOP'
$PauseFile   = Join-Path $RelayDir 'PAUSE'
$LogFile     = Join-Path $RelayDir 'relay.log'
$AlertFile   = Join-Path $RelayDir 'alerts.md'
$LedgerFile  = Join-Path $RelayDir 'dispatches.md'
$AttnFile    = Join-Path $RelayDir 'codex-attention.md'
$DispatchDir = Join-Path $RelayDir 'dispatch'
$AgentsFile  = Join-Path $RelayDir 'agents.json'
$MailDir     = Join-Path $Root 'mail'

$script:CanWrite     = $false   # true only while this process holds relay.lock (the single writer)
$script:LockStream   = $null
$script:Procs        = @{}      # dispatch id -> Process started by THIS relay process
$script:LastLaunched = $null
$script:LastCodexLaunched = $null
$script:MailLaunched = New-Object System.Collections.ArrayList   # mail wakes started by the last tick

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
        daily = @{ date = ''; wakes = 0; cost = 0.0; codex_wakes = 0; mail_wakes = @{} }; failures = 0; next_attempt_utc = 0; halt = ''; last_finish_utc = 0; flags = @{};
        codex_notes = @{}; codex_dispatches = @{}; codex_failures = 0; codex_next_attempt_utc = 0; codex_halt = ''; codex_last_finish_utc = 0;
        mail_notes = @{}; mail_dispatches = @{}; mail_failures = @{}; mail_next_attempt = @{}; mail_halts = @{}; mail_last_finish = @{} }
    foreach ($k in @($defaults.Keys)) { if (-not $s.ContainsKey($k) -or $null -eq $s[$k]) { $s[$k] = $defaults[$k] } }
    if (-not ($s.daily.mail_wakes -is [hashtable])) { $s.daily.mail_wakes = @{} }
    return $s
}

function Save-State([hashtable]$State) {
    $done = @($State.dispatches.Values | Where-Object { $_.state -ne 'running' -and $_.state -ne 'launching' } | Sort-Object { [int64]$_.seq } -Descending)
    if ($done.Count -gt 50) { foreach ($d in $done[50..($done.Count - 1)]) { [void]$State.dispatches.Remove($d.id) } }
    $old = @($State.notes.Values | Where-Object { $_.state -eq 'completed' } | Sort-Object { [int64]$_.detected_utc } -Descending)
    if ($old.Count -gt 200) { foreach ($n in $old[200..($old.Count - 1)]) { [void]$State.notes.Remove($n.id) } }
    $cdone = @($State.codex_dispatches.Values | Where-Object { $_.state -ne 'running' -and $_.state -ne 'launching' } | Sort-Object { [int64]$_.seq } -Descending)
    if ($cdone.Count -gt 50) { foreach ($d in $cdone[50..($cdone.Count - 1)]) { [void]$State.codex_dispatches.Remove($d.id) } }
    $cold = @($State.codex_notes.Values | Where-Object { $_.state -eq 'completed' } | Sort-Object { [int64]$_.detected_utc } -Descending)
    if ($cold.Count -gt 200) { foreach ($n in $cold[200..($cold.Count - 1)]) { [void]$State.codex_notes.Remove($n.id) } }
    $mdone = @($State.mail_dispatches.Values | Where-Object { $_.state -ne 'running' -and $_.state -ne 'launching' } | Sort-Object { [int64]$_.seq } -Descending)
    if ($mdone.Count -gt 50) { foreach ($d in $mdone[50..($mdone.Count - 1)]) { [void]$State.mail_dispatches.Remove($d.id) } }
    $mold = @($State.mail_notes.Values | Where-Object { $_.state -eq 'completed' } | Sort-Object { [int64]$_.detected_utc } -Descending)
    if ($mold.Count -gt 500) { foreach ($n in $mold[500..($mold.Count - 1)]) { [void]$State.mail_notes.Remove($n.id) } }
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
    if ($State.daily.date -ne $today) { $State.daily = @{ date = $today; wakes = 0; cost = 0.0; codex_wakes = 0; mail_wakes = @{} } }
    if (-not ($State.daily.mail_wakes -is [hashtable])) { $State.daily.mail_wakes = @{} }
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
    $cx = Get-CodexConfig
    if ($cx) {
        [void]$sb.AppendLine("CodexWake=ON - the relay wakes Codex thread $($cx.thread_id) with codex exec resume, once for each new item below,")
        [void]$sb.AppendLine('when no other Codex program has that thread open. This list holds everything that still waits for the planner;')
        [void]$sb.AppendLine('it is derived from questions.md, answers.md, status.md, handoff.md and review.md.')
    } else {
        [void]$sb.AppendLine('CodexWake=NOT_CONFIGURED - the relay does not wake Codex (to turn that on: bin\bridge-relay.ps1 -EnrollCodex -ThreadId <id>).')
        [void]$sb.AppendLine('Codex reads STATUS.md first on its own schedule; this list is only a hint derived from questions.md, answers.md,')
        [void]$sb.AppendLine('status.md, handoff.md and review.md.')
    }
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

function Update-Attention([hashtable]$State, [bool]$Baseline) {
    # With CodexWake on, each NEW item (not one already listed, and never at the baseline) is queued to wake Codex once.
    $cur = Get-AttentionItems
    $codexOn = [bool](Get-CodexConfig)
    $changed = $false
    foreach ($k in @($cur.Keys)) {
        if (-not $State.attention.ContainsKey($k)) {
            $State.attention[$k] = @{ task = $cur[$k].task; what = $cur[$k].what; first_seen_utc = (Get-Now) }
            $how = '(listed in .relay\codex-attention.md; CodexWake=NOT_CONFIGURED, not delivered)'
            if ($codexOn -and $Baseline) { $how = '(already waiting at the first run; listed, not sent)' }
            elseif ($codexOn) { Add-CodexWakeNote $State $k $cur[$k]; $how = '(queued to wake the Codex thread)' }
            Write-Log "Return direction: NEW for Codex - $($cur[$k].task): $($cur[$k].what) $how"
            $changed = $true
        }
    }
    foreach ($k in @($State.attention.Keys)) {
        if (-not $cur.ContainsKey($k)) {
            [void]$State.attention.Remove($k)
            $cn = $State.codex_notes[$k]
            if ($cn -and $cn.state -eq 'pending') { [void]$State.codex_notes.Remove($k) }   # resolved before it was sent
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

function Get-ClaudeListedProcesses([string]$Id) {
    # Claude Code keeps one small file per running process: <config>\sessions\<pid>.json, naming the session it has open.
    # A window started without the id on its command line (claude --name, such as a Pleni Roll over window) shows up only
    # here. A file counts only while its process runs and started no later than the file last changed: a window closed
    # with its X leaves its file behind, and Windows soon gives the number to another program. Objects with a ProcessId.
    if ($Id -notmatch '^[0-9a-fA-F-]{36}$') { return , @() }
    $dir = Join-Path $ClaudeConfigDir 'sessions'
    if (-not (Test-Path -LiteralPath $dir -PathType Container)) { return , @() }
    $found = New-Object System.Collections.ArrayList
    $files = @(Get-ChildItem -LiteralPath $dir -File -Filter '*.json' -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match '^\d{1,10}\.json$' -and $_.Length -le 65536 } | Select-Object -First 500)
    foreach ($f in $files) {
        $info = $null
        try { $info = ConvertFrom-Json -InputObject (Read-SharedText $f.FullName) } catch { continue }
        if (-not $info -or ([string]$info.sessionId).Trim().ToLowerInvariant() -ne $Id.ToLowerInvariant()) { continue }
        $procId = 0
        if (-not [int]::TryParse([string]$info.pid, [ref]$procId) -or $procId -le 0 -or $procId -eq $PID) { continue }
        $p = Get-Process -Id $procId -ErrorAction SilentlyContinue
        if (-not $p) { continue }
        $started = $null
        try { $started = $p.StartTime.ToUniversalTime() } catch { continue }
        if ($started -gt $f.LastWriteTimeUtc.AddSeconds(2)) { continue }
        [void]$found.Add([pscustomobject]@{ ProcessId = $procId; Kind = [string]$info.kind; Entrypoint = [string]$info.entrypoint })
    }
    return , $found.ToArray()
}

function Get-ClaudeOpenPids([string]$Id) {
    # Every process that has this Claude Code session open: by the id on its command line, or in Claude Code's own list.
    # $null when the process list cannot be read, which counts as open.
    $procs = Get-SessionProcesses $Id
    if ($null -eq $procs) { return $null }
    $listed = Get-ClaudeListedProcesses $Id   # held first: piped straight from the call, its list would arrive as one item
    $all = @(@($procs | ForEach-Object { [int]$_.ProcessId }) + @($listed | ForEach-Object { [int]$_.ProcessId }))
    return , @($all | Select-Object -Unique)
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
    $pids = Get-ClaudeOpenPids $Coord.session_id
    if ($null -eq $pids) { return 'the process list could not be read to confirm the session is idle' }
    if ($pids.Count -gt 0) { return ('session ' + $Coord.session_id + ' is open in pid ' + ($pids -join ',')) }
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

function Add-LedgerLine([hashtable]$D, [string]$Budget) {
    if (-not $script:CanWrite) { return }
    if (-not $Budget) { $Budget = $TurnBudgetUsd.ToString($Inv) }
    if (-not (Test-Path -LiteralPath $LedgerFile)) {
        [IO.File]::WriteAllText($LedgerFile, "| Started | Finished | Dispatch | Items | State | Outcome | Exit | Cost USD | Turns | Budget |`r`n|---|---|---|---|---|---|---|---|---|---|`r`n", $Utf8)
    }
    $outcome = [string]$D.outcome
    if ($D.error) { $outcome = $outcome + ' / ' + [string]$D.error }
    $outcome = (Get-Short $outcome 300) -replace '\|', '/'
    $line = '| {0} | {1} | {2} | {3} | {4} | {5} | {6} | {7} | {8} | {9} |' -f (Format-Unix $D.started_utc), (Format-Unix $D.finished_utc), $D.id,
        @($D.items).Count, $D.state, $outcome, $D.exit_code, $D.cost, $D.turns, $Budget
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
    if (-not $Coord) { return @{ code = 'not-enrolled'; text = 'NOT ENROLLED: no coordinator session is registered, so nothing is sent; pending notifications are kept. One-time step: bridge-relay.ps1 -Enroll -SessionName <name> (or -SessionId <uuid>)' } }
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

# ---------- Codex wake (optional; off until -EnrollCodex) ----------
# One enrolled Codex thread is woken once for each new item that waits for the planner, with
#   codex exec --json --skip-git-repo-check [codex_exec_args] resume <thread id> <notice>
# in the thread's own folder. Never two writers: it waits while another Codex program holds the thread's writer lock
# (the Codex app keeps every thread it opened until it quits fully), while a process has the thread id on its command
# line, while the thread file was written by another client in the quiet window, and while a coordinator turn runs.
function Get-CodexConfig {
    $c = $null
    try { $c = Read-Json $CodexFile } catch { $c = $null }
    if ($c -and $c.thread_id) { return $c }
    return $null
}

function Read-HeadText([string]$Path, [int]$MaxBytes) {
    $share = [IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete
    $fs = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, $share)
    try {
        $n = [int][Math]::Min([int64]$MaxBytes, $fs.Length)
        $buf = New-Object byte[] $n
        $read = 0
        while ($read -lt $n) {
            $k = $fs.Read($buf, $read, $n - $read)
            if ($k -le 0) { break }
            $read += $k
        }
        return [Text.Encoding]::UTF8.GetString($buf, 0, $read)
    } finally { $fs.Dispose() }
}

function Find-CodexRollout([string]$Id) {
    # Codex keeps each thread in <CODEX_HOME>\sessions\YYYY\MM\DD\rollout-<time>-<thread id>.jsonl (archived threads
    # move to archived_sessions). Returns @{ path; archived } or $null.
    if ($Id -notmatch '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') { return $null }
    foreach ($sub in @('sessions', 'archived_sessions')) {
        $dir = Join-Path $CodexHomeDir $sub
        if (-not (Test-Path -LiteralPath $dir -PathType Container)) { continue }
        $f = @(Get-ChildItem -LiteralPath $dir -Recurse -File -Filter "rollout-*$Id.jsonl" -ErrorAction SilentlyContinue | Select-Object -First 1)
        if ($f.Count) { return @{ path = $f[0].FullName; archived = ($sub -eq 'archived_sessions') } }
    }
    return $null
}

function Get-CodexRolloutPath($Cx) {
    # The enrolled file, or the thread's file found again (a live thread only; an archived one is not woken).
    if (-not $Cx) { return '' }
    $p = [string]$Cx.rollout_path
    if ($p -and (Test-Path -LiteralPath $p -PathType Leaf)) { return $p }
    $f = Find-CodexRollout ([string]$Cx.thread_id)
    if ($f -and -not $f.archived) { return $f.path }
    return ''
}

function Get-CodexThreadCwd([string]$Path) {
    # The first line of a thread file is its session_meta record; its payload names the thread's working folder.
    try { $head = Read-HeadText $Path 1048576 } catch { return '' }
    $line = ($head -split "`n", 2)[0]
    if ($line -notmatch '"type"\s*:\s*"session_meta"') { return '' }
    $m = [regex]::Match($line, '"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"')
    if (-not $m.Success) { return '' }
    try { return [regex]::Unescape($m.Groups[1].Value) } catch { return '' }
}

function Test-CodexThreadLocked([string]$Id) {
    # While a program writes a thread, Codex holds an operating-system lock on
    # <CODEX_HOME>\thread-writer-locks\<thread id>.lock, and Windows refuses another program's read of a locked file.
    # A refused open or read means the thread is open somewhere. The relay only reads this file.
    $f = Join-Path (Join-Path $CodexHomeDir 'thread-writer-locks') "$Id.lock"
    if (-not (Test-Path -LiteralPath $f -PathType Leaf)) { return $false }
    try {
        $fs = [IO.File]::Open($f, [IO.FileMode]::Open, [IO.FileAccess]::Read, ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
        try {
            $b = New-Object byte[] 1
            [void]$fs.Read($b, 0, 1)
            return $false
        } finally { $fs.Dispose() }
    } catch { return $true }
}

function Get-CodexExePath {
    if ($CodexExe) { return $CodexExe }
    foreach ($n in @('codex.exe', 'codex.cmd')) {
        $c = Get-Command $n -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($c) { return $c.Path }
    }
    return ''
}

function ConvertTo-SafeText([string]$Text) {
    # The notice may pass through cmd.exe (codex.cmd), so it keeps only plain characters.
    $t = [string]$Text -replace "[^A-Za-z0-9 .,:;/\\()_#@+=?'\[\]-]", ' '
    return (($t -replace '\s+', ' ').Trim())
}

function New-CodexPrompt([string]$Id, [object[]]$Batch) {
    $parts = New-Object System.Collections.Generic.List[string]
    $i = 0
    foreach ($n in $Batch) { $i++; $parts.Add(('{0}) {1}: {2}' -f $i, $n.task, $n.what)) }
    $p = "[bridge-relay $Id] Mailbox notice for the Codex planner. bin/bridge-relay.ps1 started this turn from the command line ($OwnerName did not type it). " +
        "The Claude coordinator wrote $i new item(s) for the planner: " + ($parts -join '; ') + ". " +
        "Read STATUS.md and the named task files in the mailbox $Root, then act as the planner under its README.md: " +
        'write only planner-owned files (CODEX-QUEUE.md and the tasks assignment.md, answers.md and review.md). ' +
        '.relay/codex-attention.md lists everything that still waits for the planner. Codex app thread tools may be unavailable in this turn. ' +
        'Do not invent tasks. If nothing is actionable, change nothing. End with a one to three sentence summary.'
    return (ConvertTo-SafeText $p)
}

function Get-CodexArguments([hashtable]$Cx, [string]$Prompt) {
    $a = New-Object System.Collections.Generic.List[string]
    foreach ($x in @('exec', '--json', '--skip-git-repo-check')) { $a.Add($x) }
    foreach ($x in $CodexArgs) { $a.Add([string]$x) }
    foreach ($x in @('resume', [string]$Cx.thread_id, $Prompt)) { $a.Add([string]$x) }
    return , $a
}

function Get-CodexCommandLine([string[]]$Prefix, [hashtable]$Cx, [string]$Prompt) {
    # The argument string for Start-Process. The list goes through a variable: @(<function>) would keep it as one item.
    $cliArgs = Get-CodexArguments $Cx $Prompt
    return ((@($Prefix) + @($cliArgs)) | ForEach-Object { ConvertTo-ArgToken $_ }) -join ' '
}

function Get-CodexPreflightError([hashtable]$Cx, [string]$Reenroll = '-EnrollCodex') {
    if ($CodexArgsError) { return $CodexArgsError }
    $exe = Get-CodexExePath
    if (-not $exe) { return 'the Codex CLI was not found (install it, or set codex_exe in bin\relay-settings.json)' }
    if (-not [IO.Path]::IsPathRooted($exe)) { return "codex_exe must be a full path (got $exe)" }
    if ($exe -match '\.js$') {
        if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) { return "stub Codex CLI not found at $exe" }
        if (-not (Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue)) { return 'node.exe not found (needed only for a .js stub CLI)' }
    } elseif (-not (Test-Path -LiteralPath $exe -PathType Leaf)) {
        return "the Codex CLI was not found at $exe"
    }
    if (-not $Cx.cwd -or -not (Test-Path -LiteralPath ([string]$Cx.cwd) -PathType Container)) { return "the Codex thread's folder was not found: $($Cx.cwd)" }
    if (-not (Get-CodexRolloutPath $Cx)) {
        $f = Find-CodexRollout ([string]$Cx.thread_id)
        if ($f -and $f.archived) { return "Codex thread $($Cx.thread_id) is archived; unarchive it in Codex, or enroll another thread" }
        return "Codex thread $($Cx.thread_id) was not found under $CodexHomeDir\sessions; re-enroll with $Reenroll"
    }
    return ''
}

function Set-CodexEnvironment {
    # Process-local only: the Codex turn uses the saved ChatGPT sign-in, never an inherited API key or endpoint.
    $previous = @{}
    foreach ($name in @('OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_ORG_ID', 'OPENAI_PROJECT_ID', 'CODEX_HOME')) {
        $previous[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
        [Environment]::SetEnvironmentVariable($name, $null, 'Process')
    }
    [Environment]::SetEnvironmentVariable('CODEX_HOME', $CodexHomeDir, 'Process')
    return $previous
}

function Read-CodexEvents([string]$Path) {
    # codex exec --json writes one event per line: thread.started, turn.started, item.*, turn.completed, turn.failed, error.
    $r = @{ any = $false; thread = ''; completed = $false; failed = ''; error = ''; message = '' }
    if (-not $Path -or -not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $r }
    $raw = ''
    try { $raw = Read-SharedText $Path } catch { return $r }
    foreach ($line in ($raw -split "`r?`n")) {
        $l = $line.Trim()
        if (-not $l.StartsWith('{')) { continue }
        $e = $null
        try { $e = ConvertTo-HT (ConvertFrom-Json -InputObject $l) } catch { continue }
        if (-not ($e -is [hashtable])) { continue }
        $r.any = $true
        $type = [string]$e['type']
        if ($type -eq 'thread.started') { $r.thread = ([string]$e['thread_id']).ToLowerInvariant() }
        elseif ($type -eq 'turn.completed') { $r.completed = $true }
        elseif ($type -eq 'turn.failed') {
            $m = ''
            if ($e['error'] -is [hashtable]) { $m = [string]$e['error']['message'] }
            if (-not $m) { $m = 'the turn failed' }
            $r.failed = $m
        } elseif ($type -eq 'error') { $r.error = [string]$e['message'] }
        elseif ($type -eq 'item.completed' -and $e['item'] -is [hashtable]) {
            $it = $e['item']
            $kind = [string]$it['type']
            if (-not $kind) { $kind = [string]$it['item_type'] }
            if ($kind -eq 'agent_message' -and $it['text']) { $r.message = [string]$it['text'] }
        }
    }
    return $r
}

function Test-CodexMarker([hashtable]$D) {
    # True when the wake's marker is in the thread file: Codex accepted the notice into the thread.
    $t = [string]$D.rollout
    if (-not $t -or -not (Test-Path -LiteralPath $t -PathType Leaf)) { return $false }
    try { return ((Read-TailText $t 8388608).IndexOf("[bridge-relay $($D.id)]", [StringComparison]::Ordinal) -ge 0) } catch { return $false }
}

function Add-CodexWakeNote([hashtable]$State, [string]$Key, [hashtable]$Item) {
    $State.codex_notes[$Key] = @{ id = $Key; key = $Key; task = [string]$Item.task; what = [string]$Item.what; state = 'pending'; detected_utc = (Get-Now);
        dispatch_id = ''; attempts = 0; outcome = ''; accepted_utc = 0; completed_utc = 0 }
}

function Set-CodexItemsDone([hashtable]$State, [hashtable]$D, [string]$Outcome) {
    $now = Get-Now
    foreach ($nid in @($D.items)) {
        $n = $State.codex_notes[$nid]
        if ($n -and $n.dispatch_id -eq $D.id) {
            $n.state = 'completed'; $n.outcome = $Outcome; $n.completed_utc = $now
            if (-not $n.accepted_utc) { $n.accepted_utc = $now }
        }
    }
}

function Add-CodexBackoff([hashtable]$State) {
    $State.codex_failures = [int]$State.codex_failures + 1
    $delay = [Math]::Min(3600, $BackoffSeconds * [Math]::Pow(2, [int]$State.codex_failures - 1))
    $State.codex_next_attempt_utc = (Get-Now) + [int64]$delay
}

function Set-CodexHalt([hashtable]$State, [string]$Reason, [string]$Message) {
    $State.codex_halt = $Reason
    Add-Alert $State '' "$Message Claude wakes go on. Fix the cause, then run bridge-relay.ps1 -ClearHalt."
}

function Set-CodexDispatchFailed([hashtable]$State, [hashtable]$D, [string]$Message) {
    $D.state = 'failed'; $D.error = $Message; $D.finished_utc = Get-Now; $D.outcome = 'not delivered'
    foreach ($nid in @($D.items)) {
        $n = $State.codex_notes[$nid]
        if ($n -and $n.dispatch_id -eq $D.id) { $n.state = 'pending'; $n.dispatch_id = ''; $n.outcome = "previous attempt not delivered: $Message" }
    }
    Add-CodexBackoff $State
    Write-Log ('Codex wake {0} FAILED (not delivered): {1}. {2} item(s) kept pending; failure {3}/{4}; next attempt not before {5}.' -f
        $D.id, $Message, @($D.items).Count, $State.codex_failures, $MaxFailures, (Format-Unix $State.codex_next_attempt_utc))
    if ([int]$State.codex_failures -ge $MaxFailures) {
        Set-CodexHalt $State "$($State.codex_failures) consecutive Codex wake failures; last: $Message" "Codex wakes stopped after $($State.codex_failures) failures in a row. Last error: $Message. Pending items for Codex are kept."
    }
    Add-LedgerLine $D '-'
    Remove-DispatchFiles $D
}

function Get-CodexBusyReason([hashtable]$State, [hashtable]$Cx) {
    foreach ($d in @($State.codex_dispatches.Values)) {
        if ($d.state -eq 'running' -or $d.state -eq 'launching') { return "relay Codex wake $($d.id) is still running (pid $($d.pid))" }
    }
    $tid = [string]$Cx.thread_id
    foreach ($d in @($State.mail_dispatches.Values)) {
        if (($d.state -eq 'running' -or $d.state -eq 'launching') -and [string]$d.thread_id -eq $tid) { return "the relay's mail wake $($d.id) is still running in this thread (pid $($d.pid))" }
    }
    if (Test-CodexThreadLocked $tid) { return "another Codex program has thread $tid open (most likely the Codex app, which keeps every thread it opened until it quits fully)" }
    $procs = Get-SessionProcesses $tid
    if ($null -eq $procs) { return 'the process list could not be read to confirm the thread is idle' }
    if ($procs.Count -gt 0) { return ('thread ' + $tid + ' is open in pid ' + (($procs | ForEach-Object { $_.ProcessId }) -join ',')) }
    $roll = Get-CodexRolloutPath $Cx
    if ($QuietSeconds -gt 0 -and $roll) {
        $tw = ConvertTo-Unix (Get-Item -LiteralPath $roll).LastWriteTimeUtc
        $now = Get-Now
        if ($tw -gt ($now - $QuietSeconds) -and $tw -gt ([int64]$State.codex_last_finish_utc + 15)) {
            return "the thread file was written $($now - $tw) s ago by another client (quiet window $QuietSeconds s)"
        }
    }
    return ''
}

function Get-CodexBlockReason([hashtable]$State, [hashtable]$Cx, [object[]]$Pending) {
    $now = Get-Now
    if (Test-Path -LiteralPath $PauseFile) { return @{ code = 'paused'; text = "PAUSED ($PauseFile exists); pending items are kept" } }
    if ($State.codex_halt) { return @{ code = 'halted'; text = "Codex wakes STOPPED: $($State.codex_halt). Pending items are kept; check .relay\alerts.md, then run -ClearHalt" } }
    foreach ($d in @($State.dispatches.Values)) {
        if ($d.state -eq 'running' -or $d.state -eq 'launching') { return @{ code = 'coordinator-turn'; text = "a coordinator turn is still running ($($d.id)); the planner is woken after it ends, so it reads finished work" } }
    }
    $newest = [int64](@($Pending | ForEach-Object { [int64]$_.detected_utc }) | Measure-Object -Maximum).Maximum
    if ($DebounceSeconds -gt 0 -and ($now - $newest) -lt $DebounceSeconds) { return @{ code = 'settling'; text = "settling: an item for Codex appeared less than $DebounceSeconds s ago (debounce)" } }
    if ($State.codex_next_attempt_utc -and $now -lt [int64]$State.codex_next_attempt_utc) {
        return @{ code = 'backoff'; text = "backoff after Codex failure $($State.codex_failures)/$MaxFailures; next attempt not before $(Format-Unix $State.codex_next_attempt_utc)" }
    }
    if ($MaxCodexWakesPerDay -gt 0 -and [int]$State.daily.codex_wakes -ge $MaxCodexWakesPerDay) {
        Add-Alert $State ('cap-codex-' + $State.daily.date) "Daily Codex wake limit reached ($MaxCodexWakesPerDay planner turns). Items for Codex stay queued until tomorrow. Possible loop: check .relay\relay.log."
        return @{ code = 'cap-codex'; text = "daily Codex wake limit reached ($([int]$State.daily.codex_wakes)/$MaxCodexWakesPerDay)" }
    }
    $busy = Get-CodexBusyReason $State $Cx
    if ($busy) { return @{ code = 'busy'; text = "Codex thread busy: $busy. Queued; no new process" } }
    return $null
}

function Start-CodexProcess([hashtable]$Target, [string]$Prompt, [string]$Stdin, [string]$Out, [string]$Err) {
    # Checks the ChatGPT sign-in, then starts codex exec resume for $Target (its thread_id, in its cwd) in its own hidden
    # console. Returns @{ proc; error }: the process, or a plain reason it did not start.
    $exe = Get-CodexExePath
    $file = $exe
    $prefix = @()
    if ($exe -match '\.js$') {
        $file = (Get-Command node.exe -CommandType Application | Select-Object -First 1).Path
        $prefix = @($exe)
    }
    $argString = Get-CodexCommandLine $prefix $Target $Prompt
    $proc = $null
    $launchError = ''
    $previousEnvironment = $null
    try {
        try {
            $previousEnvironment = Set-CodexEnvironment
            # 'codex login status' reports the saved sign-in, on stderr in some versions; capture both as plain text.
            $probePreference = $ErrorActionPreference
            try {
                $ErrorActionPreference = 'Continue'
                $signIn = ((& $file @prefix login status 2>&1) | ForEach-Object { [string]$_ }) -join ' '
                $signInExit = $LASTEXITCODE
            } finally { $ErrorActionPreference = $probePreference }
            if ($signInExit -ne 0 -or $signIn -notmatch '(?i)chatgpt' -or $signIn -match '(?i)api key') {
                $launchError = 'Codex is not signed in with ChatGPT; run codex login and choose ChatGPT (the relay never uses an API key)'
            }
        } catch { $launchError = 'could not check the Codex sign-in (the relay never uses an API key)' }
        if (-not $launchError) {
            try {
                # Hidden own console: Ctrl+C in the relay window must never reach the Codex turn.
                $proc = Start-Process -FilePath $file -ArgumentList $argString -WorkingDirectory ([string]$Target.cwd) -WindowStyle Hidden -PassThru `
                    -RedirectStandardInput $Stdin -RedirectStandardOutput $Out -RedirectStandardError $Err
            } catch { $launchError = 'could not start the Codex CLI: ' + $_.Exception.Message }
        }
    } finally {
        Restore-SubscriptionEnvironment $previousEnvironment
    }
    if (-not $launchError -and -not $proc) { $launchError = 'could not start the Codex CLI (no process returned)' }
    return @{ proc = $proc; error = $launchError }
}

function Start-CodexDispatch([hashtable]$State, [hashtable]$Cx, [object[]]$Pending) {
    $script:LastCodexLaunched = $null
    $now = Get-Now
    if (-not (Test-Path -LiteralPath $DispatchDir)) { New-Item -ItemType Directory -Path $DispatchDir -Force | Out-Null }
    $id = 'C' + (Get-Date).ToString('yyyyMMdd-HHmmss', $Inv) + '-' + [guid]::NewGuid().ToString('N').Substring(0, 4)
    $batch = @($Pending | Select-Object -First 10)
    $prompt = New-CodexPrompt $id $batch
    $promptFile = Join-Path $DispatchDir "$id.prompt.txt"
    $stdin = Join-Path $DispatchDir "$id.stdin.txt"
    $out = Join-Path $DispatchDir "$id.out.jsonl"
    $err = Join-Path $DispatchDir "$id.err.txt"
    [IO.File]::WriteAllText($promptFile, $prompt, $Utf8)
    [IO.File]::WriteAllText($stdin, '', $Utf8)
    $State.seq = [int64]$State.seq + 1
    $d = @{ id = $id; seq = $State.seq; target = 'codex'; state = 'launching'; items = @($batch | ForEach-Object { $_.id }); started_utc = $now; finished_utc = 0;
        thread_id = [string]$Cx.thread_id; rollout = (Get-CodexRolloutPath $Cx); cwd = [string]$Cx.cwd; pid = 0; proc_start = '';
        out = $out; err = $err; stdin = $stdin; prompt_file = $promptFile; accepted_utc = 0; exit_code = $null; outcome = ''; error = '';
        result_thread = ''; summary = ''; billing = 'chatgpt-sign-in' }
    $State.codex_dispatches[$id] = $d
    foreach ($n in $batch) { $n.state = 'launched'; $n.dispatch_id = $id; $n.attempts = [int]$n.attempts + 1 }
    Save-State $State   # write-ahead, as for coordinator turns

    $pf = Get-CodexPreflightError $Cx
    if ($pf) { Set-CodexDispatchFailed $State $d $pf; return }

    $started = Start-CodexProcess $Cx $prompt $stdin $out $err
    if ($started.error) {
        Set-CodexDispatchFailed $State $d $started.error
        return
    }
    $proc = $started.proc
    try { $null = $proc.Handle } catch { }   # keep a handle so the exit code stays readable
    $d.pid = $proc.Id
    try { $d.proc_start = [string]$proc.StartTime.ToUniversalTime().Ticks } catch { $d.proc_start = '' }
    $d.state = 'running'
    $State.daily.codex_wakes = [int]$State.daily.codex_wakes + 1
    $script:Procs[$id] = $proc
    $script:LastCodexLaunched = $id
    [void]$State.flags.Remove('last_codex_block')
    Save-State $State
    Write-Log ('Woke Codex thread {0} with {1} (pid {2}; {3} item(s)): {4}' -f $Cx.thread_id, $id, $proc.Id, $batch.Count,
        (($batch | ForEach-Object { "$($_.task): $($_.what)" }) -join '; '))
}

function Complete-CodexDispatch([hashtable]$State, [hashtable]$D) {
    $now = Get-Now
    $exit = $null
    if ($script:Procs.ContainsKey($D.id)) {
        $p = $script:Procs[$D.id]
        try { $p.WaitForExit(); $exit = $p.ExitCode } catch { }
        [void]$script:Procs.Remove($D.id)
    }
    $D.exit_code = $exit
    $ev = Read-CodexEvents $D.out
    $marker = Test-CodexMarker $D
    $errText = ''
    try { if ($D.err -and (Test-Path -LiteralPath $D.err)) { $errText = Get-Short (Read-SharedText $D.err) 300 } } catch { }
    $D.finished_utc = $now
    $D.result_thread = $ev.thread
    if ($ev.message) { $D.summary = Get-Short $ev.message 300 }
    $State.codex_last_finish_utc = $now
    $enrolled = ([string]$D.thread_id).ToLowerInvariant()
    if ($ev.thread -and $ev.thread -ne $enrolled) {
        $D.state = 'completed'
        $D.outcome = "THREAD MISMATCH: Codex used $($ev.thread), enrolled is $enrolled"
        Set-CodexItemsDone $State $D 'delivered to a different thread; not replayed'
        Set-CodexHalt $State "thread mismatch on $($D.id): Codex reported thread $($ev.thread) instead of the enrolled $enrolled" "Codex wakes stopped: wake $($D.id) ran in Codex thread $($ev.thread), not the enrolled $enrolled. Check the enrollment (-EnrollCodex)."
    } elseif ($ev.completed -and -not $ev.failed) {
        $D.state = 'completed'
        $D.outcome = 'success'
        Set-CodexItemsDone $State $D 'completed: the planner turn ended successfully'
        $State.codex_failures = 0
        $State.codex_next_attempt_utc = 0
    } elseif (-not $marker) {
        $msg = "Codex ended without a result (exit $exit)"
        if ($ev.failed) { $msg = "the Codex turn failed before the notice reached the thread: $($ev.failed)" }
        elseif ($ev.error) { $msg = "Codex reported an error before the notice reached the thread: $($ev.error)" }
        if ($errText) { $msg += ": $errText" }
        Set-CodexDispatchFailed $State $D $msg
        return
    } elseif ($ev.failed -or $ev.error) {
        $D.state = 'completed'
        $D.outcome = 'turn ended with an error; delivered, not replayed'
        $D.error = Get-Short ("$($ev.failed) $($ev.error)") 300
        Set-CodexItemsDone $State $D 'delivered; the turn ended with an error; not replayed'
        Add-CodexBackoff $State
        Add-Alert $State '' "Codex planner turn $($D.id) ended with an error: $($D.error). Not replayed."
        if ([int]$State.codex_failures -ge $MaxFailures) {
            Set-CodexHalt $State "$($State.codex_failures) consecutive failed Codex turns" "Codex wakes stopped after $($State.codex_failures) failed planner turns in a row."
        }
    } else {
        $D.state = 'completed'
        $D.outcome = 'unknown: Codex ended without a result, but the notice is in the thread (delivered; not replayed)'
        if ($errText) { $D.error = $errText }
        Set-CodexItemsDone $State $D 'delivered; outcome unknown (not replayed)'
        Add-Alert $State '' "Codex planner turn $($D.id) ended without a result (exit $exit) after its notice reached the thread. Not replayed. Check the planner's files."
    }
    Write-Log ('Codex wake {0} {1}: {2}; exit {3}' -f $D.id, $D.state, $D.outcome, $exit)
    Add-LedgerLine $D '-'
    Remove-DispatchFiles $D
}

function Update-CodexDispatches([hashtable]$State) {
    foreach ($d in @($State.codex_dispatches.Values | Where-Object { $_.state -eq 'running' -or $_.state -eq 'launching' })) {
        if ($d.state -eq 'launching' -and -not $d.pid) {
            # The relay stopped after the write-ahead but before it recorded a process id.
            $ps = Get-SessionProcesses $d.thread_id
            if ($ps -and $ps.Count -gt 0) {
                $d.pid = [int]$ps[0].ProcessId
                $d.state = 'running'
                Write-Log "Recovered Codex wake $($d.id): a process (pid $($d.pid)) has the thread open; waiting for it, never killing it"
                continue
            }
            if (-not (Test-Path -LiteralPath $d.out) -and -not (Test-CodexMarker $d)) {
                $d.state = 'abandoned'
                $d.finished_utc = Get-Now
                $d.outcome = 'the relay stopped before the Codex CLI started; items re-queued'
                foreach ($nid in @($d.items)) { $n = $State.codex_notes[$nid]; if ($n -and $n.dispatch_id -eq $d.id) { $n.state = 'pending'; $n.dispatch_id = '' } }
                Write-Log "Codex wake $($d.id) never started (the relay stopped first); $(@($d.items).Count) item(s) re-queued"
                Add-LedgerLine $d '-'
                continue
            }
        }
        if ($d.state -eq 'launching') { $d.state = 'running' }
        if (Test-DispatchAlive $d) {
            if (-not $d.accepted_utc -and (Test-CodexMarker $d)) {
                $d.accepted_utc = Get-Now
                foreach ($nid in @($d.items)) { $n = $State.codex_notes[$nid]; if ($n -and $n.state -eq 'launched') { $n.state = 'accepted'; $n.accepted_utc = $d.accepted_utc } }
                Write-Log "Codex wake $($d.id) accepted: the notice is in thread $($d.thread_id); the turn is still running"
            }
            $mins = [int][Math]::Floor(((Get-Now) - [int64]$d.started_utc) / 60)
            if ($mins -ge $WaitMinutes) {
                Add-Alert $State ('long:' + $d.id) "Codex planner turn $($d.id) is still running after $mins min (pid $($d.pid)). The relay never kills it; new items for Codex stay queued."
            }
            continue
        }
        Complete-CodexDispatch $State $d
    }
}

function Invoke-CodexTick([hashtable]$State, [bool]$ReadOnly) {
    $cx = Get-CodexConfig
    if (-not $cx) { return }
    $pending = @($State.codex_notes.Values | Where-Object { $_.state -eq 'pending' } | Sort-Object { [int64]$_.detected_utc })
    if ($pending.Count -eq 0) {
        [void]$State.flags.Remove('last_codex_block')
        if ($ReadOnly) { Write-Note 'DRY-RUN: nothing to wake Codex for.' }
        return
    }
    $why = Get-CodexBlockReason $State $cx $pending
    if ($why) {
        $text = "$($pending.Count) item(s) for Codex queued, not sent: $($why.text)"
        if ($ReadOnly) { Write-Note "DRY-RUN: would not wake Codex now. $text" }
        elseif ($State.flags['last_codex_block'] -ne $why.code) { $State.flags['last_codex_block'] = $why.code; Write-Log $text }
        else { Write-Note $text }
        return
    }
    if ($ReadOnly) {
        $batch = @($pending | Select-Object -First 10)
        $prompt = New-CodexPrompt 'C-dry-run' $batch
        Write-Note ('DRY-RUN: would wake Codex thread {0} with {1} item(s) (cwd {2}). Nothing started, nothing written.' -f $cx.thread_id, $batch.Count, $cx.cwd)
        Write-Host ('  command: ' + (Get-CodexExePath) + ' ' + (Get-CodexCommandLine @() $cx $prompt))
        return
    }
    Start-CodexDispatch $State $cx $pending
}

# ---------- agent mail (optional; off until -EnrollAgent) ----------
# Agents send each other messages with bin\agent-mail.ps1: one file per message in mail\<name key>\new, moved to
# mail\<name key>\read once the agent has read it. For each enrolled agent (a Codex thread followed by its name, kept in
# .relay\agents.json), new mail wakes the thread once, with the same codex exec resume command as the planner wake, in
# the thread's own folder. One turn at a time per agent and at most -MaxAgentTurnsAtOnce at once, never while another
# program has the thread open. Mail the agent read by itself (agent-mail.ps1 -Wait or -Read in its own window) needs
# no wake. The relay only reads mail; it creates an enrolled agent's empty mail folder and never moves a message.
$AgentNameRe = "^[A-Za-z0-9][A-Za-z0-9 ._#+'-]{0,79}$"

function Get-AgentCleanName([string]$Name) {
    $t = (([string]$Name) -replace '\s+', ' ').Trim()
    return $t.Trim([char[]]@('*', '_', '`', '"', "'", ' '))
}

function Get-AgentKey([string]$Name) {
    # The agent's mail folder name, made the same way as in bin\agent-mail.ps1.
    return ((Get-AgentCleanName $Name).ToLowerInvariant() -replace '[^a-z0-9]+', '-').Trim('-')
}

function Get-Agents {
    $a = $null
    try { $a = Read-Json $AgentsFile } catch { $a = $null }
    if ($a -is [hashtable]) { return $a }
    return @{}
}

function Get-AgentNewMail([string]$Key) {
    $dir = Join-Path (Join-Path $MailDir $Key) 'new'
    if (-not (Test-Path -LiteralPath $dir -PathType Container)) { return , @() }
    return , @(Get-ChildItem -LiteralPath $dir -File -Filter '*.md' -ErrorAction SilentlyContinue | Sort-Object Name)
}

function Get-MailSender([string]$Path) {
    $head = ''
    try { $head = Read-HeadText $Path 4096 } catch { return '' }
    $m = [regex]::Match($head, '(?m)^From:[ \t]*([^\r\n]+)')
    if ($m.Success) { return (Get-Short $m.Groups[1].Value 80) }
    return ''
}

function Update-Mail([hashtable]$State, [hashtable]$Agents, [bool]$Known) {
    # New messages for enrolled agents become pending notes (with $Known, they count as already seen). A pending note
    # whose file has left new\ was read by the agent itself, so it needs no wake.
    $now = Get-Now
    foreach ($key in @($Agents.Keys)) {
        $present = @{}
        $files = Get-AgentNewMail $key
        foreach ($f in $files) {
            $id = "$key/$($f.Name)"
            $present[$id] = $true
            if ($State.mail_notes.ContainsKey($id)) { continue }
            $n = @{ id = $id; agent = $key; file = $f.Name; from = (Get-MailSender $f.FullName); state = 'pending'; detected_utc = $now;
                dispatch_id = ''; attempts = 0; outcome = ''; accepted_utc = 0; completed_utc = 0 }
            if ($Known) { $n.state = 'completed'; $n.outcome = 'waiting when the agent was enrolled (counted as known)'; $n.completed_utc = $now }
            $State.mail_notes[$id] = $n
        }
        foreach ($n in @($State.mail_notes.Values | Where-Object { $_.agent -eq $key -and $_.state -eq 'pending' })) {
            if (-not $present.ContainsKey($n.id)) { $n.state = 'completed'; $n.outcome = 'read by the agent before a wake'; $n.completed_utc = $now }
        }
    }
}

function Get-AgentBusyReason([hashtable]$State, [hashtable]$Ag) {
    $tid = [string]$Ag.thread_id
    foreach ($d in @($State.mail_dispatches.Values)) {
        if (($d.state -eq 'running' -or $d.state -eq 'launching') -and ($d.agent -eq $Ag.key -or [string]$d.thread_id -eq $tid)) {
            return "relay mail wake $($d.id) is still running (pid $($d.pid))"
        }
    }
    foreach ($d in @($State.codex_dispatches.Values)) {
        if (($d.state -eq 'running' -or $d.state -eq 'launching') -and [string]$d.thread_id -eq $tid) { return "the relay's planner wake $($d.id) is still running in this thread (pid $($d.pid))" }
    }
    if (Test-CodexThreadLocked $tid) { return "another Codex program has thread $tid open (the Codex app, or a window)" }
    $procs = Get-SessionProcesses $tid
    if ($null -eq $procs) { return 'the process list could not be read to confirm the thread is idle' }
    if ($procs.Count -gt 0) { return ('thread ' + $tid + ' is open in pid ' + (($procs | ForEach-Object { $_.ProcessId }) -join ',')) }
    $roll = Get-CodexRolloutPath $Ag
    if ($QuietSeconds -gt 0 -and $roll) {
        $tw = ConvertTo-Unix (Get-Item -LiteralPath $roll).LastWriteTimeUtc
        $now = Get-Now
        $mine = [int64]$State.mail_last_finish[[string]$Ag.key]
        $cx = Get-CodexConfig
        if ($cx -and [string]$cx.thread_id -eq $tid) { $mine = [Math]::Max($mine, [int64]$State.codex_last_finish_utc) }
        if ($tw -gt ($now - $QuietSeconds) -and $tw -gt ($mine + 15)) {
            return "the thread file was written $($now - $tw) s ago by another client (quiet window $QuietSeconds s)"
        }
    }
    return ''
}

function Get-AgentBlockReason([hashtable]$State, [hashtable]$Ag, [object[]]$Pending, [int]$Running) {
    $now = Get-Now
    $key = [string]$Ag.key
    if (Test-Path -LiteralPath $PauseFile) { return @{ code = 'paused'; text = "PAUSED ($PauseFile exists); the mail is kept" } }
    if ($State.mail_halts[$key]) { return @{ code = 'halted'; text = "mail wakes for $($Ag.name) STOPPED: $($State.mail_halts[$key]). Check .relay\alerts.md, then run -ClearHalt" } }
    $newest = [int64](@($Pending | ForEach-Object { [int64]$_.detected_utc }) | Measure-Object -Maximum).Maximum
    if ($DebounceSeconds -gt 0 -and ($now - $newest) -lt $DebounceSeconds) { return @{ code = 'settling'; text = "settling: mail arrived less than $DebounceSeconds s ago (debounce)" } }
    $next = [int64]$State.mail_next_attempt[$key]
    if ($next -and $now -lt $next) {
        return @{ code = 'backoff'; text = "backoff after failure $([int]$State.mail_failures[$key])/$MaxFailures; next attempt not before $(Format-Unix $next)" }
    }
    $today = [int]$State.daily.mail_wakes[$key]
    if ($MaxAgentWakesPerDay -gt 0 -and $today -ge $MaxAgentWakesPerDay) {
        Add-Alert $State ('cap-mail-' + $key + '-' + $State.daily.date) "Daily mail wake limit reached for $($Ag.name) ($MaxAgentWakesPerDay turns). Its mail stays queued until tomorrow. Possible loop: check .relay\relay.log."
        return @{ code = 'cap'; text = "daily mail wake limit reached ($today/$MaxAgentWakesPerDay)" }
    }
    $busy = Get-AgentBusyReason $State $Ag
    if ($busy) { return @{ code = 'busy'; text = "$busy. Queued; no new process" } }
    if ($Running -ge $MaxAgentTurnsAtOnce) { return @{ code = 'at-once'; text = "$Running agent turn(s) already run (at most $MaxAgentTurnsAtOnce at once)" } }
    return $null
}

function New-MailPrompt([string]$Id, [hashtable]$Ag, [object[]]$Batch) {
    $name = [string]$Ag.name
    $senders = @($Batch | ForEach-Object { [string]$_.from } | Where-Object { $_ } | Select-Object -Unique)
    $who = ''
    if ($senders.Count) { $who = ' from ' + ($senders -join ', ') }
    $tool = Join-Path $Root 'bin\agent-mail.ps1'
    $p = "[bridge-relay $Id] Agent mail for $name. bin/bridge-relay.ps1 started this turn from the command line ($OwnerName did not type it). " +
        "$($Batch.Count) new message(s) wait for you$who. Read them first with: powershell -NoProfile -ExecutionPolicy Bypass -File '$tool' -Read -Me '$name' . " +
        "Then act on them under your standing orders. To answer or report, run the same command with -Send -From '$name' -To 'the agent name' -Text 'your message' " +
        'in place of -Read and -Me, or with -TextFile and the path of a file that holds a long message. Codex app thread tools may be unavailable in this turn. ' +
        'End with a one to three sentence summary.'
    return (ConvertTo-SafeText $p)
}

function Set-MailItemsDone([hashtable]$State, [hashtable]$D, [string]$Outcome) {
    $now = Get-Now
    foreach ($nid in @($D.items)) {
        $n = $State.mail_notes[$nid]
        if ($n -and $n.dispatch_id -eq $D.id) {
            $n.state = 'completed'; $n.outcome = $Outcome; $n.completed_utc = $now
            if (-not $n.accepted_utc) { $n.accepted_utc = $now }
        }
    }
}

function Add-MailBackoff([hashtable]$State, [string]$Key) {
    $f = [int]$State.mail_failures[$Key] + 1
    $State.mail_failures[$Key] = $f
    $delay = [Math]::Min(3600, $BackoffSeconds * [Math]::Pow(2, $f - 1))
    $State.mail_next_attempt[$Key] = (Get-Now) + [int64]$delay
}

function Set-MailHalt([hashtable]$State, [string]$Key, [string]$Reason, [string]$Message) {
    $State.mail_halts[$Key] = $Reason
    Add-Alert $State '' "$Message Other wakes go on. Fix the cause, then run bridge-relay.ps1 -ClearHalt."
}

function Set-MailDispatchFailed([hashtable]$State, [hashtable]$D, [string]$Message) {
    $D.state = 'failed'; $D.error = $Message; $D.finished_utc = Get-Now; $D.outcome = 'not delivered'
    foreach ($nid in @($D.items)) {
        $n = $State.mail_notes[$nid]
        if ($n -and $n.dispatch_id -eq $D.id) { $n.state = 'pending'; $n.dispatch_id = ''; $n.outcome = "previous attempt not delivered: $Message" }
    }
    $key = [string]$D.agent
    Add-MailBackoff $State $key
    Write-Log ('Mail wake {0} for {1} FAILED (not delivered): {2}. {3} message(s) kept; failure {4}/{5}; next attempt not before {6}.' -f
        $D.id, $D.name, $Message, @($D.items).Count, $State.mail_failures[$key], $MaxFailures, (Format-Unix $State.mail_next_attempt[$key]))
    if ([int]$State.mail_failures[$key] -ge $MaxFailures) {
        Set-MailHalt $State $key "$($State.mail_failures[$key]) consecutive failures; last: $Message" "Mail wakes for $($D.name) stopped after $($State.mail_failures[$key]) failures in a row. Last error: $Message. Its mail is kept."
    }
    Add-LedgerLine $D '-'
    Remove-DispatchFiles $D
}

function Start-MailDispatch([hashtable]$State, [hashtable]$Ag, [object[]]$Pending) {
    $now = Get-Now
    if (-not (Test-Path -LiteralPath $DispatchDir)) { New-Item -ItemType Directory -Path $DispatchDir -Force | Out-Null }
    $id = 'M' + (Get-Date).ToString('yyyyMMdd-HHmmss', $Inv) + '-' + [guid]::NewGuid().ToString('N').Substring(0, 4)
    $batch = @($Pending | Select-Object -First 20)
    $prompt = New-MailPrompt $id $Ag $batch
    $promptFile = Join-Path $DispatchDir "$id.prompt.txt"
    $stdin = Join-Path $DispatchDir "$id.stdin.txt"
    $out = Join-Path $DispatchDir "$id.out.jsonl"
    $err = Join-Path $DispatchDir "$id.err.txt"
    [IO.File]::WriteAllText($promptFile, $prompt, $Utf8)
    [IO.File]::WriteAllText($stdin, '', $Utf8)
    $State.seq = [int64]$State.seq + 1
    $d = @{ id = $id; seq = $State.seq; target = 'mail'; agent = [string]$Ag.key; name = [string]$Ag.name; state = 'launching';
        items = @($batch | ForEach-Object { $_.id }); started_utc = $now; finished_utc = 0;
        thread_id = [string]$Ag.thread_id; rollout = (Get-CodexRolloutPath $Ag); cwd = [string]$Ag.cwd; pid = 0; proc_start = '';
        out = $out; err = $err; stdin = $stdin; prompt_file = $promptFile; accepted_utc = 0; exit_code = $null; outcome = ''; error = '';
        result_thread = ''; summary = ''; billing = 'chatgpt-sign-in' }
    $State.mail_dispatches[$id] = $d
    foreach ($n in $batch) { $n.state = 'launched'; $n.dispatch_id = $id; $n.attempts = [int]$n.attempts + 1 }
    Save-State $State   # write-ahead, as for the other turns
    $pf = Get-CodexPreflightError $Ag '-EnrollAgent'
    if ($pf) { Set-MailDispatchFailed $State $d $pf; return }
    $started = Start-CodexProcess $Ag $prompt $stdin $out $err
    if ($started.error) { Set-MailDispatchFailed $State $d $started.error; return }
    $proc = $started.proc
    try { $null = $proc.Handle } catch { }   # keep a handle so the exit code stays readable
    $d.pid = $proc.Id
    try { $d.proc_start = [string]$proc.StartTime.ToUniversalTime().Ticks } catch { $d.proc_start = '' }
    $d.state = 'running'
    $State.daily.mail_wakes[[string]$Ag.key] = [int]$State.daily.mail_wakes[[string]$Ag.key] + 1
    $script:Procs[$id] = $proc
    [void]$script:MailLaunched.Add($id)
    [void]$State.flags.Remove('last_mail_block_' + $Ag.key)
    Save-State $State
    Write-Log ('Woke agent {0} (Codex thread {1}) with {2} (pid {3}) for {4} message(s){5}' -f $Ag.name, $Ag.thread_id, $id, $proc.Id, $batch.Count,
        $(if (@($batch | Where-Object { $_.from }).Count) { ' from ' + ((@($batch | ForEach-Object { $_.from } | Where-Object { $_ } | Select-Object -Unique)) -join ', ') } else { '' }))
}

function Complete-MailDispatch([hashtable]$State, [hashtable]$D) {
    $now = Get-Now
    $exit = $null
    if ($script:Procs.ContainsKey($D.id)) {
        $p = $script:Procs[$D.id]
        try { $p.WaitForExit(); $exit = $p.ExitCode } catch { }
        [void]$script:Procs.Remove($D.id)
    }
    $D.exit_code = $exit
    $ev = Read-CodexEvents $D.out
    $marker = Test-CodexMarker $D
    $errText = ''
    try { if ($D.err -and (Test-Path -LiteralPath $D.err)) { $errText = Get-Short (Read-SharedText $D.err) 300 } } catch { }
    $D.finished_utc = $now
    $D.result_thread = $ev.thread
    if ($ev.message) { $D.summary = Get-Short $ev.message 300 }
    $key = [string]$D.agent
    $State.mail_last_finish[$key] = $now
    $expected = ([string]$D.thread_id).ToLowerInvariant()
    if ($ev.thread -and $ev.thread -ne $expected) {
        $D.state = 'completed'
        $D.outcome = "THREAD MISMATCH: Codex used $($ev.thread), the agent's thread is $expected"
        Set-MailItemsDone $State $D 'delivered to a different thread; not replayed'
        Set-MailHalt $State $key "thread mismatch on $($D.id): Codex reported thread $($ev.thread) instead of $expected" "Mail wakes for $($D.name) stopped: wake $($D.id) ran in Codex thread $($ev.thread), not the agent's thread $expected. Check the enrollment (-EnrollAgent)."
    } elseif ($ev.completed -and -not $ev.failed) {
        $D.state = 'completed'
        $D.outcome = 'success'
        Set-MailItemsDone $State $D 'completed: the agent turn ended successfully'
        $State.mail_failures[$key] = 0
        $State.mail_next_attempt[$key] = 0
    } elseif (-not $marker) {
        $msg = "Codex ended without a result (exit $exit)"
        if ($ev.failed) { $msg = "the Codex turn failed before the notice reached the thread: $($ev.failed)" }
        elseif ($ev.error) { $msg = "Codex reported an error before the notice reached the thread: $($ev.error)" }
        if ($errText) { $msg += ": $errText" }
        Set-MailDispatchFailed $State $D $msg
        return
    } elseif ($ev.failed -or $ev.error) {
        $D.state = 'completed'
        $D.outcome = 'turn ended with an error; delivered, not replayed'
        $D.error = Get-Short ("$($ev.failed) $($ev.error)") 300
        Set-MailItemsDone $State $D 'delivered; the turn ended with an error; not replayed'
        Add-MailBackoff $State $key
        Add-Alert $State '' "Agent turn $($D.id) of $($D.name) ended with an error: $($D.error). Not replayed."
        if ([int]$State.mail_failures[$key] -ge $MaxFailures) {
            Set-MailHalt $State $key "$($State.mail_failures[$key]) consecutive failed turns" "Mail wakes for $($D.name) stopped after $($State.mail_failures[$key]) failed turns in a row."
        }
    } else {
        $D.state = 'completed'
        $D.outcome = 'unknown: Codex ended without a result, but the notice is in the thread (delivered; not replayed)'
        if ($errText) { $D.error = $errText }
        Set-MailItemsDone $State $D 'delivered; outcome unknown (not replayed)'
        Add-Alert $State '' "Agent turn $($D.id) of $($D.name) ended without a result (exit $exit) after its notice reached the thread. Not replayed."
    }
    Write-Log ('Mail wake {0} for {1} {2}: {3}; exit {4}' -f $D.id, $D.name, $D.state, $D.outcome, $exit)
    Add-LedgerLine $D '-'
    Remove-DispatchFiles $D
}

function Update-MailDispatches([hashtable]$State) {
    foreach ($d in @($State.mail_dispatches.Values | Where-Object { $_.state -eq 'running' -or $_.state -eq 'launching' })) {
        if ($d.state -eq 'launching' -and -not $d.pid) {
            # The relay stopped after the write-ahead but before it recorded a process id.
            $ps = Get-SessionProcesses $d.thread_id
            if ($ps -and $ps.Count -gt 0) {
                $d.pid = [int]$ps[0].ProcessId
                $d.state = 'running'
                Write-Log "Recovered mail wake $($d.id): a process (pid $($d.pid)) has the thread open; waiting for it, never killing it"
                continue
            }
            if (-not (Test-Path -LiteralPath $d.out) -and -not (Test-CodexMarker $d)) {
                $d.state = 'abandoned'
                $d.finished_utc = Get-Now
                $d.outcome = 'the relay stopped before the Codex CLI started; mail re-queued'
                foreach ($nid in @($d.items)) { $n = $State.mail_notes[$nid]; if ($n -and $n.dispatch_id -eq $d.id) { $n.state = 'pending'; $n.dispatch_id = '' } }
                Write-Log "Mail wake $($d.id) never started (the relay stopped first); $(@($d.items).Count) message(s) re-queued"
                Add-LedgerLine $d '-'
                continue
            }
        }
        if ($d.state -eq 'launching') { $d.state = 'running' }
        if (Test-DispatchAlive $d) {
            if (-not $d.accepted_utc -and (Test-CodexMarker $d)) {
                $d.accepted_utc = Get-Now
                foreach ($nid in @($d.items)) { $n = $State.mail_notes[$nid]; if ($n -and $n.state -eq 'launched') { $n.state = 'accepted'; $n.accepted_utc = $d.accepted_utc } }
                Write-Log "Mail wake $($d.id) accepted: the notice is in the thread of $($d.name); the turn is still running"
            }
            $mins = [int][Math]::Floor(((Get-Now) - [int64]$d.started_utc) / 60)
            if ($mins -ge $WaitMinutes) {
                Add-Alert $State ('long:' + $d.id) "Agent turn $($d.id) of $($d.name) is still running after $mins min (pid $($d.pid)). The relay never kills it; new mail for it stays queued."
            }
            continue
        }
        Complete-MailDispatch $State $d
    }
}

function Get-RunningMailCount([hashtable]$State) {
    return @($State.mail_dispatches.Values | Where-Object { $_.state -eq 'running' -or $_.state -eq 'launching' }).Count
}

function Invoke-MailTick([hashtable]$State, [bool]$ReadOnly) {
    $agents = Get-Agents
    if ($agents.Count -eq 0) { return }
    Update-Mail $State $agents $false
    $running = Get-RunningMailCount $State
    foreach ($key in @($agents.Keys | Sort-Object)) {
        $ag = $agents[$key]
        $flag = 'last_mail_block_' + $key
        $pending = @($State.mail_notes.Values | Where-Object { $_.agent -eq $key -and $_.state -eq 'pending' } | Sort-Object { [int64]$_.detected_utc })
        if ($pending.Count -eq 0) { [void]$State.flags.Remove($flag); continue }
        $why = Get-AgentBlockReason $State $ag $pending $running
        if ($why) {
            $text = "$($pending.Count) message(s) for $($ag.name) wait, no wake yet: $($why.text)"
            if ($ReadOnly) { Write-Note "DRY-RUN: would not wake $($ag.name) now. $text" }
            elseif ($State.flags[$flag] -ne $why.code) { $State.flags[$flag] = $why.code; Write-Log $text }
            else { Write-Note $text }
            continue
        }
        if ($ReadOnly) {
            $prompt = New-MailPrompt 'M-dry-run' $ag @($pending | Select-Object -First 20)
            Write-Note ('DRY-RUN: would wake {0} (Codex thread {1}, folder {2}) for {3} message(s). Nothing started, nothing written.' -f $ag.name, $ag.thread_id, $ag.cwd, $pending.Count)
            Write-Host ('  command: ' + (Get-CodexExePath) + ' ' + (Get-CodexCommandLine @() $ag $prompt))
            $running++
            continue
        }
        Start-MailDispatch $State $ag $pending
        $running = Get-RunningMailCount $State
    }
}

# ---------- follow by name (rollovers) ----------
# Enrolled with -SessionName or -ThreadName, the relay wakes the NEWEST session with that name, so a new session that
# takes the name over (a rollover) is woken without a new -Enroll. Names compare whole: case, runs of spaces and marks
# around a name (* _ ` " ') do not count. "Newest" means started last, never "used last", and the relay only ever moves
# forward to a session that started after the one it wakes now, so opening an old session again never takes the name
# back. It switches only between turns, never while a turn of the old session runs.
$FollowEverySeconds = 30
$UuidRe = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
$script:NextFollowCheck = 0
$script:TitleCache = @{}       # transcript path -> @{ len; title; started; stamped }
$script:DesktopCache = @{}     # local_*.json path -> @{ stamp; id; title; archived }
$script:DesktopTitles = @{}    # Claude session id -> the DesktopCache entry that names it
$script:DesktopListAt = 0
$script:IndexCache = @{ len = -1; names = @{} }   # Codex session_index.jsonl: thread id -> name
$script:RolloutCache = @{}     # Codex thread id -> @{ path; started }

function ConvertTo-NameKey([string]$Text) {
    $t = (([string]$Text) -replace '\s+', ' ').Trim()
    $t = $t.Trim([char[]]@('*', '_', '`', '"', "'", ' '))
    return $t.ToLowerInvariant()
}

function Get-StartMs([string]$Text, [datetime]$Fallback) {
    # The first time stamp in $Text (milliseconds), else $Fallback: @{ at; stamped }.
    $m = [regex]::Match($Text, '"timestamp"\s*:\s*"([0-9]{4}-[0-9]{2}-[0-9]{2}T[^"]+)"')
    $dt = [DateTimeOffset]::MinValue
    if ($m.Success -and [DateTimeOffset]::TryParse($m.Groups[1].Value, $Inv, [Globalization.DateTimeStyles]::AssumeUniversal, [ref]$dt)) {
        return @{ at = $dt.ToUnixTimeMilliseconds(); stamped = $true }
    }
    return @{ at = [int64](New-Object DateTimeOffset ($Fallback.ToUniversalTime())).ToUnixTimeMilliseconds(); stamped = $false }
}

function Get-ClaudeTitleRecord([string]$Path) {
    # Claude re-appends its title records (custom-title, agent-name) often, so the last one sits near the end.
    $tail = ''
    try { $tail = Read-TailText $Path 262144 } catch { return '' }
    $title = ''
    foreach ($line in ($tail -split "`n")) {
        if ($line -notmatch '"type"\s*:\s*"(custom-title|agent-name)"') { continue }
        try { $r = ConvertFrom-Json -InputObject $line } catch { continue }
        if ($r.type -eq 'custom-title' -and $r.customTitle) { $title = [string]$r.customTitle }
        elseif ($r.type -eq 'agent-name' -and $r.agentName) { $title = [string]$r.agentName }
    }
    return $title
}

function Get-DesktopRoots {
    # The Claude desktop app lists its sessions in <data>\claude-code-sessions. The Microsoft Store app keeps that
    # data in its package folder.
    $out = @()
    if ($DesktopRoot) {
        $b = Join-Path $DesktopRoot 'claude-code-sessions'
        if (Test-Path -LiteralPath $b -PathType Container) { $out += $b }
        return $out
    }
    if ($env:APPDATA) {
        $b = Join-Path $env:APPDATA 'Claude\claude-code-sessions'
        if (Test-Path -LiteralPath $b -PathType Container) { $out += $b }
    }
    if ($out.Count -eq 0 -and $env:LOCALAPPDATA) {
        foreach ($d in @(Get-ChildItem -LiteralPath (Join-Path $env:LOCALAPPDATA 'Packages') -Directory -Filter 'Claude_*' -ErrorAction SilentlyContinue)) {
            $b = Join-Path $d.FullName 'LocalCache\Roaming\Claude\claude-code-sessions'
            if (Test-Path -LiteralPath $b -PathType Container) { $out += $b }
        }
    }
    return $out
}

function Update-DesktopTitles {
    # Names set in the Claude desktop app: <root>\<a>\<b>\local_<x>.json holds cliSessionId, title and isArchived.
    # Listed again at most every 30 s; a file is read again only when it changed.
    $now = Get-Now
    if ($now -lt $script:DesktopListAt) { return }
    $script:DesktopListAt = $now + 30
    $titles = @{}
    $seen = @{}
    foreach ($base in @(Get-DesktopRoots)) {
        foreach ($f in @(Get-ChildItem -LiteralPath $base -Recurse -File -Filter 'local_*.json' -ErrorAction SilentlyContinue)) {
            $stamp = '{0}|{1}' -f $f.Length, $f.LastWriteTimeUtc.Ticks
            $c = $script:DesktopCache[$f.FullName]
            if (-not $c -or $c.stamp -ne $stamp) {
                $c = @{ stamp = $stamp; id = ''; title = ''; archived = $false }
                try {
                    $j = ConvertFrom-Json -InputObject (Read-SharedText $f.FullName)
                    $c.id = ([string]$j.cliSessionId).ToLowerInvariant()
                    $c.title = [string]$j.title
                    $c.archived = ($j.isArchived -eq $true)
                } catch { }
                $script:DesktopCache[$f.FullName] = $c
            }
            $seen[$f.FullName] = $true
            if ($c.id) { $titles[$c.id] = $c }
        }
    }
    foreach ($k in @($script:DesktopCache.Keys)) { if (-not $seen.ContainsKey($k)) { $script:DesktopCache.Remove($k) } }
    $script:DesktopTitles = $titles
}

function Get-ClaudeSessionInfo($File) {
    # The name and start of one transcript, read again only when the file grew. A name once seen is kept until another
    # title record replaces it, because a long turn can push the last title record out of the tail that is read.
    $c = $script:TitleCache[$File.FullName]
    if ($c -and $c.len -eq $File.Length) { return $c }
    if (-not $c) { $c = @{ len = -1; title = ''; started = 0; stamped = $false } }
    $t = Get-ClaudeTitleRecord $File.FullName
    if ($t) { $c.title = $t }
    if (-not $c.stamped) {
        $head = ''
        try { $head = Read-HeadText $File.FullName 65536 } catch { }
        $st = Get-StartMs $head $File.CreationTimeUtc
        $c.started = $st.at
        $c.stamped = $st.stamped
    }
    $c.len = $File.Length
    $script:TitleCache[$File.FullName] = $c
    return $c
}

function Find-NamedClaudeSession([string]$Name, [string]$Cwd) {
    # The newest Claude Code session of this working folder named $Name: @{ id; path; started } or $null. Its name is
    # its own title record (/rename in Claude Code), else the title the desktop app shows. Archived ones do not count.
    $want = ConvertTo-NameKey $Name
    if (-not $want -or -not $Cwd) { return $null }
    $dir = Join-Path (Join-Path $ClaudeConfigDir 'projects') ($Cwd -replace '[^A-Za-z0-9]', '-')
    if (-not (Test-Path -LiteralPath $dir -PathType Container)) { return $null }
    Update-DesktopTitles
    $best = $null
    foreach ($f in @(Get-ChildItem -LiteralPath $dir -File -Filter '*.jsonl' -ErrorAction SilentlyContinue)) {
        $id = $f.BaseName.ToLowerInvariant()
        if ($id -notmatch $UuidRe) { continue }
        $desk = $script:DesktopTitles[$id]
        if ($desk -and $desk.archived) { continue }
        $info = Get-ClaudeSessionInfo $f
        $title = $info.title
        if (-not $title -and $desk) { $title = $desk.title }
        if ((ConvertTo-NameKey $title) -ne $want) { continue }
        if (-not $best -or $info.started -gt $best.started -or ($info.started -eq $best.started -and $id -gt $best.id)) {
            $best = @{ id = $id; path = $f.FullName; started = [int64]$info.started }
        }
    }
    return $best
}

function Get-ClaudeStarted([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return [int64]0 }
    return [int64](Get-ClaudeSessionInfo (Get-Item -LiteralPath $Path)).started
}

function Update-CodexNames {
    # Codex keeps thread names in <CODEX_HOME>\session_index.jsonl: one record per change, the last one wins.
    $f = Join-Path $CodexHomeDir 'session_index.jsonl'
    if (-not (Test-Path -LiteralPath $f -PathType Leaf)) { $script:IndexCache = @{ len = -1; names = @{} }; return }
    $len = (Get-Item -LiteralPath $f).Length
    if ($len -eq $script:IndexCache.len) { return }
    $text = ''
    try { $text = Read-SharedText $f } catch { return }
    $names = @{}
    foreach ($line in ($text -split "`n")) {
        if (-not $line.Trim()) { continue }
        try { $r = ConvertFrom-Json -InputObject $line } catch { continue }
        $id = ([string]$r.id).ToLowerInvariant()
        if ($id -notmatch $UuidRe) { continue }
        if ($r.thread_name) { $names[$id] = [string]$r.thread_name } else { $names.Remove($id) }
    }
    $script:IndexCache = @{ len = $len; names = $names }
}

function Get-CodexStarted([string]$Path) {
    # When a thread started: the time stamp on its first line (session_meta), else when its file was made.
    $head = ''
    try { $head = (Read-HeadText $Path 65536) } catch { }
    $line = ($head -split "`n", 2)[0]
    $fallback = [datetime]::UtcNow
    try { $fallback = (Get-Item -LiteralPath $Path).CreationTimeUtc } catch { }
    return [int64](Get-StartMs $line $fallback).at
}

function Find-NamedCodexThread([string]$Name) {
    # The newest live (not archived) Codex thread named $Name: @{ id; path; started } or $null.
    $want = ConvertTo-NameKey $Name
    if (-not $want) { return $null }
    Update-CodexNames
    $best = $null
    foreach ($id in @($script:IndexCache.names.Keys)) {
        if ((ConvertTo-NameKey $script:IndexCache.names[$id]) -ne $want) { continue }
        $c = $script:RolloutCache[$id]
        if (-not $c -or -not (Test-Path -LiteralPath $c.path -PathType Leaf)) {
            $found = Find-CodexRollout $id
            if (-not $found -or $found.archived) { $script:RolloutCache.Remove($id); continue }
            $c = @{ path = $found.path; started = (Get-CodexStarted $found.path) }
            $script:RolloutCache[$id] = $c
        }
        if (-not $best -or $c.started -gt $best.started -or ($c.started -eq $best.started -and $id -gt $best.id)) {
            $best = @{ id = $id; path = $c.path; started = [int64]$c.started }
        }
    }
    return $best
}

function Update-CoordinatorFollow([hashtable]$State, [bool]$ReadOnly) {
    $c = Get-Coordinator
    if (-not $c -or -not $c.follow_name) { return }
    $name = [string]$c.follow_name
    $cur = [string]$c.session_id
    $best = Find-NamedClaudeSession $name ([string]$c.cwd)
    if (-not $best) {
        if ($State.flags['follow_coordinator_miss'] -ne $cur) {
            $State.flags['follow_coordinator_miss'] = $cur
            Write-Log "No Claude Code session named '$name' was found for $($c.cwd); the relay still wakes session $cur."
        }
        return
    }
    [void]$State.flags.Remove('follow_coordinator_miss')
    if ($best.id -eq $cur -or $best.started -le [int64]$c.started_ms) { return }
    if (@($State.dispatches.Values | Where-Object { $_.state -eq 'running' -or $_.state -eq 'launching' }).Count) {
        $script:NextFollowCheck = 0   # between turns only: look again on the next tick
        return
    }
    if ($ReadOnly) { Write-Note "DRY-RUN: would switch the coordinator to session $($best.id), the newest session named '$name' (it wakes $cur now)."; return }
    $c.previous_session_id = $cur
    $c.session_id = $best.id
    $c.transcript_path = $best.path
    $c.started_ms = $best.started
    $c.followed_utc = Get-Now
    $c.followed = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss', $Inv)
    Save-Json $CoordFile $c
    $State.failures = 0
    $State.next_attempt_utc = 0
    [void]$State.flags.Remove('last_block')
    Write-Log "Rollover: '$name' is now session $($best.id) (newest with that name), so the relay wakes it instead of $cur. Model, effort and allowed checks stay the same."
}

function Update-CodexFollow([hashtable]$State, [bool]$ReadOnly) {
    $cx = Get-CodexConfig
    if (-not $cx -or -not $cx.follow_name) { return }
    $name = [string]$cx.follow_name
    $cur = [string]$cx.thread_id
    $best = Find-NamedCodexThread $name
    if (-not $best) {
        if ($State.flags['follow_codex_miss'] -ne $cur) {
            $State.flags['follow_codex_miss'] = $cur
            Write-Log "No live Codex thread named '$name' was found; the relay still wakes thread $cur."
        }
        return
    }
    [void]$State.flags.Remove('follow_codex_miss')
    if ($best.id -eq $cur -or $best.started -le [int64]$cx.started_ms) { return }
    if (@($State.codex_dispatches.Values | Where-Object { $_.state -eq 'running' -or $_.state -eq 'launching' }).Count) {
        $script:NextFollowCheck = 0
        return
    }
    $cwd = Get-CodexThreadCwd $best.path
    if (-not $cwd -or -not (Test-Path -LiteralPath $cwd -PathType Container)) {
        if ($State.flags['follow_codex_nocwd'] -ne $best.id) {
            $State.flags['follow_codex_nocwd'] = $best.id
            Write-Log "The newest Codex thread named '$name' ($($best.id)) names no folder the relay can find ('$cwd'); the relay still wakes thread $cur."
        }
        return
    }
    if ($ReadOnly) { Write-Note "DRY-RUN: would switch the Codex wake to thread $($best.id), the newest thread named '$name' (it wakes $cur now)."; return }
    $cx.previous_thread_id = $cur
    $cx.thread_id = $best.id
    $cx.cwd = $cwd
    $cx.rollout_path = $best.path
    $cx.started_ms = $best.started
    $cx.followed_utc = Get-Now
    $cx.followed = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss', $Inv)
    Save-Json $CodexFile $cx
    $State.codex_failures = 0
    $State.codex_next_attempt_utc = 0
    [void]$State.flags.Remove('last_codex_block')
    [void]$State.flags.Remove('follow_codex_nocwd')
    Write-Log "Rollover: '$name' is now Codex thread $($best.id) (newest with that name; folder $cwd), so the relay wakes it instead of $cur."
}

function Update-AgentFollow([hashtable]$State, [bool]$ReadOnly) {
    # Each enrolled agent follows its name, like the planner: a newer Codex thread with the name takes over its mail.
    $agents = Get-Agents
    if ($agents.Count -eq 0) { return }
    $changed = $false
    foreach ($key in @($agents.Keys)) {
        $ag = $agents[$key]
        $cur = [string]$ag.thread_id
        $miss = 'follow_agent_miss_' + $key
        $best = Find-NamedCodexThread ([string]$ag.name)
        if (-not $best) {
            if ($State.flags[$miss] -ne $cur) {
                $State.flags[$miss] = $cur
                Write-Log "No live Codex thread named '$($ag.name)' was found; the relay still wakes thread $cur for its mail."
            }
            continue
        }
        [void]$State.flags.Remove($miss)
        if ($best.id -eq $cur -or $best.started -le [int64]$ag.started_ms) { continue }
        if (@($State.mail_dispatches.Values | Where-Object { $_.agent -eq $key -and ($_.state -eq 'running' -or $_.state -eq 'launching') }).Count) {
            $script:NextFollowCheck = 0   # between turns only: look again on the next tick
            continue
        }
        $cwd = Get-CodexThreadCwd $best.path
        $nocwd = 'follow_agent_nocwd_' + $key
        if (-not $cwd -or -not (Test-Path -LiteralPath $cwd -PathType Container)) {
            if ($State.flags[$nocwd] -ne $best.id) {
                $State.flags[$nocwd] = $best.id
                Write-Log "The newest Codex thread named '$($ag.name)' ($($best.id)) names no folder the relay can find ('$cwd'); the relay still wakes thread $cur for its mail."
            }
            continue
        }
        if ($ReadOnly) { Write-Note "DRY-RUN: would switch agent '$($ag.name)' to thread $($best.id), the newest thread with that name (it wakes $cur now)."; continue }
        $ag.previous_thread_id = $cur
        $ag.thread_id = $best.id
        $ag.cwd = $cwd
        $ag.rollout_path = $best.path
        $ag.started_ms = $best.started
        $ag.followed_utc = Get-Now
        $ag.followed = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss', $Inv)
        $State.mail_failures[$key] = 0
        $State.mail_next_attempt[$key] = 0
        [void]$State.flags.Remove('last_mail_block_' + $key)
        [void]$State.flags.Remove($nocwd)
        $changed = $true
        Write-Log "Rollover: agent '$($ag.name)' is now Codex thread $($best.id) (newest with that name; folder $cwd), so its mail wakes that thread instead of $cur."
    }
    if ($changed) { Save-Json $AgentsFile $agents }
}

function Update-Follow([hashtable]$State, [bool]$ReadOnly) {
    $now = Get-Now
    if ($now -lt $script:NextFollowCheck) { return }
    $script:NextFollowCheck = $now + $FollowEverySeconds
    Update-CoordinatorFollow $State $ReadOnly
    Update-CodexFollow $State $ReadOnly
    Update-AgentFollow $State $ReadOnly
}

# ---------- one tick ----------
function Invoke-Tick([hashtable]$State, [bool]$ReadOnly) {
    $script:LastLaunched = $null
    $script:LastCodexLaunched = $null
    $script:MailLaunched = New-Object System.Collections.ArrayList
    $baseline = (-not $State.baseline_utc)
    Update-Daily $State
    Update-Dispatches $State
    Update-CodexDispatches $State
    Update-MailDispatches $State
    # After the turns that ended are recorded, so a rollover never cuts into a running turn.
    Update-Follow $State $ReadOnly
    $coord = Get-Coordinator
    $settling = Update-Inbound $State $baseline
    Update-Workers $State $baseline
    Update-Attention $State $baseline
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
    Invoke-CodexTick $State $ReadOnly
    Invoke-MailTick $State $ReadOnly
    Save-State $State
}

# ---------- modes ----------
function Invoke-OnceMode {
    $state = Get-State
    Invoke-Tick $state $false
    $ids = @(@($script:LastLaunched, $script:LastCodexLaunched) + @($script:MailLaunched) | Where-Object { $_ })
    if ($ids.Count -and -not $NoWait) {
        Write-Note ("Waiting for {0} to end (up to {1} min; a turn is never killed)..." -f ($ids -join ', '), $WaitMinutes)
        $deadline = (Get-Now) + $WaitMinutes * 60
        while ((Get-Now) -lt $deadline) {
            $open = @($ids | Where-Object { $p = $script:Procs[$_]; $p -and -not $p.HasExited })
            if ($open.Count -eq 0) { break }
            Start-Sleep -Milliseconds 500
        }
        Update-Dispatches $state
        Update-CodexDispatches $state
        Update-MailDispatches $state
        Save-State $state
    }
    $pend = @($state.notes.Values | Where-Object { $_.state -eq 'pending' }).Count
    $fly = @($state.dispatches.Values | Where-Object { $_.state -eq 'running' -or $_.state -eq 'launching' } | ForEach-Object { $_.id })
    Write-Note ("Once done: {0} pending; in flight: {1}" -f $pend, $(if ($fly.Count) { $fly -join ',' } else { 'none' }))
    if (Get-CodexConfig) {
        $cpend = @($state.codex_notes.Values | Where-Object { $_.state -eq 'pending' }).Count
        $cfly = @($state.codex_dispatches.Values | Where-Object { $_.state -eq 'running' -or $_.state -eq 'launching' } | ForEach-Object { $_.id })
        Write-Note ("Codex: {0} item(s) pending; in flight: {1}" -f $cpend, $(if ($cfly.Count) { $cfly -join ',' } else { 'none' }))
    }
    if ((Get-Agents).Count) {
        $mpend = @($state.mail_notes.Values | Where-Object { $_.state -eq 'pending' }).Count
        $mfly = @($state.mail_dispatches.Values | Where-Object { $_.state -eq 'running' -or $_.state -eq 'launching' } | ForEach-Object { $_.id })
        Write-Note ("Agent mail: {0} message(s) wait for a wake; in flight: {1}" -f $mpend, $(if ($mfly.Count) { $mfly -join ',' } else { 'none' }))
    }
}

function Invoke-Loop {
    if (Test-Path -LiteralPath $StopFile) { Remove-Item -LiteralPath $StopFile -Force -ErrorAction SilentlyContinue }
    $fsw = New-Object System.IO.FileSystemWatcher($Root)
    $fsw.IncludeSubdirectories = $true
    $fsw.NotifyFilter = [IO.NotifyFilters]::FileName -bor [IO.NotifyFilters]::DirectoryName -bor [IO.NotifyFilters]::LastWrite -bor [IO.NotifyFilters]::Size
    $cxl = Get-CodexConfig
    $cxWord = 'CodexWake=NOT_CONFIGURED'
    if ($cxl) { $cxWord = "CodexWake=ON (thread $($cxl.thread_id))" }
    $agl = Get-Agents
    $amWord = 'AgentMail=OFF'
    if ($agl.Count) { $amWord = "AgentMail=ON ($($agl.Count) agent(s))" }
    Write-Log "Relay loop started (pid $PID; mailbox $Root; poll $PollSeconds s; debounce $DebounceSeconds s). Stop: bridge-relay.ps1 -Stop, or Ctrl+C here. $cxWord. $amWord."
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
    if (-not $SessionName -and $SessionId -notmatch '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$') {
        Fail "-SessionId must be the coordinator session UUID (got '$SessionId'), or give -SessionName <name> to follow a name. The relay never guesses it."
    }
    $cwd = $Root
    if ($CoordinatorCwd) { $cwd = [IO.Path]::GetFullPath($CoordinatorCwd).TrimEnd('\') }
    if (-not (Test-Path -LiteralPath $cwd -PathType Container)) { Fail "Coordinator working directory not found: $cwd" }
    if ($SessionName) {
        $named = Find-NamedClaudeSession $SessionName $cwd
        if (-not $named) {
            Fail "No Claude Code session named '$SessionName' was found for working directory $cwd. Name the session first (in Claude Code: /rename $SessionName), then enroll again."
        }
        $SessionId = $named.id
    }
    $sid = $SessionId.ToLowerInvariant()
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
    $pids = Get-ClaudeOpenPids $sid
    if ($null -eq $pids) { Fail 'Could not read the process list to confirm the session is not running. Not enrolled.' }
    $openNow = ($pids.Count -gt 0)
    # A fixed id must be closed and quiet now. A followed name may be open: the relay waits to wake it until it is closed.
    if ($openNow -and -not $SessionName) {
        Fail ("Session $sid is open right now (pid " + ($pids -join ',') + '). Exit that Claude session first: the relay must never resume a running session.')
    }
    if ($QuietSeconds -gt 0 -and -not $SessionName) {
        $age = (Get-Now) - (ConvertTo-Unix (Get-Item -LiteralPath $transcript).LastWriteTimeUtc)
        if ($age -lt $QuietSeconds) { Fail "Session $sid was written $age s ago; it may still be open. Exit it, wait $QuietSeconds s, then enroll again." }
    }
    $verified = 'local transcript present for this working directory; no process had the session open; transcript quiet'
    if ($SessionName) { $verified = "newest local session named '$SessionName' for this working directory; a turn starts only while it is closed and quiet" }
    $coord = @{ session_id = $sid; cwd = $cwd; transcript_path = $transcript; enrolled_utc = (Get-Now); enrolled = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss', $Inv);
        follow_name = [string]$SessionName; started_ms = (Get-ClaudeStarted $transcript);
        verified = $verified;
        model = [string]$Model; effort = [string]$Effort;
        allowed_checks = $CheckList.ToArray();
        resume_rule = 'claude -p <notice> --resume <session_id> using subscription login only; never --continue, --fork-session or --no-session-persistence' }
    Save-Json $CoordFile $coord
    $state = Get-State
    [void]$state.flags.Remove('last_block')
    Save-State $state
    if ($SessionName) {
        Write-Log "Enrolled coordinator session $sid (cwd $cwd), the newest session named '$SessionName'. When a newer session takes that name, the relay wakes it instead, on its own. Model: $(if ($Model) { $Model } else { 'CLI default' }); effort: $(if ($Effort) { $Effort } else { 'CLI default' })."
        if ($openNow) { Write-Log 'That session is open right now. The relay wakes it only after it is closed.' }
    } else {
        Write-Log "Enrolled coordinator session $sid (cwd $cwd). Verified: transcript present, not running. Model: $(if ($Model) { $Model } else { 'CLI default' }); effort: $(if ($Effort) { $Effort } else { 'CLI default' })."
    }
    Write-Log ('Allowed checks (operator-enrolled, granted as Bash(<prefix>*)): ' + $(if ($CheckList.Count) { ($CheckList | ForEach-Object { "'" + $_ + "'" }) -join ', ' } else { 'none' }) +
        '. To change them, exit the coordinator session and run -Enroll again.')
}

function Invoke-EnrollCodex {
    # Operator only. Records the ONE Codex thread the relay may wake. Enrolling wakes nothing: the items that wait for
    # the planner now count as known, so only new ones wake the thread.
    if ($ThreadName) {
        $named = Find-NamedCodexThread $ThreadName
        if (-not $named) {
            Fail "No live Codex thread named '$ThreadName' was found in $CodexHomeDir (archived threads do not count). Check the name in Codex, or use -ThreadId."
        }
        $ThreadId = $named.id
    }
    if ($ThreadId -notmatch '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$') {
        Fail "-ThreadId must be the Codex thread id (a UUID; got '$ThreadId'), or give -ThreadName <name> to follow a name. The relay never guesses it."
    }
    $tid = $ThreadId.ToLowerInvariant()
    $found = Find-CodexRollout $tid
    if (-not $found) {
        Fail "No Codex thread $tid found under $CodexHomeDir\sessions. Take the id from the thread itself (Pleni shows it in the thread's details), and pass -CodexHome if Codex keeps its files elsewhere."
    }
    if ($found.archived) { Fail "Codex thread $tid is archived. Unarchive it in Codex first, or enroll another thread." }
    $cwd = ''
    if ($CodexCwd) { $cwd = [IO.Path]::GetFullPath($CodexCwd).TrimEnd('\') } else { $cwd = Get-CodexThreadCwd $found.path }
    if (-not $cwd) { Fail "Could not read the thread's working folder from the first line of $($found.path). Pass -CodexCwd <folder>." }
    if (-not (Test-Path -LiteralPath $cwd -PathType Container)) { Fail "The Codex thread's working folder was not found: $cwd" }
    $held = Test-CodexThreadLocked $tid
    $cx = @{ thread_id = $tid; cwd = $cwd; rollout_path = $found.path; codex_home = $CodexHomeDir; enrolled_utc = (Get-Now);
        enrolled = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss', $Inv);
        follow_name = [string]$ThreadName; started_ms = (Get-CodexStarted $found.path);
        wake_rule = 'codex exec --json --skip-git-repo-check [codex_exec_args] resume <thread_id> <notice>, in cwd, ChatGPT sign-in only; never --last, never a sandbox bypass; never while another Codex program holds the thread' }
    $state = Get-State
    Update-Attention $state $true   # before codex.json exists: what waits now is listed, not queued
    Save-Json $CodexFile $cx
    $state.codex_halt = ''
    $state.codex_failures = 0
    $state.codex_next_attempt_utc = 0
    [void]$state.flags.Remove('last_codex_block')
    Write-AttentionFile $state
    Save-State $state
    Write-Log "Enrolled Codex thread $tid for CodexWake (cwd $cwd; thread file $($found.path)). Each NEW item for the planner wakes it once; the $($state.attention.Count) item(s) waiting now count as known."
    if ($ThreadName) { Write-Log "It follows the name '$ThreadName': when a newer Codex thread takes that name, the relay wakes it instead, on its own." }
    if ($held) { Write-Log 'Another Codex program has this thread open right now (most likely the Codex app). The relay wakes it only after that program lets go of it; quit the Codex app fully to hand the thread to the relay.' }
    $exe = Get-CodexExePath
    if (-not $exe) { Write-Log 'WARNING: the Codex CLI was not found on PATH. Install it, or set codex_exe in bin\relay-settings.json, before the first wake.' }
    if ($CodexArgsError) { Write-Log "WARNING: $CodexArgsError. No Codex wake starts until it is fixed." }
}

function Invoke-UnenrollCodex {
    $state = Get-State
    $drop = @($state.codex_notes.Values | Where-Object { $_.state -eq 'pending' })
    foreach ($n in $drop) { [void]$state.codex_notes.Remove($n.id) }
    if (Test-Path -LiteralPath $CodexFile) { Remove-Item -LiteralPath $CodexFile -Force }
    [void]$state.flags.Remove('last_codex_block')
    Write-AttentionFile $state
    Save-State $state
    Write-Log ("CodexWake turned off: .relay\codex.json removed; {0} pending item(s) for Codex dropped (they stay listed in .relay\codex-attention.md). A running Codex turn is never stopped." -f $drop.Count)
}

function Invoke-EnrollAgent {
    # Operator only. Records an agent whose Codex thread the relay may wake when mail waits for it. Enrolling wakes
    # nothing: the mail that waits now counts as known, so only new mail wakes the thread.
    $name = Get-AgentCleanName $AgentName
    if (-not $name -or $name -notmatch $AgentNameRe) { Fail "-AgentName must be 1-80 letters, digits, spaces and . _ - # + ' marks, starting with a letter or a digit (got '$AgentName')." 64 }
    $key = Get-AgentKey $name
    if (-not $key -or $key -match '^(con|prn|aux|nul|com[1-9]|lpt[1-9])$') { Fail "'$name' cannot name a mail folder on Windows. Pick another name." 64 }
    $named = Find-NamedCodexThread $name
    if (-not $named) {
        Fail "No live Codex thread named '$name' was found in $CodexHomeDir (archived threads do not count). Name the thread in Codex first (in the Codex command line: /rename $name), then enroll again."
    }
    $own = Get-AgentCleanName ([string]$script:IndexCache.names[$named.id])
    if ($own -and $own -match $AgentNameRe -and (Get-AgentKey $own) -eq $key) { $name = $own }
    $cwd = Get-CodexThreadCwd $named.path
    if (-not $cwd) { Fail "Could not read the folder of Codex thread $($named.id) from the first line of $($named.path)." }
    if (-not (Test-Path -LiteralPath $cwd -PathType Container)) { Fail "The folder of Codex thread $($named.id) was not found: $cwd" }
    $agents = Get-Agents
    $ag = @{ name = $name; key = $key; thread_id = $named.id; cwd = $cwd; rollout_path = $named.path; started_ms = $named.started; codex_home = $CodexHomeDir;
        enrolled_utc = (Get-Now); enrolled = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss', $Inv);
        wake_rule = 'codex exec --json --skip-git-repo-check [codex_exec_args] resume <thread_id> <notice>, in cwd, ChatGPT sign-in only, when new mail waits in mail\<key>\new and no program has the thread open' }
    $agents[$key] = $ag
    # Its mail folder, so bin\agent-mail.ps1 -Send knows the name.
    $dir = Join-Path $MailDir $key
    foreach ($d in @($dir, (Join-Path $dir 'new'), (Join-Path $dir 'read'))) {
        if (-not (Test-Path -LiteralPath $d -PathType Container)) { New-Item -ItemType Directory -Path $d -Force | Out-Null }
    }
    $nf = Join-Path $dir 'name.txt'
    if (-not (Test-Path -LiteralPath $nf)) { [IO.File]::WriteAllText($nf, $name, $Utf8) }
    $state = Get-State
    Update-Mail $state @{ $key = $ag } $true
    Save-Json $AgentsFile $agents
    foreach ($h in @($state.mail_halts, $state.mail_failures, $state.mail_next_attempt)) { [void]$h.Remove($key) }
    [void]$state.flags.Remove('last_mail_block_' + $key)
    Save-State $state
    $waiting = Get-AgentNewMail $key
    Write-Log ("Enrolled agent '{0}' for mail wakes: Codex thread {1} (folder {2}). New mail in mail\{3}\new wakes the thread once no program has it open; the {4} message(s) waiting now count as known. It follows the name: a newer Codex thread named '{0}' takes over on its own." -f
        $name, $named.id, $cwd, $key, $waiting.Count)
    if (Test-CodexThreadLocked $named.id) { Write-Log 'Another Codex program has this thread open right now (most likely the Codex app). The relay wakes it only after that program lets go of it.' }
    $exe = Get-CodexExePath
    if (-not $exe) { Write-Log 'WARNING: the Codex CLI was not found on PATH. Install it, or set codex_exe in bin\relay-settings.json, before the first wake.' }
    if ($CodexArgsError) { Write-Log "WARNING: $CodexArgsError. No Codex wake starts until it is fixed." }
}

function Invoke-UnenrollAgent {
    $name = Get-AgentCleanName $AgentName
    $key = Get-AgentKey $name
    $agents = Get-Agents
    if (-not $key -or -not $agents.ContainsKey($key)) {
        $have = @($agents.Values | ForEach-Object { [string]$_.name } | Sort-Object)
        Fail ("No agent named '$name' is enrolled for mail wakes. Enrolled: " + $(if ($have.Count) { $have -join ', ' } else { 'none' }) + '.')
    }
    $was = [string]$agents[$key].name
    [void]$agents.Remove($key)
    Save-Json $AgentsFile $agents
    $state = Get-State
    $drop = @($state.mail_notes.Values | Where-Object { $_.agent -eq $key -and $_.state -eq 'pending' })
    foreach ($n in $drop) { [void]$state.mail_notes.Remove($n.id) }
    [void]$state.flags.Remove('last_mail_block_' + $key)
    Save-State $state
    Write-Log "Mail wakes for '$was' turned off. Its mail stays in mail\$key; a running turn is never stopped."
}

function Invoke-ClearHalt {
    $state = Get-State
    $was = $state.halt
    $state.halt = ''
    $state.failures = 0
    $state.next_attempt_utc = 0
    [void]$state.flags.Remove('last_block')
    $cwas = $state.codex_halt
    $state.codex_halt = ''
    $state.codex_failures = 0
    $state.codex_next_attempt_utc = 0
    [void]$state.flags.Remove('last_codex_block')
    $mwas = @($state.mail_halts.Keys | Where-Object { $state.mail_halts[$_] } | Sort-Object)
    $state.mail_halts = @{}
    $state.mail_failures = @{}
    $state.mail_next_attempt = @{}
    foreach ($k in @($state.flags.Keys | Where-Object { $_ -like 'last_mail_block_*' })) { [void]$state.flags.Remove($k) }
    Save-State $state
    Write-Log ("Halt cleared by the operator (was: {0})." -f $(if ($was) { $was } else { 'not halted' }))
    if ($cwas) { Write-Log "Codex wake halt cleared by the operator (was: $cwas)." }
    if ($mwas.Count) { Write-Log ("Mail wake halts cleared by the operator for: {0}." -f ($mwas -join ', ')) }
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
        if ($coord.follow_name) {
            $sw = ''
            if ($coord.followed) { $sw = "; last switch $($coord.followed), from $($coord.previous_session_id)" }
            Write-Host "Coordinator follows the name '$($coord.follow_name)': the newest session with that name in that folder is woken$sw"
        }
        $openPids = Get-ClaudeOpenPids ([string]$coord.session_id)
        if ($null -eq $openPids) { Write-Host 'Coordinator open now: unknown (the process list could not be read)' }
        elseif ($openPids.Count -gt 0) { Write-Host ("Coordinator open now in pid {0}: the relay waits until it is closed" -f ($openPids -join ',')) }
    } else {
        Write-Host 'Coordinator: NOT ENROLLED. One-time step: run bridge-relay.ps1 -Enroll -SessionName <its name>, or exit the'
        Write-Host '             coordinator session and run bridge-relay.ps1 -Enroll -SessionId <its uuid>. Nothing is sent until then.'
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
    $cx = Get-CodexConfig
    if ($cx) {
        $roll = Get-CodexRolloutPath $cx
        $held = Test-CodexThreadLocked ([string]$cx.thread_id)
        Write-Host ("CodexWake: ON for Codex thread {0} (cwd {1}; enrolled {2}; thread file found: {3}; open in another Codex program now: {4})" -f
            $cx.thread_id, $cx.cwd, $cx.enrolled, [bool]$roll, $held)
        if ($cx.follow_name) {
            $sw = ''
            if ($cx.followed) { $sw = "; last switch $($cx.followed), from $($cx.previous_thread_id)" }
            Write-Host "CodexWake follows the name '$($cx.follow_name)': the newest live Codex thread with that name is woken$sw"
        }
        $exe = Get-CodexExePath
        Write-Host ('Codex CLI: ' + $(if ($exe) { $exe } else { 'NOT FOUND (install it, or set codex_exe in bin\relay-settings.json)' }))
        if ($CodexArgsError) { Write-Host "Codex options: REFUSED - $CodexArgsError" }
        elseif ($CodexArgs.Count) { Write-Host ('Codex options: ' + ($CodexArgs -join ' ')) }
        $cfly = @($state.codex_dispatches.Values | Where-Object { $_.state -eq 'running' -or $_.state -eq 'launching' })
        if ($cfly.Count -eq 0) { Write-Host 'Codex in flight: none' }
        foreach ($d in $cfly) { Write-Host ("Codex in flight: {0} pid {1} started {2} alive {3}" -f $d.id, $d.pid, (Format-Unix $d.started_utc), (Test-DispatchAlive $d)) }
        $cpend = @($state.codex_notes.Values | Where-Object { $_.state -eq 'pending' } | Sort-Object { [int64]$_.detected_utc })
        Write-Host "Codex items pending: $($cpend.Count)"
        foreach ($n in $cpend) { Write-Host ("  - {0}: {1} (detected {2}, attempts {3})" -f $n.task, $n.what, (Format-Unix $n.detected_utc), $n.attempts) }
        Write-Host ('Codex halt: ' + $(if ($state.codex_halt) { $state.codex_halt } else { 'none' }) + "; consecutive failures: $($state.codex_failures)" +
            $(if ($state.codex_next_attempt_utc) { '; next attempt not before ' + (Format-Unix $state.codex_next_attempt_utc) } else { '' }))
        $cLimit = $(if ($MaxCodexWakesPerDay -eq 0) { 'unlimited' } else { [string]$MaxCodexWakesPerDay })
        Write-Host ("Today ({0}): {1}/{2} Codex wakes" -f $state.daily.date, [int]$state.daily.codex_wakes, $cLimit)
        $crecent = @($state.codex_dispatches.Values | Sort-Object { [int64]$_.seq } -Descending | Select-Object -First 3)
        if ($crecent.Count) { Write-Host 'Recent Codex wakes:' }
        foreach ($d in $crecent) { Write-Host ("  - {0} {1}: {2} (items {3})" -f $d.id, $d.state, (Get-Short ([string]$d.outcome + ' ' + [string]$d.error) 160), @($d.items).Count) }
    }
    $agents = Get-Agents
    if ($agents.Count) {
        $aLimit = $(if ($MaxAgentWakesPerDay -eq 0) { 'unlimited' } else { [string]$MaxAgentWakesPerDay })
        Write-Host ("Agent mail: ON for {0} agent(s); at most {1} agent turn(s) at once; {2} wakes a day each (mail folder {3})" -f $agents.Count, $MaxAgentTurnsAtOnce, $aLimit, $MailDir)
        foreach ($key in @($agents.Keys | Sort-Object)) {
            $ag = $agents[$key]
            $tid = [string]$ag.thread_id
            $new = Get-AgentNewMail $key
            $open = 'no'
            if (Test-CodexThreadLocked $tid) { $open = 'yes, in another Codex program' }
            else {
                $procs = Get-SessionProcesses $tid
                if ($null -eq $procs) { $open = 'unknown' } elseif ($procs.Count -gt 0) { $open = 'yes, in pid ' + (($procs | ForEach-Object { $_.ProcessId }) -join ',') }
            }
            Write-Host ("  - {0}: Codex thread {1} (folder {2}); {3} new message(s); today {4} wake(s); open now: {5}" -f $ag.name, $tid, $ag.cwd, $new.Count, [int]$state.daily.mail_wakes[$key], $open)
            if ($state.mail_halts[$key]) { Write-Host "    STOPPED: $($state.mail_halts[$key]) (fix the cause, then run -ClearHalt)" }
            foreach ($d in @($state.mail_dispatches.Values | Where-Object { $_.agent -eq $key -and ($_.state -eq 'running' -or $_.state -eq 'launching') })) {
                Write-Host ("    in flight: {0} pid {1} started {2}" -f $d.id, $d.pid, (Format-Unix $d.started_utc))
            }
            if ($ag.followed) { Write-Host "    last switch $($ag.followed), from $($ag.previous_thread_id)" }
        }
    } else {
        Write-Host 'Agent mail: no agent enrolled (to wake an agent when mail waits for it: bridge-relay.ps1 -EnrollAgent -AgentName <its name>)'
    }
    $att = Get-AttentionItems
    Write-Host "Codex attention (return direction): $($att.Count)"
    foreach ($k in @($att.Keys | Sort-Object)) { Write-Host ("  - {0}: {1}" -f $k, $att[$k].what) }
    if ($cx) { Write-Host "CodexWake=ON (each new item above wakes Codex thread $($cx.thread_id) once; -UnenrollCodex turns it off)" }
    else { Write-Host 'CodexWake=NOT_CONFIGURED (the relay does not wake Codex; to turn that on: bridge-relay.ps1 -EnrollCodex -ThreadId <thread id>)' }
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
        'EnrollCodex'   { Invoke-EnrollCodex }
        'UnenrollCodex' { Invoke-UnenrollCodex }
        'EnrollAgent'   { Invoke-EnrollAgent }
        'UnenrollAgent' { Invoke-UnenrollAgent }
        'ClearHalt' { Invoke-ClearHalt }
    }
} finally {
    Exit-WriterLock
}
exit 0
