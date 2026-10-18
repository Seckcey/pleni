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
  nothing anywhere. There is no account and no tracking. The only sign-in is Pleni's own key,
  which it keeps on your computer.
- **It has zero dependencies.** You need only Node.js. Pleni installs nothing else from npm and has
  nothing to build.

## Start here

You need [Node.js](https://nodejs.org/) 22.12 or newer. Then run:

```sh
npx pleni
```

Pleni prints its address, such as `http://localhost:8790/?t=...`. Open that whole address in
your browser. The part after `?t=` is a secret key that keeps other people who use this computer
out. Each browser needs the key only once. After that, bookmark `http://localhost:8790/`.

- **The address and the key stay the same.** Pleni saves the key and never changes it on its own.
  To see the address and the key again, run `npx pleni --url`.
- **If a browser forgets the key,** Pleni shows a sign-in box. Paste the key there. Your browser can
  save it like a password.
- **To change the key,** for example if someone saw it, start Pleni once with `--new-key`. Each
  browser then needs the new key once.

Press Ctrl+C in the terminal to stop Pleni.

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
| `--url`         | Show Pleni's address and key, without starting it       |
| `--new-key`     | Make a new key, so the old one stops working            |
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
- **Pull requests** — shown when your sessions work in GitHub repositories. For each repository it
  lists the branches your agents work on, who is on each, and links to its pull request on GitHub,
  or to open one. Pleni only links to GitHub; it sends nothing there.
- **Settings** — six short groups: **Basics** (your name, the look, which sessions show),
  **Team** (names, roles, who reports to whom), **Sources** (which folders to read, and the
  mailbox), **Alerts**, **Buttons** (Open in PowerShell, New agent and Roll over), and **Devices**
  (opening Pleni from another device). Type in **Find a setting** to find one by name, such as
  "port" or "folder".

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

**Hide a session.** An old or test session can leave the map: click it, then choose **Hide from the
map** in its side panel. Nothing is deleted, and **Undo** brings it back. To show it again later,
go to **Settings → Team → Names and roles** and set its Role back to **Automatic**. The counts
under the title say how many are hidden.

**Roll over soon.** A long session gets slow, and each time its history is squeezed into a summary
it forgets details. Pleni marks a main Claude Code session or Codex thread **Roll over soon** when
its memory is nearly full, its history was squeezed often, or it is old. The side panel says why,
and its Details tab shows the numbers. Pleni reads only numbers for this, never what was said. Set
the limits in **Settings → Alerts → Roll over soon**; 0 turns one off. Then use
[Roll over](#roll-over-a-session).

**Which Pleni is this?** The version shows beside the name at the top of the page, and Settings
says which version and git commit you run. After you update Pleni and start it again, an open page
says so; reload it to use the new version. `node bin/pleni.js --version` prints the version too.

**Chain of command.** Pleni draws each helper under the session that started it. Codex workers
started by a coordinator hang under that coordinator. If your sessions report to each other in
another way, say so in **Settings → Team → Chain of command**: for example, "a session whose name
contains *Sergeant* reports to the newest session whose name contains *Colonel*". Rules match names,
so they keep working when a session is replaced by a new one.

## Needs you and alerts

The **Needs you** strip at the top of the map and the list shows what waits on you:

- a session that asks you a question, wants a plan approved, or says it is blocked;
- a session that stopped with an error;
- with a mailbox: a task with a blocking question, a task ready for review, a new note for you in
  a `NEEDS-<NAME>.md` file, and the relay's alerts. It also says when the relay is paused or
  halted, and what to do about it;
- a tile you watch that stopped working (see below).

Click a notice to open its tile. Click its **×** to hide it until something newer happens.

**Tell me if this stops working.** Click a session or the relay, and tick this box in its side
panel. If the session does no work for 15 minutes, or the relay does not run for 15 minutes, it
shows under Needs you. Change the time in **Settings → Alerts**. This helps when your agents keep
each other going and one of them goes quiet.

**Pop-ups.** In **Settings → Alerts**, tick **Pop up an alert in this browser when something new
needs you**. When the browser asks whether Pleni may show notifications, say yes. Each new notice
then also pops up, even while the Pleni tab is in the background. Keep the tab open. Use **Send a
test alert** to try it.

- Pop-ups work in desktop browsers such as Edge, Chrome and Firefox. Most phone browsers cannot
  show them from a page.
- The browser allows them only at a `localhost` or `https` address, such as the one
  `tailscale serve` gives you.
- The choice is kept in that browser only, so each browser asks for itself.
- A pop-up can take up to a minute to come while the tab is in the background.

## Open a session in PowerShell

On Windows, Pleni can open a Claude Code session or a Codex thread in a PowerShell window, so you
can watch it and type to it. You do not need Claude Code or Codex open first: the window starts
it. This is off until you turn it on:

1. Open **Settings**, then **Buttons**. Tick **Show the Open in PowerShell button**, then
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

## Roll over a session

A session that has run for days gets slow, and each turn costs more: the model reads the whole
history again every time. Rolling it over starts a fresh session with the same name that picks up
from a handoff note. On Windows, Pleni walks you through it. This is off until you turn it on:

1. Open **Settings**, then **Buttons**. Tick **Show the Roll over button**, then choose
   **Save settings**.
2. Click the session on the map. In its side panel, choose **Roll over…**.

The section shows four steps, and the exact message of each step before you click:

1. **Ask for a handoff note.** **Ask in PowerShell** opens the old session in a new window and
   asks it to write `HANDOFF-<its name>.md` in its folder. Watch it write the note.
2. **Close the old session.** Type `/exit` in that window (`/quit` for Codex).
3. **Start the new session.** **Start in PowerShell** opens a new window in the same folder. A new
   Claude Code session gets the same name on its own. For Codex, type `/rename <name>` in the new
   window; the section shows the exact words. The new session starts with the old one's model and
   effort, and for Claude Code its permission mode too.
4. **Check.** Pleni shows the new session once it finds it, and says when the mailbox relay now
   wakes it. You can keep the new window open to watch it and type to it. While it is open, the
   relay waits and keeps its messages; type `/exit` when you want the relay to wake it again. If you
   use the relay, update its copy in your mailbox first (see "Update the relay in a mailbox" in
   [relay/README.md](relay/README.md)).

- **The session needs a name of its own.** Give it one with `/rename` first. The new session takes
  it, and the mailbox relay and chain-of-command rules find sessions by name.
- **Standing instructions go along.** The old session is asked to copy into the note every standing
  instruction it follows, such as how to report, how to pick a model and effort, and what it may
  and may not do, and the new one is told to follow them. Rules that every agent should always
  follow are safest in the project's `CLAUDE.md` (Claude Code) or `AGENTS.md` (Codex): each new
  session reads those by itself.
- **Open in an app?** If the Codex app or the Claude desktop app has the session open, Pleni cannot
  send to it. Use **Copy the message** and paste it there, then start the new session from Pleni
  or in the app.
- **Pleni sends only these two messages,** and only when you click. It never reads the note, and
  it never archives, pins or closes a session: do that in the app if you like.
- **The note is a file in the session's folder.** In a git repository, it says not to commit it.
  You can add `HANDOFF-*.md` to that repository's `.gitignore`.

## Start a new agent

On Windows, Pleni can start a new Claude Code or Codex agent in the same folder as a session on
the map, for example a new Sergeant next to its Colonel. This is off until you turn it on:

1. Open **Settings**, then **Buttons**. Tick **Show the New agent button**, then choose **Save
   settings**.
2. Click a Claude Code or Codex session on the map. In its side panel, choose **New agent here…**.
3. Pick **Claude Code** or **Codex**, type a name such as `Sergeant 3`, and choose **Start in
   PowerShell**.

A new PowerShell window opens in that session's folder and runs `claude --name <name>`, or
`codex` for Codex. Type the new agent's first message there. It shows on the map after that
message.

- **Pleni sends it nothing.** You type everything in the window.
- **Codex takes its name later.** After the first message, type `/rename <name>` in the window.
  The section shows the exact words, with a copy button.
- **Names are kept apart.** The name may have letters, digits, spaces and `. _ - # + * ,`. Pleni
  refuses a name that a session on the map already has, because the relay and your chain of
  command rules find agents by name. To replace a session, use [Roll over](#roll-over-a-session).
- **Only on this computer,** like the other buttons, and it uses your plan like any Claude Code or
  Codex window.

## Where it looks

Pleni finds the usual folders on its own. You can change any of them in **Settings → Sources**.

| What it reads                       | Usual folder                                                                                                       | Change it with      |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------- |
| Claude Code sessions and helpers    | `~/.claude` (on Windows, `C:\Users\<you>\.claude`)                                                                 | `CLAUDE_CONFIG_DIR` |
| Session names from the Claude app   | Windows: `%APPDATA%\Claude` · macOS: `~/Library/Application Support/Claude` · Linux: `~/.config/Claude`            | Settings            |
| Codex sessions and helpers          | `~/.codex` (on Windows, `C:\Users\<you>\.codex`)                                                                   | `CODEX_HOME`        |
| Grok sessions                       | `~/.grok` (on Windows, `C:\Users\<you>\.grok`)                                                                     | `GROK_HOME`         |
| Kimi Code sessions and helpers      | `~/.kimi-code` (on Windows, `C:\Users\<you>\.kimi-code`)                                                           | `KIMI_CODE_HOME`    |
| A coordination mailbox (optional)   | Off until you choose a folder                                                                                      | Settings            |

Pleni shows sessions that were active in the last 24 hours. You can change that in
**Settings → Basics**.

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
- It starts nothing unless you turn on **Open in PowerShell**, **Roll over** or **New agent** and
  click a button. Then it opens one PowerShell window that runs `claude` or `codex`. Open in
  PowerShell and New agent never type into a session. Roll over sends one short message, which it
  shows you first.
- Pop-ups are off until you turn them on. Your browser makes them on your own screen; nothing is
  sent over the internet.
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

1. Install Tailscale on your computer and your phone (or laptop), and sign in to the same account
   on both.
2. Start Pleni on your computer.
3. On your computer, run:

   ```sh
   tailscale serve --bg 8790
   ```

   Tailscale prints a web address for your computer, such as `https://my-pc.tail1234.ts.net`.
4. Open that address on your phone. The first time, Pleni says it does not answer for it yet.
5. On your computer, open Pleni's **Settings → Devices**. Under **Turned away lately**, choose
   **Allow** next to your phone's visit. Pleni adds the address and your Tailscale login to its
   lists and saves.
6. Reload the page on your phone. Pleni asks for its key: on your computer, choose **Copy the
   key** in Settings → Devices and paste it there. (Or choose **Copy a sign-in link** and open that
   link once on the phone.) Then bookmark the page. You only need the key once per device, and the
   address keeps working after restarts.

Lost the address? **Settings → Devices** on your computer shows it with a **Copy** button, and
Pleni prints it when it starts (`From your other devices:`). `npx pleni --url` shows it too, with
the key.

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
lists, and the browser has Pleni's key. **Allow** fills in both lists for you. Please keep these points in mind:

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

Version 0.1 watches. It can also open a Claude Code or Codex session in PowerShell for you, roll a
long session over to a fresh one, and start a new agent next to one. The next step is to let you
send messages to a session, answer questions and approve plans right from the browser. The design
is in [docs/proposals/reply-and-send.md](docs/proposals/reply-and-send.md).

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
