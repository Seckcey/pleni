# Mailbox protocol

This folder is how three kinds of AI sessions work together: a **planner** (Codex), a
**coordinator** (Claude Code) and the coordinator's **workers** (Claude Code worker sessions). It
is plain Markdown on disk. There is no tracker and no network.

In a mailbox, this file is called `README.md`. The relay tells the coordinator to read it.

## Roles

| Role        | Who                    | Does                                                                                                                                                                                                                  | Never does                                                                                       |
| ----------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Planner     | Codex                  | Assigns tasks, answers questions, reviews handoffs, and accepts or returns work. Owns pushes, merges, release notes and the tracker, except the coordinator's narrow GitHub rule (rule 12 in `CLAUDE.md`).          | Edit files that the coordinator or a worker owns.                                                |
| Coordinator | A Claude Code session  | Reads assignments, checks the repository, makes an isolated worktree and branch, briefs and supervises workers, answers routine in-scope worker questions, reviews their diffs, runs checks, reports status, asks the planner the questions that matter, writes handoffs. | Write app code, push (except rule 12), merge, mark a pull request ready, deploy, touch the tracker, or edit planner-owned files. |
| Worker      | A Claude Code session  | Makes the code change inside its worktree and file scope, runs the named checks, commits locally, and writes its report.                                                                                             | Leave its worktree or file scope, push, merge, deploy, or edit any other file here.              |

## Golden rule: one writer per file

Every file has exactly one owner. Read anything; **write only the files you own.** This is what
makes it safe for everyone to work at the same time.

| Path                                                   | Owner                                     |
| ------------------------------------------------------ | ----------------------------------------- |
| `CODEX-QUEUE.md`                                       | Planner                                   |
| `tasks/<TASK-ID>/assignment.md`                        | Planner                                   |
| `tasks/<TASK-ID>/answers.md`                           | Planner                                   |
| `tasks/<TASK-ID>/review.md`                            | Planner                                   |
| `STATUS.md`                                            | Coordinator                               |
| `tasks/<TASK-ID>/status.md`                            | Coordinator                               |
| `tasks/<TASK-ID>/questions.md`                         | Coordinator                               |
| `tasks/<TASK-ID>/handoff.md`                           | Coordinator                               |
| `tasks/<TASK-ID>/workers/W<n>-brief.md`                | Coordinator                               |
| `tasks/<TASK-ID>/workers/W<n>-report.md`               | That worker only                          |
| `tasks/<TASK-ID>/workers/W<n>.log`, `W<n>.run.json`, `runs.md` | The worker launcher (machine-written) |
| `README.md`, `CLAUDE.md`, `templates/`                 | Coordinator (changes asked for by the planner in `CODEX-QUEUE.md`) |
| `bin/`, `tests/`, `.relay/`                            | The owner and the relay; sessions never edit them |

Add new entries at the **bottom** of a file, with a time stamp (`YYYY-MM-DD HH:MM`, local time).
Never rewrite someone else's history.

## Layout

```
README.md            this protocol
CLAUDE.md            standing orders for the coordinator
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
      W1-report.md   worker -> coordinator: what it did, a diff summary, check output
bin/                 the relay and the worker launcher
tests/               the relay test's fake Claude
.relay/              the relay's own state and notes
```

Worktrees for workers live **outside** this folder, under the worktrees folder from
`bin/relay-settings.json`: `<worktrees folder>\<TASK-ID>\<repo folder>`, on branch `claude/<TASK-ID>`.

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
   file scope that does not overlap; read-only reviewers are allowed) and starts the worker.
5. **Workers do the work:** only inside their worktree and file scope. They commit locally and
   write `W1-report.md`.
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

The coordinator starts each worker with `bin\spawn-worker.ps1`:

```powershell
.\bin\spawn-worker.ps1 -TaskId <TASK-ID> -Worker W1 [-Type implementation|review] [-MaxBudgetUsd 3] [-Model <id>] [-Effort <level>]
.\bin\spawn-worker.ps1 -TaskId <TASK-ID> -Status
```

- A worker is a Claude Code session started with `claude -p`. It uses the owner's Claude
  subscription login, never an API key.
- Its working folder is the `Worktree` line of `W<n>-brief.md`. That folder must be inside the
  worktrees folder.
- It may use only the tools on its list. Implementation workers: file tools, `git` and `node`.
  Reviewers: reading, writing their report, and read-only `git`. Always refused: push, merge,
  rebase, reset, checkout, branch, worktree, tag, stash, config, npm, npx and web access.
- The launcher writes `W<n>.log` (the result), `W<n>.run.json` (state, cost and `session_id`) and
  `runs.md` (one line per run) in the task's `workers` folder.
- Each run is a saved Claude Code session with its own id (`session_id`). Pleni shows it under the
  coordinator, and once the run has ended, the owner can open it with `claude --resume <session_id>`
  in its worktree.
- The usual model is Opus 5.5 with a 1M context, at `xhigh` effort. `-Model` and `-Effort` change
  them for one run.
- Each run has a dollar cap (`-MaxBudgetUsd`, usually 3) unless `bin\cost-limits.json` turns the
  caps off.

## Signals

When the relay runs, it wakes the coordinator after the planner writes `CODEX-QUEUE.md`, an
`assignment.md`, an `answers.md` or a `review.md`, and after a worker run ends. It lists what waits
for the planner in `.relay/codex-attention.md`. If the owner turned on the Codex wake
(`bin/bridge-relay.ps1 -EnrollCodex`), it also wakes the planner's Codex thread once for each new
item on that list. A turn the relay starts begins with `[bridge-relay <id>]`.

Without the relay, tell the other side in one line after you write:

- planner: "Claude: new or updated work in `tasks/<TASK-ID>`" (or "see CODEX-QUEUE")
- coordinator: "Codex: `<TASK-ID>` is IN_REVIEW / WAITING_ON_CODEX, see STATUS.md"

Each time it starts, each side reads the other side's board first (`STATUS.md` for the planner,
`CODEX-QUEUE.md` for the coordinator), then the task files with newer time stamps.
