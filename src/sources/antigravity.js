// Antigravity CLI conversations and the helpers they start, read from the folder Antigravity CLI
// keeps in the home folder, ~/.gemini/antigravity-cli (no setting of Antigravity CLI moves it).
// Each conversation has brain/<id>/.system_generated/logs/transcript_full.jsonl (the uncut one,
// read when it is there) or transcript.jsonl: one JSON step per line. A helper is a conversation
// of its own, named by an INVOKE_SUBAGENT step of the conversation that started it. A transcript
// does not name its working folder: cache/conversation_metadata.json, history.jsonl or
// cache/last_conversations.json does. Read-only: transcripts are tailed and nothing is ever
// written. Pleni opens nothing else in the folder, so never the login, settings.json, or the
// conversation databases (the .db and -wal files).
import fs from 'node:fs';
import path from 'node:path';
import { JsonlTail, readJsonFile, scanHead, stripBom } from '../jsonl.js';

const MiB = 1024 * 1024;
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const SCAN_MS = 30 * SECOND;
const RETRY_MS = 5 * SECOND; // a helper named before its transcript is there is looked for again
const MAX_FILES = 600; // transcripts followed, newest first
const MAX_LINKS = 50;
const MAX_STEPS = 5000; // kept per transcript; older ones are forgotten
const MAX_CALLS = 100; // tool calls kept per step
const MAX_CHILDREN = 200; // helpers kept per conversation
const MAX_ROLES = 20;
const MAX_EVENTS = 200;
const MAX_PLACES = 5000; // conversations kept from each cache and history file
const MAX_PATH = 4096;
const TAIL_BYTES = 4 * MiB;
const CATCH_UP_BYTES = 16 * MiB; // more unread bytes than this: start again near the end
const HEAD_SCAN_BYTES = 2 * MiB; // looked through for the first request of a transcript read from near its end
const CALL_SCAN_BYTES = 16 * MiB; // looked through for helpers before the part of a big transcript that is read
const CROSS_BYTES = MiB; // how far that look reads on, for the line that runs on into the part that is read
const DETAIL_BYTES = 2 * MiB;
const META_BYTES = 16 * MiB;
const LAST_BYTES = MiB;
const HISTORY_BYTES = 4 * MiB;
const HEAD_STEPS = 50; // a helper's reminder comes in its first steps
const MARK_BYTES = 64; // kept from just before where reading stopped, to notice a file written again in place
// Auto mode's own reviewer can take about 10 seconds to answer a tool call before the person is asked.
const APPROVAL_GRACE_MS = 15 * SECOND;
const NEWLINE = 0x0a;
const ID = /^[0-9a-f-]{8,64}$/;
const UUIDS = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
// A conversation id where a result labels it: a conversationId or conversation_id field or label.
const LABELED_IDS = /conversation_?id["']?\s*[:=]\s*["']?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi;
// The id on a line of a helper's reminder: "id: …" or id="…".
const LINE_ID = /id["']?\s*[:=]\s*["']?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
const WINDOWS_PATH = /^(?:[a-z]:[\\/]|\\\\)/i;
const CONTROL = /\p{Cc}/u;
const LOGS = ['.system_generated', 'logs'];
// The uncut transcript first: transcript.jsonl cuts long tool results short.
const TRANSCRIPTS = ['transcript_full.jsonl', 'transcript.jsonl'];
const INVOKE = 'INVOKE_SUBAGENT';
const INVOKE_HINT = Buffer.from(INVOKE);
const INVOKE_TOOL = 'invoke_subagent';
const REPLY_HINT = Buffer.from('PLANNER_RESPONSE');
const ASK_TOOL = 'ask_question'; // waits for the person's answer, not for leave to run a tool
// The note Antigravity CLI puts in a helper's first steps, to tell it that it is a helper.
const REMINDER = '<subagent_reminder>';
const RUNNING = new Set(['RUNNING', 'PENDING', 'WAITING', 'ACTIVE']);
// Pleni's best guess at the status of a tool step that waits for the person to allow it.
const WAITING = 'WAITING';
const FAILED = new Set(['ERROR', 'FAILED']);
const STOPPED = new Set(['CANCELED', 'CANCELLED', 'INTERRUPTED']);
const ERROR_TYPES = new Set(['ERROR', 'ERROR_MESSAGE']);
// Steps that keep the conversation's books (a checkpoint holds old history squeezed down): they
// neither start nor end a turn, and do not move lastAt.
const NOTES = new Set(['CHECKPOINT', 'CONVERSATION_HISTORY', 'SYSTEM_MESSAGE', 'EPHEMERAL_MESSAGE']);
// Blocks Antigravity CLI adds around what the person typed: the time, the workspace, a reminder.
// These known ones may run on to the end of a text that was cut short. Any other upper-case block
// goes only when it is closed and its opening tag is on a line of its own, so a <TODO> or
// <API_KEY> in the person's own words stays.
const KNOWN_BLOCKS = ['ADDITIONAL_METADATA', 'USER_INFORMATION', 'user_information', 'subagent_reminder'];
const BLOCK_OPEN = new RegExp(`(^|\\n)<([A-Z][A-Z0-9_]{2,})>(?=[ \\t]*\\r?\\n)|<(${KNOWN_BLOCKS.join('|')})>`, 'g');
const BLOCK_CLOSE = /<\/([A-Za-z][A-Za-z0-9_]{2,})>/g;
// What a working helper turns into working in each conversation above it.
const LIFTED = new Set(['ready', 'idle', 'done']);
// "Created At: …" and "Completed At: …" lines at the top of a tool's result.
const RESULT_TIMES = /^(?:(?:Created|Completed) At: [^\n]*\n)+/;
const POLL_KEEP = { text: 1000, results: false };
const DETAIL_KEEP = { text: 4000, results: true };
const WINDOW = { activeMinutes: 10, recentHours: 24, staleMinutes: 30 };
const NONE = Object.freeze([]);

export function createAntigravitySource({ root, settings, now = Date.now } = {}) {
  let entries = new Map(); // conversation id -> what was read of its transcript
  const places = newPlaces(); // working folders and names, from the cache and history files
  let missing = new Map(); // helper id -> when its transcript was last looked for, in vain
  let scannedAt = null;

  function poll() {
    const fail = (error) => ({ ok: false, error, root: root ?? null, sessions: [] });
    try {
      if (!root) return fail('No Antigravity CLI folder is set.');
      if (!isDirectory(root)) return fail('Pleni could not find the Antigravity CLI folder.');
      const t = now();
      const cutoff = t - windowOf(settings).recentHours * HOUR;
      const due = scannedAt === null || t - scannedAt >= SCAN_MS || t < scannedAt;
      if (due) {
        entries = scan(root, entries, cutoff);
        readPlaces(root, places);
        missing = new Map();
        scannedAt = t;
      }
      for (const entry of [...entries.values()]) {
        // A conversation that moved may have started a helper since the folder was listed.
        if (refresh(entry) && !due) addChildren(root, entries, entry, cutoff, missing, t);
      }
      return { ok: true, error: null, root, sessions: sessionsAt(t) };
    } catch {
      return fail('Pleni could not read the Antigravity CLI sessions.');
    }
  }

  function sessionsAt(t) {
    const snippets = settings?.content !== 'none';
    const w = windowOf(settings);
    const chosen = new Map();
    for (const entry of entries.values()) if (factsOf(entry).talked) chosen.set(entry.id, entry);
    const parents = parentsOf(chosen);
    const out = new Map();
    for (const entry of chosen.values()) {
      const x = toSession(entry, parents, chosen, places, t, w, snippets);
      out.set(x.key, x);
    }
    linkHelpers(out, chosen, snippets);
    rollUpWorking(out);
    for (const x of out.values()) {
      if (x.status === 'working') x.activity = activityOf(factsOf(chosen.get(x.id)), snippets, t, w);
    }
    return [...out.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }

  // antigravity:<conversation id>, for a conversation and a helper alike.
  function detail(key, since) {
    const empty = { events: [], next: null };
    try {
      if (typeof key !== 'string' || !key.startsWith('antigravity:')) return empty;
      const entry = entries.get(key.slice('antigravity:'.length));
      if (!entry || !factsOf(entry).talked) return empty;
      return readDetail(entry, cursorOf(since), settings?.content !== 'none');
    } catch {
      return empty;
    }
  }

  return { poll, detail };
}

// ---- discovery ----

// Keeps the newest MAX_FILES transcripts changed since `cutoff`, one per conversation. Known ones
// keep what was read of them. Only the list of conversations in brain and the two transcript
// names in each are looked at.
function scan(root, previous, cutoff) {
  const brain = path.join(root, 'brain');
  const found = [];
  for (const item of readDir(brain)) {
    const id = item.isDirectory() ? idOf(item.name) : null;
    if (!id) continue;
    const log = transcriptOf(path.join(brain, item.name));
    if (log && log.mtimeMs >= cutoff) found.push({ id, ...log });
  }
  found.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.file < b.file ? -1 : 1));
  const next = new Map();
  for (const item of found) {
    if (next.size >= MAX_FILES) break;
    if (next.has(item.id)) continue;
    const old = previous.get(item.id);
    next.set(item.id, old && old.file === item.file ? old : newEntry(item.id, item.file, old));
  }
  return next;
}

// The transcript in a conversation's folder: { file, mtimeMs }, or null.
function transcriptOf(dir) {
  for (const name of TRANSCRIPTS) {
    const file = path.join(dir, ...LOGS, name);
    try {
      const st = fs.statSync(file);
      if (st.isFile()) return { file, mtimeMs: st.mtimeMs };
    } catch {
      // Not there: try the other name.
    }
  }
  return null;
}

// The helpers a conversation named since the folder was listed, once their transcripts are there.
function addChildren(root, entries, entry, cutoff, missing, t) {
  for (const id of entry.children.keys()) {
    if (entries.size >= MAX_FILES) return;
    if (id === entry.id || entries.has(id) || t - (missing.get(id) ?? -Infinity) < RETRY_MS) continue;
    const log = transcriptOf(path.join(root, 'brain', id));
    if (!log || log.mtimeMs < cutoff) {
      missing.set(id, t);
      continue;
    }
    const child = newEntry(id, log.file, null);
    entries.set(id, child);
    refresh(child);
  }
}

function newEntry(id, file, old) {
  return {
    id,
    file,
    size: -1,
    mtimeMs: -1,
    started: false,
    fromStart: false, // the part being read began at the start of the file
    scanned: false, // a transcript read from near its end had its start looked through
    tail: new JsonlTail(file, { maxInitialBytes: TAIL_BYTES }),
    mark: null, // the bytes just before where reading stopped: { end, bytes }
    log: newLog(),
    // Kept when the file is written again, and when the other transcript name takes over: it is
    // the same conversation. `cut` is true when the first request was cleared of its words,
    // `caller` is the conversation a helper's reminder names, and `callerAt` and `callerStep` the
    // time and step_index of the step that holds that reminder.
    head: old ? { ...old.head, steps: 0 } : { prompt: null, cut: false, helper: false, caller: null, callerAt: null, callerStep: null, steps: 0 },
    children: old ? old.children : new Map(), // helper id -> the role it was given, or null
    firstAt: old ? old.firstAt : null, // the oldest step time seen
    version: 0, // goes up whenever something new was read
    facts: null,
    factsVersion: -1,
  };
}

// The steps of a transcript in order, each step_index once. `whole` is false when the start of
// the file was not read, or old steps were forgotten. `walk` follows the replies and helper starts,
// those looked through before the part that is read too, for the roles of helpers.
function newLog() {
  return { order: [], byKey: new Map(), whole: true, lines: 0, seenAt: null, firstAt: null, walk: newWalk() };
}

// ---- the cache and history files ----

function newPlaces() {
  return {
    meta: new Map(), // id -> { cwd, title }, from cache/conversation_metadata.json
    metaStamp: null,
    last: new Map(), // id -> working folder, from cache/last_conversations.json
    lastStamp: null,
    history: new Map(), // id -> { cwd, prompt }, from history.jsonl
    historyTail: null,
  };
}

function readPlaces(root, places) {
  const cache = path.join(root, 'cache');
  const meta = readChanged(path.join(cache, 'conversation_metadata.json'), META_BYTES, places.metaStamp);
  if (meta) {
    places.meta = metaPlaces(meta.value);
    places.metaStamp = meta.stamp;
  }
  const last = readChanged(path.join(cache, 'last_conversations.json'), LAST_BYTES, places.lastStamp);
  if (last) {
    places.last = lastPlaces(last.value);
    places.lastStamp = last.stamp;
  }
  readHistory(path.join(root, 'history.jsonl'), places);
}

// A small JSON file, read again only when it changed: { value, stamp }, or null when nothing
// changed. One that is gone gives no value; one caught half-written keeps what was read before
// and is tried again later.
function readChanged(file, maxBytes, stamp) {
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    return stamp === 'none' ? null : { value: null, stamp: 'none' };
  }
  const next = `${st.size}:${st.mtimeMs}`;
  if (next === stamp || !st.isFile()) return null;
  const value = readJsonFile(file, maxBytes);
  return value ? { value, stamp: next } : null;
}

// { conversations: { "<id>": { summary: { WorkspaceURIs: ["file:///…"], Title? } } } }. The first
// workspace is the working folder.
function metaPlaces(raw) {
  const out = new Map();
  const list = isObject(raw?.conversations) ? raw.conversations : {};
  for (const [key, value] of Object.entries(list)) {
    if (out.size >= MAX_PLACES) break;
    const id = idOf(key);
    if (!id || !isObject(value)) continue;
    const summary = isObject(value.summary) ? value.summary : {};
    out.set(id, { cwd: firstFolder(uriList(summary)), title: flat(str(summary.Title) ?? str(summary.title), 120) });
  }
  return out;
}

function uriList(summary) {
  for (const name of ['WorkspaceURIs', 'workspaceURIs', 'workspaceUris', 'workspace_uris']) {
    const list = typeof summary[name] === 'string' ? parseJson(summary[name]) : summary[name];
    if (Array.isArray(list)) return list;
  }
  return NONE;
}

function firstFolder(uris) {
  for (const uri of uris.slice(0, 20)) {
    const folder = folderFromUri(uri);
    if (folder) return folder;
  }
  return null;
}

// { "<working folder>": "<newest conversation id>" }, read the other way round.
function lastPlaces(raw) {
  const out = new Map();
  for (const [folder, value] of Object.entries(isObject(raw) ? raw : {})) {
    if (out.size >= MAX_PLACES) break;
    const id = idOf(value);
    const cwd = folderPath(folder);
    if (id && cwd && !out.has(id)) out.set(id, cwd);
  }
  return out;
}

// history.jsonl has a line for each prompt the person sent: { display, timestamp, workspace,
// conversationId }. It grows, and is cut short when Antigravity CLI closes.
function readHistory(file, places) {
  if (!places.historyTail) places.historyTail = new JsonlTail(file, { maxInitialBytes: HISTORY_BYTES });
  let out;
  try {
    out = places.historyTail.read();
  } catch {
    return;
  }
  for (const rec of out.records) {
    const id = idOf(rec.conversationId ?? rec.conversation_id);
    if (!id) continue;
    let item = places.history.get(id);
    if (!item) {
      if (places.history.size >= MAX_PLACES) places.history.delete(places.history.keys().next().value);
      item = { cwd: null, prompt: null };
      places.history.set(id, item);
    }
    // The newest line names the folder; the first prompt names the conversation.
    item.cwd = folderPath(rec.workspace) ?? item.cwd;
    const said = str(rec.display);
    if (item.prompt === null && said && !said.trimStart().startsWith('/')) item.prompt = flat(said, 120);
  }
}

// ---- reading a transcript ----

// Returns true when something new was read.
function refresh(entry) {
  try {
    const st = fs.statSync(entry.file);
    if (st.size === entry.size && st.mtimeMs === entry.mtimeMs) return false;
    readTail(entry, st.size);
    entry.size = st.size;
    entry.mtimeMs = st.mtimeMs;
    entry.version++;
    return true;
  } catch {
    // One unreadable transcript must not hide the others; try again on the next poll.
    return false;
  }
}

function readTail(entry, size) {
  if (entry.started && size - entry.tail.offset > CATCH_UP_BYTES) restart(entry);
  // A file written again in place keeps its name, and can grow past where Pleni stopped before
  // the next look. Only adding lines leaves the bytes before that place as they were.
  const rewritten = entry.started && !sameMark(entry.file, entry.mark);
  if (rewritten) entry.tail = new JsonlTail(entry.file, { maxInitialBytes: TAIL_BYTES });
  const out = entry.tail.read();
  const reset = out.reset || rewritten;
  if (reset) {
    // The file got smaller, was replaced or was written again: Antigravity CLI does that when it
    // squeezes old history into a checkpoint. What it holds now is read as new.
    entry.log = newLog();
    entry.head.steps = 0;
    entry.scanned = false;
  }
  if (reset || !entry.started) {
    entry.started = true;
    entry.fromStart = out.size <= TAIL_BYTES;
    if (!entry.fromStart) {
      entry.log.whole = false;
      if (!entry.scanned) scanBefore(entry, out.size - TAIL_BYTES);
    }
  }
  for (const rec of out.records) applyRecord(entry, rec);
  entry.mark = markAt(entry.file, entry.tail.offset);
}

// The last MARK_BYTES before `end`: { end, bytes }, or null when the file cannot be read.
function markAt(file, end) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const from = Math.max(0, end - MARK_BYTES);
    const bytes = Buffer.alloc(end - from); // not from the shared pool, which a small slice would keep alive
    return { end, bytes: bytes.subarray(0, fs.readSync(fd, bytes, 0, bytes.length, from)) };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// A file that cannot be read now is not taken as written again: the next look tries again.
function sameMark(file, mark) {
  if (!mark) return true;
  const now = markAt(file, mark.end);
  return now === null || now.bytes.equals(mark.bytes);
}

// Polls stop while nobody has the page open, and a busy transcript can grow a lot meanwhile.
// Rather than parse all of that in one go, start again near the end, as on the first read.
function restart(entry) {
  const old = entry.log;
  entry.log = { ...newLog(), seenAt: old.seenAt, firstAt: old.firstAt };
  entry.tail = new JsonlTail(entry.file, { maxInitialBytes: TAIL_BYTES });
  entry.started = false;
  entry.scanned = false;
}

function applyRecord(entry, rec) {
  const step = slimStep(rec, POLL_KEEP);
  if (!step) return;
  put(entry.log, step);
  if (entry.fromStart) noteHead(entry, step);
  noteFirst(entry, step);
  walkCalls(entry, step);
}

// The first request, and the reminder that tells a helper it is one and who started it, from steps
// read in order from the start of the file. A squeeze clears the first request of its words: the
// next request is not the first one, so `cut` says so. A forked helper's transcript starts with a
// copy of its parent's steps, reminder and all, so the last reminder that names a caller counts.
// A copied step keeps its time and its step_index, so those tell a copy from the original.
function noteHead(entry, step) {
  const head = entry.head;
  if (head.prompt === null && step.kind === 'prompt') {
    if (step.text) head.prompt = flat(step.text, 120);
    else if (step.status === 'CLEARED') head.cut = true;
  }
  if (head.steps >= HEAD_STEPS) return;
  head.steps++;
  if (step.reminder) {
    head.helper = true;
    if (step.caller) {
      head.caller = step.caller;
      head.callerAt = step.at;
      head.callerStep = step.index;
    }
  }
}

function noteFirst(entry, step) {
  if (step.at !== null && step.kind !== 'note' && (entry.firstAt === null || step.at < entry.firstAt)) entry.firstAt = step.at;
}

// A transcript read from near its end: its first steps give its first request, its start time and
// whether it is a helper, and the part before what was read gives the helpers it started. Each is
// looked for once.
function scanBefore(entry, end) {
  entry.scanned = true;
  for (const rec of scanHead(entry.file, Math.max(0, Math.min(HEAD_SCAN_BYTES, end)), null)) {
    const step = slimStep(rec, POLL_KEEP);
    if (!step) continue;
    noteHead(entry, step);
    noteFirst(entry, step);
  }
  scanCalls(entry, end);
}

// From the CALL_SCAN_BYTES before the part that is read, only the replies and INVOKE_SUBAGENT steps
// are taken, for the helpers those steps started and the roles their calls gave them. Only lines
// that hold one of those two words are parsed, and the parsed step decides: a tool's result may
// hold the words too. The part that is read starts after the line that runs on into it, so that
// line is read here, to its end, when it ends within CROSS_BYTES.
function scanCalls(entry, end) {
  const from = Math.max(0, end - CALL_SCAN_BYTES);
  if (end <= from) return;
  let fd;
  try {
    fd = fs.openSync(entry.file, 'r');
    // One byte more in front tells whether the first line is whole.
    const start = from === 0 ? 0 : from - 1;
    const data = readRange(fd, start, end - start + CROSS_BYTES);
    const stop = end - start; // a line that starts here or later is in the part that is read
    let pos = 0;
    if (from > 0) {
      const first = data.indexOf(NEWLINE);
      if (first === -1) return;
      pos = first + 1;
    }
    let nl;
    while (pos < stop && (nl = data.indexOf(NEWLINE, pos)) !== -1) {
      const line = data.subarray(pos, nl);
      pos = nl + 1;
      if (!line.includes(INVOKE_HINT) && !line.includes(REPLY_HINT)) continue;
      const step = slimStep(parseLine(line), POLL_KEEP);
      if (step) walkCalls(entry, step);
    }
  } catch {
    // The helpers are a bonus; the rest of the transcript is read without them.
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// The newest reply and how many INVOKE_SUBAGENT steps came after it, each step once, and where each
// reply and INVOKE_SUBAGENT step came, by step_index.
function newWalk() {
  return { reply: null, n: 0, replies: new Map(), starts: new Map() };
}

// Names the helpers of an INVOKE_SUBAGENT step, with the roles of the call it answers. Steps come in
// file order and are placed as the log places them: a step written again keeps the place of its
// first copy. So a reply written again keeps its place and gives its newer calls, and a helper's
// start written again answers the call that its first copy answered.
function walkCalls(entry, step) {
  const walk = entry.log.walk;
  const index = step.index;
  if (step.kind === 'reply') {
    const seen = index === null ? undefined : walk.replies.get(index);
    if (seen) {
      seen.calls = invokeCalls(step);
      return;
    }
    walk.reply = { calls: invokeCalls(step) };
    walk.n = 0;
    if (index !== null) remember(walk.replies, index, walk.reply);
  } else if (step.type === INVOKE) {
    let at = index === null ? undefined : walk.starts.get(index);
    if (!at) {
      at = { reply: walk.reply, n: walk.n++ };
      if (index !== null) remember(walk.starts, index, at);
    }
    if (step.children.length) addNamed(entry, step, at.reply?.calls ?? NONE, at.n);
  }
}

// Like the log, forgets the oldest past MAX_STEPS.
function remember(map, key, value) {
  map.set(key, value);
  if (map.size > MAX_STEPS) map.delete(map.keys().next().value);
}

// A step, or a newer copy of one with the same step_index: the newest copy wins, in the place the
// first one came.
function put(log, step) {
  const key = step.index !== null ? `s${step.index}` : `l${log.lines}`;
  log.lines++;
  touch(log, step);
  if (!log.byKey.has(key)) {
    log.order.push(key);
    if (log.order.length > MAX_STEPS) {
      log.byKey.delete(log.order.shift());
      log.whole = false;
    }
  }
  log.byKey.set(key, step);
}

// The newest and oldest step times seen. A step taken out later still happened.
function touch(log, step) {
  if (step.at === null || step.kind === 'note') return;
  if (log.seenAt === null || step.at > log.seenAt) log.seenAt = step.at;
  if (log.firstAt === null || step.at < log.firstAt) log.firstAt = step.at;
}

// ---- steps ----

// What Pleni keeps of a step: { step_index, source, type, status, created_at, content,
// tool_calls?, thinking? }. Words are cut short, tool results are kept only for the side panel,
// and the model's thinking is never kept: only the fact that it thought.
function slimStep(rec, keep) {
  if (!isObject(rec)) return null;
  const type = word(rec.type);
  if (!type) return null;
  const step = {
    index: Number.isSafeInteger(rec.step_index) && rec.step_index >= 0 ? rec.step_index : null,
    type,
    source: word(rec.source),
    status: word(rec.status) ?? 'DONE',
    kind: null,
    at: time(rec.created_at),
    model: modelOf(rec),
    text: null, // the person's request, or the reply's words
    result: null, // a tool's result, or an error's words (only for the side panel)
    calls: NONE,
    thought: false,
    reminder: false,
    caller: null, // the id a helper's reminder gives for the conversation that started it
    children: NONE,
  };
  step.kind = kindOf(step);
  const content = textOf(rec.content);
  if (step.kind === 'prompt') {
    step.text = keepText(requestText(content), keep.text);
    step.reminder = content !== null && content.includes(REMINDER);
  } else if (step.kind === 'reply') {
    step.text = keepText(content, keep.text);
    step.calls = callsOf(rec.tool_calls);
    step.thought = hasWords(rec.thinking);
  } else if (step.kind === 'note') {
    step.reminder = content !== null && content.includes(REMINDER);
  } else {
    if (keep.results) step.result = keepText(resultText(content), keep.text);
    if (type === INVOKE) step.children = childrenIn(content);
  }
  if (step.reminder) step.caller = callerIn(content);
  return step;
}

// The conversation that started a helper, from its <subagent_reminder>: the id on the line that
// names the caller agent ("id: …" or id="…"), as another reader of these files reads it, else the
// first id on any of its lines. Only the id is kept.
function callerIn(content) {
  const block = /<subagent_reminder>([\s\S]*?)(?:<\/subagent_reminder>|$)/.exec(content)?.[1] ?? '';
  const lines = block.split('\n');
  for (const text of [...lines.filter((l) => /caller/i.test(l)), ...lines]) {
    const id = idOf(LINE_ID.exec(text)?.[1]);
    if (id) return id;
  }
  return null;
}

// The person's prompt, the model's reply, an error, a step that keeps the books, or a tool's result.
function kindOf(step) {
  if (step.type === 'USER_INPUT') return 'prompt';
  if (step.type === 'PLANNER_RESPONSE') return 'reply';
  if (ERROR_TYPES.has(step.type)) return 'error';
  if (NOTES.has(step.type) || step.source === 'SYSTEM') return 'note';
  return 'tool';
}

// What the person typed: the words inside <USER_REQUEST>, else the text without the blocks
// Antigravity CLI adds.
function requestText(content) {
  if (typeof content !== 'string') return null;
  const tagged = /<USER_REQUEST>([\s\S]*?)(?:<\/USER_REQUEST>|$)/.exec(content);
  const text = tagged ? tagged[1] : withoutBlocks(content);
  return text.trim() || null;
}

// The text without the blocks Antigravity CLI adds, read once from the start. It first notes where
// each name is closed last, so an opening tag with no closing tag after it costs no search, and a
// long text with many of them is still quick.
function withoutBlocks(text) {
  const lastClose = new Map(); // tag name -> where its last closing tag starts
  for (const m of text.matchAll(BLOCK_CLOSE)) lastClose.set(m[1], m.index);
  const open = new RegExp(BLOCK_OPEN);
  let out = '';
  let kept = 0;
  let m;
  while ((m = open.exec(text)) !== null) {
    const name = m[2] ?? m[3];
    const closed = lastClose.get(name) >= open.lastIndex;
    if (!closed && !KNOWN_BLOCKS.includes(name)) continue;
    // A known block that is not closed runs on to the end, from its own '<'.
    const from = closed ? m.index : m.index + (m[1]?.length ?? 0);
    const end = closed ? text.indexOf(`</${name}>`, open.lastIndex) + name.length + 3 : text.length;
    out += text.slice(kept, from);
    kept = end;
    open.lastIndex = end;
  }
  return out + text.slice(kept);
}

function resultText(content) {
  if (typeof content !== 'string') return null;
  return content.replace(RESULT_TIMES, '').trim() || null;
}

// A transcript names no model so far. A line that does name one is believed.
function modelOf(rec) {
  for (const name of ['model', 'model_name', 'modelName']) {
    const value = isObject(rec[name]) ? rec[name].id ?? rec[name].name : rec[name];
    if (typeof value === 'string' && value.trim() && value.length <= 120) return value.trim();
  }
  return null;
}

// tool_calls: [{ name, args }]. `args` is an object, or JSON text of one, and each value in it may
// itself be JSON text ("\"npm test\"").
function callsOf(raw) {
  if (!Array.isArray(raw)) return NONE;
  const out = [];
  for (const call of raw) {
    if (out.length >= MAX_CALLS) break;
    if (!isObject(call)) continue;
    const args = argsOf(call.args ?? call.arguments);
    const name = flat(str(call.name), 80) ?? 'tool';
    out.push({ name, detail: toolDetail(args), roles: name === INVOKE_TOOL ? rolesOf(args) : NONE });
  }
  return out;
}

function argsOf(raw) {
  if (isObject(raw)) return raw;
  const value = typeof raw === 'string' ? parseJson(raw) : null;
  return isObject(value) ? value : null;
}

function argText(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    const inner = parseJson(text);
    if (typeof inner === 'string') return inner;
  }
  return value;
}

// Short words about what a tool call does (≤140 characters), from its arguments: the first line of
// a command, a search query or pattern, a file's base name, a web site's host name, a helper's role,
// the agent a message goes to, or the first question asked.
function toolDetail(args) {
  if (!args) return null;
  const get = (...names) => {
    for (const name of names) {
      const value = argText(args[name]);
      if (value && value.trim()) return value;
    }
    return null;
  };
  const text = firstLine(get('CommandLine', 'command'), 80)
    ?? flat(get('Query', 'query'), 140)
    ?? flat(get('Pattern', 'pattern'), 140)
    ?? baseName(get('AbsolutePath', 'TargetFile', 'DirectoryPath', 'SearchDirectory', 'SearchPath', 'ImageName'))
    ?? hostOf(get('Url', 'url'))
    ?? rolesOf(args).find(Boolean)
    ?? flat(get('Recipient'), 80)
    ?? firstQuestion(args);
  return text ? clip(text, 140) : null;
}

// The words of the first question of an ask_question call: `questions: [{ question, options }]`.
function firstQuestion(args) {
  let list = args.questions ?? args.Questions;
  if (typeof list === 'string') list = parseJson(argText(list));
  return Array.isArray(list) && isObject(list[0]) ? flat(argText(list[0].question), 140) : null;
}

// The role of each helper an invoke_subagent call asks for, in order.
function rolesOf(args) {
  let list = args?.Subagents ?? args?.subagents;
  if (typeof list === 'string') list = parseJson(argText(list));
  if (!Array.isArray(list)) return NONE;
  return list.slice(0, MAX_ROLES).map((spec) => (isObject(spec)
    ? flat(argText(spec.Role) ?? argText(spec.role) ?? argText(spec.TypeName) ?? argText(spec.typeName), 80)
    : null));
}

// The helpers an INVOKE_SUBAGENT step started, with the role each was given when the result says
// so. The ids come from where the result labels them: its JSON id fields, or the text right after
// a conversationId or conversation_id label. Only a result with no labeled id is searched for any
// conversation id, so an id that the helper's task only mentions makes no helper.
function childrenIn(content) {
  if (typeof content !== 'string' || !content) return NONE;
  const found = new Map();
  const body = resultText(content);
  if (body && /^[[{]/.test(body)) walkIds(parseJson(body), found, 0);
  for (const match of content.matchAll(LABELED_IDS)) addId(found, match[1]);
  if (!found.size) for (const match of content.matchAll(UUIDS)) addId(found, match[0]);
  return [...found].map(([id, role]) => ({ id, role }));
}

function addId(found, value) {
  const id = value.toLowerCase();
  if (found.size < MAX_CHILDREN && !found.has(id)) found.set(id, null);
}

function walkIds(value, found, depth) {
  if (depth > 6 || found.size >= MAX_CHILDREN || value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, MAX_CHILDREN)) walkIds(item, found, depth + 1);
    return;
  }
  const id = idOf(value.conversationId ?? value.conversation_id ?? value.ConversationId);
  if (id && !found.get(id)) {
    found.set(id, flat(str(value.role) ?? str(value.Role) ?? str(value.type_name) ?? str(value.TypeName), 80));
  }
  for (const item of Object.values(value)) walkIds(item, found, depth + 1);
}

// The helpers an INVOKE_SUBAGENT step names. One whose result gives no role takes the role that
// the call this step answers gave the helper in the same place: the n-th invoke_subagent call of
// the reply before it, where n counts the INVOKE_SUBAGENT steps in between.
function addNamed(entry, step, calls, n) {
  const kids = step.children.filter((child) => child.id !== entry.id);
  const roles = rolesFor(kids, calls, n);
  addFound(entry, kids.map((child, i) => ({ id: child.id, role: child.role ?? roles[i] ?? null })));
}

function invokeCalls(step) {
  return step.calls.filter((call) => call.name === INVOKE_TOOL);
}

// The roles by place: the answered call's own when there is one for each helper, else, for the
// first step after the reply, those of all its calls together (one result may name the helpers of
// several calls), else none.
function rolesFor(kids, calls, n) {
  const own = calls[n]?.roles ?? NONE;
  if (own.length === kids.length) return own;
  const all = n === 0 ? calls.flatMap((call) => call.roles) : NONE;
  return all.length === kids.length ? all : NONE;
}

function addFound(entry, children) {
  for (const { id, role } of children) {
    if (id === entry.id) continue;
    if (entry.children.has(id)) {
      if (role && !entry.children.get(id)) entry.children.set(id, role);
    } else if (entry.children.size < MAX_CHILDREN) {
      entry.children.set(id, role ?? null);
    }
  }
}

// ---- building sessions ----

// What the poll needs from a transcript, worked out again only when something new was read.
function factsOf(entry) {
  if (entry.facts && entry.factsVersion === entry.version) return entry.facts;
  const steps = stepsOf(entry.log);
  let talked = false;
  let model = null;
  let lastText = null;
  let prompt = null;
  for (const s of steps) {
    if (s.kind === 'note') continue;
    talked = true;
    if (s.model) model = s.model;
    if (s.kind === 'prompt' && prompt === null && s.text) prompt = flat(s.text, 120);
    if (s.kind === 'reply' && s.text) lastText = flat(s.text, 280);
  }
  const { pairs, waiting } = pairCalls(steps);
  entry.facts = {
    talked, // a conversation where nothing was said yet is left out
    turn: turnOf(steps),
    running: steps.filter((s) => s.kind !== 'note' && RUNNING.has(s.status)),
    current: steps.slice(steps.findLastIndex((s) => s.kind === 'prompt') + 1), // since the newest request
    pairs,
    waiting,
    model,
    lastText,
    prompt: entry.head.prompt ?? prompt,
    cut: entry.head.cut,
    lastAt: entry.log.seenAt,
    firstAt: entry.firstAt ?? entry.log.firstAt,
  };
  entry.factsVersion = entry.version;
  return entry.facts;
}

// Whether a turn is running, from the steps in order. The person's request starts one; a reply
// that calls tools, or is still being written, keeps it going, and so does each tool's result, which
// goes back to the model (a tool that failed too: the model sees the error and goes on). A reply
// with no tool calls ends the turn, a reply that failed or an error step ends it with an error, and
// a step that was stopped ends it.
function turnOf(steps) {
  const turn = { open: false, closedAt: null, ending: null };
  const go = () => {
    turn.open = true;
    turn.ending = null;
  };
  const close = (at, ending) => {
    turn.open = false;
    turn.ending = ending;
    if (at !== null) turn.closedAt = at;
  };
  for (const s of steps) {
    if (s.kind === 'note') continue;
    if (s.kind === 'prompt') go();
    else if (s.kind === 'error' || (s.kind === 'reply' && FAILED.has(s.status))) close(s.at, 'failed');
    else if (STOPPED.has(s.status)) close(s.at, 'cancelled');
    else if (s.kind === 'reply' && !s.calls.length && !RUNNING.has(s.status)) close(s.at, 'completed');
    else go();
  }
  return turn;
}

// Which call of the reply before it each tool's result answers: the first one still waiting with
// the same name (RUN_COMMAND answers run_command), else the first one still waiting. `waiting` is
// what is left of the newest reply's calls.
function pairCalls(steps) {
  const pairs = new Map();
  let waiting = [];
  for (const s of steps) {
    if (s.kind === 'prompt') waiting = [];
    else if (s.kind === 'reply') waiting = s.calls.map((call) => ({ call, at: s.at }));
    if (s.kind !== 'tool') continue;
    const type = squash(s.type);
    let i = waiting.findIndex((w) => sameTool(squash(w.call.name), type));
    if (i === -1 && waiting.length) i = 0;
    if (i === -1) continue;
    pairs.set(s, waiting[i].call);
    waiting.splice(i, 1);
  }
  return { pairs, waiting };
}

function squash(name) {
  return name.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function sameTool(a, b) {
  return a === b || (a.length >= 4 && b.length >= 4 && (a.startsWith(b) || b.startsWith(a)));
}

function toSession(entry, parents, chosen, places, t, w, snippets) {
  const f = factsOf(entry);
  const parentId = parents.get(entry.id) ?? null;
  const helper = parentId !== null || entry.head.helper;
  const role = parentId ? chosen.get(parentId).children.get(entry.id) ?? null : null;
  const title = titleOf(entry.id, role, f, places, snippets);
  return {
    platform: 'antigravity',
    key: keyOf(entry.id),
    id: entry.id,
    parentKey: parentId ? keyOf(parentId) : null,
    kind: helper ? 'agent' : 'session',
    spawned: helper, // started by the conversation above it; chain rules leave it there
    role: null,
    title: title.text,
    titleSource: title.source,
    cwd: cwdOf(entry.id, parents, places),
    branch: null,
    entrypoint: null,
    model: f.model,
    effort: null,
    startedAt: f.firstAt,
    lastAt: f.lastAt,
    status: statusOf(f, helper, t, w),
    activity: null, // set once the status of every session is known
    lastText: snippets ? f.lastText : null,
    needs: needsOf(f, snippets, t),
    links: [],
    archived: false,
  };
}

// A tool step of the turn going now that has waited longer than APPROVAL_GRACE_MS for the person to
// allow it, as an interactive run does, or to answer its question. A helper's start waits for the
// helper, not the person. It stays until the step is answered or the turn ends, however long that
// takes.
function needsOf(f, snippets, t) {
  if (!f.turn.open) return null;
  const s = f.current.findLast((x) => x.kind === 'tool' && x.type !== INVOKE && x.status === WAITING);
  if (!s || s.at === null || t - s.at <= APPROVAL_GRACE_MS) return null;
  const call = f.pairs.get(s) ?? null;
  const tool = call?.name ?? toolName(s.type);
  if (tool === ASK_TOOL || toolName(s.type) === ASK_TOOL) {
    return { kind: 'question', text: snippets && call?.name === ASK_TOOL ? call.detail : null, at: s.at };
  }
  const text = call?.detail ? `Asks to use ${tool}: ${call.detail}` : `Asks to use ${tool}`;
  return { kind: 'permission', text: snippets ? clip(text, 280) : null, at: s.at };
}

function keyOf(id) {
  return `antigravity:${id}`;
}

// A helper is named by the role it was given, else like a conversation: by the title Antigravity
// CLI gave it, its first request, or the first prompt in history.jsonl. When a squeeze cleared the
// first request's words, history.jsonl's first prompt comes before a later request. All are session
// text, so with snippets only.
function titleOf(id, role, f, places, snippets) {
  if (!snippets) return { text: null, source: null };
  if (role) return { text: role, source: 'role' };
  const summary = places.meta.get(id)?.title;
  if (summary) return { text: summary, source: 'summary' };
  const typed = places.history.get(id)?.prompt;
  if (typed && f.cut) return { text: typed, source: 'history' };
  if (f.prompt) return { text: f.prompt, source: 'first-prompt' };
  if (typed) return { text: typed, source: 'history' };
  return { text: null, source: null };
}

// The working folder, from the conversation metadata, else history.jsonl, else
// last_conversations.json. A helper with none takes the one of the conversation above it.
function cwdOf(id, parents, places) {
  const seen = new Set();
  for (let at = id; at && !seen.has(at); at = parents.get(at)) {
    seen.add(at);
    const own = places.meta.get(at)?.cwd ?? places.history.get(at)?.cwd ?? places.last.get(at) ?? null;
    if (own) return own;
  }
  return null;
}

// Who started whom. A helper whose reminder names the conversation that started it hangs under
// that one when it is shown: a fork copies its conversation's steps, so it names the same helpers
// again. Else the INVOKE_SUBAGENT steps of a conversation name its helpers, and a helper named by
// two conversations stays with the first by id. A link that would make a loop is left out.
function parentsOf(chosen) {
  const parents = new Map();
  const ids = [...chosen.keys()].sort();
  for (const id of ids) {
    const caller = callerOf(id, chosen);
    if (caller && !above(id, caller, parents)) parents.set(id, caller);
  }
  for (const id of ids) {
    for (const child of chosen.get(id).children.keys()) {
      if (child === id || !chosen.has(child) || parents.has(child) || above(child, id, parents)) continue;
      parents.set(child, id);
    }
  }
  return parents;
}

// The shown conversation a helper hangs under by its reminder. A forked helper whose own reminder
// came after its first 50 steps has only the copy of its parent's, and a copy keeps the time and the
// step_index of its step (times are often whole seconds, so the time alone is not enough). So when
// the conversation the id names does not name the helper, but conversations whose reminder is that
// same one (the same caller, time and step) do, the reminder is a copy: the helper hangs under the
// one of them that the named conversation started, which holds the original, else the steps decide.
// A helper's own reminder is believed, even when a sibling forked later names it in its copy of
// their caller's steps.
function callerOf(id, chosen) {
  const { caller, callerAt, callerStep } = chosen.get(id).head;
  if (!caller || caller === id || !chosen.has(caller)) return null;
  const top = chosen.get(caller);
  if (top.children.has(id)) return caller;
  if (callerAt === null && callerStep === null) return caller;
  let copied = false;
  for (const [other, entry] of chosen) {
    const { head } = entry;
    if (other === id || head.caller !== caller || head.callerAt !== callerAt || head.callerStep !== callerStep) continue;
    if (!entry.children.has(id)) continue;
    if (top.children.has(other)) return other;
    copied = true;
  }
  return copied ? null : caller;
}

// True when `a` is `b` or a conversation above it.
function above(a, b, parents) {
  const seen = new Set();
  for (let at = b; at && !seen.has(at); at = parents.get(at)) {
    if (at === a) return true;
    seen.add(at);
  }
  return false;
}

// A running step that is recent, or a turn still going while the transcript moved within
// staleMinutes, is working; a turn that went quiet longer is idle. A turn that ended with an error
// is an error; a helper whose turn ended is done; a turn that ended within activeMinutes is ready.
function statusOf(f, helper, t, w) {
  if (f.turn.open) return fresh(f.lastAt, t, w) ? 'working' : 'idle';
  if (f.running.some((s) => fresh(s.at ?? f.lastAt, t, w))) return 'working';
  if (f.turn.ending === 'failed') return 'error';
  if (helper && f.turn.closedAt !== null) return 'done';
  if (f.turn.closedAt !== null && t - f.turn.closedAt <= w.activeMinutes * MINUTE) return 'ready';
  return 'idle';
}

function fresh(at, t, w) {
  return at !== null && t - at <= w.staleMinutes * MINUTE;
}

// What the conversation does now: the newest tool still running in the turn going now, else the
// first call of the newest reply still waiting for its result, else a command that an earlier turn
// left running. A running step older than staleMinutes counts as gone, as in statusOf.
function activityOf(f, snippets, t, w) {
  const live = (s) => s.kind === 'tool' && RUNNING.has(s.status) && fresh(s.at ?? f.lastAt, t, w);
  const run = f.current.findLast(live);
  const next = f.turn.open ? f.waiting[0] : null;
  if (!run && next) return { tool: next.call.name, detail: snippets ? next.call.detail : null, at: next.at ?? f.lastAt ?? t };
  const step = run ?? f.running.findLast(live);
  if (!step) return null;
  const call = f.pairs.get(step) ?? null;
  return { tool: call?.name ?? toolName(step.type), detail: snippets ? call?.detail ?? null : null, at: step.at ?? f.lastAt ?? t };
}

function toolName(type) {
  return type.toLowerCase();
}

// A helper's start is work going down from the conversation that started it; its end is a report
// coming up. Links are kept by that conversation, like Claude Code's.
function linkHelpers(out, chosen, snippets) {
  const touched = new Set();
  for (const x of out.values()) {
    const parent = x.parentKey ? out.get(x.parentKey) : null;
    if (!parent || parent === x) continue;
    if (x.startedAt !== null) {
      parent.links.push({ at: x.startedAt, dir: 'down', other: x.key, label: snippets && x.title ? clip(x.title, 140) : null });
    }
    const endAt = x.status === 'done' || x.status === 'error' ? factsOf(chosen.get(x.id)).turn.closedAt ?? x.lastAt : null;
    if (endAt !== null) {
      parent.links.push({ at: endAt, dir: 'up', other: x.key, label: snippets && x.lastText ? clip(x.lastText, 140) : null });
    }
    touched.add(parent);
  }
  for (const parent of touched) {
    parent.links.sort((a, b) => a.at - b.at).splice(0, Math.max(0, parent.links.length - MAX_LINKS));
  }
}

// A conversation whose helper is working is working too, even when its own turn ended: helpers run
// on their own while it waits for them, and a helper can start helpers of its own. So "ready",
// "idle" and "done" are lifted, all the way up; an error still shows as it is.
function rollUpWorking(out) {
  for (const x of out.values()) {
    if (x.status !== 'working') continue;
    const seen = new Set([x.key]);
    let parent = x.parentKey ? out.get(x.parentKey) : null;
    while (parent && !seen.has(parent.key) && LIFTED.has(parent.status)) {
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

// The side panel's events, from the last DETAIL_BYTES of the transcript. Antigravity CLI writes a
// step again when it changes, and writes the whole file again when it squeezes old history, so
// every answer is the whole recent list (`reset: true`, which the page shows in place of what it
// had). When the file has not changed size since `since`, the answer holds no events.
function readDetail(entry, since, snippets) {
  if (since !== null && since === fs.statSync(entry.file).size) return { events: [], next: since };
  const { records, next } = readFrom(entry.file);
  const log = newLog();
  for (const rec of records) {
    const step = slimStep(rec, DETAIL_KEEP);
    if (step) put(log, step);
  }
  return { events: eventsOf(stepsOf(log), snippets), next, reset: true };
}

// Reads complete lines of the last DETAIL_BYTES. If the file grows between the size check and the
// read, the window would shift, so try again.
function readFrom(file) {
  for (let attempt = 1; ; attempt++) {
    const size = fs.statSync(file).size;
    const from = Math.max(0, size - DETAIL_BYTES);
    const tail = new JsonlTail(file, { maxInitialBytes: size - from });
    const out = tail.read();
    if (out.size === size || attempt >= 3) return { records: out.records, next: tail.offset };
  }
}

// The person's requests (and the work a helper was given), replies, tool calls and their results,
// and errors, oldest first. Thinking shows only as the fact that the model thought, never its words.
// A step without a time takes the time of the one before it.
function eventsOf(steps, snippets) {
  let events = [];
  let last = null;
  const { pairs } = pairCalls(steps);
  const push = (at, kind, tool, text) => {
    const when = at ?? last;
    if (when === null) return;
    last = when;
    events.push({ at: when, kind, tool, text: snippets && kind !== 'thinking' ? clipBlock(text, 2000) : null });
  };
  for (const s of steps) {
    if (s.kind === 'prompt') {
      if (s.text) push(s.at, 'user', null, s.text);
    } else if (s.kind === 'reply') {
      if (s.thought) push(s.at, 'thinking', null, null);
      if (s.text) push(s.at, 'assistant', null, s.text);
      for (const call of s.calls) push(s.at, 'tool', call.name, call.detail);
      if (FAILED.has(s.status)) push(s.at, 'error', null, 'Antigravity CLI stopped with an error.');
      else if (STOPPED.has(s.status)) push(s.at, 'error', null, 'Stopped');
    } else if (s.kind === 'error') {
      push(s.at, 'error', null, s.result ?? 'Antigravity CLI stopped with an error.');
    } else if (s.kind === 'tool' && !RUNNING.has(s.status) && s.status !== 'CLEARED') {
      const tool = pairs.get(s)?.name ?? toolName(s.type);
      if (FAILED.has(s.status)) push(s.at, 'error', tool, s.result ?? 'The tool failed.');
      else if (STOPPED.has(s.status)) push(s.at, 'error', tool, 'Stopped');
      else push(s.at, 'result', tool, s.result);
    }
    if (events.length > MAX_EVENTS * 4) events = events.slice(-MAX_EVENTS);
  }
  return events.slice(-MAX_EVENTS);
}

function stepsOf(log) {
  return log.order.map((key) => log.byKey.get(key));
}

function cursorOf(since) {
  if (typeof since === 'number' && Number.isSafeInteger(since) && since >= 0) return since;
  if (typeof since === 'string' && /^\d{1,15}$/.test(since)) return Number(since);
  return null;
}

// ---- text helpers ----

// `content` is text; anything else is read as a list of { text } parts, skipping any marked as thought.
function textOf(content) {
  if (typeof content === 'string') return content;
  const list = Array.isArray(content) ? content : isObject(content) ? [content] : [];
  const text = list
    .map((part) => (typeof part === 'string' ? part : isObject(part) && part.thought !== true && typeof part.text === 'string' ? part.text : ''))
    .filter(Boolean)
    .join('\n');
  return text || null;
}

function hasWords(value) {
  if (typeof value === 'string') return /\S/.test(value);
  if (Array.isArray(value)) return value.length > 0;
  return isObject(value);
}

// The start of a text, for later clipping; null when empty.
function keepText(text, max) {
  if (typeof text !== 'string' || !text.trim()) return null;
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : trimmed.slice(0, max).replace(/[\uD800-\uDBFF]$/, '');
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

// A full folder path, for Linux, macOS or Windows, without a slash at its end; anything else is null.
function folderPath(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text || text.length > MAX_PATH || CONTROL.test(text)) return null;
  if (!text.startsWith('/') && !WINDOWS_PATH.test(text)) return null;
  const clean = normalizePath(text);
  return /^(?:[a-z]:)?[\\/]$/i.test(clean) ? clean : clean.replace(/[\\/]+$/, '') || clean;
}

// file:///home/ada/old%20project is /home/ada/old project, file:///C:/Users/ada/project is
// C:\Users\ada\project, and file://server/share is \\server\share.
function folderFromUri(value) {
  if (typeof value !== 'string') return null;
  const match = /^file:\/\/([^/]*)(\/[^?#]*)?$/i.exec(value.trim());
  if (!match) return null;
  let folder;
  try {
    folder = decodeURIComponent(match[2] ?? '/');
  } catch {
    return null;
  }
  const host = match[1].toLowerCase();
  if (host && host !== 'localhost') folder = `\\\\${host}${folder.replace(/\//g, '\\')}`;
  else if (/^\/[a-z]:(?:[\\/]|$)/i.test(folder)) folder = folder.slice(1).replace(/\//g, '\\');
  return folderPath(folder);
}

// ---- small helpers ----

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
  return parseJson(stripBom(buf.toString('utf8', 0, end)));
}

function parseJson(text) {
  if (typeof text !== 'string') return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// Conversation ids are UUIDs: they must fit Pleni's node keys.
function idOf(value) {
  if (typeof value !== 'string') return null;
  const id = value.trim().toLowerCase();
  return ID.test(id) ? id : null;
}

// Antigravity CLI writes its types and statuses in capitals; an older form puts CORTEX_STEP_TYPE_
// (or _STATUS_, _SOURCE_) in front.
function word(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  return value.trim().toUpperCase().replace(/^CORTEX_STEP_(?:TYPE|STATUS|SOURCE)_/, '');
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

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
