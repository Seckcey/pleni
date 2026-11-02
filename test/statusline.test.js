import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  STATUS_MESSAGES,
  createStatusSaver,
  isPleniCommand,
  pleniCommand,
  readStatusSetup,
  scriptText,
  statusFiles,
  upgradeScript,
} from '../src/statusline.js';
import { statusLineLimits } from '../src/usage.js';

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pleni-statusline-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// A Pleni folder with the script in it, and a way to run it.
function scriptSetup(t) {
  const dir = tempDir(t);
  const files = statusFiles(dir);
  fs.writeFileSync(files.script, scriptText());
  const run = (input, env = {}) => spawnSync(process.execPath, [files.script], { input, encoding: 'utf8', env: { ...process.env, ...env }, timeout: 20000 });
  return { dir, files, run };
}

const AT = 1_900_000_000; // seconds
const FULL = {
  model: { id: 'model-x', display_name: 'Opus' },
  cwd: '/home/ada/secret-project',
  session_id: 'aaaaaaaa-1111-2222-3333-444444444444',
  transcript_path: '/home/ada/.claude/projects/secret/x.jsonl',
  context_window: { used_percentage: 12 },
  rate_limits: {
    five_hour: { used_percentage: 23.6, resets_at: AT },
    seven_day: { used_percentage: 41, resets_at: AT + 86400 },
  },
};

// ---- the script ----

test('the script saves only the limits\' numbers and prints one short line', (t) => {
  const { files, run } = scriptSetup(t);
  const result = run(JSON.stringify(FULL));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'Opus \u00b7 5-hour 24% \u00b7 week 41%\n');
  const text = fs.readFileSync(files.limits, 'utf8');
  const saved = JSON.parse(text);
  assert.deepEqual(Object.keys(saved), ['v', 'at', 'windows']);
  assert.equal(saved.v, 1);
  assert.ok(Math.abs(saved.at - Date.now()) < 60 * 1000);
  assert.deepEqual(saved.windows, [
    { name: 'five_hour', minutes: 300, usedPercent: 23.6, resetsAt: AT * 1000 },
    { name: 'seven_day', minutes: 10080, usedPercent: 41, resetsAt: (AT + 86400) * 1000 },
  ]);
  for (const secret of ['secret-project', 'aaaaaaaa', 'Opus', 'transcript']) assert.ok(!text.includes(secret), secret);
  assert.deepEqual(fs.readdirSync(path.dirname(files.limits)).sort(), ['claude-limits.json', 'pleni-statusline.mjs']);
  if (process.platform !== 'win32') assert.equal(fs.statSync(files.limits).mode & 0o777, 0o600);
  // Pleni reads it back as the Usage popup's limits.
  const limits = statusLineLimits(path.dirname(files.limits));
  assert.equal(limits.from, 'statusLine');
  assert.equal(limits.windows.length, 2);
});

test('the script keeps only windows with real numbers, and the spend limit', (t) => {
  const { files, run } = scriptSetup(t);
  const input = {
    model: { display_name: 'Sonnet' },
    rate_limits: {
      five_hour: { used_percentage: '30', resets_at: AT },
      seven_day: { used_percentage: 250, resets_at: AT },
      spend_limit: { used_percentage: 5, resets_at: AT },
      other: { used_percentage: 1, resets_at: AT },
    },
  };
  const result = run(JSON.stringify(input));
  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'Sonnet \u00b7 week 100% \u00b7 spend 5%\n');
  const windows = JSON.parse(fs.readFileSync(files.limits, 'utf8')).windows;
  assert.deepEqual(windows.map((w) => [w.name, w.minutes, w.usedPercent]), [['seven_day', 10080, 100], ['spend_limit', null, 5]]);
});

test('without rate_limits the script saves nothing', (t) => {
  const { files, run } = scriptSetup(t);
  const result = run(JSON.stringify({ model: { display_name: 'Haiku' }, cwd: '/home/ada/project' }));
  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'Haiku\n');
  assert.equal(fs.existsSync(files.limits), false);
  assert.equal(run(JSON.stringify({ rate_limits: 5 })).status, 0);
  assert.equal(fs.existsSync(files.limits), false);
});

test('a reply with no usable window keeps the limits already saved', (t) => {
  const { files, run } = scriptSetup(t);
  run(JSON.stringify(FULL));
  const before = fs.readFileSync(files.limits, 'utf8');
  for (const rate_limits of [{}, { five_hour: {} }, { five_hour: { used_percentage: 5 } }, { seven_day: { resets_at: AT } }]) {
    const result = run(JSON.stringify({ model: { display_name: 'Opus' }, rate_limits }));
    assert.equal(result.status, 0);
    assert.equal(fs.readFileSync(files.limits, 'utf8'), before, JSON.stringify(rate_limits));
  }
});

test('a bad or huge input still ends with code 0 and saves nothing', (t) => {
  const { files, run } = scriptSetup(t);
  for (const input of ['', 'not json', '[1,2', 'null', '"text"', 'x'.repeat(2 * 1024 * 1024)]) {
    const result = run(input);
    assert.equal(result.status, 0, input.slice(0, 20));
    assert.equal(result.stdout, 'Claude Code\n');
  }
  assert.equal(fs.existsSync(files.limits), false);
});

// A tiny command that every system can run: it prints what it was given on standard input.
const ECHO = 'node -e "process.stdin.pipe(process.stdout)"';

test('the script runs the status line the person had, with the same input, and keeps its code', (t) => {
  const { files, run } = scriptSetup(t);
  fs.writeFileSync(files.previous, JSON.stringify({ type: 'command', command: ECHO, padding: 1 }));
  const input = JSON.stringify(FULL);
  const result = run(input);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, input, 'their command got the same input and Pleni printed only its output');
  assert.equal(JSON.parse(fs.readFileSync(files.limits, 'utf8')).windows.length, 2, 'the limits are saved too');
  fs.writeFileSync(files.previous, JSON.stringify({ type: 'command', command: 'node -e "console.log(\'mine\'); process.exit(3)"' }));
  const coded = run(input);
  assert.equal(coded.status, 3);
  assert.equal(coded.stdout, 'mine\n');
  // A saved file with no command, or one that is damaged, means no old status line.
  for (const body of ['{}', '{"type":"command","command":""}', 'oops']) {
    fs.writeFileSync(files.previous, body);
    assert.equal(run(input).stdout, 'Opus \u00b7 5-hour 24% \u00b7 week 41%\n', body);
  }
});

test('a saved old status line that calls Pleni\'s own script is never run', (t) => {
  const { files, run } = scriptSetup(t);
  const script = files.script.replace(/\\/g, '/');
  for (const command of [`node "${script}"`, `node ${script} --again`, 'bash -c "node /home/ada/.config/pleni/PLENI-STATUSLINE.MJS"']) {
    fs.writeFileSync(files.previous, JSON.stringify({ type: 'command', command }));
    const result = run(JSON.stringify(FULL));
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'Opus \u00b7 5-hour 24% \u00b7 week 41%\n', command);
  }
});

test('the old status line runs in bash or zsh, even when SHELL is another shell', { skip: process.platform === 'win32' }, (t) => {
  const { files, run } = scriptSetup(t);
  // A shell that would fail on POSIX words, named like fish.
  const fish = path.join(tempDir(t), 'fish');
  fs.writeFileSync(fish, '#!/bin/sh\nexit 7\n', { mode: 0o755 });
  fs.writeFileSync(files.previous, JSON.stringify({ type: 'command', command: 'input=$(cat); echo "got $input"' }));
  const result = run('hi', { SHELL: fish });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'got hi\n');
});

// ---- the command ----

test('the command is node and the path on Windows, and the full node path elsewhere', () => {
  assert.equal(pleniCommand('C:\\Users\\ada\\AppData\\Roaming\\pleni\\pleni-statusline.mjs', 'win32', 'C:\\node\\node.exe'), 'node "C:/Users/ada/AppData/Roaming/pleni/pleni-statusline.mjs"');
  assert.equal(pleniCommand('/home/ada/.pleni/pleni-statusline.mjs', 'linux', '/usr/bin/node'), '"/usr/bin/node" "/home/ada/.pleni/pleni-statusline.mjs"');
  assert.equal(pleniCommand('/Users/ada/pleni/pleni-statusline.mjs', 'darwin', '/opt/node 22/bin/node'), '"/opt/node 22/bin/node" "/Users/ada/pleni/pleni-statusline.mjs"');
  for (const bad of ['/home/ada/a"b/s.mjs', '/home/ada/a`b/s.mjs', '/home/ada/$HOME/s.mjs', '/home/ada/a\nb/s.mjs', '/home/ada/a\rb/s.mjs']) {
    assert.equal(pleniCommand(bad, 'linux', '/usr/bin/node'), null, JSON.stringify(bad));
    assert.equal(pleniCommand(bad, 'win32'), null, JSON.stringify(bad));
  }
  assert.equal(pleniCommand('/home/ada/s.mjs', 'linux', '/opt/no"de/node'), null);
  assert.equal(pleniCommand('', 'linux', '/usr/bin/node'), null);
  assert.equal(isPleniCommand(pleniCommand('/home/ada/p/pleni-statusline.mjs', 'linux', '/usr/bin/node')), true);
  assert.equal(isPleniCommand('node "C:/Users/ada/pleni/pleni-statusline.mjs"'), true);
  assert.equal(isPleniCommand('~/bin/my-line.sh'), false);
  assert.equal(isPleniCommand(undefined), false);
});

// ---- Settings ----

const NODE = process.execPath;
// Real folders follow this computer's rules (a Windows folder has backslashes, which Linux's rule refuses).
const PLATFORM = process.platform;
const SCRIPT_OF = (dir) => statusFiles(dir).script;

test('Settings tells connected, stale, own status line and unusable files apart', (t) => {
  const root = tempDir(t);
  const dir = tempDir(t);
  const scriptPath = SCRIPT_OF(dir);
  const setup = () => readStatusSetup({ root, scriptPath, platform: PLATFORM, execPath: NODE });
  const write = (value) => fs.writeFileSync(path.join(root, 'settings.json'), typeof value === 'string' ? value : JSON.stringify(value));
  assert.equal(readStatusSetup({ root: null, scriptPath, platform: PLATFORM, execPath: NODE }).error, STATUS_MESSAGES.noRoot);
  // No file yet.
  let state = setup();
  assert.deepEqual([state.ok, state.found, state.connected, state.stale, state.previous], [true, false, false, false, false]);
  assert.deepEqual(JSON.parse(state.lines), { statusLine: { type: 'command', command: pleniCommand(scriptPath, PLATFORM, NODE) } });
  // The person's own status line stays.
  write({ statusLine: { type: 'command', command: '~/bin/line.sh' } });
  state = setup();
  assert.deepEqual([state.connected, state.stale, state.previous], [false, false, true]);
  // Pleni's.
  write({ statusLine: { type: 'command', command: pleniCommand(scriptPath, PLATFORM, NODE) } });
  state = setup();
  assert.deepEqual([state.ok, state.found, state.connected, state.stale, state.previous], [true, true, true, false, false]);
  // Pleni's script, but another node (off Windows, where the command names node's full path) or folder.
  if (PLATFORM !== 'win32') {
    write({ statusLine: { type: 'command', command: pleniCommand(scriptPath, PLATFORM, '/opt/other/node') } });
    state = setup();
    assert.deepEqual([state.connected, state.stale, state.previous], [false, true, false]);
  }
  write({ statusLine: { type: 'command', command: 'node "/home/ada/old/pleni-statusline.mjs"' } });
  assert.equal(setup().stale, true);
  // Files Pleni will not change.
  write('[1]');
  assert.equal(setup().error, STATUS_MESSAGES.notObject);
  write({ statusLine: 'line.sh' });
  assert.equal(setup().error, STATUS_MESSAGES.notSimple);
  write('{ oops');
  assert.equal(setup().error, STATUS_MESSAGES.notObject);
  // A folder Pleni cannot make a command for.
  const odd = readStatusSetup({ root, scriptPath: '/home/ada/$x/pleni-statusline.mjs', platform: 'linux', execPath: '/usr/bin/node' });
  assert.equal(odd.lines, null);
});

// ---- Connect and Disconnect ----

function saverSetup(t, settingsText) {
  const root = tempDir(t);
  const dir = path.join(tempDir(t), 'pleni');
  fs.mkdirSync(dir);
  const file = path.join(root, 'settings.json');
  if (settingsText !== null) fs.writeFileSync(file, settingsText);
  let now = 1_700_000_000_000;
  const saver = createStatusSaver({ now: () => now });
  const where = { root, dir, backupDir: path.join(dir, 'backups'), platform: PLATFORM, execPath: NODE };
  return { root, dir, file, saver, where, files: statusFiles(dir), tick: (ms = 1000) => { now += ms; } };
}

const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

test('Connect adds a status line after a copy of the file, and Disconnect takes it out', (t) => {
  const before = '{\r\n    "model": "opus",\r\n    "hooks": {\r\n        "Stop": []\r\n    }\r\n}\r\n';
  const s = saverSetup(t, before);
  const done = s.saver.connect(s.where);
  assert.equal(done.ok, true, done.error);
  assert.match(path.basename(done.backup), /^claude-settings-\d{8}-\d{6}\.json$/);
  assert.equal(fs.readFileSync(done.backup, 'utf8'), before);
  const text = fs.readFileSync(s.file, 'utf8');
  assert.ok(text.startsWith('{\r\n    "model": "opus"'), 'the old indent and line breaks are kept');
  const saved = JSON.parse(text);
  assert.deepEqual(saved.hooks, { Stop: [] });
  assert.deepEqual(saved.statusLine, { type: 'command', command: pleniCommand(s.files.script, PLATFORM, NODE) });
  assert.equal(fs.readFileSync(s.files.script, 'utf8'), scriptText());
  assert.equal(fs.existsSync(s.files.previous), false, 'there was no status line to keep');
  assert.equal(readStatusSetup({ root: s.root, scriptPath: s.files.script, platform: PLATFORM, execPath: NODE }).connected, true);
  s.tick();
  fs.writeFileSync(s.files.limits, '{}');
  const off = s.saver.disconnect(s.where);
  assert.equal(off.ok, true, off.error);
  assert.equal(off.note, null);
  assert.equal(fs.readFileSync(s.file, 'utf8'), before, 'the file is back exactly as it was');
  for (const f of Object.values(s.files)) assert.equal(fs.existsSync(f), false, path.basename(f));
});

test('the person\'s own status line is kept exactly and put back', (t) => {
  const mine = { type: 'command', command: '~/bin/line.sh --short', padding: 2, refreshInterval: 30, hideVimModeIndicator: true, extra: { a: [1, 2, null] } };
  const before = JSON.stringify({ model: 'opus', statusLine: mine, theme: 'dark' }, null, 2) + '\n';
  const s = saverSetup(t, before);
  assert.equal(readStatusSetup({ root: s.root, scriptPath: s.files.script, platform: PLATFORM, execPath: NODE }).previous, true);
  assert.equal(s.saver.connect(s.where).ok, true);
  const saved = read(s.file);
  assert.deepEqual(Object.keys(saved), ['model', 'statusLine', 'theme'], 'the key stays where it was');
  assert.deepEqual(saved.statusLine, { ...mine, command: pleniCommand(s.files.script, PLATFORM, NODE) });
  assert.deepEqual(read(s.files.previous), mine);
  // Connect again: nothing in the file changes, the saved old line stays the person's, the script is made fresh.
  fs.writeFileSync(s.files.script, '// old script\n');
  s.tick();
  const again = s.saver.connect(s.where);
  assert.equal(again.ok, true);
  assert.equal(again.backup, null);
  assert.deepEqual(read(s.files.previous), mine);
  assert.equal(fs.readFileSync(s.files.script, 'utf8'), scriptText());
  // Connect after Pleni moved (another node): the line is Pleni's, so it is not saved over the old one.
  s.tick();
  assert.equal(s.saver.connect({ ...s.where, execPath: '/opt/other/node' }).ok, true);
  assert.deepEqual(read(s.files.previous), mine);
  s.tick();
  const off = s.saver.disconnect(s.where);
  assert.equal(off.ok, true);
  assert.equal(fs.readFileSync(s.file, 'utf8'), before);
  assert.equal(fs.existsSync(s.files.previous), false);
});

test('Connect forgets an old saved line when the person has none now', (t) => {
  const s = saverSetup(t, '{ "model": "opus" }\n');
  fs.writeFileSync(s.files.previous, JSON.stringify({ type: 'command', command: 'left-over.sh' }));
  assert.equal(s.saver.connect(s.where).ok, true);
  assert.equal(fs.existsSync(s.files.previous), false);
  // No settings file at all: Connect makes one with only the status line.
  const fresh = saverSetup(t, null);
  assert.equal(fresh.saver.connect(fresh.where).ok, true);
  assert.deepEqual(Object.keys(read(fresh.file)), ['statusLine']);
  assert.equal(fresh.saver.disconnect(fresh.where).ok, true);
  assert.deepEqual(read(fresh.file), {});
});

test('Pleni changes nothing when the file changed while it worked', (t) => {
  const s = saverSetup(t, '{ "model": "opus" }\n');
  const other = '{ "model": "sonnet" }\n';
  // The folder for the copy is asked for after the file was read, and before it is written.
  const where = { ...s.where, get backupDir() { fs.writeFileSync(s.file, other); return path.join(s.dir, 'backups'); } };
  const result = s.saver.connect(where);
  assert.equal(result.ok, false);
  assert.equal(result.status, 409);
  assert.equal(result.error, STATUS_MESSAGES.changed);
  assert.equal(fs.readFileSync(s.file, 'utf8'), other);
  assert.equal(fs.existsSync(s.files.script), false, 'Pleni wrote none of its files');
});

test('Disconnect leaves a status line that is not Pleni\'s any more', (t) => {
  const s = saverSetup(t, '{ "model": "opus" }\n');
  assert.equal(s.saver.connect(s.where).ok, true);
  fs.writeFileSync(s.files.limits, '{}');
  const theirs = JSON.stringify({ model: 'opus', statusLine: { type: 'command', command: 'new-line.sh' } }, null, 2) + '\n';
  fs.writeFileSync(s.file, theirs);
  s.tick();
  const off = s.saver.disconnect(s.where);
  assert.equal(off.ok, true);
  assert.equal(off.backup, null);
  assert.equal(off.note, STATUS_MESSAGES.notMine);
  assert.equal(fs.readFileSync(s.file, 'utf8'), theirs);
  assert.equal(fs.existsSync(s.files.script), false);
  assert.equal(fs.existsSync(s.files.limits), false);
  // No status line at all any more: nothing to put back.
  fs.writeFileSync(s.file, '{ "model": "opus" }\n');
  s.tick();
  const none = s.saver.disconnect(s.where);
  assert.equal(none.ok, true);
  assert.equal(none.note, null);
  assert.equal(fs.readFileSync(s.file, 'utf8'), '{ "model": "opus" }\n');
});

test('Disconnect from another Pleni folder leaves the status line alone', (t) => {
  const mine = { type: 'command', command: '~/bin/line.sh', padding: 1 };
  const a = saverSetup(t, JSON.stringify({ model: 'opus', statusLine: mine }, null, 2) + '\n');
  assert.equal(a.saver.connect(a.where).ok, true);
  const connected = fs.readFileSync(a.file, 'utf8');
  // Another Pleni folder, same Claude Code settings.
  const dirB = path.join(tempDir(t), 'pleni');
  fs.mkdirSync(dirB);
  const off = a.saver.disconnect({ ...a.where, dir: dirB, backupDir: path.join(dirB, 'backups') });
  assert.equal(off.ok, true);
  assert.equal(off.note, STATUS_MESSAGES.otherFolder);
  assert.equal(fs.readFileSync(a.file, 'utf8'), connected, 'the file is not touched');
  assert.deepEqual(read(a.files.previous), mine, 'the saved copy in the first folder stays');
});

test('Pleni refuses unsafe files, paths, and too many changes in a minute', (t) => {
  const s = saverSetup(t, '[1]');
  assert.equal(s.saver.connect(s.where).error, STATUS_MESSAGES.notObject);
  fs.writeFileSync(s.file, '{ "statusLine": "line.sh" }');
  assert.equal(s.saver.connect(s.where).error, STATUS_MESSAGES.notSimple);
  assert.equal(s.saver.connect({ ...s.where, root: null }).error, STATUS_MESSAGES.noRoot);
  fs.writeFileSync(s.file, '{}');
  assert.equal(s.saver.connect({ ...s.where, dir: path.join(s.dir, 'a"b') }).error, STATUS_MESSAGES.badPath);
  assert.equal(fs.readFileSync(s.file, 'utf8'), '{}');
  let last;
  for (let i = 0; i < 12; i++) last = s.saver.connect(s.where);
  assert.equal(last.status, 429);
  assert.equal(last.error, STATUS_MESSAGES.tooMany);
  s.tick(61 * 1000);
  assert.equal(s.saver.connect(s.where).ok, true);
});

test('Pleni writes the script again at start only when connected and different', (t) => {
  const s = saverSetup(t, '{}');
  const args = { root: s.root, dir: s.dir, platform: PLATFORM, execPath: NODE };
  assert.equal(upgradeScript(args), false, 'not connected: nothing is written');
  assert.equal(fs.existsSync(s.files.script), false);
  assert.equal(s.saver.connect(s.where).ok, true);
  assert.equal(upgradeScript(args), false, 'the same text: nothing to do');
  fs.writeFileSync(s.files.script, '// from an older Pleni\n');
  assert.equal(upgradeScript(args), true);
  assert.equal(fs.readFileSync(s.files.script, 'utf8'), scriptText());
  fs.rmSync(s.files.script);
  assert.equal(upgradeScript(args), true, 'a missing script is made again');
  assert.equal(upgradeScript({ root: null, dir: s.dir }), false);
});

// ---- reading the limits ----

test('Pleni reads the saved limits only when the file is small and holds real numbers', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'claude-limits.json');
  assert.equal(statusLineLimits(dir), null);
  fs.writeFileSync(file, JSON.stringify({ v: 1, at: 1000, windows: [{ name: 'five_hour', minutes: 300, usedPercent: 12.5, resetsAt: 5000 }, { name: 'seven_day', minutes: 10080, usedPercent: 'many', resetsAt: 5000 }, { name: 'bogus', usedPercent: 1, resetsAt: 1 }, { name: 'spend_limit', usedPercent: 400, resetsAt: 9000 }] }));
  assert.deepEqual(statusLineLimits(dir), {
    at: 1000,
    from: 'statusLine',
    plan: null,
    windows: [
      { name: 'five_hour', minutes: 300, usedPercent: 12.5, resetsAt: 5000 },
      { name: 'spend_limit', minutes: null, usedPercent: 100, resetsAt: 9000 },
    ],
  });
  for (const body of ['oops', '[]', '{"v":2,"at":1,"windows":[]}', '{"v":1,"at":"x","windows":[]}', '{"v":1,"at":1,"windows":[]}', `{"v":1,"at":1,"windows":[],"pad":"${'x'.repeat(70000)}"}`]) {
    fs.writeFileSync(file, body);
    assert.equal(statusLineLimits(dir), null, body.slice(0, 30));
  }
});
