# Privacy in Pleni

Pleni runs on your own computer. It reads files that Claude Code, Codex, Grok and Kimi Code already write, and it
shows what it finds in your browser. This page says exactly what it reads, what it shows, and
what it never does.

## The short version

- Pleni **reads** session files. It **writes** only in its own folder: its settings, its key, and
  the list of notices you dismissed.
- Pleni **starts** nothing, unless you turn on **Open in PowerShell**, **Roll over** or **New
  agent** and click a button. Then it opens one PowerShell window. You do the typing, except for
  Roll over's one short message, which the page shows you before you click.
- Pleni makes **no network calls**. It has no telemetry, no tracking, and no account. Its only
  sign-in is its own key, which it keeps on your computer.
- Pleni opens only on your own computer (`127.0.0.1`), unless you set up remote access yourself,
  and only for a browser that has the key Pleni prints when it starts.
- You can turn session text off. Then the page shows only names, tools, and states.

## What Pleni reads

Pleni reads only the places below, and only the parts it needs. For session files (the
transcripts of Claude Code, Codex, Grok and Kimi Code sessions and their helpers) it looks only at files that
changed in the last 24 hours (the `recentHours` setting). The small notes files of the Claude
desktop app, the mailbox's task files, and the Codex list of session names are read whatever
their age, because they are small and say which session is which. For big files Pleni reads from
the end, about the last 4 MB at first, and then only the new lines as they are added. It may also
read the start of a file once, to find a session's name and where it started.

| Where                                   | What Pleni reads                                                                                         |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Claude Code folder (usually `~/.claude`) | Session files in `projects/`, and the helper (sub-agent) files and notes stored next to them              |
| Claude desktop app folder                | Only these fields of each session's notes file: session id, title, title source, model, effort, folder, archived, last activity time |
| Codex folder (usually `~/.codex`)        | Session files in `sessions/` and `archived_sessions/`, and the list of session names in `session_index.jsonl` |
| Grok folder (usually `~/.grok`)          | Each session's summary and its event, chat and update logs in `sessions/` |
| Kimi Code folder (usually `~/.kimi-code`) | Each session's `state.json` and its agents' `wire.jsonl` logs in `sessions/` |
| Codex coordinator list, if present      | `coordinators/registry.sqlite3` (opened read-only) and `coordinators/superintendent.json`, only to learn which coordinator started which worker |
| A mailbox folder, if you turn one on    | The Markdown files of the queue, the status board, and each task (with any worker run notes), the notes for you (`NEEDS-<NAME>.md`), plus the small relay files in `.relay/`, its alerts (`alerts.md`) among them |
| A session's project folder, only when it is inside a `_worktrees` folder on a local drive | Only the small `.git` pointer file (at most 4 KB) of that worktree, to learn the name of the repository it belongs to |
| A session's project folder, on a local drive | Only the git settings file (`.git/config`, at most 64 KB) of the repository it is in, and in a worktree the small `.git` and `commondir` files that lead there. Pleni keeps only the address of the `origin` remote, and from it only the owner and name of a GitHub repository, to link to its pull requests. It never keeps a login or token that the address may hold. Nothing else in your project is read |
| Claude Code folder, only when you click Open in PowerShell | The small files in `sessions/` that Claude Code keeps for each running process. Pleni reads only which session each one has open, whether it runs in the background or in a terminal, and its process number, to be sure no other window has that session open. To tell a live Claude Code from a leftover file, it then asks Windows (through a hidden PowerShell) only when the program with that number started |
| Codex folder, only when you click Open in PowerShell | One empty file, `thread-writer-locks/<thread id>.lock`, which Codex locks while a program writes that thread. Pleni tries to read one byte of it, only to learn whether another window has the thread open |
| The same two folders, when you click Roll over's buttons | The same small files as for Open in PowerShell, for the same reason |
| A session's own folder, only while its Roll over section is open | Only whether the handoff note (`HANDOFF-<name>.md`) is there, and when it last changed. Pleni never reads what is in it |
| Pleni's own folder                      | `settings.json`, `key`, and `dismissed.json` (which notices you dismissed, and when) in Pleni's settings folder |
| Pleni's own program folder, if it is a git copy | Only `.git/HEAD` and the one branch file it names (or `packed-refs`), to show which commit runs |

From the session files it uses: when each step happened, the working folder, the git branch, the
model and effort, which tool was used, short parts of the tool's input (see below), the
assistant's text, which session started which helper, and for "Roll over soon" only numbers: how
many tokens the newest step used, how big the model's memory is (Codex), and when the history was
squeezed into a summary and by how much.

Pleni also reads a few settings from your environment: `PLENI_PORT`, `PLENI_HOME`,
`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, and the usual system folders (`APPDATA` on Windows,
`XDG_CONFIG_HOME` on Linux).

The [README](../README.md#where-it-looks) lists the usual folders for each system.

## What Pleni shows

Always:

- Your name (the one you type in Settings; "You" until you change it).
- Session names, project folder names, git branches, models, and effort.
- Each session's state (Needs you, Working, Finished, Idle, Done, Error), the name of the tool it is
  using, and when it last did something.
- Who started whom, and when work was handed down or reported back up.
- In the Tasks view: mailbox task ids and states.

Only when the `content` setting is `snippets` (this is the default):

- A short note about the current tool step, at most 140 characters. It is built from the step's
  description, the first line of a command, a file's name (not its folder), a search pattern, a
  helper's task description, or a web site's host name.
- The last thing the assistant said, at most 280 characters.
- In the side panel: up to 200 recent steps, each with at most 2,000 characters of text.
- Mailbox task titles and the headings of mailbox entries.
- Under Needs you: the newest note for you from the mailbox, the relay's newest alert, and why the
  relay halted, each at most 280 characters.

When `content` is `none`, none of the text in that second list is shown. Pleni never shows what
a model was "thinking", in either setting. It shows only that the model was thinking.

### Pop-ups

Pop-ups are off until you turn them on in **Settings → Alerts**, and then only in that browser. Each
new Needs you notice then pops up on your screen with the same words the page shows (so with
`content` set to `none`, no session text). The browser makes the pop-up from the open Pleni page.
Pleni uses no push service, so nothing about them goes over the internet. Your system may keep
recent pop-ups in its notification list until you clear them.

## What Pleni never does

- It never writes, moves, or deletes anything in the Claude Code, Codex, Claude desktop app, or
  mailbox folders.
- It writes nowhere except its own folder (`settings.json`, `key`, `dismissed.json`). It saves each
  file safely: it writes a temporary file in the same folder, then renames it.
- When it turns away a device that Tailscale brings, it keeps that device's Tailscale address and
  login in memory (the last 5, never in a file), so Settings → Devices on your computer can offer
  **Allow**. Only your computer's page can see this list, and Pleni's key.
- It never stops a session. It sends nothing to one, except Roll over's two short messages when you
  click its buttons (see below).
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
- **New agent** (Settings → Buttons, off until you turn it on, Windows only, this computer only)
  opens one PowerShell window in the folder of a session you pick and runs `claude --name <name>`
  or `codex` there. The name you type is held to the same plain marks. Pleni sends the new agent
  nothing: you type its first message.
- It makes no network calls. It sends no telemetry, usage counts, or crash reports.
- The page loads nothing from the internet. Its scripts, styles, and pictures all come from Pleni
  itself, and the page's security rules block anything else.
- It never puts stack traces or file contents in error messages.
- It asks the browser not to keep copies of its pages and data (`Cache-Control: no-store`).

## Who can open the page

Pleni listens only on `127.0.0.1`, so only programs on your own computer can reach it. Even there,
it answers only when the address is `localhost`, `127.0.0.1`, or `[::1]`. This stops a web site
from tricking your browser into reading Pleni (an attack called DNS rebinding).

A computer can have more than one account, for example a shared Linux machine or a Windows
computer that several people sign in to remotely. Every account can reach `127.0.0.1`. So Pleni
also has a secret key. It makes the key the first time it starts and prints it as part of its
address (`http://localhost:8790/?t=<key>`). Session data and settings answer only a browser that
has the key:

- When you open the address, Pleni gives your browser the key as a cookie that the page's own
  scripts cannot read and that other web sites cannot make your browser send. It then drops the
  key from the address bar.
- A request without the right key gets `401`. Only `/api/health`, which says just that Pleni is
  running, and the page's own files (which hold no session data) answer without it.
- A browser without the key sees a sign-in box. Pasting the key there opens the same address, so
  it works the same way. The browser can save the key like a password, in its own password store.
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

## Remote access and its risks

You can open Pleni from your phone or another device through `tailscale serve` (see the
[README](../README.md#open-it-from-your-phone) for the steps). Pleni then lets a request in only when
both of these are true:

- the host name is on your `remote.hosts` list, and
- the request carries a Tailscale login (the `Tailscale-User-Login` header) that is on your
  `remote.tailscaleUsers` list.

The other device also needs Pleni's key, the same as your own browser: open the address Pleni
printed with your Tailscale address in place of `http://localhost:8790`, for example
`https://my-pc.tail1234.ts.net/?t=<key>`.

Before you turn it on, know the risks:

- **Everyone you add sees what you see.** That includes session names, folder names, and, with
  `snippets`, bits of your work. Set `content` to `none` if that is too much.
- **Everyone you add can change Pleni's settings,** including which folders it reads and who else
  may open it. Add only yourself, or people you trust with your computer's work.
- **Never use `tailscale funnel`.** Funnel puts a page on the open internet.
- **Use only `tailscale serve` in front of Pleni.** Pleni trusts the `Tailscale-User-Login`
  header because Tailscale sets it. Another proxy that passes that header on from the visitor
  would let anyone pretend to be you.
- Remote access ends when you stop sharing (`tailscale serve --https=443 off`) or remove the
  entries from your settings.

## Questions

Ask in [Discussions](https://github.com/Seckcey/pleni/discussions). To report a security problem,
follow [SECURITY.md](../SECURITY.md) and do not post the details in public.
