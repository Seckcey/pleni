# Pleni architecture

Pleni ("Plenipo Browser") is a small local web app. It reads the session files that Claude Code and
Codex already write on your computer, works out who is working on what, and shows it live in your
browser as an organization map with the hand-offs between agents drawn as moving lines.

Version 0.1 mostly **watches**. It never stops or changes a session, and it never writes into
Claude Code's, Codex's or a mailbox's folders, except for one opt-in change: with **Change models**
turned on (off by default), the Models page changes the model and effort lines in Codex's settings
after the person chooses Save to Codex (see `src/models.js` below). What it may start is a window the person asks for:
with **Open in PowerShell** turned on (off by default, Windows only), a button opens a PowerShell
window that runs `claude --resume` or `codex resume` for one Claude Code session or Codex thread,
and the person types there (see `src/open.js` below). With **Roll over** turned on (also off by
default), two buttons open such windows with one fixed message each, which the page shows first:
a request to the old session to write a handoff note, and the first message of a new session with
the same name (see `src/rollover.js` below). With **New agent** turned on (also off by default), a
button opens a window that starts a new named session in the folder of a session on the map, and
the person types its first message there (see `src/newagent.js` below). With **Bring a cloud
session here** turned on, a button opens a window in a Claude Code session's folder that runs
`claude --teleport`, where the person picks a claude.ai cloud session to go on with on this
computer. With **Live GitHub status** turned on (also off by default), Pleni runs the GitHub CLI
(`gh`) to read the pull requests of the repositories its sessions work in, and with **Merge** on as
well, it merges one on this computer after the person confirms (see `src/github.js` below).
Sending other work and approving actions come later and will get their own design.

## Ground rules

- **Zero runtime dependencies.** Node.js 22.12 or newer, ES modules, `node:` built-ins only. No
  build step: the files in `public/` are served as they are.
- **Local by default.** The server binds `127.0.0.1` only. Other devices can reach it only through a
  reverse proxy you configure (for example `tailscale serve`) and only for the host names and
  Tailscale logins you list in settings.
- **Only the person who started it.** Every account on the computer can reach `127.0.0.1`, so the
  API also needs a random key made at each start and printed in Pleni's address (see Server).
- **Read-only.** Pleni reads; it does not write anywhere on this computer except its own settings
  file, and, with the opt-in Models page, the model and effort lines in Codex's `config.toml` and
  the worker type files in Codex's `agents` folder (see Models). It starts no program except the opt-in Open in PowerShell, Roll over, New agent and Bring a
  cloud session here windows, only when the person clicks for one, and the GitHub CLI (`gh`) for
  the opt-in Live GitHub status. The only messages it sends are Roll over's two fixed ones, and the
  only change it makes elsewhere is a merge on GitHub that the person confirms.
- **Private by default.** Nothing leaves the computer, except what the opt-in Live GitHub status
  asks GitHub through `gh`. No telemetry, and no network calls of Pleni's own. The page shows short
  snippets of session text only when `content` is `"snippets"` (the default); `"none"` shows only
  tool names and states.
- **Robust to big, live files.** Session files can be gigabytes and are appended while we read them.
  Pleni reads from the end, splits only on `\n` bytes, never parses a line that has no newline yet,
  and treats every field as optional.
- **Stable layout.** Tiles never re-order because of activity. Order is by name, then key.

## Layout

```
bin/pleni.js            command line: node bin/pleni.js [--port N] [--demo] [--open] [--config FILE] [--new-key] [--url]
src/config.js           settings: defaults, validation, load/save, folder discovery
src/jsonl.js            safe incremental JSONL reading (tail, head scan, BOM)
src/sources/claude.js   Claude Code sessions and sub-agents
src/sources/codex.js    Codex threads and sub-agents
src/sources/grok.js     Grok sessions
src/sources/kimi.js     Kimi Code sessions and sub-agents
src/sources/mailbox.js  optional coordination mailbox (task folders of Markdown files)
src/model.js            builds the snapshot the page draws (nodes, edges, events)
src/repos.js            the GitHub repository of a session's folder, from its git settings (remote address only)
src/store.js            owns the sources, polls them, caches the snapshot
src/open.js             Open in PowerShell: a Claude Code session or Codex thread in a new window (opt-in, Windows)
src/rollover.js         Roll over: a handoff note from a long session, then a new one with its name (opt-in, Windows)
src/newagent.js         New agent: a new named session in the folder of one on the map (opt-in, Windows)
src/github.js           Live GitHub status and Merge, through the GitHub CLI, gh (opt-in)
src/models.js           the Models page: Codex's model and effort lines, read always, changed on request (opt-in)
src/toml.js             a small TOML reader and one-line editor for src/models.js
src/demo.js             synthetic, moving demo data (no files needed)
src/server.js           HTTP server, security gate, routes
public/index.html       the page (no inline script or style)
public/app.js           the page logic (ES module, vanilla JS)
public/styles.css       Plenipo design tokens and page styles
public/brand/           logos, favicons, mascot
test/                   node:test suites; fixtures are generated into temp folders
relay/                  the mailbox relay: a separate Windows PowerShell program (relay/README.md); Pleni never runs it
```

## Settings (`src/config.js`)

Settings live outside the repository, in `PLENI_HOME` if set, else `%APPDATA%\pleni` on Windows,
`~/Library/Application Support/pleni` on macOS and `$XDG_CONFIG_HOME/pleni` (default
`~/.config/pleni`) elsewhere. The file is `settings.json` (UTF-8, a BOM is tolerated).

```js
export const DEFAULTS = {
  version: 1,
  port: 8790,
  displayName: 'You',                 // the person at the top of the map, max 40 chars
  titles: 'plain',                    // 'plain' | 'military' | 'company'
  content: 'snippets',                // 'snippets' | 'none'
  groupBy: 'none',                    // 'none' | 'project' (a folder tile between you and its sessions)
  window: { activeMinutes: 10, recentHours: 24, staleMinutes: 30 },
  showReviewers: false,               // Codex automatic-review sub-agents
  modelTiers: { senior: ['opus', 'fable', 'astra'], junior: ['sonnet', 'haiku', 'sol', 'luna', 'mini'] },
  sources: {
    claude: { enabled: true, root: null },            // null = $CLAUDE_CONFIG_DIR or ~/.claude
    claudeDesktop: { enabled: true, root: null },     // null = platform default (see below)
    codex: { enabled: true, root: null },             // null = $CODEX_HOME or ~/.codex
    grok: { enabled: true, root: null },              // null = $GROK_HOME or ~/.grok
    kimi: { enabled: true, root: null },              // null = $KIMI_CODE_HOME or ~/.kimi-code
    mailbox: { enabled: false, root: null, planner: null, coordinator: null }, // planner/coordinator: node key or session name
  },
  people: {},      // { [nodeKey]: { label?: string (≤80), role?: Role, reportsTo?: nodeKey | 'you', watch?: true } }  max 500
  projects: {},    // { [projectName]: { label?: string (≤80), hidden?: boolean } }  max 200
  chain: [],       // [{ match, reportsTo: 'you' | name, role: Role | null }]  max 50, first match wins
  remote: { hosts: [], tailscaleUsers: [] },          // each max 20 entries, lower-cased
  actions: { openTerminal: false, rollover: false, newAgent: false, teleport: false }, // the window buttons; each true only when set to true
  github: { live: false, merge: false, mergeMethod: 'squash' }, // Live GitHub status, the Merge button, 'squash' | 'merge' | 'rebase'
  models: { edit: false },                             // the Models page may change Codex's model lines (this computer only)
  alerts: { stoppedMinutes: 15 },                      // a watched tile counts as stopped after this long without work
  rollSoon: { memoryPercent: 70, squeezes: 2, days: 7 }, // "Roll over soon" limits (0-100, 0-100, 0-365); 0 turns one off
}
// Role = 'superintendent' | 'coordinator' | 'lead' | 'worker' | 'hidden'
```

Exports:

- `configDir(env, platform, home)` and `settingsFile(env, platform, home)`.
- `cleanSettings(raw)` returns a complete, valid settings object: unknown keys dropped, wrong types
  replaced by defaults, strings trimmed and clipped, numbers clamped (`port` 1024–65535,
  `activeMinutes` 1–240, `recentHours` 1–720, `staleMinutes` 5–1440, `stoppedMinutes` 1–1440), arrays
  de-duplicated, node keys validated with `isNodeKey`, roots must be absolute paths or `null`.
  `people[key].watch` is kept only when it is exactly `true`, and so are `actions.*`, `github.live`,
  `github.merge` and `models.edit`.
- `loadSettings(file)` returns `{ settings, file, error }` and never throws (a missing file gives
  defaults and no error; a broken file gives defaults and an `error` string).
- `saveSettings(settings, file)` writes `cleanSettings(settings)` atomically (temp file, then rename),
  creating the folder.
- `renameWithRetry(from, to)` renames, trying again up to 5 times when Windows answers `EPERM`,
  `EACCES` or `EBUSY` (a virus scanner or sync tool holding the file). The key file uses it too.
- `resolveRoots(settings, env, platform, home)` returns `{ claude, claudeDesktop, codex, mailbox }`
  absolute paths or `null`. Defaults: `claude` = `$CLAUDE_CONFIG_DIR` or `~/.claude`; `codex` =
  `$CODEX_HOME` or `~/.codex`; `claudeDesktop` = `%APPDATA%\Claude` on Windows,
  `~/Library/Application Support/Claude` on macOS, `~/.config/Claude` elsewhere; `mailbox` only when
  set.
- `isNodeKey(s)`: `/^(claude|codex):[0-9a-f-]{8,64}(\/[0-9a-z_-]{1,64})?$/` or `you` or
  `project:<name>` (name 1–120 chars, no control characters).
- Environment overrides applied by the CLI: `PLENI_PORT`, `PLENI_HOME`.

## Reading JSONL (`src/jsonl.js`)

```js
export class JsonlTail {
  constructor(file, { maxInitialBytes = 4 * 1024 * 1024, maxLineBytes = 8 * 1024 * 1024 } = {})
  read()        // -> { records: object[], reset: boolean, size: number }
  get offset()  // byte offset of the next unread byte
  badLines      // count of skipped lines (invalid JSON or too long)
}
export function readHeadLine(file, maxBytes = 8 * 1024 * 1024)   // -> object | null
export function scanHead(file, maxBytes, predicate)              // -> object[] (complete lines only)
export function stripBom(text)
export function readJsonFile(file)                               // -> object | null (BOM tolerated)
```

`JsonlTail.read()` uses synchronous `fs` calls (`openSync`, `fstatSync`, `readSync`) in chunks of
1 MB:

- On the first call, if the file is larger than `maxInitialBytes`, start at
  `size - maxInitialBytes` and drop everything up to and including the first `\n` (a partial line).
- Afterwards read only from `offset` to the current size. If the file shrank, or its identity changed
  (`ino`/`birthtimeMs`), start again as on the first call and return `reset: true`.
- Split on the byte `0x0A` only. Never use `readline` or string `split` on decoded text that could
  break on U+2028 or U+2029. Bytes after the last `\n` are carried over and not parsed until their
  newline arrives.
- A line longer than `maxLineBytes` is skipped (and counted in `badLines`) but the offset still moves
  past it. Invalid JSON is skipped and counted. A trailing `\r` is removed before parsing.

## Sources

Every source is created once and then polled about every 2.5 seconds. Polling must be incremental:
directory listings are refreshed on their own slower timer, known files are checked with `fstat`, and
only new bytes are read. A source never throws from `poll()`; it returns `ok: false` and an `error`
message instead. Times are milliseconds since the epoch.

All sources return sessions in this common shape:

```js
Session = {
  platform: 'claude' | 'codex',
  key: string,              // 'claude:<sessionId>' | 'claude:<sessionId>/<agentId>' | 'codex:<threadId>'
  id: string,               // session or thread id
  parentKey: string | null, // who started it, if anyone
  kind: 'session' | 'agent' | 'reviewer',
  title: string | null,     // best available name (≤120 chars)
  titleSource: string | null,
  cwd: string | null,       // normalised: no \\?\ prefix
  branch: string | null,
  entrypoint: string | null,// claude: 'claude-desktop' | 'claude-vscode' | 'cli' | 'sdk-cli'; codex: originator
  model: string | null,
  effort: string | null,
  mode: string | null,      // claude main sessions: the newest turn's permissionMode
                            // (default, acceptEdits, plan, auto, bypassPermissions, dontAsk); else null
  startedAt: number | null,
  lastAt: number | null,    // newest timestamp seen in a conversation record
  status: 'working' | 'ready' | 'idle' | 'done' | 'error',
  needs: null | { kind: 'question' | 'plan' | 'blocked' | 'input', text: string | null, at: number },
  activity: { tool: string | null, detail: string | null, at: number } | null,
  lastText: string | null,  // last assistant text, whitespace collapsed, ≤280 chars; null when content = 'none'
  links: Link[],            // hand-offs this session took part in, newest last, max 50
  archived: boolean,
  context: Context | null,  // main Claude Code sessions and Codex threads; null elsewhere
}
// How full the context (the model's memory of the conversation) is, and how often its history was
// squeezed into a summary (compacted). Numbers only, so they show with content = 'none' too.
Context = { used: number | null, size: number | null, squeezes: number, squeezesAtLeast: boolean, squeezedAt: number | null }
Link = { at: number, dir: 'down' | 'up', other: string /* node key, or 'path:<agentPath>' for codex */, label: string | null }
```

Status meanings: **working** = a turn is running and the file moved within `staleMinutes`; **ready** =
the last turn finished within `activeMinutes` (shown as "Finished"; it is not a request); **idle** = nothing recent, or a turn
that looks open but went stale; **done** = a sub-agent that finished; **error** = the last turn ended
in an error.

`detail` strings are short (≤140 chars) and only present when `content` is `"snippets"`. Build them
from tool inputs: a shell command's `description` or its first line (≤80 chars); the base name of a
`file_path`; a search `pattern`; a sub-agent `description`; the host name of a URL. Otherwise `null`.

Each source also exports `detail(key, since)` for the side drawer: up to 200 recent events
`{ at, kind: 'user' | 'assistant' | 'thinking' | 'tool' | 'result' | 'error', tool: string | null,
text: string | null }` (`text` ≤2000 chars and only with snippets; thinking text is never returned,
only the fact that the model was thinking) and a `next` cursor (a byte offset) for the following
poll.

### Claude Code (`src/sources/claude.js`)

```js
export function createClaudeSource({ root, desktopRoot, settings, now = Date.now })
// -> { poll(): { ok, error, root, sessions: Session[] }, detail(key, since) }
```

- Transcripts: `<root>/projects/<encoded cwd>/<sessionId>.jsonl`. The folder name is a lossy
  encoding of `cwd`; always read `cwd` from the records. Refresh the folder listing every 15 s and
  track files modified within `recentHours`.
- Sub-agents: `<root>/projects/<enc>/<sessionId>/subagents/agent-<agentId>.jsonl` with
  `agent-<agentId>.meta.json` (`agentType`, `description`, `toolUseId`, `spawnDepth`,
  `parentAgentId`, `model`). Workflow agents live in
  `subagents/workflows/<runId>/agent-*.jsonl`; their labels are in that folder's `journal.jsonl`
  `started` records (`agentId`, `label`). A sub-agent's key is `claude:<sessionId>/<agentId>`; its
  parent is `claude:<sessionId>/<parentAgentId>` when nested, else `claude:<sessionId>`.
- Conversation records are `user`, `assistant`, `attachment` and `system`. They carry `timestamp`
  (ISO), `sessionId`, `cwd`, `gitBranch`, `entrypoint`, `version`, and on turns `effort` and
  `permissionMode` (the newest known mode is the session's `mode`). Metadata records (`custom-title`,
  `agent-name`, `ai-title`, `last-prompt`, `cost-state`, `queue-operation`, …) have no timestamp and
  are re-appended often; the last one wins. Never use file mtime as `lastAt`.
- Titles: last `custom-title`/`agent-name`, else last `ai-title`, else the Claude desktop app's
  session title, else (sub-agents) the meta `description` or workflow label. `ai-title` can appear
  only near the start of a long file: if the tail has no title, `scanHead` the first 2 MB once.
- The Claude desktop app keeps per-session metadata in
  `<desktopRoot>/claude-code-sessions/<uuid>/<uuid>/local_<uuid>.json`. Read only `cliSessionId`,
  `title`, `titleSource`, `model`, `effort`, `cwd`, `isArchived`, `lastActivityAt`; cache by mtime;
  refresh the listing every 30 s; ignore every error. Archived sessions get `archived: true`.
- One API message can be split across several `assistant` lines (same `message.id`); treat them as
  one. Synthetic error turns have `message.model` `"<synthetic>"` and `isApiErrorMessage`.
- Context (main sessions only): `used` is the newest assistant message's `message.usage`
  `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`. A squeeze is a `system`
  record with `subtype: 'compact_boundary'` and `compactMetadata` (`trigger` `auto` or `manual`,
  `preTokens`, `postTokens`, `cumulativeDroppedTokens`). The transcript does not say how much the
  model holds, so `size` is the newest automatic squeeze's `preTokens`: where the next one comes.
  After a squeeze, `used` is its `postTokens` until the next answer. Pleni reads only the end of a
  long file, so `squeezes` comes from the newest record's running total:
  `round(cumulativeDroppedTokens / (preTokens - postTokens))`, or one more than before when the
  record has no total. `squeezesAtLeast` is true when the file was read from its middle and no
  record had a total.
- Status: **working** if the last conversation record is a `user` record, an assistant record with
  `stop_reason` `tool_use`, or an assistant `tool_use` with no later `tool_result` for its id, and
  `lastAt` is within `staleMinutes`. **error** if the last assistant record is a synthetic error.
  **ready** if the last assistant record ended the turn (`end_turn` or `stop_sequence`) within
  `activeMinutes`. Otherwise **idle**. A sub-agent whose parent has received its result is **done**.
  Then, within each session's group, a session or sub-agent that would be **ready** or **idle** is
  **working** while any sub-agent below it (at any depth, workflow agents included) is
  **working**: it writes nothing to its own file while a long `Agent` or `Workflow` call runs, or
  while background helpers it launched do the work. **error** and **done** are never changed.
- Activity: the newest unanswered `tool_use` (name plus `detail`), else the newest text.
- Links: an assistant `tool_use` named `Agent` (or legacy `Task`) is a **down** link from the session
  to the sub-agent whose meta `toolUseId` equals the `tool_use.id` (label: its `description`). The
  matching `tool_result`, or for background agents the sub-agent's final assistant text, is the
  **up** link. `SendMessage` tool uses to a known sub-agent are **down** links too.

### Codex (`src/sources/codex.js`)

```js
export function createCodexSource({ root, settings, now = Date.now })
// -> { poll(): { ok, error, root, sessions: Session[] }, detail(key, since) }
```

- Rollouts: `<root>/sessions/YYYY/MM/DD/rollout-<local time>-<threadId>.jsonl`. A file stays in the
  folder of the day it was created, so discovery walks all day folders but keeps only files modified
  within `recentHours` (newest 300 at most). Refresh every 30 s. `archived_sessions/` holds archived
  threads (`archived: true`).
- Every line is `{ timestamp, ordinal?, type, payload }`. Line 1 is `session_meta` (read it with
  `readHeadLine`; it can be several MB): `id`, `timestamp`, `cwd`, `originator`, `cli_version`,
  `git { branch }`, and for sub-agents `parent_thread_id`, `agent_nickname`, `agent_path`,
  `subagent_history_start_ordinal`, `source.subagent.thread_spawn { parent_thread_id, depth }`.
  Records whose `ordinal` is below `subagent_history_start_ordinal` are the parent's inherited history;
  skip them.
- Automatic reviewers (`source.subagent.other === 'guardian'` or model `codex-auto-review`) get
  `kind: 'reviewer'`.
- Model and effort: the latest `turn_context` `model` and `effort`.
- Turns: `event_msg` `task_started { turn_id }` opens a turn; `task_complete { turn_id, error? }` or
  `turn_aborted` closes it. **working** = an open turn and `lastAt` within `staleMinutes`; **error** =
  the last `task_complete` has `error`; **ready** = the last turn closed within `activeMinutes`;
  **done** = a sub-agent whose parent recorded it completed; else **idle**.
- Activity: a `response_item` `function_call` or `custom_tool_call` with no output for its `call_id`
  yet (the shell tool is `exec`). `lastText`: `task_complete.last_agent_message`, else the last
  assistant `message` text.
- Messages between threads: when thread S sends thread X a message, X's rollout gets a
  `response_item` `function_call_output` named `send_message_to_thread` whose output holds
  `<codex_delegation><source_thread_id>S</source_thread_id><input>…</input></codex_delegation>`.
  Each one becomes a **down** link on S toward X (the model turns a link toward an ancestor into a
  report up), labelled with the first line of the message (≤140 chars, only with snippets). The
  sender id is read outside `<input>`, so message text cannot claim another sender.
- Coordinator registry (optional): Codex coordinators record the workers they start in
  `<root>/coordinators/registry.sqlite3` (tables `coordinators` and `worker_tasks`, one JSON
  `record` per row: `threadId`, `coordinatorThreadId`, `projectId`, `state`) and the suite
  superintendent in `<root>/coordinators/superintendent.json` (`threadId`). Pleni opens the database
  read-only with `node:sqlite` every 30 s and closes it at once. Each project has one current
  coordinator (replaced ones are `retired`); a worker's `parentKey` becomes the current coordinator
  of its `projectId` (the Sergeant of the repo it works in), else the coordinator that started it,
  the coordinator gets a **down** link at the worker's start and the worker an **up** link when its
  latest turn closes. Sessions get `role` `'coordinator'` or `'superintendent'`, which sets their
  rank unless `people[key].role` says otherwise. Without the registry, or without `node:sqlite`,
  threads show as before.
- Imported threads: threads listed in `<root>/external_agent_session_imports.json` (`records[]`
  `imported_thread_id`) are copies of another tool's sessions and get `archived: true`.
- Titles: `<root>/session_index.jsonl` `{ id, thread_name, updated_at }`, last line per id wins.
  Sub-agents are not in the index: use `agent_nickname`.
- Context: an `event_msg` of type `token_count` holds `info.last_token_usage.total_tokens` (`used`)
  and `info.model_context_window` (`size`); a `compacted` record is a squeeze. A file read from its
  middle may hold squeezes before that part, so `squeezesAtLeast` is true for it.
- Links: `function_call` `spawn_agent` is a **down** link (label: `task_name` when snippets);
  `send_message`/`followup_task` are **down** links to the named agent; an `item_completed` item of
  type `SubAgentActivity` with `kind: 'completed'` (`agent_thread_id`) is an **up** link from that
  child. Use `other: 'codex:<threadId>'` when the thread id is known, else `path:<agent_path>`.
- Paths: strip a leading `\\?\`; compare paths case-insensitively on Windows.

### Grok (`src/sources/grok.js`) and Kimi Code (`src/sources/kimi.js`)

The same contract as the Codex reader (`createGrokSource` / `createKimiSource`, `poll()` and
`detail()`), with keys `grok:<session id>` and `kimi:<session id>[/<agent id>]`.

- **Grok** keeps one folder per session in `<root>/sessions/<url-encoded working folder>/<id>/`:
  `summary.json` (id, working folder, generated title, model, effort, last active time),
  `events.jsonl` (turns, phases, tools started and completed, permission requested and resolved),
  `chat_history.jsonl` and `updates.jsonl`. An unresolved permission request is a `needs` of kind
  `'permission'`.
- **Kimi Code** keeps `<root>/sessions/wd_<folder>_<hash>/session_<id>/state.json` (title, working
  folder, times, and the session's agents: `main` plus sub-agents `agent-0`, `agent-1`, …) and an
  event log per agent, `agents/<agent id>/wire.jsonl` (prompts, turns, messages, model requests,
  usage, permission and plan mode). Sub-agents hang under the main agent with `spawned: true`.

### Mailbox (`src/sources/mailbox.js`)

An optional folder that two agents use to coordinate through Markdown files: a **planner** assigns
work and a **coordinator** reports back.

```
<root>/QUEUE.md (or CODEX-QUEUE.md)   planner-owned queue and log
<root>/STATUS.md                      coordinator-owned board
<root>/tasks/<taskId>/assignment.md   planner
<root>/tasks/<taskId>/answers.md      planner
<root>/tasks/<taskId>/review.md       planner
<root>/tasks/<taskId>/status.md       coordinator; holds "**Current state:** <STATE>"
<root>/tasks/<taskId>/questions.md    coordinator; "## Q<n> — <time> — BLOCKING|NON-BLOCKING"
<root>/tasks/<taskId>/handoff.md      coordinator
<root>/tasks/<taskId>/workers/W<n>.run.json, W<n>-report.md   optional worker runs; session_id names the run's Claude session
<root>/NEEDS-<NAME>.md                optional notes for the person, such as NEEDS-ADA.md
<root>/.relay/coordinator.json        optional: { session_id, follow_name?, ... } of the coordinator's Claude session
<root>/.relay/codex.json              optional: { thread_id, follow_name?, ... } of the planner's Codex thread, if the relay wakes it (Pleni does not read it)
<root>/.relay/state.json, relay.lock, PAUSE, STOP   optional relay state
<root>/.relay/alerts.md               optional: the relay's alerts for the person
<root>/.relay/agents.json             optional: the agents the relay wakes for their mail, by name key: { name, thread_id, ... }
<root>/mail/<name key>/name.txt       optional agent mail (relay/bin/agent-mail.ps1): the agent's name
<root>/mail/<name key>/new/*.md       its unread messages; read/*.md the ones it has read
<root>/bin/relay-settings.json        the relay's settings; Pleni reads only owner_name, the person's mail name
```

The relay that writes `.relay/` and starts the worker runs is the separate program in `relay/`
(`relay/README.md`; the mailbox rules are in `relay/PROTOCOL.md`). Pleni only reads what it writes.

```js
export function createMailboxSource({ root, settings, now = Date.now })
// -> { poll(): MailboxState }
MailboxState = {
  ok, error, root, name,
  tasks: [{ id, title, state, updatedAt, attention: ('question' | 'review')[], workers: [{ id, state, model, startedAt, finishedAt, worktree, sessionId }] }],
  events: [{ at, dir: 'down' | 'up', taskId, file, title }],   // newest first, max 300
  notes: [{ file, count, at, text }],                            // one entry per NEEDS-<NAME>.md
  relay: null | {
    running, paused, halted, coordinatorKey,                     // coordinatorKey = 'claude:<session_id>'
    lastAt, pausedAt, haltReason,                                // times are null when unknown
    alerts: null | { count, at, text },                          // from .relay/alerts.md
    wakes: [{ key, name, at, endAt, running, count }],           // its mail wakes, newest first, at most 30
  },
  mail: null | {                                                 // null without a mail folder
    owner,                                                       // owner_name from bin/relay-settings.json, else null
    agents: [{ key, name, unread, since, wakes, threadId }],     // by key, at most 50
    messages: [{ to, from, fromName, at, unread, text }],        // newest first, at most 300
  },
}
```

- Entries are Markdown headings (`##` or `###`) that contain a time stamp: ISO 8601, or
  `YYYY-MM-DD HH:MM[:SS]` read as local time (a trailing zone word such as `Pacific` is ignored).
  Planner files give **down** events, coordinator files and worker reports give **up** events. The
  event `title` is the heading text without the time stamp (≤120 chars, only with snippets).
- `state` comes from the `**Current state:**` line: its leading run of capital words joined with
  `_` (`NO CLAUDE DISPATCH — reason` → `NO_CLAUDE_DISPATCH`, `IN PROGRESS` → `IN_PROGRESS`), or,
  when the state is not written in capitals, its first word in capitals (`done` → `DONE`); `-`
  becomes `_`; at most 40 characters. `title` is the first heading of `assignment.md` (only with
  snippets; otherwise the task id).
- Finished states: `DONE`, `CANCELLED`, `CANCELED`, `COMPLETE`, `COMPLETED` and
  `NO_CLAUDE_DISPATCH`, alone or followed by `_` and more words (`DONE_PR`). Finished tasks are read
  again only when the task listing refreshes.
- Attention: a BLOCKING question without a matching answer, or a task in `IN_REVIEW` whose newest
  handoff is newer than its newest review. Finished tasks get none.
- Task ids must match `/^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/`. Files may start with a UTF-8 BOM.
- `relay.running` is true when `.relay/relay.lock` names a process that is alive. `paused` is true
  with a `PAUSE` file, `halted` with a `STOP` file or a non-empty `halt` text in `state.json` (the
  relay sets it when it stops sending, such as after repeated failures; `haltReason` is that text, ≤300 chars, only with snippets).
  `lastAt` is when `state.json` was last written: the relay rewrites it on every pass, even while
  paused, so it shows the relay is still going. `pausedAt` is when the `PAUSE` file was made.
- Notes for the person: `NEEDS-<NAME>.md` files at the root (the name is 1–61 letters, digits, `_`
  or `-`). The relay's `.relay/alerts.md` is read the same way. Each heading (`#` to `###`) or
  top-level list item (`-`, `*` or `+`, at most one space in) whose text starts with a time stamp
  (`**` marks before it are fine) is one note; nested items and code blocks are skipped. `count` is
  the number of notes, `at` the newest note's time, and `text` that note without the stamp and `**`
  marks (≤300 chars, only with snippets, else `null`).
- Agent mail: agents send each other messages by name with the relay's `agent-mail.ps1`
  (`relay/README.md`). A name's **key** is its folder name: the name in small letters, each run of
  other marks one `-` (`Sergeant Ada` → `sergeant-ada`); keys match `/^[a-z0-9][a-z0-9-]{0,99}$/`.
  A message is one file, `<yyyyMMdd-HHmmss-fff UTC>-<sender's key>-<6 hex>.md` (a copy moved to
  `read/` under a taken name gets `-<4 hex>` more), holding `From:`, `To:` and `Sent:` lines, a
  blank line, then the text. A message never changes once it is there; reading it only moves it
  from `new/` to `read/`. So each message file is read once (its first 80 KB). Each agent's `new/`
  is listed on every poll; `read/` and `mail/` again when their own times move, when a message left
  `new/`, and at least every 10 s (a folder's times can stay the same for a while after a change). `agents` are the mail folders
  plus the agents in `.relay/agents.json`: `name` from `name.txt` (≤1 KB), else from
  `agents.json`; `unread` counts every file in `new/`, `since` is the oldest one's time; `wakes` is
  true when the relay wakes it, and `threadId` is the Codex thread it wakes (from `thread_id`, kept
  current when the relay follows a newer thread with the same name). `messages` are the newest 100
  unread and the newest 30 read for each agent, unread ones first when there are more than 300:
  `to` is the folder's key, `from` the sender's key (from the file name), `fromName` the `From:`
  line (≤80 chars), `at` the time in the file name, `text` the message after the head (≤1000
  chars, line breaks kept, only with snippets, else `null`). A file without a head is all text.

## Snapshot (`src/model.js`)

```js
export function buildSnapshot({ now, settings, claude, codex, mailbox, dismissed, actions })  // any source may be null
Snapshot = {
  version: 1, now,
  sources: { claude: SourceInfo, codex: SourceInfo, mailbox: SourceInfo | null },
  nodes: Node[], edges: Edge[], events: Event[], counts: { working, ready, idle, done, error, total },
  attention: [{ id: '<key>|<kind>', key, kind, text, at }],  // at is 0 when unknown
  tasks: MailboxState['tasks'] | null,
  mail: null | { name, unread, lastAt },  // agent mail: the person's mail name, their new mail, the newest message's time
  hiddenSessions: [{ key, title, platform, kind }],  // recent sessions with Role "Hide it": off the map, named in Settings
  actions: { openTerminal: boolean, rollover: boolean, newAgent: boolean, teleport: boolean },  // the page may show each button (setting on, Pleni on Windows)
}
SourceInfo = { enabled, ok, error, count }
Node = {
  key, parent, platform: 'human' | 'group' | 'claude' | 'codex',
  kind: 'person' | 'project' | 'session' | 'agent' | 'reviewer',
  title, subtitle, rank, role, tier: 'senior' | 'junior' | null,
  model, modelLabel, effort, status, startedAt, lastAt, activity, lastText,
  project, entrypoint, hidden, archived,
  memory,   // main Claude Code session or Codex thread: { used, size, percent, squeezes, squeezesAtLeast, squeezedAt }, else null
  rollSoon, // plain reasons it is due for a roll over ('Memory 87% full', 'Squeezed 3 times', '9 days old'), else null
  github,   // 'owner/name' of the GitHub repository the session works in (src/repos.js), else null
  mail,     // agent mail: { name, unread, since, wakes, toYou } for a tile with a mail name, else null
  watched,  // true for a session or the relay whose people[key].watch is true
}
Edge = { from, to, kind: 'spawn' | 'mailbox' | 'message' | 'contains', lastDown, lastUp, downLabel, upLabel, active: 'down' | 'up' | 'both' | null }
Event = { at, kind: 'spawn' | 'report' | 'message' | 'mailbox' | 'mail' | 'wake' | 'error', from, to, text }
        // a 'mail' event also has fromName and toName, the mail names, for a side that is not on the map;
        // a 'wake' event (from 'relay') has toName
```

- Tree: `you` (the person, `displayName`) → projects (when `groupBy` is `project`) → top-level
  sessions → sub-agents, recursively. A sub-agent whose parent is not listed hangs under its project.
- Relay and its workers: when the mailbox has relay files, a `relay` node (kind and platform
  `relay`, title "Relay" or the person's label, status working/idle/error from running, paused and
  halted) sits between the planner and the coordinator. The relay's worker runs
  (`tasks/<id>/workers/W<n>.run.json`) go under the coordinator; each line lights down when the run
  starts and up when it finishes. A run whose `session_id` names a top-level Claude Code session that
  Pleni lists is shown as that session (`claude:<id>`, titled `W<n> · <task>`), so it can be watched
  and opened like any session. Other runs (older ones kept no session file) become a session-like
  node `mailbox:<task id>/W<n>` (platform `claude`, kind `agent`, status from the run, project from
  its worktree).
- Roll over soon: `memory.percent` is `round(used / size × 100)` (at most 100), null while `size` is
  unknown. `rollSoon` lists, in this order, `Memory N% full` when `percent ≥ rollSoon.memoryPercent`,
  `Squeezed once`, `twice` or `N times` (`… or more` when `squeezesAtLeast`) when
  `squeezes ≥ rollSoon.squeezes`, and `N days old` when whole days since `startedAt` reach
  `rollSoon.days`; a limit of 0 is off. Only main sessions (kind `session`) with a `context` get
  `memory` and `rollSoon`; other nodes get null.
- Hidden sessions: a session whose `people[key].role` is `hidden` is left off the map. The ones that
  would otherwise be listed (recent, not archived) are in `hiddenSessions`, by title, so the page
  can count them and Settings can name them.
- Who reports to whom, strongest first: the person's choice (`people[key].reportsTo`, set by the
  Reports to menu or by dragging a tile), the mailbox (planner → relay → coordinator → its workers:
  fixed links, like a helper under the session that started it), a chain rule, and last the parent
  the session files give. The relay carries the coordinator's work to and from the boss the relay
  reports to, so a coordinator put right under that same boss (a person's choice made before the
  relay had a tile, say) goes under the relay instead. Names are looked up whole first: "Sergeant
  Claude" finds "**Sergeant Claude" (marks around a name ignored) before "Sergeant Claude Code";
  then the newest wins. The mailbox planner is never the coordinator itself. Every node gets
  `placement`: `'manual'`, `'rule'` or `'auto'`, and `named` (it has a real name). Hand-off
  directions follow the map as drawn, so a report to a boss a session was moved under lights that
  line upward. A message between tiles not joined by a tree line gets a `message` edge of its own
  while it is active.
- Chain of command: a `chain` rule whose `match` is in a session's name (its title or the
  person's label for it, ignoring case) puts it under the newest listed session (by `lastAt`) whose
  title contains `reportsTo`, or under the person for `'you'`; its `role` sets the rank. Matching
  by name means a rule follows a role when a new thread takes it over. Without a rule, the mailbox
  coordinator hangs under the mailbox planner (both may be given by key or by name), and otherwise
  the parent the session files give is kept. A rule whose boss is not listed changes nothing, and
  loops are broken. When the coordinator hangs under its planner, the tree line and the mailbox
  line are one `mailbox` edge.
- Project name: the last segment of `cwd`, except inside a worktrees folder (`/_worktrees/`,
  `/.codex/worktrees/<id>/`, `/.claude/worktrees/`) where it is the repository folder name. For
  `/_worktrees/<name>`, Pleni reads that worktree's `.git` pointer file (only on a local drive, only
  when it is a file of at most 4 KB; cached) and takes the repository name from its `gitdir:` line.
  Settings `projects[name].label` renames, `hidden` hides.
- GitHub repository (`github`): `githubRepo(cwd)` in `src/repos.js` climbs from the session's
  folder (at most 16 folders, local drives only) to the first `.git`. A folder's git settings are
  `.git/config`; a worktree's `.git` file (at most 4 KB) points to its git folder, whose
  `commondir` file (at most 4 KB) points to the shared one. From the config file (at most 64 KB)
  Pleni takes only the `url` of `[remote "origin"]`, else of the first remote. `parseRemote` reads
  `https://`, `http://`, `ssh://`, `git://` and `user@host:owner/name` forms and keeps only the host,
  owner and name, never a login or token. Only github.com (also `www.` and `ssh.`) counts. Answers
  are kept for a minute (at most 500). The demo names its repositories itself (`raw.github`, only
  `owner/name`). These and the `_worktrees` pointer above are the only files Pleni reads inside a
  project folder, and `docs/privacy.md` lists them.
- Listed sessions: active within `recentHours`, not archived, role not `hidden`, reviewers only with
  `showReviewers`. A quiet coordinator or superintendent (a Codex registry role) stays listed while a
  chain rule names it or a listed session hangs under it in the session files; the Codex source keeps
  following registered coordinators however old their files are. Chain rules never move a helper a
  session started itself (`spawned`).
- Edges: `contains` (person → project → session), `spawn` (parent → sub-agent, from links),
  `mailbox` (planner → coordinator, from mailbox events, when both nodes are listed; the coordinator
  defaults to `relay.coordinatorKey`), and `message` (between tiles that no tree line joins, only
  while active). `active` is set when `lastDown`/`lastUp` is within `PULSE_MS = 120000`.
- Agent mail: each mail name (an agent's key) is matched to a tile: the person (`you`) for the
  key of `mail.owner`, `owner`, or the key of `displayName`; else the Codex thread the relay wakes
  for it (`codex:<threadId>`), when listed; else the newest listed session (by `lastAt`) whose
  title, or the name the person gave it, has that same key. A tile with a mail name gets
  `mail = { name, unread, since, wakes, toYou }`: `toYou` counts the unread messages it sent the
  person; a tile with two names adds them up. Mail the person marked as read on the Mail page
  (`you|mailread` in the dismissed notices) no longer counts in `unread`, `toYou`, Needs you or
  `snapshot.mail.unread`, though its file stays in `new/`. Every message whose sender and receiver are both
  session tiles lights the line between them like a hand-off: along the tree lines, down when the
  receiver is below the sender and up when it is above; otherwise one `message` line for the two
  tiles (from the one whose key sorts first, `down` when that one sent it). Mail between the
  person and a session tile lights a line from `you` to that tile, `down` when the person sent it
  (the tree line itself, a `contains` edge, when the session hangs right under the person). A
  message never dims a line something newer lit.
- Relay wakes: `relay.wakes` comes from the relay's `state.json` (`mail_dispatches`: `agent`,
  `name`, `state`, `items`, `started_utc` and `finished_utc` in seconds). Each wake of an agent on
  the map lights the line from the relay to it, labelled "Woke it to read N new messages": along
  the tree when one is above the other, else a `message` line from the relay. Each wake is a
  `wake` event ("To read N new messages."); an agent not on the map has `to: null` and its
  `toName`. The label is the message as a snippet (≤120 chars, only with
  snippets). Each message with a side on the map is a `mail` event (`text` ≤280 chars, only with
  snippets); a side not on the map is `null`, and `fromName` and `toName` still name it.
- Ranks: `plain` — the person shows only `displayName`, session "Lead", sub-agent "Agent",
  reviewer "Reviewer", and a session with the role superintendent or coordinator "Superintendent"
  or "Coordinator"; `military` — person "General", superintendent "Colonel", coordinator and lead
  "Sergeant", senior-tier agent "Specialist", other agent "Private"; `company` — person "Owner",
  superintendent "Vice President", coordinator "Manager", lead "Supervisor", agent "Worker". Roles come
  from `people[key].role`, else top-level sessions are `lead` and sub-agents `worker`. Tier comes from
  `modelTiers`: an exact model name in either list wins (so `gpt-6.1-sol` can be senior while the word
  `sol` is junior), then whole-word matches, senior words first. The Settings page lists the models
  in use with a rank menu that writes exact names.
- `modelLabel`: a short readable name (`claude-opus-5-5` → "Opus 5.5", `gpt-6.1-sol` → "GPT-6.1 Sol").
- Sorting: children by title (locale compare), then key. Never by activity.
- Attention ("Needs you"), by `kind`: `needs` (a session asks something), `error` (a session
  stopped with an error), `question` and `review` (mailbox tasks, keyed `task:<id>`); from the
  mailbox, `note` (the newest `NEEDS-<NAME>.md` note, on the coordinator's tile, or the person's
  when the coordinator is not listed), and on the relay tile `alert` (the newest relay alert),
  `halted` (instead of `alert`, with the reason and what to run) and `paused` (`at` is when it
  paused). `note` and `alert` count only within `recentHours`. `mail` is unread agent mail for the
  person, one notice for each sender tile ("Sergeant Ada sent you 2 messages. The newest: …", the
  newest message only with snippets); senders not on the map share one notice on `you`. It stays,
  however old, until the person reads the mail (it moves to `read/`) or dismisses it. `stopped` is for a watched tile: a
  session that is not working, not asking and not in error, whose own `lastAt` is at least
  `alerts.stoppedMinutes` old, or a relay whose `state.json` is that old. A tile's `lastAt` also
  counts the work of the tiles below it, so the session's own time is used. Mailbox worker runs
  (`mailbox:` keys) cannot be watched. The snapshot is rebuilt on each poll with the current time,
  so a `stopped` notice appears without any file changing.

## Store (`src/store.js`)

```js
export function createStore({ settings, roots, demo = false, now = Date.now, stateDir = null, platform = process.platform })
// -> { snapshot(): Snapshot, detail(key, since), reload(settings, roots), close(), dismiss(id, at),
//      session(key): { id, cwd, status, entrypoint, kind, title, titleSource, model, effort, mode } | null, demo: boolean }
```

Creates the enabled sources (or the demo source), polls at most every 2 s on demand, caches the
snapshot with its JSON and its ETag, and rebuilds when settings change. `snapshot().actions.openTerminal`
is `settings.actions.openTerminal` and `platform === 'win32'`, and `actions.rollover`,
`actions.newAgent` and `actions.teleport` the same for their settings. `session(key)` gives what the newest poll knows
about a top-level Claude Code session or a Codex thread (`{ id, cwd, status, entrypoint, kind,
title, titleSource, model, effort, mode }`) for Open in PowerShell, Roll over and New agent, and
`null` for anything else and in the demo. The ETag is
`snapshotTag(snapshot)` from `src/model.js`: `W/"<sha1 of the JSON with now set to 0>"`. `now`
changes on every build, and the page needs it only to allow for a clock difference, so a snapshot
that changed only its time keeps its ETag and the page's poll gets `304`.

## Open in PowerShell (`src/open.js`)

The one action Pleni takes. It is off until the person turns it on (`actions.openTerminal`), works
only on Windows for now, and the server allows it only for a request made on the computer that runs
Pleni. Pleni starts the window and nothing else: whatever is typed there comes from the person.

```js
export async function openSession({ key, settings, roots, store, limits, platform, env, home, spawn, now, isAlive, isLocked, processStarts })
// -> { ok: true } | { ok: false, status, error }   (error is a plain sentence from OPEN_MESSAGES)
export function openProblem(session, processes)          // Claude Code: plain reason it is unsafe, or null
export function codexProblem(session, locked)            // Codex: plain reason it is unsafe, or null
export function claudeProcesses(root, sessionId, isAlive) // -> [{ pid, kind, status, entrypoint, writtenAt }]
export async function confirmProcesses(found, processStarts) // -> the ones whose process really wrote the file
export function windowsProcessStarts(pids, { systemRoot, execFile }) // -> Promise<Map<pid, ms | null>>
export function codexThreadLocked(root, threadId)        // -> true while another program writes the thread
export function powershellCommand(tool, id, systemRoot)  // -> { file, args }
export function toolEnv(tool, env, root, home, platform) // -> env for the window
export function openLimits()                              // -> { take(key, now): reason | null }
```

- What can be opened: `claude:<session id>` or `codex:<thread id>` (a lower-case UUID). A Codex
  helper is a thread of its own that Codex can resume by itself, so it opens itself. A Claude Code
  helper lives inside its session's process: its key gets "open the session that started it". A
  Codex automatic reviewer is refused, and any other key gets "only Claude Code and Codex
  sessions". The demo has nothing to open. The session must be on the map, and
  `store.session(key)` must know its folder.
- The folder must be an existing absolute directory, and not a network path (`\\server\share`):
  cmd.exe cannot start there and would fall back to the Windows folder.
- **One writer per conversation (Claude Code).** Two processes writing one transcript mix it up. A
  session whose newest records come from the Claude desktop app or VS Code (`entrypoint`
  `claude-desktop` or `claude-vscode`) is refused with "open it there": those apps may hold a
  session open without a file Pleni can see. Claude Code keeps a small file per running process in
  `<root>/sessions/<pid>.json` (`pid`, `sessionId`, `kind`: `'interactive'` or `'background'`,
  `status`, `entrypoint`; files at most 64 KB, at most 500 read). Pleni reads them only when asked
  to open, and counts a file only while its process number is in use (signal 0; `EPERM` counts as
  in use). A file can outlive its process: a window closed with its X ends Claude Code before it
  removes the file, and Windows soon gives the number to another program. So `confirmProcesses`
  then asks when each such process started (`windowsProcessStarts`: one hidden
  `powershell.exe -NoProfile -NonInteractive` running `Get-Process -Id <numbers>`, with only whole
  numbers in the command, started in `%SystemRoot%`, 15 s at most), and keeps a file only while
  its process started no later than the file last changed (2 s allowed for clocks). A process
  Windows will not describe, or one that is gone, does not count; if the question cannot be asked
  at all, every file counts. A live process of any kind but `'background'` refuses: "open in
  another window" when its `entrypoint` is `cli` (a terminal), else "busy in another program". A
  session that is `working` with no live process (a `claude -p` script, or another app) refuses
  ("try again when it finishes"). A live background session is allowed: `claude --resume` shows
  that running session live (Claude Code 2.1.285 or newer).
- **One writer per thread (Codex).** Codex itself lets one program write a thread at a time: while
  it writes, it holds an operating-system lock on `<root>/thread-writer-locks/<thread id>.lock`
  (no contents), and a second program gets "thread … already has an active writer". Pleni checks
  first, so the person gets a plain answer instead of an error in a new window: it opens that one
  file read-only and reads one byte. Windows refuses the read while another program holds the
  lock (`EBUSY`, `EACCES` or `EPERM`), which refuses ("another Codex program has this thread open,
  most likely the Codex app"). A missing file counts as free. A thread that is `working` refuses
  ("try again when it finishes").
- **Limits** (`openLimits`): one window per session every 10 seconds, and 10 a minute in all. The
  limit is taken after every other check, and `take` checks and records in one step, so two quick
  clicks cannot both get through, and a refusal does not use up the next try.
- **The command.** `cmd.exe /d /s /c "start "<title>" "<powershell.exe>" -NoExit -NoLogo -Command
  "<resume> '<id>'""`, where `<title>` and `<resume>` are `Claude Code` and `claude --resume`, or
  `Codex` and `codex resume`. It is spawned with `cwd` set to the session's folder, `detached` (so
  cmd.exe gets no console window; `start` opens PowerShell in a new one), `stdio: 'ignore'`,
  `windowsHide: false` (a hidden start could hide the new window too) and
  `windowsVerbatimArguments`. Both programs are named by their full path under `%SystemRoot%`, used
  only when it is a plain folder such as `C:\Windows` (else `C:\Windows` itself). So a program with
  the same name in the session's folder never runs instead, and nothing in the line can be read as
  a second command: every part is fixed except the id, which is checked. The answer comes when
  cmd.exe has started.
- **The tool's folder** (`toolEnv`): `claude` looks in `$CLAUDE_CONFIG_DIR`, else `~/.claude`, and
  `codex` in `$CODEX_HOME`, else `~/.codex`. When Pleni reads a tool from another folder, the window
  gets that variable set to it; otherwise the environment is passed on unchanged, because naming
  Claude Code's usual folder there is not the same as leaving it unset.

## Roll over (`src/rollover.js`)

Starts a fresh session that takes over from a long one, so the work stays quick and costs less. It
is off until the person turns it on (`actions.rollover`), works only on Windows for now, and the
server allows it only for a request made on this computer. It has two steps, each a PowerShell
window the person sees. Unlike Open in PowerShell, each window sends one message, but only a fixed
one that Pleni builds from the session's own name and that the page shows before the click.

```js
export function rolloverPlan(tool, session)   // -> { name, problem, file, ask, start, rename, carry }
export function carryOver(tool, session)       // -> { model, effort, mode }, each null unless plain
export function rolloverInfo({ key, settings, store, platform, stat }) // -> { ok: true, info: { ...plan, handoffAt } } | { ok: false, status, error }
export async function rollover({ key, step, name, settings, roots, store, limits, platform, env, home, spawn, now, isAlive, isLocked, processStarts })
// -> { ok: true } | { ok: false, status, error }   (error is a plain sentence)
export function ownName(tool, session)         // the name the tool keeps for the session, or null
export function nameProblem(name)              // why the name cannot go on a command line, or null
export function handoffFile(name)              // 'HANDOFF-<name in lower case, a-z0-9 and dashes, ≤40>.md'
export function askText(file), startText(name, file)
export function claudeRollProblem(step, session, processes), codexRollProblem(step, session, locked)
export function rollCommand(tool, step, { id, name, text }, systemRoot) // -> { file, args }
```

- **What can be rolled over:** a main session on the map: `claude:<session id>` or
  `codex:<thread id>` with kind `session` (not a helper or a reviewer), and not in the demo. It
  needs a name the person gave it, because the new session takes that name and the relay and
  chain rules find sessions by name: a Claude Code `custom-title` or `agent-name` record (from
  `/rename` or `--name`), or a Codex `session_index.jsonl` thread name. A title the tool made up
  (`ai-title`) does not count. The name must be at most 80 characters of letters, digits, spaces
  and `. _ - # + * ,`, start with a letter, a digit or `*`, and hold a letter or digit: these marks
  are plain text to cmd.exe inside double quotes, to PowerShell inside single quotes, and to the
  `.cmd` files npm makes. Otherwise the page says how to rename it.
- **The handoff note** is `handoffFile(name)` in the session's own folder, for example
  `HANDOFF-sergeant-ada.md`. The old session writes it; Pleni never writes or reads it, and only
  asks for its time (`handoffAt`, from `fs.statSync`, a file only) so the page can say it is there.
- **The messages** (letters, digits, spaces and `. _ - # + * , :` only, checked again in
  `rollCommand`):
  - ask: `Pleni roll over: a new session will take over your work. Write a handoff note for it in
    <file> in this folder. Say what work is open and where it stands, what waits on whom, and what
    else it must know. Copy in every standing instruction you were given and still follow, such as
    how to report, how to pick a model and effort, and what you may and may not do. Do not commit
    the file. Then stop.`
  - start: `Pleni roll over: you take over from the last session named <name>. First read <file>
    in this folder, and follow the standing instructions in it. Then say in one line that you are
    ready.`
- **What carries over** (`carryOver`): the old session's model (letters, digits and `. _ -`, at
  most 80), its effort (Claude Code: low, medium, high, xhigh, max; Codex: minimal, low, medium,
  high, xhigh), and for Claude Code its newest permission mode when it is acceptEdits, auto,
  bypassPermissions, dontAsk or plan (the normal mode needs no flag). Anything else is left out.
  Codex keeps its permissions in its own settings, which the new thread reads anyway.
- **The commands**, in the same `cmd.exe /d /s /c "start "<title>" "<powershell.exe>" -NoExit
  -NoLogo -Command "<run>""` line as Open in PowerShell, spawned the same way in the session's
  folder with `toolEnv`:
  - ask: `claude --resume '<id>' '<ask>'`, or `codex resume '<id>' '<ask>'`;
  - start: `claude --name '<name>' [--model '<model>'] [--effort <effort>] [--permission-mode
    <mode>] '<start>'`, or `codex [-m '<model>'] [-c model_reasoning_effort=<effort>] '<start>'`.
    Codex cannot name a thread when it starts, so the page shows `/rename <name>` for the person to
    type in the new window. The page's note says what the new session starts with.
- **One writer.** Asking resumes the old session, so it follows Open in PowerShell's checks
  (`openProblem`, `codexProblem`), except that a live Claude Code background session is refused too:
  the message must not land in a turn that is already running. A Claude desktop app or VS Code
  session, and a Codex thread another program holds (most likely the Codex app), get "copy the
  message and paste it there". Starting needs the old Claude Code session closed (no live process
  of any kind, and not `working`): Claude Code gives a new session another name while one with the
  same name still runs. A Codex thread only needs to not be `working`, because the Codex app holds
  every thread it has opened.
- **The name the page showed.** The step request carries the name; if the session's name changed
  since, nothing starts ("look at the steps again"), so the message sent is the one the person saw.
- **Limits** are Open in PowerShell's (`openLimits`, shared): asking takes the session's own
  "just opened" slot, starting takes `start:<key>`.

## New agent (`src/newagent.js`)

Starts a new Claude Code session or Codex thread in a PowerShell window, in the folder of a session
on the map, so a team can grow from Pleni. It is off until the person turns it on
(`actions.newAgent`), works only on Windows for now, and the server allows it only for a request
made on this computer. Pleni sends nothing: the person types the first message in the window.

```js
export async function newAgent({ from, tool, name, settings, roots, store, limits, platform, env, home, spawn, now })
// -> { ok: true } | { ok: false, status, error }   (error is a plain sentence)
export function cleanName(name)            // spaces squeezed and trimmed; '' for a non-string
export function newNameProblem(name)       // why the name cannot be used, or null
export function takenMessage(name)         // the refusal for a name a session on the map has
export function newAgentCommand(tool, name, systemRoot) // -> { file, args }
```

- **Where:** `from` is a session on the map, `claude:<session id>` or `codex:<thread id>` (a main
  Claude Code session, or any Codex thread but a reviewer), not in the demo. The new agent works in
  that session's folder (`store.session(from).cwd`, checked with `folderProblem`), so the page never
  sends or needs a path. `tool` is `claude` or `codex`, whatever tool `from` is.
- **The name** is needed: `cleanName(name)` must pass Roll over's name rule (`nameFits`: at most 80
  characters of letters, digits, spaces and `. _ - # + * ,`, starting with a letter, a digit or
  `*`). No Claude Code or Codex tile on the map may have the same name, ignoring case and extra
  spaces, because Pleni and the relay find agents by name; Roll over is the way to replace one.
- **The command**, in Open in PowerShell's `cmd.exe /d /s /c "start "<title>" "<powershell.exe>"
  -NoExit -NoLogo -Command "<run>""` line, spawned the same way in the folder with `toolEnv` for the
  new agent's tool: `claude --name '<name>'`, or `codex`. Codex cannot name a thread when it
  starts, so the page shows `/rename <name>` for the person to type after the first message.
- **Limits** are Open in PowerShell's (`openLimits`, shared), with the slot `new:<from>`: a second
  click from the same side panel within a few seconds starts nothing.
- **Bring a cloud session here** (`teleport({ from, settings, roots, store, limits, platform, env,
  home, spawn, now })`, `teleportCommand(systemRoot)`): off until `actions.teleport`. `from` must be
  a main Claude Code session on the map (`claude:<session id>`, kind `session`), not in the demo,
  with a folder `folderProblem` accepts. The window runs `claude --teleport` in that folder with
  `toolEnv('claude', …)`; Claude Code lists the person's claude.ai cloud sessions there and checks
  its own needs (the same repository, no unsaved changes, the session's branch pushed). Limits:
  `openLimits`, slot `teleport:<from>`.

## Live GitHub status (`src/github.js`)

Off until `settings.github.live`. Pleni never talks to GitHub itself: it runs the GitHub CLI (`gh`)
on the computer that runs Pleni, which uses the person's own gh login.

```js
export function createGithub({ execFile, env, platform, isFile, now })  // -> { status, merge }
export function findGh(env, platform, isFile)            // -> the full path of gh, or null
export function listArgs(repo)                           // -> gh pr list arguments
export function mergeArgs(repo, number, method, head)    // -> gh pr merge arguments
export function parsePulls(text, repo)                   // -> Pull[], or null when it is not a list
export function ghOutcome(err, stdout, stderr)           // -> { ok, stdout, error }
export function isRepoPath(value)                        // plain 'owner/name'
export const GITHUB_MESSAGES, MAX_REPOS /* 12 */, MERGE_METHODS /* ['squash', 'merge', 'rebase'] */

// Pull
{
  number, title,         // title: control and direction marks removed, at most 200 characters
  url,                   // https://github.com/<repo>/pull/<number>, built by Pleni
  state,                 // 'open' | 'draft' | 'merged' | 'closed'
  branch, base, fork,    // head branch, base branch, whether it comes from another repository
  head,                  // the head commit id (40 hex digits), or null
  updatedAt,             // ms, or null
  checks,                // 'passing' | 'failing' | 'running' | 'none'
  failing,               // up to 3 names of failing checks
  review,                // 'approved' | 'changes' | 'needed' | null
  merge,                 // open ones: 'ready' | 'conflict' | 'behind' | 'blocked' | 'unstable' | 'draft' | 'checking'
  why, canMerge,         // why Pleni will not merge it yet, in plain words (null when it will)
}
```

- **Finding gh:** the first `gh.exe` (`gh` elsewhere) in an absolute, local folder on `PATH` (the
  name `PATH` in any case on Windows). The current folder and network shares never count, so a
  program named gh in a project never runs instead. Where gh is found is kept for a minute.
- **Running gh:** `execFile` with that full path and no shell, in `os.tmpdir()` (away from any
  repository), hidden, with a 30-second limit and at most 8 MB of output, and with
  `GH_PROMPT_DISABLED`, `GH_NO_UPDATE_NOTIFIER`, `GH_NO_EXTENSION_UPDATE_NOTIFIER`,
  `GH_SPINNER_DISABLED` and `NO_COLOR` set. The repository goes on the command line as
  `github.com/<owner>/<name>`, so a `GH_HOST` setting cannot send it to another server.
- **Asking:** `gh pr list --repo github.com/<repo> --state all --limit 30 --json
  number,title,url,state,isDraft,headRefName,headRefOid,baseRefName,isCrossRepository,updatedAt,reviewDecision,statusCheckRollup,mergeable,mergeStateStatus`.
  `status({ repos, fresh })` asks about at most `MAX_REPOS` valid repositories, sorted, and answers
  `{ error, repos: [{ repo, at, pulls, error }] }`; the outer `error` is set (and `repos` empty) when
  gh cannot be found. Each answer, a failed one too, is kept for a minute; `fresh` asks again once
  it is 10 seconds old. Two pages asking at once share one gh run.
- **Checks:** a check run passes when it completed with `SUCCESS`, `NEUTRAL` or `SKIPPED`, and is
  running until it completes; a commit status passes with `SUCCESS` and is running while `PENDING`
  or `EXPECTED`. Anything else counts as failed, so Merge is never offered by mistake.
- **Why not**, in this order: merged, closed, a draft, a merge conflict, failing checks (or GitHub's
  `UNSTABLE`), running checks, changes asked for, behind its base branch, blocked, and GitHub still
  checking (or no head commit). `canMerge` is true only when none applies, which needs GitHub's
  `MERGEABLE` with `CLEAN` or `HAS_HOOKS`.
- **Errors**, in plain words: gh missing, gh not signed in (exit code 4), too slow, else "GitHub
  said: " with the first line gh wrote, or "GitHub did not answer".
- **Merge:** `merge({ repo, number, head, method, known })`. The repository must be on the map
  (`known`), `number` a whole number, and `head` a commit id. Three merges a minute in all, and one
  at a time per pull request. Pleni asks GitHub again first and refuses unless the pull request is
  still on `head` and `canMerge`. Then it runs `gh pr merge <number> --repo github.com/<repo>
  --<method> --match-head-commit <head>`, so GitHub refuses too if anyone pushed since; never
  `--admin`, `--auto` or `--delete-branch`. After a merge, the next look asks GitHub again. It
  answers `{ ok: true }` or `{ ok: false, status, error }`.

## Models (`src/models.js`, `src/toml.js`)

The Models page shows the model and effort Codex agents start with, and with `settings.models.edit`
on, changes them on this computer when the person chooses Save to Codex. Codex reads its settings
when a thread starts, so new threads and the relay's wake-ups (`codex exec resume`, which runs on
`config.toml`'s model, not the thread's) use a change at once; a running thread keeps what it
started with. Codex reads a worker type file again each time a worker starts.

```js
export function readCodexModels({ root, seen })  // -> CodexModels (reads only)
export function createModelSaver({ now })         // -> { save({ root, backupDir, tag, changes }) }
export function readCatalog(root)                 // -> [{ id, label, efforts, defaultEffort, hidden }]
export function modelChoices(catalog, seen, set)  // -> the models the page offers
export const EFFORTS /* ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] */, MODELS_MESSAGES, PLENI_MARK

// CodexModels
{
  ok, error,             // error: why Pleni could not read the settings, in plain words
  folder, file, found,   // the Codex folder, <folder>/config.toml, and whether it is there yet
  tag,                   // 24 hex digits of SHA-256 over config.toml and the worker type files
  listed,                // true when Codex keeps a model list here (models_cache.json)
  sergeant: { model: Line, effort: Line },   // model, model_reasoning_effort
  worker: { model: Line, effort: Line },     // [agents] default_subagent_model, default_subagent_reasoning_effort
  types: [{ file, name, description, model: Line, effort: Line, pleni, error }],
  models: [{ id, label, efforts, defaultEffort, unlisted }],
  efforts,               // EFFORTS, then any other level Codex's list names
}
// Line: { value, set, editable }. value is null unless the line holds a one-line string; set is
// whether the line is there; editable is false when Pleni would not change it (see toml.js).
```

- **Files:** `<codex root>/config.toml` (the root `resolveRoots` gives, `$CODEX_HOME` or `~/.codex`),
  and the worker types: every `*.toml` in `<codex root>/agents/` and in folders in it, two levels
  down at most, 50 files at most, as Codex reads them. A type's `file` is its path in that folder
  with `/` between folders. Each file is read whole, at most 256 KB, and must be UTF-8 that writes
  back to the same bytes; otherwise it is shown with an error and never changed.
- **Model list:** `<codex root>/models_cache.json`, which Codex keeps fresh for the account (at most
  4 MB; read again once when it does not parse, because Codex writes it in place). From `models`:
  `slug` → `id`, `display_name` → `label` (else `modelLabel`), `supported_reasoning_levels[].effort`
  → `efforts`, `default_reasoning_level` → `defaultEffort`, `visibility` other than `list` →
  `hidden`, sorted by `priority`. Nothing else in the file is read or shown. With a list, the page
  offers its models that are not hidden, plus any other model a line names (`unlisted` when Codex
  does not list it). Without one, it offers the models of the Codex sessions on the map, most used
  first, plus the ones the lines name, and lets the person type a name.
- **Saving:** `save` refuses with `429` after 10 saves in a minute. It reads everything again and
  refuses (`409`) unless `tag` still matches. Each value is checked: a model name is
  `[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,99}`, and with a model list it must be on it (hidden ones count),
  because Codex will not start a worker with any other; an effort must be in `efforts`; and when
  the model of a pair is on the list, its effort must be one that model takes. null takes the line
  out. All new file texts are worked out first with `setTomlText` and `removeTomlKey`, then read
  back with `scanToml`; a line Pleni does not change (see below) refuses the whole save (`409`).
  Then each old file is copied to `<backupDir>/codex-<name>-<yyyyMMdd-HHmmss>.toml` (the newest 20
  of each are kept), and each file is checked once more against the bytes Pleni read and written
  through a temp file in the same folder and `renameWithRetry`. It answers `{ ok: true, files,
  backups }` or `{ ok: false, status, error, files }` (`files`: those already written).
- **Adding a worker type** (`changes.add: { name, description, model }`): `name` is
  `[a-z][a-z0-9_-]{0,39}`, not one of Codex's own types (`default`, `explorer`, `worker`), not a
  Windows device name, and not used by another type file (by file name or `name`); `description`
  is 1–300 characters with no control characters; `model` is null or checked as above. Pleni writes
  a new file, never over one, at `<codex root>/agents/<name>.toml`: a first line `PLENI_MARK`, then
  `name`, `description`, `model` (when given) and a short `developer_instructions`, which Codex
  needs. No other keys, because Codex drops a type file with a key it does not know.
- **`src/toml.js`:** `scanToml(text)` finds the statements of a TOML file (table headers, array
  table headers, and `key = value` lines with bare, quoted or dotted keys) and skips over strings
  of all four kinds, arrays and inline tables, which may run over lines, and comments. It answers
  `{ ok: false }` for anything it does not understand. `tomlText(items, path)` reads a one-line
  string. `setTomlText(text, path, value)` changes only the value of an existing line (a comment
  after it stays), or adds a line after the table's header, or after the last top-level value, or
  in a new table at the end (a dotted line when dotted keys made the table). `removeTomlKey` takes
  out the whole line. Neither touches a key that is there twice, holds something other than a
  one-line string, or sits inside an inline table or an array of tables, and both keep CRLF line
  breaks and a BOM. A path is one key, or a table and a key.

## Server (`src/server.js`)

```js
export function newKey()  // -> 43 random base64url characters (32 bytes)
export function createServer({ store, getSettings, saveSettings, publicDir, version, key, platform, spawnProcess, github, modelSaver })  // -> http.Server
export function keyFile(settingsPath)  // -> the "key" file next to the settings file
export function readKeyFile(file, { tries, pause, read })  // -> { key } | { missing: true } | { problem: 'damaged' | <error code> }
export function keyFileError(file, problem)  // -> Error with code 'PLENI_KEY_FILE' and a plain message
export function loadOrCreateKey(file, { renew, tries, pause })  // -> { key, saved }; throws keyFileError
export async function start({ port, configFile, demo, open, renewKey })  // -> { server, url, key, keySaved, close }
```

- Bind `127.0.0.1` only.
- **Host gate:** allow `localhost`, `127.0.0.1` and `[::1]` with any port. Any other host is allowed
  only when it is listed in `remote.hosts` and the request's `Tailscale-User-Login` header is listed
  in `remote.tailscaleUsers` (both compared lower-case). Otherwise `403`: JSON `{ error }` for
  `/api/` paths, and for a page a plain-text answer that says to choose Allow in Settings → Devices
  on the computer that runs Pleni. This also blocks DNS rebinding. A refused request whose host is
  a Tailscale name (`<machine>.<tailnet>.ts.net`, which no web site can point at this computer) and
  that carries a `Tailscale-User-Login` of the form `name@domain` is kept as a turned-away device
  `{ host, login, at }`: in memory only, the newest 5, one per host and login.
- **Key gate:** the host gate stops web sites, but every account and program on the computer can
  reach `127.0.0.1` and send any header, Tailscale's included. So every API request also needs a key.
  Demo mode always uses a throw-away key. `url` is `http://localhost:<port>/?t=<key>`, which the CLI
  prints and `--open` opens. `createServer` takes the key (letters, digits, `-`, `_`; at least 16;
  a new one when left out) and keeps only its SHA-256.
  - `GET`/`HEAD /?t=<key>` answers `303` to `/`. When the key is right it also sets
    `pleni-<local port>=<key>; Path=/; Max-Age=31536000; HttpOnly; SameSite=Strict` (one name per port, so two Plenis
    do not overwrite each other). A wrong key gets the redirect without a cookie.
  - Every `/api/` route except `/api/health` needs that cookie, compared in constant time (SHA-256
    of both, then `timingSafeEqual`), after the method check. Without it: `401` with a plain
    message. Remote requests need it too: the Tailscale headers prove nothing on their own.
  - The page files and `/brand/` need no key; they hold no session data.
- **Key file:** `start()` reads the key from the `key` file next to the settings file (`keyFile`)
  before it starts anything else. The key never changes on its own, because a new key would break
  every bookmark and every signed-in browser:
  - `readKeyFile` tries a read that fails with `EPERM`, `EACCES` or `EBUSY` (a Windows virus
    scanner or backup tool holding the file) again every 500 ms, 20 times in all.
  - `loadOrCreateKey` makes a key with `newKey()` only when there is no key file yet (`ENOENT`, or
    `ENOTDIR` when a file stands where its folder should be) or `renewKey` is set (`--new-key`). The
    file is written with mode 0600 through a temp file (`renameWithRetry`). If it cannot be written,
    the key lasts only this run (`saved: false`).
  - A key file that still cannot be read, or that does not hold a key, is never replaced:
    `loadOrCreateKey` throws `keyFileError`, and the CLI prints its message and stops with exit 1.
- **`--url`** (CLI): prints the plain address `http://localhost:<port>/`, one `https://<host>/` line
  per `remote.hosts` entry, the key, and the sign-in link `http://localhost:<port>/?t=<key>`. The
  port is `--port`, else `PLENI_PORT`, else the settings. It reads the settings and the key file
  (`readKeyFile`), starts nothing and writes nothing. No key file yet, or one that cannot be used,
  prints a plain message and exits 1; so does `--demo`, whose key does not last.
- **Headers on every response:** `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`, `Cross-Origin-Opener-Policy: same-origin`,
  `Cross-Origin-Resource-Policy: same-origin`. HTML also gets
  `Content-Security-Policy: default-src 'none'; script-src 'self'; style-src-elem 'self'; style-src-attr 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`.
- **Routes:** `GET /` (index.html; `/?t=<key>` redirects, see above), `GET /app.js`, `GET /styles.css`, `GET /brand/<file>` (names
  `[a-z0-9._-]+`, extensions png, svg, ico, webp; resolved inside `public/brand` only),
  `GET /favicon.ico`, `GET /api/health`, `GET /api/snapshot` (weak ETag, `304` on match),
  `GET /api/session?key=<nodeKey>&since=<offset>`, `GET /api/settings`, `POST /api/settings`,
  `POST /api/placement`, `POST /api/dismiss`, `POST /api/watch`, `POST /api/open`,
  `GET /api/rollover?key=<nodeKey>`, `POST /api/rollover`, `POST /api/new`, `POST /api/teleport`,
  `GET /api/devices`, `GET /api/github`, `POST /api/github/merge`, `GET /api/mail`,
  `GET /api/models`, `POST /api/models`.
  `HEAD` mirrors `GET`. Other methods get `405`; unknown paths `404`.
- `GET /api/snapshot` sends the JSON and ETag the store made (`snap.json`, `snap.etag`), or makes
  them the same way (`snapshotTag`) for a store that did not. Its answers, `304` included, carry
  `X-Pleni-Version` (from package.json) and, when Pleni runs from a git copy, `X-Pleni-Build`: the
  short commit id from `readBuild()`, which reads only `.git/HEAD` and the branch it names (its file
  under `refs/`, else its line in `packed-refs`) in Pleni's own folder. A branch name with a part
  that starts with a dot is not read. `createServer({ version, build })` can set both for tests.
- **POST /api/settings** requires the key cookie, `X-Pleni: settings`, `Content-Type:
  application/json`, a body of at most 64 KB, and an `Origin` (when present) whose host equals the
  request host. The body is cleaned with `cleanSettings`, saved, and the store reloaded.
- **POST /api/dismiss** `{ id: '<key>|<kind>', at: number | null }` passes the same checks; `kind`
  is one of `needs`, `error`, `question`, `review`, `alert`, `paused`, `halted`, `note`, `stopped`,
  `mail`, `mailread`. It hides that notice while its `at` is not newer than the given time (a
  session's `needs` becomes null too), and `at: null` brings it back. `you|mailread` is the Mail
  page's "Mark all as read": the time of the newest mail the person has read. Dismissals are kept in `dismissed.json` next to the settings (at most
  1000), so every device sees the same; the demo keeps them in memory.
- **POST /api/placement** `{ key, reportsTo: nodeKey | 'you' | null }` passes the same checks and
  saves `people[key].reportsTo` (null removes it). It refuses the person, projects, sessions that
  are not on the map, and a boss below the session itself (a loop), and answers `{ ok: true }`.
- **POST /api/watch** `{ key, watch: boolean }` passes the same checks and saves
  `people[key].watch` (`false` removes it). Only a session on the map or the relay can be watched:
  other keys get `400`, a tile that is not on the map `404`. It answers `{ ok: true }`.
- **POST /api/hide** `{ key, hide: true }` passes the same checks and saves `people[key].role =
  'hidden'` for a Claude Code, Codex, Grok or Kimi Code session or helper on the map (kind session,
  agent or reviewer; other keys `400`, a tile not on the map `404`). It answers
  `{ ok: true, role }` with the role it had before (null for none). `{ key, hide: false, role }` puts
  that role back (one of `superintendent`, `coordinator`, `lead`, `worker`, or null to remove it),
  only when the session is hidden now; the session need not be on the map.
- **POST /api/open** `{ key }` passes the same checks, then refuses (`403`) a request that is not
  from this computer: a host other than the loopback names, or one carrying `Tailscale-User-Login`
  or `X-Forwarded-For` (a proxy such as `tailscale serve` passed it on). `openSession` in
  `src/open.js` makes the rest of the checks and opens the window; it answers `{ ok: true }` or
  `{ error }` with the status it gives. `platform` and `spawnProcess` (a stand-in for
  `child_process.spawn`) let tests run this without opening anything.
- **GET /api/rollover?key=<nodeKey>** needs the key cookie and, like `/api/open`, a request from this
  computer (`403` otherwise). It answers `rolloverInfo`'s `{ name, problem, file, ask, start, rename,
  handoffAt }`, or `{ error }` with its status. It starts nothing.
- **POST /api/rollover** `{ key, step: 'ask' | 'start', name }` passes the same checks as
  `/api/open`, then `rollover` in `src/rollover.js` makes the rest and opens the window. It answers
  `{ ok: true }` or `{ error }` with the status it gives. Both share the server's `openLimits`.
- **POST /api/new** `{ from: nodeKey, tool: 'claude' | 'codex', name }` passes the same checks as
  `/api/open`, then `newAgent` in `src/newagent.js` makes the rest and opens the window. It answers
  `{ ok: true }` or `{ error }` with the status it gives, and shares the server's `openLimits`.
- **POST /api/teleport** `{ from: nodeKey }` passes the same checks as `/api/open`, then `teleport`
  in `src/newagent.js` makes the rest and opens the window.
- **GET /api/github** (`?fresh=1` for Look again) needs the key cookie. It answers `{ on, merge,
  method, error, repos }`. `on` is `settings.github.live`; `merge` is true when `live` and `merge`
  are both on and the request is from this computer (like `/api/open`); `method` is
  `settings.github.mergeMethod`. When `on` is false, `repos` is empty and nothing runs. Otherwise
  `error` and `repos` come from `github.status` for the repositories on the map (`node.github`,
  reviewers left out), or from `demoGithub` in the demo. Another device gets the same status, with
  `merge: false`. `createServer({ github })` lets tests replace `createGithub()`.
- **GET /api/mail** (`?all=1` for every message) needs the key cookie. It answers `{ on: false, name:
  null, readAt: null, messages: [] }` without agent mail, else `{ on: true, name, readAt, messages }`
  from `store.mail({ all })`: the person's mail name, the `you|mailread` time (or null), and up to
  100 messages, newest first: `{ id, to, toName, from, fromName, at, unread, text, toYou, fromYou }`.
  Without `all`, only messages to or from one of the person's mail names (`personMailKeys`: the
  relay's `owner_name`, `owner`, the name in Settings). `text` is the whole message (at most 64 KB),
  null when `content` is `none`. The mailbox source reads these files only for this request
  (`source.mail({ keys, all })`), never on a poll; the demo makes them from its own mail.
- **GET /api/models** needs the key cookie. It answers `{ edit, here, demo, codex }`: `edit` is
  `settings.models.edit`, `here` whether the request is from this computer (like `/api/open`), and
  `codex` is `readCodexModels` for `roots.codex`, with the models of the Codex sessions on the map
  (reviewers left out), or `demoModels()` in the demo. It only reads.
- **POST /api/models** `{ tag, sergeant?, worker?, types?, add? }` passes the same checks as
  `/api/open` (this computer only), needs `settings.models.edit` (`403` otherwise), and is refused in
  the demo (`409`). `createModelSaver().save` makes the rest, with `backupDir` the `backups` folder
  next to the settings file, and its answer is sent with the status it gives.
  `createServer({ modelSaver })` lets tests replace it.
- **POST /api/github/merge** `{ repo, number, head }` passes the same checks as `/api/open` (this
  computer only), needs `github.live` and `github.merge` (`403` otherwise), and is refused in the
  demo (`409`). `github.merge` makes the rest, with `settings.github.mergeMethod` and the
  repositories on the map, and its answer is sent with the status it gives.
- **GET /api/devices** needs the key cookie and a request from this computer (like `/api/open`;
  `403` otherwise). It answers `{ addresses: ['https://<host>/' for each remote.hosts], key,
  knocks: [{ host, login, at, allowed }] }`, the turned-away devices newest first, where `allowed`
  is whether both are on the lists now.
- `GET /api/settings` returns `{ settings, file, roots, nodes: [{ key, title, platform, kind }], platform }`,
  where the last `platform` is the server's `process.platform`. `nodes` holds the snapshot's nodes
  and its `hiddenSessions`, so Settings can name hidden sessions.
- JSON responses use `Content-Type: application/json; charset=utf-8`. Errors are `{ error }` with a
  plain-words message and never include stack traces or file contents.

## Page (`public/`)

- Hash routes: `#/` map (default), `#/list`, `#/activity`, `#/tasks` (only with a mailbox),
  `#/pulls` (shown in the menu only when a session on the map is in a GitHub repository),
  `#/settings`, and `#/settings/<group>` for one group of settings (`basics`, `team`, `models`,
  `sources`, `alerts`, `buttons` or `devices`).
- **Map:** a left-to-right tidy tree of tiles (`W 268 × H 128`, gaps 96 × 22, padding 48) joined by
  rounded orthogonal lines. A line glows while its edge is `active`; three small packets travel down
  (planner/parent → child, teal) or up (child → parent, purple). Pan with drag, zoom with Ctrl+wheel,
  pinch, the `+`/`−`/fit buttons, and the keyboard (`+`, `-`, `0`, arrow keys) when the map has focus.
  The view refits only when the content no longer fits and the person has not moved it. A
  Working/Everyone switch (remembered in `localStorage` as `pleni.mapMode`) hides quiet sessions.
  Dragging a session or relay tile more than 6 px onto another tile (or onto the person) posts
  `/api/placement`; valid bosses light up, Esc or a drop elsewhere cancels, and a short notice offers
  Undo. The drawer's **Reports to** menu does the same from the keyboard, with **Automatic** to undo.
- **Tile:** platform mark (Claude Code, Codex, Grok or Kimi Code), title, rank, model label, status dot and words
  ("Needs you", "Working", "Finished", "Idle", "Done", "Error"), the current activity or last text, and how
  long ago.
- **List:** a table of sessions grouped by project with status filters; it is also the accessible
  alternative to the map.
- **Activity:** the event feed, newest first.
- **Mail:** shown when the mailbox has agent mail (`snapshot.mail`), with the number of new
  messages beside its name. It asks `GET /api/mail` when it shows and again when `snapshot.mail`
  changes. **With you** lists the messages to and from the person; **All mail** lists every
  message. Each shows who wrote to whom, when, and the whole text (line breaks kept). A message to
  the person is **New** while it waits in `new/` and is newer than `readAt`; a message to an agent
  still in `new/` says **Not read yet**. Each message to the person has the command that answers
  it, with a Copy button: `& '<mailbox>\bin\agent-mail.ps1' -Send -From '<name>' -To '<sender>'
  -Text 'your answer'` (`.\bin\agent-mail.ps1` when Pleni does not know the mailbox folder).
  **Mark all as read** posts `you|mailread` with the newest new message's time; the files stay
  where they are. A "Mail for you" notice opens this page, and so does its pop-up.
- **Tasks:** mailbox tasks with state and attention.
- **Pull requests:** one card per GitHub repository (`node.github`) of the sessions on the map, with
  links to its Pull requests, Branches and Checks (Actions) pages on github.com. Under it, each
  branch (the session's `subtitle`), main branches (`main`, `master`, `trunk`, `develop`) first,
  with the main sessions on it; a helper shows only on a branch no main session of its repository
  works on. A branch that is not a main branch and whose name is only letters, digits and
  `. _ / -` links to **Its pull request** (`/pulls?q=is:pr head:<branch>`) and **Open a pull
  request** (`/compare/<branch>?expand=1`). Links open in a new tab with `rel="noopener
  noreferrer"`. A session's Details tab has a GitHub row with the same links. With live GitHub
  status on, the page asks `GET /api/github` when the view shows and then once a minute while it
  stays open and visible; **Look again** asks with `?fresh=1`. A bar says "Live from GitHub, checked
  <time>". Each branch shows its pull request (an open one first, else the newest; none for a main
  branch or one from a fork): `#<number> <title>` linking to it, when it last changed, pills for its
  state, checks, review and merge state, and up to three failing checks. An open one takes the place
  of the branch's two links. Open pull requests on other branches show under **Other open pull
  requests**. An error shows once at the top when every repository has the same one, else on each
  card. When `merge` is true, on this computer, an open pull request that `canMerge` has **Merge**,
  which asks first ("Merge #17 into main with “Squash and merge”? This changes main on GitHub.",
  **Merge now**, **Cancel**) and posts `/api/github/merge` with the commit id the page showed. The
  answer shows in the row, takes the focus, and is read out. One that cannot be merged yet says why.
  Saving Settings drops the last answer, so the view asks again.
- **Drawer:** clicking a tile opens the session's details and live recent events from
  `/api/session`. Esc closes it; focus is trapped while open and returned afterwards. When
  `snapshot.actions.openTerminal` is true and the page itself was opened on this computer
  (`localhost`, `127.0.0.1` or `[::1]`), the Now tab of a Claude Code session, a Codex thread or a
  Codex helper has an **Open in PowerShell** button that posts `/api/open`; a Claude Code helper's
  has **Open its session in PowerShell**, which opens the session it works inside. The answer shows
  in the status line under the tabs; a refusal fades after 20 seconds, so the button does not look
  stuck once its reason has passed. When `snapshot.actions.rollover` is true, on this computer, the
  Now tab of a main Claude Code session or Codex thread has **Roll over…**. It opens a section that
  asks `GET /api/rollover` (again every 5 seconds while open) and shows the four steps: the exact
  ask message with **Ask in PowerShell** and **Copy the message**, closing the old session (`/exit`,
  or `/quit` for Codex), the exact start message with **Start in PowerShell** and **Copy the
  message** (plus `/rename <name>` and its copy button for Codex), and a check. Each button posts
  `/api/rollover`; its answer shows under that step and is read out through the page's live region.
  The check finds the newest other session of the same tool whose title is the name and that
  started later, links to it, and says when the relay now wakes it (its parent is the relay
  tile). It says whether the handoff note is there, and when it was written. A session without a
  usable name shows the reason instead of the steps. When `snapshot.actions.newAgent` is true, on
  this computer, the Now tab of a main Claude Code session or a Codex thread (not a reviewer) has
  **New agent here…**. It opens a section with Tool (Claude Code or Codex, the session's own tool
  first), Name, and **Start in PowerShell**, which posts `/api/new` (Enter in the name box does the
  same). The page checks the name with the server's rule first and marks the box when it is bad.
  For Codex it shows `/rename <name>` with a copy button. The answer shows under the button and is
  read out through the page's live region. A repaint keeps a text box's caret where it was, so
  typing goes on while the panel updates. When `snapshot.actions.teleport` is true, on this
  computer, a main Claude Code session's Now tab has **Bring a cloud session here**, which posts
  `/api/teleport`; its answer shows in the status line under the tabs, like Open in PowerShell.
  Sessions and the relay have a **Tell me if this stops working**
  box that posts `/api/watch`; Settings' own copy of the settings is updated too, so saving Settings
  later keeps it.
- **Settings:** every field in `DEFAULTS`, saved with `POST /api/settings`. Under the Settings
  title, the page says which version runs ("This is Pleni 0.1.0 (commit 0c5808a)."). The form is
  split into seven groups, shown as tabs (`role="tablist"`; arrow keys, Home and End move between
  them): **Basics** (You and the map; What the page shows, with Finished for, Call a turn stuck
  after and Reviewers folded under **More choices**), **Team** (Names and roles, Chain of command,
  Projects, Ranks by model with its words folded), **Models** (Codex models, see below), **Sources** (Where Pleni looks, Mailbox,
  GitHub: Live GitHub status, Merge button, How to merge),
  **Alerts** (Needs you, with `alerts.stoppedMinutes` and the Pop-ups box; Roll over soon, with
  the three `rollSoon` limits), **Buttons** (Open sessions: Open in PowerShell, New agent, Bring a
  cloud session here and Roll over, and a line when the computer does not run Windows) and **Devices** (Open Pleni on another
  device; Other devices, the port, and where the settings file is). **Open Pleni on another
  device**, on this computer, asks `GET /api/devices` when the group opens and every 5 seconds while
  it shows. It shows this computer's address, the address for other devices with **Copy the
  address** (or the three setup steps, `tailscale serve --bg <port>`, open it on the other device,
  Allow, when none is set), the devices turned away lately with **Allow**, and **Copy the key** and
  **Copy a sign-in link** (`https://<host>/?t=<key>`). Allow adds the host and the login to the
  lists and saves when no other change waits to be saved; otherwise it fills them in and asks to
  save. On another device the section only says which address the page is using and to bookmark
  it. `#/settings/<group>` opens a group, and choosing a tab puts its
  group in the address. **Find a setting** shows, from every group, the sections whose group
  name, heading, notes, rows, or a few extra words (`data-find`) have each typed word at the start
  of a word. It marks the matching rows, opens a fold that holds a match, hides the tabs, and says
  how many sections match; Esc clears it. All groups are one form, so Save sends every field.
  Before saving, the page checks the form: whole numbers within the server's limits, full folder
  paths, host names, and Tailscale logins (`name@domain`), at most 20 of each. A bad field gets
  `aria-invalid="true"` and a plain message tied to it with `aria-describedby`, and its tab gets a
  red dot. The message under the form names the groups that hold bad fields. Focus moves to the
  first bad field in the open group, or else the first one, after opening its group and fold.
  Nothing is sent. After a save, the page compares what the server saved with what it sent and
  names any value the server had to change; the port message uses the saved port.
- **Settings → Models:** the **Change models** box is `models.edit`, saved with the other
  settings. Under it, the page asks `GET /api/models` when the group opens (and **Look again**),
  and shows where Codex keeps its settings, then menus for **Sergeants and new threads** (Model,
  with "Codex default"; Effort, with "Codex default"), **Workers** (Model, with "Same as its
  sergeant"; Effort, with "The sergeant chooses"), and a table of **Worker types** (type and file,
  when a sergeant uses it, Model with "Same as other workers", Effort with "The sergeant chooses";
  at phone width each type is a card with its cells named). An effort menu offers the levels its
  model takes, from Codex's list, else every level. A model menu offers `codex.models`; without
  Codex's list it adds **Another model…**, which opens a box for a model name. The menus are off
  unless `edit` and `here` are both true, and a note says why. The section keeps its own copy of
  the values, apart from the other settings, and **Save to Codex** posts only what changed, with
  `tag` (null for "Codex default" and the like). **Add a worker type** (a fold, which stays open
  through a repaint) posts `add` with a name, when a sergeant uses it, and a model. Each answer
  shows next to the buttons and is read out, and the section asks again after it; a line Pleni
  will not change says so under its menu. Enter in the section never saves the whole form, and the
  main Save settings button saves the box but no model line.
- **Version:** the app bar shows the version beside the name (hidden at phone width, like the name;
  its tooltip adds the commit). The page keeps the first `X-Pleni-Version` and `X-Pleni-Build` it
  gets; when a later snapshot answer carries others, Pleni was updated and started again, and a
  notice says "Pleni was updated. It now runs version …. Reload this page to use it."
- **Agent mail:** a tile whose `mail.unread` is above 0, the person's included, gets "N new
  messages" on its bottom edge (and in its label for screen readers). The Now tab of a tile with
  `mail` says what waits for it and since when, and whether the relay wakes it for mail ("Nothing
  wakes it for mail. It sees mail only when it checks." otherwise). The person's tab says how to
  read their mail in PowerShell, in the mailbox's `bin` folder: `.\agent-mail.ps1 -Read -Me
  '<name>'`. A tile with `mail.toYou` also gives that command and the one to answer it:
  `.\agent-mail.ps1 -Send -From '<your name>' -To '<its name>' -Text 'your answer'`. Pleni sends
  no mail. Feed lines read "<sender> sent mail to <receiver>", up when the receiver is above the
  sender on the map, else down; a side that is not on the map shows its mail name. A relay wake
  reads "Relay woke <agent>". Working mode shows the relay while one of its lines is lit.
- **Roll over soon:** a session whose node has `rollSoon` gets a "Roll over soon" badge on the top
  edge of its tile (the reasons are in the tile's label for screen readers), a "Roll over soon" pill
  in its List row, and a line at the top of its side panel's Now tab: "Roll over soon: Memory 87%
  full, squeezed 3 times." Its Details tab shows Memory ("680k of 780k tokens (87% full)", or
  "40k tokens in use" while the size is unknown) and Squeezed ("3 times, last 2 hours ago").
- **Hide from the map:** the Now tab of a Claude Code, Codex, Grok or Kimi Code session or helper
  has **Hide from the map**, which posts `/api/hide`. The side panel closes, since the tile is
  gone, and the notice at the bottom of the page offers Undo, which puts back the role it had.
  Settings' own copy gets the role too. Roll over's Check step offers **Hide the old session** once
  the new one is found. The counts line under the Map and List titles adds "N hidden (Settings,
  Team)".
- **Missing key:** a `401` from the API shows the sign-in box (`#signin`) instead of "Cannot reach
  Pleni", and the page keeps polling. The box is a form with a hidden `username` field ("Pleni") and
  a `current-password` field, so browsers can save the key like a password. Sign in takes the key,
  or a whole pasted address that holds `?t=<key>`, checks that it looks like a key, and opens
  `/?t=<key>`: the server's own redirect sets the cookie and sends the browser back to `/`, so the
  address to bookmark never holds the key. Before it goes, it sets `sessionStorage` `pleni.signin`;
  if the page comes back still locked, the box says the key did not work. The flag is cleared once
  the page is live. The box takes the focus only when nothing else has it.
- **Focus:** keyboard focus is never left under the sticky app bar or the Settings button row: the
  page scrolls the focused control clear of both (WCAG 2.4.11), and `scroll-padding-top` follows
  the app bar's height.
- **Theme:** Plenipo tokens, dark by default, light with `prefers-color-scheme` or the toggle
  (`localStorage` `pleni.theme`). Logos switch between the on-dark and on-light versions.
- **Pop-ups:** off until the person ticks the box in Settings, which is kept in this browser only
  (`localStorage` `pleni.alerts`) and asks the browser for permission. Browsers allow them only on
  a secure page, such as `localhost` or `https`; most phone browsers do not show them from a page.
  When on, each new "Needs you" notice, or one with a newer `at`, becomes a browser notification
  with the notice's text, at most 3 at once and then one "And N more". The first snapshot after the
  page opens only notes what is already there. Clicking one opens the tile, or Tasks. A test button
  sends one.
- Polling: `/api/snapshot` every 2.5 s with `If-None-Match`, paused while the tab is hidden. With
  pop-ups on, a hidden tab still asks every 15 s (browsers may slow that to once a minute).
- Reduced motion: no packets, no dash animation, solid glowing lines instead.
- No inline scripts. Every text value is inserted with `textContent` or escaped.

## Demo (`src/demo.js`)

```js
export function createDemoSource({ now = Date.now })  // -> { poll(): { claude, codex, mailbox }, detail(key, since) }
```

A deterministic, time-driven cast: a person, two projects, a Codex planner with two sub-agents, a
Claude coordinator with three sub-agents (one working, one waiting, one done; the coordinator has a
long session's numbers, so it shows "Roll over soon"), and a small mailbox
with a note for the person, with hand-offs that light up every few seconds. In its agent mail, the
planner (which the relay wakes) and "Sales tax research" write to each other every loop, the
person writes to "Sales tax research", and "Sales tax research" has sent the person ("Ada") a
question that waits. It is used by `node bin/pleni.js --demo`, the screenshots and the
tests, so that no real session data is ever needed to show Pleni. With live GitHub status on, the
demo shows made-up pull requests for its two repositories (`demoGithub(repos, now)`, in the shape
`src/github.js` gives, run through `parsePulls`); merging them is refused. Settings → Models shows
made-up Codex settings (`demoModels()`, in the shape `readCodexModels` gives): sergeants on GPT-6.1 Sol
at high effort, workers on GPT-6 Astra, and two worker types; saving them is refused. Each scripted
letter is kept once, at the last time the loop sent it, so the Mail page shows no copies.
