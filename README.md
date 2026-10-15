<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/Seckcey/pleni/main/assets/plenipo-horizontal-on-dark.png">
    <img src="https://raw.githubusercontent.com/Seckcey/pleni/main/assets/plenipo-horizontal-on-light.png" alt="Plenipo logo with Pip, the robot" width="420">
  </picture>
</p>

<h1 align="center">Pleni — Plenipo Browser</h1>

<p align="center">
  See your Claude Code, Codex, Grok and Kimi Code sessions work together, live in your browser.
</p>

<p align="center">
  <a href="#start-here"><strong>Start here</strong></a> ·
  <a href="https://getplenipo.com">Website</a> ·
  <a href="docs/privacy.md">Privacy</a> ·
  <a href="CONTRIBUTING.md">Contributing</a> ·
  <a href="https://github.com/Seckcey/pleni/discussions">Community</a>
</p>

<p align="center">
  <a href="https://github.com/Seckcey/pleni/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/Seckcey/pleni/actions/workflows/ci.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="Source-available: Elastic License 2.0" src="https://img.shields.io/badge/license-Elastic--2.0-2F7BF6"></a>
  <a href="https://www.npmjs.com/package/pleni"><img alt="pleni on npm" src="https://img.shields.io/npm/v/pleni?color=2F7BF6"></a>
  <a href="https://nodejs.org/"><img alt="Node.js 22.12 or newer" src="https://img.shields.io/badge/node-%3E%3D22.12-2F7BF6"></a>
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/Seckcey/pleni/main/docs/assets/pleni-demo.gif" alt="A 20-second tour of Pleni in demo mode: the live map with glowing hand-off lines between Claude Code, Codex, Grok and Kimi Code sessions, a session's side panel with its recent steps, the list of sessions, the activity feed, and back to the map." width="900">
</p>

<p align="center"><sub>A 20-second tour of the demo (<code>npx pleni --demo</code>). All the names and work in it are made up. <a href="https://raw.githubusercontent.com/Seckcey/pleni/main/docs/assets/pleni-map.png">See a still picture of the map.</a></sub></p>

## What Pleni is

When you use Claude Code or Codex, each session can start helpers of its own (sub-agents) and
hand work to them. With a few of these running at once, it gets hard to tell who is doing what.

Pleni shows you. It reads the files that Claude Code, Codex, Grok and Kimi Code already write on your computer,
works out who started whom, and draws it as a live map in your browser. Lines light up when work
is handed down and when a report comes back up.

- **It only looks.** Pleni never stops or types into a session, and it never changes the files it
  reads. The one exception is a button you can turn on, which opens a session in a PowerShell
  window for you (see [Open a session in PowerShell](#open-a-session-in-powershell)).
  Even then, you do the typing.
- **It stays on your computer.** It opens only on your own computer (`127.0.0.1`). It sends
  nothing anywhere. There is no account, no sign-in, and no tracking.
- **It has zero dependencies.** You need only Node.js. Pleni installs nothing else from npm and has
  nothing to build.

## Start here

You need [Node.js](https://nodejs.org/) 22.12 or newer. Then run:

```sh
npx pleni
```

Pleni prints its address, such as `http://localhost:8790/?t=...`. Open that whole address in
your browser. The part after `?t=` is a secret key that keeps other people who use this computer
out. The key is saved, so the address stays the same after a restart, and each browser only needs
it once. To change the key, start Pleni once with `--new-key`. Press Ctrl+C in
the terminal to stop Pleni.

No sessions yet? Try the demo. It shows a made-up team that moves on its own, so you can look
around without any real data:

```sh
npx pleni --demo
```

Prefer to run it from the source? You need git too:

```sh
git clone https://github.com/Seckcey/pleni.git
cd pleni
node bin/pleni.js
```

| Option          | What it does                                            |
| --------------- | ------------------------------------------------------- |
| `--port N`      | Use port `N` instead of 8790                            |
| `--demo`        | Show the made-up demo team instead of your sessions     |
| `--open`        | Open Pleni in your browser when it starts               |
| `--config FILE` | Use this settings file instead of the usual one         |
| `--version`     | Show the version number                                 |
| `--help`        | Show all the options                                    |

In a copy of the source, `npm start` and `npm run demo` do the same as `npx pleni` and `npx pleni --demo`.

## What you see

- **Map** — you on the left, then your projects, then each session and the helpers it started.
  A line glows while work moves along it: teal dots travel down when work is handed out, and
  purple dots travel up when a report comes back. Drag to move around. Use Ctrl + scroll, a
  pinch, or the `+` and `−` buttons to zoom. The **Working** switch hides sessions that are
  quiet.
- **List** — the same sessions as a table, grouped by project, with filters. It also works well
  with a screen reader.
- **Activity** — every hand-off, newest first.
- **Tasks** — shown only when you turn on a mailbox (see below). It lists each task, its state,
  and which ones need you.
- **Settings** — your name, the titles to use, how much text to show, which folders to read,
  and who may open Pleni from another device.

Click any tile to see more about that session, with its recent steps. Press Esc to close it.

Each tile says what the session is doing:

| Words     | What it means                                                         |
| --------- | --------------------------------------------------------------------- |
| Needs you | It asked you a question, wants a plan approved, or says it is blocked |
| Working   | It is in the middle of a turn right now                               |
| Finished  | It finished a turn a little while ago and is not asking for anything  |
| Idle      | Nothing has happened for a while                                      |
| Done      | A helper that finished its job                                        |
| Error     | Its last turn ended with an error                                     |

Titles can be plain (Lead and Agent, plus Superintendent and Coordinator for sessions you give
those roles), military (General, Sergeant, Private), or company (Owner, Supervisor, Worker). Pick the one you like in Settings. Pleni never re-orders tiles because of
activity, so things stay where you left them.

**Move anything.** Drag a tile onto another to say who it reports to, or use the **Reports to**
menu in its side panel. Pick **Automatic** to undo.

**Chain of command.** Pleni draws each helper under the session that started it. Codex workers
started by a coordinator hang under that coordinator. If your sessions report to each other in
another way, say so in **Settings → Chain of command**: for example, "a session whose name contains
*Sergeant* reports to the newest session whose name contains *Colonel*". Rules match names, so they
keep working when a session is replaced by a new one.

## Open a session in PowerShell

On Windows, Pleni can open a Claude Code session or a Codex thread in a PowerShell window, so you
can watch it and type to it. You do not need Claude Code or Codex open first: the window starts
it. This is off until you turn it on:

1. Open **Settings**. Under **Open sessions**, tick **Show the Open in PowerShell button**, then
   choose **Save settings**.
2. Click a Claude Code or Codex session on the map. In its side panel, choose **Open in
   PowerShell**.

A new PowerShell window opens in that session's folder and runs `claude --resume <session id>`, or
`codex resume <thread id>` for Codex. You see the whole conversation, and whatever you type goes to
that session.

- **A background session opens live.** If the session runs in the background (you started it with
  `claude --bg`, or from `claude agents`), you watch it work and can type to it. It keeps running
  when you close the window. This needs Claude Code 2.1.285 or newer.
- **A stopped session picks up where it left off.**
- **One window per session.** If the session is open in another window, or busy in a program
  with no window (such as a script that runs `claude -p`), Pleni says so and opens nothing. Two
  windows would mix up its messages.
- **Relay workers open too.** A worker that the mailbox relay started shows under its coordinator
  as its own Claude Code session. While it works, it is busy; once it has finished, its button
  opens it, so you can ask it what it did or give it more to do.
- **Claude Code helpers open their session.** A Claude Code helper (sub-agent) works inside the
  session that started it, so its button opens that session.
- **Codex helpers open themselves.** Each Codex helper has a thread of its own, so you can open it
  and talk to it directly. If another program has the thread open, Pleni says so.
- **Desktop and VS Code sessions stay there.** A session that belongs to the Claude desktop app or
  VS Code is already on your screen there, so Pleni asks you to open it there.
- **You need the `claude` or `codex` command.** Typing `claude` (for Claude Code) or `codex` (for
  Codex) in PowerShell must work.
- **Close the window when you are done.** While it is open, the session is yours. A script or a
  coordinator that sends that session work may clash with you, or be turned away, until you close
  it.
- **Only on this computer.** The button works only in a browser on the computer that runs Pleni,
  not from your phone.
- **It uses your plan.** Each message you send there uses your Claude plan, the same as in any
  Claude Code window.

Tip: to watch several sessions at once, start them in the background with
`claude --bg --name "Sergeant" "<task>"`. Then `claude agents` lists them all in one window, and
Pleni's button opens any one of them live.

## Where it looks

Pleni finds the usual folders on its own. You can change any of them in Settings.

| What it reads                       | Usual folder                                                                                                       | Change it with      |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------- |
| Claude Code sessions and helpers    | `~/.claude` (on Windows, `C:\Users\<you>\.claude`)                                                                 | `CLAUDE_CONFIG_DIR` |
| Session names from the Claude app   | Windows: `%APPDATA%\Claude` · macOS: `~/Library/Application Support/Claude` · Linux: `~/.config/Claude`            | Settings            |
| Codex sessions and helpers          | `~/.codex` (on Windows, `C:\Users\<you>\.codex`)                                                                   | `CODEX_HOME`        |
| Grok sessions                       | `~/.grok` (on Windows, `C:\Users\<you>\.grok`)                                                                     | `GROK_HOME`         |
| Kimi Code sessions and helpers      | `~/.kimi-code` (on Windows, `C:\Users\<you>\.kimi-code`)                                                           | `KIMI_CODE_HOME`    |
| A coordination mailbox (optional)   | Off until you choose a folder                                                                                      | Settings            |

Pleni shows sessions that were active in the last 24 hours. You can change that in Settings.

Pleni keeps its own settings in one file, `settings.json`:

| System  | Folder                                                          |
| ------- | --------------------------------------------------------------- |
| Windows | `%APPDATA%\pleni`                                               |
| macOS   | `~/Library/Application Support/pleni`                           |
| Linux   | `$XDG_CONFIG_HOME/pleni` (if that is not set, `~/.config/pleni`) |

| Setting it from the terminal | What it does                               |
| ---------------------------- | ------------------------------------------ |
| `PLENI_PORT`                 | The port to use (the usual one is 8790)    |
| `PLENI_HOME`                 | The folder for Pleni's own settings file   |
| `CLAUDE_CONFIG_DIR`          | Where Claude Code keeps its files          |
| `CODEX_HOME`                 | Where Codex keeps its files                |
| `GROK_HOME`                  | Where Grok keeps its files                 |
| `KIMI_CODE_HOME`             | Where Kimi Code keeps its files            |

**The mailbox** is for people who have two AI sessions work through a shared folder of
Markdown files: one hands out tasks, the other reports back. If you do not use one, leave it off.

**The relay** is a separate Windows program in the [`relay`](relay/README.md) folder of this
repository. It wakes the Claude Code coordinator when the Codex planner writes to the mailbox, and
the coordinator uses it to start worker sessions. Pleni shows the relay on the map, but never runs
it. It is not part of the npm package.

## Privacy and safety

- Pleni reads files. It writes only its own settings file.
- It starts nothing unless you turn on **Open in PowerShell** and click it. Then it opens one
  PowerShell window that runs `claude --resume` or `codex resume`. It never types into a session.
- It makes no network calls and sends no data about you or your work. There is no telemetry.
- The page shows short bits of session text. If you would rather it did not, turn session text
  off in Settings (the `content` setting, set to `none`). Then you see only names, tools, and
  states.
- It never shows what a model was "thinking", only that it was thinking.
- It opens only on your own computer unless you set up remote access yourself, and only for a
  browser that has the key Pleni prints when it starts.

Read [docs/privacy.md](docs/privacy.md) for exactly what Pleni reads, what it shows, and what it
never does. To report a security problem, read [SECURITY.md](SECURITY.md) first.

## Open it from your phone

Pleni opens only on your own computer. To see it on your phone, you can use
[Tailscale](https://tailscale.com/), which links your own devices together privately.

1. Install Tailscale on your computer and your phone, and sign in to the same account on both.
2. Start Pleni on your computer.
3. On your computer, run:

   ```sh
   tailscale serve --bg 8790
   ```

   Tailscale prints a web address for your computer, such as `https://my-pc.tail1234.ts.net`.
4. In Pleni's **Settings**, add two things to the remote access lists: the host name from that
   address (`my-pc.tail1234.ts.net`) and your Tailscale login name (the Tailscale app shows it).
   Save.
5. Open the web address on your phone, with Pleni's key at the end. Take the address Pleni
   printed and put your Tailscale address in place of `http://localhost:8790`, for example
   `https://my-pc.tail1234.ts.net/?t=<key>`. You only need the key once per device; after that,
   bookmark the plain address. It keeps working after restarts.

In `settings.json`, the same thing looks like this:

```json
{
  "remote": {
    "hosts": ["my-pc.tail1234.ts.net"],
    "tailscaleUsers": ["<your Tailscale login>"]
  }
}
```

Pleni lets a request in only when both the host name and the Tailscale login are on these
lists, and the browser has Pleni's key. Please keep these points in mind:

- **Never use `tailscale funnel` for Pleni.** Funnel puts a page on the open internet.
- Anyone you add can see everything you can see in Pleni, and can change its settings too. Add
  only yourself, or people you trust with your work.
- To stop sharing, run `tailscale serve --https=443 off`.

## Pleni and Plenipo

[Plenipo](https://getplenipo.com) is a Windows desktop app that runs its own team of AI workers.
You hire roles, give the team a goal, and Plenipo starts the workers, checks their permissions,
and keeps a record of what they did.

Pleni is a separate, simpler edition. It does not run any workers. It watches the Claude Code,
Codex, Grok and Kimi Code sessions you already run yourself, on Windows, macOS, or Linux. You can use either one, or
both. Both are made by 8 West Ventures, LLC.

## What comes next

Version 0.1 watches, and can open a Claude Code or Codex session in PowerShell for you. The next step is
to let you answer questions, approve plans and send messages to a session right from the browser. The design is in
[docs/proposals/reply-and-send.md](docs/proposals/reply-and-send.md).

These are plans, not promises. Ideas are welcome in
[Discussions](https://github.com/Seckcey/pleni/discussions).

## Help make Pleni better

Good first steps are a bug report that someone else can repeat, a clearer sentence in these
docs, or a fix to a confusing screen.

- Read [CONTRIBUTING.md](CONTRIBUTING.md). Before you send a change, run `npm test` and
  `node scripts/check.js`.
- [Get help](SUPPORT.md) or [ask the community](https://github.com/Seckcey/pleni/discussions).
- [Report a bug](https://github.com/Seckcey/pleni/issues/new?template=bug_report.yml).
- Read [the architecture](docs/architecture.md) to see how Pleni works inside.
- **Security problem?** Read [SECURITY.md](SECURITY.md). Do not post the details in public.

## License

Pleni is **source-available** under the [Elastic License 2.0](LICENSE). In short: you may read,
run, change, and share it. You may not offer it to others as a hosted or managed service, or
remove its notices. The
[LICENSE](LICENSE) file is what counts; see also [NOTICE](NOTICE).

© 2026 8 West Ventures, LLC.
