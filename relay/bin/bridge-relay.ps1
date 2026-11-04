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
  HQ (off unless bin\relay-settings.json has "role": "hq"): HQ is a mailbox whose settings also list project mailboxes
    ("projects": [{ id, name, mailbox }]). Each project keeps its own relay, coordinator, caps, PAUSE and halts. The HQ
    relay alone wakes the ONE orchestrator (HQ's enrolled Codex thread) for new items in HQ and in every project, up to
    10 in one wake. A project's item waits while that project's coordinator turn runs (its .relay\state.json, read
    only). HQ stops its Codex wakes when a project's .relay\codex.json or agents.json names the orchestrator's thread.
    Owner commands, HQ only: -NewProject, -UpdateProjects, -StartAll, -StopAll.
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
       accepts -AllowCheck. Refused: '*', empty, git/claude/codex/gemini/agy/npm/npx/rm/del, pwsh, cmd, powershell without
       -File <script>, node without a script path or with -e/-p.)
  .\bridge-relay.ps1 -ShowCoordinatorArgs   (read-only: prints the coordinator's allowed/denied tools and rules as JSON)
  .\bridge-relay.ps1 -EnrollCodex -ThreadId 01234567-89ab-4def-8123-456789abcdef   (optional: wake that Codex thread)
  .\bridge-relay.ps1 -EnrollCodex -ThreadName 'Planner'   (or follow a name: a newer thread named Planner takes over)
  .\bridge-relay.ps1 -UnenrollCodex          (turn the Codex wake off again)
  .\bridge-relay.ps1 -EnrollAgent -AgentName 'Sergeant Lark'   (wake that agent's Codex thread when mail waits for it)
  .\bridge-relay.ps1 -UnenrollAgent -AgentName 'Sergeant Lark' (stop waking it for its mail)
  .\bridge-relay.ps1 -Once
  .\bridge-relay.ps1 -Start        (foreground; stop with -Stop from another window, or Ctrl+C)
  .\bridge-relay.ps1 -Stop
  .\bridge-relay.ps1 -NewProject -ProjectId notes -ProjectName 'Notes'   (HQ only: make projects\notes and list it)
  .\bridge-relay.ps1 -UpdateProjects   (HQ only: copy HQ's scripts into each project whose relay does not run)
  .\bridge-relay.ps1 -StartAll         (HQ only: a new window for each project's relay, then HQ's own loop here)
  .\bridge-relay.ps1 -StopAll          (HQ only: ask every relay to stop, HQ's too)
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
    [switch]$NewProject,    # HQ only: make a project mailbox and add it to HQ's projects list
    [switch]$UpdateProjects, # HQ only: copy HQ's scripts into each project
    [switch]$StartAll,      # HQ only: start each project's relay in a new window, then HQ's own loop
    [switch]$StopAll,       # HQ only: ask every relay to stop, HQ's too
    [string]$ProjectId,     # -NewProject: 1-40 small letters, digits or hyphens
    [string]$ProjectName,   # -NewProject: the project's name
    [string]$ProjectFolder, # -NewProject: the new mailbox folder (default <HQ>\projects\<id>)
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
    [string[]]$AllowCheck,
    [string]$Tool,           # -Enroll: claude (default), codex or gemini; checked by hand so the refusal is plain words
    [string]$GeminiExe,      # default: gemini_exe in bin\relay-settings.json, else gemini.cmd or gemini.exe on PATH
    [string]$GeminiCliHome,  # default: $env:GEMINI_CLI_HOME, else the user's home (where Gemini CLI keeps .gemini)
    [ValidateRange(0, 500)][int]$MaxWorkerStartsPerDay = 12 # start requests a day; 0 = unlimited
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
if ($NewProject) { $modes += 'NewProject' }
if ($UpdateProjects) { $modes += 'UpdateProjects' }
if ($StartAll) { $modes += 'StartAll' }
if ($StopAll) { $modes += 'StopAll' }
if ($modes.Count -gt 1) { Fail ('Pick one mode, got: ' + ($modes -join ', ')) 64 }
if ($modes.Count -eq 0) { $modes = @('Status') }
$Mode = $modes[0]
if ($Effort -and @('low', 'medium', 'high', 'xhigh', 'max') -notcontains $Effort) { Fail "-Effort must be low, medium, high, xhigh or max (got '$Effort')" 64 }
# -Tool: the coordinator's AI tool, checked by hand (a ValidateSet would print PowerShell's own error for an unknown word).
$AgyCoordinatorWords = "A coordinator in Antigravity CLI is not possible yet. Google's consumer terms may not allow other programs to run it, and it has no rules file for one turn. Use claude, codex or gemini. Antigravity CLI can still run workers."
$GeminiEnrollWords = 'A Gemini CLI coordinator is enrolled by its session id: give -SessionId <id> (Gemini CLI shows it with /stats), and -CoordinatorCwd <folder> if needed.'
$EnrollTool = 'claude'
if ($PSBoundParameters.ContainsKey('Tool')) {
    if ($Mode -ne 'Enroll') { Fail '-Tool is accepted only with -Enroll.' 64 }
    $wantTool = ([string]$Tool).Trim().ToLowerInvariant()
    if ($wantTool -eq 'antigravity') { Fail $AgyCoordinatorWords 64 }
    if (@('claude', 'codex', 'gemini') -notcontains $wantTool) { Fail "-Tool must be claude, codex or gemini (got '$Tool')." 64 }
    $EnrollTool = $wantTool
}
$codexEnroll = ($Mode -eq 'EnrollCodex' -or ($Mode -eq 'Enroll' -and $EnrollTool -eq 'codex'))
if (($ThreadId -or $CodexCwd -or $ThreadName) -and -not $codexEnroll) {
    if ($Mode -eq 'Enroll' -and $EnrollTool -eq 'gemini') { Fail $GeminiEnrollWords 64 }
    Fail '-ThreadId, -ThreadName and -CodexCwd are accepted only with -EnrollCodex or -Enroll -Tool codex.' 64
}
if ($SessionName -and $Mode -ne 'Enroll') { Fail '-SessionName is accepted only with -Enroll.' 64 }
if ($SessionId -and $SessionName) { Fail 'Give -SessionId or -SessionName, not both.' 64 }
if ($ThreadId -and $ThreadName) { Fail 'Give -ThreadId or -ThreadName, not both.' 64 }
if ($Mode -eq 'Enroll' -and $EnrollTool -eq 'codex') {
    if ($SessionId -or $SessionName -or $CoordinatorCwd) { Fail 'A Codex coordinator is a thread: give -ThreadName <name> or -ThreadId <id>, and -CodexCwd <folder> if needed. -SessionId, -SessionName and -CoordinatorCwd are for Claude Code and Gemini CLI.' 64 }
    if (-not $ThreadId -and -not $ThreadName) { Fail '-Enroll -Tool codex needs -ThreadName <name> or -ThreadId <id>.' 64 }
    if ($Effort -eq 'max') { Fail 'Codex has no max effort. Use low, medium, high or xhigh.' 64 }
}
if ($Mode -eq 'Enroll' -and $EnrollTool -eq 'gemini') {
    if ($SessionName) { Fail $GeminiEnrollWords 64 }
    if ($Effort) { Fail 'Gemini CLI has no effort setting. Leave -Effort out.' 64 }
}
if ($AgentName -and @('EnrollAgent', 'UnenrollAgent') -notcontains $Mode) { Fail '-AgentName is accepted only with -EnrollAgent or -UnenrollAgent.' 64 }
if (@('EnrollAgent', 'UnenrollAgent') -contains $Mode -and -not $AgentName) { Fail "-$Mode needs -AgentName <the agent's name>." 64 }
if (($ProjectId -or $ProjectName -or $ProjectFolder) -and $Mode -ne 'NewProject') { Fail '-ProjectId, -ProjectName and -ProjectFolder are accepted only with -NewProject.' 64 }
if ($Mode -eq 'NewProject' -and (-not $ProjectId -or -not $ProjectName)) {
    Fail '-NewProject needs -ProjectId <id> and -ProjectName <name>, and -ProjectFolder <folder> for a folder other than projects\<id> in HQ.' 64
}

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
$script:GeminiTurns = 30   # gemini_max_session_turns: the turn limit of each Gemini CLI coordinator turn (0 = no limit)
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
        # 0 to 500; more counts as 500 (the parameter's own range check would refuse it). A number below 0 is a mistake,
        # not "no limit" (that is 0): the limit stays 12, with a warning, as a bad value keeps the other limits too.
        if (-not $PSBoundParameters.ContainsKey('MaxWorkerStartsPerDay') -and $null -ne $cl.relay_max_worker_starts_per_day) {
            $wsValue = [int]$cl.relay_max_worker_starts_per_day
            if ($wsValue -ge 0) { $MaxWorkerStartsPerDay = [int][Math]::Min(500, $wsValue) }
            else { Write-Host "WARNING: relay_max_worker_starts_per_day in $clFile must be 0 or more (0 means no limit); using $MaxWorkerStartsPerDay" }
        }
        if ($null -ne $cl.gemini_max_session_turns) { try { $gtValue = [int]$cl.gemini_max_session_turns; if ($gtValue -ge 0) { $script:GeminiTurns = $gtValue } } catch { } }
    } catch { Write-Host "WARNING: could not read $clFile; cost limits stay ON" }
}

# Local settings: <MailboxRoot>\bin\relay-settings.json. projects_dir is the folder that holds the application
# repositories (the coordinator may read it; -ProjectsDir wins). owner_name is the person the coordinator's notes
# ask for help; without it they ask "the owner" and use the tag NEEDS-OWNER.
$OwnerName = 'the owner'
$OwnerTag = 'NEEDS-OWNER'
$CodexArgsRaw = @()   # codex_exec_args: extra codex exec options for the Codex wake (checked below)
$HqRole = $false      # "role": "hq": this mailbox is HQ, and "projects" lists its project mailboxes (checked below)
$HqProjectsRaw = @()
$HqDirSetting = ''    # "hq_dir" in a project mailbox: its HQ folder (-NewProject writes it; -Status shows it)
$StartRequestsSetting = $null    # "start_requests": a real true or false wins (judged with -is [bool]); else the coordinator's tool decides
$WorktreesSetting = ''           # "worktrees_dir", read the way bin\spawn-worker.ps1 reads it
$WorkerToolsSetting = @('claude') # "worker_tools", read the way bin\spawn-worker.ps1 reads it
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
        if (([string]$rs.role).Trim() -eq 'hq') { $HqRole = $true }
        if ($null -ne $rs.projects) { $HqProjectsRaw = @($rs.projects) }
        if ($rs.hq_dir) { $HqDirSetting = ([string]$rs.hq_dir).Trim() }
        if (-not $GeminiExe -and $rs.gemini_exe) { $GeminiExe = ([string]$rs.gemini_exe).Trim() }
        if ($null -ne $rs.start_requests) { $StartRequestsSetting = $rs.start_requests }
        if ($rs.worktrees_dir) { $WorktreesSetting = ([string]$rs.worktrees_dir).Trim() }
        if ($null -ne $rs.worker_tools) { $WorkerToolsSetting = @(@($rs.worker_tools) | ForEach-Object { ([string]$_).Trim().ToLowerInvariant() }) }
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
    if ($p -match '^(git|claude|codex|gemini|agy|npm|npx|rm|del)') { return "it starts with '$($Matches[1])', which is never granted to the coordinator" }
    $t = @($p -split '\s+')
    $exe = $t[0]
    if ($p -match '^"([^"]*)"') { $exe = $Matches[1] } elseif ($p -match "^'([^']*)'") { $exe = $Matches[1] }
    $leaf = (($exe -replace '^.*[\\/]', '') -replace '\.(exe|cmd|bat|com|ps1)$', '').ToLowerInvariant()
    if (@('git', 'claude', 'codex', 'gemini', 'agy', 'npm', 'npx', 'rm', 'del') -contains $leaf) { return "it runs '$leaf', which is never granted to the coordinator" }
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

function Get-GeminiCheckError([string]$Prefix) {
    # One more rule for a Gemini CLI coordinator: node can load code from its options (--import, -r), so no node checks.
    $p = ([string]$Prefix).Trim()
    $exe = @($p -split '\s+')[0]
    if ($p -match '^"([^"]*)"') { $exe = $Matches[1] } elseif ($p -match "^'([^']*)'") { $exe = $Matches[1] }
    $leaf = (($exe -replace '^.*[\\/]', '') -replace '\.(exe|cmd|bat|com)$', '').ToLowerInvariant()
    if ($leaf -eq 'node') { return 'node can load code from its options, so a Gemini coordinator may not run it. Enroll powershell -NoProfile -File <script> instead.' }
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
    if ($EnrollTool -eq 'codex') { Fail '-AllowCheck is not used for a Codex coordinator: its turn runs in Codex''s sandbox, which allows commands by folder, not by name. Nothing was saved.' 64 }
    if ($EnrollTool -eq 'gemini') {
        foreach ($gcEntry in $CheckList) {
            $gcWhy = Get-GeminiCheckError $gcEntry
            if ($gcWhy) { Fail "-AllowCheck '$gcEntry' refused: $gcWhy Nothing was saved." 64 }
        }
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
# A Gemini CLI coordinator. $env:USERPROFILE is only read here, never assigned. A home that is not a folder path
# Windows can use (a quote in GEMINI_CLI_HOME, say) stops no command here, so a mailbox that never uses Gemini CLI
# works as before: $GeminiHomeDir stays '' and $GeminiHomeError says why, for the Gemini CLI checks.
$GeminiHomeDir = ''   # where Gemini CLI keeps .gemini: -GeminiCliHome, else GEMINI_CLI_HOME, else the user's home
$GeminiHomeError = ''
try {
    if ($GeminiCliHome) { $GeminiHomeDir = [IO.Path]::GetFullPath($GeminiCliHome).TrimEnd('\') }
    elseif ($env:GEMINI_CLI_HOME) { $GeminiHomeDir = [IO.Path]::GetFullPath($env:GEMINI_CLI_HOME).TrimEnd('\') }
} catch {
    $GeminiHomeError = "the Gemini CLI home '$(if ($GeminiCliHome) { $GeminiCliHome } else { $env:GEMINI_CLI_HOME })' (-GeminiCliHome, else GEMINI_CLI_HOME) is not a folder path Windows can use"
}
$GeminiDataDir = Join-Path $(if ($GeminiHomeDir) { $GeminiHomeDir } else { $env:USERPROFILE }) '.gemini'
$GeminiPolicyFile   = Join-Path $RelayDir 'coordinator.gemini-policy.toml'
$GeminiDefaultsFile = Join-Path $RelayDir 'coordinator.gemini-defaults.json'
# Gemini CLI's own folder for system policies on Windows; while it holds a .toml file, --admin-policy is ignored.
$GeminiSystemPolicies = @('C:\ProgramData\gemini-cli\policies')
if ($env:RELAY_TEST_GEMINI_POLICY_DIR) { $GeminiSystemPolicies += [string]$env:RELAY_TEST_GEMINI_POLICY_DIR }   # test only, one more folder (as in spawn-worker.ps1); can only make the relay halt
$script:RelayStamps = $null   # the guard on the relay's own files: its first look, $null until taken
$script:GuardOn = $false

# ---------- HQ projects (role hq only) ----------
function Get-ProjectFolderError([string]$Path, [bool]$MustExist) {
    # A project mailbox folder: a full path with no quotes, control characters or characters that Windows or cmd.exe
    # treat specially; not HQ itself, not a folder that holds HQ, and not inside HQ's own folders. '' when it is fine.
    $p = [string]$Path
    if (-not $p) { return 'it is empty' }
    if ($p -match '[\x00-\x1f"%!^&|<>`*?]') { return 'it holds a quote, a control character, or a character that Windows or cmd.exe treats specially' }
    if ($p -notmatch '^([A-Za-z]:\\|\\\\[^\\]+\\[^\\]+)') { return 'it is not a full path (like C:\Users\ada\mailboxes\notes)' }
    $full = ''
    try { $full = [IO.Path]::GetFullPath($p).TrimEnd('\') } catch { return 'Windows cannot use it as a folder path' }
    $f = $full.ToLowerInvariant() + '\'
    $h = $Root.ToLowerInvariant() + '\'
    if ($f -eq $h) { return 'it is HQ itself' }
    if ($h.StartsWith($f, [StringComparison]::Ordinal)) { return 'it holds HQ' }
    foreach ($sub in @('tasks', 'mail', 'bin', 'tests', 'templates', '.relay')) {
        if ($f.StartsWith($h + $sub + '\', [StringComparison]::Ordinal)) { return "it is inside HQ's $sub folder" }
    }
    if ($MustExist -and -not (Test-Path -LiteralPath $full -PathType Container)) { return 'the folder was not found' }
    return ''
}

function Get-HqProjectList {
    # The entries of "projects" that HQ uses, and a plain reason for each one it skips.
    $list = New-Object System.Collections.ArrayList
    $bad = New-Object System.Collections.Generic.List[string]
    $byId = @{}
    $dirs = @{}
    $i = 0
    foreach ($pe in @($HqProjectsRaw)) {
        $i++
        if (-not ($pe -is [System.Management.Automation.PSCustomObject])) { $bad.Add("projects entry $i is skipped: it is not an object with id, name and mailbox"); continue }
        $projId = ([string]$pe.id).Trim()
        $label = "projects entry $i"
        if ($projId) { $label = "projects entry $i ($projId)" }
        $dir = ([string]$pe.mailbox).Trim()
        $why = ''
        if ($projId -cnotmatch '^[a-z0-9][a-z0-9-]{0,39}$') { $why = 'its id must be 1-40 small letters, digits or hyphens, starting with a letter or a digit' }
        elseif ($projId -eq 'hq') { $why = 'its id may not be hq, the name HQ keeps for itself' }
        elseif ($byId.ContainsKey($projId)) { $why = 'another entry has the same id' }
        else {
            $de = Get-ProjectFolderError $dir $true
            if ($de) { $why = "its mailbox '$dir' cannot be used: $de" }
        }
        $full = ''
        if (-not $why) {
            $full = [IO.Path]::GetFullPath($dir).TrimEnd('\')
            if ($dirs.ContainsKey($full.ToLowerInvariant())) { $why = "another entry has the same mailbox $full" }
        }
        if ($why) { $bad.Add("$label is skipped: $why"); continue }
        $nm = (([string]$pe.name) -replace '[\x00-\x1f]', ' ').Trim()
        if (-not $nm) { $nm = $projId }
        if ($nm.Length -gt 80) { $nm = $nm.Substring(0, 80) }
        $p = @{ id = $projId; name = $nm; mailbox = $full }
        [void]$list.Add($p)
        $byId[$projId] = $p
        $dirs[$full.ToLowerInvariant()] = $true
    }
    return @{ list = $list; problems = $bad; byId = $byId }
}

$script:HqProjects = New-Object System.Collections.ArrayList   # @{ id; name; mailbox } for each project HQ uses
$script:HqProblems = New-Object System.Collections.Generic.List[string]
$script:HqById = @{}
$script:StartHq = $false
if ($HqRole) {
    $hqList = Get-HqProjectList
    $script:HqProjects = $hqList.list
    $script:HqProblems = $hqList.problems
    $script:HqById = $hqList.byId
}

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
            Update-RelayFileStamp $Path   # the relay's own write is not a change for its guard; it never throws
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

function Get-LockInfo([string]$Path) {
    # This mailbox's relay.lock, or (HQ) the one at $Path in a project's .relay. It only looks; it writes nothing.
    if (-not $Path) { $Path = $LockFile }
    $r = @{ held = $false; info = @{} }
    if (-not (Test-Path -LiteralPath $Path)) { return $r }
    try {
        $t = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::ReadWrite)
        $t.Dispose()
    } catch { $r.held = $true }
    try {
        $txt = Read-SharedText $Path
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
        daily = @{ date = ''; wakes = 0; cost = 0.0; codex_wakes = 0; mail_wakes = @{}; worker_starts = 0 }; failures = 0; next_attempt_utc = 0; halt = ''; last_finish_utc = 0; flags = @{};
        codex_notes = @{}; codex_dispatches = @{}; codex_failures = 0; codex_next_attempt_utc = 0; codex_halt = ''; codex_last_finish_utc = 0;
        mail_notes = @{}; mail_dispatches = @{}; mail_failures = @{}; mail_next_attempt = @{}; mail_halts = @{}; mail_last_finish = @{};
        starts = @{}; start_baseline_utc = 0 }
    foreach ($k in @($defaults.Keys)) { if (-not $s.ContainsKey($k) -or $null -eq $s[$k]) { $s[$k] = $defaults[$k] } }
    if (-not ($s.daily.mail_wakes -is [hashtable])) { $s.daily.mail_wakes = @{} }
    if ($null -eq $s.daily.worker_starts) { $s.daily.worker_starts = 0 }
    if (-not ($s.starts -is [hashtable])) { $s.starts = @{} }
    return $s
}

function Get-StartFilePath([string]$Task, [string]$W) {
    # A start request, tasks\<TASK-ID>\workers\W<n>-start.md (design section 11.4; Save-State uses it already).
    return (Join-Path $Root "tasks\$Task\workers\$W-start.md")
}

function Save-State([hashtable]$State) {
    # Start records are never pruned while their file is there, nor while they are 'launching'; one whose file has
    # been gone for more than 7 days is. A record whose file cannot be looked at counts as there.
    if ($State.starts -is [hashtable]) {
        $now = Get-Now
        foreach ($k in @($State.starts.Keys)) {
            $r = $State.starts[$k]
            if (-not ($r -is [hashtable]) -or $r.state -eq 'launching') { continue }
            $there = $true
            try { $there = Test-Path -LiteralPath (Get-StartFilePath ([string]$r.task) ([string]$r.worker)) -PathType Leaf } catch { $there = $true }
            if ($there) { $r.gone_utc = 0; continue }
            if (-not $r.gone_utc) { $r.gone_utc = $now } elseif (($now - [int64]$r.gone_utc) -gt 604800) { [void]$State.starts.Remove($k) }
        }
    }
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

function Get-CoordTool($Coord) {
    # The coordinator's AI tool from coordinator.json; a file from before Phase 6 has none, which means claude.
    if (-not $Coord) { return 'claude' }
    $t = ([string]$Coord.tool).Trim().ToLowerInvariant()
    if (-not $t) { return 'claude' }
    return $t
}

function Get-DispatchTool([hashtable]$D) {
    # The AI tool of one coordinator turn's record; a record from before Phase 6 has none, which means claude.
    $t = ([string]$D.tool).Trim().ToLowerInvariant()
    if (-not $t) { return 'claude' }
    return $t
}

function Get-ToolName([string]$Name) {
    switch ($Name) { 'codex' { return 'Codex' } 'gemini' { return 'Gemini CLI' } 'antigravity' { return 'Antigravity CLI' } default { return 'Claude Code' } }
}

function Test-SameFolder([string]$A, [string]$B) {
    # True when both name the same folder (letter case and a last \ do not count).
    if (-not $A -or -not $B) { return $false }
    return ([IO.Path]::GetFullPath($A).TrimEnd('\') -ieq [IO.Path]::GetFullPath($B).TrimEnd('\'))
}

function Test-DispatchMarker([hashtable]$D) {
    # The notice's marker in the session's own file. A Gemini CLI session may have more than one file.
    if ((Get-DispatchTool $D) -eq 'gemini') { return (Test-GeminiMarker $D) }
    return (Test-TranscriptMarker $D)
}

function Update-Daily([hashtable]$State) {
    $today = (Get-Date).ToString('yyyy-MM-dd', $Inv)
    if ($State.daily.date -ne $today) { $State.daily = @{ date = $today; wakes = 0; cost = 0.0; codex_wakes = 0; mail_wakes = @{}; worker_starts = 0 } }
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
function Get-AttentionItems([string]$Dir) {
    # What waits for the planner in the mailbox $Dir (default: this one). HQ also reads its projects with it.
    if (-not $Dir) { $Dir = $Root }
    $list = @{}
    $td = Join-Path $Dir 'tasks'
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
    $keys = @($State.attention.Keys | Sort-Object)
    if ($HqRole) {
        [void]$sb.AppendLine("HQ: this list holds the items of HQ itself (project hq) and of its $($script:HqProjects.Count) project(s) in bin\relay-settings.json.")
        [void]$sb.AppendLine('')
        [void]$sb.AppendLine('| Item | Project | Task | What | First seen by relay |')
        [void]$sb.AppendLine('|---|---|---|---|---|')
        foreach ($k in $keys) {
            $a = $State.attention[$k]
            $proj = [string]$a.project
            if (-not $proj) { $proj = 'hq' }
            [void]$sb.AppendLine(('| {0} | {1} | {2} | {3} | {4} |' -f $k, $proj, $a.task, $a.what, (Format-Unix $a.first_seen_utc)))
        }
        if ($keys.Count -eq 0) { [void]$sb.AppendLine('| (none) | | | | |') }
    } else {
        [void]$sb.AppendLine('| Item | Task | What | First seen by relay |')
        [void]$sb.AppendLine('|---|---|---|---|')
        foreach ($k in $keys) {
            $a = $State.attention[$k]
            [void]$sb.AppendLine(('| {0} | {1} | {2} | {3} |' -f $k, $a.task, $a.what, (Format-Unix $a.first_seen_utc)))
        }
        if ($keys.Count -eq 0) { [void]$sb.AppendLine('| (none) | | | |') }
    }
    [IO.File]::WriteAllText($AttnFile, $sb.ToString(), $Utf8)
}

function Update-Attention([hashtable]$State, [bool]$Baseline) {
    # With CodexWake on, each NEW item (not one already listed, and never at the baseline) is queued to wake Codex once.
    if ($HqRole) { Update-HqAttention $State $Baseline; return }
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
    $coordTool = Get-CoordTool $Coord
    if ($coordTool -eq 'codex') { return (Get-CodexCoordinatorBusy $State $Coord) }
    if ($coordTool -eq 'gemini') { return (Get-GeminiCoordinatorBusy $State $Coord) }
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
        "Start workers only with: powershell -NoProfile -ExecutionPolicy Bypass -File $spawn -TaskId <TASK-ID> -Worker W<n> [-Type review] [-Tool claude|codex|gemini|antigravity] [-MaxBudgetUsd <n>] . " +
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
    $deny = @('WebFetch', 'WebSearch',
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
        'Bash(claude*)', 'Bash(codex*)', 'Bash(gemini*)', 'Bash(agy*)', 'Bash(npm *)', 'Bash(npx *)', 'Bash(rm *)')
    # HQ: a project mailbox inside HQ (such as projects\<id>) falls under the Edit rule above, so its relay files are
    # denied the same way.
    foreach ($p in @($script:HqProjects)) {
        $b = ConvertTo-RulePath ([string]$p.mailbox)
        $deny += @("Edit($b/bin/**)", "Write($b/bin/**)", "Edit($b/.relay/**)", "Write($b/.relay/**)", "Edit($b/tests/**)", "Write($b/tests/**)")
    }
    return $deny
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
    if ((Get-DispatchTool $D) -eq 'claude') { Add-LedgerLine $D } else { Add-LedgerLine $D '-' }   # Codex and Gemini CLI turns have no dollar budget
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
    if ((Get-CoordTool $Coord) -ne 'claude') { Start-ToolDispatch $State $Coord $Pending; return }   # Codex or Gemini CLI: its own turn
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
    if ((Get-DispatchTool $D) -ne 'claude') { Complete-ToolDispatch $State $D; return }   # a Codex or Gemini CLI turn
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
            if (-not (Test-Path -LiteralPath $d.out) -and -not (Test-DispatchMarker $d)) {
                $d.state = 'abandoned'
                $d.finished_utc = Get-Now
                $d.outcome = 'the relay stopped before the CLI started; items re-queued'
                foreach ($nid in @($d.items)) { $n = $State.notes[$nid]; if ($n) { $n.state = 'pending'; $n.dispatch_id = '' } }
                Write-Log "Dispatch $($d.id) never started (the relay stopped first); $(@($d.items).Count) notification(s) re-queued"
                if ((Get-DispatchTool $d) -eq 'claude') { Add-LedgerLine $d } else { Add-LedgerLine $d '-' }
                continue
            }
        }
        if ($d.state -eq 'launching') { $d.state = 'running' }
        if (Test-DispatchAlive $d) {
            if (-not $d.accepted_utc -and (Test-DispatchMarker $d)) { Set-Accepted $State $d }
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
    $coordTool = Get-CoordTool $Coord
    if (@('claude', 'codex', 'gemini') -notcontains $coordTool) {
        return @{ code = 'unknown-tool'; text = "the relay cannot wake a coordinator in '$coordTool' (.relay\coordinator.json names that tool; the relay knows claude, codex and gemini). Pending notifications are kept. Enroll again with -Enroll -Tool claude, codex or gemini" }
    }
    if ($Settling -gt 0) { return @{ code = 'settling'; text = "settling: $Settling inbound file(s) changed less than $DebounceSeconds s ago (debounce)" } }
    if ($State.next_attempt_utc -and $now -lt [int64]$State.next_attempt_utc) {
        return @{ code = 'backoff'; text = "backoff after failure $($State.failures)/$MaxFailures; next attempt not before $(Format-Unix $State.next_attempt_utc)" }
    }
    if ($MaxWakesPerDay -gt 0 -and [int]$State.daily.wakes -ge $MaxWakesPerDay) {
        Add-Alert $State ('cap-wakes-' + $State.daily.date) "Daily wake limit reached ($MaxWakesPerDay coordinator turns). Notifications stay queued until tomorrow. Possible loop: check .relay\relay.log."
        return @{ code = 'cap-wakes'; text = "daily wake limit reached ($($State.daily.wakes)/$MaxWakesPerDay)" }
    }
    # The dollar cap is for Claude turns only: Codex and Gemini CLI turns report no cost (the wake cap above counts every tool).
    if ($coordTool -eq 'claude' -and $script:CostLimits -and ([double]$State.daily.cost + $TurnBudgetUsd) -gt $DailyBudgetUsd) {
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
    if ($HqRole) { return (New-HqCodexPrompt $Id $Batch) }
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

function Get-CodexArguments([hashtable]$Cx, [string]$Prompt, $Options = $null) {
    $a = New-Object System.Collections.Generic.List[string]
    foreach ($x in @('exec', '--json', '--skip-git-repo-check')) { $a.Add($x) }
    if ($null -ne $Options) {
        foreach ($x in $Options) { $a.Add([string]$x) }   # a coordinator turn: only the relay's own fixed options
    } else {
        foreach ($x in $CodexArgs) { $a.Add([string]$x) }
        foreach ($d in @(Get-HqAddDirs $Cx)) { $a.Add('--add-dir'); $a.Add([string]$d) }   # HQ only: each project mailbox
    }
    foreach ($x in @('resume', [string]$Cx.thread_id, $Prompt)) { $a.Add([string]$x) }
    return , $a
}

function Get-CodexCommandLine([string[]]$Prefix, [hashtable]$Cx, [string]$Prompt, $Options = $null) {
    # The argument string for Start-Process. The list goes through a variable: @(<function>) would keep it as one item.
    $cliArgs = Get-CodexArguments $Cx $Prompt $Options
    return ((@($Prefix) + @($cliArgs)) | ForEach-Object { ConvertTo-ArgToken $_ }) -join ' '
}

function Get-CodexPreflightError([hashtable]$Cx, [string]$Reenroll = '-EnrollCodex', [bool]$IgnoreCodexArgs = $false) {
    # $IgnoreCodexArgs: a coordinator turn never uses codex_exec_args (the planner's setting), so a bad one does not stop it.
    if ($CodexArgsError -and -not $IgnoreCodexArgs) { return $CodexArgsError }
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
    $n = @{ id = $Key; key = $Key; task = [string]$Item.task; what = [string]$Item.what; state = 'pending'; detected_utc = (Get-Now);
        dispatch_id = ''; attempts = 0; outcome = ''; accepted_utc = 0; completed_utc = 0 }
    if ($Item.project) { $n.project = [string]$Item.project; $n.mailbox = [string]$Item.mailbox }   # HQ only
    $State.codex_notes[$Key] = $n
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

function Get-CoordinatorThreadTurn([hashtable]$State, [string]$ThreadId) {
    # A coordinator turn that runs in this Codex thread (one thread has one job, so this is a backstop). '' when none.
    $tid = ([string]$ThreadId).ToLowerInvariant()
    foreach ($d in @($State.dispatches.Values)) {
        if (($d.state -eq 'running' -or $d.state -eq 'launching') -and (Get-DispatchTool $d) -eq 'codex' -and ([string]$d.session_id).ToLowerInvariant() -eq $tid) {
            return "the coordinator turn $($d.id) is still running in this thread (pid $($d.pid))"
        }
    }
    return ''
}

function Get-CodexBusyReason([hashtable]$State, [hashtable]$Cx) {
    foreach ($d in @($State.codex_dispatches.Values)) {
        if ($d.state -eq 'running' -or $d.state -eq 'launching') { return "relay Codex wake $($d.id) is still running (pid $($d.pid))" }
    }
    $tid = [string]$Cx.thread_id
    foreach ($d in @($State.mail_dispatches.Values)) {
        if (($d.state -eq 'running' -or $d.state -eq 'launching') -and [string]$d.thread_id -eq $tid) { return "the relay's mail wake $($d.id) is still running in this thread (pid $($d.pid))" }
    }
    $turn = Get-CoordinatorThreadTurn $State $tid
    if ($turn) { return $turn }
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
    if (-not $HqRole) {   # HQ holds back only the items of the mailbox whose coordinator turn runs (Split-HqPending)
        foreach ($d in @($State.dispatches.Values)) {
            if ($d.state -eq 'running' -or $d.state -eq 'launching') { return @{ code = 'coordinator-turn'; text = "a coordinator turn is still running ($($d.id)); the planner is woken after it ends, so it reads finished work" } }
        }
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

function Start-CodexProcess([hashtable]$Target, [string]$Prompt, [string]$Stdin, [string]$Out, [string]$Err, $Options = $null) {
    # Checks the ChatGPT sign-in, then starts codex exec resume for $Target (its thread_id, in its cwd) in its own hidden
    # console. Returns @{ proc; error }: the process, or a plain reason it did not start. $Options: a coordinator turn's
    # own fixed options in place of codex_exec_args (Get-CodexArguments). No local here may be named $err ($Err above).
    $exe = Get-CodexExePath
    $file = $exe
    $prefix = @()
    if ($exe -match '\.js$') {
        $file = (Get-Command node.exe -CommandType Application | Select-Object -First 1).Path
        $prefix = @($exe)
    }
    $argString = Get-CodexCommandLine $prefix $Target $Prompt $Options
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
    if ($HqRole) {
        # One owner for the orchestrator's thread: HQ stops its wakes when a project's relay wakes that thread too.
        $own = Get-HqOwnerProblem ([string]$cx.thread_id)
        if ($own -and $own.hold) {
            $text = "the orchestrator is not woken this round: $($own.hold)"
            if ($ReadOnly) { Write-Note "DRY-RUN: $text" }
            elseif ($State.flags['last_codex_block'] -ne 'owner-unread') { $State.flags['last_codex_block'] = 'owner-unread'; Write-Log $text }
            else { Write-Note $text }
            return
        }
        if ($own -and $own.halt -and -not $State.codex_halt) {
            if ($ReadOnly) { Write-Note "DRY-RUN: would stop the orchestrator's wakes now: $($own.halt)"; return }
            Set-CodexHalt $State $own.reason "Codex wakes stopped: $($own.halt)"
        }
    }
    $pending = @($State.codex_notes.Values | Where-Object { $_.state -eq 'pending' } | Sort-Object { [int64]$_.detected_utc })
    if ($pending.Count -eq 0) {
        [void]$State.flags.Remove('last_codex_block')
        if ($ReadOnly) { Write-Note 'DRY-RUN: nothing to wake Codex for.' }
        return
    }
    if ($HqRole) {
        # An item waits while a coordinator turn runs in its own mailbox; the other projects' items still go.
        $split = Split-HqPending $State $pending
        foreach ($proj in @($split.held.Keys | Sort-Object)) {
            $text = "$($split.count[$proj]) item(s) of project $proj wait for the orchestrator: $($split.held[$proj])"
            $flag = 'last_hq_hold_' + $proj
            if ($ReadOnly) { Write-Note "DRY-RUN: $text" }
            elseif ($State.flags[$flag] -ne $split.held[$proj]) { $State.flags[$flag] = $split.held[$proj]; Write-Log $text }
            else { Write-Note $text }
        }
        foreach ($f in @($State.flags.Keys | Where-Object { $_ -like 'last_hq_hold_*' })) {
            if (-not $split.held.ContainsKey($f.Substring(13))) { [void]$State.flags.Remove($f) }
        }
        $pending = @($split.ready)
        if ($pending.Count -eq 0) { return }
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

# ---------- HQ (off unless bin\relay-settings.json has "role": "hq") ----------
# HQ is a mailbox whose settings also list project mailboxes. Each project keeps its own relay, coordinator, caps,
# PAUSE and halts. Only the HQ relay wakes the orchestrator: HQ's enrolled Codex thread, the planner of every project.
# HQ only reads the projects (their task files, and their relays' state.json, codex.json, agents.json and relay.lock);
# it writes there only for the owner commands -NewProject, -UpdateProjects and -StopAll.
function Get-HqAttentionItems([hashtable]$Missing) {
    # HQ's own items (with their old keys) and each project's, keyed <project id>:<old key>. A project whose folder is
    # not found now is left out, and named in $Missing.
    $all = @{}
    $own = Get-AttentionItems $Root
    foreach ($k in @($own.Keys)) {
        $it = $own[$k]
        $it.project = 'hq'
        $it.mailbox = $Root
        $all[$k] = $it
    }
    foreach ($p in $script:HqProjects) {
        if (-not (Test-Path -LiteralPath $p.mailbox -PathType Container)) {
            if ($null -ne $Missing) { $Missing[$p.id] = $true }
            continue
        }
        $items = Get-AttentionItems $p.mailbox
        foreach ($k in @($items.Keys)) {
            $it = $items[$k]
            $it.project = $p.id
            $it.mailbox = $p.mailbox
            $all[$p.id + ':' + $k] = $it
        }
    }
    return $all
}

function Update-HqAttention([hashtable]$State, [bool]$Baseline) {
    # Update-Attention for HQ and every project. A project this relay has not looked at before (or one that moved to
    # another folder) is new: what already waits in it counts as known, the way -EnrollCodex counts what waits, so
    # adding a project wakes nothing. A project whose folder is not found right now keeps its items as they were.
    if (-not ($State.hq_projects -is [hashtable])) { $State.hq_projects = @{} }
    $missing = @{}
    $cur = Get-HqAttentionItems $missing
    $codexOn = [bool](Get-CodexConfig)
    $changed = $false
    $fresh = @{}
    foreach ($p in $script:HqProjects) {
        if ($missing.ContainsKey($p.id)) { continue }
        $seen = $State.hq_projects[$p.id]
        if (($seen -is [hashtable]) -and [string]$seen.mailbox -eq $p.mailbox) { continue }
        $fresh[$p.id] = $true
        $State.hq_projects[$p.id] = @{ mailbox = $p.mailbox; added_utc = (Get-Now) }
        $n = @($cur.Keys | Where-Object { $cur[$_].project -eq $p.id }).Count
        Write-Log "HQ: project $($p.id) ($($p.mailbox)) is new to this relay. The $n item(s) that wait in it now count as known, so adding it wakes nothing."
        $changed = $true
    }
    foreach ($id in @($State.hq_projects.Keys)) {
        if (-not $script:HqById.ContainsKey($id)) { [void]$State.hq_projects.Remove($id) }   # no longer in the list
    }
    foreach ($k in @($cur.Keys)) {
        if ($State.attention.ContainsKey($k)) { continue }
        $it = $cur[$k]
        $State.attention[$k] = @{ task = $it.task; what = $it.what; project = $it.project; mailbox = $it.mailbox; first_seen_utc = (Get-Now) }
        $how = '(listed in .relay\codex-attention.md; CodexWake=NOT_CONFIGURED, not delivered)'
        if ($fresh.ContainsKey([string]$it.project)) { $how = '(already waiting when HQ added the project; listed, not sent)' }
        elseif ($codexOn -and $Baseline) { $how = '(already waiting at the first run; listed, not sent)' }
        elseif ($codexOn) { Add-CodexWakeNote $State $k $it; $how = '(queued to wake the orchestrator)' }
        Write-Log "Return direction: NEW for Codex - $($it.project) $($it.task): $($it.what) $how"
        $changed = $true
    }
    foreach ($k in @($State.attention.Keys)) {
        if ($cur.ContainsKey($k)) { continue }
        $proj = [string]$State.attention[$k].project
        if ($proj -and $missing.ContainsKey($proj)) { continue }   # its folder is not found right now: kept as it was
        [void]$State.attention.Remove($k)
        $cn = $State.codex_notes[$k]
        if ($cn -and $cn.state -eq 'pending') { [void]$State.codex_notes.Remove($k) }   # resolved before it was sent
        Write-Log "Return direction: no longer pending for Codex - $k"
        $changed = $true
    }
    if ($changed -or -not (Test-Path -LiteralPath $AttnFile)) { Write-AttentionFile $State }
}

function Get-ProjectTurnReason([hashtable]$P) {
    # Read-only: the coordinator turn that runs in this project's mailbox now, from its relay's .relay\state.json.
    # '' when none runs. A state.json that cannot be read counts as a running turn.
    $f = Join-Path ([string]$P.mailbox) '.relay\state.json'
    if (-not (Test-Path -LiteralPath $f -PathType Leaf)) { return '' }
    $s = $null
    try { $s = Read-Json $f } catch { $s = $null }
    if (-not ($s -is [hashtable])) { return "its relay's .relay\state.json could not be read, so its items wait" }
    $ds = $s['dispatches']
    if (-not ($ds -is [hashtable])) { return '' }
    foreach ($d in @($ds.Values)) {
        if (-not ($d -is [hashtable]) -or -not $d.id) { continue }
        if ($d.state -eq 'launching') { return "a coordinator turn is starting there ($($d.id))" }
        if ($d.state -eq 'running' -and (Test-DispatchAlive $d)) { return "a coordinator turn runs there ($($d.id), pid $($d.pid))" }
    }
    return ''
}

function Get-HqItemWaitReason([hashtable]$State, [string]$Project) {
    # Why the items of one project (or of HQ itself, 'hq') wait this round; '' when they may go.
    if ($Project -eq 'hq') {
        foreach ($d in @($State.dispatches.Values)) {
            if ($d.state -eq 'running' -or $d.state -eq 'launching') { return "a coordinator turn of HQ is still running ($($d.id)); the orchestrator is woken after it ends, so it reads finished work" }
        }
        return ''
    }
    $p = $script:HqById[$Project]
    if (-not $p) { return 'the project is not in the projects list any more' }
    if (-not (Test-Path -LiteralPath $p.mailbox -PathType Container)) { return "its mailbox folder $($p.mailbox) was not found" }
    $t = Get-ProjectTurnReason $p
    if ($t) { return "$t; the orchestrator is woken for them after it ends" }
    return ''
}

function Split-HqPending([hashtable]$State, [object[]]$Pending) {
    # HQ: an item waits while a coordinator turn runs in its own mailbox; the other projects' items still go.
    # Returns @{ ready = the items that may go; held = @{ project = why }; count = @{ project = items held } }.
    $ready = New-Object System.Collections.ArrayList
    $held = @{}
    $count = @{}
    $why = @{}
    foreach ($n in $Pending) {
        $proj = [string]$n.project
        if (-not $proj) { $proj = 'hq' }
        if (-not $why.ContainsKey($proj)) { $why[$proj] = Get-HqItemWaitReason $State $proj }
        if ($why[$proj]) {
            $held[$proj] = $why[$proj]
            $count[$proj] = [int]$count[$proj] + 1
        } else { [void]$ready.Add($n) }
    }
    return @{ ready = $ready.ToArray(); held = $held; count = $count }
}

function Get-HqOwnerProblem([string]$ThreadId) {
    # Read-only: a project whose own relay also wakes the orchestrator's thread, as its planner (.relay\codex.json), as
    # its coordinator (.relay\coordinator.json) or for an agent's mail (.relay\agents.json). Two relays must never wake
    # one thread.
    # Returns @{ halt; reason } for such a project, @{ hold } when a file could not be read, else $null.
    $tid = ([string]$ThreadId).ToLowerInvariant()
    if (-not $tid) { return $null }
    foreach ($p in $script:HqProjects) {
        $rd = Join-Path $p.mailbox '.relay'
        $cf = Join-Path $rd 'codex.json'
        if (Test-Path -LiteralPath $cf -PathType Leaf) {
            $c = $null
            try { $c = Read-Json $cf } catch { return @{ hold = "the .relay\codex.json of project $($p.id) could not be read" } }
            if (($c -is [hashtable]) -and ([string]$c.thread_id).ToLowerInvariant() -eq $tid) {
                return @{ reason = "project $($p.id) also wakes the orchestrator's Codex thread $tid (its planner wake)";
                    halt = ("project $($p.id) also wakes the orchestrator's Codex thread $tid, as its own planner. Two relays must never wake the same thread. " +
                        "To fix it, run .\bin\bridge-relay.ps1 -UnenrollCodex in that project's folder ($($p.mailbox)).") }
            }
        }
        # A project's coordinator in Codex (a Claude Code coordinator, or one with no tool, is never a Codex thread).
        $kf = Join-Path $rd 'coordinator.json'
        if (Test-Path -LiteralPath $kf -PathType Leaf) {
            $coordRec = $null
            try { $coordRec = Read-Json $kf } catch { return @{ hold = "the .relay\coordinator.json of project $($p.id) could not be read" } }
            if (($coordRec -is [hashtable]) -and (Get-CoordTool $coordRec) -eq 'codex' -and ([string]$coordRec.session_id).ToLowerInvariant() -eq $tid) {
                return @{ reason = "project $($p.id) also wakes the orchestrator's Codex thread $tid (as its coordinator)";
                    halt = ("project $($p.id) also wakes the orchestrator's Codex thread $tid, as its coordinator. Two relays must never wake the same thread. " +
                        "To fix it, enroll another coordinator in that project's folder ($($p.mailbox)) with .\bin\bridge-relay.ps1 -Enroll.") }
            }
        }
        $af = Join-Path $rd 'agents.json'
        if (Test-Path -LiteralPath $af -PathType Leaf) {
            $ag = $null
            try { $ag = Read-Json $af } catch { return @{ hold = "the .relay\agents.json of project $($p.id) could not be read" } }
            if (-not ($ag -is [hashtable])) { continue }
            foreach ($k in @($ag.Keys)) {
                $one = $ag[$k]
                if (-not ($one -is [hashtable]) -or ([string]$one.thread_id).ToLowerInvariant() -ne $tid) { continue }
                $nm = [string]$one.name
                if (-not $nm) { $nm = [string]$k }
                return @{ reason = "project $($p.id) also wakes the orchestrator's Codex thread $tid (for the mail of its agent '$nm')";
                    halt = ("project $($p.id) also wakes the orchestrator's Codex thread $tid, for the mail of its agent '$nm'. Two relays must never wake the same thread. " +
                        "To fix it, run .\bin\bridge-relay.ps1 -UnenrollAgent -AgentName '$nm' in that project's folder ($($p.mailbox)).") }
            }
        }
    }
    return $null
}

function Get-HqAddDirs([hashtable]$Target) {
    # HQ only: when codex_exec_args asks for workspace-write, the orchestrator's turn may also write in each project
    # mailbox (--add-dir). Each folder is checked again first, the way codex_exec_args entries are: a full path to a
    # folder that is there, with no quotes or control characters. Agents' mail wakes get none.
    if (-not $HqRole -or -not $Target) { return @() }
    $ww = $false
    foreach ($x in $CodexArgs) { if ([string]$x -match '(^|=)workspace-write$') { $ww = $true } }
    if (-not $ww) { return @() }
    $cx = Get-CodexConfig
    if (-not $cx -or [string]$cx.thread_id -ne [string]$Target.thread_id) { return @() }
    $out = New-Object System.Collections.Generic.List[string]
    foreach ($p in $script:HqProjects) {
        if (Get-ProjectFolderError ([string]$p.mailbox) $true) { continue }
        if (-not $out.Contains([string]$p.mailbox)) { $out.Add([string]$p.mailbox) }
    }
    return $out.ToArray()
}

function New-HqCodexPrompt([string]$Id, [object[]]$Batch) {
    # The orchestrator's notice: the items grouped by project, each project with its mailbox folder.
    $groups = [ordered]@{}
    foreach ($n in $Batch) {
        $proj = [string]$n.project
        if (-not $proj) { $proj = 'hq' }
        if (-not $groups.Contains($proj)) { $groups[$proj] = New-Object System.Collections.ArrayList }
        [void]$groups[$proj].Add($n)
    }
    $parts = New-Object System.Collections.Generic.List[string]
    $i = 0
    foreach ($proj in @($groups.Keys)) {
        $items = @($groups[$proj])
        $mb = [string]$items[0].mailbox
        if (-not $mb -and $proj -eq 'hq') { $mb = $Root }
        if (-not $mb -and $script:HqById.ContainsKey($proj)) { $mb = [string]$script:HqById[$proj].mailbox }
        $one = New-Object System.Collections.Generic.List[string]
        foreach ($n in $items) { $i++; $one.Add(('{0}) {1}: {2}' -f $i, $n.task, $n.what)) }
        $label = "project $proj"
        if ($proj -eq 'hq') { $label = 'HQ itself (project hq)' }
        $parts.Add(('{0}, mailbox {1}: {2}' -f $label, $mb, ($one -join '; ')))
    }
    $text = "[bridge-relay $Id] Mailbox notice for the Codex orchestrator of HQ. bin/bridge-relay.ps1 in $Root started this turn from the command line ($OwnerName did not type it). " +
        "$i new item(s) wait for the planner. " + ($parts -join '. ') + '. ' +
        "For each item, read STATUS.md and the named task files in that project's mailbox, then act as that project's planner under the README.md there: " +
        "write your answer, review or assignment in that project's mailbox only, in planner-owned files (CODEX-QUEUE.md and the tasks assignment.md, answers.md and review.md). " +
        "Work with no project goes on HQ's own board in $Root. .relay/codex-attention.md in $Root lists everything that still waits, with its project. " +
        'Codex app thread tools may be unavailable in this turn. Do not invent tasks. If nothing is actionable, change nothing. End with a one to three sentence summary.'
    return (ConvertTo-SafeText $text)
}

function Write-HqProblems([hashtable]$State) {
    # The entries of "projects" that HQ skips, in the log once (again only when they change).
    $txt = ($script:HqProblems -join ' | ')
    if ([string]$State.flags['hq_problems'] -eq $txt) { return }
    if ($txt) { $State.flags['hq_problems'] = $txt } else { [void]$State.flags.Remove('hq_problems') }
    foreach ($m in $script:HqProblems) { Write-Log "HQ: in bin\relay-settings.json, $m" }
}

function Get-ProjectRelayText([hashtable]$P) {
    # Read-only: whether the project's relay runs, from the lock it holds while it runs.
    $li = Get-LockInfo (Join-Path $P.mailbox '.relay\relay.lock')
    if ($li.held -and $li.info.mode -eq 'Start') { return "yes (pid $($li.info.pid), since $($li.info.started))" }
    if ($li.held) { return "a short '$($li.info.mode)' command holds its lock (pid $($li.info.pid))" }
    $sf = Join-Path $P.mailbox '.relay\state.json'
    if (Test-Path -LiteralPath $sf -PathType Leaf) { return ('no (it last ran ' + (Get-Item -LiteralPath $sf).LastWriteTime.ToString('yyyy-MM-dd HH:mm:ss', $Inv) + ')') }
    return 'no'
}

function Show-HqProjects {
    Write-Host ("HQ: this mailbox is HQ for {0} project(s) (role hq in bin\relay-settings.json). Each project runs its own relay; this relay alone wakes the orchestrator for them all." -f $script:HqProjects.Count)
    foreach ($m in $script:HqProblems) { Write-Host "  - $m" }
    foreach ($p in $script:HqProjects) {
        $found = Test-Path -LiteralPath $p.mailbox -PathType Container
        $waiting = '-'
        if ($found) { $waiting = [string](Get-AttentionItems $p.mailbox).Count }
        Write-Host ("  - {0} ({1}): mailbox {2}; folder found: {3}; items waiting for the planner: {4}; its relay runs: {5}" -f
            $p.id, $p.name, $p.mailbox, $found, $waiting, (Get-ProjectRelayText $p))
    }
}

function Assert-Hq([string]$What) {
    if (-not $HqRole) {
        Fail "This mailbox is not HQ, so $What does not work here. HQ is the mailbox whose bin\relay-settings.json has ""role"": ""hq"" (see Run several projects in the relay's README.md)." 64
    }
}

function Write-TextSafely([string]$Path, [string]$Text) {
    # For the owner commands, which run without the writer lock: the whole new file, or the old one stays.
    $tmp = $Path + '.tmp'
    [IO.File]::WriteAllText($tmp, $Text, $Utf8)
    if (Test-Path -LiteralPath $Path) { [IO.File]::Replace($tmp, $Path, [NullString]::Value) } else { [IO.File]::Move($tmp, $Path) }
}

function Copy-FolderFiles([string]$From, [string]$To) {
    # Every file under $From to the same place under $To. Returns how many it copied.
    if (-not (Test-Path -LiteralPath $From -PathType Container)) { return 0 }
    $n = 0
    $base = (Get-Item -LiteralPath $From).FullName.TrimEnd('\')
    foreach ($f in @(Get-ChildItem -LiteralPath $From -Recurse -File -Force -ErrorAction SilentlyContinue)) {
        $dest = Join-Path $To ($f.FullName.Substring($base.Length + 1))
        $dd = Split-Path -Parent $dest
        if (-not (Test-Path -LiteralPath $dd -PathType Container)) { New-Item -ItemType Directory -Path $dd -Force | Out-Null }
        Copy-Item -LiteralPath $f.FullName -Destination $dest -Force
        $n++
    }
    return $n
}

function Invoke-NewProject {
    # Owner only, in HQ: makes a project mailbox from HQ's own copy of the relay, then adds it to HQ's projects list.
    Assert-Hq '-NewProject'
    $projId = ([string]$ProjectId).Trim()
    if ($projId -cnotmatch '^[a-z0-9][a-z0-9-]{0,39}$' -or $projId -eq 'hq') {
        Fail "-ProjectId must be 1-40 small letters, digits or hyphens, start with a letter or a digit, and not be hq (got '$ProjectId'). Nothing was made." 64
    }
    $projName = (([string]$ProjectName) -replace '[\x00-\x1f]', ' ').Trim()
    if (-not $projName -or $projName.Length -gt 80) { Fail "-ProjectName must be 1 to 80 characters (got '$ProjectName'). Nothing was made." 64 }
    $raw = $null
    try { $raw = Get-Content -LiteralPath $rsFile -Raw | ConvertFrom-Json } catch { Fail "Could not read $rsFile ($($_.Exception.Message)). Nothing was made." }
    if (-not $raw) { Fail "Could not read $rsFile. Nothing was made." }
    $folder = [string]$ProjectFolder
    if (-not $folder) { $folder = Join-Path (Join-Path $Root 'projects') $projId }
    $why = Get-ProjectFolderError $folder $false
    if ($why) { Fail "The project folder '$folder' cannot be used: $why. Nothing was made." 64 }
    $folder = [IO.Path]::GetFullPath($folder).TrimEnd('\')
    $old = @()
    if ($null -ne $raw.projects) { $old = @($raw.projects | Where-Object { $null -ne $_ }) }
    foreach ($pe in $old) {
        if (([string]$pe.id).Trim() -eq $projId) { Fail "HQ already has a project with the id '$projId' (in $rsFile). Pick another id. Nothing was made." }
        $pm = ''
        try { $pm = [IO.Path]::GetFullPath(([string]$pe.mailbox).Trim()).TrimEnd('\') } catch { $pm = '' }
        if ($pm -and $pm -eq $folder) { Fail "The project '$($pe.id)' already uses the folder $folder. Pick another folder with -ProjectFolder. Nothing was made." }
    }
    if (Test-Path -LiteralPath $folder -PathType Leaf) { Fail "$folder is a file, not a folder. Nothing was made." }
    if ((Test-Path -LiteralPath $folder -PathType Container) -and @(Get-ChildItem -LiteralPath $folder -Force -ErrorAction SilentlyContinue).Count) {
        Fail "The folder $folder already exists and is not empty. Pick a new or empty folder with -ProjectFolder. Nothing was made."
    }
    $hqBin = Join-Path $Root 'bin'
    foreach ($d in @($folder, (Join-Path $folder 'bin'), (Join-Path $folder 'tasks'))) {
        if (-not (Test-Path -LiteralPath $d -PathType Container)) { New-Item -ItemType Directory -Path $d -Force | Out-Null }
    }
    $made = 0
    foreach ($f in @(Get-ChildItem -LiteralPath $hqBin -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '\.ps1$' -or $_.Name -match '\.example\.json$' })) {
        Copy-Item -LiteralPath $f.FullName -Destination (Join-Path (Join-Path $folder 'bin') $f.Name)
        $made++
    }
    foreach ($sub in @('tests', 'templates')) { $made += Copy-FolderFiles (Join-Path $Root $sub) (Join-Path $folder $sub) }
    foreach ($doc in @('README.md', 'CLAUDE.md')) {
        $src = Join-Path $Root $doc
        if (Test-Path -LiteralPath $src -PathType Leaf) { Copy-Item -LiteralPath $src -Destination (Join-Path $folder $doc); $made++ }
    }
    [IO.File]::WriteAllText((Join-Path $folder 'CODEX-QUEUE.md'), "# Codex queue (owner: Codex)`r`n", $Utf8)
    [IO.File]::WriteAllText((Join-Path $folder 'STATUS.md'), "# Status board (owner: Claude)`r`n", $Utf8)
    # The project's settings: HQ's, without role and projects, and with hq_dir.
    $projSettings = [ordered]@{}
    foreach ($prop in @($raw.PSObject.Properties)) {
        if (@('role', 'projects', 'hq_dir') -contains $prop.Name) { continue }
        $projSettings[$prop.Name] = $prop.Value
    }
    $projSettings['hq_dir'] = $Root
    [IO.File]::WriteAllText((Join-Path $folder 'bin\relay-settings.json'), (ConvertTo-Json -InputObject $projSettings -Depth 12), $Utf8)
    $cl = Join-Path $hqBin 'cost-limits.json'
    if (Test-Path -LiteralPath $cl -PathType Leaf) { Copy-Item -LiteralPath $cl -Destination (Join-Path $folder 'bin\cost-limits.json') }
    # Then HQ's list, after a copy of the old settings.
    $bak = $rsFile + '.bak-' + (Get-Date).ToString('yyyyMMdd-HHmmss', $Inv)
    Copy-Item -LiteralPath $rsFile -Destination $bak -Force
    $list = New-Object System.Collections.ArrayList
    foreach ($pe in $old) { [void]$list.Add($pe) }
    [void]$list.Add([pscustomobject]@{ id = $projId; name = $projName; mailbox = $folder })
    $hqSettings = [ordered]@{}
    foreach ($prop in @($raw.PSObject.Properties)) { $hqSettings[$prop.Name] = $prop.Value }
    $hqSettings['projects'] = $list.ToArray()
    Write-TextSafely $rsFile (ConvertTo-Json -InputObject $hqSettings -Depth 12)
    Write-Host "Made the project mailbox $folder for '$projName' (id $projId): $made relay file(s) from HQ, a tasks folder, CODEX-QUEUE.md, STATUS.md, and bin\relay-settings.json with hq_dir."
    Write-Host "Added it to the projects list in $rsFile. The old settings are kept in $bak."
    Write-Host 'Next:'
    Write-Host "  1. Enroll the project's coordinator in the project's own folder: cd '$folder', then .\bin\bridge-relay.ps1 -Enroll -SessionName '<its name>'."
    Write-Host "     A coordinator can be Claude Code, Codex or Gemini CLI: see the README part 'A coordinator in Codex or Gemini CLI'."
    Write-Host '  2. The HQ relay reads its settings when it starts. If it runs now, run -StopAll, then -StartAll, so it watches the new project.'
}

function Invoke-UpdateProjects {
    # Owner only, in HQ: copies HQ's scripts into each project whose relay does not run. Never settings, templates,
    # README.md or CLAUDE.md. Each file it replaces is kept as <name>.bak-<time>.
    Assert-Hq '-UpdateProjects'
    $hqBin = Join-Path $Root 'bin'
    $scripts = @(Get-ChildItem -LiteralPath $hqBin -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '\.ps1$' })
    $stubs = @(Get-ChildItem -LiteralPath (Join-Path $Root 'tests') -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '^stub-.*\.js$' })
    if ($scripts.Count -eq 0) { Fail "No relay scripts were found in $hqBin. Nothing was copied." }
    foreach ($m in $script:HqProblems) { Write-Host "In bin\relay-settings.json, $m" }
    if ($script:HqProjects.Count -eq 0) { Write-Host 'HQ has no project to update (projects in bin\relay-settings.json).'; return }
    $stamp = (Get-Date).ToString('yyyyMMdd-HHmmss', $Inv)
    foreach ($p in $script:HqProjects) {
        if (-not (Test-Path -LiteralPath $p.mailbox -PathType Container)) { Write-Host "Skipped $($p.id): its mailbox folder $($p.mailbox) was not found."; continue }
        $li = Get-LockInfo (Join-Path $p.mailbox '.relay\relay.lock')
        if ($li.held) {
            Write-Host "Skipped $($p.id): its relay runs now (pid $($li.info.pid)). Stop it first (-StopAll here, or -Stop in $($p.mailbox)), then run -UpdateProjects again."
            continue
        }
        $copied = 0
        $same = 0
        foreach ($pair in @(@{ files = $scripts; dir = 'bin' }, @{ files = $stubs; dir = 'tests' })) {
            $to = Join-Path $p.mailbox $pair.dir
            if (-not (Test-Path -LiteralPath $to -PathType Container)) { New-Item -ItemType Directory -Path $to -Force | Out-Null }
            foreach ($f in @($pair.files)) {
                $dest = Join-Path $to $f.Name
                if (Test-Path -LiteralPath $dest -PathType Leaf) {
                    if ((Get-FileSha256 $dest) -eq (Get-FileSha256 $f.FullName)) { $same++; continue }
                    Copy-Item -LiteralPath $dest -Destination ($dest + '.bak-' + $stamp) -Force
                }
                Copy-Item -LiteralPath $f.FullName -Destination $dest -Force
                $copied++
            }
        }
        Write-Host ("Updated {0} ({1}): {2} file(s) copied, {3} already the same. Each file it replaced is kept as <name>.bak-{4}." -f $p.id, $p.mailbox, $copied, $same, $stamp)
    }
    Write-Host 'Settings, templates, README.md and CLAUDE.md stay as they are in each project. Start the relays again with -StartAll.'
}

function Invoke-StartAll {
    # Owner only, in HQ: one new PowerShell window for each project's relay that does not run yet. Sets
    # $script:StartHq when this window should then run HQ's own loop.
    Assert-Hq '-StartAll'
    $script:StartHq = $false
    $psExe = Join-Path $PSHOME 'powershell.exe'
    foreach ($m in $script:HqProblems) { Write-Host "In bin\relay-settings.json, $m" }
    foreach ($p in $script:HqProjects) {
        $relayPs1 = Join-Path $p.mailbox 'bin\bridge-relay.ps1'
        if (-not (Test-Path -LiteralPath $relayPs1 -PathType Leaf)) { Write-Host "Skipped $($p.id): $relayPs1 was not found (run -UpdateProjects to copy the relay there)."; continue }
        $li = Get-LockInfo (Join-Path $p.mailbox '.relay\relay.lock')
        if ($li.held) { Write-Host "Skipped $($p.id): its relay already runs (pid $($li.info.pid))."; continue }
        # One argument string with each part quoted as needed: Start-Process would join a list without quotes.
        $argString = (@('-NoProfile', '-ExecutionPolicy', 'Bypass', '-NoExit', '-File', $relayPs1, '-Start') | ForEach-Object { ConvertTo-ArgToken $_ }) -join ' '
        try {
            $proc = Start-Process -FilePath $psExe -ArgumentList $argString -WorkingDirectory $p.mailbox -PassThru
            Write-Host "Started the relay of $($p.id) ($($p.name)) in a new window (pid $($proc.Id)), for the mailbox $($p.mailbox)."
        } catch { Write-Host "Could not start the relay of $($p.id): $($_.Exception.Message)" }
    }
    $li = Get-LockInfo
    if ($li.held) { Write-Host "HQ's own relay already runs (pid $($li.info.pid)), so it is not started again."; return }
    Write-Host "HQ's own relay runs in this window now. To stop them all, run -StopAll from another window."
    $script:StartHq = $true
}

function Invoke-StopAll {
    # Owner only, in HQ: asks every relay loop to stop the way -Stop does (a STOP file in its .relay), HQ's too.
    # It never kills anything; a turn that runs keeps running.
    Assert-Hq '-StopAll'
    $targets = New-Object System.Collections.ArrayList
    foreach ($p in $script:HqProjects) { [void]$targets.Add(@{ label = "Project $($p.id)"; dir = $p.mailbox }) }
    [void]$targets.Add(@{ label = 'HQ'; dir = $Root })
    $asked = New-Object System.Collections.ArrayList
    $poll = 1
    foreach ($t in $targets) {
        $lf = Join-Path $t.dir '.relay\relay.lock'
        $li = Get-LockInfo $lf
        if (-not $li.held) { Write-Host "$($t.label): its relay is not running."; continue }
        if ($li.info.mode -ne 'Start') { Write-Host "$($t.label): a short relay command (pid $($li.info.pid), mode $($li.info.mode)) holds the lock and ends by itself."; continue }
        [IO.File]::WriteAllText((Join-Path $t.dir '.relay\STOP'), (Get-Date).ToString('yyyy-MM-dd HH:mm:ss', $Inv), $Utf8)
        $poll = [Math]::Max($poll, [int]$li.info.poll_seconds)
        [void]$asked.Add(@{ label = $t.label; lock = $lf; pid = $li.info.pid })
        Write-Host "$($t.label): asked its relay (pid $($li.info.pid)) to stop. A turn that runs is never cut off."
    }
    if ($asked.Count -eq 0) { return }
    $wait = 10 + 3 * $poll
    $deadline = (Get-Date).AddSeconds($wait)
    while ((Get-Date) -lt $deadline) {
        if (@($asked | Where-Object { (Get-LockInfo $_.lock).held }).Count -eq 0) { break }
        Start-Sleep -Milliseconds 500
    }
    foreach ($a in $asked) {
        if ((Get-LockInfo $a.lock).held) { Write-Host "$($a.label): its relay has not stopped after $wait s. It may be finishing a round. Check -Status there." }
        else { Write-Host "$($a.label): its relay stopped." }
    }
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
    $turn = Get-CoordinatorThreadTurn $State $tid
    if ($turn) { return $turn }
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
    # A Codex coordinator follows its thread name; a Gemini CLI session has no name to follow; another tool is never woken.
    $coordTool = Get-CoordTool $c
    if ($coordTool -eq 'codex') { Update-CodexCoordinatorFollow $State $ReadOnly $c; return }
    if ($coordTool -ne 'claude') { return }
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
    # One Codex thread has one job: a newer thread with the name that already has another job, or that works in the
    # coordinator's folder, is not followed.
    $other = Get-ThreadJobText $best.id 'planner'
    $coordFolder = Get-CoordinatorCodexFolder
    if (-not $other -and $coordFolder -and (Test-InFolder $cwd $coordFolder)) { $other = "working in the coordinator's folder $coordFolder" }
    if ($other) {
        if ($State.flags['follow_codex_job'] -ne $best.id) {
            $State.flags['follow_codex_job'] = $best.id
            Write-Log "The newest Codex thread named '$name' ($($best.id)) is already $other. The relay still wakes thread $cur."
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
        # One Codex thread has one job: a newer thread with the name that already has another job, or that works in the
        # coordinator's folder, is not followed.
        $other = Get-ThreadJobText $best.id ('agent:' + $key)
        $coordFolder = Get-CoordinatorCodexFolder
        if (-not $other -and $coordFolder -and (Test-InFolder $cwd $coordFolder)) { $other = "working in the coordinator's folder $coordFolder" }
        if ($other) {
            $jobFlag = 'follow_agent_job_' + $key
            if ($State.flags[$jobFlag] -ne $best.id) {
                $State.flags[$jobFlag] = $best.id
                Write-Log "The newest Codex thread named '$($ag.name)' ($($best.id)) is already $other. The relay still wakes thread $cur for its mail."
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
    if ($HqRole) { Write-HqProblems $State }
    Update-Dispatches $State
    Update-CodexDispatches $State
    Update-MailDispatches $State
    Update-StartLaunching $State $ReadOnly   # start requests left 'launching' are settled first
    if (-not $ReadOnly) { [void](Test-RelayFiles $State 'while the relay ran') }   # the guard on the relay's own files (nothing while it is off)
    # After the turns that ended are recorded, so a rollover never cuts into a running turn.
    Update-Follow $State $ReadOnly
    $coord = Get-Coordinator
    $settling = Update-Inbound $State $baseline
    Update-Workers $State $baseline
    Update-Attention $State $baseline
    Update-StartRequests $State ($baseline -or -not $State.start_baseline_utc) $coord   # start files there at the first look count as known
    if ($settling -gt 0) { Write-Note "Debounce: $settling inbound file(s) still settling (changed less than $DebounceSeconds s ago); looking again later" }
    if ($baseline) {
        $State.baseline_utc = Get-Now
        if ($ReadOnly) { Write-Note ('DRY-RUN: no baseline yet; the first -Once/-Start will mark {0} Codex file revision(s) and {1} worker run(s) as already seen.' -f $State.files.Count, $State.workers.Count) }
        else { Write-Log ('Baseline recorded: {0} Codex file revision(s) and {1} worker run(s) marked as already seen; nothing dispatched.' -f $State.files.Count, $State.workers.Count) }
    }
    Invoke-StartRequests $State $coord $ReadOnly   # before the coordinator turn, so its refusal notes ride this turn
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
            $coordTool = Get-CoordTool $coord
            if ($coordTool -eq 'claude') {
                $id = 'R<dry-run>'
                $batch = @($pending | Select-Object -First 20)
                $prompt = New-Prompt $id $batch
                Write-Note ("DRY-RUN: would dispatch {0} item(s) to session {1} (cwd {2}). No CLI started, no key decrypted, no API credit used." -f $batch.Count, $coord.session_id, $coord.cwd)
                Write-Host ('  command: ' + $ClaudeExe + ' ' + (((Get-CliArguments $coord $prompt) | ForEach-Object { ConvertTo-ArgToken $_ }) -join ' '))
            } elseif ($coordTool -eq 'codex') {
                # R-dry-run, never R<dry-run>: the Codex notice keeps plain characters only, so < and > would go.
                $batch = @($pending | Select-Object -First 10)
                $prompt = New-CoordinatorPrompt 'R-dry-run' $batch $coord
                $opts = Get-CoordinatorCodexOptions $coord   # a list, so a variable first
                Write-Note ("DRY-RUN: would dispatch {0} item(s) to the Codex coordinator thread {1} (folder {2}). Nothing started, nothing written." -f $batch.Count, $coord.session_id, $coord.cwd)
                Write-Host ('  command: ' + (Get-CodexExePath) + ' ' + (Get-CodexCommandLine @() (Get-CoordinatorCodexTarget $coord) $prompt $opts))
            } else {
                # Placeholder until the Gemini CLI coordinator turn is built (design section 15.2).
                Write-Note ("DRY-RUN: would not dispatch {0} item(s): this relay cannot wake a coordinator in {1} yet. Nothing started, nothing written." -f $pending.Count, (Get-ToolName $coordTool))
            }
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
    Initialize-RelayGuard $state   # the guard's first look, before the first tick
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
    if (Get-StartRequestsOn (Get-Coordinator)) {
        $swait = @($state.starts.Values | Where-Object { ($_ -is [hashtable]) -and $_.state -eq 'new' }).Count
        $slimit = $(if ($MaxWorkerStartsPerDay -eq 0) { 'no limit' } else { [string]$MaxWorkerStartsPerDay })
        Write-Note ("Start requests: {0} wait; {1} started today (limit {2})" -f $swait, [int]$state.daily.worker_starts, $slimit)
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
    $hqWord = ''
    if ($HqRole) { $hqWord = " HQ for $($script:HqProjects.Count) project(s)." }
    $coordLoop = Get-Coordinator
    $coordWord = 'Coordinator=NOT_ENROLLED'
    if ($coordLoop) { $coordWord = 'Coordinator=' + (Get-CoordTool $coordLoop) }
    # The state and the guard's first look come before this line: a test that waits for it changes no file too early.
    $state = Get-State
    Initialize-RelayGuard $state
    $guardWord = ''
    if ($script:GuardOn) { $guardWord = ' Guard=ON.' }
    Write-Log "Relay loop started (pid $PID; mailbox $Root; poll $PollSeconds s; debounce $DebounceSeconds s). Stop: bridge-relay.ps1 -Stop, or Ctrl+C here. $coordWord. $cxWord. $amWord.$hqWord$guardWord"
    try {
        try { Invoke-Tick $state $false } catch { Write-Log "Tick error: $($_.Exception.Message)" }
        $last = Get-Now
        $dirty = $false
        while ($true) {
            if (Test-Path -LiteralPath $StopFile) { Write-Log 'Stop requested; leaving the loop. An in-flight coordinator turn keeps running and is reconciled on the next start.'; break }
            $r = $fsw.WaitForChanged([IO.WatcherChangeTypes]::All, 1000)
            # HQ: a project relay's own notes (projects\<id>\.relay\...) are not news for HQ either.
            if (-not $r.TimedOut -and $r.Name -and -not $r.Name.StartsWith('.relay', [StringComparison]::OrdinalIgnoreCase) -and
                -not ($HqRole -and $r.Name -match '\\\.relay(\\|$)')) { $dirty = $true }
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

function Get-EnrollWaitText([hashtable]$State) {
    # -Enroll never changes the coordinator while one of its turns runs (any tool). '' when nothing holds it. -Enroll
    # holds the writer lock, so no relay loop runs now: a record still 'running' or 'launching' was left by a relay that
    # stopped (-Stop). An ended Claude Code turn does not hold it: the next tick settles that turn from its own record.
    # A Codex or Gemini CLI turn holds it until the relay settles it, even when it has ended, because settling it looks
    # at the coordinator's own files (its orders file for the guard, its folder's STATUS.md). A 'launching' record has
    # no process to look at, so it holds it too. The words say how to settle a turn without starting a new one.
    $how = 'make an empty file named PAUSE in .relay, run -Once, enroll again, then delete PAUSE. Nothing was saved.'
    foreach ($d in @($State.dispatches.Values)) {
        $claudeTurn = ((Get-DispatchTool $d) -eq 'claude')
        if ($d.state -eq 'running' -and (Test-DispatchAlive $d)) {
            if ($claudeTurn) { return "Coordinator turn $($d.id) is still running. Enroll again after it ends (-Status shows it). Nothing was saved." }
            return "Coordinator turn $($d.id) is still running. Wait until it ends (-Status shows it). Then settle it without a new turn: $how"
        }
        if ($d.state -eq 'running' -and -not $claudeTurn) { return "Coordinator turn $($d.id) has ended, but the relay has not settled it yet. To settle it without a new turn: $how" }
        if ($d.state -eq 'launching') { return "Coordinator turn $($d.id) was being started when the relay stopped, and the relay has not settled it yet. To settle it without a new turn: $how" }
    }
    return ''
}

function Backup-RelayFile([string]$Path) {
    # Owner commands keep a copy before they change a file: .relay\backups\<name>.<time>.bak, then -2, -3, ...
    # Returns the copy's path, or '' when there was no file. Only under the writer lock (every -Enroll holds it).
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return '' }
    $dir = Join-Path $RelayDir 'backups'
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    $stem = (Split-Path -Leaf $Path) + '.' + (Get-Date).ToString('yyyyMMdd-HHmmss', $Inv)
    $dest = Join-Path $dir "$stem.bak"
    $n = 2
    while (Test-Path -LiteralPath $dest) { $dest = Join-Path $dir "$stem-$n.bak"; $n++ }
    Copy-Item -LiteralPath $Path -Destination $dest
    return $dest
}

function Invoke-Enroll {
    $busy = Get-EnrollWaitText (Get-State)
    if ($busy) { Fail $busy }
    if ($EnrollTool -eq 'codex') { Invoke-EnrollCodexCoordinator; return }
    if ($EnrollTool -eq 'gemini') { Invoke-EnrollGeminiCoordinator; return }
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
    $coord = @{ tool = 'claude'; session_id = $sid; cwd = $cwd; transcript_path = $transcript; enrolled_utc = (Get-Now); enrolled = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss', $Inv);
        follow_name = [string]$SessionName; started_ms = (Get-ClaudeStarted $transcript);
        verified = $verified;
        model = [string]$Model; effort = [string]$Effort;
        allowed_checks = $CheckList.ToArray();
        resume_rule = 'claude -p <notice> --resume <session_id> using subscription login only; never --continue, --fork-session or --no-session-persistence' }
    $kept = Backup-RelayFile $CoordFile   # a copy of the old record first, even when only the checks, model or effort change
    Save-Json $CoordFile $coord
    $state = Get-State
    [void]$state.flags.Remove('last_block')
    Update-StartRequests $state $true $coord   # start files that are there now count as known: never run
    Save-State $state
    if ($SessionName) {
        Write-Log "Enrolled coordinator session $sid (cwd $cwd), the newest session named '$SessionName'. When a newer session takes that name, the relay wakes it instead, on its own. Model: $(if ($Model) { $Model } else { 'CLI default' }); effort: $(if ($Effort) { $Effort } else { 'CLI default' })."
        if ($openNow) { Write-Log 'That session is open right now. The relay wakes it only after it is closed.' }
    } else {
        Write-Log "Enrolled coordinator session $sid (cwd $cwd). Verified: transcript present, not running. Model: $(if ($Model) { $Model } else { 'CLI default' }); effort: $(if ($Effort) { $Effort } else { 'CLI default' })."
    }
    Write-Log ('Allowed checks (operator-enrolled, granted as Bash(<prefix>*)): ' + $(if ($CheckList.Count) { ($CheckList | ForEach-Object { "'" + $_ + "'" }) -join ', ' } else { 'none' }) +
        '. To change them, exit the coordinator session and run -Enroll again.')
    if ($kept) { Write-Log "The coordinator.json from before is kept as $kept." }
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
    $other = Get-ThreadJobText $tid 'planner'   # one Codex thread has one job
    if ($other) { Fail "Codex thread $tid is already $other. One Codex thread has one job: pick another thread." }
    $found = Find-CodexRollout $tid
    if (-not $found) {
        Fail "No Codex thread $tid found under $CodexHomeDir\sessions. Take the id from the thread itself (Pleni shows it in the thread's details), and pass -CodexHome if Codex keeps its files elsewhere."
    }
    if ($found.archived) { Fail "Codex thread $tid is archived. Unarchive it in Codex first, or enroll another thread." }
    $cwd = ''
    if ($CodexCwd) { $cwd = [IO.Path]::GetFullPath($CodexCwd).TrimEnd('\') } else { $cwd = Get-CodexThreadCwd $found.path }
    if (-not $cwd) { Fail "Could not read the thread's working folder from the first line of $($found.path). Pass -CodexCwd <folder>." }
    if (-not (Test-Path -LiteralPath $cwd -PathType Container)) { Fail "The Codex thread's working folder was not found: $cwd" }
    $coordFolder = Get-CoordinatorCodexFolder   # the folder of a Codex or Gemini CLI coordinator, or ''
    if ($coordFolder -and (Test-InFolder $cwd $coordFolder)) { Fail "The folder $cwd is this mailbox's coordinator's folder, or inside it. Give the planner a folder of its own." }
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
    $other = Get-ThreadJobText $named.id ('agent:' + $key)   # one Codex thread has one job
    if ($other) { Fail "Codex thread $($named.id) is already $other. One Codex thread has one job: pick another thread." }
    $own = Get-AgentCleanName ([string]$script:IndexCache.names[$named.id])
    if ($own -and $own -match $AgentNameRe -and (Get-AgentKey $own) -eq $key) { $name = $own }
    $cwd = Get-CodexThreadCwd $named.path
    if (-not $cwd) { Fail "Could not read the folder of Codex thread $($named.id) from the first line of $($named.path)." }
    if (-not (Test-Path -LiteralPath $cwd -PathType Container)) { Fail "The folder of Codex thread $($named.id) was not found: $cwd" }
    $coordFolder = Get-CoordinatorCodexFolder   # the folder of a Codex or Gemini CLI coordinator, or ''
    if ($coordFolder -and (Test-InFolder $cwd $coordFolder)) { Fail "The folder $cwd is this mailbox's coordinator's folder, or inside it. Give the agent a folder of its own." }
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
    if ($coord -and (Get-CoordTool $coord) -ne 'claude') {
        Show-ToolCoordinatorStatus $state $coord   # a Codex or Gemini CLI coordinator, or a tool the relay does not know
    } elseif ($coord) {
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
    if ($HqDirSetting) { Write-Host "HQ folder of this project mailbox: $HqDirSetting (hq_dir in bin\relay-settings.json)" }
    if ($HqRole) { Show-HqProjects }
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
    # Start requests: shown while they are on, or while the relay keeps a record of one that ran or waits.
    $startsOn = Get-StartRequestsOn $coord
    $startRecs = @($state.starts.Values | Where-Object { ($_ -is [hashtable]) -and $_.state -ne 'known' } | Sort-Object { [int64]$_.detected_utc } -Descending)
    if ($startsOn -or $startRecs.Count) {
        $startLimit = $(if ($MaxWorkerStartsPerDay -eq 0) { 'no limit' } else { [string]$MaxWorkerStartsPerDay })
        Write-Host ("Start requests: {0}; {1} wait; {2} started today (limit {3})" -f $(if ($startsOn) { 'ON' } else { 'OFF (start_requests in bin\relay-settings.json)' }),
            @($startRecs | Where-Object { $_.state -eq 'new' }).Count, [int]$state.daily.worker_starts, $startLimit)
        foreach ($sr in @($startRecs | Select-Object -First 5)) { Write-Host ("  - {0}: {1} {2}" -f $sr.key, $sr.state, (Get-Short ([string]$sr.message) 160)) }
    }
    if (Test-GuardWanted) { Write-Host "Relay files guard: ON (a Codex or Gemini CLI coordinator, or start requests): a change to bin, tests, the settings, the coordinator's orders file or the relay's records halts the relay." }
    $recent = @($state.dispatches.Values | Sort-Object { [int64]$_.seq } -Descending | Select-Object -First 5)
    if ($recent.Count) { Write-Host 'Recent dispatches:' }
    foreach ($d in $recent) {
        # A Claude Code turn shows its cost, as before; Codex and Gemini CLI turns report none, so their tool is shown.
        $what = ('cost {0} USD' -f $d.cost)
        if ($null -eq $d.cost) { $what = Get-ToolName (Get-DispatchTool $d) }
        Write-Host ("  - {0} {1}: {2} ({3}, items {4})" -f $d.id, $d.state, (Get-Short ([string]$d.outcome + ' ' + [string]$d.error) 160), $what, @($d.items).Count)
    }
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
        foreach ($n in $cpend) {
            $where = [string]$n.task
            if ($n.project) { $where = "$($n.project) $($n.task)" }
            Write-Host ("  - {0}: {1} (detected {2}, attempts {3})" -f $where, $n.what, (Format-Unix $n.detected_utc), $n.attempts)
        }
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
    $att = $null
    if ($HqRole) { $att = Get-HqAttentionItems } else { $att = Get-AttentionItems }
    Write-Host "Codex attention (return direction): $($att.Count)"
    foreach ($k in @($att.Keys | Sort-Object)) { Write-Host ("  - {0}: {1}" -f $k, $att[$k].what) }
    if ($cx) { Write-Host "CodexWake=ON (each new item above wakes Codex thread $($cx.thread_id) once; -UnenrollCodex turns it off)" }
    else { Write-Host 'CodexWake=NOT_CONFIGURED (the relay does not wake Codex; to turn that on: bridge-relay.ps1 -EnrollCodex -ThreadId <thread id>)' }
}

function Show-CoordinatorArgs {
    # Read-only (no lock, no CLI, no key): the exact permission values and --add-dir directories Get-CliArguments passes
    # to a coordinator turn, for the enrolled coordinator, or the MailboxRoot defaults when none is enrolled. For a Codex
    # coordinator: the codex exec arguments of its turn, the folders it may write, and its board.
    $coord = Get-Coordinator
    if ($coord -and (Get-CoordTool $coord) -eq 'codex') {
        $opts = Get-CoordinatorCodexOptions $coord   # each list into a variable first, never @(<function>)
        $cliArgs = Get-CodexArguments (Get-CoordinatorCodexTarget $coord) '<notice>' $opts
        $board = ''
        if ($coord.cwd) { try { $board = Join-Path ([string]$coord.cwd) 'STATUS.md' } catch { $board = '' } }   # 5.1: Join-Path throws for a drive that is not there
        $o = [ordered]@{ tool = 'codex'; codexArgs = $cliArgs.ToArray(); writableFolders = @([string]$coord.cwd, (Join-Path $Root 'tasks'));
            network = $false; board = $board }
        Write-Output (ConvertTo-Json -InputObject $o -Depth 4)
        return
    }
    $o = [ordered]@{ allowedTools = @(Get-CoordinatorTools $coord); disallowedTools = @(Get-CoordinatorDeny); addDirs = @(Get-CoordinatorAddDirs $coord);
        appendSystemPrompt = (Get-RelayRules $coord) }
    Write-Output (ConvertTo-Json -InputObject $o -Depth 4)
}

# ---------- the guard on the relay's own files ----------
# The relay runs bin\spawn-worker.ps1 outside any sandbox when a start request asks, and a Codex or Gemini CLI turn
# works in a folder of its own. So while either can happen, the relay watches its own files: the programs (bin\*.ps1,
# tests\*.js), the two settings files, a Codex or Gemini CLI coordinator's orders file, and the records the relay writes
# itself (.relay\coordinator.json, codex.json, agents.json). A change the relay did not make halts it with a plain
# alert. It is a backstop, not a lock: it sees a change only when it looks (each tick, right before each worker start
# and each Codex or Gemini CLI turn, and when the next relay starts, for a turn that an earlier relay left running).
# With a Claude Code coordinator and start requests off (every mailbox today), the guard is off.

function Test-GuardWanted {
    # On while .relay\coordinator.json names codex or gemini, or while start requests are on. Initialize-RelayGuard
    # decides it once per relay process: -Enroll needs the writer lock, so the coordinator's tool cannot change meanwhile.
    $c = Get-Coordinator
    $t = Get-CoordTool $c
    return [bool](($c -and ($t -eq 'codex' -or $t -eq 'gemini')) -or (Get-StartRequestsOn $c))
}

function Get-GuardFiles {
    # The program files: bin\*.ps1 and tests\*.js (by their extension, as -Filter also matches 8.3 short names), the
    # two settings files, and a Codex or Gemini CLI coordinator's orders file in its own folder, which a Codex
    # coordinator can write. The relay never writes any of them.
    $list = New-Object System.Collections.Generic.List[string]
    foreach ($pair in @(@('bin', '.ps1'), @('tests', '.js'))) {
        $dir = Join-Path $Root $pair[0]
        if (-not (Test-Path -LiteralPath $dir -PathType Container)) { continue }
        foreach ($f in @(Get-ChildItem -LiteralPath $dir -File -Force -ErrorAction SilentlyContinue)) {
            if ($f.Extension -ieq $pair[1]) { $list.Add($f.FullName) }
        }
    }
    foreach ($p in @((Join-Path $Root 'bin\relay-settings.json'), (Join-Path $Root 'bin\cost-limits.json'))) { $list.Add($p) }
    $c = Get-Coordinator
    $ct = Get-CoordTool $c
    if ($c -and $c.cwd -and ($ct -eq 'codex' -or $ct -eq 'gemini')) {
        $orders = 'AGENTS.md'
        if ($ct -eq 'gemini') { $orders = 'GEMINI.md' }
        try { $list.Add((Join-Path ([string]$c.cwd) $orders)) } catch { }
    }
    return , $list.ToArray()
}

function Get-RelayFileStamp([string]$Path) {
    # missing, folder, unreadable, or <length>:<sha256>. A link (a reparse point) gets link: and then what it points
    # to, read through the link (folder, missing, unreadable or its SHA-256), so both a link put where the file was and
    # a change behind a link that was always there count as changes. A read that fails is tried twice more, 100 ms
    # apart, so a file that another program holds for a moment is no change. Never throws.
    $stamp = 'unreadable'
    for ($attempt = 1; $attempt -le 3; $attempt++) {
        $link = ''
        try {
            $fi = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
            if ($fi.Attributes -band [IO.FileAttributes]::ReparsePoint) { $link = 'link:' }
            if ($fi.PSIsContainer) { return ($link + 'folder') }
            if ($link) { return ($link + (Get-FileSha256 $Path)) }   # a link's own length is not the length of what it points to
            return ($fi.Length.ToString($Inv) + ':' + (Get-FileSha256 $Path))
        } catch {
            $there = $true
            try { $there = [bool](Test-Path -LiteralPath $Path) } catch { $there = $true }
            if (-not $there) { return ($link + 'missing') }
            $stamp = $link + 'unreadable'
        }
        if ($attempt -lt 3) { Start-Sleep -Milliseconds 100 }
    }
    return $stamp
}

function Get-RelayFileStamps([bool]$ProgramOnly = $false) {
    # Each watched file's stamp, by its full path. $ProgramOnly: the program files only (what a Codex or Gemini CLI
    # turn's record keeps); else the relay's records too.
    $s = @{}
    $files = Get-GuardFiles   # a variable first: @(<function>) would keep the list as one item
    foreach ($f in $files) { $s[$f] = Get-RelayFileStamp $f }
    if (-not $ProgramOnly) { foreach ($f in @($CoordFile, $CodexFile, $AgentsFile)) { $s[$f] = Get-RelayFileStamp $f } }
    return $s
}

function Get-RelayFileChange([hashtable]$Old, [hashtable]$New) {
    # The paths whose stamps differ, files that came or went included. Only the keys of $New are looked up in $Old, so
    # a set of program files only is compared with the program files only. A file that is missing now and was not
    # looked at before is no change.
    $out = New-Object System.Collections.Generic.List[string]
    foreach ($k in @($New.Keys)) {
        $was = $Old[$k]
        if ($null -eq $was) {
            if ([string]$New[$k] -cne 'missing') { $out.Add([string]$k) }
        } elseif ([string]$was -cne [string]$New[$k]) { $out.Add([string]$k) }
    }
    foreach ($k in @($Old.Keys)) { if (-not $New.ContainsKey($k) -and [string]$Old[$k] -cne 'missing') { $out.Add([string]$k) } }
    return , $out.ToArray()
}

function Initialize-RelayGuard([hashtable]$State) {
    # Once per relay process (-Once, -Start), before its first tick and before Invoke-Loop's 'Relay loop started' line,
    # so a test that waits for that line never changes a file before the first look.
    $script:GuardOn = Test-GuardWanted
    $script:RelayStamps = $null
    if (-not $script:GuardOn) { return }
    $script:RelayStamps = Get-RelayFileStamps $false
    # A Codex or Gemini CLI turn that an earlier relay left running keeps the program files' stamps from its start in its
    # record, so a change made while no relay ran is caught before anything runs.
    $now = Get-RelayFileStamps $true
    foreach ($d in @($State.dispatches.Values)) {
        if (-not ($d -is [hashtable]) -or ($d.state -ne 'running' -and $d.state -ne 'launching') -or -not ($d.guard -is [hashtable])) { continue }
        $changed = Get-RelayFileChange $d.guard $now
        if ($changed.Count) { Set-GuardHalt $State $changed "while coordinator turn $($d.id) ran"; $d.guard = $null }
    }
}

function Test-RelayFiles([hashtable]$State, [string]$When) {
    # True when no watched file changed since the last look. Called once per tick, right before each worker start, and
    # right before each Codex or Gemini CLI turn. A change halts the relay. Always true while the guard is off.
    if (-not $script:GuardOn -or $null -eq $script:RelayStamps) { return $true }
    $now = Get-RelayFileStamps $false
    $changed = Get-RelayFileChange $script:RelayStamps $now
    if ($changed.Count -eq 0) { return $true }
    Set-GuardHalt $State $changed $When $now
    return $false
}

function Set-GuardHalt([hashtable]$State, [string[]]$Changed, [string]$When, $Seen = $null) {
    # Halts the relay with a plain alert. Each change is reported once: the files as they are now ($Seen, or a new look)
    # become the next look.
    $all = @(@($Changed) | ForEach-Object { if ($_.StartsWith($Root + '\', [StringComparison]::OrdinalIgnoreCase)) { $_.Substring($Root.Length + 1) } else { $_ } })
    $names = (@($all | Select-Object -First 10)) -join ', '
    if ($all.Count -gt 10) { $names += " and $($all.Count - 10) more" }
    $State.halt = "relay files changed ${When}: $names"
    Add-Alert $State '' ("The relay stopped: $names changed ${When}. A session or a worker may have made the change. Look at it before you start the relay again. " +
        'If you made it yourself, run bridge-relay.ps1 -Stop (if the loop runs), then -ClearHalt, then start the relay again. Until then no coordinator turn and no worker starts.')
    Write-Log "HALT: relay files changed ${When}: $names"
    if ($script:GuardOn) {
        if ($Seen -is [hashtable]) { $script:RelayStamps = $Seen } else { $script:RelayStamps = Get-RelayFileStamps $false }
    }
}

function Update-RelayFileStamp([string]$Path) {
    # Save-Json calls this after each write, so the relay's own changes to its records are no change for the guard.
    # Never throws, so a save never fails because of the guard.
    try {
        if ($null -eq $script:RelayStamps -or -not $script:RelayStamps.ContainsKey($Path)) { return }
        $script:RelayStamps[$Path] = Get-RelayFileStamp $Path
    } catch { }
}

# ---------- start requests (W<n>-start.md) ----------
# A coordinator that cannot run bin\spawn-worker.ps1 itself writes tasks\<TASK-ID>\workers\W<n>-start.md (from
# templates\worker-start.md) beside the worker's brief. Between coordinator turns, the relay checks it and runs the
# mailbox's own bin\spawn-worker.ps1 for it. Each version of the file (its SHA-256) runs at most once: a 'launching'
# record is saved before the launcher starts, and a stop while it runs is settled from what the files show, never by
# running it again. Only one launcher runs at a time, at most 5 a round and relay_max_worker_starts_per_day a day
# (bin\cost-limits.json; 12 unless set). A refusal comes back to the coordinator as a note in its next turn; a worker
# that started ends as any worker does (its run.json).

function Get-StartRequestsOn($Coord) {
    # start_requests in bin\relay-settings.json wins when it is a real true or false (the text "true" does not count);
    # else start requests are on only for a Codex or Gemini CLI coordinator.
    if ($StartRequestsSetting -is [bool]) { return $StartRequestsSetting }
    $coordTool = Get-CoordTool $Coord
    return [bool]($Coord -and ($coordTool -eq 'codex' -or $coordTool -eq 'gemini'))
}

function Get-StartBlockReason([hashtable]$State, $Coord) {
    # What holds every start request back this round, as @{ code; text }, or $null. A held request is not refused: it
    # waits. STOP needs nothing here: the loop leaves before the next tick.
    if (-not (Get-StartRequestsOn $Coord)) { return @{ code = 'off'; text = 'start requests are off (start_requests in bin\relay-settings.json; on by default only for a Codex or Gemini CLI coordinator)' } }
    if (Test-Path -LiteralPath $PauseFile) { return @{ code = 'paused'; text = "PAUSED ($PauseFile exists)" } }
    if ($State.halt) { return @{ code = 'halted'; text = "HALTED: $($State.halt)" } }
    foreach ($d in @($State.dispatches.Values)) {
        if ($d.state -eq 'running' -or $d.state -eq 'launching') { return @{ code = 'coordinator-turn'; text = "a coordinator turn runs ($($d.id)); workers start after it ends" } }
    }
    if (@($State.starts.Values | Where-Object { ($_ -is [hashtable]) -and $_.state -eq 'launching' }).Count) { return @{ code = 'launching'; text = 'the launcher of an earlier start request has not finished yet' } }
    if ($MaxWorkerStartsPerDay -gt 0 -and [int]$State.daily.worker_starts -ge $MaxWorkerStartsPerDay) {
        Add-Alert $State ('cap-starts-' + $State.daily.date) ("Daily limit of worker starts reached ($MaxWorkerStartsPerDay a day: relay_max_worker_starts_per_day in bin\cost-limits.json). " +
            'The other start requests wait until tomorrow. Possible loop: check .relay\relay.log.')
        return @{ code = 'cap-starts'; text = "the daily limit of worker starts is reached ($([int]$State.daily.worker_starts)/$MaxWorkerStartsPerDay; relay_max_worker_starts_per_day in bin\cost-limits.json)" }
    }
    return $null
}

function Get-StartFiles {
    # Every tasks\<TASK-ID>\workers\W<n>-start.md, found with -LiteralPath (a mailbox path may hold [ or ]). Its folder
    # names the task and its name the worker, both checked as bin\spawn-worker.ps1 checks -TaskId and -Worker.
    $out = New-Object System.Collections.ArrayList
    $td = Join-Path $Root 'tasks'
    if (-not (Test-Path -LiteralPath $td -PathType Container)) { return , $out.ToArray() }
    foreach ($t in @(Get-ChildItem -LiteralPath $td -Directory -ErrorAction SilentlyContinue)) {
        if ($t.Name -notmatch '^T-\d{8}-\d{2}-[a-z0-9-]+$') { continue }
        $wd = Join-Path $t.FullName 'workers'
        if (-not (Test-Path -LiteralPath $wd -PathType Container)) { continue }
        foreach ($f in @(Get-ChildItem -LiteralPath $wd -File -ErrorAction SilentlyContinue)) {
            $m = [regex]::Match($f.Name, '^[Ww](\d{1,3})-start\.md$')
            if (-not $m.Success) { continue }
            $w = 'W' + $m.Groups[1].Value
            [void]$out.Add(@{ key = "$($t.Name)/$w"; task = $t.Name; worker = $w; path = $f.FullName; write = $f.LastWriteTimeUtc })
        }
    }
    return , $out.ToArray()
}

function Update-StartRequests([hashtable]$State, [bool]$Known, $Coord) {
    # Records each new version (SHA-256) of every start file once it is older than the debounce. At the first look and
    # at enrollment ($Known) every version there counts as known, however new it is: it never runs. A record that is
    # being started is left alone.
    $now = Get-Now
    $files = Get-StartFiles   # a variable first: @(<function>) would keep the list as one item
    foreach ($f in $files) {
        if (-not $Known -and ([DateTime]::UtcNow - $f.write).TotalSeconds -lt $DebounceSeconds) { continue }   # still being written
        $h = ''
        try { $h = Get-FileSha256 $f.path } catch { continue }
        $r = $State.starts[$f.key]
        if (($r -is [hashtable]) -and $r.state -eq 'launching') { continue }   # settled first (Update-StartLaunching)
        if (($r -is [hashtable]) -and [string]$r.version -eq $h) {
            if ($Known -and $r.state -eq 'new') { $r.state = 'known' }   # at enrollment, a version that waits counts as known
            continue
        }
        $word = 'new'   # never $state: PowerShell names are not case-sensitive, so it would be $State
        if ($Known) { $word = 'known' }
        # The runner that an earlier version started is kept, so Test-WorkerRuns still sees it while it runs.
        $runnerPid = 0
        $runnerStart = ''
        if ($r -is [hashtable]) {
            try { $runnerPid = [int]$r.runner_pid } catch { $runnerPid = 0 }
            $runnerStart = [string]$r.runner_start
        }
        $State.starts[$f.key] = @{ key = $f.key; task = $f.task; worker = $f.worker; version = $h; state = $word; id = '';
            detected_utc = $now; launched_utc = 0; finished_utc = 0; launcher_pid = 0; launcher_start = ''; runner_pid = $runnerPid; runner_start = $runnerStart;
            tool = ''; type = ''; new_worktree = $false; result_file = ''; out = ''; err = ''; stdin = ''; message = ''; gone_utc = 0 }
        if (-not $Known) { Write-Log "Detected: start request $($f.worker)-start.md of $($f.task) (version $($h.Substring(0, 12)))" }
    }
    if ($Known) { $State.start_baseline_utc = $now }
}

function Get-StartRequestFields([hashtable]$R) {
    # Reads W<n>-start.md. Returns @{ wait; problem; tool; type; budget; model; effort; new_worktree }: wait is true when
    # the file is not the version the record names (the next round looks again); problem says in plain words why the
    # relay refuses the request. The Tool and Type lines must be there, and a field line in another shape (such as
    # - **Tool**: codex or * Type: review) is refused, so a request never runs with a tool or a type it did not name.
    $q = @{ wait = $false; problem = ''; tool = ''; type = ''; budget = ''; model = ''; effort = ''; new_worktree = $false }
    $fieldNames = @{ tool = 'Tool'; type = 'Type'; budget = 'Budget USD'; budgetusd = 'Budget USD'; model = 'Model'; effort = 'Effort'; newworktree = 'New worktree'; requested = 'Requested' }
    $seen = @{}
    $path = Get-StartFilePath ([string]$R.task) ([string]$R.worker)
    $text = ''
    try {
        $fi = Get-Item -LiteralPath $path -Force -ErrorAction Stop
        if ($fi.Attributes -band [IO.FileAttributes]::ReparsePoint) { $q.problem = "$($R.worker)-start.md is a link, not a file"; return $q }
        if ($fi.Length -gt 8192) { $q.problem = "$($R.worker)-start.md is larger than 8 KB"; return $q }
        $h1 = Get-FileSha256 $path
        $text = Read-SharedText $path
        if ($h1 -ne [string]$R.version -or (Get-FileSha256 $path) -ne $h1) { $q.wait = $true; return $q }   # it changed: the next round looks again
    } catch { $q.wait = $true; return $q }
    foreach ($line in ($text -split "`r?`n")) {
        $m = [regex]::Match($line, '^\s*-\s*\*\*([A-Za-z ]+):\*\*\s*(.*?)\s*$')   # [regex]::Match leaves $Matches alone
        if (-not $m.Success) {
            # A list item (- * + or 1.), or a line that starts with * _ or `, that names a field in another shape. Plain
            # lines are no fields: the heading, the words, and the template's help lines (Tool: claude, codex, ...).
            $o = [regex]::Match($line, '(?i)^\s*(?:[-*+]|\d{1,3}[.)]|[_`])[\s*_`]*(tool|type|budget(?:\s*usd)?|model|effort|new\s*worktree|requested)[\s*_`]*:')
            if ($o.Success) {
                $f = $fieldNames[($o.Groups[1].Value -replace '\s', '').ToLowerInvariant()]
                $q.problem = "the $f line is not in the shape the relay reads; write it as - **${f}:** and then the value"
                return $q
            }
            continue
        }
        $label = $m.Groups[1].Value.Trim()
        $seen[$label.ToLowerInvariant()] = $true
        $v = $m.Groups[2].Value.Trim().Trim('`').Trim()
        $vl = $v.ToLowerInvariant()
        # No continue or break inside this switch: there they would act on the switch, not on the loop.
        switch ($label.ToLowerInvariant()) {
            'tool' {
                $q.tool = $vl
                if (@('claude', 'codex', 'gemini', 'antigravity') -notcontains $vl) { $q.problem = "Tool must be claude, codex, gemini or antigravity (got '$v')" }
            }
            'type' {
                $q.type = $vl
                if (@('implementation', 'review') -notcontains $vl) { $q.problem = "Type must be implementation or review (got '$v')" }
            }
            'budget usd' {
                if ($v) {
                    $b = 0.0
                    if (-not [double]::TryParse($v, [Globalization.NumberStyles]::Float, $Inv, [ref]$b) -or [double]::IsNaN($b) -or $b -lt 0.05 -or $b -gt 25) {
                        $q.problem = "Budget USD must be a number from 0.05 to 25 (got '$v')"
                    } else { $q.budget = $b.ToString($Inv) }
                }
            }
            'model' {
                # The first character is a letter or a digit: a value that starts with - would be read as a parameter.
                if ($v) {
                    if ($v -cnotmatch '^[A-Za-z0-9][A-Za-z0-9._:\[\]-]{0,79}$') { $q.problem = "Model must be one word of letters, digits and . _ : [ ] -, starting with a letter or a digit (got '$v')" }
                    else { $q.model = $v }
                }
            }
            'effort' {
                if ($v) {
                    if (@('low', 'medium', 'high', 'xhigh', 'max') -notcontains $vl) { $q.problem = "Effort must be low, medium, high, xhigh or max (got '$v')" }
                    else { $q.effort = $vl }
                }
            }
            'new worktree' {
                if ($vl -eq 'yes') { $q.new_worktree = $true }
                elseif ($vl -and $vl -ne 'no') { $q.problem = "New worktree must be yes or no (got '$v')" }
            }
            'requested' { }
            default { $q.problem = "the line '$label' is not one the relay knows (Tool, Type, Budget USD, Model, Effort, New worktree, Requested)" }
        }
        if ($q.problem) { return $q }
    }
    # No default tool or type: a request that does not name them is refused, never run as a Claude Code implementation.
    if (-not $seen.ContainsKey('tool')) { $q.problem = 'the Tool line is missing; write it as - **Tool:** and then claude, codex, gemini or antigravity' }
    elseif (-not $seen.ContainsKey('type')) { $q.problem = 'the Type line is missing; write it as - **Type:** and then implementation or review' }
    return $q
}

function Get-StartRequestProblem([hashtable]$State, [hashtable]$R, [hashtable]$Q) {
    # Why the relay itself refuses this request, in plain words, or ''. The launcher checks everything else.
    if ($Q.problem) { return [string]$Q.problem }
    if ($WorkerToolsSetting -notcontains $Q.tool) {
        $on = (@($WorkerToolsSetting) -join ', ')
        if (-not $on) { $on = 'none' }
        return "$(Get-ToolName $Q.tool) workers are off: worker_tools in bin\relay-settings.json lists the AI tools that may run workers (now: $on)"
    }
    if (-not (Test-Path -LiteralPath (Join-Path $Root "tasks\$($R.task)\workers\$($R.worker)-brief.md") -PathType Leaf)) { return "its brief $($R.worker)-brief.md is not there; write the brief first" }
    if (-not (Test-Path -LiteralPath (Join-Path $Root 'bin\spawn-worker.ps1') -PathType Leaf)) { return 'bin\spawn-worker.ps1 is not in the mailbox' }
    $runs = Test-WorkerRuns $State ([string]$R.task) ([string]$R.worker)
    if ($runs) { return $runs }
    return ''
}

function Test-WorkerRuns([hashtable]$State, [string]$Task, [string]$W) {
    # '' unless the worker still runs: its run.json says running and its pid is alive, or the runner that a start request
    # started is still alive. The runner writes run.json only after the launcher returned, so its pid covers that gap.
    $rf = Join-Path $Root "tasks\$Task\workers\$W.run.json"
    if (Test-Path -LiteralPath $rf -PathType Leaf) {
        try {
            $s = ConvertTo-HT (ConvertFrom-Json -InputObject (Read-SharedText $rf))
            if (($s -is [hashtable]) -and [string]$s['state'] -eq 'running' -and $s['pid'] -and (Get-Process -Id ([int]$s['pid']) -ErrorAction SilentlyContinue)) {
                return "worker $W of $Task is still running (pid $($s['pid']))"
            }
        } catch { }
    }
    $r = $State.starts["$Task/$W"]
    $runner = 0
    if ($r -is [hashtable]) { try { $runner = [int]$r.runner_pid } catch { $runner = 0 } }
    if ($runner -gt 0) {
        $p = Get-Process -Id $runner -ErrorAction SilentlyContinue
        if ($p) {
            $same = $true
            if ($r.runner_start) { try { $same = ([string]$p.StartTime.ToUniversalTime().Ticks -eq [string]$r.runner_start) } catch { } }
            if ($same) { return "worker $W of $Task is still starting or running (runner pid $runner)" }
        }
    }
    return ''
}

function Invoke-StartRequests([hashtable]$State, $Coord, [bool]$ReadOnly) {
    # Runs the start requests that wait (state 'new'), oldest first. Invoke-Tick calls it before the coordinator turn of
    # the same tick, so the refusal notes ride that turn.
    $waiting = @($State.starts.Values | Where-Object { ($_ -is [hashtable]) -and $_.state -eq 'new' } | Sort-Object { [int64]$_.detected_utc })
    if ($waiting.Count -eq 0) { [void]$State.flags.Remove('last_start_block'); return }
    $why = Get-StartBlockReason $State $Coord
    if ($why) {
        $text = "$($waiting.Count) start request(s) wait: $($why.text)"
        if ($ReadOnly) { Write-Note "DRY-RUN: $text" }
        elseif ($State.flags['last_start_block'] -ne $why.code) { $State.flags['last_start_block'] = $why.code; Write-Log $text }
        else { Write-Note $text }
        return
    }
    [void]$State.flags.Remove('last_start_block')
    $done = 0
    foreach ($r in $waiting) {
        if ($done -ge 5) { break }   # at most 5 a round; the rest wait for the next one
        # Held; the next round says why. Each launcher can take a while, so PAUSE or a halt made meanwhile holds the rest.
        if ($MaxWorkerStartsPerDay -gt 0 -and [int]$State.daily.worker_starts -ge $MaxWorkerStartsPerDay) { break }
        if ((Test-Path -LiteralPath $PauseFile) -or $State.halt) { break }
        $q = Get-StartRequestFields $r
        if ($q.wait) { continue }
        $problem = Get-StartRequestProblem $State $r $q
        if ($ReadOnly) {
            if ($problem) { Write-Note "DRY-RUN: would not start worker $($r.worker) of $($r.task): $problem" }
            else {
                Write-Note ("DRY-RUN: would start worker {0} of {1} ({2}, {3}) with bin\spawn-worker.ps1. Nothing started." -f $r.worker, $r.task, $q.tool, $q.type)
                $words = Get-LauncherArguments $r $q (Join-Path $DispatchDir 'S-dry-run.result.json')
                Write-Host ('  command: ' + (Join-Path $PSHOME 'powershell.exe') + ' ' + (($words | ForEach-Object { ConvertTo-ArgToken $_ }) -join ' '))
            }
            $done++
            continue
        }
        if ($problem) { Set-StartRefused $State $r $problem; continue }
        if (-not (Test-RelayFiles $State 'before a worker start')) { break }
        Start-WorkerRequest $State $r $q
        $done++
        if ($r.state -eq 'launching') { break }   # its launcher still runs: only one launcher at a time
    }
}

function Get-LauncherArguments([hashtable]$R, [hashtable]$Q, [string]$ResultPath) {
    # The launcher's command line, from checked values only, each one its own argument.
    $a = New-Object System.Collections.Generic.List[string]
    foreach ($x in @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $Root 'bin\spawn-worker.ps1'),
            '-TaskId', [string]$R.task, '-Worker', [string]$R.worker, '-Type', [string]$Q.type, '-Tool', [string]$Q.tool, '-ResultFile', $ResultPath)) { $a.Add([string]$x) }
    if ($Q.tool -eq 'claude' -and $Q.budget) { $a.Add('-MaxBudgetUsd'); $a.Add([string]$Q.budget) }
    if ($Q.model) { $a.Add('-Model'); $a.Add([string]$Q.model) }
    if ($Q.effort) { $a.Add('-Effort'); $a.Add([string]$Q.effort) }
    if ($Q.new_worktree) { $a.Add('-NewWorktree') }
    return , $a
}

function Start-WorkerRequest([hashtable]$State, [hashtable]$R, [hashtable]$Q) {
    # Saves the 'launching' record first (write-ahead), then runs the mailbox's own bin\spawn-worker.ps1, hidden, with
    # its standard input from an empty file, and waits for it up to 120 s. It never stops the launcher.
    if (-not (Test-Path -LiteralPath $DispatchDir)) { New-Item -ItemType Directory -Path $DispatchDir -Force | Out-Null }
    $id = 'S' + (Get-Date).ToString('yyyyMMdd-HHmmss', $Inv) + '-' + [guid]::NewGuid().ToString('N').Substring(0, 4)
    $R.id = $id; $R.state = 'launching'; $R.tool = [string]$Q.tool; $R.type = [string]$Q.type; $R.new_worktree = [bool]$Q.new_worktree
    $R.launched_utc = Get-Now; $R.finished_utc = 0; $R.launcher_pid = 0; $R.launcher_start = ''; $R.message = ''
    $R.result_file = Join-Path $DispatchDir "$id.result.json"
    $R.out = Join-Path $DispatchDir "$id.out.txt"
    $R.err = Join-Path $DispatchDir "$id.err.txt"
    $R.stdin = Join-Path $DispatchDir "$id.stdin.txt"
    [IO.File]::WriteAllText([string]$R.stdin, '', $Utf8)
    $State.daily.worker_starts = [int]$State.daily.worker_starts + 1
    Save-State $State   # write-ahead: from here on a relay stop is settled from evidence (Update-StartLaunching), never run again

    $words = Get-LauncherArguments $R $Q ([string]$R.result_file)
    $argString = ($words | ForEach-Object { ConvertTo-ArgToken $_ }) -join ' '
    $proc = $null
    $launchError = ''
    $previousEnvironment = $null
    $kept = @{}
    try {
        $previousEnvironment = Set-SubscriptionEnvironment   # a Claude Code worker uses the saved subscription login only
        foreach ($name in @('CODEX_HOME', 'GEMINI_CLI_HOME')) { $kept[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
        [Environment]::SetEnvironmentVariable('CODEX_HOME', $CodexHomeDir, 'Process')
        if ($GeminiHomeDir) { [Environment]::SetEnvironmentVariable('GEMINI_CLI_HOME', $GeminiHomeDir, 'Process') }
        try {
            # Hidden, in its own console, standard input from an empty file: nothing can wait for a person.
            $proc = Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -ArgumentList $argString -WorkingDirectory $Root -WindowStyle Hidden -PassThru `
                -RedirectStandardInput ([string]$R.stdin) -RedirectStandardOutput ([string]$R.out) -RedirectStandardError ([string]$R.err)
        } catch { $launchError = 'could not start bin\spawn-worker.ps1: ' + $_.Exception.Message }
    } finally {
        foreach ($name in @($kept.Keys)) { [Environment]::SetEnvironmentVariable($name, $kept[$name], 'Process') }
        Restore-SubscriptionEnvironment $previousEnvironment
    }
    if ($launchError -or -not $proc) {
        if (-not $launchError) { $launchError = 'could not start bin\spawn-worker.ps1 (no process returned)' }
        Set-StartRefused $State $R $launchError
        return
    }
    try { $null = $proc.Handle } catch { }   # keep a handle so the exit code stays readable
    $R.launcher_pid = $proc.Id
    try { $R.launcher_start = [string]$proc.StartTime.ToUniversalTime().Ticks } catch { }
    Save-State $State
    Write-Log ('Starting worker {0} of {1} for the coordinator ({2}, {3}; start request {4}, launcher pid {5}).' -f $R.worker, $R.task, $Q.tool, $Q.type, $id, $proc.Id)
    if (-not $proc.WaitForExit(120000)) {
        Write-Log "The launcher for start request $id ($($R.key)) still runs after 120 s (pid $($proc.Id)). The relay never stops it; it looks again next round."
        return   # Update-StartLaunching settles it later
    }
    Resolve-StartResult $State $R $proc.ExitCode
}

function Resolve-StartResult([hashtable]$State, [hashtable]$R, $Exit) {
    # Settles a start from the launcher's result file: started (with its runner's pid and start time) or refused, in the
    # launcher's own words. $Exit is $null when this relay has no handle on the launcher.
    $res = $null
    try { $res = Read-Json ([string]$R.result_file) } catch { $res = $null }
    if (($res -is [hashtable]) -and ($res['ok'] -is [bool]) -and $res['ok']) {
        $R.state = 'started'; $R.finished_utc = Get-Now
        $runner = 0
        try { $runner = [int]$res['runner_pid'] } catch { $runner = 0 }
        $R.runner_pid = $runner; $R.runner_start = [string]$res['runner_start']
        $R.message = Get-Short ([string]$res['message']) 300
        Write-Log "Started worker $($R.worker) of $($R.task) ($($R.tool)) for start request $($R.id): $($R.message)"
        Remove-StartFiles $R
        return
    }
    if (-not ($res -is [hashtable])) {
        # No result file: the launcher hides a failed write of it. It prints 'Launched <W> (... - runner pid <n>' only
        # right after it started the runner, so a start that worked is never told to the coordinator as a refusal.
        $said = ''
        try { if ($R.out -and (Test-Path -LiteralPath ([string]$R.out) -PathType Leaf)) { $said = Read-SharedText ([string]$R.out) } } catch { $said = '' }
        $launch = [regex]::Match([string]$said, '(?m)^Launched ' + [regex]::Escape([string]$R.worker) + ' \([^\r\n]*')
        if ($launch.Success) {
            $runner = 0
            $runnerStart = ''
            $pm = [regex]::Match($said.Substring($launch.Index), 'runner\s+pid\s+(\d{1,9})')
            if ($pm.Success) {
                # Its start time names it, as the result file would: only a process that started after the launch.
                try {
                    $t = (Get-Process -Id ([int]$pm.Groups[1].Value) -ErrorAction Stop).StartTime.ToUniversalTime()
                    if ((ConvertTo-Unix $t) -ge ([int64]$R.launched_utc - 2)) { $runner = [int]$pm.Groups[1].Value; $runnerStart = [string]$t.Ticks }
                } catch { $runner = 0 }
            }
            $R.state = 'started'; $R.finished_utc = Get-Now
            $R.runner_pid = $runner; $R.runner_start = $runnerStart
            $R.message = Get-Short ('the launcher wrote no result file, but its output says it started the worker: ' + $launch.Value.Trim()) 300
            Write-Log "Started worker $($R.worker) of $($R.task) ($($R.tool)) for start request $($R.id): $($R.message)"
            Remove-StartFiles $R
            return
        }
    }
    $why = ''
    if ($res -is [hashtable]) { $why = [string]$res['message'] }
    if (-not $why) { $why = Get-LauncherText $R }
    if (-not $why) { $why = "the launcher stopped without saying why (exit $(if ($null -eq $Exit) { 'unknown' } else { $Exit }))" }
    Set-StartRefused $State $R $why
}

function Get-LauncherText([hashtable]$R) {
    # The launcher's own words when it wrote no result (a bad parameter fails before any line of it runs): its first
    # message on its error output, else on its other output, without PowerShell's position and category lines. Windows
    # PowerShell wraps a long message at its console's width even into a file, so the lines of that message are joined.
    foreach ($f in @([string]$R.err, [string]$R.out)) {
        if (-not $f -or -not (Test-Path -LiteralPath $f -PathType Leaf)) { continue }
        $text = ''
        try { $text = Read-SharedText $f } catch { continue }
        $words = New-Object System.Collections.Generic.List[string]
        foreach ($line in ($text -split "`r?`n")) {
            $l = $line.Trim()
            $noise = [regex]::IsMatch($l, '^(At line:|At [A-Za-z]:\\|\+ |CategoryInfo|FullyQualifiedErrorId|~)')
            if ($words.Count -eq 0) {
                if ($l -and -not $noise) { $words.Add($l) }
            } elseif (-not $l -or $noise) { break } else { $words.Add($l) }
        }
        if ($words.Count) { return (Get-Short ($words -join ' ') 300) }
    }
    return ''
}

function Set-StartRefused([hashtable]$State, [hashtable]$R, [string]$Why) {
    # A refusal: the record says why, and the coordinator gets a note in its next turn.
    $R.state = 'refused'; $R.finished_utc = Get-Now; $R.message = Get-Short $Why 400
    Add-StartNote $State $R ("The relay did not start worker $($R.worker) of $($R.task): $(([string]$R.message).TrimEnd('.')). Fix it, then change $($R.worker)-start.md to ask again")
    Write-Log "Did not start worker $($R.worker) of $($R.task): $($R.message)"
    Remove-StartFiles $R
}

function Add-StartNote([hashtable]$State, [hashtable]$R, [string]$Detail) {
    # A note for the coordinator: an ordinary entry of notes, so it batches, debounces and waits like every other one.
    $rev = [string]$R.version
    if ($rev.Length -gt 12) { $rev = $rev.Substring(0, 12) }
    $id = "start:$($R.key)@$rev"
    if ($State.notes.ContainsKey($id)) { $id = $id + '#' + (Get-Now) }
    $State.notes[$id] = @{ id = $id; key = "start:$($R.key)"; kind = 'start-note'; task = [string]$R.task; rev = [string]$R.version; detail = $Detail;
        state = 'pending'; detected_utc = (Get-Now); dispatch_id = ''; attempts = 0; outcome = ''; accepted_utc = 0; completed_utc = 0 }
}

function Remove-StartFiles([hashtable]$R) {
    # The launcher's result and output files, once its start is settled: only the relay that holds the writer lock, and
    # only files in .relay\dispatch.
    if (-not $script:CanWrite) { return }
    foreach ($f in @($R.result_file, $R.out, $R.err, $R.stdin)) {
        $p = [string]$f
        if (-not $p) { continue }
        $parent = ''
        try { $parent = [IO.Path]::GetDirectoryName($p) } catch { continue }
        if ($parent -ne $DispatchDir) { continue }
        if (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p -Force -ErrorAction SilentlyContinue }
    }
}

function Update-StartLaunching([hashtable]$State, [bool]$ReadOnly) {
    # A record left 'launching': this relay went on after 120 s, or a relay stopped while the launcher ran. While the
    # launcher still runs, it waits (it is never stopped). Then the result file settles it, else the worker's run.json
    # written since the start; with neither it is 'unknown', with a note, and it never runs again.
    foreach ($r in @($State.starts.Values | Where-Object { ($_ -is [hashtable]) -and $_.state -eq 'launching' })) {
        if ($ReadOnly) { Write-Note "DRY-RUN: start request $($r.id) for $($r.key) is still being settled"; continue }
        $lp = 0
        try { $lp = [int]$r.launcher_pid } catch { $lp = 0 }
        if ($lp -gt 0) {
            $p = Get-Process -Id $lp -ErrorAction SilentlyContinue
            $alive = [bool]$p
            if ($p -and $r.launcher_start) { try { $alive = ([string]$p.StartTime.ToUniversalTime().Ticks -eq [string]$r.launcher_start) } catch { } }
            if ($alive) {
                $mins = [int][Math]::Floor(((Get-Now) - [int64]$r.launched_utc) / 60)
                if ($mins -ge $WaitMinutes) {
                    Add-Alert $State ('long-start:' + $r.id) "The launcher for start request $($r.id) ($($r.key)) still runs after $mins min (pid $lp). The relay never stops it; the other start requests wait until it ends."
                }
                continue   # still running: looked at again next round
            }
        }
        if ($r.result_file -and (Test-Path -LiteralPath ([string]$r.result_file) -PathType Leaf)) { Resolve-StartResult $State $r $null; continue }
        $rf = Join-Path $Root "tasks\$($r.task)\workers\$($r.worker).run.json"
        $newer = $false
        try { $newer = ((Test-Path -LiteralPath $rf -PathType Leaf) -and (ConvertTo-Unix (Get-Item -LiteralPath $rf).LastWriteTimeUtc) -ge ([int64]$r.launched_utc - 2)) } catch { $newer = $false }
        if ($newer) {
            $r.state = 'started'; $r.finished_utc = Get-Now
            $r.message = 'the relay stopped while the launcher ran; the worker''s run.json was written after the start'
            Write-Log "Start request $($r.id) for $($r.key) settled as started: its run.json is newer than the start."
            Remove-StartFiles $r
            continue
        }
        $r.state = 'unknown'; $r.finished_utc = Get-Now
        $r.message = 'the relay stopped while it started this worker, and nothing shows whether it started'
        Add-StartNote $State $r ("The relay stopped while it started worker $($r.worker) of $($r.task), so it does not know if the worker started. It will not try again on its own. Look at $($r.worker).run.json; to ask again, change $($r.worker)-start.md")
        Write-Log "Start request $($r.id) for $($r.key): outcome unknown (the relay stopped while the launcher ran). Not run again."
        Remove-StartFiles $r
    }
}

# ---------- a coordinator in Codex or Gemini CLI: a folder of its own ----------
# A Codex or Gemini CLI coordinator works in a folder of its own, such as <mailbox>\coordinator: Codex may write in that
# folder, and both tools read their standing orders there (AGENTS.md or GEMINI.md). So the folder must not be one of the
# relay's own folders, nor another session's folder, nor inside an application repository.

function Test-InFolder([string]$Path, [string]$Folder) {
    # True when $Path is $Folder or inside it (letter case and a last \ do not count). False when either one is not a
    # path Windows can use. A drive (C: or C:\) holds every path on it.
    if (-not $Path -or -not $Folder) { return $false }
    $a = [string]$Path
    $b = [string]$Folder
    if ($a -match '^[A-Za-z]:$') { $a += '\' }   # GetFullPath reads C: alone as the current folder of drive C
    if ($b -match '^[A-Za-z]:$') { $b += '\' }
    $p = ''
    $f = ''
    try {
        $p = [IO.Path]::GetFullPath($a).TrimEnd('\')
        $f = [IO.Path]::GetFullPath($b).TrimEnd('\')
    } catch { return $false }
    return (($p -ieq $f) -or $p.StartsWith($f + '\', [StringComparison]::OrdinalIgnoreCase))
}

function Get-WorktreesDir {
    # The workers' worktrees folder, by the rule bin\spawn-worker.ps1 uses: worktrees_dir, else
    # <projects folder>\_worktrees\claude. '' when neither is set.
    if ($WorktreesSetting) { try { return [IO.Path]::GetFullPath($WorktreesSetting).TrimEnd('\') } catch { return '' } }
    if ($ProjectsDir) { try { return (Join-Path $ProjectsDir '_worktrees\claude') } catch { return '' } }   # 5.1: Join-Path throws for a drive that is not there
    return ''
}

function Get-GitRootAbove([string]$Folder) {
    # The nearest folder at or above $Folder that holds a .git folder or file (a Git repository or worktree), or ''.
    $d = ''
    try { $d = [IO.Path]::GetFullPath($Folder).TrimEnd('\') } catch { return '' }
    while ($d) {
        if (Test-Path -LiteralPath (Join-Path $d '.git')) { return $d }
        $up = ''
        try { $up = [string][IO.Path]::GetDirectoryName($d) } catch { $up = '' }
        if (-not $up) { break }
        $up = $up.TrimEnd('\')
        if ($up -ieq $d) { break }
        $d = $up
    }
    return ''
}

function Get-HqFolder {
    # HQ's folder: this mailbox when it is HQ, else hq_dir from bin\relay-settings.json (a project of HQ), else ''.
    if ($HqRole) { return $Root }
    if ($HqDirSetting) { try { return [IO.Path]::GetFullPath($HqDirSetting).TrimEnd('\') } catch { return '' } }
    return ''
}

function Get-CoordinatorFolderError([string]$Folder, [string]$ForTool) {
    # Why $Folder cannot be the folder of a Codex or Gemini CLI coordinator, in plain words, or '' when it can be.
    $f = ''
    try {
        if (-not $Folder -or -not (Test-Path -LiteralPath $Folder -PathType Container)) { return 'it is not there' }
        $f = [IO.Path]::GetFullPath($Folder).TrimEnd('\')
    } catch { return 'Windows cannot use it as a folder path' }
    if (($f -match '^[A-Za-z]:$') -or $f.StartsWith('\\')) { return 'it is a drive or a network folder' }
    if ($f -match '(^|\\)\.git(\\|$)') { return "it is a Git folder (.git), or inside one" }
    if (Test-InFolder $Root $f) { return 'it is the mailbox folder itself, or a folder that holds it' }
    foreach ($sub in @('bin', 'tests', 'templates', 'tasks', 'mail', '.relay')) {
        if (Test-InFolder $f (Join-Path $Root $sub)) { return "it is inside the mailbox's $sub folder" }
    }
    if ($env:USERPROFILE -and (Test-InFolder $env:USERPROFILE $f)) { return 'it is your home folder, or a folder that holds it' }
    foreach ($d in @($CodexHomeDir, $GeminiDataDir, $ClaudeConfigDir)) {
        # Inside such a folder, or holding it, a coordinator could change an AI tool's own settings.
        if ($d -and ((Test-InFolder $f $d) -or (Test-InFolder $d $f))) { return "it is $d, where an AI tool keeps its own files, or inside it, or a folder that holds it" }
    }
    # Inside the projects folder is fine; a folder inside an application repository there is refused below.
    if ($ProjectsDir -and (Test-InFolder $ProjectsDir $f)) { return 'it is the projects folder, or a folder that holds it' }
    $wt = Get-WorktreesDir
    if ($wt -and ((Test-InFolder $f $wt) -or (Test-InFolder $wt $f))) { return "it is the workers' worktrees folder $wt, or inside it, or a folder that holds it" }
    $git = Get-GitRootAbove $f
    if ($git -and -not (Test-InFolder $Root $git)) { return "it is inside the Git repository $git" }   # the mailbox's own repository is fine
    $hq = Get-HqFolder
    if ($hq) {
        # In HQ, HQ is this mailbox, so this mailbox's own subfolders are fine (its projects are refused just below).
        # -and and -or have the same precedence: hence two steps.
        $inHq = ((Test-InFolder $f $hq) -and -not (Test-InFolder $f $Root))
        if ($inHq -or (Test-InFolder $hq $f)) { return "it is HQ's folder $hq, or inside it, or a folder that holds it (HQ's AGENTS.md holds the orchestrator's orders)" }
    }
    foreach ($p in @($script:HqProjects)) {
        $pm = [string]$p.mailbox
        if ($pm -and -not (Test-SameFolder $pm $Root) -and ((Test-InFolder $f $pm) -or (Test-InFolder $pm $f))) { return "it is the project mailbox $pm, or inside it, or a folder that holds it" }
    }
    # Holding the planner's or an agent's folder, the coordinator could change that session's standing orders.
    $cx = Get-CodexConfig
    if ($cx -and $cx.cwd -and (Test-InFolder ([string]$cx.cwd) $f)) { return "it is this mailbox's planner's folder $($cx.cwd), or a folder that holds it" }
    $agents = Get-Agents
    foreach ($k in @($agents.Keys)) {
        $ag = $agents[$k]
        if (-not ($ag -is [hashtable]) -or -not $ag.cwd) { continue }
        if (Test-InFolder ([string]$ag.cwd) $f) { return "it is the folder of the agent '$($ag.name)', or a folder that holds it" }
    }
    if ($ForTool -eq 'gemini' -and ($f.Contains(',') -or $f.Contains('@'))) { return 'its path holds a comma or an @, which Gemini CLI would read as a list or a file' }
    return ''
}

function Get-ToolModelError([string]$Name, [string]$ForTool) {
    # A model for a Codex or Gemini CLI coordinator, as bin\spawn-worker.ps1 checks a worker's: not a Claude model, and
    # one word of plain characters that starts with a letter or a digit (a word that starts with - reads as an option).
    if (-not $Name) { return '' }
    if ($Name -match '(?i)claude|opus|sonnet|haiku|fable') { return "-Model $Name is a Claude model; $(Get-ToolName $ForTool) needs one of its own, or leave -Model out." }
    if ($Name -notmatch '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,79}$') { return "-Model must be one word of letters, digits and . _ : / -, starting with a letter or a digit (got '$Name')." }
    return ''
}

# ---------- one Codex thread, one job ----------
# A Codex thread may be only one of: this mailbox's planner, its coordinator, one of its agents, or HQ's orchestrator
# (and, seen from HQ, a project's coordinator). Enrollment refuses an overlap both ways, the coordinator's preflight
# halts on one, and a newer thread with a followed name that has another job is not followed. So two programs never
# wake one thread.

function Get-HqOrchestratorThread {
    # In a project of HQ (hq_dir set; not HQ itself): HQ's orchestrator thread, from HQ's .relay\codex.json. Read-only.
    # unreadable: that file is there but could not be read, so the thread is not known.
    $none = @{ thread = ''; unreadable = $false }
    if ($HqRole) { return $none }
    $hq = Get-HqFolder
    if (-not $hq -or (Test-SameFolder $hq $Root)) { return $none }
    # Join-Path in a try: in Windows PowerShell 5.1 it throws when hq_dir names a drive that is not there (a network
    # drive that this window has not mapped). Then HQ's file is not there, as for a folder that is not there.
    $f = ''
    try { $f = Join-Path $hq '.relay\codex.json' } catch { return $none }
    if (-not (Test-Path -LiteralPath $f -PathType Leaf)) { return $none }
    $c = $null
    try { $c = Read-Json $f } catch { return @{ thread = ''; unreadable = $true } }
    if ($null -eq $c) { return $none }
    if (-not ($c -is [hashtable])) { return @{ thread = ''; unreadable = $true } }
    return @{ thread = ([string]$c.thread_id).Trim().ToLowerInvariant(); unreadable = $false }
}

function Get-ThreadJobs {
    # Every job a Codex thread has here, as @{ job; thread; text }, the thread id in lower case. Read-only.
    $jobs = New-Object System.Collections.ArrayList
    $cx = Get-CodexConfig
    if ($cx) { [void]$jobs.Add(@{ job = 'planner'; thread = ([string]$cx.thread_id).Trim().ToLowerInvariant(); text = "this mailbox's planner" }) }
    $c = Get-Coordinator
    if ($c -and (Get-CoordTool $c) -eq 'codex') { [void]$jobs.Add(@{ job = 'coordinator'; thread = ([string]$c.session_id).Trim().ToLowerInvariant(); text = "this mailbox's coordinator" }) }
    $agents = Get-Agents
    foreach ($k in @($agents.Keys)) {
        $ag = $agents[$k]
        if (-not ($ag -is [hashtable])) { continue }
        $nm = [string]$ag.name
        if (-not $nm) { $nm = [string]$k }
        [void]$jobs.Add(@{ job = 'agent:' + $k; thread = ([string]$ag.thread_id).Trim().ToLowerInvariant(); text = "the agent '$nm'" })
    }
    $orch = Get-HqOrchestratorThread
    if ($orch.thread) { [void]$jobs.Add(@{ job = 'orchestrator'; thread = $orch.thread; text = "HQ's orchestrator" }) }
    if ($HqRole) {
        foreach ($p in @($script:HqProjects)) {
            $pc = $null
            try { $pc = Read-Json (Join-Path ([string]$p.mailbox) '.relay\coordinator.json') } catch { $pc = $null }
            if (($pc -is [hashtable]) -and (Get-CoordTool $pc) -eq 'codex') {
                [void]$jobs.Add(@{ job = 'project-coordinator:' + $p.id; thread = ([string]$pc.session_id).Trim().ToLowerInvariant(); text = "the coordinator of project $($p.id)" })
            }
        }
    }
    return , $jobs.ToArray()
}

function Get-ThreadJobText([string]$ThreadId, [string]$Except) {
    # The first job of this Codex thread other than $Except (planner, coordinator, agent:<key> or orchestrator), in
    # words, or ''. While HQ's codex.json cannot be read, the thread may be HQ's orchestrator, and that counts too.
    $tid = ([string]$ThreadId).Trim().ToLowerInvariant()
    if (-not $tid) { return '' }
    $jobs = Get-ThreadJobs   # a variable first: @(<function>) would keep the list as one item
    foreach ($j in $jobs) { if ($j.thread -and $j.thread -eq $tid -and $j.job -ne $Except) { return [string]$j.text } }
    if ($Except -ne 'orchestrator' -and (Get-HqOrchestratorThread).unreadable) { return "maybe HQ's orchestrator (HQ's .relay\codex.json could not be read)" }
    return ''
}

function Get-CoordinatorCodexFolder {
    # The folder of a Codex or Gemini CLI coordinator, for the planner's and the agents' folder checks, else ''.
    $c = Get-Coordinator
    $t = Get-CoordTool $c
    if ($c -and ($t -eq 'codex' -or $t -eq 'gemini')) { return [string]$c.cwd }
    return ''
}

# ---------- a Codex coordinator ----------
# One coordinator turn in Codex is
#   codex exec --json --skip-git-repo-check --sandbox workspace-write -c sandbox_workspace_write.network_access=false
#     -c sandbox_workspace_write.writable_roots=[] -c mcp_servers={} --add-dir <mailbox>\tasks [-m <model>]
#     [-c model_reasoning_effort=<effort>] resume <thread id> <notice>
# in the coordinator's own folder, with the ChatGPT sign-in only and never codex_exec_args (the planner's setting): the
# turn can write only that folder and the mailbox's tasks folder, with no network and no MCP servers, whatever the
# owner's own Codex settings say. Its status board is STATUS.md in its folder, and the relay copies it into the mailbox
# after each turn that got the notice.

function Get-CoordinatorCodexTarget([hashtable]$Coord) {
    # The shape that Start-CodexProcess, Get-CodexArguments and Get-CodexRolloutPath read.
    return @{ thread_id = ([string]$Coord.session_id).Trim().ToLowerInvariant(); cwd = [string]$Coord.cwd; rollout_path = [string]$Coord.transcript_path }
}

function Get-CoordinatorCodexOptions([hashtable]$Coord) {
    # The relay's own fixed options for a coordinator turn (design D4). Never codex_exec_args, never HQ's project folders.
    # Codex lays each -c value over the owner's own config.toml one key at a time, and adds each --add-dir folder to that
    # file's writable_roots list. So two more options empty what that file could add: its writable_roots (then only the
    # turn's own folder and tasks can be written) and its MCP servers (they run outside the sandbox; a Claude Code
    # coordinator's turn has none either).
    $o = New-Object System.Collections.Generic.List[string]
    foreach ($x in @('--sandbox', 'workspace-write', '-c', 'sandbox_workspace_write.network_access=false', '-c', 'sandbox_workspace_write.writable_roots=[]',
            '-c', 'mcp_servers={}', '--add-dir', (Join-Path $Root 'tasks'))) { $o.Add([string]$x) }
    if ($Coord.model) { $o.Add('-m'); $o.Add([string]$Coord.model) }
    if ($Coord.effort) { $o.Add('-c'); $o.Add('model_reasoning_effort=' + ([string]$Coord.effort).ToLowerInvariant()) }
    return , $o
}

function Get-CoordinatorAddDirError {
    # Each Codex coordinator turn names <mailbox>\tasks on Codex's command line (--add-dir). Codex usually runs through
    # codex.cmd, and cmd.exe cuts or changes a command line at these characters, so such a mailbox path is refused, as
    # Get-ProjectFolderError refuses it for HQ's project folders. (The notice itself keeps plain characters only.)
    $tasksDir = Join-Path $Root 'tasks'
    if ($tasksDir -match '[\x00-\x1f"%!^&|<>]') {
        return "the mailbox folder $Root has a character that cmd.exe treats specially (% ! ^ or &) in its path. Each coordinator turn names $tasksDir on Codex's command line, and codex.cmd would cut or change it there. Move the mailbox to a folder without those characters"
    }
    return ''
}

function Get-CodexCoordinatorPreflight([hashtable]$State, [hashtable]$Coord) {
    # Right before a Codex coordinator turn. @{ error }: a normal failure (back off, try again). @{ halt }: something that
    # does not fix itself, so coordinator turns stop until -ClearHalt.
    $pf = Get-CodexPreflightError (Get-CoordinatorCodexTarget $Coord) '-Enroll -Tool codex' $true   # codex_exec_args is not used
    if ($pf) { return @{ error = $pf; halt = '' } }
    $cwd = [string]$Coord.cwd
    $why = Get-CoordinatorFolderError $cwd 'codex'
    if ($why) { return @{ error = ''; halt = "the coordinator's folder $cwd cannot be used any more: $why" } }
    if (Test-Path -LiteralPath (Join-Path $cwd '.codex')) { return @{ error = ''; halt = "$cwd\.codex is there; Codex would read its settings (they could add writable folders), so no coordinator turn starts" } }
    # Codex reads AGENTS.override.md in place of AGENTS.md, and the guard watches AGENTS.md only: such a file could
    # replace the coordinator's standing orders. So no turn starts while one is there (enrollment and a rollover refuse
    # such a folder too).
    if (Test-Path -LiteralPath (Join-Path $cwd 'AGENTS.override.md')) { return @{ error = ''; halt = "$cwd\AGENTS.override.md is there; Codex would read it in place of AGENTS.md, the coordinator's standing orders, so no coordinator turn starts" } }
    $aw = Get-CoordinatorAddDirError
    if ($aw) { return @{ error = ''; halt = $aw } }
    # .relay\coordinator.json is checked again on every turn, as the Claude Code coordinator's checks are.
    $mw = Get-ToolModelError ([string]$Coord.model) 'codex'
    if ($mw) { return @{ error = ''; halt = "the model in .relay\coordinator.json cannot be used ($mw) Enroll again with -Enroll -Tool codex" } }
    $ef = ([string]$Coord.effort).ToLowerInvariant()
    if ($ef -and @('low', 'medium', 'high', 'xhigh') -notcontains $ef) { return @{ error = ''; halt = "the effort '$ef' in .relay\coordinator.json is not low, medium, high or xhigh; enroll again with -Enroll -Tool codex" } }
    $other = Get-ThreadJobText ([string]$Coord.session_id) 'coordinator'
    if ($other) { return @{ error = ''; halt = "the coordinator's Codex thread $($Coord.session_id) is also $other; one thread has one job" } }
    return @{ error = ''; halt = '' }
}

function Get-CodexCoordinatorBusy([hashtable]$State, [hashtable]$Coord) {
    # Why the coordinator's Codex thread cannot take a turn now, or ''. Get-BusyReason has looked for a running
    # coordinator turn already. Never two programs in one thread: the relay's own planner and mail wakes in it (a
    # backstop, as one thread has one job), Codex's own lock file, a process with the thread id on its command line, and
    # a thread file that another program wrote within the quiet window.
    $tid = ([string]$Coord.session_id).Trim().ToLowerInvariant()
    foreach ($d in (@($State.codex_dispatches.Values) + @($State.mail_dispatches.Values))) {
        if (($d.state -eq 'running' -or $d.state -eq 'launching') -and ([string]$d.thread_id).ToLowerInvariant() -eq $tid) { return "the relay's wake $($d.id) is still running in this thread (pid $($d.pid))" }
    }
    if (Test-CodexThreadLocked $tid) { return "another Codex program has thread $tid open (most likely the Codex app, which keeps every thread it opened until it quits fully)" }
    $procs = Get-SessionProcesses $tid
    if ($null -eq $procs) { return 'the process list could not be read to confirm the thread is idle' }
    if ($procs.Count -gt 0) { return ('thread ' + $tid + ' is open in pid ' + (($procs | ForEach-Object { $_.ProcessId }) -join ',')) }
    $roll = Get-CodexRolloutPath (Get-CoordinatorCodexTarget $Coord)
    if ($QuietSeconds -gt 0 -and $roll) {
        $tw = ConvertTo-Unix (Get-Item -LiteralPath $roll).LastWriteTimeUtc
        $now = Get-Now
        if ($tw -gt ($now - $QuietSeconds) -and $tw -gt ([int64]$State.last_finish_utc + 15)) {
            return "the thread file was written $($now - $tw) s ago by another client (quiet window $QuietSeconds s)"
        }
    }
    return ''
}

function New-CoordinatorPrompt([string]$Id, [object[]]$Batch, [hashtable]$Coord) {
    # The notice for a Codex or Gemini CLI coordinator. Neither tool takes a second system prompt, so the relay's rules
    # ride in the notice itself. Codex gets plain characters only (ConvertTo-SafeText drops < > and quotes, so the notice
    # names W1-brief.md, never a placeholder in angle brackets); Gemini CLI gets the notice on its standard input.
    $coordTool = Get-CoordTool $Coord
    $parts = New-Object System.Collections.Generic.List[string]
    $i = 0
    foreach ($n in $Batch) { $i++; $parts.Add(('{0}) {1}' -f $i, $n.detail)) }
    $orders = 'AGENTS.md'
    $board = "your own copy $($Coord.cwd)\STATUS.md (the relay copies it into the mailbox after your turn)"
    if ($coordTool -eq 'gemini') { $orders = 'GEMINI.md'; $board = "$Root\STATUS.md" }
    $p = "[bridge-relay $Id] Mailbox notification for the coordinator ($i item(s)): " + ($parts -join '; ') + '. ' +
        "bin/bridge-relay.ps1 started this turn automatically ($OwnerName did not type it). Read CODEX-QUEUE.md and the named files in $Root, then act as the coordinator under README.md there and your standing orders ($orders in your folder). " +
        "Write only coordinator files, with full paths: the status board, $board, and under $Root\tasks only status.md, questions.md, handoff.md, and worker briefs and start requests (W1-brief.md, W1-start.md and so on). " +
        "To start a worker, write its brief, then its start request from $Root\templates\worker-start.md (W2-start.md for W2, and so on); the relay starts it after your turn and tells you if it did not. " +
        "Never run spawn-worker.ps1, git worktree add, git push or gh, and never edit bin, tests, .relay, README.md, CLAUDE.md or templates; if one of those is needed, write a $OwnerTag note in the task's status.md. " +
        "If a command is refused, do not try another way: write a $OwnerTag/BLOCKED note naming the command, then end the turn. " +
        'Do not invent tasks. If nothing is actionable, change nothing. End with a one to three sentence summary.'
    $p = ($p -replace '[\r\n]+', ' ')
    if ($coordTool -eq 'codex') { return (ConvertTo-SafeText $p) }
    return (($p -replace '@', ' at ') -replace '"', "'")
}

function Initialize-CoordinatorBoard([hashtable]$Coord) {
    # At enrollment and at a rollover: the coordinator's own STATUS.md starts as a copy of the mailbox's board, the one
    # every coordinator keeps. The relay copies the folder's board over the mailbox's after each turn, so a different
    # board that is in the folder already (an old one, say, from before a Claude Code coordinator kept the board) is kept
    # in .relay\backups first, then replaced. The folder's board stays when it is the same, when it is a link, a folder
    # or more than 1 MB (the relay never copies such a board into the mailbox), or when the mailbox has no board the
    # relay copies (none, a link, or more than 1 MB). Only by the relay that holds the writer lock; never throws.
    if (-not $script:CanWrite -or -not $Coord.cwd) { return }
    $folder = [string]$Coord.cwd
    try {
        # Join-Path inside the try: in Windows PowerShell 5.1 it throws for a drive that is not there.
        $dst = Join-Path $folder 'STATUS.md'
        $src = Join-Path $Root 'STATUS.md'
        $text = ''
        $from = ''
        if (Test-Path -LiteralPath $src -PathType Leaf) {
            $fi = Get-Item -LiteralPath $src -Force
            if (-not ($fi.Attributes -band [IO.FileAttributes]::ReparsePoint) -and $fi.Length -le 1048576) { $text = Read-SharedText $src; $from = "a copy of $src" }
        }
        if (Test-Path -LiteralPath $dst) {
            $di = Get-Item -LiteralPath $dst -Force
            $plain = -not (($di.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $di.PSIsContainer)
            if ($plain -and $di.Length -gt 1048576) { $plain = $false }   # never read or copied: too large for the mailbox
            if (-not $from -or -not $plain -or ((Read-SharedText $dst) -ceq $text)) { Write-Log "Kept the coordinator's own $dst."; return }
            $kept = Backup-RelayFile $dst   # first: if the copy fails, the folder's board stays as it is
            Write-TextSafely $dst $text
            Write-Log "Replaced $dst with $from, because the two boards were not the same. The folder's old board is kept as $kept."
            return
        }
        if (-not $from) { $text = "# Status board (owner: coordinator)`r`n"; $from = 'a new board (the mailbox has no STATUS.md to copy)' }
        Write-TextSafely $dst $text
        Write-Log "Made $dst, $from. The relay copies it back into the mailbox after each coordinator turn."
    } catch { Write-Log "Could not make the coordinator's STATUS.md in ${folder}: $($_.Exception.Message)" }
}

function Copy-CoordinatorBoard([hashtable]$Turn) {
    # After a Codex coordinator turn that got its notice: STATUS.md from the turn's own folder ($Turn.cwd) into the
    # mailbox. Only a plain file of at most 1 MB, never through a link, and only by the relay that holds the writer lock
    # (never in a dry run). Never throws.
    if (-not $script:CanWrite) { return }
    $folder = [string]$Turn.cwd
    if (-not $folder) { return }
    try {
        # Join-Path inside the try: in Windows PowerShell 5.1 it throws for a drive that is not there.
        $src = Join-Path $folder 'STATUS.md'
        $dst = Join-Path $Root 'STATUS.md'
        if (-not (Test-Path -LiteralPath $src -PathType Leaf)) { return }
        $fi = Get-Item -LiteralPath $src -Force
        if ($fi.Attributes -band [IO.FileAttributes]::ReparsePoint) { Write-Log "Did not copy ${src}: it is a link, not a file."; return }
        if ($fi.Length -gt 1048576) { Write-Log "Did not copy ${src}: it is larger than 1 MB."; return }
        if (Test-Path -LiteralPath $dst) {
            $di = Get-Item -LiteralPath $dst -Force
            if (($di.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $di.PSIsContainer) { Write-Log "Did not copy the coordinator's STATUS.md: $dst is a link or a folder."; return }
        }
        $text = Read-SharedText $src
        if ((Test-Path -LiteralPath $dst -PathType Leaf) -and ((Read-SharedText $dst) -ceq $text)) { return }
        Write-TextSafely $dst $text
        Write-Log "Copied the coordinator's STATUS.md ($src) into the mailbox."
    } catch { Write-Log "Could not copy the coordinator's STATUS.md: $($_.Exception.Message)" }
}

function Update-CodexCoordinatorFollow([hashtable]$State, [bool]$ReadOnly, [hashtable]$C) {
    # A Codex coordinator enrolled by name follows it, as the planner does: a newer live thread with the name takes over,
    # forward only and between turns, when it works in a folder of its own and has no other job.
    $name = [string]$C.follow_name
    $cur = [string]$C.session_id
    $best = Find-NamedCodexThread $name
    if (-not $best) {
        if ($State.flags['follow_coordinator_miss'] -ne $cur) {
            $State.flags['follow_coordinator_miss'] = $cur
            Write-Log "No live Codex thread named '$name' was found; the relay still wakes thread $cur as the coordinator."
        }
        return
    }
    [void]$State.flags.Remove('follow_coordinator_miss')
    if ($best.id -eq $cur -or $best.started -le [int64]$C.started_ms) { return }
    if (@($State.dispatches.Values | Where-Object { $_.state -eq 'running' -or $_.state -eq 'launching' }).Count) {
        $script:NextFollowCheck = 0   # between turns only: look again on the next tick
        return
    }
    $cwd = Get-CodexThreadCwd $best.path
    $refuse = ''
    if (-not $cwd -or -not (Test-Path -LiteralPath $cwd -PathType Container)) { $refuse = "names no folder the relay can find ('$cwd')" }
    if (-not $refuse) { $fw = Get-CoordinatorFolderError $cwd 'codex'; if ($fw) { $refuse = "works in $cwd, which cannot be the coordinator's folder: $fw" } }
    if (-not $refuse -and (Test-Path -LiteralPath (Join-Path $cwd '.codex'))) { $refuse = "works in $cwd, which has a .codex folder (Codex would read its settings in every coordinator turn)" }
    if (-not $refuse -and (Test-Path -LiteralPath (Join-Path $cwd 'AGENTS.override.md'))) { $refuse = "works in $cwd, which has an AGENTS.override.md (Codex would read it in place of the coordinator's AGENTS.md)" }
    if (-not $refuse) { $ow = Get-ThreadJobText $best.id 'coordinator'; if ($ow) { $refuse = "is already $ow" } }
    if ($refuse) {
        if ($State.flags['follow_coordinator_refused'] -ne $best.id) {
            $State.flags['follow_coordinator_refused'] = $best.id
            Write-Log "The newest Codex thread named '$name' ($($best.id)) $refuse. The relay still wakes thread $cur."
        }
        return
    }
    if ($ReadOnly) { Write-Note "DRY-RUN: would switch the coordinator to Codex thread $($best.id), the newest thread named '$name' (it wakes $cur now)."; return }
    $oldCwd = [string]$C.cwd
    $C.previous_session_id = $cur
    $C.session_id = [string]$best.id
    $C.cwd = $cwd
    $C.transcript_path = [string]$best.path
    $C.board = Join-Path $cwd 'STATUS.md'
    $C.started_ms = $best.started
    $C.followed_utc = Get-Now
    $C.followed = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss', $Inv)
    Save-Json $CoordFile $C
    if ($script:GuardOn -and $null -ne $script:RelayStamps) {
        # The orders file moved with the folder: from now on the guard watches the new one. Nothing else is looked at
        # again, so a change to another watched file is still seen.
        if ($oldCwd) { try { [void]$script:RelayStamps.Remove((Join-Path $oldCwd 'AGENTS.md')) } catch { } }
        $newOrders = Join-Path $cwd 'AGENTS.md'
        $script:RelayStamps[$newOrders] = Get-RelayFileStamp $newOrders
    }
    Initialize-CoordinatorBoard $C
    $State.failures = 0
    $State.next_attempt_utc = 0
    [void]$State.flags.Remove('last_block')
    [void]$State.flags.Remove('follow_coordinator_refused')
    Write-Log "Rollover: '$name' is now Codex thread $($best.id) (newest with that name; folder $cwd), so the relay wakes it as the coordinator instead of $cur."
}

function Invoke-EnrollCodexCoordinator {
    # Operator only (-Enroll -Tool codex). Records a Codex thread as this mailbox's coordinator. Enrolling wakes nothing:
    # the start requests that are there now count as known, and only new notifications wake the thread.
    $aw = Get-CoordinatorAddDirError   # about the mailbox, not the thread: checked first
    if ($aw) { Fail "A Codex coordinator cannot work for this mailbox: $aw. Nothing was saved." }
    $tid = ''
    if ($ThreadName) {
        $named = Find-NamedCodexThread $ThreadName
        if (-not $named) { Fail "No live Codex thread named '$ThreadName' was found in $CodexHomeDir (archived threads do not count). Check the name in Codex, or use -ThreadId." }
        $tid = [string]$named.id
    } else {
        if ($ThreadId -notmatch '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$') { Fail "-ThreadId must be the Codex thread id (a UUID; got '$ThreadId'), or give -ThreadName <name>. The relay never guesses it." }
        $tid = $ThreadId.ToLowerInvariant()
    }
    $found = Find-CodexRollout $tid
    if (-not $found) { Fail "No Codex thread $tid found under $CodexHomeDir\sessions. Take the id from the thread itself, and pass -CodexHome if Codex keeps its files elsewhere." }
    if ($found.archived) { Fail "Codex thread $tid is archived. Unarchive it in Codex first, or enroll another thread." }
    $other = Get-ThreadJobText $tid 'coordinator'   # one Codex thread has one job
    if ($other) { Fail "Codex thread $tid is already $other. One Codex thread has one job: start a new thread for the coordinator." }
    $cwd = ''
    if ($CodexCwd) {
        try { $cwd = [IO.Path]::GetFullPath($CodexCwd).TrimEnd('\') } catch { Fail "-CodexCwd '$CodexCwd' is not a folder path Windows can use." 64 }
    } else { $cwd = Get-CodexThreadCwd $found.path }
    if (-not $cwd) { Fail "Could not read the thread's working folder from the first line of $($found.path). Pass -CodexCwd <folder>." }
    $why = Get-CoordinatorFolderError $cwd 'codex'
    if ($why) { Fail "The Codex thread's folder $cwd cannot be the coordinator's folder: $why. Start the coordinator thread in a folder of its own, such as $Root\coordinator, then enroll again." }
    if (Test-Path -LiteralPath (Join-Path $cwd '.codex')) { Fail "$cwd\.codex is there. Codex would read its settings in every coordinator turn. Move it away, then enroll again." }
    if (Test-Path -LiteralPath (Join-Path $cwd 'AGENTS.override.md')) { Fail "$cwd\AGENTS.override.md is there. Codex reads it in place of AGENTS.md, the coordinator's standing orders. Move it away, then enroll again." }
    $mw = Get-ToolModelError $Model 'codex'
    if ($mw) { Fail $mw 64 }
    $effortWord = ([string]$Effort).ToLowerInvariant()
    $held = Test-CodexThreadLocked $tid
    $coord = @{ tool = 'codex'; session_id = $tid; cwd = $cwd; transcript_path = [string]$found.path; codex_home = $CodexHomeDir;
        enrolled_utc = (Get-Now); enrolled = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss', $Inv);
        follow_name = [string]$ThreadName; started_ms = (Get-CodexStarted $found.path);
        verified = 'live Codex thread file found; its folder is a folder of its own; the thread has no other job';
        model = [string]$Model; effort = $effortWord; allowed_checks = @(); board = (Join-Path $cwd 'STATUS.md');
        resume_rule = 'codex exec --json --skip-git-repo-check --sandbox workspace-write -c sandbox_workspace_write.network_access=false -c sandbox_workspace_write.writable_roots=[] -c mcp_servers={} --add-dir <mailbox>\tasks [-m <model>] [-c model_reasoning_effort=<effort>] resume <thread id> <notice>; in the coordinator folder; ChatGPT sign-in only; never codex_exec_args' }
    $kept = Backup-RelayFile $CoordFile   # a copy of the old record first, whatever changes
    Save-Json $CoordFile $coord
    Initialize-CoordinatorBoard $coord
    $state = Get-State
    foreach ($flag in @('last_block', 'follow_coordinator_miss', 'follow_coordinator_refused')) { [void]$state.flags.Remove($flag) }
    Update-StartRequests $state $true $coord   # start files that are there now count as known: never run
    Save-State $state
    Write-Log ("Enrolled Codex thread $tid as the coordinator (folder $cwd). Each turn runs in Codex's workspace-write sandbox with no network and can write only $cwd and $Root\tasks. " +
        "After each turn the relay copies $cwd\STATUS.md into the mailbox. Model: $(if ($Model) { $Model } else { 'Codex default' }); effort: $(if ($effortWord) { $effortWord } else { 'Codex default' }).")
    if ($ThreadName) { Write-Log "It follows the name '$ThreadName': when a newer Codex thread takes that name, the relay wakes it instead, between turns." }
    if ($held) { Write-Log 'Another Codex program has this thread open right now (most likely the Codex app). The relay wakes it only after that program lets go of it.' }
    if (-not (Test-Path -LiteralPath (Join-Path $cwd 'AGENTS.md') -PathType Leaf)) { Write-Log "WARNING: $cwd\AGENTS.md is not there. Copy relay\COORDINATOR.md there as AGENTS.md, so the coordinator reads its standing orders." }
    if (-not (Get-StartRequestsOn $coord)) { Write-Log 'WARNING: start_requests is false in bin\relay-settings.json, so this coordinator cannot start workers.' }
    if (-not (Get-CodexExePath)) { Write-Log 'WARNING: the Codex CLI was not found on PATH. Install it, or set codex_exe in bin\relay-settings.json, before the first turn.' }
    if ($kept) { Write-Log "The coordinator.json from before is kept as $kept." }
}

# ---------- a coordinator turn in Codex (and later Gemini CLI) ----------
# Start-Dispatch and Complete-Dispatch hand a turn to these when the coordinator is not a Claude Code session. A Codex
# turn is built here. A Gemini CLI turn is built by the next step of Phase 6; until then it starts nothing.

function Start-ToolDispatch([hashtable]$State, [hashtable]$Coord, [object[]]$Pending) {
    $script:LastLaunched = $null
    $coordTool = Get-CoordTool $Coord
    if ($coordTool -ne 'codex') {
        # Not built yet (Gemini CLI): Get-BusyReason holds every turn of such a coordinator first, so this does not run.
        # If it does, it starts nothing and changes nothing: the notifications stay pending.
        Write-Log ("Not dispatched: this relay cannot wake a coordinator in '{0}' yet. {1} notification(s) stay pending." -f $coordTool, @($Pending).Count)
        return
    }
    $now = Get-Now
    if (-not (Test-Path -LiteralPath $DispatchDir)) { New-Item -ItemType Directory -Path $DispatchDir -Force | Out-Null }
    $id = 'R' + (Get-Date).ToString('yyyyMMdd-HHmmss', $Inv) + '-' + [guid]::NewGuid().ToString('N').Substring(0, 4)
    $batch = @($Pending | Select-Object -First 10)   # the Codex notice is one command-line argument
    $prompt = New-CoordinatorPrompt $id $batch $Coord
    $promptFile = Join-Path $DispatchDir "$id.prompt.txt"
    $stdin = Join-Path $DispatchDir "$id.stdin.txt"
    $out = Join-Path $DispatchDir "$id.out.jsonl"
    $errFile = Join-Path $DispatchDir "$id.err.txt"   # never $err: Start-CodexProcess names its parameter $Err
    [IO.File]::WriteAllText($promptFile, $prompt, $Utf8)
    [IO.File]::WriteAllText($stdin, '', $Utf8)
    $target = Get-CoordinatorCodexTarget $Coord
    $options = Get-CoordinatorCodexOptions $Coord   # a list, so a variable first: @(<function>) would keep it as one item
    $State.seq = [int64]$State.seq + 1
    # guard: the program files' stamps at the start. The turn may outlive this relay process, so its record keeps them,
    # and they are compared when the turn ends, in this relay process or in the next one.
    $d = @{ id = $id; seq = $State.seq; tool = $coordTool; state = 'launching'; items = @($batch | ForEach-Object { $_.id }); started_utc = $now; finished_utc = 0;
        session_id = [string]$Coord.session_id; transcript = [string]$Coord.transcript_path; cwd = [string]$Coord.cwd; pid = 0; proc_start = '';
        out = $out; err = $errFile; stdin = $stdin; prompt_file = $promptFile; accepted_utc = 0; exit_code = $null; outcome = ''; error = '';
        cost = $null; turns = $null; duration_ms = $null; subtype = ''; result_session = ''; summary = ''; billing = 'chatgpt-sign-in';
        options = $options.ToArray(); policy_sha256 = ''; guard = (Get-RelayFileStamps $true) }
    $State.dispatches[$id] = $d
    foreach ($n in $batch) { $n.state = 'launched'; $n.dispatch_id = $id; $n.attempts = [int]$n.attempts + 1 }
    Save-State $State   # write-ahead, as for a Claude Code turn: from here on a relay stop is settled from evidence

    $pf = Get-CodexCoordinatorPreflight $State $Coord
    if ($pf.halt) { Set-DispatchHalted $State $d $pf.halt; return }
    if ($pf.error) { $d.guard = $null; Set-DispatchFailed $State $d $pf.error; return }
    $roll = Get-CodexRolloutPath $target   # the thread file, found again if Codex moved it
    if ($roll) { $d.transcript = $roll; $target.rollout_path = $roll }
    if (-not (Test-RelayFiles $State 'before a coordinator turn')) { Set-DispatchHalted $State $d ([string]$State.halt); return }
    $started = Start-CodexProcess $target $prompt $stdin $out $errFile $options
    if ($started.error) { $d.guard = $null; Set-DispatchFailed $State $d $started.error; return }
    $proc = $started.proc
    try { $null = $proc.Handle } catch { }   # keep a handle so the exit code stays readable
    $d.pid = $proc.Id
    try { $d.proc_start = [string]$proc.StartTime.ToUniversalTime().Ticks } catch { $d.proc_start = '' }
    $d.state = 'running'
    $State.daily.wakes = [int]$State.daily.wakes + 1
    $script:Procs[$id] = $proc
    $script:LastLaunched = $id
    [void]$State.flags.Remove('last_block')
    Save-State $State
    Write-Log ('Dispatched {0} to the Codex coordinator thread {1} (pid {2}; {3} item(s); workspace-write sandbox, no network): {4}' -f $id, $Coord.session_id, $proc.Id, $batch.Count,
        (($batch | ForEach-Object { $_.detail }) -join '; '))
}

function Set-DispatchHalted([hashtable]$State, [hashtable]$D, [string]$Why) {
    # A coordinator turn that must not start: nothing started, nothing delivered. Its notifications wait, and coordinator
    # turns stop until -ClearHalt. No backoff: the cause does not go away by itself.
    $D.state = 'failed'; $D.error = $Why; $D.finished_utc = Get-Now; $D.outcome = 'not delivered (relay halted)'; $D.guard = $null
    foreach ($nid in @($D.items)) {
        $n = $State.notes[$nid]
        if ($n) { $n.state = 'pending'; $n.dispatch_id = ''; $n.outcome = "kept: $Why" }
    }
    if (-not $State.halt) {
        $State.halt = $Why
        Add-Alert $State '' "Relay halted before coordinator turn $($D.id) started: $Why. Pending notifications are kept. Fix it, then run bridge-relay.ps1 -ClearHalt."
    }
    Write-Log "Dispatch $($D.id) not started (halt): $Why"
    Add-LedgerLine $D '-'
    Remove-DispatchFiles $D
}

function Test-DispatchGuard([hashtable]$State, [hashtable]$D) {
    # After a Codex or Gemini CLI coordinator turn: the program files against the stamps its record kept from its start.
    # A change halts the relay (after the turn's own outcome is recorded). Compared once: the stamps are dropped then.
    if (-not ($D.guard -is [hashtable])) { return }
    $seen = Get-RelayFileStamps $true
    $changed = Get-RelayFileChange $D.guard $seen   # a variable first: the list comes back as one array
    $D.guard = $null
    if ($changed.Count) { Set-GuardHalt $State $changed "during coordinator turn $($D.id)" }
}

function Complete-ToolDispatch([hashtable]$State, [hashtable]$D) {
    # The end of a coordinator turn that is not Claude Code's. Delivery is decided by evidence, as for Claude Code: the
    # tool's own events and the notice's marker in the thread file. The exit code only picks the words, and a turn this
    # relay process did not start (no exit code) is decided the same way.
    $dispatchTool = Get-DispatchTool $D
    if ($dispatchTool -ne 'codex') {
        # Not built yet (Gemini CLI): only a state.json from a newer relay can hold such a turn. This relay cannot read
        # its outcome, so the turn counts as not delivered, and its notifications stay pending.
        if ($script:Procs.ContainsKey($D.id)) { [void]$script:Procs.Remove($D.id) }
        Set-DispatchFailed $State $D ("this relay cannot read the outcome of a coordinator turn in '{0}' yet" -f $dispatchTool)
        return
    }
    $now = Get-Now
    $exit = $null
    if ($script:Procs.ContainsKey($D.id)) {
        $p = $script:Procs[$D.id]
        try { $p.WaitForExit(); $exit = $p.ExitCode } catch { }
        [void]$script:Procs.Remove($D.id)
    }
    $D.exit_code = $exit
    $exitWord = $(if ($null -eq $exit) { 'unknown' } else { [string]$exit })
    $ev = Read-CodexEvents $D.out
    $marker = Test-DispatchMarker $D
    $errText = ''
    try { if ($D.err -and (Test-Path -LiteralPath $D.err)) { $errText = Get-Short (Read-SharedText $D.err) 300 } } catch { }
    $D.finished_utc = $now
    $D.result_session = [string]$ev.thread
    if ($ev.message) { $D.summary = Get-Short $ev.message 300 }
    $State.last_finish_utc = $now
    $enrolled = ([string]$D.session_id).ToLowerInvariant()
    $delivered = $true
    if ($ev.thread -and $ev.thread -ne $enrolled) {
        $D.state = 'completed'
        $D.outcome = "SESSION MISMATCH: Codex used thread $($ev.thread), enrolled is $enrolled"
        Set-ItemsDone $State $D 'delivered to a different thread; not replayed'
        $State.halt = "session mismatch on $($D.id): Codex reported thread $($ev.thread) instead of the enrolled $enrolled"
        Add-Alert $State '' "Relay halted: coordinator turn $($D.id) ran in Codex thread $($ev.thread), not the enrolled $enrolled. Check the enrollment (-Enroll -Tool codex), then run -ClearHalt."
    } elseif ($ev.completed -and -not $ev.failed) {
        $D.state = 'completed'
        $D.outcome = 'success'
        Set-ItemsDone $State $D 'completed: the coordinator turn ended successfully (Codex)'
        $State.failures = 0
        $State.next_attempt_utc = 0
    } elseif (-not $marker) {
        # Not delivered: backoff, the notifications wait, and the relay halts after MaxFailures in a row.
        $msg = "Codex ended without a result (exit $exitWord)"
        if ($ev.failed) { $msg = "the Codex turn failed before the notice reached the thread: $($ev.failed)" }
        elseif ($ev.error) { $msg = "Codex reported an error before the notice reached the thread: $($ev.error)" }
        if ($errText) { $msg += ": $errText" }
        Set-DispatchFailed $State $D $msg
        $delivered = $false
    } elseif ($ev.failed -or $ev.error) {
        $D.state = 'completed'
        $D.outcome = 'turn ended with an error; delivered, not replayed'
        $D.error = Get-Short ("$($ev.failed) $($ev.error)") 300
        Set-ItemsDone $State $D 'delivered; the turn ended with an error; not replayed'
        Add-Backoff $State
        Add-Alert $State '' "Coordinator turn $($D.id) (Codex) ended with an error: $($D.error). Not replayed."
        if ([int]$State.failures -ge $MaxFailures) {
            $State.halt = "$($State.failures) consecutive failed coordinator turns; last: $($D.error)"
            Add-Alert $State '' "Relay halted after $($State.failures) consecutive failed coordinator turns. Run -ClearHalt after checking."
        }
    } else {
        $D.state = 'completed'
        $D.outcome = 'unknown: Codex ended without a result, but the notice is in the thread (delivered; not replayed)'
        if ($errText) { $D.error = $errText }
        Set-ItemsDone $State $D 'delivered; terminal outcome unknown (not replayed)'
        Add-Alert $State '' "Coordinator turn $($D.id) (Codex) ended without a result (exit $exitWord) after its notice reached the thread. Not replayed. Check the coordinator's status files."
    }
    if ($delivered) { Copy-CoordinatorBoard $D }   # the turn's own folder: its board may have changed
    Test-DispatchGuard $State $D   # every turn that ran, whatever its outcome
    if (-not $delivered) { return }   # Set-DispatchFailed wrote the ledger line and removed the turn's files
    Write-Log ('Dispatch {0} {1}: {2}; exit {3}' -f $D.id, $D.state, $D.outcome, $exitWord)
    Add-LedgerLine $D '-'
    Remove-DispatchFiles $D
}

function Show-ToolCoordinatorStatus([hashtable]$State, [hashtable]$Coord) {
    # -Status for a coordinator that is not a Claude Code session.
    $coordTool = Get-CoordTool $Coord
    if ($coordTool -eq 'codex') {
        $found = [bool](Get-CodexRolloutPath (Get-CoordinatorCodexTarget $Coord))
        $held = Test-CodexThreadLocked ([string]$Coord.session_id)
        Write-Host "Coordinator: ENROLLED Codex thread $($Coord.session_id) (folder $($Coord.cwd); enrolled $($Coord.enrolled); thread file found: $found; open in another Codex program now: $held)"
        if ($Coord.follow_name) {
            $sw = ''
            if ($Coord.followed) { $sw = "; last switch $($Coord.followed), from $($Coord.previous_session_id)" }
            Write-Host "Coordinator follows the Codex thread name '$($Coord.follow_name)': the newest live thread with that name is woken$sw"
        }
        Write-Host ("Coordinator turns: Codex's workspace-write sandbox, with no network; a turn can write only $($Coord.cwd) and $Root\tasks. " +
            "The relay copies $($Coord.cwd)\STATUS.md into the mailbox after each turn. Each turn counts toward the daily wake limit; Codex reports no cost.")
    } elseif ($coordTool -eq 'gemini') {
        $tp = [bool]($Coord.transcript_path -and (Test-Path -LiteralPath ([string]$Coord.transcript_path) -PathType Leaf))
        Write-Host "Coordinator: ENROLLED Gemini CLI session $($Coord.session_id) (folder $($Coord.cwd); enrolled $($Coord.enrolled); session file found: $tp)"
        Write-Host 'Coordinator turns: this copy of the relay cannot wake a coordinator in Gemini CLI yet, so nothing is sent; pending notifications are kept.'
    } else {
        Write-Host "Coordinator: ENROLLED with an AI tool the relay does not know ('$coordTool'). Nothing is sent. Enroll again with -Enroll -Tool claude, codex or gemini."
        return
    }
    $procs = Get-SessionProcesses ([string]$Coord.session_id)
    if ($null -eq $procs) { Write-Host 'Coordinator open now: unknown (the process list could not be read)' }
    elseif ($procs.Count -gt 0) { Write-Host ("Coordinator open now in pid {0}: the relay waits until it is closed" -f (($procs | ForEach-Object { $_.ProcessId }) -join ',')) }
}

# ---------- Phase 6: placeholders for later steps ----------
# The coordinator's plumbing already calls these. Each one refuses or does nothing, in plain words, until the next step
# of Phase 6 builds it: a Gemini CLI coordinator. scripts/check.js refuses a second definition of a name, so the step
# that builds one replaces it here. With a Claude Code or Codex coordinator none of them changes what the relay does.

function Get-GeminiCoordinatorBusy([hashtable]$State, [hashtable]$Coord) {
    # Placeholder (a Gemini CLI coordinator): every turn waits, so nothing is sent, and the reason is logged once.
    return 'this relay cannot wake a coordinator in Gemini CLI yet (.relay\coordinator.json names gemini). Pending notifications are kept. Enroll a Claude Code or Codex coordinator with -Enroll'
}

function Test-GeminiMarker([hashtable]$D) {
    # Placeholder (a Gemini CLI coordinator): no Gemini CLI session file is read yet, so no notice is found there.
    return $false
}

function Invoke-EnrollGeminiCoordinator {
    # Placeholder (a Gemini CLI coordinator): refuses, and saves nothing.
    Fail 'A coordinator in Gemini CLI is not ready in this copy of the relay yet. Enroll a Claude Code coordinator (-Enroll -SessionName <name>) or a Codex coordinator (-Enroll -Tool codex -ThreadName <name>) for now. Nothing was saved.' 64
}

# ---------- main ----------
switch ($Mode) {
    'Status' { Show-Status; exit 0 }
    'Stop'   { Invoke-Stop; exit 0 }
    'ShowCoordinatorArgs' { Show-CoordinatorArgs; exit 0 }
    'DryRun' {
        $dry = Get-State   # in-memory copy only; CanWrite stays false, so nothing is written
        Write-Note "DRY-RUN on $Root (read-only; no CLI, no key, no API credit)."
        if ($HqRole) { Show-HqProjects }
        Invoke-Tick $dry $true
        exit 0
    }
    # HQ owner commands. They change no relay state, so they run without the writer lock.
    'NewProject'     { Invoke-NewProject; exit 0 }
    'UpdateProjects' { Invoke-UpdateProjects; exit 0 }
    'StopAll'        { Invoke-StopAll; exit 0 }
    'StartAll' {
        Invoke-StartAll   # the projects' windows; then HQ's own loop runs here, as with -Start
        if (-not $script:StartHq) { exit 0 }
        $Mode = 'Start'
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
