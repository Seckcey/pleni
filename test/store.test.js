import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cleanSettings } from '../src/config.js';
import { DEMO_KEYS } from '../src/demo.js';
import { POLL_MS, createStore } from '../src/store.js';

const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);
const CLAUDE_KEY = 'claude:aaaaaaaa-0000-4000-8000-000000000001';
const CODEX_KEY = 'codex:bbbbbbbb-0000-4000-8000-000000000001';
const ROOTS = {
  claude: '/home/ada/.claude',
  claudeDesktop: '/home/ada/.config/Claude',
  codex: '/home/ada/.codex',
  mailbox: '/home/ada/mailbox',
};

function clock(start = NOW) {
  let t = start;
  const now = () => t;
  now.set = (value) => {
    t = value;
  };
  return now;
}

function session(key, extra = {}) {
  return {
    platform: key.slice(0, key.indexOf(':')),
    key,
    id: key.slice(key.indexOf(':') + 1),
    parentKey: null,
    kind: 'session',
    title: 'Billing API refactor',
    titleSource: null,
    cwd: '/home/ada/code/alpha',
    branch: 'main',
    entrypoint: 'cli',
    model: 'claude-opus-5-5',
    effort: null,
    startedAt: NOW - 600000,
    lastAt: NOW - 60000,
    status: 'working',
    activity: null,
    lastText: 'Working on it',
    links: [],
    archived: false,
    ...extra,
  };
}

// Fake sources that record how they were made and used.
function fakes() {
  const made = [];
  const behaviour = { throwOnPoll: null, junkPoll: null, throwOnCreate: null, throwOnDetail: false };
  const factory = (name) => (options) => {
    if (behaviour.throwOnCreate === name) throw new Error('secret stack detail');
    const source = {
      name,
      options,
      polls: 0,
      closed: false,
      poll() {
        this.polls++;
        if (behaviour.throwOnPoll === name) throw new Error('secret stack detail');
        if (behaviour.junkPoll === name) return 'junk';
        if (name === 'mailbox') {
          return { ok: true, error: null, root: options.root, name: 'mailbox', tasks: [], events: [], relay: null };
        }
        const key = name === 'claude' ? CLAUDE_KEY : CODEX_KEY;
        return { ok: true, error: null, root: options.root, sessions: [session(key, { model: name === 'codex' ? 'gpt-6.1-sol' : 'claude-opus-5-5' })] };
      },
      detail(key, since) {
        if (behaviour.throwOnDetail) throw new Error('secret stack detail');
        return { events: [{ at: NOW, kind: 'assistant', tool: null, text: `hello from ${name}` }], next: since, key };
      },
      close() {
        this.closed = true;
      },
    };
    made.push(source);
    return source;
  };
  return {
    made,
    behaviour,
    factories: { claude: factory('claude'), codex: factory('codex'), mailbox: factory('mailbox') },
    live: () => made.filter((s) => !s.closed),
  };
}

function makeStore({ settings = {}, roots = ROOTS, now = clock(), demo = false, f = fakes() } = {}) {
  const store = createStore({ settings: cleanSettings(settings), roots, now, demo, factories: f.factories });
  return { store, now, f };
}

test('only enabled sources are made, with their roots and settings', () => {
  const { f } = makeStore({ settings: { sources: { mailbox: { enabled: true } } } });
  assert.deepEqual(f.made.map((s) => s.name), ['claude', 'codex', 'mailbox']);
  const [claude, codex, mailbox] = f.made;
  assert.equal(claude.options.root, ROOTS.claude);
  assert.equal(claude.options.desktopRoot, ROOTS.claudeDesktop);
  assert.equal(codex.options.root, ROOTS.codex);
  assert.equal(mailbox.options.root, ROOTS.mailbox);
  assert.equal(claude.options.settings.content, 'snippets');
  assert.equal(typeof claude.options.now, 'function');

  const off = makeStore({ settings: { sources: { codex: { enabled: false }, claudeDesktop: { enabled: false } } } });
  assert.deepEqual(off.f.made.map((s) => s.name), ['claude']);
  assert.equal(off.f.made[0].options.desktopRoot, null);
  const snap = off.store.snapshot();
  assert.deepEqual(snap.sources.codex, { enabled: false, ok: true, error: null, count: 0 });
  assert.equal(snap.sources.mailbox, null);
});

test('snapshot polls at most every 2 seconds', () => {
  const { store, now, f } = makeStore();
  const first = store.snapshot();
  now.set(NOW + POLL_MS - 1);
  assert.equal(store.snapshot(), first);
  assert.ok(f.made.every((s) => s.polls === 1));
  now.set(NOW + POLL_MS);
  const second = store.snapshot();
  assert.notEqual(second, first);
  assert.equal(second.now, NOW + POLL_MS);
  assert.ok(f.made.every((s) => s.polls === 2));
  // A clock that jumps back must not freeze the snapshot.
  now.set(NOW);
  assert.notEqual(store.snapshot(), second);
  assert.ok(f.made.every((s) => s.polls === 3));
});

test('the snapshot carries a weak ETag of its JSON without the time', () => {
  const { store } = makeStore();
  const snap = store.snapshot();
  const json = JSON.stringify(snap);
  const untimed = JSON.stringify({ ...snap, now: 0 });
  assert.match(snap.etag, /^W\/"[0-9a-f]{40}"$/);
  assert.equal(snap.etag, `W/"${crypto.createHash('sha1').update(untimed).digest('hex')}"`);
  assert.equal(snap.json, json);
  assert.equal(json.includes('etag'), false);
  assert.deepEqual(Object.keys(snap), ['version', 'now', 'sources', 'nodes', 'edges', 'events', 'counts', 'attention', 'tasks', 'actions']);
  assert.ok(snap.nodes.some((n) => n.key === CLAUDE_KEY));
  assert.ok(snap.nodes.some((n) => n.key === CODEX_KEY));
});

test('a rebuilt snapshot that changed only its time keeps its ETag', () => {
  const { store, now } = makeStore();
  const first = store.snapshot();
  now.set(NOW + POLL_MS + 500);
  const second = store.snapshot();
  assert.notEqual(second, first);
  assert.notEqual(second.now, first.now);
  assert.equal(second.etag, first.etag);
});

test('a failing source shows a plain message and the others keep working', () => {
  const f = fakes();
  f.behaviour.throwOnPoll = 'claude';
  f.behaviour.junkPoll = 'codex';
  const { store } = makeStore({ f });
  const snap = store.snapshot();
  assert.deepEqual(snap.sources.claude, { enabled: true, ok: false, error: 'Pleni could not read Claude Code just now.', count: 0 });
  assert.equal(snap.sources.codex.ok, false);
  assert.equal(snap.json.includes('secret'), false);

  const g = fakes();
  g.behaviour.throwOnCreate = 'codex';
  const broken = makeStore({ f: g, settings: { sources: { mailbox: { enabled: true } } }, roots: { ...ROOTS, mailbox: null } });
  const shot = broken.store.snapshot();
  assert.deepEqual(shot.sources.codex, { enabled: true, ok: false, error: 'Pleni could not start reading Codex.', count: 0 });
  assert.deepEqual(shot.sources.mailbox, { enabled: true, ok: false, error: 'Choose a mailbox folder in Settings.', count: 0 });
  assert.equal(shot.sources.claude.ok, true);
});

test('detail is routed by the key prefix', () => {
  const { store } = makeStore();
  assert.equal(store.detail(CLAUDE_KEY, 42).events[0].text, 'hello from claude');
  assert.equal(store.detail(`${CLAUDE_KEY}/a1b2c3`, 0).key, `${CLAUDE_KEY}/a1b2c3`);
  assert.equal(store.detail(CODEX_KEY, null).events[0].text, 'hello from codex');
  assert.equal(store.detail(CODEX_KEY, '1234').next, 1234);
  assert.equal(store.detail(CODEX_KEY, 'abc').next, null);
  assert.equal(store.detail(CODEX_KEY, -5).next, null);
  for (const key of ['you', 'project:alpha', 'claude:nothex', '', null, 'mailbox:T-1', '../etc']) {
    assert.equal(store.detail(key, 0), null, String(key));
  }
});

test('detail hides text when content is none and survives a throwing source', () => {
  const f = fakes();
  const { store } = makeStore({ f, settings: { content: 'none' } });
  assert.deepEqual(store.detail(CLAUDE_KEY, 0).events, [{ at: NOW, kind: 'assistant', tool: null, text: null }]);
  f.behaviour.throwOnDetail = true;
  assert.equal(store.detail(CLAUDE_KEY, 0), null);

  const off = makeStore({ settings: { sources: { codex: { enabled: false } } } });
  assert.equal(off.store.detail(CODEX_KEY, 0), null);
});

test('reload keeps the sources when only the drawing changes', () => {
  const { store, f } = makeStore();
  const before = store.snapshot();
  store.reload(cleanSettings({ displayName: 'Ada', titles: 'company', people: { [CLAUDE_KEY]: { label: 'Main' } } }), ROOTS);
  assert.equal(f.made.length, 2);
  assert.equal(f.live().length, 2);
  const after = store.snapshot();
  assert.notEqual(after, before);
  assert.equal(after.nodes[0].title, 'Ada');
  assert.equal(after.nodes.find((n) => n.key === CLAUDE_KEY).title, 'Main');
});

test('reload makes new sources when roots or source settings change', () => {
  const { store, f } = makeStore();
  const [oldClaude, oldCodex] = f.made;
  store.reload(cleanSettings({}), { ...ROOTS, claude: '/home/ada/other-claude' });
  assert.ok(oldClaude.closed && oldCodex.closed);
  assert.equal(f.live().find((s) => s.name === 'claude').options.root, '/home/ada/other-claude');

  store.reload(cleanSettings({ content: 'none', sources: { codex: { enabled: false } } }), { ...ROOTS, claude: '/home/ada/other-claude' });
  assert.deepEqual(f.live().map((s) => s.name), ['claude']);
  assert.equal(f.live()[0].options.settings.content, 'none');
  assert.equal(store.snapshot().sources.codex.enabled, false);
});

test('close closes every source', () => {
  const { store, f } = makeStore({ settings: { sources: { mailbox: { enabled: true } } } });
  store.close();
  assert.equal(f.made.length, 3);
  assert.ok(f.made.every((s) => s.closed));
});

test('demo mode uses the demo cast and no real sources', () => {
  const now = clock();
  const { store, f } = makeStore({ demo: true, now, settings: { sources: { mailbox: { enabled: false } } } });
  assert.equal(f.made.length, 0);
  const snap = store.snapshot();
  assert.ok(snap.nodes.some((n) => n.key === DEMO_KEYS.planner));
  assert.ok(snap.edges.some((e) => e.kind === 'mailbox'));
  assert.equal(snap.sources.mailbox.enabled, true);
  assert.ok(store.detail(DEMO_KEYS.coordinator, null).events.length > 0);
  assert.equal(store.detail('claude:00000000-0000-4000-8000-000000000000', null).events.length, 0);

  store.reload(cleanSettings({ titles: 'company' }), {});
  assert.equal(f.made.length, 0);
  assert.equal(store.snapshot().nodes.find((n) => n.key === DEMO_KEYS.coordinator).rank, 'Manager');
});

test('demo detail text is hidden when content is none', () => {
  const { store } = makeStore({ demo: true, settings: { content: 'none' } });
  const events = store.detail(DEMO_KEYS.coordinator, null).events;
  assert.ok(events.length > 0);
  assert.ok(events.every((e) => e.text === null));
  assert.equal(store.snapshot().nodes.find((n) => n.key === DEMO_KEYS.coordinator).lastText, null);
});

test('dismissed notices hide until something newer happens, and are kept in the state folder', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pleni-store-dismiss-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let askAt = NOW - 60000;
  const asking = () => ({
    poll: () => ({ ok: true, error: null, root: '/home/ada/.claude', sessions: [session(CLAUDE_KEY, { needs: { kind: 'question', text: null, at: askAt } })] }),
    detail: () => null,
  });
  const factories = { claude: asking, codex: () => ({ poll: () => ({ ok: true, error: null, root: '/x', sessions: [] }) }) };
  let t0 = NOW;
  const now = () => (t0 += POLL_MS);
  const store = createStore({ settings: cleanSettings({}), roots: ROOTS, now, factories, stateDir: dir });
  const id = `${CLAUDE_KEY}|needs`;
  assert.equal(store.snapshot().attention.some((a) => a.id === id), true);
  store.dismiss(id, askAt);
  let snap = store.snapshot();
  assert.equal(snap.attention.some((a) => a.id === id), false);
  assert.equal(snap.nodes.find((n) => n.key === CLAUDE_KEY).needs, null);
  assert.equal(snap.counts.needs, 0);
  // Kept on disk: a new store sees it too.
  const again = createStore({ settings: cleanSettings({}), roots: ROOTS, now, factories, stateDir: dir });
  assert.equal(again.snapshot().attention.some((a) => a.id === id), false);
  // A newer ask shows again.
  askAt = NOW + 1000;
  assert.equal(again.snapshot().attention.some((a) => a.id === id), true);
  // Undo brings the old one back.
  askAt = NOW - 60000;
  store.dismiss(id, null);
  assert.equal(store.snapshot().attention.some((a) => a.id === id), true);
  // Without a state folder, dismissals last only for the run.
  const memoryOnly = createStore({ settings: cleanSettings({}), roots: ROOTS, now, factories });
  memoryOnly.dismiss(id, askAt);
  assert.equal(memoryOnly.snapshot().attention.some((a) => a.id === id), false);
  assert.deepEqual(fs.readdirSync(dir), ['dismissed.json']);
});

// ---- Open in PowerShell ----

test('the snapshot offers Open in PowerShell only when it is turned on and Pleni runs on Windows', () => {
  const make = (settings, platform) => createStore({ settings: cleanSettings(settings), roots: ROOTS, now: clock(), factories: fakes().factories, platform });
  assert.deepEqual(make({}, 'win32').snapshot().actions, { openTerminal: false });
  assert.deepEqual(make({ actions: { openTerminal: true } }, 'win32').snapshot().actions, { openTerminal: true });
  assert.deepEqual(make({ actions: { openTerminal: true } }, 'linux').snapshot().actions, { openTerminal: false });
  assert.deepEqual(make({ actions: { openTerminal: true } }, 'darwin').snapshot().actions, { openTerminal: false });
});

test('turning Open in PowerShell on keeps the sources and shows at once', () => {
  const f = fakes();
  const store = createStore({ settings: cleanSettings({}), roots: ROOTS, now: clock(), factories: f.factories, platform: 'win32' });
  assert.equal(store.snapshot().actions.openTerminal, false);
  store.reload(cleanSettings({ actions: { openTerminal: true } }), ROOTS);
  assert.equal(store.snapshot().actions.openTerminal, true);
  assert.equal(f.live().length, 2, 'the same sources are kept');
  assert.equal(f.made.length, 2);
});

test('session() gives the folder and state of a top-level Claude Code session or a Codex thread', () => {
  const { store } = makeStore();
  assert.deepEqual(store.session(CLAUDE_KEY), { id: CLAUDE_KEY.slice('claude:'.length), cwd: '/home/ada/code/alpha', status: 'working', entrypoint: 'cli', kind: 'session' });
  assert.deepEqual(store.session(CODEX_KEY), { id: CODEX_KEY.slice('codex:'.length), cwd: '/home/ada/code/alpha', status: 'working', entrypoint: 'cli', kind: 'session' });
  assert.equal(store.session(`${CLAUDE_KEY}/a1b2c3`), null);
  assert.equal(store.session('grok:cccccccc-0000-4000-8000-000000000001'), null);
  assert.equal(store.session('claude:aaaaaaaa-0000-4000-8000-00000000ffff'), null);
  assert.equal(store.session(null), null);
  assert.equal(store.demo, false);
});

test('the demo has no real sessions to open', () => {
  const store = createStore({ settings: cleanSettings({}), roots: ROOTS, now: clock(), demo: true });
  assert.equal(store.demo, true);
  for (const key of Object.values(DEMO_KEYS)) assert.equal(store.session(key), null);
  assert.equal(store.session(CLAUDE_KEY), null);
});
