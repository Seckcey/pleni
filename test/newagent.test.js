import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NEW_MESSAGES, cleanName, newAgent, newAgentCommand, newNameProblem, takenMessage } from '../src/newagent.js';
import { OPEN_MESSAGES, openLimits } from '../src/open.js';

const ID = '0f8e2c4a-1b3d-4e5f-8a9b-0c1d2e3f4a5b';
const KEY = `claude:${ID}`;
const CODEX_KEY = `codex:${ID}`;
const NAME = 'Sergeant 3';
const ON = { actions: { newAgent: true } };
const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const CMD = 'C:\\Windows\\System32\\cmd.exe';
const line = (title, run) => `"start "${title}" "${POWERSHELL}" -NoExit -NoLogo -Command "${run}""`;

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pleni-new-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// A map with the session the new agent starts next to, plus any other tiles.
function fakeStore({ key = KEY, cwd, kind = 'session', listed = true, demo = false, others = [] } = {}) {
  const platform = key.slice(0, key.indexOf(':'));
  return {
    demo,
    snapshot: () => ({ nodes: [{ key: 'you' }, ...(listed ? [{ key, platform, title: 'Colonel Ada' }] : []), ...others] }),
    session: (asked) => (asked === key ? { id: ID, cwd, status: 'idle', entrypoint: 'cli', kind, title: 'Colonel Ada', titleSource: 'custom-title' } : null),
  };
}

// Stands in for child_process.spawn: records each call, then starts on the next tick.
function fakeSpawn({ fail = false } = {}) {
  const calls = [];
  const spawn = (file, args, options) => {
    const child = new EventEmitter();
    child.unref = () => {};
    calls.push({ file, args, options });
    process.nextTick(() => (fail ? child.emit('error', new Error('secret stack detail')) : child.emit('spawn')));
    return child;
  };
  spawn.calls = calls;
  return spawn;
}

// Each option that is left out gets a good value; one given as undefined or null stays so.
async function start(t, options = {}) {
  const pick = (name, fallback) => (Object.hasOwn(options, name) ? options[name] : fallback);
  const folder = options.folder ?? tempDir(t);
  const spawn = options.spawn ?? fakeSpawn();
  const from = pick('from', KEY);
  const result = await newAgent({
    from,
    tool: pick('tool', 'claude'),
    name: pick('name', NAME),
    settings: options.settings ?? ON,
    roots: options.roots ?? {},
    store: options.store ?? fakeStore({ key: typeof from === 'string' && from ? from : KEY, cwd: folder }),
    limits: options.limits ?? openLimits(),
    platform: options.platform ?? 'win32',
    env: { SystemRoot: 'C:\\Windows', Path: 'C:\\Windows\\System32' },
    home: 'C:\\Users\\ada',
    spawn,
    now: options.now ?? 1000,
  });
  return { result, spawn, folder };
}

function assertRefused(result, status, error) {
  assert.deepEqual(result, { ok: false, status, error });
}

test('a new Claude Code agent starts with its name, in the folder of the session it starts next to', async (t) => {
  const { result, spawn, folder } = await start(t);
  assert.deepEqual(result, { ok: true });
  assert.equal(spawn.calls.length, 1);
  const [{ file, args, options }] = spawn.calls;
  assert.equal(file, CMD);
  assert.deepEqual(args, ['/d', '/s', '/c', line('Claude Code', `claude --name '${NAME}'`)]);
  assert.equal(options.cwd, folder);
  assert.equal(options.detached, true);
  assert.equal(options.windowsHide, false);
  assert.equal(options.windowsVerbatimArguments, true);
});

test('a new Codex agent starts with codex alone, also next to a Claude Code session', async (t) => {
  for (const from of [KEY, CODEX_KEY]) {
    const { result, spawn } = await start(t, { from, tool: 'codex' });
    assert.deepEqual(result, { ok: true });
    assert.equal(spawn.calls[0].args.at(-1), line('Codex', 'codex'));
  }
});

test('the new agent reads the folder Pleni reads for its own tool', async (t) => {
  const codexRoot = tempDir(t);
  const { spawn } = await start(t, { tool: 'codex', roots: { claude: tempDir(t), codex: codexRoot } });
  assert.equal(spawn.calls[0].options.env.CODEX_HOME, codexRoot);
  assert.equal(spawn.calls[0].options.env.CLAUDE_CONFIG_DIR, undefined);
});

test('it stays off until it is turned on, and works only on Windows', async (t) => {
  assertRefused((await start(t, { settings: {} })).result, 403, NEW_MESSAGES.off);
  assertRefused((await start(t, { settings: { actions: { openTerminal: true, rollover: true } } })).result, 403, NEW_MESSAGES.off);
  assertRefused((await start(t, { settings: { actions: { newAgent: 'true' } } })).result, 403, NEW_MESSAGES.off);
  assertRefused((await start(t, { platform: 'linux' })).result, 409, NEW_MESSAGES.windowsOnly);
});

test('it starts only next to a Claude Code session or a Codex thread on the map', async (t) => {
  const folder = tempDir(t);
  for (const from of [`${KEY}/a1b2c3`, 'grok:abc', 'project:alpha', 'you', '', null]) {
    assertRefused((await start(t, { from, store: fakeStore({ cwd: folder }) })).result, 400, NEW_MESSAGES.from);
  }
  assertRefused((await start(t, { store: fakeStore({ cwd: folder, listed: false }) })).result, 404, NEW_MESSAGES.gone);
  assertRefused((await start(t, { store: fakeStore({ cwd: folder, demo: true }) })).result, 409, NEW_MESSAGES.demo);
  assertRefused((await start(t, { from: CODEX_KEY, store: fakeStore({ key: CODEX_KEY, cwd: folder, kind: 'reviewer' }) })).result, 400, NEW_MESSAGES.reviewer);
  const helper = await start(t, { from: CODEX_KEY, store: fakeStore({ key: CODEX_KEY, cwd: folder, kind: 'agent' }) });
  assert.deepEqual(helper.result, { ok: true }, 'a Codex helper is a thread with a folder of its own');
});

test('only Claude Code and Codex can be started', async (t) => {
  for (const tool of ['grok', 'kimi', '', undefined, 'toString']) assertRefused((await start(t, { tool })).result, 400, NEW_MESSAGES.tool);
});

test('the name is needed, and only letters, digits, spaces and a few plain marks may go on the line', async (t) => {
  for (const name of ['', '   ', undefined, 42]) assertRefused((await start(t, { name })).result, 400, NEW_MESSAGES.noName);
  for (const name of [`Ada' ; calc ; '`, 'Ada "boss"', 'Ada & co', 'Ada $(calc)', 'Ada`calc', '-flag', '...', 'Ada|calc', 'Ada%PATH%']) {
    assertRefused((await start(t, { name })).result, 400, NEW_MESSAGES.badName);
  }
  assertRefused((await start(t, { name: 'a'.repeat(81) })).result, 400, NEW_MESSAGES.longName);
  const tidy = await start(t, { name: '  Sergeant   3 ' });
  assert.deepEqual(tidy.result, { ok: true });
  assert.equal(tidy.spawn.calls[0].args.at(-1), line('Claude Code', `claude --name '${NAME}'`), 'extra spaces are dropped');
  const marks = await start(t, { name: '*Team #4, lead_2.b+c' });
  assert.deepEqual(marks.result, { ok: true });
});

test('a name a session on the map already has is refused, so Pleni and the relay can tell them apart', async (t) => {
  const folder = tempDir(t);
  const others = [{ key: 'codex:x', platform: 'codex', title: 'sergeant  3' }];
  assertRefused((await start(t, { store: fakeStore({ cwd: folder, others }) })).result, 409, takenMessage(NAME));
  const kimi = [{ key: 'kimi:x', platform: 'kimi', title: NAME }];
  assert.deepEqual((await start(t, { store: fakeStore({ cwd: folder, others: kimi }) })).result, { ok: true }, 'only Claude Code and Codex names count');
});

test('a missing or network folder is refused, so the new agent never works in the wrong place', async (t) => {
  const gone = path.join(tempDir(t), 'gone');
  assertRefused((await start(t, { store: fakeStore({ cwd: gone }) })).result, 409, OPEN_MESSAGES.noFolder);
  assertRefused((await start(t, { store: fakeStore({ cwd: '\\\\server\\share\\work' }) })).result, 409, OPEN_MESSAGES.network);
});

test('a second click starts no second window, and the limits are shared with the other buttons', async (t) => {
  const limits = openLimits();
  const folder = tempDir(t);
  assert.deepEqual((await start(t, { folder, limits, now: 1000 })).result, { ok: true });
  assertRefused((await start(t, { folder, limits, now: 2000 })).result, 429, NEW_MESSAGES.again);
  assert.deepEqual((await start(t, { folder, limits, now: 20000 })).result, { ok: true }, 'it works again after a few seconds');
  for (let i = 0; i < 8; i += 1) assert.equal(limits.take(`other:${i}`, 20000), null);
  assertRefused((await start(t, { folder, limits, now: 40000, from: CODEX_KEY, store: fakeStore({ key: CODEX_KEY, cwd: folder }) })).result, 429, OPEN_MESSAGES.tooMany);
});

test('a start that fails gives a plain message', async (t) => {
  assertRefused((await start(t, { spawn: fakeSpawn({ fail: true }) })).result, 500, OPEN_MESSAGES.failed);
});

test('cleanName and newNameProblem', () => {
  assert.equal(cleanName('  Sergeant \t 3\n'), 'Sergeant 3');
  assert.equal(cleanName(null), '');
  assert.equal(newNameProblem('Sergeant 3'), null);
  assert.equal(newNameProblem(''), NEW_MESSAGES.noName);
  assert.equal(newNameProblem('Ada (2)'), NEW_MESSAGES.badName);
});

test('newAgentCommand checks every part again, so nothing else reaches the line', () => {
  assert.throws(() => newAgentCommand('grok', NAME), /only Claude Code and Codex/);
  assert.throws(() => newAgentCommand('claude', `Ada' ; calc ; '`), /cannot go on a command line/);
  assert.throws(() => newAgentCommand('claude', ' Ada'), /cannot go on a command line/);
  assert.throws(() => newAgentCommand('codex', ''), /cannot go on a command line/);
  const plain = newAgentCommand('claude', NAME, 'D:\\Win dows');
  assert.equal(plain.file, CMD, 'a Windows folder with a space is not used');
});
