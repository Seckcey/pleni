// Optional coordination mailbox: a planner and a coordinator trade Markdown files in task folders.
// Read-only. A file is read again only when its size or change times move.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readJsonFile, stripBom } from '../jsonl.js';

const LIST_MS = 10_000;            // folder listings refresh on this slower timer
const MAX_EVENTS = 300;
const MAX_TITLE = 120;
const MAX_TEXT_BYTES = 4 * 1024 * 1024;
const MAX_LOCK_BYTES = 64 * 1024;
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;
const SESSION_ID = /^[0-9a-f-]{8,64}$/;
const RUN_FILE = /^(W\d{1,6})\.run\.json$/;
const REPORT_FILE = /^(W\d{1,6})-report\.md$/;
// Notes for the person, kept at the mailbox root: NEEDS-<NAME>.md (NEEDS-ADA.md, NEEDS-OWNER.md).
const NOTES_FILE = /^NEEDS-[A-Za-z0-9][A-Za-z0-9_-]{0,60}\.md$/;
const MAX_NOTE = 300;
const ROOT_FILES = [['QUEUE.md', 'down'], ['CODEX-QUEUE.md', 'down'], ['STATUS.md', 'up']];
const TASK_FILES = [
  ['assignment.md', 'down'],
  ['answers.md', 'down'],
  ['review.md', 'down'],
  ['status.md', 'up'],
  ['questions.md', 'up'],
  ['handoff.md', 'up'],
];
// Finished states. A state that starts with one of them, such as DONE_PR, is finished too.
const CLOSED = /^(DONE|CANCELL?ED|COMPLETED?|NO_CLAUDE_DISPATCH)(_|$)/;
const ORDER = new Intl.Collator('en', { numeric: true });

// Agent mail (relay/bin/agent-mail.ps1): mail/<name key>/new/ holds an agent's unread messages and
// mail/<name key>/read/ the ones it has read. A message is one file, <UTC time>-<sender's key>-<6 hex>.md,
// that never changes once it is there; reading it only moves it to read/ (with "-<4 hex>" added when
// the name is taken). The sender's key is the sender's name in small letters, other marks as '-'.
const MAIL_AGENT = /^[a-z0-9][a-z0-9-]{0,99}$/;
const MAIL_FILE = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-(\d{3})-([a-z0-9-]{1,100}?)-[0-9a-f]{6}(?:-[0-9a-f]{4})?\.md$/;
const HEAD_LINE = /^([A-Za-z][A-Za-z-]{0,30}):[ \t]*(.*)$/;
const MAX_MAIL_AGENTS = 50;
const MAX_MAIL_NEW = 100;      // unread messages read for each agent; all of them are counted
const MAX_MAIL_READ = 30;      // the newest read messages kept for each agent
const MAX_MAIL_MESSAGES = 300;
const MAX_MAIL_BYTES = 80 * 1024; // agent-mail.ps1 sends at most 64 KB of text
const MAX_MAIL_TEXT = 1000;    // the model makes a short snippet of it
const MAX_MAIL_NAME = 80;
const MAX_NAME_BYTES = 1024;

// The `s` flag lets a heading or state line hold U+2028 or U+2029 (lines are already split on \n).
const HEADING = /^ {0,3}(#{1,6})[ \t]+(.+)$/s;
// A note is a heading or a top-level list item; an item indented two or more spaces belongs to the one above.
const NOTE_LINE = /^(?: {0,3}#{1,3}| ?[-*+])[ \t]+(.+)$/s;
const FENCE_OPEN = /^ {0,3}(`{3,}(?=[^`]*$)|~{3,})/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
const STATE_LINE = /^\s*(?:[-*+]\s+)?\*\*Current state:?\*\*:?\s*(.*)$/is;
const QUESTION = /^\W*Q\s*-?(\d+)\b/i;
const ANSWER_REF = /\b[QA]\s*-?(\d+)\b/gi;
const BLOCKING = /(?<!non[-_ ]?)\bblocking\b/i;
const EDGE_MARKS = new Set([...'*|·:,—–']);
const WRAPPERS = { '[': ']', '(': ')', '`': '`', '*': '*', _: '_' };

// A zone word after a local time is ignored ("Pacific", "PDT", ...); UTC and GMT mean offset 0.
const ZONE_WORD = String.raw`(?:Pacific|Eastern|Central|Mountain|Atlantic|Alaska|Hawaii)` +
  String.raw`(?:[ \t]+(?:Standard|Daylight))?(?:[ \t]+Time)?|(?:[ECMP]|AK|H)[SD]?T|BST|CES?T|IST|JST|AE[SD]T`;
// A minus offset needs the ISO "T" or seconds before it: "10:00-11:00" is a time range, not a zone.
const MINUS_OFFSET = String.raw`(?<=T\d{1,2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?|\d:\d{2}:\d{2}(?:[.,]\d+)?)-\d{2}(?::?\d{2})?`;
const STAMP = new RegExp(
  String.raw`(?<!\d)(\d{4})-(\d{2})-(\d{2})(?:T|[ \t]+)(\d{1,2}):(\d{2})(?::(\d{2})(?:[.,](\d+))?)?(?!\d)` +
    String.raw`(?:[ \t]*([AaPp])\.?[Mm]\.?(?!\w))?` +
    String.raw`(?:(Z|\+\d{2}(?::?\d{2})?|${MINUS_OFFSET})(?![\w:]))?` +
    String.raw`(?:[ \t]*\(?(?:(UTC|GMT)|${ZONE_WORD})\)?(?!\w))?`,
  'g',
);

export function createMailboxSource({ root = null, settings = null, now = Date.now } = {}) {
  const files = createFileCache();
  const relayFiles = createFileCache();
  const mail = typeof root === 'string' && root ? createMailReader(root, now) : null;
  // A folder at a drive root has no base name; use the whole path then.
  const name = typeof root === 'string' && root ? path.basename(root) || root : null;
  let listing = null;
  let noteFiles = [];
  let listingKey = '';
  let listedAt = 0;
  let reads = new Map();
  let built = null;

  function poll() {
    try {
      return scan();
    } catch (err) {
      built = null; // the file cache may have moved on before the throw; rebuild next time
      return failure(`Pleni could not read the mailbox folder (${err?.code || 'unknown problem'}).`);
    }
  }

  function failure(error) {
    return { ok: false, error, root, name, tasks: [], events: [], notes: [], relay: null, mail: null };
  }

  function scan() {
    if (!name) return failure('No mailbox folder is set.');
    if (!isDir(root)) return failure('Pleni could not find the mailbox folder.');
    files.changed = false;
    const t = now();
    const relist = listing === null || t - listedAt >= LIST_MS || t < listedAt;
    let listChanged = false;
    if (relist) {
      listing = listTasks(root);
      noteFiles = listNotes(root);
      listedAt = t;
      const key = JSON.stringify([listing, noteFiles]);
      listChanged = key !== listingKey;
      listingKey = key;
      files.prune(expectedFiles(root, listing, noteFiles));
    }
    const rootDocs = ROOT_FILES.map(([file, dir]) => ({ file, dir, doc: files.get(path.join(root, file), readMarkdown) }));
    const next = new Map();
    for (const task of listing) {
      const prev = reads.get(task.id);
      // Finished tasks rarely change, so they are checked again only when the listing refreshes.
      const keep = !relist && prev && isClosed(prev.docs['status.md']?.state);
      next.set(task.id, keep ? prev : readTask(task));
    }
    reads = next;
    const hide = settings?.content === 'none';
    if (!built || files.changed || listChanged || built.hide !== hide) {
      built = { ...buildState(rootDocs, [...reads.values()], hide), hide };
    }
    const notes = [];
    for (const file of noteFiles) {
      const doc = files.get(path.join(root, file), readNotes);
      if (doc) notes.push({ file, count: doc.count, at: doc.at, text: hide ? null : doc.text });
    }
    return {
      ok: true, error: null, root, name, tasks: built.tasks, events: built.events, notes,
      relay: readRelay(hide), mail: mail.read(hide),
    };
  }

  function readTask({ id, workers }) {
    const dir = path.join(root, 'tasks', id);
    const docs = {};
    for (const [file] of TASK_FILES) docs[file] = files.get(path.join(dir, file), readMarkdown);
    const runs = workers.map((worker) => ({
      id: worker,
      run: files.get(runFile(dir, worker), readRun),
      report: files.get(reportFile(dir, worker), readMarkdown),
    }));
    return { id, docs, workers: runs };
  }

  function readRelay(hide) {
    const dir = path.join(root, '.relay');
    if (!isDir(dir)) return null;
    const coordinator = relayFiles.get(path.join(dir, 'coordinator.json'), readJson);
    const state = relayFiles.get(path.join(dir, 'state.json'), readJson);
    const lock = relayFiles.get(path.join(dir, 'relay.lock'), readLock);
    const alerts = relayFiles.get(path.join(dir, 'alerts.md'), readNotes);
    // The relay writes the reason it halted into state.json ("halt"); it stays until -ClearHalt.
    const halt = typeof state?.halt === 'string' && state.halt.trim() ? state.halt : null;
    return {
      running: isRunning(lock),
      paused: exists(path.join(dir, 'PAUSE')) || state?.paused === true,
      halted: exists(path.join(dir, 'STOP')) || state?.halted === true || halt !== null,
      coordinatorKey: coordinatorKeyOf(coordinator),
      // A running relay saves state.json every few seconds, so its time says when it last ran.
      lastAt: statFile(path.join(dir, 'state.json'))?.mtimeMs ?? null,
      pausedAt: statFile(path.join(dir, 'PAUSE'))?.mtimeMs ?? null,
      haltReason: hide ? null : shortText(halt, MAX_NOTE),
      alerts: alerts ? { count: alerts.count, at: alerts.at, text: hide ? null : alerts.text } : null,
    };
  }

  return { poll };
}

// Finds the first valid time stamp in `text`: { at, index, length } or null.
export function parseStamp(text) {
  if (typeof text !== 'string') return null;
  for (const m of text.matchAll(STAMP)) {
    const [, y, mo, d, h, mi, s = '0', frac = '', half, offset, utcWord] = m;
    const zone = offset ? offsetMinutes(offset) : utcWord ? 0 : null;
    if (Number.isNaN(zone)) continue;
    const ms = Number(frac.padEnd(3, '0').slice(0, 3));
    const at = toTime(+y, +mo, +d, hour24(+h, half), +mi, +s, ms, zone);
    if (at === null) continue;
    let index = m.index;
    let end = m.index + m[0].length;
    while (index > 0 && end < text.length && WRAPPERS[text[index - 1]] === text[end]) {
      index--;
      end++;
    }
    return { at, index, length: end - index };
  }
  return null;
}

// ---- building the state ----

function buildState(rootDocs, taskReads, hide) {
  const events = [];
  for (const { file, dir, doc } of rootDocs) addEvents(events, doc, dir, null, file, hide);
  const tasks = taskReads.map((read) => buildTask(read, events, hide));
  const order = events.map((event, i) => [event, i]);
  order.sort(([a, i], [b, j]) => b.at - a.at || j - i);
  return { tasks, events: order.slice(0, MAX_EVENTS).map(([event]) => event) };
}

function buildTask({ id, docs, workers }, events, hide) {
  const base = `tasks/${id}/`;
  let updatedAt = null;
  for (const [file, dir] of TASK_FILES) {
    addEvents(events, docs[file], dir, id, base + file, hide);
    updatedAt = later(updatedAt, newestIn(docs[file]));
  }
  for (const worker of workers) {
    addEvents(events, worker.report, 'up', id, `${base}workers/${worker.id}-report.md`, hide);
    updatedAt = later(later(updatedAt, newestIn(worker.report)), worker.run?.mtimeMs ?? null);
  }
  const state = docs['status.md']?.state ?? null;
  return {
    id,
    title: taskTitle(id, docs['assignment.md'], hide),
    state,
    updatedAt,
    attention: attentionFor(state, docs),
    workers: workers.map(({ id: workerId, run }) => ({
      id: workerId,
      state: run?.state ?? null,
      model: run?.model ?? null,
      startedAt: run?.startedAt ?? null,
      finishedAt: run?.finishedAt ?? null,
      worktree: run?.worktree ?? null,
      sessionId: run?.sessionId ?? null,
    })),
  };
}

function addEvents(events, doc, dir, taskId, file, hide) {
  if (!doc) return;
  for (const entry of doc.entries) {
    events.push({ at: entry.at, dir, taskId, file, title: hide ? null : entry.title });
  }
}

function taskTitle(id, assignment, hide) {
  const heading = assignment?.headings[0];
  if (hide || !heading) return id;
  return clip(heading.text, MAX_TITLE) || id;
}

function attentionFor(state, docs) {
  if (isClosed(state)) return [];
  const attention = [];
  if (hasOpenQuestion(docs['questions.md'], docs['answers.md'])) attention.push('question');
  if (state === 'IN_REVIEW') {
    const handoff = latestEntry(docs['handoff.md']);
    const review = latestEntry(docs['review.md']);
    if (handoff !== null && (review === null || handoff > review)) attention.push('review');
  }
  return attention;
}

// A BLOCKING question is open until an answers.md heading names it (Q<n> or A<n>).
function hasOpenQuestion(questions, answers) {
  if (!questions) return false;
  const answered = new Set();
  for (const heading of answers?.headings ?? []) {
    for (const m of heading.text.matchAll(ANSWER_REF)) answered.add(Number(m[1]));
  }
  return questions.headings.some((heading) => {
    const q = QUESTION.exec(heading.text);
    return q !== null && BLOCKING.test(heading.text) && !answered.has(Number(q[1]));
  });
}

function newestIn(doc) {
  if (!doc) return null;
  return doc.entries.reduce((max, entry) => Math.max(max, entry.at), doc.mtimeMs);
}

// The newest time stamped entry, else the file's modified time.
function latestEntry(doc) {
  if (!doc) return null;
  if (doc.entries.length === 0) return doc.mtimeMs;
  return doc.entries.reduce((max, entry) => Math.max(max, entry.at), -Infinity);
}

function later(a, b) {
  if (a === null) return b;
  if (b === null) return a;
  return Math.max(a, b);
}

// ---- Markdown ----

function readMarkdown(file, st) {
  const text = readText(file, st.size, MAX_TEXT_BYTES);
  return text === null ? undefined : { mtimeMs: st.mtimeMs, ...parseMarkdown(text) };
}

// A list of time-stamped notes, newest last: the relay's alerts.md ("- 2026-10-12 14:03 - text") or a
// NEEDS-<NAME>.md ("- 2026-10-12 14:03 — **text**"). Each top-level list item or heading that starts
// with a time is one note. Keeps how many there are and the newest one.
function readNotes(file, st) {
  const text = readText(file, st.size, MAX_TEXT_BYTES);
  if (text === null) return undefined;
  let count = 0;
  let newest = null;
  let fence = null;
  for (const raw of text.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (fence) {
      if (closesFence(line, fence)) fence = null;
      continue;
    }
    const open = FENCE_OPEN.exec(line);
    if (open) {
      fence = open[1];
      continue;
    }
    const m = NOTE_LINE.exec(line);
    if (!m) continue;
    const stamp = parseStamp(m[1]);
    // The time must lead the note ("**2026-10-12 14:03**" is fine); a time later in a line is not a note.
    if (!stamp || stamp.index > 3) continue;
    count++;
    if (newest === null || stamp.at >= newest.at) newest = { at: stamp.at, text: noteText(m[1], stamp) };
  }
  return { count, at: newest?.at ?? null, text: newest?.text ?? null };
}

function noteText(line, stamp) {
  const rest = trimEdges(line.slice(stamp.index + stamp.length)).replace(/\*\*|__/g, '');
  return clip(rest, MAX_NOTE) || null;
}

function parseMarkdown(text) {
  const headings = [];
  const entries = [];
  let state = null;
  let fence = null; // the opening run of a code block, such as '```' or '~~~~'
  for (const raw of text.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (fence) {
      if (closesFence(line, fence)) fence = null;
      continue;
    }
    const open = FENCE_OPEN.exec(line);
    if (open) {
      fence = open[1];
      continue;
    }
    const h = HEADING.exec(line);
    if (h) {
      const level = h[1].length;
      const headingText = withoutClosingHashes(h[2]).replace(/[\s\p{Cc}]+/gu, ' ').trim();
      if (!headingText) continue;
      headings.push({ level, text: headingText });
      const stamp = level === 2 || level === 3 ? parseStamp(headingText) : null;
      if (stamp) entries.push({ at: stamp.at, title: withoutStamp(headingText, stamp) });
      continue;
    }
    if (state === null) {
      const m = STATE_LINE.exec(line);
      if (m) state = stateWord(m[1]);
    }
  }
  return { headings, entries, state };
}

// A code block ends only on a bare run of the same mark that is at least as long as the opening.
function closesFence(line, fence) {
  const m = FENCE_CLOSE.exec(line);
  return m !== null && m[1][0] === fence[0] && m[1].length >= fence.length;
}

// Drops an optional closing run of '#' ("## Title ##"). A loop, because a regex here is slow on long lines.
function withoutClosingHashes(text) {
  let end = text.length;
  while (end > 0 && (text[end - 1] === ' ' || text[end - 1] === '\t')) end--;
  let start = end;
  while (start > 0 && text[start - 1] === '#') start--;
  if (start < end && start > 0 && (text[start - 1] === ' ' || text[start - 1] === '\t')) end = start;
  return text.slice(0, end);
}

function withoutStamp(text, stamp) {
  const parts = [text.slice(0, stamp.index), text.slice(stamp.index + stamp.length)]
    .map(trimEdges)
    .filter(Boolean);
  return parts.length ? clip(parts.join(' — '), MAX_TITLE) : null;
}

// Trims spaces and separator marks (— | : * ...) from both ends. A dash counts only when it stands
// apart, so "-11:00" keeps its sign. A loop, because a regex here is slow on long headings.
function trimEdges(text) {
  const space = (i) => i >= 0 && i < text.length && /\s/.test(text[i]);
  const mark = (i) => space(i) || EDGE_MARKS.has(text[i]);
  let start = 0;
  let end = text.length;
  while (start < end && (mark(start) || (text[start] === '-' && (start + 1 === text.length || space(start + 1))))) start++;
  while (end > start && (mark(end - 1) || (text[end - 1] === '-' && (end === 1 || space(end - 2))))) end--;
  return text.slice(start, end);
}

// The leading run of capital words, so "NO CLAUDE DISPATCH — reason" is NO_CLAUDE_DISPATCH, not NO.
// A state written in small letters ("done") is its first word.
function stateWord(value) {
  const caps = /^[\s`*_]*([A-Z][A-Z0-9_-]*(?:[ \t]+[A-Z][A-Z0-9_-]+)*)(?![A-Za-z0-9])/.exec(value);
  const m = caps ?? /^[\s`*_]*([A-Za-z][A-Za-z0-9_-]*)/.exec(value);
  return m ? m[1].toUpperCase().replace(/[ \t]+|-/g, '_').slice(0, 40) : null;
}

function isClosed(state) {
  return typeof state === 'string' && CLOSED.test(state);
}

function clip(text, max) {
  const flat = String(text).replace(/[\s\p{Cc}]+/gu, ' ').trim();
  const chars = Array.from(flat);
  return chars.length <= max ? flat : `${chars.slice(0, max - 1).join('').trimEnd()}…`;
}

// ---- time ----

function offsetMinutes(offset) {
  if (offset === 'Z') return 0;
  const m = /^([+-])(\d{2}):?(\d{2})?$/.exec(offset);
  const hours = Number(m[2]);
  const minutes = Number(m[3] ?? 0);
  if (hours > 23 || minutes > 59) return Number.NaN;
  return (m[1] === '-' ? -1 : 1) * (hours * 60 + minutes);
}

// "3:45 PM" is 15:45. An AM/PM word after a 24-hour time such as "13:00" is left alone.
function hour24(hour, half) {
  if (!half || hour < 1 || hour > 12) return hour;
  return (hour % 12) + (half.toLowerCase() === 'p' ? 12 : 0);
}

// `zone` is minutes east of UTC, or null for this computer's local time.
function toTime(y, mo, d, h, mi, s, ms, zone) {
  if (y < 1000 || mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return null;
  if (zone === null) {
    const local = new Date(y, mo - 1, d, h, mi, s, ms);
    return local.getMonth() === mo - 1 && local.getDate() === d ? local.getTime() : null;
  }
  const utc = new Date(Date.UTC(y, mo - 1, d, h, mi, s, ms));
  return utc.getUTCMonth() === mo - 1 && utc.getUTCDate() === d ? utc.getTime() - zone * 60_000 : null;
}

function toMillis(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value < 1e11 ? Math.round(value * 1000) : Math.round(value); // seconds or milliseconds
  }
  if (typeof value !== 'string') return null;
  const stamp = parseStamp(value);
  if (stamp) return stamp.at;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

// ---- workers and relay ----

function readRun(file, st) {
  const run = readJsonFile(file) ?? {};
  // Relays write "started", "finished" and "models"; other spellings are kept for other tools.
  const models = Array.isArray(run.models) ? run.models.find((m) => typeof m === 'string') : run.models;
  return {
    mtimeMs: st.mtimeMs,
    state: shortText(run.state ?? run.status, 40),
    model: shortText(run.model ?? models, 80),
    startedAt: toMillis(run.startedAt ?? run.started_at ?? run.started),
    finishedAt: toMillis(run.finishedAt ?? run.finished_at ?? run.finished ?? run.endedAt ?? run.ended_at),
    worktree: typeof run.worktree === 'string' && run.worktree.trim() ? run.worktree.trim().slice(0, 4096) : null,
    sessionId: sessionIdOf(run.session_id ?? run.sessionId),
  };
}

// The Claude Code session a worker ran in, when its launcher saved one.
function sessionIdOf(value) {
  const id = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return SESSION_ID.test(id) ? id : null;
}

// The cache passes a stat as the second argument; readJsonFile would take it as a size limit.
function readJson(file) {
  return readJsonFile(file);
}

function readLock(file, st) {
  if (st.size > MAX_LOCK_BYTES) return null;
  const text = readText(file, st.size, MAX_LOCK_BYTES);
  return text === null ? undefined : parseLock(text);
}

// relay.lock holds a process id: as JSON ({ pid, host? }), a bare number, or a "pid=<n>" line.
function parseLock(text) {
  try {
    const value = JSON.parse(text);
    if (value !== null && typeof value === 'object') {
      return { pid: toPid(value.pid), host: shortText(value.host ?? value.hostname, 253) };
    }
    return { pid: toPid(value), host: null };
  } catch {
    const m = /^\s*(?:pid\s*[:=]\s*)?(\d{1,10})\s*$/im.exec(text);
    return { pid: m ? toPid(Number(m[1])) : null, host: null };
  }
}

function toPid(value) {
  const pid = typeof value === 'string' && /^\d{1,10}$/.test(value.trim()) ? Number(value) : value;
  return Number.isSafeInteger(pid) && pid > 0 && pid <= 0x7fffffff ? pid : null;
}

function isRunning(lock) {
  if (!lock?.pid) return false;
  // A process id from another computer cannot be checked from here.
  if (lock.host && shortHost(lock.host) !== shortHost(os.hostname())) return false;
  try {
    process.kill(lock.pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM'; // it exists but belongs to another user
  }
}

function shortHost(host) {
  return String(host).trim().toLowerCase().split('.')[0];
}

function coordinatorKeyOf(coordinator) {
  const id = typeof coordinator?.session_id === 'string' ? coordinator.session_id.trim().toLowerCase() : '';
  return SESSION_ID.test(id) ? `claude:${id}` : null;
}

function shortText(value, max) {
  if (typeof value !== 'string') return null;
  return clip(value, max) || null;
}

// ---- agent mail ----

// Reads mail/ for the page: { owner, agents, messages }, or null when the mailbox has no mail folder.
// A message file never changes, so each one is read once. Each agent's new/ is listed on every poll;
// other folders when their own times move, when a message left new/, and at least every LIST_MS.
function createMailReader(root, now) {
  const dir = path.join(root, 'mail');
  const settingsFiles = createFileCache();
  const names = createFileCache();
  const listings = new Map(); // folder -> { sig, at, entries }
  const messages = new Map(); // file -> message

  function read(hide) {
    if (!isDir(dir)) {
      listings.clear();
      messages.clear();
      return null;
    }
    const t = now();
    const seenFolders = new Set();
    const seenFiles = new Set();
    const list = (folder, kind, force = false) => {
      seenFolders.add(folder);
      return listFolder(folder, kind, t, force);
    };
    const enrolled = enrolledAgents(settingsFiles.get(path.join(root, '.relay', 'agents.json'), readJson));
    const owner = shortText(settingsFiles.get(path.join(root, 'bin', 'relay-settings.json'), readJson)?.owner_name, MAX_MAIL_NAME);
    const keys = new Set(list(dir, 'dirs').filter((key) => MAIL_AGENT.test(key)));
    for (const key of enrolled.keys()) keys.add(key);
    const agents = [];
    const unread = [];
    const done = [];
    for (const key of [...keys].sort(ORDER.compare).slice(0, MAX_MAIL_AGENTS)) {
      const base = path.join(dir, key);
      // new/ is small and is listed on every poll. A message that left it was read, so read/ is
      // listed again too: a folder's times can stay the same for a while after a change (Windows).
      const newDir = path.join(base, 'new');
      const before = listings.get(newDir)?.entries ?? [];
      const fresh = list(newDir, 'mail', true);
      const still = new Set(fresh);
      const old = list(path.join(base, 'read'), 'mail', before.some((file) => !still.has(file)));
      const nameFile = path.join(base, 'name.txt');
      seenFiles.add(nameFile);
      const wakes = enrolled.get(key);
      agents.push({
        key,
        name: names.get(nameFile, readName) ?? wakes?.name ?? null,
        unread: fresh.length,
        since: fresh.length ? fileTime(fresh[0]) : null,
        wakes: Boolean(wakes),
        threadId: wakes?.threadId ?? null,
      });
      const take = (files, folder, isNew, into) => {
        for (const file of files) {
          const full = path.join(base, folder, file);
          seenFiles.add(full);
          const msg = readMessage(full, file);
          if (msg) into.push({ ...msg, to: key, unread: isNew, text: hide ? null : msg.text });
        }
      };
      take(fresh.slice(-MAX_MAIL_NEW), 'new', true, unread);
      take(old.slice(-MAX_MAIL_READ), 'read', false, done);
    }
    for (const folder of listings.keys()) if (!seenFolders.has(folder)) listings.delete(folder);
    for (const file of messages.keys()) if (!seenFiles.has(file)) messages.delete(file);
    names.prune(seenFiles);
    // Unread mail comes first, so old read mail never pushes it out.
    const newestFirst = (a, b) => b.at - a.at || ORDER.compare(a.to, b.to);
    const kept = [...unread.sort(newestFirst), ...done.sort(newestFirst)].slice(0, MAX_MAIL_MESSAGES).sort(newestFirst);
    return { owner, agents, messages: kept };
  }

  // The names in a folder, by name (so mail is oldest first). `kind` is 'dirs' or 'mail'; `force`
  // lists it again even when its times did not move.
  function listFolder(folder, kind, t, force) {
    let st;
    try {
      st = fs.statSync(folder, { throwIfNoEntry: false });
    } catch {
      st = undefined;
    }
    if (!st?.isDirectory()) return [];
    const sig = `${st.mtimeMs}:${st.ctimeMs}:${st.ino}`;
    const old = listings.get(folder);
    if (!force && old && old.sig === sig && t - old.at < LIST_MS && t >= old.at) return old.entries;
    const entries = kind === 'dirs' ? listDirs(folder).sort(ORDER.compare) : listMail(folder);
    listings.set(folder, { sig, at: t, entries });
    return entries;
  }

  // A message, read once: { from, fromName, at, text }. A file that is gone (an agent just read it)
  // is tried again next time.
  function readMessage(full, file) {
    if (messages.has(full)) return messages.get(full);
    const text = readHead(full, MAX_MAIL_BYTES);
    if (text === null) return null;
    const msg = { ...parseMail(text), from: MAIL_FILE.exec(file)[8], at: fileTime(file) };
    messages.set(full, msg);
    return msg;
  }

  return { read };
}

function listMail(folder) {
  let entries;
  try {
    entries = fs.readdirSync(folder, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile() && fileTime(e.name) !== null)
    .map((e) => e.name)
    .sort();
}

// The time in a message's file name (UTC), or null.
function fileTime(file) {
  const m = MAIL_FILE.exec(file);
  if (!m) return null;
  const [y, mo, d, h, mi, s, ms] = m.slice(1, 8).map(Number);
  return toTime(y, mo, d, h, mi, s, ms, 0);
}

// "From: <name>", "To: <names>" and "Sent: <time>" lines, a blank line, then the message.
function parseMail(text) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  let fromName = null;
  let body = 0;
  for (let i = 0; i < lines.length && i < 20; i++) {
    if (lines[i].trim() === '') {
      body = i + 1;
      break;
    }
    const m = HEAD_LINE.exec(lines[i]);
    if (!m) break; // no head: it is all message
    if (m[1].toLowerCase() === 'from') fromName = shortText(m[2], MAX_MAIL_NAME);
  }
  const rest = lines.slice(body).join('\n').trim().replace(/(?![\n\t])\p{Cc}/gu, ' ');
  const chars = Array.from(rest);
  return { fromName, text: (chars.length > MAX_MAIL_TEXT ? chars.slice(0, MAX_MAIL_TEXT).join('') : rest) || null };
}

// .relay/agents.json: the agents the relay wakes for their mail, each with the Codex thread it wakes.
function enrolledAgents(json) {
  const out = new Map();
  if (json === null || typeof json !== 'object' || Array.isArray(json)) return out;
  for (const [key, agent] of Object.entries(json)) {
    if (!MAIL_AGENT.test(key) || agent === null || typeof agent !== 'object') continue;
    const id = typeof agent.thread_id === 'string' ? agent.thread_id.trim().toLowerCase() : '';
    out.set(key, { name: shortText(agent.name, MAX_MAIL_NAME), threadId: SESSION_ID.test(id) ? id : null });
  }
  return out;
}

function readName(file, st) {
  if (st.size > MAX_NAME_BYTES) return null;
  const text = readText(file, st.size, MAX_NAME_BYTES);
  return text === null ? undefined : shortText(text, MAX_MAIL_NAME);
}

// The first `max` bytes of a file, or null when it cannot be read.
function readHead(file, max) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(max);
    let got = 0;
    while (got < max) {
      const n = fs.readSync(fd, buf, got, max - got, got);
      if (n <= 0) break;
      got += n;
    }
    return stripBom(buf.toString('utf8', 0, got));
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// ---- folders and files ----

function listTasks(root) {
  const dir = path.join(root, 'tasks');
  return listDirs(dir)
    .filter((id) => TASK_ID.test(id))
    .sort(ORDER.compare)
    .map((id) => ({ id, workers: listWorkers(path.join(dir, id, 'workers')) }));
}

function listDirs(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() || (e.isSymbolicLink() && isDir(path.join(dir, e.name))))
    .map((e) => e.name);
}

function listWorkers(dir) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const ids = new Set();
  for (const file of names) {
    const m = RUN_FILE.exec(file) || REPORT_FILE.exec(file);
    if (m) ids.add(m[1]);
  }
  return [...ids].sort(ORDER.compare);
}

function listNotes(root) {
  let names;
  try {
    names = fs.readdirSync(root);
  } catch {
    return [];
  }
  return names.filter((file) => NOTES_FILE.test(file)).sort(ORDER.compare);
}

function expectedFiles(root, listing, notes) {
  const keep = new Set(ROOT_FILES.map(([file]) => path.join(root, file)));
  for (const file of notes) keep.add(path.join(root, file));
  for (const { id, workers } of listing) {
    const dir = path.join(root, 'tasks', id);
    for (const [file] of TASK_FILES) keep.add(path.join(dir, file));
    for (const worker of workers) {
      keep.add(runFile(dir, worker));
      keep.add(reportFile(dir, worker));
    }
  }
  return keep;
}

function runFile(taskDir, worker) {
  return path.join(taskDir, 'workers', `${worker}.run.json`);
}

function reportFile(taskDir, worker) {
  return path.join(taskDir, 'workers', `${worker}-report.md`);
}

// Remembers each file's parsed value until its size, times or identity change.
function createFileCache() {
  const entries = new Map();
  const cache = {
    changed: false,
    get(file, parse) {
      const st = statFile(file);
      const old = entries.get(file);
      if (!st) {
        if (old) {
          entries.delete(file);
          cache.changed = true;
        }
        return null;
      }
      const sig = `${st.size}:${st.mtimeMs}:${st.ctimeMs}:${st.ino}`;
      if (old && old.sig === sig) return old.value;
      const value = parse(file, st);
      if (value === undefined) return old ? old.value : null; // unreadable right now; try next poll
      entries.set(file, { sig, value });
      cache.changed = true;
      return value;
    },
    prune(keep) {
      for (const file of entries.keys()) {
        if (keep.has(file)) continue;
        entries.delete(file);
        cache.changed = true;
      }
    },
  };
  return cache;
}

// Reads a text file; a file larger than `max` is read from its last `max` bytes, whole lines only.
function readText(file, size, max) {
  try {
    if (size <= max) return stripBom(fs.readFileSync(file, 'utf8'));
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(max);
      let got = 0;
      while (got < max) {
        const n = fs.readSync(fd, buf, got, max - got, size - max + got);
        if (n <= 0) break;
        got += n;
      }
      const text = buf.toString('utf8', 0, got);
      return text.slice(text.indexOf('\n') + 1);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

function statFile(file) {
  try {
    const st = fs.statSync(file, { throwIfNoEntry: false });
    return st?.isFile() ? st : null;
  } catch {
    return null;
  }
}

function isDir(dir) {
  try {
    return fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory() === true;
  } catch {
    return false;
  }
}

function exists(file) {
  try {
    return fs.statSync(file, { throwIfNoEntry: false }) !== undefined;
  } catch {
    return false;
  }
}
