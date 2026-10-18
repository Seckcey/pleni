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

A "worktree" is a second working folder of a Git repository, on its own branch. Each task gets
one, so workers never touch your main folder.

## Start the relay

Run these in the mailbox folder.

1. Check the setup. Neither command changes anything.

   ```powershell
   .\bin\bridge-relay.ps1 -Status
   .\bin\bridge-relay.ps1 -DryRun
   ```

2. Tell the relay which Claude Code session is the coordinator. Do this once. Close that session
   first, then run:

   ```powershell
   .\bin\bridge-relay.ps1 -Enroll -SessionId <the coordinator's session id>
   ```

3. Start it, and keep the window open:

   ```powershell
   .\bin\bridge-relay.ps1 -Start
   ```

| Command               | What it does                                                                                   |
| --------------------- | ---------------------------------------------------------------------------------------------- |
| `-Status`             | Shows whether the relay runs, the enrolled session, what waits, and today's turns and costs.   |
| `-DryRun`             | Shows what the relay would do now. It starts nothing and writes nothing.                       |
| `-Once`               | Does one round, then stops.                                                                    |
| `-Start`              | Keeps running and watches the mailbox. Stop it with `-Stop` from another window, or Ctrl+C.    |
| `-Stop`               | Asks a running relay to stop. A coordinator turn that is running is never cut off.             |
| `-ClearHalt`          | Starts sending again after the relay stopped itself because of repeated errors. Fix the cause first. |
| `-ShowCoordinatorArgs`| Shows the commands the coordinator may and may not run. It changes nothing.                    |
| `-EnrollCodex -ThreadId <id>` | Turns on the Codex wake for that Codex thread. See below.                        |
| `-UnenrollCodex`      | Turns the Codex wake off again.                                                                |

To pause sending without stopping the relay, create an empty file named `PAUSE` in `.relay`.
Delete it to go on. Nothing is lost while paused: notes wait in a queue.

## Wake the planner too (optional)

The planner is a Codex thread. Today the Codex app wakes it: other threads message it there. If
you quit the Codex app, nothing wakes it, and the coordinator's answers wait in the mailbox. The
relay can do that job instead.

1. Find the planner's thread id. In Pleni, click the planner's tile and open **Details**. The
   **Key** line reads `codex:<thread id>`. The id is the part after `codex:`.
2. Turn the Codex wake on, in the mailbox folder. If the relay runs, stop it first and start it
   again after:

   ```powershell
   .\bin\bridge-relay.ps1 -Stop
   .\bin\bridge-relay.ps1 -EnrollCodex -ThreadId <the planner's thread id>
   .\bin\bridge-relay.ps1 -Start
   ```

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
- **What the planner may change** is set by your Codex settings. If a planner turn says it cannot
  write to the mailbox, give it write access with `codex_exec_args` in `bin\relay-settings.json`,
  for example `["--sandbox", "workspace-write"]`. That lets Codex write inside the thread's folder.
- **Errors:** after 3 failed Codex turns in a row, the relay stops waking Codex and writes an alert.
  Claude wakes go on. Fix the cause, then run `-ClearHalt`.
- **To turn it off:** `.\bin\bridge-relay.ps1 -UnenrollCodex`.

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

It takes 3 to 5 minutes. It builds fake mailboxes in your temp folder, runs the relay against them
with a fake Claude and a fake Codex, and removes them at the end. It never touches a real mailbox or a real session,
and it costs nothing. Each pull request to this repository runs it on Windows too.

## Safety

The relay:

- wakes only the one session you enrolled, and only one turn at a time;
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

Each planner turn the relay starts uses your ChatGPT plan. It gets a line in `.relay\dispatches.md`
too, without a cost, because Codex does not report one.
