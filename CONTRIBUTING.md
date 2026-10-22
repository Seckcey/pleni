# Contributing to Pleni

Thanks for taking an interest. Pleni is a small local web app: a Node.js server that reads Claude
Code and Codex session files, and a plain HTML, CSS, and JavaScript page that draws them. This page
covers how to get it running, the checks your change has to pass, and the few house rules that keep
the code simple and safe.

## Before you start

- **Small fix or an obvious bug?** Open a pull request.
- **New feature, new view, or anything that changes how Pleni behaves?** Open an issue or a
  [discussion](https://github.com/Seckcey/pleni/discussions) first, so we can agree on where it
  fits before you write it.
- **Security problem?** Do not open an issue. See [SECURITY.md](SECURITY.md).

## Your first contribution

You do not need to write code to help:

- Try the steps in the README on your own computer and tell us about any step that was unclear.
- Report a bug that someone else can repeat; see [SUPPORT.md](SUPPORT.md).
- Suggest a plainer word for anything on screen that confused you.
- Browse [open issues](https://github.com/Seckcey/pleni/issues), and comment before you start a
  larger change.

## Getting set up

You need [Node.js](https://nodejs.org/) 22.12 or newer and git. There is nothing to install from
npm and nothing to build.

```sh
git clone https://github.com/Seckcey/pleni.git
cd pleni
node bin/pleni.js --demo
```

Then open the whole address it prints (it ends with `?t=` and a key). Demo mode needs no real
sessions, so use it while you work.

How Pleni works inside, file by file, is in [docs/architecture.md](docs/architecture.md). Read it
before you change code. It is the spec.

## The checks your change must pass

Run both before you push. GitHub runs them too, on Windows, macOS, and Linux, with Node.js 22 and
24.

```sh
npm test                 # every test, with node:test
node scripts/check.js    # the repository's own checks
```

A change to the website in `website/` has its own checks. Run them there, and GitHub runs them too
(the Website check):

```sh
cd website
npm ci
npm test
npm run typecheck
```

If you change anything in `relay/`, also run the relay's own test on Windows. It takes a few
minutes and costs nothing. GitHub runs it too, on Windows.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File relay\bin\bridge-relay-check.ps1
```

If you could not run a check, say so in the pull request. Never describe a check you did not run
as passing.

## House rules

1. **Plain words.** Everything a person can read in Pleni, and in these docs, uses short sentences
   and everyday words. Aim for a 5th-grade reading level. If you must use a technical word, say
   what it means right after it.
2. **Zero dependencies.** Use only Node.js and its built-in `node:` modules. Do not add npm
   packages, not even for development or tests. There is no build step: the files in `public/`
   are served as they are. The one exception is the website for getplenipo.com in `website/`,
   which is separate from Pleni: it has its own packages, build and checks
   ([website/README.md](website/README.md)).
3. **Read-only by design.** Pleni never writes anywhere on your computer except its own settings
   folder, and it never stops a session. It sends a session nothing but Roll over's two fixed
   messages and, with the opt-in Send messages, a message the person typed, as one hidden turn of an
   idle session that nothing else has open, with the message on the program's standard input. It may
   start only the opt-in windows (Open in PowerShell, Roll over, New agent, Bring a cloud session
   here), which the person types into, Send's hidden turns, and the GitHub CLI (`gh`) for opt-in
   Live GitHub status. It answers a Claude Code question, plan or permission prompt only with what
   the person chose on this computer, through the hooks that the opt-in Connect adds to Claude
   Code's settings (and Disconnect takes out again).
4. **Private by default.** No telemetry, and nothing loaded from the internet. Pleni makes no
   network calls of its own; only opt-in Live GitHub status reaches GitHub, through `gh`. Session
   text is shown only as text, and only when the `content` setting allows it.
5. **This repository is public.** Never commit personal names, e-mail addresses, user names,
   computer names, session ids, absolute paths from your computer, or real session content. Use
   made-up examples such as `/home/ada/project` or `C:\Users\ada\project`.
6. **Tests come with the change.** Tests use `node:test` and `node:assert/strict`. They make their
   own made-up files in a fresh temporary folder (`fs.mkdtempSync` under `os.tmpdir()`) and delete
   it afterwards. They never read your real session folders and never use the network.
7. **Screenshots come from demo mode** (`node bin/pleni.js --demo`), never from real sessions.
8. **Keep the spec true.** If you change a file layout, a setting, a route, or a data shape, update
   [docs/architecture.md](docs/architecture.md) in the same pull request.
9. **Match the style.** ES modules, 2 spaces, single quotes, semicolons, LF line endings, small
   focused functions, and short comments only where the reason is not obvious.

## Commit messages and pull requests

Commits follow [Conventional Commits](https://www.conventionalcommits.org/): `feat(map): …`,
`fix(codex): …`, `docs(readme): …`, `test(jsonl): …`, `ci: …`.

Keep a pull request to one subject. Say what changed, why, and how you checked it. If the change
shows on screen, add a screenshot taken in demo mode.

## How contributions are licensed

Pleni is licensed under the [Elastic License 2.0](LICENSE).

By opening a pull request, you confirm that the work is yours to give, and you license it to
8 West Ventures, LLC under the Elastic License 2.0 together with a perpetual, worldwide,
royalty-free, irrevocable right to use, change, and distribute it, including in Plenipo and its
other editions, and under any license 8 West Ventures, LLC later applies to Pleni. You keep the
copyright in your own contribution.

If your employer owns your work, get their sign-off before you contribute.
