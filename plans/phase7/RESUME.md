# Phase 7: where the work stopped (2026-11-04)

Made by 8 West Ventures, LLC. This branch is a backup to pick the work up later. Do not merge it.

## Done

- Phases 1 to 6 and Phase 8 are merged into `main` (Phase 6 is #52, `206a3a8`).
- **The Phase 7 plan** is `plans/phase7/phase7-design.md` (about 5,400 lines): mail agents in Claude Code, Gemini
  CLI or Codex; new named agents from `agents\<name>.md` requests; mail between mailboxes with
  `agent-mail.ps1 -Box`. Its build checklist is section 25, and its fact check is section 28.
- **Stage 7G (Pleni)** is done, tested (836 tests pass) and pushed on its own branch,
  `claude/fervent-dirac-h0fove-agents-pleni` (`b9cc501`). It belongs inside the Phase 7 pull request.

## Not done

- **Stage 7A (relay foundations)** is only partly built, and nobody has reviewed it yet. This branch holds it as it
  was when the work stopped: `relay/bin/bridge-relay.ps1`, +637/-86 lines. It may be unfinished. Review it against
  section 25's 7A row before you build on it, or start 7A again from `main`.
- Stages 7B to 7F (relay code, scenarios 31 to 36) and 7H (docs, CI timeout 50 minutes, a final review).

## The two open questions of section 28, answered

1. Branches the stand-in programs cannot reach may be checked by reading only, as in Phase 6.
2. Keep the shared-thread exception as the plan says. The planner and a Codex agent signed up with no profile may
   share one thread. Every new kind of agent gets a session of its own.

## How each stage was run

1. Make the Phase 7 branch from `main`, and merge `claude/fervent-dirac-h0fove-agents-pleni` into it.
2. Build one stage at a time, with the strongest model:
   - a builder;
   - a Windows PowerShell 5.1 reviewer and a reviewer of the plan's logic (strongest model). Word their tasks as
     checks that the code does what the plan says, never as hunts for ways around the rules;
   - a fixer for confirmed findings (a cheaper model is fine).
3. Push the stage. The GitHub check "Relay test (Windows PowerShell)" must pass every scenario so far.
4. Easier jobs get cheaper models (the owner's order):
   - docs and fact checks: Sonnet;
   - mechanical work such as merging duplicate findings: Haiku.
