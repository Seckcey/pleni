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
  Even then, you do the typing. The other is the [Models](#models) page, also off until you turn
  it on, which changes the models Codex and Claude Code use when you ask it to.
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
- **Mail** — shown when your agents use agent mail (see below). It shows every message between you
  and your agents in full, newest first, marks the new ones, and gives the command to answer each.
  **All mail** shows the mail between your agents too.
- **Tasks** — shown only when you turn on a mailbox (see below). It lists each task, its state,
  and which ones need you.
- **Pull requests** — shown when your sessions work in GitHub repositories. For each repository it
  lists the branches your agents work on, who is on each, and links to its pull request on GitHub,
  or to open one. With [Live GitHub status](#live-github-status) on, it also shows each pull
  request's checks and reviews, and a **Merge** button.
- **Settings** — seven short groups: **Basics** (your name, the look, which sessions show),
  **Team** (names, roles, who reports to whom), **Models** (the models and effort your Codex and
  Claude Code agents use, see [Models](#models)), **Sources** (which folders to read, and the
  mailbox, and GitHub), **Alerts**, **Buttons** (Open in PowerShell, New agent, Bring a cloud
  session here, Roll over, Send messages and Answer questions), and **Devices**
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
- with agent mail: mail an agent sent you that you have not read yet;
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

## Send a message to a session

On Windows, you can type a message to a Claude Code session or Codex thread right in Pleni, as if
you typed it in the session. This is off until you turn it on:

1. Open **Settings**, then **Buttons**. Under **Send messages**, tick **Show the Chat tab with a
   message box**, then choose **Save settings**.
2. Click a main session on the map. In its side panel, choose the **Chat** tab.
3. Type your message and choose **Send** (or press Ctrl+Enter).

Pleni runs the session's own program once, in the background, and hands it your message. The answer
shows in the Chat tab a moment later, like any other turn. Nothing opens on your screen.

<p align="center"><img src="https://raw.githubusercontent.com/Seckcey/pleni/main/docs/assets/pleni-chat.png" alt="A Claude Code session's side panel in the demo, on its Chat tab: the last message to it and its answer, then a Message box with a message typed in and a Send button." width="760"></p>

- **It waits its turn.** Pleni never sends to a session that is working, or that is open in a
  PowerShell window, the Claude desktop app, VS Code, the Codex app, or another program: two
  programs at once would mix up its messages. The Chat tab says why when it cannot send yet.
- **It reads and answers by default.** A sent message may read files and answer. Anything that
  would need your yes is turned down. To let it change files in its folder too, choose **Also
  change files in its folder** under **A sent message may**. What the session's own settings forbid
  stays forbidden either way.
- **It uses your plan,** like typing the message yourself.
- **Your message stays private.** It goes to the program on its standard input, never on a command
  line. Pleni keeps no copy: its record, `sent.jsonl`, says only when, to which session, and how
  the turn ended.
- **Only on this computer,** like the other buttons, and only for main sessions, not helpers.

## Answer questions from Pleni

A Claude Code session sometimes stops to ask you something: a question with choices, a plan to
approve, or "may I run this command?". Pleni can show those to you, so you answer them in your
browser instead of in the session's own window. That is how you answer a session that runs with no
window, such as one you sent a message with Pleni.

1. Open **Settings**, then **Buttons**. Under **Answer questions**, choose **Connect Pleni to Claude
   Code**. Pleni adds two hooks to Claude Code's settings file. It keeps a copy of the file first and
   changes nothing else in it.
2. Click a Claude Code session on the map. In its side panel, tick **Answer its questions in
   Pleni**. (Questions from messages you send with Pleni always come to Pleni.)
3. When it asks, the question shows under **Needs you**. Pick the answer, approve the plan or ask it
   to keep planning, or allow or deny the tool. **Answer in the session instead** gives it back.

<p align="center"><img src="https://raw.githubusercontent.com/Seckcey/pleni/main/docs/assets/pleni-answer.png" alt="A Claude Code session's side panel in the demo, with two questions waiting: one with choices and an Other box, and a plan with Approve the plan, Keep planning, and Answer in the session instead buttons." width="760"></p>

- **Nothing waits forever.** After the time you set under **Hold a question for** (10 minutes at
  first), the session asks in its own window again.
- **Other sessions are not held up.** Pleni answers "no decision" at once for every session you did
  not switch on, and Claude Code asks there as before.
- **Only on this computer,** and only while Pleni runs: if Pleni is not running, Claude Code goes on
  as if there were no hook.
- **Disconnect** takes Pleni's hooks out of Claude Code's settings again.
- Codex threads cannot ask Pleni yet.

## Bring a cloud session to this computer

Sessions you run in Claude Code on the web (claude.ai/code) run on Anthropic's computers, so Pleni
cannot see them. Claude Code can copy one onto your computer to go on with it here, and then Pleni
shows it like any other session. On Windows, Pleni gives you a button for that:

1. Open **Settings**, then **Buttons**. Tick **Show the Bring a cloud session here button**, then
   choose **Save settings**.
2. Click a Claude Code session that works in the same repository. In its side panel, choose **Bring
   a cloud session here**.
3. A PowerShell window opens in that folder and runs `claude --teleport`. Pick your cloud session
   there.

Claude Code needs the folder to hold the same repository with no unsaved changes, and the cloud
session's branch pushed to GitHub. If one of those is missing, the window says what to do. The copy
on your computer goes on by itself: new work there does not go back to the cloud session.

## Live GitHub status

Pleni can show each pull request's checks and reviews on the **Pull requests** page, and merge one
for you. It is off until you turn it on, because this is the one time Pleni reaches the internet.
Pleni does not talk to GitHub itself: it asks the GitHub CLI (`gh`) on your computer, which uses
your own gh sign-in.

1. Install gh from [cli.github.com](https://cli.github.com/). In PowerShell, run `gh auth login`
   and follow its steps. If Pleni is running, stop it and start it again from a new PowerShell
   window, so it can find gh.
2. In Pleni, open **Settings**, then **Sources**. Under **GitHub**, tick **Ask GitHub about pull
   requests**. To merge from Pleni too, tick **Show the Merge button** and pick **How to merge**.
   Then choose **Save settings**.
3. Open **Pull requests**. Each branch shows its pull request with pills such as **Checks pass**,
   **Needs a review** and **Ready to merge**. **Look again** asks GitHub right away.

Pleni asks about once a minute, and only while the Pull requests page is open. It asks only about
the repositories your sessions work in.

**Merge** works only on the computer that runs Pleni, and only when every check passes and GitHub
says the pull request is ready. Pleni asks you first, then checks once more that nobody pushed
since you looked. A merge changes your repository on GitHub, so read the pull request first.

## Models

**Settings → Models** shows which model and effort your Codex and Claude Code agents start with,
and lets you change them. Each tool has its own section:

- **Sergeants and new threads:** the model and effort a new thread or session starts with. The
  relay wakes Codex agents with them too. Claude Code keeps an effort for each model.
- **Workers:** what a worker gets when the sergeant that starts it does not pick. A sergeant can
  still pick the model and effort for each worker it starts. Leave the effort on **The sergeant
  chooses** to let it. Claude Code has no worker effort setting: a worker its sergeant gives no
  effort gets its type's, or else the sergeant's own. A Claude Code worker that is a fork of its
  sergeant always runs on the sergeant's model.
- **Worker types:** kinds of workers a sergeant can pick by the work, such as one for coding and
  design work and one for easier tasks, each with its own model. **Add a worker type** makes one.

On the map, a Claude Code worker's model or effort that its sergeant did not choose ends with
"(default)", such as "Sonnet 5.5 · max effort (defaults)". Its Details tab says who chose them. To
have a sergeant choose for every worker, its standing orders must ask for it: Claude Code tells a
sergeant to set a worker's effort only when told to. The relay's coordinator orders
(`relay/COORDINATOR.md`) do this.

For Codex, the model menus list the models Codex offers you, so a new model shows up there once
Codex knows it, and an effort menu lists only the levels its model takes. For Claude Code, they
offer its short names (Fable, Opus, Sonnet, Haiku), which always point at the newest version, and
the models your sessions use.

To change them from Pleni:

1. Open **Settings**, then **Models**. Tick **Let Pleni change the models Codex uses**, then choose
   **Save settings**.
2. Pick the models and effort levels you want, then choose **Save to Codex** or **Save to Claude
   Code**.

Pleni changes only those settings, and saves a copy of the old file first, in the `backups` folder
next to Pleni's settings. If the file changed since you looked, Pleni changes nothing and shows you
what it says now. It works only on the computer that runs Pleni. Threads and sessions that start
after you save use the new settings, and so do the relay's wake-ups. One that is running keeps
what it started with.

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

**Agent mail** lets your agents write to each other, and to you, by name, through the same
mailbox folder (see "Agent mail" in the [relay README](relay/README.md)). Pleni shows it: a line
lights up between two tiles when mail goes from one to the other, a tile says how many new
messages wait for it, and mail for you shows under **Needs you**. Read your mail in full on the
**Mail** page, where each message has the PowerShell command that answers it. Click a tile to see
whether the relay wakes it for its mail. Pleni never sends mail itself.

## Privacy and safety

- Pleni reads files. It writes only its own settings folder, except when you choose **Save to
  Codex** or **Save to Claude Code** on the [Models](#models) page, which changes that tool's model
  settings after it keeps a copy.
- It starts nothing unless you turn on **Open in PowerShell**, **Roll over**, **New agent**,
  **Bring a cloud session here** or **Send messages** and click a button. Then it opens one
  PowerShell window that runs `claude` or `codex`, or, for Send, runs the session's program once in
  the background with your message. Open in PowerShell and New agent never type into a session.
  Roll over sends one short message, which it shows you first. Send sends only what you type.
- With **Answer questions** connected, Claude Code asks Pleni before it asks you, for the sessions
  you switch on. Pleni answers only what you choose; every other question goes to the session's own
  window as before. Connect and Disconnect change only Pleni's own hooks in Claude Code's settings,
  after a copy.
- Pop-ups are off until you turn them on. Your browser makes them on your own screen; nothing is
  sent over the internet.
- It makes no network calls of its own and sends no data about you or your work. There is no
  telemetry. The one way out is **Live GitHub status**, off until you turn it on: then the GitHub
  CLI (`gh`) on your computer asks GitHub about your pull requests (see
  [Live GitHub status](#live-github-status)).
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
long session over to a fresh one, start a new agent next to one, send a session a message, and
answer a Claude Code session's questions, plans and permission prompts. Next: answering Codex
threads, and doing these from your phone with a second check. The design is in
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
