# Security policy

Pleni reads your AI sessions' files and shows them in a web page. Those files can hold your work,
so security reports are taken seriously.

## Supported versions

Pleni is new. Only the latest version on the `main` branch is supported. Please check that the
problem still happens there before you report it.

| Version             | Supported |
| ------------------- | --------- |
| Latest `main`       | Yes       |
| Anything older      | No        |

## Reporting a vulnerability

**Do not open a public issue for a security problem.**

Open the [Security tab](https://github.com/Seckcey/pleni/security), choose
**Report a vulnerability**, and describe what you found. Only the maintainers can see your report.
We will reply as soon as we can; no response time is promised yet.

If the button is missing, do not put details, exploits, logs, or secrets in a public issue or
discussion. Ask in [Discussions](https://github.com/Seckcey/pleni/discussions) for another private
way to reach us, without sharing any details.

Please use made-up data in your report. Do not send real session files.

## What counts as a vulnerability here

These are Pleni's promises, in plain words. A way around any of them is a vulnerability:

- **Only your computer can reach it.** Pleni listens only on `127.0.0.1`. It answers only when the
  host name is `localhost`, `127.0.0.1`, or `[::1]`, or when the host name is on `remote.hosts`
  **and** the `Tailscale-User-Login` header is on `remote.tailscaleUsers`. Anything else gets
  `403`. A way past this check, including DNS rebinding, is a vulnerability.
- **Only the person who started it can use it.** Other accounts on the same computer can reach
  `127.0.0.1` too, and can send any header they like. So every `/api/` request except
  `/api/health` also needs the secret key that Pleni keeps in its settings folder (file `key`, made once,
  replaced with `--new-key`) and prints in its
  address (`/?t=<key>`). The browser keeps it as an `HttpOnly`, `SameSite=Strict` cookie for a year, and
  Pleni compares it in constant time. Without it the answer is `401`. A way to read session data
  or change settings without the key, from another account or another program, is a
  vulnerability.
- **It only reads.** Pleni writes nowhere on your computer except its own settings folder, and it
  never stops a session. It sends a session nothing but Roll over's two fixed messages and, with
  **Send messages** turned on, a message you type in a session's Chat tab on this computer: one
  hidden `claude -p --resume` or `codex exec resume` turn, with your message on the program's
  standard input, never on its command line, and only to an idle session that nothing else has
  open. It starts programs only when asked: with **Open in PowerShell**, **Roll over**, **New
  agent** or **Bring a cloud session here** turned on, a click on this computer opens a PowerShell
  window that runs `claude` or `codex`. Before that, it may run a hidden PowerShell that only asks
  Windows when a program started. With **Live GitHub status** turned on, it runs the GitHub CLI
  (`gh`) to read pull requests, and with **Merge** on too, to merge one after you confirm on this
  computer. A way to make it write, delete, merge, or run anything else, to start a window, a
  hidden turn or gh without the setting, from another device, to send to a session that is busy
  or open elsewhere, or with a command line of your choosing, is a vulnerability.
- **It never phones home.** Pleni makes no network calls of its own and has no telemetry. Only
  Live GitHub status reaches the internet, through gh, and only when you turn it on.
- **Session text stays text.** Text from session files is shown as plain text and never run as
  code in the page. The page allows only its own scripts and styles. A way to run a script
  through session content, a file name, or a setting is a vulnerability.
- **Settings change only on purpose.** Saving settings needs the key, the `X-Pleni: settings`
  header, a JSON body of at most 64 KB, and, when the browser sends one, an `Origin` that matches
  the host. A way for another web site or another account to change Pleni's settings is a
  vulnerability.
- **It serves only its own files.** Pictures under `/brand/` come only from Pleni's own `brand`
  folder. A way to read any other file through the server is a vulnerability.
- **"None" means none.** With `content` set to `none`, no session text, tool details, or mailbox
  headings reach the page. Model "thinking" text never reaches the page in any setting.
- **Errors give nothing away.** Error replies never hold stack traces or file contents.

### The relay

The mailbox relay in `relay/` is a separate Windows program. Pleni never runs it; you start it
yourself. Its safety rules are in [relay/README.md](relay/README.md#safety). A way to make it wake
a session other than the one you enrolled, or to start a worker outside its worktrees folder, is a
vulnerability. Its lists of allowed and refused commands match the text of a command, so they are
a guard, not a sealed box. A way around them is still worth reporting.

## Out of scope

- What the AI tools write in their own files. Pleni only shows it.
- Problems in Claude Code, Codex, the Claude desktop app, or Tailscale themselves. Report those to
  their makers.
- People you added to `remote.hosts` and `remote.tailscaleUsers`. They are trusted by design: they
  can see what you see and change settings.
- A proxy other than `tailscale serve` that passes a visitor's own `Tailscale-User-Login` header
  on to Pleni. That is a setup Pleni does not support.
- Anything that needs an attacker to already be signed in as you on your computer. They could read
  the session files directly. A different account on the same computer is not "you", so it is in
  scope.
- Someone who reads the key from your screen, your terminal, or a copy of the address you shared.
  Treat the address Pleni prints like a password while Pleni runs.
- The address passing through the list of running programs for a moment when you use `--open` on
  a shared Linux computer. [docs/privacy.md](docs/privacy.md#who-can-open-the-page) says to copy
  the address yourself there.
