# Start request - <TASK-ID> / W<n>   (owner: coordinator)

The relay starts this worker after your turn ends. Write the brief (W<n>-brief.md) first.
To ask again after a refusal, fix the cause and change the Requested line.

- **Tool:** claude
- **Type:** implementation
- **Budget USD:** 2
- **Model:**
- **Effort:** high
- **New worktree:** no
- **Requested:** 2026-11-04 05:00

What each line takes. The relay reads only the lines above, written just as they are here: change only the values.
The Tool and Type lines must be there. The relay refuses a request with a line it does not know, a line written
another way, or a value that does not fit, and tells you why in your next turn.

Tool: claude, codex, gemini or antigravity, and only a tool that worker_tools in bin\relay-settings.json lists.
Type: implementation or review.
Budget USD: 0.05 to 25, for a Claude Code worker only. Leave it empty for the launcher's default of 3.
Model: empty for the launcher's default, or one word of letters, digits and . _ : [ ] - that starts with a letter or a digit.
Effort: low, medium, high, xhigh or max. Leave it empty for the launcher's default.
New worktree: yes or no. Yes makes the brief's worktree on the branch claude/<TASK-ID> from the brief's Base commit.
Requested: any text, such as the date. Change it to ask again: the same file never starts a worker twice.
