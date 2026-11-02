// Codex cloud tasks: the list of the person's Codex cloud tasks on the Cloud page. It is off until
// the person turns it on (settings.codexCloud.live). Pleni does not talk to OpenAI itself: it runs
// the Codex program on this computer, `codex cloud list --json --limit 20`, which asks OpenAI with
// the person's own Codex login. Pleni never reads Codex's login files or any key. Codex is found by
// its full path, every word on its command line is fixed, and no shell reads it. Codex writes a
// small error.log (with the account id inside) in the folder it runs from, so Pleni runs it from a
// folder of its own, inside Pleni's settings folder, never from a project. Pleni runs nothing else
// from Codex's cloud commands: never diff, apply or exec. It keeps each answer for a minute, in
// memory only, and the page asks only while the Cloud page is open.
import { execFile as nodeExecFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findTool } from './send.js';

export const MAX_TASKS = 20;
const FRESH_MS = 60 * 1000; // how long an answer is kept
const AGAIN_MS = 15 * 1000; // "Look again" asks no more often than this
const FIND_MS = 3 * 60 * 1000; // how long Pleni remembers where codex is
const RUN_MS = 30 * 1000;
const MAX_OUTPUT = 1024 * 1024;
const MAX_TITLE = 200;
const MAX_ENVIRONMENT = 100;
const TASK_ID = /^[A-Za-z0-9_-]{1,100}$/;
const STATUSES = new Set(['pending', 'ready', 'applied', 'error']);
export const CLOUD_FOLDER = 'codex-cloud';
// Fixed words, the same on every run.
export const CLOUD_ARGS = Object.freeze(['cloud', 'list', '--json', '--limit', String(MAX_TASKS)]);
// Control characters and invisible format marks (zero-width, left-to-right and the marks that turn text
// around), which could make a title look blank or like something else.
const HIDDEN_MARKS = /[\p{Cc}\p{Cf}]/gu;

export const CLOUD_MESSAGES = {
  noCodex: 'Pleni could not find Codex on this computer.',
  login: 'Codex cloud needs you to sign in to Codex with ChatGPT. In a terminal, run: codex login',
  slow: 'Codex took too long to answer. Pleni will try again.',
  unreadable: 'Codex gave an answer Pleni could not read. Your Codex may be too old for codex cloud list --json.',
  failed: 'Codex could not list your cloud tasks just now.',
};

// The full path of codex, as { file, args }, or null. Windows: the same search as Send (codex.exe,
// or npm's codex.cmd with its package's bin/codex.js run by Pleni's own Node.js). Elsewhere: the
// first codex in a folder on PATH that is an executable file, or a link to one (an npm install is a
// small script behind a link). Only absolute, local folders count, never the current folder or a
// network share, so a codex in a project never runs instead.
export function findCodex(env = process.env, platform = process.platform, { home = os.homedir(), size, node = process.execPath, isExecutable = executableFile } = {}) {
  if (platform === 'win32') return findTool('codex', { env, platform, home, node, ...(size ? { size } : {}) });
  const list = typeof env?.PATH === 'string' ? env.PATH : '';
  for (const raw of list.split(':')) {
    const dir = raw.trim();
    if (!dir || !path.posix.isAbsolute(dir)) continue;
    const file = path.posix.join(dir, 'codex');
    if (isExecutable(file)) return { file, args: [] };
  }
  return null;
}

// statSync follows a link, so a link to a program counts and a link to nothing does not.
function executableFile(file) {
  try {
    if (!fs.statSync(file).isFile()) return false;
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// codex's JSON -> the tasks Pleni shows, or null when it is not { tasks: [...] }. Nothing is trusted:
// the address is rebuilt from the checked id, and the text is plain and short.
export function parseTasks(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.tasks)) return null;
  return raw.tasks.map(taskOf).filter(Boolean).slice(0, MAX_TASKS);
}

function taskOf(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !TASK_ID.test(raw.id)) return null;
  const summary = raw.summary && typeof raw.summary === 'object' ? raw.summary : {};
  return {
    id: raw.id,
    title: plainText(raw.title, MAX_TITLE) || 'Untitled task',
    status: typeof raw.status === 'string' && STATUSES.has(raw.status) ? raw.status : 'unknown',
    updatedAt: timeOf(raw.updated_at),
    environment: plainText(raw.environment_label, MAX_ENVIRONMENT) || null,
    files: countOf(summary.files_changed),
    added: countOf(summary.lines_added),
    removed: countOf(summary.lines_removed),
    review: raw.is_review === true,
    attempts: Number.isSafeInteger(raw.attempt_total) && raw.attempt_total >= 1 ? raw.attempt_total : null,
    url: `https://chatgpt.com/codex/tasks/${raw.id}`,
  };
}

function plainText(value, max) {
  if (typeof value !== 'string') return '';
  return Array.from(value.replace(HIDDEN_MARKS, ' ').replace(/\s+/g, ' ').trim()).slice(0, max).join('');
}

// An RFC 3339 time, or a number of seconds or milliseconds, as milliseconds.
function timeOf(value) {
  let t = NaN;
  if (typeof value === 'string') t = Date.parse(value);
  else if (typeof value === 'number' && Number.isFinite(value) && value > 0) t = value < 1e11 ? value * 1000 : value;
  return Number.isFinite(t) && t > 0 ? t : null;
}

function countOf(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

// What a codex run came to: { ok, stdout, error } with a plain error. The words codex wrote to its
// error output are never passed on: they may hold an account id.
export function cloudOutcome(err, stdout, stderr) {
  if (!err) return { ok: true, stdout: String(stdout ?? ''), error: null };
  const fail = (error) => ({ ok: false, stdout: '', error });
  if (err.code === 'ENOENT') return fail(CLOUD_MESSAGES.noCodex);
  if (err.killed) return fail(CLOUD_MESSAGES.slow);
  if (err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return fail(CLOUD_MESSAGES.unreadable);
  if (/not signed in|codex login/i.test(`${stderr ?? ''}\n${stdout ?? ''}`)) return fail(CLOUD_MESSAGES.login);
  return fail(CLOUD_MESSAGES.failed);
}

// The answers, kept from one request to the next. `folder` is where codex runs: a path, or a function
// that gives it (Pleni's settings folder can move). `execFile`, `env`, `platform`, `find` and `now`
// are for tests.
export function createCodexCloud({ execFile = nodeExecFile, env = process.env, platform = process.platform, folder = null, now = Date.now, find = findCodex, home = os.homedir() } = {}) {
  let kept = null; // { at, tasks, error }
  let asking = null; // the answer on its way
  let found = { at: -Infinity, program: null };

  function codex(t) {
    if (!found.program || t - found.at >= FIND_MS || t < found.at) found = { at: t, program: find(env, platform, { home }) };
    return found.program;
  }

  function workFolder() {
    const dir = typeof folder === 'function' ? folder() : folder;
    const base = typeof dir === 'string' && dir ? dir : path.join(os.tmpdir(), 'pleni', CLOUD_FOLDER);
    // Private: codex leaves an error.log here, with the account id inside.
    fs.mkdirSync(base, { recursive: true, mode: 0o700 });
    return base;
  }

  function run(program) {
    return new Promise((resolve) => {
      try {
        const options = { cwd: workFolder(), env: { ...env, NO_COLOR: '1' }, timeout: RUN_MS, maxBuffer: MAX_OUTPUT, windowsHide: true, encoding: 'utf8' };
        execFile(program.file, [...program.args, ...CLOUD_ARGS], options, (err, stdout, stderr) => resolve(cloudOutcome(err, stdout, stderr)));
      } catch (err) {
        resolve(cloudOutcome(err, '', ''));
      }
    });
  }

  async function ask() {
    const program = codex(now());
    let answer;
    if (!program) {
      answer = { error: CLOUD_MESSAGES.noCodex, tasks: [] };
    } else {
      const r = await run(program);
      const tasks = r.ok ? parseTasks(r.stdout) : null;
      answer = { error: r.ok ? (tasks ? null : CLOUD_MESSAGES.unreadable) : r.error, tasks: tasks ?? [] };
    }
    kept = { at: now(), tasks: answer.tasks, error: answer.error };
    return kept;
  }

  // { at, tasks, error }. The last answer is reused for a minute; `fresh` (Look again) asks again
  // when it is more than 15 seconds old. Two pages asking at once share one run.
  async function status({ fresh = false } = {}) {
    const age = kept ? now() - kept.at : Infinity;
    if (kept && age >= 0 && age < (fresh ? AGAIN_MS : FRESH_MS)) return kept;
    asking ??= ask().finally(() => {
      asking = null;
    });
    return asking;
  }

  return { status };
}

// The folder codex runs from: next to Pleni's settings file.
export function cloudFolder(settingsFile) {
  return typeof settingsFile === 'string' && settingsFile ? path.join(path.dirname(settingsFile), CLOUD_FOLDER) : null;
}
