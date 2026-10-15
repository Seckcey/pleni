# The mailbox relay

The relay is a small Windows program. It helps AI sessions work as a team through a folder of
Markdown files, called the **mailbox**:

- A **planner** (a Codex session) hands out tasks, answers questions, and reviews the work.
- A **coordinator** (a Claude Code session) takes each task. It starts **worker** sessions to do
  the work, checks what they did, and reports back.

Neither session watches the folder on its own. The relay does. When the planner writes a new task,
an answer, or a review, the relay wakes the coordinator's saved Claude Code session with a short
note. When a worker finishes, the relay tells the coordinator. It also keeps a list of what waits
for the planner, in `.relay\codex-attention.md`. It never wakes the planner.

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
- Codex, for the planner.
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

`bin\cost-limits.json` (if there is no such file, the limits are on):

| Setting                   | What it does                                                                                       |
| ------------------------- | -------------------------------------------------------------------------------------------------- |
| `enabled`                 | `true`: each run has a dollar cap, and the relay has a daily cap. `false`: no caps. Costs are written down either way. |
| `relay_max_wakes_per_day` | How many times a day the relay may wake the coordinator. The usual number is 12. `0` means no limit. |

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

To pause sending without stopping the relay, create an empty file named `PAUSE` in `.relay`.
Delete it to go on. Nothing is lost while paused: notes wait in a queue.

## Update the relay in a mailbox

1. Stop the relay: `.\bin\bridge-relay.ps1 -Stop`.
2. Get the new version. In your Pleni folder, run `git pull`.
3. Copy the scripts into the mailbox (change the two folders to yours):

   ```powershell
   $repo = 'C:\Users\ada\pleni'
   $mb   = 'C:\Users\ada\mailbox'
   Copy-Item -Force "$repo\relay\bin\*.ps1" "$mb\bin\"
   Copy-Item -Force "$repo\relay\tests\stub-claude.js" "$mb\tests\"
   ```

4. Start it again: `.\bin\bridge-relay.ps1 -Start`.

This copies only the scripts. Your settings files, your templates, and the coordinator's files stay
as they are.

## Test it

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File bin\bridge-relay-check.ps1
```

It takes 2 to 4 minutes. It builds fake mailboxes in your temp folder, runs the relay against them
with a fake Claude, and removes them at the end. It never touches a real mailbox or a real session,
and it costs nothing. Each pull request to this repository runs it on Windows too.

## Safety

The relay:

- wakes only the one session you enrolled, and only one turn at a time;
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
