import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMailboxSource, parseStamp } from '../src/sources/mailbox.js';

const OLD = new Date(2020, 0, 1, 12, 0).getTime();
const SESSION = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';

function tempMailbox(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pleni-mailbox-'));
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

const local = (y, mo, d, h, mi, s = 0) => new Date(y, mo - 1, d, h, mi, s).getTime();

function buildMailbox(root) {
  write(root, 'QUEUE.md', [
    '# Queue',
    '',
    '## 2026-10-12 09:00 Pacific — Assigned T-1',
    'Some text.',
    '',
    '### 2026-10-13T16:30:00Z — Assigned T-2',
    '',
    '## Notes without a time stamp',
    '#### 2026-10-12 08:00 — too deep to count',
    '',
  ].join('\n'));
  write(root, 'STATUS.md', '# Board\r\n\r\n## 2026-10-12 09:30 — Started T-1\r\n');

  write(root, 'tasks/T-1/assignment.md', '﻿# Build the parser\n\n## 2026-10-12 09:00 — Assigned\n');
  write(root, 'tasks/T-1/status.md', '﻿**Current state:** IN_REVIEW — waiting\r\n');
  write(root, 'tasks/T-1/questions.md', [
    '# Questions',
    '',
    '## Q1 — 2026-10-12 09:40 — BLOCKING',
    'Which format?',
    '',
    '## Q2 — 2026-10-12 09:45 — NON-BLOCKING',
    '',
  ].join('\n'));
  write(root, 'tasks/T-1/review.md', '## 2026-10-12 10:00 — Changes requested\n');
  write(root, 'tasks/T-1/handoff.md', [
    '## 2026-10-12 11:00 — Ready for review',
    '',
    '```md',
    '## 2026-10-12 12:00 — not a heading',
    '```',
    '',
  ].join('\n'));
  write(root, 'tasks/T-1/workers/W1.run.json', JSON.stringify({
    state: 'done',
    model: 'sonnet',
    started_at: '2026-10-12T16:00:00Z',
    finished_at: '2026-10-12T16:20:00Z',
    session_id: 'AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE',
  }));
  write(root, 'tasks/T-1/workers/W1-report.md', '## 2026-10-12 10:30 — Worker report\n');
  write(root, 'tasks/T-1/workers/W2.run.json', '﻿{"status":"running","model":"haiku","startedAt":1791900000,"sessionId":"not a session id"}');
  write(root, 'tasks/T-1/workers/W10.run.json', '{ not json');
  write(root, 'tasks/T-1/workers/notes.txt', 'ignored');

  write(root, 'tasks/T-2/status.md', '**Current state:** DONE\n');
  write(root, 'tasks/T-2/questions.md', '## Q1 — 2026-10-12 09:50 — BLOCKING\n');

  write(root, 'tasks/T-10/status.md', '- **Current state:** `IN_PROGRESS`\n');
  write(root, 'tasks/T-10/questions.md', '## Q1 — 2026-10-12 09:55 — BLOCKING\n');
  write(root, 'tasks/T-10/answers.md', '## A1 — 2026-10-12 10:05 — Use JSON\n');
  write(root, 'tasks/T-10/handoff.md', '## 2026-10-12 10:10 — Halfway\n');

  write(root, 'tasks/.hidden/status.md', '**Current state:** IN_REVIEW\n');
  write(root, 'tasks/bad id/status.md', '**Current state:** IN_REVIEW\n');
  write(root, 'tasks/readme.md', '# Not a task\n');
}

test('parseStamp reads ISO and local time stamps', () => {
  assert.equal(parseStamp('2026-10-12T17:30:00Z').at, Date.UTC(2026, 9, 12, 17, 30));
  assert.equal(parseStamp('2026-10-12T10:30:00-07:00').at, Date.UTC(2026, 9, 12, 17, 30));
  assert.equal(parseStamp('2026-10-12 17:30:00+0000').at, Date.UTC(2026, 9, 12, 17, 30));
  assert.equal(parseStamp('2026-10-12T17:30:00.250Z').at, Date.UTC(2026, 9, 12, 17, 30, 0, 250));
  assert.equal(parseStamp('2026-10-12 09:15').at, local(2026, 10, 12, 9, 15));
  assert.equal(parseStamp('2026-10-12T09:15').at, local(2026, 10, 12, 9, 15));
  assert.equal(parseStamp('2026-10-12 9:15:30').at, local(2026, 10, 12, 9, 15, 30));
  assert.equal(parseStamp('2026-10-12 09:15 UTC').at, Date.UTC(2026, 9, 12, 9, 15));
});

test('parseStamp ignores a zone word and reports where the stamp is', () => {
  const text = 'Q1 — 2026-10-12 09:15:30 Pacific — BLOCKING';
  const stamp = parseStamp(text);
  assert.equal(stamp.at, local(2026, 10, 12, 9, 15, 30));
  assert.equal(text.slice(stamp.index, stamp.index + stamp.length), '2026-10-12 09:15:30 Pacific');
  assert.equal(parseStamp('2026-10-12 09:15 PDT').at, local(2026, 10, 12, 9, 15));
  assert.equal(parseStamp('2026-10-12 09:15 (Pacific Time)').length, '2026-10-12 09:15 (Pacific Time)'.length);

  const wrapped = parseStamp('Done [2026-10-12 10:00]');
  assert.deepEqual([wrapped.index, wrapped.length], [5, 18]);
  // A word after the time that is not a zone stays part of the text.
  assert.equal(parseStamp('2026-10-12 10:00 NOTE').length, 16);
});

test('parseStamp rejects things that are not time stamps', () => {
  for (const text of ['2026-02-30 10:00', '2026-10-12 24:00', '2026-10-12 10:60', '2026-10-12', 'no time', '12026-10-12 10:00', '', null, 7]) {
    assert.equal(parseStamp(text), null, String(text));
  }
  // The first valid stamp wins.
  assert.equal(parseStamp('2026-02-30 10:00 then 2026-03-01 10:00').at, local(2026, 3, 1, 10, 0));
});

test('reads tasks, states, titles, attention and workers', (t) => {
  const root = tempMailbox(t);
  buildMailbox(root);
  const state = createMailboxSource({ root, settings: { content: 'snippets' } }).poll();

  assert.equal(state.ok, true);
  assert.equal(state.error, null);
  assert.equal(state.root, root);
  assert.equal(state.name, path.basename(root));
  assert.equal(state.relay, null);
  assert.deepEqual(state.tasks.map((task) => task.id), ['T-1', 'T-2', 'T-10']);

  const [one, two, ten] = state.tasks;
  assert.equal(one.title, 'Build the parser');
  assert.equal(one.state, 'IN_REVIEW');
  assert.deepEqual(one.attention, ['question', 'review']);
  assert.equal(one.updatedAt, local(2026, 10, 12, 11, 0));
  assert.deepEqual(one.workers, [
    { id: 'W1', state: 'done', model: 'sonnet', startedAt: Date.UTC(2026, 9, 12, 16, 0), finishedAt: Date.UTC(2026, 9, 12, 16, 20), worktree: null, sessionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' },
    { id: 'W2', state: 'running', model: 'haiku', startedAt: 1791900000 * 1000, finishedAt: null, worktree: null, sessionId: null },
    { id: 'W10', state: null, model: null, startedAt: null, finishedAt: null, worktree: null, sessionId: null },
  ]);

  assert.equal(two.title, 'T-2');
  assert.equal(two.state, 'DONE');
  assert.deepEqual(two.attention, []);
  assert.deepEqual(two.workers, []);

  assert.equal(ten.state, 'IN_PROGRESS');
  assert.deepEqual(ten.attention, []);
});

test('turns time stamped headings into events, newest first', (t) => {
  const root = tempMailbox(t);
  buildMailbox(root);
  const { events } = createMailboxSource({ root, settings: {} }).poll();

  assert.equal(events.length, 13);
  for (let i = 1; i < events.length; i++) assert.ok(events[i - 1].at >= events[i].at);
  assert.deepEqual(events[0], {
    at: Date.UTC(2026, 9, 13, 16, 30),
    dir: 'down',
    taskId: null,
    file: 'QUEUE.md',
    title: 'Assigned T-2',
  });

  const find = (file, title) => events.find((e) => e.file === file && e.title === title);
  assert.deepEqual(find('QUEUE.md', 'Assigned T-1'), {
    at: local(2026, 10, 12, 9, 0), dir: 'down', taskId: null, file: 'QUEUE.md', title: 'Assigned T-1',
  });
  assert.equal(find('STATUS.md', 'Started T-1').dir, 'up');
  assert.equal(find('tasks/T-1/assignment.md', 'Assigned').dir, 'down');
  assert.equal(find('tasks/T-1/review.md', 'Changes requested').dir, 'down');
  assert.equal(find('tasks/T-10/answers.md', 'A1 — Use JSON').dir, 'down');
  assert.equal(find('tasks/T-1/handoff.md', 'Ready for review').dir, 'up');
  assert.equal(find('tasks/T-1/workers/W1-report.md', 'Worker report').dir, 'up');
  const question = find('tasks/T-1/questions.md', 'Q1 — BLOCKING');
  assert.deepEqual(question, {
    at: local(2026, 10, 12, 9, 40), dir: 'up', taskId: 'T-1', file: 'tasks/T-1/questions.md', title: 'Q1 — BLOCKING',
  });

  assert.equal(events.some((e) => /not a heading|too deep/.test(e.title)), false);
  assert.equal(events.some((e) => e.taskId === '.hidden' || e.taskId === 'bad id'), false);
});

test('content "none" hides titles', (t) => {
  const root = tempMailbox(t);
  buildMailbox(root);
  const settings = { content: 'none' };
  const source = createMailboxSource({ root, settings });
  const state = source.poll();
  assert.equal(state.tasks[0].title, 'T-1');
  assert.ok(state.events.length > 0);
  assert.ok(state.events.every((e) => e.title === null));

  // A settings change is picked up on the next poll.
  settings.content = 'snippets';
  assert.equal(source.poll().tasks[0].title, 'Build the parser');
});

test('long headings are clipped to 120 characters', (t) => {
  const root = tempMailbox(t);
  write(root, 'tasks/T-1/assignment.md', `# ${'word '.repeat(60)}\n`);
  write(root, 'QUEUE.md', `## 2026-10-12 09:00 — ${'x'.repeat(300)}\n`);
  const state = createMailboxSource({ root }).poll();
  assert.ok(Array.from(state.tasks[0].title).length <= 120);
  assert.equal(Array.from(state.events[0].title).length, 120);
  assert.ok(state.events[0].title.endsWith('…'));
});

test('review attention needs IN_REVIEW and a handoff newer than the review', (t) => {
  const root = tempMailbox(t);
  write(root, 'tasks/a/status.md', '**Current state:** IN_REVIEW\n');
  write(root, 'tasks/a/handoff.md', '## 2026-10-12 10:00 — Ready\n');
  write(root, 'tasks/a/review.md', '## 2026-10-12 11:00 — Approved\n');

  write(root, 'tasks/b/status.md', '**Current state:** in-review\n');
  write(root, 'tasks/b/handoff.md', '## 2026-10-12 10:00 — Ready\n');

  write(root, 'tasks/c/status.md', '**Current state:** CANCELLED\n');
  write(root, 'tasks/c/handoff.md', '## 2026-10-12 10:00 — Ready\n');
  write(root, 'tasks/c/questions.md', '## Q3 — 2026-10-12 09:00 — BLOCKING\n');

  write(root, 'tasks/d/status.md', '**Current state:** IN_PROGRESS\n');
  write(root, 'tasks/d/handoff.md', '## 2026-10-12 10:00 — Ready\n');
  write(root, 'tasks/d/questions.md', '## Q3 — 2026-10-12 09:00 — BLOCKING\n');
  write(root, 'tasks/d/answers.md', '## Answer to Q2 — 2026-10-12 09:30\n');

  const byId = Object.fromEntries(createMailboxSource({ root }).poll().tasks.map((task) => [task.id, task]));
  assert.deepEqual(byId.a.attention, []);
  assert.equal(byId.b.state, 'IN_REVIEW');
  assert.deepEqual(byId.b.attention, ['review']);
  assert.deepEqual(byId.c.attention, []);
  assert.deepEqual(byId.d.attention, ['question']);
});

test('a state of several capital words is kept whole, and every finished state is closed', (t) => {
  const root = tempMailbox(t);
  const states = {
    nocd: ['**Current state:** NO CLAUDE DISPATCH — handled by the planner', 'NO_CLAUDE_DISPATCH'],
    space: ['**Current state:** **IN PROGRESS**', 'IN_PROGRESS'],
    done: ['**Current state:** DONE. All merged', 'DONE'],
    donepr: ['**Current state:** DONE PR merged', 'DONE_PR'],
    complete: ['**Current state:** COMPLETE', 'COMPLETE'],
    completed: ['**Current state:** Completed on time', 'COMPLETED'],
    mixed: ['**Current state:** WAITING for the planner', 'WAITING'],
    lower: ['**Current state:** in progress', 'IN'],
  };
  for (const [id, [line]] of Object.entries(states)) {
    write(root, `tasks/${id}/status.md`, `${line}\n`);
    write(root, `tasks/${id}/questions.md`, '## Q1 — 2026-10-12 09:00 — BLOCKING\n');
  }
  const byId = Object.fromEntries(createMailboxSource({ root }).poll().tasks.map((task) => [task.id, task]));
  for (const [id, [, state]] of Object.entries(states)) assert.equal(byId[id].state, state, id);
  for (const id of ['nocd', 'done', 'donepr', 'complete', 'completed']) assert.deepEqual(byId[id].attention, [], id);
  for (const id of ['space', 'mixed', 'lower']) assert.deepEqual(byId[id].attention, ['question'], id);
});

test('a NO CLAUDE DISPATCH task counts as finished and is not read on every poll', (t) => {
  const root = tempMailbox(t);
  let clock = 1_000_000;
  const source = createMailboxSource({ root, now: () => clock });
  write(root, 'tasks/T-1/status.md', '**Current state:** NO CLAUDE DISPATCH — reason\n');
  assert.equal(source.poll().tasks[0].state, 'NO_CLAUDE_DISPATCH');
  write(root, 'tasks/T-1/status.md', '**Current state:** IN_PROGRESS — reopened\n');
  assert.equal(source.poll().tasks[0].state, 'NO_CLAUDE_DISPATCH');
  clock += 10_000;
  assert.equal(source.poll().tasks[0].state, 'IN_PROGRESS');
});

test('CODEX-QUEUE.md works like QUEUE.md', (t) => {
  const root = tempMailbox(t);
  write(root, 'CODEX-QUEUE.md', '## 2026-10-12 09:00 — Assigned T-1\n');
  const { events } = createMailboxSource({ root }).poll();
  assert.deepEqual(events.map((e) => [e.file, e.dir, e.title]), [['CODEX-QUEUE.md', 'down', 'Assigned T-1']]);
});

test('keeps only the newest 300 events', (t) => {
  const root = tempMailbox(t);
  const lines = [];
  for (let i = 0; i < 350; i++) {
    const minutes = String(i % 60).padStart(2, '0');
    const hours = String(Math.floor(i / 60)).padStart(2, '0');
    lines.push(`## 2026-10-12 ${hours}:${minutes} — Entry ${i}`);
  }
  write(root, 'QUEUE.md', `${lines.join('\n')}\n`);
  const { events } = createMailboxSource({ root }).poll();
  assert.equal(events.length, 300);
  assert.equal(events[0].title, 'Entry 349');
  assert.equal(events[299].title, 'Entry 50');
});

test('a very large file is read from its end', (t) => {
  const root = tempMailbox(t);
  const padding = `${'x'.repeat(99)}\n`.repeat(50_000); // about 5 MB
  write(root, 'QUEUE.md', `## 2026-10-12 08:00 — First\n${padding}## 2026-10-12 09:00 — Last\n`);
  const { events } = createMailboxSource({ root }).poll();
  assert.deepEqual(events.map((e) => e.title), ['Last']);
});

test('polling is incremental', (t) => {
  const root = tempMailbox(t);
  let clock = 1_000_000;
  const source = createMailboxSource({ root, now: () => clock });
  write(root, 'tasks/T-1/handoff.md', '## 2026-10-12 10:00 — First\n');

  const first = source.poll();
  assert.equal(first.events.length, 1);
  const again = source.poll();
  assert.equal(again.events, first.events);
  assert.equal(again.tasks, first.tasks);

  // Known files are checked on every poll.
  fs.appendFileSync(path.join(root, 'tasks', 'T-1', 'handoff.md'), '## 2026-10-12 11:00 — Second\n');
  assert.deepEqual(source.poll().events.map((e) => e.title), ['Second', 'First']);

  // New folders show up when the listing refreshes.
  write(root, 'tasks/T-2/status.md', '**Current state:** IN_PROGRESS\n');
  assert.deepEqual(source.poll().tasks.map((task) => task.id), ['T-1']);
  clock += 10_000;
  assert.deepEqual(source.poll().tasks.map((task) => task.id), ['T-1', 'T-2']);

  // Finished tasks are checked again only when the listing refreshes.
  write(root, 'tasks/T-2/status.md', '**Current state:** DONE\n');
  assert.equal(source.poll().tasks[1].state, 'DONE');
  write(root, 'tasks/T-2/status.md', '**Current state:** IN_PROGRESS — reopened\n');
  assert.equal(source.poll().tasks[1].state, 'DONE');
  clock += 10_000;
  assert.equal(source.poll().tasks[1].state, 'IN_PROGRESS');

  fs.rmSync(path.join(root, 'tasks', 'T-2'), { recursive: true });
  clock += 10_000;
  assert.deepEqual(source.poll().tasks.map((task) => task.id), ['T-1']);

  fs.rmSync(path.join(root, 'tasks', 'T-1', 'handoff.md'));
  assert.deepEqual(source.poll().events, []);
});

test('relay: coordinator, pause, stop and a live lock', (t) => {
  const root = tempMailbox(t);
  write(root, '.relay/coordinator.json', `﻿${JSON.stringify({ session_id: SESSION.toUpperCase() })}`);
  write(root, '.relay/relay.lock', `${process.pid}\n`);
  write(root, '.relay/PAUSE', '');
  assert.deepEqual(createMailboxSource({ root }).poll().relay, {
    running: true,
    paused: true,
    halted: false,
    coordinatorKey: `claude:${SESSION}`,
  });

  fs.rmSync(path.join(root, '.relay', 'PAUSE'));
  write(root, '.relay/STOP', '');
  write(root, '.relay/relay.lock', JSON.stringify({ pid: process.pid, host: os.hostname() }));
  assert.deepEqual(createMailboxSource({ root }).poll().relay, {
    running: true,
    paused: false,
    halted: true,
    coordinatorKey: `claude:${SESSION}`,
  });
});

test('relay: state.json flags and an empty relay folder', (t) => {
  const root = tempMailbox(t);
  fs.mkdirSync(path.join(root, '.relay'));
  assert.deepEqual(createMailboxSource({ root }).poll().relay, {
    running: false,
    paused: false,
    halted: false,
    coordinatorKey: null,
  });
  write(root, '.relay/state.json', JSON.stringify({ paused: true, halted: true }));
  const relay = createMailboxSource({ root }).poll().relay;
  assert.equal(relay.paused, true);
  assert.equal(relay.halted, true);
});

test('relay: a lock is not running when its process is gone or unknown', (t) => {
  const root = tempMailbox(t);
  const gone = spawnSync(process.execPath, ['-e', '']).pid;
  const cases = [
    `${gone}`,
    `pid=${gone}`,
    JSON.stringify({ pid: process.pid, host: 'other-host.example' }),
    '0',
    '-1',
    'not a pid',
    '{ broken',
  ];
  for (const text of cases) {
    write(root, '.relay/relay.lock', text);
    assert.equal(createMailboxSource({ root }).poll().relay.running, false, text);
  }
  write(root, '.relay/relay.lock', `pid: ${process.pid}\nstarted: 2026-10-12\n`);
  assert.equal(createMailboxSource({ root }).poll().relay.running, true);
});

test('relay: a bad coordinator session id is ignored', (t) => {
  const root = tempMailbox(t);
  for (const value of ['not a session', `${SESSION}/agent`, 42, '']) {
    write(root, '.relay/coordinator.json', JSON.stringify({ session_id: value }));
    assert.equal(createMailboxSource({ root }).poll().relay.coordinatorKey, null, String(value));
  }
  write(root, '.relay/coordinator.json', '{ broken');
  assert.equal(createMailboxSource({ root }).poll().relay.coordinatorKey, null);
});

test('poll never throws', (t) => {
  const root = tempMailbox(t);
  const expectFailure = (state) => {
    assert.equal(state.ok, false);
    assert.equal(typeof state.error, 'string');
    assert.ok(state.error.length > 0);
    assert.deepEqual(state.tasks, []);
    assert.deepEqual(state.events, []);
    assert.equal(state.relay, null);
  };

  expectFailure(createMailboxSource({ root: null }).poll());
  expectFailure(createMailboxSource().poll());
  expectFailure(createMailboxSource({ root: path.join(root, 'missing') }).poll());
  const file = write(root, 'file.md', '# not a folder\n');
  expectFailure(createMailboxSource({ root: file }).poll());

  const broken = createMailboxSource({ root, now: () => { throw new Error('secret detail'); } }).poll();
  expectFailure(broken);
  assert.equal(broken.error.includes('secret detail'), false);

  // An empty folder is fine.
  const empty = createMailboxSource({ root, settings: undefined }).poll();
  assert.equal(empty.ok, true);
  assert.deepEqual(empty.tasks, []);
  assert.deepEqual(empty.events, []);
});

test('odd file contents do not break the poll', (t) => {
  const root = tempMailbox(t);
  write(root, 'QUEUE.md', Buffer.from([0xff, 0xfe, 0x00, 0x23, 0x0a, 0x80, 0x81]));
  write(root, 'tasks/T-1/status.md', '**Current state:**\n');
  write(root, 'tasks/T-1/assignment.md', 'No heading here.\n');
  write(root, 'tasks/T-1/workers/W1.run.json', '[1, 2, 3]');
  const state = createMailboxSource({ root }).poll();
  assert.equal(state.ok, true);
  assert.deepEqual(state.tasks, [{
    id: 'T-1',
    title: 'T-1',
    state: null,
    updatedAt: OLD,
    attention: [],
    workers: [{ id: 'W1', state: null, model: null, startedAt: null, finishedAt: null, worktree: null, sessionId: null }],
  }]);
});

test('a time range is not read as a zone offset', () => {
  const range = '2026-10-12 10:00-11:00 — Meeting';
  const stamp = parseStamp(range);
  assert.equal(stamp.at, local(2026, 10, 12, 10, 0));
  assert.equal(range.slice(stamp.index, stamp.index + stamp.length), '2026-10-12 10:00');
  // Real offsets still count: after the ISO "T", after seconds, or with a plus sign.
  assert.equal(parseStamp('2026-10-12T10:30-07:00').at, Date.UTC(2026, 9, 12, 17, 30));
  assert.equal(parseStamp('2026-10-12 10:30:00-07:00').at, Date.UTC(2026, 9, 12, 17, 30));
  assert.equal(parseStamp('2026-10-12 19:30+02:00').at, Date.UTC(2026, 9, 12, 17, 30));
});

test('parseStamp reads AM and PM', () => {
  assert.equal(parseStamp('2026-10-12 3:45 PM').at, local(2026, 10, 12, 15, 45));
  assert.equal(parseStamp('2026-10-12 12:05 am').at, local(2026, 10, 12, 0, 5));
  assert.equal(parseStamp('2026-10-12 12:05 p.m.').at, local(2026, 10, 12, 12, 5));
  assert.equal(parseStamp('2026-10-12 13:00 PM').at, local(2026, 10, 12, 13, 0));
  const text = 'Q2 — 2026-10-12 3:45 PM Pacific — BLOCKING';
  const stamp = parseStamp(text);
  assert.equal(text.slice(stamp.index, stamp.index + stamp.length), '2026-10-12 3:45 PM Pacific');
});

test('code blocks end only on a matching fence', (t) => {
  const root = tempMailbox(t);
  write(root, 'tasks/T-1/handoff.md', [
    '````md',
    '```',
    '## 2026-10-12 08:00 — inside the example',
    '```',
    '````',
    '## 2026-10-12 09:00 — After the example',
    '~~~',
    '```',
    '## 2026-10-12 09:30 — inside tildes',
    '~~~',
    '```js``` is not a fence',
    '## 2026-10-12 10:00 — Last',
    '',
  ].join('\n'));
  const { events } = createMailboxSource({ root }).poll();
  assert.deepEqual(events.map((e) => e.title), ['Last', 'After the example']);
});

test('a heading may hold U+2028', (t) => {
  const root = tempMailbox(t);
  write(root, 'QUEUE.md', '## 2026-10-12 09:00 — One two\n');
  const { events } = createMailboxSource({ root }).poll();
  assert.deepEqual(events.map((e) => e.title), ['One two']);
});

test('very long headings are parsed in linear time', (t) => {
  const root = tempMailbox(t);
  write(root, 'QUEUE.md', [
    `## 2026-10-12 09:00 — a${' *'.repeat(100_000)} b`,
    `## 2026-10-12 10:00 — c${' -'.repeat(100_000)} d`,
    `## e${' '.repeat(200_000)}f`,
    `## 2026-10-12 11:00 — Closed ${'#'.repeat(200_000)}`,
    '',
  ].join('\n'));
  const started = performance.now();
  const { events } = createMailboxSource({ root }).poll();
  assert.ok(performance.now() - started < 2000, 'took too long');
  assert.equal(events.length, 3);
  assert.equal(events[0].title, 'Closed');
});

test('a mailbox at a drive root still has a name', () => {
  const driveRoot = path.parse(os.tmpdir()).root;
  // The clock throws, so the poll stops before it reads anything in the drive root.
  const state = createMailboxSource({ root: driveRoot, now: () => { throw new Error('stop'); } }).poll();
  assert.equal(state.name, driveRoot);
  assert.notEqual(state.error, 'No mailbox folder is set.');
});

test('a failed poll does not leave stale results behind', (t) => {
  const root = tempMailbox(t);
  const file = write(root, 'tasks/T-1/handoff.md', '## 2026-10-12 10:00 — First\n');
  let boom = false;
  const settings = {
    get content() {
      if (boom) throw new Error('settings went away');
      return 'snippets';
    },
  };
  const source = createMailboxSource({ root, settings });
  assert.equal(source.poll().events.length, 1);

  fs.appendFileSync(file, '## 2026-10-12 11:00 — Second\n');
  boom = true;
  assert.equal(source.poll().ok, false);
  boom = false;
  assert.deepEqual(source.poll().events.map((e) => e.title), ['Second', 'First']);
});

test('relay run files with started, finished and models are read', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pleni-mailbox-run-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'tasks', 'T-20260101-01-demo', 'workers');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(root, 'tasks', 'T-20260101-01-demo', 'status.md'), '**Current state:** IN_PROGRESS\n');
  fs.writeFileSync(path.join(dir, 'W1.run.json'), '﻿' + JSON.stringify({
    started: '2026-01-01 09:00:00', finished: '2026-01-01 09:30:00', models: 'claude-opus-5-5[1m]', state: 'finished', worktree: '/home/ada/work/T-1/app',
  }));
  fs.writeFileSync(path.join(dir, 'W2.run.json'), JSON.stringify({ started: '2026-01-01 10:00:00', models: ['claude-sonnet-5-5'], state: 'running' }));
  const box = createMailboxSource({ root, settings: { content: 'snippets' }, now: () => Date.parse('2026-01-01T12:00:00') }).poll();
  const [w1, w2] = box.tasks[0].workers;
  assert.equal(w1.model, 'claude-opus-5-5[1m]');
  assert.equal(w1.startedAt, new Date(2026, 0, 1, 9, 0, 0).getTime());
  assert.equal(w1.finishedAt, new Date(2026, 0, 1, 9, 30, 0).getTime());
  assert.equal(w1.worktree, '/home/ada/work/T-1/app');
  assert.equal(w2.model, 'claude-sonnet-5-5');
  assert.equal(w2.finishedAt, null);
});
