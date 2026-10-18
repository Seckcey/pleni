import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULTS } from '../src/config.js';
import { createClaudeSource } from '../src/sources/claude.js';

const SID = '11111111-1111-4111-8111-111111111111';
const SID2 = '22222222-2222-4222-8222-222222222222';
const SID3 = '33333333-3333-4333-8333-333333333333';
const ENC = '-home-ada-project';
const CWD = '/home/ada/project';
const MIN = 60 * 1000;
const MiB = 1024 * 1024;
const NONE = { ...DEFAULTS, content: 'none' };

// ---- fixture helpers (everything is synthetic) ----

function setup(t, { settings = DEFAULTS } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pleni-claude-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'claude');
  const desktopRoot = path.join(dir, 'desktop');
  fs.mkdirSync(path.join(root, 'projects', ENC), { recursive: true });
  let time = Date.now();
  const env = {
    dir,
    root,
    desktopRoot,
    now: () => time,
    ago: (ms) => time - ms,
    advance: (ms) => {
      time += ms;
    },
  };
  env.source = createClaudeSource({ root, desktopRoot, settings, now: env.now });
  env.poll = () => env.source.poll();
  env.get = (key) => env.poll().sessions.find((s) => s.key === key);
  return env;
}

const iso = (ms) => new Date(ms).toISOString();
const jsonl = (records) => records.map((r) => `${JSON.stringify(r)}\n`).join('');
const sessionPath = (root, sid = SID) => path.join(root, 'projects', ENC, `${sid}.jsonl`);
const subDir = (root, sid = SID, run = null) =>
  path.join(root, 'projects', ENC, sid, 'subagents', ...(run ? ['workflows', run] : []));
const agentPath = (root, agentId, sid = SID, run = null) => path.join(subDir(root, sid, run), `agent-${agentId}.jsonl`);
const keyOf = (sid, agentId) => (agentId ? `claude:${sid}/${agentId}` : `claude:${sid}`);

function write(file, records) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, jsonl(records));
}

function append(file, records) {
  fs.appendFileSync(file, jsonl(records));
}

function writeMeta(root, agentId, meta, sid = SID, run = null) {
  const file = path.join(subDir(root, sid, run), `agent-${agentId}.meta.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(meta));
}

function writeDesktop(desktopRoot, sid, data) {
  const file = path.join(desktopRoot, 'claude-code-sessions', SID3, SID2, `local_${sid}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data));
  return file;
}

const common = (at) => ({ timestamp: iso(at), sessionId: SID, cwd: CWD, gitBranch: 'main', entrypoint: 'cli', version: '2.0.0' });
const user = (at, content, extra = {}) => ({ type: 'user', ...common(at), message: { role: 'user', content }, ...extra });
const assistant = (at, content, { id = `msg_${at}`, stop = 'end_turn', model = 'claude-opus-5-5', ...extra } = {}) => ({
  type: 'assistant',
  ...common(at),
  message: { id, type: 'message', role: 'assistant', model, content, stop_reason: stop },
  ...extra,
});
const text = (value) => ({ type: 'text', text: value });
const thinking = (value) => ({ type: 'thinking', thinking: value, signature: 'sig' });
const toolUse = (id, name, input) => ({ type: 'tool_use', id, name, input });
const toolResult = (id, content, extra = {}) => ({ type: 'tool_result', tool_use_id: id, content, ...extra });
const resultRecord = (at, id, content, extra = {}) => user(at, [toolResult(id, content)], extra);

// ---- discovery and refresh ----

test('finds sessions and sub-agents, and lists new files only on the 15 second refresh', (t) => {
  const env = setup(t);
  write(sessionPath(env.root), [
    { type: 'ai-title', aiTitle: 'Fix the login page', sessionId: SID },
    user(env.ago(5 * MIN), 'Please fix the login page'),
    assistant(env.ago(4 * MIN), [text('Fixed it.')]),
  ]);
  write(agentPath(env.root, 'a1'), [user(env.ago(5 * MIN), 'Look around'), assistant(env.ago(4 * MIN), [text('Looked.')])]);
  writeMeta(env.root, 'a1', { agentType: 'Explore', description: 'Look around', toolUseId: 'toolu_1', spawnDepth: 1 });
  const old = sessionPath(env.root, SID3);
  write(old, [user(env.ago(50 * 60 * MIN), 'old work')]);
  const twoDaysAgo = new Date(env.ago(48 * 60 * MIN));
  fs.utimesSync(old, twoDaysAgo, twoDaysAgo);

  const first = env.poll();
  assert.equal(first.ok, true);
  assert.equal(first.error, null);
  assert.equal(first.root, env.root);
  assert.deepEqual(first.sessions.map((s) => s.key), [keyOf(SID), keyOf(SID, 'a1')]);

  const main = first.sessions[0];
  assert.equal(main.platform, 'claude');
  assert.equal(main.id, SID);
  assert.equal(main.kind, 'session');
  assert.equal(main.parentKey, null);
  assert.equal(main.title, 'Fix the login page');
  assert.equal(main.titleSource, 'ai-title');
  assert.equal(main.cwd, CWD);
  assert.equal(main.branch, 'main');
  assert.equal(main.entrypoint, 'cli');
  assert.equal(main.model, 'claude-opus-5-5');
  assert.equal(main.startedAt, env.ago(5 * MIN));
  assert.equal(main.lastAt, env.ago(4 * MIN));
  assert.equal(main.status, 'ready');
  assert.equal(main.archived, false);

  const agent = first.sessions[1];
  assert.equal(agent.kind, 'agent');
  assert.equal(agent.id, 'a1');
  assert.equal(agent.parentKey, keyOf(SID));
  assert.equal(agent.title, 'Look around');
  assert.equal(agent.titleSource, 'description');

  write(sessionPath(env.root, SID2), [user(env.now(), 'Second session')]);
  env.advance(5000);
  assert.equal(env.poll().sessions.some((s) => s.id === SID2), false, 'not listed before the refresh');
  env.advance(10000);
  assert.equal(env.poll().sessions.some((s) => s.id === SID2), true, 'listed after 15 seconds');

  fs.rmSync(sessionPath(env.root, SID2));
  env.advance(15000);
  assert.equal(env.poll().sessions.some((s) => s.id === SID2), false, 'dropped when the file is gone');
});

test('reports a missing folder in plain words and never throws', (t) => {
  const env = setup(t);
  const none = createClaudeSource({ root: null, settings: DEFAULTS }).poll();
  assert.deepEqual([none.ok, none.sessions], [false, []]);
  assert.match(none.error, /folder/);

  const missing = createClaudeSource({ root: path.join(env.dir, 'nope'), settings: DEFAULTS }).poll();
  assert.equal(missing.ok, false);
  assert.match(missing.error, /could not find/);

  const file = path.join(env.dir, 'a-file');
  fs.writeFileSync(file, 'x');
  assert.equal(createClaudeSource({ root: file }).poll().ok, false);

  const broken = createClaudeSource({ root: env.root, now: () => { throw new Error('clock broke'); } }).poll();
  assert.equal(broken.ok, false);
  assert.equal(typeof broken.error, 'string');
  assert.doesNotMatch(broken.error, /clock broke/);

  assert.deepEqual(env.source.detail('claude:unknown', 0), { events: [], next: null });
  assert.deepEqual(env.source.detail(undefined), { events: [], next: null });
});

test('skips broken lines and odd field types without failing', (t) => {
  const env = setup(t, { settings: null });
  const file = sessionPath(env.root);
  fs.writeFileSync(
    file,
    [
      'not json',
      '[1,2,3]',
      JSON.stringify({ type: 'user', timestamp: 12, message: 'oops' }),
      JSON.stringify({ type: 'assistant', timestamp: 'never', message: { content: 5 } }),
      JSON.stringify({ type: 'assistant', timestamp: iso(env.ago(MIN)), message: { content: [null, 7, { type: 'tool_use', input: null }] } }),
      JSON.stringify({ type: 'user', timestamp: iso(env.ago(MIN)), toolUseResult: [], message: { content: [{ type: 'tool_result' }] } }),
      JSON.stringify({ type: 'custom-title', customTitle: 42 }),
      JSON.stringify(user(env.ago(MIN), 'still here')),
      '',
    ].join('\n'),
  );
  const res = env.poll();
  assert.equal(res.ok, true);
  const s = res.sessions[0];
  assert.equal(s.title, null);
  assert.equal(s.status, 'working');
  assert.equal(s.lastAt, env.ago(MIN));
});

// ---- incremental reading ----

test('reads only new bytes and waits for a partial last line', (t) => {
  const env = setup(t);
  const file = sessionPath(env.root);
  const done = JSON.stringify(assistant(env.ago(MIN), [text('All set.')]));
  write(file, [user(env.ago(2 * MIN), 'Start please')]);
  fs.appendFileSync(file, done.slice(0, 40));

  let s = env.get(keyOf(SID));
  assert.equal(s.status, 'working');
  assert.equal(s.lastText, null);

  fs.appendFileSync(file, done.slice(40));
  s = env.get(keyOf(SID));
  assert.equal(s.status, 'working', 'still no newline');

  fs.appendFileSync(file, '\n');
  s = env.get(keyOf(SID));
  assert.equal(s.status, 'ready');
  assert.equal(s.lastText, 'All set.');

  append(file, [user(env.now(), 'One more thing')]);
  s = env.get(keyOf(SID));
  assert.equal(s.status, 'working');
  assert.equal(s.lastAt, env.now());
});

function filler(fromAt, count, padBytes) {
  const pad = 'x'.repeat(padBytes);
  const records = [];
  for (let i = 0; i < count; i++) {
    const at = fromAt + i;
    records.push(assistant(at, [toolUse(`toolu_f${i}`, 'Read', { file_path: `/home/ada/project/f${i}.txt` })], { stop: 'tool_use' }));
    records.push(resultRecord(at, `toolu_f${i}`, pad));
  }
  return records;
}

test('follows the end of a 3 MB file that keeps growing', (t) => {
  const env = setup(t);
  const file = sessionPath(env.root);
  const start = env.ago(30 * MIN);
  write(file, [
    { type: 'ai-title', aiTitle: 'Big job', sessionId: SID },
    user(start, 'Do the big job'),
    ...filler(start + 1000, 1400, 2000),
    assistant(env.ago(2 * MIN), [text('Halfway there.')]),
  ]);
  assert.ok(fs.statSync(file).size > 3 * 1024 * 1024);

  let s = env.get(keyOf(SID));
  assert.equal(s.title, 'Big job');
  assert.equal(s.startedAt, start);
  assert.equal(s.status, 'ready');
  assert.equal(s.lastText, 'Halfway there.');

  append(file, [user(env.ago(MIN), 'Keep going'), ...filler(env.ago(MIN), 1400, 2000)]);
  append(file, [assistant(env.ago(1000), [toolUse('toolu_last', 'Bash', { command: 'npm test', description: 'Run the tests' })], { stop: 'tool_use' })]);
  s = env.get(keyOf(SID));
  assert.equal(s.status, 'working');
  assert.deepEqual(s.activity, { tool: 'Bash', detail: 'Run the tests', at: env.ago(1000) });
  assert.equal(s.lastText, 'Halfway there.');
});

test('scans the head once for a title that only appears near the start of a long file', (t) => {
  const env = setup(t);
  const start = env.ago(60 * MIN);
  const big = [user(start, 'Long work'), ...filler(start + 1000, 2200, 2000), assistant(env.ago(MIN), [text('Done.')])];
  write(sessionPath(env.root), [{ type: 'ai-title', aiTitle: 'Title near the head', sessionId: SID }, ...big]);
  write(sessionPath(env.root, SID2), [
    { type: 'ai-title', aiTitle: 'Old head title', sessionId: SID2 },
    ...big,
    { type: 'custom-title', customTitle: 'Named by you', sessionId: SID2 },
  ]);
  assert.ok(fs.statSync(sessionPath(env.root)).size > 4 * 1024 * 1024);

  const res = env.poll();
  const s = res.sessions.find((x) => x.id === SID);
  assert.equal(s.title, 'Title near the head');
  assert.equal(s.titleSource, 'ai-title');
  assert.equal(s.startedAt, start, 'start time comes from the head, not the tail');
  const named = res.sessions.find((x) => x.id === SID2);
  assert.equal(named.title, 'Named by you');
  assert.equal(named.titleSource, 'custom-title');

  append(sessionPath(env.root), [user(env.now(), 'more')]);
  assert.equal(env.get(keyOf(SID)).title, 'Title near the head', 'kept after later reads');
});

test('after more than 16 MiB of new lines, starts again near the end and keeps what it knew', (t) => {
  const env = setup(t);
  const file = sessionPath(env.root);
  const at = (m) => env.ago(m * MIN);
  write(file, [
    { type: 'ai-title', aiTitle: 'Night shift', sessionId: SID },
    user(at(300), 'Work through the night', { effort: 'high' }),
    assistant(at(299), [toolUse('tu1', 'Agent', { description: 'Check the logs' })], { stop: 'tool_use' }),
    resultRecord(at(290), 'tu1', 'Logs look fine.', { toolUseResult: { status: 'completed', agentId: 'a1' } }),
    assistant(at(289), [toolUse('tu2', 'Bash', { command: 'make', description: 'Build' })], { stop: 'tool_use' }),
  ]);
  write(agentPath(env.root, 'a1'), [user(at(299), 'Check the logs'), assistant(at(291), [text('Logs look fine.')])]);
  writeMeta(env.root, 'a1', { description: 'Check the logs', toolUseId: 'tu1' });

  const first = env.get(keyOf(SID));
  assert.equal(first.status, 'idle');
  assert.equal(first.links.length, 2);

  // The page was closed for hours. These lines would change the title, model and place if read.
  append(file, [
    { type: 'custom-title', customTitle: 'Lost in the middle', sessionId: SID },
    assistant(at(200), [text('Somewhere in the middle.')], { model: 'claude-middle', effort: 'low', cwd: '/home/ada/elsewhere', gitBranch: 'side' }),
  ]);
  fs.appendFileSync(file, jsonl(Array(17).fill({ type: 'progress', sessionId: SID, data: 'x'.repeat(MiB) })));
  // The newest line says nothing about the place or the model.
  append(file, [{ type: 'assistant', timestamp: iso(at(1)), message: { id: 'msg_end', role: 'assistant', content: [text('Caught up.')], stop_reason: 'end_turn' } }]);

  const read = t.mock.method(fs, 'readSync');
  const res = env.poll();
  const bytes = read.mock.calls.reduce((sum, call) => sum + call.result, 0);
  read.mock.restore();
  assert.ok(bytes < 5 * MiB, `read ${(bytes / MiB).toFixed(1)} MiB in one poll`);

  const s = res.sessions.find((x) => x.key === keyOf(SID));
  assert.equal(s.title, 'Night shift');
  assert.equal(s.titleSource, 'ai-title');
  assert.equal(s.cwd, CWD);
  assert.equal(s.branch, 'main');
  assert.equal(s.entrypoint, 'cli');
  assert.equal(s.model, 'claude-opus-5-5');
  assert.equal(s.effort, 'high');
  assert.equal(s.startedAt, at(300));
  assert.equal(s.lastAt, at(1));
  assert.equal(s.status, 'ready');
  assert.equal(s.activity.tool, null, 'the old open tool call is not kept');
  assert.equal(s.lastText, 'Caught up.');
  assert.deepEqual(s.links, first.links);
  assert.equal(res.sessions.find((x) => x.key === keyOf(SID, 'a1')).status, 'done');

  append(file, [user(env.now(), 'Next task')]);
  const next = env.get(keyOf(SID));
  assert.equal(next.status, 'working', 'reads new lines as usual afterwards');
  assert.equal(next.title, 'Night shift');
});

// ---- titles and desktop metadata ----

test('picks titles in order: custom or agent name, then AI title, then desktop, then sub-agent description', (t) => {
  const env = setup(t);
  write(sessionPath(env.root), [
    user(env.ago(MIN), 'hi'),
    { type: 'ai-title', aiTitle: 'AI one', sessionId: SID },
    { type: 'custom-title', customTitle: 'Custom', sessionId: SID },
    { type: 'ai-title', aiTitle: 'AI two', sessionId: SID },
    { type: 'agent-name', agentName: '  Agent   name  ', sessionId: SID },
  ]);
  write(sessionPath(env.root, SID2), [user(env.ago(MIN), 'hi'), { type: 'ai-title', aiTitle: `${'Long '.repeat(40)}end`, sessionId: SID2 }]);
  write(sessionPath(env.root, SID3), [user(env.ago(MIN), 'hi')]);
  writeDesktop(env.desktopRoot, SID3, { cliSessionId: SID3, title: 'From the desktop app' });
  writeDesktop(env.desktopRoot, SID2, { cliSessionId: SID2, title: 'Loses to the AI title' });

  const res = env.poll();
  const by = (sid) => res.sessions.find((s) => s.id === sid);
  assert.deepEqual([by(SID).title, by(SID).titleSource], ['Agent name', 'agent-name']);
  assert.equal(by(SID2).titleSource, 'ai-title');
  assert.ok(by(SID2).title.length <= 120);
  assert.ok(by(SID2).title.endsWith('…'));
  assert.deepEqual([by(SID3).title, by(SID3).titleSource], ['From the desktop app', 'desktop']);
});

test('reads desktop app metadata: listed keys only, cached by time, refreshed every 30 seconds', (t) => {
  const env = setup(t);
  write(sessionPath(env.root), [{ type: 'user', timestamp: iso(env.ago(MIN)), sessionId: SID, message: { role: 'user', content: 'hi' } }]);
  write(sessionPath(env.root, SID2), [user(env.ago(MIN), 'hi')]);
  const file = writeDesktop(env.desktopRoot, SID, {
    sessionId: 'local_x',
    cliSessionId: SID,
    title: 'Desktop title',
    titleSource: 'auto',
    model: 'claude-fable-5',
    effort: 'high',
    cwd: '\\\\?\\C:\\Users\\ada\\project',
    isArchived: true,
    lastActivityAt: env.ago(MIN),
    permissionMode: 'default',
  });
  const brokenDir = path.join(env.desktopRoot, 'claude-code-sessions', SID2, SID3);
  fs.mkdirSync(brokenDir, { recursive: true });
  fs.writeFileSync(path.join(brokenDir, `local_${SID2}.json`), '{ broken');

  let res = env.poll();
  assert.equal(res.ok, true);
  let s = res.sessions.find((x) => x.id === SID);
  assert.equal(s.title, 'Desktop title');
  assert.equal(s.model, 'claude-fable-5');
  assert.equal(s.effort, 'high');
  assert.equal(s.cwd, 'C:\\Users\\ada\\project');
  assert.equal(s.archived, true);
  assert.equal(res.sessions.find((x) => x.id === SID2).archived, false);

  fs.writeFileSync(file, JSON.stringify({ cliSessionId: SID, title: 'Renamed', isArchived: false }));
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(file, later, later);
  env.advance(20000);
  assert.equal(env.get(keyOf(SID)).title, 'Desktop title', 'not re-read before 30 seconds');
  env.advance(10000);
  s = env.get(keyOf(SID));
  assert.equal(s.title, 'Renamed');
  assert.equal(s.archived, false);
});

// ---- messages, errors and status ----

test('treats lines that share a message id as one message', (t) => {
  const env = setup(t);
  write(sessionPath(env.root), [
    user(env.ago(3 * MIN), 'Explain'),
    assistant(env.ago(2 * MIN), [thinking('hmm')], { id: 'msg_a', stop: null }),
    assistant(env.ago(2 * MIN), [text('Part one,')], { id: 'msg_a', stop: null }),
    assistant(env.ago(2 * MIN) + 10, [text('part two.')], { id: 'msg_a', stop: 'end_turn' }),
  ]);
  write(sessionPath(env.root, SID2), [
    user(env.ago(3 * MIN), 'Check'),
    assistant(env.ago(2 * MIN), [thinking('plan')], { id: 'msg_b', stop: 'tool_use' }),
    assistant(env.ago(2 * MIN), [text('Looking now.')], { id: 'msg_b', stop: 'tool_use' }),
    assistant(env.ago(2 * MIN), [toolUse('toolu_g', 'Grep', { pattern: 'TODO' })], { id: 'msg_b', stop: 'tool_use' }),
  ]);
  const res = env.poll();
  const one = res.sessions.find((s) => s.id === SID);
  assert.equal(one.status, 'ready');
  assert.equal(one.lastText, 'Part one, part two.');
  const two = res.sessions.find((s) => s.id === SID2);
  assert.equal(two.status, 'working');
  assert.equal(two.lastText, 'Looking now.');
  assert.deepEqual(two.activity, { tool: 'Grep', detail: 'TODO', at: env.ago(2 * MIN) });

  append(sessionPath(env.root), [assistant(env.ago(MIN), [text('In progress')], { id: 'msg_c', stop: null })]);
  assert.equal(env.get(keyOf(SID)).status, 'working', 'a message still being written');
});

test('marks a synthetic API error turn as an error', (t) => {
  const env = setup(t);
  write(sessionPath(env.root), [
    user(env.ago(3 * MIN), 'Go'),
    assistant(env.ago(2 * MIN), [text('API Error: overloaded')], { model: '<synthetic>', stop: 'stop_sequence', isApiErrorMessage: true }),
  ]);
  write(sessionPath(env.root, SID2), [
    user(env.ago(3 * MIN), 'Go'),
    assistant(env.ago(2 * MIN), [text('No response requested.')], { model: '<synthetic>', stop: 'stop_sequence', isApiErrorMessage: false }),
  ]);
  const res = env.poll();
  const failed = res.sessions.find((s) => s.id === SID);
  assert.equal(failed.status, 'error');
  assert.equal(failed.model, null, 'the synthetic model is not a real model');
  assert.equal(res.sessions.find((s) => s.id === SID2).status, 'ready');

  append(sessionPath(env.root), [user(env.ago(MIN), 'Try again')]);
  assert.equal(env.get(keyOf(SID)).status, 'working');
});

test('status follows the last turn: working, ready, idle, stale and interrupted', (t) => {
  const env = setup(t);
  const ids = {};
  const make = (name, records) => {
    const sid = `${String(Object.keys(ids).length + 1).padStart(8, '0')}-0000-4000-8000-000000000000`;
    ids[name] = sid;
    write(sessionPath(env.root, sid), records);
  };
  const bash = (id) => toolUse(id, 'Bash', { command: 'sleep 1' });
  make('prompted', [user(env.ago(MIN), 'Do it')]);
  make('toolWait', [user(env.ago(2 * MIN), 'Do it'), assistant(env.ago(MIN), [bash('t1')], { stop: 'tool_use' })]);
  make('openTool', [
    user(env.ago(3 * MIN), 'Do it'),
    assistant(env.ago(2 * MIN), [bash('t1'), bash('t2')], { stop: 'tool_use' }),
    resultRecord(env.ago(2 * MIN), 't1', 'ok'),
    { type: 'attachment', ...common(env.ago(MIN)), attachment: { type: 'queued_command' } },
  ]);
  make('ready', [user(env.ago(3 * MIN), 'Do it'), assistant(env.ago(2 * MIN), [text('Done')])]);
  make('readyAfterNoise', [
    user(env.ago(3 * MIN), 'Do it'),
    assistant(env.ago(2 * MIN), [text('Done')]),
    { type: 'system', subtype: 'turn_duration', ...common(env.ago(2 * MIN)) },
    user(env.ago(MIN), 'Caveat: local command', { isMeta: true }),
    user(env.ago(MIN), '<command-name>/model</command-name>'),
    user(env.ago(MIN), '<local-command-stdout>Set model</local-command-stdout>'),
    user(env.ago(MIN), '<bash-input>ls</bash-input>'),
    user(env.ago(MIN), '<bash-stdout>notes.md</bash-stdout><bash-stderr></bash-stderr>'),
  ]);
  make('oldReady', [user(env.ago(3 * 60 * MIN), 'Do it'), assistant(env.ago(2 * 60 * MIN), [text('Done')])]);
  make('stale', [user(env.ago(50 * MIN), 'Do it'), assistant(env.ago(40 * MIN), [bash('t1')], { stop: 'tool_use' })]);
  make('interrupted', [
    user(env.ago(3 * MIN), 'Do it'),
    assistant(env.ago(2 * MIN), [bash('t1')], { stop: 'tool_use' }),
    user(env.ago(MIN), [toolResult('t1', 'stopped', { is_error: true }), text('[Request interrupted by user for tool use]')]),
  ]);
  make('closedByTurnEnd', [
    user(env.ago(3 * MIN), 'Do it'),
    assistant(env.ago(2 * MIN), [bash('lost')], { stop: 'tool_use' }),
    assistant(env.ago(MIN), [text('Finished anyway')], { stop: 'end_turn' }),
  ]);

  const res = env.poll();
  const status = (name) => res.sessions.find((s) => s.id === ids[name]).status;
  assert.equal(status('prompted'), 'working');
  assert.equal(status('toolWait'), 'working');
  assert.equal(status('openTool'), 'working');
  assert.equal(status('ready'), 'ready');
  assert.equal(status('readyAfterNoise'), 'ready');
  assert.equal(status('oldReady'), 'idle');
  assert.equal(status('stale'), 'idle', 'an open tool use that went stale');
  assert.equal(status('interrupted'), 'idle');
  assert.equal(status('closedByTurnEnd'), 'ready');

  const open = res.sessions.find((s) => s.id === ids.openTool);
  assert.equal(open.activity.tool, 'Bash');
  assert.equal(open.lastAt, env.ago(MIN), 'attachments move lastAt');
  assert.deepEqual(res.sessions.find((s) => s.id === ids.ready).activity, { tool: null, detail: 'Done', at: env.ago(2 * MIN) });

  env.advance(11 * MIN);
  assert.equal(env.poll().sessions.find((s) => s.id === ids.ready).status, 'idle', 'ready only within activeMinutes');
});

// ---- activity, detail strings and privacy ----

const TOOL_INPUTS = [
  ['Bash', { command: 'rm -rf build', description: 'Clean the build folder' }, 'Clean the build folder'],
  ['Bash', { command: `echo ${'a'.repeat(120)}\necho second` }, `echo ${'a'.repeat(74)}…`],
  ['PowerShell', { command: '\n  Get-ChildItem\nmore' }, 'Get-ChildItem'],
  ['Read', { file_path: '/home/ada/project/src/app.js' }, 'app.js'],
  ['Edit', { file_path: 'C:\\Users\\ada\\project\\notes.md' }, 'notes.md'],
  ['Grep', { pattern: 'function\\s+main', path: '/home/ada/project' }, 'function\\s+main'],
  ['Agent', { description: 'Explore the code', prompt: 'long prompt' }, 'Explore the code'],
  ['WebFetch', { url: 'https://docs.example.com/page?q=1', prompt: 'read it' }, 'docs.example.com'],
  ['TodoWrite', { todos: [] }, null],
];

test('activity and drawer details come from tool inputs', (t) => {
  const env = setup(t);
  const at = env.ago(MIN);
  write(sessionPath(env.root), [
    user(env.ago(2 * MIN), 'Work'),
    ...TOOL_INPUTS.map(([name, input], i) => assistant(at, [toolUse(`toolu_${i}`, name, input)], { id: 'msg_tools', stop: 'tool_use' })),
  ]);
  const s = env.get(keyOf(SID));
  assert.equal(s.status, 'working');
  assert.deepEqual(s.activity, { tool: 'TodoWrite', detail: null, at });
  const tools = env.source.detail(keyOf(SID)).events.filter((e) => e.kind === 'tool');
  assert.deepEqual(tools.map((e) => [e.tool, e.text]), TOOL_INPUTS.map(([name, , want]) => [name, want]));
  assert.ok(tools.every((e) => e.text === null || e.text.length <= 140));
});

test("content 'none' shows no session text anywhere", (t) => {
  const env = setup(t, { settings: NONE });
  write(sessionPath(env.root), [
    user(env.ago(3 * MIN), 'A private prompt'),
    assistant(env.ago(2 * MIN), [thinking('private thoughts'), text('A private answer')], { id: 'm1', stop: 'tool_use' }),
    assistant(env.ago(2 * MIN), [toolUse('toolu_a', 'Agent', { description: 'Private task', prompt: 'p' })], { id: 'm1', stop: 'tool_use' }),
    resultRecord(env.ago(MIN), 'toolu_a', 'Private report', { toolUseResult: { status: 'completed', agentId: 'a1' } }),
    assistant(env.ago(MIN), [toolUse('toolu_b', 'Bash', { command: 'cat secret.txt', description: 'Read the secret' })], { stop: 'tool_use' }),
  ]);
  write(agentPath(env.root, 'a1'), [user(env.ago(2 * MIN), 'Private task'), assistant(env.ago(MIN), [text('Private report')])]);
  writeMeta(env.root, 'a1', { description: 'Private task', toolUseId: 'toolu_a' });

  const res = env.poll();
  const main = res.sessions.find((s) => s.key === keyOf(SID));
  assert.equal(main.lastText, null);
  assert.deepEqual(main.activity, { tool: 'Bash', detail: null, at: env.ago(MIN) });
  assert.equal(main.links.length, 2);
  assert.ok(main.links.every((l) => l.label === null));
  const events = env.source.detail(keyOf(SID)).events;
  assert.ok(events.length >= 5);
  assert.ok(events.every((e) => e.text === null));
  assert.deepEqual(events.filter((e) => e.tool).map((e) => e.tool), ['Agent', 'Agent', 'Bash']);
  const shown = JSON.stringify([res, events]);
  for (const secret of ['private prompt', 'private answer', 'private thoughts', 'Private report', 'secret']) {
    assert.equal(shown.includes(secret), false, secret);
  }
});

test('clips text by characters, also for huge texts', (t) => {
  const env = setup(t);
  const smile = '\u{1F600}';
  write(sessionPath(env.root), [user(env.ago(2 * MIN), 'Go'), assistant(env.ago(MIN), [text(smile.repeat(200))])]);
  write(sessionPath(env.root, SID2), [user(env.ago(2 * MIN), 'Go'), assistant(env.ago(MIN), [text(smile.repeat(512 * 1024))])]);
  const res = env.poll();
  const short = res.sessions.find((s) => s.id === SID).lastText;
  assert.equal(short, smile.repeat(200), '200 characters fit in 280');
  const long = Array.from(res.sessions.find((s) => s.id === SID2).lastText);
  assert.equal(long.length, 280);
  assert.equal(long.at(-1), '…');
  assert.ok(long.slice(0, -1).every((c) => c === smile));
});

// ---- sub-agents and links ----

test('sub-agents: meta files, nested parents, background and workflow agents, done and links', (t) => {
  const env = setup(t);
  const at = (m) => env.ago(m * MIN);
  write(sessionPath(env.root), [
    user(at(20), 'Plan the release'),
    assistant(at(19), [toolUse('tu1', 'Agent', { description: 'Explore the code', prompt: 'look' })], { stop: 'tool_use' }),
    resultRecord(at(15), 'tu1', [text('Explored: three modules need work.')], { toolUseResult: { status: 'completed', agentId: 'a1' } }),
    assistant(at(14), [toolUse('tu3', 'Agent', { description: 'Write docs', run_in_background: true })], { stop: 'tool_use' }),
    resultRecord(at(14), 'tu3', 'Launched', { toolUseResult: { status: 'async_launched', agentId: 'a3', isAsync: true } }),
    assistant(at(13), [toolUse('tu4', 'Task', { description: 'Run checks', run_in_background: true })], { stop: 'tool_use' }),
    resultRecord(at(13), 'tu4', 'Launched', { toolUseResult: { status: 'async_launched', agentId: 'a4', isAsync: true } }),
    assistant(at(12), [toolUse('tu5', 'SendMessage', { to: 'a3', summary: 'Add a FAQ', message: 'Please add a FAQ' })], { stop: 'tool_use' }),
    resultRecord(at(12), 'tu5', 'sent'),
    assistant(at(11), [toolUse('tu6', 'SendMessage', { to: 'Checker', message: 'Hurry up\nplease' })], { stop: 'tool_use' }),
    resultRecord(at(11), 'tu6', 'sent'),
    assistant(at(11), [toolUse('tu7', 'SendMessage', { to: 'nobody', message: 'hello' })], { stop: 'tool_use' }),
    resultRecord(at(11), 'tu7', 'not found', { toolUseResult: { success: false } }),
    assistant(at(6), [text('Waiting on the helpers.')]),
  ]);
  // a1: finished in the foreground; it started its own helper a2.
  write(agentPath(env.root, 'a1'), [
    user(at(19), 'look'),
    assistant(at(18), [toolUse('tu2', 'Agent', { description: 'Find tests' })], { stop: 'tool_use', model: 'claude-sonnet-5' }),
    resultRecord(at(17), 'tu2', 'Found 12 tests', { toolUseResult: { status: 'completed', agentId: 'a2' } }),
    assistant(at(16), [text('Explored: three modules need work.')], { model: 'claude-sonnet-5' }),
  ]);
  writeMeta(env.root, 'a1', { agentType: 'Explore', description: 'Explore the code', toolUseId: 'tu1', spawnDepth: 1, model: 'sonnet' });
  write(agentPath(env.root, 'a2'), [user(at(18), 'find'), assistant(at(17), [text('Found 12 tests')], { model: null })]);
  writeMeta(env.root, 'a2', { description: 'Find tests', toolUseId: 'tu2', spawnDepth: 2, parentAgentId: 'a1', model: 'haiku' });
  // a3: background, finished with a final report.
  write(agentPath(env.root, 'a3'), [user(at(14), 'docs'), assistant(at(9), [text('Docs written and FAQ added.')])]);
  writeMeta(env.root, 'a3', { description: 'Write docs', toolUseId: 'tu3' });
  // a4: background, still working; it has its own name.
  write(agentPath(env.root, 'a4'), [
    user(at(13), 'checks'),
    { type: 'agent-name', agentName: 'Checker', sessionId: SID },
    assistant(at(1), [toolUse('tu8', 'Bash', { command: 'npm test' })], { stop: 'tool_use' }),
  ]);
  writeMeta(env.root, 'a4', { description: 'Run checks', toolUseId: 'tu4' });
  // Workflow agents: labels come from the run's journal.
  const run = 'wf_run1';
  write(agentPath(env.root, 'w1', SID, run), [user(at(8), 'review'), assistant(at(7), [text('Review passed.')])]);
  writeMeta(env.root, 'w1', { description: 'meta words', workflowPhase: 'review' }, SID, run);
  write(agentPath(env.root, 'w2', SID, run), [user(at(7.5), 'build'), assistant(at(1), [toolUse('tu9', 'Bash', { command: 'make' })], { stop: 'tool_use' })]);
  write(path.join(subDir(env.root, SID, run), 'journal.jsonl'), [
    { type: 'launched' },
    { type: 'started', key: 'k1', agentId: 'w1', label: 'Review step', phase: 'review' },
    { type: 'started', key: 'k2', agentId: 'w2', label: 'Build step', phase: 'build' },
    { type: 'result', key: 'k1', agentId: 'w1', result: 'ok' },
  ]);

  const res = env.poll();
  const get = (id) => res.sessions.find((s) => s.key === keyOf(SID, id));
  assert.deepEqual(res.sessions.map((s) => s.key), [keyOf(SID), ...['a1', 'a2', 'a3', 'a4', 'w1', 'w2'].map((id) => keyOf(SID, id))]);

  const main = get(null);
  const a1 = get('a1');
  const a2 = get('a2');
  assert.equal(main.status, 'working', 'its turn ended, but its helpers a4 and w2 are still working');
  assert.equal(a1.parentKey, keyOf(SID));
  assert.equal(a2.parentKey, keyOf(SID, 'a1'), 'nested by parentAgentId');
  assert.equal(a1.status, 'done');
  assert.equal(a2.status, 'done');
  assert.equal(a1.model, 'claude-sonnet-5', 'records beat meta');
  assert.equal(a2.model, 'haiku', 'meta model as fallback');
  assert.equal(get('a3').status, 'done', 'background agent with a final text');
  assert.equal(get('a4').status, 'working');
  assert.equal(get('a4').title, 'Checker');
  assert.deepEqual([get('w1').title, get('w1').titleSource, get('w1').status], ['Review step', 'workflow', 'done']);
  assert.deepEqual([get('w2').title, get('w2').status, get('w2').parentKey], ['Build step', 'working', keyOf(SID)]);

  const link = (dir, other, label, atMs) => ({ at: atMs, dir, other: keyOf(SID, other), label });
  assert.deepEqual(main.links, [
    link('down', 'a1', 'Explore the code', at(19)),
    link('up', 'a1', 'Explored: three modules need work.', at(15)),
    link('down', 'a3', 'Write docs', at(14)),
    link('down', 'a4', 'Run checks', at(13)),
    link('down', 'a3', 'Add a FAQ', at(12)),
    link('down', 'a4', 'Hurry up', at(11)),
    link('up', 'a3', 'Docs written and FAQ added.', at(9)),
    link('down', 'w1', 'Review step', at(8)),
    link('down', 'w2', 'Build step', at(7.5)),
    link('up', 'w1', 'Review passed.', at(7)),
  ]);
  assert.deepEqual(a1.links, [link('down', 'a2', 'Find tests', at(18)), link('up', 'a2', 'Found 12 tests', at(17))]);
  assert.deepEqual(get('a3').links, []);
});

test('a sub-agent the parent heard back from is done, even when its file looks open', (t) => {
  const env = setup(t);
  const at = (m) => env.ago(m * MIN);
  write(sessionPath(env.root), [
    user(at(20), 'Go'),
    assistant(at(19), [toolUse('tu1', 'Agent', { description: 'Hand back' })], { stop: 'tool_use' }),
    resultRecord(at(16), 'tu1', 'Handed back.', { toolUseResult: { status: 'completed', agentId: 'a1' } }),
    assistant(at(15), [toolUse('tu2', 'Agent', { description: 'Stopped early' })], { stop: 'tool_use' }),
    user(at(13), [toolResult('tu2', 'Stopped', { is_error: true })]),
    assistant(at(12), [toolUse('tu3', 'Agent', { description: 'Asked again' })], { stop: 'tool_use' }),
    resultRecord(at(10), 'tu3', 'First answer.', { toolUseResult: { status: 'completed', agentId: 'a3' } }),
    assistant(at(2), [toolUse('tu4', 'SendMessage', { to: 'a3', summary: 'One more thing' })], { stop: 'tool_use' }),
  ]);
  // a1 ends with a hand-back tool call and its result, so its own file looks like an open turn.
  write(agentPath(env.root, 'a1'), [
    user(at(19), 'Hand back'),
    assistant(at(17), [text('All done.'), toolUse('hb1', 'SubagentHandback', { report: 'r' })], { stop: null }),
    resultRecord(at(17), 'hb1', 'ok'),
  ]);
  writeMeta(env.root, 'a1', { description: 'Hand back', toolUseId: 'tu1' });
  // a2 was stopped in the middle of a tool call.
  write(agentPath(env.root, 'a2'), [user(at(15), 'Stopped early'), assistant(at(14), [toolUse('b2', 'Bash', { command: 'sleep 99' })], { stop: 'tool_use' })]);
  writeMeta(env.root, 'a2', { description: 'Stopped early', toolUseId: 'tu2' });
  // a3 finished, then was asked again and is working once more.
  write(agentPath(env.root, 'a3'), [user(at(12), 'Asked again'), assistant(at(11), [text('First answer.')]), user(at(1), 'One more thing')]);
  writeMeta(env.root, 'a3', { description: 'Asked again', toolUseId: 'tu3' });

  const res = env.poll();
  const get = (id) => res.sessions.find((s) => s.key === keyOf(SID, id));
  assert.equal(get('a1').status, 'done');
  assert.equal(get('a2').status, 'done');
  assert.equal(get('a3').status, 'working', 'asked again after it finished');
});

test('a session that launched a background workflow is working while its workflow agents work', (t) => {
  const env = setup(t);
  const at = (m) => env.ago(m * MIN);
  const run = 'wf_run2';
  write(sessionPath(env.root), [
    user(at(40), 'Review the repo'),
    assistant(at(39), [toolUse('wf1', 'Workflow', { script: 'review' })], { stop: 'tool_use' }),
    resultRecord(at(39), 'wf1', 'Started in the background', { toolUseResult: { status: 'async_launched', taskId: 'task1', taskType: 'local_workflow' } }),
    assistant(at(26), [text('The review is running in the background.')]),
    { type: 'queue-operation', operation: 'enqueue', sessionId: SID },
  ]);
  write(agentPath(env.root, 'w1', SID, run), [user(at(20), 'check'), assistant(at(0.2), [toolUse('b1', 'Bash', { command: 'npm test' })], { stop: 'tool_use' })]);
  write(path.join(subDir(env.root, SID, run), 'journal.jsonl'), [{ type: 'started', key: 'k1', agentId: 'w1', label: 'Check step' }]);

  const res = env.poll();
  const get = (id) => res.sessions.find((s) => s.key === keyOf(SID, id));
  assert.equal(get('w1').status, 'working');
  assert.equal(get('w1').parentKey, keyOf(SID));
  assert.equal(get(null).status, 'working');

  // Once the workflow agent has gone quiet too, the session is idle again.
  env.advance(40 * MIN);
  const later = env.poll();
  assert.equal(later.sessions.find((s) => s.key === keyOf(SID)).status, 'idle');
});

test('a session waiting on a long foreground helper stays working after its own file goes quiet', (t) => {
  const env = setup(t);
  const at = (m) => env.ago(m * MIN);
  write(sessionPath(env.root), [
    user(at(45), 'Refactor billing'),
    assistant(at(40), [toolUse('tu1', 'Agent', { description: 'Refactor' })], { stop: 'tool_use' }),
  ]);
  write(agentPath(env.root, 'a1'), [user(at(40), 'Refactor'), assistant(at(0.1), [toolUse('b1', 'Edit', { file_path: '/home/ada/project/a.js' })], { stop: 'tool_use' })]);
  writeMeta(env.root, 'a1', { description: 'Refactor', toolUseId: 'tu1' });
  write(agentPath(env.root, 'a2'), [user(at(39), 'Nested'), assistant(at(0.1), [toolUse('b2', 'Bash', { command: 'ls' })], { stop: 'tool_use' })]);
  writeMeta(env.root, 'a2', { description: 'Nested', toolUseId: 'tu9', parentAgentId: 'a1' });

  const res = env.poll();
  const get = (id) => res.sessions.find((s) => s.key === keyOf(SID, id));
  assert.equal(get('a1').status, 'working');
  assert.equal(get(null).status, 'working', 'its own file is 40 minutes old, past staleMinutes');
});

test('working helpers do not hide an error or a finished helper above them', (t) => {
  const env = setup(t);
  const at = (m) => env.ago(m * MIN);
  write(sessionPath(env.root), [
    user(at(20), 'Go'),
    assistant(at(19), [toolUse('tu1', 'Agent', { description: 'Helper', run_in_background: true })], { stop: 'tool_use' }),
    resultRecord(at(19), 'tu1', 'Launched', { toolUseResult: { status: 'async_launched', agentId: 'a1', isAsync: true } }),
    assistant(at(18), [text('API Error: overloaded')], { model: '<synthetic>', isApiErrorMessage: true }),
  ]);
  write(agentPath(env.root, 'a1'), [user(at(19), 'Helper'), assistant(at(0.1), [toolUse('b1', 'Bash', { command: 'ls' })], { stop: 'tool_use' })]);
  writeMeta(env.root, 'a1', { description: 'Helper', toolUseId: 'tu1' });

  const res = env.poll();
  assert.equal(res.sessions.find((s) => s.key === keyOf(SID, 'a1')).status, 'working');
  assert.equal(res.sessions.find((s) => s.key === keyOf(SID)).status, 'error');
});

test('hand-back and structured-output tool results end a sub-agent turn', (t) => {
  const env = setup(t);
  const at = (m) => env.ago(m * MIN);
  write(sessionPath(env.root), [
    user(at(20), 'Go'),
    assistant(at(19), [toolUse('tu1', 'Agent', { description: 'Check in the background', run_in_background: true })], { stop: 'tool_use' }),
    resultRecord(at(19), 'tu1', 'Launched', { toolUseResult: { status: 'async_launched', agentId: 'b1', isAsync: true } }),
    assistant(at(18), [text('Started it.')]),
  ]);
  write(agentPath(env.root, 'b1'), [
    user(at(19), 'Check'),
    assistant(at(6), [text('All checks pass.'), toolUse('hb1', 'SubagentHandback', { report: 'r' })], { stop: null }),
    resultRecord(at(6), 'hb1', 'ok'),
  ]);
  writeMeta(env.root, 'b1', { description: 'Check in the background', toolUseId: 'tu1' });
  // h1's spawning call is older than the part of the parent file that was read.
  write(agentPath(env.root, 'h1'), [
    user(at(30), 'Old helper'),
    assistant(at(25), [text('Old helper done.'), toolUse('hb2', 'SubagentHandback', { report: 'r' })], { stop: null }),
    resultRecord(at(25), 'hb2', 'ok'),
  ]);
  writeMeta(env.root, 'h1', { description: 'Old helper', toolUseId: 'tu_not_seen' });
  const run = 'wf_run2';
  const schemaOut = (id, result) => [
    assistant(at(4), [toolUse(id, 'StructuredOutput', { verdict: 'ok' })], { stop: 'tool_use' }),
    user(at(4), [toolResult(id, result.text, { is_error: result.error })]),
  ];
  write(agentPath(env.root, 'w1', SID, run), [user(at(5), 'review'), ...schemaOut('so1', { text: 'Accepted', error: false })]);
  write(agentPath(env.root, 'w2', SID, run), [user(at(5), 'review'), ...schemaOut('so2', { text: 'Does not match the schema', error: true })]);
  write(path.join(subDir(env.root, SID, run), 'journal.jsonl'), [
    { type: 'started', agentId: 'w1', label: 'Reviewer one' },
    { type: 'started', agentId: 'w2', label: 'Reviewer two' },
    { type: 'result', agentId: 'w1', result: 'ok' },
  ]);

  const res = env.poll();
  const get = (id) => res.sessions.find((s) => s.key === keyOf(SID, id));
  assert.equal(get('b1').status, 'done');
  assert.equal(get('h1').status, 'done', 'handed back with no call in view');
  assert.deepEqual(get(null).links.find((l) => l.dir === 'up' && l.other === keyOf(SID, 'b1')), {
    at: at(6),
    dir: 'up',
    other: keyOf(SID, 'b1'),
    label: 'All checks pass.',
  });
  assert.equal(get('w1').status, 'done');
  assert.equal(get('w2').status, 'working', 'a rejected result means it tries again');
});

test('keeps at most 50 links, newest last', (t) => {
  const env = setup(t);
  const records = [user(env.ago(100 * MIN), 'go')];
  for (let i = 0; i < 60; i++) {
    records.push(assistant(env.ago((90 - i) * MIN), [toolUse(`s${i}`, 'SendMessage', { to: 'a1', summary: `note ${i}` })], { stop: 'tool_use' }));
    records.push(resultRecord(env.ago((90 - i) * MIN), `s${i}`, 'sent'));
  }
  write(sessionPath(env.root), records);
  write(agentPath(env.root, 'a1'), [user(env.ago(95 * MIN), 'hi')]);
  writeMeta(env.root, 'a1', { description: 'Helper' });
  const links = env.get(keyOf(SID)).links;
  assert.equal(links.length, 50);
  assert.equal(links.at(-1).label, 'note 59');
  assert.ok(links.every((l, i) => i === 0 || l.at >= links[i - 1].at));
});

// ---- side drawer ----

test('detail returns recent events with a byte cursor and never returns thinking text', (t) => {
  const env = setup(t);
  const file = sessionPath(env.root);
  write(file, [
    { type: 'ai-title', aiTitle: 'no timestamp, no event', sessionId: SID },
    user(env.ago(5 * MIN), 'Please check the build'),
    user(env.ago(5 * MIN), 'injected note', { isMeta: true }),
    assistant(env.ago(4 * MIN), [thinking('my hidden reasoning'), text('Checking.')], { id: 'm1', stop: 'tool_use' }),
    assistant(env.ago(4 * MIN), [toolUse('t1', 'Bash', { command: 'make', description: 'Build it' })], { id: 'm1', stop: 'tool_use' }),
    resultRecord(env.ago(3 * MIN), 't1', [text('build ok')]),
    assistant(env.ago(3 * MIN), [toolUse('t2', 'Read', { file_path: '/home/ada/project/missing.txt' })], { stop: 'tool_use' }),
    user(env.ago(2 * MIN), [toolResult('t2', 'File not found', { is_error: true })]),
    assistant(env.ago(MIN), [text('API Error: overloaded')], { model: '<synthetic>', stop: 'stop_sequence', isApiErrorMessage: true }),
  ]);
  env.poll();
  const first = env.source.detail(keyOf(SID));
  assert.deepEqual(
    first.events.map((e) => [e.kind, e.tool, e.text]),
    [
      ['user', null, 'Please check the build'],
      ['thinking', null, null],
      ['assistant', null, 'Checking.'],
      ['tool', 'Bash', 'Build it'],
      ['result', 'Bash', 'build ok'],
      ['tool', 'Read', 'missing.txt'],
      ['error', 'Read', 'File not found'],
      ['error', null, 'API Error: overloaded'],
    ],
  );
  assert.equal(first.events[0].at, env.ago(5 * MIN));
  assert.equal(JSON.stringify(first).includes('hidden reasoning'), false);
  assert.equal(first.next, fs.statSync(file).size);

  const partial = JSON.stringify(assistant(env.now(), [text('Second half')]));
  append(file, [user(env.now(), 'Next step')]);
  fs.appendFileSync(file, partial.slice(0, 30));
  const second = env.source.detail(keyOf(SID), first.next);
  assert.deepEqual(second.events.map((e) => e.text), ['Next step']);
  fs.appendFileSync(file, `${partial.slice(30)}\n`);
  const third = env.source.detail(keyOf(SID), String(second.next));
  assert.deepEqual(third.events.map((e) => e.text), ['Second half']);
  assert.equal(third.next, fs.statSync(file).size);

  const restart = env.source.detail(keyOf(SID), third.next + 1000);
  assert.equal(restart.events.length, 10, 'a cursor past the end starts over');
});

test('detail keeps only the newest 200 events and reads only the end of a big file', (t) => {
  const env = setup(t);
  const file = sessionPath(env.root);
  const pad = 'y'.repeat(9000);
  const records = [];
  for (let i = 0; i < 400; i++) records.push(user(env.ago(MIN) + i, `message ${i} ${pad}`));
  write(file, records);
  assert.ok(fs.statSync(file).size > 3 * 1024 * 1024);
  env.poll();
  const { events, next } = env.source.detail(keyOf(SID), 0);
  assert.equal(events.length, 200);
  assert.ok(events.at(-1).text.startsWith('message 399 '));
  assert.ok(events.every((e) => e.text.length <= 2000));
  assert.equal(next, fs.statSync(file).size);
});

// ---- needs you ----

test('an unanswered question or plan needs the person, even after the stale window', (t) => {
  const env = setup(t);
  write(sessionPath(env.root), [
    user(env.ago(50 * MIN), 'Plan the refund work'),
    assistant(env.ago(49 * MIN), [toolUse('q1', 'AskUserQuestion', { questions: [{ question: 'Which year?' }] })], { stop: 'tool_use' }),
  ]);
  assert.deepEqual(env.get(keyOf(SID)).needs, { kind: 'question', text: null, at: env.ago(49 * MIN) });
  append(sessionPath(env.root), [resultRecord(env.ago(1 * MIN), 'q1', '2026')]);
  assert.equal(env.get(keyOf(SID)).needs, null);
  append(sessionPath(env.root), [assistant(env.ago(30000), [toolUse('p1', 'ExitPlanMode', { plan: 'Do it' })], { stop: 'tool_use' })]);
  assert.equal(env.get(keyOf(SID)).needs.kind, 'plan');
});

test('a finished reply alone does not need the person', (t) => {
  const env = setup(t);
  write(sessionPath(env.root), [user(env.ago(3 * MIN), 'Hi'), assistant(env.ago(2 * MIN), [text('All done. Want anything else?')])]);
  const s = env.get(keyOf(SID));
  assert.equal(s.status, 'ready');
  assert.equal(s.needs, null);
});

test('a headless session never needs the person', (t) => {
  const env = setup(t);
  const headless = (r) => ({ ...r, entrypoint: 'sdk-cli' });
  write(sessionPath(env.root), [
    headless(user(env.ago(3 * MIN), 'Relay notice')),
    headless(assistant(env.ago(2 * MIN), [toolUse('q1', 'AskUserQuestion', { questions: [] })], { stop: 'tool_use' })),
  ]);
  assert.equal(env.get(keyOf(SID)).needs, null);
});

test('the desktop app\'s "blocked" summary counts only for the newest reply', (t) => {
  const env = setup(t);
  write(sessionPath(env.root), [
    user(env.ago(5 * MIN), 'Deploy it'),
    assistant(env.ago(4 * MIN), [text('I need the deploy key first.')], { uuid: 'u-last' }),
  ]);
  const summary = (uuid) => ({ cliSessionId: SID, title: 'Deploy', postTurnSummary: { status_category: 'blocked', status_detail: 'x', needs_action: 'Add the deploy key', summarizes_uuid: uuid } });
  writeDesktop(env.desktopRoot, SID, summary('u-last'));
  assert.deepEqual(env.get(keyOf(SID)).needs, { kind: 'blocked', text: 'Add the deploy key', at: env.ago(4 * MIN) });
  const file = writeDesktop(env.desktopRoot, SID, summary('u-older'));
  // A rewrite in the same millisecond keeps the old time; the reader caches by it.
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(file, later, later);
  env.advance(31000); // the desktop listing refreshes every 30 s
  assert.equal(env.get(keyOf(SID)).needs, null);
});

test('with content none a blocked summary keeps its kind but no text', (t) => {
  const env = setup(t, { settings: NONE });
  write(sessionPath(env.root), [user(env.ago(5 * MIN), 'Go'), assistant(env.ago(4 * MIN), [text('Stuck.')], { uuid: 'u1' })]);
  writeDesktop(env.desktopRoot, SID, { cliSessionId: SID, postTurnSummary: { status_category: 'blocked', needs_action: 'secret', summarizes_uuid: 'u1' } });
  assert.deepEqual(env.get(keyOf(SID)).needs, { kind: 'blocked', text: null, at: env.ago(4 * MIN) });
});

// ---- how full the context is ----

test('reads how full the context is, and counts squeezes from the running total of the newest one', (t) => {
  const env = setup(t);
  const file = sessionPath(env.root);
  const at = (m) => env.ago(m * MIN);
  const said = (m, usage) => {
    const r = assistant(at(m), [text('Working.')]);
    r.message.usage = usage;
    return r;
  };
  const squeeze = (m, compactMetadata) => ({ type: 'system', subtype: 'compact_boundary', ...common(at(m)), content: 'Conversation compacted', compactMetadata });
  write(file, [user(at(60), 'Start'), said(59, { input_tokens: 10, cache_creation_input_tokens: 2000, cache_read_input_tokens: 40000, output_tokens: 50 })]);
  assert.deepEqual(env.get(keyOf(SID)).context, { used: 42010, size: null, squeezes: 0, squeezesAtLeast: false, squeezedAt: null });

  // The third squeeze of a long history: its running total of dropped tokens says how many came before.
  append(file, [
    squeeze(30, { trigger: 'auto', preTokens: 780000, postTokens: 20000, cumulativeDroppedTokens: 2280000 }),
    said(29, { input_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 30000, output_tokens: 9 }),
  ]);
  let c = env.get(keyOf(SID)).context;
  assert.deepEqual(c, { used: 30005, size: 780000, squeezes: 3, squeezesAtLeast: false, squeezedAt: at(30) });

  // A squeeze by hand with no running total (an older Claude Code) counts once more, and does not
  // move where the next automatic one comes.
  append(file, [squeeze(10, { trigger: 'manual', preTokens: 100000, postTokens: 9000 })]);
  c = env.get(keyOf(SID)).context;
  assert.equal(c.squeezes, 4);
  assert.equal(c.size, 780000);
  assert.equal(c.used, 9000);
});
