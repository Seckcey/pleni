# Mailbox protocol

This folder is how three kinds of AI sessions work together: a **planner** (Codex), a
**coordinator** (a Claude Code session, a Codex thread or a Gemini CLI session) and the
coordinator's **workers** (worker sessions in Claude Code, or in Codex, Gemini CLI or Antigravity
CLI if the owner turns them on). It is plain Markdown on disk.
There is no tracker and no network.

In a mailbox, this file is called `README.md`. The relay tells the coordinator to read it.

## Roles

| Role        | Who                    | Does                                                                                                                                                                                                                  | Never does                                                                                       |
| ----------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Planner     | Codex                  | Assigns tasks, answers questions, reviews handoffs, and accepts or returns work. Owns pushes, merges, release notes and the tracker, except the coordinator's narrow GitHub rule (rule 12 in `CLAUDE.md`).          | Edit files that the coordinator or a worker owns.                                                |
| Coordinator | A Claude Code session, a Codex thread or a Gemini CLI session | Reads assignments, checks the repository, makes an isolated worktree and branch, briefs and supervises workers, answers routine in-scope worker questions, reviews their diffs, runs checks, reports status, asks the planner the questions that matter, writes handoffs. | Write app code, push (except rule 12), merge, mark a pull request ready, deploy, touch the tracker, or edit planner-owned files. |
| Worker      | An AI tool's session (Claude Code, Codex, Gemini CLI or Antigravity CLI) | Makes the code change inside its worktree and file scope, runs the named checks, commits locally, and writes its report.                                                                                             | Leave its worktree or file scope, push, merge, deploy, or edit any other file here.              |

## Golden rule: one writer per file

Every file has exactly one owner. Read anything; **write only the files you own.** This is what
makes it safe for everyone to work at the same time.

| Path                                                   | Owner                                     |
| ------------------------------------------------------ | ----------------------------------------- |
| `CODEX-QUEUE.md`                                       | Planner                                   |
| `tasks/<TASK-ID>/assignment.md`                        | Planner                                   |
| `tasks/<TASK-ID>/answers.md`                           | Planner                                   |
| `tasks/<TASK-ID>/review.md`                            | Planner                                   |
| `STATUS.md`                                            | Coordinator (a Codex coordinator keeps it in its own folder; the relay copies it here) |
| `tasks/<TASK-ID>/status.md`                            | Coordinator                               |
| `tasks/<TASK-ID>/questions.md`                         | Coordinator                               |
| `tasks/<TASK-ID>/handoff.md`                           | Coordinator                               |
| `tasks/<TASK-ID>/workers/W<n>-brief.md`                | Coordinator                               |
| `tasks/<TASK-ID>/workers/W<n>-start.md`                | Coordinator (a start request; see "Workers") |
| `tasks/<TASK-ID>/workers/W<n>-report.md`               | That worker only                          |
| `tasks/<TASK-ID>/workers/W<n>.log`, `W<n>.run.json`, `runs.md` | The worker launcher (machine-written) |
| `README.md`, `CLAUDE.md`, `templates/`                 | Coordinator (changes asked for by the planner in `CODEX-QUEUE.md`). A Codex or Gemini CLI coordinator cannot change these: it writes a `NEEDS` note for the owner. |
| `bin/`, `tests/`, `.relay/`                            | The owner and the relay; sessions never edit them |
| `mail/<agent>/new/`, `mail/<agent>/read/`              | `bin/agent-mail.ps1` only; never edit a message by hand |

Add new entries at the **bottom** of a file, with a time stamp (`YYYY-MM-DD HH:MM`, local time).
Never rewrite someone else's history.

## Layout

```
README.md            this protocol
CLAUDE.md            standing orders for the coordinator (a Codex or Gemini CLI coordinator reads a copy,
                     AGENTS.md or GEMINI.md, in its own folder)
CODEX-QUEUE.md       planner -> coordinator: task list, priorities, cancellations, standing orders
STATUS.md            coordinator -> planner: one line per task, active worktrees, a "Needs Codex" list
templates/           blank copies of the task files below
tasks/
  T-YYYYMMDD-NN-slug/
    assignment.md    planner: the brief (repository, base ref, scope, acceptance, checks, limits)
    status.md        coordinator: running log of progress and state changes
    questions.md     coordinator: numbered questions for the planner (Q1, Q2, ...)
    answers.md       planner: answers keyed to question numbers (A1, A2, ...)
    handoff.md       coordinator: the final result, for the planner's review
    review.md        planner: ACCEPTED, RETURNED (with required changes) or CANCELLED
    workers/
      W1-brief.md    coordinator -> worker: exact scope and rules
      W1-start.md    coordinator -> relay: please start this worker (a start request; optional)
      W1-report.md   worker -> coordinator: what it did, a diff summary, check output
coordinator/         optional: the folder of a Codex or Gemini CLI coordinator (its orders, and for
                     Codex its own copy of STATUS.md). It may be another folder, outside this one.
mail/                agent mail (optional): one folder per agent
  <agent>/
    new/             messages the agent has not read yet
    read/            messages it has read
bin/                 the relay, the worker launcher and agent mail
tests/               the relay test's fake Claude
.relay/              the relay's own state and notes
```

Worktrees for workers live **outside** this folder, under the worktrees folder from
`bin/relay-settings.json`: `<worktrees folder>\<TASK-ID>\<repo folder>`, on branch `claude/<TASK-ID>`.

## Agent mail

Agents that do not use the task files, such as a Colonel and the Sergeants under it, send each other
messages by name with `bin/agent-mail.ps1`:

- `-Send -From <your name> -To <name> -Text <message>` (or `-TextFile <file>` for a long one).
- `-Read -Me <your name>` prints your new mail and files it.
- `-Wait -Me <your name> -Seconds <n>` waits for new mail, then reads it.

The relay wakes an agent it knows when mail waits for it. Never write or move a mail file yourself:
always use the script, so nobody reads half a message.

## Task lifecycle

`NEW → ACCEPTED → IN_PROGRESS ⇄ WAITING_ON_CODEX → IN_REVIEW → DONE`
(also `BLOCKED`, and `RETURNED`, which goes back to `IN_PROGRESS`, and `CANCELLED`)

1. **The planner assigns:** copies `templates/assignment.md` to `tasks/<TASK-ID>/assignment.md`,
   fills it in, and adds a line to `CODEX-QUEUE.md`.
2. **The coordinator accepts:** reads the repository's `AGENTS.md` or `CLAUDE.md`, checks
   `git status`, the base ref, and branches or worktrees that overlap, then writes `status.md`
   (`ACCEPTED`, or `BLOCKED` with the reason) and updates `STATUS.md`.
3. **The coordinator sets up isolation:**
   `git worktree add -b claude/<TASK-ID> <worktree path> <base ref>` in the repository the
   assignment names. It never touches the repository's main folder, other branches, or other
   worktrees.
4. **The coordinator briefs workers:** writes `workers/W1-brief.md` (one implementation worker per
   file scope that does not overlap; read-only reviewers are allowed) and starts the worker, with
   `bin\spawn-worker.ps1` (a Claude Code coordinator) or with a start request, `workers/W1-start.md`
   (any coordinator; see "Workers").
5. **Workers do the work:** only inside their worktree and file scope. They commit locally and
   write `W1-report.md`. A Codex worker cannot write Git's own folder, and an Antigravity worker
   runs no `git` unless the owner allows it, so the launcher commits their changes when they finish,
   with no Git hooks. It commits nothing after a run that changed the worktree's `.git`.
6. **The coordinator reviews:** reads the diff, runs the named checks again, and sends the worker
   back if needed.
7. **Questions, at any time:**
   - Routine, in-scope technical questions from workers: the coordinator answers them itself and
     writes them down in the task's `status.md`.
   - Questions about scope, ownership or authority: the coordinator adds `Qn` to `questions.md`,
     sets the state to `WAITING_ON_CODEX`, and lists it under "Needs Codex" in `STATUS.md`. The
     planner answers `An` in `answers.md`.
8. **Handoff:** the coordinator writes `handoff.md` from the template and sets `IN_REVIEW`.
9. **The planner decides** in `review.md`: `ACCEPTED` (the planner then handles the pull request,
   merge, docs and tracker from the local branch), `RETURNED` (with the required changes), or
   `CANCELLED`. The coordinator removes the worktree only after `ACCEPTED` with "worktree may be
   removed", or after `CANCELLED`.

## Hard limits (for every task, unless the assignment says otherwise)

- No push, merge, rebase of shared branches, tag, release, deploy or production change. The only
  exception is rule 12 in `CLAUDE.md`: the coordinator (never a worker) may push the assigned
  `claude/` task branch, without force, and open a draft pull request for it.
- No tracker access.
- Never change a checkout with uncommitted changes, another session's worktree or branch, or files
  outside the assigned scope.
- If the checkout has uncommitted changes, the scope overlaps work in progress, or ownership is
  unclear: `BLOCKED`, and ask.
- No passwords, tokens, keys or customer data in any file here.

## Workers

A Claude Code coordinator starts each worker with `bin\spawn-worker.ps1`. A Codex or Gemini CLI
coordinator cannot run it, so it writes a start request instead (see below). Either way, the
launcher runs this way:

```powershell
.\bin\spawn-worker.ps1 -TaskId <TASK-ID> -Worker W1 [-Type implementation|review] [-Tool claude|codex|gemini|antigravity] [-MaxBudgetUsd 3] [-Model <id>] [-Effort <level>]
.\bin\spawn-worker.ps1 -TaskId <TASK-ID> -Status
```

- A worker runs in an AI tool. The usual one is Claude Code, started with `claude -p`, with the
  owner's Claude subscription login, never an API key.
- Codex (`-Tool codex`), Gemini CLI (`-Tool gemini`) and Antigravity CLI (`-Tool antigravity`) run
  workers only when the owner lists them in `worker_tools` in `bin\relay-settings.json`. The
  launcher refuses any other tool.
  - Codex runs `codex exec` with the owner's ChatGPT sign-in, never an API key. It starts without
    the owner's own Codex settings and command rules, and with no web search, so it needs a Codex
    command line from April 2026 or newer.
  - Gemini runs `gemini -p` with the owner's own Gemini login. It costs money for every run.
  - Antigravity runs `agy` with the owner's own Google sign-in. Google's consumer terms may not
    allow that, so only the owner may turn it on.
- Its working folder is the `Worktree` line of `W<n>-brief.md`. That folder must be inside the
  worktrees folder. A Codex or Antigravity reviewer works in the task's `workers` folder instead. A
  Codex reviewer reads the worktree from there.
- It may use only the tools on its list. Implementation workers: file tools, `git` and `node`.
  Reviewers: reading, writing their report, and read-only `git`. Always refused: push, merge,
  rebase, reset, checkout, branch, worktree, tag, stash, config, npm, npx and web access.
  - A Codex worker works in Codex's `workspace-write` sandbox instead of a list.
  - A Gemini worker gets a policy file for its run, which allows only these and denies the rest.
  - An Antigravity worker may change files only in its worktree and the `workers` folder. It runs
    only the commands that the owner allows in Antigravity's own settings, and none if the owner
    allows none.
- The launcher writes `W<n>.log` (the result), `W<n>.run.json` (state, cost, `tool`, `session_id` and
  `tokens`) and `runs.md` (one line per run, with its Tool and Tokens) in the task's `workers` folder.
- Each run is a saved session with its own id (`session_id`). Pleni shows it under the coordinator.
  For a Claude run, once the run has ended, the owner can open it with
  `claude --resume <session_id>` in its worktree. For Codex, the id is the thread's id. For Gemini, it
  is the session id that Gemini CLI reports. For Antigravity, it is the conversation id that
  Antigravity CLI reports.
- The usual model is Opus 5.5 with a 1M context, at `xhigh` effort. `-Model` and `-Effort` change
  them for one run. A Codex worker's effort is `-Effort`, or `xhigh` when none is given; it never
  comes from the owner's Codex `config.toml`. A Codex, Gemini or Antigravity worker with no `-Model` uses that tool's own
  default model. Codex has no `max` effort, Gemini CLI has no effort setting, and Antigravity CLI
  has `low`, `medium` and `high` (`xhigh` runs as `high`).
- Each Claude run has a dollar cap (`-MaxBudgetUsd`, usually 3) unless `bin\cost-limits.json` turns
  the caps off. Codex, Gemini and Antigravity report no cost. Instead, `worker_runs_per_day` in
  `bin\cost-limits.json` limits how many of their workers may start in one day.

### Start requests

A coordinator that cannot run `bin\spawn-worker.ps1` (a Codex or Gemini CLI coordinator) asks the
relay to start a worker. It writes the worker's brief, then `workers/W<n>-start.md` from
`templates/worker-start.md`:

- The relay reads only the lines of the template, written just as they are: **Tool**, **Type**,
  Budget USD, Model, Effort, New worktree and Requested. Tool and Type must be there. A request with
  another line, a line written another way, or a value that does not fit is refused.
- **New worktree: yes** makes the brief's worktree on the branch `claude/<TASK-ID>` from the
  brief's Base commit. A coordinator that cannot run `git worktree add` needs it. The folder and the
  branch must not be there yet. If git fails half way, what it left stays, and the request is
  refused until the owner deletes it. The refusal note says what is left. If the launcher made the
  worktree and then refused for another reason, the worktree stays too: ask again with
  `New worktree: no`.
- After the coordinator's turn, the relay checks the request and runs the launcher. A tool that
  `worker_tools` does not list, a brief that is not there, and a worker that still runs are
  refused. At most 12 workers start a day for start requests (`relay_max_worker_starts_per_day`).
- Each version of the file runs at most once. After a refusal, fix the cause and change the
  Requested line to ask again. The refusal comes back to the coordinator as a note in its next turn.

## Signals

When the relay runs, it wakes the coordinator after the planner writes `CODEX-QUEUE.md`, an
`assignment.md`, an `answers.md` or a `review.md`, and after a worker run ends. It lists what waits
for the planner in `.relay/codex-attention.md`. If the owner turned on the Codex wake
(`bin/bridge-relay.ps1 -EnrollCodex`), it also wakes the planner's Codex thread once for each new
item on that list. A turn the relay starts begins with `[bridge-relay <id>]`.

If the owner enrolled by name, a new session that takes over the name (a rollover) gets the wakes
from then on. A new coordinator or planner session should start by reading `STATUS.md` and its open
tasks.

A Codex coordinator or a Gemini CLI coordinator gets the same wakes. A Codex thread has one job
only: it may be the planner, the coordinator, an agent or the orchestrator, never two of them. There
is one exception, as before: the planner and a mail agent may share one thread. The relay never
wakes them at the same time, and at a rollover both move to the newer thread with the name. Only
the coordinator and the orchestrator need a thread of their own. A Codex coordinator also needs a
folder with no `AGENTS.md` or `AGENTS.override.md` above it, up to the top of its Git repository:
Codex reads every `AGENTS.md` from there down, so it would get those orders too.

Without the relay, tell the other side in one line after you write:

- planner: "Claude: new or updated work in `tasks/<TASK-ID>`" (or "see CODEX-QUEUE")
- coordinator: "Codex: `<TASK-ID>` is IN_REVIEW / WAITING_ON_CODEX, see STATUS.md"

Each time it starts, each side reads the other side's board first (`STATUS.md` for the planner,
`CODEX-QUEUE.md` for the coordinator), then the task files with newer time stamps.

## HQ: one planner for several projects

The owner may run several mailboxes with one planner, the **orchestrator**:

- Each **project** is a normal mailbox, with its own coordinator, its own relay, and these same
  rules.
- **HQ** is a mailbox too. Its `bin/relay-settings.json` lists the projects. Only the HQ relay wakes
  the orchestrator: when something new waits for the planner in HQ or in a project. Each item in
  its note names the project and that project's mailbox folder.
- The orchestrator is the planner of every project. It writes each assignment, answer and review
  in that project's own mailbox, in the planner's files there. Work with no project goes on HQ's
  own board. Its standing orders are HQ's `AGENTS.md`.
- A project's relay never wakes the orchestrator's thread; only HQ's does. HQ stops waking it if a
  project does, and tells the owner. This holds for a project's coordinator too: the orchestrator's
  thread is never the coordinator of a project.
- HQ's `.relay/codex-attention.md` lists what waits in all of them, with a Project column (`hq`
  is HQ itself).
