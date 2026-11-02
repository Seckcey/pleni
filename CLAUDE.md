# Pleni — notes for AI coding agents

Pleni (Plenipo Browser) shows Claude Code, Codex, Grok and Kimi Code sessions live in a browser.
It is a public repository. [`docs/architecture.md`](docs/architecture.md) is the spec: read it
before you change code, and follow its names, shapes, and file paths.

- **Plain words.** Everything a person reads (the page, error messages, docs, pull request
  summaries) uses short sentences and everyday words, at a 5th-grade reading level. If you must
  use a technical word, say what it means right after it.
- **Zero dependencies.** Node.js 22.12 or newer, ES modules, `node:` built-ins only. Never add an
  npm package, not even a dev one. No build step. (Only the separate `website/` folder, below, has
  packages and a build of its own.)
- **Read-only by design.** Pleni writes nowhere on this computer except its own settings folder. It
  never stops a session, and never writes into Claude Code's, Codex's, or a mailbox's folders, with
  two opt-in exceptions: Connect for Answer questions (below), and the Models page (`src/models.js`), which changes the model and effort values in
  Codex's `config.toml` and Claude Code's `settings.json`, and the worker type files in their
  `agents` folders, only after the person chooses Save on this computer. It copies each file into a
  `backups` folder next to its settings first, changes nothing else in the file, and stops if the
  file changed since the page looked. It sends nothing to a session except Roll over's two fixed messages (`src/rollover.js`), each in a
  window the person sees, after a click, and, with the opt-in Send messages (`src/send.js`, Windows
  only, this computer only), a message the person typed in a session's Chat tab: one hidden
  `claude -p --resume` or `codex exec resume` turn per message, started by full path without a
  shell, with the message on the program's standard input and never on a command line, and only to
  an idle main session that no window, app or other program has open. Its record, `sent.jsonl` in
  Pleni's own folder, never holds the message. The only programs it may start are for the opt-in Open in
  PowerShell, Roll over, New agent and Bring a cloud session here buttons (`src/open.js`,
  `src/rollover.js`, `src/newagent.js`, Windows only, this computer only): a window that runs
  `claude --resume`, `codex resume`, `claude --name`, `claude --teleport` or `codex` for the person
  to type into, Send's hidden turns, and a hidden PowerShell that only asks when a process started. The one other
  program is the GitHub CLI for opt-in Live GitHub status (`src/github.js`): `gh pr list`, and
  `gh pr merge` after the person confirms on this computer, run by full path with fixed words and
  checked values, never through a shell. It answers a Claude Code session's question, plan or permission prompt only with what the person
  chose on this computer, through the opt-in hooks of Answer questions (`src/answers.js`): Connect
  adds Pleni's own two hooks to Claude Code's `settings.json`, with the same care as the Models page,
  and Disconnect takes exactly those out. The hooks call Pleni only on this computer, with a secret
  in `hook-key`; Pleni holds a call only for a session the person switched on or a turn Pleni sent,
  and answers every other call at once with no decision.
- **The relay is separate.** The `relay/` folder holds the mailbox relay: a Windows PowerShell
  program that writes into a mailbox and starts Claude Code sessions. It is not part of Pleni.
  Pleni never runs it, and it is not in the npm package. Read `relay/README.md` before you change
  it. Keep its scripts ASCII-only and working in Windows PowerShell 5.1, and run
  `relay/bin/bridge-relay-check.ps1` on Windows after a change. Never add a file named `CLAUDE.md`
  or `AGENTS.md` inside `relay/`: agents working on Pleni would read it as their own orders. The
  coordinator's orders live in `relay/COORDINATOR.md` instead. Never commit a real mailbox, its
  `.relay` folder, or its `relay-settings.json` or `cost-limits.json`.
- **The website is separate.** The `website/` folder holds getplenipo.com, made by 8 West Ventures,
  LLC. It has its own `package.json` with its own add-on packages (React, React Flow, esbuild,
  TypeScript), its own tests (`cd website && npm ci && npm test`) and its own GitHub check
  (`.github/workflows/website.yml`). The zero-dependency rule covers everything outside it. Pleni
  never imports from it, and it is not in the npm package. Read `website/README.md` before you
  change it. Its pictures of Pleni come from demo mode. A server updater publishes `main`'s site
  after its checks pass, so a merge there goes live within about 15 minutes. Each Pleni release
  adds its notes as `docs/releases/vX.Y.Z.md`, which the site shows under What's new.
- **Private by default.** No telemetry, and nothing loaded from the internet. Pleni makes no
  network calls of its own: only opt-in Live GitHub status reaches GitHub, through `gh` and the
  person's own gh login. Show session text only when `content` is `snippets`, and never show
  thinking text.
- **Who may open it.** Pleni listens on `127.0.0.1`. Only when the person turns on Wi-Fi access on
  this computer, and only while a password is set, does it also listen on the home-network
  addresses of this computer that the person chose (`src/lan.js`: 10.x, 172.16-31.x and
  192.168.x), never on any other address. Another device signs in with the password (or, except on
  a Wi-Fi address, the key) and gets a pass of its own (`src/signin.js`). Pleni keeps only hashes of
  the password and the passes, slows down and then stops wrong tries, and lets only this computer
  set the password, turn Wi-Fi access on or off, sign devices out, or change who may connect. The
  buttons that act work only from this computer, never from a Wi-Fi or Tailscale device.
- **Public repo privacy.** Never put personal names, e-mail addresses, user names, computer names,
  session ids, absolute paths from your computer, or real session content in any file, test,
  commit message, or screenshot. Use made-up examples such as `/home/ada/project` or
  `C:\Users\ada\project`. You may look at real `~/.claude` or `~/.codex` folders only to learn
  field names and value types; never copy what is in them.
- **Tests make their own data.** Use `node:test` and `node:assert/strict`. Build fixtures in a fresh
  folder from `fs.mkdtempSync(path.join(os.tmpdir(), ...))` and remove it afterwards. No network.
  Screenshots come from demo mode (`node bin/pleni.js --demo`).
- **Match the style.** 2 spaces, single quotes, semicolons, LF line endings, small focused
  functions, short comments only where the reason is not obvious.
- **Keep the spec true.** If you change an interface, update `docs/architecture.md` in the same
  change.
- **Credit 8 West Ventures, LLC.** Pleni is made by 8 West Ventures, LLC. Never remove or rename
  that credit; a change that must move one keeps it in the new place.
- **Before you finish,** run `npm test` and `node scripts/check.js`. Both must pass. If you could
  not run one, say so; never report an unrun check as passing.
- **Do not commit, push, or publish** unless the person you are working for asks you to.
