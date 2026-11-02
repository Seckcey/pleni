// "Plan limits from Claude Code": Claude Code hands a status line its 5-hour and weekly limits after
// each reply, and does not save them anywhere. With Connect (Settings, Buttons, this computer
// only), Pleni adds a small status line to Claude Code's settings.json. The status line is a
// script Pleni keeps in its own settings folder (pleni-statusline.mjs, from src/statusline-script.mjs).
// It saves only the limits' numbers in claude-limits.json, next to itself. Pleni reads no login key
// and calls no server.
//
// If the person already had a status line, Connect keeps it exactly in statusline.json (in Pleni's
// folder), the script runs it the way Claude Code would, and Disconnect puts it back exactly.
// Connect and Disconnect take the same care as Answer questions (src/answers.js): a copy of
// settings.json in Pleni's backups folder first, the rest of the file kept as it was, and no change
// if the file moved meanwhile.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { backup, parseSettings, readFileText, settingsText, writeAtomic } from './models.js';

export const SCRIPT_NAME = 'pleni-statusline.mjs';
export const PREVIOUS_NAME = 'statusline.json';
export const LIMITS_NAME = 'claude-limits.json';
const TEMPLATE = new URL('./statusline-script.mjs', import.meta.url);
const CHANGES_PER_MINUTE = 10;
const MINUTE_MS = 60 * 1000;
// The command ends with the script's path in double quotes.
const OWN_COMMAND = /[\\/]pleni-statusline\.mjs"$/;

export const STATUS_MESSAGES = {
  remote: 'Plan limits can be connected only on the computer that runs Pleni, not from another device.',
  noRoot: 'Pleni does not know where Claude Code keeps its settings. Check Where Pleni looks in Settings.',
  unreadable: "Pleni could not read Claude Code's settings.json, so it changed nothing.",
  notObject: "Claude Code's settings.json is not written the way Pleni expects, so Pleni changed nothing.",
  notSimple: "The status line in Claude Code's settings.json is written in a way Pleni does not change, so Pleni changed nothing.",
  badPath: "Pleni's folder has a letter in its name that a status line cannot hold (a double quote, a back quote or a dollar sign), so Pleni changed nothing.",
  changed: "Claude Code's settings.json changed while Pleni worked on it. Try again.",
  failed: "Pleni could not change Claude Code's settings.json.",
  tooMany: 'That is a lot of changes. Wait a minute, then try again.',
  demo: 'The demo has no Claude Code to connect.',
  notMine: "The status line in Claude Code's settings.json is not Pleni's any more, so Pleni left it as it is.",
  otherFolder: 'This status line was set up from another Pleni folder, and its saved copy is there. Pleni left it as it is. Disconnect from that Pleni to get your old one back.',
};

// ---- the files ----

// Where Pleni keeps its three files, in its own settings folder.
export function statusFiles(dir) {
  return { script: path.join(dir, SCRIPT_NAME), previous: path.join(dir, PREVIOUS_NAME), limits: path.join(dir, LIMITS_NAME) };
}

// The script as this version of Pleni writes it.
export function scriptText() {
  return fs.readFileSync(TEMPLATE, 'utf8');
}

// ---- the command ----

// The command Claude Code runs. On Windows it is `node "<path>"` with forward slashes (a quoted full
// path to node does not work in PowerShell); elsewhere it is the full path to this node and the
// script, both in double quotes. null for a path a shell could read as something else.
export function pleniCommand(scriptPath, platform = process.platform, execPath = process.execPath) {
  if (typeof scriptPath !== 'string' || !scriptPath) return null;
  const windows = platform === 'win32';
  const bad = windows ? /["`$\r\n]/ : /["`$\\\r\n]/;
  if (bad.test(scriptPath)) return null;
  if (windows) return `node "${scriptPath.replace(/\\/g, '/')}"`;
  if (typeof execPath !== 'string' || !execPath || bad.test(execPath)) return null;
  return `"${execPath}" "${scriptPath}"`;
}

// True for a command Pleni wrote, for any folder or node.
export function isPleniCommand(command) {
  return typeof command === 'string' && OWN_COMMAND.test(command.trim());
}

// ---- what Settings shows ----

// { ok, error, file, found, connected, stale, previous, lines }. `connected` is true when the status
// line is exactly Pleni's command; `stale` when it is Pleni's script with another command (Pleni's
// folder or node moved: Connect again fixes it). `previous` is true when the person has a status
// line of their own, which keeps showing. `lines` is the block Connect writes.
export function readStatusSetup({ root, scriptPath, platform = process.platform, execPath = process.execPath }) {
  const command = pleniCommand(scriptPath, platform, execPath);
  const lines = command ? JSON.stringify({ statusLine: { type: 'command', command } }, null, 2) : null;
  const none = { connected: false, stale: false, previous: false, lines };
  if (!root) return { ok: false, error: STATUS_MESSAGES.noRoot, file: null, found: false, ...none };
  const file = path.join(root, 'settings.json');
  const read = readFileText(file);
  if (read.problem) return { ok: false, error: STATUS_MESSAGES.unreadable, file, found: read.exists, ...none };
  const settings = parseSettings(read.text);
  if (!settings) return { ok: false, error: STATUS_MESSAGES.notObject, file, found: true, ...none };
  const line = settings.statusLine;
  if (line !== undefined && !isPlainObject(line)) return { ok: false, error: STATUS_MESSAGES.notSimple, file, found: true, ...none };
  const mine = line !== undefined && isPleniCommand(line.command);
  const connected = mine && command !== null && line.command === command;
  return { ok: true, error: null, file, found: read.exists, connected, stale: mine && !connected, previous: line !== undefined && !mine, lines };
}

// Pleni starts: when it is connected, a script from an older Pleni is written again from this
// version's text. Only Pleni's own folder is written. Never throws; true when it wrote.
export function upgradeScript({ root, dir, platform = process.platform, execPath = process.execPath }) {
  try {
    const files = statusFiles(dir);
    const setup = readStatusSetup({ root, scriptPath: files.script, platform, execPath });
    if (!setup.ok || !setup.connected) return false;
    const text = scriptText();
    let now = null;
    try {
      now = fs.readFileSync(files.script, 'utf8');
    } catch {
      now = null;
    }
    if (now === text) return false;
    writePrivate(files.script, text, 0o644);
    return true;
  } catch {
    return false;
  }
}

// ---- Connect and Disconnect ----

export function createStatusSaver({ now = Date.now } = {}) {
  const times = [];

  // `where` is { root, backupDir, dir, platform?, execPath? }.
  function change(where, connect) {
    const { root, dir } = where;
    if (!root) return refuse(409, STATUS_MESSAGES.noRoot);
    const platform = where.platform ?? process.platform;
    const execPath = where.execPath ?? process.execPath;
    const t = now();
    while (times.length && t - times[0] >= MINUTE_MS) times.shift();
    if (times.length >= CHANGES_PER_MINUTE) return refuse(429, STATUS_MESSAGES.tooMany);
    const file = path.join(root, 'settings.json');
    const read = readFileText(file);
    if (read.problem) return refuse(409, STATUS_MESSAGES.unreadable);
    const settings = parseSettings(read.text);
    if (!settings) return refuse(409, STATUS_MESSAGES.notObject);
    const old = settings.statusLine;
    if (old !== undefined && !isPlainObject(old)) return refuse(409, STATUS_MESSAGES.notSimple);
    const files = statusFiles(dir);
    const mine = old !== undefined && isPleniCommand(old.command);
    const plan = connect ? planConnect({ settings, old, mine, files, platform, execPath }) : planDisconnect({ settings, old, mine, files });
    if (plan.error) return plan.error;
    const { next } = plan;
    const text = JSON.stringify(next) === JSON.stringify(settings) ? null : settingsText(next, read.text);
    if (text !== null && JSON.stringify(parseSettings(text)) !== JSON.stringify(next)) return refuse(409, STATUS_MESSAGES.notSimple);
    times.push(t);
    try {
      let copy = null;
      if (text !== null) {
        copy = read.exists && read.bytes ? backup(where.backupDir, file, read.bytes, t, 'claude') : null;
        const still = readFileText(file);
        const same = still.exists === read.exists && (still.bytes ?? Buffer.alloc(0)).equals(read.bytes ?? Buffer.alloc(0));
        if (!same) return refuse(409, STATUS_MESSAGES.changed);
      }
      plan.before?.();
      if (text !== null) writeAtomic(file, text, !read.exists);
      plan.after?.();
      return { ok: true, file, backup: copy, note: plan.note ?? null };
    } catch {
      return refuse(500, STATUS_MESSAGES.failed);
    }
  }

  return {
    connect: (where) => change(where, true),
    disconnect: (where) => change(where, false),
  };
}

// The settings with Pleni's status line in, and the files Pleni writes first.
function planConnect({ settings, old, mine, files, platform, execPath }) {
  const command = pleniCommand(files.script, platform, execPath);
  if (!command) return { error: refuse(409, STATUS_MESSAGES.badPath) };
  const next = structuredClone(settings);
  // The person's own padding and refresh settings stay.
  next.statusLine = { ...(old ?? {}), type: 'command', command };
  return {
    next,
    before() {
      // The script is always written again. A status line of the person's is kept exactly, unless it
      // is already Pleni's (its saved copy is then already there).
      writePrivate(files.script, scriptText(), 0o644);
      if (!mine) {
        if (old === undefined) fs.rmSync(files.previous, { force: true });
        else writePrivate(files.previous, `${JSON.stringify(old, null, 2)}\n`, 0o600);
      }
    },
  };
}

// The settings with the person's old status line put back (or none), and the files removed after.
function planDisconnect({ settings, old, mine, files }) {
  const clean = () => {
    for (const f of [files.previous, files.script, files.limits]) fs.rmSync(f, { force: true });
  };
  if (old === undefined) return { next: settings, after: clean };
  // The person changed it meanwhile: their file stays as it is.
  if (!mine) return { next: settings, after: clean, note: STATUS_MESSAGES.notMine };
  const next = structuredClone(settings);
  const saved = readSaved(files.previous);
  if (saved) next.statusLine = saved;
  else if (!ownScript(old.command, files.script)) return { next: settings, after: clean, note: STATUS_MESSAGES.otherFolder };
  else delete next.statusLine;
  return { next, after: clean };
}

// True when the command runs this Pleni folder's script (node's own path may have moved).
function ownScript(command, script) {
  return [script, script.replace(/\\/g, '/')].some((s) => command.includes(`"${s}"`));
}

// The status line object saved by Connect, or null when there is none.
function readSaved(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return isPlainObject(value) && !isPleniCommand(value.command) ? value : null;
  } catch {
    return null;
  }
}

// A temporary file in the same folder, then a rename.
function writePrivate(file, text, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.pleni-${process.pid}-${crypto.randomBytes(4).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(temp, text, { encoding: 'utf8', flag: 'wx', mode });
    renameRetry(temp, file);
  } catch (err) {
    fs.rmSync(temp, { force: true });
    throw err;
  }
}

// Another program may hold the file for a moment on Windows.
function renameRetry(from, to) {
  for (let tries = 0; ; tries++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (err) {
      if (tries >= 5) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function refuse(status, error) {
  return { ok: false, status, error };
}
