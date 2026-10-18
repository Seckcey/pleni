# The mailbox relay

The relay is a small Windows program. It helps AI sessions work as a team through a folder of
Markdown files, called the **mailbox**:

- A **planner** (a Codex session) hands out tasks, answers questions, and reviews the work.
- A **coordinator** (a Claude Code session) takes each task. It starts **worker** sessions to do
  the work, checks what they did, and reports back.

Neither session watches the folder on its own. The relay does. When the planner writes a new task,
an answer, or a review, the relay wakes the coordinator's saved Claude Code session with a short
note. When a worker finishes, the relay tells the coordinator. It also keeps a list of what waits
for the planner, in `.relay\codex-attention.md`. If you turn it on, the relay wakes the planner's
Codex thread too, once for each new item on that list. Then the planner and the coordinator keep
each other going without the Codex app.

Other agents can talk too, with **agent mail**: one agent sends another a message by name, and the
relay wakes the agent that gets it. This does the job of the Codex app's messages between threads,
so a whole team can run with the app closed (see [Agent mail](#agent-mail-optional)).

Pleni shows all of this on its map: planner → relay → coordinator → workers. To see it, turn on
the mailbox in Pleni's **Settings** and choose the mailbox folder.

**The relay is separate from Pleni.** Pleni only reads files. The relay writes into the mailbox
and starts Claude Code sessions. Pleni never runs the relay, and the relay is not part of the
`pleni` npm package. To use it, get it from this repository.

Made by 8 West Ventures, LLC.

## What you need

- Windows, with Windows PowerShell 5.1. It comes with Windows.
- Claude Code, signed in with a Claude subscription (run `claude auth login`). The relay uses
  that login. It never uses an API key, so it never bills an API account.
- Codex, for the planner. The Codex wake (optional, see below) also needs the Codex command line,
  `codex`, signed in with ChatGPT.
- Node.js, only to run the relay's test.

## What is in this folder

| Path                                | What it is                                                                     |
| ----------------------------------- | ------------------------------------------------------------------------------ |
| `bin\bridge-relay.ps1`              | The relay.                                                                     |
| `bin\spawn-worker.ps1`              | Starts one worker session. The coordinator runs it.                            |
| `bin\agent-mail.ps1`                | Agent mail: agents send each other messages by name, and read their own.       |
| `bin\bridge-relay-check.ps1`        | The relay's test. It uses fake mailboxes and a fake Claude, so it costs nothing. |
| `bin\relay-settings.example.json`   | An example of the settings file.                                               |
| `bin\cost-limits.example.json`      | An example of the cost settings file.                                          |
| `tests\stub-claude.js`              | The fake Claude that the test uses.                                            |
| `tests\stub-codex.js`               | The fake Codex that the test uses.                                             |
| `templates\`                        | Blank task files: assignment, status, questions, answers, handoff, review, and a worker's brief and report. |
| `PROTOCOL.md`                       | The rules everyone follows. In a mailbox it is called `README.md`.             |
| `COORDINATOR.md`                    | Standing orders for the coordinator. In a mailbox it is called `CLAUDE.md`.     |

The scripts expect to live in the mailbox's `bin` folder. The relay treats the folder above `bin`
as the mailbox.

## Set up a new mailbox

Run these lines in PowerShell. Change the first two lines to your own folders.

```powershell
$repo = 'C:\Users\ada\pleni'     # where you cloned this repository
$mb   = 'C:\Users\ada\mailbox'   # the new mailbox folder
New-Item -ItemType Directory -Force "$mb\tasks" | Out-Null
Copy-Item -Recurse "$repo\relay\bin", "$repo\relay\tests", "$repo\relay\templates" $mb
Copy-Item "$repo\relay\PROTOCOL.md" "$mb\README.md"
Copy-Item "$repo\relay\COORDINATOR.md" "$mb\CLAUDE.md"
Copy-Item "$mb\bin\relay-settings.example.json" "$mb\bin\relay-settings.json"
Set-Content "$mb\CODEX-QUEUE.md" '# Codex queue (owner: Codex)'
Set-Content "$mb\STATUS.md" '# Status board (owner: Claude)'
notepad "$mb\bin\relay-settings.json"
```

In Notepad, put in your own folders and name, then save. The next part explains each setting.

## Settings

Both settings files live in the mailbox's `bin` folder, on your computer only. This repository
has just the examples. The relay reads them when it starts.

`bin\relay-settings.json`:

| Setting         | What it does                                                                                                    |
| --------------- | --------------------------------------------------------------------------------------------------------------- |
| `projects_dir`  | The folder that holds your code repositories. The coordinator may read it.                                      |
| `worktrees_dir` | The folder where workers work. A worker starts only inside it. Leave it out to use `<projects_dir>\_worktrees\claude`. |
| `owner_name`    | Your name, for the relay's notes: "Any other command needs Ada", and the tag `NEEDS-ADA`. Leave it out and they say "the owner" and `NEEDS-OWNER`. |
| `codex_exe`     | Only for the Codex wake: the full path of the Codex command. Leave it out to use `codex` from your PATH. |
| `codex_exec_args` | Only for the Codex wake: extra options for `codex exec`, one per entry, such as `["--sandbox", "workspace-write"]`. Options that turn the sandbox off are refused. |

`bin\cost-limits.json` (if there is no such file, the limits are on):

| Setting                   | What it does                                                                                       |
| ------------------------- | -------------------------------------------------------------------------------------------------- |
| `enabled`                 | `true`: each run has a dollar cap, and the relay has a daily cap. `false`: no caps. Costs are written down either way. |
| `relay_max_wakes_per_day` | How many times a day the relay may wake the coordinator. The usual number is 12. `0` means no limit. |
| `relay_max_codex_wakes_per_day` | How many times a day the relay may wake the planner's Codex thread. The usual number is 12. `0` means no limit. |
| `relay_max_agent_wakes_per_day` | How many times a day the relay may wake each agent for its mail. The usual number is 12. `0` means no limit. |
| `relay_max_agent_turns_at_once` | How many agents the relay may wake for mail at the same time, 1 to 10. The usual number is 3. |

A "worktree" is a second working folder of a Git repository, on its own branch. Each task gets
one, so workers never touch your main folder.

## Start the relay

Run these in the mailbox folder.

1. Check the setup. Neither command changes anything.

   ```powershell
   .\bin\bridge-relay.ps1 -Status
   .\bin\bridge-relay.ps1 -DryRun
   ```

2. Tell the relay which Claude Code session is the coordinator. Do this once, in one of two ways:

   - **By name.** This is best if you start a fresh coordinator session often (see
     [Roll sessions over](#roll-sessions-over)). Give the session a name: in Claude Code, type
     `/rename Sergeant` in it, or rename it in the Claude desktop app. Then run:

     ```powershell
     .\bin\bridge-relay.ps1 -Enroll -SessionName 'Sergeant'
     ```

   - **By id.** Close that session first, then run:

     ```powershell
     .\bin\bridge-relay.ps1 -Enroll -SessionId <the coordinator's session id>
     ```

3. Start it, and keep the window open:

   ```powershell
   .\bin\bridge-relay.ps1 -Start
   ```

| Command               | What it does                                                                                   |
| --------------------- | ---------------------------------------------------------------------------------------------- |
| `-Status`             | Shows whether the relay runs, the enrolled session, whether a window has it open, what waits, and today's turns and costs. |
| `-DryRun`             | Shows what the relay would do now. It starts nothing and writes nothing.                       |
| `-Once`               | Does one round, then stops.                                                                    |
| `-Start`              | Keeps running and watches the mailbox. Stop it with `-Stop` from another window, or Ctrl+C.    |
| `-Stop`               | Asks a running relay to stop. A coordinator turn that is running is never cut off.             |
| `-ClearHalt`          | Starts sending again after the relay stopped itself because of repeated errors. Fix the cause first. |
| `-ShowCoordinatorArgs`| Shows the commands the coordinator may and may not run. It changes nothing.                    |
| `-EnrollCodex -ThreadId <id>` | Turns on the Codex wake for that Codex thread. See below.                        |
| `-EnrollCodex -ThreadName <name>` | The same, for the newest Codex thread with that name. See below.             |
| `-UnenrollCodex`      | Turns the Codex wake off again.                                                                |
| `-EnrollAgent -AgentName <name>` | Wakes that agent's Codex thread when mail waits for it. See [Agent mail](#agent-mail-optional). |
| `-UnenrollAgent -AgentName <name>` | Stops waking that agent for its mail.                                              |

To pause sending without stopping the relay, create an empty file named `PAUSE` in `.relay`.
Delete it to go on. Nothing is lost while paused: notes wait in a queue.

## Wake the planner too (optional)

The planner is a Codex thread. Today the Codex app wakes it: other threads message it there. If
you quit the Codex app, nothing wakes it, and the coordinator's answers wait in the mailbox. The
relay can do that job instead.

1. Pick the thread by name or by id:
   - **By name,** if you start a fresh planner thread now and then: use the thread's name in Codex,
     for example `Planner`. The relay then follows that name (see
     [Roll sessions over](#roll-sessions-over)).
   - **By id:** in Pleni, click the planner's tile and open **Details**. The **Key** line reads
     `codex:<thread id>`. The id is the part after `codex:`.
2. Turn the Codex wake on, in the mailbox folder. If the relay runs, stop it first and start it
   again after:

   ```powershell
   .\bin\bridge-relay.ps1 -Stop
   .\bin\bridge-relay.ps1 -EnrollCodex -ThreadName 'Planner'
   .\bin\bridge-relay.ps1 -Start
   ```

   By id, the middle line is `.\bin\bridge-relay.ps1 -EnrollCodex -ThreadId <the planner's thread id>`.

   The relay finds the thread in your Codex folder and reads the folder the thread works in. This
   wakes nothing yet: what already waits for the planner counts as known.
3. Check it. `-Status` shows `CodexWake: ON`, and `-DryRun` shows the command it would run once
   there is something new.

From then on, each new item in `.relay\codex-attention.md` (a question that blocks the coordinator,
or a handoff ready for review) wakes the planner's thread once, with:

```
codex exec --json --skip-git-repo-check resume <thread id> "<a short note>"
```

It runs in the thread's own folder, and it uses your ChatGPT sign-in, never an API key.

- **The Codex app comes first.** While the Codex app has the thread open, the relay waits. The app
  keeps every thread you opened in it until you quit the app fully. Quit it, and the relay takes
  over.
- **One place at a time.** The relay also waits while a window has the thread open
  (`codex resume <id>`), while a coordinator turn runs, and while its own last Codex turn runs.
- **What the planner may change** is set by your Codex settings. `codex exec` is read-only unless
  your settings say otherwise. To let a planner turn write, set `codex_exec_args` in
  `bin\relay-settings.json`. `["--sandbox", "workspace-write"]` lets it write inside the thread's
  folder. If the mailbox is in another folder, add that folder too:
  `["--sandbox", "workspace-write", "--add-dir", "C:\\Users\\ada\\mailbox"]`.
- **Errors:** after 3 failed Codex turns in a row, the relay stops waking Codex and writes an alert.
  Claude wakes go on. Fix the cause, then run `-ClearHalt`.
- **To turn it off:** `.\bin\bridge-relay.ps1 -UnenrollCodex`.

## Agent mail (optional)

In the Codex app, agents talk with the app's tools: the Colonel sends a Sergeant a message, and the
Sergeant wakes up and answers. Those tools stop working when you quit the app. Agent mail does the
same job with files in the mailbox and with the relay:

- An agent sends a message by name, for example
  `agent-mail.ps1 -Send -From 'Colonel' -To 'Sergeant Lark' -Text 'Start T-12.'`. It waits in
  `mail\sergeant-lark\new`.
- If the relay wakes that agent (step 2 below), it resumes the agent's Codex thread with a short
  note, the same way it wakes the planner. The agent reads its mail with `-Read`, does the work, and
  answers with `-Send`.
- An agent whose window is open reads its own mail. In a long task (a Codex goal) it runs
  `agent-mail.ps1 -Wait -Me '<its name>' -Seconds 50` where it used the app's `wait_threads`. The
  relay never wakes a thread that a window has open.

### Set it up

1. Update the relay in your mailbox (see [Update the relay in a mailbox](#update-the-relay-in-a-mailbox)).
   That copies `agent-mail.ps1` too.
2. Tell the relay which agents to wake, by the names their Codex threads have. Stop the relay
   first, and start it again after:

   ```powershell
   .\bin\bridge-relay.ps1 -Stop
   .\bin\bridge-relay.ps1 -EnrollAgent -AgentName 'Sergeant Lark'
   .\bin\bridge-relay.ps1 -EnrollAgent -AgentName 'Sergeant Wren'
   .\bin\bridge-relay.ps1 -Start
   ```

   The relay finds the newest Codex thread with that name, and follows the name the same way as the
   planner wake (see [Roll sessions over](#roll-sessions-over)). Enrolling wakes nothing: mail that
   already waits counts as known, and the agent sees it the next time it reads its mail.
3. Let a woken agent write. A woken turn uses `codex exec`, which is read-only unless
   `codex_exec_args` in `bin\relay-settings.json` says otherwise. Reading and sending mail writes in
   the mailbox, so allow the mailbox folder:
   `["--sandbox", "workspace-write", "--add-dir", "C:\\Users\\ada\\mailbox"]`.
4. Tell your agents. Each one needs to know its own name, the names of the others, and to use agent
   mail instead of the app's thread tools (`send_message_to_thread`, `wait_threads`).

### What the relay does

- It wakes an enrolled agent once for its new mail, but only while no program has the agent's
  thread open: not the Codex app, not a `codex resume` window, not another relay turn. While the
  Codex app has the thread open, the relay waits. Quit the app fully to hand the thread over.
- One turn at a time for each agent, and at most 3 agents at once
  (`relay_max_agent_turns_at_once` in `bin\cost-limits.json`).
- Up to 12 wakes a day for each agent (`relay_max_agent_wakes_per_day`).
- After 3 failed turns in a row, it stops waking that agent and writes an alert. Other wakes go on.
  Fix the cause, then run `-ClearHalt`.
- `-Status` lists the agents, how much new mail waits for each, and whether a window has one open.
- It never moves or deletes a message. The agents do that with `agent-mail.ps1`.

### Agent mail commands

Run them in the mailbox folder: `.\bin\agent-mail.ps1 <command>`. Names compare without case and
extra spaces, so `sergeant lark` is Sergeant Lark.

| Command                                         | What it does                                                                   |
| ----------------------------------------------- | ------------------------------------------------------------------------------ |
| `-Send -From <name> -To <name> -Text <text>`    | Sends a message. For several agents, separate the names with commas. For a long message, use `-TextFile <file>` (64 KB at most). A name that has no mail yet needs `-NewAgent` once, so a typo does not send mail nowhere. |
| `-Read -Me <name>`                              | Prints the new mail, oldest first and 10 at a time, and moves it to `read`.    |
| `-Wait -Me <name> -Seconds <n>`                 | Waits up to n seconds (50 if you leave it out) for new mail, then reads it.    |
| `-List`                                         | Shows each agent, how much new mail waits, and whether the relay wakes it.      |

You can use it too. To send the Colonel a note:
`.\bin\agent-mail.ps1 -Send -From 'Ada' -To 'Colonel' -Text 'Please pause the website work.'`
Mail to you waits in `mail\<your name>\new`; read it with `-Read -Me '<your name>'`. Put the same
name in `owner_name` in `bin\relay-settings.json`, so Pleni knows that this mail is yours.

Read messages stay in each agent's `read` folder. You may delete old ones whenever you like.

### What Pleni shows

With the mailbox turned on in Pleni, Pleni reads the `mail` folder too. It never sends mail.

- A line lights up between two tiles when mail goes from one to the other, and the Activity view
  lists each message: "Colonel sent mail to Sergeant Lark".
- A tile with mail waiting says "2 new messages" on its bottom edge. Click it to see since when, and
  whether the relay wakes it for its mail.
- Mail for you shows under **Needs you**. Your own side panel gives the command to read it, and the
  sender's side panel also gives the command to answer it.
- Pleni matches a mail name to a tile by the Codex thread the relay wakes for it, else by the
  session's name. Mail for `owner_name`, for `Owner`, or for your name in Pleni's Settings is yours.

## Roll sessions over

Starting a fresh session now and then keeps each turn small and cheap. If you enrolled by name
(`-Enroll -SessionName`, `-EnrollCodex -ThreadName`), the relay follows the name. Give the new
session the same name, and the relay switches to it on its own. You type no ids and run no
commands.

- **Which session:** the newest one with that name. For the coordinator, only Claude Code sessions
  of its working folder count. For the planner, only live Codex threads count, not archived ones.
  Case, extra spaces, and marks around the name (like `**`) do not matter.
- **Newest means started last.** Using an old session again never takes the name back. The relay
  only moves on to a session that started after the one it wakes now.
- **Between turns.** The relay switches only when no turn runs. A new coordinator session that is
  still open in a window gets its first turn after you close it.
- **Windows it did not start.** The relay waits while any Claude Code window has the coordinator
  open: one opened with `claude --resume <id>`, and also one started another way, such as
  `claude --name <name>` or Pleni's Roll over button. It finds those in Claude Code's own list of
  running sessions (`sessions\<number>.json` in the Claude Code folder). So you can keep a new
  coordinator's window open to watch it; the relay keeps its messages until you close it.
- **What stays:** model, effort and allowed checks carry over to the new coordinator session. A new
  planner thread runs in its own folder.
- **To check:** `-Status` shows the name each one follows and the last switch, and `relay.log` has
  a `Rollover:` line for each switch.

To give the new session the same name:

- **Claude Code:** type `/rename <name>` in the session, or rename it in the Claude desktop app.
- **Codex:** rename the thread in Codex.

If you enrolled by id (`-SessionId`, `-ThreadId`), the relay never switches. Run `-Enroll` or
`-EnrollCodex` again after each new session.

## Update the relay in a mailbox

1. Stop the relay: `.\bin\bridge-relay.ps1 -Stop`.
2. Get the new version. In your Pleni folder, run `git pull`.
3. Copy the scripts into the mailbox (change the two folders to yours):

   ```powershell
   $repo = 'C:\Users\ada\pleni'
   $mb   = 'C:\Users\ada\mailbox'
   Copy-Item -Force "$repo\relay\bin\*.ps1" "$mb\bin\"
   Copy-Item -Force "$repo\relay\tests\stub-*.js" "$mb\tests\"
   ```

4. Start it again: `.\bin\bridge-relay.ps1 -Start`.

This copies only the scripts. Your settings files, your templates, and the coordinator's files stay
as they are.

## Test it

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File bin\bridge-relay-check.ps1
```

It takes 4 to 7 minutes. It builds fake mailboxes in your temp folder, runs the relay and agent
mail against them with a fake Claude and a fake Codex, and removes them at the end. It never touches a real mailbox or a real session,
and it costs nothing. Each pull request to this repository runs it on Windows too.

## Safety

The relay:

- wakes only the sessions you enrolled: the coordinator, the planner, and the agents you enrolled
  for mail, with one turn at a time for each;
- wakes a Codex thread only if you enrolled it, never while another program has it open, and never
  with an option that turns the Codex sandbox off;
- never wakes a session that looks open in another window, and never stops or kills a process;
- keeps its own notes only in the mailbox's `.relay` folder, with no secrets and no copies of the
  conversation;
- installs nothing: no service, no scheduled task, and no registry entry;
- gives each coordinator turn a fixed list of commands it may run, and a list it may not. The
  coordinator may not change the relay's own files, and a worker may not push or merge. These
  lists are a guard, not a sealed box, so keep an eye on what the sessions do.

## Costs

Each coordinator turn and each worker run uses your Claude plan. The relay writes the cost the
Claude Code command reports into `.relay\dispatches.md` and each task's `workers\runs.md`. These
numbers are estimates from Claude Code, not bills.

Each planner turn and each agent turn the relay starts uses your ChatGPT plan. It gets a line in
`.relay\dispatches.md` too, without a cost, because Codex does not report one.
