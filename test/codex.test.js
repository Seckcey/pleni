import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import v8 from 'node:v8';
import vm from 'node:vm';
import { cleanSettings } from '../src/config.js';
import { createCodexSource } from '../src/sources/codex.js';

const MiB = 1024 * 1024;
const MINUTE = 60 * 1000;
const T0 = Math.floor(Date.now() / 1000) * 1000;

const MAIN = '0199a000-0000-7000-8000-000000000001';
const CHILD = '0199a000-0000-7000-8000-000000000002';
const OTHER = '0199a000-0000-7000-8000-000000000003';
const GUARD = '0199a000-0000-7000-8000-000000000004';
const STRANGER = '0199a000-0000-7000-8000-0000000000ff';
const idAt = (n) => `0199b000-0000-7000-8000-${String(n).padStart(12, '0')}`;

// ---- fixture helpers ----

function codexHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pleni-codex-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const iso = (ms) => new Date(ms).toISOString();
const line = (record) => `${JSON.stringify(record)}\n`;

function rollout(root, id, { day = '2026/10/12', archived = false, meta = {}, records = [], mtime = T0 - MINUTE, at = T0 - 30 * MINUTE } = {}) {
  const dir = archived ? path.join(root, 'archived_sessions') : path.join(root, 'sessions', ...day.split('/'));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-2026-10-12T09-00-00-${id}.jsonl`);
  const head = {
    timestamp: iso(at),
    ordinal: 0,
    type: 'session_meta',
    payload: {
      id,
      timestamp: iso(at),
      cwd: '/home/ada/project',
      originator: 'codex_cli_rs',
      cli_version: '1.0.0',
      git: { branch: 'main' },
      ...meta,
    },
  };
  fs.writeFileSync(file, [head, ...records].map(line).join(''));
  setMtime(file, mtime);
  return file;
}

function setMtime(file, ms) {
  fs.utimesSync(file, ms / 1000, ms / 1000);
}

const append = (file, ...records) => fs.appendFileSync(file, records.map(line).join(''));

const rec = (type, ms, payload, ordinal) => ({ timestamp: iso(ms), ...(ordinal === undefined ? {} : { ordinal }), type, payload });
const started = (ms, turn = 't1', ord) => rec('event_msg', ms, { type: 'task_started', turn_id: turn }, ord);
const completed = (ms, turn = 't1', extra = {}, ord) =>
  rec('event_msg', ms, { type: 'task_complete', turn_id: turn, last_agent_message: null, ...extra }, ord);
const aborted = (ms, turn = 't1') => rec('event_msg', ms, { type: 'turn_aborted', turn_id: turn, reason: 'interrupted' });
const context = (ms, model, effort, ord) => rec('turn_context', ms, { model, effort, cwd: '/home/ada/project' }, ord);
const say = (ms, text, ord) => rec('response_item', ms, { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }, ord);
const ask = (ms, text) => rec('response_item', ms, { type: 'message', role: 'user', content: [{ type: 'input_text', text }] });
const think = (ms) => rec('response_item', ms, { type: 'reasoning', summary: [], encrypted_content: 'zz' });
const call = (ms, name, args, callId, ord) =>
  rec('response_item', ms, { type: 'function_call', name, arguments: JSON.stringify(args), call_id: callId }, ord);
const exec = (ms, input, callId) =>
  rec('response_item', ms, { type: 'custom_tool_call', name: 'exec', input, call_id: callId, status: 'completed' });
const output = (ms, callId, text, type = 'function_call_output') => rec('response_item', ms, { type, call_id: callId, output: text });
const subAgent = (ms, kind, threadId, agentPath) =>
  rec('event_msg', ms, {
    type: 'item_completed',
    thread_id: MAIN,
    turn_id: 't1',
    item: { type: 'SubAgentActivity', id: 'x', kind, agent_thread_id: threadId, agent_path: agentPath },
  });

function childMeta(extra = {}) {
  return {
    parent_thread_id: MAIN,
    session_id: MAIN,
    agent_nickname: 'Scout',
    agent_path: '/root/scout',
    subagent_history_start_ordinal: 5,
    source: {
      subagent: { thread_spawn: { parent_thread_id: MAIN, depth: 1, agent_path: '/root/scout', agent_nickname: 'Scout', agent_role: null } },
    },
    ...extra,
  };
}

function open(root, { content = 'snippets', window } = {}) {
  const clock = { now: T0 };
  const settings = cleanSettings({ content, window });
  const source = createCodexSource({ root, settings, now: () => clock.now });
  const poll = () => {
    const result = source.poll();
    assert.equal(result.ok, true, result.error);
    return result;
  };
  const session = (id) => poll().sessions.find((s) => s.id === id);
  return { clock, source, poll, session };
}

// ---- discovery ----

test('finds rollouts in every day folder and in archived_sessions', (t) => {
  const root = codexHome(t);
  rollout(root, idAt(1), { day: '2026/10/12' });
  rollout(root, idAt(2), { day: '2026/09/01', mtime: T0 - 2 * 60 * MINUTE }); // old folder, still being written
  rollout(root, idAt(3), { day: '2026/09/01', mtime: T0 - 48 * 60 * MINUTE }); // older than recentHours
  rollout(root, idAt(4), { archived: true });
  fs.writeFileSync(path.join(root, 'sessions', '2026', '10', '12', 'notes.txt'), 'hello\n');
  fs.writeFileSync(path.join(root, 'sessions', '2026', '10', '12', 'rollout-no-id.jsonl'), '{}\n');

  const { sessions, root: reported } = open(root).poll();
  assert.equal(reported, root);
  assert.deepEqual(sessions.map((s) => s.id), [idAt(1), idAt(2), idAt(4)]);
  assert.deepEqual(sessions.map((s) => s.archived), [false, false, true]);
  assert.equal(sessions[0].key, `codex:${idAt(1)}`);
  assert.equal(sessions[0].platform, 'codex');
});

test('keeps only the newest 300 rollouts', (t) => {
  const root = codexHome(t);
  for (let n = 1; n <= 305; n++) rollout(root, idAt(n), { mtime: T0 - n * 1000 });
  const ids = open(root).poll().sessions.map((s) => s.id);
  assert.equal(ids.length, 300);
  for (let n = 301; n <= 305; n++) assert.ok(!ids.includes(idAt(n)), `${n} should be left out`);
  assert.ok(ids.includes(idAt(300)));
});

test('looks for new rollout files every 30 seconds', (t) => {
  const root = codexHome(t);
  rollout(root, idAt(1));
  const { clock, poll } = open(root);
  assert.equal(poll().sessions.length, 1);

  rollout(root, idAt(2), { mtime: T0 });
  clock.now = T0 + 10 * 1000;
  assert.equal(poll().sessions.length, 1);
  clock.now = T0 + 31 * 1000;
  assert.equal(poll().sessions.length, 2);
});

test('a missing Codex folder is reported, not thrown', (t) => {
  const root = codexHome(t);
  const gone = createCodexSource({ root: path.join(root, 'nope'), settings: cleanSettings({}) }).poll();
  assert.equal(gone.ok, false);
  assert.match(gone.error, /could not find/);
  assert.deepEqual(gone.sessions, []);

  const unset = createCodexSource({ root: null, settings: cleanSettings({}) }).poll();
  assert.equal(unset.ok, false);
  assert.equal(typeof unset.error, 'string');
});

test('a folder with no sessions yet is fine', (t) => {
  const root = codexHome(t);
  const result = open(root).poll();
  assert.deepEqual(result.sessions, []);
});

// ---- session_meta ----

test('reads a session_meta head line that is several megabytes long', (t) => {
  const root = codexHome(t);
  rollout(root, MAIN, {
    meta: { cwd: '/home/ada/big', git: { branch: 'feature/x' }, originator: 'codex_vscode', base_instructions: { text: 'x'.repeat(5 * MiB) } },
    records: [
      context(T0 - 5 * MINUTE, 'gpt-test', 'high'),
      started(T0 - 5 * MINUTE),
      say(T0 - 4 * MINUTE, 'All set.'),
      completed(T0 - 3 * MINUTE),
    ],
  });
  const s = open(root).session(MAIN);
  assert.equal(s.cwd, '/home/ada/big');
  assert.equal(s.branch, 'feature/x');
  assert.equal(s.entrypoint, 'codex_vscode');
  assert.equal(s.startedAt, T0 - 30 * MINUTE);
  assert.equal(s.lastAt, T0 - 3 * MINUTE);
  assert.equal(s.model, 'gpt-test');
  assert.equal(s.status, 'ready');
  assert.equal(s.lastText, 'All set.');
  assert.equal(s.kind, 'session');
  assert.equal(s.parentKey, null);
});

test('only the session_meta fields Pleni uses are kept in memory', (t) => {
  v8.setFlagsFromString('--expose-gc');
  const gc = vm.runInNewContext('gc');
  const root = codexHome(t);
  const big = { text: 'x'.repeat(MiB) };
  for (let n = 1; n <= 40; n++) rollout(root, idAt(n), { meta: { base_instructions: big } });
  gc();
  const before = process.memoryUsage().heapUsed;
  const { source } = open(root);
  source.poll();
  gc();
  const held = process.memoryUsage().heapUsed - before;
  assert.ok(held < 16 * MiB, `the source holds ${Math.round(held / MiB)} MiB`);
  const s = source.poll().sessions;
  assert.equal(s.length, 40);
  assert.equal(s[0].cwd, '/home/ada/project');
  assert.equal(s[0].branch, 'main');
});

test('\\\\?\\ prefixes are removed from cwd', (t) => {
  const root = codexHome(t);
  rollout(root, idAt(1), { meta: { cwd: '\\\\?\\C:\\Users\\ada\\project' } });
  rollout(root, idAt(2), { meta: { cwd: '\\\\?\\UNC\\server\\share\\ada' } });
  const { poll } = open(root);
  const [a, b] = poll().sessions;
  assert.equal(a.cwd, 'C:\\Users\\ada\\project');
  assert.equal(b.cwd, '\\\\server\\share\\ada');
});

// ---- sub-agents and reviewers ----

test('a sub-agent skips the history it inherited from its parent', (t) => {
  const root = codexHome(t);
  rollout(root, CHILD, {
    meta: childMeta(),
    records: [
      context(T0 - 20 * MINUTE, 'parent-model', 'xhigh', 1),
      started(T0 - 20 * MINUTE, 'p1', 2),
      say(T0 - 19 * MINUTE, 'parent words', 3),
      call(T0 - 19 * MINUTE, 'exec_command', { cmd: 'parent command' }, 'p-call', 4),
      context(T0 - 3 * MINUTE, 'gpt-test-mini', 'low', 5),
      started(T0 - 3 * MINUTE, 'c1', 6),
      say(T0 - 2 * MINUTE, 'child words', 7),
      completed(T0 - 2 * MINUTE, 'c1', { last_agent_message: 'child done' }, 8),
    ],
  });
  const { session, source } = open(root);
  const s = session(CHILD);
  assert.equal(s.kind, 'agent');
  assert.equal(s.parentKey, `codex:${MAIN}`);
  assert.equal(s.title, 'Scout');
  assert.equal(s.titleSource, 'agent_nickname');
  assert.equal(s.model, 'gpt-test-mini');
  assert.equal(s.effort, 'low');
  assert.equal(s.lastText, 'child done');
  assert.equal(s.status, 'ready');
  assert.equal(s.activity, null);

  const texts = source.detail(`codex:${CHILD}`).events.map((e) => e.text);
  assert.ok(texts.includes('child words'));
  assert.ok(!texts.includes('parent words'));
});

test('automatic reviewers are marked as reviewers', (t) => {
  const root = codexHome(t);
  rollout(root, GUARD, { meta: { parent_thread_id: MAIN, source: { subagent: { other: 'guardian' } } } });
  rollout(root, OTHER, { meta: { parent_thread_id: MAIN }, records: [context(T0 - MINUTE, 'codex-auto-review', 'low')] });
  rollout(root, MAIN);
  const { poll } = open(root);
  const byId = Object.fromEntries(poll().sessions.map((s) => [s.id, s]));
  assert.equal(byId[GUARD].kind, 'reviewer');
  assert.equal(byId[GUARD].parentKey, `codex:${MAIN}`);
  assert.equal(byId[GUARD].title, null);
  assert.equal(byId[OTHER].kind, 'reviewer');
  assert.equal(byId[MAIN].kind, 'session');
});

test('model and effort come from the latest turn_context', (t) => {
  const root = codexHome(t);
  const file = rollout(root, MAIN, { records: [context(T0 - 9 * MINUTE, 'gpt-old', 'low'), context(T0 - 8 * MINUTE, 'gpt-new', 'high')] });
  const { session } = open(root);
  assert.equal(session(MAIN).model, 'gpt-new');
  assert.equal(session(MAIN).effort, 'high');

  append(file, context(T0 - 7 * MINUTE, 'gpt-plain'));
  assert.equal(session(MAIN).model, 'gpt-plain');
  assert.equal(session(MAIN).effort, null);
});

// ---- turns and status ----

test('turn status: working, stale, ready, old, error, aborted', (t) => {
  const root = codexHome(t);
  rollout(root, idAt(1), { records: [started(T0 - MINUTE)] });
  rollout(root, idAt(2), { records: [started(T0 - 40 * MINUTE)] });
  rollout(root, idAt(3), { records: [started(T0 - 5 * MINUTE), completed(T0 - 4 * MINUTE)] });
  rollout(root, idAt(4), { records: [started(T0 - 25 * MINUTE), completed(T0 - 20 * MINUTE)] });
  const failure = { error: { message: 'Quota reached', codex_error_info: 'other' } };
  rollout(root, idAt(5), { records: [started(T0 - 2 * MINUTE), completed(T0 - MINUTE, 't1', failure)] });
  rollout(root, idAt(6), { records: [started(T0 - 3 * MINUTE), aborted(T0 - 2 * MINUTE)] });
  rollout(root, idAt(7), { records: [started(T0 - 3 * MINUTE, 'a'), started(T0 - 2 * MINUTE, 'b'), completed(T0 - MINUTE, 'a')] });
  rollout(root, idAt(8));

  const status = Object.fromEntries(open(root).poll().sessions.map((s) => [s.id, s.status]));
  assert.deepEqual(status, {
    [idAt(1)]: 'working',
    [idAt(2)]: 'idle',
    [idAt(3)]: 'ready',
    [idAt(4)]: 'idle',
    [idAt(5)]: 'error',
    [idAt(6)]: 'ready',
    [idAt(7)]: 'working',
    [idAt(8)]: 'idle',
  });
});

test('the stale and active windows come from settings', (t) => {
  const root = codexHome(t);
  rollout(root, idAt(1), { records: [started(T0 - 40 * MINUTE)] });
  rollout(root, idAt(2), { records: [completed(T0 - 20 * MINUTE)] });
  const status = Object.fromEntries(
    open(root, { window: { staleMinutes: 60, activeMinutes: 30 } }).poll().sessions.map((s) => [s.id, s.status]),
  );
  assert.deepEqual(status, { [idAt(1)]: 'working', [idAt(2)]: 'ready' });
});

test('a sub-agent is done once its parent records it completed', (t) => {
  const root = codexHome(t);
  const parent = rollout(root, MAIN, { records: [started(T0 - 10 * MINUTE, 'm1')] });
  const child = rollout(root, CHILD, {
    meta: childMeta(),
    records: [started(T0 - 5 * MINUTE, 'c1', 5), completed(T0 - 3 * MINUTE, 'c1', { last_agent_message: 'found it' }, 6)],
  });
  const { session, clock } = open(root);
  assert.equal(session(CHILD).status, 'ready');

  append(parent, subAgent(T0 - 2 * MINUTE, 'completed', CHILD, '/root/scout'));
  assert.equal(session(CHILD).status, 'done');

  // A follow-up starts a new turn after the completion: working again.
  clock.now = T0 + MINUTE;
  append(child, started(T0 + MINUTE, 'c2', 7));
  assert.equal(session(CHILD).status, 'working');

  append(child, completed(T0 + 2 * MINUTE, 'c2', {}, 8));
  append(parent, subAgent(T0 + 2 * MINUTE, 'completed', CHILD, '/root/scout'));
  clock.now = T0 + 3 * MINUTE;
  assert.equal(session(CHILD).status, 'done');
});

test('a turn that began before the read window still counts as open', (t) => {
  const root = codexHome(t);
  rollout(root, MAIN, {
    records: [
      context(T0 - 3 * MINUTE, 'gpt-early', 'medium'),
      started(T0 - 2 * MINUTE),
      exec(T0 - 2 * MINUTE, 'cat big.log', 'c1'),
      output(T0 - 2 * MINUTE, 'c1', 'y'.repeat(5 * MiB), 'custom_tool_call_output'),
      exec(T0 - MINUTE, 'npm test', 'c2'),
    ],
  });
  const s = open(root).session(MAIN);
  assert.equal(s.status, 'working');
  assert.deepEqual(s.activity, { tool: 'exec', detail: 'npm test', at: T0 - MINUTE });
  // The turn_context is outside the tail, so it is found near the start of the file.
  assert.equal(s.model, 'gpt-early');
  assert.equal(s.effort, 'medium');
});

test('after a long pause, a file that grew a lot is read again from near its end', (t) => {
  const root = codexHome(t);
  const file = rollout(root, MAIN, {
    records: [
      context(T0 - 20 * MINUTE, 'gpt-test', 'high'),
      started(T0 - 20 * MINUTE, 't1'),
      call(T0 - 19 * MINUTE, 'spawn_agent', { task_name: 'scout' }, 's1'),
    ],
  });
  const { session } = open(root);
  assert.equal(session(MAIN).links.length, 1);

  // While nobody polls, about 20 MiB arrive. The message lies far from the end, so it is skipped.
  append(file, call(T0 - 18 * MINUTE, 'send_message', { target: '/root/gap' }, 'g1'));
  for (let n = 0; n < 20; n++) append(file, output(T0 - 10 * MINUTE, `f${n}`, 'y'.repeat(MiB)));
  append(file, completed(T0 - 5 * MINUTE, 't1'), started(T0 - MINUTE, 't2'), exec(T0 - MINUTE, 'npm test', 'c1'));

  const s = session(MAIN);
  assert.deepEqual(s.links.map((link) => link.other), ['path:/root/scout']);
  assert.equal(s.status, 'working');
  assert.deepEqual(s.activity, { tool: 'exec', detail: 'npm test', at: T0 - MINUTE });
  assert.equal(s.model, 'gpt-test');
  assert.equal(s.startedAt, T0 - 30 * MINUTE);
});

// ---- activity and text ----

test('an open tool call is the activity until its output arrives', (t) => {
  const root = codexHome(t);
  const file = rollout(root, MAIN, { records: [started(T0 - 2 * MINUTE), exec(T0 - MINUTE, '\n  npm   test \nnpm run lint', 'c1')] });
  const { session } = open(root);
  assert.deepEqual(session(MAIN).activity, { tool: 'exec', detail: 'npm test', at: T0 - MINUTE });

  append(file, output(T0 - MINUTE, 'c1', 'ok', 'custom_tool_call_output'));
  assert.equal(session(MAIN).activity, null);
  assert.equal(session(MAIN).status, 'working');

  append(file, call(T0 - MINUTE, 'shell', { command: ['bash', '-lc', 'ls'], description: 'List the files' }, 'c2'));
  assert.deepEqual(session(MAIN).activity, { tool: 'shell', detail: 'List the files', at: T0 - MINUTE });

  // A closed turn leaves no activity behind.
  append(file, completed(T0 - MINUTE));
  assert.equal(session(MAIN).activity, null);
});

test('tool details use file names, patterns, agents and host names', (t) => {
  const root = codexHome(t);
  rollout(root, MAIN, {
    records: [
      started(T0 - 2 * MINUTE),
      call(T0 - MINUTE, 'read_file', { file_path: 'C:\\Users\\ada\\project\\src\\main.js' }, 'a'),
      call(T0 - MINUTE, 'grep', { pattern: 'TODO' }, 'b'),
      call(T0 - MINUTE, 'spawn_agent', { task_name: 'scout', message: 'look around' }, 'c'),
      call(T0 - MINUTE, 'fetch', { url: 'https://example.com/a/b?c=d' }, 'd'),
      call(T0 - MINUTE, 'shell', { cmd: 'x'.repeat(200) }, 'e'),
      call(T0 - MINUTE, 'mystery', { other: 1 }, 'f'),
      rec('response_item', T0 - MINUTE, {
        type: 'custom_tool_call',
        name: 'apply_patch',
        input: '*** Begin Patch\n*** Update File: /home/ada/project/README.md\n',
        call_id: 'g',
      }),
    ],
  });
  const tools = open(root).source;
  tools.poll();
  const details = tools.detail(`codex:${MAIN}`).events.filter((e) => e.kind === 'tool').map((e) => e.text);
  assert.deepEqual(details.slice(0, 4), ['main.js', 'TODO', 'scout', 'example.com']);
  assert.equal(details[4].length, 80);
  assert.ok(details[4].endsWith('…'));
  assert.equal(details[5], null);
  assert.equal(details[6], 'README.md');
});

test('lastText prefers the final answer and collapses whitespace', (t) => {
  const root = codexHome(t);
  const file = rollout(root, MAIN, { records: [started(T0 - 3 * MINUTE), say(T0 - 3 * MINUTE, 'Working   on\n\nit')] });
  const { session } = open(root);
  assert.equal(session(MAIN).lastText, 'Working on it');

  append(file, completed(T0 - 2 * MINUTE, 't1', { last_agent_message: 'All  done\n\nnow' }));
  assert.equal(session(MAIN).lastText, 'All done now');

  append(file, started(T0 - MINUTE, 't2'), say(T0 - MINUTE, 'z'.repeat(400)));
  const long = session(MAIN).lastText;
  assert.equal(long.length, 280);
  assert.ok(long.endsWith('…'));
});

test('content "none" hides text, details and labels', (t) => {
  const root = codexHome(t);
  rollout(root, MAIN, {
    records: [started(T0 - 2 * MINUTE), say(T0 - 2 * MINUTE, 'secret words'), call(T0 - MINUTE, 'spawn_agent', { task_name: 'scout' }, 'c1')],
  });
  const { session, source } = open(root, { content: 'none' });
  const s = session(MAIN);
  assert.equal(s.lastText, null);
  assert.deepEqual(s.activity, { tool: 'spawn_agent', detail: null, at: T0 - MINUTE });
  assert.equal(s.links[0].label, null);
  assert.ok(source.detail(`codex:${MAIN}`).events.every((e) => e.text === null));
});

test('U+2028 and U+2029 inside JSON strings do not split records', (t) => {
  const root = codexHome(t);
  const text = 'line one\u2028line two\u2029end';
  const file = rollout(root, MAIN, { records: [started(T0 - 2 * MINUTE), say(T0 - 2 * MINUTE, text), completed(T0 - MINUTE)] });
  assert.ok(fs.readFileSync(file, 'utf8').includes('\u2028'), 'the fixture holds a raw U+2028');
  const { session, source } = open(root);
  const s = session(MAIN);
  assert.equal(s.lastText, 'line one line two end');
  assert.equal(s.status, 'ready');
  assert.deepEqual(source.detail(`codex:${MAIN}`).events.map((e) => e.text), [text]);
});

// ---- titles ----

test('titles come from session_index.jsonl, the last line per id wins', (t) => {
  const root = codexHome(t);
  rollout(root, MAIN);
  rollout(root, CHILD, { meta: childMeta() });
  const index = path.join(root, 'session_index.jsonl');
  fs.writeFileSync(index, [
    { id: MAIN, thread_name: 'First name', updated_at: iso(T0 - 9 * MINUTE) },
    { id: OTHER, thread_name: 'Someone else', updated_at: iso(T0 - 8 * MINUTE) },
    { id: MAIN, thread_name: 'Second   name', updated_at: iso(T0 - 7 * MINUTE) },
  ].map(line).join(''));
  const { session } = open(root);
  assert.equal(session(MAIN).title, 'Second name');
  assert.equal(session(MAIN).titleSource, 'session_index');
  assert.equal(session(CHILD).title, 'Scout');

  fs.appendFileSync(index, line({ id: MAIN, thread_name: 'Third name', updated_at: iso(T0) }));
  assert.equal(session(MAIN).title, 'Third name');
});

// ---- links ----

test('links: spawns and messages go down, completed reports come up', (t) => {
  const root = codexHome(t);
  rollout(root, MAIN, {
    records: [
      started(T0 - 10 * MINUTE),
      call(T0 - 9 * MINUTE, 'spawn_agent', { task_name: 'scout', message: 'look around', fork_turns: 'none' }, 's1'),
      output(T0 - 9 * MINUTE, 's1', JSON.stringify({ task_name: '/root/scout' })),
      call(T0 - 8 * MINUTE, 'spawn_agent', { task_name: 'ghost', message: 'never written' }, 's2'),
      call(T0 - 7 * MINUTE, 'followup_task', { target: 'scout', message: 'and the tests?' }, 'f1'),
      call(T0 - 6 * MINUTE, 'send_message', { target: '/root/scout', message: 'hurry' }, 'm1'),
      subAgent(T0 - 5 * MINUTE, 'interacted', CHILD, '/root/scout'),
      subAgent(T0 - 4 * MINUTE, 'completed', CHILD, '/root/scout'),
      subAgent(T0 - 3 * MINUTE, 'completed', STRANGER, '/root/elsewhere'),
    ],
  });
  rollout(root, CHILD, {
    meta: childMeta(),
    records: [started(T0 - 9 * MINUTE, 'c1', 5), call(T0 - 5 * MINUTE, 'send_message', { target: '/root', message: 'report' }, 'r1', 6)],
  });
  const { session } = open(root);
  assert.deepEqual(session(MAIN).links, [
    { at: T0 - 9 * MINUTE, dir: 'down', other: `codex:${CHILD}`, label: 'scout' },
    { at: T0 - 8 * MINUTE, dir: 'down', other: 'path:/root/ghost', label: 'ghost' },
    { at: T0 - 7 * MINUTE, dir: 'down', other: `codex:${CHILD}`, label: null },
    { at: T0 - 6 * MINUTE, dir: 'down', other: `codex:${CHILD}`, label: null },
    { at: T0 - 4 * MINUTE, dir: 'up', other: `codex:${CHILD}`, label: null },
    { at: T0 - 3 * MINUTE, dir: 'up', other: `codex:${STRANGER}`, label: null },
  ]);
  assert.deepEqual(session(CHILD).links, [{ at: T0 - 5 * MINUTE, dir: 'up', other: `codex:${MAIN}`, label: null }]);
});

test('a message to the parent thread id is a report up', (t) => {
  const root = codexHome(t);
  rollout(root, MAIN);
  rollout(root, CHILD, {
    meta: childMeta(),
    records: [
      call(T0 - 2 * MINUTE, 'send_message', { target: MAIN.toUpperCase(), message: 'report' }, 'r1', 6),
      call(T0 - MINUTE, 'send_message', { target: OTHER, message: 'hello' }, 'r2', 7),
    ],
  });
  assert.deepEqual(open(root).session(CHILD).links, [
    { at: T0 - 2 * MINUTE, dir: 'up', other: `codex:${MAIN}`, label: null },
    { at: T0 - MINUTE, dir: 'down', other: `codex:${OTHER}`, label: null },
  ]);
});

test('a spawn resolves to the thread id once the child appears', (t) => {
  const root = codexHome(t);
  rollout(root, MAIN, { records: [call(T0 - 9 * MINUTE, 'spawn_agent', { task_name: 'scout' }, 's1')] });
  const { session, clock } = open(root);
  assert.equal(session(MAIN).links[0].other, 'path:/root/scout');

  rollout(root, CHILD, { meta: childMeta(), mtime: T0 });
  clock.now = T0 + 31 * 1000;
  assert.equal(session(MAIN).links[0].other, `codex:${CHILD}`);
});

test('links keep the newest 50', (t) => {
  const root = codexHome(t);
  const records = [];
  for (let n = 0; n < 60; n++) records.push(call(T0 - (60 - n) * 1000, 'send_message', { target: `/root/w${n}` }, `m${n}`));
  rollout(root, MAIN, { records });
  const links = open(root).session(MAIN).links;
  assert.equal(links.length, 50);
  assert.equal(links[0].other, 'path:/root/w10');
  assert.equal(links[49].other, 'path:/root/w59');
});

// ---- detail ----

test('detail returns recent events and a cursor for the next poll', (t) => {
  const root = codexHome(t);
  const file = rollout(root, MAIN, {
    records: [
      started(T0 - 5 * MINUTE),
      ask(T0 - 5 * MINUTE, '<environment_context>\n  <cwd>/home/ada/project</cwd>\n</environment_context>'),
      ask(T0 - 5 * MINUTE, 'Please run the tests'),
      think(T0 - 4 * MINUTE),
      exec(T0 - 4 * MINUTE, 'npm test', 'c1'),
      output(T0 - 4 * MINUTE, 'c1', [{ type: 'input_text', text: '12 passing' }], 'custom_tool_call_output'),
      say(T0 - 3 * MINUTE, 'The tests pass.'),
      completed(T0 - 2 * MINUTE, 't1', { error: { message: 'Connection lost' } }),
      started(T0 - MINUTE, 't2'),
      aborted(T0 - MINUTE, 't2'),
    ],
  });
  fs.appendFileSync(file, '{broken\n');
  const { source, poll } = open(root);
  poll();
  const first = source.detail(`codex:${MAIN}`);
  assert.deepEqual(first.events.map((e) => [e.kind, e.tool, e.text]), [
    ['user', null, 'Please run the tests'],
    ['thinking', null, null],
    ['tool', 'exec', 'npm test'],
    ['result', 'exec', '12 passing'],
    ['assistant', null, 'The tests pass.'],
    ['error', null, 'Connection lost'],
    ['error', null, 'Stopped: interrupted'],
  ]);
  assert.equal(first.events[0].at, T0 - 5 * MINUTE);
  assert.equal(first.next, fs.statSync(file).size);

  assert.deepEqual(source.detail(`codex:${MAIN}`, first.next).events, []);
  append(file, say(T0, 'One more thing.'));
  const second = source.detail(`codex:${MAIN}`, String(first.next));
  assert.deepEqual(second.events, [{ at: T0, kind: 'assistant', tool: null, text: 'One more thing.' }]);
  assert.equal(second.next, fs.statSync(file).size);
});

test('the drawer skips the AGENTS.md instructions Codex adds as a user message', (t) => {
  const root = codexHome(t);
  rollout(root, MAIN, {
    records: [
      ask(T0 - 2 * MINUTE, '# AGENTS.md instructions for /home/ada/project\n\n<INSTRUCTIONS>\nBe brief.\n</INSTRUCTIONS>'),
      ask(T0 - MINUTE, 'Fix the build'),
    ],
  });
  const { source, poll } = open(root);
  poll();
  const events = source.detail(`codex:${MAIN}`).events;
  assert.deepEqual(events.map((e) => [e.kind, e.text]), [['user', 'Fix the build']]);
});

test('detail returns at most 200 events and ignores unknown keys', (t) => {
  const root = codexHome(t);
  const records = [];
  for (let n = 0; n < 250; n++) records.push(say(T0 - (250 - n) * 1000, `message ${n}`));
  rollout(root, MAIN, { records });
  const { source, poll } = open(root);
  poll();
  const { events } = source.detail(`codex:${MAIN}`, 'not a number');
  assert.equal(events.length, 200);
  assert.equal(events[0].text, 'message 50');
  assert.equal(events[199].text, 'message 249');

  assert.deepEqual(source.detail(`codex:${STRANGER}`), { events: [], next: null });
  assert.deepEqual(source.detail('claude:0199a000'), { events: [], next: null });
  assert.deepEqual(source.detail(null), { events: [], next: null });
});

test('a rollout whose head line is still being written waits for it', (t) => {
  const root = codexHome(t);
  const dir = path.join(root, 'sessions', '2026', '10', '12');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-2026-10-12T09-00-00-${MAIN}.jsonl`);
  const meta = { id: MAIN, cwd: '/home/ada/project', timestamp: iso(T0 - MINUTE) };
  const head = line({ timestamp: iso(T0 - MINUTE), type: 'session_meta', payload: meta });
  fs.writeFileSync(file, head.slice(0, 20));
  const { poll } = open(root);
  assert.deepEqual(poll().sessions, []);

  fs.writeFileSync(file, head + line(started(T0 - MINUTE)));
  const [s] = poll().sessions;
  assert.equal(s.id, MAIN);
  assert.equal(s.status, 'working');
});
