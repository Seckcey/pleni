import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OPEN_MESSAGES, openLimits, openSession } from '../src/open.js';
import {
  ROLL_MESSAGES,
  askText,
  claudeRollProblem,
  codexRollProblem,
  handoffFile,
  nameProblem,
  ownName,
  rollCommand,
  rollover,
  rolloverInfo,
  rolloverPlan,
  startText,
} from '../src/rollover.js';

const ID = '0f8e2c4a-1b3d-4e5f-8a9b-0c1d2e3f4a5b';
const KEY = `claude:${ID}`;
const CODEX_KEY = `codex:${ID}`;
const NAME = 'Sergeant Ada';
const FILE = 'HANDOFF-sergeant-ada.md';
const ON = { actions: { rollover: true } };
const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const CMD = 'C:\\Windows\\System32\\cmd.exe';
const line = (title, run) => `"start "${title}" "${POWERSHELL}" -NoExit -NoLogo -Command "${run}""`;

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pleni-roll-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// A Claude Code folder with one live-process file per entry, named after its process id.
function claudeRoot(t, entries = []) {
  const root = tempDir(t);
  fs.mkdirSync(path.join(root, 'sessions'));
  for (const entry of entries) fs.writeFileSync(path.join(root, 'sessions', `${entry.pid}.json`), JSON.stringify(entry));
  return root;
}

function fakeStore({ key = KEY, cwd, status = 'idle', entrypoint = 'cli', kind = 'session', title = NAME, titleSource, listed = true, demo = false } = {}) {
  const source = titleSource ?? (key.startsWith('codex:') ? 'session_index' : 'custom-title');
  return {
    demo,
    snapshot: () => ({ nodes: listed ? [{ key: 'you' }, { key }] : [{ key: 'you' }] }),
    session: (asked) => (asked === key ? { id: ID, cwd, status, entrypoint, kind, title, titleSource: source } : null),
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

async function roll(t, options = {}) {
  const folder = options.folder ?? tempDir(t);
  const spawn = options.spawn ?? fakeSpawn();
  const key = options.key ?? KEY;
  const result = await rollover({
    key,
    step: options.step ?? 'ask',
    name: options.name ?? NAME,
    settings: options.settings ?? ON,
    roots: { claude: options.root ?? claudeRoot(t), codex: options.codexRoot ?? null },
    store: options.store ?? fakeStore({ key, cwd: folder, status: options.status }),
    limits: options.limits ?? openLimits(),
    platform: options.platform ?? 'win32',
    env: { SystemRoot: 'C:\\Windows', Path: 'C:\\Windows\\System32' },
    home: 'C:\\Users\\ada',
    spawn,
    now: options.now ?? 1000,
    isAlive: () => true,
    isLocked: options.isLocked ?? (() => false),
    processStarts: (pids) => Promise.resolve(new Map(pids.map((pid) => [pid, 0]))),
  });
  return { result, spawn, folder };
}

function assertRefused(result, status, error) {
  assert.deepEqual(result, { ok: false, status, error });
}

// ---- the two steps ----

test('asking resumes the old session in a new PowerShell window with the handoff request', async (t) => {
  const { result, spawn, folder } = await roll(t);
  assert.deepEqual(result, { ok: true });
  assert.equal(spawn.calls.length, 1);
  const [{ file, args, options }] = spawn.calls;
  assert.equal(file, CMD);
  assert.deepEqual(args, ['/d', '/s', '/c', line('Claude Code', `claude --resume '${ID}' '${askText(FILE)}'`)]);
  assert.equal(options.cwd, folder);
  assert.equal(options.detached, true);
  assert.equal(options.windowsHide, false);
  assert.equal(options.windowsVerbatimArguments, true);
});

test('starting opens a new Claude Code session in the same folder, with the same name', async (t) => {
  const { result, spawn, folder } = await roll(t, { step: 'start' });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(spawn.calls[0].args.at(-1), line('Claude Code', `claude --name '${NAME}' '${startText(NAME, FILE)}'`));
  assert.equal(spawn.calls[0].options.cwd, folder);
});

test('a Codex thread is asked with codex resume, and the new one starts with codex', async (t) => {
  const asked = await roll(t, { key: CODEX_KEY });
  assert.deepEqual(asked.result, { ok: true });
  assert.equal(asked.spawn.calls[0].args.at(-1), line('Codex', `codex resume '${ID}' '${askText(FILE)}'`));
  const started = await roll(t, { key: CODEX_KEY, step: 'start' });
  assert.deepEqual(started.result, { ok: true });
  assert.equal(started.spawn.calls[0].args.at(-1), line('Codex', `codex '${startText(NAME, FILE)}'`));
});

test('it stays off until it is turned on, and works only on Windows', async (t) => {
  assertRefused((await roll(t, { settings: {} })).result, 403, ROLL_MESSAGES.off);
  assertRefused((await roll(t, { settings: { actions: { openTerminal: true } } })).result, 403, ROLL_MESSAGES.off);
  assertRefused((await roll(t, { platform: 'linux' })).result, 409, ROLL_MESSAGES.windowsOnly);
});

test('only a main Claude Code session or Codex thread on the map can be rolled over', async (t) => {
  const folder = tempDir(t);
  assertRefused((await roll(t, { key: `${KEY}/a1b2c3d4` })).result, 400, ROLL_MESSAGES.helper);
  assertRefused((await roll(t, { key: `grok:${ID}` })).result, 400, ROLL_MESSAGES.otherTool);
  assertRefused((await roll(t, { key: 'claude:not-an-id' })).result, 400, ROLL_MESSAGES.otherTool);
  for (const kind of ['agent', 'reviewer']) {
    const store = fakeStore({ key: CODEX_KEY, cwd: folder, kind });
    assertRefused((await roll(t, { key: CODEX_KEY, store })).result, 400, ROLL_MESSAGES.notMain);
  }
  assertRefused((await roll(t, { store: fakeStore({ cwd: folder, demo: true }) })).result, 409, ROLL_MESSAGES.demo);
  assertRefused((await roll(t, { store: fakeStore({ cwd: folder, listed: false }) })).result, 404, ROLL_MESSAGES.gone);
  assertRefused((await roll(t, { step: 'both' })).result, 400, ROLL_MESSAGES.step);
});

test('a session needs a name of its own that is safe to pass on, and the one the page showed', async (t) => {
  const folder = tempDir(t);
  const named = (title, titleSource) => fakeStore({ cwd: folder, title, titleSource });
  assertRefused((await roll(t, { store: named('Fix the login page', 'ai-title') })).result, 409, ROLL_MESSAGES.noName);
  assertRefused((await roll(t, { store: named(null, 'custom-title') })).result, 409, ROLL_MESSAGES.noName);
  for (const bad of [`Ada's work`, 'Ada "boss"', 'Ada & co', '50% done', 'Ada $env', 'Ada (lead)', 'C:\\work', '-rm']) {
    assertRefused((await roll(t, { store: named(bad, 'custom-title'), name: bad })).result, 409, ROLL_MESSAGES.badName);
  }
  const long = 'A'.repeat(81);
  assertRefused((await roll(t, { store: named(long, 'custom-title'), name: long })).result, 409, ROLL_MESSAGES.longName);
  const { result, spawn } = await roll(t, { name: 'Sergeant Bob' });
  assertRefused(result, 409, ROLL_MESSAGES.changed);
  assert.equal(spawn.calls.length, 0);
});

test('a missing or network folder is refused, so the new session never works in the wrong place', async (t) => {
  const gone = path.join(tempDir(t), 'gone');
  assertRefused((await roll(t, { store: fakeStore({ cwd: gone }) })).result, 409, OPEN_MESSAGES.noFolder);
  assertRefused((await roll(t, { store: fakeStore({ cwd: '\\\\server\\share\\work' }) })).result, 409, OPEN_MESSAGES.network);
});

test('asking a Claude Code session waits until no window or program has it open', async (t) => {
  const window = claudeRoot(t, [{ pid: 4242, sessionId: ID, kind: 'interactive', entrypoint: 'cli' }]);
  assertRefused((await roll(t, { root: window })).result, 409, OPEN_MESSAGES.elsewhere);
  const background = claudeRoot(t, [{ pid: 4343, sessionId: ID, kind: 'background', entrypoint: 'cli' }]);
  assertRefused((await roll(t, { root: background })).result, 409, OPEN_MESSAGES.busy);
  assertRefused((await roll(t, { status: 'working' })).result, 409, OPEN_MESSAGES.busy);
  const folder = tempDir(t);
  assertRefused((await roll(t, { store: fakeStore({ cwd: folder, entrypoint: 'claude-desktop' }) })).result, 409, ROLL_MESSAGES.desktopApp);
  assertRefused((await roll(t, { store: fakeStore({ cwd: folder, entrypoint: 'claude-vscode' }) })).result, 409, ROLL_MESSAGES.vscode);
});

test('starting a Claude Code session waits until the old one is closed and done', async (t) => {
  const open = claudeRoot(t, [{ pid: 4242, sessionId: ID, kind: 'background', entrypoint: 'cli' }]);
  assertRefused((await roll(t, { step: 'start', root: open })).result, 409, ROLL_MESSAGES.stillOpen);
  assertRefused((await roll(t, { step: 'start', status: 'working' })).result, 409, ROLL_MESSAGES.stillWorking);
});

test('a Codex thread open in the Codex app is asked there, and its new thread may still start', async (t) => {
  const locked = () => true;
  assertRefused((await roll(t, { key: CODEX_KEY, isLocked: locked })).result, 409, ROLL_MESSAGES.codexElsewhere);
  assertRefused((await roll(t, { key: CODEX_KEY, status: 'working' })).result, 409, OPEN_MESSAGES.busy);
  assert.deepEqual((await roll(t, { key: CODEX_KEY, step: 'start', isLocked: locked })).result, { ok: true });
  assertRefused((await roll(t, { key: CODEX_KEY, step: 'start', status: 'working' })).result, 409, ROLL_MESSAGES.stillWorking);
});

test('asking shares the "just opened" slot with Open in PowerShell; starting has its own', async (t) => {
  const limits = openLimits();
  const folder = tempDir(t);
  const root = claudeRoot(t);
  const opened = await openSession({
    key: KEY,
    settings: { actions: { openTerminal: true } },
    roots: { claude: root },
    store: fakeStore({ cwd: folder }),
    limits,
    platform: 'win32',
    env: { SystemRoot: 'C:\\Windows' },
    spawn: fakeSpawn(),
    now: 1000,
    isAlive: () => true,
  });
  assert.deepEqual(opened, { ok: true });
  assertRefused((await roll(t, { folder, root, limits, now: 2000 })).result, 429, OPEN_MESSAGES.again);
  assert.deepEqual((await roll(t, { folder, root, limits, now: 2000, step: 'start' })).result, { ok: true });
  assertRefused((await roll(t, { folder, root, limits, now: 3000, step: 'start' })).result, 429, OPEN_MESSAGES.again);
});

test('a start that fails gives a plain message', async (t) => {
  assertRefused((await roll(t, { spawn: fakeSpawn({ fail: true }) })).result, 500, OPEN_MESSAGES.failed);
});

// ---- what the page shows first ----

test('rolloverInfo gives the exact messages and when the handoff note last changed', (t) => {
  const folder = tempDir(t);
  const info = (store, platform = 'win32') => rolloverInfo({ key: KEY, settings: ON, store, platform });
  const before = info(fakeStore({ cwd: folder }));
  assert.deepEqual(before, {
    ok: true,
    info: { name: NAME, problem: null, file: FILE, ask: askText(FILE), start: startText(NAME, FILE), rename: null, handoffAt: null },
  });
  fs.writeFileSync(path.join(folder, FILE), 'notes');
  const at = new Date('2026-10-01T12:00:00Z');
  fs.utimesSync(path.join(folder, FILE), at, at);
  assert.equal(info(fakeStore({ cwd: folder })).info.handoffAt, at.getTime());
  fs.rmSync(path.join(folder, FILE));
  fs.mkdirSync(path.join(folder, FILE));
  assert.equal(info(fakeStore({ cwd: folder })).info.handoffAt, null, 'a folder is not a note');
  const codex = rolloverInfo({ key: CODEX_KEY, settings: ON, store: fakeStore({ key: CODEX_KEY, cwd: folder }), platform: 'win32' });
  assert.equal(codex.info.rename, `/rename ${NAME}`);
  const unnamed = info(fakeStore({ cwd: folder, title: 'Fix the login page', titleSource: 'ai-title' }));
  assert.deepEqual(unnamed.info, { name: null, problem: ROLL_MESSAGES.noName, file: null, ask: null, start: null, rename: null, handoffAt: null });
  assertRefused(info(fakeStore({ cwd: folder }), 'linux'), 409, ROLL_MESSAGES.windowsOnly);
  assertRefused(rolloverInfo({ key: KEY, settings: {}, store: fakeStore({ cwd: folder }), platform: 'win32' }), 403, ROLL_MESSAGES.off);
});

// ---- the parts ----

test('ownName takes only a name the person gave, never one the tool made up', () => {
  assert.equal(ownName('claude', { title: '  Sergeant   Ada ', titleSource: 'custom-title' }), 'Sergeant Ada');
  assert.equal(ownName('claude', { title: 'Sergeant Ada', titleSource: 'agent-name' }), 'Sergeant Ada');
  assert.equal(ownName('claude', { title: 'Fix the login page', titleSource: 'ai-title' }), null);
  assert.equal(ownName('claude', { title: 'Old chat', titleSource: 'desktop' }), null);
  assert.equal(ownName('codex', { title: '**Colonel', titleSource: 'session_index' }), '**Colonel');
  assert.equal(ownName('codex', { title: 'Euler', titleSource: 'agent_nickname' }), null);
  assert.equal(ownName('grok', { title: 'Ada', titleSource: 'custom-title' }), null);
  assert.equal(ownName('claude', null), null);
});

test('nameProblem allows letters, digits, spaces and a few plain marks', () => {
  for (const good of ['Sergeant Ada', '**Colonel', 'W2 build.v3', 'Team #4, lead', 'a+b_c-d']) assert.equal(nameProblem(good), null, good);
  for (const bad of ['', '***', ' Ada', '-Ada', 'Ada\nBob', 'Ada\tBob', 'Adá', 'Ada!', 'Ada^', 'Ada|Bob', 'Ada<Bob', 'Ada`Bob', 'Ada/Bob']) {
    assert.notEqual(nameProblem(bad), null, JSON.stringify(bad));
  }
  assert.equal(nameProblem('A'.repeat(80)), null);
  assert.equal(nameProblem('A'.repeat(81)), ROLL_MESSAGES.longName);
});

test('handoffFile makes a short plain file name from any name', () => {
  assert.equal(handoffFile('Sergeant Claude Code'), 'HANDOFF-sergeant-claude-code.md');
  assert.equal(handoffFile('**Colonel'), 'HANDOFF-colonel.md');
  assert.equal(handoffFile('***'), 'HANDOFF-session.md');
  assert.equal(handoffFile('A'.repeat(39) + ' B'), `HANDOFF-${'a'.repeat(39)}.md`);
});

test('rolloverPlan has no messages for a session it cannot roll over', () => {
  assert.equal(rolloverPlan('claude', { title: 'Ada "boss"', titleSource: 'custom-title' }).problem, ROLL_MESSAGES.badName);
  assert.equal(rolloverPlan('claude', { title: 'Ada "boss"', titleSource: 'custom-title' }).ask, null);
});

test('rollCommand checks every part again, so nothing else reaches the line', () => {
  const ask = askText(FILE);
  assert.throws(() => rollCommand('grok', 'ask', { id: ID, name: NAME, text: ask }), /only Claude Code and Codex/);
  assert.throws(() => rollCommand('claude', 'stop', { id: ID, name: NAME, text: ask }), /not a roll over step/);
  assert.throws(() => rollCommand('claude', 'ask', { id: 'x', name: NAME, text: ask }), /not a session id/);
  assert.throws(() => rollCommand('claude', 'ask', { id: ID, name: NAME, text: `${ask}' ; calc ; '` }), /cannot go on a command line/);
  assert.throws(() => rollCommand('claude', 'start', { id: ID, name: `Ada' ; calc ; '`, text: ask }), /cannot go on a command line/);
  const plain = rollCommand('codex', 'start', { id: ID, name: NAME, text: startText(NAME, FILE) }, 'D:\\Win dows');
  assert.equal(plain.file, CMD, 'a Windows folder with a space is not used');
});

test('the fixed messages hold no sign that cmd.exe or PowerShell would act on', () => {
  for (const text of [askText(FILE), startText(NAME, FILE), startText('**Team #4, lead', handoffFile('**Team #4, lead'))]) {
    assert.match(text, /^[A-Za-z0-9 ._#+*,:-]+$/);
  }
});

test('claudeRollProblem and codexRollProblem keep the old session to one writer', () => {
  const idle = { status: 'idle', entrypoint: 'cli' };
  assert.equal(claudeRollProblem('ask', idle, []), null);
  assert.equal(claudeRollProblem('start', idle, []), null);
  assert.equal(claudeRollProblem('start', idle, [{ pid: 1, kind: 'interactive', entrypoint: 'cli' }]), ROLL_MESSAGES.stillOpen);
  assert.equal(claudeRollProblem('ask', { ...idle, status: 'working' }, []), OPEN_MESSAGES.busy);
  assert.equal(codexRollProblem('ask', idle, false), null);
  assert.equal(codexRollProblem('ask', { status: 'working' }, true), ROLL_MESSAGES.codexElsewhere);
  assert.equal(codexRollProblem('start', idle, true), null);
});
