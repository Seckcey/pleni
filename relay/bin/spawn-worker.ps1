<#
.SYNOPSIS
  Claude coordinator tooling: launch a Claude Code worker session using the existing Claude Code subscription login.

.DESCRIPTION
  - Runs `claude -p` with the saved claude.ai subscription login, never --bare or an injected API key.
  - Funding overrides are removed only in the runner process and restored after the child exits. No API fallback.
  - The worker's working directory is read from its brief (line "- **Worktree ...:** <path>"). It must be inside the
    worktrees folder from bin\relay-settings.json: worktrees_dir, or <projects_dir>\_worktrees\claude.
  - Default: detaches; a hidden runner writes, in tasks\<TASK>\workers\:
      <W>.log       claude JSON result (or error text)
      <W>.run.json  state / pid / exit code / cost / session_id
  - Each run is a saved Claude Code session with a new id (session_id in <W>.run.json), so Pleni can show it
    and, once the run has ended, open it with claude --resume <session_id> in the worktree.
      runs.md       one ledger line per run

.EXAMPLE
  .\spawn-worker.ps1 -TaskId T-20260101-01-example-task -Worker W1
  .\spawn-worker.ps1 -TaskId T-20260101-01-example-task -Worker W2 -Type review -MaxBudgetUsd 1
  .\spawn-worker.ps1 -TaskId T-20260101-01-example-task -Status
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidatePattern('^T-\d{8}-\d{2}-[a-z0-9-]+$')][string]$TaskId,
    [ValidatePattern('^W\d+$')][string]$Worker,
    [ValidateSet('implementation', 'review')][string]$Type = 'implementation',
    [ValidateRange(0.05, 25)][double]$MaxBudgetUsd = 3,
    # Default Opus 5.5 with 1M context. Workers run with --setting-sources '', so without this
    # the CLI falls back to its own default model (Sonnet). Override per run with -Model.
    [string]$Model = 'claude-opus-5-5[1m]',
    [ValidateSet('low', 'medium', 'high', 'xhigh', 'max')][string]$Effort = 'xhigh',
    [switch]$Status,
    [switch]$Foreground
)

$ErrorActionPreference = 'Stop'
$Inv       = [Globalization.CultureInfo]::InvariantCulture
$Bridge    = Split-Path -Parent $PSScriptRoot
$TaskDir   = Join-Path $Bridge "tasks\$TaskId"
$WorkerDir = Join-Path $TaskDir 'workers'
$ClaudeExe = Join-Path $env:APPDATA 'npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe'

function Write-RunState([string]$Path, [hashtable]$State) {
    ($State | ConvertTo-Json -Depth 4) | Set-Content -LiteralPath $Path -Encoding UTF8
}

# ---------- status ----------
if ($Status) {
    if (-not (Test-Path $WorkerDir)) { throw "No workers folder for $TaskId" }
    Get-ChildItem $WorkerDir -Filter '*.run.json' | ForEach-Object {
        $s = Get-Content $_.FullName -Raw | ConvertFrom-Json
        $alive = $false
        if ($s.state -eq 'running' -and $s.pid) { $alive = [bool](Get-Process -Id $s.pid -ErrorAction SilentlyContinue) }
        [pscustomobject]@{ Worker = $s.worker; Type = $s.type; State = $s.state; Alive = $alive; Started = $s.started
            Finished = $s.finished; Exit = $s.exit_code; CostUsd = $s.cost_usd; Turns = $s.num_turns }
    } | Format-Table -AutoSize
    return
}

if (-not $Worker) { throw 'Specify -Worker (e.g. W1) or -Status.' }

# ---------- preflight ----------
$Brief = Join-Path $WorkerDir "$Worker-brief.md"
if (-not (Test-Path $Brief))     { throw "Brief not found: $Brief" }
if (-not (Test-Path $ClaudeExe)) { throw "claude.exe not found at $ClaudeExe" }

$wtLine = Select-String -LiteralPath $Brief -Pattern '^\s*-\s*\*\*Worktree[^:]*:\*\*\s*(\S+)' | Select-Object -First 1
if (-not $wtLine) { throw "Brief has no '- **Worktree ...:** <path>' line: $Brief" }
$Worktree = $wtLine.Matches[0].Groups[1].Value.Trim('`')

# Local settings: bin\relay-settings.json. Workers run only inside the worktrees folder.
$rsFile = Join-Path $PSScriptRoot 'relay-settings.json'
$WorktreesDir = ''
if (Test-Path -LiteralPath $rsFile -PathType Leaf) {
    try { $rs = Get-Content -LiteralPath $rsFile -Raw | ConvertFrom-Json } catch { throw "Could not read ${rsFile}: $($_.Exception.Message)" }
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

# ---------- detach: re-launch this script hidden in foreground mode ----------
if (-not $Foreground) {
    $argList = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"",
        '-TaskId', $TaskId, '-Worker', $Worker, '-Type', $Type, '-MaxBudgetUsd', $MaxBudgetUsd.ToString($Inv), '-Effort', $Effort, '-Foreground')
    if ($Model) { $argList += @('-Model', $Model) }
    $p = Start-Process -FilePath 'powershell.exe' -ArgumentList $argList -WindowStyle Hidden -PassThru
    Write-Output "Launched $Worker ($Type) for $TaskId - runner pid $($p.Id), model $Model, effort $Effort. Check: -Status"
    return
}

# ---------- foreground runner ----------
$state = @{ task = $TaskId; worker = $Worker; type = $Type; state = 'running'; pid = $PID; worktree = $Worktree
    started = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss'); finished = $null; exit_code = $null; cost_usd = $null
    num_turns = $null; budget_usd = $MaxBudgetUsd; effort = $Effort; model = $Model; billing = 'claude-code-subscription'
    session_id = [guid]::NewGuid().ToString() }
Write-RunState $RunFile $state

$report = Join-Path $WorkerDir "$Worker-report.md"
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
$clFile = Join-Path $PSScriptRoot 'cost-limits.json'
if (Test-Path -LiteralPath $clFile) {
    try { $cl = Get-Content -LiteralPath $clFile -Raw | ConvertFrom-Json; if ($null -ne $cl.enabled) { $costLimits = [bool]$cl.enabled } } catch { }
}
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

$errFile = "$LogFile.err"
$stdin = Join-Path $env:TEMP "claude-worker-$TaskId-$Worker.stdin"
Set-Content -LiteralPath $stdin -Value '' -NoNewline
$exit = $null
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
        $authRaw = ((& $ClaudeExe auth status 2>$null) | Out-String)
        $authExitCode = $LASTEXITCODE
    } finally { $ErrorActionPreference = $authErrorActionPreference }
    $auth = $authRaw | ConvertFrom-Json
    if ($authExitCode -ne 0 -or -not $auth.loggedIn -or $auth.authMethod -ne 'claude.ai' -or -not $auth.subscriptionType) {
        throw 'Claude Code subscription login is unavailable; run claude auth login and select your Claude subscription (no API fallback)'
    }
    $proc = Start-Process -FilePath $ClaudeExe -ArgumentList $argString -WorkingDirectory $Worktree -NoNewWindow -Wait -PassThru `
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
        if ($r.is_error -or ($r.subtype -and $r.subtype -ne 'success')) { $state.state = "failed ($($r.subtype))" }
    }
} catch { }
Write-RunState $RunFile $state

$ledger = Join-Path $WorkerDir 'runs.md'
if (-not (Test-Path $ledger)) {
    "| Started | Finished | Worker | Type | State | Exit | Cost USD | Turns | Budget | Models |`n|---|---|---|---|---|---|---|---|---|---|" |
        Set-Content -LiteralPath $ledger -Encoding UTF8
}
"| $($state.started) | $($state.finished) | $Worker | $Type | $($state.state) | $exit | $($state.cost_usd) | $($state.num_turns) | $($state.budget_usd) | $($state.models) |" |
    Add-Content -LiteralPath $ledger -Encoding UTF8
