// "New agent": starts a new Claude Code session or Codex thread in a PowerShell window, in the
// folder of a session the person picked, so a team can grow from Pleni. It is off until the person
// turns it on (settings.actions.newAgent), works on Windows only for now, and the server allows it
// only for a request made on this computer. Pleni starts the window and sends nothing: the person
// types the first message there. The name is held to Roll over's plain marks, so neither cmd.exe
// nor PowerShell can read any of it as a command.
import { spawn as nodeSpawn } from 'node:child_process';
import os from 'node:os';
import { OPEN_MESSAGES, folderProblem, launch, plainWindowsDir, toolEnv } from './open.js';
import { MAX_NAME, nameFits } from './rollover.js';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
// The session whose folder the new agent works in: a main Claude Code session or a Codex thread.
const FROM_KEY = new RegExp(`^(claude|codex):${UUID}$`);
const TITLES = { claude: 'Claude Code', codex: 'Codex' };

export const NEW_MESSAGES = {
  off: 'Starting new agents is turned off. Turn on "New agent" in Settings, under Buttons, first.',
  windowsOnly: 'Starting a new agent in a window works only on Windows for now.',
  from: 'A new agent can start only next to a Claude Code session or a Codex thread.',
  reviewer: 'A new agent cannot start next to an automatic reviewer.',
  tool: 'Pick Claude Code or Codex for the new agent.',
  demo: 'The demo cannot start real agents.',
  gone: OPEN_MESSAGES.gone,
  noName: 'Type a name for the new agent.',
  longName: `Use ${MAX_NAME} letters or fewer for the name.`,
  badName: 'Use only letters, digits, spaces and . _ - # + * , signs in the name, and start it with a letter or a digit.',
  again: 'Pleni just started a new agent here. Look for the new window on your taskbar.',
};

// "  Sergeant   3 " -> "Sergeant 3". Anything else is checked by newNameProblem.
export function cleanName(name) {
  return typeof name === 'string' ? name.replace(/\s+/g, ' ').trim() : '';
}

// Why this name cannot be used for a new agent, or null.
export function newNameProblem(name) {
  if (typeof name !== 'string' || !name) return NEW_MESSAGES.noName;
  if (name.length > MAX_NAME) return NEW_MESSAGES.longName;
  return nameFits(name) ? null : NEW_MESSAGES.badName;
}

export function takenMessage(name) {
  return `A session named "${name}" is on the map already. Pick another name, or use Roll over to replace that one.`;
}

// Starts a new agent next to `from` ('claude:<session id>' or 'codex:<thread id>'), in its folder:
// `tool` is 'claude' or 'codex', and `name` the new agent's name. Answers { ok: true } once the
// window is on its way, else { ok: false, status, error } with a plain message. `limits` is shared
// with Open in PowerShell and Roll over.
export async function newAgent({
  from,
  tool,
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
}) {
  if (settings?.actions?.newAgent !== true) return refuse(403, NEW_MESSAGES.off);
  if (platform !== 'win32') return refuse(409, NEW_MESSAGES.windowsOnly);
  const key = typeof from === 'string' ? from : '';
  if (!FROM_KEY.test(key)) return refuse(400, NEW_MESSAGES.from);
  if (!Object.hasOwn(TITLES, tool)) return refuse(400, NEW_MESSAGES.tool);
  const clean = cleanName(name);
  const bad = newNameProblem(clean);
  if (bad) return refuse(400, bad);
  if (store.demo) return refuse(409, NEW_MESSAGES.demo);
  const nodes = store.snapshot()?.nodes ?? [];
  const node = nodes.find((n) => n?.key === key);
  const session = node ? store.session?.(key) : null;
  if (!session) return refuse(404, NEW_MESSAGES.gone);
  if (session.kind === 'reviewer') return refuse(400, NEW_MESSAGES.reviewer);
  const folder = folderProblem(session.cwd, platform);
  if (folder) return refuse(409, folder);
  // Pleni and the relay find agents by name, so two with one name would be mixed up.
  const want = clean.toLowerCase();
  const twin = nodes.some((n) => Object.hasOwn(TITLES, n?.platform) && typeof n.title === 'string' && n.title.replace(/\s+/g, ' ').trim().toLowerCase() === want);
  if (twin) return refuse(409, takenMessage(clean));
  const wait = limits.take(`new:${key}`, now);
  if (wait) return refuse(429, wait === OPEN_MESSAGES.again ? NEW_MESSAGES.again : wait);
  const { file, args } = newAgentCommand(tool, clean, env.SystemRoot ?? env.SYSTEMROOT);
  const options = {
    cwd: session.cwd,
    env: toolEnv(tool, env, roots?.[tool] ?? null, home, platform),
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
    windowsVerbatimArguments: true,
  };
  return (await launch(spawn, file, args, options)) ? { ok: true } : refuse(500, OPEN_MESSAGES.failed);
}

// The same shape as Open in PowerShell's command, with no message:
//   Claude Code: claude --name '<name>'      Codex: codex
// Codex has no way to take a name when it starts, so the person types /rename in it. The name is
// checked again here, so nothing else can reach the line.
export function newAgentCommand(tool, name, systemRoot) {
  if (!Object.hasOwn(TITLES, tool)) throw new Error('Pleni can start only Claude Code and Codex agents.');
  if (!nameFits(name) || name !== cleanName(name)) throw new Error('That name cannot go on a command line.');
  const run = tool === 'claude' ? `claude --name '${name}'` : 'codex';
  const windows = plainWindowsDir(systemRoot);
  const powershell = `${windows}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
  const line = `start "${TITLES[tool]}" "${powershell}" -NoExit -NoLogo -Command "${run}"`;
  return { file: `${windows}\\System32\\cmd.exe`, args: ['/d', '/s', '/c', `"${line}"`] };
}

function refuse(status, error) {
  return { ok: false, status, error };
}
