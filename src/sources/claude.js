// Claude Code source: sessions and sub-agents from the transcripts under <root>/projects.
// It only reads. Known files are tailed a few new bytes at a time; folder listings refresh on
// slower timers, driven by poll() and the injected clock so there is nothing to shut down.
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULTS } from '../config.js';
import { JsonlTail, readJsonFile, scanHead, stripBom } from '../jsonl.js';

const MiB = 1024 * 1024;
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const LIST_EVERY_MS = 15 * 1000;
const DESKTOP_EVERY_MS = 30 * 1000;
const TAIL_BYTES = 4 * MiB;
const CATCH_UP_BYTES = 16 * MiB; // more unread bytes than this: start again near the end
const HEAD_BYTES = 2 * MiB;
const DETAIL_BYTES = 2 * MiB;
const MAX_EVENTS = 200;
const MAX_LINKS = 50;
const MAX_KEPT = 500; // per file: remembered tool calls, results and messages
const NEWLINE = 0x0a;
const CARRIAGE_RETURN = 0x0d;

const SESSION_FILE = /^([0-9a-f-]{8,64})\.jsonl$/;
const AGENT_FILE = /^agent-([0-9a-z_-]{1,64})\.jsonl$/;
const SESSION_ID = /^[0-9a-f-]{8,64}$/;
const AGENT_ID = /^[0-9a-z_-]{1,64}$/;
const DESKTOP_FILE = /^local_[\w-]+\.json$/;
const CONVERSATION = new Set(['user', 'assistant', 'attachment', 'system']);
const TITLE_TYPES = new Set(['custom-title', 'agent-name', 'ai-title']);
const TURN_ENDS = new Set(['end_turn', 'stop_sequence']);
const AGENT_TOOLS = new Set(['Agent', 'Task']);
// Tools a sub-agent calls last to hand its answer back; a good result for one ends the turn.
const HANDBACK_TOOLS = new Set(['SubagentHandback', 'StructuredOutput']);
// Echoes of local slash commands such as /model, and of `!` shell commands; they do not start a turn.
const COMMAND_ECHO = /^\s*<(command-(name|message|args)|local-command-[a-z-]+|bash-(input|stdout|stderr))>/;
const INTERRUPTED = /^\s*\[Request interrupted by user/;
const SYNTHETIC = '<synthetic>';

export function createClaudeSource({ root, desktopRoot = null, settings = DEFAULTS, now = Date.now } = {}) {
  const files = new Map();        // transcript path -> FileState
  const journals = new Map();     // workflow journal path -> JournalState
  const desktopFiles = new Map(); // desktop metadata path -> { mtimeMs, info }
  let desktop = new Map();        // session id -> desktop info
  let listedAt = null;
  let desktopAt = null;
  let found = true;
  let sessions = [];

  const reply = (ok, error, list) => ({ ok, error, root: isText(root) ? root : null, sessions: list });

  function poll() {
    try {
      if (!isText(root)) return reply(false, 'No Claude Code folder is set.', []);
      const t = now();
      if (isDue(listedAt, t, LIST_EVERY_MS)) {
        found = discover(t);
        listedAt = t;
      }
      if (isDue(desktopAt, t, DESKTOP_EVERY_MS)) {
        refreshDesktop();
        desktopAt = t;
      }
      if (!found) return reply(false, 'Pleni could not find the Claude Code projects folder.', []);
      for (const state of files.values()) readTranscript(state);
      for (const journal of journals.values()) readJournal(journal);
      sessions = buildSessions(t);
      return reply(true, null, sessions);
    } catch {
      return reply(false, 'Pleni could not read the Claude Code sessions.', sessions);
    }
  }

  function detail(key, since) {
    try {
      let state = null;
      for (const s of files.values()) if (s.key === key) state = state ?? s;
      if (!state) return { events: [], next: null };
      return readEvents(state.file, toOffset(since), settings?.content !== 'none');
    } catch {
      return { events: [], next: null };
    }
  }

  // ---- discovery ----

  function discover(t) {
    const projects = path.join(root, 'projects');
    if (!isDirectory(projects)) {
      files.clear();
      journals.clear();
      return false;
    }
    const cutoff = t - windowOf(settings).recentMs;
    const seen = new Set();
    for (const dir of readDir(projects)) {
      if (!dir.isDirectory()) continue;
      const projectDir = path.join(projects, dir.name);
      for (const entry of readDir(projectDir)) {
        const m = entry.isFile() && SESSION_FILE.exec(entry.name);
        if (!m) continue;
        const file = path.join(projectDir, entry.name);
        if (!isRecent(file, cutoff)) continue;
        track(file, { sessionId: m[1], agentId: null, runId: null, metaFile: null }, seen);
        listAgents(path.join(projectDir, m[1], 'subagents'), m[1], null, cutoff, seen);
      }
    }
    for (const file of files.keys()) if (!seen.has(file)) files.delete(file);
    for (const file of journals.keys()) if (!seen.has(file)) journals.delete(file);
    return true;
  }

  function listAgents(dir, sessionId, runId, cutoff, seen) {
    for (const entry of readDir(dir)) {
      if (entry.isDirectory()) {
        if (runId === null && entry.name === 'workflows') listWorkflows(path.join(dir, entry.name), sessionId, cutoff, seen);
        continue;
      }
      if (!entry.isFile()) continue;
      const file = path.join(dir, entry.name);
      if (runId !== null && entry.name === 'journal.jsonl') {
        if (!journals.has(file)) journals.set(file, newJournal(sessionId, runId, file));
        seen.add(file);
        continue;
      }
      const m = AGENT_FILE.exec(entry.name);
      if (!m || !isRecent(file, cutoff)) continue;
      const metaFile = path.join(dir, `agent-${m[1]}.meta.json`);
      refreshMeta(track(file, { sessionId, agentId: m[1], runId, metaFile }, seen));
    }
  }

  function listWorkflows(dir, sessionId, cutoff, seen) {
    for (const run of readDir(dir)) {
      if (run.isDirectory()) listAgents(path.join(dir, run.name), sessionId, run.name, cutoff, seen);
    }
  }

  function track(file, info, seen) {
    seen.add(file);
    let state = files.get(file);
    if (!state) {
      state = newFileState(file, info);
      files.set(file, state);
    }
    return state;
  }

  // ---- reading ----

  function readTranscript(s) {
    let res;
    try {
      if (s.started && fs.statSync(s.file).size - s.tail.offset > CATCH_UP_BYTES) restart(s);
      res = s.tail.read();
    } catch {
      return; // locked or busy for a moment: try again on the next poll
    }
    s.started = true;
    if (res.reset) Object.assign(s, freshParse());
    for (const record of res.records) applyRecord(s, record);
    if (!s.headDone && res.size > 0) {
      s.headDone = true;
      if (res.size > TAIL_BYTES) scanHeadOnce(s);
    }
  }

  function readJournal(j) {
    let res;
    try {
      res = j.tail.read();
    } catch {
      return;
    }
    if (res.reset) {
      j.labels.clear();
      j.results.clear();
    }
    for (const r of res.records) {
      if (!isText(r.agentId)) continue;
      if (r.type === 'started' && isText(r.label)) j.labels.set(r.agentId, r.label);
      else if (r.type === 'result') j.results.add(r.agentId);
    }
  }

  // ---- desktop app metadata ----

  function refreshDesktop() {
    try {
      const seen = new Set();
      for (const base of desktopBases(desktopRoot)) {
        for (const a of readDir(base)) {
          if (!a.isDirectory()) continue;
          for (const b of readDir(path.join(base, a.name))) {
            if (!b.isDirectory()) continue;
            const dir = path.join(base, a.name, b.name);
            for (const f of readDir(dir)) {
              if (!f.isFile() || !DESKTOP_FILE.test(f.name)) continue;
              const file = path.join(dir, f.name);
              seen.add(file);
              loadDesktopFile(file);
            }
          }
        }
      }
      for (const file of desktopFiles.keys()) if (!seen.has(file)) desktopFiles.delete(file);
      const next = new Map();
      for (const { info } of desktopFiles.values()) {
        if (!info) continue;
        const prev = next.get(info.cliSessionId);
        if (!prev || (info.lastActivityAt ?? 0) >= (prev.lastActivityAt ?? 0)) next.set(info.cliSessionId, info);
      }
      desktop = next;
    } catch {
      // The desktop app's files are a bonus; never let them break the source.
    }
  }

  function loadDesktopFile(file) {
    let mtimeMs;
    try {
      mtimeMs = fs.statSync(file).mtimeMs;
    } catch {
      return;
    }
    const cached = desktopFiles.get(file);
    if (cached && cached.mtimeMs === mtimeMs) return;
    desktopFiles.set(file, { mtimeMs, info: pickDesktop(readJsonFile(file)) });
  }

  // ---- building sessions ----

  function buildSessions(t) {
    const snippets = settings?.content !== 'none';
    const win = windowOf(settings);
    const journalIndex = new Map();
    for (const j of journals.values()) journalIndex.set(`${j.sessionId}/${j.runId}`, j);
    const groups = new Map();
    for (const s of files.values()) {
      let g = groups.get(s.sessionId);
      if (!g) groups.set(s.sessionId, (g = { main: null, agents: new Map() }));
      if (s.agentId === null) g.main = s;
      else if (!g.agents.has(s.agentId)) g.agents.set(s.agentId, s);
    }
    const out = [];
    for (const [sessionId, g] of groups) {
      const ctx = { sessionId, g, desk: desktop.get(sessionId) ?? null, journalIndex, snippets };
      const group = [];
      for (const view of linkGroup(ctx)) {
        if (view.s.lastAt !== null) group.push(toSession(view, ctx.desk, t, win, snippets));
      }
      out.push(...rollUpWorking(group));
    }
    return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }

  return { poll, detail };
}

// ---- per-file state ----

function newFileState(file, { sessionId, agentId, runId, metaFile }) {
  return {
    file,
    sessionId,
    agentId,
    runId,
    metaFile,
    key: agentId === null ? `claude:${sessionId}` : `claude:${sessionId}/${agentId}`,
    tail: new JsonlTail(file, { maxInitialBytes: TAIL_BYTES }),
    started: false, // the tail has been read at least once
    meta: null,
    metaMtime: null,
    ...freshParse(),
  };
}

function freshParse() {
  return {
    headDone: false,
    cwd: null,
    branch: null,
    entrypoint: null,
    model: null,
    effort: null,
    startedAt: null,
    lastAt: null,
    customTitle: null,
    customSource: null,
    aiTitle: null,
    lastKind: null,      // 'user' | 'assistant' | 'interrupted' | 'handback': the last record that moved a turn
    msgId: null,         // the API message the last assistant line belongs to
    msgText: [],
    stop: null,
    synthError: false,
    assistantAt: null,
    assistantUuid: null,
    text: null,
    textAt: null,
    open: new Map(),     // tool_use id -> { name, detail, at }, still waiting for its result
    calls: new Map(),    // Agent/Task tool_use id -> { at, description, background }
    results: new Map(),  // Agent/Task tool_use id -> { at, agentId, async, text }
    sends: [],           // SendMessage uses: { at, to, label }
  };
}

function newJournal(sessionId, runId, file) {
  return { sessionId, runId, tail: new JsonlTail(file), labels: new Map(), results: new Set() };
}

function refreshMeta(s) {
  let mtimeMs = null;
  try {
    mtimeMs = fs.statSync(s.metaFile).mtimeMs;
  } catch {
    // No meta file (yet).
  }
  if (mtimeMs === s.metaMtime) return;
  s.metaMtime = mtimeMs;
  const raw = mtimeMs === null ? null : readJsonFile(s.metaFile);
  s.meta = raw && {
    agentType: textOrNull(raw.agentType),
    description: textOrNull(raw.description),
    toolUseId: textOrNull(raw.toolUseId),
    spawnDepth: Number.isFinite(raw.spawnDepth) ? raw.spawnDepth : null,
    parentAgentId: isText(raw.parentAgentId) && AGENT_ID.test(raw.parentAgentId) ? raw.parentAgentId : null,
    model: textOrNull(raw.model),
  };
}

// Polls stop while nobody has the page open, and a busy transcript can grow by hundreds of
// megabytes meanwhile. Rather than parse all of that in one go, start again near the end, as on
// the first read, keeping the facts that stay true: titles, place, model, start time, and the
// sub-agent calls and results that make the links. The head was already scanned, so it is not
// scanned again.
function restart(s) {
  const keep = {
    headDone: s.headDone,
    cwd: s.cwd,
    branch: s.branch,
    entrypoint: s.entrypoint,
    model: s.model,
    effort: s.effort,
    startedAt: s.startedAt,
    lastAt: s.lastAt,
    customTitle: s.customTitle,
    customSource: s.customSource,
    aiTitle: s.aiTitle,
    calls: s.calls,
    results: s.results,
    sends: s.sends,
  };
  Object.assign(s, freshParse(), keep);
  s.tail = new JsonlTail(s.file, { maxInitialBytes: TAIL_BYTES });
  s.started = false;
}

// A long file is read from its end, so its title and start time may only be near the head.
function scanHeadOnce(s) {
  let first = null;
  const titles = scanHead(s.file, HEAD_BYTES, (r) => {
    if (TITLE_TYPES.has(r.type)) return true;
    if (first === null && CONVERSATION.has(r.type) && parseTime(r.timestamp) !== null) first = r;
    return false;
  });
  if (first) s.startedAt = minTime(s.startedAt, parseTime(first.timestamp));
  if (s.customTitle || s.aiTitle) return;
  for (const r of titles) applyTitle(s, r);
}

function applyRecord(s, r) {
  if (TITLE_TYPES.has(r.type)) {
    applyTitle(s, r);
    return;
  }
  if (!CONVERSATION.has(r.type)) return;
  const at = parseTime(r.timestamp);
  if (at !== null) {
    s.lastAt = s.lastAt === null ? at : Math.max(s.lastAt, at);
    s.startedAt = minTime(s.startedAt, at);
  }
  if (isText(r.cwd)) s.cwd = cleanPath(r.cwd);
  if (isText(r.gitBranch)) s.branch = r.gitBranch;
  if (isText(r.entrypoint)) s.entrypoint = r.entrypoint;
  if (isText(r.effort)) s.effort = r.effort;
  if (r.type === 'assistant') applyAssistant(s, r, at);
  else if (r.type === 'user') applyUser(s, r, at);
}

function applyTitle(s, r) {
  if (r.type === 'custom-title' && isText(r.customTitle)) setCustom(s, r.customTitle, r.type);
  else if (r.type === 'agent-name' && isText(r.agentName)) setCustom(s, r.agentName, r.type);
  else if (r.type === 'ai-title' && isText(r.aiTitle)) s.aiTitle = r.aiTitle;
}

function setCustom(s, title, source) {
  s.customTitle = title;
  s.customSource = source;
}

// One API message can arrive as several lines with the same message.id; they are one message.
function applyAssistant(s, r, at) {
  const msg = isObject(r.message) ? r.message : {};
  const id = isText(msg.id) ? msg.id : null;
  if (id === null || id !== s.msgId) {
    s.msgId = id;
    s.msgText = [];
    s.stop = null;
  }
  if (isText(msg.stop_reason)) s.stop = msg.stop_reason;
  s.lastKind = 'assistant';
  if (at !== null) s.assistantAt = at;
  if (isText(r.uuid)) s.assistantUuid = r.uuid;
  s.synthError = msg.model === SYNTHETIC && r.isApiErrorMessage === true;
  if (isText(msg.model) && msg.model !== SYNTHETIC) s.model = msg.model;
  for (const block of blocks(msg.content)) {
    if (block.type === 'text' && isText(block.text)) {
      s.msgText.push(clip(collapse(block.text), 280));
      s.text = clip(s.msgText.join(' '), 280);
      s.textAt = at;
    } else if (block.type === 'tool_use' && isText(block.id)) {
      addToolUse(s, block, at);
    }
  }
  if (s.synthError || TURN_ENDS.has(s.stop)) s.open.clear();
}

function addToolUse(s, block, at) {
  const name = textOrNull(block.name);
  const input = isObject(block.input) ? block.input : {};
  remember(s.open, block.id, { name, detail: toolDetail(input), at });
  if (AGENT_TOOLS.has(name)) {
    remember(s.calls, block.id, { at, description: textOrNull(input.description), background: input.run_in_background === true });
  } else if (name === 'SendMessage') {
    const to = textOrNull(input.to) ?? textOrNull(input.recipient);
    const label = textOrNull(input.summary) ?? firstLine(input.message) ?? firstLine(input.content);
    if (to) s.sends.push({ at, to, label: label && clip(collapse(label), 140) });
    if (s.sends.length > MAX_KEPT) s.sends.shift();
  }
}

function applyUser(s, r, at) {
  if (r.isMeta === true) return; // added by the app, not typed or returned by a tool
  const content = isObject(r.message) ? r.message.content : null;
  const texts = typeof content === 'string' ? [content] : [];
  let prompt = false;
  let result = false;
  let handback = false;
  for (const block of blocks(content)) {
    if (block.type === 'tool_result') {
      result = true;
      if (HANDBACK_TOOLS.has(closeToolUse(s, block, r, at)) && block.is_error !== true) handback = true;
    } else if (block.type === 'text') {
      texts.push(block.text);
    } else {
      prompt = true; // images and other input
    }
  }
  let interrupted = false;
  for (const text of texts) {
    if (typeof text !== 'string' || COMMAND_ECHO.test(text)) continue;
    if (INTERRUPTED.test(text)) interrupted = true;
    else prompt = true;
  }
  if (interrupted) {
    s.lastKind = 'interrupted';
    s.open.clear();
  } else if (handback && !prompt) {
    s.lastKind = 'handback';
    s.open.clear();
  } else if (prompt || result) {
    s.lastKind = 'user';
  }
}

// Returns the name of the tool whose call this result answers, when that call was seen.
function closeToolUse(s, block, r, at) {
  const id = block.tool_use_id;
  if (!isText(id)) return null;
  const name = s.open.get(id)?.name ?? null;
  s.open.delete(id);
  const res = isObject(r.toolUseResult) ? r.toolUseResult : null;
  const agentId = res && isText(res.agentId) && AGENT_ID.test(res.agentId) ? res.agentId : null;
  if (!s.calls.has(id) && !(agentId && isText(res.status))) return name;
  remember(s.results, id, {
    at,
    agentId,
    async: res?.status === 'async_launched' || res?.isAsync === true,
    text: clip(collapse(resultText(block.content)), 280),
  });
  return name;
}

// ---- links, titles, status ----

function linkGroup({ sessionId, g, desk, journalIndex, snippets }) {
  const views = new Map();
  const nodes = g.main ? [g.main, ...g.agents.values()] : [...g.agents.values()];
  for (const s of nodes) {
    const journal = s.runId === null ? null : journalIndex.get(`${sessionId}/${s.runId}`) ?? null;
    const workflowLabel = journal?.labels.get(s.agentId) ?? null;
    const [title, titleSource] = titleOf(s, s.agentId === null ? desk : null, workflowLabel);
    views.set(s.key, { s, journal, title, titleSource, parentKey: parentKeyOf(s), links: [], finishedAt: null, done: false });
  }
  const byToolUse = new Map();
  for (const [agentId, a] of g.agents) if (a.meta?.toolUseId) byToolUse.set(a.meta.toolUseId, agentId);
  const agentView = (agentId) => (agentId && g.agents.has(agentId) ? views.get(g.agents.get(agentId).key) : null);
  const byName = (name) => {
    const lower = name.toLowerCase();
    for (const v of views.values()) if (v.s.agentId !== null && v.title?.toLowerCase() === lower) return v;
    return null;
  };
  const label = (text) => (snippets && isText(text) ? clip(collapse(text), 140) : null);
  const called = new Set();
  const background = new Set();

  for (const v of views.values()) {
    const s = v.s;
    for (const [id, call] of s.calls) {
      const child = agentView(byToolUse.get(id) ?? s.results.get(id)?.agentId);
      if (!child) continue;
      called.add(child);
      if (call.background) background.add(child);
      addLink(v, call.at, 'down', child, label(call.description ?? child.s.meta?.description));
    }
    for (const [id, res] of s.results) {
      const child = agentView(byToolUse.get(id) ?? res.agentId);
      if (!child) continue;
      if (res.async) {
        background.add(child);
        continue;
      }
      if (res.at !== null) child.finishedAt = Math.max(child.finishedAt ?? res.at, res.at);
      addLink(v, res.at, 'up', child, label(res.text));
    }
    for (const send of s.sends) {
      const child = agentView(send.to) ?? byName(send.to);
      if (child && child !== v) addLink(v, send.at, 'down', child, label(send.label));
    }
  }

  // Sub-agents whose start was not seen (workflow agents, or a call older than the tail),
  // and background or workflow agents that finished: their final text is the report back.
  for (const child of views.values()) {
    const a = child.s;
    if (a.agentId === null) continue;
    const owner = views.get(child.parentKey) ?? (g.main ? views.get(g.main.key) : null);
    if (!called.has(child) && owner) addLink(owner, a.startedAt, 'down', child, label(child.title));
    if (child.finishedAt !== null) {
      // Records after the parent got its result mean it was asked again (for example by SendMessage).
      child.done = !(a.lastAt > child.finishedAt) || endedTurn(a);
      continue;
    }
    // A hand-back is itself the report, even when the parent's call is older than the tail.
    const reported = child.journal?.results.has(a.agentId) === true || a.lastKind === 'handback';
    const detached = background.has(child) || a.runId !== null;
    if (reported || (detached && endedTurn(a))) {
      child.finishedAt = a.assistantAt ?? a.lastAt;
      child.done = true;
      if (owner) addLink(owner, child.finishedAt, 'up', child, label(a.text));
    }
  }
  return views.values();
}

function addLink(view, at, dir, child, label) {
  if (!Number.isFinite(at)) return;
  view.links.push({ at, dir, other: child.s.key, label });
}

function toSession(view, desk, t, win, snippets) {
  const s = view.s;
  const agent = s.agentId !== null;
  return {
    platform: 'claude',
    key: s.key,
    id: agent ? s.agentId : s.sessionId,
    parentKey: view.parentKey,
    kind: agent ? 'agent' : 'session',
    title: view.title,
    titleSource: view.titleSource,
    cwd: s.cwd ?? desk?.cwd ?? null,
    branch: s.branch,
    entrypoint: s.entrypoint,
    model: s.model ?? (agent ? s.meta?.model : desk?.model) ?? null,
    effort: s.effort ?? (agent ? null : desk?.effort) ?? null,
    startedAt: s.startedAt,
    lastAt: s.lastAt,
    status: statusOf(s, t, win, view.done),
    activity: activityOf(s, snippets),
    lastText: snippets ? s.text : null,
    needs: agent ? null : needsOf(s, desk, snippets),
    links: view.links.sort((a, b) => a.at - b.at).slice(-MAX_LINKS),
    archived: desk?.isArchived === true,
  };
}

function titleOf(s, desk, workflowLabel) {
  const choices = [
    [s.customTitle, s.customSource],
    [s.aiTitle, 'ai-title'],
    [desk?.title, 'desktop'],
    [workflowLabel, 'workflow'],
    [s.meta?.description, 'description'],
  ];
  for (const [text, source] of choices) {
    const title = isText(text) ? clip(collapse(text), 120) : '';
    if (title) return [title, source];
  }
  return [null, null];
}

function parentKeyOf(s) {
  if (s.agentId === null) return null;
  const parent = s.meta?.parentAgentId;
  return parent && parent !== s.agentId ? `claude:${s.sessionId}/${parent}` : `claude:${s.sessionId}`;
}

function statusOf(s, t, win, done) {
  const fresh = s.lastAt !== null && t - s.lastAt <= win.staleMs;
  // A null stop_reason is a message still being written (older files split it across lines).
  const asking = s.lastKind === 'assistant' && (s.stop === 'tool_use' || s.stop === null);
  const turnOpen = s.lastKind === 'user' || asking || s.open.size > 0;
  // Checked first: a sub-agent that was stopped mid-tool can still look open in its own file.
  if (done && !s.synthError) return 'done';
  if (turnOpen && fresh) return 'working';
  if (s.synthError) return 'error';
  if (endedTurn(s) && s.assistantAt !== null && t - s.assistantAt <= win.activeMs) return 'ready';
  return 'idle';
}

// What the person must do before this session can go on, or null. A headless session (started by
// a script or relay, not a person) is never waiting for the person. A question or a plan waits
// until it is answered, however long that takes.
const ASK_TOOLS = { AskUserQuestion: 'question', ExitPlanMode: 'plan' };
function needsOf(s, desk, snippets) {
  if (s.entrypoint === 'sdk-cli' || desk?.isArchived === true) return null;
  let asking = null;
  for (const value of s.open.values()) if (ASK_TOOLS[value.name]) asking = value;
  if (asking) return { kind: ASK_TOOLS[asking.name], text: null, at: asking.at ?? s.lastAt };
  const blocked = desk?.needs;
  if (blocked && endedTurn(s) && blocked.uuid === s.assistantUuid) {
    return { kind: 'blocked', text: snippets && blocked.text ? clip(collapse(blocked.text), 280) : null, at: s.assistantAt ?? s.lastAt };
  }
  return null;
}

function endedTurn(s) {
  return s.lastKind === 'handback' || (s.lastKind === 'assistant' && TURN_ENDS.has(s.stop));
}

// A session (or helper) whose helpers are still working is working too, even when its own turn
// ended or went quiet: it writes nothing to its own file while a long Agent or Workflow call runs,
// or while background helpers it launched do the work. Only "ready" and "idle" are lifted, so an
// error or a finished helper still shows as it is. Each working helper lifts every parent above it.
function rollUpWorking(sessions) {
  const byKey = new Map(sessions.map((x) => [x.key, x]));
  for (const x of sessions) {
    if (x.status !== 'working') continue;
    const seen = new Set([x.key]);
    let parent = x.parentKey ? byKey.get(x.parentKey) : null;
    while (parent && !seen.has(parent.key) && (parent.status === 'ready' || parent.status === 'idle')) {
      seen.add(parent.key);
      parent.status = 'working';
      parent = parent.parentKey ? byKey.get(parent.parentKey) : null;
    }
  }
  return sessions;
}

function activityOf(s, snippets) {
  let tool = null;
  for (const value of s.open.values()) tool = value; // insertion order: the newest is last
  if (tool) return { tool: tool.name, detail: snippets ? tool.detail : null, at: tool.at ?? s.lastAt };
  if (snippets && s.text) return { tool: null, detail: clip(s.text, 140), at: s.textAt ?? s.lastAt };
  return null;
}

// Short words about what a tool is doing, from its input. Only shown with content = 'snippets'.
function toolDetail(input) {
  if (!isObject(input)) return null;
  let text = null;
  if (isText(input.command)) text = clip(collapse(textOrNull(input.description) ?? firstLine(input.command) ?? ''), 80);
  else if (isText(input.file_path)) text = baseName(input.file_path);
  else if (isText(input.pattern)) text = input.pattern;
  else if (isText(input.description)) text = input.description;
  else if (isText(input.url)) text = hostName(input.url);
  return isText(text) ? clip(collapse(text), 140) || null : null;
}

// ---- side drawer events ----

function readEvents(file, since, snippets) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    let start = since !== null && since <= size ? since : Math.max(0, size - DETAIL_BYTES);
    if (size - start > DETAIL_BYTES) start = size - DETAIL_BYTES;
    const data = readBytes(fd, start, size - start);
    let pos = 0;
    if (start > 0 && start !== since && readBytes(fd, start - 1, 1)[0] !== NEWLINE) {
      const nl = data.indexOf(NEWLINE);
      pos = nl === -1 ? data.length : nl + 1; // we landed inside a line: drop that part
    }
    const names = new Map();
    let events = [];
    let nl;
    while ((nl = data.indexOf(NEWLINE, pos)) !== -1) {
      const record = parseLine(data.subarray(pos, nl));
      pos = nl + 1;
      if (record) addEvents(record, names, snippets, events);
      if (events.length > MAX_EVENTS * 4) events = events.slice(-MAX_EVENTS);
    }
    return { events: events.slice(-MAX_EVENTS), next: start + pos };
  } finally {
    fs.closeSync(fd);
  }
}

function addEvents(r, names, snippets, out) {
  const at = parseTime(r.timestamp);
  if (at === null) return;
  const push = (kind, tool, text) => out.push({ at, kind, tool: tool ?? null, text: snippets ? clipBlock(text, 2000) : null });
  if (r.type === 'assistant') {
    const msg = isObject(r.message) ? r.message : {};
    if (msg.model === SYNTHETIC && r.isApiErrorMessage === true) {
      push('error', null, blocks(msg.content).map((b) => (b.type === 'text' ? b.text : '')).join('\n'));
      return;
    }
    for (const block of blocks(msg.content)) {
      if (block.type === 'text') push('assistant', null, block.text);
      else if (block.type === 'thinking' || block.type === 'redacted_thinking') out.push({ at, kind: 'thinking', tool: null, text: null });
      else if (block.type === 'tool_use') {
        const name = textOrNull(block.name);
        if (isText(block.id)) names.set(block.id, name);
        push('tool', name, toolDetail(block.input));
      }
    }
  } else if (r.type === 'user' && r.isMeta !== true) {
    const content = isObject(r.message) ? r.message.content : null;
    if (typeof content === 'string') {
      if (!COMMAND_ECHO.test(content)) push('user', null, content);
      return;
    }
    for (const block of blocks(content)) {
      if (block.type === 'text' && typeof block.text === 'string' && !COMMAND_ECHO.test(block.text)) push('user', null, block.text);
      else if (block.type === 'tool_result') push(block.is_error === true ? 'error' : 'result', names.get(block.tool_use_id), resultText(block.content));
    }
  }
}

// ---- small helpers ----

// The Claude desktop app from the Microsoft Store keeps its files in its package folder, which only
// the app itself sees as %APPDATA%\Claude. Other programs, Pleni included, must look there directly.
function desktopBases(desktopRoot) {
  if (!isText(desktopRoot)) return [];
  const base = path.join(desktopRoot, 'claude-code-sessions');
  if (process.platform !== 'win32' || isDir(base)) return [base];
  const local = process.env.LOCALAPPDATA;
  if (!isText(local)) return [base];
  const packages = path.join(local, 'Packages');
  const found = readDir(packages)
    .filter((d) => d.isDirectory() && /^Claude_[a-z0-9]+$/i.test(d.name))
    .map((d) => path.join(packages, d.name, 'LocalCache', 'Roaming', 'Claude', 'claude-code-sessions'))
    .filter(isDir);
  return found.length ? found : [base];
}

function isDir(dir) {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

// Claude's own end-of-turn summary says "blocked" when the session needs the person. It counts only
// while it still describes the newest reply.
function desktopNeeds(raw) {
  const sum = isObject(raw.postTurnSummary) ? raw.postTurnSummary : null;
  if (!sum || sum.status_category !== 'blocked' || !isText(sum.summarizes_uuid)) return null;
  return { uuid: sum.summarizes_uuid, text: textOrNull(sum.needs_action) };
}

function pickDesktop(raw) {
  if (!raw || !isText(raw.cliSessionId) || !SESSION_ID.test(raw.cliSessionId)) return null;
  return {
    needs: desktopNeeds(raw),
    cliSessionId: raw.cliSessionId,
    title: textOrNull(raw.title),
    titleSource: textOrNull(raw.titleSource),
    model: textOrNull(raw.model),
    effort: textOrNull(raw.effort),
    cwd: isText(raw.cwd) ? cleanPath(raw.cwd) : null,
    isArchived: raw.isArchived === true,
    lastActivityAt: Number.isFinite(raw.lastActivityAt) ? raw.lastActivityAt : null,
  };
}

function windowOf(settings) {
  const w = isObject(settings?.window) ? settings.window : {};
  const d = DEFAULTS.window;
  const pick = (value, fallback) => (Number.isFinite(value) && value > 0 ? value : fallback);
  return {
    activeMs: pick(w.activeMinutes, d.activeMinutes) * MINUTE,
    staleMs: pick(w.staleMinutes, d.staleMinutes) * MINUTE,
    recentMs: pick(w.recentHours, d.recentHours) * HOUR,
  };
}

function isDue(last, t, every) {
  return last === null || t < last || t - last >= every;
}

function remember(map, key, value) {
  map.delete(key);
  map.set(key, value);
  if (map.size > MAX_KEPT) map.delete(map.keys().next().value);
}

function readDir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function isDirectory(dir) {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function isRecent(file, cutoff) {
  try {
    return fs.statSync(file).mtimeMs >= cutoff;
  } catch {
    return false;
  }
}

function readBytes(fd, position, length) {
  const buf = Buffer.allocUnsafe(length);
  let got = 0;
  while (got < length) {
    const n = fs.readSync(fd, buf, got, length - got, position + got);
    if (n <= 0) break;
    got += n;
  }
  return got === length ? buf : buf.subarray(0, got);
}

function parseLine(buf) {
  let end = buf.length;
  if (end > 0 && buf[end - 1] === CARRIAGE_RETURN) end--;
  try {
    const value = JSON.parse(stripBom(buf.toString('utf8', 0, end)));
    return isObject(value) ? value : null;
  } catch {
    return null;
  }
}

function toOffset(since) {
  if (Number.isSafeInteger(since) && since >= 0) return since;
  if (typeof since === 'string' && /^\d{1,15}$/.test(since)) return Number(since);
  return null;
}

function blocks(content) {
  return Array.isArray(content) ? content.filter(isObject) : [];
}

function resultText(content) {
  if (typeof content === 'string') return content;
  return blocks(content).filter((b) => b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n');
}

function parseTime(value) {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function minTime(a, b) {
  if (b === null) return a;
  return a === null ? b : Math.min(a, b);
}

// Windows long-path prefixes (\\?\C:\... and \\?\UNC\server\share) are dropped.
function cleanPath(p) {
  if (p.startsWith('\\\\?\\UNC\\')) return `\\\\${p.slice(8)}`;
  if (p.startsWith('\\\\?\\')) return p.slice(4);
  return p;
}

function baseName(p) {
  const parts = p.split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : null;
}

function hostName(url) {
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}

function firstLine(text) {
  if (typeof text !== 'string') return null;
  const line = text.split('\n').map((l) => l.trim()).find(Boolean);
  return line || null;
}

function collapse(text) {
  return typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : '';
}

// Clips to `max` characters (not UTF-16 units), ending with an ellipsis when cut.
function clip(text, max) {
  if (typeof text !== 'string') return null;
  if (text.length <= max) return text;
  // A character is at most two UTF-16 units, so this slice still holds more than `max` of them,
  // and a huge text is never split into one array item per character.
  const chars = Array.from(text.slice(0, max * 2 + 2));
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('').trimEnd()}…`;
}

// Like clip, but keeps line breaks for the drawer; empty text becomes null.
function clipBlock(text, max) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  return trimmed ? clip(trimmed, max) : null;
}

function textOrNull(value) {
  return isText(value) ? value : null;
}

function isText(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
