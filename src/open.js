// "Open in PowerShell": opens one Claude Code session or Codex thread in a new PowerShell window, so
// the person can watch it and type to it. It is off until the person turns it on
// (settings.actions.openTerminal), works on Windows only for now, and the server allows it only for
// a request made on this computer. Pleni starts the window and nothing else; whatever is typed
// there comes from the person.
import { execFile as nodeExecFile, spawn as nodeSpawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readJsonFile } from './jsonl.js';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const SESSION_ID = new RegExp(`^${UUID}$`);
// What can be opened: a Claude Code session, or any Codex thread. A Codex helper is a thread of its
// own that Codex can resume by itself; a Claude Code helper lives inside its session's process.
const OPEN_KEY = new RegExp(`^(claude|codex):(${UUID})$`);
const CLAUDE_HELPER_KEY = /^claude:[0-9a-f-]{8,64}\//;
// The command that reopens a session, and where each tool keeps its files unless told otherwise.
const TOOLS = {
  claude: { title: 'Claude Code', resume: 'claude --resume', homeVar: 'CLAUDE_CONFIG_DIR', homeDir: '.claude' },
  codex: { title: 'Codex', resume: 'codex resume', homeVar: 'CODEX_HOME', homeDir: '.codex' },
};
// Claude Code keeps one small file per running process: <root>/sessions/<process id>.json.
const PROCESS_FILE = /^\d{1,10}\.json$/;
const MAX_PROCESS_FILES = 500;
const MAX_PROCESS_BYTES = 64 * 1024;
// How Windows answers a read of a file that another program has locked.
const LOCKED_CODES = new Set(['EBUSY', 'EACCES', 'EPERM']);
// Clocks round, so a process may look up to this much younger than the file it wrote.
const START_SLACK_MS = 2000;
const START_QUERY_MS = 15 * 1000;
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
  otherTool: 'Only Claude Code and Codex sessions can be opened in a window for now.',
  helper: 'A helper cannot be opened by itself. Open the session that started it.',
  reviewer: 'An automatic reviewer cannot be opened in a window.',
  demo: 'The demo has no real sessions to open.',
  gone: 'That session is not on the map any more.',
  noFolder: "This session's folder is gone, so Pleni cannot open it there.",
  network: "This session's folder is on a network path, so Pleni cannot open it there.",
  desktopApp: 'This session belongs to the Claude desktop app. Open it there, so its messages stay in one place.',
  vscode: 'This session belongs to VS Code. Open it there, so its messages stay in one place.',
  elsewhere: 'This session is open in another window right now. Use that window, or close it first. If you just closed it, wait a few seconds and try again. Two windows would mix up its messages.',
  codexElsewhere: 'Another Codex program has this thread open right now, most likely the Codex app. Use that program for this thread. The Codex app keeps every thread you open in it until you quit it fully.',
  busy: 'This session is busy in another program right now, such as a script that sends it work. Try again when it finishes. Two programs at once would mix up its messages.',
  again: 'Pleni just opened this session. Look for the new window on your taskbar.',
  tooMany: 'That is a lot of windows. Wait a minute, then try again.',
  failed: 'Pleni could not open PowerShell.',
};

// Opens `key` ('claude:<session id>' or 'codex:<thread id>') in a new PowerShell window. Answers
// { ok: true } once the window is on its way, else { ok: false, status, error } with a plain
// message. `limits` comes from openLimits() and is kept by the caller from one request to the next.
// `roots` holds the Claude Code and Codex folders Pleni reads ({ claude, codex }).
export async function openSession({
  key,
  settings,
  roots,
  store,
  limits,
  platform = process.platform,
  env = process.env,
  home = os.homedir(),
  spawn = nodeSpawn,
  now = Date.now(),
  isAlive = processAlive,
  isLocked = codexThreadLocked,
  processStarts = (pids) => windowsProcessStarts(pids, { systemRoot: env.SystemRoot ?? env.SYSTEMROOT }),
}) {
  if (settings?.actions?.openTerminal !== true) return refuse(403, OPEN_MESSAGES.off);
  if (platform !== 'win32') return refuse(409, OPEN_MESSAGES.windowsOnly);
  const text = typeof key === 'string' ? key : '';
  const match = OPEN_KEY.exec(text);
  if (!match) return refuse(400, CLAUDE_HELPER_KEY.test(text) ? OPEN_MESSAGES.helper : OPEN_MESSAGES.otherTool);
  const [, tool, id] = match;
  if (store.demo) return refuse(409, OPEN_MESSAGES.demo);
  const listed = (store.snapshot()?.nodes ?? []).some((node) => node?.key === text);
  const session = listed ? store.session?.(text) : null;
  if (!session) return refuse(404, OPEN_MESSAGES.gone);
  if (session.kind === 'reviewer') return refuse(400, OPEN_MESSAGES.reviewer);
  const folder = folderProblem(session.cwd, platform);
  if (folder) return refuse(409, folder);
  const root = roots?.[tool] ?? null;
  const problem = tool === 'claude'
    ? openProblem(session, await confirmProcesses(claudeProcesses(root, id, isAlive), processStarts))
    : codexProblem(session, isLocked(root, id));
  if (problem) return refuse(409, problem);
  // Taken last, after every other check. take() checks and records in one step, so two quick
  // clicks cannot both get through, and a refusal above does not use up the next try.
  const wait = limits.take(text, now);
  if (wait) return refuse(429, wait);
  const { file, args } = powershellCommand(tool, id, env.SystemRoot ?? env.SYSTEMROOT);
  // Detached, cmd.exe gets no console window of its own; "start" gives PowerShell a new one.
  const options = {
    cwd: session.cwd,
    env: toolEnv(tool, env, root, home, platform),
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
    windowsVerbatimArguments: true,
  };
  return (await launch(spawn, file, args, options)) ? { ok: true } : refuse(500, OPEN_MESSAGES.failed);
}

// Why opening a Claude Code session would be unsafe, or null. Two processes writing one
// conversation mix it up, so the only live process allowed is a background session:
// "claude --resume" then shows that one live. A terminal window has entrypoint 'cli'; anything
// else (a script running "claude -p", another app) is busy rather than open in a window. The
// desktop app and VS Code may hold their sessions open without a process file Pleni can see.
export function openProblem(session, processes) {
  if (session.entrypoint === 'claude-desktop') return OPEN_MESSAGES.desktopApp;
  if (session.entrypoint === 'claude-vscode') return OPEN_MESSAGES.vscode;
  const live = processes.filter((proc) => proc.kind !== 'background');
  if (live.some((proc) => proc.entrypoint === 'cli')) return OPEN_MESSAGES.elsewhere;
  if (live.length) return OPEN_MESSAGES.busy;
  if (!processes.length && session.status === 'working') return OPEN_MESSAGES.busy;
  return null;
}

// Why opening a Codex thread would be unsafe, or null. Codex lets one program write a thread at a
// time and refuses a second, so this only gives a plain answer before a window opens for nothing.
export function codexProblem(session, locked) {
  if (locked) return OPEN_MESSAGES.codexElsewhere;
  if (session.status === 'working') return OPEN_MESSAGES.busy;
  return null;
}

// The Claude Code processes that have this session open, read from <root>/sessions/:
// [{ pid, kind, status, entrypoint, writtenAt }], where kind is 'interactive' or 'background' and
// writtenAt is when the file last changed. Files whose process number is not in use are skipped;
// confirmProcesses then drops the files whose number another program has taken since.
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
  const text = (value) => (typeof value === 'string' ? value : null);
  for (const name of names.slice(0, MAX_PROCESS_FILES)) {
    const file = path.join(dir, name);
    const info = readJsonFile(file, MAX_PROCESS_BYTES);
    if (typeof info?.sessionId !== 'string' || info.sessionId.trim().toLowerCase() !== sessionId) continue;
    if (!Number.isSafeInteger(info.pid) || info.pid <= 0 || !isAlive(info.pid)) continue;
    const writtenAt = modifiedAt(file);
    if (writtenAt === null) continue;
    out.push({ pid: info.pid, kind: text(info.kind), status: text(info.status), entrypoint: text(info.entrypoint), writtenAt });
  }
  return out;
}

// A process file can outlive its process: a window closed with its X ends Claude Code before it can
// remove the file, and Windows soon gives the same process number to another program. The process
// that wrote a file started before it last wrote it; a program that took the number later started
// after. So a file counts only while the process with its number started no later than the file
// last changed. If Pleni cannot learn the start times, it keeps every file, to stay on the safe side.
export async function confirmProcesses(found, processStarts) {
  if (!found.length) return found;
  let starts;
  try {
    starts = await processStarts(found.map((proc) => proc.pid));
  } catch {
    return found;
  }
  if (!(starts instanceof Map)) return found;
  return found.filter((proc) => {
    const startedAt = starts.get(proc.pid);
    return Number.isFinite(startedAt) && startedAt <= proc.writtenAt + START_SLACK_MS;
  });
}

// When each of these processes started, in milliseconds: Map<pid, ms | null>. Node.js cannot ask
// Windows itself, so a hidden PowerShell does, with only whole numbers put into its command. A
// process that is gone is missing from the map; one whose start time Windows will not tell (a
// system process) maps to null. PowerShell ends with code 1 when any number has no process, so
// the command ends with "exit 0": a missing process is a missing line, not a failed question.
export function windowsProcessStarts(pids, { systemRoot = process.env.SystemRoot, execFile = nodeExecFile } = {}) {
  const ids = [...new Set(pids)].filter((pid) => Number.isSafeInteger(pid) && pid > 0);
  if (!ids.length) return Promise.resolve(new Map());
  const windows = plainWindowsDir(systemRoot);
  const script = `Get-Process -Id ${ids.join(',')} -ErrorAction SilentlyContinue | ForEach-Object { try { '{0} {1}' -f $_.Id, ([DateTimeOffset]$_.StartTime).ToUnixTimeMilliseconds() } catch { '{0} -' -f $_.Id } }; exit 0`;
  const file = `${windows}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
  const options = { cwd: windows, timeout: START_QUERY_MS, windowsHide: true, maxBuffer: 64 * 1024 };
  return new Promise((resolve, reject) => {
    execFile(file, ['-NoProfile', '-NonInteractive', '-Command', script], options, (err, stdout) => {
      if (err) reject(err);
      else resolve(parseStarts(String(stdout)));
    });
  });
}

// Lines of "<pid> <ms>" or "<pid> -" -> Map<pid, ms | null>.
export function parseStarts(text) {
  const out = new Map();
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(\d{1,10}) (\d{1,16}|-)\s*$/.exec(line);
    if (m) out.set(Number(m[1]), m[2] === '-' ? null : Number(m[2]));
  }
  return out;
}

// True when another program is writing this Codex thread. While it writes, Codex holds an operating
// system lock on <root>/thread-writer-locks/<thread id>.lock, and Windows refuses to let any other
// program read a locked file. So Pleni tries to read one byte: a refusal means the thread is open
// somewhere. A missing file means no program has written the thread since Codex last cleaned up.
// Pleni never writes here. Other systems allow the read, so this finds nothing there.
export function codexThreadLocked(root, threadId) {
  if (!root || !SESSION_ID.test(threadId)) return false;
  const file = path.join(root, 'thread-writer-locks', `${threadId}.lock`);
  let fd;
  try {
    fd = fs.openSync(file, 'r');
  } catch (err) {
    return err?.code === 'EBUSY';
  }
  try {
    fs.readSync(fd, Buffer.alloc(1), 0, 1, 0);
    return false;
  } catch (err) {
    return LOCKED_CODES.has(err?.code);
  } finally {
    fs.closeSync(fd);
  }
}

// cmd.exe's "start" opens PowerShell in a new console window, in the folder cmd.exe was started
// in. Every part of the line is fixed or checked (the id is hex digits and dashes), so cmd.exe and
// PowerShell cannot read any of it as a second command. The id is in single quotes so PowerShell
// passes it on exactly as written. Both programs are named by their full path: a program with the
// same name in the session's folder never runs instead.
export function powershellCommand(tool, id, systemRoot) {
  const how = Object.hasOwn(TOOLS, tool) ? TOOLS[tool] : null;
  if (!how) throw new Error('Pleni can open only Claude Code and Codex sessions.');
  if (!SESSION_ID.test(id)) throw new Error('That is not a session id.');
  const windows = plainWindowsDir(systemRoot);
  const powershell = `${windows}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
  const line = `start "${how.title}" "${powershell}" -NoExit -NoLogo -Command "${how.resume} '${id}'"`;
  return { file: `${windows}\\System32\\cmd.exe`, args: ['/d', '/s', '/c', `"${line}"`] };
}

// "claude" looks for its sessions in $CLAUDE_CONFIG_DIR, else ~/.claude, and "codex" in $CODEX_HOME,
// else ~/.codex. When Pleni reads a tool from another folder (set in Settings), the window is
// pointed at that one. The usual folder is left alone: for Claude Code, naming it in
// CLAUDE_CONFIG_DIR is not the same as leaving it unset, because Claude Code then keeps its main
// settings file in another place.
export function toolEnv(tool, env, root, home, platform = process.platform) {
  const how = TOOLS[tool];
  const p = platform === 'win32' ? path.win32 : path.posix;
  const set = typeof env[how.homeVar] === 'string' && env[how.homeVar].trim();
  const usual = set ? p.resolve(set) : p.join(home, how.homeDir);
  const same = (a, b) => (platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
  if (!root || same(p.resolve(root), usual)) return { ...env };
  return { ...env, [how.homeVar]: root };
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

// %SystemRoot% when it is a plain folder such as C:\Windows, else C:\Windows itself.
function plainWindowsDir(systemRoot) {
  return typeof systemRoot === 'string' && PLAIN_WINDOWS_DIR.test(systemRoot) ? systemRoot.replace(/\\+$/, '') : 'C:\\Windows';
}

function modifiedAt(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return null;
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
