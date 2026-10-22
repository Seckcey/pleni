# Changelog

All notable changes to Pleni are listed here, newest first. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and version numbers follow
[Semantic Versioning](https://semver.org/).

## Unreleased

### Fixed

- The × on a "Mail for you" notice now hides it. Before, Pleni refused it.
- Agent mail now lights lines on the map that it did not before: mail between you and an agent
  lights the line between your tile and theirs, and when the relay wakes an agent for its mail, the
  line from the relay to that agent lights up and the Activity view says "Relay woke <agent>". The
  Working view shows the relay while one of its lines is lit.
- The mailbox relay now waits while any Claude Code window has the coordinator open, also a window
  whose command line does not name the session, such as one started with `claude --name` or by
  Roll over. It finds those in Claude Code's own list of running sessions. Before, it could wake
  the coordinator while such a window was open, and two programs writing one session mix up its
  messages. `-Status` now says when a window has the coordinator open. Update the relay copy in
  your mailbox to get this. Roll over's last step now says you may keep the new window open.

- Pleni's address no longer changes on its own. Pleni used to make a new key whenever it could not
  read its key file, even for a moment, and that broke every bookmark. Now it makes a key only the
  first time it starts, or when you ask with `--new-key`. It tries a busy key file again for about
  ten seconds, and if the file still cannot be read, or is damaged, it stops with a message instead.
- A coordinator that was moved under its planner (by dragging it, or with Reports to) now stays
  below the relay, so the map shows planner → relay → coordinator → its workers.
- A relay that halted itself (it writes the reason into `state.json`) now shows as halted. Before,
  Pleni saw a halt only from a `STOP` file.

### Added

- **Answer questions** (off until you choose Connect in Settings → Buttons, this computer only): a
  Claude Code session's question, plan to approve, or permission prompt can wait in Pleni, under
  Needs you and on top of its side panel, where you pick an answer, approve the plan or ask it to
  keep planning, or allow or deny the tool. Connect adds Pleni's own two hooks to Claude Code's
  `settings.json` (after a copy, nothing else changed); Disconnect takes them out. Pleni holds a
  question only for a session you switch on ("Answer its questions in Pleni" in its side panel) and
  for messages Pleni sends, and only for the time you set (10 minutes at first); every other
  question goes to the session's own window as before. A plan or a permission prompt also shows in
  the session's window; answer it in either place, and Pleni takes its card away within a few
  seconds when you answer it there. A message sent with Pleni runs with no window, where Claude Code
  asks no questions and shows no plans, so only its permission prompts come, with **Also change
  files in its folder**. If Pleni is closed, Claude Code shows a short "hook error" line and asks in
  its own window. The hooks reach Pleni only on this computer, with a secret Pleni keeps in
  `hook-key`. Checked with Claude Code 2.1.307 in a real window.
- **Send messages** (Windows, off until you turn it on in Settings → Buttons): a main Claude Code
  session or Codex thread gets a **Chat** tab in its side panel, with the conversation and a message
  box. Pleni sends what you type as one turn of that session, run in the background
  (`claude -p --resume` or `codex exec resume`), and the answer shows there. The message goes to the
  program on its standard input, never on a command line. Pleni never sends to a session that is
  working, or open in a window, an app or another program, and only on the computer that runs it.
  A sent message may read files and answer; **A sent message may** can also let it change files in
  its folder. Pleni keeps no copy of the message: `sent.jsonl` in its own folder says only when, to
  which session, and how the turn ended. A few messages a minute, three turns at once at most.
- **Who chose a worker's model and effort:** when the sergeant that started a Claude Code worker did
  not choose its model or its effort, the map, the List and its side panel now show "(default)"
  after it, such as "Sonnet 5.5 · max effort (defaults)". Its Details tab shows its worker type and
  who chose them. A worker with no effort chosen runs at its sergeant's own effort, which is why a
  sergeant at max effort gave every worker max.
- **Coordinator order 13:** the coordinator's standing orders (`relay/COORDINATOR.md`) now ask
  Sergeant Claude Code to choose a model and an effort for every worker, from a table by kind of
  work, and the worker brief has a line for them. Claude Code tells a sergeant to set a worker's
  effort only when its orders ask, so without this it never does. Add the new order to the end of
  your mailbox's own `CLAUDE.md`, and the new line to your own worker brief (relay README, "Update
  the relay in a mailbox"). Do not copy `COORDINATOR.md` or the templates over your mailbox's
  files: an earlier version of that README said to, and that loses what your mailbox added over
  time.
- **Claude Code on the Models page:** see and change the model and effort Sergeant Claude Code
  starts with (Claude Code keeps an effort for each model, where `/effort` keeps it), the model a
  worker gets when its sergeant does not pick, and Claude Code worker types (agent files). The
  menus offer Claude Code's short names (Fable, Opus, Sonnet, Haiku), which always point at its
  newest models. **Save to Claude Code** keeps every other setting in `settings.json`, after Pleni
  keeps a copy of the old file. The page also warns when a setting such as `ANTHROPIC_MODEL` wins
  over what it sets.
- A **Models** page (Settings → Models): see and change the model and effort your Codex agents
  start with. Sergeants and new threads get one model and effort; workers get theirs when their
  sergeant does not pick; and **worker types** let a sergeant pick a model by the kind of work.
  The menus list the models Codex offers you, so new models show up on their own, and each effort
  menu lists only what its model takes. Changing them is off until you turn it on. **Save to
  Codex** changes only those lines in Codex's settings file, on this computer, after Pleni keeps a
  copy of the old file in its own `backups` folder.
- A **Mail** page: read every message between you and your agents in full, newest first, with the
  new ones marked and the PowerShell command that answers each one. **All mail** shows the mail
  between your agents too. **Mark all as read** changes only what Pleni shows; the mail files stay
  where they are. A "Mail for you" notice opens it.
- Agent mail, in the mailbox relay: agents send each other messages by name with
  `bin\agent-mail.ps1` (`-Send`, `-Read`, `-Wait`, `-List`), and `bridge-relay.ps1 -EnrollAgent`
  wakes an agent's Codex thread when mail waits for it. This does the job of the Codex app's
  messages between threads (`send_message_to_thread` and `wait_threads`), so a Colonel and its
  Sergeants can work with the app closed. Off until you enroll an agent. Update the relay copy in
  your mailbox to get it.
- Pleni shows agent mail: a line lights up between two tiles when mail goes from one to the other,
  a tile says "N new messages" when mail waits for it, the Activity view lists each message, and
  mail for you shows under Needs you. A tile's side panel says whether the relay wakes it for mail,
  and gives the PowerShell commands to read your mail and answer it. Pleni sends no mail.
- Live GitHub status (off until you turn it on in Settings → Sources): the Pull requests page shows
  each pull request's checks, reviews, and whether it can be merged, and lists other open pull
  requests. Pleni asks through the GitHub CLI (`gh`) on your computer, with your own gh sign-in,
  about once a minute while that page is open. With **Show the Merge button** on as well, an open
  pull request whose checks all pass and that GitHub calls ready gets a **Merge** button, on the
  computer that runs Pleni only. It asks you first, and GitHub refuses the merge if anyone pushed
  since you looked. This is the first time Pleni can reach the internet, so the rules in
  `CLAUDE.md`, `AGENTS.md`, `CONTRIBUTING.md`, `SECURITY.md` and the privacy page now say so.
- Bring a cloud session here (Windows, off until you turn it on in Settings → Buttons): a Claude
  Code session's side panel opens a PowerShell window in its folder that runs `claude --teleport`.
  Pick one of your claude.ai cloud sessions there, and it goes on on this computer, where Pleni
  shows it. Pleni itself still sends nothing.
- New agent (Windows, off until you turn it on in Settings → Buttons): a session's side panel has
  **New agent here…**. Pick Claude Code or Codex, type a name, and Pleni opens a PowerShell window
  in that session's folder that runs `claude --name <name>`, or `codex`. You type the first
  message there; Pleni sends nothing. It refuses a name that a session on the map already has, and
  works only on the computer that runs Pleni.
- Hide a session with one click: **Hide from the map** in a session's side panel, with Undo. Roll
  over's last step offers **Hide the old session**. The counts under the Map and List titles say
  how many are hidden, and Settings → Team → Names and roles now names them, so one can be shown again.
  (#13)
- Roll over soon: a main Claude Code session or Codex thread whose memory is nearly full, whose
  history was squeezed into a summary often, or that is old gets a **Roll over soon** mark on its
  tile and in the List, with the reasons in its side panel and the numbers in its Details tab. The
  limits are in Settings → Alerts → Roll over soon. Pleni reads only token numbers and squeeze records for
  this, never message text. (#14)
- The version shows beside Pleni's name at the top of the page, and Settings says which version
  and git commit run. When Pleni was updated and started again, an open page says to reload. (#17)
- Roll over (Windows, off until you turn it on in Settings → Buttons): a session's side panel
  gets **Roll over…**, which starts a fresh session with the same name that picks up from a handoff
  note. **Ask in PowerShell** opens the old session and asks it to write `HANDOFF-<name>.md` in its
  folder; **Start in PowerShell** opens a new session there that reads the note first (Claude Code
  with `--name`; for Codex, type `/rename`). Pleni shows both messages before you click, sends
  nothing else, and works only on this computer. Each message also has a Copy button, for a
  session that is open in the Codex app or the Claude desktop app.
- Rollovers without new ids: the mailbox relay can follow a session by name. Enroll with
  `bridge-relay.ps1 -Enroll -SessionName <name>` or `-EnrollCodex -ThreadName <name>`, and when a newer
  session takes over that name, the relay wakes it instead, on its own. It only moves on to a
  session that started later, and only between turns. A Claude Code session's name is set with
  `/rename` or in the Claude desktop app; a Codex thread's name is set in Codex.
- The relay README says how to let a planner turn write to a mailbox in another folder
  (`--add-dir` in `codex_exec_args`).
- A sign-in box: a browser that does not have Pleni's key (a new device, or one that forgot it) now
  asks for the key on the page. Bookmark the plain address, `http://localhost:8790/`, and paste
  the key once. Browsers can save the key like a password.
- `--url` shows Pleni's address, your Tailscale addresses and the key, without starting Pleni.
- The mailbox relay can wake the planner's Codex thread, so the planner and the coordinator keep
  each other going without the Codex app. It is off until you turn it on with
  `bridge-relay.ps1 -EnrollCodex -ThreadId <id>`. Then each new item for the planner (a question
  that blocks the coordinator, or a handoff ready for review) wakes that thread once, with
  `codex exec resume`. It waits while the Codex app or a window has the thread open, and while a
  coordinator turn runs. It uses your ChatGPT sign-in, never an API key, and has its own daily limit
  and its own stop after repeated errors.
- More under Needs you from the mailbox: a new note for you in a `NEEDS-<NAME>.md` file, the
  relay's alerts from `.relay/alerts.md`, and a relay that is paused or halted, with what to do
  about it.
- Tell me if this stops working: tick it in a session's or the relay's side panel. A watched
  session that does no work for 15 minutes, or a relay that does not run for 15 minutes, shows
  under Needs you. Settings → Alerts changes the time.
- Pop-ups: turn them on in Settings → Alerts, and each new Needs you notice also pops up in that
  browser, even while the tab is in the background. Off until you turn it on; desktop browsers
  only.

- Relay workers you can see and open: the relay's worker launcher now saves each run as a Claude
  Code session and writes its id (`session_id`) into the run file. Pleni shows that session as the
  worker's tile under the coordinator, with its live activity, and once the run has ended, Open in
  PowerShell opens it. Runs from before this change keep their old tile.
- The mailbox relay now lives in this repository, in `relay/`. It is a separate Windows
  PowerShell program, not part of Pleni or its npm package. It wakes a coordinator's Claude Code
  session when the Codex planner writes to the mailbox, and starts worker sessions. Its folders
  and the owner's name now come from a settings file on your computer
  (`bin\relay-settings.json`), and a worker no longer starts in a folder that steps outside the
  worktrees folder. GitHub runs the relay's own test on Windows for each pull request.
- Open in PowerShell (Windows): a button in a Claude Code or Codex session's side panel opens that
  session in a new PowerShell window with `claude --resume` or `codex resume`, so you can watch it
  and type to it. Neither tool needs to be open first. A Claude Code background session opens
  live. It is off until you turn it on in Settings → Buttons, works only on the computer
  that runs Pleni, and never opens a session that another window already has open. A Claude Code
  helper's button opens the session it works inside; a Codex helper opens its own thread. A
  window closed with its X does not block the button afterwards, and a thread the Codex app
  holds says so.

- Pull requests view: for each GitHub repository your sessions work in, the branches your agents
  are on, who is on each, and links to the branch's pull request on GitHub, or to open one, plus
  the repository's pull requests, branches and checks. A session's Details tab has the same links.
  Pleni learns the repository from the `origin` address in the folder's git settings, keeps only
  the owner and name, and sends nothing to GitHub.

- Settings → Devices shows how to open Pleni on another device. It has the address to use, with
  a Copy button, and buttons to copy the key or a sign-in link, on the computer that runs Pleni.
  When Pleni turns away a phone or laptop that Tailscale brings, the device shows up there with
  **Allow**, which adds its address and login to the lists in one click. The turned-away page now
  says what to do in plain words, and Pleni prints the address for other devices when it starts.

### Changed

- Roll over keeps more: the new session starts with the old one's model and effort, and for Claude
  Code its permission mode too. The handoff request now asks the old session to copy in every
  standing instruction it follows (how to report, how to pick a model and effort, what it may and
  may not do), and the new session is told to follow them. Pleni now reads each Claude Code turn's
  permission mode for this.
- Settings is no longer one long page. It has six short groups, each behind a tab: Basics, Team,
  Sources, Alerts, Buttons and Devices. Settings most people never change are folded under **More
  choices**. **Find a setting** finds a setting by name in every group, for example "port" or
  "folder". If a field needs fixing when you save, Pleni opens its group, marks its tab with a red
  dot, and says which group it is in. An address such as `#/settings/alerts` opens one group.

## 0.1.0 (2026-10-13)

The first version, on npm as `pleni` (`npx pleni`). Pleni only watches: it never starts, stops, or
sends anything to a session.

### Added

- Grok and Kimi Code sessions show on the map, read from their own session logs, alongside Claude
  Code and Codex. A permission request still waiting after two seconds shows as "Needs you", so
  requests that a rule answers at once never do. The demo has a Grok and a Kimi Code session too.

- Dismiss a "Needs you" notice from its banner or the side panel; it comes back when something new
  happens, and the choice is shared by every device.
- Settings → Ranks by model: pick Specialist or Private for each model in use.

- Say who each session reports to: drag a tile onto another, or use the Reports to menu.
- The mailbox relay is a tile between the planner and the coordinator, and the relay's worker
  runs show under the coordinator with live lines.
- Codex workers hang under the current coordinator of their project; Codex's imported copies of
  other tools' sessions are left out.

- A chain of command in Settings: rules such as "a session whose name contains Sergeant reports to
  the newest session whose name contains Colonel", with an optional rank. The mailbox coordinator
  hangs under its planner, which can be named instead of picked by key.
- Live lines for messages Codex threads send each other (send_message_to_thread).

- Codex workers started by a coordinator now hang under that coordinator, read from Codex's
  coordinator registry, with lines when work goes down and when the worker reports back.

- "Needs you" now means a real ask: a Claude question or plan waiting for your answer, a Claude
  desktop session that its own summary marks as blocked, or a Codex request for your input. A
  session that simply finished a reply shows "Finished". Background (headless) sessions never ask.
- The map draws lines straight from you to your sessions; each tile names its folder. Folder
  tiles are still available in Settings ("Group sessions: By project folder").

- Pleni keeps its key, so its address stays the same after a restart and each phone or laptop
  signs in once. `--new-key` makes a new one.

- A live map in your browser: you, your projects, each Claude Code and Codex session, and the
  helpers (sub-agents) each one started. Lines light up when work is handed down or a report
  comes back up.
- List, Activity, Tasks, and Settings views, and a side panel with each session's recent steps.
- Reading Claude Code sessions, their sub-agents and workflow agents, and session names from the
  Claude desktop app.
- Reading Codex threads and their sub-agents, with automatic reviewers hidden unless you turn
  them on.
- An optional coordination mailbox: a shared folder of Markdown files where one session hands out
  tasks and another reports back.
- Demo mode (`node bin/pleni.js --demo`) with a made-up team, so you can try Pleni without any
  real sessions.
- Command line options `--port`, `--demo`, `--open`, `--config`, `--version`, and `--help`, and
  the `PLENI_PORT` and `PLENI_HOME` terminal settings.
- Plain, military, or company titles, a setting to hide session text, and light and dark themes.
- Opening Pleni from your phone through `tailscale serve`, only for the host names and Tailscale
  logins you list.
- Safety: Pleni listens only on `127.0.0.1`, checks every request's host name, sends strict
  security headers, makes no network calls, and writes only its own settings file.
- A new secret key each time Pleni starts, printed as part of its address (`/?t=<key>`). Session
  data and settings answer only a browser that has it, so other accounts on a shared computer
  cannot read your sessions or change your settings.
- Zero dependencies: Node.js 22.12 or newer and its built-in modules only.
- Tests with `node:test` that make their own made-up files, and checks on Windows, macOS, and
  Linux with Node.js 22 and 24.
