// Grok sessions and sub-agents, read from the session folders Grok keeps in its home folder:
// <root>/sessions/<URL-encoded working folder>/<session id>/. Read-only: files are tailed
// incrementally and nothing is ever written.
import fs from 'node:fs';
import path from 'node:path';
import { JsonlTail, readJsonFile } from '../jsonl.js';

const MiB = 1024 * 1024;
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const SCAN_MS = 30 * 1000;
const MAX_FILES = 300;
const MAX_LINKS = 50;
const MAX_EVENTS = 200;
const MAX_OPEN = 100; // open tool calls and permission requests remembered per session
const MAX_RUN = 8000; // characters kept while the chunks of one message are joined
const TAIL_BYTES = 4 * MiB;
const CATCH_UP_BYTES = 16 * MiB; // more unread bytes than this: start again near the end
const DETAIL_BYTES = 2 * MiB;
const JSON_BYTES = MiB; // summary.json and a sub-agent's meta.json are a few kilobytes
// Grok asks for permission before every tool call, and its rules answer nearly all of them within
// milliseconds. A request still open after this long is waiting for the person.
const PERMISSION_GRACE_MS = 2000;
const SESSION_ID = /^[0-9a-f-]{8,64}$/;
const TOOL_NAME = /^[\w.:/-]{1,80}$/;
const WINDOWS_PATH = /^(?:[a-z]:[\\/]|\\\\)/i;
const WATCHED = ['events.jsonl', 'updates.jsonl', 'summary.json'];
// Tools that wait for the person: a question to answer and a plan to approve.
const ASK_TOOLS = new Map([['ask_user_question', 'question'], ['exit_plan_mode', 'plan']]);
const CHUNKS = new Map([['user_message_chunk', 'user'], ['agent_message_chunk', 'assistant'], ['agent_thought_chunk', 'thinking']]);
const FAILED = new Set(['error', 'failed']);
const FINAL = new Set(['completed', 'failed']); // the last update of a tool call
const TOOL_META = 'x.ai/tool';
const SUBAGENT = 'subagent';
const HEADLESS = 'headless';
const WINDOW = { activeMinutes: 10, recentHours: 24, staleMinutes: 30 };
const NO_SUMMARY = Object.freeze({
  cwd: null,
  title: null,
  manual: false,
  agentName: null,
  model: null,
  effort: null,
  createdAt: null,
  activeAt: null,
  kind: null,
  parentId: null,
  branch: null,
});

export function createGrokSource({ root, settings, now = Date.now } = {}) {
  let folders = new Map(); // folder path -> session folder
  let scannedAt = null;

  function poll() {
    const fail = (error) => ({ ok: false, error, root: root ?? null, sessions: [] });
    try {
      if (!root) return fail('No Grok folder is set.');
      if (!isDirectory(root)) return fail('Pleni could not find the Grok folder.');
      const t = now();
      if (scannedAt === null || t - scannedAt >= SCAN_MS || t < scannedAt) {
        folders = scan(root, folders, t - windowOf(settings).recentHours * HOUR);
        scannedAt = t;
      }
      const snippets = settings?.content !== 'none';
      for (const folder of folders.values()) refresh(folder, snippets);
      return { ok: true, error: null, root, sessions: sessionsAt(t, snippets) };
    } catch {
      return fail('Pleni could not read the Grok sessions.');
    }
  }

  function sessionsAt(t, snippets) {
    const parents = parentsOf(folders.values());
    const out = new Map();
    const owners = new Map(); // session key -> folder
    for (const folder of folders.values()) {
      if (!hasRecords(folder)) continue;
      const session = toSession(folder, parents.get(folder.id) ?? null, t, snippets);
      out.set(session.key, session);
      owners.set(session.key, folder);
    }
    linkAgents(out, owners, parents, snippets);
    rollUpWorking(out);
    return [...out.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }

  function toSession(folder, link, t, snippets) {
    const sum = folder.summary ?? NO_SUMMARY;
    const s = folder.state;
    const meta = link?.meta ?? null;
    // A sub-agent is a session of its own. Its parent records it, and its own files say so too.
    const agent = Boolean(link) || sum.kind === SUBAGENT || s.relationship === SUBAGENT;
    const parentId = link?.parentId ?? (agent && sum.parentId !== folder.id ? sum.parentId : null);
    const startedAt = sum.createdAt ?? s.firstAt;
    const lastAt = s.lastAt ?? sum.activeAt ?? startedAt;
    const status = statusOf(s, agent ? meta : null, agent, t, windowOf(settings));
    const title = titleOf(sum, meta);
    const call = s.turnOpen ? s.open[s.open.length - 1] : undefined;
    return {
      platform: 'grok',
      key: `grok:${folder.id}`,
      id: folder.id,
      parentKey: parentId ? `grok:${parentId}` : null,
      kind: agent ? 'agent' : 'session',
      // A sub-agent its parent session started itself. Chain rules leave those where they are.
      spawned: agent,
      role: null,
      title: title.text,
      titleSource: title.source,
      cwd: normalizePath(sum.cwd ?? cwdOfFolder(folder.group)),
      branch: sum.branch,
      entrypoint: sum.kind,
      model: s.model ?? sum.model,
      effort: sum.effort,
      startedAt,
      lastAt,
      status,
      activity: status === 'working' && call
        ? { tool: call.tool, detail: snippets ? callFor(folder.talk, call.tool)?.detail ?? null : null, at: call.at ?? lastAt ?? t }
        : null,
      lastText: snippets ? flat(folder.talk.text, 280) : null,
      needs: needsOf(s, sum, folder.talk, t, snippets),
      links: [],
      archived: false,
    };
  }

  function detail(key, since) {
    const empty = { events: [], next: null };
    try {
      const folder = findFolder(key);
      if (!folder) return empty;
      const { records, next } = readFrom(path.join(folder.dir, 'updates.jsonl'), cursorOf(since));
      return { events: eventsOf(records, settings?.content !== 'none').slice(-MAX_EVENTS), next };
    } catch {
      return empty;
    }
  }

  function findFolder(key) {
    if (typeof key !== 'string' || !key.startsWith('grok:')) return null;
    const id = idOf(key.slice('grok:'.length));
    for (const folder of folders.values()) if (folder.id === id) return folder;
    return null;
  }

  return { poll, detail };
}

// ---- discovery ----

// Keeps the newest MAX_FILES session folders changed since `cutoff`; known folders keep their
// read state. A folder counts as changed when one of the files Pleni reads changed.
function scan(root, previous, cutoff) {
  const found = [];
  const base = path.join(root, 'sessions');
  for (const group of readDir(base)) {
    if (!group.isDirectory()) continue;
    const groupDir = path.join(base, group.name);
    for (const entry of readDir(groupDir)) {
      const id = entry.isDirectory() ? idOf(entry.name) : null;
      if (!id) continue;
      const dir = path.join(groupDir, entry.name);
      const mtimeMs = newestMtime(dir);
      if (mtimeMs !== null && mtimeMs >= cutoff) found.push({ dir, id, group: group.name, mtimeMs });
    }
  }
  found.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.dir < b.dir ? -1 : 1));
  const seen = new Set();
  const next = new Map();
  for (const entry of found) {
    if (next.size >= MAX_FILES) break;
    if (seen.has(entry.id)) continue; // the same session in two places: the newest copy wins
    seen.add(entry.id);
    const key = fileKey(entry.dir);
    const folder = previous.get(key) ?? newFolder(entry);
    readMetas(folder);
    next.set(key, folder);
  }
  return next;
}

function newestMtime(dir) {
  let newest = null;
  for (const name of WATCHED) {
    try {
      const ms = fs.statSync(path.join(dir, name)).mtimeMs;
      if (newest === null || ms > newest) newest = ms;
    } catch {
      // Not written yet.
    }
  }
  return newest;
}

function newFolder({ dir, id, group }) {
  return {
    dir,
    id,
    group,
    summary: null,
    summaryStat: { size: -1, mtimeMs: -1 },
    metas: new Map(), // meta.json path -> { size, mtimeMs, meta }, one per sub-agent it started
    events: newSource(path.join(dir, 'events.jsonl')),
    updates: newSource(path.join(dir, 'updates.jsonl')),
    state: newState(),
    talk: newTalk(),
  };
}

function newSource(file) {
  return {
    file,
    size: -1,
    mtimeMs: -1,
    started: false,
    partial: false, // the first read began in the middle of the file
    tail: new JsonlTail(file, { maxInitialBytes: TAIL_BYTES }),
  };
}

// What events.jsonl says: turns, tools, permission requests and times.
function newState() {
  return {
    firstAt: null,
    lastAt: null,
    model: null,
    relationship: null, // 'primary' or 'subagent', from the latest turn_started
    turnOpen: false,
    turnStartedAt: null,
    closedAt: null,
    lastError: false,
    sawTurn: false,
    open: [], // tools started and not completed yet, oldest first: { tool, at }
    asks: [], // permission requests not answered yet, oldest first: { tool, at }
  };
}

// What updates.jsonl says, read only with snippets: the latest reply and the open tool calls.
function newTalk() {
  return {
    text: null,
    stream: null, // when the model stream that wrote `text` started
    inMessage: false, // the record before was a chunk of a reply
    calls: new Map(), // tool call id -> { tool, detail, question }, oldest first
  };
}

function hasRecords(folder) {
  return folder.summary !== null || folder.state.lastAt !== null;
}

// ---- sub-agents ----

// For every sub-agent a session started, Grok keeps subagents/<id>/meta.json in the parent's
// folder. The sub-agent itself is a session of its own elsewhere in the sessions folder.
function readMetas(folder) {
  const dir = path.join(folder.dir, 'subagents');
  const seen = new Set();
  for (const entry of readDir(dir)) {
    if (!entry.isDirectory()) continue;
    const file = path.join(dir, entry.name, 'meta.json');
    let st;
    try {
      st = fs.statSync(file);
    } catch {
      continue;
    }
    seen.add(file);
    const known = folder.metas.get(file);
    if (known && known.size === st.size && known.mtimeMs === st.mtimeMs) continue;
    const raw = readJsonFile(file, JSON_BYTES);
    folder.metas.set(file, { size: st.size, mtimeMs: st.mtimeMs, meta: raw ? pickMeta(raw) : known?.meta ?? null });
  }
  for (const file of folder.metas.keys()) if (!seen.has(file)) folder.metas.delete(file);
}

// Only the fields Pleni uses; the rest (the sub-agent's whole prompt among them) is dropped.
function pickMeta(raw) {
  const status = str(raw.status)?.toLowerCase() ?? null;
  return {
    childId: idOf(raw.child_session_id),
    parentId: idOf(raw.parent_session_id),
    description: flat(raw.description, 120),
    startedAt: time(raw.started_at),
    finishedAt: time(raw.completed_at),
    failed: FAILED.has(status),
  };
}

// Child session id -> { parentId, meta }. A sub-agent started again keeps its newest start.
function parentsOf(list) {
  const out = new Map();
  for (const folder of list) {
    for (const { meta } of folder.metas.values()) {
      if (!meta?.childId || meta.childId === folder.id) continue;
      if (meta.parentId && meta.parentId !== folder.id) continue;
      const known = out.get(meta.childId);
      if (known && !((meta.startedAt ?? 0) > (known.meta.startedAt ?? 0))) continue;
      out.set(meta.childId, { parentId: folder.id, meta });
    }
  }
  return out;
}

// A sub-agent's start is work going down from its parent; its end is a report coming up.
function linkAgents(out, owners, parents, snippets) {
  const touched = new Set();
  for (const session of out.values()) {
    const parent = session.spawned && session.parentKey ? out.get(session.parentKey) : null;
    if (!parent || parent === session) continue;
    const meta = parents.get(session.id)?.meta ?? null;
    const startAt = session.startedAt ?? meta?.startedAt ?? null;
    if (startAt !== null) {
      parent.links.push({ at: startAt, dir: 'down', other: session.key, label: snippets ? meta?.description ?? session.title : null });
    }
    const endAt = session.status === 'done' || session.status === 'error' ? endOf(owners.get(session.key).state, meta) : null;
    if (endAt !== null) {
      parent.links.push({ at: endAt, dir: 'up', other: session.key, label: snippets && session.lastText ? clip(session.lastText, 140) : null });
    }
    touched.add(parent);
  }
  for (const parent of touched) {
    parent.links.sort((a, b) => a.at - b.at).splice(0, Math.max(0, parent.links.length - MAX_LINKS));
  }
}

// When a finished sub-agent ended: the close of its latest turn, else (its file still looks open,
// for example after Grok was stopped) its parent's record of its end.
function endOf(state, meta) {
  if (!state.turnOpen && state.closedAt !== null) return state.closedAt;
  return meta?.finishedAt ?? null;
}

// A session whose sub-agent is working is working too, even when its own turn ended or went
// quiet: it writes nothing while a long sub-agent runs. Only "ready" and "idle" are lifted.
function rollUpWorking(out) {
  for (const session of out.values()) {
    if (session.status !== 'working') continue;
    const seen = new Set([session.key]);
    let parent = session.parentKey ? out.get(session.parentKey) : null;
    while (parent && !seen.has(parent.key) && (parent.status === 'ready' || parent.status === 'idle')) {
      seen.add(parent.key);
      parent.status = 'working';
      parent = parent.parentKey ? out.get(parent.parentKey) : null;
    }
  }
}

// ---- reading ----

function refresh(folder, snippets) {
  readSummary(folder);
  readEvents(folder);
  if (snippets) readUpdates(folder);
}

function readSummary(folder) {
  const file = path.join(folder.dir, 'summary.json');
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    return; // not written yet
  }
  if (st.size === folder.summaryStat.size && st.mtimeMs === folder.summaryStat.mtimeMs) return;
  folder.summaryStat = { size: st.size, mtimeMs: st.mtimeMs };
  const raw = readJsonFile(file, JSON_BYTES);
  if (raw) folder.summary = pickSummary(raw); // a half-written file keeps the last good one
}

function pickSummary(raw) {
  const info = isObject(raw.info) ? raw.info : {};
  return {
    cwd: str(info.cwd),
    title: flat(raw.generated_title, 120),
    manual: raw.title_is_manual === true,
    agentName: flat(raw.agent_name, 120),
    model: str(raw.current_model_id),
    effort: str(raw.reasoning_effort),
    createdAt: time(raw.created_at),
    activeAt: time(raw.last_active_at),
    kind: str(raw.session_kind),
    parentId: idOf(raw.parent_session_id),
    branch: str(raw.head_branch),
  };
}

function readEvents(folder) {
  const src = folder.events;
  try {
    const st = fs.statSync(src.file);
    if (st.size === src.size && st.mtimeMs === src.mtimeMs) return;
    if (src.started && st.size - src.tail.offset > CATCH_UP_BYTES) {
      // Polls stop while nobody has the page open. Rather than parse a big backlog in one go,
      // start again near the end, keeping the facts that stay true.
      const old = folder.state;
      folder.state = { ...newState(), firstAt: old.firstAt, model: old.model, relationship: old.relationship };
      restart(src);
    }
    const out = src.tail.read();
    if (out.reset || !src.started) {
      if (out.reset) folder.state = newState();
      src.started = true;
      src.partial = out.size > TAIL_BYTES;
    }
    for (const rec of out.records) applyEvent(folder, rec);
    src.size = st.size;
    src.mtimeMs = st.mtimeMs;
  } catch {
    // Missing, locked or busy for a moment: try again on the next poll.
  }
}

function readUpdates(folder) {
  const src = folder.updates;
  try {
    const st = fs.statSync(src.file);
    if (st.size === src.size && st.mtimeMs === src.mtimeMs) return;
    if (src.started && st.size - src.tail.offset > CATCH_UP_BYTES) {
      folder.talk = { ...newTalk(), text: folder.talk.text };
      restart(src);
    }
    const out = src.tail.read();
    if (out.reset) folder.talk = newTalk();
    src.started = true;
    for (const rec of out.records) applyUpdate(folder.talk, rec);
    src.size = st.size;
    src.mtimeMs = st.mtimeMs;
  } catch {
    // Missing, locked or busy for a moment: try again on the next poll.
  }
}

function restart(src) {
  src.tail = new JsonlTail(src.file, { maxInitialBytes: TAIL_BYTES });
  src.started = false;
}

function applyEvent(folder, rec) {
  const s = folder.state;
  const at = time(rec.ts);
  touch(s, at);
  switch (rec.type) {
    case 'turn_started':
      s.turnOpen = true;
      s.turnStartedAt = at;
      s.sawTurn = true;
      s.open = [];
      s.asks = [];
      if (str(rec.model_id)) s.model = rec.model_id;
      if (str(rec.session_relationship) && (rec.session_id === undefined || idOf(rec.session_id) === folder.id)) {
        s.relationship = rec.session_relationship;
      }
      return;
    case 'turn_ended':
      s.turnOpen = false;
      s.closedAt = at;
      s.lastError = FAILED.has(rec.outcome);
      s.sawTurn = true;
      s.open = [];
      s.asks = [];
      return;
    case 'loop_started':
      // A new round with the model: the tools of the round before are over, even the few whose
      // end Grok did not record.
      inside(folder);
      s.open = [];
      s.asks = [];
      return;
    case 'tool_started':
      inside(folder);
      remember(s.open, { tool: str(rec.tool_name) ?? 'tool', at });
      return;
    case 'tool_completed':
      forget(s.open, str(rec.tool_name) ?? 'tool');
      return;
    case 'permission_requested':
      inside(folder);
      remember(s.asks, { tool: str(rec.tool_name) ?? 'tool', at });
      return;
    case 'permission_resolved':
      forget(s.asks, str(rec.tool_name) ?? 'tool');
      return;
    case 'phase_changed':
    case 'first_token':
    case 'interjected':
      inside(folder);
      return;
  }
}

// Reading began mid-file and no turn boundary has been seen yet: we are inside a turn.
function inside(folder) {
  const s = folder.state;
  if (folder.events.partial && !s.sawTurn) s.turnOpen = true;
}

function remember(list, item) {
  list.push(item);
  if (list.length > MAX_OPEN) list.shift();
}

// Tool and permission events carry no call id, only the tool name; the oldest open one of that
// name is the one that ended.
function forget(list, tool) {
  const i = list.findIndex((item) => item.tool === tool);
  if (i !== -1) list.splice(i, 1);
}

function applyUpdate(talk, rec) {
  const u = updateOf(rec);
  if (!u) return;
  if (u.sessionUpdate === 'agent_message_chunk') {
    const piece = chunkText(u.content);
    if (!piece) return;
    const stream = streamOf(rec);
    const join = talk.inMessage && stream !== null && stream === talk.stream;
    talk.text = (join ? `${talk.text}${piece}` : piece).slice(0, MAX_RUN);
    talk.stream = stream;
    talk.inMessage = true;
    return;
  }
  talk.inMessage = false;
  if (u.sessionUpdate === 'tool_call') {
    const id = str(u.toolCallId);
    if (!id) return;
    talk.calls.delete(id);
    talk.calls.set(id, { tool: toolNameOf(u) ?? 'tool', detail: toolDetail(u.rawInput), question: questionOf(u.rawInput) });
    if (talk.calls.size > MAX_OPEN) talk.calls.delete(talk.calls.keys().next().value);
  } else if (u.sessionUpdate === 'tool_call_update') {
    const id = str(u.toolCallId);
    const call = id ? talk.calls.get(id) : undefined;
    if (!call) return;
    if (FINAL.has(u.status)) talk.calls.delete(id);
    else if (!call.detail && isObject(u.rawInput)) {
      call.detail = toolDetail(u.rawInput);
      call.question = call.question ?? questionOf(u.rawInput);
    }
  } else if (u.sessionUpdate === 'turn_completed') {
    talk.calls.clear();
  }
}

function touch(s, at) {
  if (at === null) return;
  if (s.lastAt === null || at > s.lastAt) s.lastAt = at;
  if (s.firstAt === null || at < s.firstAt) s.firstAt = at;
}

// ---- snapshot helpers ----

function titleOf(sum, meta) {
  if (sum.title) return { text: sum.title, source: sum.manual ? 'manual' : 'generated_title' };
  if (meta?.description) return { text: meta.description, source: 'description' };
  if (sum.agentName) return { text: sum.agentName, source: 'agent_name' };
  return { text: null, source: null };
}

function statusOf(s, meta, agent, t, w) {
  // The parent's record that a sub-agent ended counts only if it is newer than its latest turn.
  const endAt = meta?.finishedAt ?? null;
  const finished = endAt !== null && (s.turnStartedAt === null || endAt >= s.turnStartedAt);
  if (s.turnOpen && !finished) {
    return s.lastAt !== null && t - s.lastAt <= w.staleMinutes * MINUTE ? 'working' : 'idle';
  }
  if (s.lastError || (finished && meta.failed)) return 'error';
  if (agent && (finished || s.closedAt !== null)) return 'done';
  if (s.closedAt !== null && t - s.closedAt <= w.activeMinutes * MINUTE) return 'ready';
  return 'idle';
}

// What the person must do before this session can go on, or null. A headless session (run by a
// script, not a person) never waits for the person. A question or a plan waits until it is
// answered, however long that takes.
function needsOf(s, sum, talk, t, snippets) {
  if (!s.turnOpen || sum.kind === HEADLESS) return null;
  const ask = s.asks[0];
  if (ask && ask.at !== null && t - ask.at >= PERMISSION_GRACE_MS) return { kind: 'permission', text: null, at: ask.at };
  for (let i = s.open.length - 1; i >= 0; i--) {
    const call = s.open[i];
    const kind = ASK_TOOLS.get(call.tool);
    if (!kind) continue;
    const text = kind === 'question' && snippets ? callFor(talk, call.tool)?.question ?? null : null;
    return { kind, text, at: call.at ?? s.lastAt };
  }
  return null;
}

// The newest open call of a tool in updates.jsonl, which holds its input.
function callFor(talk, tool) {
  let found = null;
  for (const call of talk.calls.values()) if (call.tool === tool) found = call;
  return found;
}

// The folder of a session's working folder is that path, URL-encoded. A very long path gets a
// short name instead; then only the summary has it.
function cwdOfFolder(name) {
  try {
    const decoded = decodeURIComponent(name);
    return decoded !== name && (path.isAbsolute(decoded) || WINDOWS_PATH.test(decoded)) ? decoded : null;
  } catch {
    return null;
  }
}

function windowOf(settings) {
  const w = isObject(settings?.window) ? settings.window : {};
  const pick = (name) => (Number.isFinite(w[name]) && w[name] > 0 ? w[name] : WINDOW[name]);
  return { activeMinutes: pick('activeMinutes'), recentHours: pick('recentHours'), staleMinutes: pick('staleMinutes') };
}

// ---- detail ----

// Reads complete lines from `since` (or the last DETAIL_BYTES) to the end. If the file grows
// between the size check and the read, the window would shift, so try again.
function readFrom(file, since) {
  for (let attempt = 1; ; attempt++) {
    const size = fs.statSync(file).size;
    const from = since !== null && since <= size ? Math.max(since, size - DETAIL_BYTES) : Math.max(0, size - DETAIL_BYTES);
    const tail = new JsonlTail(file, { maxInitialBytes: size - from });
    const out = tail.read();
    if (out.size === size || attempt >= 3) return { records: out.records, next: tail.offset };
  }
}

// The drawer's events, from updates.jsonl. Pieces of one message become one event; thinking is
// only marked, never shown.
function eventsOf(records, snippets) {
  const tools = new Map(); // tool call id -> tool name
  const events = [];
  let message = null; // the event the next piece of the same message belongs to
  const push = (at, kind, tool, text, stream = null) => {
    const event = { at, kind, tool, text: text || '', stream };
    events.push(event);
    return event;
  };
  for (const rec of records) {
    const u = updateOf(rec);
    const at = updateTime(rec);
    if (!u || at === null) {
      message = null;
      continue;
    }
    const chunk = CHUNKS.get(u.sessionUpdate);
    if (chunk) {
      const text = chunk === 'thinking' ? '' : chunkText(u.content);
      const stream = streamOf(rec);
      if (message?.kind === chunk && stream !== null && message.stream === stream) {
        message.text = `${message.text}${text}`.slice(0, MAX_RUN);
      } else message = push(at, chunk, null, text, stream);
      continue;
    }
    message = null;
    if (u.sessionUpdate === 'tool_call') {
      const name = toolNameOf(u) ?? 'tool';
      if (str(u.toolCallId)) tools.set(u.toolCallId, name);
      push(at, 'tool', name, toolDetail(u.rawInput));
    } else if (u.sessionUpdate === 'tool_call_update' && FINAL.has(u.status)) {
      const name = tools.get(u.toolCallId) ?? toolNameOf(u);
      push(at, u.status === 'failed' ? 'error' : 'result', name, resultText(u.content));
    } else if (u.sessionUpdate === 'turn_completed' && str(u.stop_reason) && u.stop_reason !== 'end_turn') {
      push(at, 'error', null, u.stop_reason === 'cancelled' ? 'Stopped' : `Stopped: ${u.stop_reason.replace(/_/g, ' ')}`);
    }
  }
  return events.map((e) => ({
    at: e.at,
    kind: e.kind,
    tool: e.tool,
    text: snippets && e.kind !== 'thinking' && e.text.trim() ? clip(e.text.trim(), 2000) : null,
  }));
}

function cursorOf(since) {
  if (typeof since === 'number' && Number.isSafeInteger(since) && since >= 0) return since;
  if (typeof since === 'string' && /^\d{1,15}$/.test(since)) return Number(since);
  return null;
}

function updateOf(rec) {
  return isObject(rec.params) && isObject(rec.params.update) && typeof rec.params.update.sessionUpdate === 'string'
    ? rec.params.update
    : null;
}

// When the update happened, in milliseconds. The record's own `timestamp` is in whole seconds
// and is written later, so the time in _meta comes first.
function updateTime(rec) {
  const meta = isObject(rec.params?._meta) ? rec.params._meta : {};
  return time(meta.agentTimestampMs) ?? time(rec.timestamp);
}

// Grok saves each reply whole, as one chunk. Should a reply come in pieces, they share the time
// their model stream started.
function streamOf(rec) {
  const meta = isObject(rec.params?._meta) ? rec.params._meta : {};
  return Number.isFinite(meta.streamStartMs) ? meta.streamStartMs : null;
}

function chunkText(content) {
  return isObject(content) && typeof content.text === 'string' ? content.text : '';
}

function resultText(content) {
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => isObject(part) && part.type === 'content' && isObject(part.content) && typeof part.content.text === 'string')
    .map((part) => part.content.text)
    .join('\n');
}

// The tool's name from Grok's own tool metadata, else the call's title (which is the name).
function toolNameOf(u) {
  const info = isObject(u._meta) && isObject(u._meta[TOOL_META]) ? u._meta[TOOL_META] : null;
  const name = str(info?.name) ?? str(u.title);
  return name && TOOL_NAME.test(name) ? name : null;
}

// ---- text helpers ----

// Short words about what a tool call does (<=140 chars), from its input.
function toolDetail(input) {
  if (!isObject(input)) return null;
  const text = inputDetail(input);
  return text ? clip(text, 140) : null;
}

function inputDetail(a) {
  const description = str(a.description);
  if (description) return firstLine(description, 80);
  const command = commandText(a.command);
  if (command) return firstLine(command, 80);
  const file = str(a.file_path) ?? str(a.target_file);
  if (file) return baseName(file);
  const pattern = str(a.pattern) ?? str(a.query);
  if (pattern) return flat(pattern, 140);
  const folder = str(a.path) ?? str(a.target_directory);
  if (folder) return baseName(folder);
  const tool = str(a.tool_name);
  if (tool) return flat(tool, 80);
  const question = questionOf(a);
  if (question) return clip(question, 80);
  const url = str(a.url);
  return url ? hostOf(url) : null;
}

// The first question of an ask_user_question call.
function questionOf(input) {
  if (!isObject(input) || !Array.isArray(input.questions)) return null;
  const first = input.questions.find((q) => isObject(q) && str(q.question));
  return first ? flat(first.question, 280) : null;
}

function commandText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.filter((part) => typeof part === 'string').join(' ');
  return null;
}

function firstLine(text, max) {
  const line = text.split('\n').map((part) => part.trim()).find(Boolean);
  return line ? clip(line.replace(/\s+/g, ' '), max) : null;
}

function flat(text, max) {
  if (typeof text !== 'string') return null;
  const value = text.replace(/\s+/g, ' ').trim();
  return value ? clip(value, max) : null;
}

function clip(text, max) {
  if (text.length <= max) return text;
  let end = max - 1;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end--; // do not split a surrogate pair
  return `${text.slice(0, end)}…`;
}

function baseName(file) {
  const parts = normalizePath(file).split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : null;
}

function hostOf(url) {
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}

// Windows long paths: \\?\C:\x becomes C:\x and \\?\UNC\server\share becomes \\server\share.
function normalizePath(value) {
  if (typeof value !== 'string' || !value) return null;
  if (value.startsWith('\\\\?\\UNC\\')) return `\\\\${value.slice(8)}`;
  if (value.startsWith('\\\\?\\')) return value.slice(4);
  return value;
}

// ---- small helpers ----

function readDir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function fileKey(file) {
  return process.platform === 'win32' ? file.toLowerCase() : file;
}

function isDirectory(dir) {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function idOf(value) {
  if (typeof value !== 'string') return null;
  const id = value.trim().toLowerCase();
  return SESSION_ID.test(id) ? id : null;
}

function str(value) {
  return typeof value === 'string' && value.trim() ? value : null;
}

// ISO text, or a number of milliseconds. Grok writes some times as whole seconds.
function time(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return null;
    return value < 1e11 ? value * 1000 : value;
  }
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
