<#
.SYNOPSIS
  Agent mail: the agents of a mailbox send each other messages by name, without the Codex app.

.DESCRIPTION
  Each agent has a folder <mailbox>\mail\<name key>. Its new\ folder holds the messages it has not read yet, and
  read\ the ones it has. A message is a small Markdown file: a From, a To and a Sent line, a blank line, the text.
    -Send  writes one message to each agent named in -To.
    -Read  prints the agent's new messages, oldest first and at most 10 at a time, and moves them to read\.
    -Wait  waits up to -Seconds for new mail, then reads it like -Read. It takes the place of the Codex app's
           wait_threads.
    -List  shows each agent with a mail folder, how many messages wait for it, and whether the relay wakes it.
  The relay (bridge-relay.ps1 -EnrollAgent) wakes an agent whose Codex thread is closed when mail waits for it.
  An agent whose window is open reads its own mail, with -Wait or -Read.
  Names: 1-80 letters, digits, spaces and the marks . _ - # + ', starting with a letter or a digit. Case, runs of
  spaces and marks around a name (* _ ` " ') do not count, the same way the relay compares names.
  It writes only under <mailbox>\mail. Windows PowerShell 5.1 compatible. ASCII only.

.EXAMPLE
  .\bin\agent-mail.ps1 -Send -From 'Colonel' -To 'Sergeant Lark' -Text 'Start T-12. Report when done.'
  .\bin\agent-mail.ps1 -Send -From 'Colonel' -To 'Sergeant Lark,Sergeant Wren' -TextFile C:\Users\ada\order.md
  .\bin\agent-mail.ps1 -Read -Me 'Sergeant Lark'
  .\bin\agent-mail.ps1 -Wait -Me 'Colonel' -Seconds 50
  .\bin\agent-mail.ps1 -List
#>
[CmdletBinding()]
param(
    [switch]$Send,
    [switch]$Read,
    [switch]$Wait,
    [switch]$List,
    [string]$From,          # -Send: the sender's name
    [string[]]$To,          # -Send: one or more names, as a list or separated by commas
    [string]$Me,            # -Read, -Wait: the agent whose mail to read
    [string]$Text,          # -Send: the message
    [string]$TextFile,      # -Send: a file that holds the message (UTF-8), instead of -Text
    [switch]$NewAgent,      # -Send: allow a name that has no mail folder yet
    [ValidateRange(1, 3600)][int]$Seconds = 50,
    [string]$MailboxRoot    # default: the folder above bin\, where this script lives
)

$ErrorActionPreference = 'Stop'
$Inv  = [Globalization.CultureInfo]::InvariantCulture
$Utf8 = New-Object System.Text.UTF8Encoding($false)
$NameRe = "^[A-Za-z0-9][A-Za-z0-9 ._#+'-]{0,79}$"
$MaxBytes = 65536
$ReadAtOnce = 10
# Messages may hold any text; agents read this script's output as UTF-8.
try { [Console]::OutputEncoding = $Utf8 } catch { }

function Fail([string]$Message, [int]$Code = 2) {
    Write-Host "ERROR: $Message"
    exit $Code
}

$modes = @()
if ($Send) { $modes += 'Send' }
if ($Read) { $modes += 'Read' }
if ($Wait) { $modes += 'Wait' }
if ($List) { $modes += 'List' }
if ($modes.Count -ne 1) { Fail 'Pick one of -Send, -Read, -Wait or -List.' 64 }
$Mode = $modes[0]

if (-not $MailboxRoot) {
    $hereDir = $PSScriptRoot
    if (-not $hereDir) { $hereDir = Split-Path -Parent $MyInvocation.MyCommand.Path }
    $MailboxRoot = Split-Path -Parent $hereDir
}
$Root = [IO.Path]::GetFullPath($MailboxRoot).TrimEnd('\')
if (-not (Test-Path -LiteralPath $Root -PathType Container)) { Fail "Mailbox folder not found: $Root" }
if (-not ((Test-Path -LiteralPath (Join-Path $Root 'CODEX-QUEUE.md')) -or (Test-Path -LiteralPath (Join-Path $Root 'tasks')))) {
    Fail "This does not look like a mailbox (no CODEX-QUEUE.md and no tasks folder): $Root. Run the copy in <mailbox>\bin, or pass -MailboxRoot <mailbox folder>."
}
$MailDir = Join-Path $Root 'mail'

# ---------- names ----------
function Get-CleanName([string]$Name) {
    $t = (([string]$Name) -replace '\s+', ' ').Trim()
    return $t.Trim([char[]]@('*', '_', '`', '"', "'", ' '))
}

function Get-NameKey([string]$Name) {
    # The folder name: lower case, every run of other characters as one '-'.
    return ((Get-CleanName $Name).ToLowerInvariant() -replace '[^a-z0-9]+', '-').Trim('-')
}

function Get-NameProblem([string]$Name) {
    if (-not $Name) { return 'a name is empty' }
    if ($Name -notmatch $NameRe) { return "'$Name' is not a name: use 1-80 letters, digits, spaces and . _ - # + ' marks, starting with a letter or a digit" }
    $k = Get-NameKey $Name
    if (-not $k) { return "'$Name' has no letters or digits" }
    if ($k -match '^(con|prn|aux|nul|com[1-9]|lpt[1-9])$') { return "'$Name' is a name Windows keeps for itself" }
    return ''
}

function Get-OwnerName {
    $f = Join-Path $Root 'bin\relay-settings.json'
    if (-not (Test-Path -LiteralPath $f -PathType Leaf)) { return '' }
    try {
        $on = (Get-CleanName ([string](Get-Content -LiteralPath $f -Raw | ConvertFrom-Json).owner_name))
        if ($on -and -not (Get-NameProblem $on)) { return $on }
    } catch { }
    return ''
}

function Get-EnrolledAgents {
    # name key -> name: the agents the relay wakes for their mail (.relay\agents.json, written by bridge-relay.ps1).
    $out = @{}
    $f = Join-Path $Root '.relay\agents.json'
    if (-not (Test-Path -LiteralPath $f -PathType Leaf)) { return $out }
    try {
        $j = ConvertFrom-Json -InputObject (Read-SharedText $f)
        foreach ($p in @($j.PSObject.Properties)) { if ($p.Value.name) { $out[[string]$p.Name] = [string]$p.Value.name } }
    } catch { }
    return $out
}

function Get-KnownName([string]$Name) {
    # The name as the agent's mail folder spells it, else the name as given.
    $nf = Join-Path (Join-Path $MailDir (Get-NameKey $Name)) 'name.txt'
    if (Test-Path -LiteralPath $nf -PathType Leaf) {
        try {
            $n = (Read-SharedText $nf).Trim()
            if ($n -and -not (Get-NameProblem $n) -and (Get-NameKey $n) -eq (Get-NameKey $Name)) { return $n }
        } catch { }
    }
    return $Name
}

function Get-KnownNames {
    # name key -> name, for every agent with a mail folder, every agent the relay wakes, and the owner.
    $known = @{}
    if (Test-Path -LiteralPath $MailDir -PathType Container) {
        foreach ($d in @(Get-ChildItem -LiteralPath $MailDir -Directory -ErrorAction SilentlyContinue)) {
            $nf = Join-Path $d.FullName 'name.txt'
            $n = $d.Name
            if (Test-Path -LiteralPath $nf -PathType Leaf) { try { $n = (Read-SharedText $nf).Trim() } catch { } }
            $known[$d.Name] = $n
        }
    }
    $enrolled = Get-EnrolledAgents
    foreach ($k in @($enrolled.Keys)) { if (-not $known.ContainsKey($k)) { $known[$k] = $enrolled[$k] } }
    $owner = Get-OwnerName
    if ($owner) { $known[(Get-NameKey $owner)] = $owner }
    return $known
}

# ---------- files ----------
function Read-SharedText([string]$Path) {
    $fs = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
    try {
        $sr = New-Object System.IO.StreamReader($fs, $true)
        try { return $sr.ReadToEnd() } finally { $sr.Dispose() }
    } finally { $fs.Dispose() }
}

function Get-AgentDir([string]$Name, [bool]$Create) {
    $dir = Join-Path $MailDir (Get-NameKey $Name)
    if ($Create) {
        foreach ($d in @($dir, (Join-Path $dir 'new'), (Join-Path $dir 'read'))) {
            if (-not (Test-Path -LiteralPath $d -PathType Container)) { New-Item -ItemType Directory -Path $d -Force | Out-Null }
        }
        $nf = Join-Path $dir 'name.txt'
        if (-not (Test-Path -LiteralPath $nf)) { [IO.File]::WriteAllText($nf, $Name, $Utf8) }
    }
    return $dir
}

function Get-NewMail([string]$Name) {
    $d = Join-Path (Get-AgentDir $Name $false) 'new'
    if (-not (Test-Path -LiteralPath $d -PathType Container)) { return , @() }
    return , @(Get-ChildItem -LiteralPath $d -File -Filter '*.md' -ErrorAction SilentlyContinue | Sort-Object Name)
}

# ---------- modes ----------
function Invoke-Send {
    $fromName = Get-CleanName $From
    $why = Get-NameProblem $fromName
    if ($why) { Fail "-From: $why." 64 }
    $fromName = Get-KnownName $fromName
    $names = New-Object System.Collections.Generic.List[string]
    $keys = @{}
    foreach ($part in @(@($To) | ForEach-Object { ([string]$_) -split ',' })) {
        $n = Get-CleanName $part
        if (-not $n) { continue }
        $why = Get-NameProblem $n
        if ($why) { Fail "-To: $why. Nothing was sent." 64 }
        $k = Get-NameKey $n
        if ($k -eq (Get-NameKey $fromName)) { Fail "-To names the sender, $fromName. Nothing was sent." 64 }
        if (-not $keys.ContainsKey($k)) { $keys[$k] = $true; $names.Add((Get-KnownName $n)) }
    }
    if ($names.Count -eq 0) { Fail '-To needs at least one name. Nothing was sent.' 64 }
    if ($names.Count -gt 20) { Fail '-To names more than 20 agents. Nothing was sent.' 64 }
    if ($Text -and $TextFile) { Fail 'Give -Text or -TextFile, not both.' 64 }
    $body = [string]$Text
    if ($TextFile) {
        if (-not (Test-Path -LiteralPath $TextFile -PathType Leaf)) { Fail "-TextFile not found: $TextFile" }
        if ((Get-Item -LiteralPath $TextFile).Length -gt $MaxBytes) { Fail "The message is longer than 64 KB. Nothing was sent." }
        $body = Read-SharedText $TextFile
    }
    if (-not $body.Trim()) { Fail 'The message is empty. Nothing was sent.' 64 }
    if ($Utf8.GetByteCount($body) -gt $MaxBytes) { Fail 'The message is longer than 64 KB. Nothing was sent.' 64 }
    $known = Get-KnownNames
    if (-not $NewAgent) {
        foreach ($n in $names) {
            if (-not $known.ContainsKey((Get-NameKey $n))) {
                $list = @($known.Values | Sort-Object)
                $have = 'none yet'
                if ($list.Count) { $have = $list -join ', ' }
                Fail "No agent named '$n' has mail here. Known: $have. Check the name. To start mail for a new agent, add -NewAgent. Nothing was sent." 3
            }
        }
    }
    $sent = (Get-Date).ToUniversalTime()
    $head = "From: $fromName`r`nTo: " + ($names -join ', ') + "`r`nSent: " + $sent.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", $Inv) + "`r`n`r`n"
    $content = $head + $body.Trim() + "`r`n"
    $stamp = $sent.ToString('yyyyMMdd-HHmmss-fff', $Inv)
    $fromKey = Get-NameKey $fromName
    foreach ($n in $names) {
        $dir = Get-AgentDir $n $true
        $name = '{0}-{1}-{2}.md' -f $stamp, $fromKey, [guid]::NewGuid().ToString('N').Substring(0, 6)
        $tmp = Join-Path $dir ('new\' + $name + '.part')
        # Written whole under another name first, so a reader never sees half a message.
        [IO.File]::WriteAllText($tmp, $content, $Utf8)
        [IO.File]::Move($tmp, (Join-Path $dir ('new\' + $name)))
    }
    Write-Host ('Sent to {0}.' -f ($names -join ', '))
}

function Invoke-ReadMail([string]$Name) {
    $files = Get-NewMail $Name
    if ($files.Count -eq 0) { Write-Host "No new mail for $Name."; return }
    $batch = @($files | Select-Object -First $ReadAtOnce)
    $readDir = Join-Path (Get-AgentDir $Name $true) 'read'
    $i = 0
    foreach ($f in $batch) {
        $i++
        $t = ''
        try { $t = Read-SharedText $f.FullName } catch { Write-Host "Could not read $($f.Name): $($_.Exception.Message)"; continue }
        Write-Host ('===== Message {0} of {1} for {2} =====' -f $i, $batch.Count, $Name)
        Write-Host $t.TrimEnd()
        Write-Host ''
        $dest = Join-Path $readDir $f.Name
        if (Test-Path -LiteralPath $dest) { $dest = Join-Path $readDir ($f.BaseName + '-' + [guid]::NewGuid().ToString('N').Substring(0, 4) + '.md') }
        try { [IO.File]::Move($f.FullName, $dest) } catch { Write-Host "NOTE: could not move $($f.Name) to read\ ($($_.Exception.Message)); it shows again next time." }
    }
    $left = $files.Count - $batch.Count
    if ($left -gt 0) { Write-Host "$left more message(s) wait. Run -Read again." }
    Write-Host ("To answer: agent-mail.ps1 -Send -From '{0}' -To '<name>' -Text '<answer>' (or -TextFile <file>)." -f $Name)
}

function Invoke-WaitMail([string]$Name) {
    $deadline = (Get-Date).AddSeconds($Seconds)
    while ((Get-NewMail $Name).Count -eq 0) {
        if ((Get-Date) -ge $deadline) { Write-Host "No new mail for $Name after $Seconds seconds."; return }
        Start-Sleep -Milliseconds 1000
    }
    Invoke-ReadMail $Name
}

function Invoke-ListMail {
    $known = Get-KnownNames
    $enrolled = Get-EnrolledAgents
    Write-Host "Agent mail in $MailDir"
    if ($known.Count -eq 0) { Write-Host '  No agent has mail yet.'; return }
    foreach ($k in @($known.Keys | Sort-Object)) {
        $n = $known[$k]
        $files = Get-NewMail $n
        $line = '  {0,-28} {1} new' -f $n, $files.Count
        if ($files.Count) { $line += ', the oldest from ' + $files[0].LastWriteTime.ToString('yyyy-MM-dd HH:mm', $Inv) }
        if ($enrolled.ContainsKey($k)) { $line += '; the relay wakes it' }
        Write-Host $line
    }
}

switch ($Mode) {
    'Send' { Invoke-Send }
    'List' { Invoke-ListMail }
    default {
        $name = Get-CleanName $Me
        $why = Get-NameProblem $name
        if ($why) { Fail "-Me: $why." 64 }
        $name = Get-KnownName $name
        if ($Mode -eq 'Read') { Invoke-ReadMail $name } else { Invoke-WaitMail $name }
    }
}
exit 0
