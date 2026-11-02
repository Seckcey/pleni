// Usage: how many tokens each AI tool used in the last 7 days, and Codex's plan limits, read from
// the session files the tools already keep on this computer. Read-only. No login keys, no calls to
// any server. Only numbers and de-duplication keys are kept in memory, never text from a session.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { stripBom } from './jsonl.js';

const MiB = 1024 * 1024;
const DAY_COUNT = 7;
const REUSE_MS = 30 * 1000;
const CHUNK_BYTES = MiB;
const MAX_LINE_BYTES = 8 * MiB;
const MAX_JSON_BYTES = 8 * MiB;
const MAX_BYTES = 256 * MiB;
const MAX_FILES = 5000;
// Above this a token number is bad data: no session reaches it, and one broken line must not turn
// a week of totals into Infinity (which JSON sends as null).
const MAX_TOKENS = 1e12;
const NEWLINE = 0x0a;
const SYNTHETIC = '<synthetic>';
const ROLLOUT = /^rollout-.*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
const DATE_DIR = /^\d{1,4}$/;

export const TOOLS = ['claude', 'codex', 'grok', 'kimi'];
const NAMES = { claude: 'Claude Code', codex: 'Codex', grok: 'Grok', kimi: 'Kimi Code' };

// ---- days ----

// The last 7 local days, oldest first, today last: { keys: ['YYYY-MM-DD'], starts: [8 local midnights
// in ms], start, end }. A day starts at local midnight, so a day with a clock change is still one day.
export function lastDays(now) {
  const d = new Date(now);
  const starts = [];
  for (let i = 0; i <= DAY_COUNT; i++) {
    starts.push(new Date(d.getFullYear(), d.getMonth(), d.getDate() + i - (DAY_COUNT - 1)).getTime());
  }
  return { keys: starts.slice(0, DAY_COUNT).map(localKey), starts, start: starts[0], end: starts[DAY_COUNT] };
}

function localKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function dayIndex(win, ts) {
  if (!(ts >= win.start && ts < win.end)) return -1;
  for (let i = 0; i < DAY_COUNT; i++) if (ts < win.starts[i + 1]) return i;
  return -1;
}

// ---- shapes ----

export function zeroTokens() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
}

// Cache reads are shown apart and never added to the total.
function withTotal(t) {
  return { ...t, total: t.input + t.output + t.cacheWrite };
}

function addTo(t, input, output, cacheRead, cacheWrite) {
  t.input += input;
  t.output += output;
  t.cacheRead += cacheRead;
  t.cacheWrite += cacheWrite;
}

// `buckets` is 7 { input, output, cacheRead, cacheWrite } objects, oldest first.
function toolAnswer({ on, win, buckets = null, atLeast = false, limits = null, error = null }) {
  const week = zeroTokens();
  const days = win.keys.map((date, i) => {
    const b = buckets?.[i] ?? zeroTokens();
    addTo(week, b.input, b.output, b.cacheRead, b.cacheWrite);
    return { date, ...withTotal(b) };
  });
  const { date, ...today } = days[DAY_COUNT - 1];
  return { on, today, week: withTotal(week), days, atLeast, limits, error };
}

function emptyBuckets() {
  return Array.from({ length: DAY_COUNT }, zeroTokens);
}

// ---- small helpers ----

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function num(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= MAX_TOKENS ? value : 0;
}

function text(value) {
  return typeof value === 'string' && value ? value : null;
}

function millis(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : NaN;
  if (typeof value !== 'string') return NaN;
  return Date.parse(value);
}

async function listDir(dir) {
  try {
    return await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function candidate(file, win) {
  try {
    const st = await fsp.stat(file);
    if (!st.isFile() || st.mtimeMs < win.start) return null;
    return { file, size: st.size, mtimeMs: st.mtimeMs, ino: st.ino };
  } catch {
    return null;
  }
}

async function isDirectory(dir) {
  try {
    return (await fsp.stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

function yieldNow() {
  return new Promise((resolve) => setImmediate(resolve));
}

// Newest first, at most `limit`; `budget.cut` says some were left out.
function newestFiles(found, limit, budget) {
  found.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.file < b.file ? -1 : 1));
  if (found.length > limit) budget.cut = true;
  return found.slice(0, limit);
}

// ---- a ledger of de-duplicated calls: key -> [ts, input, output, cacheRead, cacheWrite] ----

function createLedger() {
  const entries = new Map();
  return {
    // The earliest time and the largest value of each number win, so a repeat or a partly written
    // copy of the same call never counts twice and a re-read never adds anything.
    add(key, ts, input, output, cacheRead, cacheWrite) {
      const old = entries.get(key);
      if (!old) {
        entries.set(key, [ts, input, output, cacheRead, cacheWrite]);
        return;
      }
      old[0] = Math.min(old[0], ts);
      old[1] = Math.max(old[1], input);
      old[2] = Math.max(old[2], output);
      old[3] = Math.max(old[3], cacheRead);
      old[4] = Math.max(old[4], cacheWrite);
    },
    prune(start) {
      for (const [key, entry] of entries) if (entry[0] < start) entries.delete(key);
    },
    buckets(win) {
      const out = emptyBuckets();
      for (const [ts, input, output, cacheRead, cacheWrite] of entries.values()) {
        const i = dayIndex(win, ts);
        if (i >= 0) addTo(out[i], input, output, cacheRead, cacheWrite);
      }
      return out;
    },
  };
}

// ---- reading a .jsonl file that grows ----

function newFile() {
  return { size: -1, mtimeMs: -1, ino: null, offset: 0, carry: null, skipping: false, data: null };
}

// Reads only the bytes added since the last time. `wanted(line)` is a cheap look at the text before
// parsing; `onLine(record, state)` gets each parsed object. A last line without its newline waits.
async function followLines(cand, state, budget, wanted, onLine) {
  if (cand.size < state.offset || (state.ino !== null && state.ino !== cand.ino)) Object.assign(state, newFile());
  state.size = cand.size;
  state.mtimeMs = cand.mtimeMs;
  state.ino = cand.ino;
  if (state.offset >= cand.size) return;
  let handle;
  try {
    handle = await fsp.open(cand.file, 'r');
  } catch {
    return;
  }
  try {
    while (state.offset < cand.size) {
      if (budget.bytes <= 0) {
        budget.cut = true;
        break;
      }
      const want = Math.min(CHUNK_BYTES, cand.size - state.offset, budget.bytes);
      const buf = Buffer.allocUnsafe(want);
      const { bytesRead } = await handle.read(buf, 0, want, state.offset);
      if (bytesRead <= 0) break;
      state.offset += bytesRead;
      budget.bytes -= bytesRead;
      takeChunk(state, buf.subarray(0, bytesRead), wanted, onLine);
    }
  } catch {
    // Keep what was read; the rest is tried again next time.
  } finally {
    await handle.close().catch(() => {});
  }
}

function takeChunk(state, chunk, wanted, onLine) {
  let start = 0;
  let nl;
  while ((nl = chunk.indexOf(NEWLINE, start)) !== -1) {
    const part = chunk.subarray(start, nl);
    start = nl + 1;
    if (state.skipping) {
      state.skipping = false;
      continue;
    }
    const line = state.carry ? Buffer.concat([state.carry, part]) : part;
    state.carry = null;
    handleLine(line, state, wanted, onLine);
  }
  const rest = chunk.subarray(start);
  if (state.skipping || rest.length === 0) return;
  const held = (state.carry ? state.carry.length : 0) + rest.length;
  if (held > MAX_LINE_BYTES) {
    state.carry = null;
    state.skipping = true;
    return;
  }
  state.carry = state.carry ? Buffer.concat([state.carry, rest]) : Buffer.from(rest);
}

function handleLine(line, state, wanted, onLine) {
  if (line.length === 0 || line.length > MAX_LINE_BYTES) return;
  const body = stripBom(line.toString('utf8'));
  if (!wanted(body)) return;
  try {
    const record = JSON.parse(body);
    if (isObject(record)) onLine(record, state);
  } catch {
    // A bad line is skipped.
  }
}

// ---- Claude Code ----

function claudeLine(ledger, win) {
  return (rec) => {
    if (rec.type !== 'assistant' || !isObject(rec.message)) return;
    const msg = rec.message;
    if (msg.model === SYNTHETIC || !isObject(msg.usage)) return;
    const ts = millis(rec.timestamp);
    if (dayIndex(win, ts) < 0) return;
    // One API message is written on several lines with the same id.
    const key = text(msg.id) ?? text(rec.uuid);
    if (!key) return;
    const u = msg.usage;
    ledger.add(key, ts, num(u.input_tokens), num(u.output_tokens), num(u.cache_read_input_tokens), num(u.cache_creation_input_tokens));
  };
}

async function claudeFiles(roots, win, budget, limits) {
  const found = [];
  for (const root of roots) {
    const projects = path.join(root, 'projects');
    if (await isDirectory(projects)) await walkJsonl(projects, 0, win, found);
  }
  return newestFiles(found, limits.maxFiles, budget);
}

// projects/<folder>/<session>.jsonl, <session>/subagents/agent-*.jsonl and what lies below.
async function walkJsonl(dir, depth, win, found) {
  for (const entry of await listDir(dir)) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (depth < 6) await walkJsonl(full, depth + 1, win, found);
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      const cand = await candidate(full, win);
      if (cand) found.push(cand);
    }
  }
}

// ---- Codex ----

function newCodexData() {
  return { meta: false, floor: null, last: null, days: new Map(), limit: null };
}

function codexTotals(info) {
  const t = isObject(info) ? info.total_token_usage : null;
  if (!isObject(t)) return null;
  return { input: num(t.input_tokens), cached: num(t.cached_input_tokens), output: num(t.output_tokens) };
}

// What a total grew by since the last one; null when nothing changed. A total that went down
// starts again from the new value.
function codexGrowth(last, cur) {
  if (!last) return cur;
  if (cur.input === last.input && cur.cached === last.cached && cur.output === last.output) return null;
  if (cur.input + cur.output < last.input + last.output) return cur;
  return {
    input: Math.max(0, cur.input - last.input),
    cached: Math.max(0, cur.cached - last.cached),
    output: Math.max(0, cur.output - last.output),
  };
}

function codexLine(win) {
  return (rec, state) => {
    const d = (state.data ??= newCodexData());
    if (rec.type === 'session_meta') {
      if (d.meta) return;
      d.meta = true;
      const p = isObject(rec.payload) ? rec.payload : {};
      if (text(p.forked_from_id)) {
        const at = millis(rec.timestamp);
        d.floor = Number.isFinite(at) ? at : millis(p.timestamp);
        if (!Number.isFinite(d.floor)) d.floor = null;
      }
      return;
    }
    const p = rec.type === 'event_msg' && isObject(rec.payload) ? rec.payload : null;
    if (!p || p.type !== 'token_count') return;
    const ts = millis(rec.timestamp);
    if (!Number.isFinite(ts)) return;
    if (isObject(p.rate_limits) && (!d.limit || ts > d.limit.ts) && limitIdOk(p.rate_limits) && hasWindow(p.rate_limits)) d.limit = { ts, snap: p.rate_limits };
    const cur = codexTotals(p.info);
    if (!cur) return;
    const growth = codexGrowth(d.last, cur);
    d.last = cur;
    if (!growth) return;
    // A fork copies its parent's old events: they set the starting point and count for nothing.
    if (d.floor !== null && ts < d.floor) return;
    const i = dayIndex(win, ts);
    if (i < 0) return;
    const key = win.keys[i];
    const day = d.days.get(key) ?? [0, 0, 0];
    day[0] += Math.max(0, growth.input - growth.cached);
    day[1] += growth.output;
    day[2] += growth.cached;
    d.days.set(key, day);
  };
}

// A snapshot for an extra metered feature (its limit_id is some other name) is not the main limit.
function limitIdOk(snap) {
  const id = snap.limit_id;
  return !(typeof id === 'string' && id !== '' && id !== 'codex');
}

// A snapshot with no usable window (both null) must not hide an older one that has numbers.
function hasWindow(snap) {
  return [snap.primary, snap.secondary].some((w) => isObject(w) && typeof w.used_percent === 'number' && Number.isFinite(w.used_percent));
}

function codexLimits(files) {
  let best = null;
  for (const state of files) {
    const l = state.data?.limit;
    if (l && (!best || l.ts > best.ts)) best = l;
  }
  if (!best) return null;
  const windows = [];
  for (const w of [best.snap.primary, best.snap.secondary]) {
    if (!isObject(w) || typeof w.used_percent !== 'number' || !Number.isFinite(w.used_percent)) continue;
    windows.push({
      minutes: typeof w.window_minutes === 'number' && Number.isFinite(w.window_minutes) ? w.window_minutes : null,
      usedPercent: w.used_percent,
      resetsAt: typeof w.resets_at === 'number' && Number.isFinite(w.resets_at) ? w.resets_at * 1000 : null,
    });
  }
  return { at: best.ts, from: 'files', plan: text(best.snap.plan_type), windows };
}

async function codexFiles(root, win, budget, limits) {
  const found = [];
  await walkCodex(path.join(root, 'sessions'), 0, win, found);
  await walkCodex(path.join(root, 'archived_sessions'), 0, win, found);
  // The same thread in two places: the newest copy counts.
  const byId = new Map();
  for (const cand of found) {
    const m = ROLLOUT.exec(path.basename(cand.file));
    const id = m ? m[1].toLowerCase() : cand.file;
    const old = byId.get(id);
    if (!old || cand.mtimeMs > old.mtimeMs) byId.set(id, cand);
  }
  return newestFiles([...byId.values()], limits.maxFiles, budget);
}

// A rollout stays in the day folder it was created in, so every day folder is walked.
async function walkCodex(dir, depth, win, found) {
  for (const entry of await listDir(dir)) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (depth < 3 && DATE_DIR.test(entry.name)) await walkCodex(full, depth + 1, win, found);
    } else if (entry.isFile() && ROLLOUT.test(entry.name)) {
      const cand = await candidate(full, win);
      if (cand) found.push(cand);
    }
  }
}

function codexBuckets(files, win) {
  const out = emptyBuckets();
  for (const state of files) {
    for (const [key, [input, output, cacheRead]] of state.data?.days ?? []) {
      const i = win.keys.indexOf(key);
      if (i >= 0) addTo(out[i], input, output, cacheRead, 0);
    }
  }
  return out;
}

// ---- Grok ----

async function grokFiles(root, win, budget, limits) {
  const found = [];
  const base = path.join(root, 'sessions');
  for (const group of await listDir(base)) {
    if (!group.isDirectory()) continue;
    for (const session of await listDir(path.join(base, group.name))) {
      if (!session.isDirectory()) continue;
      const cand = await candidate(path.join(base, group.name, session.name, 'usage.json'), win);
      if (cand) found.push(cand);
    }
  }
  return newestFiles(found, limits.maxFiles, budget);
}

// usage.json is rewritten whole, so it is read again when it changes. A turn that a resumed or
// forked session copied shows up in two files; its key makes it count once.
async function followGrok(cand, state, budget, ledger, win) {
  if (cand.size > MAX_JSON_BYTES || cand.size > budget.bytes) {
    budget.cut = true;
    return;
  }
  // A file that says its numbers are too low (a helper's turns timed out) marks them "at least"
  // on every read, also when the file did not change.
  if (state.size === cand.size && state.mtimeMs === cand.mtimeMs) {
    if (state.incomplete) budget.cut = true;
    return;
  }
  let raw;
  try {
    raw = JSON.parse(stripBom(await fsp.readFile(cand.file, 'utf8')));
  } catch {
    if (state.incomplete) budget.cut = true;
    return; // not written yet, or caught half-written: tried again next time
  }
  budget.bytes -= cand.size;
  state.size = cand.size;
  state.mtimeMs = cand.mtimeMs;
  state.incomplete = raw?.session?.usageIsIncomplete === true
    || (Array.isArray(raw?.turns) && raw.turns.some((turn) => turn?.usageIsIncomplete === true));
  if (state.incomplete) budget.cut = true;
  for (const turn of Array.isArray(raw?.turns) ? raw.turns : []) {
    if (!isObject(turn)) continue;
    const ts = millis(turn.endedAt);
    if (dayIndex(win, ts) < 0) continue;
    const input = num(turn.inputTokens);
    const output = num(turn.outputTokens);
    const key = `${turn.endedAt}|${input}|${output}|${num(turn.cachedReadTokens)}|${num(turn.cacheCreationTokens)}`;
    ledger.add(key, ts, input, output, num(turn.cachedReadTokens), num(turn.cacheCreationTokens));
  }
}

// ---- Kimi Code ----

function kimiLine(ledger, win) {
  return (rec) => {
    if (rec.type !== 'usage.record') return;
    const body = isObject(rec.usage) ? rec : isObject(rec.payload) ? rec.payload : null;
    if (!body || !isObject(body.usage)) return;
    const ts = millis(rec.time);
    if (dayIndex(win, ts) < 0) return;
    const u = body.usage;
    const n = [num(u.inputOther), num(u.output), num(u.inputCacheRead), num(u.inputCacheCreation)];
    const key = `${ts}|${text(body.agentId) ?? ''}|${text(body.model) ?? ''}|${n.join('|')}`;
    ledger.add(key, ts, n[0], n[1], n[2], n[3]);
  };
}

// sessions/<folder>/<session>/agents/<agent>/wire.jsonl: the main agent and every helper.
async function kimiFiles(root, win, budget, limits) {
  const found = [];
  const base = path.join(root, 'sessions');
  for (const folder of await listDir(base)) {
    if (!folder.isDirectory() || folder.name.startsWith('.')) continue; // .index-cache is Kimi's own
    for (const session of await listDir(path.join(base, folder.name))) {
      if (!session.isDirectory()) continue;
      const agents = path.join(base, folder.name, session.name, 'agents');
      for (const agent of await listDir(agents)) {
        if (!agent.isDirectory()) continue;
        const cand = await candidate(path.join(agents, agent.name, 'wire.jsonl'), win);
        if (cand) found.push(cand);
      }
    }
  }
  return newestFiles(found, limits.maxFiles, budget);
}

// ---- Claude Code's limits, from Pleni's status line (src/statusline.js) ----

const MAX_LIMITS_BYTES = 64 * 1024;
const LIMIT_NAMES = new Set(['five_hour', 'seven_day', 'spend_limit']);

// What claude-limits.json in `dir` (Pleni's settings folder) holds, as { at, from: 'statusLine',
// plan: null, windows: [{ name, minutes, usedPercent, resetsAt }] }, or null when it is not there,
// too big, or has no valid window. Only numbers are used.
export function statusLineLimits(dir) {
  if (typeof dir !== 'string' || !dir) return null;
  let value;
  try {
    const file = path.join(dir, 'claude-limits.json');
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MAX_LIMITS_BYTES) return null;
    value = JSON.parse(stripBom(fs.readFileSync(file, 'utf8')));
  } catch {
    return null;
  }
  if (!isObject(value) || value.v !== 1 || !finite(value.at) || !Array.isArray(value.windows)) return null;
  const windows = [];
  for (const w of value.windows.slice(0, 8)) {
    if (!isObject(w) || !LIMIT_NAMES.has(w.name) || !finite(w.usedPercent) || !finite(w.resetsAt)) continue;
    windows.push({
      name: w.name,
      minutes: finite(w.minutes) && w.minutes > 0 ? w.minutes : null,
      usedPercent: Math.min(100, Math.max(0, w.usedPercent)),
      resetsAt: w.resetsAt,
    });
  }
  return windows.length ? { at: value.at, from: 'statusLine', plan: null, windows } : null;
}

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

// ---- the whole thing ----

// createUsage({ getRoots, getSettings, now, claudeLimits, maxBytes, maxFiles })
//   getRoots()      -> the folders per tool, as resolveRoots gives them
//   getSettings()   -> Pleni's settings (sources.<tool>.enabled says which tools are read)
//   claudeLimits    -> the hook for Claude Code's plan limits. Part 2 (the opt-in status line)
//                      gives a function that returns { at, from: 'statusLine', plan, windows } or
//                      null; it may be async. Without it, Claude Code has no limits here.
//   maxBytes, maxFiles -> what one read may take from each tool (tests make them small)
// read({ fresh }) -> { at, tools: { claude, codex, grok, kimi } }, the last answer reused for 30 s.
export function createUsage({ getRoots, getSettings, now = Date.now, claudeLimits = null, maxBytes = MAX_BYTES, maxFiles = MAX_FILES } = {}) {
  const limits = { maxFiles };
  const state = Object.fromEntries(TOOLS.map((name) => [name, { rootKey: null, files: new Map(), ledger: createLedger() }]));
  let cache = null;
  let running = null;

  function read({ fresh = false } = {}) {
    if (running) return running;
    running = compute(fresh).finally(() => {
      running = null;
    });
    return running;
  }

  async function compute(fresh) {
    const t = now();
    const roots = (typeof getRoots === 'function' ? getRoots() : null) ?? {};
    const settings = (typeof getSettings === 'function' ? getSettings() : null) ?? {};
    const signature = JSON.stringify([roots, TOOLS.map((name) => enabled(settings, name)), roots.claudeDesktop && enabled(settings, 'claudeDesktop')]);
    if (!fresh && cache && cache.signature === signature && t >= cache.at && t - cache.at < REUSE_MS) return withClaudeLimits(cache.result);
    const win = lastDays(t);
    const tools = {};
    for (const name of TOOLS) {
      try {
        tools[name] = await readTool(name, roots, settings, win);
      } catch {
        tools[name] = toolAnswer({ on: enabled(settings, name), win, error: `Pleni could not read the ${NAMES[name]} usage.` });
      }
    }
    const result = { at: t, tools };
    cache = { at: t, signature, result };
    return result;
  }

  // Claude Code's limits are one small file, so they are read again on every call.
  async function withClaudeLimits(result) {
    const claude = result.tools.claude;
    if (typeof claudeLimits !== 'function' || !claude?.on) return result;
    const limits = await claudeHook();
    if (JSON.stringify(limits) === JSON.stringify(claude.limits)) return result;
    return { ...result, tools: { ...result.tools, claude: { ...claude, limits } } };
  }

  async function readTool(name, roots, settings, win) {
    const on = enabled(settings, name);
    if (!on) return toolAnswer({ on, win });
    const folders = name === 'claude'
      ? [roots.claude, enabled(settings, 'claudeDesktop') ? roots.claudeDesktop : null]
      : [roots[name]];
    const known = [...new Set(folders.filter((f) => typeof f === 'string' && f))];
    if (known.length === 0) return toolAnswer({ on, win, error: `Pleni does not know where ${NAMES[name]} keeps its files.` });
    const mine = state[name];
    const rootKey = JSON.stringify(known);
    if (mine.rootKey !== rootKey) {
      mine.rootKey = rootKey;
      mine.files = new Map();
      mine.ledger = createLedger();
    }
    const budget = { bytes: maxBytes, cut: false };
    mine.ledger.prune(win.start);
    const buckets = await collectTool(name, known, mine, win, budget);
    // Claude Code's limits do not come from its session files, so they show even without them.
    const found = name === 'claude' ? await claudeHook() : name === 'codex' && buckets ? codexLimits(mine.files.values()) : null;
    if (buckets === null) return toolAnswer({ on, win, limits: found, error: `Pleni could not find the ${NAMES[name]} files on this computer.` });
    return toolAnswer({ on, win, buckets, atLeast: budget.cut, limits: found });
  }

  // The hook never stops a read: if it fails, Claude Code simply has no limits to show.
  async function claudeHook() {
    if (typeof claudeLimits !== 'function') return null;
    try {
      const l = await claudeLimits();
      return isObject(l) ? l : null;
    } catch {
      return null;
    }
  }

  // Reads what is new for one tool and returns its 7 day buckets, or null when its folder is not there.
  async function collectTool(name, folders, mine, win, budget) {
    if (name === 'claude') {
      if (!(await anyFolder(folders))) return null;
      const cands = await claudeFiles(folders, win, budget, limits);
      await follow(cands, mine, budget, (cand, file) => followLines(cand, file, budget, (l) => l.includes('"usage"'), claudeLine(mine.ledger, win)));
      return mine.ledger.buckets(win);
    }
    if (name === 'codex') {
      if (!(await isDirectory(folders[0]))) return null;
      const cands = await codexFiles(folders[0], win, budget, limits);
      await follow(cands, mine, budget, (cand, file) => followLines(cand, file, budget, (l) => l.includes('token_count') || l.includes('session_meta'), codexLine(win)));
      return codexBuckets(cands.map((c) => mine.files.get(c.file)), win);
    }
    if (name === 'grok') {
      if (!(await isDirectory(folders[0]))) return null;
      const cands = await grokFiles(folders[0], win, budget, limits);
      await follow(cands, mine, budget, (cand, file) => followGrok(cand, file, budget, mine.ledger, win));
      return mine.ledger.buckets(win);
    }
    if (!(await isDirectory(folders[0]))) return null;
    const cands = await kimiFiles(folders[0], win, budget, limits);
    await follow(cands, mine, budget, (cand, file) => followLines(cand, file, budget, (l) => l.includes('usage.record'), kimiLine(mine.ledger, win)));
    return mine.ledger.buckets(win);
  }

  // Runs `step` on each file, forgetting files that are no longer in the list, and yielding to the
  // server between files so it keeps answering.
  async function follow(cands, mine, budget, step) {
    const keep = new Set(cands.map((c) => c.file));
    for (const file of mine.files.keys()) if (!keep.has(file)) mine.files.delete(file);
    for (const cand of cands) {
      let file = mine.files.get(cand.file);
      if (!file) mine.files.set(cand.file, (file = newFile()));
      await step(cand, file);
      await yieldNow();
    }
  }

  return { read };
}

function enabled(settings, name) {
  return settings?.sources?.[name]?.enabled !== false;
}

async function anyFolder(dirs) {
  for (const dir of dirs) if (await isDirectory(dir)) return true;
  return false;
}
