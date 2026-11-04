<#
.SYNOPSIS
  Claude coordinator tooling: launch one worker session in Claude Code (the default), Codex, Gemini CLI or Antigravity CLI.

.DESCRIPTION
  - Claude (-Tool claude, the default): runs `claude -p` with the saved claude.ai subscription login, never --bare or
    an injected API key. Funding overrides are removed only in the runner process and restored after the child exits.
    No API fallback.
  - Codex (-Tool codex), Gemini (-Tool gemini) and Antigravity (-Tool antigravity) stay off until worker_tools in
    bin\relay-settings.json lists them.
    Codex: `codex exec` in a new thread, signed in with ChatGPT (codex login status). OPENAI_API_KEY and the other
    OpenAI overrides are removed for the child, so it never bills an API account. Gemini: `gemini -p` with the owner's
    own Gemini login (GEMINI_API_KEY passes through untouched; Gemini is paid per use), a per-run admin policy
    (--admin-policy, checked by SHA-256 right before the start) and a turn limit (GEMINI_CLI_SYSTEM_DEFAULTS_PATH).
    Antigravity: `agy` in a new headless conversation (--input-format stream-json, the prompt as one line on stdin),
    in --mode accept-edits, with the owner's own Antigravity login, which the launcher never reads. Google's consumer
    terms may not allow running it from other programs, so every run writes a warning in <W>.log. There is no
    permission file for one run: its commands follow the owner's own Antigravity settings, and with no rule there it
    runs none, so the launcher commits its changes, as for Codex: with no Git hooks, and only when the run left the
    worktree's .git alone. It works only in a Git worktree (git worktree add). antigravity_sandbox: true adds --sandbox.
  - Programs: claude_exe, codex_exe, gemini_exe and antigravity_exe in bin\relay-settings.json (full paths; a .js path
    runs through node, which the test uses). Without them: %APPDATA%\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe,
    codex or gemini from PATH, and %LOCALAPPDATA%\agy\bin\agy.exe (else agy from PATH).
  - Daily limits for Codex, Gemini and Antigravity: worker_runs_per_day in bin\cost-limits.json (12, 4 and 4 unless
    set; 0 means no limit), counted from today's rows in tasks\*\workers\runs.md and the runs that are running now.
  - The worker's working directory is read from its brief (line "- **Worktree ...:** <path>"). It must be inside the
    worktrees folder from bin\relay-settings.json: worktrees_dir, or <projects_dir>\_worktrees\claude. A Codex or
    Antigravity reviewer works in the task's workers folder instead, so it can write only there; a Codex reviewer can
    still read the worktree.
  - Default: detaches; a hidden runner writes, in tasks\<TASK>\workers\:
      <W>.log       Claude: its JSON result. Codex, Gemini and Antigravity: their JSON events, then the launcher's notes.
      <W>.run.json  state / pid / exit code / cost / tool / session_id / tokens
      runs.md       one ledger line per run
  - Each run is a saved session with its own id (session_id in <W>.run.json): a new Claude Code session, a new Codex
    thread (its id from the thread.started event, saved as soon as Codex reports it), a new Gemini session (its id from
    the init event) or a new Antigravity conversation (its conversation_id from the init event, saved as soon as agy
    reports it). Pleni can show it, and once a Claude run has ended, the owner can open it with
    claude --resume <session_id> in the worktree.
  - -ResultFile and -NewWorktree: only bin\bridge-relay.ps1 passes them, for a start request (W<n>-start.md).
      -ResultFile   a .relay\dispatch\S<time>-<id>.result.json file of this mailbox (any other path is refused). The
                    launcher writes what happened there: ok (true or false), its own words, and the runner's pid and
                    start time. A refusal writes its words too.
      -NewWorktree  first makes the brief's worktree, <worktrees folder>\<TASK-ID>\<repo>, on the new branch
                    claude/<TASK-ID> from the brief's Base commit, out of <projects_dir>\<repo> (git worktree add, which
                    runs that repository's own post-checkout hook, if it has one). It never changes a worktree or a
                    branch that is already there.
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
  .\spawn-worker.ps1 -TaskId T-20260101-01-example-task -Worker W5 -Tool antigravity -Effort medium
  .\spawn-worker.ps1 -TaskId T-20260101-01-example-task -Status
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidatePattern('^T-\d{8}-\d{2}-[a-z0-9-]+$')][string]$TaskId,
    [ValidatePattern('^W\d+$')][string]$Worker,
    [ValidateSet('implementation', 'review')][string]$Type = 'implementation',
    # The AI tool that runs the worker. Codex, Gemini and Antigravity stay off until worker_tools in
    # bin\relay-settings.json lists them.
    [ValidateSet('claude', 'codex', 'gemini', 'antigravity')][string]$Tool = 'claude',
    [ValidateRange(0.05, 25)][double]$MaxBudgetUsd = 3,
    # Default Opus 5.5 with 1M context. Workers run with --setting-sources '', so without this
    # the CLI falls back to its own default model (Sonnet). Override per run with -Model.
    # For Codex, Gemini and Antigravity, this default means the tool's own default model.
    [string]$Model = 'claude-opus-5-5[1m]',
    [ValidateSet('low', 'medium', 'high', 'xhigh', 'max')][string]$Effort = 'xhigh',
    [switch]$Status,
    [switch]$Foreground,
    # Only bin\bridge-relay.ps1 passes these, for a start request (W<n>-start.md).
    [string]$ResultFile,     # where to write what happened: .relay\dispatch\S<time>-<id>.result.json of this mailbox
    [switch]$NewWorktree     # make <worktrees>\<TASK-ID>\<repo> on claude/<TASK-ID> from the brief's Base commit first
)

$ErrorActionPreference = 'Stop'
$Inv       = [Globalization.CultureInfo]::InvariantCulture
$Utf8      = New-Object System.Text.UTF8Encoding($false)
$Bridge    = Split-Path -Parent $PSScriptRoot
$TaskDir   = Join-Path $Bridge "tasks\$TaskId"
$WorkerDir = Join-Path $TaskDir 'workers'
$Tool      = $Tool.ToLowerInvariant()
$ToolName  = @{ claude = 'Claude'; codex = 'Codex'; gemini = 'Gemini'; antigravity = 'Antigravity' }[$Tool]
$ToolArticle = 'a'   # "an Antigravity worker"
if ($Tool -eq 'antigravity') { $ToolArticle = 'an' }
# The risk the owner accepted by turning Antigravity workers on. Every Antigravity run writes the warning in its log.
$AgyRisk = "Google's consumer terms may not allow running Antigravity CLI from other programs. Your Google account could be suspended or closed."
$AgyWarning = $AgyRisk + ' Turn it off by taking antigravity out of worker_tools.'
$ClaudeDefaultModel = 'claude-opus-5-5[1m]'
# Gemini CLI's own fixed folder for admin policies on Windows. While it holds a .toml file, Gemini CLI ignores
# --admin-policy, and with it the relay's policy for the worker.
$GeminiSystemPolicies = 'C:\ProgramData\gemini-cli\policies'
$Notes = New-Object System.Collections.Generic.List[string]   # Codex and Gemini: the launcher's notes for <W>.log

function Write-StartResult([bool]$Ok, [string]$Message, $RunnerPid, [string]$RunnerStart) {
    # For the relay (-ResultFile): what happened, in the launcher's own words. Never throws.
    if (-not $ResultPath) { return }
    try {
        $o = [ordered]@{ ok = $Ok; message = $Message; runner_pid = $RunnerPid; runner_start = $RunnerStart; task = $TaskId; worker = $Worker; tool = $Tool }
        [IO.File]::WriteAllText($ResultPath, (ConvertTo-Json -InputObject $o -Depth 3), $Utf8)
    } catch { }
}

# -ResultFile: only a .relay\dispatch\S<time>-<4 hex>.result.json file of this mailbox. A refused path gets no file.
$ResultPath = ''
if ($ResultFile) {
    $full = [IO.Path]::GetFullPath($ResultFile)
    $want = [IO.Path]::GetFullPath((Join-Path $Bridge '.relay\dispatch'))
    if ((Split-Path -Parent $full) -ne $want -or (Split-Path -Leaf $full) -notmatch '^S\d{8}-\d{6}-[0-9a-f]{4}\.result\.json$') {
        throw "Refusing: -ResultFile must be a .relay\dispatch\S<time>-<id>.result.json file of this mailbox (got $ResultFile). Nothing was started."
    }
    $ResultPath = $full
}

# Any refusal below ends the script, as before; the relay gets its words (the message only, without PowerShell's
# position lines). A trap covers the whole script, wherever it stands; break ends the script with the error, as a
# throw with no trap does. Errors that a try/catch inside the script catches never reach it. When -NewWorktree made
# the worktree before a later refusal, the words say so: the worktree stays, so the next request needs New worktree: no.
trap {
    $trapWords = $_.Exception.Message
    if ($script:WorktreeNote) { $trapWords += $script:WorktreeNote + ' It stays: to ask again, set New worktree to no.' }
    Write-StartResult $false $trapWords $null ''
    break
}

function Write-RunState([string]$Path, [hashtable]$State) {
    # Another program (Pleni, the relay, a test) may be reading run.json just then, so a failed write is tried again.
    $text = ConvertTo-Json -InputObject $State -Depth 4
    for ($i = 1; $i -le 5; $i++) {
        try {
            Set-Content -LiteralPath $Path -Value $text -Encoding UTF8 -ErrorAction Stop
            return
        } catch {
            if ($i -eq 5) { throw }
            Start-Sleep -Milliseconds 200
        }
    }
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
    # Codex (codex exec --json), Gemini (-o stream-json) and Antigravity (--output-format stream-json) write one JSON
    # event per line. Other lines are skipped.
    # Codex: thread.started, turn.completed (usage), turn.failed, item.completed, error.
    # Gemini: init (session_id, model), result (status, stats), error (severity, message).
    # Antigravity names each event in "event", not "type", and keeps its fields under that name: init
    # (conversation_id, init.model), step_update, result (status, error, response, usage).
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
        if ($null -eq $e.type -and $null -ne $e.event) {
            $k = [string]$e.event
            if ($k -eq 'init') {
                if ($e.conversation_id) { $r.session = [string]$e.conversation_id }
                if ($e.init -and $e.init.model) { $r.model = [string]$e.init.model }
            } elseif ($k -eq 'result' -and $e.result) {
                $x = $e.result
                $r.status = [string]$x.status
                $m = $x.error
                if ($m -and -not ($m -is [string])) { $m = $m.message }
                if ($m) { $r.error = [string]$m }
                if ($x.response) { $r.message = [string]$x.response }
                if (-not $r.session -and $x.conversation_id) { $r.session = [string]$x.conversation_id }
                if ($x.usage) {
                    # usage counts the whole conversation; total_tokens is input plus output.
                    $u = $x.usage
                    $total = [int64]$u.total_tokens
                    if ($total -le 0) { $total = [int64]$u.input_tokens + [int64]$u.output_tokens }
                    $r.tokens = [ordered]@{ input = [int64]$u.input_tokens; output = [int64]$u.output_tokens; cached = [int64]$u.cache_read_tokens; total = $total }
                }
            }
            continue
        }
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
    $risk = ''
    if ($Tool -eq 'antigravity') { $risk = " Know this first: $AgyRisk" }
    throw ("Refusing: $ToolName workers are off. worker_tools in $rsFile lists the AI tools that may run workers (now: $on). " +
        "To turn $ToolName workers on, add `"$Tool`" to it.$risk Nothing was started.")
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
    $command = $Name
    if ($Name -eq 'antigravity') {
        # Antigravity CLI's own installer puts agy.exe here on Windows.
        if ($env:LOCALAPPDATA) {
            $agy = Join-Path $env:LOCALAPPDATA 'agy\bin\agy.exe'
            if (Test-Path -LiteralPath $agy -PathType Leaf) { return $agy }
        }
        $command = 'agy'
    }
    foreach ($n in @("$command.exe", "$command.cmd")) {
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

function New-TaskWorktree {
    # -NewWorktree: makes only <worktrees>\<TASK-ID>\<repo>, on the new branch claude/<TASK-ID>, from the brief's Base
    # commit, out of <projects_dir>\<repo>. It never changes a worktree or a branch that is already there.
    $parts = @($Worktree.Substring($WorktreesDir.Length).Split('\') | Where-Object { $_ })
    if ($parts.Count -ne 2 -or $parts[0] -ne $TaskId) { throw "Refusing: a new worktree must be $WorktreesDir$TaskId\<repo folder> (got $Worktree). Nothing was started." }
    $repoName = $parts[1]
    if ($repoName -notmatch '^[A-Za-z0-9._-]{1,100}$' -or $repoName -match '^\.+$') { throw "Refusing: '$repoName' is not a plain repo folder name. Nothing was started." }
    if (Test-Path -LiteralPath $Worktree) { throw "Refusing: $Worktree is already there; New worktree: yes only makes a new one. Set it to no. Nothing was started." }
    if (-not ($rs -and $rs.projects_dir)) { throw "Refusing: a new worktree needs projects_dir in $rsFile (the folder that holds $repoName). Nothing was started." }
    $repo = Join-Path ([IO.Path]::GetFullPath([string]$rs.projects_dir).TrimEnd('\')) $repoName
    if (-not (Test-Path -LiteralPath (Join-Path $repo '.git') -PathType Container)) { throw "Refusing: $repo is not a Git repository folder (it has no .git folder). Nothing was started." }
    $branchLine = Select-String -LiteralPath $Brief -Pattern '^\s*-\s*\*\*Branch:\*\*\s*`?([^\s`]+)' | Select-Object -First 1
    $baseLine = Select-String -LiteralPath $Brief -Pattern '^\s*-\s*\*\*Base commit:\*\*\s*`?([0-9a-fA-F]{7,40})(?![0-9A-Za-z])' | Select-Object -First 1
    $branch = "claude/$TaskId"
    if (-not $branchLine -or $branchLine.Matches[0].Groups[1].Value -ne $branch) { throw "Refusing: for a new worktree the brief's Branch line must be $branch. Nothing was started." }
    if (-not $baseLine) { throw 'Refusing: for a new worktree the brief needs a Base commit line with the commit (7 to 40 hex characters). Nothing was started.' }
    $base = $baseLine.Matches[0].Groups[1].Value
    $git = Get-Command git.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $git) { throw 'Refusing: git.exe was not found, so the new worktree cannot be made. Nothing was started.' }
    $keep = $ErrorActionPreference
    $baseOk = $false
    $branchThere = $false
    $addExit = 0
    $addText = ''
    $branchLeft = $false
    $treeLeft = $false
    $folderLeft = $false
    try {
        $ErrorActionPreference = 'Continue'   # Windows PowerShell 5.1 turns native stderr into errors under Stop
        $null = & $git.Path -C $repo cat-file -e "$base^{commit}" 2>&1
        $baseOk = ($LASTEXITCODE -eq 0)
        $null = & $git.Path -C $repo show-ref --verify --quiet "refs/heads/$branch" 2>&1
        $branchThere = ($LASTEXITCODE -eq 0)
        if ($baseOk -and -not $branchThere) {
            # Native output goes through [string], so an error record becomes plain text.
            $addText = ((& $git.Path -C $repo worktree add -b $branch $Worktree $base 2>&1) | ForEach-Object { [string]$_ }) -join ' '
            $addExit = $LASTEXITCODE
            if ($addExit -ne 0) {
                # git makes the branch first, so it can fail after that: in the checkout (the branch stays) or in
                # the repository's post-checkout hook (the whole worktree stays). The words name what is left;
                # nothing is removed.
                $null = & $git.Path -C $repo show-ref --verify --quiet "refs/heads/$branch" 2>&1
                $branchLeft = ($LASTEXITCODE -eq 0)
                $treeLeft = Test-Path -LiteralPath ([IO.Path]::Combine($Worktree, '.git')) -PathType Leaf   # a worktree's .git is a file
                $folderLeft = Test-Path -LiteralPath $Worktree
            }
        }
    } finally { $ErrorActionPreference = $keep }
    if (-not $baseOk) { throw "Refusing: the Base commit $base from the brief is not in $repo. Nothing was started." }
    if ($branchThere) { throw "Refusing: the branch $branch is already in $repo; a new worktree needs a new branch. Nothing was started." }
    if ($addText.Length -gt 200) { $addText = $addText.Substring(0, 200) }
    if ($addExit -ne 0) {
        # What git left comes before git's own words, so a shortened copy of the message still says it.
        $left = ''
        if ($treeLeft) { $left = " git made the worktree $Worktree on $branch before it failed. It stays: to ask again, set New worktree to no." }
        else {
            if ($branchLeft) { $left += " git made the branch $branch in $repo before it failed." }
            if ($folderLeft) { $left += " The folder $Worktree is there now, but it is not a whole worktree." }
            if ($left) { $left += ' What git left stays, so New worktree: yes is refused until the owner deletes it.' }
        }
        throw "Refusing: git worktree add failed.$left Nothing was started. git said: $addText"
    }
    $script:WorktreeNote = " Made the worktree $Worktree on $branch from $base."
}

# -NewWorktree (a start request with New worktree: yes): make the worktree first. The runner never gets it.
$script:WorktreeNote = ''
if ($NewWorktree) { New-TaskWorktree }
if (-not (Test-Path $Worktree)) { throw "Worktree from brief does not exist: $Worktree" }

$RunFile = Join-Path $WorkerDir "$Worker.run.json"
$LogFile = Join-Path $WorkerDir "$Worker.log"
if (Test-Path $RunFile) {
    $prev = Get-Content $RunFile -Raw | ConvertFrom-Json
    if ($prev.state -eq 'running' -and $prev.pid -and (Get-Process -Id $prev.pid -ErrorAction SilentlyContinue)) {
        throw "$Worker for $TaskId is already running (pid $($prev.pid))."
    }
}

# ---------- Codex, Gemini and Antigravity: checks before anything starts ----------
function Get-ModelError([string]$Name) {
    # A model for -m: not a Claude model, and one word of plain characters.
    if ($Name -match '^(claude|opus|sonnet|haiku|fable)') {
        return "-Model $Name is a Claude model. For $ToolArticle $ToolName worker, leave -Model out to use ${ToolName}'s default model, or name one of ${ToolName}'s models"
    }
    if ($Name -notmatch '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,79}$') { return "-Model $Name has characters the relay does not pass on (use letters, digits and . _ : / - only)" }
    return ''
}

function Get-RunLimit([string]$Name) {
    # worker_runs_per_day in bin\cost-limits.json, for example {"codex": 12, "gemini": 4, "antigravity": 4}. 0 means
    # no limit.
    $limit = 12
    if ($Name -eq 'gemini' -or $Name -eq 'antigravity') { $limit = 4 }
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

function Get-CodexConfigTop {
    # The only three settings that the launcher still takes from Codex's own <CODEX_HOME>\config.toml (CODEX_HOME, else
    # <USERPROFILE>\.codex), now that a Codex worker starts with --ignore-user-config: model, model_reasoning_effort and
    # cli_auth_credentials_store. Read only, from the top-level keys (above the first [table]), and nothing else in the
    # file. Each value is checked; one that fails is left out and its key is named in bad (a key only, never a value).
    # store is only keyring or auto: file is Codex's default.
    $r = @{ model = ''; effort = ''; store = ''; bad = @() }
    $raw = @{}
    try {
        $codexHome = $env:CODEX_HOME
        if (-not $codexHome) {
            if (-not $env:USERPROFILE) { return $r }
            $codexHome = [IO.Path]::Combine($env:USERPROFILE, '.codex')   # not Join-Path: it throws for a drive that is not there
        }
        if (-not [IO.Path]::IsPathRooted($codexHome)) { return $r }
        $f = [IO.Path]::Combine($codexHome, 'config.toml')
        if (-not (Test-Path -LiteralPath $f -PathType Leaf)) { return $r }
        foreach ($line in @(Get-Content -LiteralPath $f -TotalCount 400 -ErrorAction Stop)) {
            if ($line -match '^\s*\[') { break }   # the first table: the top-level keys end here
            if ($line -cmatch '^\s*(model|model_reasoning_effort|cli_auth_credentials_store)\s*=\s*["'']([^"'']*)["'']') {
                if (-not $raw.ContainsKey($Matches[1])) { $raw[$Matches[1]] = $Matches[2] }
            }
        }
    } catch { return $r }
    $m = [string]$raw['model']
    if ($m) {
        $why = Get-ModelError $m
        if ($why) { $r.bad = @($r.bad) + 'model' } else { $r.model = $m }
    }
    $e = ([string]$raw['model_reasoning_effort']).ToLowerInvariant()
    if ($e) {
        if (@('low', 'medium', 'high', 'xhigh') -contains $e) { $r.effort = $e } else { $r.bad = @($r.bad) + 'model_reasoning_effort' }
    }
    $s = [string]$raw['cli_auth_credentials_store']
    if ($s -ceq 'keyring' -or $s -ceq 'auto') { $r.store = $s }
    elseif ($s -and $s -cne 'file') { $r.bad = @($r.bad) + 'cli_auth_credentials_store' }
    return $r
}

function Find-GitTop([string]$Dir) {
    # The folder that holds the .git of the Git repository that <Dir> is in: <Dir> itself or a folder above it, or ''.
    $d = $Dir
    for ($i = 0; $i -lt 40 -and $d; $i++) {
        if (Test-Path -LiteralPath (Join-Path $d '.git')) { return $d }
        $parent = Split-Path -Parent $d
        if (-not $parent -or $parent -eq $d) { break }
        $d = $parent
    }
    return ''
}

function Get-GitLink([string]$Dir) {
    # What tells Git where its own folder is for <Dir>: 'file:<top>|<text>' when the repository's top holds a Git
    # worktree's small .git file, 'folder:<top>' when it holds Git's whole folder, 'none' outside a repository, or
    # 'other'. Save-ToolWork compares it before and after a run.
    $top = Find-GitTop $Dir
    if (-not $top) { return 'none' }
    $p = Join-Path $top '.git'
    $item = Get-Item -LiteralPath $p -Force -ErrorAction SilentlyContinue
    if (-not $item) { return 'other' }
    if ($item.PSIsContainer) { return "folder:$top" }
    if ($item.Length -gt 4096) { return 'other' }
    try { return "file:$top|" + [IO.File]::ReadAllText($p) } catch { return 'other' }
}

function Get-AgyFolders([string]$Start) {
    # The folders whose .agents folder Antigravity CLI reads for a run in <Start>: <Start> and, inside a Git
    # repository, each folder above it up to the repository's top.
    $top = Find-GitTop $Start
    if (-not $top) { return @($Start) }
    $out = New-Object System.Collections.Generic.List[string]
    $d = $Start
    for ($i = 0; $i -lt 40 -and $d; $i++) {
        $out.Add($d)
        if ($d -eq $top) { break }
        $parent = Split-Path -Parent $d
        if (-not $parent -or $parent -eq $d) { break }
        $d = $parent
    }
    return $out.ToArray()
}

$ToolModel = ''      # Codex, Gemini and Antigravity: the value for -m (--model); '' means the tool's own default model
# Antigravity CLI's efforts in a headless run are low, medium and high. xhigh, the usual -Effort, runs as high.
$AgyEffort = $Effort.ToLowerInvariant()
if ($AgyEffort -eq 'xhigh') { $AgyEffort = 'high' }
$AgySandbox = $false
if ($rs -and $rs.antigravity_sandbox -eq $true) { $AgySandbox = $true }
if ($Tool -ne 'claude') {
    if ($Model -and $Model -ne $ClaudeDefaultModel) {
        $why = Get-ModelError $Model
        if ($why) { throw "Refusing: $why. Nothing was started." }
        $ToolModel = $Model
    }
    if ($Tool -eq 'codex' -and $Effort -eq 'max') { throw 'Refusing: Codex has no max effort. Use -Effort xhigh or lower for a Codex worker. Nothing was started.' }
    if ($Tool -eq 'antigravity' -and $Effort -eq 'max') {
        throw 'Refusing: Antigravity CLI has no max effort. Use -Effort high or lower for an Antigravity worker (xhigh runs as high). Nothing was started.'
    }
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
    if ($Tool -eq 'antigravity') {
        # Antigravity CLI loads hooks, MCP servers, plugins and custom agents from an .agents folder (or .agent, _agents,
        # _agent) in the folder it works in and in each folder above it up to the repository's top, and a
        # .gemini\config.json there can send it to one more such folder. Those can run commands without asking. A worker
        # works in the worktree and the workers folder.
        $what = 'hooks (commands Antigravity CLI runs by itself at set moments), MCP servers (helper programs that give it more tools) or plugins (packs of these)'
        foreach ($start in @($Worktree, $WorkerDir)) {
            foreach ($d in @(Get-AgyFolders $start)) {
                $f = Join-Path $d '.gemini\config.json'
                if (Test-Path -LiteralPath $f) {
                    throw ("Refusing: $f is there. Antigravity CLI reads it when it starts, and it can send Antigravity CLI to more $what. " +
                        'Take it out of the branch, or use another tool for this worker. Nothing was started.')
                }
                foreach ($folder in @('.agents', '.agent', '_agents', '_agent')) {
                    foreach ($item in @('hooks.json', 'mcp_config.json', 'plugins.json', 'plugins', 'agents')) {
                        $f = Join-Path (Join-Path $d $folder) $item
                        if (Test-Path -LiteralPath $f) {
                            throw ("Refusing: $f is there. Antigravity CLI reads it when it starts, and it can run commands from it without asking: $what. " +
                                'Take it out of the branch, or use another tool for this worker. Nothing was started.')
                        }
                    }
                }
            }
        }
        # The launcher commits an implementation worker's changes with its own git commands (Save-ToolWork). In a Git
        # worktree, Git's own folder is outside the worktree. A plain copy of a repository keeps it inside, where the
        # worker could change Git's settings, so the launcher does not start a worker there.
        if ($Type -eq 'implementation' -and -not (Get-GitLink $Worktree).StartsWith('file:')) {
            throw ("Refusing: $Worktree is not in a Git worktree (one made with git worktree add). There, Git's own folder would be " +
                'where an Antigravity worker can change it, so the launcher could not commit its changes safely. Use a worktree from git worktree add. Nothing was started.')
        }
    }
}

# Codex: the settings that stay from the owner's config.toml. The effort is the one given with -Effort, else the one in
# config.toml, else the usual default (xhigh).
$EffortGiven = $PSBoundParameters.ContainsKey('Effort')
$CodexCfg = @{ model = ''; effort = ''; store = ''; bad = @() }
$CodexEffort = $Effort
$CodexEffortFromConfig = $false
if ($Tool -eq 'codex') {
    $CodexCfg = Get-CodexConfigTop
    if (-not $EffortGiven -and $CodexCfg.effort) { $CodexEffort = $CodexCfg.effort; $CodexEffortFromConfig = $true }
}
# An older Codex CLI does not know --ignore-user-config or --ignore-rules: clap's words on standard error, exit code 2.
$CodexTooOldPattern = "unexpected argument\W+--ignore-(user-config|rules)\b"
$CodexOptionWords = ('Codex starts with --ignore-user-config and --ignore-rules, so it uses none of the extra folders, MCP servers (add-on tools), ' +
    'hooks or command rules from your own Codex settings. It keeps your model, effort and sign-in store.')
$CodexTooOldWords = 'This Codex CLI is too old for the relay. Update it (npm install -g @openai/codex) to a version from April 2026 or newer.'

function Get-ModelText {
    # The model, in words, for the launch line and the log.
    if ($Tool -eq 'claude') { return "model $Model" }
    if ($ToolModel) { return "model $ToolModel (from -Model)" }
    if ($Tool -eq 'codex') {
        $m = [string]$CodexCfg.model
        if ($m) { return "model $m (Codex's default, from its config.toml)" }
        if (@($CodexCfg.bad) -contains 'model') { return "Codex's own default model (the model in its config.toml cannot be passed on)" }
        return "Codex's own default model (its config.toml names none)"
    }
    if ($Tool -eq 'antigravity') { return "Antigravity CLI's default model" }
    return "Gemini CLI's default model"
}

function Get-EffortText {
    if ($Tool -eq 'gemini') { return 'no effort (Gemini CLI has no effort setting)' }
    if ($Tool -eq 'antigravity') {
        if ($Effort -eq 'xhigh') { return "effort $AgyEffort (Antigravity CLI has low, medium and high, so xhigh runs as high)" }
        return "effort $AgyEffort"
    }
    if ($Tool -eq 'codex') {
        if ($CodexEffortFromConfig) { return "effort $CodexEffort (Codex's default, from its config.toml)" }
        return "effort $CodexEffort"
    }
    return "effort $Effort"
}

# ---------- detach: re-launch this script hidden in foreground mode ----------
if (-not $Foreground) {
    $argList = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"",
        '-TaskId', $TaskId, '-Worker', $Worker, '-Type', $Type, '-MaxBudgetUsd', $MaxBudgetUsd.ToString($Inv), '-Foreground')
    if ($EffortGiven) { $argList += @('-Effort', $Effort) }   # the runner tells "no effort given" from a given one
    if ($Model) { $argList += @('-Model', $Model) }
    if ($Tool -ne 'claude') { $argList += @('-Tool', $Tool) }
    $p = Start-Process -FilePath 'powershell.exe' -ArgumentList $argList -WindowStyle Hidden -PassThru
    # For the relay (-ResultFile): the runner's pid and start time name it until its run.json says more. The runner never
    # gets -ResultFile or -NewWorktree, so only the launcher writes the result.
    $ticks = ''
    try { $ticks = [string]$p.StartTime.ToUniversalTime().Ticks } catch { }
    Write-StartResult $true ("Launched $Worker ($Type, $ToolName) for $TaskId - runner pid $($p.Id)." + $script:WorktreeNote) $p.Id $ticks
    if ($script:WorktreeNote) { Write-Output $script:WorktreeNote.Trim() }
    if ($Tool -eq 'claude') {
        Write-Output "Launched $Worker ($Type) for $TaskId - runner pid $($p.Id), model $Model, effort $Effort. Check: -Status"
    } else {
        Write-Output "Launched $Worker ($Type, $ToolName) for $TaskId - runner pid $($p.Id), $(Get-ModelText), $(Get-EffortText). Check: -Status"
    }
    if ($Tool -eq 'antigravity') { Write-Output "Warning: $AgyWarning" }
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
    if (-not $ToolModel) { $state.model = $CodexCfg.model }
    if (-not $state.model) { $state.model = 'codex default' }
    $state.effort = $CodexEffort
} elseif ($Tool -eq 'gemini') {
    $state.billing = 'gemini-own-login (paid per use)'
    $state.budget_usd = $null          # Gemini CLI reports no cost; worker_runs_per_day limits the runs
    $state.effort = $null
    $state.model = $ToolModel
    if (-not $ToolModel) { $state.model = 'gemini default' }
} elseif ($Tool -eq 'antigravity') {
    $state.session_id = $null          # the conversation id comes from Antigravity CLI's init event
    $state.billing = 'antigravity-own-login'
    $state.budget_usd = $null          # Antigravity CLI reports no cost; worker_runs_per_day limits the runs
    $state.effort = $AgyEffort
    $state.model = $ToolModel
    if (-not $ToolModel) { $state.model = 'antigravity default' }
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
    # ---------- Codex, Gemini and Antigravity ----------
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
        # Poll the output while the run goes, so the session id is saved as soon as the CLI reports it. It counts as
        # saved only once run.json was written: a write that fails (someone is reading the file just then) is tried
        # again on the next round.
        $saved = $false
        while (-not $proc.WaitForExit(1000)) {
            if ($saved) { continue }
            try {
                $ev = Read-ToolEvents $LogFile 65536
                if ($ev.session) {
                    $state.session_id = $ev.session
                    Write-RunState $RunFile $state
                    $saved = $true
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
        } elseif ($Tool -eq 'antigravity') {
            $p += "Your brief and your report are in the task's workers folder $WorkerDir. Do not run git add or git commit: when you finish, the launcher commits your changes. "
        } else {
            $p += "Do not run git add or git commit: Git's own folder is outside your sandbox. When you finish, the launcher commits your changes. "
        }
        if ($Tool -eq 'antigravity') {
            $p += 'If Antigravity CLI denies you a file or a command, do not look for another way: say so in your report. '
        }
        $p += "Never push, merge or change branches. When finished, write your report to $report and stop."
        return $p
    }

    if ($Tool -eq 'antigravity') { Add-Note $AgyWarning }
    Add-Note (Get-ModelText)
    Add-Note (Get-EffortText)
    if ($Tool -eq 'codex') {
        Add-Note $CodexOptionWords
        foreach ($k in @($CodexCfg.bad)) { Add-Note "Codex's config.toml has a '$k' that the relay cannot pass on, so it is left out. Codex uses its own default for it." }
    }
    Add-Note "$ToolName reports no cost in dollars, so -MaxBudgetUsd does not apply. worker_runs_per_day in bin\cost-limits.json limits the runs."

    # The worktree's .git as it is before the run. Save-ToolWork's git commands trust it only if the run left it alone.
    $gitLinkBefore = Get-GitLink $Worktree

    function Save-ToolWork {
        # A Codex worker cannot write Git's own folder, and an Antigravity worker runs no command unless the owner's own
        # Antigravity rules allow it. So the launcher commits their changes, outside the tool. A worker can still change
        # files, so the launcher's git commands trust nothing it could have changed: they run no Git hooks and no file
        # monitor program, and they do not run at all when the run changed what tells Git where its own folder is.
        $gitLink = Get-GitLink $Worktree
        if ($gitLink -cne $gitLinkBefore -or $gitLink -eq 'other') {
            Add-Note ("The $ToolName worker changed the worktree's .git during its run, so the launcher ran no git command there and " +
                'committed nothing. Look at the worktree before you use it.')
            return
        }
        $git = Get-Command git.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if (-not $git) { Add-Note "Git was not found, so the $ToolName worker's changes stay uncommitted in the worktree."; return }
        # A hooks folder that does not exist (a new name each time), so Git finds no hooks; and no file monitor program.
        $noHooks = Join-Path ([IO.Path]::GetTempPath()) ('relay-no-hooks-' + [guid]::NewGuid().ToString('N'))
        $safe = @('-c', "core.hooksPath=$noHooks", '-c', 'core.fsmonitor=false')
        $previous = $ErrorActionPreference
        try {
            $ErrorActionPreference = 'Continue'
            $changes = ((& $git.Path -C $Worktree @safe status --porcelain 2>$null) | Out-String).Trim()
            if ($LASTEXITCODE -ne 0) { Add-Note "git status failed in the worktree, so the $ToolName worker's changes were not committed."; return }
            if (-not $changes) { Add-Note "The $ToolName worker changed no files, so there was nothing to commit."; return }
            $null = & $git.Path -C $Worktree @safe add -A 2>$null
            if ($LASTEXITCODE -ne 0) { Add-Note "git add failed, so the $ToolName worker's changes stay uncommitted in the worktree."; return }
            $message = "$TaskId ${Worker}: changes from the $ToolName worker run"
            $said = ((& $git.Path -C $Worktree @safe commit -q --no-verify -m $message 2>&1) | ForEach-Object { [string]$_ }) -join ' '
            if ($LASTEXITCODE -ne 0) { Add-Note "git commit failed, so the $ToolName worker's changes stay uncommitted in the worktree: $said"; return }
            $sha = ((& $git.Path -C $Worktree @safe rev-parse HEAD 2>$null) | Out-String).Trim()
            $state.commit = $sha
            Add-Note "Committed the $ToolName worker's changes as $sha."
        } finally { $ErrorActionPreference = $previous }
    }

    if ($Tool -eq 'codex') {
        $cwd = $Worktree
        # The network stays off. Git's own folder is not writable, so a worker can never add a Git hook or change Git's
        # settings; the launcher commits its changes (Save-ToolWork). --ignore-user-config: Codex does not load
        # <CODEX_HOME>\config.toml (the sign-in still uses CODEX_HOME), so none of its extra writable folders, MCP servers
        # (add-on tools, which run outside the sandbox) or hooks apply. --ignore-rules: Codex does not load the owner's
        # command rules, which can let a command run outside the sandbox. Codex's system settings still load, so the two
        # -c values still hold, and writable_roots=[] leaves the run only its own folder and the --add-dir folder, as for a
        # Codex coordinator's turn. Codex no longer reads the model, the effort and the sign-in store from config.toml, so
        # the launcher passes them (Get-CodexConfigTop): -Model, else the config.toml model; the effort chosen above; the
        # store only when it is keyring or auto.
        $cliArgs = @('exec', '--json', '--skip-git-repo-check', '--ignore-user-config', '--ignore-rules', '--sandbox', 'workspace-write',
            '-c', 'sandbox_workspace_write.network_access=false', '-c', 'sandbox_workspace_write.writable_roots=[]')
        if ($Type -eq 'implementation') {
            $cliArgs += @('--add-dir', $WorkerDir)
        } else {
            $cwd = $WorkerDir   # a reviewer can write only in the workers folder, its report's folder
        }
        $cliModel = $ToolModel
        if (-not $cliModel) { $cliModel = [string]$CodexCfg.model }
        if ($cliModel) { $cliArgs += @('-m', $cliModel) }
        $cliArgs += @('-c', "model_reasoning_effort=$($CodexEffort.ToLowerInvariant())")
        if ($CodexCfg.store) { $cliArgs += @('-c', "cli_auth_credentials_store=$($CodexCfg.store)") }
        $cliArgs += '-'
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
                if ($Type -eq 'implementation') { Save-ToolWork }
            } else {
                $state.state = 'failed'
                $why = $ev.failed
                if (-not $why) { $why = $ev.error }
                $errText = ''
                try { $errText = Read-SharedText $errFile 1048576 } catch { }
                if ($errText -match $CodexTooOldPattern) { $state.note = $CodexTooOldWords }
                elseif ($why) { $state.note = "Codex stopped: $why (exit $exit)." }
                else { $state.note = "Codex ended without finishing its turn (exit $exit)." }
                Add-Note $state.note
            }
        }
    } elseif ($Tool -eq 'antigravity') {
        function Get-ShortText([string]$Text) {
            # One line of at most 300 characters, for run.json and the log.
            $t = ([string]$Text -replace '\s+', ' ').Trim()
            if ($t.Length -gt 300) { $t = $t.Substring(0, 300) + '...' }
            return $t
        }

        function Get-AgyErrorText([string]$ErrText) {
            # The plain message in Antigravity CLI's 'AGY_ERROR: {...}' line on stderr, or ''. Its fields are not
            # written down, so: message, else error, else status, else the whole line.
            foreach ($line in ($ErrText -split "`r?`n")) {
                $i = $line.IndexOf('AGY_ERROR:')
                if ($i -lt 0) { continue }
                $raw = $line.Substring($i + 10).Trim()
                $o = $null
                try { $o = ConvertFrom-Json -InputObject $raw } catch { $o = $null }
                if ($null -ne $o) {
                    foreach ($k in @('message', 'error', 'status')) {
                        $v = $o.$k
                        if ($null -ne $v -and -not ($v -is [string])) { $v = $v.message }
                        if ($v -is [string] -and $v.Trim()) { return (Get-ShortText $v) }
                    }
                }
                return (Get-ShortText $raw)
            }
            return ''
        }

        function Get-AgyStderrText([string]$ErrText) {
            # A reason from Antigravity CLI's stderr, for a failure whose result gave none: the AGY_ERROR message, else
            # the last line that starts with Error, fatal or panic (without its 'Error:'), else the last line that is
            # not a warning. Or ''.
            $why = Get-AgyErrorText $ErrText
            if ($why) { return $why }
            $lines = @(([string]$ErrText -split "`r?`n") | ForEach-Object { $_.Trim() } | Where-Object { $_ })
            for ($i = $lines.Count - 1; $i -ge 0; $i--) {
                if ($lines[$i] -match '(?i)^(error|fatal|panic)\b') { return (Get-ShortText ($lines[$i] -replace '(?i)^error:\s*', '')) }
            }
            for ($i = $lines.Count - 1; $i -ge 0; $i--) {
                if ($lines[$i] -notmatch '(?i)^warning\b') { return (Get-ShortText $lines[$i]) }
            }
            return ''
        }

        function Get-AgyFailure([int]$Code, $Ev, [string]$ErrText) {
            # Why a run did not finish, in plain words: a short word for the state, and a sentence. Two empty strings
            # when it finished. Antigravity CLI exits 0 even when it denied a tool or ran out of time, so the result's
            # status decides. Exit 1 is its usual error code, so only its known input errors count as bad input.
            if ($Code -eq 0 -and $Ev.status -eq 'SUCCESS') { return @('', '') }
            $text = Get-ShortText ([string]$Ev.error)
            if ($ErrText -match '(?i)authentication required' -or $text -match '(?i)authentication required') {
                return @('not signed in', 'Antigravity CLI is not signed in (it said: authentication required). Run agy once in a window and sign in. Then start the worker again.')
            }
            if ($Code -eq 3) {
                $why = Get-AgyErrorText $ErrText
                if (-not $why) { $why = $text }
                if ($why) { return @('service error', "The model or Antigravity's service failed (exit 3): $why") }
                return @('service error', "The model or Antigravity's service failed (exit 3).")
            }
            if (-not $text) { $text = Get-AgyStderrText $ErrText }
            $said = ''
            if ($text) {
                $said = " It said: $text"
                if ($text -notmatch '[.!?]$') { $said += '.' }
            }
            if ($Code -eq 1) {
                if ($text -match '(?i)invalid model selection|missing the event field|invalid JSON line|unsupported content') {
                    return @('bad input', "Antigravity CLI said the relay's input was wrong (exit 1).$said")
                }
                return @('', "Antigravity CLI stopped with an error (exit 1).$said")
            }
            if ($Code -eq 2) {
                return @('wrong flag', ("Antigravity CLI did not know a flag or a command that the relay gave it (exit 2). " +
                    "The relay needs Antigravity CLI 1.4.12 or newer.$said"))
            }
            if ($Code -eq 0) {
                $s = [string]$Ev.status
                if (-not $s) { return @('', "Antigravity CLI did not finish the work: it ended without a result.$said") }
                return @('', "Antigravity CLI did not finish the work: it ended with status $s.$said")
            }
            return @('', "Antigravity CLI stopped with exit code $Code.$said")
        }

        $cwd = $Worktree
        # accept-edits: file edits in the worker's folders go through without asking. Anything else that needs the
        # owner's approval (commands, other folders, the web, MCP tools) is denied in a run with no window, unless a
        # rule in the owner's own Antigravity settings allows it. The relay never changes those settings.
        $cliArgs = @('--input-format', 'stream-json', '--output-format', 'stream-json', '--mode', 'accept-edits')
        if ($Type -eq 'implementation') {
            $cliArgs += @('--add-dir', $WorkerDir)
        } else {
            $cwd = $WorkerDir   # a reviewer's only folder is the workers folder, so it can change only that folder
        }
        if ($ToolModel) { $cliArgs += @('--model', $ToolModel) }
        $cliArgs += @('--effort', $AgyEffort)
        if ($AgySandbox) {
            $cliArgs += '--sandbox'
            Add-Note ("antigravity_sandbox is on, so the relay asked Antigravity CLI to run the worker's commands in its terminal sandbox (--sandbox), " +
                'away from the network (except sites your read_url rules allow) and from private folders. On a Windows without the sandbox ' +
                '(Windows 10, or Windows 11 before 24H2 with the August 2026 update) this does nothing.')
        }
        # The prompt as one stream-json line on stdin, never on the command line (with stream-json input, Antigravity
        # CLI drops a -p prompt). The file ends after that line, which closes stdin, so the run ends after one turn.
        $userEvent = [ordered]@{ event = 'user'; message = [ordered]@{ content = (Get-ToolPrompt) } }
        $stdinLine = (ConvertTo-Json -InputObject $userEvent -Depth 4 -Compress) + "`n"
        $noCheck = { }
        $exit = Invoke-ToolRun $cliArgs $cwd $stdinLine @{} $noCheck

        if ($exit -eq -1) {
            $state.state = 'failed'   # refused: nothing started, and <W>.log is an older run's
        } else {
            $ev = Read-ToolEvents $LogFile 0
            if ($ev.session) { $state.session_id = $ev.session } else { Add-Note 'Antigravity CLI reported no conversation id, so run.json has no session_id.' }
            if ($ev.model) { $state.model = $ev.model }
            $state.tokens = $ev.tokens
            $errText = ''
            try { $errText = Read-SharedText $errFile 1048576 } catch { }
            $x = @(Get-AgyFailure $exit $ev $errText)
            if (-not $x[1]) {
                $state.state = 'finished'
                if ($Type -eq 'implementation') { Save-ToolWork }
            } else {
                $state.state = 'failed'
                if ($x[0]) { $state.state = "failed ($($x[0]))" }
                $state.note = $x[1]
                Add-Note $x[1]
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
