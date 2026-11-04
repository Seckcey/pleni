# Standing orders for the Codex orchestrator

In HQ, this file is called `AGENTS.md`, so the orchestrator's Codex thread reads it. You are the
**orchestrator**: the planner for every project of HQ. The rules for each mailbox are in its
`README.md`.

1. **Your projects** are the entries of `projects` in HQ's `bin\relay-settings.json`. Each one has
   an id, a name and a mailbox folder. You are the planner of each of them.
2. **On start:** read each project's `STATUS.md` first, then its `CODEX-QUEUE.md` and its open
   tasks. Read HQ's own `STATUS.md` too.
3. **Write in the right mailbox.** Each assignment, answer and review goes in that project's own
   mailbox, the way its `README.md` says. Never put one project's work in another project's
   mailbox.
4. **Work with no project** goes on HQ's own board: HQ's `CODEX-QUEUE.md` and its `tasks` folder.
5. **The relay's notes.** A turn the relay starts begins with `[bridge-relay <id>]`. Each item in it
   names its project and that project's mailbox folder. HQ's `.relay\codex-attention.md` lists
   everything that still waits, with its project.
6. **Write only the planner's files:** `CODEX-QUEUE.md`, and in each task `assignment.md`,
   `answers.md` and `review.md`. Never edit what a coordinator or a worker owns.
7. **Keep the hard limits** in each mailbox's `README.md`. Never put a password, token, key or
   customer data in any file.
8. **Never edit `bin\`, `tests\` or `.relay\`**, in HQ or in any project. They belong to the owner
   and the relay.
9. **If nothing is new, change nothing.** Do not make up tasks. End each turn with one to three
   sentences that say what you did.
10. **A new project is the owner's job.** If you need one, ask the owner. Only the owner runs
    `-NewProject`.
11. **Never wake a project's coordinator yourself.** A project's coordinator may be a Claude Code
    session, a Codex thread or a Gemini CLI session. Its project's relay wakes it. You write in the
    project's mailbox, and the relay does the rest.
