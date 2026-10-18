# Pleni architecture

Pleni ("Plenipo Browser") is a small local web app. It reads the session files that Claude Code and
Codex already write on your computer, works out who is working on what, and shows it live in your
browser as an organization map with the hand-offs between agents drawn as moving lines.

Version 0.1 only **watches**. It never stops, sends to or changes a session, and it never writes
into Claude Code's, Codex's or a mailbox's folders. The one thing it may start is a window the
person asks for: with **Open in PowerShell** turned on (off by default, Windows only), a button
opens a PowerShell window that runs `claude --resume` or `codex resume` for one Claude Code session
or Codex thread, and the person types there (see `src/open.js` below). Sending work and approving actions come later and will get
their own design.

## Ground rules

- **Zero runtime dependencies.** Node.js 22.12 or newer, ES modules, `node:` built-ins only. No
  build step: the files in `public/` are served as they are.
- **Local by default.** The server binds `127.0.0.1` only. Other devices can reach it only through a
  reverse proxy you configure (for example `tailscale serve`) and only for the host names and
  Tailscale logins you list in settings.
- **Only the person who started it.** Every account on the computer can reach `127.0.0.1`, so the
  API also needs a random key made at each start and printed in Pleni's address (see Server).
- **Read-only.** Pleni reads; it does not write anywhere except its own settings file. It starts no
  program except the opt-in Open in PowerShell window, and only when the person clicks for it.
- **Private by default.** Nothing leaves the computer. No telemetry, no network calls. The page shows
  short snippets of session text only when `content` is `"snippets"` (the default); `"none"` shows
  only tool names and states.
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
src/store.js            owns the sources, polls them, caches the snapshot
src/open.js             Open in PowerShell: a Claude Code session or Codex thread in a new window (opt-in, Windows)
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
  actions: { openTerminal: false },                    // the Open in PowerShell button; true only when set to true
  alerts: { stoppedMinutes: 15 },                      // a watched tile counts as stopped after this long without work
}
// Role = 'superintendent' | 'coordinator' | 'lead' | 'worker' | 'hidden'
```

Exports:

- `configDir(env, platform, home)` and `settingsFile(env, platform, home)`.
- `cleanSettings(raw)` returns a complete, valid settings object: unknown keys dropped, wrong types
  replaced by defaults, strings trimmed and clipped, numbers clamped (`port` 1024–65535,
  `activeMinutes` 1–240, `recentHours` 1–720, `staleMinutes` 5–1440, `stoppedMinutes` 1–1440), arrays
  de-duplicated, node keys validated with `isNodeKey`, roots must be absolute paths or `null`.
  `people[key].watch` is kept only when it is exactly `true`.
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
  startedAt: number | null,
  lastAt: number | null,    // newest timestamp seen in a conversation record
  status: 'working' | 'ready' | 'idle' | 'done' | 'error',
  needs: null | { kind: 'question' | 'plan' | 'blocked' | 'input', text: string | null, at: number },
  activity: { tool: string | null, detail: string | null, at: number } | null,
  lastText: string | null,  // last assistant text, whitespace collapsed, ≤280 chars; null when content = 'none'
  links: Link[],            // hand-offs this session took part in, newest last, max 50
  archived: boolean,
}
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
  (ISO), `sessionId`, `cwd`, `gitBranch`, `entrypoint`, `version`. Metadata records (`custom-title`,
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

## Snapshot (`src/model.js`)

```js
export function buildSnapshot({ now, settings, claude, codex, mailbox, dismissed, actions })  // any source may be null
Snapshot = {
  version: 1, now,
  sources: { claude: SourceInfo, codex: SourceInfo, mailbox: SourceInfo | null },
  nodes: Node[], edges: Edge[], events: Event[], counts: { working, ready, idle, done, error, total },
  attention: [{ id: '<key>|<kind>', key, kind, text, at }],  // at is 0 when unknown
  tasks: MailboxState['tasks'] | null,
  actions: { openTerminal: boolean },  // the page may show Open in PowerShell (setting on, Pleni on Windows)
}
SourceInfo = { enabled, ok, error, count }
Node = {
  key, parent, platform: 'human' | 'group' | 'claude' | 'codex',
  kind: 'person' | 'project' | 'session' | 'agent' | 'reviewer',
  title, subtitle, rank, role, tier: 'senior' | 'junior' | null,
  model, modelLabel, effort, status, startedAt, lastAt, activity, lastText,
  project, entrypoint, hidden, archived,
  watched,  // true for a session or the relay whose people[key].watch is true
}
Edge = { from, to, kind: 'spawn' | 'mailbox' | 'contains', lastDown, lastUp, downLabel, upLabel, active: 'down' | 'up' | 'both' | null }
Event = { at, kind: 'spawn' | 'report' | 'message' | 'mailbox' | 'error', from, to, text }
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
  when it is a file of at most 4 KB; cached) and takes the repository name from its `gitdir:` line. This is the only
  file Pleni reads inside a project folder, and `docs/privacy.md` lists it. Settings
  `projects[name].label` renames, `hidden` hides.
- Listed sessions: active within `recentHours`, not archived, role not `hidden`, reviewers only with
  `showReviewers`. A quiet coordinator or superintendent (a Codex registry role) stays listed while a
  chain rule names it or a listed session hangs under it in the session files; the Codex source keeps
  following registered coordinators however old their files are. Chain rules never move a helper a
  session started itself (`spawned`).
- Edges: `contains` (person → project → session), `spawn` (parent → sub-agent, from links), and
  `mailbox` (planner → coordinator, from mailbox events, when both nodes are listed; the coordinator
  defaults to `relay.coordinatorKey`). `active` is set when `lastDown`/`lastUp` is within
  `PULSE_MS = 120000`.
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
  paused). `note` and `alert` count only within `recentHours`. `stopped` is for a watched tile: a
  session that is not working, not asking and not in error, whose own `lastAt` is at least
  `alerts.stoppedMinutes` old, or a relay whose `state.json` is that old. A tile's `lastAt` also
  counts the work of the tiles below it, so the session's own time is used. Mailbox worker runs
  (`mailbox:` keys) cannot be watched. The snapshot is rebuilt on each poll with the current time,
  so a `stopped` notice appears without any file changing.

## Store (`src/store.js`)

```js
export function createStore({ settings, roots, demo = false, now = Date.now, stateDir = null, platform = process.platform })
// -> { snapshot(): Snapshot, detail(key, since), reload(settings, roots), close(), dismiss(id, at),
//      session(key): { id, cwd, status, entrypoint, kind } | null, demo: boolean }
```

Creates the enabled sources (or the demo source), polls at most every 2 s on demand, caches the
snapshot with its JSON and its ETag, and rebuilds when settings change. `snapshot().actions.openTerminal`
is `settings.actions.openTerminal` and `platform === 'win32'`. `session(key)` gives what the newest
poll knows about a top-level Claude Code session or a Codex thread (`{ id, cwd, status, entrypoint,
kind }`) for Open in PowerShell, and `null` for anything else and in the demo. The ETag is
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

## Server (`src/server.js`)

```js
export function newKey()  // -> 43 random base64url characters (32 bytes)
export function createServer({ store, getSettings, saveSettings, publicDir, version, key, platform, spawnProcess })  // -> http.Server
export function keyFile(settingsPath)  // -> the "key" file next to the settings file
export function readKeyFile(file, { tries, pause, read })  // -> { key } | { missing: true } | { problem: 'damaged' | <error code> }
export function keyFileError(file, problem)  // -> Error with code 'PLENI_KEY_FILE' and a plain message
export function loadOrCreateKey(file, { renew, tries, pause })  // -> { key, saved }; throws keyFileError
export async function start({ port, configFile, demo, open, renewKey })  // -> { server, url, key, keySaved, close }
```

- Bind `127.0.0.1` only.
- **Host gate:** allow `localhost`, `127.0.0.1` and `[::1]` with any port. Any other host is allowed
  only when it is listed in `remote.hosts` and the request's `Tailscale-User-Login` header is listed
  in `remote.tailscaleUsers` (both compared lower-case). Otherwise `403`. This also blocks DNS
  rebinding.
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
  `POST /api/placement`, `POST /api/dismiss`, `POST /api/watch`, `POST /api/open`.
  `HEAD` mirrors `GET`. Other methods get `405`; unknown paths `404`.
- `GET /api/snapshot` sends the JSON and ETag the store made (`snap.json`, `snap.etag`), or makes
  them the same way (`snapshotTag`) for a store that did not.
- **POST /api/settings** requires the key cookie, `X-Pleni: settings`, `Content-Type:
  application/json`, a body of at most 64 KB, and an `Origin` (when present) whose host equals the
  request host. The body is cleaned with `cleanSettings`, saved, and the store reloaded.
- **POST /api/dismiss** `{ id: '<key>|<kind>', at: number | null }` passes the same checks; `kind`
  is one of `needs`, `error`, `question`, `review`, `alert`, `paused`, `halted`, `note`, `stopped`. It hides
  that notice while its `at` is not newer than the given time (a session's `needs` becomes null too),
  and `at: null` brings it back. Dismissals are kept in `dismissed.json` next to the settings (at most
  1000), so every device sees the same; the demo keeps them in memory.
- **POST /api/placement** `{ key, reportsTo: nodeKey | 'you' | null }` passes the same checks and
  saves `people[key].reportsTo` (null removes it). It refuses the person, projects, sessions that
  are not on the map, and a boss below the session itself (a loop), and answers `{ ok: true }`.
- **POST /api/watch** `{ key, watch: boolean }` passes the same checks and saves
  `people[key].watch` (`false` removes it). Only a session on the map or the relay can be watched:
  other keys get `400`, a tile that is not on the map `404`. It answers `{ ok: true }`.
- **POST /api/open** `{ key }` passes the same checks, then refuses (`403`) a request that is not
  from this computer: a host other than the loopback names, or one carrying `Tailscale-User-Login`
  or `X-Forwarded-For` (a proxy such as `tailscale serve` passed it on). `openSession` in
  `src/open.js` makes the rest of the checks and opens the window; it answers `{ ok: true }` or
  `{ error }` with the status it gives. `platform` and `spawnProcess` (a stand-in for
  `child_process.spawn`) let tests run this without opening anything.
- `GET /api/settings` returns `{ settings, file, roots, nodes: [{ key, title, platform, kind }], platform }`,
  where the last `platform` is the server's `process.platform`.
- JSON responses use `Content-Type: application/json; charset=utf-8`. Errors are `{ error }` with a
  plain-words message and never include stack traces or file contents.

## Page (`public/`)

- Hash routes: `#/` map (default), `#/list`, `#/activity`, `#/tasks` (only with a mailbox),
  `#/settings`.
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
- **Tasks:** mailbox tasks with state and attention.
- **Drawer:** clicking a tile opens the session's details and live recent events from
  `/api/session`. Esc closes it; focus is trapped while open and returned afterwards. When
  `snapshot.actions.openTerminal` is true and the page itself was opened on this computer
  (`localhost`, `127.0.0.1` or `[::1]`), the Now tab of a Claude Code session, a Codex thread or a
  Codex helper has an **Open in PowerShell** button that posts `/api/open`; a Claude Code helper's
  has **Open its session in PowerShell**, which opens the session it works inside. The answer shows
  in the status line under the tabs; a refusal fades after 20 seconds, so the button does not look
  stuck once its reason has passed. Sessions and the relay have a **Tell me if this stops working**
  box that posts `/api/watch`; Settings' own copy of the settings is updated too, so saving Settings
  later keeps it.
- **Settings:** every field in `DEFAULTS`, saved with `POST /api/settings`. The Open sessions
  section turns Open in PowerShell on and says when the computer does not run Windows. The Alerts
  section sets `alerts.stoppedMinutes` and holds the Pop-ups box. Before saving, the page
  checks the form: whole numbers within the server's limits, full folder paths, host names, and
  Tailscale logins (`name@domain`), at most 20 of each. A bad field gets `aria-invalid="true"` and
  a plain message tied to it with `aria-describedby`, focus moves to the first one, and nothing is
  sent. After a save, the page compares what the server saved with what it sent and names any
  value the server had to change; the port message uses the saved port.
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
Claude coordinator with three sub-agents (one working, one waiting, one done), and a small mailbox
with a note for the person, with hand-offs that light up every few seconds. It is used by `node bin/pleni.js --demo`, the screenshots and the
tests, so that no real session data is ever needed to show Pleni.
