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
  running sessions) holds the coordinator turn, and files left behind by closed windows do not; 17 agent mail
  (agent-mail.ps1: send, read and wait by name, with names, sizes and unknown agents checked); 18 agent mail wakes
  (-EnrollAgent by name, one wake per new message, none for mail already read, waits while the thread is open, two
  agents at once, and -MaxAgentTurnsAtOnce); 19-22 HQ (role hq in bin\relay-settings.json, with two project mailboxes
  that share one fake Codex home): one orchestrator wake for the items of both projects, with an --add-dir for each,
  nothing for what waited when a project was added, and a dry run that changes nothing; a project's item waits while
  that project's coordinator turn runs, the other project's goes, and never two Codex processes; a project that wakes
  the orchestrator's thread too stops HQ's wakes with an alert; -NewProject and -UpdateProjects. 23-24 workers
  (bin\spawn-worker.ps1, run from a copy in a fixture mailbox's bin folder, as the launcher treats the folder above bin
  as the mailbox): a Claude worker through claude_exe gets the same arguments, session id and budget as before -Tool,
  and a tool that worker_tools does not list is refused; Codex and Gemini workers with tests\stub-codex.js and
  tests\stub-gemini.js (their commands, prompts on stdin and ids, OPENAI_API_KEY removed, GEMINI_API_KEY passed
  through and never written down, the Gemini policy, exits 41 and 55, and refusals for the daily limit, a
  .gemini\settings.json in the worktree, Gemini system policies and a changed policy file). 25 Antigravity CLI
  workers with tests\stub-agy.js: off until worker_tools lists them; the command, the prompt as one stream-json line
  on stdin, and the conversation id saved while the run goes; the tokens; the warning in the log; the launcher's
  commit of a change with no Git hooks, none without one and none after a changed .git; a reviewer in the workers
  folder; antigravity_sandbox; exits 1 and 3, an ERROR result, a reason only on stderr and "authentication required"
  in plain words, with nothing committed; off with no worker_tools; refusals for .agents, .agent, _agents and _agent
  items and a .gemini\config.json in the worktree, the workers folder and the folders up to the worktree's top, a
  folder that is not a Git worktree, a Claude model, max effort and the daily limit.
  It runs only the bridge-relay.ps1, agent-mail.ps1 and spawn-worker.ps1 beside it, ..\tests\stub-claude.js,
  ..\tests\stub-codex.js, ..\tests\stub-gemini.js and ..\tests\stub-agy.js; other -RelayScript/-StubCli values are
  refused.
  Scenarios 24 and 25 need git.exe, for a Git folder in their fixtures. Scenario 24 sets two test-only variables that
  spawn-worker.ps1 reads (RELAY_TEST_GEMINI_POLICY_DIR and RELAY_TEST_CHANGE_POLICY); each one can only make the
  launcher refuse.
  Prints one PASS/FAIL line per check, then a summary. Exit 0 only when every check passes (2 = could not set up).
  No network, no API key, no real claude.exe. It removes its temp folder and stops any process it started
  (only processes whose command line names this run's temp folder). Takes about 6-10 minutes.
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
$StubGemini = Join-Path (Split-Path -Parent $HereDir) 'tests\stub-gemini.js'
$StubAgy = Join-Path (Split-Path -Parent $HereDir) 'tests\stub-agy.js'
$AgentMail = Join-Path $HereDir 'agent-mail.ps1'
$SpawnWorker = Join-Path $HereDir 'spawn-worker.ps1'
if (-not $RelayScript) { $RelayScript = $OwnRelay }
if (-not $StubCli) { $StubCli = $OwnStub }
foreach ($f in @($RelayScript, $StubCli, $StubCodex, $StubGemini, $StubAgy, $AgentMail, $SpawnWorker, $PsExe)) { if (-not (Test-Path -LiteralPath $f -PathType Leaf)) { Stop-Setup "not found: $f" } }
if (-not (Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue)) { Stop-Setup 'node.exe not found (the stub CLI needs it)' }
$RelayScript = (Resolve-Path -LiteralPath $RelayScript).Path
$StubCli = (Resolve-Path -LiteralPath $StubCli).Path
$StubCodex = (Resolve-Path -LiteralPath $StubCodex).Path
$StubGemini = (Resolve-Path -LiteralPath $StubGemini).Path
$StubAgy = (Resolve-Path -LiteralPath $StubAgy).Path
$DummyOpenAiKey = 'sk-relay-check-dummy-openai'   # set for every relay run; the Codex stub reports whether it saw it
$DummyGeminiKey = 'relay-check-dummy-gemini-key'  # set for every run; it must pass through to Gemini and be written nowhere
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

function Start-Mail([hashtable]$Fx, [string[]]$MailArgs) {
    # bin\agent-mail.ps1 on this fixture's mailbox, as an agent runs it.
    if (-not ([string]$Fx.mb).StartsWith($Base + '\', [StringComparison]::OrdinalIgnoreCase)) { throw "refusing: mailbox outside $Base" }
    $script:RunNo++
    $o = Join-Path $Fx.dir ('mail-{0:d2}.out.txt' -f $script:RunNo)
    $e = Join-Path $Fx.dir ('mail-{0:d2}.err.txt' -f $script:RunNo)
    $a = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $AgentMail, '-MailboxRoot', $Fx.mb) + @($MailArgs)
    $p = Start-Process -FilePath $PsExe -ArgumentList (($a | ForEach-Object { ConvertTo-Token $_ }) -join ' ') -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput $o -RedirectStandardError $e
    $null = $p.Handle
    [void]$script:Spawned.Add($p)
    return @{ proc = $p; out = $o; err = $e }
}

function Invoke-Mail([hashtable]$Fx, [string[]]$MailArgs) {
    $r = Start-Mail $Fx $MailArgs
    if (-not $r.proc.WaitForExit(60000)) {
        try { Stop-Process -Id $r.proc.Id -Force } catch { }
        throw 'agent-mail.ps1 did not exit within 60 s'
    }
    $out = Read-RelayOutput $r
    $script:LastOut = "[agent-mail exit $($r.proc.ExitCode)] $out"
    return @{ code = $r.proc.ExitCode; out = $out }
}

function Get-MailFiles([hashtable]$Fx, [string]$Key, [string]$Box) {
    return , @(Get-ChildItem -LiteralPath (Join-Path $Fx.mb "mail\$Key\$Box") -File -Filter '*.md' -ErrorAction SilentlyContinue)
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

function Get-MailDispatches([hashtable]$Fx) {
    $st = Get-RelayState $Fx
    if (-not $st) { return @() }
    return @(Get-Values $st.mail_dispatches | Sort-Object { [int64]$_.seq })
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

function Set-HqProjects([hashtable]$Fx, [string[]]$Ids, [object[]]$Extra) {
    # HQ's bin\relay-settings.json: role hq, the named projects of the fixture (and any extra entries), workspace-write.
    $list = @()
    foreach ($pf in @($Fx.p1, $Fx.p2)) {
        if ($Ids -contains $pf.id) { $list += [pscustomobject]@{ id = $pf.id; name = $pf.title; mailbox = $pf.mb } }
    }
    foreach ($e in @($Extra)) { if ($null -ne $e) { $list += $e } }
    $s = [ordered]@{ role = 'hq'; projects = $list; codex_exec_args = @('--sandbox', 'workspace-write') }
    Write-Text (Join-Path $Fx.mb 'bin\relay-settings.json') (ConvertTo-Json -InputObject $s -Depth 6)
}

function New-HqFixture([string]$Name) {
    # HQ (a fixture as above; its Codex thread is the orchestrator) and two project mailboxes beside it, notes and shop,
    # that share HQ's fake Codex home, Claude folder and stubs. HQ's settings list both projects.
    $fx = New-Fixture $Name
    foreach ($p in @(@{ key = 'p1'; id = 'notes'; title = 'Notes'; dir = 'proj-notes' }, @{ key = 'p2'; id = 'shop'; title = 'Shop'; dir = 'proj-shop' })) {
        $pf = $fx.Clone()
        $pf.mb = Join-Path $fx.dir $p.dir
        $pf.id = $p.id
        $pf.title = $p.title
        Write-Text (Join-Path $pf.mb 'CODEX-QUEUE.md') "# Codex queue (owner: Codex)`r`n"
        Write-Text (Join-Path $pf.mb 'STATUS.md') "# Status board (owner: Claude)`r`n"
        Write-Text (Join-Path $pf.mb 'tasks\T-BASE\assignment.md') "# Assignment - T-BASE ($($p.id), synthetic)`r`n`r`n- Goal: fixture only.`r`n"
        $fx[$p.key] = $pf
    }
    Set-HqProjects $fx @('notes', 'shop') $null
    return $fx
}

function New-WorkerFixture([string]$Name) {
    # A mailbox with its own copy of bin\spawn-worker.ps1 (the launcher treats the folder above bin as the mailbox), a
    # task with a workers folder, and a worktrees folder with one worktree folder in it.
    $fx = New-Fixture $Name
    $fx.task = 'T-20261104-01-workers'
    $fx.workers = Join-Path $fx.mb "tasks\$($fx.task)\workers"
    $fx.wtroot = Join-Path $fx.dir 'worktrees'
    $fx.wt = Join-Path $fx.wtroot "$($fx.task)\repo"
    $fx.spawn = Join-Path $fx.mb 'bin\spawn-worker.ps1'
    foreach ($d in @($fx.workers, $fx.wt, (Join-Path $fx.mb 'bin'))) { New-Item -ItemType Directory -Path $d -Force | Out-Null }
    Copy-Item -LiteralPath $SpawnWorker -Destination $fx.spawn
    if ($fx.wt -match '\s') { throw "the temp folder path has a space ($($fx.wt)); a brief's Worktree line cannot hold one. Re-run with a TEMP folder without spaces." }
    return $fx
}

function Set-WorkerSettings([hashtable]$Fx, [hashtable]$Extra) {
    # bin\relay-settings.json of a worker fixture: its worktrees folder, and any other settings.
    $s = @{ worktrees_dir = $Fx.wtroot }
    if ($Extra) { foreach ($k in @($Extra.Keys)) { $s[$k] = $Extra[$k] } }
    Write-Text (Join-Path $Fx.mb 'bin\relay-settings.json') (ConvertTo-Json -InputObject $s -Depth 4)
}

function Write-Brief([hashtable]$Fx, [string]$W, [string]$Type, [string]$Tool) {
    $t = "# Worker brief - $($Fx.task) / $W   (owner: Claude coordinator)`r`n`r`n- **Type:** $Type`r`n- **Tool:** $Tool`r`n" +
        "- **Worktree (your only working directory):** $($Fx.wt)`r`n- **Branch:** claude/$($Fx.task)`r`n`r`n" +
        "## Do`r`n1. Nothing: this is a synthetic brief (BRIEF-MARKER-$W).`r`n"
    Write-Text (Join-Path $Fx.workers "$W-brief.md") $t
}

function Start-Spawn([hashtable]$Fx, [string[]]$SpawnArgs) {
    # The fixture's own copy of bin\spawn-worker.ps1, for the fixture's task, as the coordinator runs it.
    if (-not ([string]$Fx.spawn).StartsWith($Base + '\', [StringComparison]::OrdinalIgnoreCase)) { throw "refusing: launcher outside $Base" }
    $env:RELAY_STUB_DIR = $Fx.stub          # inherited by the launcher, its hidden runner and the stub it starts
    $env:RELAY_STUB_CONFIG_DIR = $Fx.cfg
    $script:RunNo++
    $o = Join-Path $Fx.dir ('spawn-{0:d2}.out.txt' -f $script:RunNo)
    $e = Join-Path $Fx.dir ('spawn-{0:d2}.err.txt' -f $script:RunNo)
    $a = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $Fx.spawn, '-TaskId', $Fx.task) + @($SpawnArgs)
    $p = Start-Process -FilePath $PsExe -ArgumentList (($a | ForEach-Object { ConvertTo-Token $_ }) -join ' ') -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput $o -RedirectStandardError $e
    $null = $p.Handle
    [void]$script:Spawned.Add($p)
    return @{ proc = $p; out = $o; err = $e }
}

function Invoke-Spawn([hashtable]$Fx, [string[]]$SpawnArgs) {
    $r = Start-Spawn $Fx $SpawnArgs
    if (-not $r.proc.WaitForExit(120000)) {
        try { Stop-Process -Id $r.proc.Id -Force } catch { }
        throw 'spawn-worker.ps1 did not exit within 120 s'
    }
    $out = Read-RelayOutput $r
    $script:LastOut = "[spawn-worker exit $($r.proc.ExitCode)] $out"
    return @{ code = $r.proc.ExitCode; out = $out }
}

function Get-RunJson([hashtable]$Fx, [string]$W) {
    $f = Join-Path $Fx.workers "$W.run.json"
    for ($i = 0; $i -lt 10; $i++) {
        if (-not (Test-Path -LiteralPath $f)) { return $null }
        try { return (ConvertFrom-Json -InputObject (Read-Shared $f)) } catch { Start-Sleep -Milliseconds 200 }
    }
    throw "$W.run.json stayed unreadable"
}

function Set-GeminiStubMode([hashtable]$Fx, [string]$Mode) { [IO.File]::WriteAllText((Join-Path $Fx.stub 'gemini-mode.txt'), $Mode, $Utf8) }

function Get-GeminiCalls([hashtable]$Fx, [string]$Phase) {
    $f = Join-Path $Fx.stub 'gemini-calls.jsonl'
    if (-not (Test-Path -LiteralPath $f)) { return }
    foreach ($l in ((Read-Shared $f) -split "`n")) {
        $l = $l.Trim()
        if (-not $l) { continue }
        try { $c = ConvertFrom-Json -InputObject $l } catch { continue }
        if (-not $Phase -or $c.phase -eq $Phase) { $c }
    }
}

function Get-CodexWorkerCalls([hashtable]$Fx) { return @(Get-CodexCalls $Fx 'start' | Where-Object { $_.kind -eq 'worker' }) }

function Set-AgyStubMode([hashtable]$Fx, [string]$Mode) { [IO.File]::WriteAllText((Join-Path $Fx.stub 'agy-mode.txt'), $Mode, $Utf8) }

function Get-AgyCalls([hashtable]$Fx, [string]$Phase) {
    $f = Join-Path $Fx.stub 'agy-calls.jsonl'
    if (-not (Test-Path -LiteralPath $f)) { return }
    foreach ($l in ((Read-Shared $f) -split "`n")) {
        $l = $l.Trim()
        if (-not $l) { continue }
        try { $c = ConvertFrom-Json -InputObject $l } catch { continue }
        if (-not $Phase -or $c.phase -eq $Phase) { $c }
    }
}

function Get-RunningAgyStubs([hashtable]$Fx) { return @(Get-ChildItem -LiteralPath $Fx.stub -Filter 'agy-running-*' -File -ErrorAction SilentlyContinue).Count }

function Test-SaidText([string]$Out, [string]$Text) {
    # Like Test-Said, for plain text with no pattern in it.
    return (($Out -replace '\s+', '').Contains(($Text -replace '\s+', '')))
}

function ConvertTo-BaseText([string]$Text) {
    # Paths in this run's temp folder read as <base>, whether Windows shows it in its short (8.3) or long form.
    $t = ([string]$Text).Replace($Base, '<base>')
    return [regex]::Replace($t, '[A-Za-z]:\\[^\s"]*?\\' + [regex]::Escape($Token), '<base>')
}

function Get-ClaudeWorkerArgs([hashtable]$Fx, [string]$W, [string]$Sid) {
    # The arguments that spawn-worker.ps1 gave a Claude implementation worker before -Tool existed, with the usual
    # budget, model and effort. Kept here on purpose: a change to them must be a change to this list too.
    $brief = Join-Path $Fx.workers "$W-brief.md"
    $report = Join-Path $Fx.workers "$W-report.md"
    $prompt = "You are Claude worker $W (implementation). Read and follow exactly the brief at $brief. " +
        "Your working directory is the task worktree $($Fx.wt). Stay inside the brief's file scope. " +
        "Put throwaway scripts only in $env:TEMP. When finished, write your report to $report and stop."
    $deny = @('WebFetch', 'WebSearch', 'Bash(git push*)', 'Bash(git merge*)', 'Bash(git rebase*)', 'Bash(git reset*)',
        'Bash(git checkout*)', 'Bash(git switch*)', 'Bash(git branch*)', 'Bash(git worktree*)', 'Bash(git tag*)',
        'Bash(git stash*)', 'Bash(git config*)', 'Bash(npm *)', 'Bash(npx *)')
    $tools = @('Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash(git *)', 'Bash(node *)')
    return @('-p', $prompt, '--output-format', 'json', '--permission-mode', 'acceptEdits', '--setting-sources', '', '--strict-mcp-config',
        '--disable-slash-commands', '--tools', 'Read,Edit,Write,Glob,Grep,Bash', '--session-id', $Sid, '--add-dir', $Fx.workers,
        '--add-dir', $env:TEMP, '--allowedTools') + $tools + @('--disallowedTools') + $deny + @('--max-budget-usd', '3', '--model', 'claude-opus-5-5[1m]', '--effort', 'xhigh')
}

function Compare-ArgList([object[]]$Got, [object[]]$Want) {
    # '' when both lists are the same (paths compared from this run's temp folder on); else where they differ first.
    $g = @(@($Got) | ForEach-Object { ConvertTo-BaseText ([string]$_) })
    $w = @(@($Want) | ForEach-Object { ConvertTo-BaseText ([string]$_) })
    $n = [Math]::Max($g.Count, $w.Count)
    for ($i = 0; $i -lt $n; $i++) {
        $a = ''; $b = ''
        if ($i -lt $g.Count) { $a = $g[$i] }
        if ($i -lt $w.Count) { $b = $w[$i] }
        if ($i -ge $g.Count -or $i -ge $w.Count -or $a -cne $b) { return "argument $i is '$a', want '$b' ($($g.Count) of $($w.Count) arguments)" }
    }
    return ''
}

function Test-Said([string]$Out, [string]$Pattern) {
    # Windows PowerShell wraps a long error at the width of its console, even into a file, so this compares without
    # any white space. The pattern must not need its spaces.
    return (($Out -replace '\s+', '') -match ($Pattern -replace ' ', ''))
}

function Test-NoKeyText([hashtable]$Fx, [string]$Key) {
    # Names the files under the fixture that hold the key's text ('' when none does).
    $leak = @(Get-ChildItem -LiteralPath $Fx.dir -Recurse -File | Select-String -SimpleMatch $Key -List)
    return (($leak | ForEach-Object { $_.Path }) -join ', ')
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
$PreviousGeminiKey = $env:GEMINI_API_KEY
$PreviousGeminiHome = $env:GEMINI_CLI_HOME
try {
    New-Item -ItemType Directory -Path $Base -Force | Out-Null
    $env:OPENAI_API_KEY = $DummyOpenAiKey   # inherited by every relay run; the relay must not pass it to Codex
    $env:GEMINI_API_KEY = $DummyGeminiKey   # inherited by every launcher run; it passes through to Gemini untouched
    $env:GEMINI_CLI_HOME = Join-Path $Base 'gemini-home'   # a Gemini CLI would keep its settings and sessions here
    New-Item -ItemType Directory -Path $env:GEMINI_CLI_HOME -Force | Out-Null
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
        foreach ($bad in @('git push', 'powershell', 'agy -p')) {
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
        Check ($deny -contains 'Bash(agy*)') 'disallowedTools lacks Bash(agy*), so the coordinator could start Antigravity CLI itself'
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
    Invoke-Scenario '17 agent mail: send, read and wait by name; names, sizes and unknown agents are checked' {
        $fx = New-Fixture 'am1'
        $r = Invoke-Mail $fx @('-Send', '-From', 'Colonel', '-To', 'Sergeant Test', '-Text', 'Start T-12.')
        Check ($r.code -ne 0 -and $r.out -match 'No agent named') 'mail to an unknown name was sent without -NewAgent'
        $r = Invoke-Mail $fx @('-Send', '-From', 'Colonel', '-To', 'Sergeant Test', '-Text', 'Start T-12. Report when done.', '-NewAgent')
        Check ($r.code -eq 0 -and $r.out -match 'Sent to Sergeant Test') "-Send exit code $($r.code): $(Get-Tail $r.out)"
        $m = Get-MailFiles $fx 'sergeant-test' 'new'
        Check ($m.Count -eq 1) "expected 1 new message, got $($m.Count)"
        if ($m.Count -eq 1) {
            $t = Read-Shared $m[0].FullName
            Check ($t -match '(?m)^From: Colonel\r?$' -and $t -match '(?m)^To: Sergeant Test\r?$' -and $t -match '(?m)^Sent: \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ\r?$' -and
                $t -match 'Report when done') 'the message file does not hold From, To, Sent and the text'
        }
        foreach ($bad in @('Bad;Name', 'con', 'Colonel')) {
            $r = Invoke-Mail $fx @('-Send', '-From', 'Colonel', '-To', $bad, '-Text', 'x', '-NewAgent')
            Check ($r.code -ne 0) "a bad recipient was accepted: '$bad'"
        }
        $big = Join-Path $fx.dir 'big.txt'
        Write-Text $big ('x' * 70000)
        $r = Invoke-Mail $fx @('-Send', '-From', 'Colonel', '-To', 'Sergeant Test', '-TextFile', $big)
        Check ($r.code -ne 0 -and $r.out -match '64 KB') 'a message over 64 KB was sent'
        Check ((Get-MailFiles $fx 'sergeant-test' 'new').Count -eq 1) 'a refused message left a file'
        # Read: printed, then moved to read\. Case and extra spaces in the name do not count.
        $r = Invoke-Mail $fx @('-Read', '-Me', 'sergeant   test')
        Check ($r.code -eq 0 -and $r.out -match 'for Sergeant Test' -and $r.out -match 'From: Colonel' -and $r.out -match 'Report when done') '-Read did not print the message'
        Check ((Get-MailFiles $fx 'sergeant-test' 'new').Count -eq 0 -and (Get-MailFiles $fx 'sergeant-test' 'read').Count -eq 1) '-Read did not move the message to read'
        $r = Invoke-Mail $fx @('-Read', '-Me', 'Sergeant Test')
        Check ($r.out -match 'No new mail for Sergeant Test') 'a second -Read did not say that no new mail waits'
        # Wait: ends after -Seconds without mail, and as soon as mail comes.
        $t0 = Get-Date
        $r = Invoke-Mail $fx @('-Wait', '-Me', 'Sergeant Test', '-Seconds', '2')
        Check ($r.out -match 'No new mail for Sergeant Test after 2 seconds' -and ((Get-Date) - $t0).TotalSeconds -lt 30) '-Wait did not end after 2 seconds without mail'
        $w = Start-Mail $fx @('-Wait', '-Me', 'Sergeant Test', '-Seconds', '90')
        Start-Sleep -Seconds 3
        $null = Invoke-Mail $fx @('-Send', '-From', 'Colonel', '-To', 'Sergeant Test,Sergeant Two', '-Text', 'Both of you: stand by.', '-NewAgent')
        Check ($w.proc.WaitForExit(30000)) '-Wait did not end when mail came'
        Check ((Read-RelayOutput $w) -match 'stand by') '-Wait did not print the mail that came'
        $two = Get-MailFiles $fx 'sergeant-two' 'new'
        Check ($two.Count -eq 1 -and (Read-Shared $two[0].FullName) -match '(?m)^To: Sergeant Test, Sergeant Two\r?$') 'a message to two agents did not reach both, with both names on its To line'
        $r = Invoke-Mail $fx @('-List')
        Check ($r.out -match 'Sergeant Two\s+1 new') '-List does not show the new message for Sergeant Two'
    }

    Invoke-Scenario '18 agent mail wakes: enrolled by name, one wake per new message, none for mail already read, waits while the thread is open, a few at once' {
        $fx = New-Fixture 'am2'
        Initialize-Fixture $fx
        $w1 = Join-Path $fx.dir 'sergeant1'
        $w2 = Join-Path $fx.dir 'sergeant2'
        foreach ($d in @($w1, $w2)) { New-Item -ItemType Directory -Path $d -Force | Out-Null }
        $t1 = [guid]::NewGuid().ToString()
        $t2 = [guid]::NewGuid().ToString()
        Write-Thread $fx $t1 '2026-10-09T06:00:00Z' $w1 '**Sergeant One'
        Write-Thread $fx $t2 '2026-10-09T06:00:00Z' $w2 'Sergeant Two'
        $r = Invoke-Relay $fx 'EnrollAgent' @{ AgentName = 'Nobody' }
        Check ($r.code -ne 0 -and $r.out -match 'No live Codex thread named') '-EnrollAgent accepted a name that no Codex thread has'
        # Mail that waits when the agent is enrolled counts as known: enrolling wakes nothing.
        $null = Invoke-Mail $fx @('-Send', '-From', 'Colonel', '-To', 'Sergeant One', '-Text', 'Old order.', '-NewAgent')
        $r = Invoke-Relay $fx 'EnrollAgent' @{ AgentName = 'sergeant one' }
        Check ($r.code -eq 0) "-EnrollAgent exit code $($r.code): $(Get-Tail $r.out)"
        $aj = Get-RelayJson $fx 'agents.json'
        Check ($aj -and $aj.'sergeant-one'.thread_id -eq $t1 -and $aj.'sergeant-one'.name -eq 'Sergeant One') 'agents.json does not hold Sergeant One, named as its thread is, with its thread'
        $null = Invoke-Relay $fx 'Once' $null
        Check (@(Get-CodexCalls $fx 'start').Count -eq 0) 'enrolling woke the agent for mail that was already waiting'
        # New mail: the dry run shows the command; -Once wakes the thread once, in its own folder.
        $null = Invoke-Mail $fx @('-Send', '-From', 'Colonel', '-To', 'Sergeant One', '-Text', 'New order.')
        $r = Invoke-Relay $fx 'DryRun' $null
        Check ($r.out -match 'would wake Sergeant One' -and $r.out -match ('exec --json --skip-git-repo-check resume ' + $t1)) 'the dry run did not show the wake for Sergeant One'
        $r1 = Invoke-Relay $fx 'Once' $null
        $r2 = Invoke-Relay $fx 'Once' $null
        Check ($r1.code -eq 0 -and $r2.code -eq 0) "-Once exit codes $($r1.code)/$($r2.code)"
        $s = @(Get-CodexCalls $fx 'start')
        Check ($s.Count -eq 1) "expected 1 Codex call, got $($s.Count)"
        if ($s.Count -ge 1) {
            $c = $s[0]
            Check ($c.thread -eq $t1) "woke thread '$($c.thread)' instead of the thread of Sergeant One"
            Check ($c.exec -and $c.json -and $c.skip_git -and -not $c.last -and -not $c.bypass) 'unsafe or missing Codex options (want exec --json --skip-git-repo-check; never --last or a sandbox bypass)'
            Check ($c.prompt -match '\[bridge-relay M' -and $c.prompt -match "-Read -Me 'Sergeant One'" -and $c.prompt -match 'from Colonel') 'the notice does not say who wrote and how to read the mail'
            Check ($c.prompt -notmatch 'Old order') 'the notice repeats mail text'
            Check ([bool]$c.key_absent) 'the agent turn inherited an OpenAI or Codex API key'
            Check ([string]$c.cwd -like '*\am2\sergeant1') "the agent turn ran in '$($c.cwd)', not in its thread's folder"
        }
        $md = @(Get-MailDispatches $fx)
        Check ($md.Count -eq 1 -and $md[0].outcome -eq 'success') 'the mail wake is not recorded once with outcome success'
        # Mail the agent read by itself needs no wake.
        $null = Invoke-Mail $fx @('-Send', '-From', 'Colonel', '-To', 'Sergeant One', '-Text', 'Third order.')
        $null = Invoke-Mail $fx @('-Read', '-Me', 'Sergeant One')
        $null = Invoke-Relay $fx 'Once' $null
        Check (@(Get-CodexCalls $fx 'start').Count -eq 1) 'the relay woke the agent for mail it had already read'
        # Another program holds the thread: the mail waits until it lets go.
        $lock = Join-Path $fx.codex ('thread-writer-locks\' + $t1 + '.lock')
        Write-Text $lock ''
        $held = [IO.File]::Open($lock, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
        try {
            $null = Invoke-Mail $fx @('-Send', '-From', 'Colonel', '-To', 'Sergeant One', '-Text', 'Fourth order.')
            $r = Invoke-Relay $fx 'Once' $null
            Check ($r.out -match 'another Codex program has thread') 'the relay did not say that another program has the thread open'
            Check (@(Get-CodexCalls $fx 'start').Count -eq 1) 'the agent was woken while another program held its thread'
        } finally { $held.Dispose() }
        $null = Invoke-Relay $fx 'Once' $null
        Check (@(Get-CodexCalls $fx 'start').Count -eq 2) 'the agent was not woken after the other program let go of its thread'
        # Two agents run at once; with at most one at once, the other waits for it.
        $r = Invoke-Relay $fx 'EnrollAgent' @{ AgentName = 'Sergeant Two' }
        Check ($r.code -eq 0) "-EnrollAgent Sergeant Two exit code $($r.code): $(Get-Tail $r.out)"
        Set-CodexStubMode $fx 'sleep:10'
        $null = Invoke-Mail $fx @('-Send', '-From', 'Colonel', '-To', 'Sergeant One,Sergeant Two', '-Text', 'Fifth order.')
        $null = Invoke-Relay $fx 'Once' @{ NoWait = $true }
        Check (Wait-Until { (Get-RunningCodexStubs $fx) -eq 2 } 20) 'the two agents did not run at the same time'
        Check (Wait-Until { (Get-RunningCodexStubs $fx) -eq 0 } 40) 'the two agent turns did not end'
        $null = Invoke-Relay $fx 'Once' $null
        $null = Invoke-Mail $fx @('-Send', '-From', 'Colonel', '-To', 'Sergeant One,Sergeant Two', '-Text', 'Sixth order.')
        $r = Invoke-Relay $fx 'Once' @{ NoWait = $true; MaxAgentTurnsAtOnce = 1 }
        Check (Wait-Until { (Get-RunningCodexStubs $fx) -eq 1 } 20) 'no agent turn started'
        if ((Get-RunningCodexStubs $fx) -ne 1) { throw 'timing: the 10 s agent turn ended before the check; re-run on a less loaded machine' }
        Check ($r.out -match 'at most 1 at once') 'the relay did not hold the second agent back (at most 1 at once)'
        Check (Wait-Until { (Get-RunningCodexStubs $fx) -eq 0 } 40) 'the agent turn did not end'
        Set-CodexStubMode $fx 'ok'
        $null = Invoke-Relay $fx 'Once' @{ MaxAgentTurnsAtOnce = 1 }
        $n = @(Get-CodexCalls $fx 'start').Count
        Check ($n -eq 6) "expected 6 Codex calls in total, got $n"
        $r = Invoke-Relay $fx 'Status' $null
        Check ($r.out -match 'Agent mail: ON for 2 agent' -and $r.out -match 'Sergeant One: Codex thread') 'status does not show the two agents'
        $r = Invoke-Relay $fx 'UnenrollAgent' @{ AgentName = 'Sergeant Two' }
        Check ($r.code -eq 0 -and -not (Get-RelayJson $fx 'agents.json').'sergeant-two') '-UnenrollAgent did not remove Sergeant Two'
        Check (@(Get-Calls $fx 'start').Count -eq 0) 'agent mail woke the coordinator'
    }

    Invoke-Scenario '19 HQ: one orchestrator wake covers items from both projects; what waited when a project was added wakes nothing; -DryRun changes nothing' {
        $fx = New-HqFixture 'hq1'
        Set-HqProjects $fx @('notes') $null
        # Already waiting in shop before HQ lists it.
        Write-Text (Join-Path $fx.p2.mb 'tasks\T-BASE\questions.md') (Get-Questions @(5))
        Initialize-Fixture $fx
        $r = Invoke-Relay $fx 'EnrollCodex' @{ ThreadId = $fx.tid }
        if ($r.code -ne 0) { throw "-EnrollCodex failed (exit $($r.code)): $(Get-Tail $r.out)" }
        # The owner adds shop, and two entries the relay must skip.
        $bad = @([pscustomobject]@{ id = 'hq'; name = 'Bad'; mailbox = $fx.p1.mb }, [pscustomobject]@{ id = 'gone'; name = 'Gone'; mailbox = (Join-Path $fx.dir 'nowhere') })
        Set-HqProjects $fx @('notes', 'shop') $bad
        $r = Invoke-Relay $fx 'Once' $null
        Check ($r.code -eq 0) "-Once exit code $($r.code)"
        Check ($r.out -match 'project shop .+ is new to this relay') 'the relay did not say that the shop project is new to it'
        Check (@(Get-CodexCalls $fx 'start').Count -eq 0) 'adding a project woke the orchestrator for an item that was already waiting in it'
        $r = Invoke-Relay $fx 'Status' $null
        Check ($r.out -match '- notes \(Notes\): mailbox .+; folder found: True' -and $r.out -match '- shop \(Shop\): mailbox .+; folder found: True') '-Status does not list the two projects'
        Check ($r.out -match 'entry 3 \(hq\) is skipped' -and $r.out -match 'entry 4 \(gone\) is skipped') '-Status does not show the two bad entries as skipped'
        Check (@(Get-AttentionKeys $r.out) -contains 'shop:T-BASE/Q5') '-Status does not list the waiting shop item under its project key'
        # New items in both projects: the dry run shows one wake, with both project folders, and changes nothing.
        Write-Text (Join-Path $fx.p1.mb 'tasks\T-BASE\questions.md') (Get-Questions @(2))
        Write-Text (Join-Path $fx.p2.mb 'tasks\T-BASE\status.md') "# Status - T-BASE`r`n`r`n**Current state:** IN_REVIEW (handoff written)`r`n"
        Write-Text (Join-Path $fx.p2.mb 'tasks\T-BASE\handoff.md') "# Handoff - T-BASE`r`n`r`n- Result: ready for review.`r`n"
        $sf = Join-Path $fx.mb '.relay\state.json'
        $before = (Get-FileHash -LiteralPath $sf -Algorithm SHA256).Hash
        $r = Invoke-Relay $fx 'DryRun' $null
        Check ($r.out -match 'would wake Codex thread') 'the dry run did not report the orchestrator wake'
        Check ($r.out -match 'workspace-write --add-dir "?[^"]*proj-notes"? --add-dir "?[^"]*proj-shop') 'the dry run command does not add both project folders'
        Check ((Get-FileHash -LiteralPath $sf -Algorithm SHA256).Hash -eq $before) 'the dry run changed state.json'
        Check (@(Get-CodexCalls $fx '').Count -eq 0) 'the dry run called the Codex stub'
        Check (-not (Test-Path -LiteralPath (Join-Path $fx.p1.mb '.relay')) -and -not (Test-Path -LiteralPath (Join-Path $fx.p2.mb '.relay'))) 'HQ wrote into a project mailbox'
        $r1 = Invoke-Relay $fx 'Once' $null
        $r2 = Invoke-Relay $fx 'Once' $null
        Check ($r1.code -eq 0 -and $r2.code -eq 0) "-Once exit codes $($r1.code)/$($r2.code)"
        $s = @(Get-CodexCalls $fx 'start')
        Check ($s.Count -eq 1) "expected 1 orchestrator wake, got $($s.Count)"
        if ($s.Count -ge 1) {
            $c = $s[0]
            Check ($c.thread -eq $fx.tid) 'the wake did not go to the orchestrator thread'
            Check ($c.prompt -match 'project notes' -and $c.prompt -match 'project shop') 'one wake does not name both projects'
            Check ($c.prompt -match 'proj-notes' -and $c.prompt -match 'proj-shop') 'the notice does not name the project mailbox folders'
            Check ($c.prompt -match 'Q2' -and $c.prompt -match 'IN_REVIEW' -and $c.prompt -notmatch 'Q5') 'the wake does not hold exactly the two new items'
            $x = @($c.extra)
            $dirs = @()
            for ($i = 0; $i -lt $x.Count - 1; $i++) { if ($x[$i] -eq '--add-dir') { $dirs += [string]$x[$i + 1] } }
            Check ($dirs.Count -eq 2 -and $dirs[0] -like '*\hq1\proj-notes' -and $dirs[1] -like '*\hq1\proj-shop') ('the wake did not add exactly the two project folders: ' + ($x -join ' '))
            Check ($x -contains 'workspace-write') 'the wake lost codex_exec_args'
        }
        $n = @(Get-CodexNotes $fx | Where-Object { $_.key -eq 'notes:T-BASE/Q2' -or $_.key -like 'shop:T-BASE/handoff@*' })
        Check ($n.Count -eq 2 -and @($n | Where-Object { $_.state -ne 'completed' }).Count -eq 0) 'the two project items are not recorded once each as completed, under their project keys'
        $att = Read-Shared (Join-Path $fx.mb '.relay\codex-attention.md')
        Check ($att -match '\| Item \| Project \| Task \|' -and $att -match '\| notes:T-BASE/Q2 \| notes \|' -and $att -match '\| shop:T-BASE/Q5 \| shop \|') 'codex-attention.md has no Project column with the project items'
        Check (@(Get-Calls $fx 'start').Count -eq 0) 'project items woke the coordinator of HQ'
    }

    Invoke-Scenario '20 HQ: a project item waits while that project''s coordinator turn runs; the other project''s item still goes; never two Codex processes' {
        $fx = New-HqFixture 'hq2'
        Initialize-Fixture $fx
        $r = Invoke-Relay $fx 'EnrollCodex' @{ ThreadId = $fx.tid }
        if ($r.code -ne 0) { throw "-EnrollCodex failed (exit $($r.code)): $(Get-Tail $r.out)" }
        # The notes relay runs a coordinator turn: its state.json names a running turn of a live process (this harness).
        $busy = @{ dispatches = @{ 'R-fixture' = @{ id = 'R-fixture'; state = 'running'; pid = $PID } } }
        $nsf = Join-Path $fx.p1.mb '.relay\state.json'
        Write-Text $nsf (ConvertTo-Json -InputObject $busy -Depth 5)
        Write-Text (Join-Path $fx.p1.mb 'tasks\T-BASE\questions.md') (Get-Questions @(2))
        Write-Text (Join-Path $fx.p2.mb 'tasks\T-BASE\questions.md') (Get-Questions @(3))
        Set-CodexStubMode $fx 'sleep:12'
        $r = Invoke-Relay $fx 'Once' @{ NoWait = $true }
        Check ($r.out -match 'item\(s\) of project notes wait' -and $r.out -match 'a coordinator turn runs there') 'the notes item did not wait for the coordinator turn of notes'
        Check (Wait-Until { (Get-RunningCodexStubs $fx) -eq 1 } 15) 'the shop item did not wake the orchestrator'
        $s = @(Get-CodexCalls $fx 'start')
        Check ($s.Count -eq 1 -and $s[0].prompt -match 'project shop' -and $s[0].prompt -notmatch 'project notes') 'the first wake was not exactly the shop item'
        # A state.json that cannot be read counts as a running turn.
        Write-Text $nsf '{ not json'
        $r = Invoke-Relay $fx 'Once' @{ NoWait = $true }
        Check ($r.out -match 'could not be read') 'a state.json that cannot be read did not hold the notes item'
        # The notes turn is over, but the orchestrator still runs the shop wake: never a second Codex process.
        Remove-Item -LiteralPath $nsf -Force
        $r = Invoke-Relay $fx 'Once' @{ NoWait = $true }
        if ((Get-RunningCodexStubs $fx) -ne 1) { throw 'timing: the 12 s Codex turn ended before the check; re-run on a less loaded machine' }
        Check ($r.out -match 'Codex wake C\S+ is still running') 'the notes item did not wait for the running orchestrator turn'
        Check (@(Get-CodexCalls $fx 'start').Count -eq 1) 'a second Codex process started while the orchestrator ran'
        Check (Wait-Until { (Get-RunningCodexStubs $fx) -eq 0 } 40) 'the orchestrator turn did not end'
        Set-CodexStubMode $fx 'ok'
        $null = Invoke-Relay $fx 'Once' $null
        $null = Invoke-Relay $fx 'Once' $null
        $s = @(Get-CodexCalls $fx 'start')
        Check ($s.Count -eq 2) "expected 2 orchestrator wakes in total, got $($s.Count)"
        if ($s.Count -eq 2) { Check ($s[1].prompt -match 'project notes' -and $s[1].prompt -notmatch 'project shop') 'the second wake was not exactly the notes item' }
        Check (Test-NoOverlap $fx -Codex) 'two Codex processes were alive at the same time'
    }

    Invoke-Scenario '21 HQ: a project that also wakes the orchestrator''s thread stops the orchestrator wakes, with an alert' {
        $fx = New-HqFixture 'hq3'
        Initialize-Fixture $fx
        $r = Invoke-Relay $fx 'EnrollCodex' @{ ThreadId = $fx.tid }
        if ($r.code -ne 0) { throw "-EnrollCodex failed (exit $($r.code)): $(Get-Tail $r.out)" }
        # The notes relay enrolls the same thread for its own planner wake (both use one Codex home).
        $r = Invoke-Relay $fx.p1 'EnrollCodex' @{ ThreadId = $fx.tid }
        Check ($r.code -eq 0) "-EnrollCodex in the notes project exit code $($r.code): $(Get-Tail $r.out)"
        Write-Text (Join-Path $fx.p2.mb 'tasks\T-BASE\questions.md') (Get-Questions @(2))
        $null = Invoke-Relay $fx 'Once' $null
        Check (@(Get-CodexCalls $fx 'start').Count -eq 0) 'HQ woke the orchestrator although the notes project wakes the same thread'
        $st = Get-RelayState $fx
        Check ([string]$st.codex_halt -match 'project notes') 'HQ did not stop its orchestrator wakes for the notes project'
        Check (-not $st.halt) 'the shared thread stopped the coordinator direction too'
        $al = Read-Shared (Join-Path $fx.mb '.relay\alerts.md')
        Check ($al -match 'project notes' -and $al -match '-UnenrollCodex') 'the alert does not say to run -UnenrollCodex in the notes project'
        # Fixed in the project: after -ClearHalt the wake goes.
        $null = Invoke-Relay $fx.p1 'UnenrollCodex' $null
        $null = Invoke-Relay $fx 'ClearHalt' $null
        $null = Invoke-Relay $fx 'Once' $null
        Check (@(Get-CodexCalls $fx 'start').Count -eq 1) 'the orchestrator was not woken after the notes project let go of the thread'
        # An agent of the shop project on the same thread stops the wakes too.
        $agents = @{ orch = @{ name = 'Orchestrator'; key = 'orch'; thread_id = $fx.tid } }
        Write-Text (Join-Path $fx.p2.mb '.relay\agents.json') (ConvertTo-Json -InputObject $agents -Depth 4)
        Write-Text (Join-Path $fx.p1.mb 'tasks\T-BASE\questions.md') (Get-Questions @(3))
        $null = Invoke-Relay $fx 'Once' $null
        Check (@(Get-CodexCalls $fx 'start').Count -eq 1) 'HQ woke the orchestrator although an agent of the shop project uses the same thread'
        Check ([string](Get-RelayState $fx).codex_halt -match 'project shop') 'HQ did not stop its orchestrator wakes for the agent of the shop project'
        Check ((Read-Shared (Join-Path $fx.mb '.relay\alerts.md')) -match '-UnenrollAgent') 'the alert does not say to run -UnenrollAgent'
    }

    Invoke-Scenario '22 HQ: -NewProject makes a project mailbox and lists it; the same id again is refused; -UpdateProjects copies only the scripts' {
        $fx = New-HqFixture 'hq4'
        # HQ holds its own copy of the relay, the way the README's setup makes one.
        $repoRelay = Split-Path -Parent $HereDir
        foreach ($f in @(Get-ChildItem -LiteralPath $HereDir -File | Where-Object { $_.Name -match '\.ps1$|\.example\.json$' })) {
            Copy-Item -LiteralPath $f.FullName -Destination (Join-Path (Join-Path $fx.mb 'bin') $f.Name)
        }
        foreach ($sub in @('tests', 'templates')) {
            $to = Join-Path $fx.mb $sub
            New-Item -ItemType Directory -Path $to -Force | Out-Null
            foreach ($f in @(Get-ChildItem -LiteralPath (Join-Path $repoRelay $sub) -File)) { Copy-Item -LiteralPath $f.FullName -Destination (Join-Path $to $f.Name) }
        }
        Write-Text (Join-Path $fx.mb 'README.md') "# Mailbox protocol (synthetic)`r`n"
        Write-Text (Join-Path $fx.mb 'CLAUDE.md') "# Standing orders (synthetic)`r`n"
        Write-Text (Join-Path $fx.mb 'bin\cost-limits.json') '{"enabled":false}'
        $r = Invoke-Relay $fx 'NewProject' @{ ProjectId = 'garden'; ProjectName = 'Garden' }
        Check ($r.code -eq 0) "-NewProject exit code $($r.code): $(Get-Tail $r.out)"
        $pg = Join-Path $fx.mb 'projects\garden'
        foreach ($rel in @('bin\bridge-relay.ps1', 'bin\agent-mail.ps1', 'bin\spawn-worker.ps1', 'bin\relay-settings.example.json', 'bin\cost-limits.json',
                'tests\stub-codex.js', 'tests\stub-claude.js', 'templates\assignment.md', 'README.md', 'CLAUDE.md')) {
            Check (Test-Path -LiteralPath (Join-Path $pg $rel) -PathType Leaf) "-NewProject did not make $rel"
        }
        Check (Test-Path -LiteralPath (Join-Path $pg 'tasks') -PathType Container) '-NewProject did not make the tasks folder'
        $q = Join-Path $pg 'CODEX-QUEUE.md'
        Check ((Test-Path -LiteralPath $q) -and (Read-Shared $q) -match '^# Codex queue \(owner: Codex\)') 'CODEX-QUEUE.md does not start the way the README setup starts it'
        $b = Join-Path $pg 'STATUS.md'
        Check ((Test-Path -LiteralPath $b) -and (Read-Shared $b) -match '^# Status board \(owner: Claude\)') 'STATUS.md does not start the way the README setup starts it'
        $ps = $null
        try { $ps = ConvertFrom-Json -InputObject (Read-Shared (Join-Path $pg 'bin\relay-settings.json')) } catch { }
        $hqRoot = [IO.Path]::GetFullPath($fx.mb).TrimEnd('\')
        Check ($ps -and -not $ps.role -and $null -eq $ps.projects -and $ps.hq_dir -eq $hqRoot -and @($ps.codex_exec_args) -contains 'workspace-write') 'the project settings are not HQ''s without role and projects, with hq_dir'
        $hs = ConvertFrom-Json -InputObject (Read-Shared (Join-Path $fx.mb 'bin\relay-settings.json'))
        $g = @(@($hs.projects) | Where-Object { $_.id -eq 'garden' })
        Check ($g.Count -eq 1 -and $g[0].name -eq 'Garden' -and $g[0].mailbox -eq $pg) 'the projects list of HQ does not hold the garden project'
        Check (@($hs.projects).Count -eq 3 -and $hs.role -eq 'hq') 'the settings of HQ lost the other projects or the role'
        Check (@(Get-ChildItem -LiteralPath (Join-Path $fx.mb 'bin') -File -Filter 'relay-settings.json.bak-*').Count -eq 1) '-NewProject kept no copy of the old HQ settings'
        $g2 = Join-Path $fx.dir 'garden2'
        $r = Invoke-Relay $fx 'NewProject' @{ ProjectId = 'garden'; ProjectName = 'Garden again'; ProjectFolder = $g2 }
        Check ($r.code -ne 0 -and $r.out -match 'already has a project') 'a second -NewProject with the same id was not refused'
        Check (-not (Test-Path -LiteralPath $g2)) 'the refused -NewProject made a folder'
        $r = Invoke-Relay $fx.p1 'NewProject' @{ ProjectId = 'other'; ProjectName = 'Other' }
        Check ($r.code -ne 0 -and $r.out -match 'not HQ') '-NewProject worked in a mailbox that is not HQ'
        # -UpdateProjects copies the scripts and keeps the one it replaced; the settings stay; a running relay is skipped.
        $gs = Join-Path $pg 'bin\bridge-relay.ps1'
        Write-Text $gs "# an older relay`r`n"
        $setBefore = (Get-FileHash -LiteralPath (Join-Path $pg 'bin\relay-settings.json') -Algorithm SHA256).Hash
        $lockFile = Join-Path $fx.p2.mb '.relay\relay.lock'
        Write-Text $lockFile ('{"pid":' + $PID + ',"mode":"Start","started":"2026-11-03 10:00:00","started_utc":0,"poll_seconds":1}')
        $held = [IO.File]::Open($lockFile, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::Read)
        try { $r = Invoke-Relay $fx 'UpdateProjects' $null } finally { $held.Dispose() }
        Check ($r.code -eq 0) "-UpdateProjects exit code $($r.code): $(Get-Tail $r.out)"
        $hqHash = (Get-FileHash -LiteralPath (Join-Path $fx.mb 'bin\bridge-relay.ps1') -Algorithm SHA256).Hash
        Check ((Get-FileHash -LiteralPath $gs -Algorithm SHA256).Hash -eq $hqHash) '-UpdateProjects did not copy the relay of HQ into the garden project'
        Check (@(Get-ChildItem -LiteralPath (Join-Path $pg 'bin') -File -Filter 'bridge-relay.ps1.bak-*').Count -eq 1) '-UpdateProjects kept no copy of the script it replaced'
        Check ((Get-FileHash -LiteralPath (Join-Path $pg 'bin\relay-settings.json') -Algorithm SHA256).Hash -eq $setBefore) '-UpdateProjects changed the project settings'
        Check (Test-Path -LiteralPath (Join-Path $fx.p1.mb 'bin\bridge-relay.ps1') -PathType Leaf) '-UpdateProjects did not copy the relay into the notes project'
        Check (Test-Path -LiteralPath (Join-Path $fx.p1.mb 'tests\stub-codex.js') -PathType Leaf) '-UpdateProjects did not copy the stubs into the notes project'
        Check (-not (Test-Path -LiteralPath (Join-Path $fx.p1.mb 'bin\relay-settings.json')) -and -not (Test-Path -LiteralPath (Join-Path $fx.p1.mb 'templates'))) '-UpdateProjects copied settings or templates'
        Check (-not (Test-Path -LiteralPath (Join-Path $fx.p2.mb 'bin\bridge-relay.ps1')) -and $r.out -match 'Skipped shop') '-UpdateProjects did not skip the shop project, whose relay runs'
    }

    Invoke-Scenario '23 workers: Claude through claude_exe gets the same arguments, session id and budget as before; a tool not in worker_tools is refused, and nothing starts' {
        $fx = New-WorkerFixture 'wk1'
        Set-WorkerSettings $fx @{ claude_exe = $StubCli }   # no worker_tools: Claude only, as before
        # A ledger from before the Tool and Tokens columns: its rows stay as they are.
        $ledger = Join-Path $fx.workers 'runs.md'
        $old = "| Started | Finished | Worker | Type | State | Exit | Cost USD | Turns | Budget | Models |`r`n|---|---|---|---|---|---|---|---|---|---|`r`n" +
            "| 2026-11-01 10:00:00 | 2026-11-01 10:05:00 | W9 | implementation | finished | 0 | 0.5 | 3 | 3 | claude-opus-5-5 |`r`n"
        Write-Text $ledger $old
        Write-Brief $fx 'W1' 'implementation' 'claude'
        $previousKey = $env:ANTHROPIC_API_KEY
        $env:ANTHROPIC_API_KEY = $DummyKey   # the launcher must keep it from the worker, as before
        try { $r = Invoke-Spawn $fx @('-Worker', 'W1') } finally {
            if ($null -ne $previousKey) { $env:ANTHROPIC_API_KEY = $previousKey } else { Remove-Item Env:ANTHROPIC_API_KEY -ErrorAction SilentlyContinue }
        }
        Check ($r.code -eq 0 -and (Test-Said $r.out ('Launched W1 \(implementation\) for ' + $fx.task + ' - runner pid \d+, model claude-opus-5-5\[1m\], effort xhigh\. Check: -Status'))) "the launch line changed: $(Get-Tail $r.out)"
        Check (Wait-Until { (Test-Path -LiteralPath $ledger) -and (Read-Shared $ledger) -match '\| W1 \|' } 90) 'the Claude worker run did not end with a line in runs.md'
        $s = Get-RunJson $fx 'W1'
        $c = @(Get-Calls $fx 'start')
        Check ($c.Count -eq 1) "expected 1 Claude worker run, got $($c.Count)"
        if ($c.Count -ge 1 -and $s) {
            $why = Compare-ArgList @($c[0].args) (Get-ClaudeWorkerArgs $fx 'W1' ([string]$s.session_id))
            Check (-not $why) "the Claude worker's arguments changed: $why"
            Check ($c[0].session_id_flag -eq $s.session_id -and [string]$s.session_id -match '^[0-9a-f]{8}-[0-9a-f]{4}-') 'the session id in run.json is not the one the worker got'
            Check ($c[0].max_budget_usd -eq '3') "the budget was '$($c[0].max_budget_usd)', want 3"
            Check (-not $c[0].key_present -and $c[0].oauth_absent) 'the Claude worker inherited an API key or an overriding OAuth token'
            Check ([string]$c[0].cwd -like '*\wk1\worktrees\*\repo') "the Claude worker ran in '$($c[0].cwd)', not in the worktree"
        }
        Check ($s -and $s.tool -eq 'claude' -and $s.state -eq 'finished' -and $s.exit_code -eq 0 -and $s.budget_usd -eq 3 -and
            $s.billing -eq 'claude-code-subscription' -and $s.cost_usd -eq 0.05) 'W1.run.json does not record the Claude run as before, with tool claude'
        Check ($s -and $s.tokens -and $s.tokens.total -eq 1160 -and $s.tokens.cached -eq 1000) 'W1.run.json does not hold the token counts'
        $led = Read-Shared $ledger
        Check ($led.StartsWith($old)) 'the old rows of runs.md changed'
        Check ($led -match [regex]::Escape('| Started | Finished | Worker | Type | State | Exit | Cost USD | Turns | Budget | Models | Tool | Tokens |') -and
            $led -match '\| W1 \| implementation \| finished \| 0 \| 0\.05 \| 2 \| 3 \| claude-opus-5-5 \| claude \| 1160 \(in 1110, out 50, cached 1000\) \|') 'runs.md has no new table with the Tool and Tokens of the run'
        # Codex and Gemini are off until worker_tools lists them: refused, and nothing starts.
        foreach ($t in @('codex', 'gemini')) {
            Write-Brief $fx 'W2' 'implementation' $t
            $r = Invoke-Spawn $fx @('-Worker', 'W2', '-Tool', $t)
            Check ($r.code -ne 0 -and (Test-Said $r.out 'workers are off') -and (Test-Said $r.out 'worker_tools')) "-Tool $t was not refused in words that name worker_tools: $(Get-Tail $r.out)"
        }
        Check (-not (Test-Path -LiteralPath (Join-Path $fx.workers 'W2.run.json'))) 'a refused worker wrote a run.json'
        Check (@(Get-Calls $fx 'start').Count -eq 1 -and @(Get-CodexCalls $fx '').Count -eq 0 -and @(Get-GeminiCalls $fx '').Count -eq 0) 'a refused worker started a program'
        $leak = Test-NoKeyText $fx $DummyKey
        Check (-not $leak) "the Anthropic key's text was written to: $leak"
    }

    Invoke-Scenario '24 workers in Codex and Gemini: commands, prompts on stdin and ids; OPENAI_API_KEY removed; the Gemini policy; exits 41 and 55; refusals' {
        $git = Get-Command git.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if (-not $git) { throw 'git.exe not found: a Codex worker needs a Git folder' }
        $fx = New-WorkerFixture 'wk2'
        $gitExit = 1
        $gitPreference = $ErrorActionPreference
        try {
            $ErrorActionPreference = 'Continue'
            $null = & $git.Path -C $fx.wt init -q 2>$null
            $gitExit = $LASTEXITCODE
            if ($gitExit -eq 0) {
                $null = & $git.Path -C $fx.wt config user.email 'ada@example.com' 2>$null
                $null = & $git.Path -C $fx.wt config user.name 'Ada' 2>$null
            }
        } finally { $ErrorActionPreference = $gitPreference }
        if ($gitExit -ne 0) { throw "git init failed in $($fx.wt)" }
        Set-WorkerSettings $fx @{ worker_tools = @('claude', 'codex', 'gemini'); codex_exe = $StubCodex; gemini_exe = $StubGemini }
        Write-Text (Join-Path $fx.mb 'bin\cost-limits.json') '{"worker_runs_per_day":{"codex":2,"gemini":0}}'
        Write-Text (Join-Path $fx.codex 'config.toml') "model = `"gpt-stub-default`"`r`n`r`n[profiles.other]`r`nmodel = `"not-this-one`"`r`n"
        $previousCodexHome = $env:CODEX_HOME
        $env:CODEX_HOME = $fx.codex   # where the launcher finds Codex's config.toml
        try {
            # Codex, the usual worker, launched as the coordinator does it. The thread id is saved while the run still goes.
            Write-Brief $fx 'W1' 'implementation' 'codex'
            Set-CodexStubMode $fx 'sleep:10'   # long enough for a slow runner to see the id while the run goes
            $r = Invoke-Spawn $fx @('-Worker', 'W1', '-Tool', 'codex')
            Check ($r.code -eq 0 -and (Test-Said $r.out 'Launched W1 \(implementation, Codex\)') -and (Test-Said $r.out "model gpt-stub-default \(Codex's default, from its config.toml\)")) "the Codex launch line does not say which model: $(Get-Tail $r.out)"
            $early = Wait-Until { $s = Get-RunJson $fx 'W1'; [bool]($s -and $s.session_id -and $s.state -eq 'running') } 30
            Check ($early -and (Get-RunningCodexStubs $fx) -eq 1) 'the Codex thread id was not saved in run.json while the run still went'
            $led = Join-Path $fx.workers 'runs.md'
            Check (Wait-Until { (Test-Path -LiteralPath $led) -and (Read-Shared $led) -match '\| W1 \|' } 60) 'the Codex worker run did not end with a line in runs.md'
            Set-CodexStubMode $fx 'ok'
            $w = @(Get-CodexWorkerCalls $fx)
            Check ($w.Count -eq 1) "expected 1 Codex worker run, got $($w.Count)"
            $s = Get-RunJson $fx 'W1'
            if ($w.Count -ge 1 -and $s) {
                $c = $w[0]
                $why = Compare-ArgList @($c.args) @('exec', '--json', '--skip-git-repo-check', '--sandbox', 'workspace-write',
                    '-c', 'sandbox_workspace_write.network_access=false', '--add-dir', $fx.workers, '-c', 'model_reasoning_effort=xhigh', '-')
                Check (-not $why) "the Codex command is not the one asked for: $why"
                Check ([string]$c.stdin -match [regex]::Escape((Join-Path $fx.workers 'W1-brief.md')) -and [string]$c.stdin -match 'W1-report\.md') 'the prompt on stdin does not name the brief and the report'
                Check ([string]$c.stdin -match 'Do not run git add or git commit') 'the Codex worker prompt does not say the launcher commits'
                Check (-not (@($c.args) -contains (Join-Path $fx.wt '.git'))) 'the Codex worker may write in Git''s own folder'
                Check ([bool]$c.key_absent) 'the Codex worker inherited OPENAI_API_KEY'
                Check ([string]$c.cwd -like '*\wk2\worktrees\*\repo') "the Codex worker ran in '$($c.cwd)', not in the worktree"
                Check ($s.tool -eq 'codex' -and $s.state -eq 'finished' -and $s.exit_code -eq 0 -and $s.session_id -eq $c.thread -and
                    $s.billing -eq 'chatgpt-sign-in' -and $s.model -eq 'gpt-stub-default') 'W1.run.json does not record the Codex run with its thread id'
                Check ($s.tokens -and $s.tokens.total -eq 1500 -and $s.tokens.cached -eq 800) 'W1.run.json does not hold the token counts'
            }
            Check ((Read-Shared (Join-Path $fx.workers 'W1.log')) -match 'changed no files, so there was nothing to commit') 'W1.log does not say there was nothing to commit'
            Check (@(Get-CodexCalls $fx 'login').Count -ge 1) 'the launcher did not check the Codex sign-in'
            Check ((Read-Shared (Join-Path $fx.workers 'W1.log')) -match "launcher: model gpt-stub-default \(Codex's default, from its config.toml\)") 'W1.log does not say which model Codex used'
            Check ((Read-Shared $led) -match '\| W1 \| implementation \| finished \| 0 \| .*\| codex \| 1500 \(in 1200, out 300, cached 800\) \|') 'runs.md has no Codex line with its tokens'
            # Signed in with an API key: refused before any turn. It runs before W2, while only W1 counts toward
            # the daily limit (2 here), so the sign-in check, not the limit, is what refuses it.
            Set-CodexStubMode $fx 'api-key'
            Write-Brief $fx 'W3' 'implementation' 'codex'
            $null = Invoke-Spawn $fx @('-Worker', 'W3', '-Tool', 'codex', '-Foreground')
            Set-CodexStubMode $fx 'ok'
            $s = Get-RunJson $fx 'W3'
            Check ($s -and $s.state -eq 'failed' -and $s.exit_code -eq -1 -and [string]$s.note -match 'not signed in with ChatGPT') 'a Codex worker signed in with an API key was not refused with a ChatGPT message'
            Check (@(Get-CodexWorkerCalls $fx).Count -eq 1) 'a Codex worker started although Codex is signed in with an API key'
            # A Codex reviewer works in the workers folder, with the model and effort it was given.
            Write-Brief $fx 'W2' 'review' 'codex'
            $null = Invoke-Spawn $fx @('-Worker', 'W2', '-Tool', 'codex', '-Type', 'review', '-Model', 'gpt-6.1-sol', '-Effort', 'high', '-Foreground')
            $w = @(Get-CodexWorkerCalls $fx)
            Check ($w.Count -eq 2) "expected 2 Codex worker runs, got $($w.Count)"
            if ($w.Count -ge 2) {
                $why = Compare-ArgList @($w[1].args) @('exec', '--json', '--skip-git-repo-check', '--sandbox', 'workspace-write',
                    '-c', 'sandbox_workspace_write.network_access=false', '-m', 'gpt-6.1-sol', '-c', 'model_reasoning_effort=high', '-')
                Check (-not $why) "the Codex reviewer's command is not the one asked for: $why"
                Check ([string]$w[1].cwd -like '*\workers') "the Codex reviewer ran in '$($w[1].cwd)', not in the workers folder"
                Check ([string]$w[1].stdin -match 'The only file you may write is your report') 'the reviewer prompt does not keep it to its report'
            }
            # A Claude model, or an effort Codex does not have: refused, nothing starts.
            Write-Brief $fx 'W4' 'implementation' 'codex'
            foreach ($bad in @(@('-Model', 'opus'), @('-Effort', 'max'))) {
                $r = Invoke-Spawn $fx (@('-Worker', 'W4', '-Tool', 'codex', '-Foreground') + $bad)
                Check ($r.code -ne 0 -and (Test-Said $r.out 'Refusing') -and (Test-Said $r.out 'Nothing was started')) "-Tool codex $($bad -join ' ') was not refused: $(Get-Tail $r.out)"
            }
            # The daily limit (2 here): W1 and W2 count; W3 started nothing, so it does not.
            $r = Invoke-Spawn $fx @('-Worker', 'W4', '-Tool', 'codex', '-Foreground')
            Check ($r.code -ne 0 -and (Test-Said $r.out 'today already had 2 Codex worker run') -and (Test-Said $r.out 'worker_runs_per_day')) "the daily Codex limit did not refuse the third run: $(Get-Tail $r.out)"
            Check (-not (Test-Path -LiteralPath (Join-Path $fx.workers 'W4.run.json')) -and @(Get-CodexWorkerCalls $fx).Count -eq 2) 'a refused Codex worker started or wrote a run.json'
            # A Codex worker that changes a file: the launcher commits it, outside the sandbox. One more run is allowed for it.
            Write-Text (Join-Path $fx.mb 'bin\cost-limits.json') '{"worker_runs_per_day":{"codex":3,"gemini":0}}'
            Write-Brief $fx 'W9' 'implementation' 'codex'
            Set-CodexStubMode $fx 'write'
            $null = Invoke-Spawn $fx @('-Worker', 'W9', '-Tool', 'codex', '-Foreground')
            Set-CodexStubMode $fx 'ok'
            $s9 = Get-RunJson $fx 'W9'
            $tip = ''
            $gitPreference = $ErrorActionPreference
            try {
                $ErrorActionPreference = 'Continue'
                $tip = ((& $git.Path -C $fx.wt log -1 --format=%H%n%s 2>$null) | Out-String).Trim()
            } finally { $ErrorActionPreference = $gitPreference }
            Check ($s9 -and $s9.state -eq 'finished' -and $s9.commit -and $tip.StartsWith([string]$s9.commit)) "the launcher did not commit the Codex worker's change (run.json commit '$($s9.commit)', head '$tip')"
            Check ($tip -match 'W9: changes from the Codex worker run') "the launcher's commit has the wrong message: $tip"
            Check ((Read-Shared (Join-Path $fx.workers 'W9.log')) -match "Committed the Codex worker's changes as") 'W9.log does not say the launcher committed the changes'

            # Gemini, the usual worker.
            Set-GeminiStubMode $fx 'ok'
            Write-Brief $fx 'W5' 'implementation' 'gemini'
            $null = Invoke-Spawn $fx @('-Worker', 'W5', '-Tool', 'gemini', '-Foreground')
            $g = @(Get-GeminiCalls $fx 'start')
            $s = Get-RunJson $fx 'W5'
            $pf = Join-Path $fx.workers 'W5.gemini-policy.toml'
            Check ($g.Count -eq 1) "expected 1 Gemini worker run, got $($g.Count)"
            if ($g.Count -ge 1 -and $s) {
                $c = $g[0]
                $why = Compare-ArgList @($c.args) @('--session-id', [string]$s.session_id, '-p', 'Do the work in the brief above.', '-o', 'stream-json',
                    '--approval-mode', 'auto_edit', '--skip-trust', '--admin-policy', $pf, '--include-directories', $fx.workers)
                Check (-not $why) "the Gemini command is not the one asked for: $why"
                Check ($c.session_id_flag -eq $s.session_id -and [string]$s.session_id -match '^[0-9a-f]{8}-[0-9a-f]{4}-') 'run.json does not hold the session id that Gemini got and reported'
                Check ([string]$c.stdin -match 'Read and follow exactly the brief' -and [string]$c.stdin -match 'BRIEF-MARKER-W5') 'the prompt on stdin does not hold the launcher''s words and the brief itself'
                Check ([string]$c.cwd -like '*\wk2\worktrees\*\repo') "the Gemini worker ran in '$($c.cwd)', not in the worktree"
                Check ([bool]$c.gemini_key_present) 'GEMINI_API_KEY did not pass through to Gemini'
                $p = [string]$c.policy
                Check ($p -match '(?m)^toolName = "\*"\r?\ndecision = "deny"\r?\npriority = 0\r?$') 'the policy has no deny-all rule at priority 0'
                Check ($p.Contains('commandPrefix = ["git status", "git diff", "git log", "git show", "git add", "git commit", "git rev-parse", "node"]')) 'the policy does not allow exactly the git and node prefixes'
                Check ($p.Contains('"git push"') -and $p.Contains('commandRegex = "node (?:-e|')) 'the policy does not deny git push and node -e'
                Check ($p.Contains('toolName = ["web_fetch", "google_web_search"]') -and $p -match '(?m)^mcpName = "\*"\r?\ndecision = "deny"') 'the policy does not deny the web and MCP tools'
                Check ([string]$c.defaults -eq '{"model":{"maxSessionTurns":30}}') "the defaults file holds '$($c.defaults)', want the turn limit 30"
                Check ($s.policy_sha256 -eq (Get-FileHash -LiteralPath $pf -Algorithm SHA256).Hash.ToLowerInvariant()) 'run.json does not hold the SHA-256 of the policy file'
                Check ($s.tool -eq 'gemini' -and $s.state -eq 'finished' -and $s.exit_code -eq 0 -and $s.model -eq 'gemini-stub' -and $s.tokens.total -eq 1500 -and $s.tokens.cached -eq 800) 'W5.run.json does not record the Gemini run with its tokens'
            }
            Check ((Read-Shared (Join-Path $fx.workers 'runs.md')) -match '\| W5 \| implementation \| finished \| 0 \| .*\| gemini \| 1500 \(in 1200, out 300, cached 800\) \|') 'runs.md has no Gemini line with its tokens'
            # A Gemini reviewer: approval mode default, writes only its report, no git add or commit.
            Write-Brief $fx 'W6' 'review' 'gemini'
            $null = Invoke-Spawn $fx @('-Worker', 'W6', '-Tool', 'gemini', '-Type', 'review', '-Foreground')
            $g = @(Get-GeminiCalls $fx 'start')
            Check ($g.Count -eq 2) "expected 2 Gemini worker runs, got $($g.Count)"
            if ($g.Count -ge 2) {
                $a = @($g[1].args)
                Check ($a -contains 'default' -and $a -notcontains 'auto_edit') 'a Gemini reviewer did not use --approval-mode default'
                $p = [string]$g[1].policy
                Check ($p -match 'argsPattern = .*W6-report' -and $p.Contains('commandPrefix = ["git status", "git diff", "git log", "git show", "git rev-parse", "node"]')) 'the reviewer policy does not keep writes to its report, and git to reading'
                Check ($p -notmatch 'toolName = \["write_file", "replace"\]\r?\ndecision = "allow"') 'the reviewer policy lets it edit any file'
            }
            # Exit codes, recorded truthfully in plain words.
            foreach ($x in @(@{ w = 'W7'; mode = 'exit:41'; code = 41; state = 'failed (not signed in)'; words = 'not signed in\. Gemini CLI needs a paid API key, Vertex AI or a work license' },
                    @{ w = 'W8'; mode = 'exit:55'; code = 55; state = 'failed (untrusted folder)'; words = 'does not trust the worktree folder' })) {
                Set-GeminiStubMode $fx $x.mode
                Write-Brief $fx $x.w 'implementation' 'gemini'
                $null = Invoke-Spawn $fx @('-Worker', $x.w, '-Tool', 'gemini', '-Foreground')
                $s = Get-RunJson $fx $x.w
                Check ($s -and $s.state -eq $x.state -and $s.exit_code -eq $x.code -and [string]$s.note -match $x.words) "$($x.w).run.json does not record exit $($x.code) truthfully"
                Check ((Read-Shared (Join-Path $fx.workers "$($x.w).log")) -match ('launcher: .*' + $x.words)) "$($x.w).log does not say in plain words what exit $($x.code) means"
            }
            # Gemini reports a session id of its own: run.json keeps that one, and the log says so.
            Set-GeminiStubMode $fx 'wrong-session'
            Write-Brief $fx 'W9' 'implementation' 'gemini'
            $null = Invoke-Spawn $fx @('-Worker', 'W9', '-Tool', 'gemini', '-Foreground')
            Set-GeminiStubMode $fx 'ok'
            $s = Get-RunJson $fx 'W9'
            Check ($s -and $s.session_id -eq '99999999-9999-4999-8999-999999999999' -and (Read-Shared (Join-Path $fx.workers 'W9.log')) -match 'run.json keeps the one Gemini CLI reported') 'a session id that Gemini reported was not kept, with a note'
            # Refused before anything starts: a .gemini\settings.json in the worktree, and Gemini system policies.
            $before = @(Get-GeminiCalls $fx 'start').Count
            Write-Brief $fx 'W10' 'implementation' 'gemini'
            Write-Text (Join-Path $fx.wt '.gemini\settings.json') '{}'
            $r = Invoke-Spawn $fx @('-Worker', 'W10', '-Tool', 'gemini', '-Foreground')
            Remove-Item -LiteralPath (Join-Path $fx.wt '.gemini') -Recurse -Force
            Check ($r.code -ne 0 -and (Test-Said $r.out '\.gemini\\settings\.json') -and (Test-Said $r.out 'Nothing was started')) "a .gemini\settings.json in the worktree was not refused: $(Get-Tail $r.out)"
            $sysDir = Join-Path $fx.dir 'gemini-system-policies'
            Write-Text (Join-Path $sysDir 'org.toml') "# a policy of this computer's administrator`n"
            $env:RELAY_TEST_GEMINI_POLICY_DIR = $sysDir   # test only: read like C:\ProgramData\gemini-cli\policies
            try { $r = Invoke-Spawn $fx @('-Worker', 'W10', '-Tool', 'gemini', '-Foreground') } finally { Remove-Item Env:RELAY_TEST_GEMINI_POLICY_DIR -ErrorAction SilentlyContinue }
            Check ($r.code -ne 0 -and (Test-Said $r.out 'holds Gemini admin policies') -and (Test-Said $r.out 'Nothing was started')) "Gemini system policies did not stop the start: $(Get-Tail $r.out)"
            Check (-not (Test-Path -LiteralPath (Join-Path $fx.workers 'W10.run.json'))) 'a refused Gemini worker wrote a run.json'
            # A policy file that changed after its hash was saved: refused right before the start.
            $env:RELAY_TEST_CHANGE_POLICY = '1'   # test only
            try { $null = Invoke-Spawn $fx @('-Worker', 'W10', '-Tool', 'gemini', '-Foreground') } finally { Remove-Item Env:RELAY_TEST_CHANGE_POLICY -ErrorAction SilentlyContinue }
            $s = Get-RunJson $fx 'W10'
            Check ($s -and $s.state -eq 'failed' -and $s.exit_code -eq -1 -and [string]$s.note -match 'policy file changed') 'a changed policy file did not stop the start'
            Check (@(Get-GeminiCalls $fx 'start').Count -eq $before) 'a refused Gemini worker started Gemini'
        } finally {
            if ($null -ne $previousCodexHome) { $env:CODEX_HOME = $previousCodexHome } else { Remove-Item Env:CODEX_HOME -ErrorAction SilentlyContinue }
        }
        foreach ($k in @($DummyGeminiKey, $DummyOpenAiKey)) {
            $leak = Test-NoKeyText $fx $k
            Check (-not $leak) "a dummy key's text was written to: $leak"
        }
    }

    Invoke-Scenario '25 workers in Antigravity CLI: off until worker_tools lists it; the command, the stdin line and the id; the warning; commits with no Git hooks, and none after a changed .git; exits, ERROR results and sign-in; refusals; the sandbox' {
        $git = Get-Command git.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if (-not $git) { throw 'git.exe not found: an Antigravity worker needs a Git worktree' }
        $fx = New-WorkerFixture 'wk3'
        # A Git worktree, made the way the coordinator makes them (git worktree add), from a repository beside it.
        $fx.repo = Join-Path $fx.dir 'repo-main'
        $gitExit = 1
        $gitPreference = $ErrorActionPreference
        try {
            $ErrorActionPreference = 'Continue'
            Remove-Item -LiteralPath $fx.wt -Recurse -Force   # git worktree add makes it again
            $null = & $git.Path init -q $fx.repo 2>$null
            $gitExit = $LASTEXITCODE
            if ($gitExit -eq 0) {
                $null = & $git.Path -C $fx.repo config user.email 'ada@example.com' 2>$null
                $null = & $git.Path -C $fx.repo config user.name 'Ada' 2>$null
                $null = & $git.Path -C $fx.repo commit -q --allow-empty -m 'start' 2>$null
                $gitExit = $LASTEXITCODE
            }
            if ($gitExit -eq 0) {
                $null = & $git.Path -C $fx.repo worktree add -q -b "claude/$($fx.task)" $fx.wt 2>$null
                $gitExit = $LASTEXITCODE
            }
        } finally { $ErrorActionPreference = $gitPreference }
        if ($gitExit -ne 0 -or -not (Test-Path -LiteralPath (Join-Path $fx.wt '.git') -PathType Leaf)) { throw "git worktree add failed for $($fx.wt)" }
        # The test's own git calls: HEAD and the changed files, for the checks that a run committed nothing.
        $gitNow = {
            $p = $ErrorActionPreference
            try {
                $ErrorActionPreference = 'Continue'
                $h = ((& $git.Path -C $fx.wt rev-parse HEAD 2>$null) | Out-String).Trim()
                $st = ((& $git.Path -C $fx.wt status --porcelain 2>$null) | Out-String)
            } finally { $ErrorActionPreference = $p }
            return @{ head = $h; status = $st }
        }
        $warning = "Google's consumer terms may not allow running Antigravity CLI from other programs. Your Google account could be suspended or closed. Turn it off by taking antigravity out of worker_tools."
        $led = Join-Path $fx.workers 'runs.md'

        # Off by default: with no worker_tools at all, only Claude Code workers may start.
        Set-WorkerSettings $fx @{ antigravity_exe = $StubAgy }
        Write-Brief $fx 'W1' 'implementation' 'antigravity'
        $r = Invoke-Spawn $fx @('-Worker', 'W1', '-Tool', 'antigravity')
        Check ($r.code -ne 0 -and (Test-Said $r.out 'Antigravity workers are off') -and (Test-Said $r.out 'now: claude\)')) "-Tool antigravity was not refused with no worker_tools setting: $(Get-Tail $r.out)"
        Check (-not (Test-Path -LiteralPath (Join-Path $fx.workers 'W1.run.json')) -and @(Get-AgyCalls $fx '').Count -eq 0) 'an Antigravity worker started with no worker_tools setting'

        # Off until worker_tools lists it: refused in words that name worker_tools and the risk, and nothing starts.
        Set-WorkerSettings $fx @{ worker_tools = @('claude', 'codex', 'gemini'); antigravity_exe = $StubAgy }
        Write-Brief $fx 'W1' 'implementation' 'antigravity'
        $r = Invoke-Spawn $fx @('-Worker', 'W1', '-Tool', 'antigravity')
        Check ($r.code -ne 0 -and (Test-Said $r.out 'Antigravity workers are off') -and (Test-Said $r.out 'worker_tools') -and
            (Test-Said $r.out 'Your Google account could be suspended or closed')) "-Tool antigravity was not refused in words that name worker_tools and the risk: $(Get-Tail $r.out)"
        Check (-not (Test-Path -LiteralPath (Join-Path $fx.workers 'W1.run.json')) -and @(Get-AgyCalls $fx '').Count -eq 0) 'a refused Antigravity worker started a program or wrote a run.json'

        # Turned on, with no daily limit (0) until the limit is checked at the end.
        Set-WorkerSettings $fx @{ worker_tools = @('claude', 'antigravity'); antigravity_exe = $StubAgy }
        Write-Text (Join-Path $fx.mb 'bin\cost-limits.json') '{"worker_runs_per_day":{"antigravity":0}}'

        # The usual worker, launched as the coordinator does it. The conversation id is saved while the run still goes.
        Set-AgyStubMode $fx 'sleep:10'
        $r = Invoke-Spawn $fx @('-Worker', 'W1', '-Tool', 'antigravity')
        Check ($r.code -eq 0 -and (Test-Said $r.out 'Launched W1 \(implementation, Antigravity\)') -and (Test-SaidText $r.out "Antigravity CLI's default model") -and
            (Test-SaidText $r.out 'effort high (Antigravity CLI has low, medium and high, so xhigh runs as high)') -and (Test-SaidText $r.out "Warning: $warning")) "the Antigravity launch line does not give the model, the effort and the warning: $(Get-Tail $r.out)"
        $early = Wait-Until { $s = Get-RunJson $fx 'W1'; [bool]($s -and $s.session_id -and $s.state -eq 'running') } 30
        Check ($early -and (Get-RunningAgyStubs $fx) -eq 1) 'the Antigravity conversation id was not saved in run.json while the run still went'
        Check (Wait-Until { (Test-Path -LiteralPath $led) -and (Read-Shared $led) -match '\| W1 \|' } 60) 'the Antigravity worker run did not end with a line in runs.md'
        Set-AgyStubMode $fx 'ok'
        $a = @(Get-AgyCalls $fx 'start')
        $s = Get-RunJson $fx 'W1'
        Check ($a.Count -eq 1) "expected 1 Antigravity worker run, got $($a.Count)"
        if ($a.Count -ge 1 -and $s) {
            $c = $a[0]
            $why = Compare-ArgList @($c.args) @('--input-format', 'stream-json', '--output-format', 'stream-json', '--mode', 'accept-edits', '--add-dir', $fx.workers, '--effort', 'high')
            Check (-not $why) "the Antigravity command is not the one asked for: $why"
            Check (([string]$c.stdin).StartsWith('{"event":"user","message":{"content":"') -and $c.stdin_lines -eq 1 -and $c.stdin_event -eq 'user') 'stdin is not one stream-json user line'
            $prompt = [string]$c.stdin_content
            Check ($prompt.Contains((Join-Path $fx.workers 'W1-brief.md')) -and $prompt.Contains((Join-Path $fx.workers 'W1-report.md'))) 'the prompt on stdin does not name the brief and the report'
            Check ($prompt.Contains('Do not run git add or git commit: when you finish, the launcher commits your changes')) 'the Antigravity worker prompt does not say the launcher commits'
            Check ([string]$c.cwd -like '*\wk3\worktrees\*\repo') "the Antigravity worker ran in '$($c.cwd)', not in the worktree"
            Check ([bool]$c.gemini_key_present) 'GEMINI_API_KEY did not pass through to Antigravity CLI'
            Check ($s.tool -eq 'antigravity' -and $s.state -eq 'finished' -and $s.exit_code -eq 0 -and $s.session_id -eq $c.conversation_id -and $s.billing -eq 'antigravity-own-login' -and
                $s.model -eq 'antigravity default' -and $s.effort -eq 'high' -and -not $s.commit) 'W1.run.json does not record the Antigravity run with its conversation id, and no commit'
            Check ($s.tokens -and $s.tokens.input -eq 10418 -and $s.tokens.output -eq 589 -and $s.tokens.cached -eq 8113 -and $s.tokens.total -eq 11007) 'W1.run.json does not hold the token counts'
        }
        $log = Read-Shared (Join-Path $fx.workers 'W1.log')
        Check ($log.Contains("launcher: $warning")) 'W1.log does not hold the warning about Google''s consumer terms'
        Check ($log.Contains('The Antigravity worker changed no files, so there was nothing to commit.')) 'W1.log does not say there was nothing to commit'
        Check ((Read-Shared $led) -match '\| W1 \| implementation \| finished \| 0 \| .*\| antigravity \| 11007 \(in 10418, out 589, cached 8113\) \|') 'runs.md has no Antigravity line with its tokens'

        # A worker that changes a file: the launcher commits it, outside Antigravity CLI, and runs no Git hooks. The
        # repository names a hooks folder inside the worktree, as some projects do, so a worker could write hooks
        # there. --no-verify skips only some of them (pre-commit), so the test also uses two it does not skip:
        # post-commit, and post-index-change, which runs whenever git writes its list of files (git add, git status).
        # Each hook leaves a mark beside the worktree, outside it, so the marks never show in git status. A plain git
        # add and commit run all three; the launcher's git commands must run none.
        $hooks = @('pre-commit', 'post-commit', 'post-index-change')
        $marks = @($hooks | ForEach-Object { Join-Path (Split-Path -Parent $fx.wt) "hook-$_.txt" })
        foreach ($h in $hooks) { Write-Text (Join-Path $fx.wt ".hooks\$h") "#!/bin/sh`necho ran > ../hook-$h.txt`n" }
        Write-Text (Join-Path $fx.wt 'probe.txt') 'probe'
        $hookPreference = $ErrorActionPreference
        try {
            $ErrorActionPreference = 'Continue'
            $null = & $git.Path -C $fx.repo config core.hooksPath (Join-Path $fx.wt '.hooks') 2>$null
            $null = & $git.Path -C $fx.wt add probe.txt 2>$null
            $null = & $git.Path -C $fx.wt commit -q -m 'probe' 2>$null
        } finally { $ErrorActionPreference = $hookPreference }
        $missing = @($marks | Where-Object { -not (Test-Path -LiteralPath $_) })
        Check ($missing.Count -eq 0) "a test hook did not run on a plain git add and commit ($($missing -join ', ')), so the hook check below proves nothing"
        foreach ($m in $marks) { Remove-Item -LiteralPath $m -Force -ErrorAction SilentlyContinue }
        Write-Brief $fx 'W2' 'implementation' 'antigravity'
        Set-AgyStubMode $fx 'write'
        $null = Invoke-Spawn $fx @('-Worker', 'W2', '-Tool', 'antigravity', '-Foreground')
        Set-AgyStubMode $fx 'ok'
        $s2 = Get-RunJson $fx 'W2'
        $tip = ''
        $gitPreference = $ErrorActionPreference
        try {
            $ErrorActionPreference = 'Continue'
            $tip = ((& $git.Path -C $fx.wt log -1 --format=%H%n%s 2>$null) | Out-String).Trim()
        } finally { $ErrorActionPreference = $gitPreference }
        Check ($s2 -and $s2.state -eq 'finished' -and $s2.commit -and $tip.StartsWith([string]$s2.commit)) "the launcher did not commit the Antigravity worker's change (run.json commit '$($s2.commit)', head '$tip')"
        Check ($tip -match 'W2: changes from the Antigravity worker run') "the launcher's commit has the wrong message: $tip"
        Check ((Read-Shared (Join-Path $fx.workers 'W2.log')) -match "Committed the Antigravity worker's changes as") 'W2.log does not say the launcher committed the changes'
        $ran = @($marks | Where-Object { Test-Path -LiteralPath $_ })
        Check ($ran.Count -eq 0) "the launcher's git commands ran Git hooks that a worker could have written: $($ran -join ', ')"
        # The test's own git calls below must not run those hooks either.
        $hookPreference = $ErrorActionPreference
        try {
            $ErrorActionPreference = 'Continue'
            $null = & $git.Path -C $fx.repo config --unset core.hooksPath 2>$null
        } finally { $ErrorActionPreference = $hookPreference }

        # A worker that changes the worktree's .git file (it tells Git where Git's own folder is): the launcher runs no
        # git command there and commits nothing.
        $gitFile = Join-Path $fx.wt '.git'
        $gitText = Read-Shared $gitFile
        $g0 = & $gitNow
        Write-Brief $fx 'W9' 'implementation' 'antigravity'
        Set-AgyStubMode $fx 'gitlink'
        $null = Invoke-Spawn $fx @('-Worker', 'W9', '-Tool', 'antigravity', '-Foreground')
        Set-AgyStubMode $fx 'ok'
        $changed = Read-Shared $gitFile
        # Put it back for the runs below. Git for Windows marks .git hidden, and .NET cannot overwrite a hidden file.
        [IO.File]::SetAttributes($gitFile, [IO.FileAttributes]::Normal)
        [IO.File]::WriteAllText($gitFile, $gitText, $Utf8)
        $s9 = Get-RunJson $fx 'W9'
        $g9 = & $gitNow
        Check ($changed -ne $gitText) "the stub did not change the worktree's .git file, so this check proves nothing"
        Check ($s9 -and $s9.state -eq 'finished' -and -not $s9.commit -and $g9.head -eq $g0.head) "the launcher committed after the worker changed the worktree's .git (run.json commit '$($s9.commit)')"
        Check ((Read-Shared (Join-Path $fx.workers 'W9.log')) -match "changed the worktree's \.git during its run, so the launcher ran no git command there") 'W9.log does not say why nothing was committed'
        Check ($g9.status -match 'agy-stub-gitlink\.txt') "the W9 worker's change is not left uncommitted in the worktree"

        # A reviewer works in the workers folder. -Model and -Effort low are passed on, and antigravity_sandbox adds --sandbox.
        Set-WorkerSettings $fx @{ worker_tools = @('claude', 'antigravity'); antigravity_exe = $StubAgy; antigravity_sandbox = $true }
        Write-Brief $fx 'W3' 'review' 'antigravity'
        $null = Invoke-Spawn $fx @('-Worker', 'W3', '-Tool', 'antigravity', '-Type', 'review', '-Model', 'gemini-stub-flash', '-Effort', 'low', '-Foreground')
        Set-WorkerSettings $fx @{ worker_tools = @('claude', 'antigravity'); antigravity_exe = $StubAgy }
        $a = @(Get-AgyCalls $fx 'start')
        Check ($a.Count -eq 4) "expected 4 Antigravity worker runs, got $($a.Count)"
        if ($a.Count -ge 4) {
            $why = Compare-ArgList @($a[3].args) @('--input-format', 'stream-json', '--output-format', 'stream-json', '--mode', 'accept-edits',
                '--model', 'gemini-stub-flash', '--effort', 'low', '--sandbox')
            Check (-not $why) "the Antigravity reviewer's command is not the one asked for: $why"
            Check ([string]$a[3].cwd -like '*\workers') "the Antigravity reviewer ran in '$($a[3].cwd)', not in the workers folder"
            Check ([string]$a[3].stdin_content -match 'The only file you may write is your report') 'the reviewer prompt does not keep it to its report'
        }
        $s3 = Get-RunJson $fx 'W3'
        $g3 = & $gitNow
        Check ($s3 -and $s3.state -eq 'finished' -and $s3.model -eq 'gemini-stub-flash' -and $s3.effort -eq 'low' -and -not $s3.commit -and
            $g3.head -eq $g0.head -and $g3.status -match 'agy-stub-gitlink\.txt') 'W3.run.json does not record the reviewer run with its model and effort, or the reviewer run committed'
        Check ((Read-Shared (Join-Path $fx.workers 'W3.log')) -match 'antigravity_sandbox is on') 'W3.log does not say that the sandbox is on'

        # Exits, ERROR results and the sign-in, recorded truthfully in plain words. Nothing is committed for them: the
        # change W9 left in the worktree stays uncommitted, and HEAD stays where it was.
        foreach ($x in @(@{ w = 'W4'; mode = 'exit:1'; code = 1; state = 'failed (bad input)'; words = "said the relay's input was wrong \(exit 1\)\. It said: invalid model selection" },
                @{ w = 'W5'; mode = 'exit:3'; code = 3; state = 'failed (service error)'; words = "The model or Antigravity's service failed \(exit 3\): The model is overloaded" },
                @{ w = 'W6'; mode = 'result-error'; code = 0; state = 'failed'; words = 'did not finish the work: it ended with status ERROR\. It said: simulated model error' },
                @{ w = 'W7'; mode = 'auth'; code = 1; state = 'failed (not signed in)'; words = 'is not signed in \(it said: authentication required\)\. Run agy once in a window and sign in' },
                @{ w = 'W10'; mode = 'not-eligible'; code = 1; state = 'failed'; words = 'stopped with an error \(exit 1\)\. It said: Eligibility check failed: Your current account is not eligible for Antigravity' })) {
            Set-AgyStubMode $fx $x.mode
            Write-Brief $fx $x.w 'implementation' 'antigravity'
            $null = Invoke-Spawn $fx @('-Worker', $x.w, '-Tool', 'antigravity', '-Foreground')
            $s = Get-RunJson $fx $x.w
            $gx = & $gitNow
            Check ($s -and $s.state -eq $x.state -and $s.exit_code -eq $x.code -and [string]$s.note -match $x.words -and -not $s.commit) "$($x.w).run.json does not record $($x.mode) truthfully (state '$($s.state)', exit '$($s.exit_code)', note '$($s.note)')"
            Check ($gx.head -eq $g0.head -and $gx.status -match 'agy-stub-gitlink\.txt') "the launcher committed after the failed $($x.mode) run"
            $wlog = Read-Shared (Join-Path $fx.workers "$($x.w).log")
            Check ($wlog -match ('launcher: .*' + $x.words) -and $wlog.Contains("launcher: $warning") -and -not $wlog.Contains('Committed the')) "$($x.w).log does not say in plain words what happened, has no warning, or says it committed"
        }
        Set-AgyStubMode $fx 'ok'
        Remove-Item -LiteralPath (Join-Path $fx.wt 'agy-stub-gitlink.txt') -Force -ErrorAction SilentlyContinue

        # Refused before anything starts: hooks in the worktree, a Claude model and max effort.
        $before = @(Get-AgyCalls $fx 'start').Count
        Write-Brief $fx 'W8' 'implementation' 'antigravity'
        Write-Text (Join-Path $fx.wt '.agents\hooks.json') '{}'
        $r = Invoke-Spawn $fx @('-Worker', 'W8', '-Tool', 'antigravity', '-Foreground')
        Remove-Item -LiteralPath (Join-Path $fx.wt '.agents') -Recurse -Force
        Check ($r.code -ne 0 -and (Test-Said $r.out '\.agents\\hooks\.json is there') -and (Test-Said $r.out 'Nothing was started')) "an .agents\hooks.json in the worktree was not refused: $(Get-Tail $r.out)"
        # The other names and places that Antigravity CLI reads: files and folders, in the workers folder too, and a
        # .gemini\config.json, which can send it to more of them.
        foreach ($bad in @(@{ path = (Join-Path $fx.workers '.agents\hooks.json'); file = $true }, @{ path = (Join-Path $fx.wt '.agent\mcp_config.json'); file = $true },
                @{ path = (Join-Path $fx.wt '_agents\plugins.json'); file = $true }, @{ path = (Join-Path $fx.wt '_agent\plugins'); file = $false },
                @{ path = (Join-Path $fx.wt '.agents\agents'); file = $false }, @{ path = (Join-Path $fx.wt '.gemini\config.json'); file = $true })) {
            if ($bad.file) { Write-Text $bad.path '{}' } else { New-Item -ItemType Directory -Path $bad.path -Force | Out-Null }
            $r = Invoke-Spawn $fx @('-Worker', 'W8', '-Tool', 'antigravity', '-Foreground')
            Remove-Item -LiteralPath (Split-Path -Parent $bad.path) -Recurse -Force
            $name = [regex]::Escape((Split-Path -Leaf (Split-Path -Parent $bad.path)) + '\' + (Split-Path -Leaf $bad.path))
            Check ($r.code -ne 0 -and (Test-Said $r.out "$name is there") -and (Test-Said $r.out 'Nothing was started')) "$($bad.path) was not refused: $(Get-Tail $r.out)"
        }
        # A worker in a folder below the worktree's top: Antigravity CLI reads the .agents folder at the top too.
        $sub = Join-Path $fx.wt 'sub'
        New-Item -ItemType Directory -Path $sub -Force | Out-Null
        $brief8 = Join-Path $fx.workers 'W8-brief.md'
        Write-Text $brief8 ((Read-Shared $brief8).Replace("** $($fx.wt)`r`n", "** $sub`r`n"))
        Write-Text (Join-Path $fx.wt '.agents\hooks.json') '{}'
        $r = Invoke-Spawn $fx @('-Worker', 'W8', '-Tool', 'antigravity', '-Foreground')
        Remove-Item -LiteralPath (Join-Path $fx.wt '.agents') -Recurse -Force
        Remove-Item -LiteralPath $sub -Recurse -Force
        Check ($r.code -ne 0 -and (Test-Said $r.out '\.agents\\hooks\.json is there') -and (Test-Said $r.out 'Nothing was started')) "an .agents\hooks.json at the worktree's top was not refused for a worker in a folder below it: $(Get-Tail $r.out)"
        # A plain copy of a repository (git init), not a Git worktree: Git's own folder would be inside, where the worker
        # could change it, so an implementation worker is refused there.
        $plain = Join-Path $fx.wtroot 'plain\repo'
        New-Item -ItemType Directory -Path $plain -Force | Out-Null
        $plainPreference = $ErrorActionPreference
        try {
            $ErrorActionPreference = 'Continue'
            $null = & $git.Path -C $plain init -q 2>$null
        } finally { $ErrorActionPreference = $plainPreference }
        Write-Brief $fx 'W8' 'implementation' 'antigravity'
        Write-Text $brief8 ((Read-Shared $brief8).Replace("** $($fx.wt)`r`n", "** $plain`r`n"))
        $r = Invoke-Spawn $fx @('-Worker', 'W8', '-Tool', 'antigravity', '-Foreground')
        Check ($r.code -ne 0 -and (Test-Said $r.out 'is not in a Git worktree') -and (Test-Said $r.out 'Nothing was started')) "an implementation worker in a plain git init folder was not refused: $(Get-Tail $r.out)"
        Write-Brief $fx 'W8' 'implementation' 'antigravity'
        foreach ($bad in @(@('-Model', 'opus'), @('-Effort', 'max'))) {
            $r = Invoke-Spawn $fx (@('-Worker', 'W8', '-Tool', 'antigravity', '-Foreground') + $bad)
            Check ($r.code -ne 0 -and (Test-Said $r.out 'Refusing') -and (Test-Said $r.out 'Nothing was started')) "-Tool antigravity $($bad -join ' ') was not refused: $(Get-Tail $r.out)"
        }
        # The daily limit: 4 unless set. Today had 9 runs (W1 to W7, W9 and W10); the refusals above started nothing.
        Write-Text (Join-Path $fx.mb 'bin\cost-limits.json') '{"worker_runs_per_day":{"codex":12}}'
        $r = Invoke-Spawn $fx @('-Worker', 'W8', '-Tool', 'antigravity', '-Foreground')
        Check ($r.code -ne 0 -and (Test-Said $r.out 'today already had 9 Antigravity worker run') -and (Test-Said $r.out 'the limit is 4 a day') -and
            (Test-Said $r.out 'worker_runs_per_day')) "the daily Antigravity limit did not refuse the tenth run: $(Get-Tail $r.out)"
        Check (-not (Test-Path -LiteralPath (Join-Path $fx.workers 'W8.run.json')) -and @(Get-AgyCalls $fx 'start').Count -eq $before) 'a refused Antigravity worker started or wrote a run.json'
        foreach ($k in @($DummyGeminiKey, $DummyOpenAiKey)) {
            $leak = Test-NoKeyText $fx $k
            Check (-not $leak) "a dummy key's text was written to: $leak"
        }
    }
} catch {
    $script:Fail++
    Write-Host ('FAIL harness: ' + $_.Exception.Message)
} finally {
    if ($null -ne $PreviousOpenAiKey) { $env:OPENAI_API_KEY = $PreviousOpenAiKey } else { Remove-Item Env:OPENAI_API_KEY -ErrorAction SilentlyContinue }
    if ($null -ne $PreviousGeminiKey) { $env:GEMINI_API_KEY = $PreviousGeminiKey } else { Remove-Item Env:GEMINI_API_KEY -ErrorAction SilentlyContinue }
    if ($null -ne $PreviousGeminiHome) { $env:GEMINI_CLI_HOME = $PreviousGeminiHome } else { Remove-Item Env:GEMINI_CLI_HOME -ErrorAction SilentlyContinue }
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
