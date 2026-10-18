// "Roll over": starts a fresh session that takes over from a long one, so the work stays quick and
// costs less. It is off until the person turns it on (settings.actions.rollover), works on Windows
// only for now, and the server allows it only for a request made on this computer. It has two steps,
// each a PowerShell window the person sees: "ask" resumes the old session with a request to write a
// handoff note, and "start" starts a new session in the same folder, with the same name, that reads
// the note first. Unlike Open in PowerShell, each window sends one message, but only a fixed one that
// the page shows first. Pleni builds it from the session's own name, and it holds only letters,
// digits, spaces and a few marks, so neither cmd.exe nor PowerShell can read any of it as a command.
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
  launch,
  plainWindowsDir,
  processAlive,
  toolEnv,
  windowsProcessStarts,
} from './open.js';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const SESSION_ID = new RegExp(`^${UUID}$`);
const ROLL_KEY = new RegExp(`^(claude|codex):(${UUID})$`);
const CLAUDE_HELPER_KEY = /^claude:[0-9a-f-]{8,64}\//;
const STEPS = new Set(['ask', 'start']);
// Where each tool keeps a name the person gave: Claude Code's /rename or --name (custom-title and
// agent-name records), and Codex's thread name (session_index.jsonl). A title the tool made up
// (ai-title) is not a name, and the relay could not follow it.
const OWN_NAME = { claude: new Set(['custom-title', 'agent-name']), codex: new Set(['session_index']) };
// Every mark here is plain text to cmd.exe inside double quotes, to PowerShell inside single quotes,
// and to the small .cmd files npm makes for command-line programs. Quotes, %, !, ^, &, |, <, >, $,
// backticks, backslashes and brackets are not, so a name with one of them is refused.
const NAME = /^[A-Za-z0-9*][A-Za-z0-9 ._#+*,-]*$/;
const TEXT = /^[A-Za-z0-9 ._#+*,:-]+$/;
export const MAX_NAME = 80;
const MAX_SLUG = 40;
const TITLES = { claude: 'Claude Code', codex: 'Codex' };

export const ROLL_MESSAGES = {
  off: 'Roll over is turned off. Turn it on in Settings first.',
  windowsOnly: 'Roll over works only on Windows for now.',
  otherTool: 'Only Claude Code sessions and Codex threads can be rolled over.',
  helper: 'A helper cannot be rolled over. Roll over the session that started it.',
  notMain: 'Only a main session can be rolled over, not a helper or a reviewer.',
  step: 'Pleni could not read which step to take.',
  demo: 'The demo has no real sessions to roll over.',
  gone: OPEN_MESSAGES.gone,
  noName: 'This session has no name of its own yet. Give it one first: type /rename and a name in it.',
  badName: 'This name has a sign Pleni cannot pass on safely. Rename the session using only letters, digits, spaces and . _ - # + * , signs.',
  longName: `This name is too long. Rename the session to ${MAX_NAME} letters or fewer.`,
  changed: "This session's name just changed. Look at the steps again, then try again.",
  desktopApp: 'This session belongs to the Claude desktop app. Copy the messages and paste them there.',
  vscode: 'This session belongs to VS Code. Copy the messages and paste them there.',
  codexElsewhere: 'Another Codex program has this thread open, most likely the Codex app. Copy the message and paste it into the thread there.',
  stillOpen: 'The old session is still open. Close it first: type /exit in its window. While it runs, a new session cannot take the same name.',
  stillWorking: 'The old session is still working. Wait until it has written the handoff note.',
};

// The name the tool itself keeps for this session, or null.
export function ownName(tool, session) {
  if (!Object.hasOwn(OWN_NAME, tool) || !OWN_NAME[tool].has(session?.titleSource)) return null;
  const name = typeof session.title === 'string' ? session.title.replace(/\s+/g, ' ').trim() : '';
  return name || null;
}

// Why this name cannot go on a command line, or null.
export function nameProblem(name) {
  if (typeof name !== 'string' || !name) return ROLL_MESSAGES.noName;
  if (name.length > MAX_NAME) return ROLL_MESSAGES.longName;
  if (!nameFits(name)) return ROLL_MESSAGES.badName;
  return null;
}

// True when this name may go on a command line: see NAME.
export function nameFits(name) {
  return typeof name === 'string' && name.length <= MAX_NAME && NAME.test(name) && /[A-Za-z0-9]/.test(name);
}

// "Sergeant Claude Code" -> "HANDOFF-sergeant-claude-code.md", in the session's own folder.
export function handoffFile(name) {
  const slug = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '').slice(0, MAX_SLUG).replace(/-+$/, '');
  return `HANDOFF-${slug || 'session'}.md`;
}

export function askText(file) {
  return `Pleni roll over: a new session will take over your work. Write a handoff note for it in ${file} in this folder. Say what work is open and where it stands, what waits on whom, and what else it must know. Do not commit the file. Then stop.`;
}

export function startText(name, file) {
  return `Pleni roll over: you take over from the last session named ${name}. First read ${file} in this folder. Then say in one line that you are ready.`;
}

// What the page shows before either step: { name, problem, file, ask, start, rename }. `problem` is
// a plain reason the session cannot be rolled over yet (no name, or one Pleni cannot pass on).
// Codex has no way to name a new thread when it starts, so the person types `rename` in it.
export function rolloverPlan(tool, session) {
  const name = ownName(tool, session);
  const problem = name ? nameProblem(name) : ROLL_MESSAGES.noName;
  if (problem) return { name, problem, file: null, ask: null, start: null, rename: null };
  const file = handoffFile(name);
  return { name, problem: null, file, ask: askText(file), start: startText(name, file), rename: tool === 'codex' ? `/rename ${name}` : null };
}

// What the page needs to show the steps: { ok: true, info: { name, problem, file, ask, start,
// rename, handoffAt } }, else { ok: false, status, error }. `handoffAt` is when the handoff note in
// the session's folder last changed, or null. Pleni only asks for its time, never reads it.
export function rolloverInfo({ key, settings, store, platform = process.platform, stat = fs.statSync }) {
  const head = rollHead(key, settings, store, platform);
  if (!head.ok) return head;
  const plan = rolloverPlan(head.tool, head.session);
  let handoffAt = null;
  if (plan.file && !folderProblem(head.session.cwd, platform)) handoffAt = fileTime(path.join(head.session.cwd, plan.file), stat);
  return { ok: true, info: { ...plan, handoffAt } };
}

// Takes one step for `key` ('claude:<session id>' or 'codex:<thread id>'): 'ask' or 'start'. `name`
// is the name the page showed: if the session's name changed since, nothing starts, so the message
// sent is always the one the person saw. Answers { ok: true } once the window is on its way, else
// { ok: false, status, error }. `limits` is shared with Open in PowerShell.
export async function rollover({
  key,
  step,
  name,
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
  const head = rollHead(key, settings, store, platform);
  if (!head.ok) return head;
  const { tool, id, session } = head;
  if (!STEPS.has(step)) return refuse(400, ROLL_MESSAGES.step);
  const plan = rolloverPlan(tool, session);
  if (plan.problem) return refuse(409, plan.problem);
  if (name !== plan.name) return refuse(409, ROLL_MESSAGES.changed);
  const folder = folderProblem(session.cwd, platform);
  if (folder) return refuse(409, folder);
  const root = roots?.[tool] ?? null;
  const problem = tool === 'claude'
    ? claudeRollProblem(step, session, await confirmProcesses(claudeProcesses(root, id, isAlive), processStarts))
    : codexRollProblem(step, session, step === 'ask' && isLocked(root, id));
  if (problem) return refuse(409, problem);
  // Asking resumes the old session, so it shares Open in PowerShell's "just opened" slot for it.
  const wait = limits.take(step === 'ask' ? key : `start:${key}`, now);
  if (wait) return refuse(429, wait);
  const text = step === 'ask' ? plan.ask : plan.start;
  const { file, args } = rollCommand(tool, step, { id, name: plan.name, text }, env.SystemRoot ?? env.SYSTEMROOT);
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

// Why a step would be unsafe for a Claude Code session, or null. Asking resumes the session, so it
// follows Open in PowerShell's one-writer rule, except that a live background session is refused
// too: the message must not land in a turn that is already running. Starting needs the old session
// closed, because Claude Code gives a new session another name while one with that name still runs.
export function claudeRollProblem(step, session, processes) {
  if (session.entrypoint === 'claude-desktop') return ROLL_MESSAGES.desktopApp;
  if (session.entrypoint === 'claude-vscode') return ROLL_MESSAGES.vscode;
  if (step === 'start') {
    if (processes.length) return ROLL_MESSAGES.stillOpen;
    return session.status === 'working' ? ROLL_MESSAGES.stillWorking : null;
  }
  if (processes.some((proc) => proc.entrypoint === 'cli' && proc.kind !== 'background')) return OPEN_MESSAGES.elsewhere;
  if (processes.length || session.status === 'working') return OPEN_MESSAGES.busy;
  return null;
}

// Why a step would be unsafe for a Codex thread, or null. Only asking writes to the old thread, so
// only asking needs it free. The Codex app holds every thread it has opened, so a new thread may
// start while the app runs.
export function codexRollProblem(step, session, locked) {
  if (step === 'start') return session.status === 'working' ? ROLL_MESSAGES.stillWorking : null;
  if (locked) return ROLL_MESSAGES.codexElsewhere;
  return session.status === 'working' ? OPEN_MESSAGES.busy : null;
}

// The same shape as Open in PowerShell's command, with the step's program and its one message:
//   ask, Claude Code:  claude --resume '<id>' '<text>'      ask, Codex:  codex resume '<id>' '<text>'
//   start, Claude Code: claude --name '<name>' '<text>'     start, Codex: codex '<text>'
// The id, the name and the text are checked again here, so nothing else can reach the line.
export function rollCommand(tool, step, { id, name, text }, systemRoot) {
  if (!Object.hasOwn(TITLES, tool)) throw new Error('Pleni can roll over only Claude Code and Codex sessions.');
  if (!STEPS.has(step)) throw new Error('That is not a roll over step.');
  if (!SESSION_ID.test(id)) throw new Error('That is not a session id.');
  if (typeof text !== 'string' || !TEXT.test(text)) throw new Error('That message cannot go on a command line.');
  if (nameProblem(name)) throw new Error('That name cannot go on a command line.');
  const run = {
    'claude:ask': `claude --resume '${id}' '${text}'`,
    'claude:start': `claude --name '${name}' '${text}'`,
    'codex:ask': `codex resume '${id}' '${text}'`,
    'codex:start': `codex '${text}'`,
  }[`${tool}:${step}`];
  const windows = plainWindowsDir(systemRoot);
  const powershell = `${windows}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
  const line = `start "${TITLES[tool]}" "${powershell}" -NoExit -NoLogo -Command "${run}"`;
  return { file: `${windows}\\System32\\cmd.exe`, args: ['/d', '/s', '/c', `"${line}"`] };
}

// The checks both the steps and the page's question share: the switch, Windows, a main session
// that is on the map, and not the demo.
function rollHead(key, settings, store, platform) {
  if (settings?.actions?.rollover !== true) return refuse(403, ROLL_MESSAGES.off);
  if (platform !== 'win32') return refuse(409, ROLL_MESSAGES.windowsOnly);
  const text = typeof key === 'string' ? key : '';
  const match = ROLL_KEY.exec(text);
  if (!match) return refuse(400, CLAUDE_HELPER_KEY.test(text) ? ROLL_MESSAGES.helper : ROLL_MESSAGES.otherTool);
  if (store.demo) return refuse(409, ROLL_MESSAGES.demo);
  const listed = (store.snapshot()?.nodes ?? []).some((node) => node?.key === text);
  const session = listed ? store.session?.(text) : null;
  if (!session) return refuse(404, ROLL_MESSAGES.gone);
  if (session.kind !== 'session') return refuse(400, ROLL_MESSAGES.notMain);
  return { ok: true, tool: match[1], id: match[2], session };
}

function fileTime(file, stat) {
  try {
    const info = stat(file);
    return info.isFile() ? Math.round(info.mtimeMs) : null;
  } catch {
    return null;
  }
}

function refuse(status, error) {
  return { ok: false, status, error };
}
