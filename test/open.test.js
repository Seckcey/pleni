import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn as realSpawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  OPEN_MESSAGES,
  claudeProcesses,
  confirmProcesses,
  codexProblem,
  codexThreadLocked,
  openLimits,
  openProblem,
  openSession,
  parseStarts,
  powershellCommand,
  processAlive,
  toolEnv,
  windowsProcessStarts,
} from '../src/open.js';

const ID = '0f8e2c4a-1b3d-4e5f-8a9b-0c1d2e3f4a5b';
const KEY = `claude:${ID}`;
const CODEX_KEY = `codex:${ID}`;
const ON = { actions: { openTerminal: true } };
const CMD = 'C:\\Windows\\System32\\cmd.exe';
const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const LINE = `"start "Claude Code" "${POWERSHELL}" -NoExit -NoLogo -Command "claude --resume '${ID}'""`;
const CODEX_LINE = `"start "Codex" "${POWERSHELL}" -NoExit -NoLogo -Command "codex resume '${ID}'""`;

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pleni-open-'));
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

function fakeStore({ key = KEY, cwd, status = 'idle', entrypoint = 'cli', kind = 'session', listed = true, demo = false } = {}) {
  return {
    demo,
    snapshot: () => ({ nodes: listed ? [{ key: 'you' }, { key }] : [{ key: 'you' }] }),
    session: (asked) => (asked === key ? { id: ID, cwd, status, entrypoint, kind } : null),
  };
}

// Stands in for child_process.spawn: records each call, then starts (or fails) on the next tick.
function fakeSpawn({ fail = false, throws = false } = {}) {
  const calls = [];
  const spawn = (file, args, options) => {
    if (throws) throw new Error('secret stack detail');
    const child = new EventEmitter();
    child.unref = () => {
      child.unrefed = true;
    };
    calls.push({ file, args, options, child });
    process.nextTick(() => (fail ? child.emit('error', new Error('secret stack detail')) : child.emit('spawn')));
    return child;
  };
  spawn.calls = calls;
  return spawn;
}

async function open(t, options = {}) {
  const folder = options.folder ?? tempDir(t);
  const spawn = options.spawn ?? fakeSpawn();
  const result = await openSession({
    key: KEY,
    settings: ON,
    roots: { claude: options.root ?? claudeRoot(t), codex: options.codexRoot ?? null },
    store: options.store ?? fakeStore({ cwd: folder, status: options.status }),
    limits: options.limits ?? openLimits(),
    platform: 'win32',
    env: { SystemRoot: 'C:\\Windows', Path: 'C:\\Windows\\System32' },
    home: 'C:\\Users\\ada',
    spawn,
    now: options.now ?? 1000,
    isAlive: options.isAlive ?? (() => true),
    isLocked: options.isLocked ?? (() => false),
    // Unless a test says otherwise, every live process started long before it wrote its file.
    processStarts: options.processStarts ?? ((pids) => Promise.resolve(new Map(pids.map((pid) => [pid, 0])))),
    ...options.args,
  });
  return { result, spawn, folder };
}

function assertRefused(result, status, error) {
  assert.deepEqual(result, { ok: false, status, error });
}

// ---- opening ----

test('opening starts PowerShell through cmd.exe, in the session folder, with nothing for a shell to read', async (t) => {
  const { result, spawn, folder } = await open(t);
  assert.deepEqual(result, { ok: true });
  assert.equal(spawn.calls.length, 1);
  const [call] = spawn.calls;
  assert.equal(call.file, CMD);
  assert.deepEqual(call.args, ['/d', '/s', '/c', LINE]);
  assert.equal(call.options.cwd, folder);
  assert.equal(call.options.detached, true);
  assert.equal(call.options.stdio, 'ignore');
  assert.equal(call.options.windowsHide, false, 'a hidden start could hide the new window too');
  assert.equal(call.options.windowsVerbatimArguments, true);
  assert.equal('shell' in call.options, false);
  assert.equal(call.options.env.Path, 'C:\\Windows\\System32');
  assert.equal(call.child.unrefed, true, 'Pleni does not wait for the window to close');
});

test('it stays off until it is turned on, and works only on Windows', async (t) => {
  for (const settings of [{}, { actions: {} }, { actions: { openTerminal: 'true' } }, null]) {
    const { result, spawn } = await open(t, { args: { settings } });
    assertRefused(result, 403, OPEN_MESSAGES.off);
    assert.equal(spawn.calls.length, 0);
  }
  for (const platform of ['linux', 'darwin']) {
    const { result, spawn } = await open(t, { args: { platform } });
    assertRefused(result, 409, OPEN_MESSAGES.windowsOnly);
    assert.equal(spawn.calls.length, 0);
  }
});

test('only a top-level Claude Code session or a Codex thread can be opened', async (t) => {
  const helper = await open(t, { args: { key: `${KEY}/a1b2c3` } });
  assertRefused(helper.result, 400, OPEN_MESSAGES.helper);
  const others = [`grok:${ID}`, `kimi:${ID}`, `codex:${ID}/a1b2`, 'claude:../../x', `claude:${ID.toUpperCase()}`, `claude:${ID} & calc`, `codex:${ID}' ; calc`, 42, undefined];
  for (const key of others) {
    const { result, spawn } = await open(t, { args: { key } });
    assertRefused(result, 400, OPEN_MESSAGES.otherTool);
    assert.equal(spawn.calls.length, 0, String(key));
  }
});

test('the demo, and sessions that are not on the map, are refused', async (t) => {
  const folder = tempDir(t);
  const demo = await open(t, { store: fakeStore({ cwd: folder, demo: true }) });
  assertRefused(demo.result, 409, OPEN_MESSAGES.demo);
  const unlisted = await open(t, { store: fakeStore({ cwd: folder, listed: false }) });
  assertRefused(unlisted.result, 404, OPEN_MESSAGES.gone);
  const unknown = { ...fakeStore({ cwd: folder }), session: () => null };
  assertRefused((await open(t, { store: unknown })).result, 404, OPEN_MESSAGES.gone);
});

test('a missing or network folder is refused, so a session never works in the wrong place', async (t) => {
  const base = tempDir(t);
  const file = path.join(base, 'notes.txt');
  fs.writeFileSync(file, 'not a folder');
  for (const cwd of [path.join(base, 'gone'), file, null, '', 'relative/project']) {
    const { result, spawn } = await open(t, { store: fakeStore({ cwd }) });
    assertRefused(result, 409, OPEN_MESSAGES.noFolder);
    assert.equal(spawn.calls.length, 0, String(cwd));
  }
  for (const cwd of ['\\\\server\\share\\project', '//server/share/project']) {
    const { result } = await open(t, { store: fakeStore({ cwd }) });
    assertRefused(result, 409, OPEN_MESSAGES.network);
  }
});

test('a session open in another window is refused; a background session opens live', async (t) => {
  const live = (kind, entrypoint = 'cli') => claudeRoot(t, [{ pid: 4242, sessionId: ID, kind, status: 'idle', entrypoint }]);
  assertRefused((await open(t, { root: live('interactive') })).result, 409, OPEN_MESSAGES.elsewhere);
  // A script (claude -p) or another app has no window to point at: it is busy instead.
  assertRefused((await open(t, { root: live('interactive', 'sdk-cli') })).result, 409, OPEN_MESSAGES.busy);
  assertRefused((await open(t, { root: live('some-new-kind', null) })).result, 409, OPEN_MESSAGES.busy);
  assertRefused((await open(t, { root: live(null, null) })).result, 409, OPEN_MESSAGES.busy);
  // "claude --resume" shows a running background session live, even in the middle of a turn.
  const background = await open(t, { root: live('background'), status: 'working' });
  assert.deepEqual(background.result, { ok: true });
  // A file left behind by a process that has ended does not count.
  assert.deepEqual((await open(t, { root: live('interactive'), isAlive: () => false })).result, { ok: true });
  // Nor does another session's process.
  const other = claudeRoot(t, [{ pid: 4242, sessionId: 'aaaaaaaa-0000-4000-8000-000000000001', kind: 'interactive', entrypoint: 'cli' }]);
  assert.deepEqual((await open(t, { root: other })).result, { ok: true });
});

test('a file left behind by a closed window does not count once Windows gives its number to another program', async (t) => {
  const root = claudeRoot(t, [{ pid: 4242, sessionId: ID, kind: 'interactive', status: 'idle', entrypoint: 'cli' }]);
  const writtenAt = fs.statSync(path.join(root, 'sessions', '4242.json')).mtimeMs;
  const startedAt = (ms) => () => Promise.resolve(new Map([[4242, ms]]));
  // The program now using number 4242 started after the file was written, so it did not write it.
  assert.deepEqual((await open(t, { root, processStarts: startedAt(writtenAt + 60000) })).result, { ok: true });
  // A system program Windows will not describe is not the Claude Code that wrote the file either.
  assert.deepEqual((await open(t, { root, processStarts: startedAt(null) })).result, { ok: true });
  assert.deepEqual((await open(t, { root, processStarts: () => Promise.resolve(new Map()) })).result, { ok: true });
  // The Claude Code that wrote the file started before it.
  assertRefused((await open(t, { root, processStarts: startedAt(writtenAt - 60000) })).result, 409, OPEN_MESSAGES.elsewhere);
  // When Pleni cannot learn the start times, it stays on the safe side.
  const broken = () => Promise.reject(new Error('secret stack detail'));
  assertRefused((await open(t, { root, processStarts: broken })).result, 409, OPEN_MESSAGES.elsewhere);
});

test('a session of the Claude desktop app or VS Code is opened there, not in a second window', async (t) => {
  const folder = tempDir(t);
  const desktop = await open(t, { store: fakeStore({ cwd: folder, entrypoint: 'claude-desktop' }) });
  assertRefused(desktop.result, 409, OPEN_MESSAGES.desktopApp);
  const vscode = await open(t, { store: fakeStore({ cwd: folder, entrypoint: 'claude-vscode' }) });
  assertRefused(vscode.result, 409, OPEN_MESSAGES.vscode);
  assert.equal(desktop.spawn.calls.length + vscode.spawn.calls.length, 0);
  // A script's session (claude -p) and a terminal's session open once nothing else has them.
  for (const entrypoint of ['sdk-cli', 'cli', null]) {
    assert.deepEqual((await open(t, { store: fakeStore({ cwd: folder, entrypoint }) })).result, { ok: true }, String(entrypoint));
  }
});

test('a turn running with no window (a script or another app) is refused until it finishes', async (t) => {
  const busy = await open(t, { status: 'working' });
  assertRefused(busy.result, 409, OPEN_MESSAGES.busy);
  assert.equal(busy.spawn.calls.length, 0);
  for (const status of ['idle', 'ready', 'error', null]) {
    assert.deepEqual((await open(t, { status })).result, { ok: true }, String(status));
  }
});

test('a double click opens one window, and a stuck page cannot open many', async (t) => {
  const limits = openLimits();
  const first = await open(t, { limits, now: 1000 });
  assert.deepEqual(first.result, { ok: true });
  const again = await open(t, { limits, now: 6000 });
  assertRefused(again.result, 429, OPEN_MESSAGES.again);
  assert.equal(again.spawn.calls.length, 0);
  assert.deepEqual((await open(t, { limits, now: 11000 })).result, { ok: true });

  const many = openLimits();
  for (let i = 0; i < 10; i++) assert.equal(many.take(`claude:${i}`, 1000 + i), null);
  assert.equal(many.take('claude:another', 2000), OPEN_MESSAGES.tooMany);
  assert.equal(many.take('claude:another', 61000), null, 'a minute later it works again');
});

test('a refusal does not use up the next try', async (t) => {
  const limits = openLimits();
  assertRefused((await open(t, { limits, status: 'working' })).result, 409, OPEN_MESSAGES.busy);
  assert.deepEqual((await open(t, { limits, now: 1500 })).result, { ok: true });
});

test('a start that fails gives a plain message', async (t) => {
  assertRefused((await open(t, { spawn: fakeSpawn({ fail: true }) })).result, 500, OPEN_MESSAGES.failed);
  assertRefused((await open(t, { spawn: fakeSpawn({ throws: true }) })).result, 500, OPEN_MESSAGES.failed);
});

// ---- the parts ----

test('openProblem allows only a background session to be live already', () => {
  assert.equal(openProblem({ status: 'idle' }, []), null);
  assert.equal(openProblem({ status: 'idle', entrypoint: 'claude-desktop' }, []), OPEN_MESSAGES.desktopApp);
  assert.equal(openProblem({ status: 'working' }, []), OPEN_MESSAGES.busy);
  assert.equal(openProblem({ status: 'working' }, [{ kind: 'background' }]), null);
  assert.equal(openProblem({ status: 'idle' }, [{ kind: 'background' }, { kind: 'interactive', entrypoint: 'cli' }]), OPEN_MESSAGES.elsewhere);
  assert.equal(openProblem({ status: 'idle' }, [{ kind: 'interactive', entrypoint: 'sdk-cli' }]), OPEN_MESSAGES.busy);
  assert.equal(openProblem({ status: 'idle' }, [{ kind: null }]), OPEN_MESSAGES.busy);
  assert.equal(openProblem({ status: 'idle' }, [{ kind: 'interactive', entrypoint: 'sdk-cli' }, { kind: 'interactive', entrypoint: 'cli' }]), OPEN_MESSAGES.elsewhere);
});

test('confirmProcesses keeps only processes that started before they last wrote their file', async () => {
  const found = [{ pid: 1, writtenAt: 10000 }, { pid: 2, writtenAt: 10000 }, { pid: 3, writtenAt: 10000 }, { pid: 4, writtenAt: 10000 }];
  const starts = new Map([[1, 5000], [2, 11500], [3, 13000], [4, null]]);
  assert.deepEqual((await confirmProcesses(found, async () => starts)).map((p) => p.pid), [1, 2], 'a little clock rounding is allowed');
  assert.deepEqual(await confirmProcesses([], async () => { throw new Error('not asked'); }), []);
  assert.deepEqual(await confirmProcesses(found, async () => 'junk'), found);
  assert.deepEqual(await confirmProcesses(found, async () => { throw new Error('no PowerShell'); }), found);
});

test('windowsProcessStarts asks a hidden PowerShell, with only whole numbers in its command', async () => {
  const calls = [];
  const execFile = (file, args, options, done) => {
    calls.push({ file, args, options });
    done(null, '4242 1792011600123\r\n77 -\r\n');
  };
  const starts = await windowsProcessStarts([4242, 77, 4242, -1, 1.5, 'x'], { systemRoot: 'C:\\Windows', execFile });
  assert.deepEqual([...starts], [[4242, 1792011600123], [77, null]]);
  assert.equal(calls.length, 1);
  const [call] = calls;
  assert.equal(call.file, POWERSHELL);
  assert.deepEqual(call.args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-Command']);
  assert.match(call.args[3], /^Get-Process -Id 4242,77 -ErrorAction SilentlyContinue /);
  assert.match(call.args[3], /; exit 0$/, 'a process that is gone must not fail the whole question');
  assert.equal(call.options.windowsHide, true);
  assert.equal(call.options.cwd, 'C:\\Windows');
  assert.ok(call.options.timeout > 0);
  assert.deepEqual([...(await windowsProcessStarts([], { execFile }))], []);
  assert.equal(calls.length, 1, 'nothing to ask, nothing started');
  const failing = (file, args, options, done) => done(new Error('secret stack detail'));
  await assert.rejects(windowsProcessStarts([1], { execFile: failing }));
});

test('parseStarts reads "<pid> <ms>" and "<pid> -" lines and nothing else', () => {
  assert.deepEqual([...parseStarts('12 1000\n13 -\r\n\nnoise\n14 12a\n 15 2000 \n')], [[12, 1000], [13, null], [15, 2000]]);
  assert.deepEqual([...parseStarts('')], []);
});

test('windowsProcessStarts knows when this process started', { skip: process.platform !== 'win32' && 'Windows only' }, async () => {
  const starts = await windowsProcessStarts([process.pid, 2147483644]);
  const startedAt = starts.get(process.pid);
  assert.ok(Number.isFinite(startedAt), 'a start time for this process');
  assert.ok(Math.abs(startedAt - (Date.now() - process.uptime() * 1000)) < 10000, 'close to when Node.js started');
  assert.equal(starts.has(2147483644), false, 'no answer for a process that does not exist');
});

test('claudeProcesses reads only live process files for that session', (t) => {
  const root = claudeRoot(t, [
    { pid: 101, sessionId: ID, kind: 'interactive', status: 'busy' },
    { pid: 102, sessionId: ID.toUpperCase(), kind: 'background', status: 'idle' },
    { pid: 103, sessionId: 'aaaaaaaa-0000-4000-8000-000000000001', kind: 'interactive' },
    { pid: 104, sessionId: ID, kind: 'interactive' },
  ]);
  const dir = path.join(root, 'sessions');
  fs.writeFileSync(path.join(dir, '105.json'), '{ broken');
  fs.writeFileSync(path.join(dir, 'notes.json'), JSON.stringify({ pid: 106, sessionId: ID, kind: 'interactive' }));
  fs.writeFileSync(path.join(dir, '107.json'), JSON.stringify({ pid: 'x', sessionId: ID, kind: 'interactive' }));
  fs.writeFileSync(path.join(dir, '108.json'), JSON.stringify({ pid: 108, sessionId: ID, kind: 'interactive', pad: 'x'.repeat(70 * 1024) }));
  fs.mkdirSync(path.join(dir, '109.json'));
  const alive = (pid) => pid !== 104;
  const found = claudeProcesses(root, ID, alive).sort((a, b) => a.pid - b.pid);
  assert.deepEqual(found.map(({ writtenAt, ...rest }) => rest), [
    { pid: 101, kind: 'interactive', status: 'busy', entrypoint: null },
    { pid: 102, kind: 'background', status: 'idle', entrypoint: null },
  ]);
  for (const proc of found) assert.equal(proc.writtenAt, fs.statSync(path.join(dir, `${proc.pid}.json`)).mtimeMs);
  assert.deepEqual(claudeProcesses(path.join(root, 'missing'), ID, alive), []);
  assert.deepEqual(claudeProcesses(null, ID, alive), []);
  assert.deepEqual(claudeProcesses(root, '../x', alive), []);
});

test('powershellCommand checks the tool and the id, and uses only a plain Windows folder', () => {
  assert.deepEqual(powershellCommand('claude', ID, 'C:\\Windows'), { file: CMD, args: ['/d', '/s', '/c', LINE] });
  assert.deepEqual(powershellCommand('codex', ID, 'C:\\Windows'), { file: CMD, args: ['/d', '/s', '/c', CODEX_LINE] });
  assert.equal(powershellCommand('claude', ID, 'C:\\Windows\\').file, CMD);
  assert.equal(powershellCommand('claude', ID, 'D:\\WINNT').file, 'D:\\WINNT\\System32\\cmd.exe');
  assert.ok(powershellCommand('claude', ID, 'D:\\WINNT').args[3].includes('"D:\\WINNT\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"'));
  for (const odd of ['C:\\Win&calc', 'C:\\My Windows', '%COMSPEC%', 'C:\\Windows"', '\\\\server\\share', '', undefined, 7]) {
    assert.equal(powershellCommand('claude', ID, odd).file, CMD, String(odd));
  }
  for (const bad of [ID.toUpperCase(), `${ID}" & calc & "`, '', undefined]) {
    assert.throws(() => powershellCommand('claude', bad, 'C:\\Windows'), String(bad));
  }
  for (const tool of ['grok', 'kimi', '__proto__', 'toString', undefined]) {
    assert.throws(() => powershellCommand(tool, ID, 'C:\\Windows'), String(tool));
  }
});

test('toolEnv points the window at the folder Pleni reads, and only when it must', () => {
  const env = { Path: 'C:\\Windows' };
  const home = 'C:\\Users\\ada';
  assert.deepEqual(toolEnv('claude', env, null, home, 'win32'), env);
  assert.notEqual(toolEnv('claude', env, null, home, 'win32'), env, 'a copy, never the same object');
  assert.deepEqual(toolEnv('claude', env, 'C:\\Users\\ada\\.claude', home, 'win32'), env);
  assert.deepEqual(toolEnv('claude', env, 'c:\\users\\ADA\\.claude\\', home, 'win32'), env, 'Windows folder names ignore case');
  assert.deepEqual(toolEnv('claude', env, 'D:\\claude-data', home, 'win32'), { ...env, CLAUDE_CONFIG_DIR: 'D:\\claude-data' });
  const own = { ...env, CLAUDE_CONFIG_DIR: 'D:\\claude-data' };
  assert.deepEqual(toolEnv('claude', own, 'D:\\claude-data', home, 'win32'), own);
  assert.deepEqual(toolEnv('claude', own, 'C:\\Users\\ada\\.claude', home, 'win32'), { ...env, CLAUDE_CONFIG_DIR: 'C:\\Users\\ada\\.claude' });
  assert.deepEqual(toolEnv('claude', {}, '/home/ada/.claude', '/home/ada', 'linux'), {});
  assert.deepEqual(toolEnv('claude', {}, '/srv/claude', '/home/ada', 'linux'), { CLAUDE_CONFIG_DIR: '/srv/claude' });
  assert.deepEqual(toolEnv('codex', env, 'C:\\Users\\ada\\.codex', home, 'win32'), env);
  assert.deepEqual(toolEnv('codex', env, 'D:\\codex-data', home, 'win32'), { ...env, CODEX_HOME: 'D:\\codex-data' });
  assert.deepEqual(toolEnv('codex', { ...env, CODEX_HOME: 'D:\\codex-data' }, 'd:\\CODEX-DATA', home, 'win32'), { ...env, CODEX_HOME: 'D:\\codex-data' });
  assert.deepEqual(env, { Path: 'C:\\Windows' }, 'the given env is never changed');
});

test('processAlive knows this process', () => {
  assert.equal(processAlive(process.pid), true);
  assert.equal(processAlive(2147483646), false);
});

// ---- Codex ----

test('a Codex thread opens with codex resume, a Codex helper too', async (t) => {
  const codexRoot = tempDir(t);
  for (const kind of ['session', 'agent']) {
    const folder = tempDir(t);
    const asked = [];
    const isLocked = (root, id) => {
      asked.push([root, id]);
      return false;
    };
    const store = fakeStore({ key: CODEX_KEY, cwd: folder, kind, entrypoint: 'codex_cli_rs' });
    const { result, spawn } = await open(t, { store, codexRoot, isLocked, args: { key: CODEX_KEY } });
    assert.deepEqual(result, { ok: true }, kind);
    assert.deepEqual(asked, [[codexRoot, ID]], 'the lock of this thread, in the Codex folder Pleni reads');
    const [call] = spawn.calls;
    assert.equal(call.file, CMD);
    assert.deepEqual(call.args, ['/d', '/s', '/c', CODEX_LINE]);
    assert.equal(call.options.cwd, folder);
    assert.equal(call.options.env.CODEX_HOME, codexRoot, 'the window reads the same Codex folder as Pleni');
    assert.equal(call.options.env.CLAUDE_CONFIG_DIR, undefined);
  }
});

test('a Codex thread that another program has open, or that is working, is refused', async (t) => {
  const folder = tempDir(t);
  const locked = await open(t, { store: fakeStore({ key: CODEX_KEY, cwd: folder }), isLocked: () => true, args: { key: CODEX_KEY } });
  assertRefused(locked.result, 409, OPEN_MESSAGES.codexElsewhere);
  const working = await open(t, { store: fakeStore({ key: CODEX_KEY, cwd: folder, status: 'working' }), args: { key: CODEX_KEY } });
  assertRefused(working.result, 409, OPEN_MESSAGES.busy);
  const reviewer = await open(t, { store: fakeStore({ key: CODEX_KEY, cwd: folder, kind: 'reviewer' }), args: { key: CODEX_KEY } });
  assertRefused(reviewer.result, 400, OPEN_MESSAGES.reviewer);
  assert.equal(locked.spawn.calls.length + working.spawn.calls.length + reviewer.spawn.calls.length, 0);
  // The app or VS Code may hold a Codex thread too, but Codex's own lock covers that case.
  const vscode = await open(t, { store: fakeStore({ key: CODEX_KEY, cwd: folder, entrypoint: 'codex_vscode' }), args: { key: CODEX_KEY } });
  assert.deepEqual(vscode.result, { ok: true });
});

test('codexProblem refuses a locked thread first, then a working one', () => {
  assert.equal(codexProblem({ status: 'idle' }, false), null);
  assert.equal(codexProblem({ status: 'done' }, false), null);
  assert.equal(codexProblem({ status: 'working' }, false), OPEN_MESSAGES.busy);
  assert.equal(codexProblem({ status: 'working' }, true), OPEN_MESSAGES.codexElsewhere);
  assert.equal(codexProblem({ status: 'idle' }, true), OPEN_MESSAGES.codexElsewhere);
});

test('codexThreadLocked finds no lock without a file or without a holder', (t) => {
  const root = tempDir(t);
  assert.equal(codexThreadLocked(null, ID), false);
  assert.equal(codexThreadLocked(root, ID), false, 'no thread-writer-locks folder');
  fs.mkdirSync(path.join(root, 'thread-writer-locks'));
  assert.equal(codexThreadLocked(root, ID), false, 'no lock file');
  fs.writeFileSync(path.join(root, 'thread-writer-locks', `${ID}.lock`), '');
  assert.equal(codexThreadLocked(root, ID), false, 'a lock file nobody holds');
  assert.equal(codexThreadLocked(root, '../x'), false);
  assert.deepEqual(fs.readdirSync(path.join(root, 'thread-writer-locks')), [`${ID}.lock`], 'Pleni writes nothing there');
});

// On Windows, PowerShell can hold the same kind of lock Codex takes: the whole file, for one writer.
test('codexThreadLocked sees a lock that another program holds', { skip: process.platform !== 'win32' && 'Windows locks only' }, async (t) => {
  const root = tempDir(t);
  fs.mkdirSync(path.join(root, 'thread-writer-locks'));
  const file = path.join(root, 'thread-writer-locks', `${ID}.lock`);
  fs.writeFileSync(file, '');
  const script = `$f = [System.IO.File]::Open('${file}', 'Open', 'ReadWrite', 'ReadWrite'); $f.Lock(0, [long]::MaxValue); 'locked'; Start-Sleep -Seconds 60`;
  const holder = realSpawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: ['ignore', 'pipe', 'ignore'] });
  t.after(() => holder.kill());
  await new Promise((resolve, reject) => {
    holder.stdout.on('data', (data) => {
      if (String(data).includes('locked')) resolve();
    });
    holder.on('error', reject);
    holder.on('exit', () => reject(new Error('the program holding the lock stopped early')));
  });
  assert.equal(codexThreadLocked(root, ID), true);
  holder.kill();
  await once(holder, 'exit');
  assert.equal(codexThreadLocked(root, ID), false, 'the lock goes with the program');
});
