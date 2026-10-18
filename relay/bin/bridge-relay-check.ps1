<#
.SYNOPSIS
  $0 behaviour check for bin\bridge-relay.ps1.

.DESCRIPTION
  Builds throwaway synthetic mailboxes under %TEMP%\bridge-relay-check-<random> (never the real bridge) and runs the
  relay against them as a separate process, with tests\stub-claude.js as -ClaudeExe and a DPAPI-encrypted DUMMY key.
  It checks behaviour only through external evidence: the stub's calls.jsonl, the fake session transcript,
  .relay\state.json and the relay's own output.
  Checks: dry run; return direction; 1 new assignment; 2 answers change; 3 worker end; 4 duplicate writes;
  5 busy turn; 6 restart (+ unknown outcome); 7 CLI error / missing session; 8 coordinator permissions
  (-Enroll -AllowCheck validation, -ShowCoordinatorArgs allowed/denied tools); 9 and 10 wake limits;
  11 local settings (bin\relay-settings.json: projects_dir, owner_name); 12-14 CodexWake with tests\stub-codex.js
  (off until enrolled, one wake per new item, waits for a held thread / a coordinator turn / a running wake,
  errors back off and stop only the Codex direction, a different thread id stops it, ChatGPT sign-in only);
  15 rollovers (-Enroll -SessionName and -EnrollCodex -ThreadName follow the newest session with the name, forward
  only and between turns); 16 a window whose command line does not name the session (Claude Code's own list of
  running sessions) holds the coordinator turn, and files left behind by closed windows do not.
  It runs only the bridge-relay.ps1 beside it, ..\tests\stub-claude.js and ..\tests\stub-codex.js; other
  -RelayScript/-StubCli values are refused.
  Prints one PASS/FAIL line per check, then a summary. Exit 0 only when every check passes (2 = could not set up).
  No network, no API key, no real claude.exe. It removes its temp folder and stops any process it started
  (only processes whose command line names this run's temp folder). Takes about 2-4 minutes.
  Windows PowerShell 5.1. ASCII only.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File bin\bridge-relay-check.ps1
  powershell -NoProfile -ExecutionPolicy Bypass -File bin\bridge-relay-check.ps1 -KeepTemp   (keep the temp folder to debug)
#>
[CmdletBinding()]
param(
    [string]$RelayScript,   # default: bridge-relay.ps1 beside this file
    [string]$StubCli,       # default: ..\tests\stub-claude.js
    [switch]$KeepTemp
)

$ErrorActionPreference = 'Stop'
$Utf8 = New-Object System.Text.UTF8Encoding($false)
$PsExe = Join-Path $PSHOME 'powershell.exe'
$DummyKey = 'sk-ant-relay-check-dummy'   # the stub reports key_is_dummy when it receives exactly this value

function Stop-Setup([string]$Message) { Write-Host "SETUP ERROR: $Message"; exit 2 }
# Defaults are resolved here, not in param(): $PSScriptRoot can be empty there.
$HereDir = $PSScriptRoot
if (-not $HereDir) { $HereDir = Split-Path -Parent $MyInvocation.MyCommand.Path }
$OwnRelay = Join-Path $HereDir 'bridge-relay.ps1'
$OwnStub = Join-Path (Split-Path -Parent $HereDir) 'tests\stub-claude.js'
$StubCodex = Join-Path (Split-Path -Parent $HereDir) 'tests\stub-codex.js'
if (-not $RelayScript) { $RelayScript = $OwnRelay }
if (-not $StubCli) { $StubCli = $OwnStub }
foreach ($f in @($RelayScript, $StubCli, $StubCodex, $PsExe)) { if (-not (Test-Path -LiteralPath $f -PathType Leaf)) { Stop-Setup "not found: $f" } }
if (-not (Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue)) { Stop-Setup 'node.exe not found (the stub CLI needs it)' }
$RelayScript = (Resolve-Path -LiteralPath $RelayScript).Path
$StubCli = (Resolve-Path -LiteralPath $StubCli).Path
$StubCodex = (Resolve-Path -LiteralPath $StubCodex).Path
$DummyOpenAiKey = 'sk-relay-check-dummy-openai'   # set for every relay run; the Codex stub reports whether it saw it
# The unattended coordinator may run this harness (bridge-relay.ps1 allows it), so it only ever executes the relay and
# stub that sit beside it (under bin and tests, which the coordinator cannot edit), never a script named on the command line.
if ([IO.Path]::GetFullPath($RelayScript) -ne [IO.Path]::GetFullPath($OwnRelay)) { Stop-Setup "-RelayScript must be $OwnRelay (got $RelayScript)" }
if ([IO.Path]::GetFullPath($StubCli) -ne [IO.Path]::GetFullPath($OwnStub)) { Stop-Setup "-StubCli must be $OwnStub (got $StubCli)" }

$Token = 'bridge-relay-check-' + [guid]::NewGuid().ToString('N').Substring(0, 8)   # short: fake transcript paths stay < 260 chars
$Base = Join-Path ([IO.Path]::GetFullPath($env:TEMP).TrimEnd('\')) $Token
$KeyPath = Join-Path $Base 'dummy-key.dpapi'

$script:Spawned = New-Object System.Collections.ArrayList   # every relay process this harness started
$script:RunNo = 0
$script:Pass = 0
$script:Fail = 0
$script:P = $null
$script:LastOut = ''

# ---------- helpers ----------
function Write-Text([string]$Path, [string]$Text) {
    $d = Split-Path -Parent $Path
    if (-not (Test-Path -LiteralPath $d)) { New-Item -ItemType Directory -Path $d -Force | Out-Null }
    [IO.File]::WriteAllText($Path, $Text, $Utf8)
}

function Read-Shared([string]$Path) {
    $fs = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
    try {
        $sr = New-Object System.IO.StreamReader($fs, $true)
        try { return $sr.ReadToEnd() } finally { $sr.Dispose() }
    } finally { $fs.Dispose() }
}

function Get-Tail([string]$Text, [int]$Max = 400) {
    $t = ([string]$Text -replace '\s+', ' ').Trim()
    if ($t.Length -gt $Max) { $t = '...' + $t.Substring($t.Length - $Max) }
    return $t
}

function ConvertTo-Token([string]$A) {
    if ($A -eq '') { return '""' }
    if ($A -notmatch '[\s"]') { return $A }
    return '"' + ($A -replace '"', '\"') + '"'
}

function Get-RelayArgs([hashtable]$Fx, [string]$Mode, [hashtable]$Opt) {
    $o = @{ MailboxRoot = $Fx.mb; ClaudeExe = $StubCli; KeyFile = $KeyPath; ClaudeConfigDir = $Fx.cfg; ProjectsDir = $Base;
        CodexExe = $StubCodex; CodexHome = $Fx.codex; DesktopRoot = (Join-Path $Fx.dir 'desktop');
        DebounceSeconds = 0; QuietSeconds = 0; PollSeconds = 1; BackoffSeconds = 60 }
    if ($Opt) { foreach ($k in @($Opt.Keys)) { $o[$k] = $Opt[$k] } }
    # Safety: only synthetic mailboxes under this run's temp folder, only the stub CLIs and the dummy key.
    if (-not ([string]$o.MailboxRoot).StartsWith($Base + '\', [StringComparison]::OrdinalIgnoreCase)) { throw "refusing: mailbox outside $Base" }
    if ([string]$o.ClaudeExe -ne $StubCli -or [string]$o.KeyFile -ne $KeyPath) { throw 'refusing: -ClaudeExe/-KeyFile must be the stub and the dummy key' }
    if ([string]$o.CodexExe -ne $StubCodex) { throw 'refusing: -CodexExe must be the Codex stub' }
    if (-not ([string]$o.CodexHome).StartsWith($Base + '\', [StringComparison]::OrdinalIgnoreCase)) { throw "refusing: Codex home outside $Base" }
    if (-not ([string]$o.DesktopRoot).StartsWith($Base + '\', [StringComparison]::OrdinalIgnoreCase)) { throw "refusing: desktop app folder outside $Base" }
    $a = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $RelayScript, "-$Mode")
    foreach ($k in @($o.Keys | Sort-Object)) {
        if ($null -eq $o[$k]) { continue }   # an option set to $null is left out
        if ($o[$k] -is [bool]) { if ($o[$k]) { $a += "-$k" } } else { $a += "-$k"; $a += [string]$o[$k] }
    }
    return (($a | ForEach-Object { ConvertTo-Token $_ }) -join ' ')
}

function Start-Relay([hashtable]$Fx, [string]$Mode, [hashtable]$Opt) {
    $env:RELAY_STUB_DIR = $Fx.stub          # inherited by the relay and by the stub it starts
    $env:RELAY_STUB_CONFIG_DIR = $Fx.cfg
    $script:RunNo++
    $o = Join-Path $Fx.dir ('relay-{0:d2}-{1}.out.txt' -f $script:RunNo, $Mode)
    $e = Join-Path $Fx.dir ('relay-{0:d2}-{1}.err.txt' -f $script:RunNo, $Mode)
    $p = Start-Process -FilePath $PsExe -ArgumentList (Get-RelayArgs $Fx $Mode $Opt) -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput $o -RedirectStandardError $e
    $null = $p.Handle   # keep a handle so ExitCode stays readable
    [void]$script:Spawned.Add($p)
    return @{ proc = $p; out = $o; err = $e }
}

function Read-RelayOutput([hashtable]$R) {
    $t = ''
    foreach ($f in @($R.out, $R.err)) { if (Test-Path -LiteralPath $f) { $t += Read-Shared $f } }
    return $t
}

function Invoke-Relay([hashtable]$Fx, [string]$Mode, [hashtable]$Opt) {
    $r = Start-Relay $Fx $Mode $Opt
    if (-not $r.proc.WaitForExit(180000)) {
        try { Stop-Process -Id $r.proc.Id -Force } catch { }
        throw "relay -$Mode did not exit within 180 s"
    }
    $out = Read-RelayOutput $r
    $script:LastOut = "[-$Mode exit $($r.proc.ExitCode)] $out"
    return @{ code = $r.proc.ExitCode; out = $out }
}

function Stop-Loop([hashtable]$Fx, [hashtable]$Loop) {
    $null = Invoke-Relay $Fx 'Stop' $null
    $ok = $Loop.proc.WaitForExit(30000)
    $script:LastOut = '[-Start loop] ' + (Read-RelayOutput $Loop)
    return $ok
}

function Set-StubMode([hashtable]$Fx, [string]$Mode) { [IO.File]::WriteAllText((Join-Path $Fx.stub 'mode.txt'), $Mode, $Utf8) }
function Set-CodexStubMode([hashtable]$Fx, [string]$Mode) { [IO.File]::WriteAllText((Join-Path $Fx.stub 'codex-mode.txt'), $Mode, $Utf8) }

function Get-Calls([hashtable]$Fx, [string]$Phase) {
    $f = Join-Path $Fx.stub 'calls.jsonl'
    if (-not (Test-Path -LiteralPath $f)) { return }
    foreach ($l in ((Read-Shared $f) -split "`n")) {
        $l = $l.Trim()
        if (-not $l) { continue }
        try { $c = ConvertFrom-Json -InputObject $l } catch { continue }
        if (-not $Phase -or $c.phase -eq $Phase) { $c }
    }
}

function Get-RunningStubs([hashtable]$Fx) { return @(Get-ChildItem -LiteralPath $Fx.stub -Filter 'running-*' -File -ErrorAction SilentlyContinue).Count }

function Get-CodexCalls([hashtable]$Fx, [string]$Phase) {
    $f = Join-Path $Fx.stub 'codex-calls.jsonl'
    if (-not (Test-Path -LiteralPath $f)) { return }
    foreach ($l in ((Read-Shared $f) -split "`n")) {
        $l = $l.Trim()
        if (-not $l) { continue }
        try { $c = ConvertFrom-Json -InputObject $l } catch { continue }
        if (-not $Phase -or $c.phase -eq $Phase) { $c }
    }
}

function Get-RunningCodexStubs([hashtable]$Fx) { return @(Get-ChildItem -LiteralPath $Fx.stub -Filter 'codex-running-*' -File -ErrorAction SilentlyContinue).Count }

function Get-RolloutNotices([hashtable]$Fx) {
    if (-not (Test-Path -LiteralPath $Fx.rollout)) { return 0 }
    return ([regex]::Matches((Read-Shared $Fx.rollout), '\[bridge-relay C\d')).Count
}

function Get-TranscriptNotices([hashtable]$Fx) {
    if (-not (Test-Path -LiteralPath $Fx.transcript)) { return 0 }
    return ([regex]::Matches((Read-Shared $Fx.transcript), '\[bridge-relay R\d')).Count
}

function Get-RelayState([hashtable]$Fx) {
    $f = Join-Path $Fx.mb '.relay\state.json'
    for ($i = 0; $i -lt 10; $i++) {
        if (-not (Test-Path -LiteralPath $f)) { return $null }
        try { return (ConvertFrom-Json -InputObject (Read-Shared $f)) } catch { Start-Sleep -Milliseconds 200 }
    }
    throw 'state.json stayed unreadable'
}

function Get-Values($Obj) { if ($Obj) { foreach ($p in $Obj.PSObject.Properties) { $p.Value } } }

function Get-Note([hashtable]$Fx, [string]$Key) {
    $st = Get-RelayState $Fx
    if (-not $st) { return @() }
    return @(Get-Values $st.notes | Where-Object { $_.key -eq $Key } | Sort-Object { [int64]$_.detected_utc })
}

function Test-Pending([hashtable]$Fx, [string]$Key) { return (@(Get-Note $Fx $Key | Where-Object { $_.state -eq 'pending' }).Count -gt 0) }

function Get-CodexNotes([hashtable]$Fx) {
    $st = Get-RelayState $Fx
    if (-not $st) { return @() }
    return @(Get-Values $st.codex_notes | Sort-Object { [int64]$_.detected_utc })
}

function Get-CodexDispatches([hashtable]$Fx) {
    $st = Get-RelayState $Fx
    if (-not $st) { return @() }
    return @(Get-Values $st.codex_dispatches | Sort-Object { [int64]$_.seq })
}

function Get-Dispatches([hashtable]$Fx) {
    $st = Get-RelayState $Fx
    if (-not $st) { return @() }
    return @(Get-Values $st.dispatches | Sort-Object { [int64]$_.seq })
}

function Test-NoOverlap([hashtable]$Fx, [switch]$Codex) {
    # True when no two stub CLI processes were alive at the same time (from their own start/end records).
    if ($Codex) { $all = @(Get-CodexCalls $Fx '') } else { $all = @(Get-Calls $Fx '') }
    $runs = @()
    foreach ($s in @($all | Where-Object { $_.phase -eq 'start' })) {
        $e = @($all | Where-Object { $_.phase -eq 'end' -and $_.pid -eq $s.pid -and [int64]$_.t -ge [int64]$s.t } | Select-Object -First 1)
        $end = [int64]::MaxValue
        if ($e.Count) { $end = [int64]$e[0].t }
        $runs += [pscustomobject]@{ s = [int64]$s.t; e = $end }
    }
    $runs = @($runs | Sort-Object s)
    for ($i = 1; $i -lt $runs.Count; $i++) { if ($runs[$i].s -lt $runs[$i - 1].e) { return $false } }
    return $true
}

function Wait-Until([scriptblock]$Condition, [int]$Seconds) {
    $deadline = (Get-Date).AddSeconds($Seconds)
    do {
        if (& $Condition) { return $true }
        Start-Sleep -Milliseconds 300
    } while ((Get-Date) -lt $deadline)
    return [bool](& $Condition)
}

function Write-Session([hashtable]$Fx, [string]$Id, [string]$At, [string]$Title) {
    # A fake Claude Code session in the coordinator's folder. The title line is what /rename writes.
    $p = Join-Path (Split-Path -Parent $Fx.transcript) "$Id.jsonl"
    $t = '{"type":"user","sessionId":"' + $Id + '","timestamp":"' + $At + '","message":{"role":"user","content":"synthetic session"}}' + "`n"
    if ($Title) { $t += '{"type":"custom-title","customTitle":"' + $Title + '","sessionId":"' + $Id + '"}' + "`n" }
    Write-Text $p $t
}

function Write-Thread([hashtable]$Fx, [string]$Id, [string]$At, [string]$Cwd, [string]$Name) {
    # A fake Codex thread, and its name in session_index.jsonl, where Codex keeps thread names.
    $day = $At.Substring(0, 10) -replace '-', '\'
    $p = Join-Path $Fx.codex ("sessions\$day\rollout-" + ($At -replace ':', '-').Substring(0, 19) + "-$Id.jsonl")
    $meta = [ordered]@{ timestamp = $At; type = 'session_meta'; payload = [ordered]@{ id = $Id; timestamp = $At; cwd = $Cwd; originator = 'codex_cli_rs' } }
    Write-Text $p ((ConvertTo-Json -InputObject $meta -Compress -Depth 4) + "`n")
    $rec = [ordered]@{ id = $Id; thread_name = $Name; updated_at = $At }
    [IO.File]::AppendAllText((Join-Path $Fx.codex 'session_index.jsonl'), (ConvertTo-Json -InputObject $rec -Compress) + "`n", $Utf8)
}

function Get-RelayJson([hashtable]$Fx, [string]$Name) {
    $f = Join-Path $Fx.mb ".relay\$Name"
    if (-not (Test-Path -LiteralPath $f)) { return $null }
    return (ConvertFrom-Json -InputObject (Read-Shared $f))
}

function Get-AttentionKeys([string]$Out) {
    $in = $false
    foreach ($l in ($Out -split "`r?`n")) {
        if ($l -match '^Codex attention \(return direction') { $in = $true; continue }
        if ($in) { if ($l -match '^\s+- (\S+): ') { $Matches[1] } else { $in = $false } }
    }
}

function Check([bool]$Condition, [string]$Message) { if (-not $Condition) { [void]$script:P.Add($Message) } }

function Invoke-Scenario([string]$Name, [scriptblock]$Body) {
    $script:P = New-Object System.Collections.ArrayList
    $script:LastOut = ''
    $t0 = Get-Date
    try { & $Body | Out-Null } catch { [void]$script:P.Add('error: ' + $_.Exception.Message) }
    $secs = [int]((Get-Date) - $t0).TotalSeconds
    if ($script:P.Count -eq 0) {
        $script:Pass++
        Write-Host ('PASS {0} ({1} s)' -f $Name, $secs)
    } else {
        $script:Fail++
        Write-Host ('FAIL {0}: {1}' -f $Name, ($script:P -join '; '))
        if ($script:LastOut) { Write-Host ('  last relay output: ' + (Get-Tail $script:LastOut 600)) }
    }
}

# ---------- fixtures ----------
function New-Fixture([string]$Name) {
    $dir = Join-Path $Base $Name
    $fx = @{ name = $Name; dir = $dir; mb = (Join-Path $dir 'mailbox'); cfg = (Join-Path $dir 'claude-config'); stub = (Join-Path $dir 'stub');
        sid = [guid]::NewGuid().ToString(); codex = (Join-Path $dir 'codex-home'); planner = (Join-Path $dir 'planner'); tid = [guid]::NewGuid().ToString() }
    foreach ($d in @($fx.mb, $fx.cfg, $fx.stub, $fx.codex, $fx.planner)) { New-Item -ItemType Directory -Path $d -Force | Out-Null }
    Write-Text (Join-Path $fx.mb 'CODEX-QUEUE.md') "# CODEX-QUEUE (synthetic fixture)`r`n`r`n- T-BASE: assigned`r`n"
    Write-Text (Join-Path $fx.mb 'tasks\T-BASE\assignment.md') "# Assignment - T-BASE (synthetic)`r`n`r`n- Goal: fixture only.`r`n"
    Write-Text (Join-Path $fx.mb 'tasks\T-BASE\answers.md') "# Answers - T-BASE`r`n`r`n### A1 (Q1)`r`n**Answer:** yes.`r`n"
    # Fake local session transcript where the relay (-Enroll) and the stub (--resume) look for it.
    $root = [IO.Path]::GetFullPath($fx.mb).TrimEnd('\')
    $fx.transcript = Join-Path $fx.cfg ('projects\' + ($root -replace '[^A-Za-z0-9]', '-') + '\' + $fx.sid + '.jsonl')
    $first = @{ type = 'user'; sessionId = $fx.sid; message = @{ role = 'user'; content = 'synthetic coordinator session' } }
    Write-Text $fx.transcript ((ConvertTo-Json -InputObject $first -Compress -Depth 4) + "`n")
    Set-StubMode $fx 'ok'
    # Fake Codex thread file where the relay (-EnrollCodex) and the Codex stub (resume) look for it.
    $fx.rollout = Join-Path $fx.codex ('sessions\2026\10\09\rollout-2026-10-09T05-00-00-' + $fx.tid + '.jsonl')
    $meta = [ordered]@{ timestamp = '2026-10-09T05:00:00Z'; type = 'session_meta';
        payload = [ordered]@{ id = $fx.tid; timestamp = '2026-10-09T05:00:00Z'; cwd = $fx.planner; originator = 'codex_cli_rs'; instructions = 'synthetic planner thread' } }
    Write-Text $fx.rollout ((ConvertTo-Json -InputObject $meta -Compress -Depth 4) + "`n")
    Set-CodexStubMode $fx 'ok'
    return $fx
}

function Initialize-Fixture([hashtable]$Fx) {
    # Enroll the fake session, then let one -Once record the baseline (existing files count as already seen).
    $r = Invoke-Relay $Fx 'Enroll' @{ SessionId = $Fx.sid }
    if ($r.code -ne 0) { throw "enroll failed (exit $($r.code)): $(Get-Tail $r.out)" }
    $r = Invoke-Relay $Fx 'Once' $null
    if ($r.code -ne 0) { throw "baseline -Once failed (exit $($r.code)): $(Get-Tail $r.out)" }
    if (@(Get-Calls $Fx '').Count -ne 0) { throw 'the baseline run called the CLI' }
}

function Stop-Leftovers {
    $n = 0
    foreach ($p in @($script:Spawned)) {
        try { if (-not $p.HasExited) { Stop-Process -Id $p.Id -Force; $n++ } } catch { }
    }
    # Stub CLIs (and anything else) whose command line names this run's unique temp folder.
    $procs = @()
    try { $procs = @(Get-CimInstance -ClassName Win32_Process -Filter ("CommandLine LIKE '%" + $Token + "%'") | Where-Object { $_.ProcessId -ne $PID }) } catch { }
    foreach ($p in $procs) { try { Stop-Process -Id $p.ProcessId -Force; $n++ } catch { } }
    if ($n) { Start-Sleep -Seconds 1 }
    return $n
}

# ---------- scenarios ----------
$NewAssignment = "# Assignment - T-NEW (synthetic)`r`n`r`n- Goal: new work.`r`n"
function Get-Questions([int[]]$Blocking) {
    $t = "# Questions - T-BASE`r`n"
    foreach ($q in $Blocking) { $t += "`r`n## Q$q - 2026-10-09 05:0$q - BLOCKING`r`n**Question:** option $q?`r`n" }
    return $t
}
$cleanupOk = $false
$PreviousOpenAiKey = $env:OPENAI_API_KEY
try {
    New-Item -ItemType Directory -Path $Base -Force | Out-Null
    $env:OPENAI_API_KEY = $DummyOpenAiKey   # inherited by every relay run; the relay must not pass it to Codex
    $sec = ConvertTo-SecureString -String $DummyKey -AsPlainText -Force
    [IO.File]::WriteAllText($KeyPath, (ConvertFrom-SecureString -SecureString $sec), $Utf8)
    Write-Host "bridge-relay-check: relay $RelayScript"
    Write-Host "                    stub  $StubCli"
    Write-Host "                    temp  $Base"

    # Read-only fixture for the dry run and the return direction (never enrolled, never run with -Once).
    $rd = New-Fixture 'rd'
    $t = Join-Path $rd.mb 'tasks'
    Write-Text "$t\T-ANSWERED\questions.md" "# Questions - T-ANSWERED`r`n`r`n## Q1 - 2026-10-09 04:50 - BLOCKING`r`n**Question:** ok?`r`n"
    Write-Text "$t\T-ANSWERED\answers.md" "# Answers - T-ANSWERED`r`n`r`n### A1 (Q1)`r`n**Answer:** yes.`r`n"
    Write-Text "$t\T-ANSWERED\status.md" "# Status - T-ANSWERED`r`n`r`n**Current state:** IN_PROGRESS (working)`r`n"
    Write-Text "$t\T-DONE\questions.md" "# Questions - T-DONE`r`n`r`n## Q1 - 2026-10-09 04:50 - BLOCKING`r`n**Question:** old?`r`n"
    Write-Text "$t\T-DONE\status.md" "# Status - T-DONE`r`n`r`n**Current state:** DONE (accepted by Codex)`r`n"
    Write-Text "$t\T-CANCELLED\questions.md" "# Questions - T-CANCELLED`r`n`r`n## Q1 - 2026-10-09 04:50 - BLOCKING`r`n**Question:** old?`r`n"
    Write-Text "$t\T-CANCELLED\status.md" "# Status - T-CANCELLED`r`n`r`n**Current state:** CANCELLED`r`n"
    Write-Text "$t\T-OPEN\questions.md" ("# Questions - T-OPEN`r`n`r`n## Q1 - 2026-10-09 04:50 - NON-BLOCKING`r`n**Finding:** fyi.`r`n`r`n" +
        "## Q2 - 2026-10-09 04:51 - BLOCKING`r`n**Question:** which option?`r`n")
    Write-Text "$t\T-OPEN\status.md" "# Status - T-OPEN`r`n`r`n**Current state:** IN_REVIEW (handoff written)`r`n"
    Write-Text "$t\T-OPEN\handoff.md" "# Handoff - T-OPEN`r`n`r`n- Result: ready for review.`r`n"

    Invoke-Scenario 'dry-run: exit 0, no .relay created, no CLI call' {
        $r = Invoke-Relay $rd 'DryRun' $null
        Check ($r.code -eq 0) "exit code $($r.code)"
        Check ($r.out -match 'DRY-RUN') 'no DRY-RUN banner in the output'
        Check (-not (Test-Path -LiteralPath (Join-Path $rd.mb '.relay'))) 'the dry run created .relay'
        Check (@(Get-Calls $rd '').Count -eq 0) 'the dry run called the stub CLI'
    }

    Invoke-Scenario 'return direction: ### A1 answers and DONE/CANCELLED tasks raise nothing' {
        $r = Invoke-Relay $rd 'Status' $null
        Check ($r.code -eq 0) "-Status exit code $($r.code)"
        $keys = @(Get-AttentionKeys $r.out)
        Check ($keys -contains 'T-OPEN/Q2') 'positive control missing: unanswered BLOCKING T-OPEN/Q2 not listed'
        Check (@($keys | Where-Object { $_ -like 'T-OPEN/handoff@*' }).Count -eq 1) 'positive control missing: IN_REVIEW handoff of T-OPEN not listed'
        $bad = @($keys | Where-Object { $_ -notlike 'T-OPEN/*' -or $_ -eq 'T-OPEN/Q1' })
        Check ($bad.Count -eq 0) ('false items listed: ' + ($bad -join ', '))
        Check (-not (Test-Path -LiteralPath (Join-Path $rd.mb '.relay'))) '-Status created .relay'
    }

    Invoke-Scenario '1 new assignment -> exactly one dispatch' {
        $fx = New-Fixture 's1'
        Initialize-Fixture $fx
        Write-Text (Join-Path $fx.mb 'tasks\T-NEW\assignment.md') $NewAssignment
        $sf = Join-Path $fx.mb '.relay\state.json'
        $before = (Get-FileHash -LiteralPath $sf -Algorithm SHA256).Hash
        $r = Invoke-Relay $fx 'DryRun' $null
        Check ($r.code -eq 0 -and $r.out -match 'would dispatch 1 item') "the dry run did not report exactly one pending dispatch (exit $($r.code))"
        Check (@(Get-Calls $fx '').Count -eq 0) 'the dry run called the stub CLI'
        Check ((Get-FileHash -LiteralPath $sf -Algorithm SHA256).Hash -eq $before) 'the dry run changed state.json'
        $r1 = Invoke-Relay $fx 'Once' $null
        $r2 = Invoke-Relay $fx 'Once' $null
        Check ($r1.code -eq 0 -and $r2.code -eq 0) "-Once exit codes $($r1.code)/$($r2.code)"
        $s = @(Get-Calls $fx 'start')
        Check ($s.Count -eq 1) "expected 1 CLI call, got $($s.Count)"
        if ($s.Count -ge 1) {
            $c = $s[0]
            Check ($c.prompt -match 'tasks/T-NEW/assignment\.md') 'the notice does not name tasks/T-NEW/assignment.md'
            Check ($c.resume -eq $fx.sid) "resumed '$($c.resume)' instead of the enrolled session"
            Check (-not $c.bare -and -not $c.continue_flag -and -not $c.fork_session -and -not $c.no_session_persistence) 'unsafe CLI flags (subscription mode excludes --bare; never --continue, --fork-session, --no-session-persistence)'
            Check (-not $c.key_present -and $c.oauth_absent) 'the subscription CLI inherited an API key or an overriding OAuth token'
        }
        Check ((Get-TranscriptNotices $fx) -eq 1) 'the session transcript does not hold exactly one notice'
        $n = @(Get-Note $fx 'tasks/T-NEW/assignment.md')
        Check ($n.Count -eq 1 -and $n[0].state -eq 'completed') 'the notification is not recorded once as completed'
        $leak = @(Get-ChildItem -LiteralPath $fx.dir -Recurse -File | Select-String -SimpleMatch $DummyKey -List)
        Check ($leak.Count -eq 0) ('the key text was written to: ' + (($leak | ForEach-Object { $_.Path }) -join ', '))
    }

    Invoke-Scenario '2 answers.md change -> exactly one follow-up dispatch' {
        $fx = New-Fixture 's2'
        Initialize-Fixture $fx
        [IO.File]::AppendAllText((Join-Path $fx.mb 'tasks\T-BASE\answers.md'), "`r`n### A2 (Q2)`r`n**Answer:** option (a).`r`n", $Utf8)
        $r1 = Invoke-Relay $fx 'Once' $null
        $r2 = Invoke-Relay $fx 'Once' $null
        Check ($r1.code -eq 0 -and $r2.code -eq 0) "-Once exit codes $($r1.code)/$($r2.code)"
        $s = @(Get-Calls $fx 'start')
        Check ($s.Count -eq 1) "expected 1 CLI call, got $($s.Count)"
        if ($s.Count -ge 1) { Check ($s[0].prompt -match 'tasks/T-BASE/answers\.md') 'the notice does not name tasks/T-BASE/answers.md' }
    }

    Invoke-Scenario '3 worker run reaches a terminal state -> exactly one coordinator notification' {
        $fx = New-Fixture 's3'
        $rj = Join-Path $fx.mb 'tasks\T-BASE\workers\W1.run.json'
        $run = @{ task = 'T-BASE'; worker = 'W1'; started = '2026-10-09 05:00:00'; state = 'running' }
        Write-Text $rj (ConvertTo-Json -InputObject $run -Compress)
        Initialize-Fixture $fx
        # Routine progress (run.json rewritten while running) and a worker report write: no dispatch.
        $run.note = 'progress'
        Write-Text $rj (ConvertTo-Json -InputObject $run -Compress)
        Write-Text (Join-Path $fx.mb 'tasks\T-BASE\workers\W1-report.md') "# W1 report`r`n`r`nResult: PARTIAL (in progress)`r`n"
        $r0 = Invoke-Relay $fx 'Once' $null
        Check ($r0.code -eq 0 -and @(Get-Calls $fx 'start').Count -eq 0) 'a still-running worker (progress or report write) caused a dispatch'
        $run.state = 'completed'; $run.exit_code = 0; $run.cost_usd = 0.12; $run.finished = '2026-10-09 05:20:00'
        $done = ConvertTo-Json -InputObject $run -Compress
        Write-Text $rj $done
        $r1 = Invoke-Relay $fx 'Once' $null
        Write-Text $rj $done   # the same terminal record saved again
        $r2 = Invoke-Relay $fx 'Once' $null
        Check ($r1.code -eq 0 -and $r2.code -eq 0) "-Once exit codes $($r1.code)/$($r2.code)"
        $s = @(Get-Calls $fx 'start')
        Check ($s.Count -eq 1) "expected 1 CLI call, got $($s.Count)"
        if ($s.Count -ge 1) { Check ($s[0].prompt -match 'Worker W1 of T-BASE ended: recorded state completed') 'the notice does not report the recorded terminal state' }
    }

    Invoke-Scenario '4 unchanged/duplicate writes and Claude-owned writes -> zero extra dispatches' {
        $fx = New-Fixture 's4'
        Initialize-Fixture $fx
        foreach ($rel in @('CODEX-QUEUE.md', 'tasks\T-BASE\assignment.md', 'tasks\T-BASE\answers.md')) {
            $p = Join-Path $fx.mb $rel
            [IO.File]::WriteAllBytes($p, [IO.File]::ReadAllBytes($p))   # same bytes, new write time
            (Get-Item -LiteralPath $p).LastWriteTimeUtc = [DateTime]::UtcNow
        }
        $t = Join-Path $fx.mb 'tasks\T-BASE'
        Write-Text "$t\status.md" "# Status - T-BASE`r`n`r`n**Current state:** IN_PROGRESS`r`n"
        Write-Text "$t\questions.md" "# Questions - T-BASE`r`n`r`n## Q2 - 2026-10-09 05:00 - NON-BLOCKING`r`n**Finding:** fyi.`r`n"
        Write-Text "$t\handoff.md" "# Handoff - T-BASE`r`n`r`n- Result: PARTIAL.`r`n"
        Write-Text "$t\workers\W1-report.md" "# W1 report`r`n`r`nResult: PARTIAL (in progress)`r`n"
        $r1 = Invoke-Relay $fx 'Once' $null
        $r2 = Invoke-Relay $fx 'Once' $null
        Check ($r1.code -eq 0 -and $r2.code -eq 0) "-Once exit codes $($r1.code)/$($r2.code)"
        $n = @(Get-Calls $fx 'start').Count
        Check ($n -eq 0) "duplicate or Claude-owned writes caused $n dispatch(es)"
        # A real change still inside the debounce window is held back, then sent exactly once.
        Write-Text "$t\assignment.md" "# Assignment - T-BASE (synthetic)`r`n`r`n- Goal: fixture only.`r`n- Amended scope.`r`n"
        $r3 = Invoke-Relay $fx 'Once' @{ DebounceSeconds = 30 }
        Check ($r3.out -match 'settling' -and @(Get-Calls $fx 'start').Count -eq 0) 'a change inside the debounce window was not held back'
        $null = Invoke-Relay $fx 'Once' $null
        $null = Invoke-Relay $fx 'Once' $null
        $n = @(Get-Calls $fx 'start').Count
        Check ($n -eq 1) "the real change after the duplicates: expected 1 CLI call, got $n"
    }

    Invoke-Scenario '5 busy turn -> new revisions queued, no second process' {
        $fx = New-Fixture 's5'
        Initialize-Fixture $fx
        Set-StubMode $fx 'sleep:15'
        Write-Text (Join-Path $fx.mb 'tasks\T-NEW\assignment.md') $NewAssignment
        $null = Invoke-Relay $fx 'Once' @{ NoWait = $true }
        Check (Wait-Until { (Get-RunningStubs $fx) -eq 1 } 15) 'the first turn did not start'
        $af = Join-Path $fx.mb 'tasks\T-NEW\answers.md'
        Write-Text $af "# Answers - T-NEW`r`n`r`n### A1 (Q1)`r`n**Answer:** first.`r`n"
        $r2 = Invoke-Relay $fx 'Once' @{ NoWait = $true }
        Write-Text $af "# Answers - T-NEW`r`n`r`n### A1 (Q1)`r`n**Answer:** second, corrected.`r`n"
        $r3 = Invoke-Relay $fx 'Once' @{ NoWait = $true }
        if ((Get-RunningStubs $fx) -ne 1) { throw 'timing: the 15 s stub turn ended before the busy checks finished; re-run on a less loaded machine' }
        Check (@(Get-Calls $fx 'start').Count -eq 1) 'a second CLI process was started while the turn was busy'
        Check ($r2.out -match 'busy' -and $r3.out -match 'busy') 'the relay did not report the coordinator as busy'
        $st = Get-RelayState $fx
        $pend = @(Get-Values $st.notes | Where-Object { $_.state -eq 'pending' })
        Check ($pend.Count -eq 1 -and $pend[0].key -eq 'tasks/T-NEW/answers.md') "expected exactly 1 queued notification (newest answers.md revision), got $($pend.Count)"
        $acc = @(Get-Note $fx 'tasks/T-NEW/assignment.md')
        Check ($acc.Count -eq 1 -and $acc[0].state -eq 'accepted') 'the running turn was not recorded as accepted (CLI acceptance, not completion)'
        Check (Wait-Until { (Get-RunningStubs $fx) -eq 0 } 40) 'the busy stub turn did not end'
        Set-StubMode $fx 'ok'
        $null = Invoke-Relay $fx 'Once' $null
        $null = Invoke-Relay $fx 'Once' $null
        $s = @(Get-Calls $fx 'start')
        Check ($s.Count -eq 2) "expected 2 CLI calls in total, got $($s.Count)"
        if ($s.Count -eq 2) {
            Check ($s[1].prompt -match 'tasks/T-NEW/answers\.md' -and $s[1].prompt -notmatch 'assignment\.md') 'the follow-up was not exactly the queued answers.md revision'
            Check ($s[1].prompt -match '\(1 item') 'the follow-up carried more than one item (superseded revisions not collapsed)'
        }
        Check (Test-NoOverlap $fx) 'two CLI processes were alive at the same time'
    }

    Invoke-Scenario '6 restart mid-queue -> pending kept, accepted turn not replayed' {
        $fx = New-Fixture 's6'
        Initialize-Fixture $fx
        Set-StubMode $fx 'sleep:15'
        Write-Text (Join-Path $fx.mb 'tasks\T-NEW\assignment.md') $NewAssignment
        $loop = Start-Relay $fx 'Start' $null
        Check (Wait-Until { @(Get-Calls $fx 'start').Count -ge 1 } 30) 'the loop did not dispatch the new assignment'
        Write-Text (Join-Path $fx.mb 'tasks\T-NEW\answers.md') "# Answers - T-NEW`r`n`r`n### A1 (Q1)`r`n**Answer:** yes.`r`n"
        Check (Wait-Until { Test-Pending $fx 'tasks/T-NEW/answers.md' } 30) 'the loop did not queue the answers.md change'
        Check (Stop-Loop $fx $loop) 'the loop did not stop on -Stop'
        if ((Get-RunningStubs $fx) -ne 1) { throw 'timing: the 15 s stub turn ended before the restart; re-run on a less loaded machine' }
        $acc = @(Get-Note $fx 'tasks/T-NEW/assignment.md')
        Check ($acc.Count -eq 1 -and $acc[0].state -eq 'accepted') 'before the restart the in-flight turn was not recorded as accepted'
        Check (Test-Pending $fx 'tasks/T-NEW/answers.md') 'the queued notification was not persisted across the stop'
        Set-StubMode $fx 'ok'
        $loop2 = Start-Relay $fx 'Start' $null
        Check (Wait-Until { @(Get-Calls $fx 'end').Count -ge 2 } 60) 'after the restart the queued notification was not delivered'
        Start-Sleep -Seconds 3   # room for a wrongful replay to show up
        Check (Stop-Loop $fx $loop2) 'the restarted loop did not stop on -Stop'
        $s = @(Get-Calls $fx 'start')
        Check ($s.Count -eq 2) "expected 2 CLI calls (no replay), got $($s.Count)"
        if ($s.Count -ge 2) { Check ($s[1].prompt -match 'tasks/T-NEW/answers\.md' -and $s[1].prompt -notmatch 'assignment\.md') 'after the restart the accepted assignment notice was replayed' }
        Check ((Get-TranscriptNotices $fx) -eq 2) 'the session transcript does not hold exactly two notices'
        Check (Test-NoOverlap $fx) 'two CLI processes were alive at the same time (restart resumed into the running turn)'
        $d = @(Get-Dispatches $fx)
        Check ($d.Count -eq 2 -and @($d | Where-Object { $_.outcome -ne 'success' }).Count -eq 0) 'expected 2 dispatch records, both with outcome success'
        # Unknown outcome: the CLI dies after the notice reached the session -> recorded as delivered, never replayed.
        Set-StubMode $fx 'die-after-transcript'
        Write-Text (Join-Path $fx.mb 'tasks\T-NEW\review.md') "# Review - T-NEW`r`n`r`nDecision: changes requested.`r`n"
        $null = Invoke-Relay $fx 'Once' $null
        Set-StubMode $fx 'ok'
        $null = Invoke-Relay $fx 'Once' $null
        $n = @(Get-Calls $fx 'start').Count
        Check ($n -eq 3) "unknown-outcome turn: expected 3 CLI calls in total, got $n (replayed?)"
        $rv = @(Get-Note $fx 'tasks/T-NEW/review.md')
        Check ($rv.Count -eq 1 -and $rv[0].state -eq 'completed' -and [string]$rv[0].outcome -match 'not replayed') 'a turn that died after delivery was not recorded as delivered/not replayed'
    }

    Invoke-Scenario '7 CLI error / missing session -> truthful error, backoff, no tight retry loop' {
        $fx = New-Fixture 's7'
        Initialize-Fixture $fx
        Set-StubMode $fx 'fail'
        Write-Text (Join-Path $fx.mb 'tasks\T-NEW\assignment.md') $NewAssignment
        $loop = Start-Relay $fx 'Start' @{ BackoffSeconds = 2 }
        $halted = Wait-Until { $st = Get-RelayState $fx; [bool]($st -and $st.halt) } 60
        Start-Sleep -Seconds 4   # a tight retry loop would add calls here
        Check (Stop-Loop $fx $loop) 'the loop did not stop on -Stop'
        Check $halted 'the relay did not halt after repeated CLI errors'
        $s = @(Get-Calls $fx 'start')
        Check ($s.Count -eq 3) "expected exactly 3 CLI attempts (MaxFailures 3), got $($s.Count)"
        if ($s.Count -ge 3) {
            $g1 = [int64]$s[1].t - [int64]$s[0].t
            $g2 = [int64]$s[2].t - [int64]$s[1].t
            Check ($g1 -ge 900 -and $g2 -ge 2900) "retries not backed off (gaps $g1 ms and $g2 ms; want >= 900 and >= 2900)"
        }
        $d = @(Get-Dispatches $fx)
        Check ($d.Count -ge 1 -and $d[-1].state -eq 'failed' -and [string]$d[-1].error -match 'simulated CLI failure') 'the CLI error text was not recorded on the failed dispatch'
        Check (Test-Pending $fx 'tasks/T-NEW/assignment.md') 'the undelivered notification was not kept pending'
        Check ((Get-TranscriptNotices $fx) -eq 0) 'a failed attempt reached the session transcript'
        # Missing session (transcript gone): refused before any CLI start, truthful error, then backoff.
        $r0 = Invoke-Relay $fx 'ClearHalt' $null
        Check ($r0.code -eq 0) "-ClearHalt exit code $($r0.code)"
        Remove-Item -LiteralPath $fx.transcript -Force
        Set-StubMode $fx 'ok'
        $null = Invoke-Relay $fx 'Once' $null
        $r2 = Invoke-Relay $fx 'Once' $null
        $d = @(Get-Dispatches $fx)
        Check (@(Get-Calls $fx 'start').Count -eq 3) 'the CLI was started although the session transcript is missing'
        Check ($d.Count -eq 4) "expected one refused attempt and then a backoff wait (dispatch records: $($d.Count), want 4)"
        if ($d.Count -ge 4) { Check ($d[3].state -eq 'failed' -and [string]$d[3].error -match 'not found \(no local transcript') "missing session not reported truthfully: $($d[3].error)" }
        Check ($r2.out -match 'backoff') 'the next attempt was not held back by backoff'
        Check (Test-Pending $fx 'tasks/T-NEW/assignment.md') 'the notification was not kept pending'
    }

    Invoke-Scenario '8 coordinator permissions -> refused checks save nothing; harness and enrolled check allowed; bin/.relay edits denied' {
        $fx = New-Fixture 'perm'
        $cf = Join-Path $fx.mb '.relay\coordinator.json'
        foreach ($bad in @('git push', 'powershell')) {
            $r = Invoke-Relay $fx 'Enroll' @{ SessionId = $fx.sid; AllowCheck = $bad }
            Check ($r.code -ne 0) "-Enroll -AllowCheck '$bad' was accepted (exit 0)"
            Check (-not (Test-Path -LiteralPath $cf)) "-Enroll -AllowCheck '$bad' saved coordinator.json"
        }
        $r = Invoke-Relay $fx 'Enroll' @{ SessionId = $fx.sid; AllowCheck = 'php -l' }
        Check ($r.code -eq 0) "-Enroll -AllowCheck 'php -l' exit code $($r.code)"
        if (Test-Path -LiteralPath $cf) {
            $saved = @((ConvertFrom-Json -InputObject (Read-Shared $cf)).allowed_checks)
            Check ($saved.Count -eq 1 -and $saved[0] -eq 'php -l') "coordinator.json allowed_checks is '$($saved -join ', ')', want 'php -l'"
        } else { Check $false "-Enroll -AllowCheck 'php -l' did not write coordinator.json" }
        $r = Invoke-Relay $fx 'ShowCoordinatorArgs' $null
        Check ($r.code -eq 0) "-ShowCoordinatorArgs exit code $($r.code)"
        $j = ConvertFrom-Json -InputObject $r.out
        $allow = @($j.allowedTools)
        $deny = @($j.disallowedTools)
        $root = [IO.Path]::GetFullPath($fx.mb).TrimEnd('\')
        $fwd = $root -replace '\\', '/'
        $ps = 'powershell -NoProfile -ExecutionPolicy Bypass -File '
        foreach ($w in @("Bash($ps$fwd/bin/bridge-relay-check.ps1*)", "Bash($ps$root\bin\bridge-relay-check.ps1*)", 'Bash(php -l*)', 'Bash(node --test *)')) {
            Check ($allow -contains $w) "allowedTools lacks $w"
        }
        Check ($allow -notcontains 'Bash(node *)') 'allowedTools still contains Bash(node *)'
        Check ($allow -notcontains 'Bash(git -C *)') 'allowedTools still contains the blanket Bash(git -C *)'
        # Path rules use the CLI's Windows form //<lowercase drive>/... (no colon); the //C:/... form is not matched.
        # -ccontains: the drive letter must be lowercase.
        $toRule = { param([string]$p) '//' + $p.Substring(0, 1).ToLowerInvariant() + ($p.Substring(2) -replace '\\', '/') }
        $rr = & $toRule $root
        Check ($rr -cmatch '^//[a-z]/') "fixture root '$root' is not a drive-letter path (rule '$rr')"
        foreach ($w in @("Edit($rr/bin/**)", "Write($rr/bin/**)", "Edit($rr/.relay/**)", "Write($rr/.relay/**)")) {
            Check ($deny -ccontains $w) "disallowedTools lacks $w"
        }
        # Edit/Write are scoped to the mailbox: a bare Edit or Write entry permits edits at any path.
        foreach ($t in @('Edit', 'Write')) {
            Check ($allow -notcontains $t) "allowedTools still contains the bare $t (edits at any path)"
            Check ($allow -ccontains "${t}($rr/**)") "allowedTools lacks ${t}($rr/**)"
        }
        $colon = @(@($allow) + @($deny) | Where-Object { $_ -match '^(Read|Edit|Write)\(//[A-Za-z]:' })
        Check ($colon.Count -eq 0) "path rules still use the //X:/ form: $($colon -join ', ')"
        # Invoke-Relay passes -ProjectsDir $Base: application repositories are readable via Read(...), not --add-dir.
        $pr = "Read($(& $toRule $Base)/**)"
        Check ($allow -ccontains $pr) "allowedTools lacks $pr"
        Check (@($j.PSObject.Properties.Name) -contains 'addDirs') '-ShowCoordinatorArgs JSON has no addDirs'
        $dirs = @($j.addDirs)
        foreach ($d in @($Base, [IO.Path]::GetFullPath($env:TEMP).TrimEnd('\'), $env:TEMP.TrimEnd('\'))) {
            Check ($dirs -notcontains $d) "addDirs still contains $d"
        }
        Check ([string]$j.appendSystemPrompt -match 'bridge-relay-check\.ps1') 'the coordinator rules do not name the relay harness'
        Check (@(Get-Calls $fx '').Count -eq 0) 'enrolment or -ShowCoordinatorArgs called the CLI'
    }
    Invoke-Scenario '9 zero configured wake limit dispatches past 40 without resetting history; pause and backoff still block' {
        $fx = New-Fixture 'unlimited'
        Initialize-Fixture $fx
        Write-Text (Join-Path $fx.mb 'bin\cost-limits.json') '{"enabled":false,"relay_max_wakes_per_day":0}'
        $statePath = Join-Path $fx.mb '.relay\state.json'
        $seed = Get-RelayState $fx
        $seed.daily.wakes = 40; $seed.seq = 100
        Write-Text $statePath (ConvertTo-Json -InputObject $seed -Depth 12)
        Write-Text (Join-Path $fx.mb 'tasks\T-NEW\assignment.md') $NewAssignment
        $r = Invoke-Relay $fx 'Once' $null
        Check ($r.code -eq 0) "configured zero -Once exit $($r.code)"
        Check (@(Get-Calls $fx 'start').Count -eq 1) 'configured zero did not dispatch beyond 40'
        $s = Get-RelayState $fx
        Check ($s.daily.wakes -eq 41 -and $s.seq -eq 101) 'unlimited mode reset or failed to advance counters'
        $r = Invoke-Relay $fx 'Status' $null
        Check ($r.out -match '41/unlimited coordinator turns') 'status did not identify unlimited wake mode'
        Write-Text (Join-Path $fx.mb 'tasks\T-NEW\answers.md') '# Continuation two'
        $null = Invoke-Relay $fx 'Once' @{ MaxWakesPerDay = 0 }
        Check (@(Get-Calls $fx 'start').Count -eq 2) 'explicit zero did not dispatch the next revision'
        $s = Get-RelayState $fx
        Check ($s.daily.wakes -eq 42 -and $s.seq -eq 102) 'second unlimited dispatch did not preserve counters'
        $s.next_attempt_utc = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds() + 600
        Write-Text $statePath (ConvertTo-Json -InputObject $s -Depth 12)
        Write-Text (Join-Path $fx.mb 'tasks\T-NEW\answers.md') '# Held continuation'
        $r = Invoke-Relay $fx 'Once' $null
        Check ($r.out -match 'backoff' -and @(Get-Calls $fx 'start').Count -eq 2) 'unlimited mode bypassed failure backoff'
        Write-Text (Join-Path $fx.mb '.relay\PAUSE') 'fixture pause'
        $r = Invoke-Relay $fx 'Once' $null
        Check ($r.out -match 'PAUSED' -and @(Get-Calls $fx 'start').Count -eq 2) 'unlimited mode bypassed explicit pause'
        Check (Test-Pending $fx 'tasks/T-NEW/answers.md') 'blocked revision was not retained pending'
    }

    Invoke-Scenario '10 positive wake limit overrides configured unlimited and retains queued work' {
        $fx = New-Fixture 'bounded'
        Initialize-Fixture $fx
        Write-Text (Join-Path $fx.mb 'bin\cost-limits.json') '{"enabled":false,"relay_max_wakes_per_day":0}'
        $statePath = Join-Path $fx.mb '.relay\state.json'
        $seed = Get-RelayState $fx; $seed.daily.wakes = 40
        Write-Text $statePath (ConvertTo-Json -InputObject $seed -Depth 12)
        Write-Text (Join-Path $fx.mb 'tasks\T-NEW\assignment.md') $NewAssignment
        $r = Invoke-Relay $fx 'Once' @{ MaxWakesPerDay = 40 }
        Check ($r.out -match 'cap-wakes|daily wake limit reached') 'positive explicit wake limit did not block'
        Check (@(Get-Calls $fx 'start').Count -eq 0) 'bounded mode dispatched at its limit'
        Check ((Get-RelayState $fx).daily.wakes -eq 40) 'bounded mode reset wake history'
        Check (Test-Pending $fx 'tasks/T-NEW/assignment.md') 'bounded mode lost queued assignment'
    }

    Invoke-Scenario '11 local settings: projects_dir and owner_name come from bin\relay-settings.json' {
        $fx = New-Fixture 'settings'
        $proj = Join-Path $fx.dir 'projects'
        New-Item -ItemType Directory -Path $proj -Force | Out-Null
        $sf = Join-Path $fx.mb 'bin\relay-settings.json'
        Write-Text $sf (ConvertTo-Json -InputObject @{ projects_dir = $proj; owner_name = 'Ada' } -Compress)
        $r = Invoke-Relay $fx 'ShowCoordinatorArgs' @{ ProjectsDir = $null }
        Check ($r.code -eq 0) "-ShowCoordinatorArgs exit code $($r.code)"
        $j = ConvertFrom-Json -InputObject $r.out
        $rr = '//' + $proj.Substring(0, 1).ToLowerInvariant() + ($proj.Substring(2) -replace '\\', '/')
        Check (@($j.allowedTools) -ccontains "Read($rr/**)") "allowedTools lacks Read($rr/**) from relay-settings.json"
        $rules = [string]$j.appendSystemPrompt
        Check ($rules -match 'Any other command needs Ada\.' -and $rules -match 'NEEDS-ADA/BLOCKED') 'the coordinator rules do not name the owner from relay-settings.json'
        Remove-Item -LiteralPath $sf -Force
        $r = Invoke-Relay $fx 'ShowCoordinatorArgs' @{ ProjectsDir = $null }
        Check ($r.code -eq 0) "-ShowCoordinatorArgs (no settings) exit code $($r.code)"
        $j = ConvertFrom-Json -InputObject $r.out
        Check (@(@($j.allowedTools) | Where-Object { $_ -like 'Read(*' }).Count -eq 0) 'without projects_dir the coordinator still got a Read(...) rule'
        $rules = [string]$j.appendSystemPrompt
        Check ($rules -match 'Any other command needs the owner\.' -and $rules -match 'NEEDS-OWNER/BLOCKED') 'without owner_name the rules do not fall back to the owner'
        Check (@(Get-Calls $fx '').Count -eq 0) '-ShowCoordinatorArgs called the CLI'
    }

    Invoke-Scenario '12 CodexWake: off until enrolled; enrolling wakes nothing; each new item wakes the thread once' {
        $fx = New-Fixture 'cx1'
        Initialize-Fixture $fx
        $t = Join-Path $fx.mb 'tasks\T-BASE'
        # An item for the planner before CodexWake is on: listed only.
        Write-Text "$t\questions.md" (Get-Questions @(2))
        $r = Invoke-Relay $fx 'Once' $null
        Check ($r.code -eq 0) "-Once exit code $($r.code)"
        Check (@(Get-CodexCalls $fx 'start').Count -eq 0) 'Codex was woken although CodexWake was never enrolled'
        Check ($r.out -match 'CodexWake=NOT_CONFIGURED') 'the relay did not say that CodexWake is off'
        # Enrolling: the thread's folder comes from its first line; the item that already waits counts as known.
        $r = Invoke-Relay $fx 'EnrollCodex' @{ ThreadId = $fx.tid }
        Check ($r.code -eq 0) "-EnrollCodex exit code $($r.code): $(Get-Tail $r.out)"
        $cf = Join-Path $fx.mb '.relay\codex.json'
        if (Test-Path -LiteralPath $cf) {
            $cj = ConvertFrom-Json -InputObject (Read-Shared $cf)
            Check ($cj.thread_id -eq $fx.tid) "codex.json thread_id is '$($cj.thread_id)'"
            Check ($cj.cwd -eq $fx.planner) "codex.json cwd is '$($cj.cwd)', want the thread's folder $($fx.planner)"
        } else { Check $false '-EnrollCodex did not write .relay\codex.json' }
        $r = Invoke-Relay $fx 'EnrollCodex' @{ ThreadId = 'ffffffff-ffff-4fff-8fff-ffffffffffff' }
        Check ($r.code -ne 0 -and $r.out -match 'No Codex thread') '-EnrollCodex accepted a thread that does not exist'
        $null = Invoke-Relay $fx 'Once' $null
        Check (@(Get-CodexCalls $fx 'start').Count -eq 0) 'enrolling woke Codex for an item that was already waiting'
        # A new item: the dry run shows the command; -Once wakes the thread exactly once.
        Write-Text "$t\status.md" "# Status - T-BASE`r`n`r`n**Current state:** IN_REVIEW (handoff written)`r`n"
        Write-Text "$t\handoff.md" "# Handoff - T-BASE`r`n`r`n- Result: ready for review.`r`n"
        $r = Invoke-Relay $fx 'DryRun' $null
        Check ($r.out -match 'would wake Codex thread') 'the dry run did not report the Codex wake'
        Check ($r.out -match ('exec --json --skip-git-repo-check resume ' + $fx.tid)) 'the dry run did not show the codex exec resume command'
        Check (@(Get-CodexCalls $fx '').Count -eq 0) 'the dry run called the Codex stub'
        $r1 = Invoke-Relay $fx 'Once' $null
        $r2 = Invoke-Relay $fx 'Once' $null
        Check ($r1.code -eq 0 -and $r2.code -eq 0) "-Once exit codes $($r1.code)/$($r2.code)"
        $s = @(Get-CodexCalls $fx 'start')
        Check ($s.Count -eq 1) "expected 1 Codex call, got $($s.Count)"
        if ($s.Count -ge 1) {
            $c = $s[0]
            Check ($c.thread -eq $fx.tid) "woke thread '$($c.thread)' instead of the enrolled one"
            Check ($c.exec -and $c.json -and $c.skip_git -and -not $c.last -and -not $c.bypass) 'unsafe or missing Codex options (want exec --json --skip-git-repo-check; never --last or a sandbox bypass)'
            Check ($c.prompt -match 'T-BASE' -and $c.prompt -match 'IN_REVIEW') 'the notice does not name the T-BASE handoff in review'
            Check ($c.prompt -notmatch 'Q2') 'the notice repeats the item that was already waiting before enrollment'
            Check ([bool]$c.key_absent) 'the Codex turn inherited an OpenAI or Codex API key'
            # Only the end of each path is compared: Windows may show the temp folder in its short 8.3 form.
            Check ([string]$c.cwd -like '*\cx1\planner') "the Codex turn ran in '$($c.cwd)', not in the thread's folder"
            Check ([string]$c.codex_home -like '*\cx1\codex-home') "CODEX_HOME was '$($c.codex_home)', not the Codex home folder"
        }
        Check (@(Get-CodexCalls $fx 'login').Count -ge 1) 'the relay did not check the Codex sign-in first'
        Check ((Get-RolloutNotices $fx) -eq 1) 'the thread file does not hold exactly one notice'
        $n = @(Get-CodexNotes $fx | Where-Object { $_.key -like 'T-BASE/handoff@*' })
        Check ($n.Count -eq 1 -and $n[0].state -eq 'completed') 'the Codex item is not recorded once as completed'
        $d = @(Get-CodexDispatches $fx)
        Check ($d.Count -eq 1 -and $d[0].outcome -eq 'success') 'the Codex wake is not recorded once with outcome success'
        $r = Invoke-Relay $fx 'Status' $null
        Check ($r.out -match 'CodexWake: ON' -and $r.out -match '1/12 Codex wakes') 'status does not show CodexWake on with 1/12 wakes'
        $leak = @(Get-ChildItem -LiteralPath $fx.dir -Recurse -File | Select-String -SimpleMatch $DummyOpenAiKey -List)
        Check ($leak.Count -eq 0) ('the OpenAI key text was written to: ' + (($leak | ForEach-Object { $_.Path }) -join ', '))
        # Off again: no more wakes, and Claude-owned writes never woke the coordinator.
        $r = Invoke-Relay $fx 'UnenrollCodex' $null
        Check ($r.code -eq 0 -and -not (Test-Path -LiteralPath $cf)) '-UnenrollCodex did not remove codex.json'
        Write-Text "$t\questions.md" (Get-Questions @(2, 3))
        $null = Invoke-Relay $fx 'Once' $null
        Check (@(Get-CodexCalls $fx 'start').Count -eq 1) 'Codex was woken after -UnenrollCodex'
        Check (@(Get-Calls $fx 'start').Count -eq 0) 'Claude-owned writes woke the coordinator'
    }

    Invoke-Scenario '13 CodexWake waits while another program holds the thread, during a coordinator turn, and during a running wake' {
        $fx = New-Fixture 'cx2'
        Initialize-Fixture $fx
        $r = Invoke-Relay $fx 'EnrollCodex' @{ ThreadId = $fx.tid }
        if ($r.code -ne 0) { throw "-EnrollCodex failed (exit $($r.code)): $(Get-Tail $r.out)" }
        $t = Join-Path $fx.mb 'tasks\T-BASE'
        # Another program holds the thread's writer lock, as the Codex app does for every thread it opened.
        $lock = Join-Path $fx.codex ('thread-writer-locks\' + $fx.tid + '.lock')
        Write-Text $lock ''
        $held = [IO.File]::Open($lock, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
        try {
            Write-Text "$t\questions.md" (Get-Questions @(2))
            $r = Invoke-Relay $fx 'Once' $null
            Check ($r.out -match 'another Codex program has thread') 'the relay did not report the thread as open in another Codex program'
            Check (@(Get-CodexCalls $fx 'start').Count -eq 0) 'Codex was woken while another program held the thread'
        } finally { $held.Dispose() }
        $null = Invoke-Relay $fx 'Once' $null
        Check (@(Get-CodexCalls $fx 'start').Count -eq 1) 'Codex was not woken after the other program let go of the thread'
        # A coordinator turn is running: the planner waits until it ends.
        Set-StubMode $fx 'sleep:12'
        Write-Text (Join-Path $fx.mb 'tasks\T-NEW\assignment.md') $NewAssignment
        $null = Invoke-Relay $fx 'Once' @{ NoWait = $true }
        Check (Wait-Until { (Get-RunningStubs $fx) -eq 1 } 15) 'the coordinator turn did not start'
        Write-Text "$t\questions.md" (Get-Questions @(2, 3))
        $r = Invoke-Relay $fx 'Once' @{ NoWait = $true }
        if ((Get-RunningStubs $fx) -ne 1) { throw 'timing: the 12 s coordinator turn ended before the check; re-run on a less loaded machine' }
        Check ($r.out -match 'coordinator turn is still running') 'the Codex wake did not wait for the coordinator turn'
        Check (@(Get-CodexCalls $fx 'start').Count -eq 1) 'Codex was woken during a coordinator turn'
        Check (Wait-Until { (Get-RunningStubs $fx) -eq 0 } 40) 'the coordinator turn did not end'
        Set-StubMode $fx 'ok'
        # A running wake: the next item waits for it; never a second Codex process.
        Set-CodexStubMode $fx 'sleep:12'
        $null = Invoke-Relay $fx 'Once' @{ NoWait = $true }
        Check (Wait-Until { (Get-RunningCodexStubs $fx) -eq 1 } 15) 'the Codex wake for Q3 did not start'
        Write-Text "$t\questions.md" (Get-Questions @(2, 3, 4))
        $r = Invoke-Relay $fx 'Once' @{ NoWait = $true }
        if ((Get-RunningCodexStubs $fx) -ne 1) { throw 'timing: the 12 s Codex turn ended before the check; re-run on a less loaded machine' }
        Check ($r.out -match 'Codex wake C\S+ is still running') 'the relay did not report the running Codex wake'
        Check (@(Get-CodexCalls $fx 'start').Count -eq 2) 'a second Codex process started while a wake was running'
        Check (Wait-Until { (Get-RunningCodexStubs $fx) -eq 0 } 40) 'the running Codex wake did not end'
        Set-CodexStubMode $fx 'ok'
        $null = Invoke-Relay $fx 'Once' $null
        $null = Invoke-Relay $fx 'Once' $null
        $s = @(Get-CodexCalls $fx 'start')
        Check ($s.Count -eq 3) "expected 3 Codex calls in total, got $($s.Count)"
        if ($s.Count -eq 3) {
            Check ($s[1].prompt -match 'Q3' -and $s[1].prompt -notmatch 'Q2') 'the second wake was not exactly the Q3 item'
            Check ($s[2].prompt -match 'Q4' -and $s[2].prompt -notmatch 'Q3') 'the follow-up wake was not exactly the queued Q4 item'
        }
        Check (Test-NoOverlap $fx -Codex) 'two Codex processes were alive at the same time'
    }

    Invoke-Scenario '14 CodexWake errors back off and stop only the Codex direction; ChatGPT sign-in only; a different thread id stops it' {
        $fx = New-Fixture 'cx3'
        Initialize-Fixture $fx
        $r = Invoke-Relay $fx 'EnrollCodex' @{ ThreadId = $fx.tid }
        if ($r.code -ne 0) { throw "-EnrollCodex failed (exit $($r.code)): $(Get-Tail $r.out)" }
        $t = Join-Path $fx.mb 'tasks\T-BASE'
        Set-CodexStubMode $fx 'fail'
        Write-Text "$t\questions.md" (Get-Questions @(2))
        $loop = Start-Relay $fx 'Start' @{ BackoffSeconds = 2 }
        $halted = Wait-Until { $st = Get-RelayState $fx; [bool]($st -and $st.codex_halt) } 60
        Start-Sleep -Seconds 4   # a tight retry loop would add calls here
        Check (Stop-Loop $fx $loop) 'the loop did not stop on -Stop'
        Check $halted 'Codex wakes did not stop after repeated errors'
        $s = @(Get-CodexCalls $fx 'start')
        Check ($s.Count -eq 3) "expected exactly 3 Codex attempts (MaxFailures 3), got $($s.Count)"
        if ($s.Count -ge 3) {
            $g1 = [int64]$s[1].t - [int64]$s[0].t
            $g2 = [int64]$s[2].t - [int64]$s[1].t
            Check ($g1 -ge 900 -and $g2 -ge 2900) "Codex retries not backed off (gaps $g1 ms and $g2 ms; want >= 900 and >= 2900)"
        }
        $st = Get-RelayState $fx
        Check (-not $st.halt) 'a Codex failure stopped the coordinator direction'
        Check (@(Get-CodexNotes $fx | Where-Object { $_.state -eq 'pending' }).Count -eq 1) 'the undelivered Codex item was not kept pending'
        Check ((Get-RolloutNotices $fx) -eq 0) 'a failed attempt reached the thread file'
        Check ((Read-Shared (Join-Path $fx.mb '.relay\alerts.md')) -match 'Codex wakes stopped') 'no alert says that Codex wakes stopped'
        # Claude wakes go on while Codex wakes are stopped.
        Write-Text (Join-Path $fx.mb 'tasks\T-NEW\assignment.md') $NewAssignment
        $null = Invoke-Relay $fx 'Once' $null
        Check (@(Get-Calls $fx 'start').Count -eq 1) 'stopped Codex wakes also stopped the coordinator wake'
        # Signed in with an API key: refused before any turn.
        $r = Invoke-Relay $fx 'ClearHalt' $null
        Check ($r.code -eq 0 -and $r.out -match 'Codex wake halt cleared') "-ClearHalt did not clear the Codex halt (exit $($r.code))"
        Set-CodexStubMode $fx 'api-key'
        $null = Invoke-Relay $fx 'Once' $null
        Check (@(Get-CodexCalls $fx 'start').Count -eq 3) 'Codex was started although it is signed in with an API key'
        $d = @(Get-CodexDispatches $fx)
        Check ($d.Count -ge 1 -and $d[-1].state -eq 'failed' -and [string]$d[-1].error -match 'ChatGPT') 'the API-key sign-in was not refused with a ChatGPT message'
        # A wake that runs in a different thread: delivered, but Codex wakes stop.
        $null = Invoke-Relay $fx 'ClearHalt' $null
        Set-CodexStubMode $fx 'wrong-thread'
        $null = Invoke-Relay $fx 'Once' $null
        Check (@(Get-CodexCalls $fx 'start').Count -eq 4) 'the wrong-thread wake did not run'
        $st = Get-RelayState $fx
        Check ([string]$st.codex_halt -match 'mismatch') 'a wake that ran in a different thread did not stop Codex wakes'
        Check (-not $st.halt) 'the thread mismatch stopped the coordinator direction'
    }

    Invoke-Scenario '15 rollovers: enrolled by name, the relay wakes the newest session with that name, forward only and between turns' {
        $fx = New-Fixture 'ro'
        # The fixture's session, named the way /rename names it, started first.
        Write-Session $fx $fx.sid '2026-10-09T05:00:00Z' 'Sergeant Test'
        $r = Invoke-Relay $fx 'Enroll' @{ SessionName = 'Nobody' }
        Check ($r.code -ne 0 -and $r.out -match 'No Claude Code session named') '-Enroll accepted a name that no session has'
        $r = Invoke-Relay $fx 'Enroll' @{ SessionName = 'sergeant test' }
        Check ($r.code -eq 0) "-Enroll -SessionName exit code $($r.code): $(Get-Tail $r.out)"
        $cj = Get-RelayJson $fx 'coordinator.json'
        Check ($cj -and $cj.session_id -eq $fx.sid -and $cj.follow_name -eq 'sergeant test') 'coordinator.json does not hold the named session and the name to follow'
        $null = Invoke-Relay $fx 'Once' $null
        Check (@(Get-Calls $fx '').Count -eq 0) 'the baseline run called the CLI'
        # Rollover: a newer session takes the name, so the next turn goes to it.
        $sid2 = [guid]::NewGuid().ToString()
        Write-Session $fx $sid2 '2026-10-10T05:00:00Z' 'Sergeant Test'
        Write-Text (Join-Path $fx.mb 'tasks\T-NEW\assignment.md') $NewAssignment
        $r = Invoke-Relay $fx 'Once' $null
        Check ($r.out -match 'Rollover:') 'the relay did not log the rollover'
        $s = @(Get-Calls $fx 'start')
        Check ($s.Count -eq 1 -and $s[0].resume -eq $sid2) 'the turn did not go to the newest session named Sergeant Test'
        $cj = Get-RelayJson $fx 'coordinator.json'
        Check ($cj.session_id -eq $sid2 -and $cj.previous_session_id -eq $fx.sid) 'coordinator.json does not record the switch'
        # Forward only: new work in the old session, and a newer session with another name, change nothing.
        [IO.File]::AppendAllText($fx.transcript, '{"type":"user","sessionId":"' + $fx.sid + '","timestamp":"2026-10-12T05:00:00Z","message":{"role":"user","content":"old again"}}' + "`n", $Utf8)
        Write-Session $fx ([guid]::NewGuid().ToString()) '2026-10-13T05:00:00Z' 'Someone Else'
        [IO.File]::AppendAllText((Join-Path $fx.mb 'tasks\T-BASE\answers.md'), "`r`n### A2 (Q2)`r`n**Answer:** b.`r`n", $Utf8)
        $null = Invoke-Relay $fx 'Once' $null
        $s = @(Get-Calls $fx 'start')
        Check ($s.Count -eq 2 -and $s[1].resume -eq $sid2) 'the relay moved away from the newest session named Sergeant Test'
        # Between turns only: a rollover while a turn runs waits until that turn has ended.
        Set-StubMode $fx 'sleep:12'
        Write-Text (Join-Path $fx.mb 'tasks\T-TWO\assignment.md') $NewAssignment
        $null = Invoke-Relay $fx 'Once' @{ NoWait = $true }
        Check (Wait-Until { (Get-RunningStubs $fx) -eq 1 } 15) 'the slow turn did not start'
        $sid3 = [guid]::NewGuid().ToString()
        Write-Session $fx $sid3 '2026-10-14T05:00:00Z' 'Sergeant Test'
        $null = Invoke-Relay $fx 'Once' @{ NoWait = $true }
        if ((Get-RunningStubs $fx) -ne 1) { throw 'timing: the 12 s stub turn ended before the check; re-run on a less loaded machine' }
        Check ((Get-RelayJson $fx 'coordinator.json').session_id -eq $sid2) 'the relay switched sessions while a turn of the old one ran'
        Check (Wait-Until { (Get-RunningStubs $fx) -eq 0 } 40) 'the slow stub turn did not end'
        Set-StubMode $fx 'ok'
        $null = Invoke-Relay $fx 'Once' $null
        Check ((Get-RelayJson $fx 'coordinator.json').session_id -eq $sid3) 'the relay did not switch once the turn had ended'
        Check (Test-NoOverlap $fx) 'two CLI processes were alive at the same time'
        # Codex: follow a thread name. A newer thread with the name takes over and runs in its own folder.
        [IO.File]::AppendAllText((Join-Path $fx.codex 'session_index.jsonl'), '{"id":"' + $fx.tid + '","thread_name":"Planner Test","updated_at":"x"}' + "`n", $Utf8)
        $r = Invoke-Relay $fx 'EnrollCodex' @{ ThreadName = 'planner test' }
        Check ($r.code -eq 0) "-EnrollCodex -ThreadName exit code $($r.code): $(Get-Tail $r.out)"
        Check ((Get-RelayJson $fx 'codex.json').thread_id -eq $fx.tid) 'codex.json does not hold the named thread'
        $planner2 = Join-Path $fx.dir 'planner2'
        New-Item -ItemType Directory -Path $planner2 -Force | Out-Null
        $tid2 = [guid]::NewGuid().ToString()
        Write-Thread $fx $tid2 '2026-10-10T05:00:00Z' $planner2 'Planner Test'
        Write-Text (Join-Path $fx.mb 'tasks\T-BASE\questions.md') (Get-Questions @(3))
        $r = Invoke-Relay $fx 'Once' $null
        Check ($r.out -match 'Rollover:') 'the relay did not log the Codex rollover'
        $c = @(Get-CodexCalls $fx 'start')
        Check ($c.Count -eq 1 -and $c[0].thread -eq $tid2) 'the Codex wake did not go to the newest thread named Planner Test'
        if ($c.Count -ge 1) { Check ([string]$c[0].cwd -like '*\ro\planner2') "the Codex turn ran in '$($c[0].cwd)', not in the new thread's folder" }
        $r = Invoke-Relay $fx 'Status' $null
        Check ($r.out -match "Coordinator follows the name 'sergeant test'" -and $r.out -match "CodexWake follows the name 'planner test'") 'status does not show the names the relay follows'
    }

    Invoke-Scenario '16 a window that Claude Code lists, with no session id on its command line, holds the coordinator turn' {
        $fx = New-Fixture 's16'
        Initialize-Fixture $fx
        # Claude Code's own list of running sessions. This harness stands in for a window started with claude --name,
        # such as a Pleni Roll over window, whose command line does not name the session.
        $list = Join-Path $fx.cfg 'sessions'
        $mine = Join-Path $list "$PID.json"
        Write-Text $mine ('{"pid":' + $PID + ',"sessionId":"' + $fx.sid + '","kind":"interactive","entrypoint":"cli"}')
        Write-Text (Join-Path $fx.mb 'tasks\T-NEW\assignment.md') $NewAssignment
        $r = Invoke-Relay $fx 'Once' $null
        Check ($r.code -eq 0) "-Once exit code $($r.code)"
        Check (@(Get-Calls $fx 'start').Count -eq 0) 'the relay resumed a session that a window has open'
        Check ($r.out -match ('is open in pid ' + $PID)) 'the relay did not say that the session is open'
        Check (Test-Pending $fx 'tasks/T-NEW/assignment.md') 'the notification was not kept pending'
        $r = Invoke-Relay $fx 'Status' $null
        Check ($r.out -match ('Coordinator open now in pid ' + $PID)) '-Status does not show that the coordinator is open'
        $r = Invoke-Relay $fx 'Enroll' @{ SessionId = $fx.sid }
        Check ($r.code -ne 0 -and $r.out -match 'is open right now') 'enrolling a fixed id did not refuse a session that a window has open'
        # Files left behind count for nothing: one whose process is gone, and one older than the process that has its number now.
        $gone = Start-Process -FilePath $env:ComSpec -ArgumentList '/c exit 0' -WindowStyle Hidden -PassThru
        $gone.WaitForExit()
        Write-Text (Join-Path $list "$($gone.Id).json") ('{"pid":' + $gone.Id + ',"sessionId":"' + $fx.sid + '","kind":"interactive","entrypoint":"cli"}')
        (Get-Item -LiteralPath $mine).LastWriteTimeUtc = (Get-Process -Id $PID).StartTime.ToUniversalTime().AddHours(-1)
        $r = Invoke-Relay $fx 'Once' $null
        Check (@(Get-Calls $fx 'start').Count -eq 1) 'files left behind by closed windows still held the turn'
        Check (-not (Test-Pending $fx 'tasks/T-NEW/assignment.md')) 'the notification stayed pending after the window closed'
    }
} catch {
    $script:Fail++
    Write-Host ('FAIL harness: ' + $_.Exception.Message)
} finally {
    if ($null -ne $PreviousOpenAiKey) { $env:OPENAI_API_KEY = $PreviousOpenAiKey } else { Remove-Item Env:OPENAI_API_KEY -ErrorAction SilentlyContinue }
    Remove-Item Env:RELAY_STUB_DIR -ErrorAction SilentlyContinue
    Remove-Item Env:RELAY_STUB_CONFIG_DIR -ErrorAction SilentlyContinue
    $left = Stop-Leftovers
    if ($left) { Write-Host "NOTE: stopped $left leftover test process(es) of this run" }
    if ($KeepTemp) {
        Write-Host "NOTE: temp folder kept (-KeepTemp): $Base"
        $cleanupOk = $true
    } else {
        for ($i = 0; $i -lt 10; $i++) {
            try { if (Test-Path -LiteralPath $Base) { Remove-Item -LiteralPath $Base -Recurse -Force }; break } catch { Start-Sleep -Milliseconds 500 }
        }
        $cleanupOk = -not (Test-Path -LiteralPath $Base)
    }
}
if ($cleanupOk) { $script:Pass++; Write-Host 'PASS cleanup: temp folder removed (or kept by -KeepTemp), no test process left' }
else { $script:Fail++; Write-Host "FAIL cleanup: could not remove $Base" }
$total = $script:Pass + $script:Fail
Write-Host ('SUMMARY: {0} of {1} checks passed, {2} failed. Stub CLI only: no API call, no cost.' -f $script:Pass, $total, $script:Fail)
if ($script:Fail -eq 0) { exit 0 }
exit 1
