import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULTS,
  cleanSettings,
  configDir,
  isNodeKey,
  loadSettings,
  resolveRoots,
  saveSettings,
  settingsFile,
} from '../src/config.js';

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pleni-config-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const UUID = '0f8e2c4a-1b3d-4e5f-8a9b-0c1d2e3f4a5b';

test('defaults are complete and frozen', () => {
  assert.equal(DEFAULTS.version, 1);
  assert.equal(DEFAULTS.port, 8790);
  assert.ok(Object.isFrozen(DEFAULTS));
  assert.ok(Object.isFrozen(DEFAULTS.sources.mailbox));
  assert.ok(Object.isFrozen(DEFAULTS.modelTiers.senior));
});

test('cleanSettings fills in defaults for empty or wrong input', () => {
  for (const raw of [undefined, null, {}, [], 'settings', 42]) {
    assert.deepEqual(cleanSettings(raw), DEFAULTS);
  }
});

test('cleanSettings returns a fresh copy that can be changed', () => {
  const settings = cleanSettings({});
  settings.window.activeMinutes = 99;
  settings.modelTiers.senior.push('new');
  settings.remote.hosts.push('box.example.ts.net');
  assert.equal(DEFAULTS.window.activeMinutes, 10);
  assert.deepEqual(DEFAULTS.modelTiers.senior, ['opus', 'fable', 'astra']);
  assert.deepEqual(DEFAULTS.remote.hosts, []);
});

test('cleanSettings keeps good values', () => {
  const root = path.resolve(os.tmpdir(), 'claude-root');
  const raw = {
    version: 1,
    port: 9100,
    displayName: 'Ada',
    titles: 'military',
    content: 'none',
    groupBy: 'none',
    window: { activeMinutes: 15, recentHours: 48, staleMinutes: 60 },
    showReviewers: true,
    modelTiers: { senior: ['opus'], junior: [] },
    sources: {
      claude: { enabled: false, root },
      claudeDesktop: { enabled: true, root: null },
      codex: { enabled: true, root: null },
      mailbox: { enabled: true, root, planner: `codex:${UUID}`, coordinator: `claude:${UUID}` },
    },
    people: { you: { label: 'Ada' }, [`claude:${UUID}`]: { label: 'Builder', role: 'coordinator' } },
    projects: { pleni: { label: 'Pleni', hidden: false } },
    chain: [{ match: 'Sergeant', reportsTo: 'Colonel', role: 'coordinator' }, { match: 'Colonel', reportsTo: 'you', role: null }],
    remote: { hosts: ['box.example.ts.net'], tailscaleUsers: ['ada@example.com'] },
  };
  assert.deepEqual(cleanSettings(raw), raw);
});

test('cleanSettings clamps and rounds numbers', () => {
  const low = cleanSettings({ port: 80, window: { activeMinutes: 0, recentHours: 0, staleMinutes: 1 } });
  assert.equal(low.port, 1024);
  assert.deepEqual(low.window, { activeMinutes: 1, recentHours: 1, staleMinutes: 5 });

  const high = cleanSettings({ port: 70000, window: { activeMinutes: 1000, recentHours: 9999, staleMinutes: 99999 } });
  assert.equal(high.port, 65535);
  assert.deepEqual(high.window, { activeMinutes: 240, recentHours: 720, staleMinutes: 1440 });

  assert.equal(cleanSettings({ port: 8080.6 }).port, 8081);
  assert.equal(cleanSettings({ port: '9000' }).port, 8790);
  assert.equal(cleanSettings({ port: Number.NaN }).port, 8790);
  assert.equal(cleanSettings({ port: Infinity }).port, 8790);
  assert.equal(cleanSettings({ window: { activeMinutes: '5' } }).window.activeMinutes, 10);
});

test('cleanSettings trims and clips text', () => {
  assert.equal(cleanSettings({ displayName: '  Ada  ' }).displayName, 'Ada');
  assert.equal(cleanSettings({ displayName: 'x'.repeat(100) }).displayName, 'x'.repeat(40));
  assert.equal(cleanSettings({ displayName: '   ' }).displayName, 'You');
  assert.equal(cleanSettings({ displayName: 7 }).displayName, 'You');
  assert.equal(cleanSettings({ displayName: 'Ada\n\tLovelace' }).displayName, 'Ada Lovelace');
  // Clipping never splits a character made of two UTF-16 units.
  assert.equal(cleanSettings({ displayName: '\u{1F600}'.repeat(50) }).displayName, '\u{1F600}'.repeat(40));

  const people = cleanSettings({ people: { you: { label: 'y'.repeat(200) } } }).people;
  assert.equal(people.you.label, 'y'.repeat(80));
});

test('cleanSettings drops unknown keys', () => {
  const settings = cleanSettings({
    extra: 1,
    version: 7,
    window: { activeMinutes: 5, extra: 2 },
    modelTiers: { senior: ['opus'], middle: ['x'] },
    sources: { other: { enabled: true }, claude: { enabled: true, extra: 1 } },
    remote: { hosts: [], extra: true },
    people: { you: { label: 'Ada', extra: 1 } },
    projects: { pleni: { hidden: true, extra: 1 } },
  });
  assert.equal(settings.version, 1);
  assert.equal('extra' in settings, false);
  assert.deepEqual(Object.keys(settings), Object.keys(DEFAULTS));
  assert.deepEqual(Object.keys(settings.window), ['activeMinutes', 'recentHours', 'staleMinutes']);
  assert.deepEqual(Object.keys(settings.modelTiers), ['senior', 'junior']);
  assert.deepEqual(Object.keys(settings.sources), ['claude', 'claudeDesktop', 'codex', 'mailbox']);
  assert.deepEqual(settings.sources.claude, { enabled: true, root: null });
  assert.deepEqual(settings.remote, { hosts: [], tailscaleUsers: [] });
  assert.deepEqual(settings.people, { you: { label: 'Ada' } });
  assert.deepEqual(settings.projects, { pleni: { hidden: true } });
});

test('cleanSettings replaces wrong types with defaults', () => {
  const settings = cleanSettings({
    titles: 'royal',
    content: 5,
    groupBy: ['project'],
    window: 'soon',
    showReviewers: 'yes',
    modelTiers: 'opus',
    sources: { claude: { enabled: 'no', root: 5 }, mailbox: 'on' },
    people: ['you'],
    projects: 'pleni',
    remote: { hosts: 'box', tailscaleUsers: null },
  });
  assert.deepEqual(settings, DEFAULTS);
});

test('cleanSettings cleans lists: lower case, no repeats, no blanks, capped', () => {
  const settings = cleanSettings({
    modelTiers: { senior: ['Opus', 'opus', ' FABLE ', '', 3, 'two words'], junior: ['Haiku'] },
    remote: {
      hosts: ['Box.Example.ts.net', 'box.example.ts.net', ...Array.from({ length: 30 }, (_, i) => `h${i}.example`)],
      tailscaleUsers: ['Ada@Example.com', 'ada@example.com', null, 'x'.repeat(300)],
    },
  });
  assert.deepEqual(settings.modelTiers, { senior: ['opus', 'fable'], junior: ['haiku'] });
  assert.equal(settings.remote.hosts.length, 20);
  assert.equal(settings.remote.hosts[0], 'box.example.ts.net');
  assert.equal(settings.remote.hosts[1], 'h0.example');
  assert.deepEqual(settings.remote.tailscaleUsers, ['ada@example.com']);
});

test('isNodeKey accepts only real node keys', () => {
  const good = [
    'you',
    'claude:0123abcd',
    `claude:${UUID}`,
    `codex:${UUID}`,
    `claude:${UUID}/a1b2c3d4e5f6`,
    `claude:${UUID}/agent_one-2`,
    'project:pleni',
    'project:My Project (old)',
    `project:${'p'.repeat(120)}`,
  ];
  for (const key of good) assert.equal(isNodeKey(key), true, key);

  const bad = [
    '',
    'You',
    'you ',
    'claude:0123abc',
    'claude:0123ABCD',
    'claude:0123abcz',
    `claude:${'a'.repeat(65)}`,
    `claude:${UUID}/`,
    `claude:${UUID}/Agent`,
    `claude:${UUID}/a/b`,
    `gemini:${UUID}`,
    `claude:${UUID}\n`,
    'project:',
    `project:${'p'.repeat(121)}`,
    'project:a\nb',
    'project:a\u0000b',
    null,
    42,
  ];
  for (const key of bad) assert.equal(isNodeKey(key), false, String(key));
});

test('cleanSettings validates node keys, roles and entry limits', () => {
  const people = {
    you: { role: 'superintendent' },
    'claude:NOT-A-KEY': { label: 'Bad' },
    [`codex:${UUID}`]: { label: 'Planner', role: 'boss' },
    [`claude:${UUID}`]: { role: 'hidden' },
    'project:pleni': {},
    'project:other': 'lead',
  };
  for (let i = 0; i < 600; i++) people[`claude:${String(i).padStart(8, '0')}`] = { role: 'worker' };

  const settings = cleanSettings({
    people,
    sources: { mailbox: { planner: 'someone', coordinator: ` claude:${UUID} ` } },
  });
  assert.deepEqual(settings.people.you, { role: 'superintendent' });
  assert.deepEqual(settings.people[`codex:${UUID}`], { label: 'Planner' });
  assert.deepEqual(settings.people[`claude:${UUID}`], { role: 'hidden' });
  assert.equal('claude:NOT-A-KEY' in settings.people, false);
  assert.equal('project:pleni' in settings.people, false);
  assert.equal('project:other' in settings.people, false);
  assert.equal(Object.keys(settings.people).length, 500);
  // A text that is not a key is a session name to look for.
  assert.equal(settings.sources.mailbox.planner, 'someone');
  assert.equal(settings.sources.mailbox.coordinator, `claude:${UUID}`);
});

test('cleanSettings validates project names and handles odd keys safely', () => {
  const raw = JSON.parse('{"projects":{"__proto__":{"label":"Proto"},"ok":{"hidden":true},"":{"hidden":true},"bad\\u0001":{"hidden":true},"none":{"label":"   "}}}');
  const { projects } = cleanSettings(raw);
  assert.deepEqual(Object.keys(projects), ['__proto__', 'ok']);
  assert.equal(Object.getPrototypeOf(projects), Object.prototype);
  assert.deepEqual(projects.ok, { hidden: true });
  assert.deepEqual(Object.getOwnPropertyDescriptor(projects, '__proto__').value, { label: 'Proto' });

  const many = {};
  for (let i = 0; i < 250; i++) many[`project-${i}`] = { hidden: true };
  assert.equal(Object.keys(cleanSettings({ projects: many }).projects).length, 200);
});

test('cleanSettings keeps only absolute roots', () => {
  const absolute = path.resolve(os.tmpdir(), 'session-root');
  const roots = (root) => cleanSettings({ sources: { claude: { root }, mailbox: { root } } }).sources;

  assert.equal(roots(absolute).claude.root, absolute);
  assert.equal(roots(`  ${absolute}  `).mailbox.root, absolute);
  for (const bad of ['relative/dir', './here', '../up', '~/.claude', 'C:folder', '', '   ', 5, {}, `${absolute}\u0000x`]) {
    assert.equal(roots(bad).claude.root, null, String(bad));
    assert.equal(roots(bad).mailbox.root, null, String(bad));
  }
});

test('configDir and settingsFile follow each platform', () => {
  assert.equal(
    configDir({ APPDATA: 'C:\\Users\\ada\\AppData\\Roaming' }, 'win32', 'C:\\Users\\ada'),
    'C:\\Users\\ada\\AppData\\Roaming\\pleni',
  );
  assert.equal(configDir({}, 'win32', 'C:\\Users\\ada'), 'C:\\Users\\ada\\AppData\\Roaming\\pleni');
  assert.equal(configDir({}, 'darwin', '/Users/ada'), '/Users/ada/Library/Application Support/pleni');
  assert.equal(configDir({}, 'linux', '/home/ada'), '/home/ada/.config/pleni');
  assert.equal(configDir({ XDG_CONFIG_HOME: '/home/ada/.cfg' }, 'linux', '/home/ada'), '/home/ada/.cfg/pleni');
  assert.equal(configDir({ XDG_CONFIG_HOME: '' }, 'linux', '/home/ada'), '/home/ada/.config/pleni');

  assert.equal(configDir({ PLENI_HOME: '/srv/pleni', XDG_CONFIG_HOME: '/x' }, 'linux', '/home/ada'), '/srv/pleni');
  assert.equal(configDir({ PLENI_HOME: 'D:\\pleni' }, 'win32', 'C:\\Users\\ada'), 'D:\\pleni');
  assert.equal(configDir({ PLENI_HOME: '/opt/pleni' }, 'darwin', '/Users/ada'), '/opt/pleni');

  assert.equal(settingsFile({}, 'linux', '/home/ada'), '/home/ada/.config/pleni/settings.json');
  assert.equal(
    settingsFile({ APPDATA: 'C:\\Users\\ada\\AppData\\Roaming' }, 'win32', 'C:\\Users\\ada'),
    'C:\\Users\\ada\\AppData\\Roaming\\pleni\\settings.json',
  );
});

test('configDir uses this computer when called with no arguments', () => {
  assert.ok(path.isAbsolute(configDir()));
  assert.equal(path.basename(settingsFile()), 'settings.json');
});

test('resolveRoots uses platform defaults', () => {
  assert.deepEqual(resolveRoots(DEFAULTS, {}, 'linux', '/home/ada'), {
    claude: '/home/ada/.claude',
    claudeDesktop: '/home/ada/.config/Claude',
    codex: '/home/ada/.codex',
    mailbox: null,
  });
  assert.deepEqual(resolveRoots(DEFAULTS, {}, 'darwin', '/Users/ada'), {
    claude: '/Users/ada/.claude',
    claudeDesktop: '/Users/ada/Library/Application Support/Claude',
    codex: '/Users/ada/.codex',
    mailbox: null,
  });
  assert.deepEqual(resolveRoots(DEFAULTS, { APPDATA: 'C:\\Users\\ada\\AppData\\Roaming' }, 'win32', 'C:\\Users\\ada'), {
    claude: 'C:\\Users\\ada\\.claude',
    claudeDesktop: 'C:\\Users\\ada\\AppData\\Roaming\\Claude',
    codex: 'C:\\Users\\ada\\.codex',
    mailbox: null,
  });
  assert.equal(resolveRoots(DEFAULTS, {}, 'win32', 'C:\\Users\\ada').claudeDesktop, 'C:\\Users\\ada\\AppData\\Roaming\\Claude');
});

test('resolveRoots honours environment variables', () => {
  const env = { CLAUDE_CONFIG_DIR: '/opt/claude', CODEX_HOME: '/opt/codex' };
  const roots = resolveRoots(DEFAULTS, env, 'linux', '/home/ada');
  assert.equal(roots.claude, '/opt/claude');
  assert.equal(roots.codex, '/opt/codex');

  const win = resolveRoots(DEFAULTS, { CLAUDE_CONFIG_DIR: 'D:\\claude', CODEX_HOME: 'D:\\codex' }, 'win32', 'C:\\Users\\ada');
  assert.equal(win.claude, 'D:\\claude');
  assert.equal(win.codex, 'D:\\codex');

  const blank = resolveRoots(DEFAULTS, { CLAUDE_CONFIG_DIR: '  ', CODEX_HOME: '' }, 'linux', '/home/ada');
  assert.equal(blank.claude, '/home/ada/.claude');
  assert.equal(blank.codex, '/home/ada/.codex');
});

test('resolveRoots prefers roots from settings', () => {
  const settings = {
    sources: {
      claude: { enabled: true, root: '/data/claude' },
      claudeDesktop: { enabled: true, root: '/data/desktop' },
      codex: { enabled: false, root: 'relative/codex' },
      mailbox: { enabled: true, root: '/data/mailbox' },
    },
  };
  const env = { CLAUDE_CONFIG_DIR: '/opt/claude', CODEX_HOME: '/opt/codex' };
  assert.deepEqual(resolveRoots(settings, env, 'linux', '/home/ada'), {
    claude: '/data/claude',
    claudeDesktop: '/data/desktop',
    codex: '/opt/codex',
    mailbox: '/data/mailbox',
  });
  assert.deepEqual(resolveRoots(null, {}, 'linux', '/home/ada').mailbox, null);
});

test('saveSettings writes atomically and loadSettings reads it back', (t) => {
  const dir = path.join(tempDir(t), 'nested', 'pleni');
  const file = path.join(dir, 'settings.json');
  const wanted = cleanSettings({
    port: 9000,
    displayName: 'Ada',
    titles: 'company',
    people: { you: { label: 'Ada' } },
    remote: { hosts: ['box.example.ts.net'], tailscaleUsers: ['ada@example.com'] },
  });

  const saved = saveSettings({ ...wanted, extra: 'dropped', port: 80 }, file);
  assert.equal(saved.port, 1024);
  assert.deepEqual(fs.readdirSync(dir), ['settings.json']);
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(text.endsWith('}\n'));
  assert.equal(text.includes('extra'), false);

  saveSettings(wanted, file);
  assert.deepEqual(fs.readdirSync(dir), ['settings.json']);
  assert.deepEqual(loadSettings(file), { settings: wanted, file, error: null });
});

test('loadSettings gives defaults and no error when the file is missing', (t) => {
  const file = path.join(tempDir(t), 'settings.json');
  assert.deepEqual(loadSettings(file), { settings: DEFAULTS, file, error: null });
});

test('loadSettings tolerates a byte order mark', (t) => {
  const file = path.join(tempDir(t), 'settings.json');
  fs.writeFileSync(file, '\ufeff{"port":9001,"titles":"military"}');
  const { settings, error } = loadSettings(file);
  assert.equal(error, null);
  assert.equal(settings.port, 9001);
  assert.equal(settings.titles, 'military');
});

test('loadSettings gives defaults and an error for a broken file', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'settings.json');

  fs.writeFileSync(file, '{"port": 9001, "secret-looking-text"');
  const broken = loadSettings(file);
  assert.deepEqual(broken.settings, DEFAULTS);
  assert.equal(broken.file, file);
  assert.equal(typeof broken.error, 'string');
  assert.equal(broken.error.includes('secret-looking-text'), false);

  fs.writeFileSync(file, '[1, 2, 3]');
  const notObject = loadSettings(file);
  assert.deepEqual(notObject.settings, DEFAULTS);
  assert.equal(typeof notObject.error, 'string');

  const folder = loadSettings(dir);
  assert.deepEqual(folder.settings, DEFAULTS);
  assert.equal(typeof folder.error, 'string');
});

test('cleanSettings cleans chain rules', () => {
  const rules = [
    { match: '  Sergeant  ', reportsTo: ' Colonel ', role: 'coordinator' },
    { match: 'Colonel', reportsTo: 'me', role: 'hidden' },
    { match: 'Lead', reportsTo: '', role: 'boss' },
    { match: '', reportsTo: 'x' },
    'junk',
    { match: 'x'.repeat(200), reportsTo: 'y'.repeat(200) },
  ];
  assert.deepEqual(cleanSettings({ chain: rules }).chain, [
    { match: 'Sergeant', reportsTo: 'Colonel', role: 'coordinator' },
    { match: 'Colonel', reportsTo: 'you', role: null },
    { match: 'Lead', reportsTo: 'you', role: null },
    { match: 'x'.repeat(80), reportsTo: 'y'.repeat(80), role: null },
  ]);
  assert.equal(cleanSettings({ chain: Array.from({ length: 80 }, (_, i) => ({ match: `m${i}`, reportsTo: 'you' })) }).chain.length, 50);
  assert.deepEqual(cleanSettings({ chain: 'nope' }).chain, []);
});

test('node keys include the relay and mailbox worker runs, and people keep a valid reportsTo', () => {
  for (const key of ['relay', 'mailbox:T-20261013-02-business/W1', 'mailbox:T-1/W12']) assert.equal(isNodeKey(key), true, key);
  for (const key of ['relay2', 'mailbox:T-1', 'mailbox:T-1/X1', 'mailbox:/W1', 'mailbox:T 1/W1']) assert.equal(isNodeKey(key), false, key);
  const k = `claude:${UUID}`;
  const people = cleanSettings({ people: {
    [k]: { reportsTo: 'relay' },
    relay: { reportsTo: `codex:${UUID}`, label: 'Pleni relay' },
    'mailbox:T-1/W1': { reportsTo: 'you' },
    [`codex:${UUID}`]: { reportsTo: `codex:${UUID}` },
    [`codex:${UUID}/a1`]: { reportsTo: 'project:alpha' },
  } }).people;
  assert.deepEqual(people[k], { reportsTo: 'relay' });
  assert.deepEqual(people.relay, { label: 'Pleni relay', reportsTo: `codex:${UUID}` });
  assert.deepEqual(people['mailbox:T-1/W1'], { reportsTo: 'you' });
  assert.equal(people[`codex:${UUID}`], undefined, 'not itself');
  assert.equal(people[`codex:${UUID}/a1`], undefined, 'not a project');
});
