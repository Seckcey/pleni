# Get help with Pleni

Start with the [README](README.md). It covers how to start Pleni, what each view shows, and which
folders it reads. [docs/privacy.md](docs/privacy.md) explains what Pleni reads and shows.

| You need                           | Where to go                                                                                      |
| ---------------------------------- | ------------------------------------------------------------------------------------------------ |
| Setup help, a question, or an idea | [GitHub Discussions](https://github.com/Seckcey/pleni/discussions)                               |
| A bug you can repeat               | [Bug report form](https://github.com/Seckcey/pleni/issues/new?template=bug_report.yml)           |
| A new feature                      | [Feature request form](https://github.com/Seckcey/pleni/issues/new?template=feature_request.yml) |
| A security concern                 | Read [SECURITY.md](SECURITY.md) before you share any details                                     |
| To help build Pleni                | [Contributing guide](CONTRIBUTING.md)                                                            |

## Make a report easy to repeat

Tell us:

- the Pleni version, or the commit you are on (`git rev-parse --short HEAD`),
- your system (Windows, macOS, or Linux, and its version) and your Node.js version
  (`node --version`),
- which sources you use (Claude Code, the Claude desktop app, Codex, a mailbox),
- whether the problem also happens in demo mode (`node bin/pleni.js --demo`),
- the smallest steps that make it happen, and what you expected instead.

A small screenshot helps. Take it in demo mode if you can.

**Do not post private things.** Session files, real session text, passwords, tokens, keys, and
customer data do not belong in a public issue. Before you post a log or a screenshot, look at it
closely: replace your name, your computer's name, and your folder names with made-up ones, such as
`C:\Users\ada\project` or `/home/ada/project`.

## When Pleni shows no sessions

1. Try `node bin/pleni.js --demo`. If the demo works, Pleni itself is fine.
2. Check that Claude Code or Codex ran in the last 24 hours. Pleni hides older sessions.
3. Check the folders in **Settings** against the table in the
   [README](README.md#where-it-looks). If you set `CLAUDE_CONFIG_DIR` or `CODEX_HOME`, start
   Pleni from a terminal that has the same setting.
4. If Pleni says a source could not be read, its message says what went wrong.

## When the page will not open

- Use the whole address Pleni printed when it started, such as `http://localhost:8790/?t=...`.
  The part after `?t=` is a key that changes each time Pleni starts. Without it the page says
  "Pleni needs its key".
- If another program already uses port 8790, start Pleni with `node bin/pleni.js --port 8791`.
- From another device, the page opens only through `tailscale serve`, and only when its host name
  and your Tailscale login are both in Settings. Otherwise Pleni answers `403` on purpose. See the
  [README](README.md#open-it-from-your-phone).

Support is given through this repository. Response times are not promised.
