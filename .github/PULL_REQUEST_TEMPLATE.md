## What this changes

<!-- One or two sentences. What does this do, and why? -->

## How it was checked

<!-- Tick what you ran. Delete any line that does not apply. Never tick a check you did not run. -->

- [ ] `npm test`
- [ ] `node scripts/check.js`
- [ ] Tried it in demo mode (`node bin/pleni.js --demo`)
- [ ] Tried it with my own sessions (Claude Code, Codex, Grok, Kimi Code, Gemini CLI, Antigravity CLI, or a mailbox)
- [ ] Tried it in light and dark themes, and at phone width (for page changes)

## Screenshots

<!-- Needed if anything changed on screen. Take them in demo mode, never from real sessions. -->

## Checklist

- [ ] **Plain words:** any new text a person can read uses short sentences and everyday words.
- [ ] **Privacy:** no personal names, e-mail addresses, user names, computer names, session ids,
      paths from my computer, or real session content in code, tests, docs, or screenshots.
- [ ] **Zero dependencies:** no npm packages added; only `node:` built-ins.
- [ ] **Read-only:** Pleni still writes nowhere except its own settings folder (apart from the
      opt-in Models page and Connect buttons, which copy a file first), and makes no network calls
      of its own (only opt-in Live GitHub status, through `gh`, and Codex cloud tasks, through
      `codex`, reach the internet).
- [ ] **Spec:** if I changed a file layout, setting, route, or data shape, I updated
      [`docs/architecture.md`](https://github.com/Seckcey/pleni/blob/main/docs/architecture.md).
- [ ] **Tests:** new behavior has tests that make their own data in a temporary folder.

<!-- Closes #000 -->
