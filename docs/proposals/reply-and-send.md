# Proposal: answer and send from Pleni

Status: proposal, not built. Pleni 0.1 only watches.

## What we want

From the Pleni page, on the computer or a phone:

1. **Answer what a session asks.** A Claude question (`AskUserQuestion`), a Claude plan waiting
   for approval (`ExitPlanMode`), a Claude permission prompt ("may I run this command?"), and a
   Codex request for input or approval.
2. **Send a message** to a session, as if you typed it there.
3. **Talk through a mailbox**, for teams that coordinate through one.

## The short answer

All three are possible, but not through one door. Each tool offers a different official way in,
and some of them are still marked experimental.

| Goal | Claude Code | Codex |
| --- | --- | --- |
| Answer a question or plan | Yes, through a **hook** that asks Pleni and waits | Yes, through the **app server**, if the Codex app shares it (to test) |
| Answer a permission prompt | Yes, through a **hook** | Yes, through the **app server** (to test) |
| Send a message to an idle session | Yes, `claude -p --resume <id> "..."` | Yes, `codex exec resume <id> "..."`, or the app server's `turn/start` |
| Send to a session that is busy or open in the app | Not safely: messages can interleave | The app server's `turn/steer` may allow it (to test) |

## Claude Code

### Answering questions, plans and permission prompts: hooks

Claude Code runs **hooks** before tools are used, and a hook may be an HTTP call that waits for an
answer (up to 10 minutes by default, configurable). Hooks set in the user's Claude settings also
apply to the Claude desktop app.

- **Questions and plans.** A `PreToolUse` hook on `AskUserQuestion` returns
  `permissionDecision: "allow"` with `updatedInput` holding the answers, for example
  `{ "questions": [...], "answers": { "Which framework?": "React" } }`. The same hook on
  `ExitPlanMode` approves a plan. (The docs show the question format; the plan format needs a
  test.)
- **Permission prompts.** A `PermissionRequest` hook returns
  `{ "hookSpecificOutput": { "hookEventName": "PermissionRequest", "decision": { "behavior": "allow" } } }`
  or `"deny"` with a message.
- **If Pleni is not running**, the hook call fails and Claude Code goes on as if there were no
  hook: the normal question or prompt appears in the app. That is the safe default.

The hard part is **who answers first**. While the hook waits, the app does not show its own
question. So Pleni must not hold every question hostage. The design:

- Each session has a switch, **"Answer from Pleni"**, off by default.
- When it is off, Pleni's hook answers at once with "no decision", and the app asks as usual.
- When it is on, Pleni holds the question, shows it on the page (and phone), and replies when you
  answer. After a time limit you choose (for example 10 minutes) it gives up and the app asks.

Turning hooks on means changing the user's Claude settings file, which Pleni never does today. It
becomes an explicit step, **"Connect Pleni to Claude Code"**, that shows the exact lines it will add,
keeps a backup, and can be undone with one button. The hook call must carry a secret so that only
this Pleni can answer.

### Sending a message: resume

`claude -p --resume <session-id> "message"` runs a new turn in an existing session and adds it to
the same session file. The docs warn that using one session in two places at once mixes up its
messages, and there is no lock. So Pleni will only send when it is safe:

- the session is not working (no turn open, nothing written in the last 90 seconds), and
- no live Claude process has that session open (Claude keeps a list of live processes in
  `~/.claude/sessions/`).

Otherwise the Send button is off and says why ("This session is open in the Claude app. Send it
there."). A message to a session kept running in the background is delivered as its next turn, as
the docs describe.

Each send starts a paid turn on the user's plan. The resumed turn starts in the normal
`claude -p` permission mode, so the permission hook above is what lets it ask before risky steps.

### What does not work

- **Remote Control** (the claude.ai and phone feature) has no API for other apps.
- **Channels** can push messages into a session only when the session was started with a special
  flag and an approved plugin, in the terminal only. Not usable for sessions already running or for
  the desktop app.
- There is no way to type into a running desktop or VS Code session from outside.

## Codex

### The app server

Codex 0.162 ships an **app server**: the program the Codex apps use under the hood. It can run as a
shared local daemon, and `codex app-server proxy` connects to it through a local socket. It speaks
JSON-RPC, and its published schema includes what Pleni needs:

- to send and steer: `thread/list`, `thread/read`, `thread/resume`, `turn/start`, `turn/steer`,
  `turn/interrupt`;
- requests the server sends to its client, which the client answers:
  `item/tool/requestUserInput`, `item/commandExecution/requestApproval`,
  `item/fileChange/requestApproval`, `item/permissions/requestApproval`,
  `mcpServer/elicitation/request`.

It is marked **experimental**, so Pleni must check the version and turn this off if the protocol
changes. Two things must be tested before building on it:

1. Does the Codex desktop app use the shared daemon, so another client can see its threads?
   (On the test computer the daemon was not running.)
2. When two clients watch one thread, which one gets the input and approval requests?

### Fallback: resume

`codex exec resume <thread-id> "message"` sends a message to a thread as a new turn, without the
app server. Same rule as Claude: only when the thread is idle and not open in the app. Codex keeps
writer locks in `~/.codex/thread-writer-locks/`, which Pleni can check first.

## Mailbox

A mailbox has one writer per file. Pleni must not write files that belong to the planner or the
coordinator. The clean way is a new file that belongs to the person, for example
`tasks/<id>/owner-notes.md`, plus a change to the relay so it wakes the coordinator when that file
changes. The relay lives outside Pleni, so this is its own small project.

## Safety rules for any action

Today Pleni can only read, and its key protects only reading. Acting is a bigger power: these
sessions can run commands on the computer. So:

- **Off by default.** Actions are turned on in Settings, per tool, with a plain warning.
- **Local first.** Actions from another device (phone over Tailscale) need their own switch, and
  each action asks for a second confirmation code shown on the computer, or the person's passkey.
- **Show before sending.** Every action shows the exact session, the exact text or decision, and
  asks to confirm.
- **No double sends.** Each action carries a one-time id; repeats are ignored.
- **Never into a busy session** unless the tool supports it safely (Codex `turn/steer`).
- **A record.** Pleni keeps an action log in its own folder: when, which session, what kind of
  action. Not the full text, which may hold secrets.
- **Limits.** A few actions per minute, so a stuck page or a bad link cannot flood a session.
- **The same gates as today:** the host gate, the key, same-origin checks and the `X-Pleni` header
  on every action request.

## Page changes

- The side drawer gets a message box and a Send button that explains when sending is not safe.
- "Needs you" items get answer controls: the question's choices, the plan with **Approve** and
  **Keep planning**, the command with **Allow once** and **Deny**, and Codex input forms.
- A **Needs you** list collects every open question in one place, which suits a phone.

## Plan

| Step | What | Size |
| --- | --- | --- |
| 1 | Tests on a spare computer: Claude hooks in the desktop app (HTTP hooks, secret header, what the app shows while a hook waits, the `ExitPlanMode` answer format), and the Codex app server questions above | Small |
| 2 | Claude questions, plans and permission prompts through hooks, with the "Connect" step, the switch per session, and the answer controls | Large |
| 3 | Send a message to idle Claude sessions, with the safety checks | Medium |
| 4 | Codex answers and messages through the app server, with `codex exec resume` as the fallback | Large, depends on step 1 |
| 5 | Actions from the phone: second confirmation | Medium |
| 6 | Mailbox owner notes, with the relay change | Small, outside Pleni |

Steps 2 and 3 work alone, so Pleni can answer Claude before Codex support is ready.

## Sources

- Claude Code docs: hooks (`PreToolUse`, `PermissionRequest`, HTTP hooks), sessions and headless
  mode (`--resume`), the desktop app, Remote Control and channels, at
  <https://code.claude.com/docs/en/>.
- Codex CLI 0.162 help for `codex exec resume`, `codex app-server` and `codex agents`, and the
  schema from `codex app-server generate-json-schema`.
