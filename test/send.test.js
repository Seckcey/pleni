import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  MAX_RUNNING,
  MAX_TEXT,
  SEND_MESSAGES,
  claudeOutcome,
  claudeSendProblem,
  cleanMessage,
  codexSendProblem,
  createSender,
  findTool,
  messageProblem,
  sendArgs,
  sendHead,
  sendLogFile,
} from '../src/send.js';

const ID = '0f8e2c4a-1b3d-4e5f-8a9b-0c1d2e3f4a5b';
const ID2 = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const KEY = `claude:${ID}`;
const CODEX_KEY = `codex:${ID}`;
const ON = { actions: { send: true } };
const CLAUDE_EXE = 'C:\\Users\\ada\\.local\\bin\\claude.exe';
const CODEX_EXE = 'C:\\Program Files\\Codex\\codex.exe';

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pleni-send-'));
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

function fakeStore({ sessions = {}, demo = false } = {}) {
  return {
    demo,
    snapshot: () => ({ nodes: [{ key: 'you' }, ...Object.keys(sessions).map((key) => ({ key }))] }),
    session: (asked) => sessions[asked] ?? null,
  };
}

function session(cwd, patch = {}) {
  return { id: ID, cwd, status: 'idle', entrypoint: 'cli', kind: 'session', ...patch };
}

// Stands in for child_process.spawn: records each call and hands back a child that starts on the
// next tick. The test ends it with child.finish(code, stdout).
function fakeSpawn({ fail = false } = {}) {
  const calls = [];
  const spawn = (file, args, options) => {
    const child = new EventEmitter();
    child.pid = 4321 + calls.length;
    child.stdin = new EventEmitter();
    child.stdin.text = null;
    child.stdin.end = (text, encoding) => {
      child.stdin.text = text;
      child.stdin.encoding = encoding;
    };
    child.stdout = options.stdio[1] === 'pipe' ? new EventEmitter() : null;
    child.unref = () => {
      child.unrefed = true;
    };
    child.finish = (code, out = '') => {
      if (out && child.stdout) child.stdout.emit('data', Buffer.from(out));
      child.emit('close', code);
    };
    calls.push({ file, args, options, child });
    process.nextTick(() => (fail ? child.emit('error', new Error('secret stack detail')) : child.emit('spawn')));
    return child;
  };
  spawn.calls = calls;
  return spawn;
}

const found = (tool) => (tool === 'claude' ? { file: CLAUDE_EXE, args: [] } : { file: CODEX_EXE, args: [] });
let clock = 1_000_000;
const tick = () => (clock += 60_000);

function sender(options = {}) {
  return createSender({
    spawn: options.spawn ?? fakeSpawn(),
    now: options.now ?? (() => clock),
    isAlive: options.isAlive ?? (() => true),
    isLocked: options.isLocked ?? (() => false),
    processStarts: options.processStarts ?? (async (pids) => new Map(pids.map((pid) => [pid, 0]))),
    findProgram: options.findProgram ?? found,
  });
}

async function sendOne(t, s, options = {}) {
  const folder = options.folder ?? tempDir(t);
  const key = options.key ?? KEY;
  const store = options.store ?? fakeStore({ sessions: { [key]: session(folder, options.session) } });
  return s.send({
    key,
    text: options.text ?? 'Please run the tests again.',
    id: options.id ?? `m-${Math.random().toString(36).slice(2)}-${Date.now()}`,
    settings: options.settings ?? ON,
    roots: { claude: options.root ?? claudeRoot(t), codex: options.codexRoot ?? tempDir(t) },
    store,
    logFile: options.logFile ?? null,
    platform: options.platform ?? 'win32',
    env: { SystemRoot: 'C:\\Windows' },
    home: 'C:\\Users\\ada',
  });
}

test('sending stays off until turned on, works on Windows only, and only for main sessions on the map', (t) => {
  const folder = tempDir(t);
  const store = fakeStore({ sessions: { [KEY]: session(folder), [`claude:${ID2}`]: session(folder, { kind: 'agent' }) } });
  assert.deepEqual(sendHead(KEY, {}, store, 'win32'), { ok: false, status: 403, error: SEND_MESSAGES.off });
  assert.deepEqual(sendHead(KEY, { actions: { send: 'true' } }, store, 'win32'), { ok: false, status: 403, error: SEND_MESSAGES.off });
  assert.deepEqual(sendHead(KEY, ON, store, 'linux'), { ok: false, status: 409, error: SEND_MESSAGES.windowsOnly });
  assert.equal(sendHead(`grok:${ID}`, ON, store, 'win32').error, SEND_MESSAGES.otherTool);
  assert.equal(sendHead(`claude:${ID}/agent-1`, ON, store, 'win32').error, SEND_MESSAGES.helper);
  assert.equal(sendHead(`codex:${ID.toUpperCase()}`, ON, store, 'win32').error, SEND_MESSAGES.otherTool);
  assert.equal(sendHead(KEY, ON, { ...store, demo: true }, 'win32').error, SEND_MESSAGES.demo);
  assert.equal(sendHead(KEY, ON, fakeStore(), 'win32').status, 404);
  assert.equal(sendHead(`claude:${ID2}`, ON, store, 'win32').error, SEND_MESSAGES.notMain);
  const ok = sendHead(KEY, ON, store, 'win32');
  assert.equal(ok.ok, true);
  assert.equal(ok.tool, 'claude');
  assert.equal(ok.id, ID);
});

test('a message is trimmed, keeps its line breaks, and has limits', () => {
  assert.equal(cleanMessage('  one\r\ntwo\rthree\n  '), 'one\ntwo\nthree');
  assert.equal(cleanMessage(42), '');
  assert.equal(messageProblem(''), SEND_MESSAGES.empty);
  assert.equal(messageProblem('a'.repeat(MAX_TEXT)), null);
  assert.equal(messageProblem('a'.repeat(MAX_TEXT + 1)), SEND_MESSAGES.tooLong);
  assert.equal(messageProblem('tab\there\nand a line'), null);
  assert.equal(messageProblem('bell \u0007'), SEND_MESSAGES.badText);
  assert.equal(messageProblem('null \u0000'), SEND_MESSAGES.badText);
  assert.equal(messageProblem('half \ud83d pair'), SEND_MESSAGES.badText);
  assert.equal(messageProblem('emoji 🎉 and "quotes" & | > %PATH% $(x) `y`'), null);
});

test('the command line holds only fixed words and the checked id', () => {
  assert.deepEqual(sendArgs('claude', ID), ['-p', '--resume', ID, '--output-format', 'json', '--permission-mode', 'dontAsk']);
  assert.deepEqual(sendArgs('claude', ID, 'edit'), ['-p', '--resume', ID, '--output-format', 'json', '--permission-mode', 'acceptEdits']);
  assert.deepEqual(sendArgs('codex', ID), ['exec', '--skip-git-repo-check', '--sandbox', 'read-only', 'resume', ID, '-']);
  assert.deepEqual(sendArgs('codex', ID, 'edit'), ['exec', '--skip-git-repo-check', '--sandbox', 'workspace-write', 'resume', ID, '-']);
  assert.throws(() => sendArgs('claude', `${ID}' ; calc`));
  assert.throws(() => sendArgs('grok', ID));
});

test('a Claude Code session open anywhere else is not sent to', () => {
  const s = { status: 'idle', entrypoint: 'cli' };
  assert.equal(claudeSendProblem(s, []), null);
  assert.equal(claudeSendProblem({ ...s, entrypoint: 'claude-desktop' }, []), SEND_MESSAGES.desktopApp);
  assert.equal(claudeSendProblem({ ...s, entrypoint: 'claude-vscode' }, []), SEND_MESSAGES.vscode);
  assert.equal(claudeSendProblem(s, [{ pid: 1, kind: 'interactive', entrypoint: 'cli' }]), SEND_MESSAGES.elsewhere);
  assert.equal(claudeSendProblem(s, [{ pid: 1, kind: 'background', entrypoint: 'cli' }]), SEND_MESSAGES.busy);
  assert.equal(claudeSendProblem(s, [{ pid: 1, kind: 'interactive', entrypoint: 'sdk-cli' }]), SEND_MESSAGES.busy);
  assert.equal(claudeSendProblem({ ...s, status: 'working' }, []), SEND_MESSAGES.busy);
  assert.equal(codexSendProblem({ status: 'idle' }, false), null);
  assert.equal(codexSendProblem({ status: 'idle' }, true), SEND_MESSAGES.codexElsewhere);
  assert.equal(codexSendProblem({ status: 'working' }, false), SEND_MESSAGES.busy);
});

test('a message goes to the hidden program on its standard input, never on the command line', async (t) => {
  const spawn = fakeSpawn();
  const s = sender({ spawn });
  const folder = tempDir(t);
  const logFile = path.join(tempDir(t), 'sent.jsonl');
  const text = '  Fix the build, then say "done" & stop.\r\nThanks  ';
  const result = await sendOne(t, s, { folder, text, id: 'first-message-0001', logFile });
  assert.deepEqual(result, { ok: true });
  assert.equal(spawn.calls.length, 1);
  const call = spawn.calls[0];
  assert.equal(call.file, CLAUDE_EXE);
  assert.deepEqual(call.args, ['-p', '--resume', ID, '--output-format', 'json', '--permission-mode', 'dontAsk']);
  assert.equal(call.options.cwd, folder);
  assert.equal(call.options.windowsHide, true);
  assert.equal(call.options.detached, true);
  assert.deepEqual(call.options.stdio, ['pipe', 'pipe', 'ignore']);
  assert.equal(call.options.shell, undefined);
  assert.equal(call.child.stdin.text, 'Fix the build, then say "done" & stop.\nThanks');
  assert.equal(call.child.stdin.encoding, 'utf8');
  assert.ok(!call.args.join(' ').includes('Fix the build'));
  assert.equal(call.child.unrefed, true);
  assert.equal(s.running(KEY), true);
  // A second message waits for the first turn to end.
  const busy = await sendOne(t, s, { folder, id: 'second-message-0001' });
  assert.deepEqual(busy, { ok: false, status: 409, error: SEND_MESSAGES.running });
  // The same message again (a retried request) is not sent twice.
  assert.deepEqual(await sendOne(t, s, { folder, text, id: 'first-message-0001' }), { ok: true, repeat: true });
  assert.equal(spawn.calls.length, 1);
  call.child.finish(0, `${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: ID, result: 'secret answer text' })}\n`);
  assert.equal(s.running(KEY), false);
  const info = s.info({ key: KEY, settings: ON, store: fakeStore({ sessions: { [KEY]: session(folder) } }), platform: 'win32' });
  assert.equal(info.ok, true);
  assert.equal(info.info.running, false);
  assert.equal(info.info.last.ok, true);
  // The record says when and where, never what was said or answered.
  const log = fs.readFileSync(logFile, 'utf8');
  assert.equal(log.trim().split('\n').length, 2);
  assert.ok(!log.includes('Fix the build'));
  assert.ok(!log.includes('secret answer text'));
  const [started, ended] = log.trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(started.key, KEY);
  assert.equal(started.chars, 'Fix the build, then say "done" & stop.\nThanks'.length);
  assert.equal(ended.ok, true);
  assert.equal(ended.code, 0);
  assert.equal(sendLogFile(path.join('C:', 'pleni', 'settings.json')), path.join('C:', 'pleni', 'sent.jsonl'));
});

test('Codex gets the message on standard input too, in a read-only sandbox unless edit is chosen', async (t) => {
  const spawn = fakeSpawn();
  const s = sender({ spawn });
  const folder = tempDir(t);
  const store = fakeStore({ sessions: { [CODEX_KEY]: session(folder) } });
  const result = await sendOne(t, s, { key: CODEX_KEY, store, settings: { actions: { send: true }, send: { mode: 'edit' } }, id: 'codex-message-0001' });
  assert.deepEqual(result, { ok: true });
  const call = spawn.calls[0];
  assert.equal(call.file, CODEX_EXE);
  assert.deepEqual(call.args, ['exec', '--skip-git-repo-check', '--sandbox', 'workspace-write', 'resume', ID, '-']);
  assert.deepEqual(call.options.stdio, ['pipe', 'ignore', 'ignore']);
  assert.equal(call.child.stdin.text, 'Please run the tests again.');
  call.child.finish(1);
  const info = s.info({ key: CODEX_KEY, settings: ON, store, platform: 'win32' });
  assert.equal(info.info.last.ok, false);
});

test('a session that is busy or open elsewhere is refused before anything starts', async (t) => {
  const spawn = fakeSpawn();
  const s = sender({ spawn });
  assert.equal((await sendOne(t, s, { session: { status: 'working' } })).error, SEND_MESSAGES.busy);
  assert.equal((await sendOne(t, s, { session: { entrypoint: 'claude-desktop' } })).error, SEND_MESSAGES.desktopApp);
  const root = claudeRoot(t, [{ pid: 77, sessionId: ID, kind: 'interactive', entrypoint: 'cli' }]);
  assert.equal((await sendOne(t, s, { root })).error, SEND_MESSAGES.elsewhere);
  const locked = sender({ spawn, isLocked: () => true });
  const folder = tempDir(t);
  const store = fakeStore({ sessions: { [CODEX_KEY]: session(folder) } });
  assert.equal((await sendOne(t, locked, { key: CODEX_KEY, store })).error, SEND_MESSAGES.codexElsewhere);
  // A process file whose number another program took since does not count.
  const reused = sender({ spawn, processStarts: async (pids) => new Map(pids.map((pid) => [pid, Date.now() + 60_000])) });
  assert.deepEqual(await sendOne(t, reused, { root }), { ok: true });
  assert.equal(spawn.calls.length, 1);
});

test('bad messages, ids and missing programs are refused with plain words', async (t) => {
  const spawn = fakeSpawn();
  const s = sender({ spawn });
  assert.equal((await sendOne(t, s, { id: 'short' })).error, SEND_MESSAGES.badId);
  assert.equal((await sendOne(t, s, { id: '../../etc/passwd-xxxxxxxx' })).error, SEND_MESSAGES.badId);
  assert.equal((await sendOne(t, s, { text: '   ' })).error, SEND_MESSAGES.empty);
  assert.equal((await sendOne(t, s, { text: 'x'.repeat(MAX_TEXT + 1) })).error, SEND_MESSAGES.tooLong);
  const none = sender({ spawn, findProgram: () => null });
  assert.equal((await sendOne(t, none)).error, SEND_MESSAGES.noClaude);
  const folder = tempDir(t);
  const store = fakeStore({ sessions: { [CODEX_KEY]: session(folder) } });
  assert.equal((await sendOne(t, none, { key: CODEX_KEY, store })).error, SEND_MESSAGES.noCodex);
  const broken = sender({ spawn: fakeSpawn({ fail: true }) });
  const failed = await sendOne(t, broken);
  assert.deepEqual(failed, { ok: false, status: 500, error: SEND_MESSAGES.failed });
  assert.ok(!JSON.stringify(failed).includes('secret'));
  assert.equal(spawn.calls.length, 0);
  // The folder must be there.
  const gone = path.join(tempDir(t), 'gone');
  assert.equal((await sendOne(t, s, { folder: gone })).status, 409);
});

test('a few messages a minute, a few turns at once, and a short wait per session', async (t) => {
  let now = 5_000_000;
  const spawn = fakeSpawn();
  const s = sender({ spawn, now: () => now });
  const folder = tempDir(t);
  const keys = [ID, ID2, '2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e', '3c4d5e6f-7a8b-4c9d-8e1f-2a3b4c5d6e7f'].map((id) => `claude:${id}`);
  const store = fakeStore({ sessions: Object.fromEntries(keys.map((key) => [key, session(folder, { id: key.slice(7) })])) });
  for (let i = 0; i < MAX_RUNNING; i++) assert.deepEqual(await sendOne(t, s, { key: keys[i], store }), { ok: true });
  assert.equal((await sendOne(t, s, { key: keys[MAX_RUNNING], store })).error, SEND_MESSAGES.full);
  spawn.calls[0].child.finish(0);
  // The same session again right away is asked to wait a few seconds.
  assert.equal((await sendOne(t, s, { key: keys[0], store })).error, SEND_MESSAGES.again);
  now += 6_000;
  assert.deepEqual(await sendOne(t, s, { key: keys[0], store }), { ok: true });
  for (const call of spawn.calls) call.child.finish(0);
  for (const key of keys) {
    now += 6_000;
    await sendOne(t, s, { key, store });
    for (const call of spawn.calls) call.child.finish(0);
  }
  now += 6_000;
  assert.equal((await sendOne(t, s, { key: keys[1], store })).error, SEND_MESSAGES.tooMany);
  now += 61_000;
  assert.deepEqual(await sendOne(t, s, { key: keys[1], store }), { ok: true });
});

test('Claude Code\'s answer says whether the turn went well, and in which session', () => {
  const line = (value) => `${JSON.stringify(value)}\n`;
  assert.deepEqual(claudeOutcome(line({ type: 'result', subtype: 'success', is_error: false, session_id: ID }), 0, ID), { ok: true, code: 0, otherSession: false });
  assert.deepEqual(claudeOutcome(line({ type: 'result', subtype: 'error_max_turns', is_error: true, session_id: ID }), 0, ID), { ok: false, code: 0, otherSession: false });
  assert.deepEqual(claudeOutcome(line({ type: 'result', subtype: 'success', session_id: ID2 }), 0, ID), { ok: true, code: 0, otherSession: true });
  assert.deepEqual(claudeOutcome('not json', 1, ID), { ok: false, code: 1, otherSession: false });
  assert.deepEqual(claudeOutcome('', 0, ID), { ok: true, code: 0, otherSession: false });
  assert.deepEqual(claudeOutcome('', null, ID), { ok: false, code: null, otherSession: false });
});

test('the program is found in absolute, local folders only, never in the current folder', () => {
  const BIG = 300 * 1024 * 1024;
  const sizes = new Map([
    ['C:\\Tools\\claude.exe', BIG],
    ['C:\\Users\\ada\\AppData\\Roaming\\npm\\codex.cmd', 400],
    ['C:\\Users\\ada\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js', 9000],
    ['project\\codex.exe', BIG],
    ['\\\\server\\share\\codex.exe', BIG],
  ]);
  const size = (file) => sizes.get(file) ?? -1;
  const env = { Path: 'project;\\\\server\\share;"C:\\Tools";C:\\Users\\ada\\AppData\\Roaming\\npm' };
  const node = 'C:\\Program Files\\nodejs\\node.exe';
  assert.deepEqual(findTool('claude', { env, platform: 'win32', size, node, home: 'C:\\Users\\ada' }), { file: 'C:\\Tools\\claude.exe', args: [] });
  assert.deepEqual(findTool('codex', { env, platform: 'win32', size, node, home: 'C:\\Users\\ada' }), {
    file: node,
    args: ['C:\\Users\\ada\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js'],
  });
  // npm's Claude Code package: its own claude.exe once its install step put the real one there,
  // else its Node.js script.
  const npm = 'C:\\Users\\ada\\AppData\\Roaming\\npm';
  const pkg = `${npm}\\node_modules\\@anthropic-ai\\claude-code`;
  const found = (files) => findTool('claude', { env: { PATH: npm }, platform: 'win32', size: (f) => files[f] ?? -1, node, home: 'C:\\Users\\ada' });
  assert.deepEqual(found({ [`${npm}\\claude.cmd`]: 300, [`${pkg}\\bin\\claude.exe`]: BIG }), { file: `${pkg}\\bin\\claude.exe`, args: [] });
  assert.deepEqual(found({ [`${npm}\\claude.cmd`]: 300, [`${pkg}\\bin\\claude.exe`]: 500, [`${pkg}\\cli-wrapper.cjs`]: 2000 }), { file: node, args: [`${pkg}\\cli-wrapper.cjs`] });
  assert.deepEqual(found({ [`${npm}\\claude.cmd`]: 300, [`${pkg}\\cli.js`]: 9000 }), { file: node, args: [`${pkg}\\cli.js`] });
  // A stand-in claude.exe and nothing else is not a program.
  assert.equal(found({ [`${npm}\\claude.cmd`]: 300, [`${pkg}\\bin\\claude.exe`]: 500 }), null);
  // The installers' own folders, when they are not on PATH.
  assert.deepEqual(findTool('claude', { env: {}, platform: 'win32', size: (f) => (f === 'C:\\Users\\ada\\.local\\bin\\claude.exe' ? BIG : -1), node, home: 'C:\\Users\\ada' }), { file: 'C:\\Users\\ada\\.local\\bin\\claude.exe', args: [] });
  const standalone = 'C:\\Users\\ada\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe';
  assert.deepEqual(findTool('codex', { env: { LOCALAPPDATA: 'C:\\Users\\ada\\AppData\\Local' }, platform: 'win32', size: (f) => (f === standalone ? BIG : -1), node }), { file: standalone, args: [] });
  assert.equal(findTool('codex', { env: { LOCALAPPDATA: '\\\\server\\share' }, platform: 'win32', size: () => BIG, node }), null);
  assert.equal(findTool('codex', { env: { PATH: 'project' }, platform: 'win32', size, node }), null);
});

test('the page learns what stops a send without starting anything', (t) => {
  const spawn = fakeSpawn();
  const s = sender({ spawn });
  const folder = tempDir(t);
  const ask = (patch, settings = ON) => s.info({ key: KEY, settings, store: fakeStore({ sessions: { [KEY]: session(folder, patch) } }), platform: 'win32' });
  assert.deepEqual(ask({}), { ok: true, info: { problem: null, running: false, last: null, mode: 'read' } });
  assert.equal(ask({ status: 'working' }).info.problem, SEND_MESSAGES.busy);
  assert.equal(ask({ entrypoint: 'claude-vscode' }).info.problem, SEND_MESSAGES.vscode);
  assert.equal(ask({}, { actions: { send: true }, send: { mode: 'edit' } }).info.mode, 'edit');
  assert.deepEqual(ask({}, {}), { ok: false, status: 403, error: SEND_MESSAGES.off });
  assert.equal(spawn.calls.length, 0);
});
