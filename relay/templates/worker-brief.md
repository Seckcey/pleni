# Worker brief — <TASK-ID> / <W#>   (owner: Claude coordinator)

You are a **Claude worker** session, supervised by the **Claude coordinator**. You never talk to Codex directly.

- **Type:** implementation | read-only review
- **Worktree (your only working directory):** <worktrees folder>\<TASK-ID>\<repo>
- **Branch:** claude/<TASK-ID>   (already created — do not create/switch branches)
- **Base commit:** <sha>
- **Model and effort:** <model>, <effort>   (why: <one line, by standing order 13>)

## Read first
- `<worktree>\AGENTS.md` (and any CLAUDE.md / docs it names)
- `<mailbox>\tasks\<TASK-ID>\assignment.md`

## Your file scope (edit ONLY these)
-

## Do
1.

## Do not
- Edit files outside your scope or outside your worktree.
- Push, merge, rebase, tag, deploy, or touch other branches/worktrees.
- Edit anything in the mailbox folder except your report file.
- Add dependencies or install packages.

## Checks to run
-

## Reviewers only
- Scope: exact diff `<base>..<head>` plus checks 1..N listed above. Nothing broader.
- **First action:** create your report file with `Result: PARTIAL (in progress)`. Append each finding as soon as you have it.
- Reuse the implementation worker's existing measurements and scripts (paths: ...) instead of re-exploring.
- Finish by setting `Result: COMPLETE review` or `Result: PARTIAL evidence (reason)`.

## When finished
- Commit locally on the branch: `<TASK-ID>: <summary>` (implementation workers only).
- Write `<mailbox>\tasks\<TASK-ID>\workers\<W#>-report.md` from
  `templates\worker-report.md`. Stop.
