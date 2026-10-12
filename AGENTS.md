# Pleni — notes for AI coding agents

Pleni (Plenipo Browser) shows Claude Code and Codex sessions live in a browser. It is a public
repository. [`docs/architecture.md`](docs/architecture.md) is the spec: read it before you change
code, and follow its names, shapes, and file paths.

- **Plain words.** Everything a person reads (the page, error messages, docs, pull request
  summaries) uses short sentences and everyday words, at a 5th-grade reading level. If you must
  use a technical word, say what it means right after it.
- **Zero dependencies.** Node.js 22.12 or newer, ES modules, `node:` built-ins only. Never add an
  npm package, not even a dev one. No build step.
- **Read-only by design.** Pleni writes nowhere except its own settings file. It never starts,
  stops, or sends anything to a session, and never writes into Claude Code's, Codex's, or a
  mailbox's folders. Sending work and approvals need their own design first.
- **Private by default.** No network calls, no telemetry, nothing loaded from the internet. Show
  session text only when `content` is `snippets`, and never show thinking text.
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
