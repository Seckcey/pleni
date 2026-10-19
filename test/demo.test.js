import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanSettings, isNodeKey } from '../src/config.js';
import { BEAT_MS, DEMO_KEYS, createDemoSource, demoSettings } from '../src/demo.js';
import { buildSnapshot } from '../src/model.js';

const NOW = Date.UTC(2026, 0, 15, 12, 3, 7);

function clock(start = NOW) {
  let t = start;
  const now = () => t;
  now.set = (value) => {
    t = value;
  };
  return now;
}

function allSessions(state) {
  return ['claude', 'codex', 'grok', 'kimi'].flatMap((name) => state[name].sessions);
}

function demoSnapshot(now, settings = {}) {
  const state = createDemoSource({ now: () => now }).poll();
  return buildSnapshot({ now, settings: demoSettings(cleanSettings(settings)), ...state });
}

test('the same time always gives the same demo data', () => {
  const a = createDemoSource({ now: () => NOW });
  const b = createDemoSource({ now: () => NOW });
  assert.deepEqual(a.poll(), b.poll());
  assert.deepEqual(a.poll(), a.poll());
  assert.deepEqual(a.detail(DEMO_KEYS.coordinator, null), b.detail(DEMO_KEYS.coordinator, null));
});

test('the demo returns the source shapes the store expects', () => {
  const state = createDemoSource({ now: () => NOW }).poll();
  for (const name of ['claude', 'codex', 'grok', 'kimi']) {
    assert.equal(state[name].ok, true);
    assert.ok(state[name].sessions.length > 0, name);
    assert.equal(state[name].error, null);
    assert.ok(state[name].sessions.every((s) => s.platform === name && s.key.startsWith(`${name}:`)));
  }
  for (const s of allSessions(state)) {
    assert.ok(isNodeKey(s.key), s.key);
    assert.ok(s.cwd.startsWith('/home/ada/'), s.cwd);
    assert.ok(s.startedAt <= s.lastAt && s.lastAt <= NOW);
    assert.ok(s.links.length <= 50);
    for (let i = 1; i < s.links.length; i++) assert.ok(s.links[i - 1].at <= s.links[i].at);
  }
  const m = state.mailbox;
  assert.equal(m.ok, true);
  assert.equal(m.relay.coordinatorKey, DEMO_KEYS.coordinator);
  assert.ok(m.events.length > 0 && m.events.length <= 300);
  for (let i = 1; i < m.events.length; i++) assert.ok(m.events[i - 1].at >= m.events[i].at);
  assert.ok(m.tasks.every((task) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/.test(task.id)));
});

test('the cast has every status and the planned shape', () => {
  const sessions = allSessions(createDemoSource({ now: () => NOW }).poll());
  const statuses = new Set(sessions.map((s) => s.status));
  assert.deepEqual([...statuses].sort(), ['done', 'error', 'idle', 'ready', 'working']);

  const planner = sessions.find((s) => s.key === DEMO_KEYS.planner);
  assert.equal(planner.platform, 'codex');
  const plannerAgents = sessions.filter((s) => s.parentKey === planner.key && s.kind === 'agent');
  assert.equal(plannerAgents.length, 2);
  assert.ok(sessions.some((s) => s.parentKey === planner.key && s.kind === 'reviewer'));

  const coordinator = sessions.find((s) => s.key === DEMO_KEYS.coordinator);
  assert.equal(coordinator.platform, 'claude');
  const helpers = sessions.filter((s) => s.parentKey === coordinator.key);
  assert.deepEqual(helpers.map((s) => s.status).sort(), ['done', 'ready', 'working']);

  const models = new Set(sessions.map((s) => s.model));
  for (const model of ['claude-opus-5-5', 'claude-sonnet-5-5', 'gpt-6.1-sol']) assert.ok(models.has(model), model);
});

test('hand-offs light up every few seconds', () => {
  const now = clock();
  const source = createDemoSource({ now });
  const times = new Set();
  for (let t = NOW; t < NOW + 3 * 60000; t += 1000) {
    now.set(t);
    const state = source.poll();
    for (const s of allSessions(state)) for (const link of s.links) if (link.at > NOW - 60000) times.add(link.at);
    for (const event of state.mailbox.events) if (event.at > NOW - 60000) times.add(event.at);
    for (const s of allSessions(state)) assert.ok(s.links.every((link) => link.at <= t));
  }
  const sorted = [...times].sort((a, b) => a - b);
  assert.ok(sorted.length >= 15, `only ${sorted.length} hand-offs`);
  for (let i = 1; i < sorted.length; i++) assert.ok(sorted[i] - sorted[i - 1] <= 15000, 'a long quiet gap');
});

test('working sessions move while the others keep still', () => {
  const now = clock();
  const source = createDemoSource({ now });
  const before = allSessions(source.poll());
  now.set(NOW + BEAT_MS);
  const after = allSessions(source.poll());
  for (let i = 0; i < before.length; i++) {
    assert.equal(after[i].status, before[i].status);
    if (before[i].status === 'working') {
      assert.equal(after[i].lastAt, before[i].lastAt + BEAT_MS);
      assert.notDeepEqual(after[i].activity, before[i].activity);
    } else {
      assert.equal(after[i].lastAt, before[i].lastAt);
      assert.equal(after[i].activity, null);
    }
  }
});

test('the demo snapshot shows two projects, ranks and a live mailbox line', () => {
  const s = demoSnapshot(NOW, { titles: 'military', groupBy: 'project' });
  const projects = s.nodes.filter((n) => n.kind === 'project').map((n) => n.title);
  assert.deepEqual(projects, ['billing-service', 'field-app']);
  for (const status of ['working', 'ready', 'idle', 'done', 'error']) assert.ok(s.counts[status] > 0, status);
  assert.equal(s.nodes.find((n) => n.key === DEMO_KEYS.planner).rank, 'Colonel');
  assert.equal(s.nodes.find((n) => n.key === DEMO_KEYS.coordinator).rank, 'Sergeant');
  // The mailbox runs planner -> relay -> coordinator, and both legs light together.
  const legs = s.edges.filter((e) => e.kind === 'mailbox');
  assert.deepEqual(legs.map((e) => [e.from, e.to]), [[DEMO_KEYS.planner, 'relay'], ['relay', DEMO_KEYS.coordinator]]);
  assert.ok(legs.every((e) => e.active));
  assert.ok(s.edges.some((e) => e.kind === 'spawn' && e.active));
  assert.ok(s.events.some((e) => e.kind === 'spawn'));
  assert.ok(s.events.some((e) => e.kind === 'report'));
  assert.ok(s.events.some((e) => e.kind === 'message'));
  assert.ok(s.events.some((e) => e.kind === 'error'));
  assert.deepEqual(new Set(s.attention.map((a) => a.kind)), new Set(['needs', 'error', 'question', 'review', 'note', 'mail']));
  // Agent mail: the planner and a session write to each other, and one asks the person something.
  assert.ok(s.events.some((e) => e.kind === 'mail' && e.from === DEMO_KEYS.planner));
  assert.equal(s.nodes.find((n) => n.key === 'you').mail.unread, 1);
  assert.equal(s.nodes.find((n) => n.key === DEMO_KEYS.planner).mail.wakes, true);
  // The automatic reviewer only shows when asked for.
  assert.equal(s.nodes.some((n) => n.kind === 'reviewer'), false);
  assert.ok(demoSnapshot(NOW, { showReviewers: true }).nodes.some((n) => n.kind === 'reviewer'));
});

test('each demo letter shows once, however long the demo has run', () => {
  const source = createDemoSource({ now: () => NOW });
  for (const messages of [source.poll().mailbox.mail.messages, source.mail({ all: true })]) {
    const seen = messages.map((m) => `${m.from}|${m.to}|${m.text}`);
    assert.equal(new Set(seen).size, seen.length);
    assert.equal(seen.length, 6);
  }
});

test('demoSettings wires the mailbox and keeps your own choices', () => {
  const settings = demoSettings(cleanSettings({ people: { [DEMO_KEYS.coordinator]: { label: 'Main', role: 'lead' } } }));
  assert.equal(settings.sources.mailbox.planner, DEMO_KEYS.planner);
  assert.equal(settings.sources.mailbox.coordinator, DEMO_KEYS.coordinator);
  assert.deepEqual(settings.people[DEMO_KEYS.coordinator], { label: 'Main', role: 'lead' });
  assert.deepEqual(settings.people[DEMO_KEYS.planner], { role: 'superintendent' });
  assert.deepEqual(cleanSettings(settings), settings);
});

test('detail returns recent events oldest first and follows the cursor', () => {
  const now = clock();
  const source = createDemoSource({ now });
  const first = source.detail(DEMO_KEYS.coordinator, null);
  assert.ok(first.events.length > 5 && first.events.length <= 200);
  for (let i = 1; i < first.events.length; i++) assert.ok(first.events[i - 1].at <= first.events[i].at);
  assert.equal(first.next, first.events[first.events.length - 1].at);
  const kinds = new Set(first.events.map((e) => e.kind));
  for (const kind of ['user', 'thinking', 'tool', 'result', 'assistant']) assert.ok(kinds.has(kind), kind);
  assert.ok(first.events.filter((e) => e.kind === 'thinking').every((e) => e.text === null));

  assert.deepEqual(source.detail(DEMO_KEYS.coordinator, first.next).events, []);
  now.set(NOW + 3 * BEAT_MS);
  const more = source.detail(DEMO_KEYS.coordinator, first.next);
  assert.ok(more.events.length >= 2);
  assert.ok(more.events.every((e) => e.at > first.next));

  const error = allSessions(source.poll()).find((s) => s.status === 'error');
  assert.equal(source.detail(error.key, null).events.at(-1).kind, 'error');
  assert.deepEqual(source.detail('claude:00000000-0000-4000-8000-000000000000', null), { events: [], next: null });
});
