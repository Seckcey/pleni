# Privacy in Pleni

Pleni runs on your own computer. It reads files that Claude Code, Codex, Grok, Kimi Code, Gemini CLI and Antigravity CLI already write, and it
shows what it finds in your browser. This page says exactly what it reads, what it shows, and
what it never does.

## The short version

- Pleni **reads** session files. It **writes** only in its own folder: its settings, its key, the
  list of notices you dismissed, and, if you set a password, its hash and the list of signed-in
  devices. The one exception is the **Models** page, off until you turn
  it on: when you choose **Save to Codex** or **Save to Claude Code**, it changes the model and
  effort settings of that tool, after it keeps a copy of the old file (see [below](#models)).
- Pleni **starts** nothing, unless you turn on **Open in PowerShell**, **Roll over**, **New
  agent** or **Bring a cloud session here** and click a button. Then it opens one PowerShell
  window. You do the typing, except for Roll over's one short message, which the page shows you
  before you click.
- Pleni makes **no network calls** of its own. It has no telemetry, no tracking, and no account.
  Its only sign-ins are its own key and the password you can set, both kept on your computer.
- The ways out are **Live GitHub status** and **Codex cloud tasks**, both off until you turn them
  on. Then the GitHub CLI (`gh`) on your computer asks GitHub about your pull requests for Pleni
  (see [below](#live-github-status-and-merge)), or the Codex program asks OpenAI for the list of
  your Codex cloud tasks (see [below](#codex-cloud-tasks)).
- Pleni opens only on your own computer (`127.0.0.1`), unless you turn on Wi-Fi access or set up
  Tailscale yourself, and only for a browser that signed in with the key Pleni prints when it
  starts, or with your password.
- You can turn session text off. Then the page shows only names, tools, and states.

## What Pleni reads

Pleni reads only the places below, and only the parts it needs. For session files (the
transcripts of Claude Code, Codex, Grok, Kimi Code, Gemini CLI and Antigravity CLI sessions and their helpers) it looks only at files that
changed in the last 24 hours (the `recentHours` setting). The small notes files of the Claude
desktop app, the mailbox's task files, the Codex list of session names, Gemini CLI's
`projects.json` and `.project_root` files, and Antigravity CLI's two cache lists and its
`history.jsonl` are read whatever their age, because they say which session is which and which
folder it works in. For big files Pleni reads from the end, about the last 4 MB at first, and then
only the new lines as they are added. It may also read the start of a file once, to find a
session's name and where it started. For a big Kimi Code or Antigravity CLI log, it also looks
through up to 16 MB before that last part, only to find the helpers the session started (and, for
Antigravity CLI, the role each was given). It may look at the start and those 16 MB again when the
tool writes the log over or after a long gap, so a log under about 20 MB may be read whole.

| Where                                   | What Pleni reads                                                                                         |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Claude Code folder (usually `~/.claude`) | Session files in `projects/`, and the helper (sub-agent) files and notes stored next to them              |
| Claude desktop app folder                | Only these fields of each session's notes file: session id, title, title source, model, effort, folder, archived, last activity time |
| Codex folder (usually `~/.codex`)        | Session files in `sessions/` and `archived_sessions/`, and the list of session names in `session_index.jsonl` |
| Grok folder (usually `~/.grok`)          | Each session's summary and its event, chat and update logs in `sessions/` |
| Kimi Code folder (usually `~/.kimi-code`) | Each session's `state.json` and its agents' `wire.jsonl` logs in `sessions/` |
| Gemini CLI folder (usually `~/.gemini`)  | Only three things in it: each session's chat log in `tmp/<project>/chats/` (and its helpers' logs in a folder there named after the session), the small `.project_root` file in `tmp/<project>/` that names the project's folder, and `projects.json`, the list of your project folders. Never the login files (`oauth_creds.json`, `google_accounts.json`, `gemini-credentials.json`), `settings.json`, `trustedFolders.json` or any `.env` file. Of each reply's thoughts, Pleni keeps only that there were some, and when |
| Antigravity CLI folder (usually `~/.gemini/antigravity-cli`) | Only four things in it: each conversation's log in `brain/<conversation>/.system_generated/logs/` (`transcript_full.jsonl`, or `transcript.jsonl` when there is no uncut one), and three small lists that say which folder each conversation works in: `cache/conversation_metadata.json` (also its title), `cache/last_conversations.json` and `history.jsonl` (also the first prompt you typed, used as a name when nothing else gives one, or when Antigravity CLI has cleared that prompt from the log to save space). Never your login (it is kept in the system's own password store, or a file such as `antigravity-oauth-token`), `settings.json`, the conversation databases (`.db` and `-wal` files) or anything else in the folder, such as a conversation's plans and notes. Of each reply's thinking, Pleni keeps only that there was some |
| Codex folder, while Settings → Models is open | From `config.toml`, only the model and effort lines (`model`, `model_reasoning_effort`, and `default_subagent_model` and `default_subagent_reasoning_effort` under `[agents]`); the whole file is read to find them, and nothing else in it is kept or shown. From each worker type file in `agents/`, its name, description, model and effort. From `models_cache.json`, the list of models Codex offers you: each model's name and the effort levels it takes |
| Claude Code folder, while Settings → Models is open | From `settings.json`, only `model`, the effort kept for each model under `modelSettings`, and from its `env` block only `CLAUDE_CODE_SUBAGENT_MODEL`, `ANTHROPIC_MODEL`, `CLAUDE_CODE_EFFORT_LEVEL` and `CLAUDE_CODE_SUBAGENT_MODEL_FORCE`; the whole file is read to find them, and nothing else in it is shown. From each agent file in `agents/`, the name, description, model and effort in the block at its top. The same three setting names are also looked up in Pleni's own environment |
| Codex coordinator list, if present      | `coordinators/registry.sqlite3` (opened read-only) and `coordinators/superintendent.json`, only to learn which coordinator started which worker |
| A mailbox folder, if you turn one on    | The Markdown files of the queue, the status board, and each task (with any worker run notes), the notes for you (`NEEDS-<NAME>.md`), plus the small relay files in `.relay/`, its alerts (`alerts.md`) and the list of agents it wakes for mail (`agents.json`) among them. With agent mail, also the `mail/` folder: each agent's name (`name.txt`) and its messages, the newest 100 unread and the newest 30 read (the first 80 KB of each). While the Mail page is open, Pleni reads the whole of the newest 100 messages it shows. From the relay's settings (`bin/relay-settings.json`) Pleni reads only `owner_name`, the name agents use to write to you, and `role` and `projects`, which say whether the folder is an HQ and which project mailboxes it lists |
| The project mailboxes an HQ lists, if your mailbox folder is an HQ | The same files as in a mailbox folder, in each project mailbox that HQ's `bin/relay-settings.json` lists (at most 20, each a full path that is not HQ itself or inside HQ's own folders). In HQ itself, Pleni also reads `.relay/codex.json`, only for the id of the Codex thread HQ's relay wakes (the orchestrator), and from `.relay/state.json` when that relay woke it. Pleni only reads these mailboxes: it never writes to them, and it never sends their folder paths to the page |
| A session's project folder, only when it is inside a `_worktrees` folder on a local drive | Only the small `.git` pointer file (at most 4 KB) of that worktree, to learn the name of the repository it belongs to |
| A session's project folder, on a local drive | Only the git settings file (`.git/config`, at most 64 KB) of the repository it is in, and in a worktree the small `.git` and `commondir` files that lead there. Pleni keeps only the address of the `origin` remote, and from it only the owner and name of a GitHub repository, to link to its pull requests. It never keeps a login or token that the address may hold. Nothing else in your project is read |
| Claude Code folder, only when you click Open in PowerShell | The small files in `sessions/` that Claude Code keeps for each running process. Pleni reads only which session each one has open, whether it runs in the background or in a terminal, and its process number, to be sure no other window has that session open. To tell a live Claude Code from a leftover file, it then asks Windows (through a hidden PowerShell) only when the program with that number started |
| Codex folder, only when you click Open in PowerShell | One empty file, `thread-writer-locks/<thread id>.lock`, which Codex locks while a program writes that thread. Pleni tries to read one byte of it, only to learn whether another window has the thread open |
| The same two folders, when you click Roll over's buttons | The same small files as for Open in PowerShell, for the same reason |
| A session's own folder, only while its Roll over section is open | Only whether the handoff note (`HANDOFF-<name>.md`) is there, and when it last changed. Pleni never reads what is in it |
| Pleni's own folder                      | `settings.json` (your choices, including your list of projects: each one's name, folders, GitHub repositories and their short names; the folders are not part of the live view of your sessions), `key`, and `dismissed.json` (which notices you dismissed, and when) in Pleni's settings folder, `password` and `devices.json` once you set a password, and the copies of Codex's files in `backups/` |
| Pleni's own program folder, if it is a git copy | Only `.git/HEAD` and the one branch file it names (or `packed-refs`), to show which commit runs |

From the session files it uses: when each step happened, the working folder, the git branch, the
model and effort, the permission mode, which tool was used, short parts of the tool's input (see below), the
assistant's text, which session started which helper, and for "Roll over soon" only numbers: how
many tokens the newest step used, how big the model's memory is (Codex), and when the history was
squeezed into a summary and by how much.

Pleni also reads a few settings from your environment: `PLENI_PORT`, `PLENI_HOME`,
`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `GROK_HOME`, `KIMI_CODE_HOME`, `GEMINI_CLI_HOME` (the folder
that holds Gemini CLI's `.gemini` folder), and the usual system folders (`APPDATA` on Windows,
`XDG_CONFIG_HOME` on Linux). With Live GitHub status or Codex cloud tasks on, it also reads
`PATH`, to find gh or codex.

The [README](../README.md#where-it-looks) lists the usual folders for each system.

## What Pleni shows

Always:

- Your name (the one you type in Settings; "You" until you change it).
- Session names, project folder names, git branches, models, and effort.
- With Projects: the name and GitHub repositories of each project you added, the short names you
  gave its folders and repositories, and which sessions work in its folders. The folder paths are
  not part of the live view; they are kept in Pleni's settings.
- Each session's state (Needs you, Working, Finished, Idle, Done, Error), the name of the tool it is
  using, and when it last did something.
- Who started whom, and when work was handed down or reported back up.
- With agent mail: who sent mail to whom and when, how many messages wait for each agent, and when
  the relay woke an agent for its mail.
- In the Tasks view: mailbox task ids and states.

Only when the `content` setting is `snippets` (this is the default):

- A short note about the current tool step, at most 140 characters. It is built from the step's
  description, the first line of a command, a file's name (not its folder), a search's words or
  pattern, a helper's task description, the name of the agent a message goes to (never the
  message), a question the agent asks you, or a web site's host name.
- The last thing the assistant said, at most 280 characters.
- In the side panel: up to 200 recent steps, each with at most 2,000 characters of text.
- Mailbox task titles and the headings of mailbox entries.
- Under Needs you: the newest note for you from the mailbox, the relay's newest alert, why the
  relay halted, and the newest agent mail for you, each at most 280 characters.
- Agent mail between your agents: the start of each message, at most 280 characters in the feed
  and 120 on a map line, and on the Mail page each whole message.

When `content` is `none`, none of the text in that second list is shown. Pleni never shows what
a model was "thinking", in either setting. It shows only that the model was thinking.

### Pop-ups

Pop-ups are off until you turn them on in **Settings → Alerts**, and then only in that browser. Each
new Needs you notice then pops up on your screen with the same words the page shows (so with
`content` set to `none`, no session text). The browser makes the pop-up from the open Pleni page.
Pleni uses no push service, so nothing about them goes over the internet. Your system may keep
recent pop-ups in its notification list until you clear them.

## What Pleni never does

- It never writes, moves, or deletes anything in the Claude Code, Codex, Grok, Kimi Code, Gemini CLI,
  Antigravity CLI, Claude desktop app, or mailbox folders. The exceptions are **Save to Codex** and **Save to Claude Code** on the Models
  page (see [below](#models)), and **Connect** and **Disconnect** for **Answer questions**, which add
  and take out Pleni's own two hooks in Claude Code's `settings.json` (see below), and **Connect**
  and **Disconnect** for **plan limits**, which add and take out Pleni's status line there.
- It writes nowhere except its own folder (`settings.json`, `key`, `hook-key`, `dismissed.json`, the
  `backups/` folder of the Models page and of Connect, `sent.jsonl`, the record of messages
  sent with **Send messages**, and `pleni-statusline.mjs`, `statusline.json` and `claude-limits.json` for plan limits, and `password` and `devices.json` for signing in, see
  [below](#signing-in-with-a-password)). It saves each file safely: it writes a temporary file in
  the same folder, then renames it.
- When it turns away a device that Tailscale brings, it keeps that device's Tailscale address and
  login in memory (the last 5, never in a file), so Settings → Devices on your computer can offer
  **Allow**. Only your computer's page can see this list, and Pleni's key.
- It never stops a session. It sends nothing to one, except Roll over's two short messages when you
  click its buttons, and the messages you type with **Send messages** (see below).
- It starts nothing unless you turn on **Open in PowerShell** (Settings → Buttons, off until
  you turn it on, Windows only) and click the button on this computer. Then it opens one
  PowerShell window that runs `claude --resume` or `codex resume` for that session. Whatever is typed there comes
  from you. It does not open a session that is already open in another window, and it refuses the
  button from another device.
- **Roll over** (Settings → Buttons, off until you turn it on, Windows only, this computer
  only) works the same way, with one message per window. **Ask in PowerShell** runs
  `claude --resume` or `codex resume` with a request to write a handoff note. **Start in
  PowerShell** runs `claude --name <name>` or `codex` in the session's folder with a request to read
  that note. Pleni builds both messages from the session's name, holds them to letters, digits,
  spaces and a few plain marks, and shows them before you click. It sends nothing else.
- **Bring a cloud session here** (Settings → Buttons, off until you turn it on, Windows only, this
  computer only) opens one PowerShell window in a Claude Code session's folder that runs
  `claude --teleport`. Claude Code itself then talks to claude.ai to list your cloud sessions, as it
  does when you run it yourself. Pleni sends nothing.
- **Send messages** (Settings → Buttons, off until you turn it on, Windows only, this computer
  only) sends a message you type in a session's **Chat** tab. Pleni runs that session's own
  program once, hidden, in its folder (`claude -p --resume` or `codex exec resume`) and hands it
  your message on its standard input, never on a command line. Claude Code or Codex then sends it to
  Anthropic or OpenAI, as they do when you type it yourself, and writes the answer into the
  session's own file, where Pleni reads it. Pleni keeps no copy of your message or the answer: its
  record, `sent.jsonl`, says only when, to which session, and how the turn ended. It never sends to
  a session that is working, or open in a window, an app or another program, and it refuses a
  message from another device.
- **Answer questions** (Settings → Buttons, off until you choose **Connect**, this computer only)
  adds two hooks to Claude Code's `settings.json`, after a copy of the file: Claude Code then asks
  Pleni, at `127.0.0.1` on this computer and with a secret Pleni made (`hook-key`), before it shows a
  question, a plan or a permission prompt. Pleni holds the call only for a session you switched on
  in its side panel, or for a turn Pleni sent; every other call gets "no decision" at once, and
  Claude Code asks you in its own window as before. A held question shows on the page with the words
  Claude Code sent (only while session text is on), in memory only, until you answer it, give it
  back, or the time you chose runs out. **Disconnect** takes exactly Pleni's hooks out again. If
  Pleni is not running, Claude Code cannot reach it and goes on as if there were no hook.
- **Plan limits for Claude Code** (Settings → Buttons, off until you choose **Connect**, this
  computer only) adds a small status line to Claude Code's `settings.json`, after a copy of the file.
  Claude Code then runs Pleni's script after each reply and hands it its 5-hour and weekly limits.
  The script saves only those numbers (the percent used and when each limit resets) in
  `claude-limits.json` in Pleni's folder. It saves nothing else Claude Code sends it: no folder
  names, session ids, or words. Pleni reads no login key and calls no server for this. If you
  already had a status line, Pleni keeps it exactly in `statusline.json`, its script runs your
  command the way Claude Code would and shows what it prints, and **Disconnect** puts your old
  status line back and deletes Pleni's three files. If you changed the status line yourself in the
  meantime, Pleni leaves your file alone and says so. Claude Code only runs a status line in a
  folder you trust. Grok, Kimi Code and Gemini CLI save no limits, so Pleni shows where to look in each tool
  instead. The Antigravity CLI files that Pleni reads hold no limits and no token counts, and Pleni
  never opens its databases, so Pleni counts nothing for it and shows where to look there too
  (`/usage`).
- **New agent** (Settings → Buttons, off until you turn it on, Windows only, this computer only)
  opens one PowerShell window in the folder of a session you pick and runs `claude --name <name>`
  or `codex` there. The name you type is held to the same plain marks. Pleni sends the new agent
  nothing: you type its first message.
- It makes no network calls of its own. It sends no telemetry, usage counts, or crash reports.
  Only Live GitHub status (through gh) and Codex cloud tasks (through codex) reach the internet,
  and only when you turn them on.
- The page loads nothing from the internet. Its scripts, styles, and pictures all come from Pleni
  itself, and the page's security rules block anything else.
- It never puts stack traces or file contents in error messages.
- It asks the browser not to keep copies of its pages and data (`Cache-Control: no-store`).

## Live GitHub status and Merge

Live GitHub status is off until you turn it on in **Settings → Sources**. Then:

- Pleni runs the GitHub CLI (`gh`) on the computer that runs Pleni. gh signs in to GitHub with
  your own gh login. Pleni never sees your GitHub password or token.
- It asks only while a page shows the Pull requests or Cloud view, about once a minute, and only
  about the GitHub repositories your sessions work in and those of your projects (at most 30, and
  at most 6 at a time). Each time, gh sends GitHub the owner and name of each repository. It gets
  back the 30 newest pull requests of each one: number, title, branches, state, checks, reviews,
  and whether it can be merged.
- Pleni keeps that answer in memory for a minute and shows it on the Pull requests page, and the
  pull requests on `claude/...` branches on the Cloud page, to every device that may open Pleni. It
  writes none of it to a file. Pleni never reads your Claude login to list Claude cloud sessions.
- **Merge** is off until you turn it on too. It works only on the computer that runs Pleni, after
  you confirm, and only when every check passes and GitHub says the pull request is ready. Pleni
  then runs `gh pr merge` the way you picked in Settings, and tells GitHub to refuse if anyone
  pushed since you looked. A merge changes your repository on GitHub. Pleni never deletes a branch.
- Pleni finds gh in the folders on your `PATH`, never in the current folder. It runs gh with fixed
  words and checked values, never through a shell (a program that reads commands), and in your
  temporary folder, away from your projects.
- What GitHub does with what it receives is covered by GitHub's own privacy rules.

## Codex cloud tasks

Codex cloud tasks are off until you tick **Show my Codex cloud tasks** in **Settings → Sources**
on the computer that runs Pleni. Another device cannot turn them on. Then:

- Pleni runs the Codex program (`codex`) on that computer, with the fixed words `cloud list
  --json --limit 20`, never through a shell (a program that reads commands). Codex, not Pleni,
  asks OpenAI, with your own Codex login. Pleni never reads Codex's login files or any key. It
  needs a ChatGPT sign-in (`codex login`); an API key does not work.
- It asks only while the Cloud page is open, about once a minute, and shows the answer to every
  device that may open Pleni. It never runs `codex cloud diff`, `apply` or `exec`.
- What it shows, for up to 20 tasks: the title, the status (working, ready, applied or error), the
  environment name, when it was updated, how many files changed and how many lines were added and
  removed, whether it has a pull request, how many tries it had, and a link to the task on
  chatgpt.com. Pleni builds that link itself from the task's id. It never shows or keeps what was
  said in a task, because Codex's list does not hold it.
- Pleni keeps the last list in memory only, reuses it for a minute, and writes none of it to a file.
- Codex writes a small file named `error.log` in the folder it runs from, and that file holds your
  account id. So Pleni runs Codex from a folder of its own, `codex-cloud`, inside Pleni's
  settings folder, never from a project. Delete the file whenever you like.
- Pleni finds `codex` in the folders on your `PATH` (on Windows, like Send does), never in the
  current folder.
- What OpenAI does with what it receives is covered by OpenAI's own privacy rules.

## Models

The **Models** page (Settings → Models) shows which model and effort your Codex and Claude Code
agents start with. It reads them from the tools' own files (see
[What Pleni reads](#what-pleni-reads)). Changing them from Pleni is off until you tick **Let Pleni
change the models Codex and Claude Code use**. Then:

- Pleni changes a tool's files only when you choose **Save to Codex**, **Save to Claude Code** or
  **Add the worker type**, and only on the computer that runs Pleni. Another device can look but
  not change.
- It changes only the model and effort values. In Codex's file and in agent files it keeps every
  other line, comment and space as it was. In Claude Code's `settings.json` it keeps every other
  setting, and writes the file back with the same indent. If a value is written in a way Pleni does
  not change, it changes nothing and says so.
- Before it changes a file, it saves a copy of it in the `backups/` folder in Pleni's own folder
  (the newest 20 copies of each file). To undo a change, copy one back.
- If Codex changed the file since the page looked, Pleni changes nothing and shows what the file
  says now.
- **Add the worker type** makes one new file in that tool's `agents/` folder. It never writes over a
  file that is there.
- None of this leaves your computer.

## Who can open the page

Pleni listens only on `127.0.0.1`, so only programs on your own computer can reach it (unless you
turn on [Wi-Fi access](#wi-fi-access-and-its-risks)). Even there, it answers only when the address
is `localhost`, `127.0.0.1`, or `[::1]`. This stops a web site from tricking your browser into
reading Pleni (an attack called DNS rebinding).

A computer can have more than one account, for example a shared Linux machine or a Windows
computer that several people sign in to remotely. Every account can reach `127.0.0.1`. So Pleni
also has a secret key. It makes the key the first time it starts and prints it as part of its
address (`http://localhost:8790/?t=<key>`). Session data and settings answer only a browser that
has the key:

- When you open the address, Pleni gives your browser the key as a cookie that the page's own
  scripts cannot read and that other web sites cannot make your browser send. It then drops the
  key from the address bar.
- A request without the right key, or a device's pass, gets `401`. Only `/api/health`, which says
  just that Pleni is running, signing in itself, and the page's own files (which hold no session
  data) answer without one.
- A browser without the key sees a sign-in box. It takes your password, if you set one, or the
  key. Either way the browser gets a pass of its own, and can save what you typed in its own
  password store.
- The key is saved in a file named `key` next to `settings.json`, so the address stays the same
  after a restart. A browser keeps it as a cookie for a year. Pleni never changes the key on its
  own: if it cannot read the key file, or the file is damaged, it stops with a message instead of
  making a new key. `--url` shows the address and the key again. Do not share the key. If it leaks,
  start Pleni once with `--new-key`: the old key stops working.
- With `--open`, Pleni hands the address to your browser. On a shared Linux computer, other
  accounts may see it in the list of running programs while the browser starts, so there it is
  safer to copy the address from the terminal yourself.

Keep in mind that anyone who can use your computer as you can also open the page, the same way
they could open the session files themselves.

## Signing in with a password

You can set a password in **Settings → Devices** on your computer, so your other devices can sign
in without the key.

- Pleni never keeps the password itself. The file `password` holds only a scrambled form of it
  (an scrypt hash, which is slow to guess from), and how many wrong tries came in a row.
- Each device that signs in gets a pass of its own, in a cookie that the page's scripts cannot
  read. The file `devices.json` keeps, for each device, only a scrambled form of its pass, a short
  name from its browser (for example "iPhone, Safari"), when it signed in, and when it was last used.
  It never keeps the browser's full details, an address, or a location.
- **Settings → Devices** lists these devices. **Sign out** next to one ends its pass at once.
- Wrong passwords slow Pleni down: the first 4 in a row are free, then it waits 1 minute, then 2,
  4, 8, 16, and at most 30. After 20 in a row it stops taking the password until you turn it back
  on, on your computer. The count and the wait are kept in the file, so restarting Pleni resets
  neither.
- Only your computer's page can set the password, turn Wi-Fi access on or off, see the list of
  devices, or sign one out.

## Wi-Fi access and its risks

With **Open Pleni on this Wi-Fi** on (Settings → Devices, off until you turn it on, and only while
a password is set), Pleni also listens on the home-network address of your computer that you chose,
so a phone on the same Wi-Fi can open it. Before you turn it on, know what it means:

- **No padlock.** The Wi-Fi address is plain `http://`, not HTTPS. What Pleni shows, and the
  password when a device signs in, travel over your Wi-Fi without encryption of their own. Someone
  else on the same network could read them. Use it only on a network you trust, like your home
  Wi-Fi, and never on public Wi-Fi. Tailscale adds that lock if you need it.
- **Only the address you chose.** Pleni listens only on addresses that start with `10.`, `172.16.`
  to `172.31.`, or `192.168.`, which only devices on the same network can reach, and only on the
  one you chose. On another network (a café, a hotel, a work VPN) your computer has another
  address, so Pleni does not answer there until you choose it. It never listens on an address the
  internet can reach. It answers only when the browser asks for that same address, which stops web
  sites from reaching it by DNS rebinding.
- **The password, not the key.** On the Wi-Fi address Pleni takes only the password. Its key does
  not work there, so the key never travels without a padlock. A device's pass does, so Pleni lets
  you sign each device out.
- **Signed-in devices can look, not act.** A device on the Wi-Fi must sign in first. Then it sees
  what you see. It cannot send messages, answer questions, merge, change models, or open windows,
  and it cannot set the password or let in more devices.
- Wi-Fi access stops when you turn it off, or when you remove the password.

## Remote access and its risks

You can open Pleni from your phone or another device through `tailscale serve` (see the
[README](../README.md#open-it-from-your-phone) for the steps). Pleni then lets a request in only when
both of these are true:

- the host name is on your `remote.hosts` list, and
- the request carries a Tailscale login (the `Tailscale-User-Login` header) that is on your
  `remote.tailscaleUsers` list.

The other device also needs to sign in, with your password (see
[above](#signing-in-with-a-password)) or with Pleni's key: open the address Pleni printed with your
Tailscale address in place of `http://localhost:8790`, for example
`https://my-pc.tail1234.ts.net/?t=<key>`.

Before you turn it on, know the risks:

- **Everyone you add sees what you see.** That includes session names, folder names, and, with
  `snippets`, bits of your work. Set `content` to `none` if that is too much.
- **Everyone you add can change most of Pleni's settings,** including which folders it reads, but
  not who else may open it. Add only yourself, or people you trust with your computer's work.
- **Never use `tailscale funnel`.** Funnel puts a page on the open internet.
- **Use only `tailscale serve` in front of Pleni.** Pleni trusts the `Tailscale-User-Login`
  header because Tailscale sets it. Another proxy that passes that header on from the visitor
  would let anyone pretend to be you.
- Remote access ends when you stop sharing (`tailscale serve --https=443 off`) or remove the
  entries from your settings.

## Questions

Ask in [Discussions](https://github.com/Seckcey/pleni/discussions). To report a security problem,
follow [SECURITY.md](../SECURITY.md) and do not post the details in public.
