// Kimi Code sessions and their helper agents, read from the folders Kimi Code keeps in its home
// folder: <root>/sessions/wd_<folder>_<hash>/session_<id>/ holds state.json (title, working
// folder, times, the session's agents) and one event log per agent, agents/<agent id>/wire.jsonl.
// Read-only: the logs are tailed incrementally and nothing is ever written.
import fs from 'node:fs';
import path from 'node:path';
import { JsonlTail, readHeadLine, readJsonFile, scanHead, stripBom } from '../jsonl.js';

const MiB = 1024 * 1024;
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const SCAN_MS = 30 * SECOND;
const MAX_SESSIONS = 300;
const MAX_HELPERS = 50; // helper logs followed per session, newest first
const MAX_FILES = 600; // logs followed in all
const MAX_LINKS = 50;
const MAX_KEPT = 200; // per log: open tool calls, requests, helper calls and background tasks
const MAX_RUNS = 50; // per log: when it was given work, and when its turns ended
const MAX_EVENTS = 200;
const TAIL_BYTES = 4 * MiB;
const CATCH_UP_BYTES = 16 * MiB; // more unread bytes than this: start again near the end
const HEAD_BYTES = 64 * 1024; // every log starts with a short metadata line
const HEAD_SCAN_BYTES = 4 * MiB;
const CALL_SCAN_BYTES = 16 * MiB; // looked through for helper calls before the part of a big log that is read
const DETAIL_BYTES = 2 * MiB;
const NEWLINE = 0x0a;
// Bytes a line must hold to be worth parsing when looking for helper calls: an Agent or AgentSwarm
// call, a result that names a helper, a background task.
const CALL_HINTS = ['"Agent', 'agent_id', '"task.'].map((hint) => Buffer.from(hint));
const MATCH_MS = 10 * SECOND; // a helper starts within moments of the call that starts it
// Approval rules (or the client) answer some requests within milliseconds, before any person could
// see them. A request for approval still open after this long is waiting for the person.
const PERMISSION_GRACE_MS = 2000;
const MAIN = 'main';
const SESSION_DIR = /^session_([0-9a-f-]{8,64})$/i;
const AGENT_ID = /^[0-9a-z_-]{1,64}$/;
const LOOP = 'context.append_loop_event';
const HELPER_TOOLS = new Set(['Agent', 'AgentSwarm']);
const MODEL_TYPES = new Set(['llm.request', 'profile.bind', 'config.update']);
const QUESTION_TOOL = 'AskUserQuestion';
const PLAN_TOOL = 'ExitPlanMode';
// Records Kimi Code writes when a session is opened or its settings change, rather than because
// work happened. They do not move lastAt.
const SETUP = new Set([
  'metadata', 'config.update', 'profile.bind', 'runtime.set_binding', 'tools.set_active_tools', 'llm.tools_snapshot',
  'permission.set_mode', 'plugin.session_start', 'swarm_mode.enter', 'plan_mode.enter', 'plan_mode.exit', 'plan_mode.cancel',
]);
// How a turn ended: turn.ended gives a `reason`, agent.turn.ended an `outcome`.
const ENDINGS = { completed: 'completed', failed: 'failed', cancelled: 'cancelled', aborted: 'cancelled' };
// Logs of protocol 1.4 write no turn.ended: a step that ends like this ends the turn, unless more
// steps of the same turn follow. In 1.5 turn.ended comes next and has the last word.
const STEP_ENDINGS = { end_turn: 'completed', error: 'failed', interrupted: 'cancelled' };
const SAME_END_MS = 5 * SECOND;
// A helper call's result names its helpers: "agent_id: agent-3" heads an Agent result, and an
// AgentSwarm result has one <subagent agent_id="agent-3" …> per item.
const RESULT_AGENT = /^[ \t]*agent_id:[ \t]*([A-Za-z0-9_-]{1,64})[ \t]*\r?$/m;
const SWARM_AGENT = /<subagent\b[^>]*?\bagent_id="([A-Za-z0-9_-]{1,64})"/g;
const WINDOW = { activeMinutes: 10, recentHours: 24, staleMinutes: 30 };

export function createKimiSource({ root, settings, now = Date.now } = {}) {
  let sessions = new Map(); // folder key -> session
  let scannedAt = null;

  function poll() {
    const fail = (error) => ({ ok: false, error, root: root ?? null, sessions: [] });
    try {
      if (!root) return fail('No Kimi Code folder is set.');
      if (!isDirectory(root)) return fail('Pleni could not find the Kimi Code folder.');
      const t = now();
      const cutoff = t - windowOf(settings).recentHours * HOUR;
      const due = scannedAt === null || t - scannedAt >= SCAN_MS || t < scannedAt;
      if (due) {
        sessions = scan(root, sessions, cutoff);
        scannedAt = t;
      }
      for (const session of sessions.values()) follow(session, cutoff, !due);
      return { ok: true, error: null, root, sessions: sessionsAt(t) };
    } catch {
      return fail('Pleni could not read the Kimi Code sessions.');
    }
  }

  function sessionsAt(t) {
    const snippets = settings?.content !== 'none';
    const w = windowOf(settings);
    const out = [];
    for (const session of sessions.values()) out.push(...groupOf(session, t, w, snippets));
    return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }

  function detail(key, since) {
    const empty = { events: [], next: null };
    try {
      const agent = findAgent(key);
      if (!agent) return empty;
      const { records, next } = readFrom(agent.file, cursorOf(since));
      return { events: eventsOf(records, settings?.content !== 'none'), next };
    } catch {
      return empty;
    }
  }

  // kimi:<session id> is the session's main agent, kimi:<session id>/<agent id> one of its helpers.
  function findAgent(key) {
    if (typeof key !== 'string' || !key.startsWith('kimi:')) return null;
    const [id, agentId, extra] = key.slice('kimi:'.length).split('/');
    if (extra !== undefined || agentId === MAIN) return null;
    for (const session of sessions.values()) {
      if (session.id === id) return session.agents.get(agentId ?? MAIN) ?? null;
    }
    return null;
  }

  return { poll, detail };
}

// ---- discovery ----

// Keeps the newest MAX_SESSIONS sessions whose state.json or main log changed since `cutoff`.
// Known sessions keep their read state.
function scan(root, previous, cutoff) {
  const found = [];
  const base = path.join(root, 'sessions');
  for (const folder of readDir(base)) {
    if (!folder.isDirectory() || folder.name.startsWith('.')) continue; // .index-cache is Kimi's own
    const parent = path.join(base, folder.name);
    for (const entry of readDir(parent)) {
      const match = entry.isDirectory() ? SESSION_DIR.exec(entry.name) : null;
      if (!match) continue;
      const dir = path.join(parent, entry.name);
      const mtimeMs = Math.max(mtimeOf(path.join(dir, 'state.json')) ?? -Infinity, mtimeOf(logFile(dir, MAIN)) ?? -Infinity);
      if (mtimeMs >= cutoff) found.push({ dir, id: match[1].toLowerCase(), mtimeMs });
    }
  }
  found.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.dir < b.dir ? -1 : 1));
  const next = new Map();
  const seen = new Set();
  let budget = MAX_FILES;
  for (const entry of found) {
    if (next.size >= MAX_SESSIONS || budget <= 0) break;
    if (seen.has(entry.id)) continue; // the same session in two folders: the newest copy wins
    seen.add(entry.id);
    const key = fileKey(entry.dir);
    const session = previous.get(key) ?? newSession(entry);
    session.helperLimit = Math.max(0, Math.min(MAX_HELPERS, budget - 1));
    loadState(session);
    listAgents(session, cutoff);
    budget -= Math.max(1, session.agents.size);
    next.set(key, session);
  }
  return next;
}

// Reads what is new in a session's logs. A session that moved may have started helpers since its
// folders were listed, so its agents and state.json are looked at again at once.
function follow(session, cutoff, relist) {
  let moved = false;
  for (const agent of session.agents.values()) if (refresh(agent)) moved = true;
  if (!moved || !relist) return;
  loadState(session);
  for (const agent of listAgents(session, cutoff)) refresh(agent);
}

// The agents of a session that have a log: the main agent always, and helpers whose log changed
// since `cutoff`, newest first, up to the session's share. Returns the ones that are new.
function listAgents(session, cutoff) {
  const found = [];
  for (const entry of readDir(path.join(session.dir, 'agents'))) {
    const id = entry.isDirectory() ? agentIdOf(entry.name) : null;
    if (!id) continue;
    const file = logFile(session.dir, entry.name);
    const mtimeMs = mtimeOf(file);
    if (mtimeMs === null || (id !== MAIN && mtimeMs < cutoff)) continue;
    found.push({ id, file, mtimeMs });
  }
  found.sort((a, b) => Number(b.id === MAIN) - Number(a.id === MAIN) || b.mtimeMs - a.mtimeMs || (a.id < b.id ? -1 : 1));
  const next = new Map();
  const added = [];
  for (const entry of found) {
    if (next.has(entry.id)) continue;
    if (entry.id !== MAIN && next.size - Number(next.has(MAIN)) >= session.helperLimit) break;
    let agent = session.agents.get(entry.id);
    if (!agent) added.push((agent = newAgent(entry)));
    next.set(entry.id, agent);
  }
  session.agents = next;
  return added;
}

function newSession({ dir, id }) {
  return { dir, id, helperLimit: MAX_HELPERS, stateMtime: undefined, info: pickState(null), agents: new Map() };
}

// state.json is rewritten as the session goes on, so it is read again only when its time changes.
// A file caught half-written is tried again later.
function loadState(session) {
  const file = path.join(session.dir, 'state.json');
  const mtimeMs = mtimeOf(file);
  if (mtimeMs === session.stateMtime) return;
  const raw = mtimeMs === null ? null : readJsonFile(file);
  if (mtimeMs !== null && !raw) return;
  session.stateMtime = mtimeMs;
  session.info = pickState(raw);
}

// Keeps only what Pleni uses, from either shape Kimi Code writes: an older one with ISO times and
// `workDir`, and a newer one with `id`, `version`, `cwd`, millisecond times and `archived`.
// `lastPrompt` (the person's own words) is never kept.
function pickState(raw) {
  const agents = new Map();
  for (const [name, value] of Object.entries(isObject(raw?.agents) ? raw.agents : {})) {
    const id = agentIdOf(name);
    if (!id || !isObject(value)) continue;
    const labels = isObject(value.labels) ? value.labels : {};
    agents.set(id, {
      parent: agentIdOf(value.parentAgentId) ?? agentIdOf(labels.parentAgentId),
      swarmItem: firstLine(labels.swarmItem, 120), // the work an AgentSwarm call gave this helper
    });
  }
  return {
    title: flat(raw?.title, 120),
    customTitle: raw?.isCustomTitle === true,
    cwd: str(raw?.cwd) ?? str(raw?.workDir),
    createdAt: time(raw?.createdAt),
    archived: raw?.archived === true,
    agents,
  };
}

function newAgent({ id, file }) {
  return {
    id,
    file,
    createdAt: null, // from the metadata line that starts the log
    headDone: false,
    size: -1,
    mtimeMs: -1,
    started: false,
    partial: false, // the first read began in the middle of the log
    scanned: false, // the part before it was looked through for helper calls
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
    closedTurnId: null,
    closedAt: null,
    ending: null, // how the last turn ended: 'completed' | 'failed' | 'cancelled'
    softEnd: false, // the last turn was ended by its last step or a cancel, not by turn.ended
    pending: new Map(), // tool call id -> { tool, detail, at }, oldest first
    asks: new Map(), // request id -> { kind, tool, text, detail, at }, waiting for the person
    lastText: null,
    textKey: null, // the step the newest text belongs to
    textParts: [],
    turnText: null, // the newest text of the open turn: the report when it ends
    runs: [], // when this agent was given work by the agent above it
    ends: [], // { at, text } for each turn that ended
    calls: [], // helper calls: { id, at, tool, description, resume, background, helpers, doneAt }
    taskNames: new Map(), // helper agent id -> description of the background task it runs as
    taskEnds: new Map(), // helper agent id -> when that background task ended
  };
}

// ---- reading ----

// Returns true when new lines were read.
function refresh(agent) {
  try {
    const st = fs.statSync(agent.file);
    if (st.size === agent.size && st.mtimeMs === agent.mtimeMs) return false;
    if (!agent.headDone) readHead(agent, st.size);
    if (agent.started && st.size - agent.tail.offset > CATCH_UP_BYTES) restart(agent);
    const out = agent.tail.read();
    const fresh = out.reset || !agent.started;
    if (fresh) {
      if (out.reset) {
        agent.state = newState();
        agent.headDone = false;
        agent.scanned = false;
        readHead(agent, out.size);
      }
      agent.started = true;
      agent.partial = out.size > TAIL_BYTES;
      if (agent.partial && !agent.scanned) scanCalls(agent, out.size - TAIL_BYTES);
    }
    for (const rec of out.records) apply(agent.state, rec);
    if (fresh && agent.partial && !agent.state.model) guessModel(agent);
    agent.size = st.size;
    agent.mtimeMs = st.mtimeMs;
    return true;
  } catch {
    // One unreadable log must not hide the others; try again on the next poll.
    return false;
  }
}

// The metadata line says when the agent was created. Until its newline arrives it is tried again.
function readHead(agent, size) {
  const head = readHeadLine(agent.file, HEAD_BYTES);
  if (!head && size <= HEAD_BYTES) return;
  agent.headDone = true;
  if (head?.type === 'metadata') agent.createdAt = time(head.created_at);
}

// Polls stop while nobody has the page open, and a busy log can grow by hundreds of megabytes
// meanwhile. Rather than parse all of that in one go, start again near the end, as on the first
// read, keeping the facts that stay true. Turns are learned again from what is read.
function restart(agent) {
  const old = agent.state;
  agent.state = {
    ...newState(),
    firstAt: old.firstAt,
    lastAt: old.lastAt,
    model: old.model,
    effort: old.effort,
    cwd: old.cwd,
    runs: old.runs,
    ends: old.ends,
    calls: old.calls,
    taskNames: old.taskNames,
    taskEnds: old.taskEnds,
  };
  agent.tail = new JsonlTail(agent.file, { maxInitialBytes: TAIL_BYTES });
  agent.started = false;
  agent.scanned = false; // the gap may hold helper calls
}

// In a big log the latest model request can lie before the part that was read; the newest one near
// the start is the best guess there is.
function guessModel(agent) {
  for (const rec of scanHead(agent.file, HEAD_SCAN_BYTES, (r) => MODEL_TYPES.has(r.type))) onModel(agent.state, rec);
}

function apply(s, rec) {
  const at = time(rec.time);
  if (!SETUP.has(rec.type)) touch(s, at);
  switch (rec.type) {
    case 'llm.request':
    case 'profile.bind':
    case 'config.update':
      onModel(s, rec);
      return;
    case 'turn.prompt':
    case 'turn.steer':
      onPrompt(s, rec, at);
      return;
    case 'prompt.aborted':
      // A prompt taken back before its turn began.
      if (s.turnOpen && s.turnId === null) s.turnOpen = false;
      return;
    case 'agent.turn.started':
      if (!s.turnOpen) openTurn(s, null, at);
      return;
    case 'turn.cancel':
      if (s.turnOpen) closeTurn(s, turnKey(rec.turnId), at, 'cancelled', true);
      return;
    case 'turn.ended':
      closeTurn(s, turnKey(rec.turnId), at, ENDINGS[rec.reason] ?? 'completed');
      return;
    case 'agent.turn.ended':
      // Its turn id is not always the one the turn's steps carry; turn.ended follows with that one.
      closeTurn(s, null, at, ENDINGS[rec.outcome] ?? 'completed');
      return;
    case LOOP:
      onLoop(s, rec.event, at);
      return;
    case 'agent.message.appended':
      onMessage(s, rec.message);
      return;
    case 'interaction.request':
      onAsk(s, rec, at);
      return;
    case 'interaction.resolved':
      if (typeof rec.id === 'string') s.asks.delete(rec.id);
      return;
    case 'task.started':
    case 'task.terminated':
      onTask(s, rec, at);
      return;
  }
}

// The model and effort of the newest request, or of the profile or setting chosen after it. A
// profile names the model with its provider ("kimi-code/k3"); requests name it alone ("k3").
function onModel(s, rec) {
  if (rec.type === 'llm.request') {
    if (rec.kind === 'compaction') return; // a summary request, maybe with another model
    if (str(rec.model)) s.model = rec.model.trim();
  } else {
    const alias = str(rec.modelAlias)?.trim();
    if (alias) s.model = alias.slice(alias.lastIndexOf('/') + 1) || alias;
    const disclosure = isObject(rec.environmentDisclosure) ? rec.environmentDisclosure : {};
    const cwd = str(disclosure.cwd) ?? str(rec.cwd);
    if (cwd) s.cwd = cwd;
  }
  const effort = str(rec.thinkingEffort);
  if (effort) s.effort = effort.trim();
}

// turn.prompt, and turn.steer (more input for a running turn).
function onPrompt(s, rec, at) {
  const origin = isObject(rec.origin) ? rec.origin : {};
  // The agent above a helper gives it work as a prompt from the system.
  if (rec.type === 'turn.prompt' && origin.kind === 'system_trigger' && origin.name === 'subagent' && at !== null) {
    keepTime(s.runs, at);
  }
  // Input that arrives while a turn runs waits for it or joins it; otherwise it starts a turn.
  if (!s.turnOpen) openTurn(s, turnKey(rec.turnId), at);
}

function openTurn(s, turnId, at) {
  s.turnOpen = true;
  s.turnId = turnId;
  s.turnStartedAt = at;
  s.softEnd = false;
  s.pending.clear();
  s.asks.clear();
  s.turnText = null;
}

// Records that name their turn. One newer than the open turn, or than the last one that ended,
// means a new turn began even when its start was not seen (a read that began mid-log). A new step
// of a turn that seemed to end with its last step means the turn went on.
function enterTurn(s, turnId, at, step = false) {
  if (turnId === null) return;
  if (s.turnOpen) {
    if (s.turnId === null) s.turnId = turnId;
    else if (isLater(turnId, s.turnId)) openTurn(s, turnId, at);
  } else if (s.closedTurnId === null || isLater(turnId, s.closedTurnId)) {
    openTurn(s, turnId, at);
  } else if (step && s.softEnd && turnId === s.closedTurnId) {
    s.turnOpen = true;
    s.turnId = turnId;
    s.softEnd = false;
    if (s.ends.at(-1)?.at === s.closedAt) s.ends.pop();
  }
}

// `soft`: ended by its last step or by a cancel, which turn.ended may still follow.
function closeTurn(s, turnId, at, ending, soft = false) {
  // The end of a turn that already ended (an end_turn step, then turn.ended; or agent.turn.ended,
  // then turn.ended), perhaps after the next prompt came in: it only says how that turn ended.
  if (s.closedAt !== null && isSameEnd(s, turnId, at)) {
    if (s.closedTurnId === null) s.closedTurnId = turnId;
    if (!soft && turnId !== null) {
      s.ending = ending;
      s.softEnd = false;
    }
    return;
  }
  // A late end for an older turn does not end the one that is running now.
  if (s.turnOpen && turnId !== null && s.turnId !== null && isLater(s.turnId, turnId)) return;
  s.closedTurnId = turnId ?? s.turnId;
  s.turnOpen = false;
  s.turnId = null;
  s.softEnd = soft;
  if (at !== null) s.closedAt = at;
  s.ending = ending;
  s.pending.clear();
  s.asks.clear();
  if (at !== null) keepRun(s.ends, { at, text: s.turnText });
}

function isSameEnd(s, turnId, at) {
  if (turnId !== null && s.closedTurnId !== null) {
    return turnId === s.closedTurnId && !(s.turnOpen && s.turnId === turnId);
  }
  return !s.turnOpen && at !== null && at - s.closedAt <= SAME_END_MS;
}

function onLoop(s, e, at) {
  if (!isObject(e)) return;
  const turnId = turnKey(e.turnId);
  enterTurn(s, turnId, at, e.type === 'step.begin');
  if (e.type === 'content.part') {
    if (isObject(e.part) && e.part.type === 'text') addText(s, e.part.text, str(e.stepUuid) ?? `${e.turnId}/${e.step}`);
  } else if (e.type === 'tool.call') {
    onCall(s, e, at);
  } else if (e.type === 'tool.result') {
    onResult(s, e, at);
  } else if (e.type === 'step.end' && STEP_ENDINGS[e.finishReason] && s.turnOpen) {
    closeTurn(s, turnId, at, STEP_ENDINGS[e.finishReason], true);
  }
}

// Text parts of one step are one reply.
function addText(s, text, key) {
  const value = flat(text, 280);
  if (!value) return;
  if (key === null || key !== s.textKey) s.textParts = [];
  s.textKey = key;
  if (s.textParts.length < 4) s.textParts.push(value);
  s.lastText = clip(s.textParts.join(' '), 280);
  s.turnText = s.lastText;
}

// The description Kimi Code writes beside each call holds full paths, so only the arguments are used.
function onCall(s, e, at) {
  const id = str(e.toolCallId);
  const args = isObject(e.args) ? e.args : {};
  if (id) remember(s.pending, id, { tool: str(e.name) ?? 'tool', detail: toolDetail(args), at });
  addCall(s, e, at);
}

function onResult(s, e, at) {
  const id = str(e.toolCallId);
  if (!id) return;
  s.pending.delete(id);
  settleCall(s, e, at);
}

// An Agent or AgentSwarm call: it starts helpers, or gives one more work.
function addCall(s, e, at) {
  const name = str(e.name);
  if (!HELPER_TOOLS.has(name) || at === null) return;
  const id = str(e.toolCallId);
  if (id && s.calls.some((c) => c.id === id)) return; // read again after starting near the end
  const args = isObject(e.args) ? e.args : {};
  s.calls.push({
    id,
    at,
    tool: name,
    description: flat(args.description, 140),
    resume: agentIdOf(args.resume), // gives an existing helper more work
    background: args.run_in_background === true,
    helpers: null, // the helpers its result names, once it arrives
    doneAt: null,
  });
  if (s.calls.length > MAX_KEPT) s.calls.shift();
}

function settleCall(s, e, at) {
  const id = str(e.toolCallId);
  const call = id ? s.calls.findLast((c) => c.id === id) : null;
  if (!call || call.helpers) return;
  const result = isObject(e.result) ? e.result : {};
  call.helpers = helpersIn(outputText(result.output));
  // A background helper's call answers at once; the end of its task is its report.
  if (!call.background) call.doneAt = at;
}

// When a big log is first read from near its end, the calls that started its helpers may lie before
// that part. They are picked out of the CALL_SCAN_BYTES before it, once, so that those helpers keep
// their names and the time their parent heard back. Only lines that can hold such a call are parsed.
function scanCalls(agent, end) {
  agent.scanned = true;
  const from = Math.max(0, end - CALL_SCAN_BYTES);
  if (end <= from) return;
  let fd;
  try {
    fd = fs.openSync(agent.file, 'r');
    // One byte more in front tells whether the first line is whole.
    const data = readRange(fd, from === 0 ? 0 : from - 1, from === 0 ? end : end - from + 1);
    let pos = 0;
    if (from > 0) {
      const first = data.indexOf(NEWLINE);
      if (first === -1) return;
      pos = first + 1;
    }
    let nl;
    while ((nl = data.indexOf(NEWLINE, pos)) !== -1) {
      const line = data.subarray(pos, nl);
      pos = nl + 1;
      if (!CALL_HINTS.some((hint) => line.includes(hint))) continue;
      const rec = parseLine(line);
      if (rec) applyHistory(agent.state, rec);
    }
  } catch {
    // The names are a bonus; the rest of the log is read without them.
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// From the part of a log before the part that was read, only what names helpers is taken.
function applyHistory(s, rec) {
  const at = time(rec.time);
  if (rec.type === LOOP && isObject(rec.event)) {
    if (rec.event.type === 'tool.call') addCall(s, rec.event, at);
    else if (rec.event.type === 'tool.result') settleCall(s, rec.event, at);
  } else if (rec.type === 'task.started' || rec.type === 'task.terminated') {
    onTask(s, rec, at);
  }
}

// agent.message.appended holds whole messages: history Kimi Code copies into a session, and what is
// kept of a reply that was interrupted. Only the text of replies is used here.
function onMessage(s, wrapper) {
  const msg = isObject(wrapper) && isObject(wrapper.message) ? wrapper.message : null;
  if (msg?.role !== 'assistant') return;
  const text = blocks(msg.content)
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n');
  addText(s, text, null);
}

// The person is asked to approve a tool, to answer a question, or to accept a plan (an approval of
// ExitPlanMode). interaction.resolved, or the end of the turn, settles it.
function onAsk(s, rec, at) {
  const id = str(rec.id);
  if (!id) return;
  const req = isObject(rec.request) ? rec.request : {};
  const turnId = turnKey(req.turnId);
  enterTurn(s, turnId, at);
  if (!s.turnOpen && turnId === null) openTurn(s, null, at);
  if (!s.turnOpen) return;
  const display = isObject(req.display) ? req.display : {};
  let kind = 'permission';
  if (rec.kind === 'question') kind = 'question';
  else if (req.toolName === PLAN_TOOL || display.kind === 'plan_review') kind = 'plan';
  const question = blocks(req.questions).find((q) => str(q.question));
  remember(s.asks, id, {
    kind,
    tool: str(req.toolName) ?? (kind === 'question' ? QUESTION_TOOL : null),
    text: kind === 'question' ? flat(question?.question, 280) : flat(req.action, 280),
    detail: toolDetail({ command: display.command, path: display.path }),
    at,
  });
}

// A helper started with run_in_background runs as a task of the agent that started it.
function onTask(s, rec, at) {
  const info = isObject(rec.info) ? rec.info : null;
  if (info?.kind !== 'agent') return;
  const id = agentIdOf(info.agentId);
  if (!id) return;
  const description = flat(info.description, 140);
  if (description) remember(s.taskNames, id, description);
  if (rec.type === 'task.terminated' && at !== null) remember(s.taskEnds, id, at);
}

function helpersIn(text) {
  const ids = new Set();
  const named = agentIdOf(RESULT_AGENT.exec(text.slice(0, 4096))?.[1]);
  if (named) ids.add(named);
  for (const match of text.matchAll(SWARM_AGENT)) {
    const id = agentIdOf(match[1]);
    if (id) ids.add(id);
  }
  return [...ids];
}

function touch(s, at) {
  if (at === null) return;
  if (s.lastAt === null || at > s.lastAt) s.lastAt = at;
  if (s.firstAt === null || at < s.firstAt) s.firstAt = at;
}

// ---- building sessions ----

// One session's agents as Pleni sessions: the main agent and the helpers below it, with the
// hand-offs between them. An agent in whose log nothing has happened yet is left out.
function groupOf(session, t, w, snippets) {
  const keyOf = (id) => (id === MAIN ? `kimi:${session.id}` : `kimi:${session.id}/${id}`);
  const views = new Map();
  for (const agent of session.agents.values()) {
    if (agent.state.lastAt !== null) views.set(agent.id, { agent, key: keyOf(agent.id), parent: null, links: [], description: null, doneAt: null });
  }
  if (!views.size) return [];
  for (const view of views.values()) view.parent = parentOf(session, view.agent.id, views);
  linkHelpers(session, views, snippets);
  const list = [...views.values()].map((view) => [view, toSession(session, view, keyOf, t, w, snippets)]);
  rollUpWorking(list.map(([, x]) => x));
  for (const [view, x] of list) {
    if (x.status === 'working') x.activity = activityOf(view.agent.state, snippets, t);
  }
  return list.map(([, x]) => x);
}

// A helper's parent is the agent state.json names, when that agent is shown; else the main agent.
function parentOf(session, id, views) {
  if (id === MAIN) return null;
  const parent = session.info.agents.get(id)?.parent;
  return parent && parent !== id && views.has(parent) ? parent : MAIN;
}

// A helper's own log shows when it was given work (a prompt from the system) and when each of its
// turns ended. Its parent's log says why: the Agent or AgentSwarm call that started it, whose result
// names it, or the background task it runs as. Links are kept by the parent, like Claude Code's.
function linkHelpers(session, views, snippets) {
  const byParent = new Map();
  for (const view of views.values()) {
    if (view.parent === null) continue;
    if (!byParent.has(view.parent)) byParent.set(view.parent, []);
    byParent.get(view.parent).push(view);
  }
  const label = (text) => (snippets && text ? clip(text, 140) : null);
  for (const [parentId, kids] of byParent) {
    const ps = session.agents.get(parentId)?.state ?? newState();
    const runs = [];
    for (const kid of kids) {
      const s = kid.agent.state;
      // A helper whose first prompt lies before the part that was read started when its log did.
      const times = s.runs.length ? s.runs : [kid.agent.createdAt ?? s.firstAt];
      for (const at of times) if (Number.isFinite(at)) runs.push({ kid, at });
    }
    const matched = matchRuns(ps.calls, runs);
    for (const kid of kids) {
      const id = kid.agent.id;
      const first = runs.find((run) => run.kid === kid);
      kid.description = (first && matched.get(first)?.description)
        ?? ps.calls.findLast((c) => c.description && (c.resume === id || c.helpers?.includes(id)))?.description
        ?? ps.taskNames.get(id)
        ?? null;
      let doneAt = ps.taskEnds.get(id) ?? null;
      for (const c of ps.calls) {
        if (c.doneAt !== null && c.helpers?.includes(id) && !(doneAt >= c.doneAt)) doneAt = c.doneAt;
      }
      kid.doneAt = doneAt;
    }
    const owner = views.get(parentId) ?? views.get(MAIN);
    if (!owner) continue;
    for (const run of runs) {
      owner.links.push({ at: run.at, dir: 'down', other: run.kid.key, label: label(matched.get(run)?.description ?? run.kid.description) });
    }
    for (const kid of kids) {
      for (const end of kid.agent.state.ends) owner.links.push({ at: end.at, dir: 'up', other: kid.key, label: label(end.text) });
    }
  }
}

// Which call started each helper run. Once a call's result is in, it names its helpers. Until then
// a run that begins within moments of a call is taken to be that call's, earliest call first; an
// Agent call starts one run, an AgentSwarm call several.
function matchRuns(calls, runs) {
  runs.sort((a, b) => a.at - b.at || (a.kid.key < b.kid.key ? -1 : a.kid.key > b.kid.key ? 1 : 0));
  const ordered = [...calls].sort((a, b) => a.at - b.at);
  const used = new Set();
  const matched = new Map();
  let low = 0;
  for (const run of runs) {
    while (low < ordered.length && ordered[low].at < run.at - MATCH_MS) low++;
    const id = run.kid.agent.id;
    for (let i = low; i < ordered.length && ordered[i].at <= run.at + SECOND; i++) {
      const call = ordered[i];
      const fits = call.resume ? call.resume === id : call.helpers ? call.helpers.includes(id) : call.tool !== 'Agent' || !used.has(call);
      if (!fits) continue;
      used.add(call);
      matched.set(run, call);
      break;
    }
  }
  return matched;
}

function toSession(session, view, keyOf, t, w, snippets) {
  const { agent, key } = view;
  const { info } = session;
  const s = agent.state;
  const helper = agent.id !== MAIN;
  const title = helper ? helperTitle(info, agent.id, view.description, snippets) : mainTitle(info, snippets);
  const mainCwd = session.agents.get(MAIN)?.state.cwd ?? null;
  return {
    platform: 'kimi',
    key,
    id: helper ? agent.id : session.id,
    parentKey: helper ? keyOf(view.parent) : null,
    kind: helper ? 'agent' : 'session',
    spawned: helper, // started by the agent above it; chain rules leave it there
    role: null,
    title: title.text,
    titleSource: title.source,
    cwd: normalizePath(helper ? s.cwd ?? info.cwd ?? mainCwd : info.cwd ?? s.cwd),
    branch: null,
    entrypoint: null,
    model: s.model,
    effort: s.effort,
    startedAt: agent.createdAt ?? (helper ? null : info.createdAt) ?? s.firstAt,
    lastAt: s.lastAt,
    status: statusOf(s, helper ? view.doneAt : undefined, t, w),
    activity: null, // set once the status of the whole group is known
    lastText: snippets ? s.lastText : null,
    needs: info.archived ? null : needsOf(s, snippets, t),
    links: view.links.sort((a, b) => a.at - b.at).slice(-MAX_LINKS),
    archived: info.archived,
  };
}

// The person's own name for a session always shows. Otherwise Kimi Code names a session after the
// start of its first prompt, the person's own words, so that name shows only with snippets.
function mainTitle(info, snippets) {
  if (!info.title) return { text: null, source: null };
  if (info.customTitle) return { text: info.title, source: 'custom-title' };
  return snippets ? { text: info.title, source: 'first-prompt' } : { text: null, source: null };
}

// A helper is named by the description of the call that started it, like a Claude Code helper.
// AgentSwarm helpers share one call, so with snippets each is named by its own item of work.
function helperTitle(info, id, description, snippets) {
  const item = info.agents.get(id)?.swarmItem ?? null;
  if (snippets && item) return { text: item, source: 'swarm-item' };
  if (description) return { text: clip(description, 120), source: 'description' };
  return { text: null, source: null };
}

function statusOf(s, doneAt, t, w) {
  const helper = doneAt !== undefined;
  // The parent hearing back counts only if it is newer than the helper's latest turn.
  const finished = helper && doneAt !== null && (s.turnStartedAt === null || doneAt >= s.turnStartedAt);
  if (s.turnOpen && !finished) {
    return s.lastAt !== null && t - s.lastAt <= w.staleMinutes * MINUTE ? 'working' : 'idle';
  }
  if (!s.turnOpen && s.ending === 'failed') return 'error';
  if (helper && (finished || s.closedAt !== null)) return 'done';
  if (s.closedAt !== null && t - s.closedAt <= w.activeMinutes * MINUTE) return 'ready';
  return 'idle';
}

// An agent whose helpers are still working is working too, even when its own turn ended or went
// quiet: it writes nothing while a long Agent call runs, or while background helpers do the work.
// Only "ready" and "idle" are lifted, so an error or a finished helper still shows as it is.
function rollUpWorking(list) {
  const byKey = new Map(list.map((x) => [x.key, x]));
  for (const x of list) {
    if (x.status !== 'working') continue;
    const seen = new Set([x.key]);
    let parent = x.parentKey ? byKey.get(x.parentKey) : null;
    while (parent && !seen.has(parent.key) && (parent.status === 'ready' || parent.status === 'idle')) {
      seen.add(parent.key);
      parent.status = 'working';
      parent = parent.parentKey ? byKey.get(parent.parentKey) : null;
    }
  }
}

// The newest open tool call, else the tool waiting for the person's approval.
function activityOf(s, snippets, t) {
  const call = lastOf(s.pending.values());
  if (call) return { tool: call.tool, detail: snippets ? call.detail : null, at: call.at ?? s.lastAt ?? t };
  const ask = lastOf(s.asks.values());
  if (ask?.tool) return { tool: ask.tool, detail: snippets ? ask.detail : null, at: ask.at ?? s.lastAt ?? t };
  return null;
}

// What the person must do before this agent can go on: approve a tool, answer a question or accept
// a plan. It stays until answered or the turn ends, however long that takes. A question or a plan
// counts at once; a request for approval only once it has waited PERMISSION_GRACE_MS.
function needsOf(s, snippets, t) {
  if (!s.turnOpen) return null;
  const asks = [...s.asks.values()];
  for (let i = asks.length - 1; i >= 0; i--) {
    const ask = asks[i];
    if (ask.kind === 'permission' && !(ask.at !== null && t - ask.at >= PERMISSION_GRACE_MS)) continue;
    return { kind: ask.kind, text: snippets ? ask.text : null, at: ask.at ?? s.lastAt };
  }
  for (const call of s.pending.values()) {
    if (call.tool === QUESTION_TOOL) return { kind: 'question', text: null, at: call.at ?? s.lastAt };
  }
  return null;
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

// The person's prompts (and the work a helper was given), replies, tool calls and their results,
// and turns that failed or were stopped. Thinking shows only as the fact that the model thought.
function eventsOf(records, snippets) {
  const tools = new Map(); // tool call id -> tool name
  let events = [];
  const push = (at, kind, tool, text) => {
    events.push({ at, kind, tool, text: snippets ? clipBlock(text, 2000) : null });
  };
  for (const rec of records) {
    const at = time(rec.time);
    if (at === null) continue;
    if (rec.type === 'turn.prompt' || rec.type === 'turn.steer') {
      if (isAsked(rec.origin)) push(at, 'user', null, inputText(rec.input));
    } else if (rec.type === LOOP && isObject(rec.event)) {
      loopEvents(rec.event, at, tools, push);
    } else if (rec.type === 'agent.message.appended') {
      messageEvents(rec.message, at, tools, push);
    } else if (rec.type === 'turn.ended' && rec.reason === 'failed') {
      push(at, 'error', null, errorText(rec.error));
    } else if (rec.type === 'turn.ended' && rec.reason === 'cancelled') {
      push(at, 'error', null, 'Stopped');
    }
    if (events.length > MAX_EVENTS * 4) events = events.slice(-MAX_EVENTS);
  }
  return events.slice(-MAX_EVENTS);
}

// Prompts the person typed, and the work a helper was handed. Automatic prompts (a goal going on,
// a background task reporting, instructions Kimi Code adds) are left out.
function isAsked(origin) {
  if (!isObject(origin)) return false;
  return origin.kind === 'user' || (origin.kind === 'system_trigger' && origin.name === 'subagent');
}

function loopEvents(e, at, tools, push) {
  if (e.type === 'content.part' && isObject(e.part)) {
    if (e.part.type === 'think') push(at, 'thinking', null, null);
    else if (e.part.type === 'text') push(at, 'assistant', null, e.part.text);
  } else if (e.type === 'tool.call') {
    const name = str(e.name) ?? 'tool';
    if (str(e.toolCallId)) tools.set(e.toolCallId, name);
    push(at, 'tool', name, toolDetail(e.args));
  } else if (e.type === 'tool.result') {
    const result = isObject(e.result) ? e.result : {};
    push(at, result.isError === true ? 'error' : 'result', tools.get(e.toolCallId) ?? null, outputText(result.output));
  }
}

function messageEvents(wrapper, at, tools, push) {
  const msg = isObject(wrapper) && isObject(wrapper.message) ? wrapper.message : null;
  if (msg?.role === 'assistant') {
    for (const part of blocks(msg.content)) {
      if (part.type === 'think') push(at, 'thinking', null, null);
      else if (part.type === 'text') push(at, 'assistant', null, part.text);
    }
    for (const call of blocks(msg.toolCalls)) {
      const name = str(call.name) ?? 'tool';
      if (str(call.id)) tools.set(call.id, name);
      push(at, 'tool', name, toolDetail(parseObject(call.arguments)));
    }
  } else if (msg?.role === 'tool') {
    push(at, 'result', tools.get(msg.toolCallId) ?? null, messageText(msg.content));
  }
}

function cursorOf(since) {
  if (typeof since === 'number' && Number.isSafeInteger(since) && since >= 0) return since;
  if (typeof since === 'string' && /^\d{1,15}$/.test(since)) return Number(since);
  return null;
}

function errorText(error) {
  if (typeof error === 'string' && error.trim()) return error;
  return str(isObject(error) ? error.message : null) ?? 'The turn ended with an error.';
}

// ---- text helpers ----

// Short words about what a tool call does (≤140 characters), from its arguments: a description,
// the first line of a command, a search pattern, a file's base name, a web site's host name.
function toolDetail(args) {
  if (!isObject(args)) return null;
  const text = firstLine(args.description, 80)
    ?? firstLine(args.command, 80)
    ?? flat(args.pattern, 140)
    ?? flat(args.query, 140)
    ?? baseName(str(args.path) ?? str(args.file_path))
    ?? hostOf(str(args.url))
    ?? flat(args.skill, 140);
  return text ? clip(text, 140) : null;
}

function inputText(input) {
  if (typeof input === 'string') return input;
  return messageText(input);
}

function outputText(output) {
  if (typeof output === 'string') return output;
  return messageText(output);
}

function messageText(content) {
  if (typeof content === 'string') return content;
  return blocks(content)
    .filter((part) => typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n');
}

function blocks(value) {
  return Array.isArray(value) ? value.filter(isObject) : [];
}

function firstLine(text, max) {
  if (typeof text !== 'string') return null;
  const line = /\S[^\n]*/.exec(text);
  return line ? flat(line[0], max) : null;
}

function flat(text, max) {
  if (typeof text !== 'string') return null;
  const value = text.replace(/\s+/g, ' ').trim();
  return value ? clip(value, max) : null;
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

function baseName(file) {
  if (!file) return null;
  const parts = normalizePath(file).split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : null;
}

function hostOf(url) {
  if (!url) return null;
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

function logFile(sessionDir, agentFolder) {
  return path.join(sessionDir, 'agents', agentFolder, 'wire.jsonl');
}

function readRange(fd, position, length) {
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
  if (end > 0 && buf[end - 1] === 0x0d) end--;
  try {
    const value = JSON.parse(stripBom(buf.toString('utf8', 0, end)));
    return isObject(value) ? value : null;
  } catch {
    return null;
  }
}

function fileKey(file) {
  return process.platform === 'win32' ? file.toLowerCase() : file;
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

function mtimeOf(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return null;
  }
}

// Agent ids are "main" and "agent-0", "agent-1", …
function agentIdOf(value) {
  if (typeof value !== 'string') return null;
  const id = value.trim().toLowerCase();
  return AGENT_ID.test(id) ? id : null;
}

// Turn ids are numbers in some records and strings in others.
function turnKey(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : null;
  if (typeof value !== 'string') return null;
  const id = value.trim();
  return id && id.length <= 64 ? id : null;
}

// Turn ids count up within a log; ids that are not numbers can only be told apart.
function isLater(id, than) {
  if (id === than) return false;
  const a = Number(id);
  const b = Number(than);
  return Number.isFinite(a) && Number.isFinite(b) ? a > b : true;
}

function remember(map, key, value) {
  map.delete(key);
  map.set(key, value);
  if (map.size > MAX_KEPT) map.delete(map.keys().next().value);
}

// Runs and ends are kept in time order without repeats (a log read again near its end after a
// long pause sees some of them twice).
function keepTime(list, at) {
  if (list.includes(at)) return;
  list.push(at);
  list.sort((a, b) => a - b);
  if (list.length > MAX_RUNS) list.shift();
}

function keepRun(list, run) {
  if (list.some((item) => item.at === run.at)) return;
  list.push(run);
  list.sort((a, b) => a.at - b.at);
  if (list.length > MAX_RUNS) list.shift();
}

function lastOf(values) {
  let last = null;
  for (const value of values) last = value;
  return last;
}

function str(value) {
  return typeof value === 'string' && value.trim() ? value : null;
}

function time(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : null;
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function parseObject(text) {
  if (isObject(text)) return text;
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
