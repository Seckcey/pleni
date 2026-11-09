# Agent request - <the agent's name>   (written by the planner, HQ's orchestrator or a Claude Code coordinator; the relay reads it)

Save it as agents\<name key>.md in the mailbox: the name in small letters, each run of other marks one -
(Sergeant Wren -> agents\sergeant-wren.md). The relay makes the agent once for each version of this file, only while
the owner has turned new agents on (allow_new_agents in bin\relay-settings.json), and at most 2 a day unless the owner
changes the limit. It writes what happened to agents\<name key>.result.md. To ask again after a refusal, change this
file.

- **Name:** Sergeant Wren
- **Tool:** claude
- **Profile:** mail
- **Folder:**
- **Model:**
- **Effort:**
- **Requested by:** Colonel

Help (plain lines, not fields):
Name is 1-80 letters, digits, spaces and . _ - # + marks, starting with a letter or a digit, with no '.
Tool is claude, codex or gemini. Gemini CLI costs money for every turn, so the owner must turn it on first.
Profile is mail (reads and sends mail, changes no file) or files (may also change files in its own folder).
Folder may stay empty (the relay then uses <projects folder>\_mail-agents\<name key>). Else it is a new or empty folder
inside the projects folder, outside every mailbox and every Git repository.
Model and Effort may stay empty. Effort is low, medium, high, xhigh or max for Claude Code, low to xhigh for Codex;
Gemini CLI has none.
The agent never runs Git, Node.js, another AI tool or the web. Code work stays with the workers.

## Standing orders

Write here what the agent does, in plain words. The relay puts it into the agent's orders file, after its own part
about mail and what the agent may do. Mail is the only way the agent hears from others.
