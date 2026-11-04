import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanSettings, isNodeKey } from '../src/config.js';
import { BEAT_MS, DEMO_KEYS, createDemoSource, demoCloud, demoSettings } from '../src/demo.js';
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
  return ['claude', 'codex', 'grok', 'kimi', 'gemini'].flatMap((name) => state[name].sessions);
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
  for (const name of ['claude', 'codex', 'grok', 'kimi', 'gemini']) {
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
  // An HQ, whose relay wakes the orchestrator, with two project mailboxes, each with its own relay.
  const m = state.mailbox;
  assert.equal(m.ok, true);
  assert.equal(m.relay.plannerKey, DEMO_KEYS.planner);
  assert.deepEqual(m.hq.projects.map((p) => [p.id, p.name]), [['billing', 'Billing service'], ['field-app', 'Field app']]);
  assert.equal(m.hq.projects[0].mailbox.relay.coordinatorKey, DEMO_KEYS.coordinator);
  assert.equal(m.hq.projects[1].mailbox.relay.coordinatorKey, DEMO_KEYS.fieldCoordinator);
  for (const box of [m, ...m.hq.projects.map((p) => p.mailbox)]) {
    assert.equal(box.ok, true);
    assert.ok(box.events.length > 0 && box.events.length <= 300);
    for (let i = 1; i < box.events.length; i++) assert.ok(box.events[i - 1].at >= box.events[i].at);
    assert.ok(box.tasks.every((task) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/.test(task.id)));
  }
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

  // A Gemini CLI session with a helper that finished.
  const gemini = sessions.filter((s) => s.platform === 'gemini');
  const lead = gemini.find((s) => s.kind === 'session');
  assert.deepEqual(gemini.filter((s) => s.parentKey === lead.key).map((s) => [s.kind, s.status]), [['agent', 'done']]);

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
    for (const box of [state.mailbox, ...state.mailbox.hq.projects.map((p) => p.mailbox)]) {
      for (const event of box.events) if (event.at > NOW - 60000) times.add(event.at);
    }
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
  // The orchestrator's own folder, then HQ's two project mailboxes, which hold their projects' sessions.
  const projects = s.nodes.filter((n) => n.kind === 'project').map((n) => n.title);
  assert.deepEqual(projects, ['hq', 'Billing service', 'Field app']);
  for (const status of ['working', 'ready', 'idle', 'done', 'error']) assert.ok(s.counts[status] > 0, status);
  assert.equal(s.nodes.find((n) => n.key === DEMO_KEYS.planner).rank, 'Colonel');
  assert.equal(s.nodes.find((n) => n.key === DEMO_KEYS.coordinator).rank, 'Sergeant');
  // Each project's mailbox runs orchestrator -> project -> its relay -> its coordinator, and the legs
  // light together; HQ's relay lights when it wakes the orchestrator.
  const legs = s.edges.filter((e) => e.kind === 'mailbox');
  assert.deepEqual(legs.map((e) => [e.from, e.to]), [
    [DEMO_KEYS.planner, 'project:Billing service'], ['project:Billing service', 'relay:billing'], ['relay:billing', DEMO_KEYS.coordinator],
    [DEMO_KEYS.planner, 'project:Field app'], ['project:Field app', 'relay:field-app'], ['relay:field-app', DEMO_KEYS.fieldCoordinator],
    [DEMO_KEYS.planner, 'relay'],
  ]);
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
  assert.equal(settings.codexCloud.live, true, 'the demo always has a Cloud page, with made-up tasks');
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

test('demoSettings always shows its two made-up projects, never the person\'s own', () => {
  const settings = demoSettings(cleanSettings({}));
  assert.deepEqual(settings.projectList.map((p) => [p.id, p.name, p.repo]), [
    ['demobilling01', 'Billing service', 'example/billing-service'],
    ['demofieldapp1', 'Field app', 'example/field-app'],
  ]);
  assert.deepEqual(cleanSettings(settings), settings);
  const own = [{ id: 'mine0001', name: 'Mine', folder: '/home/ada/code/mine', repo: null }];
  assert.deepEqual(demoSettings(cleanSettings({ projectList: own })).projectList, settings.projectList);
});

test('the demo\'s Codex cloud tasks are made up, checked, newest first, and cover every status', () => {
  const answer = demoCloud(NOW);
  assert.equal(answer.error, null);
  assert.equal(answer.at, NOW);
  assert.ok(answer.tasks.length >= 4 && answer.tasks.length <= 5);
  assert.deepEqual([...new Set(answer.tasks.map((t) => t.status))].sort(), ['applied', 'error', 'pending', 'ready']);
  const times = answer.tasks.map((t) => t.updatedAt);
  assert.deepEqual(times, [...times].sort((a, b) => b - a));
  for (const task of answer.tasks) {
    assert.match(task.id, /^[A-Za-z0-9_-]+$/);
    assert.equal(task.url, `https://chatgpt.com/codex/tasks/${task.id}`);
    assert.ok(task.updatedAt < NOW);
  }
  assert.deepEqual(demoCloud(NOW), answer, 'the same time gives the same tasks');
});

test('the demo is an HQ: the orchestrator above HQ\'s relay and two projects, each with its relay, coordinator and workers', () => {
  const s = demoSnapshot(NOW);
  const node = (key) => s.nodes.find((n) => n.key === key);
  const kids = (key) => s.nodes.filter((n) => n.parent === key).map((n) => n.key);
  const orchestrator = node(DEMO_KEYS.planner);
  assert.deepEqual([orchestrator.title, orchestrator.parent], ['Orchestrator', 'you']);
  for (const key of ['relay', 'project:Billing service', 'project:Field app']) assert.ok(kids(DEMO_KEYS.planner).includes(key), key);
  assert.equal(node('relay').title, 'HQ relay');
  for (const [tile, relay, lead] of [['project:Billing service', 'relay:billing', DEMO_KEYS.coordinator], ['project:Field app', 'relay:field-app', DEMO_KEYS.fieldCoordinator]]) {
    assert.deepEqual(kids(tile), [relay]);
    assert.deepEqual(kids(relay), [lead]);
    assert.equal(node(lead).rank, 'Coordinator');
  }
  // Workers: runs that kept no session file (one of them in Codex), and one that is a Claude Code
  // session of its own.
  assert.ok(kids(DEMO_KEYS.coordinator).includes('mailbox:billing:T-101/W1'));
  assert.equal(node('mailbox:billing:T-101/W1').platform, 'claude');
  const field = kids(DEMO_KEYS.fieldCoordinator).map((key) => node(key));
  assert.deepEqual(field.map((n) => [n.title, n.status, n.platform]), [['W1 · T-201: Offline map tiles', 'done', 'codex'], ['W2 · T-201: Offline map tiles', 'working', 'claude']]);
  assert.ok(field[1].key.startsWith('claude:'));
  assert.deepEqual(s.boxes.map((b) => [b.id, b.name, b.error, b.project]), [['hq', 'HQ', null, null], ['billing', 'Billing service', null, 'Billing service'], ['field-app', 'Field app', null, 'Field app']]);
  assert.deepEqual([...new Set(s.tasks.map((task) => task.boxName))], ['HQ', 'Billing service', 'Field app']);
  // HQ's relay wakes the orchestrator for new items, and that lights their line.
  assert.ok(s.events.some((e) => e.kind === 'wake' && e.from === 'relay' && e.to === DEMO_KEYS.planner && /new item/.test(e.text)));
  assert.equal(JSON.stringify(s).includes('/home/ada'), false, 'no folder paths');
});
