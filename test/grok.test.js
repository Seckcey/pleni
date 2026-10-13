import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cleanSettings } from '../src/config.js';
import { createGrokSource } from '../src/sources/grok.js';

const MiB = 1024 * 1024;
const MINUTE = 60 * 1000;
const T0 = Math.floor(Date.now() / 1000) * 1000;

const MAIN = '0199a000-0000-7000-8000-000000000001';
const CHILD = '0199a000-0000-7000-8000-000000000002';
const OTHER = '0199a000-0000-7000-8000-000000000003';
const STRANGER = '0199a000-0000-7000-8000-0000000000ff';
const idAt = (n) => `0199b000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const CWD = '/home/ada/project';

// ---- fixture helpers (everything is made up) ----

function grokHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pleni-grok-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const iso = (ms) => new Date(ms).toISOString();
const line = (record) => `${JSON.stringify(record)}\n`;

// One session folder, sessions/<encoded working folder>/<id>/, as Grok writes it.
function session(root, id, { cwd = CWD, summary = {}, events = [], updates = [], mtime = T0 - MINUTE, at = T0 - 30 * MINUTE } = {}) {
  const dir = path.join(root, 'sessions', encodeURIComponent(cwd), id);
  fs.mkdirSync(dir, { recursive: true });
  const files = {
    dir,
    summary: path.join(dir, 'summary.json'),
    events: path.join(dir, 'events.jsonl'),
    updates: path.join(dir, 'updates.jsonl'),
  };
  if (summary !== null) {
    fs.writeFileSync(files.summary, JSON.stringify({
      info: { id, cwd },
      session_summary: '',
      created_at: iso(at),
      updated_at: iso(at),
      last_active_at: iso(at),
      num_messages: 0,
      current_model_id: 'grok-test',
      reasoning_effort: 'high',
      generated_title: 'Fix the build',
      agent_name: 'grok-test-agent',
      ...summary,
    }));
  }
  fs.writeFileSync(files.events, events.map(line).join(''));
  fs.writeFileSync(files.updates, updates.map(line).join(''));
  for (const file of [files.summary, files.events, files.updates]) if (fs.existsSync(file)) setMtime(file, mtime);
  return files;
}

// A sub-agent's record in its parent's folder: subagents/<name>/meta.json.
function subagentMeta(parentDir, name, fields) {
  const dir = path.join(parentDir, 'subagents', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({
    subagent_id: name,
    attempt_id: 'a1',
    subagent_type: 'explore',
    prompt: 'Look around the code and report back.',
    status: 'running',
    ...fields,
  }));
}

function setMtime(file, ms) {
  fs.utimesSync(file, ms / 1000, ms / 1000);
}

const append = (file, ...records) => fs.appendFileSync(file, records.map(line).join(''));

// events.jsonl lines
const ev = (type, ms, fields = {}) => ({ ts: iso(ms), type, ...fields });
const started = (ms, fields = {}) => ev('turn_started', ms, {
  turn_number: 1,
  model_id: 'grok-test',
  yolo_mode: false,
  session_relationship: 'primary',
  schema_version: '1.0',
  conversation_message_count: 1,
  ...fields,
});
const ended = (ms, outcome = 'completed', fields = {}) => ev('turn_ended', ms, { outcome, ...fields });
const loop = (ms, index = 0) => ev('loop_started', ms, { loop_index: index });
const phase = (ms, name) => ev('phase_changed', ms, { phase: name });
const toolStart = (ms, name) => ev('tool_started', ms, { tool_name: name });
const toolEnd = (ms, name, outcome = 'success') => ev('tool_completed', ms, { tool_name: name, duration_ms: 12, outcome, tool_call_id: 'call-1-0' });
const asked = (ms, name) => ev('permission_requested', ms, { tool_name: name });
const answered = (ms, name, decision = 'allow') => ev('permission_resolved', ms, { tool_name: name, decision, wait_ms: 0 });

// updates.jsonl lines: ACP session updates. The record's own timestamp is in whole seconds.
// Pieces of one model reply share `stream`, the time their stream started.
const upd = (ms, update, { method = 'session/update', stream } = {}) => ({
  timestamp: Math.floor(ms / 1000),
  method,
  params: { sessionId: MAIN, update, _meta: { agentTimestampMs: ms, eventId: 'e1', ...(stream === undefined ? {} : { streamStartMs: stream }) } },
});
const userSays = (ms, text) => upd(ms, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text } });
const grokSays = (ms, text, stream = ms) => upd(ms, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } }, { stream });
const thinks = (ms, stream = ms) =>
  upd(ms, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'private thoughts' } }, { stream });
const toolCall = (ms, id, name, rawInput = {}) => upd(ms, {
  sessionUpdate: 'tool_call',
  toolCallId: id,
  title: name,
  rawInput,
  _meta: { 'x.ai/tool': { version: 1, name, kind: 'other', namespace: 'grok_build', label: 'Tool', read_only: false } },
});
const toolResult = (ms, id, text, status = 'completed') => upd(ms, {
  sessionUpdate: 'tool_call_update',
  toolCallId: id,
  status,
  content: [{ type: 'content', content: { type: 'text', text } }],
});
const turnDone = (ms, stopReason = 'end_turn') =>
  upd(ms, { sessionUpdate: 'turn_completed', prompt_id: 'p1', stop_reason: stopReason }, { method: '_x.ai/session/update' });

function open(root, { content = 'snippets', window } = {}) {
  const clock = { now: T0 };
  const settings = cleanSettings({ content, window });
  const source = createGrokSource({ root, settings, now: () => clock.now });
  const poll = () => {
    const result = source.poll();
    assert.equal(result.ok, true, result.error);
    return result;
  };
  const get = (id) => poll().sessions.find((s) => s.id === id);
  return { clock, source, poll, get };
}

// ---- discovery ----

test('finds session folders under every working folder and skips old or odd ones', (t) => {
  const root = grokHome(t);
  session(root, idAt(1));
  session(root, idAt(2), { cwd: 'C:\\Users\\ada\\other', mtime: T0 - 2 * 60 * MINUTE });
  session(root, idAt(3), { mtime: T0 - 48 * 60 * MINUTE }); // older than recentHours
  const group = path.join(root, 'sessions', encodeURIComponent(CWD));
  fs.mkdirSync(path.join(group, 'not-a-session'));
  fs.mkdirSync(path.join(group, idAt(4))); // nothing written yet
  fs.writeFileSync(path.join(group, 'prompt_history.jsonl'), '{}\n');
  fs.writeFileSync(path.join(root, 'sessions', 'session_search.sqlite'), 'x');

  const { sessions, root: reported } = open(root).poll();
  assert.equal(reported, root);
  assert.deepEqual(sessions.map((s) => s.id), [idAt(1), idAt(2)]);
  const [s] = sessions;
  assert.equal(s.key, `grok:${idAt(1)}`);
  assert.equal(s.platform, 'grok');
  assert.equal(s.kind, 'session');
  assert.equal(s.parentKey, null);
  assert.equal(s.spawned, false);
  assert.equal(s.role, null);
  assert.equal(s.archived, false);
  assert.deepEqual(s.links, []);
  assert.equal(sessions[1].cwd, 'C:\\Users\\ada\\other');
});

test('keeps only the newest 300 session folders, and one copy of each session', (t) => {
  const root = grokHome(t);
  for (let n = 1; n <= 305; n++) session(root, idAt(n), { mtime: T0 - n * 1000 });
  session(root, idAt(1), { cwd: '/home/ada/elsewhere', mtime: T0 - 10 * MINUTE }); // an older copy
  const { sessions } = open(root).poll();
  const ids = sessions.map((s) => s.id);
  assert.equal(ids.length, 300);
  for (let n = 301; n <= 305; n++) assert.ok(!ids.includes(idAt(n)), `${n} should be left out`);
  assert.ok(ids.includes(idAt(300)));
  assert.equal(sessions.find((s) => s.id === idAt(1)).cwd, CWD);
});

test('looks for new session folders every 30 seconds', (t) => {
  const root = grokHome(t);
  session(root, idAt(1));
  const { clock, poll } = open(root);
  assert.equal(poll().sessions.length, 1);

  session(root, idAt(2), { mtime: T0 });
  clock.now = T0 + 10 * 1000;
  assert.equal(poll().sessions.length, 1);
  clock.now = T0 + 31 * 1000;
  assert.equal(poll().sessions.length, 2);
});

test('a missing Grok folder is reported, not thrown', (t) => {
  const root = grokHome(t);
  const gone = createGrokSource({ root: path.join(root, 'nope'), settings: cleanSettings({}) }).poll();
  assert.equal(gone.ok, false);
  assert.match(gone.error, /could not find/);
  assert.deepEqual(gone.sessions, []);

  const unset = createGrokSource({ root: null, settings: cleanSettings({}) }).poll();
  assert.equal(unset.ok, false);
  assert.equal(typeof unset.error, 'string');
  assert.deepEqual(unset.sessions, []);
});

test('a Grok folder with no sessions yet is fine', (t) => {
  const root = grokHome(t);
  assert.deepEqual(open(root).poll().sessions, []);
  fs.mkdirSync(path.join(root, 'sessions'));
  assert.deepEqual(open(root).poll().sessions, []);
});

// ---- summary.json ----

test('titles: the generated title, a title set by hand, then the agent name', (t) => {
  const root = grokHome(t);
  const first = session(root, idAt(1), { summary: { generated_title: '  Fix   the\nbuild ' } });
  session(root, idAt(2), { summary: { generated_title: 'Renamed by hand', title_is_manual: true } });
  session(root, idAt(3), { summary: { generated_title: '', agent_name: 'reviewer-bot' } });
  session(root, idAt(4), { summary: { generated_title: undefined, agent_name: undefined } });
  const { get } = open(root);
  const titleOf = (id) => [get(id).title, get(id).titleSource];
  assert.deepEqual(titleOf(idAt(1)), ['Fix the build', 'generated_title']);
  assert.deepEqual(titleOf(idAt(2)), ['Renamed by hand', 'manual']);
  assert.deepEqual(titleOf(idAt(3)), ['reviewer-bot', 'agent_name']);
  assert.deepEqual(titleOf(idAt(4)), [null, null]);

  // A new title is picked up when summary.json changes.
  const summary = JSON.parse(fs.readFileSync(first.summary, 'utf8'));
  fs.writeFileSync(first.summary, JSON.stringify({ ...summary, generated_title: 'Ship the release' }));
  setMtime(first.summary, T0);
  assert.equal(get(idAt(1)).title, 'Ship the release');
});

test('reads the working folder, branch, kind, start, model and effort from summary.json', (t) => {
  const root = grokHome(t);
  session(root, MAIN, {
    cwd: '\\\\?\\C:\\Users\\ada\\project',
    summary: {
      head_branch: 'feature/x',
      session_kind: 'worktree',
      created_at: '2026-10-12T09:00:00.123456789Z',
      current_model_id: 'grok-summary',
      reasoning_effort: 'xhigh',
    },
  });
  const s = open(root).get(MAIN);
  assert.equal(s.cwd, 'C:\\Users\\ada\\project');
  assert.equal(s.branch, 'feature/x');
  assert.equal(s.entrypoint, 'worktree');
  assert.equal(s.startedAt, Date.parse('2026-10-12T09:00:00.123Z'));
  assert.equal(s.model, 'grok-summary');
  assert.equal(s.effort, 'xhigh');
  assert.equal(s.lastAt, T0 - 30 * MINUTE); // no events yet: the summary's last activity
});

test('without a good summary.json a session still shows from its events', (t) => {
  const root = grokHome(t);
  const files = session(root, MAIN, { summary: null, events: [started(T0 - 2 * MINUTE, { model_id: 'grok-events' })] });
  const { get } = open(root);
  let s = get(MAIN);
  assert.equal(s.cwd, CWD); // from the folder name
  assert.equal(s.title, null);
  assert.equal(s.model, 'grok-events');
  assert.equal(s.effort, null);
  assert.equal(s.startedAt, T0 - 2 * MINUTE);
  assert.equal(s.status, 'working');

  fs.writeFileSync(files.summary, '{ "info": { "cwd": "/home/ada/half');
  assert.equal(get(MAIN).title, null);
  fs.writeFileSync(files.summary, JSON.stringify({ info: { id: MAIN, cwd: '/home/ada/real' }, generated_title: 'Now it has a name' }));
  setMtime(files.summary, T0);
  s = get(MAIN);
  assert.equal(s.title, 'Now it has a name');
  assert.equal(s.cwd, '/home/ada/real');
});

// ---- turns and status ----

test('the model comes from the latest turn, else from summary.json', (t) => {
  const root = grokHome(t);
  const file = session(root, idAt(1), {
    events: [started(T0 - 9 * MINUTE, { model_id: 'grok-old' }), ended(T0 - 8 * MINUTE), started(T0 - 7 * MINUTE, { model_id: 'grok-new' })],
  }).events;
  session(root, idAt(2), { summary: { current_model_id: 'grok-summary' } });
  const { get } = open(root);
  assert.equal(get(idAt(1)).model, 'grok-new');
  assert.equal(get(idAt(1)).effort, 'high');
  assert.equal(get(idAt(2)).model, 'grok-summary');

  append(file, ended(T0 - 6 * MINUTE), started(T0 - 5 * MINUTE, { model_id: 'grok-newest' }));
  assert.equal(get(idAt(1)).model, 'grok-newest');
});

test('turn status: working, stale, ready, old, error, cancelled', (t) => {
  const root = grokHome(t);
  session(root, idAt(1), { events: [started(T0 - MINUTE)] });
  session(root, idAt(2), { events: [started(T0 - 40 * MINUTE)] });
  session(root, idAt(3), { events: [started(T0 - 5 * MINUTE), ended(T0 - 4 * MINUTE)] });
  session(root, idAt(4), { events: [started(T0 - 25 * MINUTE), ended(T0 - 20 * MINUTE)] });
  session(root, idAt(5), { events: [started(T0 - 2 * MINUTE), ended(T0 - MINUTE, 'error')] });
  session(root, idAt(6), { events: [started(T0 - 3 * MINUTE), ended(T0 - 2 * MINUTE, 'cancelled', { cancellation_category: 'mid_turn_abort' })] });
  session(root, idAt(7));
  session(root, idAt(8), { events: [started(T0 - 9 * MINUTE), ended(T0 - 8 * MINUTE, 'error'), started(T0 - 2 * MINUTE), ended(T0 - MINUTE)] });

  const status = Object.fromEntries(open(root).poll().sessions.map((s) => [s.id, s.status]));
  assert.deepEqual(status, {
    [idAt(1)]: 'working',
    [idAt(2)]: 'idle',
    [idAt(3)]: 'ready',
    [idAt(4)]: 'idle',
    [idAt(5)]: 'error',
    [idAt(6)]: 'ready',
    [idAt(7)]: 'idle',
    [idAt(8)]: 'ready',
  });
});

test('the stale and active windows come from settings', (t) => {
  const root = grokHome(t);
  session(root, idAt(1), { events: [started(T0 - 40 * MINUTE)] });
  session(root, idAt(2), { events: [started(T0 - 21 * MINUTE), ended(T0 - 20 * MINUTE)] });
  const status = Object.fromEntries(
    open(root, { window: { staleMinutes: 60, activeMinutes: 30 } }).poll().sessions.map((s) => [s.id, s.status]),
  );
  assert.deepEqual(status, { [idAt(1)]: 'working', [idAt(2)]: 'ready' });
});

test('lastAt is the newest event time, not the file time', (t) => {
  const root = grokHome(t);
  const file = session(root, MAIN, { events: [started(T0 - 9 * MINUTE), ended(T0 - 8 * MINUTE)], mtime: T0 }).events;
  const { get } = open(root);
  assert.equal(get(MAIN).lastAt, T0 - 8 * MINUTE);
  assert.equal(get(MAIN).startedAt, T0 - 30 * MINUTE);
  append(file, ev('mcp_init_completed', T0 - 2 * MINUTE, { total_servers: 0 }));
  assert.equal(get(MAIN).lastAt, T0 - 2 * MINUTE);
});

test('a turn that began before the read window still counts as open', (t) => {
  const root = grokHome(t);
  session(root, MAIN, {
    summary: { current_model_id: 'grok-summary' },
    events: [
      started(T0 - 3 * MINUTE, { model_id: 'grok-early' }),
      ev('mcp_init_completed', T0 - 3 * MINUTE, { padding: 'x'.repeat(5 * MiB) }),
      loop(T0 - 2 * MINUTE),
      toolStart(T0 - MINUTE, 'run_terminal_command'),
    ],
  });
  const s = open(root).get(MAIN);
  assert.equal(s.status, 'working');
  assert.deepEqual(s.activity, { tool: 'run_terminal_command', detail: null, at: T0 - MINUTE });
  // The turn_started lies outside the tail, so the model comes from summary.json.
  assert.equal(s.model, 'grok-summary');
});

test('after a long pause, a file that grew a lot is read again from near its end', (t) => {
  const root = grokHome(t);
  const file = session(root, MAIN, { events: [started(T0 - 20 * MINUTE, { model_id: 'grok-before' }), toolStart(T0 - 19 * MINUTE, 'grep')] }).events;
  const { get } = open(root);
  assert.equal(get(MAIN).status, 'working');

  // While nobody polls, about 20 MiB arrive. The turn in the gap is skipped.
  append(file, ended(T0 - 18 * MINUTE), started(T0 - 17 * MINUTE, { model_id: 'grok-in-the-gap' }));
  for (let n = 0; n < 20; n++) append(file, ev('mcp_server_connected', T0 - 10 * MINUTE, { padding: 'y'.repeat(MiB) }));
  append(file, loop(T0 - MINUTE, 3), toolStart(T0 - MINUTE, 'read_file'));
  const s = get(MAIN);
  assert.equal(s.status, 'working');
  assert.deepEqual(s.activity, { tool: 'read_file', detail: null, at: T0 - MINUTE });
  assert.equal(s.model, 'grok-before');
  assert.equal(s.startedAt, T0 - 30 * MINUTE);
});

test('a last line without its newline waits for it', (t) => {
  const root = grokHome(t);
  const files = session(root, MAIN, { events: [started(T0 - 2 * MINUTE)], updates: [grokSays(T0 - 2 * MINUTE, 'First')] });
  const end = line(ended(T0 - MINUTE));
  const reply = line(grokSays(T0 - MINUTE, 'Second'));
  fs.appendFileSync(files.events, end.slice(0, 15));
  fs.appendFileSync(files.updates, reply.slice(0, 30));
  const { get } = open(root);
  let s = get(MAIN);
  assert.equal(s.status, 'working');
  assert.equal(s.lastText, 'First');

  fs.appendFileSync(files.events, end.slice(15));
  fs.appendFileSync(files.updates, reply.slice(30));
  s = get(MAIN);
  assert.equal(s.status, 'ready');
  assert.equal(s.lastText, 'Second');
});

test('U+2028 and U+2029 inside JSON strings do not split records', (t) => {
  const root = grokHome(t);
  const text = 'line one\u2028line two\u2029end';
  const files = session(root, MAIN, { events: [started(T0 - 2 * MINUTE), ended(T0 - MINUTE)], updates: [grokSays(T0 - MINUTE, text)] });
  assert.ok(fs.readFileSync(files.updates, 'utf8').includes('\u2028'), 'the fixture holds a raw U+2028');
  const { get, source } = open(root);
  const s = get(MAIN);
  assert.equal(s.lastText, 'line one line two end');
  assert.equal(s.status, 'ready');
  assert.deepEqual(source.detail(`grok:${MAIN}`).events.map((e) => e.text), [text]);
});

// ---- activity and text ----

test('an open tool is the activity, with details from updates.jsonl', (t) => {
  const root = grokHome(t);
  const files = session(root, MAIN, {
    events: [started(T0 - 3 * MINUTE), loop(T0 - 3 * MINUTE), toolStart(T0 - 2 * MINUTE, 'run_terminal_command')],
    updates: [
      userSays(T0 - 3 * MINUTE, 'Run the tests'),
      toolCall(T0 - 2 * MINUTE, 'call-1', 'run_terminal_command', { command: '\n  npm   test \nnpm run lint', is_background: false }),
    ],
  });
  const { get } = open(root);
  assert.deepEqual(get(MAIN).activity, { tool: 'run_terminal_command', detail: 'npm test', at: T0 - 2 * MINUTE });

  append(files.events, toolEnd(T0 - 100000, 'run_terminal_command'));
  append(files.updates, toolResult(T0 - 100000, 'call-1', 'ok'));
  assert.equal(get(MAIN).activity, null);
  assert.equal(get(MAIN).status, 'working');

  // Tools run side by side: the newest open one shows, and an end matches the oldest of its name.
  append(files.events, toolStart(T0 - 90000, 'read_file'), toolStart(T0 - 80000, 'grep'), toolStart(T0 - 70000, 'grep'));
  append(
    files.updates,
    toolCall(T0 - 90000, 'call-2', 'read_file', { target_file: 'C:\\Users\\ada\\project\\src\\main.js', offset: null }),
    toolCall(T0 - 80000, 'call-3', 'grep', { pattern: 'TODO', path: null }),
    toolCall(T0 - 70000, 'call-4', 'grep', { pattern: 'FIXME', path: null }),
  );
  assert.deepEqual(get(MAIN).activity, { tool: 'grep', detail: 'FIXME', at: T0 - 70000 });
  append(files.events, toolEnd(T0 - 60000, 'grep'));
  assert.deepEqual(get(MAIN).activity, { tool: 'grep', detail: 'FIXME', at: T0 - 70000 });
  append(files.events, toolEnd(T0 - 50000, 'grep'));
  assert.deepEqual(get(MAIN).activity, { tool: 'read_file', detail: 'main.js', at: T0 - 90000 });

  // A new round with the model clears tools whose end Grok did not write.
  append(files.events, loop(T0 - 40000, 1));
  assert.equal(get(MAIN).activity, null);

  // The end of the turn clears everything.
  append(files.events, toolStart(T0 - 30000, 'write'), ended(T0 - 20000));
  const s = get(MAIN);
  assert.equal(s.activity, null);
  assert.equal(s.status, 'ready');
});

test('tool details use descriptions, commands, file names, patterns, tools, questions and host names', (t) => {
  const root = grokHome(t);
  const calls = [
    ['run_terminal_command', { command: 'npm test', description: 'Run the tests' }],
    ['read_file', { target_file: '/home/ada/project/README.md', offset: 1 }],
    ['search_replace', { file_path: 'C:\\Users\\ada\\project\\app.js', old_string: 'a', new_string: 'b' }],
    ['grep', { pattern: 'TODO\n  later', path: '/home/ada/project', glob: null }],
    ['list_dir', { target_directory: '/home/ada/project/src/' }],
    ['use_tool', { tool_name: 'github__get_pull_request', tool_input: { owner: 'ada', repo: 'project' } }],
    ['ask_user_question', { questions: [{ question: 'Which branch?', options: [{ label: 'main' }] }] }],
    ['web_fetch', { url: 'https://example.com/a/b?c=d' }],
    ['todo_write', { todos: [], merge: true }],
    ['run_terminal_command', { command: 'x'.repeat(200) }],
  ];
  session(root, MAIN, { updates: calls.map(([name, input], i) => toolCall(T0 - MINUTE + i, `c${i}`, name, input)) });
  const { source, poll } = open(root);
  poll();
  const details = source.detail(`grok:${MAIN}`).events.map((e) => [e.tool, e.text]);
  assert.deepEqual(details.slice(0, 9), [
    ['run_terminal_command', 'Run the tests'],
    ['read_file', 'README.md'],
    ['search_replace', 'app.js'],
    ['grep', 'TODO later'],
    ['list_dir', 'src'],
    ['use_tool', 'github__get_pull_request'],
    ['ask_user_question', 'Which branch?'],
    ['web_fetch', 'example.com'],
    ['todo_write', null],
  ]);
  assert.equal(details[9][1].length, 80);
  assert.ok(details[9][1].endsWith('…'));
});

test('lastText is the newest reply, its chunks joined and whitespace collapsed', (t) => {
  const root = grokHome(t);
  const file = session(root, MAIN, { updates: [userSays(T0 - 4 * MINUTE, 'Hello'), grokSays(T0 - 3 * MINUTE, 'Working   on\n\nit')] }).updates;
  const { get } = open(root);
  assert.equal(get(MAIN).lastText, 'Working on it');

  // Grok saves a reply whole; pieces of one reply share their stream start.
  const stream = T0 - 2 * MINUTE - 500;
  append(file, toolCall(T0 - 3 * MINUTE, 'c1', 'grep', { pattern: 'x' }), grokSays(T0 - 2 * MINUTE, 'All ', stream), grokSays(T0 - 2 * MINUTE, ' done\n\nnow', stream));
  assert.equal(get(MAIN).lastText, 'All done now');
  append(file, grokSays(T0 - 2 * MINUTE + 1, 'A reply of its own'));
  assert.equal(get(MAIN).lastText, 'A reply of its own');

  append(file, userSays(T0 - MINUTE, 'Thanks'));
  assert.equal(get(MAIN).lastText, 'A reply of its own');

  append(file, grokSays(T0 - MINUTE, 'z'.repeat(400)));
  const long = get(MAIN).lastText;
  assert.equal(long.length, 280);
  assert.ok(long.endsWith('…'));
});

// ---- needs you ----

test('a permission request that stays open needs the person', (t) => {
  const root = grokHome(t);
  const first = session(root, idAt(1), {
    events: [started(T0 - 5 * MINUTE), toolStart(T0 - 4 * MINUTE, 'run_terminal_command'), asked(T0 - 4 * MINUTE, 'run_terminal_command')],
  }).events;
  // Grok's own rules answer most requests within milliseconds; one that just arrived is not shown yet.
  session(root, idAt(2), { events: [started(T0 - 5 * MINUTE), toolStart(T0 - 1000, 'read_file'), asked(T0 - 500, 'read_file')] });
  const third = session(root, idAt(3), {
    events: [started(T0 - 5 * MINUTE), toolStart(T0 - 4 * MINUTE, 'write'), asked(T0 - 4 * MINUTE, 'write'), answered(T0 - 4 * MINUTE, 'write', 'deny')],
  }).events;
  const { get, clock } = open(root);
  assert.deepEqual(get(idAt(1)).needs, { kind: 'permission', text: null, at: T0 - 4 * MINUTE });
  assert.equal(get(idAt(1)).status, 'working');
  assert.equal(get(idAt(2)).needs, null);
  assert.equal(get(idAt(3)).needs, null);

  clock.now = T0 + 2000;
  assert.deepEqual(get(idAt(2)).needs, { kind: 'permission', text: null, at: T0 - 500 });

  append(first, answered(T0 + 1000, 'run_terminal_command'));
  assert.equal(get(idAt(1)).needs, null);

  // A turn that ends leaves no request behind.
  append(third, asked(T0 - 3 * MINUTE, 'write'), ended(T0 - 2 * MINUTE, 'cancelled'));
  assert.equal(get(idAt(3)).needs, null);
});

test('an unanswered question or plan needs the person until it is answered', (t) => {
  const root = grokHome(t);
  const files = session(root, idAt(1), {
    events: [
      started(T0 - 50 * MINUTE),
      toolStart(T0 - 49 * MINUTE, 'ask_user_question'),
      asked(T0 - 49 * MINUTE, 'ask_user_question'),
      answered(T0 - 49 * MINUTE, 'ask_user_question'),
      phase(T0 - 49 * MINUTE, 'tool_execution'),
    ],
    updates: [toolCall(T0 - 49 * MINUTE, 'q1', 'ask_user_question', { questions: [{ question: 'Deploy   now\nor later?', options: [{ label: 'Now' }] }] })],
  });
  session(root, idAt(2), { events: [started(T0 - 3 * MINUTE), toolStart(T0 - 2 * MINUTE, 'exit_plan_mode')] });
  const { get } = open(root);
  // The turn went quiet long ago, but a question waits however long it takes.
  const s = get(idAt(1));
  assert.equal(s.status, 'idle');
  assert.deepEqual(s.needs, { kind: 'question', text: 'Deploy now or later?', at: T0 - 49 * MINUTE });
  assert.deepEqual(get(idAt(2)).needs, { kind: 'plan', text: null, at: T0 - 2 * MINUTE });

  append(files.events, toolEnd(T0 - MINUTE, 'ask_user_question'), loop(T0 - MINUTE, 1));
  append(files.updates, upd(T0 - MINUTE, { sessionUpdate: 'tool_call_update', toolCallId: 'q1', status: 'completed', rawOutput: { UserAnswered: {} } }));
  assert.equal(get(idAt(1)).needs, null);
});

test('a headless session never needs the person', (t) => {
  const root = grokHome(t);
  session(root, MAIN, {
    summary: { session_kind: 'headless' },
    events: [started(T0 - 5 * MINUTE), toolStart(T0 - 4 * MINUTE, 'ask_user_question'), asked(T0 - 4 * MINUTE, 'write')],
  });
  const s = open(root).get(MAIN);
  assert.equal(s.entrypoint, 'headless');
  assert.equal(s.needs, null);
});

test('content "none" hides text everywhere', (t) => {
  const root = grokHome(t);
  session(root, MAIN, {
    events: [started(T0 - 2 * MINUTE), toolStart(T0 - MINUTE, 'ask_user_question')],
    updates: [
      userSays(T0 - 2 * MINUTE, 'secret prompt'),
      grokSays(T0 - 2 * MINUTE, 'secret words'),
      toolCall(T0 - MINUTE, 'q1', 'ask_user_question', { questions: [{ question: 'secret question' }] }),
      turnDone(T0 - MINUTE, 'cancelled'),
    ],
  });
  const { get, source } = open(root, { content: 'none' });
  const s = get(MAIN);
  assert.equal(s.lastText, null);
  assert.deepEqual(s.activity, { tool: 'ask_user_question', detail: null, at: T0 - MINUTE });
  assert.deepEqual(s.needs, { kind: 'question', text: null, at: T0 - MINUTE });
  const events = source.detail(`grok:${MAIN}`).events;
  assert.deepEqual(events.map((e) => [e.kind, e.tool]), [['user', null], ['assistant', null], ['tool', 'ask_user_question'], ['error', null]]);
  assert.ok(events.every((e) => e.text === null));
});

// ---- sub-agents ----

test('a sub-agent is a session of its own under the session that started it', (t) => {
  const root = grokHome(t);
  const parent = session(root, MAIN, {
    events: [started(T0 - 10 * MINUTE), toolStart(T0 - 9 * MINUTE, 'spawn_subagent')],
    updates: [toolCall(T0 - 9 * MINUTE, 'call-s', 'spawn_subagent', { description: 'Find the callers', prompt: 'Find every caller.' })],
  });
  subagentMeta(parent.dir, 'sa-1', { parent_session_id: MAIN, child_session_id: CHILD, description: 'Find the callers', started_at: iso(T0 - 9 * MINUTE) });
  const child = session(root, CHILD, {
    at: T0 - 9 * MINUTE,
    summary: { session_kind: 'subagent', parent_session_id: MAIN, generated_title: undefined, agent_name: 'explore' },
    events: [started(T0 - 9 * MINUTE, { session_id: CHILD, session_relationship: 'subagent', model_id: 'grok-mini' }), toolStart(T0 - MINUTE, 'grep')],
  });
  const { get } = open(root);
  let kid = get(CHILD);
  assert.equal(kid.key, `grok:${CHILD}`);
  assert.equal(kid.kind, 'agent');
  assert.equal(kid.parentKey, `grok:${MAIN}`);
  assert.equal(kid.spawned, true);
  assert.deepEqual([kid.title, kid.titleSource], ['Find the callers', 'description']);
  assert.equal(kid.entrypoint, 'subagent');
  assert.equal(kid.model, 'grok-mini');
  assert.equal(kid.status, 'working');
  let boss = get(MAIN);
  assert.equal(boss.kind, 'session');
  assert.deepEqual(boss.activity, { tool: 'spawn_subagent', detail: 'Find the callers', at: T0 - 9 * MINUTE });
  assert.deepEqual(boss.links, [{ at: T0 - 9 * MINUTE, dir: 'down', other: `grok:${CHILD}`, label: 'Find the callers' }]);
  assert.deepEqual(kid.links, []);

  // The sub-agent finishes: it is done, and its report goes up to the parent.
  append(child.updates, grokSays(T0 - 30000, 'Found  three callers.'));
  append(child.events, toolEnd(T0 - 40000, 'grep'), ended(T0 - 30000));
  kid = get(CHILD);
  assert.equal(kid.status, 'done');
  boss = get(MAIN);
  assert.deepEqual(boss.links, [
    { at: T0 - 9 * MINUTE, dir: 'down', other: `grok:${CHILD}`, label: 'Find the callers' },
    { at: T0 - 30000, dir: 'up', other: `grok:${CHILD}`, label: 'Found three callers.' },
  ]);
});

test('a sub-agent is known from its parent\'s meta.json or from its own turns', (t) => {
  const root = grokHome(t);
  const parent = session(root, MAIN, { events: [started(T0 - 10 * MINUTE)] });
  subagentMeta(parent.dir, 'sa-1', { child_session_id: CHILD, description: 'Check the tests' });
  subagentMeta(parent.dir, 'sa-2', { child_session_id: MAIN, description: 'Itself' }); // ignored
  subagentMeta(parent.dir, 'sa-3', { parent_session_id: STRANGER, child_session_id: OTHER }); // not ours
  fs.mkdirSync(path.join(parent.dir, 'subagents', 'broken'));
  fs.writeFileSync(path.join(parent.dir, 'subagents', 'broken', 'meta.json'), '{ broken');
  session(root, CHILD, { events: [started(T0 - 5 * MINUTE)] });
  session(root, OTHER, { events: [started(T0 - 5 * MINUTE, { session_id: OTHER, session_relationship: 'subagent' })] });
  // A fork names its source session, but nobody started it as a helper.
  session(root, idAt(1), { summary: { parent_session_id: MAIN }, events: [started(T0 - 5 * MINUTE)] });
  // A turn_started written for another session says nothing about this one.
  session(root, idAt(2), { events: [started(T0 - 5 * MINUTE, { session_id: STRANGER, session_relationship: 'subagent' })] });

  const byId = Object.fromEntries(open(root).poll().sessions.map((s) => [s.id, s]));
  assert.deepEqual([byId[CHILD].kind, byId[CHILD].parentKey, byId[CHILD].spawned], ['agent', `grok:${MAIN}`, true]);
  assert.equal(byId[CHILD].title, 'Fix the build'); // its own title still comes first
  assert.deepEqual([byId[OTHER].kind, byId[OTHER].parentKey, byId[OTHER].spawned], ['agent', null, true]);
  assert.deepEqual([byId[idAt(1)].kind, byId[idAt(1)].parentKey, byId[idAt(1)].spawned], ['session', null, false]);
  assert.deepEqual([byId[idAt(2)].kind, byId[idAt(2)].parentKey], ['session', null]);
  assert.deepEqual([byId[MAIN].kind, byId[MAIN].parentKey], ['session', null]);
  assert.deepEqual(byId[MAIN].links.map((link) => [link.dir, link.other]), [['down', `grok:${CHILD}`]]);
});

test('the parent\'s record that a sub-agent ended finishes it, even when its file looks open', (t) => {
  const root = grokHome(t);
  const parent = session(root, MAIN, { events: [started(T0 - 10 * MINUTE), ended(T0 - 9 * MINUTE)] });
  const meta = { parent_session_id: MAIN, started_at: iso(T0 - 8 * MINUTE) };
  subagentMeta(parent.dir, 'sa-1', { ...meta, child_session_id: CHILD, status: 'completed', completed_at: iso(T0 - 2 * MINUTE) });
  subagentMeta(parent.dir, 'sa-2', { ...meta, child_session_id: OTHER, status: 'failed', completed_at: iso(T0 - 2 * MINUTE) });
  // A helper started again after its last end is working again.
  subagentMeta(parent.dir, 'sa-3', { ...meta, child_session_id: idAt(1), status: 'completed', completed_at: iso(T0 - 3 * MINUTE) });
  for (const id of [CHILD, OTHER]) session(root, id, { summary: { session_kind: 'subagent' }, events: [started(T0 - 8 * MINUTE)] });
  session(root, idAt(1), { summary: { session_kind: 'subagent' }, events: [started(T0 - MINUTE)] });

  const { get } = open(root);
  assert.equal(get(CHILD).status, 'done');
  assert.equal(get(OTHER).status, 'error');
  assert.equal(get(idAt(1)).status, 'working');
  const ups = get(MAIN).links.filter((link) => link.dir === 'up').map((link) => [link.other, link.at]);
  assert.deepEqual(ups, [[`grok:${CHILD}`, T0 - 2 * MINUTE], [`grok:${OTHER}`, T0 - 2 * MINUTE]]);
});

test('a session whose sub-agent is working is working too', (t) => {
  const root = grokHome(t);
  session(root, MAIN, { events: [started(T0 - 60 * MINUTE), ended(T0 - 59 * MINUTE)] });
  session(root, CHILD, { summary: { session_kind: 'subagent', parent_session_id: MAIN }, events: [started(T0 - MINUTE)] });
  session(root, OTHER, { events: [started(T0 - 60 * MINUTE), ended(T0 - 59 * MINUTE, 'error')] });
  session(root, idAt(1), { summary: { session_kind: 'subagent', parent_session_id: OTHER }, events: [started(T0 - MINUTE)] });
  const byId = Object.fromEntries(open(root).poll().sessions.map((s) => [s.id, s.status]));
  assert.equal(byId[MAIN], 'working');
  assert.equal(byId[CHILD], 'working');
  assert.equal(byId[OTHER], 'error', 'an error stays an error');
});

test('content "none" leaves sub-agent links without labels', (t) => {
  const root = grokHome(t);
  const parent = session(root, MAIN, { events: [started(T0 - 10 * MINUTE)] });
  subagentMeta(parent.dir, 'sa-1', { parent_session_id: MAIN, child_session_id: CHILD, description: 'Secret errand' });
  session(root, CHILD, { at: T0 - 9 * MINUTE, events: [started(T0 - 9 * MINUTE), ended(T0 - 8 * MINUTE)], updates: [grokSays(T0 - 8 * MINUTE, 'secret report')] });
  const { get } = open(root, { content: 'none' });
  assert.deepEqual(get(MAIN).links, [
    { at: T0 - 9 * MINUTE, dir: 'down', other: `grok:${CHILD}`, label: null },
    { at: T0 - 8 * MINUTE, dir: 'up', other: `grok:${CHILD}`, label: null },
  ]);
});

test('a sub-agent recorded after the first look is found on the next scan', (t) => {
  const root = grokHome(t);
  const parent = session(root, MAIN, { events: [started(T0 - 10 * MINUTE)] });
  const { get, clock } = open(root);
  assert.deepEqual(get(MAIN).links, []);

  subagentMeta(parent.dir, 'sa-1', { parent_session_id: MAIN, child_session_id: CHILD, description: 'Late helper' });
  session(root, CHILD, { at: T0 - MINUTE, events: [started(T0 - MINUTE)], mtime: T0 });
  clock.now = T0 + 31 * 1000;
  assert.equal(get(CHILD).parentKey, `grok:${MAIN}`);
  assert.deepEqual(get(MAIN).links, [{ at: T0 - MINUTE, dir: 'down', other: `grok:${CHILD}`, label: 'Late helper' }]);
});

// ---- detail ----

test('detail returns recent events and a cursor for the next poll', (t) => {
  const root = grokHome(t);
  const files = session(root, MAIN, {
    updates: [
      userSays(T0 - 5 * MINUTE, 'Please run the tests'),
      thinks(T0 - 5 * MINUTE, 7),
      thinks(T0 - 5 * MINUTE + 10, 7),
      toolCall(T0 - 4 * MINUTE, 'c1', 'run_terminal_command', { command: 'npm test', description: 'Run the tests' }),
      upd(T0 - 4 * MINUTE, { sessionUpdate: 'tool_call_update', toolCallId: 'c1', rawInput: { command: 'npm test' } }),
      toolResult(T0 - 4 * MINUTE, 'c1', '12 passing'),
      toolCall(T0 - 4 * MINUTE, 'c2', 'read_file', { target_file: '/home/ada/project/missing.js' }),
      toolResult(T0 - 4 * MINUTE, 'c2', 'File not found', 'failed'),
      grokSays(T0 - 3 * MINUTE, 'The tests ', 8),
      grokSays(T0 - 3 * MINUTE + 10, 'pass.', 8),
      grokSays(T0 - 3 * MINUTE + 20, 'A reply of its own.'),
      upd(T0 - 3 * MINUTE, { sessionUpdate: 'hook_execution', event_name: 'stop', runs: [] }, { method: '_x.ai/session/update' }),
      turnDone(T0 - 3 * MINUTE),
      userSays(T0 - 2 * MINUTE, 'Again'),
      turnDone(T0 - 2 * MINUTE, 'rate_limit'),
      userSays(T0 - MINUTE, 'Stop'),
      turnDone(T0 - MINUTE, 'cancelled'),
    ],
  });
  fs.appendFileSync(files.updates, '{broken\n');
  const { source, poll } = open(root);
  poll();
  const first = source.detail(`grok:${MAIN}`);
  assert.deepEqual(first.events.map((e) => [e.kind, e.tool, e.text]), [
    ['user', null, 'Please run the tests'],
    ['thinking', null, null],
    ['tool', 'run_terminal_command', 'Run the tests'],
    ['result', 'run_terminal_command', '12 passing'],
    ['tool', 'read_file', 'missing.js'],
    ['error', 'read_file', 'File not found'],
    ['assistant', null, 'The tests pass.'],
    ['assistant', null, 'A reply of its own.'],
    ['user', null, 'Again'],
    ['error', null, 'Stopped: rate limit'],
    ['user', null, 'Stop'],
    ['error', null, 'Stopped'],
  ]);
  assert.equal(first.events[0].at, T0 - 5 * MINUTE);
  assert.equal(first.next, fs.statSync(files.updates).size);
  assert.ok(!JSON.stringify(first).includes('private thoughts'), 'thinking text is never returned');

  assert.deepEqual(source.detail(`grok:${MAIN}`, first.next).events, []);
  append(files.updates, grokSays(T0, 'One more thing.'));
  const second = source.detail(`grok:${MAIN}`, String(first.next));
  assert.deepEqual(second.events, [{ at: T0, kind: 'assistant', tool: null, text: 'One more thing.' }]);
  assert.equal(second.next, fs.statSync(files.updates).size);
});

test('update times come from _meta in milliseconds, else from the timestamp in seconds', (t) => {
  const root = grokHome(t);
  // Grok writes the record's own timestamp later, and in whole seconds.
  const written = { ...grokSays(T0 - 2 * MINUTE + 123, 'with meta'), timestamp: Math.floor((T0 + 5 * MINUTE) / 1000) };
  const bare = {
    timestamp: Math.floor((T0 - MINUTE) / 1000),
    method: 'session/update',
    params: { sessionId: MAIN, update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'no meta' } } },
  };
  const timeless = { method: 'session/update', params: { update: { sessionUpdate: 'user_message_chunk', content: { text: 'no time' } } } };
  session(root, MAIN, { updates: [written, bare, timeless] });
  const { source, poll } = open(root);
  poll();
  assert.deepEqual(source.detail(`grok:${MAIN}`).events.map((e) => [e.at, e.text]), [
    [T0 - 2 * MINUTE + 123, 'with meta'],
    [T0 - MINUTE, 'no meta'],
  ]);
});

test('detail returns at most 200 events and ignores unknown keys', (t) => {
  const root = grokHome(t);
  const updates = [];
  for (let n = 0; n < 150; n++) updates.push(userSays(T0 - (150 - n) * 1000, `question ${n}`), grokSays(T0 - (150 - n) * 1000 + 1, `answer ${n}`));
  session(root, MAIN, { updates });
  const { source, poll } = open(root);
  poll();
  const { events } = source.detail(`grok:${MAIN}`, 'not a number');
  assert.equal(events.length, 200);
  assert.equal(events[0].text, 'question 50');
  assert.equal(events[199].text, 'answer 149');

  const empty = { events: [], next: null };
  assert.deepEqual(source.detail(`grok:${STRANGER}`), empty);
  assert.deepEqual(source.detail(`codex:${MAIN}`), empty);
  assert.deepEqual(source.detail(`grok:${MAIN}/agent`), empty);
  assert.deepEqual(source.detail(null), empty);
});

test('detail of a session without updates.jsonl is empty', (t) => {
  const root = grokHome(t);
  const files = session(root, MAIN, { events: [started(T0 - MINUTE)] });
  fs.rmSync(files.updates);
  const { source, poll } = open(root);
  assert.equal(poll().sessions.length, 1);
  assert.deepEqual(source.detail(`grok:${MAIN}`), { events: [], next: null });
});
