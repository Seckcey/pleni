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
    -Box   with -Send: write to an agent in another mailbox of this HQ: hq, or a project id from HQ's list of
           projects. The message gets a Box line with this mailbox's own box id, so an answer finds its way back.
  The relay (bridge-relay.ps1 -EnrollAgent) wakes an agent whose Codex thread is closed when mail waits for it.
  An agent whose window is open reads its own mail, with -Wait or -Read.
  In a turn that the relay started for an agent with the relay's rules, the relay names the agent, its mailbox and its
  folder (RELAY_AGENT_NAME, RELAY_AGENT_MAILBOX, RELAY_AGENT_FOLDER). This script then works only for that agent: its
  own name in -From and -Me, its own mailbox, a -TextFile in its own folder, and no -NewAgent. A copy of this script in
  a mailbox's bin folder serves only that mailbox. In the turns it starts, the relay also sets RELAY_MAIL_HOP; -Send
  then writes a Hop line, so the relay can see two agents that keep waking each other.
  It never writes or moves mail through a folder that is a link.
  Names: 1-80 letters, digits, spaces and the marks . _ - # + ', starting with a letter or a digit. Case, runs of
  spaces and marks around a name (* _ ` " ') do not count, the same way the relay compares names.
  It writes only under <mailbox>\mail, and with -Box under the other mailbox's mail folder. Windows PowerShell 5.1
  compatible. ASCII only.

.EXAMPLE
  .\bin\agent-mail.ps1 -Send -From 'Colonel' -To 'Sergeant Lark' -Text 'Start T-12. Report when done.'
  .\bin\agent-mail.ps1 -Send -From 'Colonel' -To 'Sergeant Lark,Sergeant Wren' -TextFile C:\Users\ada\order.md
  .\bin\agent-mail.ps1 -Send -From 'Sergeant Kit' -To 'Orchestrator' -Box hq -Text 'T-12 is done.'
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
    [string]$Box,           # -Send: hq or a project id: write to an agent in another mailbox of this HQ
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

# The mailbox. A copy of this script in a mailbox's bin folder serves only that mailbox: the relay watches that copy,
# and an agent's rules name it. The repository's copy (in relay\, which is no mailbox) takes any -MailboxRoot.
$hereDir = $PSScriptRoot
if (-not $hereDir) { $hereDir = Split-Path -Parent $MyInvocation.MyCommand.Path }
$ownBox = Split-Path -Parent $hereDir   # the folder above bin\
$ownIsMailbox = (Test-Path -LiteralPath (Join-Path $ownBox 'CODEX-QUEUE.md')) -or (Test-Path -LiteralPath (Join-Path $ownBox 'tasks'))
$boxGiven = $PSBoundParameters.ContainsKey('MailboxRoot')
if (-not $MailboxRoot) { $MailboxRoot = $ownBox }
$Root = [IO.Path]::GetFullPath($MailboxRoot).TrimEnd('\')
if ($ownIsMailbox -and $boxGiven -and $Root -ne [IO.Path]::GetFullPath($ownBox).TrimEnd('\')) {
    Fail "This copy of agent-mail.ps1 serves only the mailbox $ownBox. Leave -MailboxRoot out, run the copy in the other mailbox's bin folder, or use -Box to write to another mailbox of this HQ." 64
}
if (-not (Test-Path -LiteralPath $Root -PathType Container)) { Fail "Mailbox folder not found: $Root" }
if (-not ((Test-Path -LiteralPath (Join-Path $Root 'CODEX-QUEUE.md')) -or (Test-Path -LiteralPath (Join-Path $Root 'tasks')))) {
    Fail "This does not look like a mailbox (no CODEX-QUEUE.md and no tasks folder): $Root. Run the copy in <mailbox>\bin, or pass -MailboxRoot <mailbox folder>."
}
$MailDir = Join-Path $Root 'mail'

# ---------- names ----------
# The helpers below read one box: this mailbox by default, or with -Box the mailbox the mail goes to. Their parameters
# are never named $Box, and no local shares a name with a script parameter (names ignore case).
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

function Get-OwnerName([string]$BoxRoot = $Root) {
    $f = [IO.Path]::Combine($BoxRoot, 'bin', 'relay-settings.json')
    if (-not (Test-Path -LiteralPath $f -PathType Leaf)) { return '' }
    try {
        $on = (Get-CleanName ([string](Get-Content -LiteralPath $f -Raw | ConvertFrom-Json).owner_name))
        if ($on -and -not (Get-NameProblem $on)) { return $on }
    } catch { }
    return ''
}

function Get-EnrolledEntries([string]$BoxRoot = $Root) {
    # The entries of .relay\agents.json (written by bridge-relay.ps1), or $null. Never throws.
    $f = [IO.Path]::Combine($BoxRoot, '.relay', 'agents.json')
    if (-not (Test-Path -LiteralPath $f -PathType Leaf)) { return $null }
    try { return (ConvertFrom-Json -InputObject (Read-SharedText $f)) } catch { return $null }
}

function Get-EnrolledAgents([string]$BoxRoot = $Root) {
    # name key -> name: the agents the relay wakes for their mail.
    $out = @{}
    $j = Get-EnrolledEntries $BoxRoot
    if ($null -eq $j) { return $out }
    foreach ($p in @($j.PSObject.Properties)) { if ($p.Value.name) { $out[[string]$p.Name] = [string]$p.Value.name } }
    return $out
}

function Get-EnrolledTools([string]$BoxRoot = $Root) {
    # name key -> the AI tool the relay wakes the agent in (an entry from before Phase 7 has none: codex).
    $out = @{}
    $j = Get-EnrolledEntries $BoxRoot
    if ($null -eq $j) { return $out }
    foreach ($p in @($j.PSObject.Properties)) {
        if (-not $p.Value.name) { continue }
        $t = ([string]$p.Value.tool).Trim().ToLowerInvariant()
        if (-not $t) { $t = 'codex' }
        $out[[string]$p.Name] = $t
    }
    return $out
}

function Get-KnownName([string]$Name, [string]$Dir = $MailDir) {
    # The name as the agent's mail folder (in the mail folder $Dir) spells it, else the name as given.
    $nf = [IO.Path]::Combine($Dir, (Get-NameKey $Name), 'name.txt')
    if (Test-Path -LiteralPath $nf -PathType Leaf) {
        try {
            $n = (Read-SharedText $nf).Trim()
            if ($n -and -not (Get-NameProblem $n) -and (Get-NameKey $n) -eq (Get-NameKey $Name)) { return $n }
        } catch { }
    }
    return $Name
}

function Get-KnownNames([string]$BoxRoot = $Root) {
    # name key -> name, for every agent with a mail folder, every agent the relay wakes, and the owner, in one box.
    $known = @{}
    $md = [IO.Path]::Combine($BoxRoot, 'mail')
    if (Test-Path -LiteralPath $md -PathType Container) {
        foreach ($d in @(Get-ChildItem -LiteralPath $md -Directory -ErrorAction SilentlyContinue)) {
            $nf = Join-Path $d.FullName 'name.txt'
            $n = $d.Name
            if (Test-Path -LiteralPath $nf -PathType Leaf) { try { $n = (Read-SharedText $nf).Trim() } catch { } }
            $known[$d.Name] = $n
        }
    }
    $enrolled = Get-EnrolledAgents $BoxRoot
    foreach ($k in @($enrolled.Keys)) { if (-not $known.ContainsKey($k)) { $known[$k] = $enrolled[$k] } }
    $owner = Get-OwnerName $BoxRoot
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

function Get-LinkProblem([string]$Path) {
    # '' unless $Path is a link (a junction or a symbolic link), even one whose target is gone, or cannot be looked at.
    # A path that is not there is ''. GetAttributes reads the path's own attributes; it does not follow a link.
    # Never throws.
    $at = $null
    try {
        $at = [IO.File]::GetAttributes($Path)
    } catch {
        $ex = $_.Exception
        while ($ex -is [Management.Automation.MethodInvocationException] -and $null -ne $ex.InnerException) { $ex = $ex.InnerException }
        if ($ex -is [IO.FileNotFoundException] -or $ex -is [IO.DirectoryNotFoundException]) { return '' }
        return "$Path could not be looked at"
    }
    if ($at -band [IO.FileAttributes]::ReparsePoint) { return "$Path is a link to another place; agent-mail.ps1 writes and moves mail only in plain folders" }
    return ''
}

function Get-AgentDirLinkProblem([string]$Name, [string]$Dir = $MailDir) {
    # '' unless the mail folder $Dir, the agent's folder in it, or its new or read folder is a link. Reads only.
    $ad = [IO.Path]::Combine($Dir, (Get-NameKey $Name))
    foreach ($p in @($Dir, $ad, [IO.Path]::Combine($ad, 'new'), [IO.Path]::Combine($ad, 'read'))) {
        $why = Get-LinkProblem $p
        if ($why) { return $why }
    }
    return ''
}

function Get-AgentDir([string]$Name, [bool]$Create, [string]$Dir = $MailDir) {
    # The agent's folder in the mail folder $Dir. With $Create it makes new\ and read\ and name.txt, never through a link.
    $ad = [IO.Path]::Combine($Dir, (Get-NameKey $Name))
    if ($Create) {
        $why = Get-AgentDirLinkProblem $Name $Dir
        if ($why) { Fail "$why. Nothing was sent." 3 }
        foreach ($d in @($ad, [IO.Path]::Combine($ad, 'new'), [IO.Path]::Combine($ad, 'read'))) {
            if (-not (Test-Path -LiteralPath $d -PathType Container)) { New-Item -ItemType Directory -Path $d -Force | Out-Null }
        }
        $nf = [IO.Path]::Combine($ad, 'name.txt')
        if (-not (Test-Path -LiteralPath $nf)) { [IO.File]::WriteAllText($nf, $Name, $Utf8) }
    }
    return $ad
}

function Get-NewMail([string]$Name) {
    $d = Join-Path (Get-AgentDir $Name $false) 'new'
    if (-not (Test-Path -LiteralPath $d -PathType Container)) { return , @() }
    # -Filter '*.md' also matches a short 8.3 name, so each name is checked again.
    return , @(Get-ChildItem -LiteralPath $d -File -Filter '*.md' -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '\.md$' } | Sort-Object Name)
}

# ---------- mailboxes of an HQ (the same rules as the relay's Get-MailBoxFolders) ----------
function Read-BoxSettings([string]$Dir) {
    # bin\relay-settings.json of a mailbox, or $null. [IO.Path]::Combine, never Join-Path: hq_dir may name a drive that
    # is not there. Never throws.
    try {
        $f = [IO.Path]::Combine($Dir, 'bin', 'relay-settings.json')
        if (-not (Test-Path -LiteralPath $f -PathType Leaf)) { return $null }
        return (ConvertFrom-Json -InputObject (Read-SharedText $f))
    } catch { return $null }
}

function Get-ListedBoxes($Settings) {
    # HQ's projects list: an ordered @{ id -> folder } of each well-formed entry whose folder is there.
    $found = [ordered]@{}
    if ($null -eq $Settings -or $null -eq $Settings.projects) { return $found }
    foreach ($pe in @($Settings.projects)) {
        if ($null -eq $pe) { continue }
        $id = ([string]$pe.id).Trim()
        if ($id -cnotmatch '^[a-z0-9][a-z0-9-]{0,39}$' -or $id -eq 'hq' -or $found.Contains($id)) { continue }
        $mb = ([string]$pe.mailbox).Trim()
        if (-not $mb -or $mb -match '[\x00-\x1f"%!^&|<>`*?]') { continue }
        try { $mb = [IO.Path]::GetFullPath($mb).TrimEnd('\') } catch { continue }
        $there = $false
        try { $there = Test-Path -LiteralPath $mb -PathType Container } catch { $there = $false }
        if (-not $there) { continue }
        $found[$id] = $mb
    }
    return $found
}

function Get-BoxFolders {
    # @{ own = this mailbox's box id, or '' when it is in no HQ; boxes = ordered @{ id -> folder }, itself included }.
    # HQ (role hq): hq and every listed project. A project (hq_dir): HQ and the projects HQ lists, only when HQ lists
    # this mailbox. Read-only. A dictionary leaves a function as one object.
    $r = @{ own = ''; boxes = [ordered]@{} }
    $set = Read-BoxSettings $Root
    if ($set -and ([string]$set.role).Trim() -eq 'hq') {
        $r.own = 'hq'
        $r.boxes['hq'] = $Root
        $listed = Get-ListedBoxes $set
        foreach ($id in @($listed.Keys)) { $r.boxes[$id] = $listed[$id] }
        return $r
    }
    $hqText = ''
    if ($set) { $hqText = ([string]$set.hq_dir).Trim() }
    if (-not $hqText) { return $r }
    $hq = ''
    try { $hq = [IO.Path]::GetFullPath($hqText).TrimEnd('\') } catch { return $r }
    if ($hq -eq $Root) { return $r }
    $there = $false
    try { $there = Test-Path -LiteralPath $hq -PathType Container } catch { $there = $false }
    if (-not $there) { return $r }
    $hs = Read-BoxSettings $hq
    if (-not $hs -or ([string]$hs.role).Trim() -ne 'hq') { return $r }
    $listed = Get-ListedBoxes $hs
    foreach ($id in @($listed.Keys)) { if ([string]$listed[$id] -eq $Root) { $r.own = $id } }
    if (-not $r.own) { return $r }   # HQ does not list this mailbox: no mail between boxes from here
    $r.boxes['hq'] = $hq
    foreach ($id in @($listed.Keys)) { $r.boxes[$id] = $listed[$id] }
    return $r
}

function Get-WroteToMe([string]$Name, [string]$FromBox) {
    # The senders of the newest 200 messages in this agent's own new\ and read\ folders whose Box line is $FromBox ('' =
    # this mailbox): @{ key -> name }. In a relay turn, such a name counts as known (D12), so the agent can answer
    # someone who has no mail folder here without -NewAgent.
    $out = @{}
    $ad = Get-AgentDir $Name $false
    $files = @()
    foreach ($sub in @('new', 'read')) {
        $d = [IO.Path]::Combine($ad, $sub)
        if (Test-Path -LiteralPath $d -PathType Container) { $files += @(Get-ChildItem -LiteralPath $d -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '\.md$' }) }
    }
    foreach ($f in @($files | Sort-Object Name -Descending | Select-Object -First 200)) {
        $m = [regex]::Match($f.Name, '^\d{8}-\d{6}-\d{3}-([a-z0-9-]{1,100}?)-[0-9a-f]{6}(?:-[0-9a-f]{4})?\.md$')
        if (-not $m.Success) { continue }
        $head = ''
        try { $head = @((Read-SharedText $f.FullName) -split "\r?\n\r?\n", 2)[0] } catch { continue }
        $b = [regex]::Match($head, '(?m)^Box:[ \t]*([a-z0-9][a-z0-9-]{0,39})[ \t]*\r?$')
        $lineBox = ''
        if ($b.Success) { $lineBox = $b.Groups[1].Value }
        if ($lineBox -ne $FromBox) { continue }
        $fm = [regex]::Match($head, '(?m)^From:[ \t]*([^\r\n]+)')
        $n = $m.Groups[1].Value
        if ($fm.Success) { $c = Get-CleanName $fm.Groups[1].Value; if ($c -and -not (Get-NameProblem $c) -and (Get-NameKey $c) -eq $m.Groups[1].Value) { $n = $c } }
        $out[$m.Groups[1].Value] = $n
    }
    return $out
}

# ---------- the agent pins ----------
function Get-Pins {
    # In a relay turn of an agent with the relay's rules: its name, mailbox and folder. $null outside one.
    $n = Get-CleanName ([string]$env:RELAY_AGENT_NAME)
    if (-not $n) { return $null }
    return @{ name = $n; mailbox = [string]$env:RELAY_AGENT_MAILBOX; folder = [string]$env:RELAY_AGENT_FOLDER }
}

function Test-Pins($Pins) {
    # Holds the caller to the agent the relay woke. Each refusal says what to do instead; nothing is read or sent.
    # The local is $pinKey, never $me: names ignore case, so $me would be the -Me parameter itself.
    if ($null -eq $Pins) { return }
    $mb = ''
    try { $mb = [IO.Path]::GetFullPath($Pins.mailbox).TrimEnd('\') } catch { $mb = '' }
    if (-not $mb -or $mb -ne $Root) { Fail "In this relay turn you are $($Pins.name) of the mailbox $($Pins.mailbox), and this script serves only that mailbox. Nothing was read or sent." 64 }
    $pinKey = Get-NameKey $Pins.name
    if ($Mode -eq 'Send' -and (Get-NameKey $From) -ne $pinKey) { Fail "In this relay turn you are $($Pins.name): send with -From '$($Pins.name)'. Nothing was sent." 64 }
    if (($Mode -eq 'Read' -or $Mode -eq 'Wait') -and (Get-NameKey $Me) -ne $pinKey) { Fail "In this relay turn you are $($Pins.name): read your own mail with -Me '$($Pins.name)'. Nothing was read." 64 }
    if ($Mode -ne 'Send') { return }
    if ($NewAgent) { Fail 'In this relay turn -NewAgent is not allowed: write to names that have mail there, or that wrote to you. Nothing was sent.' 64 }
    if ($TextFile) {
        $p = ''; $pinDir = ''
        try { $p = [IO.Path]::GetFullPath($TextFile); $pinDir = [IO.Path]::GetFullPath($Pins.folder).TrimEnd('\') } catch { $p = '' }
        if (-not $p -or -not $pinDir -or -not $p.StartsWith($pinDir + '\', [StringComparison]::OrdinalIgnoreCase)) { Fail "In this relay turn a -TextFile must be a file in your own folder $($Pins.folder). Nothing was sent." 64 }
        # No link on the way from the agent's folder to the file: a link could point at a login file.
        $d = $p
        while ($d -and $d.Length -gt $pinDir.Length) {
            $why = Get-LinkProblem $d
            if ($why -and $why.EndsWith('could not be looked at')) { Fail "-TextFile: $why. Nothing was sent." 64 }
            if ($why) { Fail "-TextFile goes through the link $d. Nothing was sent." 64 }
            $d = [IO.Path]::GetDirectoryName($d)
        }
    }
}

# ---------- modes ----------
function Invoke-Send {
    $pins = Get-Pins
    $fromName = Get-CleanName $From
    $why = Get-NameProblem $fromName
    if ($why) { Fail "-From: $why." 64 }
    $fromName = Get-KnownName $fromName
    # -Box first: every later check reads the mailbox the mail goes to.
    $target = $Root
    $wantBox = ''
    $boxLine = ''
    if ($Box) {
        $want = ([string]$Box).Trim().ToLowerInvariant()
        if ($want -cnotmatch '^[a-z0-9][a-z0-9-]{0,39}$') { Fail "-Box must be hq or a project id (got '$Box'). Nothing was sent." 64 }
        $bf = Get-BoxFolders
        if (-not $bf.own) { Fail 'This mailbox is not part of an HQ, so -Box has no other mailbox to reach. Leave -Box out. Nothing was sent.' 64 }
        if (-not $bf.boxes.Contains($want)) { Fail ("There is no mailbox '$want' here. Boxes: " + (@($bf.boxes.Keys) -join ', ') + '. Nothing was sent.') 3 }
        if ($want -ne $bf.own) { $target = [string]$bf.boxes[$want]; $wantBox = $want; $boxLine = [string]$bf.own }   # -Box naming this box sends here (D11)
    }
    $toDir = [IO.Path]::Combine($target, 'mail')
    $names = New-Object System.Collections.Generic.List[string]
    $keys = @{}
    foreach ($part in @(@($To) | ForEach-Object { ([string]$_) -split ',' })) {
        $n = Get-CleanName $part
        if (-not $n) { continue }
        $why = Get-NameProblem $n
        if ($why) { Fail "-To: $why. Nothing was sent." 64 }
        $k = Get-NameKey $n
        if (-not $boxLine -and $k -eq (Get-NameKey $fromName)) { Fail "-To names the sender, $fromName. Nothing was sent." 64 }
        if (-not $keys.ContainsKey($k)) { $keys[$k] = $true; $names.Add((Get-KnownName $n $toDir)) }
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
    $known = Get-KnownNames $target
    if ($pins) {
        # In a relay turn, a name that wrote to this agent from that box counts as known (D12).
        $w = Get-WroteToMe $pins.name $wantBox
        foreach ($k in @($w.Keys)) { if (-not $known.ContainsKey($k)) { $known[$k] = $w[$k] } }
    }
    if (-not $NewAgent) {
        $where = 'here'
        if ($wantBox) { $where = "in the mailbox '$wantBox'" }
        foreach ($n in $names) {
            if (-not $known.ContainsKey((Get-NameKey $n))) {
                $all = @($known.Values | Sort-Object)
                $have = 'none yet'
                if ($all.Count) { $have = $all -join ', ' }
                Fail "No agent named '$n' has mail $where. Known: $have. Check the name. To start mail for a new agent, add -NewAgent. Nothing was sent." 3
            }
        }
    }
    # No folder on the way is a link, for any name, before the first message is written.
    foreach ($n in $names) {
        $why = Get-AgentDirLinkProblem $n $toDir
        if ($why) { Fail "$why. Nothing was sent." 3 }
    }
    $sent = (Get-Date).ToUniversalTime()
    $head = "From: $fromName`r`nTo: " + ($names -join ', ') + "`r`nSent: " + $sent.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", $Inv) + "`r`n"
    if ($boxLine) { $head += "Box: $boxLine`r`n" }
    $hop = 0
    $hopText = ([string]$env:RELAY_MAIL_HOP).Trim()
    if ([regex]::IsMatch($hopText, '^[0-9]{1,3}$')) { $hop = [int]$hopText }
    if ($hop -ge 1 -and $hop -le 999) { $head += "Hop: $hop`r`n" }
    $content = $head + "`r`n" + $body.Trim() + "`r`n"
    $stamp = $sent.ToString('yyyyMMdd-HHmmss-fff', $Inv)
    $fromKey = Get-NameKey $fromName
    foreach ($n in $names) {
        $ad = Get-AgentDir $n $true $toDir
        $name = '{0}-{1}-{2}.md' -f $stamp, $fromKey, [guid]::NewGuid().ToString('N').Substring(0, 6)
        $tmp = [IO.Path]::Combine($ad, 'new', $name + '.part')
        # Written whole under another name first, so a reader never sees half a message.
        [IO.File]::WriteAllText($tmp, $content, $Utf8)
        [IO.File]::Move($tmp, [IO.Path]::Combine($ad, 'new', $name))
    }
    $inBox = ''
    if ($wantBox) { $inBox = " in the mailbox '$wantBox'" }
    Write-Host ('Sent to {0}{1}.' -f ($names -join ', '), $inBox)   # with no -Box: "Sent to <names>." as before
}

function Invoke-ReadMail([string]$Name) {
    # Nothing is read or moved through a folder that is a link.
    $why = Get-AgentDirLinkProblem $Name
    if ($why) { Fail "$why. Nothing was read." 3 }
    $files = Get-NewMail $Name
    if ($files.Count -eq 0) { Write-Host "No new mail for $Name."; return }
    $batch = @($files | Select-Object -First $ReadAtOnce)
    $readDir = Join-Path (Get-AgentDir $Name $true) 'read'
    $i = 0
    foreach ($f in $batch) {
        $i++
        if ($f.Attributes -band [IO.FileAttributes]::ReparsePoint) { Write-Host "Skipped $($f.Name): it is a link."; continue }
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
    $why = Get-AgentDirLinkProblem $Name
    if ($why) { Fail "$why. Nothing was read." 3 }
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
    $tools = Get-EnrolledTools
    $bf = Get-BoxFolders
    $title = "Agent mail in $MailDir"
    if ($bf.own) { $title += " (box $($bf.own))" }
    Write-Host $title
    if ($known.Count -eq 0) { Write-Host '  No agent has mail yet.'; return }
    foreach ($k in @($known.Keys | Sort-Object)) {
        $n = $known[$k]
        $files = Get-NewMail $n
        $line = '  {0,-28} {1} new' -f $n, $files.Count
        if ($files.Count) { $line += ', the oldest from ' + $files[0].LastWriteTime.ToString('yyyy-MM-dd HH:mm', $Inv) }
        if ($enrolled.ContainsKey($k)) {
            $line += '; the relay wakes it'
            if ($tools[$k] -eq 'claude') { $line += ' (Claude Code)' }
            if ($tools[$k] -eq 'gemini') { $line += ' (Gemini CLI)' }
        }
        Write-Host $line
    }
}

# In a relay turn of an agent with the relay's rules, every mode is held to that agent first (-List to its mailbox).
$pins = Get-Pins
Test-Pins $pins
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
