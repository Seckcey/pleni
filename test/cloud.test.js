import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CLOUD_ARGS, CLOUD_MESSAGES, cloudFolder, cloudOutcome, createCodexCloud, findCodex, parseTasks } from '../src/cloud.js';

// One task as `codex cloud list --json` gives it (made-up data).
function raw(extra = {}) {
  return {
    id: 'task_e_0123abcd',
    url: 'https://chatgpt.com/codex/tasks/task_e_0123abcd',
    title: 'Fix the invoice totals',
    status: 'ready',
    updated_at: '2026-10-18T08:00:00Z',
    environment_id: null,
    environment_label: 'billing-service',
    summary: { files_changed: 3, lines_added: 120, lines_removed: 14 },
    is_review: true,
    attempt_total: 2,
    ...extra,
  };
}

const json = (tasks) => JSON.stringify({ tasks, cursor: null });
const one = (extra) => parseTasks(json([raw(extra)]))[0];

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pleni-cloud-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// A stand-in for execFile that answers each run from `answer(args, count)`: { stdout } or { err, stderr }.
function fakeCodex(answer = () => ({ stdout: json([raw()]) })) {
  const calls = [];
  const execFile = (file, args, options, done) => {
    calls.push({ file, args, options });
    const a = answer(args, calls.length);
    setImmediate(() => done(a.err ?? null, a.stdout ?? '', a.stderr ?? ''));
  };
  return { calls, execFile };
}

function cloud(t, fake, clock = { t: 1000 }, extra = {}) {
  const folder = path.join(tempDir(t), 'pleni', 'codex-cloud');
  return {
    folder,
    clock,
    cloud: createCodexCloud({
      execFile: fake.execFile,
      env: { PATH: '/usr/bin', HOME: '/home/ada', CODEX_HOME: '/home/ada/.codex' },
      platform: 'linux',
      folder,
      now: () => clock.t,
      find: () => ({ file: '/usr/bin/codex', args: [] }),
      ...extra,
    }),
  };
}

// ---- finding codex ----

test('on Windows, codex is found like Send finds it, including npm\'s codex.cmd', () => {
  const node = 'C:\\Program Files\\nodejs\\node.exe';
  const npm = 'C:\\Users\\ada\\AppData\\Roaming\\npm';
  const script = `${npm}\\node_modules\\@openai\\codex\\bin\\codex.js`;
  const sizes = { [`${npm}\\codex.cmd`]: 300, [script]: 900 };
  const size = (file) => sizes[file] ?? -1;
  const env = { Path: `C:\\Windows;${npm}` };
  assert.deepEqual(findCodex(env, 'win32', { size, node, home: 'C:\\Users\\ada' }), { file: node, args: [script] });
  const exe = 'C:\\Tools\\codex.exe';
  assert.deepEqual(findCodex({ PATH: 'C:\\Tools' }, 'win32', { size: (f) => (f === exe ? 5_000_000 : -1), node, home: 'C:\\Users\\ada' }), { file: exe, args: [] });
  assert.equal(findCodex({ PATH: 'C:\\Windows' }, 'win32', { size, node, home: 'C:\\Users\\ada' }), null);
  assert.equal(findCodex({ PATH: '\\\\server\\share;relative' }, 'win32', { size: () => 5_000_000, node, home: 'C:\\Users\\ada' }), null, 'no network share, no relative folder');
});

// The PATH walk itself, with made-up folders, on every computer.
test('on macOS and Linux, codex is the first codex on PATH that can run', () => {
  const ready = new Set(['/usr/local/bin/codex', '/home/ada/.npm-global/bin/codex']);
  const isExecutable = (file) => ready.has(file);
  const find = (PATH, platform = 'linux') => findCodex({ PATH }, platform, { isExecutable });
  assert.deepEqual(find('/usr/bin:/usr/local/bin:/home/ada/.npm-global/bin'), { file: '/usr/local/bin/codex', args: [] });
  assert.deepEqual(find('/home/ada/.npm-global/bin:/usr/local/bin', 'darwin'), { file: '/home/ada/.npm-global/bin/codex', args: [] });
  assert.equal(find('.:bin::relative/bin'), null, 'never the current folder or a relative one');
  assert.equal(find('/usr/bin'), null);
});

// Real links and run bits, which only macOS and Linux have.
const POSIX_ONLY = { skip: process.platform === 'win32' && 'needs macOS or Linux file links and run bits' };

test('on Linux, codex is the first executable file on PATH, or a link to one', POSIX_ONLY, (t) => {
  const dir = tempDir(t);
  const bin = path.join(dir, 'bin');
  const lib = path.join(dir, 'lib', 'codex', 'bin');
  const other = path.join(dir, 'other');
  fs.mkdirSync(bin);
  fs.mkdirSync(lib, { recursive: true });
  fs.mkdirSync(other);
  // npm's install: a small script behind a link.
  const script = path.join(lib, 'codex.js');
  fs.writeFileSync(script, '#!/usr/bin/env node\nconsole.log(1);\n', { mode: 0o755 });
  fs.symlinkSync(script, path.join(bin, 'codex'));
  fs.writeFileSync(path.join(other, 'codex'), 'x', { mode: 0o755 });
  assert.deepEqual(findCodex({ PATH: `${bin}:${other}` }, 'linux'), { file: path.join(bin, 'codex'), args: [] });
  assert.deepEqual(findCodex({ PATH: `${other}:${bin}` }, 'darwin'), { file: path.join(other, 'codex'), args: [] });
});

test('on Linux, a file that cannot run, a broken link, a folder and a relative folder do not count', POSIX_ONLY, (t) => {
  const dir = tempDir(t);
  const plain = path.join(dir, 'plain');
  const broken = path.join(dir, 'broken');
  const folder = path.join(dir, 'folder');
  fs.mkdirSync(plain);
  fs.mkdirSync(broken);
  fs.mkdirSync(path.join(folder, 'codex'), { recursive: true });
  fs.writeFileSync(path.join(plain, 'codex'), 'x', { mode: 0o644 });
  fs.symlinkSync(path.join(dir, 'nowhere'), path.join(broken, 'codex'));
  assert.equal(findCodex({ PATH: [plain, broken, folder, '', '.', 'bin'].join(':') }, 'linux'), null);
  assert.equal(findCodex({}, 'linux'), null);
});

// ---- the run ----

test('codex runs with fixed words, no shell, and a private folder of Pleni\'s own', async (t) => {
  const fake = fakeCodex();
  const { cloud: c, folder } = cloud(t, fake);
  const answer = await c.status();
  assert.equal(answer.error, null);
  assert.equal(fake.calls.length, 1);
  const { file, args, options } = fake.calls[0];
  assert.equal(file, '/usr/bin/codex');
  assert.deepEqual(args, ['cloud', 'list', '--json', '--limit', '20']);
  assert.deepEqual([...CLOUD_ARGS], args);
  assert.equal(options.cwd, folder);
  assert.equal(options.shell, undefined, 'never through a shell');
  assert.equal(options.timeout, 30000);
  assert.equal(options.maxBuffer, 1024 * 1024);
  assert.equal(options.windowsHide, true);
  assert.equal(options.env.NO_COLOR, '1');
  assert.equal(options.env.CODEX_HOME, '/home/ada/.codex', 'the person\'s own settings stay');
  assert.ok(fs.statSync(folder).isDirectory());
  if (process.platform !== 'win32') assert.equal(fs.statSync(folder).mode & 0o777, 0o700);
});

test('a codex run from a script goes through Node.js first, with its words after the script', async (t) => {
  const fake = fakeCodex();
  const { cloud: c } = cloud(t, fake, { t: 1000 }, { find: () => ({ file: '/usr/bin/node', args: ['/opt/codex/bin/codex.js'] }) });
  await c.status();
  assert.equal(fake.calls[0].file, '/usr/bin/node');
  assert.deepEqual(fake.calls[0].args, ['/opt/codex/bin/codex.js', 'cloud', 'list', '--json', '--limit', '20']);
});

test('the folder can be told by a function, and cloudFolder puts it next to the settings', async (t) => {
  assert.equal(cloudFolder(path.join('/home/ada/.config/pleni', 'settings.json')), path.join('/home/ada/.config/pleni', 'codex-cloud'));
  assert.equal(cloudFolder(undefined), null);
  const dir = tempDir(t);
  const fake = fakeCodex();
  const c = createCodexCloud({ execFile: fake.execFile, env: {}, platform: 'linux', folder: () => cloudFolder(path.join(dir, 'settings.json')), find: () => ({ file: '/usr/bin/codex', args: [] }) });
  await c.status();
  assert.equal(fake.calls[0].options.cwd, path.join(dir, 'codex-cloud'));
});

// ---- reading the answer ----

test('parseTasks keeps the fields Pleni shows and builds the address from the id', () => {
  assert.deepEqual(one(), {
    id: 'task_e_0123abcd',
    title: 'Fix the invoice totals',
    status: 'ready',
    updatedAt: Date.parse('2026-10-18T08:00:00Z'),
    environment: 'billing-service',
    files: 3,
    added: 120,
    removed: 14,
    review: true,
    attempts: 2,
    url: 'https://chatgpt.com/codex/tasks/task_e_0123abcd',
  });
});

test('parseTasks drops a task with a bad id and never trusts the url it was given', () => {
  const bad = ['', 'a b', '../x', 'x/y', 'a?b=1', 'x'.repeat(101), 7, null, undefined];
  const tasks = parseTasks(json([...bad.map((id) => raw({ id })), raw({ id: 'good_1', url: 'https://evil.example/steal' }), null, 'task', 7]));
  assert.deepEqual(tasks.map((x) => x.id), ['good_1']);
  assert.equal(tasks[0].url, 'https://chatgpt.com/codex/tasks/good_1');
  assert.equal(one({ id: 'a'.repeat(100) }).id.length, 100);
});

test('parseTasks maps the status and falls back to unknown', () => {
  for (const status of ['pending', 'ready', 'applied', 'error']) assert.equal(one({ status }).status, status);
  for (const status of ['READY', 'in-progress', '', null, 4, {}, undefined]) assert.equal(one({ status }).status, 'unknown', String(status));
});

test('parseTasks clips and cleans the title and the environment', () => {
  assert.equal(one({ title: 'a'.repeat(300) }).title.length, 200);
  assert.equal(one({ title: '  Tidy\u0000 the\u001b[31m\ttotals\r\nnow  ' }).title, 'Tidy the [31m totals now');
  assert.equal(one({ title: 'Ship\u202eit' }).title, 'Ship it', 'text-turning marks are removed');
  assert.equal(one({ title: '\u200b\u200e\u200f\ufeff\u061c' }).title, 'Untitled task', 'invisible format marks count as empty');
  assert.equal(one({ environment_label: '\u200b\ufeff' }).environment, null, 'an invisible-only environment name is dropped');
  for (const title of ['', '   ', '\u0000\u0007', null, 5, undefined]) assert.equal(one({ title }).title, 'Untitled task', String(title));
  assert.equal(one({ environment_label: 'e'.repeat(150) }).environment.length, 100);
  for (const label of ['', null, 9, undefined]) assert.equal(one({ environment_label: label }).environment, null, String(label));
  assert.equal(one({ environment_label: 'ok\u0000name' }).environment, 'ok name');
});

test('parseTasks takes numbers and times only when they make sense', () => {
  const missing = one({ summary: undefined, updated_at: undefined, attempt_total: undefined, is_review: undefined });
  assert.deepEqual([missing.files, missing.added, missing.removed, missing.updatedAt, missing.attempts, missing.review], [null, null, null, null, null, false]);
  for (const n of [-1, 1.5, '3', NaN, null, Infinity]) assert.equal(one({ summary: { files_changed: n } }).files, null, String(n));
  assert.equal(one({ summary: { files_changed: 0, lines_added: 0, lines_removed: 0 } }).files, 0);
  for (const n of [0, -2, 1.5, '2', null]) assert.equal(one({ attempt_total: n }).attempts, null, String(n));
  assert.equal(one({ attempt_total: 1 }).attempts, 1);
  for (const at of ['soon', '', null, {}, -5]) assert.equal(one({ updated_at: at }).updatedAt, null, String(at));
  assert.equal(one({ updated_at: 1792310400 }).updatedAt, 1792310400000, 'seconds become milliseconds');
  assert.equal(one({ is_review: 'yes' }).review, false);
});

test('parseTasks keeps at most 20 tasks', () => {
  const many = Array.from({ length: 27 }, (_, i) => raw({ id: `task_${i}` }));
  const tasks = parseTasks(json(many));
  assert.equal(tasks.length, 20);
  assert.equal(tasks[0].id, 'task_0');
});

test('parseTasks answers null for anything that is not { tasks: [...] }', () => {
  for (const text of ['', 'not json', '{', 'null', '[]', '{}', '{"tasks":{}}', '{"tasks":"x"}', '"tasks"', 'Not signed in.']) assert.equal(parseTasks(text), null, text);
  assert.deepEqual(parseTasks('{"tasks":[]}'), []);
});

// ---- plain errors ----

test('every error is in plain words, and raw error output never shows', async (t) => {
  const secret = 'auth: mode=ChatGPT account_id=acct_SECRET0123 base_url=https://chatgpt.com/backend-api';
  const cases = [
    [{ err: Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' }), stderr: secret }, CLOUD_MESSAGES.noCodex],
    [{ err: Object.assign(new Error('Command failed'), { code: 1, stderr: secret }), stderr: `Not signed in. Please run 'codex login' to sign in with ChatGPT, then re-run 'codex cloud'.\n${secret}` }, CLOUD_MESSAGES.login],
    [{ err: Object.assign(new Error('timed out'), { killed: true, signal: 'SIGTERM', code: null }), stderr: secret }, CLOUD_MESSAGES.slow],
    [{ stdout: 'Error: something odd', stderr: secret }, CLOUD_MESSAGES.unreadable],
    [{ stdout: '{"tasks":{}}' }, CLOUD_MESSAGES.unreadable],
    [{ err: Object.assign(new Error('too big'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }), stderr: secret }, CLOUD_MESSAGES.unreadable],
    [{ err: Object.assign(new Error('Command failed'), { code: 2 }), stderr: `panic ${secret}` }, CLOUD_MESSAGES.failed],
    [{ err: Object.assign(new Error('boom'), { code: 'EACCES' }), stderr: secret }, CLOUD_MESSAGES.failed],
  ];
  for (const [run, message] of cases) {
    const { cloud: c } = cloud(t, fakeCodex(() => run));
    const answer = await c.status();
    assert.equal(answer.error, message);
    assert.deepEqual(answer.tasks, []);
    assert.ok(!JSON.stringify(answer).includes('SECRET'), 'no account id');
    assert.ok(!JSON.stringify(answer).includes('backend-api'));
  }
  assert.equal(CLOUD_MESSAGES.noCodex, 'Pleni could not find Codex on this computer.');
  assert.equal(CLOUD_MESSAGES.login, 'Codex cloud needs you to sign in to Codex with ChatGPT. In a terminal, run: codex login');
  assert.equal(CLOUD_MESSAGES.slow, 'Codex took too long to answer. Pleni will try again.');
  assert.equal(CLOUD_MESSAGES.unreadable, 'Codex gave an answer Pleni could not read. Your Codex may be too old for codex cloud list --json.');
  assert.equal(CLOUD_MESSAGES.failed, 'Codex could not list your cloud tasks just now.');
});

test('no codex on this computer is a plain error, and nothing is run', async (t) => {
  const fake = fakeCodex();
  const { cloud: c } = cloud(t, fake, { t: 1000 }, { find: () => null });
  const answer = await c.status();
  assert.equal(answer.error, CLOUD_MESSAGES.noCodex);
  assert.equal(fake.calls.length, 0);
});

test('a throw from the run is a plain error', async (t) => {
  const { cloud: c } = cloud(t, { execFile: () => { throw new Error('C:\\Users\\ada\\secret path'); } });
  const answer = await c.status();
  assert.equal(answer.error, CLOUD_MESSAGES.failed);
});

test('cloudOutcome passes good output through', () => {
  assert.deepEqual(cloudOutcome(null, '{"tasks":[]}', ''), { ok: true, stdout: '{"tasks":[]}', error: null });
});

// ---- keeping answers ----

test('an answer is reused for 60 seconds', async (t) => {
  const fake = fakeCodex();
  const { cloud: c, clock } = cloud(t, fake);
  const first = await c.status();
  assert.equal(first.at, 1000);
  assert.equal(first.tasks.length, 1);
  clock.t = 1000 + 59 * 1000;
  assert.equal(await c.status(), first);
  assert.equal(fake.calls.length, 1);
  clock.t = 1000 + 60 * 1000;
  await c.status();
  assert.equal(fake.calls.length, 2);
});

test('Look again asks only when the answer is more than 15 seconds old', async (t) => {
  const fake = fakeCodex();
  const { cloud: c, clock } = cloud(t, fake);
  await c.status();
  clock.t = 1000 + 14 * 1000;
  await c.status({ fresh: true });
  assert.equal(fake.calls.length, 1, 'too soon');
  clock.t = 1000 + 15 * 1000;
  const again = await c.status({ fresh: true });
  assert.equal(fake.calls.length, 2);
  assert.equal(again.at, 16000);
});

test('an error answer is kept for the same time, and a clock that went back asks again', async (t) => {
  const fake = fakeCodex(() => ({ err: Object.assign(new Error('x'), { code: 2 }) }));
  const { cloud: c, clock } = cloud(t, fake);
  await c.status();
  clock.t = 30000;
  await c.status();
  assert.equal(fake.calls.length, 1);
  clock.t = 500;
  await c.status();
  assert.equal(fake.calls.length, 2);
});

test('two pages asking at once share one run', async (t) => {
  const fake = fakeCodex();
  const { cloud: c } = cloud(t, fake);
  const [a, b, d] = await Promise.all([c.status(), c.status({ fresh: true }), c.status()]);
  assert.equal(fake.calls.length, 1);
  assert.equal(a, b);
  assert.equal(a, d);
});

test('where codex is stays known for a few minutes, and a missing codex is looked for again', async (t) => {
  let finds = 0;
  let program = null;
  const fake = fakeCodex();
  const { cloud: c, clock } = cloud(t, fake, { t: 1000 }, {
    find: () => {
      finds++;
      return program;
    },
  });
  await c.status();
  clock.t += 20 * 1000;
  await c.status({ fresh: true });
  assert.equal(finds, 2, 'a missing codex is looked for on each run');
  program = { file: '/usr/bin/codex', args: [] };
  clock.t += 20 * 1000;
  const found = await c.status({ fresh: true });
  assert.equal(found.error, null);
  assert.equal(finds, 3);
  clock.t += 61 * 1000;
  await c.status();
  assert.equal(finds, 3, 'kept');
  clock.t += 3 * 60 * 1000;
  await c.status();
  assert.equal(finds, 4);
});
