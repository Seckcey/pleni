// "Send a message": the person types one message to an idle Claude Code session or Codex thread in
// Pleni, as if they typed it in the session itself. It is off until the person turns it on
// (settings.actions.send), works on Windows only for now, and the server allows it only for a
// request made on this computer. For each message Pleni starts the tool once, hidden, in the
// session's folder: `claude -p --resume <id>` or `codex exec resume <id> -`. The message goes to
// the program's standard input, never onto a command line, so no shell can read any of it as a
// command, whatever it says. Pleni keeps no copy of it: the session's own file has it, like any
// other turn. Its record of sends (sent.jsonl, next to the settings) says when, to which session and
// how it ended, never what was said.
import { spawn as nodeSpawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  OPEN_MESSAGES,
  claudeProcesses,
  codexThreadLocked,
  confirmProcesses,
  folderProblem,
  processAlive,
  toolEnv,
  windowsProcessStarts,
} from './open.js';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const SESSION_ID = new RegExp(`^${UUID}$`);
const SEND_KEY = new RegExp(`^(claude|codex):(${UUID})$`);
const CLAUDE_HELPER_KEY = /^claude:[0-9a-f-]{8,64}\//;
// The page makes a new id for each message, so a send that is tried again is not sent twice.
const SEND_ID = /^[A-Za-z0-9_-]{16,64}$/;
export const MAX_TEXT = 8000;
// Tabs and line breaks are fine; other control characters are not text a person types.
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/;
const AGAIN_MS = 5 * 1000;
const MINUTE_MS = 60 * 1000;
const MAX_PER_MINUTE = 6;
// Each turn costs money on the person's plan, so only a few run at once.
export const MAX_RUNNING = 3;
const ID_MS = 10 * 60 * 1000;
const MAX_IDS = 500;
// Claude Code writes its answer once, at the end of the turn; Pleni reads only its outcome.
const MAX_RESULT_BYTES = 1024 * 1024;
const FIND_MS = 60 * 1000;
// npm's Claude Code package first holds a stand-in of a few hundred bytes where its install step puts
// the real claude.exe; a real program is far bigger.
const MIN_PROGRAM_BYTES = 64 * 1024;
const LOG_FILE = 'sent.jsonl';
const MAX_LOG_BYTES = 256 * 1024;
const KEEP_LOG_LINES = 500;

export const SEND_MESSAGES = {
  off: 'Sending is turned off. Turn on "Send messages from Pleni" in Settings, under Buttons, first.',
  windowsOnly: 'Sending a message from Pleni works only on Windows for now.',
  otherTool: 'Only Claude Code sessions and Codex threads can get a message from Pleni for now.',
  helper: 'A helper cannot get a message by itself. Send it to the session that started it.',
  notMain: 'Only a main session can get a message from Pleni, not a helper or a reviewer.',
  demo: 'The demo has no real sessions, so Pleni sends nothing here.',
  gone: OPEN_MESSAGES.gone,
  empty: 'Type a message first.',
  tooLong: `This message is too long. Keep it to ${MAX_TEXT} characters or fewer.`,
  badText: 'This message has a character Pleni cannot pass on. Remove it and try again.',
  badId: 'Pleni could not read this message. Reload the page and try again.',
  running: 'Pleni is still waiting for this session to finish your last message. Send the next one when it is done.',
  full: `Pleni is already waiting on ${MAX_RUNNING} sessions. Send this when one of them is done.`,
  again: 'Pleni just sent this session a message. Wait a few seconds.',
  tooMany: 'That is a lot of messages. Wait a minute, then try again.',
  desktopApp: 'This session belongs to the Claude desktop app. Send your message there, so its messages stay in one place.',
  vscode: 'This session belongs to VS Code. Send your message there, so its messages stay in one place.',
  elsewhere: 'This session is open in a window right now. Type your message in that window, or close the window first. If you just closed it, wait a few seconds and try again.',
  codexElsewhere: 'Another Codex program has this thread open right now, most likely the Codex app. Send your message there, or quit the app fully first.',
  busy: 'This session is working right now. Send your message when it finishes, so it does not land in the middle of a turn.',
  noClaude: 'Pleni could not find Claude Code on this computer (claude.exe). Check that it is installed, then try again.',
  noCodex: 'Pleni could not find Codex on this computer (codex.exe). Check that it is installed, then try again.',
  failed: 'Pleni could not start the program for this session.',
};

// What a sent turn may do. 'read': read files and answer; anything that would need the person's
// yes is refused (Claude Code's dontAsk mode, Codex's read-only sandbox). 'edit': it may also change
// files in the session's folder (acceptEdits, workspace-write). The session's own settings still
// refuse what they refuse. Nothing else, and never a mode that skips every check.
export const SEND_MODES = ['read', 'edit'];

// One sender per server: it remembers which sessions are waiting for a sent turn, the message ids it
// has seen, and how many messages went out lately. `spawn`, `findProgram` and the process checks are
// there for tests.
export function createSender({
  spawn = nodeSpawn,
  now = Date.now,
  isAlive = processAlive,
  isLocked = codexThreadLocked,
  processStarts = null,
  findProgram = findTool,
} = {}) {
  const running = new Map(); // key -> { id, at, tool, pid }
  const last = new Map(); // key -> { at, endedAt, ok }
  const seen = new Map(); // message id -> time it came
  const recent = new Map(); // key -> time of its last send
  const times = [];
  const programs = new Map(); // tool -> { at, program }

  // Where each tool's program is, looked up again after a minute.
  function program(tool, env, platform, home) {
    const kept = programs.get(tool);
    const t = now();
    if (kept && t - kept.at < FIND_MS) return kept.program;
    const next = findProgram(tool, { env, platform, home });
    programs.set(tool, { at: t, program: next });
    return next;
  }

  // What the page shows before a send: { problem, running, last, mode }. Only the quick checks: the
  // switch, Windows, a main session on the map, which app it belongs to, and whether it is working.
  // Whether a window has it open is checked when the message is sent.
  function info({ key, settings, store, platform = process.platform }) {
    const head = sendHead(key, settings, store, platform);
    const mode = sendMode(settings);
    if (!head.ok) return { ok: false, status: head.status, error: head.error };
    const quick = running.has(key) ? SEND_MESSAGES.running : quickProblem(head.tool, head.session);
    return { ok: true, info: { problem: quick, running: running.has(key), last: last.get(key) ?? null, mode } };
  }

  // Sends `text` to `key` ('claude:<session id>' or 'codex:<thread id>'). `id` is the page's
  // one-time id for this message. Answers { ok: true } once the program has started (or, for an id
  // it has seen, { ok: true, repeat: true } without sending again), else { ok: false, status, error }.
  async function send({ key, text, id, settings, roots, store, logFile = null, platform = process.platform, env = process.env, home = os.homedir() }) {
    const head = sendHead(key, settings, store, platform);
    if (!head.ok) return head;
    const { tool, id: sessionId, session } = head;
    if (typeof id !== 'string' || !SEND_ID.test(id)) return refuse(400, SEND_MESSAGES.badId);
    const t = now();
    forgetOld(t);
    if (seen.has(id)) return { ok: true, repeat: true };
    const message = cleanMessage(text);
    const bad = messageProblem(message);
    if (bad) return refuse(400, bad);
    if (running.has(key)) return refuse(409, SEND_MESSAGES.running);
    if (running.size >= MAX_RUNNING) return refuse(429, SEND_MESSAGES.full);
    const folder = folderProblem(session.cwd, platform);
    if (folder) return refuse(409, folder);
    const root = roots?.[tool] ?? null;
    const starts = processStarts ?? ((pids) => windowsProcessStarts(pids, { systemRoot: env.SystemRoot ?? env.SYSTEMROOT }));
    const problem = tool === 'claude'
      ? claudeSendProblem(session, await confirmProcesses(claudeProcesses(root, sessionId, isAlive), starts))
      : codexSendProblem(session, isLocked(root, sessionId));
    if (problem) return refuse(409, problem);
    // Asked again: another message may have gone out while the checks above ran.
    if (running.has(key)) return refuse(409, SEND_MESSAGES.running);
    if (running.size >= MAX_RUNNING) return refuse(429, SEND_MESSAGES.full);
    const wait = take(key, t);
    if (wait) return refuse(429, wait);
    const found = program(tool, env, platform, home);
    if (!found) return refuse(409, tool === 'claude' ? SEND_MESSAGES.noClaude : SEND_MESSAGES.noCodex);
    const mode = sendMode(settings);
    const args = [...found.args, ...sendArgs(tool, sessionId, mode)];
    seen.set(id, t);
    const options = {
      cwd: session.cwd,
      env: toolEnv(tool, env, root, home, platform),
      // Claude Code writes its outcome at the end; Codex's outcome is its exit code.
      stdio: ['pipe', tool === 'claude' ? 'pipe' : 'ignore', 'ignore'],
      windowsHide: true,
      // The turn goes on if Pleni stops; Pleni never stops a session.
      detached: true,
    };
    const child = await start(spawn, found.file, args, options);
    if (!child) {
      seen.delete(id);
      return refuse(500, SEND_MESSAGES.failed);
    }
    const entry = { id, at: t, tool, pid: Number.isSafeInteger(child.pid) ? child.pid : null };
    running.set(key, entry);
    writeLog(logFile, { at: t, key, tool, mode, chars: message.length, started: true });
    watch(child, tool, sessionId, (outcome) => {
      if (running.get(key) === entry) running.delete(key);
      const endedAt = now();
      last.set(key, { at: t, endedAt, ok: outcome.ok });
      writeLog(logFile, { at: t, key, tool, mode, endedAt, ok: outcome.ok, code: outcome.code, otherSession: outcome.otherSession || undefined });
    });
    try {
      child.stdin.on('error', () => {
        // The program ended before it read everything; its exit says how it went.
      });
      child.stdin.end(message, 'utf8');
    } catch {
      // Same: the exit tells.
    }
    child.unref?.();
    return { ok: true };
  }

  function take(key, t) {
    while (times.length && t - times[0] >= MINUTE_MS) times.shift();
    for (const [k, at] of recent) if (t - at >= AGAIN_MS) recent.delete(k);
    if (recent.has(key)) return SEND_MESSAGES.again;
    if (times.length >= MAX_PER_MINUTE) return SEND_MESSAGES.tooMany;
    recent.set(key, t);
    times.push(t);
    return null;
  }

  function forgetOld(t) {
    for (const [k, at] of seen) if (t - at >= ID_MS) seen.delete(k);
    while (seen.size > MAX_IDS) seen.delete(seen.keys().next().value);
  }

  return { info, send, running: (key) => running.has(key), waiting: () => [...running.keys()] };
}

// 'read' unless the person chose 'edit' in Settings.
export function sendMode(settings) {
  return settings?.send?.mode === 'edit' ? 'edit' : 'read';
}

// The checks the page's question and a send share: the switch, Windows, a main Claude Code session
// or Codex thread that is on the map, and not the demo.
export function sendHead(key, settings, store, platform) {
  if (settings?.actions?.send !== true) return refuse(403, SEND_MESSAGES.off);
  if (platform !== 'win32') return refuse(409, SEND_MESSAGES.windowsOnly);
  const text = typeof key === 'string' ? key : '';
  const match = SEND_KEY.exec(text);
  if (!match) return refuse(400, CLAUDE_HELPER_KEY.test(text) ? SEND_MESSAGES.helper : SEND_MESSAGES.otherTool);
  if (store.demo) return refuse(409, SEND_MESSAGES.demo);
  const listed = (store.snapshot()?.nodes ?? []).some((node) => node?.key === text);
  const session = listed ? store.session?.(text) : null;
  if (!session) return refuse(404, SEND_MESSAGES.gone);
  if (session.kind !== 'session') return refuse(400, SEND_MESSAGES.notMain);
  return { ok: true, tool: match[1], id: match[2], session };
}

// What the page can tell without looking at running programs.
function quickProblem(tool, session) {
  if (tool === 'claude' && session.entrypoint === 'claude-desktop') return SEND_MESSAGES.desktopApp;
  if (tool === 'claude' && session.entrypoint === 'claude-vscode') return SEND_MESSAGES.vscode;
  return session.status === 'working' ? SEND_MESSAGES.busy : null;
}

// Why a message to this Claude Code session would be unsafe, or null. Two programs writing one
// conversation mix it up, so no live process of any kind may have it open: not a window, not a
// background session, not a script. The desktop app and VS Code may hold a session open without a
// process file Pleni can see.
export function claudeSendProblem(session, processes) {
  if (session.entrypoint === 'claude-desktop') return SEND_MESSAGES.desktopApp;
  if (session.entrypoint === 'claude-vscode') return SEND_MESSAGES.vscode;
  if (processes.some((proc) => proc.entrypoint === 'cli' && proc.kind !== 'background')) return SEND_MESSAGES.elsewhere;
  if (processes.length || session.status === 'working') return SEND_MESSAGES.busy;
  return null;
}

// Why a message to this Codex thread would be unsafe, or null. Codex lets one program write a
// thread at a time; the Codex app holds every thread it has opened until it quits.
export function codexSendProblem(session, locked) {
  if (locked) return SEND_MESSAGES.codexElsewhere;
  return session.status === 'working' ? SEND_MESSAGES.busy : null;
}

// The message as it is sent: Windows line breaks become plain ones, and the ends are trimmed.
export function cleanMessage(text) {
  return typeof text === 'string' ? text.replace(/\r\n?/g, '\n').trim() : '';
}

export function messageProblem(text) {
  if (!text) return SEND_MESSAGES.empty;
  if (text.length > MAX_TEXT) return SEND_MESSAGES.tooLong;
  if (CONTROL.test(text) || !text.isWellFormed()) return SEND_MESSAGES.badText;
  return null;
}

// The words after the program: fixed ones and the checked id, never the message.
//   Claude Code: -p --resume <id> --output-format json --permission-mode dontAsk | acceptEdits
//   Codex:       exec --skip-git-repo-check --sandbox read-only | workspace-write resume <id> -
export function sendArgs(tool, id, mode = 'read') {
  if (!SESSION_ID.test(id)) throw new Error('That is not a session id.');
  const edit = mode === 'edit';
  if (tool === 'claude') return ['-p', '--resume', id, '--output-format', 'json', '--permission-mode', edit ? 'acceptEdits' : 'dontAsk'];
  if (tool === 'codex') return ['exec', '--skip-git-repo-check', '--sandbox', edit ? 'workspace-write' : 'read-only', 'resume', id, '-'];
  throw new Error('Pleni can send only to Claude Code and Codex sessions.');
}

// Where the program is: { file, args } with args put before Pleni's own (the launcher script when
// the program is a Node.js script), or null. Only absolute, local folders count, and never the
// current folder, so a program with the same name in a project never runs instead. A program file
// must be a real program, not npm's small stand-in that its install step replaces.
//   Claude Code: claude.exe on PATH (its installer, WinGet); else, next to npm's claude.cmd, its
//   package's bin\claude.exe, or cli-wrapper.cjs or cli.js run by Pleni's own Node.js; else
//   %USERPROFILE%\.local\bin\claude.exe.
//   Codex: codex.exe on PATH (its installer, WinGet); else, next to npm's codex.cmd, its package's
//   bin\codex.js run by Pleni's own Node.js (it finds and runs the real codex.exe); else
//   %LOCALAPPDATA%\Programs\OpenAI\Codex\bin\codex.exe.
export function findTool(tool, { env = process.env, platform = process.platform, home = os.homedir(), size = fileSize, node = process.execPath } = {}) {
  const win = platform === 'win32';
  const p = win ? path.win32 : path.posix;
  const dirs = pathDirs(env, platform);
  const isProgram = (file) => size(file) >= MIN_PROGRAM_BYTES;
  const isScript = (file) => size(file) > 0 && plainLocal(node, p);
  const exe = win ? `${tool}.exe` : tool;
  for (const dir of dirs) {
    const file = p.join(dir, exe);
    if (isProgram(file)) return { file, args: [] };
  }
  if (!win) return null;
  const pkg = tool === 'claude' ? ['@anthropic-ai', 'claude-code'] : ['@openai', 'codex'];
  for (const dir of dirs) {
    if (size(p.join(dir, `${tool}.cmd`)) <= 0) continue;
    const base = p.join(dir, 'node_modules', ...pkg);
    if (tool === 'claude') {
      const native = p.join(base, 'bin', 'claude.exe');
      if (isProgram(native)) return { file: native, args: [] };
      for (const name of ['cli-wrapper.cjs', 'cli.js']) {
        const script = p.join(base, name);
        if (isScript(script)) return { file: node, args: [script] };
      }
    } else {
      const script = p.join(base, 'bin', 'codex.js');
      if (isScript(script)) return { file: node, args: [script] };
    }
  }
  const own = (base, ...parts) => (typeof base === 'string' && p.isAbsolute(base) && !/^[\\/]{2}/.test(base) ? p.join(base, ...parts) : null);
  const last = tool === 'claude' ? own(home, '.local', 'bin', 'claude.exe') : own(env.LOCALAPPDATA, 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe');
  return last && isProgram(last) ? { file: last, args: [] } : null;
}

function pathDirs(env, platform) {
  const win = platform === 'win32';
  const p = win ? path.win32 : path.posix;
  const name = Object.keys(env).find((k) => (win ? k.toUpperCase() === 'PATH' : k === 'PATH'));
  const list = name && typeof env[name] === 'string' ? env[name] : '';
  const out = [];
  for (const raw of list.split(win ? ';' : ':')) {
    const dir = raw.trim().replace(/^"(.*)"$/, '$1');
    if (dir && p.isAbsolute(dir) && !/^[\\/]{2}/.test(dir)) out.push(dir);
  }
  return out;
}

function plainLocal(file, p) {
  return typeof file === 'string' && p.isAbsolute(file) && !/^[\\/]{2}/.test(file);
}

// A file's size, or -1 when it is not a file.
function fileSize(file) {
  try {
    const info = fs.statSync(file);
    return info.isFile() ? info.size : -1;
  } catch {
    return -1;
  }
}

// Resolves the child once it has started, or null if it could not start.
function start(spawn, file, args, options) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(file, args, options);
    } catch {
      resolve(null);
      return;
    }
    child.once('spawn', () => resolve(child));
    child.once('error', () => resolve(null));
  });
}

// Calls done({ ok, code, otherSession }) once when the turn's program ends. For Claude Code, Pleni
// reads only the outcome fields of the one answer it writes at the end, never the answer itself.
function watch(child, tool, sessionId, done) {
  const chunks = [];
  let size = 0;
  if (tool === 'claude' && child.stdout) {
    child.stdout.on('data', (chunk) => {
      size += chunk.length;
      if (size <= MAX_RESULT_BYTES) chunks.push(chunk);
    });
    child.stdout.on('error', () => {});
  }
  let finished = false;
  const finish = (code) => {
    if (finished) return;
    finished = true;
    const outcome = tool === 'claude' ? claudeOutcome(Buffer.concat(chunks).toString('utf8'), code, sessionId) : { ok: code === 0, code, otherSession: false };
    chunks.length = 0;
    done(outcome);
  };
  child.once('close', (code) => finish(Number.isInteger(code) ? code : null));
  child.once('error', () => finish(null));
}

// { ok, code, otherSession } from Claude Code's answer (--output-format json) and its exit code.
export function claudeOutcome(text, code, sessionId) {
  let result = null;
  const lines = String(text).split('\n').map((line) => line.trim()).filter(Boolean);
  for (const line of lines.reverse()) {
    try {
      const value = JSON.parse(line);
      if (value && typeof value === 'object' && value.type === 'result') {
        result = value;
        break;
      }
    } catch {
      // Not the answer line.
    }
  }
  const otherSession = !!result && typeof result.session_id === 'string' && result.session_id !== sessionId;
  const ok = code === 0 && (!result || (result.is_error !== true && (result.subtype === undefined || result.subtype === 'success')));
  return { ok, code, otherSession };
}

// One line per send and one when it ends, in Pleni's own folder: never the message.
function writeLog(file, entry) {
  if (typeof file !== 'string' || !file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    if (fs.statSync(file).size > MAX_LOG_BYTES) {
      const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-KEEP_LOG_LINES);
      fs.writeFileSync(file, `${lines.join('\n')}\n`, { mode: 0o600 });
    }
  } catch {
    // The record is a convenience; a send never fails because of it.
  }
}

// The record of sends next to the settings file.
export function sendLogFile(settingsPath) {
  return path.join(path.dirname(settingsPath), LOG_FILE);
}

function refuse(status, error) {
  return { ok: false, status, error };
}
