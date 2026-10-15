# Changelog

All notable changes to Pleni are listed here, newest first. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and version numbers follow
[Semantic Versioning](https://semver.org/).

## Unreleased

### Fixed

- A coordinator that was moved under its planner (by dragging it, or with Reports to) now stays
  below the relay, so the map shows planner → relay → coordinator → its workers.

### Added

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
  live. It is off until you turn it on in Settings → Open sessions, works only on the computer
  that runs Pleni, and never opens a session that another window already has open. A Claude Code
  helper's button opens the session it works inside; a Codex helper opens its own thread. A
  window closed with its X does not block the button afterwards, and a thread the Codex app
  holds says so.

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
