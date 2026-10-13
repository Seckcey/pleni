# Privacy in Pleni

Pleni runs on your own computer. It reads files that Claude Code and Codex already write, and it
shows what it finds in your browser. This page says exactly what it reads, what it shows, and
what it never does.

## The short version

- Pleni **reads** session files. It **writes** only its own settings file.
- Pleni makes **no network calls**. It has no telemetry, no tracking, no account, and no sign-in.
- Pleni opens only on your own computer (`127.0.0.1`), unless you set up remote access yourself,
  and only for a browser that has the key Pleni prints when it starts.
- You can turn session text off. Then the page shows only names, tools, and states.

## What Pleni reads

Pleni reads only the places below, and only the parts it needs. For session files (the
transcripts of Claude Code and Codex sessions and their helpers) it looks only at files that
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
| A mailbox folder, if you turn one on    | The Markdown files of the queue, the status board, and each task (with any worker run notes), plus the small relay files in `.relay/` |
| A session's project folder, only when it is inside a `_worktrees` folder on a local drive | Only the small `.git` pointer file (at most 4 KB) of that worktree, to learn the name of the repository it belongs to. Nothing else in your project is read |
| Pleni's own settings file               | `settings.json` in Pleni's settings folder                                                               |

From the session files it uses: when each step happened, the working folder, the git branch, the
model and effort, which tool was used, short parts of the tool's input (see below), the
assistant's text, and which session started which helper.

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

When `content` is `none`, none of the text in that second list is shown. Pleni never shows what
a model was "thinking", in either setting. It shows only that the model was thinking.

## What Pleni never does

- It never writes, moves, or deletes anything in the Claude Code, Codex, Claude desktop app, or
  mailbox folders.
- It writes nowhere except its own settings file. It saves that file safely: it writes a temporary
  file in the same folder, then renames it.
- It never starts, stops, or sends anything to a session.
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
also makes a new secret key each time it starts and prints it as part of its address
(`http://localhost:8790/?t=<key>`). Session data and settings answer only a browser that has the
key:

- When you open the address, Pleni gives your browser the key as a cookie that the page's own
  scripts cannot read and that other web sites cannot make your browser send. It then drops the
  key from the address bar.
- A request without the right key gets `401`. Only `/api/health`, which says just that Pleni is
  running, and the page's own files (which hold no session data) answer without it.
- The key is saved in a file named `key` next to `settings.json`, so the address stays the same
  after a restart. A browser keeps it as a cookie for a year. Do not share the address. If it
  leaks, start Pleni once with `--new-key`: the old key stops working.
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
