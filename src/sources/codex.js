// Codex threads and sub-agents, read from the rollout files Codex writes in its home folder.
// Read-only: files are tailed incrementally and nothing is ever written.
import fs from 'node:fs';
import path from 'node:path';
import { JsonlTail, readHeadLine, readJsonFile, scanHead } from '../jsonl.js';

// node:sqlite reads the coordinator registry. It is missing on some Node.js builds; then workers
// simply show without their coordinator.
const sqlite = await import('node:sqlite').catch(() => null);

const MiB = 1024 * 1024;
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const SCAN_MS = 30 * 1000;
const MAX_FILES = 300;
const MAX_LINKS = 50;
const MAX_RECEIVED = 200;
const MAX_EVENTS = 200;
const TAIL_BYTES = 4 * MiB;
const CATCH_UP_BYTES = 16 * MiB; // more unread bytes than this: start again near the end
const HEAD_BYTES = 16 * MiB;
const HEAD_SCAN_BYTES = 4 * MiB;
const INDEX_BYTES = 16 * MiB;
const DETAIL_BYTES = 2 * MiB;
const ROOT_AGENT = '/root';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROLLOUT = /^rollout-.*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
const THREAD_ID = /^[0-9a-f-]{8,64}$/;
const DATE_DIR = /^\d{1,4}$/;
// Context Codex adds as user messages: <tag> blocks and the AGENTS.md instructions.
const INJECTED = /^(?:<[a-z_]+>|# AGENTS\.md instructions\b)/;
const PATCH_FILE = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/m;
const CALLS = new Set(['function_call', 'custom_tool_call']);
const OUTPUTS = new Set(['function_call_output', 'custom_tool_call_output']);
const MESSAGE_TOOLS = new Set(['send_message', 'followup_task']);
// A message from another thread arrives as the output of this call, wrapped in a delegation block.
const RECEIVED_TOOL = 'send_message_to_thread';
const DELEGATION_OPEN = '<codex_delegation>';
const DELEGATION_CLOSE = '</codex_delegation>';
const DELEGATION_INPUT = /<input>([\s\S]*)<\/input>/;
const DELEGATION_SOURCE = /<source_thread_id>([^<]*)<\/source_thread_id>/;
const WINDOW = { activeMinutes: 10, recentHours: 24, staleMinutes: 30 };

export function createCodexSource({ root, settings, now = Date.now } = {}) {
  let threads = new Map(); // file key -> thread
  let scannedAt = null;
  let index = null;
  const titles = new Map(); // thread id -> name from session_index.jsonl
  let registry = EMPTY_REGISTRY;
  let registryAt = null;

  function poll() {
    const fail = (error) => ({ ok: false, error, root: root ?? null, sessions: [] });
    try {
      if (!root) return fail('No Codex folder is set.');
      if (!isDirectory(root)) return fail('Pleni could not find the Codex folder.');
      const t = now();
      if (registryAt === null || t - registryAt >= SCAN_MS || t < registryAt) {
        registry = readRegistry(root);
        registryAt = t;
      }
      if (scannedAt === null || t - scannedAt >= SCAN_MS || t < scannedAt) {
        threads = scan(root, threads, t - windowOf(settings).recentHours * HOUR, bossesOf(registry));
        scannedAt = t;
      }
      readTitles();
      const snippets = settings?.content !== 'none';
      for (const thread of threads.values()) refresh(thread, snippets);
      return { ok: true, error: null, root, sessions: sessionsAt(t) };
    } catch {
      return fail('Pleni could not read the Codex sessions.');
    }
  }

  function readTitles() {
    if (!index) index = new JsonlTail(path.join(root, 'session_index.jsonl'), { maxInitialBytes: INDEX_BYTES });
    let out;
    try {
      out = index.read();
    } catch {
      return;
    }
    if (out.reset) titles.clear();
    for (const rec of out.records) {
      const id = idOf(rec.id);
      if (!id) continue;
      const name = flat(rec.thread_name, 120);
      if (name) titles.set(id, name);
      else titles.delete(id);
    }
  }

  function sessionsAt(t) {
    const list = [...threads.values()].filter((thread) => thread.meta);
    const ctx = contextOf(list);
    const out = new Map();
    for (const thread of list) {
      const session = toSession(thread, ctx, t);
      if (!out.has(session.key)) out.set(session.key, session);
    }
    linkWorkers(out, ctx);
    linkMessages(out, ctx);
    return [...out.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }

  // A coordinator's worker is a thread of its own with no parent in its file; the registry says
  // who started it. Its start is work going down; the end of its latest turn is a report coming up.
  function linkWorkers(out, ctx) {
    for (const session of out.values()) {
      const boss = registry.workers.get(session.id);
      if (!boss || session.parentKey !== `codex:${boss}`) continue;
      const parent = out.get(session.parentKey);
      const thread = ctx.byId.get(session.id);
      if (parent && session.startedAt !== null) {
        parent.links.push({ at: session.startedAt, dir: 'down', other: session.key, label: session.title });
        parent.links.sort((a, b) => a.at - b.at).splice(0, Math.max(0, parent.links.length - MAX_LINKS));
      }
      const closedAt = thread?.state.closedAt ?? null;
      if (closedAt !== null && !thread.state.turnOpen) {
        session.links.push({ at: closedAt, dir: 'up', other: session.parentKey, label: null });
      }
    }
  }

  // A message one thread sends another is recorded only in the recipient's file, but the line
  // belongs to the sender. Senders that are not listed get nothing.
  function linkMessages(out, ctx) {
    const snippets = settings?.content !== 'none';
    const touched = new Set();
    for (const session of out.values()) {
      const thread = ctx.byId.get(session.id);
      for (const message of thread?.state.received ?? []) {
        const sender = out.get(`codex:${message.from}`);
        if (!sender || sender === session) continue;
        sender.links.push({ at: message.at, dir: 'down', other: session.key, label: snippets ? message.label : null });
        touched.add(sender);
      }
    }
    for (const sender of touched) {
      sender.links.sort((a, b) => a.at - b.at).splice(0, Math.max(0, sender.links.length - MAX_LINKS));
    }
  }

  function toSession(thread, ctx, t) {
    const { meta, state: s } = thread;
    const snippets = settings?.content !== 'none';
    const ownParent = parentIdOf(meta);
    const boss = registry.workers.get(thread.id);
    const parentId = ownParent ?? (boss && boss !== thread.id ? boss : null);
    const status = statusOf(s, ownParent ? ctx.done.get(thread.id) : undefined, t, windowOf(settings));
    const title = titleOf(thread);
    const startedAt = time(meta.timestamp) ?? s.firstAt;
    const call = [...s.pending.values()].pop();
    return {
      platform: 'codex',
      key: `codex:${thread.id}`,
      id: thread.id,
      parentKey: parentId ? `codex:${parentId}` : null,
      kind: isReviewer(meta, s) ? 'reviewer' : parentId ? 'agent' : 'session',
      // A sub-agent its parent thread started itself. Chain rules leave those where they are.
      spawned: Boolean(ownParent),
      role: registry.superintendent === thread.id ? 'superintendent' : registry.coordinators.has(thread.id) ? 'coordinator' : null,
      title: title.text,
      titleSource: title.source,
      cwd: normalizePath(str(meta.cwd) ?? s.cwd),
      branch: str(meta.git?.branch),
      entrypoint: str(meta.originator),
      model: s.model,
      effort: s.effort,
      startedAt,
      lastAt: s.lastAt ?? startedAt,
      status,
      activity: status === 'working' && call
        ? { tool: call.tool, detail: snippets ? call.detail : null, at: call.at ?? s.lastAt ?? t }
        : null,
      lastText: snippets ? s.lastText : null,
      needs: needsOf(s),
      links: linksOf(thread, ctx, snippets),
      archived: thread.archived || registry.imported.has(thread.id),
      // A file read from its middle may hold squeezes before the part Pleni read.
      context: { used: s.used, size: s.size, squeezes: s.squeezes, squeezesAtLeast: thread.partial, squeezedAt: s.squeezedAt },
    };
  }

  function titleOf(thread) {
    const indexed = titles.get(thread.id);
    if (indexed) return { text: indexed, source: 'session_index' };
    const meta = thread.meta;
    const nickname = flat(meta.agent_nickname ?? meta.source?.subagent?.thread_spawn?.agent_nickname, 120);
    if (nickname) return { text: nickname, source: 'agent_nickname' };
    return { text: null, source: null };
  }

  function detail(key, since) {
    const empty = { events: [], next: null };
    try {
      const thread = findThread(key);
      if (!thread) return empty;
      const meta = thread.meta ?? readHeadLine(thread.file, HEAD_BYTES)?.payload ?? null;
      const { records, next } = readFrom(thread.file, cursorOf(since));
      const events = eventsOf(records, meta, settings?.content !== 'none');
      return { events: events.slice(-MAX_EVENTS), next };
    } catch {
      return empty;
    }
  }

  function findThread(key) {
    if (typeof key !== 'string' || !key.startsWith('codex:')) return null;
    const id = idOf(key.slice('codex:'.length));
    for (const thread of threads.values()) if (thread.id === id) return thread;
    return null;
  }

  return { poll, detail };
}

// ---- discovery ----

// Keeps the newest MAX_FILES rollouts modified since `cutoff`; known files keep their read state.
// Coordinators and the superintendent stay on the map however long they have been quiet: a boss
// waiting for the person is still the boss of everyone below it.
function bossesOf(registry) {
  const ids = new Set(registry.coordinators);
  if (registry.superintendent) ids.add(registry.superintendent);
  return ids;
}

function scan(root, previous, cutoff, keep = new Set()) {
  const found = [];
  collect(path.join(root, 'sessions'), false, 0, cutoff, found, keep);
  collect(path.join(root, 'archived_sessions'), true, 0, cutoff, found, keep);
  // Kept bosses go first, so the cap on how many files are followed never pushes them out.
  found.sort((a, b) => Number(keep.has(b.id)) - Number(keep.has(a.id)) || b.mtimeMs - a.mtimeMs || (a.file < b.file ? -1 : 1));
  const seen = new Set();
  const next = new Map();
  for (const entry of found) {
    if (next.size >= MAX_FILES) break;
    if (seen.has(entry.id)) continue; // the same thread in two places: the newest copy wins
    seen.add(entry.id);
    const key = fileKey(entry.file);
    const thread = previous.get(key) ?? newThread(entry);
    thread.archived = entry.archived;
    next.set(key, thread);
  }
  return next;
}

// A rollout stays in the day folder it was created in, so every day folder is walked.
function collect(dir, archived, depth, cutoff, found, keep) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (depth < 3 && DATE_DIR.test(entry.name)) collect(full, archived, depth + 1, cutoff, found, keep);
      continue;
    }
    const match = ROLLOUT.exec(entry.name);
    if (!match || !entry.isFile()) continue;
    let st;
    try {
      st = fs.statSync(full);
    } catch {
      continue;
    }
    const id = match[1].toLowerCase();
    if (st.mtimeMs >= cutoff || keep.has(id)) found.push({ file: full, id, archived, mtimeMs: st.mtimeMs });
  }
}

function newThread({ file, id, archived }) {
  return {
    file,
    id,
    archived,
    meta: null,
    headSize: -1, // file size at the last failed attempt to read the head line
    size: -1,
    mtimeMs: -1,
    started: false,
    partial: false, // the first read began in the middle of the file
    tail: new JsonlTail(file, { maxInitialBytes: TAIL_BYTES }),
    state: newState(),
  };
}

function newState() {
  return {
    firstAt: null,
    lastAt: null,
    model: null,
    effort: null,
    cwd: null,
    turnOpen: false,
    turnId: null,
    turnStartedAt: null,
    closedAt: null,
    lastError: false,
    sawTurn: false,
    pending: new Map(), // call_id -> { tool, detail, at }, oldest first
    lastText: null,
    links: [],
    spawns: new Map(), // call_id -> link, until the spawn output names the agent path
    paths: new Map(), // agent path -> thread id, from SubAgentActivity items
    completed: new Map(), // child thread id -> time its completion was recorded here
    received: [], // { at, from, label } for messages other threads sent here, oldest first
    used: null, // tokens in the context (memory) after the newest model call
    size: null, // how many tokens the model's context holds
    squeezes: 0, // "compacted" records Pleni has read; a long file is read from its end, so maybe more
    squeezedAt: null,
  };
}

// ---- reading ----

function refresh(thread, snippets) {
  try {
    const st = fs.statSync(thread.file);
    if (st.size === thread.size && st.mtimeMs === thread.mtimeMs) return;
    if (!thread.meta && !loadMeta(thread, st.size)) return;
    if (thread.started && st.size - thread.tail.offset > CATCH_UP_BYTES) restart(thread);
    const out = thread.tail.read();
    const fresh = out.reset || !thread.started;
    if (fresh) {
      if (out.reset) {
        thread.state = newState();
        loadMeta(thread, -1);
      }
      thread.started = true;
      thread.partial = out.size > TAIL_BYTES;
    }
    for (const rec of out.records) apply(thread, rec, snippets);
    if (fresh && thread.partial && !thread.state.model) guessModel(thread);
    thread.size = st.size;
    thread.mtimeMs = st.mtimeMs;
  } catch {
    // One unreadable file must not hide the others; try again on the next poll.
  }
}

// Polls stop while nobody has the page open, and a busy file can grow by hundreds of megabytes
// meanwhile. Rather than parse all of that in one go, start again near the end, as on the first
// read, keeping the facts that stay true.
function restart(thread) {
  const old = thread.state;
  thread.state = {
    ...newState(),
    firstAt: old.firstAt,
    model: old.model,
    effort: old.effort,
    cwd: old.cwd,
    links: old.links,
    paths: old.paths,
    completed: old.completed,
    received: old.received,
    used: old.used,
    size: old.size,
    squeezes: old.squeezes,
    squeezedAt: old.squeezedAt,
  };
  thread.tail = new JsonlTail(thread.file, { maxInitialBytes: TAIL_BYTES });
  thread.started = false;
}

// The meta line comes first and can be megabytes long. Records are not read until it is known,
// because a sub-agent's inherited history can only be skipped with it.
function loadMeta(thread, size) {
  if (size !== -1 && size === thread.headSize) return false;
  const head = readHeadLine(thread.file, HEAD_BYTES);
  if (head) {
    thread.meta = head.type === 'session_meta' && isObject(head.payload) ? pickMeta(head.payload) : {};
    thread.id = idOf(thread.meta.id) ?? thread.id;
    return true;
  }
  thread.headSize = size;
  if (size > HEAD_BYTES && !thread.meta) {
    thread.meta = {}; // the head is too big to read; show the thread without it
    return true;
  }
  return Boolean(thread.meta);
}

// Keeps only the fields Pleni uses. The rest of the head line (instructions and the like) can be
// megabytes, and up to 300 threads are held at once.
function pickMeta(p) {
  const sub = isObject(p.source) && isObject(p.source.subagent) ? p.source.subagent : null;
  const spawn = isObject(sub?.thread_spawn) ? sub.thread_spawn : null;
  return {
    id: p.id,
    timestamp: p.timestamp,
    cwd: p.cwd,
    originator: p.originator,
    session_id: p.session_id,
    git: isObject(p.git) ? { branch: p.git.branch } : null,
    parent_thread_id: p.parent_thread_id,
    agent_nickname: p.agent_nickname,
    agent_path: p.agent_path,
    subagent_history_start_ordinal: p.subagent_history_start_ordinal,
    source: sub && {
      subagent: {
        other: sub.other,
        thread_spawn: spawn && {
          parent_thread_id: spawn.parent_thread_id,
          agent_path: spawn.agent_path,
          agent_nickname: spawn.agent_nickname,
        },
      },
    },
  };
}

// In a big file the latest turn_context can lie before the tail we read; the newest one near
// the start is the best guess we have.
function guessModel(thread) {
  const isOwnContext = (rec) => rec.type === 'turn_context' && !isInherited(thread.meta, rec);
  const found = scanHead(thread.file, HEAD_SCAN_BYTES, isOwnContext);
  const last = found.findLast((rec) => str(rec.payload?.model));
  if (!last) return;
  thread.state.model = last.payload.model;
  thread.state.effort = str(last.payload.effort);
}

function apply(thread, rec, snippets) {
  if (isInherited(thread.meta, rec)) return;
  const s = thread.state;
  const payload = isObject(rec.payload) ? rec.payload : {};
  const at = time(rec.timestamp);
  switch (rec.type) {
    case 'turn_context':
      if (str(payload.model)) {
        s.model = payload.model;
        s.effort = str(payload.effort);
      }
      s.cwd = str(payload.cwd) ?? s.cwd;
      return;
    case 'response_item':
      touch(s, at);
      onItem(thread, payload, at, snippets);
      return;
    case 'event_msg':
      touch(s, at);
      onEvent(s, payload, at);
      return;
    case 'compacted':
      touch(s, at);
      s.squeezes++;
      if (at !== null) s.squeezedAt = at;
      return;
  }
}

function onEvent(s, p, at) {
  switch (p.type) {
    case 'task_started':
      s.turnOpen = true;
      s.turnId = str(p.turn_id);
      s.turnStartedAt = at;
      s.sawTurn = true;
      s.pending.clear();
      return;
    case 'task_complete':
      if (str(p.last_agent_message)) s.lastText = flat(p.last_agent_message, 280);
      closeTurn(s, str(p.turn_id), at, Boolean(p.error));
      return;
    case 'turn_aborted':
      closeTurn(s, str(p.turn_id), at, false);
      return;
    case 'item_completed':
      if (isObject(p.item) && p.item.type === 'SubAgentActivity') onSubAgent(s, p.item, at);
      return;
    case 'token_count':
      onTokens(s, p.info);
      return;
  }
}

// How full the context is: the newest model call's tokens, out of what the model holds.
function onTokens(s, info) {
  if (!isObject(info)) return;
  const last = isObject(info.last_token_usage) ? info.last_token_usage : {};
  if (tokens(last.total_tokens) > 0) s.used = tokens(last.total_tokens);
  if (tokens(info.model_context_window) > 0) s.size = tokens(info.model_context_window);
}

function tokens(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function closeTurn(s, turnId, at, error) {
  s.sawTurn = true;
  // A late close for an older turn does not close the turn that is running now.
  if (s.turnOpen && turnId && s.turnId && turnId !== s.turnId) return;
  s.turnOpen = false;
  s.turnId = null;
  s.closedAt = at;
  s.lastError = error;
  s.pending.clear();
}

function onItem(thread, p, at, snippets) {
  const s = thread.state;
  // Reading began mid-file and no turn boundary has been seen yet: we are inside a turn.
  if (thread.partial && !s.sawTurn && !s.turnOpen && (CALLS.has(p.type) || p.type === 'message')) s.turnOpen = true;
  if (CALLS.has(p.type)) onCall(thread, p, at);
  else if (OUTPUTS.has(p.type)) {
    onOutput(s, p);
    if (p.type === 'function_call_output' && p.name === RECEIVED_TOOL) onReceived(thread, p, at, snippets);
  } else if (p.type === 'message' && p.role === 'assistant') {
    const text = flat(messageText(p.content), 280);
    if (text) s.lastText = text;
  }
}

function onCall(thread, p, at) {
  const s = thread.state;
  const name = str(p.name) ?? 'tool';
  const args = p.type === 'function_call' ? parseObject(p.arguments) : null;
  const callId = str(p.call_id);
  if (callId) {
    s.pending.delete(callId);
    s.pending.set(callId, { tool: name, detail: toolDetail(args, p.input), at });
  }
  const own = agentPathOf(thread.meta);
  if (name === 'spawn_agent') {
    const task = str(args?.task_name);
    const link = addLink(s, { at, dir: 'down', id: null, path: task ? fullAgentPath(own, task) : null, label: task ? clip(task, 140) : null });
    if (callId) s.spawns.set(callId, link);
  } else if (MESSAGE_TOOLS.has(name)) {
    const target = str(args?.target);
    if (target) addLink(s, messageLink(own, parentIdOf(thread.meta), target, at));
  }
}

function onOutput(s, p) {
  const callId = str(p.call_id);
  if (!callId) return;
  s.pending.delete(callId);
  const link = s.spawns.get(callId);
  if (!link) return;
  s.spawns.delete(callId);
  // spawn_agent answers with the new agent's full path, e.g. {"task_name":"/root/scout"}.
  const result = parseObject(outputText(p.output));
  const spawned = str(result?.task_name) ?? str(result?.agent_path);
  if (spawned?.startsWith('/')) link.path = spawned;
}

// Another thread's message to this one. Only the sender and a short label are kept, never the text.
function onReceived(thread, p, at, snippets) {
  if (at === null) return;
  const message = delegationOf(outputText(p.output), snippets);
  if (!message || message.from === thread.id) return;
  const s = thread.state;
  s.received.push({ at, from: message.from, label: message.label });
  if (s.received.length > MAX_RECEIVED) s.received.shift();
}

// <codex_delegation><source_thread_id>UUID</source_thread_id><input>TEXT</input></codex_delegation>,
// possibly with whitespace and other tags around it. The sender id is looked for outside <input>,
// so a message cannot claim to come from someone else.
function delegationOf(text, snippets) {
  const start = text.indexOf(DELEGATION_OPEN);
  const end = text.lastIndexOf(DELEGATION_CLOSE);
  if (start === -1 || end < start) return null;
  const block = text.slice(start + DELEGATION_OPEN.length, end);
  const input = DELEGATION_INPUT.exec(block);
  const rest = input ? block.slice(0, input.index) + block.slice(input.index + input[0].length) : block;
  const from = idOf(DELEGATION_SOURCE.exec(rest)?.[1]);
  if (!from || !UUID.test(from)) return null;
  return { from, label: snippets && input ? firstLine(input[1], 140) : null };
}

function onSubAgent(s, item, at) {
  const id = idOf(item.agent_thread_id);
  const agentPath = str(item.agent_path);
  if (id && agentPath) s.paths.set(agentPath, id);
  if (item.kind !== 'completed' || !(id || agentPath)) return;
  addLink(s, { at, dir: 'up', id, path: agentPath, label: null });
  if (id && at !== null) s.completed.set(id, at);
}

// A message to an ancestor (usually "/root", or the parent's thread id) is a report up;
// anything else goes down.
function messageLink(own, parentId, target, at) {
  if (UUID.test(target)) {
    const id = target.toLowerCase();
    return { at, dir: id === parentId ? 'up' : 'down', id, path: null, label: null };
  }
  const full = fullAgentPath(own, target);
  const up = own !== null && own.startsWith(`${full}/`);
  return { at, dir: up ? 'up' : 'down', id: null, path: full, label: null };
}

function addLink(s, link) {
  s.links.push(link);
  if (s.links.length > MAX_LINKS) s.links.shift();
  return link;
}

function touch(s, at) {
  if (at === null) return;
  if (s.lastAt === null || at > s.lastAt) s.lastAt = at;
  if (s.firstAt === null || at < s.firstAt) s.firstAt = at;
}

function isInherited(meta, rec) {
  const start = meta?.subagent_history_start_ordinal;
  return typeof start === 'number' && typeof rec.ordinal === 'number' && rec.ordinal < start;
}

// ---- snapshot helpers ----

function contextOf(list) {
  const byId = new Map(list.map((thread) => [thread.id, thread]));
  const trees = new Map(list.map((thread) => [thread.id, treeOf(thread, byId)]));
  const ids = new Map(); // tree id + agent path -> thread id
  const done = new Map(); // child thread id -> newest completion time
  for (const thread of list) {
    const own = agentPathOf(thread.meta);
    if (own) ids.set(pathKey(trees.get(thread.id), own), thread.id);
  }
  for (const thread of list) {
    const tree = trees.get(thread.id);
    for (const [agentPath, id] of thread.state.paths) {
      const key = pathKey(tree, agentPath);
      if (!ids.has(key)) ids.set(key, id);
    }
    for (const [id, at] of thread.state.completed) {
      if (!(done.get(id) >= at)) done.set(id, at);
    }
  }
  return { trees, ids, done, byId };
}

// ---- coordinator registry ----

const EMPTY_REGISTRY = Object.freeze({ workers: new Map(), coordinators: new Set(), superintendent: null, imported: new Set() });

// Codex coordinators record the workers they start in coordinators/registry.sqlite3 (one JSON record
// per row), and the suite superintendent in coordinators/superintendent.json. Opened read-only and
// closed again at once; any problem means "no registry".
export function readRegistry(root) {
  const dir = path.join(root, 'coordinators');
  const out = {
    workers: new Map(),
    coordinators: new Set(),
    superintendent: idOf(readJsonFile(path.join(dir, 'superintendent.json'))?.threadId),
    imported: importedThreads(root),
  };
  const file = path.join(dir, 'registry.sqlite3');
  if (!sqlite || !isFile(file)) return out;
  let db = null;
  try {
    db = new sqlite.DatabaseSync(file, { readOnly: true });
    // Each project has one current coordinator; replaced ones are marked "retired". A worker hangs
    // under the current coordinator of its project, which is the Sergeant of the repo it works in,
    // even when an older coordinator thread started it.
    const current = new Map(); // project id -> { id, at }
    for (const record of records(db, 'coordinators')) {
      const id = idOf(record.threadId);
      if (!id || record.state === 'retired') continue;
      out.coordinators.add(id);
      const project = typeof record.projectId === 'string' ? record.projectId : null;
      const at = Date.parse(record.updatedAt ?? record.createdAt ?? '') || 0;
      if (project && !(current.get(project)?.at > at)) current.set(project, { id, at });
    }
    for (const record of records(db, 'worker_tasks')) {
      const id = idOf(record.threadId);
      const project = typeof record.projectId === 'string' ? current.get(record.projectId)?.id : null;
      const boss = project ?? idOf(record.coordinatorThreadId);
      if (id && boss && id !== boss) out.workers.set(id, boss);
    }
  } catch {
    return { ...EMPTY_REGISTRY, superintendent: out.superintendent, imported: out.imported };
  } finally {
    try {
      db?.close();
    } catch {
      // Already closed.
    }
  }
  return out;
}

// Threads Codex made by importing another tool's sessions (external_agent_session_imports.json).
// They copy sessions Pleni already shows from that tool, so they are left out like archived ones.
function importedThreads(root) {
  const out = new Set();
  const raw = readJsonFile(path.join(root, 'external_agent_session_imports.json'));
  const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? Object.values(raw).flat() : [];
  for (const item of list) {
    const id = idOf(item?.imported_thread_id);
    if (id) out.add(id);
  }
  return out;
}

function records(db, table) {
  const out = [];
  for (const row of db.prepare(`SELECT record FROM ${table}`).all()) {
    try {
      const record = JSON.parse(String(row.record));
      if (record && typeof record === 'object') out.push(record);
    } catch {
      // A damaged row is skipped.
    }
  }
  return out;
}

function isFile(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

// Agent paths such as "/root/scout" are only unique inside one tree of threads.
function treeOf(thread, byId) {
  const session = idOf(thread.meta.session_id);
  if (session) return session;
  let current = thread;
  for (let hops = 0; hops < 20; hops++) {
    const parent = parentIdOf(current.meta);
    if (!parent) return current.id;
    if (!byId.has(parent)) return parent;
    current = byId.get(parent);
  }
  return current.id;
}

function linksOf(thread, ctx, snippets) {
  const tree = ctx.trees.get(thread.id);
  const links = [];
  for (const link of thread.state.links) {
    const other = otherOf(link, tree, ctx);
    if (!other || link.at === null) continue;
    links.push({ at: link.at, dir: link.dir, other, label: snippets ? link.label : null });
  }
  return links;
}

function otherOf(link, tree, ctx) {
  if (link.id) return `codex:${link.id}`;
  if (!link.path) return null;
  const id = ctx.ids.get(pathKey(tree, link.path));
  return id ? `codex:${id}` : `path:${link.path}`;
}

function statusOf(s, doneAt, t, w) {
  // The parent's "completed" counts only if it is newer than the sub-agent's latest turn.
  const finished = doneAt !== undefined && (s.turnStartedAt === null || doneAt >= s.turnStartedAt);
  if (s.turnOpen && !finished) {
    return s.lastAt !== null && t - s.lastAt <= w.staleMinutes * MINUTE ? 'working' : 'idle';
  }
  if (s.lastError) return 'error';
  if (finished) return 'done';
  if (s.closedAt !== null && t - s.closedAt <= w.activeMinutes * MINUTE) return 'ready';
  return 'idle';
}

// A turn held open by an unanswered request for the person's input. The async form returns at once,
// so only the waiting form counts. It stays until answered, however long that takes.
function needsOf(s) {
  if (!s.turnOpen) return null;
  for (const call of s.pending.values()) {
    if (call.tool === 'request_user_input') return { kind: 'input', at: call.at ?? s.lastAt };
  }
  return null;
}

function isReviewer(meta, s) {
  return meta.source?.subagent?.other === 'guardian' || s.model === 'codex-auto-review';
}

function parentIdOf(meta) {
  return idOf(meta?.parent_thread_id) ?? idOf(meta?.source?.subagent?.thread_spawn?.parent_thread_id);
}

function agentPathOf(meta) {
  const own = str(meta?.agent_path) ?? str(meta?.source?.subagent?.thread_spawn?.agent_path);
  if (own) return own;
  return parentIdOf(meta) ? null : ROOT_AGENT;
}

function fullAgentPath(own, name) {
  if (name.startsWith('/') || !own) return name;
  return `${own}/${name}`;
}

function pathKey(tree, agentPath) {
  return `${tree}\n${agentPath}`;
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

function eventsOf(records, meta, snippets) {
  const tools = new Map(); // call_id -> tool name
  const events = [];
  const push = (at, kind, tool, text) => {
    events.push({ at, kind, tool, text: snippets && text ? clip(text, 2000) : null });
  };
  for (const rec of records) {
    if (isInherited(meta, rec)) continue;
    const p = isObject(rec.payload) ? rec.payload : {};
    const at = time(rec.timestamp);
    if (rec.type === 'response_item') {
      if (p.type === 'message') {
        const text = messageText(p.content).trim();
        if (p.role === 'assistant') push(at, 'assistant', null, text);
        else if (p.role === 'user' && !INJECTED.test(text)) push(at, 'user', null, text);
      } else if (p.type === 'reasoning') {
        push(at, 'thinking', null, null);
      } else if (CALLS.has(p.type)) {
        const name = str(p.name) ?? 'tool';
        if (str(p.call_id)) tools.set(p.call_id, name);
        push(at, 'tool', name, toolDetail(p.type === 'function_call' ? parseObject(p.arguments) : null, p.input));
      } else if (OUTPUTS.has(p.type)) {
        push(at, 'result', tools.get(p.call_id) ?? str(p.name), outputText(p.output).trim());
      }
    } else if (rec.type === 'event_msg') {
      if (p.type === 'task_complete' && p.error) push(at, 'error', null, errorText(p.error));
      else if (p.type === 'turn_aborted') push(at, 'error', null, str(p.reason) ? `Stopped: ${p.reason}` : 'Stopped');
    }
  }
  return events;
}

function cursorOf(since) {
  if (typeof since === 'number' && Number.isSafeInteger(since) && since >= 0) return since;
  if (typeof since === 'string' && /^\d{1,15}$/.test(since)) return Number(since);
  return null;
}

function errorText(error) {
  if (typeof error === 'string') return error;
  return str(error?.message) ?? 'The turn ended with an error.';
}

// ---- text helpers ----

// Short words about what a tool call does (<=140 chars), from its arguments or free-form input.
function toolDetail(args, input) {
  let text = null;
  if (args) text = argsDetail(args);
  else if (typeof input === 'string') {
    const patched = PATCH_FILE.exec(input);
    text = patched ? baseName(patched[1].trim()) : firstLine(input, 80);
  }
  return text ? clip(text, 140) : null;
}

function argsDetail(a) {
  const description = str(a.description);
  if (description) return firstLine(description, 80);
  const command = commandText(a.cmd ?? a.command);
  if (command) return firstLine(command, 80);
  const file = str(a.file_path) ?? str(a.path);
  if (file) return baseName(file);
  const pattern = str(a.pattern) ?? str(a.query);
  if (pattern) return pattern;
  const agent = str(a.task_name) ?? str(a.target);
  if (agent) return agent;
  const url = str(a.url);
  return url ? hostOf(url) : null;
}

function commandText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.filter((part) => typeof part === 'string').join(' ');
  return null;
}

function messageText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => isObject(part) && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n');
}

function outputText(output) {
  if (typeof output === 'string') return output;
  return messageText(output);
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
  return THREAD_ID.test(id) ? id : null;
}

function str(value) {
  return typeof value === 'string' && value.trim() ? value : null;
}

function time(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function parseObject(text) {
  if (typeof text !== 'string') return null;
  try {
    const value = JSON.parse(text);
    return isObject(value) ? value : null;
  } catch {
    return null;
  }
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
