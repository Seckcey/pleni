// "Answer from Pleni": a Claude Code session asks Pleni before it asks the person, so a question, a
// plan to approve or a "may I run this?" prompt can be answered on the Pleni page, also for a turn
// that runs without a window (a message sent with Send). It works through Claude Code's hooks: with
// Connect (Settings, Buttons, this computer only), Pleni adds hooks to Claude Code's settings.json
// that call Pleni's own address on this computer, with a secret only this Pleni knows. It keeps a copy
// of the file first, changes nothing else in it, and Disconnect takes exactly its own hooks out again.
//
// Pleni holds a question only for a session the person switched on ("Answer its questions in
// Pleni") and for a turn Pleni itself sent. Every other call is answered at once with no decision,
// and Claude Code asks in its own window as before. A held question is answered when the person
// answers on the page, and given back to the session (no decision) when the person says so, when
// the time limit passes, or when Pleni stops. If Pleni is not running, Claude Code cannot reach the
// hook and goes on as if there were none.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { backup, parseSettings, readFileText, settingsText, writeAtomic } from './models.js';

export const HOOK_PATH = '/api/hook';
export const HOOK_HEADER = 'X-Pleni-Hook';
const HOOK_KEY_FILE = 'hook-key';
const HOOK_KEY = /^[A-Za-z0-9_-]{32,128}$/;
// The questions and plans Pleni can show, through PreToolUse; prompts come through PermissionRequest.
export const ASK_TOOLS = ['AskUserQuestion', 'ExitPlanMode'];
// Claude Code waits this long for Pleni's answer; Pleni gives a question back well before that.
export const HOOK_TIMEOUT_SECONDS = 3900;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ASK_ID = /^[0-9a-f]{24}$/;
export const MAX_ASKS = 20;
const MAX_QUESTIONS = 4;
const MAX_OPTIONS = 8;
const MAX_PLAN = 20000;
const MAX_DETAIL = 2000;
const MAX_ANSWER = 2000;
const CHANGES_PER_MINUTE = 10;
const MINUTE_MS = 60 * 1000;

// What Claude Code takes as "no decision": it goes on and asks in its own window.
export const NO_DECISION = Object.freeze({});

export const ANSWER_MESSAGES = {
  remote: 'Questions can be answered from Pleni only on the computer that runs it, not from another device.',
  hooksRemote: 'Pleni can be connected to Claude Code only on the computer that runs it.',
  noRoot: 'Pleni does not know where Claude Code keeps its settings. Check Where Pleni looks in Settings.',
  unreadable: "Pleni could not read Claude Code's settings.json, so it changed nothing.",
  notObject: "Claude Code's settings.json is not written the way Pleni expects, so Pleni changed nothing.",
  notSimple: 'The hooks in Claude Code\'s settings.json are written in a way Pleni does not change, so Pleni changed nothing. Add the lines yourself, or tidy the hooks first.',
  changed: "Claude Code's settings.json changed while Pleni worked on it. Try again.",
  failed: "Pleni could not change Claude Code's settings.json.",
  tooMany: 'That is a lot of changes. Wait a minute, then try again.',
  demo: 'The demo has no Claude Code to connect.',
  gone: 'That question is not waiting any more. The session may have gone on without it.',
  badAnswer: 'Pleni could not read that answer.',
  badChoice: 'That answer is not one of the choices. Pick one, or type your own under Other.',
  noAnswer: 'Answer each question first.',
  longAnswer: `That answer is too long. Keep it to ${MAX_ANSWER} characters or fewer.`,
};

// ---- the secret ----

export function hookKeyFile(settingsPath) {
  return path.join(path.dirname(settingsPath), HOOK_KEY_FILE);
}

// The secret the hooks send, kept next to Pleni's settings. A new one is made when there is none (or
// it is damaged); the hooks then need Connect again, which Settings says.
export function loadOrCreateHookKey(file) {
  try {
    const kept = fs.readFileSync(file, 'utf8').trim();
    if (HOOK_KEY.test(kept)) return kept;
  } catch {
    // None yet: make one below.
  }
  const key = crypto.randomBytes(32).toString('base64url');
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${key}\n`, { mode: 0o600 });
  } catch {
    // It works for this run; Connect again after a restart.
  }
  return key;
}

export function hookKeyMatches(sent, key) {
  if (typeof sent !== 'string' || typeof key !== 'string' || !sent || !key) return false;
  const hash = (text) => crypto.createHash('sha256').update(text).digest();
  return crypto.timingSafeEqual(hash(sent), hash(key));
}

// ---- the hooks in Claude Code's settings.json ----

export function hookUrl(port) {
  return `http://127.0.0.1:${port}${HOOK_PATH}`;
}

// Pleni's own hook, the same for each event it asks about.
export function pleniHook(port, secret) {
  return { type: 'http', url: hookUrl(port), timeout: HOOK_TIMEOUT_SECONDS, headers: { [HOOK_HEADER]: secret } };
}

// The entries Pleni adds: { PreToolUse: [...], PermissionRequest: [...] }.
export function pleniEntries(port, secret) {
  return {
    PreToolUse: [{ matcher: ASK_TOOLS.join('|'), hooks: [pleniHook(port, secret)] }],
    PermissionRequest: [{ matcher: '*', hooks: [pleniHook(port, secret)] }],
  };
}

// True for a hook Pleni added: an http hook to Pleni's address on this computer, with Pleni's header.
export function isPleniHook(hook) {
  if (!isPlainObject(hook) || hook.type !== 'http' || typeof hook.url !== 'string') return false;
  const headers = isPlainObject(hook.headers) ? hook.headers : {};
  return /^http:\/\/127\.0\.0\.1:\d{1,5}\/api\/hook$/.test(hook.url) && Object.hasOwn(headers, HOOK_HEADER);
}

// What Settings shows: { ok, error, file, found, connected, stale, lines }. `connected` is true when
// both events call this Pleni with this secret; `stale` when Pleni's hooks are there but call
// another port or carry an old secret (Connect again fixes it). `lines` is the hooks block as Pleni
// would write it, to show before Connect.
export function readHookSetup({ root, port, secret }) {
  const lines = JSON.stringify({ hooks: pleniEntries(port, '<secret>') }, null, 2);
  if (!root) return { ok: false, error: ANSWER_MESSAGES.noRoot, file: null, found: false, connected: false, stale: false, lines };
  const file = path.join(root, 'settings.json');
  const read = readFileText(file);
  if (read.problem) return { ok: false, error: ANSWER_MESSAGES.unreadable, file, found: read.exists, connected: false, stale: false, lines };
  const settings = parseSettings(read.text);
  if (!settings) return { ok: false, error: ANSWER_MESSAGES.notObject, file, found: true, connected: false, stale: false, lines };
  const mine = ownHooks(settings);
  const want = pleniHook(port, secret);
  const fits = (list) => list.length === 1 && list[0].url === want.url && list[0].headers[HOOK_HEADER] === secret;
  const connected = fits(mine.PreToolUse) && fits(mine.PermissionRequest);
  const any = mine.PreToolUse.length + mine.PermissionRequest.length > 0;
  return { ok: true, error: null, file, found: read.exists, connected, stale: any && !connected, lines };
}

// Pleni's hooks in a settings object, by event.
function ownHooks(settings) {
  const out = { PreToolUse: [], PermissionRequest: [] };
  const hooks = isPlainObject(settings.hooks) ? settings.hooks : {};
  for (const event of Object.keys(out)) {
    for (const entry of Array.isArray(hooks[event]) ? hooks[event] : []) {
      for (const hook of isPlainObject(entry) && Array.isArray(entry.hooks) ? entry.hooks : []) {
        if (isPleniHook(hook)) out[event].push(hook);
      }
    }
  }
  return out;
}

// The settings with every Pleni hook taken out (and, for Connect, the current ones put in), or null
// when the hooks block is not written as plain lists Pleni can change safely.
export function withPleniHooks(settings, add) {
  const next = structuredClone(settings);
  if (next.hooks !== undefined && !isPlainObject(next.hooks)) return null;
  const hooks = next.hooks ?? {};
  for (const event of ['PreToolUse', 'PermissionRequest']) {
    if (hooks[event] === undefined) continue;
    if (!Array.isArray(hooks[event])) return null;
    const kept = [];
    for (const entry of hooks[event]) {
      if (!isPlainObject(entry) || (entry.hooks !== undefined && !Array.isArray(entry.hooks))) return null;
      const list = Array.isArray(entry.hooks) ? entry.hooks : [];
      const others = list.filter((hook) => !isPleniHook(hook));
      if (others.length === list.length) kept.push(entry);
      else if (others.length) kept.push({ ...entry, hooks: others });
    }
    if (kept.length) hooks[event] = kept;
    else delete hooks[event];
  }
  if (add) {
    for (const [event, entries] of Object.entries(add)) hooks[event] = [...(hooks[event] ?? []), ...entries];
  }
  if (Object.keys(hooks).length) next.hooks = hooks;
  else delete next.hooks;
  return next;
}

// Connect and Disconnect, with the Models page's care: a copy of the old file in Pleni's backups
// folder first, the rest of the file kept as it was, and no change if the file moved meanwhile.
export function createHookSaver({ now = Date.now } = {}) {
  const times = [];

  function change({ root, backupDir, connect, port, secret }) {
    if (!root) return refuse(409, ANSWER_MESSAGES.noRoot);
    const t = now();
    while (times.length && t - times[0] >= MINUTE_MS) times.shift();
    if (times.length >= CHANGES_PER_MINUTE) return refuse(429, ANSWER_MESSAGES.tooMany);
    const file = path.join(root, 'settings.json');
    const read = readFileText(file);
    if (read.problem) return refuse(409, ANSWER_MESSAGES.unreadable);
    const settings = parseSettings(read.text);
    if (!settings) return refuse(409, ANSWER_MESSAGES.notObject);
    const next = withPleniHooks(settings, connect ? pleniEntries(port, secret) : null);
    if (!next) return refuse(409, ANSWER_MESSAGES.notSimple);
    if (JSON.stringify(next) === JSON.stringify(settings)) return { ok: true, file, backup: null };
    const text = settingsText(next, read.text);
    if (JSON.stringify(parseSettings(text)) !== JSON.stringify(next)) return refuse(409, ANSWER_MESSAGES.notSimple);
    times.push(t);
    try {
      const copy = read.exists && read.bytes ? backup(backupDir, file, read.bytes, t, 'claude') : null;
      const still = readFileText(file);
      const same = still.exists === read.exists && (still.bytes ?? Buffer.alloc(0)).equals(read.bytes ?? Buffer.alloc(0));
      if (!same) return refuse(409, ANSWER_MESSAGES.changed);
      writeAtomic(file, text, !read.exists);
      return { ok: true, file, backup: copy };
    } catch {
      return refuse(500, ANSWER_MESSAGES.failed);
    }
  }

  return {
    connect: ({ root, backupDir, port, secret }) => change({ root, backupDir, connect: true, port, secret }),
    disconnect: ({ root, backupDir }) => change({ root, backupDir, connect: false }),
  };
}

// ---- what a session asks ----

// What the page shows for one hook call, or null for a call Pleni does not hold:
//   { kind: 'question', questions: [{ index, question, header, multiSelect, options: [{ label, description }] }] }
//   { kind: 'plan', plan }
//   { kind: 'permission', tool, detail }
export function askView(input) {
  if (!isPlainObject(input)) return null;
  const tool = typeof input.tool_name === 'string' ? input.tool_name : '';
  const args = isPlainObject(input.tool_input) ? input.tool_input : {};
  if (input.hook_event_name === 'PreToolUse' && tool === 'AskUserQuestion') {
    const questions = (Array.isArray(args.questions) ? args.questions : []).slice(0, MAX_QUESTIONS).map((q, index) => ({
      index,
      question: clip(q?.question, 500),
      header: clip(q?.header, 60),
      multiSelect: q?.multiSelect === true,
      options: (Array.isArray(q?.options) ? q.options : []).slice(0, MAX_OPTIONS).map((o) => ({ label: clip(o?.label, 200), description: clip(o?.description, 400) })).filter((o) => o.label),
    })).filter((q) => q.question);
    return questions.length ? { kind: 'question', questions } : null;
  }
  if (input.hook_event_name === 'PreToolUse' && tool === 'ExitPlanMode') {
    const plan = clip(args.plan, MAX_PLAN, true);
    return plan ? { kind: 'plan', plan } : null;
  }
  if (input.hook_event_name === 'PermissionRequest' && tool) {
    return { kind: 'permission', tool: clip(tool, 80), detail: permissionDetail(args) };
  }
  return null;
}

// The part of a tool's input a person needs to decide: a command, a file, an address, else a short
// description of the input's keys.
function permissionDetail(args) {
  for (const key of ['command', 'file_path', 'notebook_path', 'url', 'path', 'pattern']) {
    if (typeof args[key] === 'string' && args[key].trim()) return clip(args[key], MAX_DETAIL, true);
  }
  if (typeof args.description === 'string') return clip(args.description, MAX_DETAIL, true);
  const keys = Object.keys(args).slice(0, 8);
  return keys.length ? clip(`With ${keys.join(', ')}.`, 200) : null;
}

// The hook's answer for a held call, from the person's answer on the page, or { error }.
//   question: { answers: ['<label>' | '<label>, <label>' | '<own words>', ...] }, one per question shown
//   plan:     { approve: true } | { approve: false, feedback? }
//   permission: { allow: true } | { allow: false, reason? }
export function hookAnswer(input, view, answer) {
  if (!isPlainObject(answer)) return { error: ANSWER_MESSAGES.badAnswer };
  if (view.kind === 'question') {
    const given = Array.isArray(answer.answers) ? answer.answers : null;
    if (!given || given.length !== view.questions.length) return { error: ANSWER_MESSAGES.badAnswer };
    const args = isPlainObject(input.tool_input) ? input.tool_input : {};
    const asked = Array.isArray(args.questions) ? args.questions : [];
    // Claude Code matches each answer to its question by the question's own words.
    const answers = {};
    for (const [i, q] of view.questions.entries()) {
      const text = typeof given[i] === 'string' ? given[i].replace(/\s+/g, ' ').trim() : '';
      if (!text) return { error: ANSWER_MESSAGES.noAnswer };
      if (text.length > MAX_ANSWER) return { error: ANSWER_MESSAGES.longAnswer };
      answers[asked[q.index].question] = text;
    }
    return { body: preToolUse('allow', { updatedInput: { ...args, answers } }) };
  }
  if (view.kind === 'plan') {
    if (answer.approve === true) return { body: preToolUse('allow') };
    if (answer.approve !== false) return { error: ANSWER_MESSAGES.badAnswer };
    const feedback = plainAnswer(answer.feedback);
    if (feedback === null) return { error: ANSWER_MESSAGES.longAnswer };
    return { body: preToolUse('deny', { permissionDecisionReason: feedback || 'Keep planning. The person did not approve this plan yet.' }) };
  }
  if (view.kind === 'permission') {
    if (answer.allow === true) return { body: permissionRequest({ behavior: 'allow' }) };
    if (answer.allow !== false) return { error: ANSWER_MESSAGES.badAnswer };
    const reason = plainAnswer(answer.reason);
    if (reason === null) return { error: ANSWER_MESSAGES.longAnswer };
    return { body: permissionRequest({ behavior: 'deny', message: reason || 'The person said no in Pleni.' }) };
  }
  return { error: ANSWER_MESSAGES.badAnswer };
}

function preToolUse(decision, extra = {}) {
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision, ...extra } };
}

function permissionRequest(decision) {
  return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } };
}

// The person's own words, squeezed, or '' when none, or null when too long.
function plainAnswer(value) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') return '';
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length > MAX_ANSWER ? null : text;
}

// ---- the questions Pleni holds ----

// Holds the hook calls Pleni answers for the person. `onChange()` runs whenever the list changes,
// so the snapshot can show it. Each held call resolves its promise once: with the person's answer,
// or with NO_DECISION.
export function createAsks({ now = Date.now, onChange = () => {}, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const held = new Map(); // id -> { id, key, view, input, at, until, resolve, timer }

  // Holds one call for `waitMs`. Answers NO_DECISION at once when too many are held already.
  function hold({ key, input, view, waitMs }) {
    if (held.size >= MAX_ASKS) return { id: null, answer: Promise.resolve(NO_DECISION) };
    const id = crypto.randomBytes(12).toString('hex');
    const at = now();
    let resolve;
    const answer = new Promise((done) => {
      resolve = done;
    });
    const entry = { id, key, view, input, at, until: at + waitMs, resolve, timer: null };
    entry.timer = setTimer(() => finish(id, NO_DECISION), waitMs);
    entry.timer?.unref?.();
    held.set(id, entry);
    onChange();
    return { id, answer };
  }

  function finish(id, body) {
    const entry = held.get(id);
    if (!entry) return false;
    held.delete(id);
    clearTimer(entry.timer);
    entry.resolve(body);
    onChange();
    return true;
  }

  // The person's answer from the page.
  function answer(id, given) {
    if (typeof id !== 'string' || !ASK_ID.test(id)) return refuse(400, ANSWER_MESSAGES.badAnswer);
    const entry = held.get(id);
    if (!entry) return refuse(404, ANSWER_MESSAGES.gone);
    const made = hookAnswer(entry.input, entry.view, given);
    if (made.error) return refuse(400, made.error);
    finish(id, made.body);
    return { ok: true };
  }

  // "Answer in the session instead", or the call went away (Claude Code gave up, or the turn ended).
  function release(id) {
    if (typeof id !== 'string' || !ASK_ID.test(id)) return refuse(400, ANSWER_MESSAGES.badAnswer);
    return finish(id, NO_DECISION) ? { ok: true } : refuse(404, ANSWER_MESSAGES.gone);
  }

  function list() {
    return [...held.values()].map(({ id, key, view, at, until }) => ({ id, key, at, until, ...view }));
  }

  // Pleni stops: every held call gets no decision, so no session waits for nothing.
  function close() {
    for (const id of [...held.keys()]) finish(id, NO_DECISION);
  }

  return { hold, answer, release, list, close, size: () => held.size };
}

// The session a hook call comes from, as a node key, or null.
export function askKey(input) {
  const id = isPlainObject(input) && typeof input.session_id === 'string' ? input.session_id.trim().toLowerCase() : '';
  return UUID.test(id) ? `claude:${id}` : null;
}

function clip(value, max, keepLines = false) {
  if (typeof value !== 'string') return null;
  const text = keepLines ? value.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim() : value.replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function refuse(status, error) {
  return { ok: false, status, error };
}
