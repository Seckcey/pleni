# Proposal: answer and send from Pleni

Status: proposal. Step 1 of the plan, the relay waking the planner's Codex thread, is built in
`relay/`, and so is **agent mail** (step 7, below), which lets the other Codex threads message each
other without the Codex app; Pleni shows that mail. **Roll over** and **New agent** (step 4) are built in Pleni (see
below). **Send** (step 3) and **Claude Code questions, plans and permission prompts** (step 5) are
built too: the owner asked for them in October 2026, so a team can run with no Codex or Claude app
open. The rest is not built yet.

## What we want

From the Pleni page, on the computer or a phone:

1. **Answer what a session asks.** A Claude question (`AskUserQuestion`), a Claude plan waiting
   for approval (`ExitPlanMode`), a Claude permission prompt ("may I run this command?"), and a
   Codex request for input or approval.
2. **Send a message** to a session, as if you typed it there.
3. **Talk through a mailbox**, for teams that coordinate through one.
4. **Run the team from Pleni alone:** watch, send, and start agents in command-line windows, with
   no Codex app running.

## The short answer

All three are possible, but not through one door. Each tool offers a different official way in,
and some of them are still marked experimental.

| Goal | Claude Code | Codex |
| --- | --- | --- |
| Answer a question or plan | Yes, through a **hook** that asks Pleni and waits | Yes, through the **app server**, if the Codex app shares it (to test) |
| Answer a permission prompt | Yes, through a **hook** | Yes, through the **app server** (to test) |
| Send a message to an idle session | Yes, `claude -p --resume <id> "..."` | Yes, `codex exec resume <id> "..."`, or the app server's `turn/start` |
| Send to a session that is busy or open in the app | Not safely: messages can interleave | The app server's `turn/steer` may allow it (to test) |

## Running the team without the Codex app

Today the Codex desktop app does two jobs that a mailbox does not do:

1. **It carries messages between Codex threads.** Codex threads talk through app tools:
   `send_message_to_thread`, `wait_threads`, `list_threads`, `read_thread`, `create_thread`,
   `fork_thread` and `handoff_thread`, plus tools for the sidebar and for scheduled tasks. They come
   from a local connection to the running app. A check on a real setup (Codex CLI 0.162, October
   2026) found that none of them work once the app is quit. The Codex command line's own helper
   tools (`spawn_agent` and the like) are a different thing: they start new helpers and cannot
   reach threads that already exist.
2. **It wakes threads.** A message sent with `send_message_to_thread` starts the other thread's next
   turn. A file in the mailbox wakes nobody. A mailbox keeps messages, but it does not start an
   idle agent, so every reader needs something that starts its turn.

From the Codex command line these still work: the thread and its history (`codex resume <id>`),
long tasks with `/goal` (marked experimental since Codex CLI 0.128), the repositories, the shell,
and reading and writing the mailbox.

So running the team from Pleni alone needs these parts:

| Need | How | Step |
| --- | --- | --- |
| Wake the planner when the coordinator writes back | The relay wakes one Codex thread with `codex exec resume` | 1 (built) |
| Send a message to any idle session | Pleni runs `claude -p --resume` or `codex exec resume` | 3 (design below) |
| Start a new agent in a window | A **New agent** button, built on Open in PowerShell | 4 (built) |
| Codex threads that use app messaging today | Agent mail: `bin\agent-mail.ps1`, and the relay wakes the agent that gets mail | 7 (built; Pleni shows it) |

### One place per session

A session takes one writer at a time. While it is open in a window, nothing else can safely start
a turn in it. The relay holds its messages until the window closes, and Pleni's Send button must do
the same. So the agents that others message, such as a coordinator or a planner, should run without
a window and be woken. Open their window to look or to talk, then close it.

## Step 1: the relay wakes the planner (built)

The relay already lists what waits for the planner in `.relay/codex-attention.md`: a BLOCKING
question with no answer, or a handoff in review with no newer review. Now it can also wake one
Codex thread for those items.

- **Off until the owner turns it on**, once:
  `bridge-relay.ps1 -EnrollCodex -ThreadId <thread id>`. The relay checks that the thread is in
  the Codex home folder, reads the thread's working folder from its first line, and saves both in
  `.relay/codex.json`. `-UnenrollCodex` turns it off. Enrolling wakes nothing: the items that
  already wait count as known.
- **What wakes the thread:** each new item on that list wakes it once. One turn at a time, with at
  most 10 items in a turn.
- **The command:** `codex exec --json --skip-git-repo-check [extra options] resume <thread id>
  "<notice>"`, run in the thread's folder. The notice starts with `[bridge-relay C<id>]`, names the
  items, and tells the planner to write only the planner's own files. The extra options
  (`codex_exec_args` in `bin/relay-settings.json`) are for the sandbox, such as
  `--sandbox workspace-write`. Options that turn the sandbox off are refused.
- **When it waits, so a thread never has two writers:**
  - another Codex program has the thread open. Codex locks `thread-writer-locks/<id>.lock` while
    a program writes a thread, and the Codex app keeps the lock for every thread it has opened
    until it quits fully;
  - a process has the thread id on its command line, such as a `codex resume` window;
  - something else wrote the thread's file in the last 90 seconds;
  - a coordinator turn is still running, so the planner reads finished work;
  - a Codex wake is still running, the relay is paused, the daily limit is reached (12 a day by
    default), or it is backing off after errors.
- **Sign-in:** ChatGPT sign-in only. The relay checks `codex login status` first, and removes
  `OPENAI_API_KEY` and `CODEX_API_KEY` for the turn. It never uses an API key.
- **Results:** the relay reads Codex's JSON events. `turn.completed` means success. A different
  thread id stops Codex wakes (a halt) and writes an alert, and so do three failures in a row.
  Claude wakes go on either way. `-ClearHalt` clears both.
- **Records:** `codex_notes` and `codex_dispatches` in `.relay/state.json`, one line per turn in
  `.relay/dispatches.md`, and alerts in `.relay/alerts.md`, which Pleni shows under Needs you.

While the Codex app runs and has the thread open, nothing changes: the relay waits, and the app
carries on as before. Quit the app, and the relay wakes the planner itself.

Step 1 does not move other Codex threads off app messaging, wakes only one Codex thread per
mailbox, and never answers anything for the owner.

## Step 7: agent mail (built)

The Colonel coordinates its Sergeants with the Codex app's thread tools: `send_message_to_thread`
to give work, and `wait_threads` to hear back. A Sergeant's answer comes back the same way. Agent
mail does both jobs with files and the relay, so the app can stay closed.

- **Sending:** `bin\agent-mail.ps1 -Send -From <name> -To <name> -Text <message>` writes one file per
  message in `mail\<name key>\new` (the name in lower case, other marks as `-`). It is written
  under another name first and then renamed, so a reader never sees half a message. A message holds
  `From`, `To` and `Sent` lines, a blank line, then the text, at most 64 KB. A name with no mail
  folder yet needs `-NewAgent` once, so a typo does not send mail nowhere.
- **Reading:** `-Read -Me <name>` prints the new mail, oldest first, 10 at a time, and moves it to
  `read`. `-Wait -Me <name> -Seconds <n>` takes the place of `wait_threads`: it waits for new mail,
  then reads it.
- **Waking:** `bridge-relay.ps1 -EnrollAgent -AgentName <name>` records the newest Codex thread with
  that name, and follows the name like the planner wake. When new mail waits for it, the relay runs
  `codex exec --json --skip-git-repo-check [codex_exec_args] resume <thread id> "<notice>"` in the
  thread's folder. The notice says who wrote and how to read and answer, never the mail itself.
- **Never two writers:** the same checks as the planner wake (the app's writer lock, a window with
  the thread id, a recent write), one turn at a time per agent, at most 3 agents at once, 12 wakes a
  day each, and a stop after 3 failures in a row. Mail an agent read by itself, in its own window,
  needs no wake.

So the team can run like this: the Colonel works in a PowerShell window (Open in PowerShell) on a
long `/goal`, sends with `-Send` and waits with `-Wait`. The Sergeants stay closed, and the relay
wakes each one when the Colonel writes. Open a Sergeant's window to look or talk; the relay holds
its mail until the window closes. The app's scheduled tasks are not replaced yet.

Pleni shows agent mail (read-only, like the rest of the mailbox): a line lights up between two
tiles when mail goes from one to the other, each tile says how many new messages wait for it and
whether the relay wakes it, the Activity view lists every message, and mail to the owner shows
under Needs you, with the commands to read it and answer it. Pleni sends no mail; that would be
Send (step 3), which is set aside.

## Roll over (built)

Long sessions get slow and cost more: every turn makes the model read the whole history again,
and old details get squeezed into summaries. Teams that run named agents (a Colonel, Sergeants, a
coordinator) roll them over now and then: the old session writes a handoff note, and a new session
with the same name starts from it. The relay and Pleni's chain rules find sessions by name, so the
new one takes over on its own.

Roll over is the first time Pleni sends a message, so it is kept narrow:

- **Two fixed messages, never free text.** Pleni builds both from the session's own name, and they
  hold only letters, digits, spaces and a few plain marks, so no shell can read any of it as a
  command. The page shows each one before the button. A session whose name has other marks is
  refused, with how to rename it.
- **In a window the person sees.** Each step opens a PowerShell window, the same way Open in
  PowerShell does: the person watches the old session write the note, and talks to the new one.
- **Ask:** `claude --resume <id> "<ask>"` or `codex resume <id> "<ask>"`: please write
  `HANDOFF-<name>.md` in this folder, do not commit it, then stop.
- **Start:** `claude --name <name> "<start>"` or `codex "<start>"`: you take over from the last
  session with this name, read the note first, then say you are ready. Claude Code names the
  session from `--name`; Codex has no such option, so the person types `/rename <name>`.
- **The same one-writer checks as Open in PowerShell**, plus: a live background session is not
  asked (the message could land in a running turn), and a new Claude Code session waits until the
  old one has closed, because Claude Code renames a new session while one with that name runs.
  A thread the Codex app holds is asked there: the page has a Copy button for each message.
- **Off by default**, Windows only, this computer only, with Open in PowerShell's limits, and the
  name the page showed must still be the session's name.

What it does not do: it never archives, pins or closes the old session (the person does that in
the app), never reads the note, and keeps no action log: the window and the session's own file
show what was sent.

## New agent (built)

Step 4, without a first message. A session's side panel has **New agent here…**: the person picks
Claude Code or Codex and types a name, and Pleni opens a PowerShell window in that session's folder
that runs `claude --name <name>` or `codex`. The person types the first message there, so Pleni
sends nothing and the rule about free text does not come up.

- The folder comes from the session on the map, on the server, so the page never sends a path.
- The name follows Roll over's name rule, and a name a Claude Code or Codex tile on the map already
  has is refused: the relay and chain rules find agents by name.
- Codex cannot take a name when it starts, so the page shows `/rename <name>` to type after the
  first message.
- Off by default, Windows only, this computer only, with Open in PowerShell's limits.

A first message typed in Pleni would be free text, like Send (step 3), so it is not built: the
person types it in the window.

## Step 3: Send a message (built)

First set aside, then asked for by the owner in October 2026: with no Codex or Claude app running,
the person still wants to type to a session from Pleni. Send is free text: whatever the person types
goes to a session that can run commands. So it came with the owner's yes and a change to the rule
in `CLAUDE.md` and `AGENTS.md`. What was built differs from the design below in a few places: the
tab is called Chat; Claude Code's turn uses `--output-format json` (one answer at the end, so a
Pleni that stops mid-turn does not cut the turn short) and `--permission-mode dontAsk` for "read and
answer"; Codex's output is not read at all (its exit code tells how the turn ended); and the record
is `sent.jsonl`. The answers to the three questions below: yes; "read and answer" by default, with a
setting for "also change files"; and this computer only. `docs/architecture.md` describes it.

**What the person sees.** A session's side panel gets a **Chat** tab: the last messages between the
person and the session (Pleni already reads them, as short snippets when `content` is `snippets`),
and a message box with **Send**. The box is on only when sending is safe; otherwise it says why
("This session is open in the Claude app. Send it there."). After Send, the tile turns Working, and
the reply shows in the chat as Pleni reads it from the session's file, like any other turn.

**How it works: no window, and no shell.**

- For each message, Pleni starts the tool once, hidden, in the session's folder:
  - Claude Code: `claude -p --resume <id> --output-format stream-json --verbose`
  - Codex: `codex exec --json resume <id> -`
- **The message never goes on a command line.** Pleni writes it to the program's standard input
  (`-p` reads its prompt there, and Codex reads it when the prompt is `-`). Only fixed words and the
  checked session id are on the command line, so no shell can read the message as a command,
  whatever it says.
- Pleni reads the program's JSON lines only to learn when the turn ends and whether it failed. It
  keeps no copy of the message: the session's own file has it.
- **One writer.** The same checks as Roll over's ask step: not working, not open in a window, not
  held by the Claude desktop app, VS Code or the Codex app, and no live background turn. While the
  turn runs, its command line holds the session id, so the mailbox relay waits too.
- **Limits.** One turn at a time per session, a few sends a minute in all, at most 8,000 characters
  per message, and Send is off while Pleni waits for the last turn to end.
- **Off by default,** turned on in Settings → Buttons, Windows first (the same `claude` and
  `codex` commands the windows use), this computer only.

**What a sent turn may do.** A hidden turn cannot ask the person anything, so this needs a choice:

| Choice | Claude Code | Codex |
| --- | --- | --- |
| A. Read and answer (safest) | default `-p` mode: anything that would ask is refused | `--sandbox read-only` |
| B. Also edit files in its folder | `--permission-mode acceptEdits` (the relay uses this for the coordinator) | `--sandbox workspace-write` |

Commands that the session's own settings do not allow stay refused in both. Full access is not
offered.

**Questions for the owner:**

1. May Pleni start a hidden `claude -p --resume` or `codex exec resume` turn with the message you
   typed, sent on its standard input? (This changes the read-only rule.)
2. Which should be the default: A (read and answer) or B (also edit files)? Recommended: a setting
   with A as the default, and B for teams that want Pleni to hand out work.
3. Only on this computer at first? Recommended: yes. Sending from the phone needs step 8 (a second
   confirmation) first.

Before building, the spare-computer test (step 2) checks that `claude -p --resume <id>` reads its
prompt from standard input on Windows, and what `-p` does with a session that has a running
background turn.

## Claude Code

### Answering questions, plans and permission prompts: hooks

Claude Code runs **hooks** before tools are used, and a hook may be an HTTP call that waits for an
answer (up to 10 minutes by default, configurable). Hooks set in the user's Claude settings also
apply to the Claude desktop app.

- **Questions.** A `PreToolUse` hook on `AskUserQuestion` returns
  `permissionDecision: "allow"` with `updatedInput` holding the answers, for example
  `{ "questions": [...], "answers": { "Which framework?": "React" } }`.
- **Plans.** A `PermissionRequest` hook on `ExitPlanMode` approves a plan with
  `"decision": { "behavior": "allow", "updatedInput": <the input it was given> }`. Without the input
  handed back, Claude Code 2.1.307 ignores the yes. `"deny"` with a message keeps it planning.
- **Permission prompts.** A `PermissionRequest` hook returns
  `{ "hookSpecificOutput": { "hookEventName": "PermissionRequest", "decision": { "behavior": "allow" } } }`
  or `"deny"` with a message.
- **If Pleni is not running**, the hook call fails: Claude Code shows a short "hook error" line,
  and the normal question or prompt appears in the app. That is the safe default.
- **Tested** (2026-10-22) with Claude Code 2.1.307 on Linux, in a real terminal window and with
  `claude -p`, against a stand-in for the model: all of the above works. A question waits in Pleni
  only; a plan or a prompt shows in the window too, and Claude Code does not tell the hook when it
  is answered there. In `claude -p`, Claude Code turns questions and plans off, and in "don't ask"
  mode it refuses prompts without calling the hook.

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

Each send starts a paid turn on the user's plan. As built, a sent turn runs in "don't ask" mode
("Read files and answer": anything that would need a yes is refused) or "accept edits" mode ("Also
change files in its folder"), and only in the second do its permission prompts reach Pleni's hook.

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

| Step | What | Size | State |
| --- | --- | --- | --- |
| 1 | The relay wakes the planner's Codex thread (above) | Medium, outside Pleni | Built |
| 2 | Tests on a spare computer: Claude hooks in the desktop app (HTTP hooks, secret header, what the app shows while a hook waits, the `ExitPlanMode` answer format), and the Codex app server questions above | Small | Claude Code's hooks tested with Claude Code 2.1.307 in a terminal window (see above); the desktop app and the Codex checks are still to do |
| 3 | Send a message to idle sessions, Claude and Codex, with the safety checks | Medium | Built (`src/send.js`, the Chat tab) |
| 4 | **New agent:** choose Claude Code or Codex and a name; Pleni opens it in a PowerShell window in the folder of a session on the map, the same way as Open in PowerShell. The first message is typed there | Medium | Built |
| 5 | Claude questions, plans and permission prompts through hooks, with the "Connect" step, the switch per session, and the answer controls | Large | Built (`src/answers.js`), this computer only, and tested end to end with Claude Code 2.1.307; the desktop-app check of step 2 is still to do |
| 6 | Codex answers and messages through the app server, with `codex exec resume` as the fallback | Large, depends on step 2 | |
| 7 | Move other Codex threads from app messaging to mailboxes, each with a wake (a relay) | Large, per team | Built: agent mail and its wakes in the relay, and Pleni shows the mail |
| 8 | Actions from the phone: second confirmation | Medium | |
| 9 | Mailbox owner notes, with the relay change | Small, outside Pleni | |

Step 4 works alone, so Pleni can start agents before it can answer questions.

## Sources

- Claude Code docs: hooks (`PreToolUse`, `PermissionRequest`, HTTP hooks), sessions and headless
  mode (`--resume`), the desktop app, Remote Control and channels, at
  <https://code.claude.com/docs/en/>.
- Codex CLI 0.162 help for `codex exec resume`, `codex app-server` and `codex agents`, and the
  schema from `codex app-server generate-json-schema`.
- Codex goals: <https://developers.openai.com/cookbook/examples/codex/using_goals_in_codex>.
- Which tools need the Codex app: a check of the installed Codex app plugin on a real setup,
  October 2026.
