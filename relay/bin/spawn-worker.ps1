<#
.SYNOPSIS
  Claude coordinator tooling: launch one worker session in Claude Code (the default), Codex or Gemini CLI.

.DESCRIPTION
  - Claude (-Tool claude, the default): runs `claude -p` with the saved claude.ai subscription login, never --bare or
    an injected API key. Funding overrides are removed only in the runner process and restored after the child exits.
    No API fallback.
  - Codex (-Tool codex) and Gemini (-Tool gemini) stay off until worker_tools in bin\relay-settings.json lists them.
    Codex: `codex exec` in a new thread, signed in with ChatGPT (codex login status). OPENAI_API_KEY and the other
    OpenAI overrides are removed for the child, so it never bills an API account. Gemini: `gemini -p` with the owner's
    own Gemini login (GEMINI_API_KEY passes through untouched; Gemini is paid per use), a per-run admin policy
    (--admin-policy, checked by SHA-256 right before the start) and a turn limit (GEMINI_CLI_SYSTEM_DEFAULTS_PATH).
  - Programs: claude_exe, codex_exe and gemini_exe in bin\relay-settings.json (full paths; a .js path runs through
    node, which the test uses). Without them: %APPDATA%\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe, and
    codex or gemini from PATH.
  - Daily limits for Codex and Gemini: worker_runs_per_day in bin\cost-limits.json (12 and 4 unless set; 0 means no
    limit), counted from today's rows in tasks\*\workers\runs.md and the runs that are running now.
  - The worker's working directory is read from its brief (line "- **Worktree ...:** <path>"). It must be inside the
    worktrees folder from bin\relay-settings.json: worktrees_dir, or <projects_dir>\_worktrees\claude. A Codex
    reviewer works in the task's workers folder instead, so it can write only there; it can still read the worktree.
  - Default: detaches; a hidden runner writes, in tasks\<TASK>\workers\:
      <W>.log       Claude: its JSON result. Codex and Gemini: their JSON events, then the launcher's notes.
      <W>.run.json  state / pid / exit code / cost / tool / session_id / tokens
      runs.md       one ledger line per run
  - Each run is a saved session with its own id (session_id in <W>.run.json): a new Claude Code session, a new Codex
    thread (its id from the thread.started event, saved as soon as Codex reports it) or a new Gemini session (its id from
    the init event). Pleni can show it, and once a Claude run has ended, the owner can open it with
    claude --resume <session_id> in the worktree.
  - Test only. bin\bridge-relay-check.ps1 sets these; each one can only make the launcher refuse:
      RELAY_TEST_GEMINI_POLICY_DIR  one more folder for the Gemini system policy check, read like
                                    C:\ProgramData\gemini-cli\policies (which is always read too)
      RELAY_TEST_CHANGE_POLICY      1: change the Gemini policy file after its hash was saved
  Windows PowerShell 5.1 compatible. ASCII only.

.EXAMPLE
  .\spawn-worker.ps1 -TaskId T-20260101-01-example-task -Worker W1
  .\spawn-worker.ps1 -TaskId T-20260101-01-example-task -Worker W2 -Type review -MaxBudgetUsd 1
  .\spawn-worker.ps1 -TaskId T-20260101-01-example-task -Worker W3 -Tool codex -Model gpt-6.1-sol -Effort high
  .\spawn-worker.ps1 -TaskId T-20260101-01-example-task -Worker W4 -Tool gemini -Type review
  .\spawn-worker.ps1 -TaskId T-20260101-01-example-task -Status
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidatePattern('^T-\d{8}-\d{2}-[a-z0-9-]+$')][string]$TaskId,
    [ValidatePattern('^W\d+$')][string]$Worker,
    [ValidateSet('implementation', 'review')][string]$Type = 'implementation',
    # The AI tool that runs the worker. Codex and Gemini stay off until worker_tools in bin\relay-settings.json lists them.
    [ValidateSet('claude', 'codex', 'gemini')][string]$Tool = 'claude',
    [ValidateRange(0.05, 25)][double]$MaxBudgetUsd = 3,
    # Default Opus 5.5 with 1M context. Workers run with --setting-sources '', so without this
    # the CLI falls back to its own default model (Sonnet). Override per run with -Model.
    # For Codex and Gemini, this default means the tool's own default model.
    [string]$Model = 'claude-opus-5-5[1m]',
    [ValidateSet('low', 'medium', 'high', 'xhigh', 'max')][string]$Effort = 'xhigh',
    [switch]$Status,
    [switch]$Foreground
)

$ErrorActionPreference = 'Stop'
$Inv       = [Globalization.CultureInfo]::InvariantCulture
$Utf8      = New-Object System.Text.UTF8Encoding($false)
$Bridge    = Split-Path -Parent $PSScriptRoot
$TaskDir   = Join-Path $Bridge "tasks\$TaskId"
$WorkerDir = Join-Path $TaskDir 'workers'
$Tool      = $Tool.ToLowerInvariant()
$ToolName  = @{ claude = 'Claude'; codex = 'Codex'; gemini = 'Gemini' }[$Tool]
$ClaudeDefaultModel = 'claude-opus-5-5[1m]'
# Gemini CLI's own fixed folder for admin policies on Windows. While it holds a .toml file, Gemini CLI ignores
# --admin-policy, and with it the relay's policy for the worker.
$GeminiSystemPolicies = 'C:\ProgramData\gemini-cli\policies'
$Notes = New-Object System.Collections.Generic.List[string]   # Codex and Gemini: the launcher's notes for <W>.log

function Write-RunState([string]$Path, [hashtable]$State) {
    ($State | ConvertTo-Json -Depth 4) | Set-Content -LiteralPath $Path -Encoding UTF8
}

function Add-Note([string]$Text) { $Notes.Add($Text) }

function ConvertTo-ArgToken([string]$A) {
    # One argument for a Windows command line, quoted the way programs read it back.
    if ($A -eq '') { return '""' }
    if ($A -notmatch '[\s"]') { return $A }
    $q = $A -replace '(\\*)"', '$1$1\"'
    $q = $q -replace '(\\+)$', '$1$1'
    return '"' + $q + '"'
}

function Get-Launch([string]$Path) {
    # How to start a program: a .js file runs through node (the relay's test uses one).
    if ($Path -match '\.js$') {
        $node = (Get-Command node.exe -CommandType Application | Select-Object -First 1).Path
        return @{ file = $node; prefix = @($Path) }
    }
    return @{ file = $Path; prefix = @() }
}

function Read-SharedText([string]$Path, [int]$MaxBytes) {
    # Reads a file that another program may still be writing. $MaxBytes above 0 reads only the start of it.
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return '' }
    $fs = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
    try {
        $n = [int64]$fs.Length
        if ($MaxBytes -gt 0 -and $n -gt $MaxBytes) { $n = $MaxBytes }
        $buf = New-Object byte[] ([int]$n)
        $read = 0
        while ($read -lt $n) {
            $k = $fs.Read($buf, $read, [int]$n - $read)
            if ($k -le 0) { break }
            $read += $k
        }
        return $Utf8.GetString($buf, 0, $read)
    } finally { $fs.Dispose() }
}

function Format-Tokens($T) {
    if (-not $T) { return '' }
    return ('{0} (in {1}, out {2}, cached {3})' -f $T.total, $T.input, $T.output, $T.cached)
}

function Get-ClaudeTokens($R) {
    # Claude Code's JSON result: modelUsage (each model) when it has it, else usage.
    $in = [int64]0; $out = [int64]0; $cached = [int64]0; $known = $false
    if ($R.modelUsage) {
        foreach ($p in $R.modelUsage.PSObject.Properties) {
            $u = $p.Value
            $in += [int64]$u.inputTokens + [int64]$u.cacheReadInputTokens + [int64]$u.cacheCreationInputTokens
            $out += [int64]$u.outputTokens
            $cached += [int64]$u.cacheReadInputTokens
            $known = $true
        }
    } elseif ($R.usage) {
        $u = $R.usage
        $in = [int64]$u.input_tokens + [int64]$u.cache_read_input_tokens + [int64]$u.cache_creation_input_tokens
        $out = [int64]$u.output_tokens
        $cached = [int64]$u.cache_read_input_tokens
        $known = $true
    }
    if (-not $known) { return $null }
    return [ordered]@{ input = $in; output = $out; cached = $cached; total = $in + $out }
}

function Read-ToolEvents([string]$Path, [int]$MaxBytes) {
    # Codex (codex exec --json) and Gemini (-o stream-json) write one JSON event per line. Other lines are skipped.
    # Codex: thread.started, turn.completed (usage), turn.failed, item.completed, error.
    # Gemini: init (session_id, model), result (status, stats), error (severity, message).
    $r = @{ session = ''; model = ''; completed = $false; status = ''; failed = ''; error = ''; message = ''; tokens = $null }
    $raw = ''
    try { $raw = Read-SharedText $Path $MaxBytes } catch { return $r }
    $in = [int64]0; $out = [int64]0; $cached = [int64]0; $usage = $false
    foreach ($line in ($raw -split "`r?`n")) {
        $l = $line.Trim()
        if (-not $l.StartsWith('{')) { continue }
        $e = $null
        try { $e = ConvertFrom-Json -InputObject $l } catch { continue }
        if ($null -eq $e) { continue }
        $t = [string]$e.type
        if ($t -eq 'thread.started') {
            $r.session = ([string]$e.thread_id).ToLowerInvariant()
        } elseif ($t -eq 'init') {
            $r.session = [string]$e.session_id
            $r.model = [string]$e.model
        } elseif ($t -eq 'turn.completed') {
            $r.completed = $true
            if ($e.usage) {
                $usage = $true
                $in += [int64]$e.usage.input_tokens
                $cached += [int64]$e.usage.cached_input_tokens
                $out += [int64]$e.usage.output_tokens
            }
        } elseif ($t -eq 'turn.failed') {
            $m = ''
            if ($e.error) { $m = [string]$e.error.message }
            if (-not $m) { $m = 'the turn failed' }
            $r.failed = $m
        } elseif ($t -eq 'result') {
            $r.status = [string]$e.status
            if ($e.error -and $e.error.message) { $r.error = [string]$e.error.message }
            if ($e.stats) {
                $s = $e.stats
                $r.tokens = [ordered]@{ input = [int64]$s.input_tokens; output = [int64]$s.output_tokens; cached = [int64]$s.cached; total = [int64]$s.total_tokens }
            }
        } elseif ($t -eq 'error') {
            if ([string]$e.severity -ne 'warning') { $r.error = [string]$e.message }
        } elseif ($t -eq 'item.completed' -and $e.item) {
            $kind = [string]$e.item.type
            if (-not $kind) { $kind = [string]$e.item.item_type }
            if ($kind -eq 'agent_message' -and $e.item.text) { $r.message = [string]$e.item.text }
        }
    }
    if ($usage) { $r.tokens = [ordered]@{ input = $in; output = $out; cached = $cached; total = $in + $out } }
    return $r
}

# ---------- status ----------
if ($Status) {
    if (-not (Test-Path $WorkerDir)) { throw "No workers folder for $TaskId" }
    Get-ChildItem $WorkerDir -Filter '*.run.json' | ForEach-Object {
        $s = Get-Content $_.FullName -Raw | ConvertFrom-Json
        $alive = $false
        if ($s.state -eq 'running' -and $s.pid) { $alive = [bool](Get-Process -Id $s.pid -ErrorAction SilentlyContinue) }
        $t = [string]$s.tool
        if (-not $t) { $t = 'claude' }   # a run from before -Tool
        $tk = $null
        if ($s.tokens) { $tk = $s.tokens.total }
        [pscustomobject]@{ Worker = $s.worker; Type = $s.type; Tool = $t; State = $s.state; Alive = $alive; Started = $s.started
            Finished = $s.finished; Exit = $s.exit_code; CostUsd = $s.cost_usd; Turns = $s.num_turns; Tokens = $tk }
    } | Format-Table -AutoSize
    return
}

if (-not $Worker) { throw 'Specify -Worker (e.g. W1) or -Status.' }

# ---------- settings ----------
# Local settings: bin\relay-settings.json (the worktrees folder, the programs, and the AI tools that may run workers)
# and bin\cost-limits.json (the caps).
$rsFile = Join-Path $PSScriptRoot 'relay-settings.json'
$rs = $null
if (Test-Path -LiteralPath $rsFile -PathType Leaf) {
    try { $rs = Get-Content -LiteralPath $rsFile -Raw | ConvertFrom-Json } catch { throw "Could not read ${rsFile}: $($_.Exception.Message)" }
}
$clFile = Join-Path $PSScriptRoot 'cost-limits.json'
$cl = $null
if (Test-Path -LiteralPath $clFile) {
    try { $cl = Get-Content -LiteralPath $clFile -Raw | ConvertFrom-Json } catch { $cl = $null }
}

$WorkerTools = @('claude')
if ($rs -and $null -ne $rs.worker_tools) { $WorkerTools = @(@($rs.worker_tools) | ForEach-Object { ([string]$_).Trim().ToLowerInvariant() }) }
if ($WorkerTools -notcontains $Tool) {
    $on = $WorkerTools -join ', '
    if (-not $on) { $on = 'none' }
    throw ("Refusing: $ToolName workers are off. worker_tools in $rsFile lists the AI tools that may run workers (now: $on). " +
        "To turn $ToolName workers on, add `"$Tool`" to it. Nothing was started.")
}

function Get-ToolProgram([string]$Name) {
    # The program for one AI tool: its <tool>_exe setting (a full path), else where the tool is usually installed.
    $key = $Name + '_exe'
    $set = ''
    if ($rs -and $rs.$key) { $set = ([string]$rs.$key).Trim() }
    if ($set) {
        if (-not [IO.Path]::IsPathRooted($set)) { throw "Refusing: $key in $rsFile must be a full path (got $set)" }
        if ($set -match '\.ps1$') { throw "Refusing: $key in $rsFile must name a .exe, .cmd or .js program, not a PowerShell script (got $set)" }
        return $set
    }
    if ($Name -eq 'claude') { return (Join-Path $env:APPDATA 'npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe') }
    foreach ($n in @("$Name.exe", "$Name.cmd")) {
        $c = Get-Command $n -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($c) { return $c.Path }
    }
    throw "$ToolName was not found. Install it, or set $key in $rsFile to its full path."
}

# ---------- preflight ----------
$Exe = Get-ToolProgram $Tool
$Brief = Join-Path $WorkerDir "$Worker-brief.md"
if (-not (Test-Path $Brief)) { throw "Brief not found: $Brief" }
if (-not (Test-Path -LiteralPath $Exe -PathType Leaf)) {
    if ($Tool -eq 'claude') { throw "claude.exe not found at $Exe" }
    throw "$ToolName was not found at $Exe"
}
if ($Exe -match '\.js$' -and -not (Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue)) {
    throw 'node.exe was not found (needed only for a .js program)'
}

$wtLine = Select-String -LiteralPath $Brief -Pattern '^\s*-\s*\*\*Worktree[^:]*:\*\*\s*(\S+)' | Select-Object -First 1
if (-not $wtLine) { throw "Brief has no '- **Worktree ...:** <path>' line: $Brief" }
$Worktree = $wtLine.Matches[0].Groups[1].Value.Trim('`')

# Workers run only inside the worktrees folder.
$WorktreesDir = ''
if ($rs) {
    if ($rs.worktrees_dir) { $WorktreesDir = [string]$rs.worktrees_dir }
    elseif ($rs.projects_dir) { $WorktreesDir = Join-Path ([string]$rs.projects_dir) '_worktrees\claude' }
}
if (-not $WorktreesDir) { throw "Set projects_dir (or worktrees_dir) in $rsFile first. Workers run only inside that folder." }
$WorktreesDir = [IO.Path]::GetFullPath($WorktreesDir).TrimEnd('\') + '\'
# A full path only, with any .. resolved, so a brief cannot step outside the worktrees folder.
if (-not [IO.Path]::IsPathRooted($Worktree)) { throw "Refusing: the worktree in the brief must be a full path (got $Worktree)" }
$Worktree = [IO.Path]::GetFullPath($Worktree)
if (-not $Worktree.StartsWith($WorktreesDir, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing: worktree must be under $WorktreesDir (got $Worktree)"
}
if (-not (Test-Path $Worktree)) { throw "Worktree from brief does not exist: $Worktree" }

$RunFile = Join-Path $WorkerDir "$Worker.run.json"
$LogFile = Join-Path $WorkerDir "$Worker.log"
if (Test-Path $RunFile) {
    $prev = Get-Content $RunFile -Raw | ConvertFrom-Json
    if ($prev.state -eq 'running' -and $prev.pid -and (Get-Process -Id $prev.pid -ErrorAction SilentlyContinue)) {
        throw "$Worker for $TaskId is already running (pid $($prev.pid))."
    }
}

# ---------- Codex and Gemini: checks before anything starts ----------
function Get-ModelError([string]$Name) {
    # A model for -m: not a Claude model, and one word of plain characters.
    if ($Name -match '^(claude|opus|sonnet|haiku|fable)') {
        return "-Model $Name is a Claude model. For a $ToolName worker, leave -Model out to use ${ToolName}'s default model, or name one of ${ToolName}'s models"
    }
    if ($Name -notmatch '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,79}$') { return "-Model $Name has characters the relay does not pass on (use letters, digits and . _ : / - only)" }
    return ''
}

function Get-RunLimit([string]$Name) {
    # worker_runs_per_day in bin\cost-limits.json, for example {"codex": 12, "gemini": 4}. 0 means no limit.
    $limit = 12
    if ($Name -eq 'gemini') { $limit = 4 }
    if ($cl -and $cl.worker_runs_per_day) {
        $v = $cl.worker_runs_per_day.$Name
        if ($null -ne $v) { try { $n = [int]$v; if ($n -ge 0) { $limit = $n } } catch { } }
    }
    return $limit
}

function Get-RunsToday([string]$Name) {
    # Today's runs of one tool: its rows in every task's runs.md (a row with exit -1 was refused and started nothing),
    # and its runs that are running now.
    $today = (Get-Date).ToString('yyyy-MM-dd')
    $n = 0
    foreach ($f in @(Get-ChildItem -Path (Join-Path $Bridge 'tasks\*\workers\runs.md') -File -ErrorAction SilentlyContinue)) {
        foreach ($line in @(Get-Content -LiteralPath $f.FullName -ErrorAction SilentlyContinue)) {
            $c = @(([string]$line).Trim().Trim('|').Split('|') | ForEach-Object { $_.Trim() })
            if ($c.Count -lt 12) { continue }
            if ($c[0].StartsWith($today) -and $c[10] -eq $Name -and $c[5] -ne '-1') { $n++ }
        }
    }
    foreach ($f in @(Get-ChildItem -Path (Join-Path $Bridge 'tasks\*\workers\*.run.json') -File -ErrorAction SilentlyContinue)) {
        $s = $null
        try { $s = Get-Content -LiteralPath $f.FullName -Raw | ConvertFrom-Json } catch { continue }
        if ($s -and $s.state -eq 'running' -and [string]$s.tool -eq $Name -and $s.pid -and (Get-Process -Id $s.pid -ErrorAction SilentlyContinue)) { $n++ }
    }
    return $n
}

function Get-CodexConfigModel {
    # The model that Codex's own settings name: model = "..." at the top of <CODEX_HOME>\config.toml, or ''.
    # Read only, and only that line.
    $codexHome = $env:CODEX_HOME
    if (-not $codexHome) { $codexHome = Join-Path $env:USERPROFILE '.codex' }
    $f = Join-Path $codexHome 'config.toml'
    if (-not (Test-Path -LiteralPath $f -PathType Leaf)) { return '' }
    try {
        foreach ($line in @(Get-Content -LiteralPath $f -TotalCount 400 -ErrorAction Stop)) {
            if ($line -match '^\s*\[') { break }   # the first table: the top-level keys end here
            if ($line -match '^\s*model\s*=\s*["'']([^"'']*)["'']') { return $Matches[1] }
        }
    } catch { }
    return ''
}

$ToolModel = ''      # Codex and Gemini: the value for -m; '' means the tool's own default model
if ($Tool -ne 'claude') {
    if ($Model -and $Model -ne $ClaudeDefaultModel) {
        $why = Get-ModelError $Model
        if ($why) { throw "Refusing: $why. Nothing was started." }
        $ToolModel = $Model
    }
    if ($Tool -eq 'codex' -and $Effort -eq 'max') { throw 'Refusing: Codex has no max effort. Use -Effort xhigh or lower for a Codex worker. Nothing was started.' }
    $limit = Get-RunLimit $Tool
    if ($limit -gt 0) {
        $done = Get-RunsToday $Tool
        if ($done -ge $limit) {
            throw "Refusing: today already had $done $ToolName worker run(s), and the limit is $limit a day (worker_runs_per_day in $clFile). Nothing was started."
        }
    }
    if ($Tool -eq 'gemini') {
        if ($WorkerDir.Contains(',')) {
            throw "Refusing: Gemini CLI cuts the paths it is given at commas, and the workers folder has one ($WorkerDir). Use a mailbox folder without commas. Nothing was started."
        }
        $gs = Join-Path $Worktree '.gemini\settings.json'
        if (Test-Path -LiteralPath $gs) {
            throw ("Refusing: the worktree has $gs. Gemini CLI reads that file when it starts, and it can run commands from it. " +
                'Take it out of the branch, or use another tool for this worker. Nothing was started.')
        }
        $policyDirs = @($GeminiSystemPolicies)
        if ($env:RELAY_TEST_GEMINI_POLICY_DIR) { $policyDirs += [string]$env:RELAY_TEST_GEMINI_POLICY_DIR }   # test only
        foreach ($d in $policyDirs) {
            $toml = @(Get-ChildItem -LiteralPath $d -File -Filter '*.toml' -ErrorAction SilentlyContinue)
            if ($toml.Count) {
                throw ("Refusing: $d holds Gemini admin policies ($($toml[0].Name)). Then Gemini CLI ignores the relay's own policy " +
                    'for the worker (--admin-policy), so the relay does not start Gemini workers on this computer. Nothing was started.')
            }
        }
    }
}

function Get-ModelText {
    # The model, in words, for the launch line and the log.
    if ($Tool -eq 'claude') { return "model $Model" }
    if ($ToolModel) { return "model $ToolModel (from -Model)" }
    if ($Tool -eq 'codex') {
        $m = Get-CodexConfigModel
        if ($m) { return "model $m (Codex's default, from its config.toml)" }
        return "Codex's own default model (its config.toml names none)"
    }
    return "Gemini CLI's default model"
}

function Get-EffortText {
    if ($Tool -eq 'gemini') { return 'no effort (Gemini CLI has no effort setting)' }
    return "effort $Effort"
}

# ---------- detach: re-launch this script hidden in foreground mode ----------
if (-not $Foreground) {
    $argList = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"",
        '-TaskId', $TaskId, '-Worker', $Worker, '-Type', $Type, '-MaxBudgetUsd', $MaxBudgetUsd.ToString($Inv), '-Effort', $Effort, '-Foreground')
    if ($Model) { $argList += @('-Model', $Model) }
    if ($Tool -ne 'claude') { $argList += @('-Tool', $Tool) }
    $p = Start-Process -FilePath 'powershell.exe' -ArgumentList $argList -WindowStyle Hidden -PassThru
    if ($Tool -eq 'claude') {
        Write-Output "Launched $Worker ($Type) for $TaskId - runner pid $($p.Id), model $Model, effort $Effort. Check: -Status"
    } else {
        Write-Output "Launched $Worker ($Type, $ToolName) for $TaskId - runner pid $($p.Id), $(Get-ModelText), $(Get-EffortText). Check: -Status"
    }
    return
}

# ---------- foreground runner ----------
$state = @{ task = $TaskId; worker = $Worker; type = $Type; tool = $Tool; state = 'running'; pid = $PID; worktree = $Worktree
    started = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss'); finished = $null; exit_code = $null; cost_usd = $null
    num_turns = $null; budget_usd = $MaxBudgetUsd; effort = $Effort; model = $Model; billing = 'claude-code-subscription'
    session_id = [guid]::NewGuid().ToString(); tokens = $null }
if ($Tool -eq 'codex') {
    $state.session_id = $null          # the thread id comes from Codex's thread.started event
    $state.billing = 'chatgpt-sign-in'
    $state.budget_usd = $null          # Codex reports no cost; worker_runs_per_day limits the runs
    $state.model = $ToolModel
    if (-not $ToolModel) { $state.model = Get-CodexConfigModel }
    if (-not $state.model) { $state.model = 'codex default' }
} elseif ($Tool -eq 'gemini') {
    $state.billing = 'gemini-own-login (paid per use)'
    $state.budget_usd = $null          # Gemini CLI reports no cost; worker_runs_per_day limits the runs
    $state.effort = $null
    $state.model = $ToolModel
    if (-not $ToolModel) { $state.model = 'gemini default' }
}
Write-RunState $RunFile $state

$report = Join-Path $WorkerDir "$Worker-report.md"
$errFile = "$LogFile.err"
$exit = $null

if ($Tool -eq 'claude') {
    $deny = @('WebFetch', 'WebSearch', 'Bash(git push*)', 'Bash(git merge*)', 'Bash(git rebase*)', 'Bash(git reset*)',
        'Bash(git checkout*)', 'Bash(git switch*)', 'Bash(git branch*)', 'Bash(git worktree*)', 'Bash(git tag*)',
        'Bash(git stash*)', 'Bash(git config*)', 'Bash(npm *)', 'Bash(npx *)')
    if ($Type -eq 'implementation') {
        $tools = @('Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash(git *)', 'Bash(node *)')
    } else {
        $tools = @('Read', 'Write', 'Glob', 'Grep', 'Bash(git diff*)', 'Bash(git log*)', 'Bash(git show*)', 'Bash(git status*)', 'Bash(node *)')
        $deny += @('Edit', 'Bash(git commit*)', 'Bash(git add*)')
    }

    $prompt = "You are Claude worker $Worker ($Type). Read and follow exactly the brief at $Brief. " +
        "Your working directory is the task worktree $Worktree. Stay inside the brief's file scope. " +
        "Put throwaway scripts only in $env:TEMP. When finished, write your report to $report and stop."

    # Cost-limit switch: bin\cost-limits.json {"enabled":false} drops the per-run cap; cost is still recorded.
    $costLimits = $true
    if ($cl -and $null -ne $cl.enabled) { try { $costLimits = [bool]$cl.enabled } catch { } }
    $state.budget_usd = if ($costLimits) { $MaxBudgetUsd } else { 'off' }
    Write-RunState $RunFile $state

    $claudeArgs = @('-p', $prompt, '--output-format', 'json', '--permission-mode', 'acceptEdits',
        '--setting-sources', '', '--strict-mcp-config', '--disable-slash-commands', '--tools', 'Read,Edit,Write,Glob,Grep,Bash',
        '--session-id', $state.session_id, '--add-dir', $WorkerDir, '--add-dir', $env:TEMP, '--allowedTools') + $tools + @('--disallowedTools') + $deny
    if ($costLimits) { $claudeArgs += @('--max-budget-usd', $MaxBudgetUsd.ToString($Inv)) }
    if ($Model) { $claudeArgs += @('--model', $Model) }
    $claudeArgs += @('--effort', $Effort)   # default xhigh ("Extra High")

    # Start-Process joins arguments with spaces; quote each one (no argument contains a double quote).
    $argString = ($claudeArgs | ForEach-Object { if ($_ -eq '') { '""' } elseif ($_ -match '\s') { '"' + $_ + '"' } else { $_ } }) -join ' '
    $launch = Get-Launch $Exe
    $prefix = @($launch.prefix)
    if ($prefix.Count) { $argString = (($prefix | ForEach-Object { '"' + $_ + '"' }) -join ' ') + ' ' + $argString }

    $stdin = Join-Path $env:TEMP "claude-worker-$TaskId-$Worker.stdin"
    Set-Content -LiteralPath $stdin -Value '' -NoNewline
    $previousEnvironment = @{}
    try {
        foreach ($name in @('ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN',
                'ANTHROPIC_PROFILE', 'ANTHROPIC_FEDERATION_RULE_ID', 'ANTHROPIC_ORGANIZATION_ID',
                'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY')) {
            $previousEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
            [Environment]::SetEnvironmentVariable($name, $null, 'Process')
        }
        # Windows PowerShell 5.1 turns native stderr into errors even when redirected.
        # Capture the probe's stdout and exit code before restoring strict error handling.
        $authErrorActionPreference = $ErrorActionPreference
        try {
            $ErrorActionPreference = 'Continue'
            $authRaw = ((& $launch.file @prefix auth status 2>$null) | Out-String)
            $authExitCode = $LASTEXITCODE
        } finally { $ErrorActionPreference = $authErrorActionPreference }
        $auth = $authRaw | ConvertFrom-Json
        if ($authExitCode -ne 0 -or -not $auth.loggedIn -or $auth.authMethod -ne 'claude.ai' -or -not $auth.subscriptionType) {
            throw 'Claude Code subscription login is unavailable; run claude auth login and select your Claude subscription (no API fallback)'
        }
        $proc = Start-Process -FilePath $launch.file -ArgumentList $argString -WorkingDirectory $Worktree -NoNewWindow -Wait -PassThru `
            -RedirectStandardInput $stdin -RedirectStandardOutput $LogFile -RedirectStandardError $errFile
        $exit = $proc.ExitCode
    } catch {
        "launcher error: $($_.Exception.Message)" | Add-Content -LiteralPath $errFile
        $exit = -1
    } finally {
        foreach ($name in $previousEnvironment.Keys) { [Environment]::SetEnvironmentVariable($name, $previousEnvironment[$name], 'Process') }
        Remove-Item -LiteralPath $stdin -ErrorAction SilentlyContinue
    }

    # ---------- record result ----------
    $state.finished = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
    $state.exit_code = $exit
    $state.state = if ($exit -eq 0) { 'finished' } else { 'failed' }
    try {
        $raw = Get-Content -LiteralPath $LogFile -Raw
        $i = $raw.IndexOf('{')
        if ($i -ge 0) {
            $r = $raw.Substring($i) | ConvertFrom-Json
            if ($null -ne $r.total_cost_usd) { $state.cost_usd = [math]::Round([double]$r.total_cost_usd, 4) }
            if ($r.modelUsage) { $state.models = ($r.modelUsage.PSObject.Properties.Name -join ', ') }
            $state.num_turns = $r.num_turns
            $state.tokens = Get-ClaudeTokens $r
            if ($r.is_error -or ($r.subtype -and $r.subtype -ne 'success')) { $state.state = "failed ($($r.subtype))" }
        }
    } catch { }
} else {
    # ---------- Codex and Gemini ----------
    function Set-ChildEnvironment([hashtable]$Values) {
        # Process-local only: sets (or, with $null, removes) each variable for the child. Returns the old values.
        $previous = @{}
        foreach ($name in @($Values.Keys)) {
            $previous[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
            [Environment]::SetEnvironmentVariable($name, $Values[$name], 'Process')
        }
        return $previous
    }

    function Restore-ChildEnvironment([hashtable]$Previous) {
        if ($null -eq $Previous) { return }
        foreach ($name in @($Previous.Keys)) { [Environment]::SetEnvironmentVariable($name, $Previous[$name], 'Process') }
    }

    function Invoke-ToolRun([string[]]$CliArgs, [string]$Cwd, [string]$Prompt, [hashtable]$Environment, [scriptblock]$Check) {
        # One Codex or Gemini run: the prompt on stdin, the output in <W>.log, errors in <W>.log.err. $Check runs right
        # before the start, inside the child's environment, and throws to refuse. Returns the exit code (-1: refused,
        # nothing started).
        $stdin = Join-Path $env:TEMP "$Tool-worker-$TaskId-$Worker.stdin"
        [IO.File]::WriteAllText($stdin, $Prompt, $Utf8)
        $proc = $null
        $previous = $null
        try {
            try {
                $previous = Set-ChildEnvironment $Environment
                & $Check
                $launch = Get-Launch $Exe
                if ($launch.file -match '\.(cmd|bat)$') {
                    foreach ($a in $CliArgs) {
                        if ($a -match '[\x00-\x1f"%!^&|<>]') {
                            throw ("Refusing: $ToolName runs through cmd.exe ($($launch.file)), and the argument $a has a character that cmd.exe " +
                                "treats specially. Use folders without % ! ^ & | < > in their names, or set ${Tool}_exe to a .exe. Nothing was started.")
                        }
                    }
                }
                $line = (@(@($launch.prefix) + @($CliArgs)) | ForEach-Object { ConvertTo-ArgToken $_ }) -join ' '
                $proc = Start-Process -FilePath $launch.file -ArgumentList $line -WorkingDirectory $Cwd -NoNewWindow -PassThru `
                    -RedirectStandardInput $stdin -RedirectStandardOutput $LogFile -RedirectStandardError $errFile
                $null = $proc.Handle   # keeps the exit code readable
            } finally { Restore-ChildEnvironment $previous }
        } catch {
            $msg = $_.Exception.Message
            "launcher error: $msg" | Add-Content -LiteralPath $errFile
            Add-Note "launcher error: $msg"
            Remove-Item -LiteralPath $stdin -ErrorAction SilentlyContinue
            return -1
        }
        # Poll the output while the run goes, so the session id is saved as soon as the CLI reports it.
        $seen = $false
        while (-not $proc.WaitForExit(1000)) {
            if ($seen) { continue }
            try {
                $ev = Read-ToolEvents $LogFile 65536
                if ($ev.session) {
                    $seen = $true
                    if ($ev.session -ne [string]$state.session_id) { $state.session_id = $ev.session; Write-RunState $RunFile $state }
                }
            } catch { }
        }
        $proc.WaitForExit()
        $code = $proc.ExitCode
        Remove-Item -LiteralPath $stdin -ErrorAction SilentlyContinue
        return $code
    }

    function Get-ToolPrompt {
        $p = "You are $ToolName worker $Worker ($Type), started by the Claude coordinator's launcher. Read and follow exactly the brief at $Brief. "
        if ($Type -eq 'implementation') {
            $p += "Your working directory is the task worktree $Worktree. Stay inside the brief's file scope. "
        } else {
            $p += "Review the task worktree ${Worktree}: read it, but change nothing in it. The only file you may write is your report. "
        }
        if ($Tool -eq 'gemini') {
            $git = 'git status, git diff, git log, git show, git rev-parse'
            if ($Type -eq 'implementation') { $git += ', git add, git commit' }
            $p += "You can read only the worktree and the task's workers folder $WorkerDir. Shell commands: only $git and node <a script>, with no > or >>. "
        } elseif ($Type -eq 'review') {
            $p += "Your working directory is the task's workers folder $WorkerDir. "
        } else {
            $p += "Do not run git add or git commit: Git's own folder is outside your sandbox. When you finish, the launcher commits your changes. "
        }
        $p += "Never push, merge or change branches. When finished, write your report to $report and stop."
        return $p
    }

    Add-Note (Get-ModelText)
    Add-Note (Get-EffortText)
    Add-Note "$ToolName reports no cost in dollars, so -MaxBudgetUsd does not apply. worker_runs_per_day in bin\cost-limits.json limits the runs."

    function Save-CodexWork {
        # A Codex worker cannot write Git's own folder, so the launcher commits its changes, outside the sandbox.
        $git = Get-Command git.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if (-not $git) { Add-Note "Git was not found, so the Codex worker's changes stay uncommitted in the worktree."; return }
        $previous = $ErrorActionPreference
        try {
            $ErrorActionPreference = 'Continue'
            $changes = ((& $git.Path -C $Worktree status --porcelain 2>$null) | Out-String).Trim()
            if ($LASTEXITCODE -ne 0) { Add-Note "git status failed in the worktree, so the Codex worker's changes were not committed."; return }
            if (-not $changes) { Add-Note 'The Codex worker changed no files, so there was nothing to commit.'; return }
            $null = & $git.Path -C $Worktree add -A 2>$null
            if ($LASTEXITCODE -ne 0) { Add-Note "git add failed, so the Codex worker's changes stay uncommitted in the worktree."; return }
            $message = "$TaskId ${Worker}: changes from the Codex worker run"
            $said = ((& $git.Path -C $Worktree commit -q -m $message 2>&1) | ForEach-Object { [string]$_ }) -join ' '
            if ($LASTEXITCODE -ne 0) { Add-Note "git commit failed, so the Codex worker's changes stay uncommitted in the worktree: $said"; return }
            $sha = ((& $git.Path -C $Worktree rev-parse HEAD 2>$null) | Out-String).Trim()
            $state.commit = $sha
            Add-Note "Committed the Codex worker's changes as $sha."
        } finally { $ErrorActionPreference = $previous }
    }

    if ($Tool -eq 'codex') {
        $cwd = $Worktree
        # The network stays off whatever Codex's own settings say. Git's own folder is not writable, so a worker can
        # never add a Git hook or change Git's settings; the launcher commits its changes (Save-CodexWork).
        $cliArgs = @('exec', '--json', '--skip-git-repo-check', '--sandbox', 'workspace-write', '-c', 'sandbox_workspace_write.network_access=false')
        if ($Type -eq 'implementation') {
            $cliArgs += @('--add-dir', $WorkerDir)
        } else {
            $cwd = $WorkerDir   # a reviewer can write only in the workers folder, its report's folder
        }
        if ($ToolModel) { $cliArgs += @('-m', $ToolModel) }
        $cliArgs += @('-c', "model_reasoning_effort=$($Effort.ToLowerInvariant())", '-')
        # The ChatGPT sign-in, checked the way the relay's Codex wake checks it ('codex login status' may answer on stderr).
        $check = {
            $launch = Get-Launch $Exe
            $prefix = @($launch.prefix)
            $signIn = ''
            $signInExit = 1
            $probePreference = $ErrorActionPreference
            try {
                $ErrorActionPreference = 'Continue'
                $signIn = ((& $launch.file @prefix login status 2>&1) | ForEach-Object { [string]$_ }) -join ' '
                $signInExit = $LASTEXITCODE
            } finally { $ErrorActionPreference = $probePreference }
            if ($signInExit -ne 0 -or $signIn -notmatch '(?i)chatgpt' -or $signIn -match '(?i)api key') {
                throw 'Codex is not signed in with ChatGPT. Run codex login and choose ChatGPT. The relay never uses an API key for Codex.'
            }
        }
        # Process-local: the run uses the saved ChatGPT sign-in, never an inherited API key or endpoint.
        $codexEnvironment = @{ OPENAI_API_KEY = $null; CODEX_API_KEY = $null; OPENAI_BASE_URL = $null; OPENAI_ORG_ID = $null; OPENAI_PROJECT_ID = $null }
        $exit = Invoke-ToolRun $cliArgs $cwd (Get-ToolPrompt) $codexEnvironment $check

        if ($exit -eq -1) {
            $state.state = 'failed'   # refused: nothing started, and <W>.log is an older run's
        } else {
            $ev = Read-ToolEvents $LogFile 0
            if ($ev.session) { $state.session_id = $ev.session } else { Add-Note 'Codex reported no thread id, so run.json has no session_id.' }
            $state.tokens = $ev.tokens
            if ($exit -eq 0 -and $ev.completed -and -not $ev.failed) {
                $state.state = 'finished'
                if ($Type -eq 'implementation') { Save-CodexWork }
            } else {
                $state.state = 'failed'
                $why = $ev.failed
                if (-not $why) { $why = $ev.error }
                if ($why) { $state.note = "Codex stopped: $why (exit $exit)." } else { $state.note = "Codex ended without finishing its turn (exit $exit)." }
                Add-Note $state.note
            }
        }
    } else {
        $policyFile = Join-Path $WorkerDir "$Worker.gemini-policy.toml"
        $defaultsFile = Join-Path $WorkerDir "$Worker.gemini-defaults.json"
        $turns = 30
        if ($cl -and $null -ne $cl.gemini_max_session_turns) {
            try { $v = [int]$cl.gemini_max_session_turns; if ($v -ge 0) { $turns = $v } } catch { }
        }
        if ($turns -eq 0) { $turns = -1 }   # 0 means no limit, which Gemini CLI writes as -1

        function ConvertTo-TomlText([string]$Text) {
            # A TOML basic string: backslash, quote and control characters escaped.
            $sb = New-Object System.Text.StringBuilder
            [void]$sb.Append('"')
            foreach ($ch in $Text.ToCharArray()) {
                $c = [int]$ch
                if ($ch -eq [char]'\') { [void]$sb.Append('\\') }
                elseif ($ch -eq [char]'"') { [void]$sb.Append('\"') }
                elseif ($c -lt 32 -or $c -eq 127) { [void]$sb.Append(('\u{0:X4}' -f $c)) }
                else { [void]$sb.Append($ch) }
            }
            [void]$sb.Append('"')
            return $sb.ToString()
        }

        function ConvertTo-TomlList([string[]]$Items) { return '[' + ((@($Items) | ForEach-Object { ConvertTo-TomlText $_ }) -join ', ') + ']' }

        function New-GeminiPolicy {
            # Gemini CLI's TOML policy format (v0.66.0): [[rule]] with toolName, mcpName, commandPrefix, commandRegex,
            # argsPattern, decision and priority (0-999). The rule with the highest priority wins.
            $review = ($Type -eq 'review')
            $shell = @('git status', 'git diff', 'git log', 'git show', 'git rev-parse')
            if (-not $review) { $shell = @('git status', 'git diff', 'git log', 'git show', 'git add', 'git commit', 'git rev-parse') }
            $shell += 'node'   # commandPrefix needs a space, a quote or the end after it, so this is "node <something>"
            $denyShell = @('git push', 'git merge', 'git rebase', 'git reset', 'git checkout', 'git switch', 'git branch', 'git worktree',
                'git tag', 'git stash', 'git config', 'npm', 'npx')
            if ($review) { $denyShell += @('git add', 'git commit') }
            $L = New-Object System.Collections.Generic.List[string]
            $L.Add("# Gemini CLI admin policy for worker $Worker ($Type) of $TaskId, written by the relay's bin\spawn-worker.ps1.")
            $L.Add('# Gemini CLI reads it with --admin-policy. The rule with the highest priority wins, and every deny below')
            $L.Add('# has a higher priority than every allow, so a deny always wins.')
            $L.Add('')
            $L.Add('# Everything that no rule below allows is denied.')
            $L.Add('[[rule]]'); $L.Add('toolName = "*"'); $L.Add('decision = "deny"'); $L.Add('priority = 0')
            $L.Add('denyMessage = ' + (ConvertTo-TomlText 'The relay does not let this worker use this tool. See your brief.'))
            $L.Add('')
            $L.Add('# Read and search.')
            $L.Add('[[rule]]'); $L.Add('toolName = ' + (ConvertTo-TomlList @('read_file', 'glob', 'grep_search', 'list_directory')))
            $L.Add('decision = "allow"'); $L.Add('priority = 100')
            $L.Add('')
            if ($review) {
                # The call's arguments as the policy engine sees them: JSON, each top-level argument between NUL characters.
                $back = [regex]::Escape($report.Replace('\', '\\'))
                $fwd = [regex]::Escape($report.Replace('\', '/'))
                $pattern = '\x00"file_path":"(?:' + $back + '|' + $fwd + ')"\x00'
                if ($pattern.Length -gt 2000) { throw "Refusing: the report's path is too long for the Gemini policy ($report). Nothing was started." }
                $L.Add('# A reviewer writes only its report.')
                $L.Add('[[rule]]'); $L.Add('toolName = "write_file"'); $L.Add('argsPattern = ' + (ConvertTo-TomlText $pattern))
                $L.Add('decision = "allow"'); $L.Add('priority = 100')
                $L.Add('')
                $L.Add('[[rule]]'); $L.Add('toolName = ' + (ConvertTo-TomlList @('write_file', 'replace'))); $L.Add('decision = "deny"'); $L.Add('priority = 50')
                $L.Add('denyMessage = ' + (ConvertTo-TomlText "A reviewer writes only its report: $report"))
            } else {
                $L.Add('# Write and edit files. Gemini CLI keeps them inside the worktree and the workers folder.')
                $L.Add('[[rule]]'); $L.Add('toolName = ' + (ConvertTo-TomlList @('write_file', 'replace')))
                $L.Add('decision = "allow"'); $L.Add('priority = 100')
            }
            $L.Add('')
            $L.Add('# Shell: only commands that start with these. A command with > or >> is not allowed.')
            $L.Add('[[rule]]'); $L.Add('toolName = "run_shell_command"'); $L.Add('commandPrefix = ' + (ConvertTo-TomlList $shell))
            $L.Add('decision = "allow"'); $L.Add('priority = 100')
            $L.Add('')
            $L.Add('# Always denied.')
            $L.Add('[[rule]]'); $L.Add('toolName = "run_shell_command"'); $L.Add('commandPrefix = ' + (ConvertTo-TomlList $denyShell))
            $L.Add('decision = "deny"'); $L.Add('priority = 900')
            $L.Add('')
            $L.Add('# node -e, --eval and -p run code that is not in a file: first, then later on the command line.')
            foreach ($rx in @('node (?:-e|-p|-pe|--eval|--print)(?:[\s="]|\\")', 'node [^"]* (?:-e|-p|-pe|--eval|--print)(?:[\s="]|\\")')) {
                $L.Add('[[rule]]'); $L.Add('toolName = "run_shell_command"'); $L.Add('commandRegex = ' + (ConvertTo-TomlText $rx))
                $L.Add('decision = "deny"'); $L.Add('priority = 900')
                $L.Add('')
            }
            $L.Add('# No web.')
            $L.Add('[[rule]]'); $L.Add('toolName = ' + (ConvertTo-TomlList @('web_fetch', 'google_web_search'))); $L.Add('decision = "deny"'); $L.Add('priority = 900')
            $L.Add('')
            $L.Add('# No MCP tools, from any server.')
            $L.Add('[[rule]]'); $L.Add('toolName = "*"'); $L.Add('mcpName = "*"'); $L.Add('decision = "deny"'); $L.Add('priority = 900')
            return (($L -join "`n") + "`n")
        }

        function Get-GeminiExitText([int]$Code) {
            # Gemini CLI's exit codes (FatalError classes in v0.66.0): a short word for the state, and a plain sentence.
            switch ($Code) {
                41 { return @('not signed in', 'Gemini is not signed in. Gemini CLI needs a paid API key, Vertex AI or a work license. Set one up in Gemini CLI first.') }
                42 { return @('bad input', 'Gemini CLI said the input was bad (exit 42), so it did not do the work.') }
                52 { return @('settings problem', 'Gemini CLI found a problem in its settings (exit 52).') }
                53 { return @('turn limit', "The worker used up its turns ($turns, from gemini_max_session_turns in bin\cost-limits.json) and Gemini CLI stopped it (exit 53).") }
                54 { return @('tool error', 'A tool failed, and Gemini CLI stopped (exit 54).') }
                55 { return @('untrusted folder', 'Gemini CLI does not trust the worktree folder (exit 55), so it did not do the work.') }
            }
            return @('', "Gemini CLI stopped with exit code $Code.")
        }

        $mode = 'auto_edit'
        if ($Type -eq 'review') { $mode = 'default' }
        $exit = -1
        $prompt = ''
        try {
            [IO.File]::WriteAllText($policyFile, (New-GeminiPolicy), $Utf8)
            $state.policy_sha256 = (Get-FileHash -LiteralPath $policyFile -Algorithm SHA256).Hash.ToLowerInvariant()
            $state.turn_limit = $turns
            [IO.File]::WriteAllText($defaultsFile, ('{"model":{"maxSessionTurns":' + $turns + '}}'), $Utf8)
            Write-RunState $RunFile $state
            if ($env:RELAY_TEST_CHANGE_POLICY -eq '1') { [IO.File]::AppendAllText($policyFile, "# changed by the relay test`n", $Utf8) }   # test only
            # The full prompt on stdin: the launcher's words, then the brief itself. Gemini CLI puts -p after it.
            $prompt = (Get-ToolPrompt) + "`n`nThe brief, from ${Brief}:`n`n" + [IO.File]::ReadAllText($Brief) + "`n"
        } catch {
            "launcher error: $($_.Exception.Message)" | Add-Content -LiteralPath $errFile
            Add-Note "launcher error: $($_.Exception.Message)"
            $prompt = ''
        }
        if ($prompt) {
            $cliArgs = @('--session-id', [string]$state.session_id, '-p', 'Do the work in the brief above.', '-o', 'stream-json',
                '--approval-mode', $mode, '--skip-trust', '--admin-policy', $policyFile, '--include-directories', $WorkerDir)
            if ($ToolModel) { $cliArgs += @('-m', $ToolModel) }
            $check = {
                $now = (Get-FileHash -LiteralPath $policyFile -Algorithm SHA256).Hash.ToLowerInvariant()
                if ($now -ne [string]$state.policy_sha256) { throw "Refusing: the policy file changed after the relay wrote it ($policyFile). Nothing was started." }
            }
            $exit = Invoke-ToolRun $cliArgs $Worktree $prompt @{ GEMINI_CLI_SYSTEM_DEFAULTS_PATH = $defaultsFile } $check
        }

        $ev = Read-ToolEvents $LogFile 0
        if ($exit -ne -1) {
            if ($ev.session -and $ev.session -ne [string]$state.session_id) {
                Add-Note "Gemini CLI reported session $($ev.session), not $($state.session_id), the one the relay gave it. run.json keeps the one Gemini CLI reported."
                $state.session_id = $ev.session
            }
            if ($ev.model) { $state.model = $ev.model }
            $state.tokens = $ev.tokens
            $errText = ''
            try { $errText = Read-SharedText $errFile 1048576 } catch { }
            if ($errText -match 'Skipping system defaults' -or (Read-SharedText $LogFile 0) -match 'Skipping system defaults') {
                $state.turn_limit = 'skipped by Gemini CLI'
                Add-Note ('Gemini CLI did not use the turn limit file: it skips a defaults file that people other than an administrator ' +
                    'can change. To be sure of a turn limit, also set model.maxSessionTurns in your own Gemini settings.')
            }
        }
        if ($exit -eq -1) {
            $state.state = 'failed'
        } elseif ($exit -eq 0 -and $ev.status -eq 'success') {
            $state.state = 'finished'
        } else {
            $state.state = 'failed'
            if ($exit -eq 0) {
                $why = $ev.error
                if (-not $why) { $why = 'Gemini CLI ended without a result' }
                Add-Note "Gemini CLI did not finish the work: $why."
            } else {
                $x = @(Get-GeminiExitText $exit)
                if ($x[0]) { $state.state = "failed ($($x[0]))" }
                $state.note = $x[1]
                Add-Note $x[1]
            }
        }
    }

    if ($exit -eq -1) {
        $state.note = ($Notes | Where-Object { $_ -like 'launcher error:*' } | Select-Object -Last 1) -replace '^launcher error: ', ''
        Set-Content -LiteralPath $LogFile -Value @($Notes | ForEach-Object { "launcher: $_" }) -Encoding UTF8
    } else {
        Add-Content -LiteralPath $LogFile -Value @($Notes | ForEach-Object { "launcher: $_" }) -Encoding UTF8
    }
    $state.finished = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
    $state.exit_code = $exit
}
Write-RunState $RunFile $state

# ---------- ledger ----------
# Old ledgers end their table at the Models column. Their rows stay as they are, and a new table with the Tool and
# Tokens columns starts below them.
$ledger = Join-Path $WorkerDir 'runs.md'
$head = '| Started | Finished | Worker | Type | State | Exit | Cost USD | Turns | Budget | Models | Tool | Tokens |'
$sep = '|---|---|---|---|---|---|---|---|---|---|---|---|'
if (-not (Test-Path $ledger)) {
    "$head`n$sep" | Set-Content -LiteralPath $ledger -Encoding UTF8
} else {
    $lastHead = ''
    foreach ($l in @(Get-Content -LiteralPath $ledger -ErrorAction SilentlyContinue)) { if (([string]$l).StartsWith('| Started |')) { $lastHead = ([string]$l).Trim() } }
    if ($lastHead -ne $head) { Add-Content -LiteralPath $ledger -Encoding UTF8 -Value @('', $head, $sep) }
}
$budget = $state.budget_usd
if ($null -eq $budget) { $budget = '-' }
$cells = @($state.started, $state.finished, $Worker, $Type, $state.state, $exit, $state.cost_usd, $state.num_turns, $budget, $state.models, $Tool, (Format-Tokens $state.tokens))
('| ' + (($cells | ForEach-Object { ([string]$_) -replace '\|', '/' }) -join ' | ') + ' |') | Add-Content -LiteralPath $ledger -Encoding UTF8
