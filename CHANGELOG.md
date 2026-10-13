# Changelog

All notable changes to Pleni are listed here, newest first. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and version numbers follow
[Semantic Versioning](https://semver.org/).

## 0.1.0 (unreleased)

The first version. Pleni only watches: it never starts, stops, or sends anything to a session.

### Added

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
