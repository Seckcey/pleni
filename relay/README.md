# The mailbox relay

The relay is a small Windows program. It helps AI sessions work as a team through a folder of
Markdown files, called the **mailbox**:

- A **planner** (a Codex session) hands out tasks, answers questions, and reviews the work.
- A **coordinator** takes each task. It is a Claude Code session, a Codex thread or a Gemini CLI
  session. You pick which one when you sign it up (see
  [A coordinator in Codex or Gemini CLI](#a-coordinator-in-codex-or-gemini-cli-optional)). It starts
  **worker** sessions to do the work, checks what they did, and reports back.

Neither session watches the folder on its own. The relay does. When the planner writes a new task,
an answer, or a review, the relay wakes the coordinator's saved session with a short
note. When a worker finishes, the relay tells the coordinator. It also keeps a list of what waits
for the planner, in `.relay\codex-attention.md`. If you turn it on, the relay wakes the planner's
Codex thread too, once for each new item on that list. Then the planner and the coordinator keep
each other going without the Codex app. Agents can write to the planner too (see
[Mail for the planner](#mail-for-the-planner)).

Other agents can talk too, with **agent mail**: one agent sends another a message by name, and the
relay wakes the agent that gets it. An agent can be a Claude Code session, a Codex thread or a
Gemini CLI session. This does the job of the Codex app's messages between threads, so a whole
team can run with the app closed (see [Agent mail](#agent-mail-optional) and
[Agents in any AI tool](#agents-in-any-ai-tool)). If you allow it, the planner can also ask for a
new agent (see [New agents](#new-agents)).

Pleni shows all of this on its map: planner -> relay -> coordinator -> workers. To see it, turn on
the mailbox in Pleni's **Settings** and choose the mailbox folder.

**The relay is separate from Pleni.** Pleni only reads files. The relay writes into the mailbox
and starts AI tool sessions (Claude Code, Codex or Gemini CLI). Pleni never runs the relay, and the
relay is not part of the `pleni` npm package. To use it, get it from this repository.

Made by 8 West Ventures, LLC.

## What you need

- Windows, with Windows PowerShell 5.1. It comes with Windows.
- Claude Code, signed in with a Claude subscription (run `claude auth login`). The relay uses
  that login. It never uses an API key (a secret code that bills you for each use), so it never
  bills an API account.
- Codex, for the planner. The Codex wake (optional, see below) also needs the Codex command line,
  `codex`, signed in with ChatGPT.
- Only for workers in Codex or Gemini (optional, see [Workers in Codex or Gemini](#workers-in-codex-or-gemini-optional)):
  the `codex` command line signed in with ChatGPT, or Gemini CLI with a paid plan, and Git. The Codex
  command line must be from April 2026 or newer. An older one stops with an "update Codex" message.
- Only for a coordinator in Codex or Gemini CLI (optional, see
  [A coordinator in Codex or Gemini CLI](#a-coordinator-in-codex-or-gemini-cli-optional)):
  - For Codex: the `codex` command line from April 2026 or newer, signed in with ChatGPT. Set up
    Codex's Windows sandbox first. A sandbox is a locked box that limits what a program may touch.
  - For Gemini CLI: a paid API key, Vertex AI (Google's paid cloud service) or a work license.
- Only for workers in Antigravity CLI (off by default, see [Antigravity workers](#antigravity-workers-off-by-default)):
  Antigravity CLI (`agy`) signed in, and Git. Read that part first: Google's consumer terms may not
  allow it, and your Google account could be suspended or closed.
- Only for agents (optional, see [Agents in any AI tool](#agents-in-any-ai-tool)): for Claude Code
  agents, the same Claude login. For Gemini CLI agents, a paid API key, Vertex AI or a work license.
  For Codex agents with a profile, the `codex` command line from April 2026 or newer and Codex's
  Windows sandbox. For Claude Code and Gemini CLI agents, a mailbox path with only letters, digits
  and `. _ - ~`.
- Node.js and Git, only to run the relay's test.

## What is in this folder

| Path                                | What it is                                                                     |
| ----------------------------------- | ------------------------------------------------------------------------------ |
| `bin\bridge-relay.ps1`              | The relay.                                                                     |
| `bin\spawn-worker.ps1`              | Starts one worker session. The coordinator runs it.                            |
| `bin\agent-mail.ps1`                | Agent mail: agents send each other messages by name, and read their own.       |
| `bin\bridge-relay-check.ps1`        | The relay's test. It uses fake mailboxes and a fake Claude, so it costs nothing. |
| `bin\relay-settings.example.json`   | An example of the settings file.                                               |
| `bin\relay-settings.hq.example.json` | An example of the settings file for HQ (see [Run several projects](#run-several-projects-hq)). |
| `bin\cost-limits.example.json`      | An example of the cost settings file.                                          |
| `tests\stub-claude.js`              | The fake Claude that the test uses.                                            |
| `tests\stub-codex.js`               | The fake Codex that the test uses.                                             |
| `tests\stub-gemini.js`              | The fake Gemini CLI that the test uses.                                        |
| `tests\stub-agy.js`                 | The fake Antigravity CLI that the test uses.                                   |
| `templates\`                        | Blank task files: assignment, status, questions, answers, handoff, review, and a worker's brief, start request and report. Also `agent-request.md`, a request for a new agent (see [New agents](#new-agents)). |
| `agents\`                           | Requests for new agents, and the relay's answers. You make this folder only if you turn on new agents. |
| `PROTOCOL.md`                       | The rules everyone follows. In a mailbox it is called `README.md`.             |
| `COORDINATOR.md`                    | Standing orders for the coordinator. In a mailbox it is called `CLAUDE.md`. A Codex or Gemini CLI coordinator reads a copy in its own folder, called `AGENTS.md` or `GEMINI.md`. |
| `ORCHESTRATOR.md`                   | Standing orders for the orchestrator, the planner of several projects. In HQ it is called `AGENTS.md`. |

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

Keep the mailbox on a plain path, with no `~`. Windows can give a long folder name a short one, such
as `ADA~1`. The relay's notes to the planner and to Codex agents turn every `~` into a space, so the
mail command in them would break. Use the long name.

## Settings

Both settings files live in the mailbox's `bin` folder, on your computer only. This repository
has just the examples. The relay reads them when it starts. Always type a folder as a full path,
such as `D:\mailbox`. A bare drive, such as `D:`, means the folder that drive is in right now, not
its top.

`bin\relay-settings.json`:

| Setting         | What it does                                                                                                    |
| --------------- | --------------------------------------------------------------------------------------------------------------- |
| `projects_dir`  | The folder that holds your code repositories. The coordinator may read it.                                      |
| `worktrees_dir` | The folder where workers work. A worker starts only inside it. Leave it out to use `<projects_dir>\_worktrees\claude`. |
| `owner_name`    | Your name, for the relay's notes: "Any other command needs Ada", and the tag `NEEDS-ADA`. Leave it out and they say "the owner" and `NEEDS-OWNER`. |
| `codex_exe`     | For the Codex wake, Codex workers and a Codex coordinator: the full path of the Codex command. Leave it out to use `codex` from your PATH. |
| `worker_tools`  | The AI tools that may run workers: a list from `"claude"`, `"codex"`, `"gemini"` and `"antigravity"`. Leave it out for `["claude"]`. See [Workers in Codex or Gemini](#workers-in-codex-or-gemini-optional) and [Antigravity workers](#antigravity-workers-off-by-default). |
| `claude_exe`    | The full path of Claude Code for workers. Leave it out to use `%APPDATA%\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe`. |
| `gemini_exe`    | For Gemini workers and a Gemini CLI coordinator: the full path of Gemini CLI. Leave it out to use `gemini` from your PATH. |
| `start_requests` | `true` or `false`: whether the relay starts workers for the start requests (`W<n>-start.md`) that a coordinator writes. Leave it out and they are on for a Codex or Gemini CLI coordinator, and off for a Claude Code one. Write `true` or `false` without quotes. See [Start requests](#start-requests). |
| `antigravity_exe` | Only for Antigravity workers: the full path of Antigravity CLI. Leave it out to use `%LOCALAPPDATA%\agy\bin\agy.exe`, or `agy` from your PATH. |
| `antigravity_sandbox` | Only for Antigravity workers: `true` runs their commands in Antigravity CLI's terminal sandbox (`--sandbox`). Leave it out, or `false`, to keep it off. |
| `codex_exec_args` | Only for the Codex wake and for a Codex agent with no profile: extra options for `codex exec`, one per entry, such as `["--sandbox", "workspace-write"]`. Options that turn the sandbox off are refused. |
| `role`          | Only in HQ: `"hq"`. Then the relay also wakes the orchestrator for the projects in `projects`. Leave it out in every other mailbox. |
| `projects`      | Only in HQ: the project mailboxes, each one `{ "id": "notes", "name": "Notes", "mailbox": "C:\\Users\\ada\\mailboxes\\notes" }`. The id is 1 to 40 small letters, digits or hyphens, and never `hq`. The mailbox is the full path of a folder that is there, and not HQ itself. The relay skips a bad entry and says why in `-Status` and `relay.log`. |
| `hq_dir`        | Only in a project mailbox: the HQ folder. `-NewProject` writes it, and `-Status` shows it. A project uses it to find HQ, so it can refuse HQ's orchestrator thread and HQ's folders for its coordinator. Set it when you add a project by hand. `-Box` needs it too (see [Mail between mailboxes](#mail-between-mailboxes)). |
| `agent_tools`   | The AI tools whose agents the relay may sign up, wake and make: a list from `"codex"`, `"claude"` and `"gemini"`. Leave it out for `["codex", "claude"]`. A tool that is not listed is off for agents, and its agents' mail stays where it is. An empty list turns every agent off. See [Agents in any AI tool](#agents-in-any-ai-tool). |
| `allow_new_agents` | `true` lets the relay make new agents from requests in `agents\`. Write `true` with no quotes. Leave it out, or write `false`, and it is off. It also turns the guard on. See [New agents](#new-agents). |

`bin\cost-limits.json` (if there is no such file, the limits are on):

| Setting                   | What it does                                                                                       |
| ------------------------- | -------------------------------------------------------------------------------------------------- |
| `enabled`                 | `true`: each run has a dollar cap, and the relay has a daily cap. `false`: no caps (that takes away the dollar cap of Claude Code agents too, but not the Gemini CLI total or the limit on new agents). Costs are written down either way. |
| `relay_max_wakes_per_day` | How many times a day the relay may wake the coordinator, whatever AI tool it is. The usual number is 12. `0` means no limit. |
| `relay_max_codex_wakes_per_day` | How many times a day the relay may wake the planner's Codex thread. The usual number is 12. `0` means no limit. |
| `relay_max_agent_wakes_per_day` | How many times a day the relay may wake each agent for its mail, whatever AI tool it uses. The usual number is 12. `0` means no limit. |
| `relay_max_agent_turns_at_once` | How many agents the relay may wake for mail at the same time, 1 to 10. The usual number is 3. The first turn of a new agent counts too. |
| `relay_max_new_agents_per_day` | How many new agents the relay may make in one day, 0 to 20. The usual number is 2. `0` means no limit. A number below 0 is a mistake: the relay keeps 2 and says so. See [New agents](#new-agents). |
| `relay_max_agent_usd_per_day` | How many dollars a day all Claude Code agents together may use, as Claude Code reports it. The usual number is 5. `0` means no cap. It works only while `enabled` is `true`. |
| `agent_wakes_per_day` | How many agent turns a day all agents of one AI tool may take together, such as `{"gemini": 4}`. That is the usual number: only Gemini CLI has a total. A tool you do not name has none. `0` means no limit for that tool, so `{"gemini": 0}` takes the 4 away. A first turn of a new agent counts too. |
| `relay_max_mail_hops` | How many turns the relay wakes in a row for agent mail, with no person in between, before it holds the mail. The usual number is 8, and the top is 99. `0` means no limit. See [Two agents that keep waking each other](#two-agents-that-keep-waking-each-other). |
| `worker_runs_per_day`     | How many Codex, Gemini and Antigravity workers may start in one day, such as `{"codex": 12, "gemini": 4, "antigravity": 4}`. Those are the usual numbers. `0` means no limit. |
| `relay_max_worker_starts_per_day` | How many workers the relay may start a day for start requests. The usual number is 12. `0` means no limit. A number below 0 is a mistake: the relay keeps 12 and says so. |
| `gemini_max_session_turns` | How many turns a Gemini worker, a Gemini CLI coordinator turn, or a Gemini CLI agent turn may take. The usual number is 30. `0` means no limit. Gemini CLI may skip this limit for a coordinator: see [the turn limit](#the-turn-limit-of-a-gemini-cli-coordinator). |

A "worktree" is a second working folder of a Git repository, on its own branch. Each task gets
one, so workers never touch your main folder.

## Start the relay

Run these in the mailbox folder.

1. Check the setup. Neither command changes anything.

   ```powershell
   .\bin\bridge-relay.ps1 -Status
   .\bin\bridge-relay.ps1 -DryRun
   ```

2. Tell the relay which Claude Code session is the coordinator. Do this once, in one of two ways.
   (For a coordinator in Codex or Gemini CLI, skip this step and follow
   [A coordinator in Codex or Gemini CLI](#a-coordinator-in-codex-or-gemini-cli-optional) instead.)

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
| `-Status`             | Shows whether the relay runs, the enrolled session, whether a window has it open, what waits, and today's turns and costs. It also shows whether new agents are on, and the requests that wait. |
| `-DryRun`             | Shows what the relay would do now, agent requests included. It starts nothing and writes nothing. |
| `-Once`               | Does one round, then stops.                                                                    |
| `-Start`              | Keeps running and watches the mailbox. Stop it with `-Stop` from another window, or Ctrl+C.    |
| `-Stop`               | Asks a running relay to stop. A coordinator turn that is running is never cut off.             |
| `-ClearHalt`          | Starts sending again after the relay stopped itself: repeated errors, a changed relay file, or a halted agent. Fix the cause first. It also lets new agents start again after three failed first turns, accepts a changed orders file of a new agent as it is now, and lets mail that was held as a possible loop wake its agent once more. |
| `-ShowCoordinatorArgs`| Shows the commands the coordinator may and may not run. It changes nothing.                    |
| `-Enroll -Tool codex -ThreadName <name>` | Signs up a Codex thread as the coordinator (`-ThreadId <id>` in place of the name works too; `-CodexCwd <folder>` names its folder if the relay cannot read it; `-Model` and `-Effort low`, `medium`, `high` or `xhigh` are optional). See [A coordinator in Codex or Gemini CLI](#a-coordinator-in-codex-or-gemini-cli-optional). |
| `-Enroll -Tool gemini -SessionId <id>` | Signs up a Gemini CLI session as the coordinator (`-CoordinatorCwd <folder>` if the relay cannot tell its folder; `-Model` and `-AllowCheck` are optional). Gemini CLI has no names to follow and no effort. |
| `-Enroll -Tool claude` | The same as `-Enroll` alone: a Claude Code coordinator. `-Tool` works only with `-Enroll`. |
| `-MaxWorkerStartsPerDay <n>` | How many workers the relay may start for start requests in one day, just for this run (0 to 500; `0` means no limit). The usual way is `relay_max_worker_starts_per_day` in `bin\cost-limits.json`. |
| `-GeminiExe <path>`, `-GeminiCliHome <folder>` | Where Gemini CLI is, and the folder that holds its `.gemini` folder, if they are not in the usual place (`gemini_exe` in `bin\relay-settings.json`; `GEMINI_CLI_HOME`). |
| `-EnrollCodex -ThreadId <id>` | Turns on the Codex wake for that Codex thread. Mail for the planner stays off. See below. |
| `-EnrollCodex -ThreadName <name>` | The same, for the newest Codex thread with that name. The name is also the planner's mail name. See [Mail for the planner](#mail-for-the-planner). |
| `-UnenrollCodex`      | Turns the Codex wake off again.                                                                |
| `-EnrollAgent -AgentName <name>` | Wakes that agent's Codex thread when mail waits for it. For a Claude Code or Gemini CLI agent, or a Codex agent with the relay's rules, add `-Tool`, `-AgentFolder`, `-SessionId` or `-AgentProfile mail` or `files` (`-Model` and `-Effort` are optional). See [Agents in any AI tool](#agents-in-any-ai-tool). |
| `-UnenrollAgent -AgentName <name>` | Stops waking that agent for its mail. Its mail stays. It saves a copy of `.relay\agents.json` first. |
| `-ShowAgentArgs -AgentName <name>` | Shows one agent's turn as JSON: the command, the rules and the folder. It changes nothing. |
| `-MaxNewAgentsPerDay <n>` | How many new agents the relay may make in one day, just for this run (0 to 20; `0` means no limit). The usual way is `relay_max_new_agents_per_day` in `bin\cost-limits.json`. See [New agents](#new-agents). |
| `-NewProject -ProjectId <id> -ProjectName <name>` | Only in HQ: makes a project mailbox in `projects\<id>` (or in `-ProjectFolder <folder>`), and adds it to HQ's list. See [Run several projects](#run-several-projects-hq). |
| `-UpdateProjects`     | Only in HQ: copies HQ's scripts into each project whose relay does not run.                    |
| `-StartAll`           | Only in HQ: starts each project's relay in a new window, then HQ's own relay in this window.   |
| `-StopAll`            | Only in HQ: asks every relay to stop, HQ's too. A turn that runs is never cut off.             |

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
  `["--sandbox", "workspace-write", "--add-dir", "C:\\Users\\ada\\mailbox"]`. For the mail that
  agents send the planner, see [Mail for the planner](#mail-for-the-planner).
- **Errors:** after 3 failed Codex turns in a row, the relay stops waking Codex and writes an alert.
  Claude wakes go on. Fix the cause, then run `-ClearHalt`.
- **To turn it off:** `.\bin\bridge-relay.ps1 -UnenrollCodex`.

## A coordinator in Codex or Gemini CLI (optional)

The coordinator does not have to be a Claude Code session. It can also be a Codex thread or a
Gemini CLI session. It gets the same notices and does the same job. A Claude Code coordinator works
exactly as before, and nothing changes in your mailboxes until you sign up a Codex or Gemini CLI
coordinator.

A Codex or Gemini CLI coordinator works in **a folder of its own**, such as
`C:\Users\ada\mailbox\coordinator`. That folder holds its standing orders and, for Codex, its
status board. The folder must not be:

- the mailbox folder itself, a folder above it, or its `bin`, `tests`, `templates`, `tasks`, `mail`,
  `agents` or `.relay` folder;
- a folder inside a code repository (a Git folder), or a `.git` folder. The mailbox's own
  repository is fine;
- your home folder or your projects folder (or a folder that holds one of them), the workers'
  worktrees folder (or a folder inside it, or one that holds it), a whole drive, or a network
  folder. A folder inside the projects folder is fine, unless it is in a repository;
- the folder where an AI tool keeps its own files (the `.codex`, `.gemini` and Claude Code folders);
- HQ's folder (the folder of a many-project setup, see
  [Run several projects](#run-several-projects-hq)), or the folder of a project mailbox of HQ;
- the planner's folder or an agent's folder;
- for a Codex coordinator inside a Git repository: a folder above it, up to the top of the
  repository, that holds an `AGENTS.md` or an `AGENTS.override.md`. Codex reads every `AGENTS.md`
  from the top of the repository down to its own folder, for example HQ's `AGENTS.md` with the
  orchestrator's orders, so the coordinator would get those orders too. Outside a Git repository,
  Codex reads only the folder's own `AGENTS.md`, and this rule does not apply.

The relay checks all of this when you sign it up and before every turn, and says in plain words
which rule a folder breaks. Signing up refuses a folder that breaks the last rule, a rollover does
not follow a Codex thread to one, and a turn halts on one.

### Set it up

1. **Update the relay in your mailbox** (see [Update the relay in a mailbox](#update-the-relay-in-a-mailbox)).
   Copy the new scripts and `templates\worker-start.md`. (In HQ, `-UpdateProjects` does not copy
   templates, so copy `worker-start.md` into each project that lacks it: see step 6 of
   [Run several projects](#run-several-projects-hq).)
2. **Make the coordinator's folder** and copy the standing orders into it. Codex reads
   `AGENTS.md`. Gemini CLI reads `GEMINI.md`. Both files are a copy of `COORDINATOR.md`:

   ```powershell
   $repo = 'C:\Users\ada\pleni'
   $mb   = 'C:\Users\ada\mailbox'
   New-Item -ItemType Directory -Force "$mb\coordinator" | Out-Null
   Copy-Item "$repo\relay\COORDINATOR.md" "$mb\coordinator\AGENTS.md"   # Codex
   Copy-Item "$repo\relay\COORDINATOR.md" "$mb\coordinator\GEMINI.md"   # Gemini CLI
   ```

   (Copy only the one you need.)
3. **Start the session in that folder, once.** Open a window in `C:\Users\ada\mailbox\coordinator`,
   start `codex` or `gemini`, and say hello. Then close the window.
   - Codex: give the thread a name, such as `Coordinator`, in Codex. Set up Codex's Windows sandbox
     first (see below), and use a Codex command line from April 2026 or newer.
   - Gemini CLI: type `/stats` and copy the session id.
4. **Stop the relay and sign the coordinator up.** In the mailbox folder:

   ```powershell
   .\bin\bridge-relay.ps1 -Stop
   .\bin\bridge-relay.ps1 -Enroll -Tool codex -ThreadName Coordinator -Effort high
   ```

   For Gemini CLI, use the session id and, if you like, a check the coordinator may run:

   ```powershell
   .\bin\bridge-relay.ps1 -Enroll -Tool gemini -SessionId <the session id> -AllowCheck 'php -l'
   ```

   For Codex you may give `-ThreadId <id>` in place of the name, and `-Model <model>`. Codex takes
   no `-AllowCheck`: it runs commands in its own sandbox. For Gemini CLI you may give `-Model`, and
   `-CoordinatorCwd <folder>` if the relay cannot tell the session's folder. Gemini CLI has no
   effort setting and no names to follow. A Gemini CLI check may not start with `node`.

   For Gemini CLI, also set `model.maxSessionTurns` in your own Gemini settings
   (`%USERPROFILE%\.gemini\settings.json`) before you start the relay. Gemini CLI skips the relay's
   own turn limit in a mailbox folder, and every turn costs money. See
   [The turn limit of a Gemini CLI coordinator](#the-turn-limit-of-a-gemini-cli-coordinator).
5. **Start the relay again, and check it.**

   ```powershell
   .\bin\bridge-relay.ps1 -Start
   ```

   In another window, `-Status` shows the coordinator, the AI tool it uses, whether start requests
   are on, and whether the guard is on. `-DryRun` shows the command a turn would run.
   `-ShowCoordinatorArgs` shows the options of a turn, and for Gemini CLI the rules file.

Signing up starts nothing by itself. A start request that already waits keeps waiting, and the
relay runs it later. A start request the relay never saw (one written in the last 20 seconds, for
example) counts as known and never runs, and `relay.log` has a line for each. A notice that is
still waiting goes to the new coordinator after `-Start`. See [Start requests](#start-requests).

- **Gemini CLI:** the relay refuses a session that is open right now, or that was written less than
  90 seconds ago (`QuietSeconds`). Close the window and wait first.
- **Codex:** if another Codex program (most likely the Codex app) has the thread open, signing up
  still works. The relay wakes the thread only after that program lets go of it.

### What each kind of coordinator can do

| | Claude Code | Codex | Gemini CLI |
| --- | --- | --- | --- |
| **Reads** | The mailbox and your projects folder. | Whatever Codex's workspace-write sandbox lets it read (the relay sets no read limit). | The mailbox, the projects folder, the workers' worktrees folder and its own folder. |
| **Writes** | Its own files in the mailbox, but not `bin`, `tests` or `.relay`. | Only its own folder and the mailbox's `tasks` folder. | Only `STATUS.md` in the mailbox and `.md` files under `tasks`. Never a file named `GEMINI.md`, `AGENTS.md`, `AGENTS.override.md`, `CLAUDE.md` or `CLAUDE.local.md`, and never a path with `..`. |
| **Runs commands** | A fixed list, and the checks you allowed. | In Codex's sandbox (a locked box that limits what a program may touch), with no internet. | Only read-only Git commands (`status`, `log`, `diff`, `show`, `rev-parse`, `branch --list`, `ls-tree`, `cat-file` and `worktree list`) and the checks you allowed. No web, no memory tool, no MCP tools (add-on tools). |
| **Starts workers** | With `spawn-worker.ps1`. | With start requests. | With start requests. |
| **GitHub** | One push and a draft pull request, in the narrow way of order 12. | No. | No. |
| **Costs** | Your Claude plan, with dollar caps. | Your ChatGPT plan. | Money each turn, on your own Gemini login. |

For Codex and Gemini CLI, the planner or the coordinator asks the **owner** for anything else, in
a `NEEDS-` note. A coordinator that is refused a command writes a `NEEDS-<OWNER>/BLOCKED` note and
ends the turn. A Codex or Gemini CLI coordinator puts these notes in the task's `status.md`, not
at the mailbox root, because it may not write there. The relay puts these rules in every notice too.

**What the relay changes about Codex.** This holds for a Codex coordinator and for Codex workers.
The relay starts Codex without your own `config.toml` and your own command rules
(`--ignore-user-config` and `--ignore-rules`). So these settings of yours do not apply:

- extra folders;
- MCP servers (add-on tools);
- hooks (commands Codex runs by itself at set moments);
- command rules (your list of commands Codex may run without asking);
- every other setting in `config.toml`, profiles included.

Codex's own web search is off too. The relay still passes on a few of your settings. It reads only
the top level of `config.toml` (and the `[windows]` part), and nothing else:

- **Your model** (`model`). A Codex worker uses `-Model` when one is given, else this one.
- **Your effort** (`model_reasoning_effort`), for a Codex coordinator only: the effort you gave
  when you signed it up, else this one. A Codex worker's effort is `-Effort`, or `xhigh` when none
  is given, as before. It is never the effort in `config.toml`.
- **Your sign-in store** (`cli_auth_credentials_store`). This is where Codex keeps your sign-in:
  `keyring` is Windows Credential Manager, and `auto` is the keyring when it works.
- **Your Windows sandbox** (`sandbox` in the `[windows]` part).

A model or effort set in a `[profiles.<name>]` part, or chosen with `profile = "<name>"`, does not
apply any more, like every other setting. If one of the few settings does not look right, the relay
leaves it out and names only its key in `relay.log`.

- **Set up Codex's Windows sandbox first.** Codex on Windows has no sandbox until you set it up
  (`sandbox` in the `[windows]` part of `config.toml`, which Codex's own setup writes). Without it,
  Codex refuses the coordinator's commands and file edits. `relay.log` says when it is not set up,
  and so does a Codex worker's note.
- **You need a Codex command line from April 2026 or newer.** An older one does not know the two
  options and stops at once. A worker then gets a note that says to update Codex, and a coordinator
  turn halts with the same words. Update it with `npm install -g @openai/codex`.
- **The planner's Codex wake does not change.** It still uses your Codex settings and
  `codex_exec_args`.

**Status board.** A Codex coordinator keeps `STATUS.md` in its own folder. After each turn the
relay copies it into the mailbox. It copies only a plain file of 1 MB or less, never a link. When
you sign the coordinator up, the relay starts the folder's board as a copy of the mailbox's. If the
folder already has a different board, the relay keeps a copy of it in `.relay\backups` first. A
Gemini CLI coordinator writes `STATUS.md` in the mailbox directly.

### The turn limit of a Gemini CLI coordinator

The relay asks Gemini CLI for a turn limit (`gemini_max_session_turns` in `bin\cost-limits.json`,
30 unless you change it). **But Gemini CLI skips the relay's limit in a mailbox folder.** It
ignores a limit file that people other than an administrator can change. People can change
anything in a mailbox. When that happens, `-Status`, `relay.log` and an alert say so. So **set
`model.maxSessionTurns` in your own Gemini settings** (`%USERPROFILE%\.gemini\settings.json`). That
limit Gemini CLI always reads.

**Each Gemini CLI turn costs money.** Gemini CLI needs a paid API key, Vertex AI or a work license.
The relay hands your `GEMINI_API_KEY` to Gemini CLI as it is, and never writes it down. It counts
turns (12 a day, like every coordinator), not dollars. Codex and Gemini CLI report no cost, so the
relay's dollar caps work only for a Claude Code coordinator.

### Start requests

A Codex or Gemini CLI coordinator cannot run `spawn-worker.ps1` itself. In Codex's sandbox a worker
would have no network, and Gemini CLI's rules do not allow PowerShell. So it asks. To start a
worker, the coordinator:

1. writes the worker's brief, `tasks\<TASK-ID>\workers\W<n>-brief.md`, as always;
2. writes a **start request** beside it, `W<n>-start.md`, from `templates\worker-start.md`.

After the coordinator's turn ends, the relay checks the request and runs the mailbox's own
`bin\spawn-worker.ps1` for it. That script is the **launcher**: the program that starts a worker.
The template looks like this:

```markdown
- **Tool:** claude
- **Type:** implementation
- **Budget USD:** 2
- **Model:**
- **Effort:** high
- **New worktree:** no
- **Requested:** 2026-11-04 05:00
```

- The relay reads only these lines, written just as they are in the template. **Tool** (`claude`,
  `codex`, `gemini` or `antigravity`) and **Type** (`implementation` or `review`) must be there.
  Budget USD (0.05 to 25) is for a Claude Code worker only. Model, Effort and Requested are
  optional. Effort is `low`, `medium`, `high`, `xhigh` or `max`, but Codex and Antigravity have no
  `max`: for them use `xhigh` or lower.
- These lines take the place of the launcher's `-Tool`, `-Type`, `-Model` and `-Effort` options. A
  coordinator that cannot run the launcher picks the worker's AI tool, model and effort here.
- The relay refuses a line it does not know. It refuses a line written another way, and a value
  that does not fit. It also refuses a file larger than 8 KB, and a file that is a link.
- It starts only a tool that `worker_tools` lists. The brief must be there. It never starts a
  worker that still runs.
- **New worktree: yes** makes the worker's worktree first, on the branch `claude/<TASK-ID>` from
  the brief's **Base commit**. The brief's Branch line must be that branch, and `projects_dir` must
  be set. That way a coordinator that cannot run `git worktree add` can still start a worker.
  The folder must not be there yet. The branch must not be there yet either. If git fails half way,
  what it left stays, and the request is refused until you delete it. The refusal note says what is
  left. If the launcher made the worktree and then refused for another reason, the worktree stays
  too: ask again with `New worktree: no`.
- **Each version of the file runs at most once.** To ask again after a refusal, fix the cause and
  change the Requested line. The same file never starts a worker twice.
- It runs between coordinator turns, after a short wait for the file to settle. One launcher runs at
  a time, up to 5 in a round, and up to 12 a day (`relay_max_worker_starts_per_day`; `0` means no
  limit). It waits while PAUSE is there, while the relay is halted, and while a coordinator turn
  runs. At the daily limit, the requests wait until the next day, and the relay writes an alert. If
  a launcher runs longer than 30 minutes, the relay writes a `long-start` alert. It never stops
  the launcher, and the other requests wait until it ends.
- **A refusal comes back as a note.** The coordinator's next turn starts with a line such as: "The
  relay did not start worker W2 of T-20261104-01-notes: its brief W2-brief.md is not there; write
  the brief first. Fix it, then change W2-start.md to ask again."
- **If the relay stops while it starts a worker,** the note says it does not know if the worker
  started. It will not try again on its own.
- When the relay first looks, every start request that is there counts as known and never runs.
  When you sign a coordinator up, a request the relay has already seen and that waits (for the
  daily limit, PAUSE, a halt or a coordinator turn) keeps waiting, and runs later. One the relay
  never saw (for example, one written in the last 20 seconds) counts as known and never runs.
  `relay.log` has a line for each. After a second sign-up, the new coordinator gets one note that
  names them, such as: "W2-start.md of T-20261104-01-notes was not run because the coordinator was
  signed up again; change the file to ask again." If start requests are off for that coordinator
  (a Claude Code coordinator without `start_requests`), the note says instead that start requests
  are off and that the coordinator starts the worker itself with `bin\spawn-worker.ps1`, if it is
  still needed.

Start requests are on by default only for a Codex or Gemini CLI coordinator. Set `start_requests` to
`true` or `false` in `bin\relay-settings.json` to change that for any coordinator. `-Status` shows
how many requests wait and how many started today.

### What makes the relay stop, and why

The relay **guards its own files** while any one of these is true:

- a Codex or Gemini CLI coordinator is signed up;
- start requests are on;
- `allow_new_agents` is `true`;
- an agent with the relay's rules is signed up: a Claude Code or Gemini CLI agent, a Codex agent
  with a profile, or an agent the relay made.

The relay decides this when it starts. It runs `bin\spawn-worker.ps1` outside any sandbox when a
start request asks, an agent runs `bin\agent-mail.ps1` in every turn, and a Codex coordinator can
write in a folder of its own. So a changed script must never run. The relay looks at these files
each round, before each worker start, coordinator turn, agent turn and new agent, and after those
turns:

- the relay's scripts (`bin\*.ps1`, `agent-mail.ps1` too) and the fake tools in `tests\*.js`;
- `bin\relay-settings.json` and `bin\cost-limits.json`;
- the coordinator's standing orders (`AGENTS.md` or `GEMINI.md` in its folder);
- the relay's own records: `.relay\coordinator.json`, `codex.json` and `agents.json`.

The orders file of an agent the relay made is checked on its own: a change stops only that agent
(see below).

If one of them changes and the relay did not make the change, the relay **halts**. That means it
sends no turn, wakes no planner or agent, and starts no worker and no new agent until you look. It
writes an alert that names the file.
**To go on:** see what changed. If you changed it yourself, run `-Stop` (if the relay runs), then
`-ClearHalt`, then `-Start`.

**So to change a script, a setting or an orders file, stop the relay first.** `-Stop` never cuts
off a coordinator turn that is running, and it does not settle it. So run `-Status` too. If it
lists a turn in flight, wait until it says `alive False`. Then, with the old scripts still in
place, make an empty file named `PAUSE` in the mailbox's `.relay` folder, run
`.\bin\bridge-relay.ps1 -Once` (it settles the turn and starts nothing), and delete `PAUSE`. Now
`-Status` says `In flight: none`. If a turn is still running when you change a file, the relay
halts itself when you start it again, but only while its guard is on (see the list above). A
mailbox with a Claude Code coordinator, start requests off, new agents off and no agent with the
relay's rules has no guard, so nothing halts there.

Each change halts the relay once. After the relay halted for a change and you cleared it with
`-ClearHalt`, a turn that still runs does not halt it again for that same change, only for a newer
one.

HQ's `-NewProject` changes HQ's own settings file. While HQ's relay runs with its guard on,
`-NewProject` refuses and says: "HQ's relay is running and watches its own settings. Run -StopAll
first, then -NewProject, then -StartAll." It also refuses while a Codex or Gemini CLI coordinator
turn of HQ is still running, or has ended but the relay has not settled it: `-StopAll` leaves such a
turn running, and the next relay would halt at the change. Wait until `-Status` shows no coordinator
turn in flight. Or make an empty file named `PAUSE` in `.relay`, run `-Once`, run `-NewProject`,
delete `PAUSE`, then run `-StartAll`. The guard is off for a Claude Code coordinator with start
requests off, new agents off and no agent with the relay's rules, which is how an older mailbox
works. Then `-NewProject` works while HQ's relay runs, and the step it prints (run `-StopAll`, then
`-StartAll`) still applies.

The relay also halts, with an alert that says what to do. Each cause below has its own bullet.

For a **Codex** coordinator:

- A `.codex` folder is in the coordinator's folder. Codex would read its settings. Move it away.
- An `AGENTS.override.md` file is in the coordinator's folder. Codex reads it in place of
  `AGENTS.md`. Move it away.
- An `AGENTS.md` or `AGENTS.override.md` is in a folder above the coordinator's folder, in its
  Git repository. Codex would read those orders too. Move it away, or give the coordinator a
  folder outside the repository.
- The coordinator's folder breaks one of the folder rules at the top of this part. Pick another
  folder.
- The mailbox path has a character that `cmd.exe` (the Windows command window) treats specially:
  `%`, `!`, `^`, `&`, `|`, `<`, `>`, `"`, or a control character. Move the mailbox.
- The model in `.relay\coordinator.json` cannot be used, or the effort is not `low`, `medium`,
  `high` or `xhigh`. Sign up again.
- The Codex command line is too old. Update it.
- The thread has another job (see "One thread, one job" below). Use another thread. Only the
  planner and a Codex agent with no profile may share a thread.

For a **Gemini CLI** coordinator:

- A `.gemini` or `.agents` folder is in the coordinator's folder. Gemini CLI would load it. Move it
  away.
- A `.env` file is in the folder, or in a folder above it, up to your home folder. Move it away.
- Gemini CLI's system policy folder (`C:\ProgramData\gemini-cli\policies`) holds a `.toml` file.
  Then Gemini CLI ignores the relay's rules. Move that file away.
- A check you allowed would make Gemini CLI drop one of the relay's rules without a word. The alert
  names the rule. Change or remove the check, and sign up again.
- The relay's rules file changed while a turn ran. Look at it before you go on.
- The session moved to another folder. Sign up again.
- The model in `.relay\coordinator.json` cannot be used. It may be a Claude model, or not one plain
  word. Sign up again.
- A path on the command line has a comma or an `@`. Gemini CLI would read it as a list or a file.
  Move the folder.
- Gemini CLI starts from a `.cmd` or `.bat` file (the usual npm install), and a path or the command
  line has `%`, `!`, `^`, `&`, `|`, `<` or `>`. The Windows command window would change it. Move the
  folder.

For **both**:

- The turn ran in another thread or session than the one signed up. Check the sign-up.
- 3 turns in a row failed, or ended with an error. See the next part.

An **agent** halts alone: its mail is kept, its wakes stop, and the other agents go on. The alert says
why. The common causes:

- Its folder is gone, or no longer follows the folder rules (see [The folder rules](#the-folder-rules)).
- Its mail folder is a link (a shortcut to another place).
- The orders file of an agent the relay made has changed.
- Its session now has another job too (one session has one job).
- For a Codex agent: a model or effort the relay cannot use, or a Codex command line that is too old.
- For a Claude Code or Gemini CLI agent: the mailbox path has a space or a sign other than letters,
  digits and `. _ - ~`. Move the mailbox to a plain path.
- 3 turns in a row failed.

The relay's own guard (above) halts everything, agents included: no agent turn starts until you
clear it. Mail that comes in a long loop is not a halt: see
[Two agents that keep waking each other](#two-agents-that-keep-waking-each-other).

Fix the cause, then run `-ClearHalt`.

**When a turn fails.** The relay waits and tries again, up to 3 turns in a row. Then it halts. The
alert says what Codex or Gemini CLI told the relay. A notice that reached the session is never sent
again. For Gemini CLI, the exit number tells you what to do:

- **Not signed in (41).** Sign in once in a Gemini CLI window on this computer.
- **No such session (42), a problem in its settings (52), or a folder it does not trust (55).** The
  notice did not reach the session. Fix the cause. The relay tries again.
- **It hit its turn limit (53), or a tool failed (54).** The notice did reach the session. The work
  is kept, and the relay does not send the notice again.
- **It stopped after the notice reached the session, with no result.** The relay cannot tell what
  happened. It does not send the notice again. Look at the coordinator's status files.

**One thread, one job.** A Codex thread may be only one of: the planner, the coordinator, an agent,
or HQ's orchestrator. There is one exception, as before: the planner and a Codex agent with no profile may
share one thread. The relay never wakes them at the same time, and at a rollover both move to the
newer thread with the name. Only the coordinator and HQ's orchestrator need a thread of their own,
and so does every agent of a new kind. Signing up refuses every other overlap, and a turn halts if it finds one. Never let two mailboxes
wake the same Codex thread.

**Close the coordinator's window before the relay wakes it.** The relay waits while a window has
the coordinator open. It can see a Codex window and a Gemini CLI window that names the session id.
A Gemini CLI window opened with `/resume` names no id, so the relay cannot see it. It only waits
while the session file is fresh (`QuietSeconds`, 90 seconds unless you change it).

### Change the coordinator's AI tool

To move a mailbox's coordinator from one tool to another, such as from Claude Code to Codex:

1. Stop the relay: `.\bin\bridge-relay.ps1 -Stop`.
2. Sign up again with the other tool, as in step 4 above: `-Enroll -Tool codex ...`, `-Enroll -Tool
   gemini ...`, or `-Enroll -Tool claude ...` (the same as `-Enroll`). Give the model, effort and
   checks again: they do not carry over from the old coordinator. Make the new coordinator's folder
   and orders first, as in steps 2 and 3.
3. Start the relay again: `.\bin\bridge-relay.ps1 -Start`.

The relay keeps a copy of the old `.relay\coordinator.json` in `.relay\backups` (a name such as
`coordinator.json.20261104-050000.bak`), every time you sign a coordinator up. The relay will not
sign up a new coordinator while a coordinator turn still runs: wait for it to end, or settle it as
the message says. Pleni shows the coordinator under the new tool.

Signing up again also clears the old coordinator's count of failed turns and its wait (the
backoff), as a rollover does, even when the AI tool changes. A halt stays. `-Enroll` then says:
"The relay is still halted: <reason>. Run -ClearHalt after you check it." A start request that
already waits keeps waiting and runs later. One the relay never saw counts as known and never runs,
and after this second sign-up the new coordinator gets one note that names it, such as: "W2-start.md
of T-20261104-01-notes was not run because the coordinator was signed up again; change the file to
ask again." (With start requests off for that coordinator, the note says so, and says to start the
worker with `bin\spawn-worker.ps1`.) A notice that was still waiting goes to the new coordinator
after `-Start`.

### Why not Antigravity CLI yet

You cannot choose Antigravity CLI for a coordinator yet. `-Enroll -Tool antigravity` says so. There
are two big reasons:

- Google's consumer terms may not allow other programs to run Antigravity CLI, and your Google
  account could be suspended or closed. A worker is run now and then. A coordinator runs many times
  a day, every day, so the risk is much bigger.
- Antigravity CLI has no rules file for one run. The relay cannot say "write only the status board
  and the task notes" for one turn, as it can for Gemini CLI. Its way to pick up a saved
  conversation for one run is not proven either.

Antigravity CLI can still run workers. See [Antigravity workers](#antigravity-workers-off-by-default).

## Workers in Codex or Gemini (optional)

Workers run in Claude Code. If you turn them on, the coordinator can also start a worker in Codex
or in Gemini CLI, with `-Tool codex` or `-Tool gemini`. Through the coordinator, the planner can ask
for them too. Both stay off until you turn them on. Workers in Antigravity CLI have a part of their
own, with a warning: [Antigravity workers](#antigravity-workers-off-by-default).

1. **Sign in.**
   - Codex: install the `codex` command line and run `codex login`. Choose ChatGPT. The relay never
     uses an API key for Codex, so a Codex worker uses your ChatGPT plan.
   - Gemini: install Gemini CLI and sign it in. **Gemini costs money for every run.** Gemini CLI
     needs a paid API key, Vertex AI or a work license. The relay hands your `GEMINI_API_KEY` to
     Gemini as it is, and never writes it down.
2. **Turn them on.** In `bin\relay-settings.json`, list the tools that may run workers:
   `"worker_tools": ["claude", "codex", "gemini"]`. Leave a tool out to keep it off. Without this
   setting, only Claude runs workers, and the launcher refuses the others.
3. **Show the relay the programs,** if they are not on your PATH: set `codex_exe` and `gemini_exe`
   to their full paths. (A path that ends in `.js` runs through `node`. The test uses that.)
4. **Check the daily limits** in `bin\cost-limits.json`. Unless you change them, 12 Codex workers and
   4 Gemini workers may start in one day (`worker_runs_per_day`), and a Gemini worker may take 30
   turns (`gemini_max_session_turns`). The relay counts today's lines in each task's `runs.md`,
   and the runs that are running now.
5. **Tell the coordinator.** Add the order "Choose the AI tool for each worker" (order 14) to the
   end of your mailbox's `CLAUDE.md`, and the `- **Tool:**` line to your `templates\worker-brief.md`.
   See [Update the relay in a mailbox](#update-the-relay-in-a-mailbox): in the lines there, set
   `$want = 'Choose the AI tool for each worker'`, `$toClaude = $true`, `$toOthers = $true` and
   `$next`, or the lines add the newest order (order 16) instead. You may also copy order 14 from `COORDINATOR.md` by hand.

What each tool may do:

| Tool   | How the relay starts it | What it may change | What it may run |
| ------ | ----------------------- | ------------------ | --------------- |
| Claude | `claude -p`, with your Claude plan. | The worktree and its report. A reviewer: only its report. | `git` and `node`, but never push, merge, rebase, reset, checkout, switch, branch, worktree, tag, stash or config; never `npm`, `npx` or the web. |
| Codex  | `codex exec`, with your ChatGPT plan, in Codex's `workspace-write` sandbox. The launcher starts Codex without your `config.toml` and your command rules (`--ignore-user-config` and `--ignore-rules`), so their extra folders, MCP servers (add-on tools), hooks (commands Codex runs by itself at set moments) and command rules (your list of commands Codex may run without asking) do not apply. It still passes on your model (unless `-Model` is given), your Windows sandbox and your sign-in store. Its effort is always `-Effort`, or `xhigh` when none is given, as before, and never the effort in your `config.toml`. Every other `config.toml` setting, profiles included, does not apply. The Windows sandbox is the `sandbox` in the `[windows]` part of your `config.toml` (`elevated`, `unelevated` or `mxc`; the older `[features]` flags `elevated_windows_sandbox` and `experimental_windows_sandbox` also count). Codex has no sandbox on Windows without it, and then refuses the worker's commands and file edits, so set it up in Codex first; the worker's note says when it is not set up. The sign-in store is where Codex keeps your sign-in: `keyring` is Windows Credential Manager, and `auto` is the keyring when it works (the relay passes on only these two). It needs a Codex CLI from April 2026 or newer; an older one stops at once, and the worker's note says to update it. | The worktree and the task's `workers` folder. It cannot write in the folder where Git keeps the repository, so it cannot add a Git hook or change Git's settings. It does not commit: when it finishes, the launcher commits its changes, with no Git hooks. A reviewer works in the `workers` folder, so it can change only that folder. It can still read the worktree. | What the sandbox lets it run. The relay turns the sandbox's network off, and Codex's own web search too. Your own Codex settings and command rules do not add to what it may run. |
| Gemini | `gemini -p`, with your Gemini login, and a policy that the relay writes for each run (`W<n>.gemini-policy.toml`). | The worktree and the `workers` folder. A reviewer: only its report. | Only `git status`, `diff`, `log`, `show` and `rev-parse`, `git add` and `commit` (not a reviewer), and `node <a script>`, without `>` or `>>`. Never push and the other git commands above, `npm`, `npx`, `node -e`, the web or MCP tools. |
| Antigravity | `agy`, with your Google sign-in. Off by default: see [Antigravity workers](#antigravity-workers-off-by-default). | The worktree and the `workers` folder. A reviewer: only the `workers` folder. It does not commit: the launcher does. | Only what your own Antigravity settings allow. With no rule there, nothing. |

A Gemini worker gets the whole brief in its prompt. It can read only its worktree and the task's
`workers` folder, so the coordinator puts what it needs from the assignment into the brief.

The relay does not start a Gemini worker, and says why, when:

- the worktree has `.gemini\settings.json`. Gemini CLI reads that file when it starts, and it can run
  commands from it.
- `C:\ProgramData\gemini-cli\policies` holds a `.toml` file. Then Gemini CLI ignores the relay's
  policy for the worker.
- the policy file changed after the relay wrote it. The relay checks it (its SHA-256) right before
  the start.

What the relay writes down:

- `W<n>.run.json` gets `tool`, `session_id` and `tokens`. For Codex, `session_id` is the Codex
  thread's id. The relay saves it as soon as Codex reports it. For Gemini, it is the session id that
  Gemini CLI reports. Neither tool reports a cost in dollars, so the daily limits keep the costs in
  check.
- `runs.md` gets two more columns, Tool and Tokens. An old `runs.md` keeps its rows as they are, and
  a new table starts under them.
- When Gemini CLI stops with an error, run.json and `W<n>.log` say what it means: 41 is "not signed
  in", 42 is bad input, 53 is the turn limit, and 55 is a folder it does not trust.
- `W<n>.log` also says which model the worker used. With no `-Model`, Codex and Gemini use their own
  default model.

**About the turn limit:** the relay gives Gemini CLI the limit in a small file
(`W<n>.gemini-defaults.json`). Gemini CLI 0.66 skips such a file when people other than an
administrator can change it, as in a mailbox folder. When Gemini CLI says so in its output, run.json
says `"turn_limit": "skipped by Gemini CLI"`. To be sure of a limit, also set
`model.maxSessionTurns` in your own Gemini settings (`%USERPROFILE%\.gemini\settings.json`).

## Antigravity workers (off by default)

**Read this first.** Google's FAQ for Antigravity says that running `agy` inside other programs "is
not supported under consumer plans". It also says that using an Antigravity login from other
software breaks Google's terms, and that Google may suspend or close the account for it. The relay
is such a program. So if you turn this on, your Google account could be suspended, or closed for
good. Turn it on only if you accept that risk. Every Antigravity run writes this warning in its log
(`W<n>.log`):

> Google's consumer terms may not allow running Antigravity CLI from other programs. Your Google
> account could be suspended or closed. Turn it off by taking antigravity out of worker_tools.

With it on, the coordinator can start a worker in Antigravity CLI (`agy`) with `-Tool antigravity`.

### Turn it on

1. **Sign in.** Install Antigravity CLI. Open a window, run `agy` once, and sign in. The relay never
   reads, copies or writes your login. A worker that is not signed in stops, and its `W<n>.run.json`
   says so.
2. **Turn it on.** Add `"antigravity"` to `worker_tools` in `bin\relay-settings.json`, for example
   `"worker_tools": ["claude", "antigravity"]`.
3. **Show the relay the program,** if it is not `%LOCALAPPDATA%\agy\bin\agy.exe` and not on your
   PATH: set `antigravity_exe` to its full path.
4. **Check the daily limit.** Unless you change `worker_runs_per_day` in `bin\cost-limits.json` (for
   example `{"antigravity": 2}`), 4 Antigravity workers may start in one day.
5. **Tell the coordinator.** Add `antigravity` to the `- **Tool:**` line of your
   `templates\worker-brief.md`. If your `CLAUDE.md` already has the order "Choose the AI tool for each
   worker", replace that order by hand with the new one from `COORDINATOR.md`. If it does not, add it
   as in [Update the relay in a mailbox](#update-the-relay-in-a-mailbox), with `$want` set to
   `'Choose the AI tool for each worker'`, and `$toClaude` and `$toOthers` set to `$true`.

To turn it off again, take `"antigravity"` out of `worker_tools`.

### What it may do

The launcher starts `agy` with no window. The prompt goes on its input (stdin), never on the command
line:

```
agy --input-format stream-json --output-format stream-json --mode accept-edits --add-dir <workers folder> --effort <effort>
```

- **Files:** in `accept-edits` mode, it may change files in the worktree and in the task's `workers`
  folder. A reviewer works in the `workers` folder, so it can change only that folder.
- **Reading:** it can read only those folders. A reviewer can read only the `workers` folder, unless
  you let it read your worktrees (see below). So the coordinator puts what a worker needs from the
  assignment into its brief.
- **Commands:** none, unless you allow them. Antigravity CLI has no permission file for one run. Its
  rules live in your own Antigravity settings, and the relay never changes that file. A run with no
  window denies each command that no rule allows, and goes on without it. It lists what it denied in
  `W<n>.log.err`.
- **Commits:** with no rule, a worker cannot run `git` either. So when it finishes, the launcher
  commits its changes, as for Codex. A run that changed nothing gets no commit, and a failed run
  gets none either. The worker could have changed files that Git reads, so the launcher's own `git`
  commands run no Git hooks (small programs Git can start by itself) and no file monitor program.
  If the run changed the worktree's `.git` file (it tells Git where Git's own folder is), the
  launcher commits nothing and says so in `W<n>.log`. Then look at the worktree before you use it.
- **Only in a Git worktree:** an Antigravity worker works only in a worktree made with
  `git worktree add`, the way the coordinator makes them. In a plain copy of a repository, Git's own
  folder is inside the worker's folder, where the worker could change it, so the launcher refuses.
- **Your own setup counts too.** Your Antigravity rules, hooks (commands Antigravity runs by itself
  at set moments, such as after it changes a file), MCP servers (helper programs that give it more
  tools, such as a link to a database) and plugins (add-on packs that can hold both) apply to a
  worker the same way they apply to you. A hook can run a command without asking. If your settings
  say `"toolPermission": "always-proceed"`, a worker may run any command. Keep the usual value.
- **What the launcher refuses:** it does not start an Antigravity worker, and says why, when there
  is a `.agents` folder (or `.agent`, `_agents` or `_agent`) with `hooks.json`, `mcp_config.json`,
  `plugins.json`, `plugins` or `agents` (custom agents, which can bring their own MCP servers) in
  it, or a `.gemini\config.json` (it can send Antigravity CLI to one more such folder). It looks in
  the worktree and the `workers` folder, and in each folder above them up to the top of their Git
  repository, because Antigravity CLI reads those too. Antigravity CLI loads all of these when it
  starts, and they can run commands without asking.
- **Model and effort:** with no `-Model`, it uses Antigravity CLI's own default model. `-Model` names
  one of its models (`agy models` lists them); a Claude model is refused. Its efforts are `low`,
  `medium` and `high`. `xhigh`, the usual one, runs as `high`, and `max` is refused.
- **What the relay writes down:** `W<n>.run.json` gets `tool` (`antigravity`), `session_id` (the
  conversation id that Antigravity CLI reports, saved as soon as it does), `tokens` and `commit`.
  `runs.md` says `antigravity` in its Tool column. When a run fails, run.json and `W<n>.log` say why
  in plain words: not signed in, the relay's input was wrong (exit 1), another error (exit 1, with
  Antigravity CLI's own words), a wrong flag (exit 2), the model or its service failed (exit 3), or
  a result that was not `SUCCESS`.

### The sandbox

Set `"antigravity_sandbox": true` in `bin\relay-settings.json` to add `--sandbox`. Then a worker's
commands run in Antigravity CLI's terminal sandbox: they stay off the network (except the sites your
`read_url` rules allow), and they can write only in the worker's folders and in temporary folders.
The sandbox is only for commands. It does not stop the worker's own file edits, which
`accept-edits` lets through in its folders. On Windows, the sandbox needs Windows 11 24H2 with the
August 2026 update or newer. On an older Windows, the setting does nothing. It is off unless you set
it.

The sandbox does not allow more commands by itself. But if your settings say
`"toolPermission": "proceed-in-sandbox"`, a worker may then run any command inside the sandbox.

### Let it run git and node

A worker runs no checks unless you allow the commands, in your own Antigravity settings file,
`%USERPROFILE%\.gemini\antigravity-cli\settings.json`. Add rules under `permissions`, for example:

```json
{
  "permissions": {
    "allow": ["command(git status)", "command(git diff)", "command(node)"],
    "deny": ["command(git push)"]
  }
}
```

- These rules count for every Antigravity session on this computer, not only for workers.
- `command(node)` lets it run any `node` command, also code that is not in a file (`node -e`).
- Do not allow `command(git)` or `command(*)`: then a worker could push, or run anything. A `deny`
  rule always wins over an `allow` rule.
- To let a reviewer read your worktrees, add a `read_file` rule for the worktrees folder, such as
  `"read_file(/Users/ada/projects/_worktrees/claude)"`. Write the path the way Antigravity compares
  paths: without the drive letter (`C:`), and with `/`.
- You can also add rules inside `agy`, with `/permissions`.

## Agent mail (optional)

In the Codex app, agents talk with the app's tools: the Colonel sends a Sergeant a message, and the
Sergeant wakes up and answers. Those tools stop working when you quit the app. Agent mail does the
same job with files in the mailbox and with the relay:

- An agent sends a message by name, for example
  `agent-mail.ps1 -Send -From 'Colonel' -To 'Sergeant Lark' -Text 'Start T-12.'`. It waits in
  `mail\sergeant-lark\new`.
- If the relay wakes that agent (step 2 below), it resumes the agent's session with a short
  note, the same way it wakes the planner. The session is a Codex thread, a Claude Code session or
  a Gemini CLI session. The agent reads its mail with `-Read`, does the work, and answers with
  `-Send`.
- An agent whose window is open reads its own mail. In a long task (a Codex goal) it runs
  `agent-mail.ps1 -Wait -Me '<its name>' -Seconds 50` where it used the app's `wait_threads`. The
  relay never wakes a thread that a window has open.

### Set it up

1. Update the relay in your mailbox (see [Update the relay in a mailbox](#update-the-relay-in-a-mailbox)).
   That copies `agent-mail.ps1` too.
2. Tell the relay which agents to wake. This part is for Codex agents, by the names their Codex
   threads have. For Claude Code and Gemini CLI agents, and for Codex agents with the relay's own
   rules, see [Agents in any AI tool](#agents-in-any-ai-tool). Stop the relay first, and start it
   again after:

   ```powershell
   .\bin\bridge-relay.ps1 -Stop
   .\bin\bridge-relay.ps1 -EnrollAgent -AgentName 'Sergeant Lark'
   .\bin\bridge-relay.ps1 -EnrollAgent -AgentName 'Sergeant Wren'
   .\bin\bridge-relay.ps1 -Start
   ```

   The relay finds the newest Codex thread with that name, and follows the name the same way as the
   planner wake (see [Roll sessions over](#roll-sessions-over)). Enrolling wakes nothing: mail that
   already waits counts as known, and the agent sees it the next time it reads its mail.
3. Let a woken Codex agent that has no profile write. A woken turn uses `codex exec`, which is
   read-only unless `codex_exec_args` in `bin\relay-settings.json` says otherwise. Reading and
   sending mail writes in the mailbox, so allow the mailbox folder:
   `["--sandbox", "workspace-write", "--add-dir", "C:\\Users\\ada\\mailbox"]`. An agent with a
   profile, and a Claude Code or Gemini CLI agent, needs no such setting: the relay sets it up.
4. Tell your agents. Each one needs to know its own name, the names of the others, and to use agent
   mail instead of the app's thread tools (`send_message_to_thread`, `wait_threads`).

### What the relay does

- It wakes an enrolled agent once for its new mail, but only while no program has the agent's
  session open: not the Codex app, not a `codex resume` or `claude --resume` window, not another
  relay turn. While a window has the session open, the relay waits. Quit the app or close the
  window fully to hand the session over.
- One turn at a time for each agent, and at most 3 agents at once
  (`relay_max_agent_turns_at_once` in `bin\cost-limits.json`).
- Up to 12 wakes a day for each agent (`relay_max_agent_wakes_per_day`).
- After 3 failed turns in a row, it stops waking that agent and writes an alert. Other wakes go on.
  Fix the cause, then run `-ClearHalt`.
- It holds mail that came after too many relay-woken turns in a row (see
  [Two agents that keep waking each other](#two-agents-that-keep-waking-each-other)).
- `-Status` lists the agents, how much new mail waits for each, and whether a window has one open.
- It never moves or deletes a message. The agents do that with `agent-mail.ps1`.

### Agent mail commands

Run them in the mailbox folder: `.\bin\agent-mail.ps1 <command>`. Names compare without case and
extra spaces, so `sergeant lark` is Sergeant Lark.

| Command                                         | What it does                                                                   |
| ----------------------------------------------- | ------------------------------------------------------------------------------ |
| `-Send -From <name> -To <name> -Text <text>`    | Sends a message. For several agents, separate the names with commas. For a long message, use `-TextFile <file>` (64 KB at most). A name that has no mail yet needs `-NewAgent` once, so a typo does not send mail nowhere. |
| `-Send ... -Box <id>`                           | Sends to an agent in another mailbox of the same HQ: `hq`, or a project id. See [Mail between mailboxes](#mail-between-mailboxes). |
| `-Read -Me <name>`                              | Prints the new mail, oldest first and 10 at a time, and moves it to `read`.    |
| `-Wait -Me <name> -Seconds <n>`                 | Waits up to n seconds (50 if you leave it out) for new mail, then reads it.    |
| `-List`                                         | Shows each agent, how much new mail waits, and whether the relay wakes it.      |

You can use it too. To send the Colonel a note:
`.\bin\agent-mail.ps1 -Send -From 'Ada' -To 'Colonel' -Text 'Please pause the website work.'`
Mail to you waits in `mail\<your name>\new`; read it with `-Read -Me '<your name>'`. Put the same
name in `owner_name` in `bin\relay-settings.json`, so Pleni knows that this mail is yours.

Read messages stay in each agent's `read` folder. You may delete old ones whenever you like.

### Mail between mailboxes

In HQ, an agent can write to an agent in another mailbox of the same HQ. Add `-Box` and that
mailbox's id: `hq`, or a project's id from HQ's `projects` list.

```powershell
.\bin\agent-mail.ps1 -Send -From 'Colonel' -To 'Sergeant Lark' -Box notes -Text 'Start T-12.'
```

- The message goes into the other mailbox's `mail` folder. That mailbox's own relay wakes the agent,
  so that relay must run.
- HQ reaches itself and each project that has a folder. A project reaches HQ and every project HQ
  lists, but only if `hq_dir` in its `bin\relay-settings.json` names an HQ that lists it. A project
  you added by hand without `hq_dir` has no `-Box`.
- `-Box` works with `-Send` only. Naming your own mailbox sends here, as without it.
- The message has a `Box:` line with the sender's own mailbox. The notice shows the sender as
  `Sergeant Wren (box notes)`. To answer, send again with `-Box` and that id.
- The name must already have mail in that mailbox, be an agent there, or be its `owner_name`.
  Otherwise add `-NewAgent`, as always.
- When it cannot send, `agent-mail.ps1` says why and ends with `Nothing was sent.` The common
  reasons: `-Box` is not `hq` or a project id, the mailbox is not part of an HQ, or there is no such
  mailbox.

Two rules keep this safe:

- A copy of `agent-mail.ps1` in a mailbox's `bin` folder serves only that mailbox. It refuses
  another `-MailboxRoot`. To reach another mailbox, use `-Box`.
- `agent-mail.ps1` writes and moves mail only in plain folders. If the mail folder, an agent's
  folder, or its `new` or `read` folder is a link, it refuses, and so does the relay when it checks
  an agent.

In a turn the relay starts for an agent with the relay's rules, `agent-mail.ps1` works only for that
agent. The relay tells it the agent's name, mailbox and folder, and the script refuses anything else:
another mailbox, another `-From` or `-Me`, `-NewAgent` (it may write only to names that have mail
there, or that wrote to it), and a `-TextFile` outside its own folder or behind a link.

### Mail for the planner

Agents can write to the planner too, and the relay wakes it for that mail. In HQ, the planner is
the orchestrator. Give it a mail name when you sign up its thread, with `-ThreadName`:

```powershell
.\bin\bridge-relay.ps1 -Stop
.\bin\bridge-relay.ps1 -EnrollCodex -ThreadName 'Planner'
.\bin\bridge-relay.ps1 -Start
```

- The thread's name is the mail name. The relay makes `mail\planner\new` and `read` for it.
  Agents write to it with `agent-mail.ps1 -Send -From 'Sergeant Wren' -To 'Planner' -Text '...'`.
- `-EnrollCodex -ThreadId` gives no mail name, so planner mail is off. A rollover keeps the name.
- A mail name must be 1 to 80 letters, digits, spaces or `. _ - # +`. It cannot be `owner`, `relay`,
  a name Windows keeps for itself, your `owner_name`, or an agent's name. If the name is no good,
  signing up still works, and `relay.log` says why mail does not wake the planner. An agent may not
  take the planner's mail name either: `-EnrollAgent` refuses it.
- Each new message is one item in `.relay\codex-attention.md`, such as "new mail for the planner from
  Sergeant Wren". The list never holds the message. Several items that wait together go in one
  wake. Each wake counts toward `relay_max_codex_wakes_per_day`. The relay never wakes the planner
  twice for the same message.
- The planner's note says how to read the mail and how to answer it, and that a mail is a request
  from an agent, never an order from you. A From line is not proof of who wrote a message.
- Mail that waits when you sign up counts as known and wakes nothing.
- `-Status` has a `Planner mail:` line. It says whether mail wakes the planner, or why it does not.

The planner's turn must be able to write in the mail folder, to move what it read:

- Start the planner's thread in the mailbox folder (in HQ, the HQ folder), and set `codex_exec_args`
  to `["--sandbox", "workspace-write"]`.
- If the thread works in another folder, the relay adds `--add-dir <mailbox>\mail` itself, but only
  with `workspace-write`, and only if that folder is there and its path is plain.
- A planner with the default read-only setting reads its mail, but cannot move it, so it shows
  again at the next read. It cannot answer either. The relay still never wakes it twice for one
  message.

### Two agents that keep waking each other

Two agents can wake each other for ever: each answer is mail that wakes the other. The relay stops
this with a count. Each message `agent-mail.ps1` writes in a relay turn gets a `Hop:` line. It is
the highest hop of the messages that woke that turn, plus 1. A message you write in your own window has no
Hop line.

- `relay_max_mail_hops` in `bin\cost-limits.json` is the most hops the relay follows. The usual
  number is 8. `0` means no limit.
- With the usual 8, turns 1 to 8 run. The message the 8th turn writes is held, and the 9th turn does
  not run.
- A held message stays in the agent's `new` folder. The agent still reads it when it next reads
  its mail, but the relay does not wake it for it. `relay.log` says `held`, and an alert says
  `Possible loop`, once a day for each agent. `-Status` shows how many are held.
- To let the agents go on, look first, then run `-ClearHalt`. The relay wakes the agent once more
  for the held mail, and the count starts again.
- A planner wake with mail also writes a hop, so a planner and an agent in a loop get held on the
  agent's side.

### What Pleni shows

With the mailbox turned on in Pleni, Pleni reads the `mail` folder too. It never sends mail.

- A line lights up between two tiles when mail goes from one to the other, mail with you
  included, and the Activity view lists each message: "Colonel sent mail to Sergeant Lark".
- When the relay wakes an agent for its mail, the line from the relay's tile to the agent lights
  up, and the Activity view says "Relay woke Sergeant Lark".
- A tile with mail waiting says "2 new messages" on its bottom edge. Click it to see since when, and
  whether the relay wakes it for its mail.
- Mail for you shows under **Needs you**. Your own side panel gives the command to read it, and the
  sender's side panel also gives the command to answer it.
- Pleni matches a mail name to a tile by the Codex thread the relay wakes for it, else by the
  session's name. Mail for `owner_name`, for `Owner`, or for your name in Pleni's Settings is yours.

## Agents in any AI tool

An agent is a session that has a name and gets mail. When mail waits for it, the relay wakes it for
one turn. An agent can be a Claude Code session, a Codex thread or a Gemini CLI session. Agents
from before this version are Codex agents, and they work as they did. Nothing changes until you
sign up an agent of a new kind. The mail commands are in [Agent mail](#agent-mail-optional).

### Sign up an agent

Stop the relay first, and start it again after. Enrolling wakes nothing: mail that already waits
counts as known, and the agent sees it the next time it reads its mail.

```powershell
# Codex, as before: no profile, and the relay finds the thread by its name
.\bin\bridge-relay.ps1 -EnrollAgent -AgentName 'Sergeant Lark'
# Codex with the relay's rules: -AgentProfile mail or files (-Model and -Effort are optional)
.\bin\bridge-relay.ps1 -EnrollAgent -AgentName 'Sergeant Lark' -AgentProfile mail
# Claude Code, by name: first type /rename Sergeant Wren in that session
.\bin\bridge-relay.ps1 -EnrollAgent -AgentName 'Sergeant Wren' -Tool claude -AgentFolder 'C:\Users\ada\agents\wren'
# Claude Code, by session id (the relay then follows no name)
.\bin\bridge-relay.ps1 -EnrollAgent -AgentName 'Sergeant Wren' -Tool claude -AgentFolder 'C:\Users\ada\agents\wren' -SessionId <the session id>
# Gemini CLI: the id is what /stats shows
.\bin\bridge-relay.ps1 -EnrollAgent -AgentName 'Sergeant Kit' -Tool gemini -SessionId <the session id>
```

- **Codex.** The relay finds the newest live Codex thread with that name, and its folder is the
  thread's folder. With no profile, the agent works as before: it uses `codex_exec_args` and
  Codex's own model. To give a Codex agent a model or an effort, give it a profile too. Codex has
  no `max` effort.
- **Claude Code.** `-AgentFolder` is the folder the session works in. Claude Code finds a session
  only from its own folder. With a name, the relay takes the newest session of that folder with
  that name. With `-SessionId`, it uses that session and follows no name. A Claude Code agent
  has the `mail` profile unless you give `-AgentProfile files`. `-Effort` may be `max`.
- **Gemini CLI.** `-SessionId` is needed. Gemini CLI has no effort setting. The agent's folder is
  the folder the session was started in (`-AgentFolder` names it if the relay cannot tell). Gemini
  CLI agents are off until you turn them on: see
  [Gemini CLI agents cost money](#gemini-cli-agents-cost-money).
- **`agent_tools`.** The setting `agent_tools` in `bin\relay-settings.json` says which tools may
  run agents. Claude Code and Codex are on by default. If you sign up an agent of a tool that is
  off, the relay says so and saves nothing.
- **Names.** An agent's name must be a plain mail name. It cannot be `owner`, `relay`, a name that
  Windows keeps for itself (such as `con` or `nul`), your own mail name, or the planner's mail name.
- **One job.** One session has one job. The relay refuses a session that is already the planner,
  a coordinator or another agent. The one old exception stays: the planner and a Codex agent with
  no profile may share one thread. Every new kind of agent gets a session of its own.
- **Closed sessions only.** The relay refuses a session that is open in a window, or that was
  written to in the last 90 seconds. Close it, wait, and try again.
- **Following a name.** A Claude Code agent signed up by name, and a Codex agent with a profile,
  follow a newer session with the same name, the way the coordinator does (see
  [Roll sessions over](#roll-sessions-over)). A Claude Code agent follows only inside its own
  folder. A Gemini CLI agent, and any agent signed up by id, never follows.
- **Wakes.** The relay wakes an agent only as [What the relay does](#what-the-relay-does) says.

To see what the relay would run for one agent, without running it:

```powershell
.\bin\bridge-relay.ps1 -ShowAgentArgs -AgentName 'Sergeant Wren'
```

It prints one agent's turn as JSON (the tool, session, folder, profile, and the command and rules
it would use) and changes nothing. To stop waking an agent, run
`.\bin\bridge-relay.ps1 -UnenrollAgent -AgentName 'Sergeant Wren'`. That keeps the agent's mail.
It first saves a copy of `.relay\agents.json` in `.relay\backups`. It removes the agent's two
Gemini files too, if it has them, but not while a turn of that agent still runs. It never stops a
turn that runs.

### The two profiles

- **`mail`** reads and sends mail. It changes no file.
- **`files`** may also change files, only in the agent's own folder.

A Claude Code agent's turn starts in the agent's folder. `mail` may read files and run its mail
commands. `files` may also use Edit and Write. Your own Claude Code settings, hooks, rules files
and add-on tools do not apply to the turn. The notice goes on the program's input, never on a
command line. A Gemini CLI agent runs with a rules file that the relay writes for it.

### What no agent may do

In an agent's turn, the relay lets it run only its own two mail commands:
`agent-mail.ps1 -Read -Me '<its name>'` and `agent-mail.ps1 -Send -From '<its name>' ...`.

- It never runs Git, Node.js, another AI tool or the web. Nobody can answer a question in its turn.
- It never writes in a mailbox, and never reads another mailbox's `mail` folder.
- It never changes an orders file or a settings file.
- `agent-mail.ps1` works only for that agent in its turn (see
  [Mail between mailboxes](#mail-between-mailboxes)). It sends only as the agent and reads only the
  agent's own mail.

For a Claude Code agent, these are on the list of what it may not do. Some are new in this
version:

- the web (`WebFetch` and `WebSearch`), and `curl`, `wget`;
- reading the Claude Code, Codex and Gemini folders, `.ssh`, and `.env` files;
- writing in any mailbox, and reading any mailbox's `mail` folder;
- the orders and settings files in its own folder (`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`,
  `.mcp.json`, and the `.claude` and `.git` folders);
- `git`, `gh`, `node`, `npm`, `npx`, another AI tool, PowerShell run with `-Command`, and `cmd`;
- `rm`, and these, which are new in this version: `rmdir`, `mkdir`, `touch`, `mv`, `cp` and `sed`.
  Claude Code's `acceptEdits` mode may let common file commands like these run in the working
  folder without a rule, so a `files` agent changes files only with its Edit and Write tools.

A Gemini CLI `files` agent may write only in its own folder, with its `write_file` and `replace`
tools. It may not write a path with `..`, an orders file, a `.gemini`, `.agents`, `.git`, `.codex`
or `.claude` folder, or a `.env` file. It has no web tools, no memory tool and no MCP.

The lists are a guard, not a sealed box. Keep an eye on what your agents do.

#### A Claude Code agent waits for money

Each Claude Code agent turn has a dollar cap (`-TurnBudgetUsd`, 1 unless you change it), and all
Claude Code agents together have a daily cap (`relay_max_agent_usd_per_day`, 5 unless you change
it). A turn also waits while the turns that already run could use the rest of the day's cap. The
mail stays where it is, and the relay sends the turn when they end. This wait raises no alert.

### The folder rules

An agent works in **a folder of its own**. The relay checks the folder when you sign the agent up,
and again before every turn, and says in plain words which rule it breaks. The most common ones:

- It must be a full path with a drive, to a folder that is there. Not a whole drive, a network
  folder, or a link (a shortcut to another place).
- It must not be a mailbox folder, or inside one (not `bin`, `tests`, `templates`, `tasks`,
  `mail`, `.relay` or `agents`). A mailbox's folders belong to its coordinator and planner.
- It must not be inside a Git repository. An agent works outside code repositories: workers do
  the code work.
- It must not be your home folder, your projects folder, the workers' worktrees folder, a folder
  that holds one of them, or a folder where an AI tool keeps its own files.
- It must not be HQ's folder, a project mailbox of HQ, the coordinator's folder, the planner's
  folder, or another agent's folder.
- It must not hold settings that could change the agent's rules: a `.codex` folder or an
  `AGENTS.override.md` for Codex; `.gemini`, `.agents` or a `.env` file for Gemini CLI; Claude Code
  settings with hooks for Claude Code.
- No folder above it may hold a `CLAUDE.md` (Claude Code) or a `GEMINI.md` (Gemini CLI), because
  the tool would read it as orders.
- For Claude Code and Gemini CLI agents, the mailbox's own path may hold only letters, digits and
  `. _ - ~`. A path with a space cannot host these agents: move the mailbox to a plain path. Avoid
  `~` too (see [Set up a new mailbox](#set-up-a-new-mailbox)).

And more: the relay says why.

### What each tool costs

| Agent in | What it costs |
| -------- | ------------- |
| Claude Code | Your Claude plan. A dollar cap for each turn and for each day. The cost goes into `.relay\dispatches.md`. |
| Gemini CLI | Money for every turn. Off until you turn it on. Four turns a day in all. |
| Codex | Your ChatGPT plan. Codex reports no cost. |

### Gemini CLI agents cost money

Gemini CLI needs a paid API key, Vertex AI or a work license, so every Gemini CLI agent turn costs
money. That is why these agents are off.

- **Turn them on.** Add `"gemini"` to `agent_tools` in `bin\relay-settings.json`, for example
  `"agent_tools": ["codex", "claude", "gemini"]`. Until then, signing up, waking and making a
  Gemini CLI agent are all refused, and the words say it costs money.
- **The total.** At most 4 Gemini CLI agent turns run in a day, for all Gemini CLI agents
  together. The first turns of new agents count too. Change it with `agent_wakes_per_day` in
  `bin\cost-limits.json`, such as `{"gemini": 4}`. `0` means no limit. The usual limits for each
  agent (12 a day) and at once (3) also apply. When the total is reached, mail waits until
  tomorrow, and the relay writes an alert.
- **The turn limit.** The relay asks Gemini CLI for 30 tool turns in one agent turn
  (`gemini_max_session_turns`). Gemini CLI may skip that. Then the turn has no limit from the
  relay. The relay writes one alert (once, not once for each turn) and says so in its log. To be
  sure of a limit, also set `model.maxSessionTurns` in your own Gemini settings
  (`%USERPROFILE%\.gemini\settings.json`).
- **Your key.** `GEMINI_API_KEY` goes to Gemini CLI as it is. The relay never writes it down.
- `-Status` says "Gemini CLI costs money for every turn." under each Gemini CLI agent.

**A known gap in short file names.** A Gemini CLI `files` agent's write rule matches the text of
a path. Windows may also give a file a short 8.3 name, such as `GEMINI~1.MD`, and a path may end
in a dot (`GEMINI.md.`). The rule does not match those, so such a name could reach the agent's
orders file. To close the gap, keep 8.3 short names off for the drive that holds agent folders
(`fsutil 8dot3name set C: 1` needs an administrator; `fsutil 8dot3name query C:` checks it), or
give the agent the `mail` profile, which has no write rule at all.

### A Codex agent can change files in its folder and the mail folders

A Codex agent's turn runs in Codex's `workspace-write` sandbox. The sandbox must let
`agent-mail.ps1` write the mail folders. So it cannot tell that from the agent's own writes. A
Codex agent, even with the `mail` profile, can still change files in its own folder and in the
mail folders, including another agent's mail. The `mail` profile only changes its notice: it tells
the agent to change no file itself. Give a mail agent in Codex a folder that holds nothing else.

What still holds for a Codex agent with a profile: no network and no web search; none of your own
Codex settings or command rules (`--ignore-user-config` and `--ignore-rules`); a `.codex` folder
or an `AGENTS.override.md` in its folder stops the agent; and the caps. For an agent that must
change nothing, use Claude Code or Gemini CLI. Give a Codex agent only work you trust it with.

The relay also checks a Codex agent's model and effort before each turn. A Codex CLI that is too
old stops with an "update Codex" message.

### Check on a real install before you turn on a new kind

The relay's own test uses fake programs. The rules for Claude Code and Gemini CLI agents work
through real programs that change. Before you trust a new kind of agent, check these on your own
computer, with an agent that has nothing you care about:

- `claude -p --resume` with the notice on its input delivers one message, and the exact mail rule
  with the agent's name in single quotes is allowed, in both path forms (`C:/` and `C:\`).
- A command that is not on the list, a chained command, and a `$( )` are all refused.
- With `acceptEdits`, the file commands that the list refuses (`mkdir`, `touch`, `rm`, `rmdir`,
  `mv`, `cp`, `sed`) are refused.
- On Windows, Claude Code may also offer a PowerShell tool. The relay's turn gives it only the
  tools Read, Edit, Write, Glob, Grep and Bash, and every rule is a Bash rule. Check that the
  turn offers no PowerShell tool.
- A Gemini CLI agent may run its own mail commands, and `powershell -Command` is refused.

### Why not Antigravity CLI agents yet

You cannot sign up an agent in Antigravity CLI yet. `-EnrollAgent -Tool antigravity` says so.
The reasons:

- An agent must run `agent-mail.ps1` in every turn. Antigravity CLI has no rules file for one run.
  It can allow a command only in your own Antigravity settings, and that counts for every
  Antigravity session on this computer.
- Google's consumer terms may not allow other programs to run Antigravity CLI, and your Google
  account could be suspended or closed. An agent may take 12 turns a day, every day, so the risk
  grows with each turn.
- Its way to pick up a saved conversation for one run is not proven.
- There is no way to tell that a conversation is open in a window.
- Pleni cannot show it yet.

### Your Gemini AI Pro plan works for Antigravity workers today

If you have a Gemini AI Pro plan, it signs in to Antigravity CLI. Antigravity workers already
exist and use it. They are off by default and carry the same risk warning: see
[Antigravity workers](#antigravity-workers-off-by-default).

## New agents

A planner, HQ's orchestrator or a Claude Code coordinator can ask the relay to make a new agent.
The relay makes its folder and its orders file, runs one first turn, and then signs it up. It is
off until you turn it on.

### Turn it on

Add `"allow_new_agents": true` to `bin\relay-settings.json`. Write `true` with no quotes: the text
`"true"` does not count. Then also check `agent_tools`, which says which tools a new agent may use.
Set `projects_dir` too, because a new agent's folder must be inside the projects folder. In HQ,
each project turns it on in its own `bin\relay-settings.json`: HQ's setting covers only HQ's own
`agents` folder.

While it is off, the relay still reads each request, and refuses it, with the reason in the result
file. Turn it on first, then ask. Turning it on also turns on the guard that watches the relay's own
files (see [What makes the relay stop, and why](#what-makes-the-relay-stop-and-why)).

### Who may ask

- The planner, if its sandbox can write in the mailbox's `agents` folder (start its thread in the
  mailbox folder, with `workspace-write`).
- HQ's orchestrator, in HQ's own `agents` folder or in a project's.
- A Claude Code coordinator.

A Codex or Gemini CLI coordinator cannot ask. Its sandbox or its rules file allows no write in
`agents`. It asks the planner in `questions.md` instead.

### How to ask

1. Copy `templates\agent-request.md` to `agents\<key>.md` in the mailbox. Make the `agents`
   folder first: the relay never makes it. The `<key>` is the agent's name in small letters, with
   each run of other marks as one `-`. `Sergeant Wren` becomes `agents\sergeant-wren.md`. A file name
   with a capital letter is ignored, and gets no answer.
2. Fill in the fields at the top: `Name`, `Tool` (`claude`, `codex` or `gemini`), `Profile`
   (`mail` or `files`; empty means `mail`), `Folder`, `Model`, `Effort` and `Requested by`. Only
   `Name` and `Tool` are needed. A field line that is there twice: the last one wins.
3. Under `## Standing orders`, write what the agent does, in plain words. The relay puts it in the
   agent's orders file, after its own part about mail and what the agent may do. Mail is the only
   way the agent hears from others.

The file may be 32 KB at most, and the orders 16 KB at most. `Folder` may stay empty. The relay
then makes `<projects_dir>\_mail-agents\<key>`. If you give a folder, it must be a full path inside
the projects folder, and new or empty, so no settings, hooks or orders files are in it. All the
folder rules above apply too.

The relay reads a version of the file once it is 20 seconds old, and makes each version at most
once. A request that is already in `agents` the first time the relay looks counts as known, and
never runs. A link in place of the file or of the folder is refused.

### What the relay writes back

The relay writes `agents\<key>.result.md`. It has the version, the outcome, the time, and a short
sentence. Nothing wakes the asker for it, so the asker reads the file in a later turn. The four
outcomes:

- **made.** The first turn went well, so the agent is signed up. From now on, its mail wakes it.
  Mail that already waited for it wakes it too.
- **refused.** The relay did not make it, and says why. This is final for that version.
- **failed.** The first turn made no session. This is final for that version.
- **unknown.** The first turn ran, but the relay could not be sure that the right session was
  made. Nothing is signed up. If the session is right, sign it up yourself with `-EnrollAgent`.

To ask again after one that is not `made`, change the file. The relay does not try the same version
twice. The relay also writes an alert for each outcome.

### Why a request is refused

The most common reasons:

- New agents are off, or the tool is off (`agent_tools`).
- The file is not in the shape the relay reads: no `## Standing orders` part, a field line it
  cannot read, a missing `Name` or `Tool` line, or a file that is too large.
- The name is not allowed, is already an agent, or does not match the file name.
- The folder breaks a rule, or is not empty, or is not inside the projects folder.
- The daily limit is reached: new agents (`relay_max_new_agents_per_day`), Gemini CLI turns
  (`agent_wakes_per_day`), or Claude Code agent money (`relay_max_agent_usd_per_day`).

The relay says which one in the result file.

### Why a request waits

A waiting request is not refused. The relay tries again, and says why it waits in its log, once
for each reason:

- The relay is paused or halted.
- Three first turns in a row did not make an agent. New agents stop until you check
  `.relay\alerts.md` and run `-ClearHalt`.
- A coordinator turn runs. New agents are made between coordinator turns.
- Another new agent is being made. One at a time.
- Three agent turns already run (the limit at once).
- Claude Code agent turns that run now could use the rest of the day's dollar cap. The new agent
  is made after they end.

### The limits

- **2 a day.** `relay_max_new_agents_per_day` in `bin\cost-limits.json` (0 to 20; `0` means no
  limit). `-MaxNewAgentsPerDay <n>` sets it for one run.
- **One at a time.**
- **Three in a row.** Three failed first turns in a row stop new agents until you run
  `-ClearHalt`. A refusal does not count. A made agent starts the count again.
- A first turn counts as an agent turn: it counts toward the agent's 12 a day, the 3 at once, the
  Gemini CLI total, and the dollar cap of Claude Code agents.

### What the relay makes

1. It saves its plan first (the day's count goes up here).
2. It makes the agent's folder.
3. It writes the agent's orders file: `CLAUDE.md`, `GEMINI.md` or `AGENTS.md`, with the relay's
   own part and then your orders.
4. It runs one first turn there. The agent only says hello, changes nothing, and sends no mail.
5. If that went well, it signs the agent up. A made Claude Code agent follows a newer session with
   its name only if Claude Code wrote the name and the session is in the agent's folder. A made
   Codex or Gemini CLI agent never follows a name.

The relay remembers a fingerprint of the orders file. If the file changes later, the agent's wakes
stop, with an alert. Look at the file. If the change is right, run `-ClearHalt` to accept the file
as it is now.

### Known small gaps

- A request file name with a capital letter is ignored, with no answer.
- The alert for an `agents` folder that is a link comes only once.
- A refusal is final for that version. Change the file to ask again.
- A folder write that fails after the relay saved its plan still uses one of the day's slots.
- `-DryRun` does not run the whole check that comes before an agent turn.
- A request that is already in `agents` the first time the relay looks counts as known, and never
  runs.
- `-UpdateProjects` does not copy templates. A project mailbox made before this version does not
  have `templates\agent-request.md`. Copy it by hand. `-NewProject` copies it.

## Run several projects (HQ)

One relay runs for each mailbox. With **HQ**, one Codex thread, the **orchestrator**, is the planner
for several mailboxes at once:

- Each **project mailbox** is a normal mailbox. It has its own relay, coordinator, limits, `PAUSE`
  file and halts.
- **HQ** is a mailbox too. Its settings list the projects. Only the HQ relay wakes the orchestrator:
  once for the new items that wait in HQ or in any project, with up to 10 items in one wake. Each
  item names its project and that project's mailbox folder.
- A project's item waits while a coordinator turn runs in that project. The other projects' items
  still go. There is never more than one orchestrator turn at a time.
- HQ only reads the projects' files. It writes there only when you run `-NewProject`,
  `-UpdateProjects` or `-StopAll`.

1. **Turn a mailbox into HQ.** Set up a mailbox as in [Set up a new mailbox](#set-up-a-new-mailbox).
   Copy `relay\ORCHESTRATOR.md` into it as `AGENTS.md`, so the orchestrator reads its orders. Then
   add `"role": "hq"` and `"projects": []` to its `bin\relay-settings.json` (see
   `bin\relay-settings.hq.example.json`). To let the orchestrator write in the projects, also set
   `"codex_exec_args": ["--sandbox", "workspace-write"]`. The relay then adds each project's folder
   to the orchestrator's turns (with `--add-dir`).
2. **Enroll the orchestrator.** Start a Codex thread in the HQ folder and name it `Orchestrator`.
   Then, in the HQ folder:

   ```powershell
   .\bin\bridge-relay.ps1 -EnrollCodex -ThreadName 'Orchestrator'
   ```

3. **Make each project.** In the HQ folder:

   ```powershell
   .\bin\bridge-relay.ps1 -NewProject -ProjectId notes -ProjectName 'Notes'
   ```

   This makes the folder `projects\notes` in HQ, or the empty folder you name with
   `-ProjectFolder`. It copies the relay, the tests, the templates, `README.md` and `CLAUDE.md` from
   HQ, and makes `tasks`, `CODEX-QUEUE.md` and `STATUS.md`. The project's settings are HQ's, without
   `role` and `projects`, and with `hq_dir`. So a project made from an HQ that has `allow_new_agents`
   on, or a changed `agent_tools`, has them too, and it gets HQ's cost limits. The templates come
   along, `agent-request.md` too. Then it adds the project to HQ's `projects` list, and
   keeps a copy of the old settings as `relay-settings.json.bak-<time>`. It refuses an id that HQ
   already has, and a folder that is not empty.

   `-NewProject` changes HQ's own settings. While HQ's relay runs with its guard on (see
   [What makes the relay stop, and why](#what-makes-the-relay-stop-and-why)), it refuses and says: "HQ's relay is running
   and watches its own settings. Run -StopAll first, then -NewProject, then -StartAll." It also
   refuses while a coordinator turn of HQ still runs, or has ended and is not settled yet (wait for
   `-Status` to show none, or use `PAUSE` and `-Once` to settle it). With the guard off, the step
   it prints (run `-StopAll`, then `-StartAll`) still applies.

   You may also add a mailbox you already have to `projects` by hand. Then also set `hq_dir` to
   HQ's folder in that mailbox's `bin\relay-settings.json`, or the project's checks of HQ's
   orchestrator thread and HQ's folders are off, and `-Box` does not work there. What already waits in a new project counts as
   known, so adding a project wakes nothing.
4. **Enroll each project's coordinator** in that project's own folder, as in step 2 of
   [Start the relay](#start-the-relay). Never enroll the orchestrator's thread in a project (with
   `-EnrollCodex` or `-EnrollAgent`). If a project wakes the same thread, HQ stops waking the
   orchestrator and writes an alert that says which command to run in that project.
5. **Start and stop them all** from the HQ folder:

   ```powershell
   .\bin\bridge-relay.ps1 -StartAll
   .\bin\bridge-relay.ps1 -StopAll
   ```

   `-StartAll` opens a new PowerShell window for each project's relay that does not run yet, then
   runs HQ's own relay in this window. `-StopAll`, from another window, asks every relay to stop,
   HQ's too. It never cuts off a turn that runs.
6. **Update them all.** Update HQ as in [Update the relay in a mailbox](#update-the-relay-in-a-mailbox)
   (with `-StopAll` in place of `-Stop`). Then, in the HQ folder:

   ```powershell
   .\bin\bridge-relay.ps1 -UpdateProjects
   .\bin\bridge-relay.ps1 -StartAll
   ```

   `-UpdateProjects` copies HQ's scripts (`bin\*.ps1` and `tests\stub-*.js`) into each project, and
   keeps each file it replaces as `<name>.bak-<time>`. It never copies settings, templates,
   `README.md` or `CLAUDE.md`. It skips a project whose relay runs, and says so.

   Because it copies no templates, a project made before this version has no
   `templates\worker-start.md`, which the notices of a Codex or Gemini CLI coordinator point to, and
   no `templates\agent-request.md`, which a request for a new agent starts from. Copy them into each
   project that lacks them (change the folder to HQ's):

   ```powershell
   $hq = 'C:\Users\ada\hq'
   $settings = Get-Content "$hq\bin\relay-settings.json" -Raw | ConvertFrom-Json
   foreach ($p in @($settings.projects)) {
     $t = "$($p.mailbox)\templates"
     New-Item -ItemType Directory -Force $t | Out-Null
     foreach ($f in 'worker-start.md', 'agent-request.md') {
       if (-not (Test-Path "$t\$f")) { Copy-Item "$hq\templates\$f" $t }
     }
   }
   ```

In HQ, `-Status` and `-DryRun` list each project: whether its folder was found, how many items wait
in it, and whether its relay runs. HQ's `.relay\codex-attention.md` has a Project column, where `hq`
is HQ itself. The HQ relay reads its settings when it starts, so after a change to `projects`, stop
it and start it again.

## Roll sessions over

Starting a fresh session now and then keeps each turn small and cheap. If you enrolled by name
(`-Enroll -SessionName`, `-Enroll -Tool codex -ThreadName`, `-EnrollCodex -ThreadName`), the relay follows the name. Give the new
session the same name, and the relay switches to it on its own. You type no ids and run no
commands.

- **Which session:** the newest one with that name. For a Claude Code coordinator, only Claude Code
  sessions of its working folder count. For a Codex coordinator and for the planner, only live Codex
  threads count, not archived ones.
  - A newer Codex thread takes over as the coordinator only if four things are true. Its folder
    passes the rules for a coordinator's folder (that includes this: no `AGENTS.md` or
    `AGENTS.override.md` is in a folder above it, inside its Git repository). It has no `.codex`
    folder or `AGENTS.override.md`. It has no other job. Its folder holds `AGENTS.md`.
  - Otherwise the relay says why in `relay.log` (once for each thread and each reason, so a new reason is
    told too) and keeps the old thread.
  - Put `AGENTS.md`, a copy of `relay\COORDINATOR.md`, in the new thread's folder **before** you give
    the new thread the name. Until it is there, the relay keeps the old thread. (Once the relay
    follows a thread, it guards that file, so a copy made afterwards would halt the relay.)
  - A Gemini CLI coordinator does not follow a name: Gemini CLI sessions have no names.
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
`-EnrollCodex` again after each new session. A Gemini CLI coordinator is always enrolled by id.

## Update the relay in a mailbox

1. Stop the relay: `.\bin\bridge-relay.ps1 -Stop`. Then run `-Status`. If it lists a turn in
   flight, wait until it says `alive False`. Then, with the old scripts still in place, make an
   empty file named `PAUSE` in the mailbox's `.relay` folder, run `.\bin\bridge-relay.ps1 -Once`
   (it settles the turn and starts nothing), and delete `PAUSE`. Now `-Status` says
   `In flight: none`. If a coordinator turn is still running when you change a script, the relay
   halts itself when you start it again, but only while its guard is on (see
   [What makes the relay stop, and why](#what-makes-the-relay-stop-and-why)).
2. Get the new version. In your Pleni folder, run `git pull`.
3. Copy the scripts into the mailbox (change the two folders to yours):

   ```powershell
   $repo = 'C:\Users\ada\pleni'
   $mb   = 'C:\Users\ada\mailbox'
   Copy-Item -Force "$repo\relay\bin\*.ps1" "$mb\bin\"
   Copy-Item -Force "$repo\relay\tests\stub-*.js" "$mb\tests\"
   foreach ($f in 'worker-start.md', 'agent-request.md') {
     if (-not (Test-Path "$mb\templates\$f")) { Copy-Item "$repo\relay\templates\$f" "$mb\templates\" }
   }
   ```

4. If `worker_tools` lists `codex`, or a Codex coordinator is signed up: Codex now needs a newer
   Codex command line (April 2026 or newer). Run `codex exec --help`. If it does not list
   `--ignore-user-config`, update Codex with `npm install -g @openai/codex`. Codex also no longer
   uses your `config.toml` extras, command rules or web search, and needs Codex's Windows sandbox
   set up (see [A coordinator in Codex or Gemini CLI](#a-coordinator-in-codex-or-gemini-cli-optional)).
5. Start it again: `.\bin\bridge-relay.ps1 -Start`.

This copies only the scripts, and the start request template and the new agent request template if
your mailbox does not have them yet. Your settings files, your other templates, and the
coordinator's files stay as they are.

**Nothing changes in an old mailbox until you use a new part.** The new limits have usual numbers,
so no file edit is needed. These need a step from you:

- **Agents, and new agents.** Follow [Agents in any AI tool](#agents-in-any-ai-tool) and
  [New agents](#new-agents). Every mailbox that uses agent mail needs the new `agent-mail.ps1` (the
  lines above copy it). An old copy has no `-Box` and none of the rules for an agent's turn.
- **Mail for the planner.** A `codex.json` from before this version has no mail name. Stop the
  relay and sign up the planner again with `-EnrollCodex -ThreadName '<its name>'`. The relay keeps
  a copy of the old file in `.relay\backups`.
- **The agent request template in project mailboxes.** `-UpdateProjects` copies scripts only. Copy
  `templates\agent-request.md` into each existing project by hand (see step 6 of
  [Run several projects](#run-several-projects-hq)).

Never copy `COORDINATOR.md` over a mailbox's `CLAUDE.md`, or the templates over the mailbox's
`templates` folder. Over time a mailbox gets orders and brief fields of its own (who reports to whom,
their addresses, exceptions the owner made), and a copy would lose them. To get a new order, add
just that order to the end of your orders file.

The newest order in `COORDINATOR.md` is order 16, "New agents (Claude Code coordinators only)". Only
a Claude Code coordinator can write an agent request, so the lines below add it to `CLAUDE.md` and
to no other file. Order 15, "If you are a Codex thread or a Gemini CLI session", is only for a Codex
or Gemini CLI coordinator. Orders 6, 9, 12 and 15 also have new words in `COORDINATOR.md`. The lines
do not change them. Edit them by hand if you want the new words. (If order 16 gets another number
in your `CLAUDE.md`, change the words "rule 16" in your order 6 to match.)

The lines keep a copy of each file as `<name>.old` first, and do nothing for a file that already has
the order. They add the newest order. To add an older one, set `$want` to a part of its title, such
as `'Choose the AI tool for each worker'` (order 14), and set the two choices that follow. `$toClaude`
adds the order to `CLAUDE.md`, and `$next` is the next free order number there. `$toOthers` adds it
to the `AGENTS.md` or `GEMINI.md` in the coordinator's folder, if a Codex or Gemini CLI coordinator
is enrolled (`.relay\coordinator.json` says `codex` or `gemini`), and `$nextCoordinator` is the next
free number there. Order 14 is for every coordinator: set both to `$true`. Order 15 is only for
`$toOthers`. Run the lines while the relay is stopped: its guard halts a running relay when a
coordinator's orders file changes.

```powershell
$repo  = 'C:\Users\ada\pleni'     # change these two to your folders
$mb    = 'C:\Users\ada\mailbox'
$want  = ''                      # '' adds the newest order (order 16). Or part of an order's title, such as 'Choose the AI tool for each worker'
$toClaude = $true                # add it to CLAUDE.md (order 16 and order 14, not order 15)
$toOthers = $false               # add it to AGENTS.md or GEMINI.md (order 14 and order 15, not order 16)
$next  = 15                      # the next free order number in your CLAUDE.md
$nextCoordinator = 16            # the next free order number in AGENTS.md or GEMINI.md
$src   = @(Get-Content "$repo\relay\COORDINATOR.md")
$starts = @($src | Select-String -Pattern '^\d+\. \*\*' | ForEach-Object { $_.LineNumber - 1 })
$pick = $starts.Count - 1
if ($want) {
  $pick = -1
  for ($i = 0; $i -lt $starts.Count; $i++) { if ($src[$starts[$i]].Contains($want)) { $pick = $i } }
  if ($pick -lt 0) { throw "No order in COORDINATOR.md has '$want' in its title." }
}
$last = $src.Count - 1
if ($pick -lt $starts.Count - 1) { $last = $starts[$pick + 1] - 1 }
$order = $src[$starts[$pick]..$last]
$title = [regex]::Match($order[0], '\*\*(.+?)\*\*').Groups[1].Value
$orders = @()
if ($toClaude) { $orders += @{ file = "$mb\CLAUDE.md"; next = $next } }
$coordFile = "$mb\.relay\coordinator.json"
if ($toOthers -and (Test-Path $coordFile)) {
  $c = Get-Content $coordFile -Raw | ConvertFrom-Json
  if ($c.tool -eq 'codex')  { $orders += @{ file = (Join-Path $c.cwd 'AGENTS.md'); next = $nextCoordinator } }
  if ($c.tool -eq 'gemini') { $orders += @{ file = (Join-Path $c.cwd 'GEMINI.md'); next = $nextCoordinator } }
}
foreach ($o in $orders) {
  $file = $o.file
  if (-not (Test-Path $file)) { "Not there, skipped: $file"; continue }
  if (Select-String -Path $file -Pattern $title -SimpleMatch -Quiet) {
    "$file already has: $title"
  } else {
    Copy-Item -Force $file "$file.old"
    $text = $order.Clone()
    $text[0] = $text[0] -replace '^\d+\.', "$($o.next)."
    [IO.File]::AppendAllText($file, "`r`n" + ($text -join "`r`n") + "`r`n")
    "Added order $($o.next) to ${file}: $title"
  }
}
```

In HQ, `ORCHESTRATOR.md` has new orders 11, "Never wake a project's coordinator yourself", 12, "Mail
for your name", and 13, "New agents". Add what is missing by hand to the end of HQ's `AGENTS.md`,
while the HQ relay is stopped. Order 6 has new words too, about `agents\<key>.md`.

If the new order names a line for the worker brief, add that line to your own
`templates\worker-brief.md` by hand. For the model and effort order, put this under the branch and
base commit lines:

```markdown
- **Model and effort:** <model>, <effort>   (why: <one line>)
```

For the AI tool order, put this under the model and effort line:

```markdown
- **Tool:** claude | codex | gemini | antigravity   (only a tool that worker_tools in bin\relay-settings.json lists)
```

The brief's template (`templates\worker-brief.md`) has new words for start requests. Copy them by
hand if you want them:

- The first line now says "(owner: coordinator)".
- The Branch line has a note: "already created, or made by the launcher for a start request with
  New worktree: yes; do not create or switch branches".
- The Base commit line has a note: "needed for New worktree: yes".

Then tell the coordinator to read its orders file again (`CLAUDE.md`, `AGENTS.md` or `GEMINI.md`),
or roll it over: a new session always reads it. Order 12 (GitHub) stays in your `CLAUDE.md` as it
is. A Codex or Gemini CLI coordinator never uses it.

## Test it

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File bin\bridge-relay-check.ps1
```

It takes about 16 minutes. It builds fake mailboxes in your temp folder, runs the relay, agent mail
and the worker launcher against them with a fake Claude, a fake Codex, a fake Gemini CLI and a fake
Antigravity CLI, and removes them at the end. It covers a coordinator in Codex and in Gemini CLI,
start requests and the guard on the relay's own files too. It never touches a real mailbox or a real session, and it costs nothing.
It needs Git, for a fake worktree. Each pull request to this repository runs it on Windows too.

The test sets two variables that only the test uses: `RELAY_TEST_GEMINI_POLICY_DIR` and
`RELAY_TEST_CHANGE_POLICY`. The worker launcher reads them, and so does the relay for a Gemini CLI
coordinator. Each one can only make the launcher refuse to start a Gemini worker, or make the relay
stop. Never set them yourself.

## Safety

The relay:

- wakes only the sessions you enrolled: the coordinator, the planner, and the agents you enrolled
  for mail, with one turn at a time for each. It also wakes an agent it made, but only while
  `allow_new_agents` is `true`;
- wakes agents of a tool only if `agent_tools` lists it (Gemini CLI agents cost money, so they are
  off until you list `gemini`);
- wakes a Codex thread only if you enrolled it, never while another program has it open, and never
  with an option that turns the Codex sandbox off;
- never wakes a session that looks open in another window, and never stops or kills a process;
- keeps its own notes in the mailbox's `.relay` folder, with no secrets and no copies of the
  conversation, and writes only a few other things: the planner's mail folders when you sign up its
  mail name, the result file for a request for a new agent, the folder and orders file of an agent
  it made (inside your projects folder), and copies of its own records in `.relay\backups`. It
  never writes through a link;
- writes agent mail only under a mailbox's `mail` folder (another mailbox's too, with `-Box`), and
  holds mail that comes after too many relay-woken turns in a row (`relay_max_mail_hops`);
- lets an agent run only its own two mail commands, and `agent-mail.ps1` works only for that agent
  in its turn;
- makes a new agent only when `allow_new_agents` is `true`, never more than
  `relay_max_new_agents_per_day` a day, and never more than one at a time;
- in HQ, only reads the project mailboxes, except when you run `-NewProject`, `-UpdateProjects` or
  `-StopAll`;
- installs nothing: no service, no scheduled task, and no registry entry;
- gives each coordinator turn a fixed list of commands it may run, and a list it may not. The
  coordinator may not change the relay's own files, and a worker may not push or merge. These
  lists are a guard, not a sealed box, so keep an eye on what the sessions do;
- starts a worker in Codex, Gemini or Antigravity only when `worker_tools` lists that tool, never
  more of them in a day than `worker_runs_per_day` allows, and a Gemini worker only with the relay's
  own policy;
- wakes Claude Code agents only while they have not used `relay_max_agent_usd_per_day` for the day
  (and the turns that already run could not use the rest of it), and Gemini CLI agents only up to
  `agent_wakes_per_day` in all;
- runs a Codex or Gemini CLI coordinator only in a folder of its own;
- runs a Codex coordinator and Codex workers only without your own Codex settings and command
  rules, with no network and no web search (see
  [A coordinator in Codex or Gemini CLI](#a-coordinator-in-codex-or-gemini-cli-optional));
- starts a worker for a start request only after it checked the request, never the same version
  twice, and never more than `relay_max_worker_starts_per_day` allows;
- while its guard is on (a Codex or Gemini CLI coordinator, start requests, new agents, or an agent
  with the relay's rules), stops itself and tells you when one of its own files changes. It stops an
  agent that finds something it must not run with, or whose orders file changed (see
  [What makes the relay stop, and why](#what-makes-the-relay-stop-and-why));
- never reads, copies or writes the login of an AI tool that runs a worker, and never changes that
  tool's own settings files.

## Costs

Each coordinator turn and each worker run uses your Claude plan. The relay writes the cost the
Claude Code command reports into `.relay\dispatches.md` and each task's `workers\runs.md`. These
numbers are estimates from Claude Code, not bills.

That holds for a Claude Code coordinator. A Codex coordinator turn uses your ChatGPT plan, and a
Gemini CLI coordinator turn costs money on your own Gemini login. Neither tool reports a cost, so
the dollar caps (`--max-budget-usd` and the daily dollar cap) apply only to Claude Code turns.
Every coordinator turn, in any tool, counts toward `relay_max_wakes_per_day`. A Gemini CLI turn also
has a turn limit that Gemini CLI may skip: see
[the turn limit](#the-turn-limit-of-a-gemini-cli-coordinator). Workers that start for start requests
count toward `relay_max_worker_starts_per_day`, and Codex, Gemini and Antigravity workers toward
`worker_runs_per_day` as well.

Each planner turn and each Codex agent turn the relay starts uses your ChatGPT plan. It gets a
line in `.relay\dispatches.md` too, without a cost, because Codex does not report one. A planner
wake for mail counts toward `relay_max_codex_wakes_per_day`. What a Claude Code agent or a Gemini
CLI agent costs is in [What each tool costs](#what-each-tool-costs).

Every agent turn, in any tool, counts toward `relay_max_agent_wakes_per_day` and toward its tool's
`agent_wakes_per_day`. The turns of all Claude Code agents together also count toward
`relay_max_agent_usd_per_day`, not toward the coordinator's daily dollar cap. The first turn of a new
agent counts like any other, and each new agent counts toward `relay_max_new_agents_per_day`.

A Codex worker uses your ChatGPT plan too. A Gemini worker costs money for every run. An Antigravity
worker uses your Google plan (or your Gemini API key, if you set Antigravity CLI up with one). Their
lines in `runs.md` show the tokens they used, without a cost, because none of these tools reports
one.
