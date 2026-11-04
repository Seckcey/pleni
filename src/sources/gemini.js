// Gemini CLI sessions and their helper agents, read from the folders Gemini CLI keeps in its home
// folder (~/.gemini): tmp/<project>/chats/session-<time>-<id>.jsonl for each session (version 0.38
// and older wrote one session-<time>-<id>.json each instead), and
// tmp/<project>/chats/<session id>/<agent id>.jsonl for each helper. A session does not name its
// working folder: tmp/<project>/.project_root does, or else projects.json. Read-only: logs are
// tailed incrementally and nothing is ever written. Pleni opens nothing else in the folder, so
// never the login files, settings.json, trustedFolders.json or a .env file.
import crypto from 'node:crypto';
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
const MAX_MESSAGES = 5000; // kept per log; older ones are forgotten
const MAX_CALLS = 100; // tool calls kept per message
const MAX_PARTS = 100; // function calls and responses kept per message
const MAX_EVENTS = 200;
const MAX_ID = 200;
const MAX_PATH = 4096;
const MAX_PROJECTS = 5000;
const TAIL_BYTES = 4 * MiB;
const CATCH_UP_BYTES = 16 * MiB; // more unread bytes than this: start again near the end
const HEAD_BYTES = 64 * 1024; // every log starts with a short metadata line
const HEAD_SCAN_BYTES = 2 * MiB; // looked through for the first prompt of a log read from near its end
const JSON_BYTES = 16 * MiB; // an older one-object session file is read whole, up to this size
const DETAIL_BYTES = 2 * MiB;
const SMALL_FILE_BYTES = 4096; // .project_root holds one folder path
const PROJECTS_BYTES = MiB;
// Approval rules (or YOLO mode) answer most tool calls at once. A call still waiting for approval
// after this long is waiting for the person.
const PERMISSION_GRACE_MS = 2000;
const SESSION_ID = /^[0-9a-f-]{8,64}$/;
const AGENT_ID = /^[0-9a-z_-]{1,64}$/;
const HASH = /^[0-9a-f]{64}$/;
const SESSION_FILE = /^session-.*\.jsonl?$/;
const LOG = '.jsonl';
const WINDOWS_PATH = /^(?:[a-z]:[\\/]|\\\\)/i;
const CONTROL = /\p{Cc}/u;
// Tool calls still on their way: the turn is running.
const OPEN_CALLS = new Set(['validating', 'scheduled', 'executing', 'awaiting_approval']);
const WAITING = 'awaiting_approval';
// The call a helper makes last, to hand its result to the session that started it.
const FINISH_TOOL = 'complete_task';
// User text that is not the person talking: a command, help, or context Gemini CLI or a hook adds.
const NOT_TALK = ['/', '?', '<session_context>', '<hook_context>'];
const POLL_KEEP = { text: 1000, results: false };
const DETAIL_KEEP = { text: 4000, results: true };
const WINDOW = { activeMinutes: 10, recentHours: 24, staleMinutes: 30 };
const NONE = Object.freeze([]);
const EMPTY_MESSAGE = Object.freeze({
  type: null,
  at: null,
  model: null,
  said: null, // the words of `content`
  shown: null, // the words of `displayContent`: what the person typed, before files were added in
  requested: NONE, // function calls in `content`
  responses: NONE, // function responses in `content`: tool results going back to the model
  calls: NONE, // toolCalls
  thought: false, // the model thought first; its thoughts are never kept
  thoughtAt: null,
});
const EMPTY_CALL = Object.freeze({ id: null, name: 'tool', display: null, status: null, at: null, detail: null, result: null });

export function createGeminiSource({ root, settings, now = Date.now } = {}) {
  let entries = new Map(); // log file -> what was read of it
  let places = { folders: new Map(), byHash: new Map() }; // working folders
  let scannedAt = null;

  function poll() {
    const fail = (error) => ({ ok: false, error, root: root ?? null, sessions: [] });
    try {
      if (!root) return fail('No Gemini CLI folder is set.');
      if (!isDirectory(root)) return fail('Pleni could not find the Gemini CLI folder.');
      const t = now();
      const cutoff = t - windowOf(settings).recentHours * HOUR;
      const due = scannedAt === null || t - scannedAt >= SCAN_MS || t < scannedAt;
      if (due) {
        ({ entries, places } = scan(root, entries, cutoff));
        scannedAt = t;
      }
      for (const entry of [...entries.values()]) {
        // A session that moved may have started a helper since the folders were listed.
        if (refresh(entry) && !due) addHelpers(entries, entry, cutoff);
      }
      return { ok: true, error: null, root, sessions: sessionsAt(t) };
    } catch {
      return fail('Pleni could not read the Gemini CLI sessions.');
    }
  }

  function sessionsAt(t) {
    const snippets = settings?.content !== 'none';
    const w = windowOf(settings);
    const chosen = pick(entries.values());
    const out = new Map();
    for (const item of chosen.values()) out.set(item.key, toSession(item, chosen, places, t, w, snippets));
    linkHelpers(out, chosen, snippets);
    rollUpWorking(out);
    for (const x of out.values()) {
      if (x.status === 'working') x.activity = activityOf(chosen.get(x.key).entry, snippets, t);
    }
    return [...out.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }

  // gemini:<session id> is a session, gemini:<session id>/<agent id> one of its helpers.
  function detail(key, since) {
    const empty = { events: [], next: null };
    try {
      if (typeof key !== 'string' || !key.startsWith('gemini:')) return empty;
      const item = pick(entries.values()).get(key);
      if (!item) return empty;
      return readDetail(item.entry, cursorOf(since), settings?.content !== 'none');
    } catch {
      return empty;
    }
  }

  return { poll, detail };
}

// ---- discovery ----

// Keeps the newest MAX_SESSIONS session logs, and the newest helper logs, changed since `cutoff`.
// Known logs keep what was read of them. Only the chats folders, .project_root and projects.json
// are looked at.
function scan(root, previous, cutoff) {
  const tmp = path.join(root, 'tmp');
  const known = readProjects(root);
  const folders = new Map(); // project folder name -> working folder or null
  const mains = [];
  const helpers = [];
  for (const folder of readDir(tmp)) {
    if (!folder.isDirectory() || folder.name.startsWith('.')) continue;
    const chats = path.join(tmp, folder.name, 'chats');
    const before = mains.length + helpers.length;
    for (const item of readDir(chats)) {
      if (item.isFile() && SESSION_FILE.test(item.name)) {
        addFound(mains, path.join(chats, item.name), folder.name, null, null, cutoff);
      } else if (item.isDirectory()) {
        const parentId = sessionIdOf(item.name);
        if (!parentId) continue;
        for (const log of readDir(path.join(chats, item.name))) {
          const agentId = helperIdOf(log);
          if (agentId) addFound(helpers, path.join(chats, item.name, log.name), folder.name, parentId, agentId, cutoff);
        }
      }
    }
    if (mains.length + helpers.length > before) folders.set(folder.name, workingFolder(tmp, folder.name, known));
  }
  const newest = (a, b) => b.mtimeMs - a.mtimeMs || (a.file < b.file ? -1 : 1);
  const picked = mains.sort(newest).slice(0, MAX_SESSIONS);
  const perParent = new Map();
  for (const helper of helpers.sort(newest)) {
    if (picked.length >= MAX_FILES) break;
    const count = perParent.get(helper.parentId) ?? 0;
    if (count >= MAX_HELPERS) continue;
    perParent.set(helper.parentId, count + 1);
    picked.push(helper);
  }
  const next = new Map();
  for (const item of picked) {
    const key = fileKey(item.file);
    next.set(key, previous.get(key) ?? newEntry(item));
  }
  return { entries: next, places: { folders, byHash: known.byHash } };
}

function addFound(list, file, folder, parentId, agentId, cutoff) {
  const mtimeMs = mtimeOf(file);
  if (mtimeMs !== null && mtimeMs >= cutoff) list.push({ file, folder, parentId, agentId, mtimeMs });
}

// The helper logs of a session that moved, when there are new ones.
function addHelpers(entries, main, cutoff) {
  const parentId = main.meta.sessionId;
  if (main.parentId || !parentId) return;
  const dir = path.join(path.dirname(main.file), parentId);
  let count = 0;
  for (const entry of entries.values()) if (entry.parentId === parentId) count++;
  for (const log of readDir(dir)) {
    if (entries.size >= MAX_FILES || count >= MAX_HELPERS) return;
    const agentId = helperIdOf(log);
    if (!agentId) continue;
    const file = path.join(dir, log.name);
    const key = fileKey(file);
    const mtimeMs = mtimeOf(file);
    if (entries.has(key) || mtimeMs === null || mtimeMs < cutoff) continue;
    const entry = newEntry({ file, folder: main.folder, parentId, agentId });
    entries.set(key, entry);
    count++;
    refresh(entry);
  }
}

function helperIdOf(dirent) {
  return dirent.isFile() && dirent.name.endsWith(LOG) ? agentIdOf(dirent.name.slice(0, -LOG.length)) : null;
}

// projects.json is { projects: { "<working folder>": "<project folder name>" } }. Older project
// folders are named by the SHA-256 of the working folder instead.
function readProjects(root) {
  const bySlug = new Map();
  const byHash = new Map();
  const raw = readJsonFile(path.join(root, 'projects.json'), PROJECTS_BYTES);
  const list = isObject(raw) && isObject(raw.projects) ? Object.entries(raw.projects).slice(0, MAX_PROJECTS) : [];
  for (const [folder, name] of list) {
    const clean = folderPath(folder);
    if (!clean) continue;
    if (typeof name === 'string' && name && !bySlug.has(name)) bySlug.set(name, clean);
    const hash = crypto.createHash('sha256').update(folder).digest('hex');
    if (!byHash.has(hash)) byHash.set(hash, clean);
  }
  return { bySlug, byHash };
}

function workingFolder(tmp, name, known) {
  const own = folderPath(readSmallText(path.join(tmp, name, '.project_root')));
  return own ?? known.bySlug.get(name) ?? (HASH.test(name) ? known.byHash.get(name) : null) ?? null;
}

function newEntry({ file, folder, parentId, agentId }) {
  const json = !file.endsWith(LOG);
  return {
    file,
    folder, // its project folder's name in tmp
    parentId, // a helper: the session that started it, and its own id
    agentId,
    json, // the older one-object file
    size: -1,
    mtimeMs: -1,
    started: false,
    headDone: false,
    headScanned: false,
    tail: json ? null : new JsonlTail(file, { maxInitialBytes: TAIL_BYTES }),
    meta: newMeta(),
    log: newLog(),
    head: { prompt: null, model: null }, // from the start of a log read from near its end
    version: 0, // goes up whenever something new was read
    facts: null,
    factsVersion: -1,
  };
}

// Only what Pleni uses. `memoryScratchpad` and `directories` are never kept.
function newMeta() {
  return { sessionId: null, kind: null, startedAt: null, updatedAt: null, summary: null, projectHash: null };
}

// The messages of a log in order, each id once, in the place it first came. `whole` is false when
// the start of the log was not read, or old messages were forgotten.
function newLog() {
  return { order: [], byId: new Map(), whole: true, seenAt: null, firstAt: null };
}

// ---- reading ----

// Returns true when something new was read.
function refresh(entry) {
  try {
    const st = fs.statSync(entry.file);
    if (st.size === entry.size && st.mtimeMs === entry.mtimeMs) return false;
    if (entry.json) {
      if (!readWhole(entry)) return false; // caught half-written, or too big: tried again later
    } else {
      readTail(entry, st.size);
    }
    entry.size = st.size;
    entry.mtimeMs = st.mtimeMs;
    entry.version++;
    return true;
  } catch {
    // One unreadable log must not hide the others; try again on the next poll.
    return false;
  }
}

function readTail(entry, size) {
  if (!entry.headDone) readHead(entry, size);
  if (entry.started && size - entry.tail.offset > CATCH_UP_BYTES) restart(entry);
  const out = entry.tail.read();
  if (out.reset || !entry.started) {
    if (out.reset) {
      // Another file in the old one's place: it is read as new.
      entry.meta = newMeta();
      entry.log = newLog();
      entry.head = { prompt: null, model: null };
      entry.headDone = false;
      entry.headScanned = false;
      readHead(entry, out.size);
    }
    entry.started = true;
    if (out.size > TAIL_BYTES) {
      entry.log.whole = false;
      if (!entry.headScanned) scanStart(entry);
    }
  }
  for (const rec of out.records) applyRecord(entry.log, entry.meta, rec, POLL_KEEP);
}

// The metadata line names the session. Until its newline arrives it is tried again.
function readHead(entry, size) {
  const head = readHeadLine(entry.file, HEAD_BYTES);
  if (!head && size <= HEAD_BYTES) return;
  entry.headDone = true;
  if (head && isMeta(head)) mergeMeta(entry.meta, head);
}

// Polls stop while nobody has the page open, and a busy log can grow a lot meanwhile. Rather than
// parse all of that in one go, start again near the end, as on the first read.
function restart(entry) {
  const old = entry.log;
  entry.log = { ...newLog(), seenAt: old.seenAt, firstAt: old.firstAt };
  entry.tail = new JsonlTail(entry.file, { maxInitialBytes: TAIL_BYTES });
  entry.started = false;
}

// A log read from near its end: its first prompt names the session, and its newest model there is
// the best guess when no reply in the part that was read names one.
function scanStart(entry) {
  entry.headScanned = true;
  for (const rec of scanHead(entry.file, HEAD_SCAN_BYTES, (r) => isMessage(r) && (r.type === 'user' || r.type === 'gemini'))) {
    const m = slimMessage(rec, POLL_KEEP);
    if (m.type === 'user' && entry.head.prompt === null && userKind(m) === 'prompt') entry.head.prompt = flat(userText(m), 120);
    if (m.type === 'gemini' && m.model) entry.head.model = m.model;
  }
}

// The older file is one JSON object, written again whole on every change.
function readWhole(entry) {
  const raw = readJsonFile(entry.file, JSON_BYTES);
  if (!raw) return false;
  entry.meta = newMeta();
  mergeMeta(entry.meta, raw);
  entry.log = newLog();
  for (const message of Array.isArray(raw.messages) ? raw.messages : []) {
    if (isMessage(message)) put(entry.log, message, POLL_KEEP);
  }
  entry.started = true;
  return true;
}

// One line of a log: the metadata, a message (new, or a newer copy of one), or a change to the
// list. `meta` is null when only the messages matter.
function applyRecord(log, meta, rec, keep) {
  if (isObject(rec.$set)) {
    if (meta) mergeMeta(meta, rec.$set);
    // The older way to write the list: all of it at once.
    if (Array.isArray(rec.$set.messages)) replaceAll(log, rec.$set.messages, keep);
  } else if (typeof rec.$rewindTo === 'string') {
    rewind(log, rec.$rewindTo);
  } else if (isObject(rec.$patch)) {
    patch(log, rec.$patch, keep);
  } else if (isMessage(rec)) {
    put(log, rec, keep);
  } else if (meta && isMeta(rec)) {
    mergeMeta(meta, rec);
  }
}

function mergeMeta(meta, raw) {
  if (Object.hasOwn(raw, 'sessionId')) meta.sessionId = sessionIdOf(raw.sessionId) ?? meta.sessionId;
  if (raw.kind === 'main' || raw.kind === 'subagent') meta.kind = raw.kind;
  if (Object.hasOwn(raw, 'startTime')) meta.startedAt = time(raw.startTime) ?? meta.startedAt;
  if (Object.hasOwn(raw, 'lastUpdated')) meta.updatedAt = time(raw.lastUpdated) ?? meta.updatedAt;
  if (Object.hasOwn(raw, 'summary')) meta.summary = flat(raw.summary, 120);
  if (typeof raw.projectHash === 'string' && HASH.test(raw.projectHash)) meta.projectHash = raw.projectHash;
}

// A message, or a newer copy of one: the newest copy wins, in the place the first one came.
function put(log, raw, keep) {
  const message = slimMessage(raw, keep);
  touch(log, message);
  if (!log.byId.has(raw.id)) {
    log.order.push(raw.id);
    if (log.order.length > MAX_MESSAGES) {
      log.byId.delete(log.order.shift());
      log.whole = false;
    }
  }
  log.byId.set(raw.id, message);
}

// $patch: fields of one message (`id`), of several (`updates`), messages taken out (`removeIds`),
// and a new order (`orderIds`). A message that was not read is left alone.
function patch(log, p, keep) {
  if (typeof p.id === 'string') {
    patchOne(log, p.id, p, keep);
    if (isObject(p.updates)) patchOne(log, p.id, p.updates, keep);
  }
  if (Array.isArray(p.updates)) {
    for (const u of p.updates) if (isObject(u) && typeof u.id === 'string') patchOne(log, u.id, u, keep);
  } else if (isObject(p.updates)) {
    for (const [id, u] of Object.entries(p.updates)) if (isObject(u) && log.byId.has(id)) patchOne(log, id, u, keep);
  }
  if (Array.isArray(p.removeIds)) remove(log, p.removeIds);
  if (Array.isArray(p.orderIds)) reorder(log, p.orderIds);
}

// Only the fields given change. Tool calls are matched by their id.
function patchOne(log, id, fields, keep) {
  const old = log.byId.get(id);
  if (!old) return;
  const changed = messageFields(fields, keep);
  if (Object.hasOwn(fields, 'toolCalls')) changed.calls = mergeCalls(old.calls, fields.toolCalls, keep);
  const message = { ...old, ...changed };
  touch(log, message);
  log.byId.set(id, message);
}

function remove(log, ids) {
  const gone = new Set(ids.filter((id) => typeof id === 'string'));
  if (!gone.size) return;
  log.order = log.order.filter((id) => !gone.has(id));
  for (const id of gone) log.byId.delete(id);
}

// $rewindTo: that message and every one after it go. One that was not read lies before the part
// that was read, so all of that goes.
function rewind(log, id) {
  const i = log.order.indexOf(id);
  if (i === -1) {
    if (!log.whole) clear(log);
    return;
  }
  for (const gone of log.order.splice(i)) log.byId.delete(gone);
}

// orderIds: the messages it names take their places in its order; the others stay where they are.
function reorder(log, ids) {
  const named = new Set();
  const wanted = [];
  for (const id of ids) {
    if (typeof id !== 'string' || !log.byId.has(id) || named.has(id)) continue;
    named.add(id);
    wanted.push(id);
  }
  let next = 0;
  log.order = log.order.map((id) => (named.has(id) ? wanted[next++] : id));
}

function replaceAll(log, messages, keep) {
  clear(log);
  log.whole = true;
  for (const message of messages) if (isMessage(message)) put(log, message, keep);
}

function clear(log) {
  log.order = [];
  log.byId.clear();
}

// The newest and oldest times seen. A message taken out later still happened.
function touch(log, m) {
  for (const at of [m.at, m.thoughtAt, ...m.calls.map((call) => call.at)]) {
    if (typeof at !== 'number') continue;
    if (log.seenAt === null || at > log.seenAt) log.seenAt = at;
    if (log.firstAt === null || at < log.firstAt) log.firstAt = at;
  }
}

// ---- messages ----

function slimMessage(raw, keep) {
  return { ...EMPTY_MESSAGE, ...messageFields(raw, keep) };
}

// What Pleni keeps of a message, from the fields `raw` has: a whole message, or the fields a patch
// changes. Words are cut short, and thoughts are kept only as the fact that there were some.
function messageFields(raw, keep) {
  const out = {};
  if (Object.hasOwn(raw, 'type')) out.type = str(raw.type);
  if (Object.hasOwn(raw, 'timestamp')) out.at = time(raw.timestamp);
  if (Object.hasOwn(raw, 'model')) out.model = str(raw.model)?.trim() ?? null;
  if (Object.hasOwn(raw, 'content')) {
    const parts = partsOf(raw.content);
    out.said = keepText(textOf(raw.content), keep.text);
    out.requested = parts.filter((p) => isObject(p.functionCall)).slice(0, MAX_PARTS).map((p) => requestOf(p.functionCall));
    out.responses = parts.filter((p) => isObject(p.functionResponse)).slice(0, MAX_PARTS).map((p) => responseOf(p.functionResponse, keep));
  }
  if (Object.hasOwn(raw, 'displayContent')) out.shown = keepText(textOf(raw.displayContent), keep.text);
  if (Object.hasOwn(raw, 'toolCalls')) out.calls = mergeCalls(NONE, raw.toolCalls, keep);
  if (Object.hasOwn(raw, 'thoughts')) {
    const list = Array.isArray(raw.thoughts) ? raw.thoughts.filter(isObject) : [];
    out.thought = list.length > 0;
    out.thoughtAt = null;
    for (const thought of list) {
      const at = time(thought.timestamp);
      if (at !== null && (out.thoughtAt === null || at < out.thoughtAt)) out.thoughtAt = at;
    }
  }
  return out;
}

// Tool calls by id: a newer copy of a call changes the fields it has, and a new call is added.
function mergeCalls(old, incoming, keep) {
  const out = [...old];
  for (const raw of Array.isArray(incoming) ? incoming : []) {
    if (!isObject(raw)) continue;
    const fields = callFields(raw, keep);
    const i = fields.id ? out.findIndex((call) => call.id === fields.id) : -1;
    if (i >= 0) out[i] = { ...out[i], ...fields };
    else if (out.length < MAX_CALLS) out.push({ ...EMPTY_CALL, ...fields });
  }
  return out;
}

// A tool call's `description` is the tool's own long description, so only its arguments are used.
function callFields(raw, keep) {
  const out = {};
  if (Object.hasOwn(raw, 'id')) out.id = str(raw.id);
  if (Object.hasOwn(raw, 'name')) out.name = str(raw.name) ?? 'tool';
  if (Object.hasOwn(raw, 'displayName')) out.display = flat(raw.displayName, 80);
  if (Object.hasOwn(raw, 'status')) out.status = str(raw.status);
  if (Object.hasOwn(raw, 'timestamp')) out.at = time(raw.timestamp);
  if (Object.hasOwn(raw, 'args')) out.detail = toolDetail(raw.args);
  if (keep.results && (Object.hasOwn(raw, 'result') || Object.hasOwn(raw, 'resultDisplay'))) {
    out.result = keepText(resultText(raw.result) ?? (typeof raw.resultDisplay === 'string' ? raw.resultDisplay : null), keep.text);
  }
  return out;
}

function requestOf(call) {
  return { id: str(call.id), name: str(call.name) ?? 'tool', detail: toolDetail(call.args) };
}

function responseOf(response, keep) {
  return { id: str(response.id), name: str(response.name), text: keep.results ? keepText(responseText(response), keep.text) : null };
}

// What a user message is: the person talking ('prompt'), tool results going back to the model
// ('result'), or something else, such as a command ('other').
function userKind(m) {
  if (m.responses.length) return 'result';
  const text = (userText(m) ?? '').trimStart();
  return NOT_TALK.some((mark) => text.startsWith(mark)) ? 'other' : 'prompt';
}

function userText(m) {
  return m.shown ?? m.said;
}

// ---- building sessions ----

// The sessions to show, by key. One session can be in two places (an older project folder named
// by a hash keeps copies): the copy with the newest lastUpdated wins.
function pick(entries) {
  const chosen = new Map();
  for (const entry of entries) {
    const who = identityOf(entry);
    if (!who || !factsOf(entry).talked) continue;
    const old = chosen.get(who.key);
    if (old && !isNewer(entry, old.entry)) continue;
    chosen.set(who.key, { entry, ...who });
  }
  return chosen;
}

function identityOf(entry) {
  if (entry.parentId) {
    const parentKey = `gemini:${entry.parentId}`;
    return { key: `${parentKey}/${entry.agentId}`, id: entry.agentId, helper: true, parentKey };
  }
  const id = entry.meta.sessionId;
  if (!id) return null;
  // A helper's log beside the sessions names no parent; it shows as a helper on its own.
  return { key: `gemini:${id}`, id, helper: entry.meta.kind === 'subagent', parentKey: null };
}

function isNewer(a, b) {
  const at = (entry) => entry.meta.updatedAt ?? factsOf(entry).lastAt ?? entry.mtimeMs;
  if (at(a) !== at(b)) return at(a) > at(b);
  if (a.mtimeMs !== b.mtimeMs) return a.mtimeMs > b.mtimeMs;
  return a.file < b.file;
}

// What the poll needs from a log, worked out again only when something new was read.
function factsOf(entry) {
  if (entry.facts && entry.factsVersion === entry.version) return entry.facts;
  const { log } = entry;
  const messages = messagesOf(log);
  let talked = false;
  let model = null;
  let lastText = null;
  let prompt = null;
  for (const m of messages) {
    if (m.type === 'user') {
      const kind = userKind(m);
      if (kind === 'other') continue;
      talked = true;
      if (kind === 'prompt' && prompt === null) prompt = flat(userText(m), 120);
    } else if (m.type === 'gemini') {
      talked = true;
      if (m.model) model = m.model;
      lastText = flat(m.said, 280) ?? lastText;
    } else if (m.type === 'error') {
      talked = true;
    }
  }
  entry.facts = {
    talked, // a session where nothing was said yet is left out
    turn: turnOf(messages),
    model: model ?? entry.head.model,
    lastText,
    prompt: log.whole ? prompt : entry.head.prompt ?? prompt,
    // lastUpdated can move when nothing happened in the session (a summary added later), so the
    // newest time of a message, tool call or thought comes first.
    lastAt: log.seenAt ?? entry.meta.updatedAt,
    firstAt: log.firstAt,
  };
  entry.factsVersion = entry.version;
  return entry.facts;
}

// Whether a turn is running, from the messages in order. The person's prompt starts one, and tool
// results going back to the model keep it going, until a reply with no tool calls, a stop, or an
// error ends it. Notes from Gemini CLI itself (info, warning) and commands change nothing.
function turnOf(messages) {
  const turn = { open: false, closedAt: null, ending: null, calls: [] };
  const go = (calls = []) => {
    turn.open = true;
    turn.ending = null;
    turn.calls = calls;
  };
  const close = (at, ending) => {
    turn.open = false;
    turn.ending = ending;
    turn.calls = [];
    if (at !== null) turn.closedAt = at;
  };
  for (const m of messages) {
    if (m.type === 'user') {
      if (userKind(m) !== 'other') go();
    } else if (m.type === 'gemini') {
      const open = m.calls.filter((call) => OPEN_CALLS.has(call.status)).map((call) => ({ ...call, at: call.at ?? m.at }));
      if (open.length) go(open);
      else if (m.calls.some((call) => call.name === FINISH_TOOL && call.status === 'success')) close(endOf(m), 'completed');
      else if (m.calls.length && m.calls.every((call) => call.status === 'cancelled')) close(endOf(m), 'cancelled');
      // The tools ran, and their results go back to the model, which goes on.
      else if (m.calls.length || m.requested.length) go();
      else close(m.at, 'completed');
    } else if (m.type === 'error') {
      close(m.at, 'failed');
    }
  }
  return turn;
}

function endOf(m) {
  let end = m.at;
  for (const call of m.calls) if (call.at !== null && (end === null || call.at > end)) end = call.at;
  return end;
}

function toSession({ entry, key, id, helper, parentKey }, chosen, places, t, w, snippets) {
  const f = factsOf(entry);
  const parent = parentKey ? chosen.get(parentKey) ?? null : null;
  const parentDone = helper && parent !== null && movedOn(factsOf(parent.entry), f);
  const status = statusOf(f, helper, parentDone, t, w);
  const title = titleOf(entry.meta, f, snippets);
  return {
    platform: 'gemini',
    key,
    id,
    parentKey,
    kind: helper ? 'agent' : 'session',
    spawned: helper, // started by the session above it; chain rules leave it there
    role: null,
    title: title.text,
    titleSource: title.source,
    cwd: cwdOf(entry, places) ?? (parent ? cwdOf(parent.entry, places) : null),
    branch: null,
    entrypoint: null,
    model: f.model,
    effort: null,
    startedAt: entry.meta.startedAt ?? f.firstAt,
    lastAt: f.lastAt,
    status,
    activity: null, // set once the status of every session is known
    lastText: snippets ? f.lastText : null,
    needs: status === 'done' ? null : needsOf(f.turn, snippets, t),
    links: [],
    archived: false,
  };
}

// The summary Gemini CLI writes, else the first prompt: both are session text, so with snippets only.
function titleOf(meta, f, snippets) {
  if (!snippets) return { text: null, source: null };
  if (meta.summary) return { text: meta.summary, source: 'summary' };
  if (f.prompt) return { text: f.prompt, source: 'first-prompt' };
  return { text: null, source: null };
}

function cwdOf(entry, places) {
  const own = places.folders.get(entry.folder);
  if (own) return own;
  return entry.meta.projectHash ? places.byHash.get(entry.meta.projectHash) ?? null : null;
}

// The session that started a helper heard back from it: nothing it started is still running, and
// it wrote something after the helper's last word.
function movedOn(parent, f) {
  return parent.turn.calls.length === 0 && parent.lastAt !== null && f.lastAt !== null && parent.lastAt > f.lastAt;
}

function statusOf({ turn, lastAt }, helper, parentDone, t, w) {
  if (turn.open && !parentDone) {
    return lastAt !== null && t - lastAt <= w.staleMinutes * MINUTE ? 'working' : 'idle';
  }
  if (!turn.open && turn.ending === 'failed') return 'error';
  if (helper && (parentDone || turn.closedAt !== null)) return 'done';
  if (turn.closedAt !== null && t - turn.closedAt <= w.activeMinutes * MINUTE) return 'ready';
  return 'idle';
}

// A tool call that waits for the person's approval, once it has waited PERMISSION_GRACE_MS. It
// stays until answered or the turn ends, however long that takes.
function needsOf(turn, snippets, t) {
  if (!turn.open) return null;
  for (let i = turn.calls.length - 1; i >= 0; i--) {
    const call = turn.calls[i];
    if (call.status !== WAITING || call.at === null || t - call.at < PERMISSION_GRACE_MS) continue;
    const tool = call.display ?? call.name;
    const text = call.detail ? `Asks to use ${tool}: ${call.detail}` : `Asks to use ${tool}`;
    return { kind: 'permission', text: snippets ? clip(text, 280) : null, at: call.at };
  }
  return null;
}

// The newest tool call still on its way.
function activityOf(entry, snippets, t) {
  const f = factsOf(entry);
  const call = f.turn.calls[f.turn.calls.length - 1];
  if (!call) return null;
  return { tool: call.display ?? call.name, detail: snippets ? call.detail : null, at: call.at ?? f.lastAt ?? t };
}

// A helper's start is work going down from the session that started it; its end is a report
// coming up. Links are kept by that session, like Claude Code's.
function linkHelpers(out, chosen, snippets) {
  const touched = new Set();
  for (const x of out.values()) {
    const parent = x.kind === 'agent' && x.parentKey ? out.get(x.parentKey) : null;
    if (!parent || parent === x) continue;
    if (x.startedAt !== null) {
      parent.links.push({ at: x.startedAt, dir: 'down', other: x.key, label: snippets && x.title ? clip(x.title, 140) : null });
    }
    const endAt = x.status === 'done' || x.status === 'error' ? factsOf(chosen.get(x.key).entry).turn.closedAt ?? x.lastAt : null;
    if (endAt !== null) {
      parent.links.push({ at: endAt, dir: 'up', other: x.key, label: snippets && x.lastText ? clip(x.lastText, 140) : null });
    }
    touched.add(parent);
  }
  for (const parent of touched) {
    parent.links.sort((a, b) => a.at - b.at).splice(0, Math.max(0, parent.links.length - MAX_LINKS));
  }
}

// A session whose helper is working is working too, even when its own turn went quiet: it writes
// nothing while a long helper runs. Only "ready" and "idle" are lifted.
function rollUpWorking(out) {
  for (const x of out.values()) {
    if (x.status !== 'working') continue;
    const seen = new Set([x.key]);
    let parent = x.parentKey ? out.get(x.parentKey) : null;
    while (parent && !seen.has(parent.key) && (parent.status === 'ready' || parent.status === 'idle')) {
      seen.add(parent.key);
      parent.status = 'working';
      parent = parent.parentKey ? out.get(parent.parentKey) : null;
    }
  }
}

function windowOf(settings) {
  const w = isObject(settings?.window) ? settings.window : {};
  const get = (name) => (Number.isFinite(w[name]) && w[name] > 0 ? w[name] : WINDOW[name]);
  return { activeMinutes: get('activeMinutes'), recentHours: get('recentHours'), staleMinutes: get('staleMinutes') };
}

// ---- detail ----

// The side panel's events. Gemini CLI writes a message again whenever it changes, so every answer
// is the whole recent list (`reset: true`, which the page shows in place of what it had), built
// from the last DETAIL_BYTES of the log. When the log has not grown since `since`, the answer
// holds no events and the page keeps what it has.
function readDetail(entry, since, snippets) {
  const log = newLog();
  if (entry.json) {
    const size = fs.statSync(entry.file).size;
    const raw = readJsonFile(entry.file, JSON_BYTES);
    if (!raw) return { events: [], next: since };
    for (const message of Array.isArray(raw.messages) ? raw.messages : []) {
      if (isMessage(message)) put(log, message, DETAIL_KEEP);
    }
    return { events: eventsOf(messagesOf(log), snippets), next: size, reset: true };
  }
  if (since !== null && since === fs.statSync(entry.file).size) return { events: [], next: since };
  const { records, next, from } = readFrom(entry.file);
  log.whole = from === 0;
  for (const rec of records) applyRecord(log, null, rec, DETAIL_KEEP);
  return { events: eventsOf(messagesOf(log), snippets), next, reset: true };
}

// Reads complete lines of the last DETAIL_BYTES. If the file grows between the size check and the
// read, the window would shift, so try again.
function readFrom(file) {
  for (let attempt = 1; ; attempt++) {
    const size = fs.statSync(file).size;
    const from = Math.max(0, size - DETAIL_BYTES);
    const tail = new JsonlTail(file, { maxInitialBytes: size - from });
    const out = tail.read();
    if (out.size === size || attempt >= 3) return { records: out.records, next: tail.offset, from };
  }
}

// The person's prompts (and the work a helper was given), replies, tool calls and their results,
// and errors, oldest first. Thinking shows only as the fact that the model thought, never its words.
function eventsOf(messages, snippets) {
  let events = [];
  const answered = new Set(); // tool calls whose result already shows
  const push = (at, kind, tool, text) => {
    if (at === null) return;
    events.push({ at, kind, tool, text: snippets && kind !== 'thinking' ? clipBlock(text, 2000) : null });
  };
  for (const m of messages) {
    if (m.type === 'user') {
      const kind = userKind(m);
      if (kind === 'prompt') push(m.at, 'user', null, userText(m));
      if (kind !== 'result') continue;
      for (const r of m.responses) if (!(r.id && answered.has(r.id))) push(m.at, 'result', r.name, r.text);
    } else if (m.type === 'gemini') {
      if (m.thought) push(m.thoughtAt ?? m.at, 'thinking', null, null);
      if (m.said) push(m.at, 'assistant', null, m.said);
      for (const call of m.calls) callEvents(call, m.at, answered, push);
      if (!m.calls.length) for (const r of m.requested) push(m.at, 'tool', r.name, r.detail);
    } else if (m.type === 'error') {
      push(m.at, 'error', null, m.said ?? m.shown ?? 'Gemini CLI stopped with an error.');
    }
    if (events.length > MAX_EVENTS * 4) events = events.slice(-MAX_EVENTS);
  }
  return events.slice(-MAX_EVENTS);
}

function callEvents(call, at, answered, push) {
  const when = call.at ?? at;
  const tool = call.display ?? call.name;
  push(when, 'tool', tool, call.detail);
  if (call.status !== 'success' && call.status !== 'error' && call.status !== 'cancelled') return;
  if (call.id) answered.add(call.id);
  if (call.status === 'success') push(when, 'result', tool, call.result);
  else if (call.status === 'cancelled') push(when, 'error', tool, 'Stopped');
  else push(when, 'error', tool, call.result ?? 'The tool call failed.');
}

function messagesOf(log) {
  return log.order.map((id) => log.byId.get(id));
}

function cursorOf(since) {
  if (typeof since === 'number' && Number.isSafeInteger(since) && since >= 0) return since;
  if (typeof since === 'string' && /^\d{1,15}$/.test(since)) return Number(since);
  return null;
}

// ---- text helpers ----

// Gemini "parts": an array of { text }, { functionCall } and { functionResponse } objects (or
// strings), one such object, or an object with `parts`.
function partsOf(content) {
  if (Array.isArray(content)) return content.filter(isObject);
  if (!isObject(content)) return [];
  return Array.isArray(content.parts) ? content.parts.filter(isObject) : [content];
}

// The words of a message. A part marked `thought` is the model thinking, never words to show.
function textOf(content) {
  if (typeof content === 'string') return content;
  let list = [];
  if (Array.isArray(content)) list = content;
  else if (isObject(content)) list = Array.isArray(content.parts) ? content.parts : [content];
  return list
    .map((part) => (typeof part === 'string' ? part : isObject(part) && part.thought !== true && typeof part.text === 'string' ? part.text : ''))
    .filter(Boolean)
    .join('\n');
}

function responseText(response) {
  const r = response.response;
  if (typeof r === 'string') return r || null;
  if (!isObject(r)) return null;
  for (const name of ['output', 'error', 'content', 'result']) if (typeof r[name] === 'string' && r[name]) return r[name];
  return null;
}

function resultText(result) {
  if (typeof result === 'string') return result || null;
  const texts = [];
  for (const part of partsOf(result)) {
    if (isObject(part.functionResponse)) texts.push(responseText(part.functionResponse));
    else if (part.thought !== true && typeof part.text === 'string') texts.push(part.text);
  }
  return texts.filter(Boolean).join('\n') || null;
}

// Short words about what a tool call does (≤140 characters), from its arguments: a description,
// the first line of a command, a search pattern or query, a file's base name, a web site's host name.
function toolDetail(raw) {
  const args = isObject(raw) ? raw : parseObject(raw);
  if (!args) return null;
  const text = firstLine(args.description, 80)
    ?? firstLine(args.command, 80)
    ?? flat(args.pattern, 140)
    ?? flat(args.query, 140)
    ?? baseName(str(args.file_path) ?? str(args.absolute_path) ?? str(args.path) ?? str(args.dir_path))
    ?? hostOf(str(args.url));
  return text ? clip(text, 140) : null;
}

// The start of a text, for later clipping; null when empty.
function keepText(text, max) {
  if (typeof text !== 'string' || !text.trim()) return null;
  return text.length <= max ? text : text.slice(0, max).replace(/[\uD800-\uDBFF]$/, '');
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
  const chars = Array.from(text.slice(0, max * 2 + 2));
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('').trimEnd()}…`;
}

// Like clip, but keeps line breaks for the side panel; empty text becomes null.
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

// A full folder path, for Linux, macOS or Windows; anything else is null.
function folderPath(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text || text.length > MAX_PATH || CONTROL.test(text)) return null;
  return text.startsWith('/') || WINDOWS_PATH.test(text) ? normalizePath(text) : null;
}

// ---- small helpers ----

function readSmallText(file) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > SMALL_FILE_BYTES) return null;
    return stripBom(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
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

function fileKey(file) {
  return process.platform === 'win32' ? file.toLowerCase() : file;
}

// Session ids are UUIDs: they must fit Pleni's node keys.
function sessionIdOf(value) {
  if (typeof value !== 'string') return null;
  const id = value.trim().toLowerCase();
  return SESSION_ID.test(id) ? id : null;
}

function agentIdOf(value) {
  if (typeof value !== 'string') return null;
  const id = value.trim().toLowerCase();
  return AGENT_ID.test(id) ? id : null;
}

function isMessage(rec) {
  return isObject(rec) && typeof rec.id === 'string' && rec.id.length > 0 && rec.id.length <= MAX_ID;
}

// The first line of a log: { sessionId, projectHash, startTime, lastUpdated, kind?, directories? }.
function isMeta(rec) {
  return !Object.hasOwn(rec, 'id') && !Object.hasOwn(rec, 'type') && (typeof rec.sessionId === 'string' || typeof rec.startTime === 'string');
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
