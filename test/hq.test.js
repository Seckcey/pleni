// HQ: one mailbox folder that lists project mailboxes, each with its own relay and coordinator.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cleanSettings } from '../src/config.js';
import { buildSnapshot } from '../src/model.js';
import { createStore } from '../src/store.js';
import { createMailboxSource, createMailboxesSource, readHqProjects } from '../src/sources/mailbox.js';

const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);
const MIN = 60000;
const HOUR = 60 * MIN;
const OLD = new Date(2020, 0, 1, 12, 0).getTime();

const ORCH = 'codex:bbbbbbbb-0000-4000-8000-0000000000aa';
const OTHER_PLANNER = 'codex:bbbbbbbb-0000-4000-8000-0000000000bb';
const HQ_LEAD = 'claude:aaaaaaaa-0000-4000-8000-0000000000a1';
const NOTES_LEAD = 'claude:aaaaaaaa-0000-4000-8000-0000000000b1';
const SHOP_LEAD = 'claude:aaaaaaaa-0000-4000-8000-0000000000c1';
const NOTES_WORKER = 'claude:aaaaaaaa-0000-4000-8000-0000000000b2';
const LOOSE = 'claude:cccccccc-0000-4000-8000-000000000001';
const THREAD = ORCH.slice('codex:'.length);

function tempDir(t, prefix = 'pleni-hq-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Writes a fixture file and backdates it, so time stamps inside the files decide the times.
function write(root, rel, text, mtime = OLD) {
  const file = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  fs.utimesSync(file, new Date(mtime), new Date(mtime));
  return file;
}

function json(value) {
  return JSON.stringify(value, null, 2);
}

// A small mailbox: a task with a blocking question, a worker run and a relay that names its coordinator.
function writeMailbox(root, { task = 'T-1', title = 'Split the service', coordinator = null } = {}) {
  write(root, 'CODEX-QUEUE.md', '# Queue\n\n## 2026-10-12 09:00 — Assigned T-1\n');
  write(root, `tasks/${task}/assignment.md`, `# ${title}\n`);
  write(root, `tasks/${task}/status.md`, '**Current state:** IN_PROGRESS\n');
  write(root, `tasks/${task}/questions.md`, '## Q1 — 2026-10-12 09:40 — BLOCKING\n');
  write(root, `tasks/${task}/workers/W1.run.json`, json({ state: 'running', started_at: '2026-10-12T16:00:00Z' }));
  if (coordinator) write(root, '.relay/coordinator.json', json({ session_id: coordinator.slice('claude:'.length) }));
}

// An HQ in a temp folder with the projects given, written into its bin/relay-settings.json.
function writeHq(t, projects, extra = {}) {
  const dir = tempDir(t);
  const hq = path.join(dir, 'hq');
  writeMailbox(hq, { task: 'T-0', title: 'Pick the projects' });
  write(hq, 'bin/relay-settings.json', json({ role: 'hq', owner_name: 'Ada', projects: projects(dir, hq), ...extra }));
  return { dir, hq };
}

// ---- finding the project mailboxes ----

test('readHqProjects reads an HQ list and gives null for a lone mailbox', (t) => {
  const dir = tempDir(t);
  assert.equal(readHqProjects(dir), null, 'no settings file');
  write(dir, 'bin/relay-settings.json', json({ owner_name: 'Ada' }));
  assert.equal(readHqProjects(dir), null, 'no role');
  write(dir, 'bin/relay-settings.json', json({ role: 'project', projects: [] }));
  assert.equal(readHqProjects(dir), null, 'another role');
  write(dir, 'bin/relay-settings.json', '{ not json');
  assert.equal(readHqProjects(dir), null, 'a broken file');
  for (const bad of [null, '', 42]) assert.equal(readHqProjects(bad), null);

  // The relay reads its role without minding case, and so does Pleni.
  write(dir, 'bin/relay-settings.json', `\uFEFF${json({ role: ' HQ ', projects: [{ id: 'notes', name: ' Notes\u0007app ', mailbox: path.join(dir, 'notes') }] })}`);
  assert.deepEqual(readHqProjects(dir), { projects: [{ id: 'notes', name: 'Notes app', root: path.join(dir, 'notes') }], skipped: [] });
  write(dir, 'bin/relay-settings.json', json({ role: 'hq' }));
  assert.deepEqual(readHqProjects(dir), { projects: [], skipped: [] }, 'an HQ with no projects yet');
});

test('bad project entries are skipped, each with a plain reason, and the good ones kept', (t) => {
  const { dir, hq } = writeHq(t, (base, root) => [
    { id: 'notes', name: 'Notes', mailbox: path.join(base, 'notes') },
    // The relay's -NewProject makes projects in HQ's own projects folder, so that one is fine.
    { id: 'shop', name: 'Shop', mailbox: path.join(root, 'projects', 'shop') },
    { id: 'inbox', name: 'Inside HQ', mailbox: path.join(root, 'tasks', 'T-9') },
    { id: 'state', name: 'Inside HQ', mailbox: path.join(root, '.relay') },
    { id: 'rel', name: 'Relative', mailbox: path.join('projects', 'rel') },
    { id: 'notes', name: 'Same id', mailbox: path.join(base, 'other') },
    { id: 'hq', name: 'HQ again', mailbox: path.join(base, 'hq-two') },
    { id: 'self', name: 'Itself', mailbox: `${root}${path.sep}` },
    { id: 'above', name: 'Above HQ', mailbox: base },
    { id: 'twice', name: 'Same folder', mailbox: path.join(base, 'notes', '.') },
    { id: 'Bad_Id', name: 'Bad id', mailbox: path.join(base, 'bad') },
    { id: 'quote', name: 'A quote', mailbox: path.join(base, 'a"b') },
    { id: 'empty', name: 'No folder', mailbox: '  ' },
    'not an entry',
    { id: 'gone', name: '', mailbox: path.join(base, 'gone') },
  ]);
  const got = readHqProjects(hq);
  assert.deepEqual(got.projects, [
    { id: 'notes', name: 'Notes', root: path.join(dir, 'notes') },
    { id: 'shop', name: 'Shop', root: path.join(hq, 'projects', 'shop') },
    // A folder that is not there yet is kept: it shows as that project's error.
    { id: 'gone', name: 'gone', root: path.join(dir, 'gone') },
  ]);
  assert.deepEqual(got.skipped, [
    { entry: 3, id: 'inbox', why: "its mailbox is inside HQ's tasks folder" },
    { entry: 4, id: 'state', why: "its mailbox is inside HQ's .relay folder" },
    { entry: 5, id: 'rel', why: 'its mailbox is not a full path' },
    { entry: 6, id: 'notes', why: 'another entry has the same id' },
    { entry: 7, id: 'hq', why: 'its id may not be hq, the name HQ keeps for itself' },
    { entry: 8, id: 'self', why: 'its mailbox is HQ itself' },
    { entry: 9, id: 'above', why: 'its mailbox holds HQ' },
    { entry: 10, id: 'twice', why: 'another entry has the same mailbox' },
    { entry: 11, id: null, why: 'its id must be 1 to 40 small letters, digits or hyphens, starting with a letter or a digit' },
    { entry: 12, id: 'quote', why: 'its mailbox holds a quote, a control character or a mark that Windows treats specially' },
    { entry: 13, id: 'empty', why: 'its mailbox is empty' },
    { entry: 14, id: null, why: 'it is not an object with id, name and mailbox' },
  ]);
});

test('Windows project paths are checked the way the relay checks them, without minding case', () => {
  const relaySettings = {
    role: 'hq',
    projects: [
      { id: 'notes', name: 'Notes', mailbox: 'C:\\Users\\ada\\mailboxes\\notes' },
      { id: 'shop', name: 'Shop', mailbox: 'C:\\Users\\ada\\hq\\projects\\shop\\' },
      { id: 'share', name: 'Share', mailbox: '\\\\server\\share\\box' },
      { id: 'inbox', name: 'x', mailbox: 'c:\\users\\ADA\\HQ\\Tasks\\T-1' },
      { id: 'same', name: 'x', mailbox: 'c:\\users\\ada\\MAILBOXES\\notes' },
      { id: 'self', name: 'x', mailbox: 'C:\\Users\\ada\\HQ' },
      { id: 'slash', name: 'x', mailbox: 'C:/Users/ada/slash' },
      { id: 'rooted', name: 'x', mailbox: '\\Users\\ada\\rooted' },
    ],
  };
  const got = readHqProjects('C:\\Users\\ada\\hq', { platform: 'win32', relaySettings });
  assert.deepEqual(got.projects.map((p) => [p.id, p.root]), [
    ['notes', 'C:\\Users\\ada\\mailboxes\\notes'],
    ['shop', 'C:\\Users\\ada\\hq\\projects\\shop'],
    ['share', '\\\\server\\share\\box'],
  ]);
  assert.deepEqual(got.skipped.map((s) => [s.id, s.why]), [
    ['inbox', "its mailbox is inside HQ's tasks folder"],
    ['same', 'another entry has the same mailbox'],
    ['self', 'its mailbox is HQ itself'],
    ['slash', 'its mailbox is not a full path'],
    ['rooted', 'its mailbox is not a full path'],
  ]);
});

test('Pleni reads at most 20 project mailboxes', (t) => {
  const { hq } = writeHq(t, (base) => Array.from({ length: 23 }, (_, i) => ({ id: `p${i}`, name: `P${i}`, mailbox: path.join(base, `p${i}`) })));
  const got = readHqProjects(hq);
  assert.equal(got.projects.length, 20);
  assert.deepEqual(got.skipped.map((s) => [s.entry, s.why]), [21, 22, 23].map((entry) => [entry, 'Pleni shows at most 20 projects']));
});

test('an HQ is read with its project mailboxes, and a missing one is that project\'s error only', (t) => {
  const { dir, hq } = writeHq(t, (base) => [
    { id: 'notes', name: 'Notes', mailbox: path.join(base, 'notes') },
    { id: 'shop', name: 'Shop', mailbox: path.join(base, 'shop') },
  ]);
  writeMailbox(path.join(dir, 'notes'), { coordinator: NOTES_LEAD });
  write(hq, '.relay/codex.json', json({ thread_id: THREAD.toUpperCase(), follow_name: 'Orchestrator' }));
  const at = Date.UTC(2026, 9, 18, 15, 40, 0) / 1000;
  write(hq, '.relay/state.json', json({
    codex_dispatches: {
      C1: { id: 'C1', target: 'codex', state: 'completed', items: ['notes:T-1/Q1', 'T-0/Q1'], started_utc: at, finished_utc: at + 60, thread_id: THREAD },
      C2: { id: 'C2', target: 'codex', state: 'running', items: ['shop:T-1/Q1'], started_utc: at + 120, finished_utc: 0, thread_id: THREAD },
      C3: { id: 'C3', target: 'codex', state: 'failed', items: ['x'], started_utc: at + 30, finished_utc: at + 31, thread_id: THREAD },
      C4: { id: 'C4', target: 'codex', state: 'abandoned', items: [], started_utc: at + 40, thread_id: THREAD },
    },
    mail_dispatches: { M1: { id: 'M1', agent: 'sergeant-ada', name: 'Sergeant Ada', state: 'completed', items: ['a'], started_utc: at + 10, finished_utc: at + 20 } },
  }));

  const state = createMailboxesSource({ root: hq }).poll();
  assert.equal(state.ok, true);
  assert.deepEqual(state.tasks.map((task) => task.id), ['T-0']);
  // HQ's orchestrator is the Codex thread its relay wakes as the planner.
  assert.equal(state.relay.plannerKey, ORCH);
  assert.deepEqual(state.relay.wakes, [
    { key: null, name: null, at: (at + 120) * 1000, endAt: null, running: true, count: 1, planner: true, threadId: THREAD },
    { key: 'sergeant-ada', name: 'Sergeant Ada', at: (at + 10) * 1000, endAt: (at + 20) * 1000, running: false, count: 1 },
    { key: null, name: null, at: at * 1000, endAt: (at + 60) * 1000, running: false, count: 2, planner: true, threadId: THREAD },
  ], 'a wake that never reached the thread is left out');
  assert.deepEqual(state.hq.skipped, []);
  const [notes, shop] = state.hq.projects;
  assert.deepEqual([notes.id, notes.name, shop.id, shop.name], ['notes', 'Notes', 'shop', 'Shop']);
  assert.equal(notes.mailbox.ok, true);
  assert.deepEqual(notes.mailbox.tasks.map((task) => [task.id, task.title, task.attention]), [['T-1', 'Split the service', ['question']]]);
  assert.equal(notes.mailbox.relay.coordinatorKey, NOTES_LEAD);
  assert.equal(Object.hasOwn(notes.mailbox.relay, 'plannerKey'), false, 'only HQ names an orchestrator');
  assert.deepEqual(shop.mailbox, { ...shop.mailbox, ok: false, error: 'Pleni could not find the mailbox folder.', tasks: [], relay: null });

  // The project is found once its folder is made.
  writeMailbox(path.join(dir, 'shop'), { task: 'T-7', coordinator: SHOP_LEAD });
  const source = createMailboxesSource({ root: hq });
  assert.deepEqual(source.poll().hq.projects.map((p) => [p.id, p.mailbox.ok, p.mailbox.tasks.map((task) => task.id)]), [['notes', true, ['T-1']], ['shop', true, ['T-7']]]);

  // HQ's list is read again when it changes.
  write(hq, 'bin/relay-settings.json', json({ role: 'hq', projects: [{ id: 'shop', name: 'Shop', mailbox: path.join(dir, 'shop') }] }), OLD + 5000);
  assert.deepEqual(source.poll().hq.projects.map((p) => p.id), ['shop']);
  write(hq, 'bin/relay-settings.json', json({ owner_name: 'Ada' }), OLD + 9000);
  const lone = source.poll();
  assert.equal(lone.hq, null, 'no longer an HQ');
  assert.equal(Object.hasOwn(lone.relay, 'plannerKey'), false);
  assert.deepEqual(lone.relay.wakes.map((w) => w.key), ['sergeant-ada'], 'a lone mailbox lists only its mail wakes');
});

test('a lone mailbox reads exactly as it always did', (t) => {
  const root = tempDir(t);
  writeMailbox(root, { coordinator: NOTES_LEAD });
  write(root, 'bin/relay-settings.json', json({ owner_name: 'Ada' }));
  write(root, '.relay/codex.json', json({ thread_id: THREAD }));
  const now = () => NOW;
  const wrapped = createMailboxesSource({ root, now }).poll();
  assert.deepEqual(wrapped, { ...createMailboxSource({ root, now }).poll(), hq: null });
  assert.equal(Object.hasOwn(wrapped.relay, 'plannerKey'), false, 'Pleni reads codex.json only in an HQ');
});

test('the Mail page gets every mailbox\'s mail in an HQ, each message with its mailbox', (t) => {
  const { dir, hq } = writeHq(t, (base) => [{ id: 'notes', name: 'Notes', mailbox: path.join(base, 'notes') }]);
  writeMailbox(path.join(dir, 'notes'));
  write(hq, 'mail/ada/new/20261018-154000-000-sergeant-ada-0a1b2c.md', 'From: Sergeant Ada\nTo: Ada\n\nFrom HQ.');
  write(path.join(dir, 'notes'), 'mail/ada/new/20261018-155000-000-sergeant-bo-0a1b2d.md', 'From: Sergeant Bo\nTo: Ada\n\nFrom Notes.');
  const source = createMailboxesSource({ root: hq });
  source.poll();
  const messages = source.mail({ keys: ['ada'] });
  assert.deepEqual(messages.map((m) => [m.id, m.box, m.boxName, m.fromName, m.text]), [
    ['notes:ada/new/20261018-155000-000-sergeant-bo-0a1b2d.md', 'notes', 'Notes', 'Sergeant Bo', 'From Notes.'],
    ['ada/new/20261018-154000-000-sergeant-ada-0a1b2c.md', 'hq', 'HQ', 'Sergeant Ada', 'From HQ.'],
  ]);
  const lone = createMailboxesSource({ root: path.join(dir, 'notes') });
  lone.poll();
  assert.equal(lone.mail({ keys: ['ada'] })[0].box, undefined, 'a lone mailbox\'s messages keep their shape');
});

// ---- the map ----

function session(key, extra = {}) {
  return {
    platform: key.slice(0, key.indexOf(':')),
    key,
    id: key.slice(key.indexOf(':') + 1),
    parentKey: null,
    kind: 'session',
    title: null,
    cwd: '/home/ada/code/alpha',
    branch: 'main',
    entrypoint: 'cli',
    model: 'claude-opus-5-5',
    effort: null,
    startedAt: NOW - 30 * MIN,
    lastAt: NOW - MIN,
    status: 'working',
    activity: null,
    lastText: null,
    links: [],
    archived: false,
    ...extra,
  };
}

function cast() {
  return {
    codex: [session(ORCH, { title: 'Orchestrator', cwd: '/home/ada/hq', model: 'gpt-6.1-astra' }), session(OTHER_PLANNER, { title: 'Old plan', model: 'gpt-6.1-sol' })],
    claude: [
      session(HQ_LEAD, { title: 'HQ coordinator', cwd: '/home/ada/hq' }),
      session(NOTES_LEAD, { title: 'Notes coordinator', cwd: '/home/ada/hq/projects/notes' }),
      session(SHOP_LEAD, { title: 'Shop coordinator', cwd: '/home/ada/hq/projects/shop' }),
      session(NOTES_WORKER, { title: 'Index builder', cwd: '/home/ada/code/notes-app/.claude/worktrees/t-1' }),
      session(LOOSE, { title: 'Notes app polish', cwd: '/home/ada/code/notes-app' }),
    ],
  };
}

// A mailbox as the source reports it: one task with a worker run, events and a running relay.
function mailbox({ coordinator = null, relay = {}, task = 'T-1', name = 'mailbox', ...extra } = {}) {
  return {
    ok: true, error: null, root: `/home/ada/${name}`, name,
    tasks: [{ id: task, title: 'Split the service', state: 'IN_PROGRESS', updatedAt: NOW - 2 * MIN, attention: ['question'], workers: [{ id: 'W1', state: 'running', startedAt: NOW - 2 * MIN, finishedAt: null }] }],
    events: [
      { at: NOW - MIN, dir: 'up', taskId: task, file: 'questions.md', title: 'Q1 Which format?' },
      { at: NOW - 10 * MIN, dir: 'down', taskId: task, file: 'assignment.md', title: 'Split the service' },
    ],
    notes: [],
    relay: { running: true, paused: false, halted: false, coordinatorKey: coordinator, lastAt: NOW - 5000, pausedAt: null, haltReason: null, alerts: null, wakes: [], ...relay },
    mail: null,
    ...extra,
  };
}

// An HQ with the projects Notes and Shop. HQ's relay names the orchestrator (from .relay/codex.json).
function hqState({ plannerKey = ORCH, relay = {}, projects = null, ...extra } = {}) {
  return {
    ...mailbox({ name: 'hq', task: 'T-0', coordinator: HQ_LEAD, relay: { plannerKey, ...relay }, ...extra }),
    hq: {
      projects: projects ?? [
        { id: 'notes', name: 'Notes', mailbox: mailbox({ name: 'notes', coordinator: NOTES_LEAD }) },
        { id: 'shop', name: 'Shop', mailbox: mailbox({ name: 'shop', task: 'T-7', coordinator: SHOP_LEAD }) },
      ],
      skipped: [],
    },
  };
}

function snap({ settings = {}, mailbox: box = hqState(), sessions = cast(), now = NOW, dismissed = null } = {}) {
  return buildSnapshot({
    now,
    settings: cleanSettings(settings),
    claude: { ok: true, error: null, root: '/home/ada/.claude', sessions: sessions.claude },
    codex: { ok: true, error: null, root: '/home/ada/.codex', sessions: sessions.codex },
    mailbox: box,
    dismissed,
  });
}

function node(s, key) {
  return s.nodes.find((n) => n.key === key);
}

// The keys above a tile, nearest first, up to the person.
function above(s, key) {
  const out = [];
  for (let n = node(s, key); n && n.parent && out.length < 20; n = node(s, n.parent)) out.push(n.parent);
  return out;
}

function kids(s, key) {
  return s.nodes.filter((n) => n.parent === key).map((n) => n.key);
}

test('the HQ tree: you, the orchestrator, HQ\'s relay and a tile per project with its relay, coordinator and workers', () => {
  const s = snap();
  assert.equal(node(s, ORCH).parent, 'you');
  // Tiles sort by title: "HQ relay", "Notes", "Shop".
  assert.deepEqual(kids(s, ORCH), ['relay', 'project:Notes', 'project:Shop']);
  // HQ's own coordinator keeps its place under HQ's relay, and HQ keeps the old keys.
  assert.deepEqual(kids(s, 'relay'), [HQ_LEAD]);
  assert.deepEqual(kids(s, HQ_LEAD), ['mailbox:T-0/W1']);
  for (const [id, lead] of [['notes', NOTES_LEAD], ['shop', SHOP_LEAD]]) {
    const tile = `project:${id === 'notes' ? 'Notes' : 'Shop'}`;
    assert.deepEqual(kids(s, tile), [`relay:${id}`]);
    assert.deepEqual(kids(s, `relay:${id}`), [lead]);
    assert.deepEqual(above(s, lead), [`relay:${id}`, tile, ORCH, 'you']);
  }
  assert.deepEqual(kids(s, NOTES_LEAD), ['mailbox:notes:T-1/W1']);
  assert.deepEqual(kids(s, SHOP_LEAD), ['mailbox:shop:T-7/W1']);
  const relay = node(s, 'relay:notes');
  assert.deepEqual([relay.kind, relay.platform, relay.title, relay.rank, relay.subtitle, relay.status], ['relay', 'relay', 'Notes relay', 'Relay', 'notes', 'working']);
  assert.equal(node(s, 'relay').title, 'HQ relay');
  assert.deepEqual([node(s, 'project:Notes').kind, node(s, 'project:Notes').subtitle], ['project', '2 sessions']);
  // Sessions that are not part of a mailbox stay where they always were.
  assert.equal(node(s, LOOSE).parent, 'you');
  assert.equal(node(s, OTHER_PLANNER).parent, 'you');
  // The mailbox of every project runs from the orchestrator through its tile and relay.
  const legs = s.edges.filter((e) => e.kind === 'mailbox').map((e) => [e.from, e.to]);
  assert.deepEqual(legs, [
    [ORCH, 'relay'], ['relay', HQ_LEAD],
    [ORCH, 'project:Notes'], ['project:Notes', 'relay:notes'], ['relay:notes', NOTES_LEAD],
    [ORCH, 'project:Shop'], ['project:Shop', 'relay:shop'], ['relay:shop', SHOP_LEAD],
  ]);
  const notesLine = s.edges.find((e) => e.from === 'relay:notes');
  assert.deepEqual([notesLine.lastDown, notesLine.lastUp, notesLine.upLabel, notesLine.active], [NOW - 10 * MIN, NOW - MIN, 'T-1: Q1 Which format?', 'up']);
  assert.equal(s.edges.find((e) => e.from === ORCH && e.to === 'project:Notes').active, 'up', 'the whole way to the orchestrator');
  const mail = s.events.filter((e) => e.kind === 'mailbox' && e.to === ORCH).map((e) => e.from);
  assert.deepEqual(new Set(mail), new Set([HQ_LEAD, NOTES_LEAD, SHOP_LEAD]), 'each coordinator writes back to the orchestrator');
});

test('the snapshot lists HQ and its project mailboxes, never a folder', () => {
  const s = snap();
  assert.deepEqual(s.boxes, [
    { id: 'hq', name: 'HQ', root: null, error: null, project: null },
    { id: 'notes', name: 'Notes', root: null, error: null, project: 'Notes' },
    { id: 'shop', name: 'Shop', root: null, error: null, project: 'Shop' },
  ]);
  assert.deepEqual(s.tasks.map((task) => [task.box, task.boxName, task.id]), [['hq', 'HQ', 'T-0'], ['notes', 'Notes', 'T-1'], ['shop', 'Shop', 'T-7']]);
  assert.equal(JSON.stringify(s).includes('/home/ada/hq'), false);
  assert.equal(JSON.stringify(s).includes('/home/ada/notes'), false);
  assert.deepEqual(s.sources.mailbox, { enabled: true, ok: true, error: null, count: 3 });
  // A lone mailbox has no boxes, and its tasks say no mailbox.
  const lone = snap({ mailbox: mailbox({ coordinator: NOTES_LEAD }) });
  assert.equal(Object.hasOwn(lone, 'boxes'), false);
  assert.deepEqual(lone.tasks.map((task) => [task.box, task.boxName]), [[null, null]]);
});

test('a lone mailbox keeps its keys and tree', () => {
  const s = snap({ mailbox: mailbox({ coordinator: NOTES_LEAD }), settings: { sources: { mailbox: { enabled: true, planner: ORCH } } } });
  assert.equal(node(s, 'relay').parent, ORCH);
  assert.equal(node(s, 'relay').title, 'Relay');
  assert.equal(node(s, NOTES_LEAD).parent, 'relay');
  assert.equal(node(s, 'mailbox:T-1/W1').parent, NOTES_LEAD);
  assert.equal(s.nodes.some((n) => n.kind === 'project'), false);
  assert.deepEqual(s.attention.filter((a) => a.kind === 'question').map((a) => [a.key, a.text]), [['task:T-1', 'Split the service has a question that is holding up work.']]);
});

test('the orchestrator comes from HQ\'s relay, else from Settings', () => {
  const settings = { sources: { mailbox: { enabled: true, planner: OTHER_PLANNER } } };
  // The thread HQ's relay wakes wins over the planner in Settings.
  assert.deepEqual(kids(snap({ settings }), ORCH), ['relay', 'project:Notes', 'project:Shop']);
  // Without .relay/codex.json, the planner in Settings is the orchestrator, by key or by name.
  const fallback = snap({ settings, mailbox: hqState({ plannerKey: null }) });
  assert.deepEqual(kids(fallback, OTHER_PLANNER), ['relay', 'project:Notes', 'project:Shop']);
  assert.equal(node(fallback, ORCH).parent, 'you');
  const byName = snap({ settings: { sources: { mailbox: { enabled: true, planner: 'old plan' } } }, mailbox: hqState({ plannerKey: null }) });
  assert.equal(node(byName, 'relay').parent, OTHER_PLANNER);
  // An orchestrator that is not on the map leaves HQ's relay and the project tiles under you.
  const gone = snap({ mailbox: hqState({ plannerKey: 'codex:bbbbbbbb-0000-4000-8000-0000000000ff' }) });
  assert.deepEqual(['relay', 'project:Notes', 'project:Shop'].map((key) => node(gone, key).parent), ['you', 'you', 'you']);
  assert.equal(node(gone, 'relay:notes').parent, 'project:Notes');
});

test('a project mailbox links to a Projects page project by name, then by slug, else gets a tile of its own', () => {
  const projectList = [
    { id: 'proj00000001', name: 'notes', folder: '/home/ada/code/notes-app', repo: null },
    { id: 'proj00000002', name: 'Shop Front', folder: '/home/ada/code/shop', repo: null },
  ];
  const projects = [
    { id: 'notes', name: 'Notes', mailbox: mailbox({ name: 'notes', coordinator: NOTES_LEAD }) },
    { id: 'shop-front', name: 'Store', mailbox: mailbox({ name: 'shop', task: 'T-7', coordinator: SHOP_LEAD }) },
    { id: 'blog', name: 'Blog', mailbox: mailbox({ name: 'blog', task: 'T-9' }) },
  ];
  const s = snap({ settings: { projectList }, mailbox: hqState({ projects }) });
  assert.deepEqual(s.boxes.map((b) => [b.id, b.project]), [['hq', null], ['notes', 'notes'], ['shop-front', 'Shop Front'], ['blog', 'Blog']]);
  assert.deepEqual(kids(s, ORCH), ['project:Blog', 'relay', 'project:notes', 'project:Shop Front']);
  assert.equal(node(s, 'relay:shop-front').parent, 'project:Shop Front');
  // A label for the project's name renames its tile, as for any project tile.
  const renamed = snap({ settings: { projectList, projects: { 'Shop Front': { label: 'The shop' } } }, mailbox: hqState({ projects }) });
  assert.equal(node(renamed, 'project:Shop Front').title, 'The shop');
});

test('grouped by project, a linked project\'s tile holds its other sessions too, and a folder tile holds the orchestrator', () => {
  const projectList = [{ id: 'proj00000001', name: 'Notes', folder: '/home/ada/code/notes-app', repo: null }];
  const s = snap({ settings: { groupBy: 'project', projectList } });
  assert.deepEqual(above(s, ORCH), ['project:hq', 'you']);
  assert.equal(node(s, LOOSE).parent, 'project:Notes', 'a session in the linked project\'s folder');
  assert.equal(node(s, 'relay:notes').parent, 'project:Notes');
  assert.equal(node(s, 'project:Notes').parent, ORCH);
  assert.deepEqual(above(s, NOTES_LEAD), ['relay:notes', 'project:Notes', ORCH, 'project:hq', 'you']);
  assert.equal(s.nodes.filter((n) => n.key === 'project:Notes').length, 1, 'one tile, not two');
  // Without a link, a folder whose name is the project's is that same tile.
  const named = snap({ settings: { groupBy: 'project' }, sessions: { ...cast(), claude: [...cast().claude.filter((x) => x.key !== LOOSE), session(LOOSE, { title: 'Notes polish', cwd: '/home/ada/code/Notes' })] } });
  assert.equal(node(named, LOOSE).parent, 'project:Notes');
});

test('with AI tool tiles, the orchestrator hangs under Codex and the project tiles under it', () => {
  const s = snap({ settings: { toolTiles: true } });
  assert.deepEqual(above(s, ORCH), ['tool:codex', 'you']);
  assert.deepEqual(kids(s, ORCH), ['relay', 'project:Notes', 'project:Shop']);
  assert.deepEqual(above(s, NOTES_LEAD), ['relay:notes', 'project:Notes', ORCH, 'tool:codex', 'you']);
  assert.equal(node(s, LOOSE).parent, 'tool:claude');
});

test('a project mailbox that cannot be read is its own error, and the others go on', () => {
  const gone = { ok: false, error: 'Pleni could not find the mailbox folder.', root: '/home/ada/gone', name: 'gone', tasks: [], events: [], notes: [], relay: null, mail: null };
  const projects = [
    { id: 'notes', name: 'Notes', mailbox: mailbox({ name: 'notes', coordinator: NOTES_LEAD }) },
    { id: 'gone', name: 'Gone', mailbox: gone },
    { id: 'odd', name: 'Odd', mailbox: 'junk' },
  ];
  const s = snap({ mailbox: hqState({ projects }) });
  assert.deepEqual(s.boxes.map((b) => [b.id, b.error]), [['hq', null], ['notes', null], ['gone', 'Pleni could not find the mailbox folder.'], ['odd', 'Pleni could not read this mailbox just now.']]);
  assert.equal(node(s, 'project:Gone').parent, ORCH, 'its tile still shows');
  assert.equal(node(s, 'relay:gone'), undefined);
  assert.deepEqual(kids(s, 'relay:notes'), [NOTES_LEAD]);
  assert.equal(s.sources.mailbox.ok, true);
  // Bad entries never make a tile: a bad id, HQ's own id, a repeated id.
  const bad = snap({ mailbox: hqState({ projects: [...projects, { id: 'hq', name: 'X', mailbox: mailbox() }, { id: 'Bad', name: 'Y', mailbox: mailbox() }, { id: 'notes', name: 'Z', mailbox: mailbox() }] }) });
  assert.deepEqual(bad.boxes.map((b) => b.id), ['hq', 'notes', 'gone', 'odd']);
});

test('notices name the mailbox they come from', () => {
  const alerts = { count: 1, at: NOW - 4 * MIN, text: 'Coordinator turn R1 ended with an error.' };
  const projects = [
    { id: 'notes', name: 'Notes', mailbox: mailbox({ name: 'notes', coordinator: NOTES_LEAD, relay: { paused: true, pausedAt: NOW - 3 * MIN, alerts } }) },
    { id: 'shop', name: 'Shop', mailbox: mailbox({ name: 'shop', task: 'T-7', relay: { halted: true, haltReason: '3 failed turns', alerts }, notes: [{ file: 'NEEDS-ADA.md', count: 1, at: NOW - MIN, text: 'Sign in again' }] }) },
  ];
  const s = snap({ mailbox: hqState({ projects, notes: [{ file: 'NEEDS-ADA.md', count: 1, at: NOW - 2 * MIN, text: 'Approve the budget' }] }) });
  const said = Object.fromEntries(s.attention.map((a) => [a.id, a.text]));
  assert.equal(said['relay:notes|alert'], 'The Notes relay wrote an alert: Coordinator turn R1 ended with an error.');
  assert.equal(said['relay:notes|paused'], 'The Notes relay is paused, so it sends nothing. To go on, delete the PAUSE file in its .relay folder.');
  assert.equal(said['relay:shop|halted'], 'The Shop relay stopped sending (3 failed turns). Fix the cause, then run bridge-relay.ps1 -ClearHalt in its mailbox folder.');
  assert.equal(said['task:notes:T-1|question'], 'Split the service (Notes) has a question that is holding up work.');
  assert.equal(said['task:T-0|question'], 'Split the service (HQ) has a question that is holding up work.', 'HQ keeps the old task keys');
  assert.equal(said[`${HQ_LEAD}|note`], 'New note for you in NEEDS-ADA.md (HQ): Approve the budget');
  // Shop's coordinator is not on the map, so its note goes on its relay's tile.
  assert.equal(said['relay:shop|note'], 'New note for you in NEEDS-ADA.md (Shop): Sign in again');
  // A notice can be dismissed by its id, as always.
  const quiet = snap({ mailbox: hqState({ projects }), dismissed: { 'relay:notes|paused': NOW - 3 * MIN } });
  assert.equal(quiet.attention.some((a) => a.id === 'relay:notes|paused'), false);
});

test('a project\'s relay can be watched, and says when it stops', () => {
  const projects = [{ id: 'notes', name: 'Notes', mailbox: mailbox({ name: 'notes', coordinator: NOTES_LEAD, relay: { running: false, lastAt: NOW - 40 * MIN } }) }];
  const people = { 'relay:notes': { watch: true }, relay: { watch: true }, 'mailbox:notes:T-1/W1': { watch: true } };
  const s = snap({ settings: { people }, mailbox: hqState({ projects, relay: { lastAt: NOW - 30 * MIN } }) });
  assert.equal(node(s, 'relay:notes').watched, true);
  assert.equal(node(s, 'mailbox:notes:T-1/W1').watched, false, 'a worker run cannot be watched');
  assert.deepEqual(s.attention.filter((a) => a.kind === 'stopped').map((a) => [a.key, a.text]), [
    ['relay', 'The HQ relay has not run for 15 minutes or more, so nothing wakes the orchestrator.'],
    ['relay:notes', 'The Notes relay has not run for 15 minutes or more, so nothing wakes its coordinator.'],
  ]);
  // It can be moved like HQ's relay: the person's choice wins.
  const moved = snap({ settings: { people: { 'relay:notes': { reportsTo: LOOSE } } } });
  assert.equal(node(moved, 'relay:notes').parent, LOOSE);
  assert.equal(node(moved, 'relay:notes').placement, 'manual');
  assert.equal(node(moved, NOTES_LEAD).parent, 'relay:notes');
});

test('the orchestrator\'s wakes light the line between it and HQ\'s relay', () => {
  const wakes = [
    { key: null, name: null, at: NOW - 30000, endAt: null, running: true, count: 2, planner: true, threadId: THREAD },
    { key: null, name: null, at: NOW - 30 * MIN, endAt: NOW - 29 * MIN, running: false, count: 1, planner: true, threadId: 'bbbbbbbb-0000-4000-8000-0000000000ff' },
  ];
  const s = snap({ mailbox: hqState({ relay: { wakes } }) });
  const line = s.edges.find((e) => e.from === ORCH && e.to === 'relay');
  assert.deepEqual([line.lastUp, line.upLabel, line.active], [NOW - 30000, 'Woke it to check 2 new items', 'up']);
  assert.deepEqual(s.events.filter((e) => e.kind === 'wake').map((e) => [e.from, e.to, e.text, e.toName]), [
    ['relay', ORCH, 'To check 2 new items.', 'the orchestrator'],
    // An older thread that is not on the map: the orchestrator HQ's relay names now.
    ['relay', ORCH, 'To check 1 new item.', 'the orchestrator'],
  ]);
  const away = snap({ mailbox: hqState({ relay: { wakes } }), sessions: { ...cast(), codex: cast().codex.filter((x) => x.key !== ORCH) } });
  assert.deepEqual(away.events.filter((e) => e.kind === 'wake').map((e) => [e.to, e.toName])[0], [null, 'the orchestrator']);
});

test('mail names belong to their own mailbox, and the person\'s mail adds up across them', () => {
  const lead = (key, name, threadId, unread) => ({ key, name, unread, since: unread ? NOW - 5 * MIN : null, wakes: true, threadId });
  const ada = { key: 'ada', name: 'Ada', unread: 1, since: NOW - 4 * MIN, wakes: false, threadId: null };
  const hqMail = {
    owner: 'Ada',
    agents: [ada, lead('planner', 'Planner', THREAD, 1)],
    messages: [{ to: 'ada', from: 'planner', fromName: 'Planner', at: NOW - 4 * MIN, unread: true, text: 'From HQ.' }],
  };
  const notesMail = {
    owner: 'Ada',
    // The same name as in HQ, but this mailbox's planner is another thread.
    agents: [{ ...ada, since: NOW - 2 * MIN }, lead('planner', 'Planner', OTHER_PLANNER.slice('codex:'.length), 0)],
    messages: [{ to: 'ada', from: 'planner', fromName: 'Planner', at: NOW - 2 * MIN, unread: true, text: 'From Notes.' }],
  };
  const projects = [{ id: 'notes', name: 'Notes', mailbox: mailbox({ name: 'notes', coordinator: NOTES_LEAD, mail: notesMail }) }];
  const s = snap({ mailbox: hqState({ projects, mail: hqMail }) });
  assert.deepEqual(node(s, ORCH).mail, { name: 'Planner', unread: 1, since: NOW - 5 * MIN, wakes: true, toYou: 1 });
  assert.deepEqual(node(s, OTHER_PLANNER).mail, { name: 'Planner', unread: 0, since: null, wakes: true, toYou: 1 });
  assert.deepEqual(s.mail, { name: 'Ada', unread: 2, lastAt: NOW - 2 * MIN });
  assert.deepEqual(node(s, 'you').mail, { name: 'Ada', unread: 2, since: NOW - 4 * MIN, wakes: false, toYou: 0 });
  assert.deepEqual(s.attention.filter((a) => a.kind === 'mail').map((a) => [a.key, a.text]), [
    [OTHER_PLANNER, 'Old plan sent you mail: From Notes.'],
    [ORCH, 'Orchestrator sent you mail: From HQ.'],
  ]);
});

test('a coordinator a project\'s relay names is that project\'s, whatever Settings say', () => {
  const s = snap({ settings: { sources: { mailbox: { enabled: true, coordinator: NOTES_LEAD } } } });
  assert.equal(node(s, NOTES_LEAD).parent, 'relay:notes');
  assert.deepEqual(kids(s, 'relay'), ['mailbox:T-0/W1'], 'HQ has no coordinator then, so its worker hangs under its relay');
  // Two project relays that name one coordinator: the first project keeps it.
  const twice = snap({ mailbox: hqState({ projects: [
    { id: 'notes', name: 'Notes', mailbox: mailbox({ name: 'notes', coordinator: NOTES_LEAD }) },
    { id: 'shop', name: 'Shop', mailbox: mailbox({ name: 'shop', task: 'T-7', coordinator: NOTES_LEAD }) },
  ] }) });
  assert.equal(node(twice, NOTES_LEAD).parent, 'relay:notes');
  assert.deepEqual(kids(twice, 'relay:shop'), ['mailbox:shop:T-7/W1'], 'without a coordinator its worker hangs under its relay');
});

test('a person who puts the orchestrator below its own project still gets a whole map', () => {
  const s = snap({ settings: { people: { [ORCH]: { reportsTo: NOTES_LEAD } } } });
  const keys = new Set(s.nodes.map((n) => n.key));
  for (const key of [ORCH, 'project:Notes', 'relay:notes', NOTES_LEAD]) assert.ok(keys.has(key), key);
  for (const n of s.nodes.filter((x) => x.key !== 'you')) assert.ok(above(s, n.key).at(-1) === 'you', `${n.key} reaches you`);
});

// ---- the store, from real folders ----

test('the store reads an HQ folder end to end, and a project relay keeps no session file', (t) => {
  const { dir, hq } = writeHq(t, (base) => [
    { id: 'notes', name: 'Notes', mailbox: path.join(base, 'notes') },
    { id: 'shop', name: 'Shop', mailbox: path.join(base, 'shop') },
  ]);
  writeMailbox(path.join(dir, 'notes'), { coordinator: NOTES_LEAD });
  write(hq, '.relay/codex.json', json({ thread_id: THREAD }));
  const settings = cleanSettings({ sources: { mailbox: { enabled: true, root: hq }, claude: { enabled: false }, codex: { enabled: false }, grok: { enabled: false }, kimi: { enabled: false }, gemini: { enabled: false }, antigravity: { enabled: false } } });
  // Just after the worker run started (2026-10-12 16:00 UTC), so it is recent.
  const store = createStore({ settings, roots: { mailbox: hq }, now: () => Date.UTC(2026, 9, 12, 16, 30) });
  t.after(() => store.close());
  const s = store.snapshot();
  assert.deepEqual(s.boxes.map((b) => [b.id, b.error]), [['hq', null], ['notes', null], ['shop', 'Pleni could not find the mailbox folder.']]);
  assert.deepEqual(s.tasks.map((task) => `${task.box}/${task.id}`), ['hq/T-0', 'notes/T-1']);
  assert.ok(s.nodes.some((n) => n.key === 'relay:notes'));
  assert.ok(s.nodes.some((n) => n.key === 'mailbox:notes:T-1/W1'));
  assert.equal(s.json.includes(dir), false, 'no folder of this computer in the snapshot');
  assert.deepEqual(store.detail('relay:notes', 0), { events: [], next: null });
  assert.deepEqual(store.detail('mailbox:notes:T-1/W1', 0), { events: [], next: null });
  assert.equal(store.detail('relay:hq', 0), null, 'HQ\'s own relay is "relay"');
});
