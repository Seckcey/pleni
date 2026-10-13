import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const CLI = path.join(REPO, 'bin', 'pleni.js');
const CHECK = path.join(REPO, 'scripts', 'check.js');
const VERSION = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).version;
// Running the server needs the store and the demo data, which live in other modules.
const CAN_RUN = fs.existsSync(path.join(REPO, 'src', 'store.js'));
const RUN = { skip: CAN_RUN ? false : 'src/store.js is not there yet' };
// The tests run the CLI from the repository folder, the way the README says to.
const COMMAND = 'node bin/pleni.js';

function tempDir(t, prefix = 'pleni-cli-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// A clean environment: settings in a temp folder and no port from the outside.
function cliEnv(home, extra = {}) {
  const env = { ...process.env, PLENI_HOME: home, ...extra };
  if (!('PLENI_PORT' in extra)) delete env.PLENI_PORT;
  return env;
}

function runCli(args, env) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd: REPO, env, encoding: 'utf8', timeout: 20000 });
}

// Starts the CLI and resolves once it prints its address.
function startCli(t, args, env) {
  const child = spawn(process.execPath, [CLI, ...args], { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const out = { stdout: '', stderr: '' };
  child.stdout.setEncoding('utf8').on('data', (text) => { out.stdout += text; });
  child.stderr.setEncoding('utf8').on('data', (text) => { out.stderr += text; });
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  });
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no address printed: ${out.stderr}`)), 15000);
    const look = () => {
      const match = /Pleni is running at (http:\/\/localhost:(\d+)\/\?t=([A-Za-z0-9_-]+))\n/.exec(out.stdout);
      if (!match) return;
      clearTimeout(timer);
      const port = Number(match[2]);
      resolve({ url: match[1], port, key: match[3], cookie: `pleni-${port}=${match[3]}` });
    };
    child.stdout.on('data', look);
    exited.then(() => {
      clearTimeout(timer);
      reject(new Error(`stopped early: ${out.stderr}`));
    });
  });
  return { child, out, ready, exited };
}

async function stopCli(cli) {
  cli.child.kill('SIGTERM');
  const result = await cli.exited;
  // Windows has no real signals: the process is simply ended there.
  if (process.platform !== 'win32') {
    assert.equal(result.code, 0);
    assert.match(cli.out.stdout, /Stopping Pleni/);
  }
}

function busyPort() {
  return new Promise((resolve) => {
    const blocker = net.createServer();
    blocker.listen(0, '127.0.0.1', () => resolve(blocker));
  });
}

// ---- simple flags ----

test('--version prints the package version', (t) => {
  const env = cliEnv(tempDir(t));
  for (const flag of ['--version', '-v']) {
    const result = runCli([flag], env);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, `${VERSION}\n`);
  }
});

test('--help lists every option and the settings file', (t) => {
  const home = tempDir(t);
  const result = runCli(['--help'], cliEnv(home));
  assert.equal(result.status, 0);
  for (const word of [`Usage: ${COMMAND} [options]`, '--port N', '--demo', '--open', '--config FILE', '--version', '--help', 'PLENI_PORT', 'PLENI_HOME']) {
    assert.ok(result.stdout.includes(word), word);
  }
  assert.ok(result.stdout.includes(path.join(home, 'settings.json')));
  assert.equal(runCli(['-h'], cliEnv(home)).stdout, result.stdout);

  const custom = path.join(home, 'custom.json');
  assert.ok(runCli(['--help', '--config', custom], cliEnv(home)).stdout.includes(custom));
});

test('wrong options get a short message and exit code 2', (t) => {
  const home = tempDir(t);
  const cases = [
    [['--nope'], {}, /Unknown option '--nope'\./],
    [['extra'], {}, /Unexpected argument 'extra'/],
    [['--port'], {}, /--port/],
    [['--port', 'abc'], {}, /--port must be a port number from 1 to 65535\./],
    [['--port', '70000'], {}, /--port must be a port number/],
    [['--port', '-5'], {}, /--port/],
    [['--config', ''], {}, /--config needs the name of a settings file\./],
    [[], { PLENI_PORT: 'eighty' }, /PLENI_PORT must be a port number/],
    [[], { PLENI_PORT: '99999' }, /PLENI_PORT must be a port number/],
  ];
  for (const [args, extra, message] of cases) {
    const result = runCli(args, cliEnv(home, extra));
    assert.equal(result.status, 2, args.join(' '));
    assert.match(result.stderr, message, args.join(' '));
    assert.ok(result.stderr.includes(`Run "${COMMAND} --help"`), args.join(' '));
    assert.equal(result.stdout, '');
  }
});

test('a bad PLENI_PORT or --config does not hide --help or --version', (t) => {
  const home = tempDir(t);
  for (const extra of [{ PLENI_PORT: 'abc' }, { PLENI_PORT: '99999' }]) {
    const help = runCli(['--help'], cliEnv(home, extra));
    assert.equal(help.status, 0);
    assert.ok(help.stdout.includes('--port N'));
    assert.equal(help.stderr, '');
    const version = runCli(['--version'], cliEnv(home, extra));
    assert.equal(version.status, 0);
    assert.equal(version.stdout, `${VERSION}\n`);
  }
  const blank = runCli(['--help', '--config', ''], cliEnv(home));
  assert.equal(blank.status, 0);
  assert.ok(blank.stdout.includes(path.join(home, 'settings.json')));
  assert.equal(runCli(['--version', '--port', 'abc'], cliEnv(home)).status, 0);
});

test('advice names the command that really started Pleni', (t) => {
  // From another folder "node bin/pleni.js" would not work, so the full path to the script is shown.
  const elsewhere = tempDir(t);
  const result = spawnSync(process.execPath, [CLI, '--nope'], { cwd: elsewhere, env: cliEnv(elsewhere), encoding: 'utf8', timeout: 20000 });
  assert.equal(result.status, 2);
  const shown = /\s/.test(CLI) ? `"${CLI}"` : CLI;
  assert.ok(result.stderr.includes(`Run "node ${shown} --help"`), 'full path to the script');
});

// ---- running ----

test('the address stays the same after a restart, and --new-key changes it', RUN, async (t) => {
  const home = tempDir(t);
  const first = startCli(t, ['--port', '0'], cliEnv(home));
  const a = await first.ready;
  assert.match(first.out.stdout, /stays the same each time Pleni starts/);
  await stopCli(first);
  const second = startCli(t, ['--port', '0'], cliEnv(home));
  const b = await second.ready;
  assert.equal(b.key, a.key);
  await stopCli(second);
  const third = startCli(t, ['--port', '0', '--new-key'], cliEnv(home));
  const c = await third.ready;
  assert.notEqual(c.key, a.key);
  assert.match(third.out.stdout, /This is a new key/);
  await stopCli(third);
  assert.equal(fs.readFileSync(path.join(home, 'key'), 'utf8').trim(), c.key);
});

test('pleni --demo runs, answers, uses PLENI_HOME and stops', RUN, async (t) => {
  const home = tempDir(t);
  // --port wins over PLENI_PORT, so a bad PLENI_PORT is not even read.
  const cli = startCli(t, ['--demo', '--port', '0'], cliEnv(home, { PLENI_PORT: 'not a port' }));
  const { port, url, key, cookie } = await cli.ready;
  assert.equal(url, `http://localhost:${port}/?t=${key}`);
  assert.match(key, /^[A-Za-z0-9_-]{43}$/);
  assert.match(cli.out.stdout, /Press Ctrl\+C to stop\./);

  const base = `http://127.0.0.1:${port}`;
  const health = await fetch(`${base}/api/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true, version: VERSION });
  assert.equal(health.headers.get('x-frame-options'), 'DENY');

  // Another program on this computer has not seen the key, so it gets nothing.
  assert.equal((await fetch(`${base}/api/snapshot`)).status, 401);
  const opened = await fetch(`${base}/?t=${key}`, { redirect: 'manual' });
  assert.equal(opened.status, 303);
  assert.equal(opened.headers.get('set-cookie').split(';')[0], cookie);

  const snapshot = await fetch(`${base}/api/snapshot`, { headers: { cookie } });
  assert.equal(snapshot.status, 200);
  assert.equal((await snapshot.json()).version, 1);

  const settings = await (await fetch(`${base}/api/settings`, { headers: { cookie } })).json();
  assert.equal(settings.file, path.join(home, 'settings.json'));

  await stopCli(cli);
});

test('--config chooses where settings are saved', RUN, async (t) => {
  const home = tempDir(t);
  const file = path.join(home, 'nested', 'my-settings.json');
  const cli = startCli(t, ['--demo', '--port', '0', '--config', file], cliEnv(home));
  const { port, cookie } = await cli.ready;

  const res = await fetch(`http://127.0.0.1:${port}/api/settings`, {
    method: 'POST',
    headers: { cookie, 'x-pleni': 'settings', 'content-type': 'application/json' },
    body: JSON.stringify({ displayName: 'Ada' }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.file, file);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).displayName, 'Ada');
  assert.equal(fs.existsSync(path.join(home, 'settings.json')), false);

  await stopCli(cli);
});

test('a port that is in use gets a friendly message', RUN, async (t) => {
  const blocker = await busyPort();
  t.after(() => blocker.close());
  const port = blocker.address().port;
  const result = await new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, '--demo'], { cwd: REPO, env: cliEnv(tempDir(t), { PLENI_PORT: String(port) }) });
    let stderr = '';
    child.stderr.setEncoding('utf8').on('data', (text) => { stderr += text; });
    child.on('exit', (code) => resolve({ code, stderr }));
  });
  assert.equal(result.code, 1);
  assert.match(result.stderr, new RegExp(`Port ${port} is already in use`));
  assert.ok(!/\n\s+at\s/.test(result.stderr), 'no stack trace');
});

test('a busy top port suggests the port below it, not one that cannot exist', RUN, async (t) => {
  const blocker = net.createServer();
  const listening = await new Promise((resolve) => {
    blocker.once('error', () => resolve(false));
    blocker.listen(65535, '127.0.0.1', () => resolve(true));
  });
  if (!listening) {
    t.skip('port 65535 is not free on this computer');
    return;
  }
  t.after(() => blocker.close());
  const result = runCli(['--demo', '--port', '65535'], cliEnv(tempDir(t)));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Port 65535 is already in use/);
  assert.ok(result.stderr.includes(`for example: ${COMMAND} --port 65534\n`));
});

// ---- scripts/check.js ----

function writeFiles(root, files) {
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
}

function runCheck(root) {
  return spawnSync(process.execPath, [CHECK, root], { encoding: 'utf8', timeout: 60000 });
}

// Built at run time so this file itself never holds a personal-looking path or address.
const personalPath = (sep) => ['C:', 'Users', 'jdoe', 'work'].join(sep);
const personalEmail = () => ['jdoe', 'mailhost.com'].join('@');

test('check passes clean files and allows the example names', (t) => {
  const root = tempDir(t, 'pleni-check-');
  writeFiles(root, {
    'package.json': '{ "type": "module" }\n',
    'src/ok.js': 'export const ok = 1;\n',
    'scripts/tool.mjs': 'export default function tool() {}\n',
    'README.md': [
      'Run it in C:\\Users\\ada\\project or /home/ada/project.',
      'Settings live in C:\\Users\\%USERNAME%\\AppData\\Roaming\\pleni.',
      'Write to ada@example.com, team@mail.example.org or noreply@github.com.',
      'The logo is logo@2x.png.',
    ].join('\n'),
  });
  const result = runCheck(root);
  assert.equal(result.status, 0, result.stdout);
  assert.match(result.stdout, /All clear: 2 script\(s\) parsed/);
});

test('check fails on a script that does not parse', (t) => {
  const root = tempDir(t, 'pleni-check-');
  writeFiles(root, {
    'package.json': '{ "type": "module" }\n',
    'src/ok.js': 'export const ok = 1;\n',
    'test/broken.js': 'const = ;\n',
  });
  const result = runCheck(root);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /test\/broken\.js: does not parse/);
  assert.ok(!result.stdout.includes('src/ok.js'));
});

test('check finds personal paths and addresses without printing them', (t) => {
  const root = tempDir(t, 'pleni-check-');
  writeFiles(root, {
    'notes.md': `line one\nline two\nsee ${personalPath('\\')}\n`,
    'data/config.json': JSON.stringify({ root: personalPath('\\') }),
    'docs/slash.md': `${personalPath('/')}\n`,
    'docs/contact.md': `ask ${personalEmail()}\n`,
    'brand/image.png': Buffer.concat([Buffer.from([0x89, 0, 0, 0]), Buffer.from(personalPath('\\'))]),
  });
  const result = runCheck(root);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /notes\.md:3: a personal Windows folder path/);
  assert.match(result.stdout, /data\/config\.json:1: a personal Windows folder path/);
  assert.match(result.stdout, /docs\/slash\.md:1: a personal Windows folder path/);
  assert.match(result.stdout, /docs\/contact\.md:1: an e-mail address that is not an example/);
  assert.ok(!result.stdout.includes('image.png'), 'binary files are skipped');
  assert.ok(!result.stdout.includes('jdoe'), 'the match itself is never printed');
  assert.match(result.stdout, /Found 4 problem\(s\)/);
});

test('check gives the right line for several matches in one file', (t) => {
  const root = tempDir(t, 'pleni-check-');
  writeFiles(root, {
    'docs/mixed.md': `${personalPath('\\')}\nplain\n${personalEmail()}\n${personalPath('/')}\n`,
  });
  const result = runCheck(root);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /docs\/mixed\.md:1: a personal Windows folder path/);
  assert.match(result.stdout, /docs\/mixed\.md:4: a personal Windows folder path/);
  assert.match(result.stdout, /docs\/mixed\.md:3: an e-mail address that is not an example/);
  assert.match(result.stdout, /Found 3 problem\(s\)/);
});

test('check stays fast on a long run of letters', (t) => {
  const root = tempDir(t, 'pleni-check-');
  // A token-like run with no "@" once made the address search take minutes.
  const run = 'Ab0-_'.repeat(80000);
  writeFiles(root, { 'data/blob.txt': `${run}\nask ${personalEmail()}\n` });
  const started = Date.now();
  const result = spawnSync(process.execPath, [CHECK, root], { encoding: 'utf8', timeout: 20000 });
  assert.equal(result.status, 1, `finished in ${Date.now() - started} ms`);
  assert.match(result.stdout, /data\/blob\.txt:2: an e-mail address that is not an example/);
  assert.match(result.stdout, /Found 1 problem\(s\)/);
});
