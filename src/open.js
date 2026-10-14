// "Open in PowerShell": opens one Claude Code session in a new PowerShell window, so the person can
// watch it and type to it. It is off until the person turns it on (settings.actions.openTerminal),
// works on Windows only for now, and the server allows it only for a request made on this
// computer. Pleni starts the window and nothing else; whatever is typed there comes from the person.
import { spawn as nodeSpawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readJsonFile } from './jsonl.js';

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SESSION_KEY = /^claude:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const HELPER_KEY = /^claude:[0-9a-f-]{8,64}\//;
// Claude Code keeps one small file per running process: <root>/sessions/<process id>.json.
const PROCESS_FILE = /^\d{1,10}\.json$/;
const MAX_PROCESS_FILES = 500;
const MAX_PROCESS_BYTES = 64 * 1024;
// A second click must not open a second window while the first one is still starting.
const AGAIN_MS = 10 * 1000;
const MINUTE_MS = 60 * 1000;
const MAX_PER_MINUTE = 10;
// Only letters, digits, dots, dashes, underscores and backslashes, so the folder is safe to put in
// a cmd.exe command line.
const PLAIN_WINDOWS_DIR = /^[A-Za-z]:\\[A-Za-z0-9_.\\-]+$/;

export const OPEN_MESSAGES = {
  off: 'Opening sessions is turned off. Turn on "Open in PowerShell" in Settings first.',
  windowsOnly: 'Opening a session in a window works only on Windows for now.',
  notClaude: 'Only Claude Code sessions can be opened in a window for now.',
  helper: 'A helper cannot be opened by itself. Open the session that started it.',
  demo: 'The demo has no real sessions to open.',
  gone: 'That session is not on the map any more.',
  noFolder: "This session's folder is gone, so Pleni cannot open it there.",
  network: "This session's folder is on a network path, so Pleni cannot open it there.",
  desktopApp: 'This session belongs to the Claude desktop app. Open it there, so its messages stay in one place.',
  vscode: 'This session belongs to VS Code. Open it there, so its messages stay in one place.',
  elsewhere: 'This session is open in another window right now. Use that window, or close it first. Two windows would mix up its messages.',
  busy: 'This session is working in another program right now. Try again when it finishes. Two windows would mix up its messages.',
  again: 'Pleni just opened this session. Look for the new window on your taskbar.',
  tooMany: 'That is a lot of windows. Wait a minute, then try again.',
  failed: 'Pleni could not open PowerShell.',
};

// Opens `key` ('claude:<session id>') in a new PowerShell window. Answers { ok: true } once the
// window is on its way, else { ok: false, status, error } with a plain message. `limits` comes from
// openLimits() and is kept by the caller from one request to the next. `root` is the Claude Code
// folder Pleni reads.
export async function openSession({
  key,
  settings,
  root,
  store,
  limits,
  platform = process.platform,
  env = process.env,
  home = os.homedir(),
  spawn = nodeSpawn,
  now = Date.now(),
  isAlive = processAlive,
}) {
  if (settings?.actions?.openTerminal !== true) return refuse(403, OPEN_MESSAGES.off);
  if (platform !== 'win32') return refuse(409, OPEN_MESSAGES.windowsOnly);
  const text = typeof key === 'string' ? key : '';
  const match = SESSION_KEY.exec(text);
  if (!match) return refuse(400, HELPER_KEY.test(text) ? OPEN_MESSAGES.helper : OPEN_MESSAGES.notClaude);
  if (store.demo) return refuse(409, OPEN_MESSAGES.demo);
  const listed = (store.snapshot()?.nodes ?? []).some((node) => node?.key === text);
  const session = listed ? store.session?.(text) : null;
  if (!session) return refuse(404, OPEN_MESSAGES.gone);
  const folder = folderProblem(session.cwd, platform);
  if (folder) return refuse(409, folder);
  const problem = openProblem(session, claudeProcesses(root, match[1], isAlive));
  if (problem) return refuse(409, problem);
  // Taken last, with no waiting before it, so two quick clicks cannot both get through.
  const wait = limits.take(text, now);
  if (wait) return refuse(429, wait);
  const { file, args } = powershellCommand(match[1], env.SystemRoot ?? env.SYSTEMROOT);
  // Detached, cmd.exe gets no console window of its own; "start" gives PowerShell a new one.
  const options = {
    cwd: session.cwd,
    env: claudeEnv(env, root, home, platform),
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
    windowsVerbatimArguments: true,
  };
  return (await launch(spawn, file, args, options)) ? { ok: true } : refuse(500, OPEN_MESSAGES.failed);
}

// Why opening would be unsafe, or null. Two processes writing one conversation mix it up, so the
// only live process allowed is a background session: "claude --resume" then shows that one live.
// The desktop app and VS Code may hold their sessions open without a process file Pleni can see.
export function openProblem(session, processes) {
  if (session.entrypoint === 'claude-desktop') return OPEN_MESSAGES.desktopApp;
  if (session.entrypoint === 'claude-vscode') return OPEN_MESSAGES.vscode;
  if (processes.some((proc) => proc.kind !== 'background')) return OPEN_MESSAGES.elsewhere;
  if (!processes.length && session.status === 'working') return OPEN_MESSAGES.busy;
  return null;
}

// The live Claude Code processes that have this session open, read from <root>/sessions/:
// [{ kind, status }], where kind is 'interactive' or 'background'. Files whose process has ended
// are skipped.
export function claudeProcesses(root, sessionId, isAlive = processAlive) {
  if (!root || !SESSION_ID.test(sessionId)) return [];
  const dir = path.join(root, 'sessions');
  let names;
  try {
    names = fs.readdirSync(dir).filter((name) => PROCESS_FILE.test(name));
  } catch {
    return [];
  }
  const out = [];
  for (const name of names.slice(0, MAX_PROCESS_FILES)) {
    const info = readJsonFile(path.join(dir, name), MAX_PROCESS_BYTES);
    if (typeof info?.sessionId !== 'string' || info.sessionId.trim().toLowerCase() !== sessionId) continue;
    if (!Number.isSafeInteger(info.pid) || info.pid <= 0 || !isAlive(info.pid)) continue;
    out.push({ kind: typeof info.kind === 'string' ? info.kind : null, status: typeof info.status === 'string' ? info.status : null });
  }
  return out;
}

// cmd.exe's "start" opens PowerShell in a new console window, in the folder cmd.exe was started
// in. Every part of the line is fixed or checked (the session id is hex digits and dashes), so
// cmd.exe and PowerShell cannot read any of it as a second command. The id is in single quotes so
// PowerShell passes it on exactly as written. Both programs are named by their full path: a
// program with the same name in the session's folder never runs instead.
export function powershellCommand(sessionId, systemRoot) {
  if (!SESSION_ID.test(sessionId)) throw new Error('That is not a Claude Code session id.');
  const windows = typeof systemRoot === 'string' && PLAIN_WINDOWS_DIR.test(systemRoot) ? systemRoot.replace(/\\+$/, '') : 'C:\\Windows';
  const powershell = `${windows}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
  const line = `start "Claude Code" "${powershell}" -NoExit -NoLogo -Command "claude --resume '${sessionId}'"`;
  return { file: `${windows}\\System32\\cmd.exe`, args: ['/d', '/s', '/c', `"${line}"`] };
}

// "claude" looks for the session in its own folder: $CLAUDE_CONFIG_DIR, else ~/.claude. When Pleni
// reads Claude Code from another folder (set in Settings), the window is pointed at that one. The
// usual folder is left alone: naming it in CLAUDE_CONFIG_DIR is not the same as leaving it unset,
// because Claude Code then keeps its main settings file in another place.
export function claudeEnv(env, root, home, platform = process.platform) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const set = typeof env.CLAUDE_CONFIG_DIR === 'string' && env.CLAUDE_CONFIG_DIR.trim();
  const usual = set ? p.resolve(set) : p.join(home, '.claude');
  const same = (a, b) => (platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
  if (!root || same(p.resolve(root), usual)) return { ...env };
  return { ...env, CLAUDE_CONFIG_DIR: root };
}

// One window per session every few seconds, and a few a minute in all, so a double click or a
// stuck page cannot fill the screen.
export function openLimits() {
  const last = new Map();
  const times = [];
  return {
    take(key, now) {
      while (times.length && now - times[0] >= MINUTE_MS) times.shift();
      for (const [k, at] of last) if (now - at >= AGAIN_MS) last.delete(k);
      if (last.has(key)) return OPEN_MESSAGES.again;
      if (times.length >= MAX_PER_MINUTE) return OPEN_MESSAGES.tooMany;
      last.set(key, now);
      times.push(now);
      return null;
    },
  };
}

// Signal 0 only asks whether the process exists. EPERM means it exists but belongs to another user.
export function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

// cmd.exe cannot start in a network folder (\\server\share): it would fall back to the Windows
// folder, and the session would then work in the wrong place.
function folderProblem(dir, platform) {
  if (typeof dir !== 'string' || !dir) return OPEN_MESSAGES.noFolder;
  if (platform === 'win32' && /^[\\/]{2}/.test(dir)) return OPEN_MESSAGES.network;
  try {
    return path.isAbsolute(dir) && fs.statSync(dir).isDirectory() ? null : OPEN_MESSAGES.noFolder;
  } catch {
    return OPEN_MESSAGES.noFolder;
  }
}

// Resolves true once cmd.exe has started, false if it could not.
function launch(spawn, file, args, options) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(file, args, options);
    } catch {
      resolve(false);
      return;
    }
    child.once('spawn', () => resolve(true));
    child.once('error', () => resolve(false));
    child.unref?.();
  });
}

function refuse(status, error) {
  return { ok: false, status, error };
}
