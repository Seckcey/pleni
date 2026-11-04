import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cleanSettings } from '../src/config.js';
import { createAntigravitySource } from '../src/sources/antigravity.js';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const T0 = Math.floor(Date.now() / 1000) * 1000;

const CID = '7a1b2c3d-4e5f-4a6b-8c7d-0000000000c1';
const KID = '7a1b2c3d-4e5f-4a6b-8c7d-0000000000c2';
const idAt = (n) => `7a1b2c3d-4e5f-4a6b-8c7d-${String(n).padStart(12, '0')}`;
const keyOf = (id) => `antigravity:${id}`;
const FOLDER = '/home/ada/project';
const THOUGHT = 'SECRET-THOUGHT about the plan';

// ---- fixture helpers (everything is synthetic) ----

function agyHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pleni-antigravity-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const iso = (ms) => new Date(ms).toISOString();
const line = (record) => (typeof record === 'string' ? record : `${JSON.stringify(record)}\n`);
const setMtime = (file, ms) => fs.utimesSync(file, ms / 1000, ms / 1000);
const logsOf = (root, id) => path.join(root, 'brain', id, '.system_generated', 'logs');
const ADDED = '<ADDITIONAL_METADATA>\nThe current local time is: 2026-11-04T10:00:00+01:00.\n</ADDITIONAL_METADATA>';
// Antigravity CLI writes each argument of a tool call as JSON text of its own.
const args = (values) => Object.fromEntries(Object.entries(values).map(([name, value]) => [name, JSON.stringify(value)]));

const ask = (ms, text, extra = {}) => ({ source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: iso(ms), content: `<USER_REQUEST>\n${text}\n</USER_REQUEST>\n${ADDED}`, ...extra });
const reply = (ms, content, extra = {}) => ({ source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: iso(ms), content, ...extra });
const uses = (ms, toolCalls, extra = {}) => reply(ms, '', { tool_calls: toolCalls, ...extra });
const call = (name, values) => ({ name, args: args({ ...values, toolAction: 'Working on it', toolSummary: 'Tool' }) });
const ran = (ms, type, content, extra = {}) => ({ source: 'MODEL', type, status: 'DONE', created_at: iso(ms), content: `Created At: ${iso(ms)}\nCompleted At: ${iso(ms)}\n${content}`, ...extra });
const note = (ms, type, content = '', extra = {}) => ({ source: 'SYSTEM', type, status: 'DONE', created_at: iso(ms), content, ...extra });
// The result of an invoke_subagent call names each helper's conversation.
const invoked = (ms, ids) => ran(ms, 'INVOKE_SUBAGENT', ids.map((id) => `Started a subagent.\nconversationId: "${id}"`).join('\n'));
const numbered = (list, from = 0) => list.map((step, i) => (typeof step === 'string' ? step : { step_index: from + i, ...step }));

// A conversation's transcript, its steps numbered in order. Strings are written as they are.
function writeTranscript(root, id, steps, { full = false, mtime } = {}) {
  const file = path.join(logsOf(root, id), full ? 'transcript_full.jsonl' : 'transcript.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, numbered(steps).map(line).join(''));
  if (mtime !== undefined) setMtime(file, mtime);
  return file;
}

const append = (file, ...steps) => fs.appendFileSync(file, steps.map(line).join(''));

function writeJson(root, name, value) {
  const file = path.join(root, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
  return file;
}

// cache/conversation_metadata.json: { conversations: { <id>: { summary: { WorkspaceURIs, Title? } } } }.
const writeMeta = (root, list) => writeJson(root, 'cache/conversation_metadata.json', { conversations: list });
const writeLast = (root, map) => writeJson(root, 'cache/last_conversations.json', map);
function writeHistory(root, lines) {
  fs.writeFileSync(path.join(root, 'history.jsonl'), lines.map(line).join(''));
}

function open(root, { content = 'snippets', window } = {}) {
  const clock = { now: T0 };
  const settings = cleanSettings({ content, window });
  const source = createAntigravitySource({ root, settings, now: () => clock.now });
  const poll = () => {
    const out = source.poll();
    assert.equal(out.ok, true, out.error);
    return out;
  };
  const get = (key) => poll().sessions.find((s) => s.key === key);
  return { clock, source, poll, get };
}

// ---- discovery ----

test('finds each conversation in brain, prefers the uncut transcript, and fills the session shape', (t) => {
  const root = agyHome(t);
  const at = T0 - 6 * MINUTE;
  writeMeta(root, { [CID]: { summary: { Title: 'Fix the login page', WorkspaceURIs: [`file://${FOLDER}`] } } });
  writeTranscript(root, CID, [
    ask(at, 'The login page shows a blank screen.'),
    note(at + 100, 'CONVERSATION_HISTORY'),
    reply(at + 2000, 'The login page works again.'),
    note(T0 - MINUTE, 'CHECKPOINT', 'A title for the conversation'),
  ]);
  // Both names: the uncut transcript_full.jsonl is the one read.
  writeTranscript(root, idAt(2), [ask(at, 'Short'), reply(at + 1000, 'Cut short…')]);
  writeTranscript(root, idAt(2), [ask(at, 'Short'), reply(at + 1000, 'The whole answer, not cut short.')], { full: true });
  writeTranscript(root, idAt(3), [ask(T0 - 48 * HOUR, 'Old'), reply(T0 - 48 * HOUR, 'Old answer.')], { mtime: T0 - 48 * HOUR }); // older than recentHours
  writeTranscript(root, idAt(4), [note(at, 'CONVERSATION_HISTORY'), note(at, 'CHECKPOINT')]); // nothing said yet
  writeTranscript(root, 'not-an-id!', [ask(at, 'Hi'), reply(at, 'Hi.')]);
  fs.writeFileSync(path.join(root, 'brain', `${idAt(5)}.txt`), 'not a folder\n');
  fs.mkdirSync(path.join(root, 'brain', idAt(6)), { recursive: true }); // a folder with no transcript

  const { sessions, root: reported } = open(root).poll();
  assert.equal(reported, root);
  // Sorted by key.
  assert.deepEqual(sessions.map((s) => s.key), [keyOf(idAt(2)), keyOf(CID)]);
  const [full, s] = sessions;
  assert.deepEqual({ ...s, links: s.links.length }, {
    platform: 'antigravity',
    key: keyOf(CID),
    id: CID,
    parentKey: null,
    kind: 'session',
    spawned: false,
    role: null,
    title: 'Fix the login page',
    titleSource: 'summary',
    cwd: FOLDER,
    branch: null,
    entrypoint: null,
    model: null, // no model is named in a transcript
    effort: null,
    startedAt: at,
    lastAt: at + 2000, // the checkpoint keeps the books and does not count
    status: 'ready',
    activity: null,
    lastText: 'The login page works again.',
    needs: null,
    links: 0,
    archived: false,
  });
  assert.equal(full.lastText, 'The whole answer, not cut short.');
  assert.equal(full.title, 'Short', 'the first request names it');
  assert.equal(full.titleSource, 'first-prompt');
  assert.equal(full.cwd, null, 'no file names its folder');
});

test('the working folder comes from the conversation metadata, else history.jsonl, else last_conversations.json', (t) => {
  const root = agyHome(t);
  const at = T0 - 5 * MINUTE;
  for (let n = 1; n <= 6; n++) writeTranscript(root, idAt(n), [ask(at, `Request ${n}`), reply(at + 1000, 'Done.')]);
  writeMeta(root, {
    // The first workspace wins, and a file URI is read back into a folder.
    [idAt(1)]: { summary: { WorkspaceURIs: ['file:///home/ada/old%20project/', 'file:///tmp'] } },
    [idAt(5)]: { summary: { WorkspaceURIs: ['file:///C:/Users/ada/project'] } },
    [idAt(6)]: { summary: { WorkspaceURIs: ['https://example.com/x', 'not a uri'] } },
    'NOT AN ID': { summary: { WorkspaceURIs: ['file:///home/ada/nope'] } },
  });
  writeHistory(root, [
    { display: 'Request 1', timestamp: at, workspace: '/home/ada/other', conversationId: idAt(1) },
    { display: 'Request 2', timestamp: at, workspace: '/home/ada/first-place', conversationId: idAt(2) },
    'not json\n',
    { display: 'Request 2 again', timestamp: at + 1, workspace: '/home/ada/history-project', conversationId: idAt(2) },
    { display: 'No folder', timestamp: at, workspace: 'relative/folder', conversationId: idAt(4) },
  ]);
  writeLast(root, { '/home/ada/third': idAt(1), '/home/ada/last-project': idAt(3), '/home/ada/also-two': idAt(2), 'relative': idAt(4) });

  const byId = new Map(open(root).poll().sessions.map((s) => [s.id, s]));
  assert.equal(byId.get(idAt(1)).cwd, '/home/ada/old project');
  assert.equal(byId.get(idAt(2)).cwd, '/home/ada/history-project', 'the newest history line wins');
  assert.equal(byId.get(idAt(3)).cwd, '/home/ada/last-project');
  assert.equal(byId.get(idAt(4)).cwd, null, 'no file names a full folder path');
  assert.equal(byId.get(idAt(5)).cwd, 'C:\\Users\\ada\\project');
  assert.equal(byId.get(idAt(6)).cwd, null);
});

// ---- titles, text and thinking ----

test('the title is the summary title, else the first request, else the first prompt in history', (t) => {
  const root = agyHome(t);
  const at = T0 - 4 * MINUTE;
  writeTranscript(root, idAt(1), [ask(at, 'Fix the login page\nIt shows a blank screen.'), reply(at + 1000, 'Fixed.'), ask(at + 2000, 'Thanks')]);
  // A request without the tags: the blocks Antigravity CLI adds are taken out.
  writeTranscript(root, idAt(2), [{ ...ask(at, ''), content: `Plain words here\n${ADDED}` }, reply(at + 1000, 'Done.')]);
  // No request text at all: history.jsonl has what the person typed.
  writeTranscript(root, idAt(3), [{ ...ask(at, ''), content: '' }, reply(at + 1000, 'Done.')]);
  writeHistory(root, [
    { display: '/model', timestamp: at, workspace: FOLDER, conversationId: idAt(3) }, // a command, not a name
    { display: 'Tidy the docs folder', timestamp: at, workspace: FOLDER, conversationId: idAt(3) },
  ]);
  writeTranscript(root, idAt(4), [ask(at, 'A long first request'), reply(at + 1000, 'Done.')]);
  writeMeta(root, { [idAt(4)]: { summary: { title: 'Named by Antigravity', WorkspaceURIs: [] } } });

  const byId = new Map(open(root).poll().sessions.map((s) => [s.id, [s.title, s.titleSource]]));
  assert.deepEqual(byId.get(idAt(1)), ['Fix the login page It shows a blank screen.', 'first-prompt']);
  assert.deepEqual(byId.get(idAt(2)), ['Plain words here', 'first-prompt']);
  assert.deepEqual(byId.get(idAt(3)), ['Tidy the docs folder', 'history']);
  assert.deepEqual(byId.get(idAt(4)), ['Named by Antigravity', 'summary']);
});

test('thinking is never kept or shown: only the fact that the model thought', (t) => {
  const root = agyHome(t);
  const at = T0 - 3 * MINUTE;
  writeTranscript(root, CID, [
    ask(at, 'Plan the change'),
    uses(at + 1000, [call('view_file', { AbsolutePath: '/home/ada/project/plan.md' })], { thinking: THOUGHT }),
    ran(at + 1500, 'VIEW_FILE', 'The plan file.'),
    reply(at + 3000, 'Here is the plan.', { thinking: `${THOUGHT} again` }),
    reply(at + 4000, '', { thinking: `${THOUGHT} with no words` }),
  ]);
  const { source, poll } = open(root);
  const out = poll();
  const detail = source.detail(keyOf(CID), null);
  assert.equal(out.sessions[0].lastText, 'Here is the plan.');
  assert.equal(JSON.stringify([out, detail]).includes('SECRET-THOUGHT'), false);
  const thinking = detail.events.filter((e) => e.kind === 'thinking');
  assert.equal(thinking.length, 3);
  assert.ok(thinking.every((e) => e.text === null && e.tool === null));
});

test('with content "none", no session text is shown: no title, last words, tool details or event text', (t) => {
  const root = agyHome(t);
  const at = T0 - 2 * MINUTE;
  writeMeta(root, { [CID]: { summary: { Title: 'Private title', WorkspaceURIs: [`file://${FOLDER}`] } } });
  writeTranscript(root, CID, [
    ask(at, 'Private request'),
    uses(at + 1000, [call('run_command', { CommandLine: 'npm test -- --secret', Cwd: FOLDER })], { thinking: THOUGHT }),
  ]);
  const { source, poll } = open(root, { content: 'none' });
  const [s] = poll().sessions;
  assert.equal(s.title, null);
  assert.equal(s.titleSource, null);
  assert.equal(s.lastText, null);
  assert.equal(s.cwd, FOLDER, 'the folder is not session text');
  assert.equal(s.status, 'working');
  assert.deepEqual(s.activity, { tool: 'run_command', detail: null, at: at + 1000 });
  const detail = source.detail(keyOf(CID), null);
  assert.deepEqual(detail.events.map((e) => [e.kind, e.tool, e.text]), [['user', null, null], ['thinking', null, null], ['tool', 'run_command', null]]);
  assert.equal(JSON.stringify(detail).includes('Private'), false);
});

// ---- the side panel ----

test('the side panel shows requests, replies, tool calls and their results, each step once', (t) => {
  const root = agyHome(t);
  const at = T0 - 2 * MINUTE;
  const file = writeTranscript(root, CID, [
    ask(at, 'Run the tests'),
    note(at + 100, 'CONVERSATION_HISTORY', 'Old history'),
    uses(at + 1000, [call('run_command', { CommandLine: 'npm test\necho done', Cwd: FOLDER }), call('search_web', { query: 'node test runner' })]),
    // The same step written again when it finished: it shows once, as it is now.
    { ...ran(at + 1500, 'RUN_COMMAND', ''), step_index: 3, status: 'RUNNING' },
    { ...ran(at + 1500, 'RUN_COMMAND', '12 passed, 0 failed'), step_index: 3 },
    { ...ran(at + 1800, 'SEARCH_WEB', 'Node has a test runner.'), step_index: 4 },
    { ...uses(at + 2000, [{ name: 'view_file', args: JSON.stringify({ AbsolutePath: '/home/ada/project/src/login.js' }) }]), step_index: 5 },
    { ...ran(at + 2500, 'VIEW_FILE', 'No such file.', { status: 'ERROR' }), step_index: 6 },
    { ...reply(at + 3000, 'The tests pass.'), step_index: 7 },
    { source: 'SYSTEM', type: 'ERROR_MESSAGE', status: 'DONE', created_at: iso(at + 4000), content: 'The model is busy. Try again.', step_index: 8 },
  ]);
  const { source, poll } = open(root);
  poll();
  const first = source.detail(keyOf(CID), null);
  assert.equal(first.reset, true, 'each answer is the whole recent list');
  assert.equal(first.next, fs.statSync(file).size);
  assert.deepEqual(first.events.map((e) => [e.at, e.kind, e.tool, e.text]), [
    [at, 'user', null, 'Run the tests'],
    [at + 1000, 'tool', 'run_command', 'npm test'],
    [at + 1000, 'tool', 'search_web', 'node test runner'],
    [at + 1500, 'result', 'run_command', '12 passed, 0 failed'],
    [at + 1800, 'result', 'search_web', 'Node has a test runner.'],
    [at + 2000, 'tool', 'view_file', 'login.js'],
    [at + 2500, 'error', 'view_file', 'No such file.'],
    [at + 3000, 'assistant', null, 'The tests pass.'],
    [at + 4000, 'error', null, 'The model is busy. Try again.'],
  ]);
  assert.equal(JSON.stringify(first).includes('Created At'), false, 'the times at the top of a result are left out');

  // Nothing new since the last answer: no events, and the page keeps what it has.
  assert.deepEqual(source.detail(keyOf(CID), first.next), { events: [], next: first.next });
  append(file, { ...ask(at + 5000, 'One more thing'), step_index: 9 });
  const later = source.detail(keyOf(CID), first.next);
  assert.equal(later.reset, true);
  assert.deepEqual(later.events.at(-1), { at: at + 5000, kind: 'user', tool: null, text: 'One more thing' });
  assert.equal(later.events.length, 10);

  assert.deepEqual(source.detail(keyOf(idAt(9)), null), { events: [], next: null });
  assert.deepEqual(source.detail(`gemini:${CID}`, null), { events: [], next: null });
  assert.deepEqual(source.detail(42, null), { events: [], next: null });
});

// ---- status ----

test('status: working, ready, idle, error and stopped, from the steps and the window settings', (t) => {
  const root = agyHome(t);
  const test = (n, steps) => writeTranscript(root, idAt(n), steps);
  const runs = (ms, command) => uses(ms, [call('run_command', { CommandLine: command, Cwd: FOLDER })]);
  // A reply that calls a tool, with no result yet: the tool is running.
  test(1, [ask(T0 - 3 * MINUTE, 'Test it'), runs(T0 - MINUTE, 'npm test')]);
  // A tool step that is RUNNING and recent.
  test(2, [ask(T0 - 5 * MINUTE, 'Build it'), runs(T0 - 4 * MINUTE, 'npm run build'), ran(T0 - 4 * MINUTE + 500, 'RUN_COMMAND', '', { status: 'RUNNING' })]);
  test(3, [ask(T0 - 5 * MINUTE, 'Check it'), reply(T0 - 2 * MINUTE, 'All done.')]);
  test(4, [ask(T0 - 30 * MINUTE, 'Old'), reply(T0 - 20 * MINUTE, 'Done long ago.')]);
  test(5, [ask(T0 - 5 * MINUTE, 'Go'), { source: 'SYSTEM', type: 'ERROR_MESSAGE', status: 'DONE', created_at: iso(T0 - 4 * MINUTE), content: 'Quota used up.' }]);
  test(6, [ask(T0 - 5 * MINUTE, 'Go'), reply(T0 - 4 * MINUTE, '', { status: 'ERROR' })]);
  // A tool that failed: the model sees the error and goes on.
  test(7, [ask(T0 - 3 * MINUTE, 'Read it'), uses(T0 - 2 * MINUTE, [call('view_file', { AbsolutePath: '/x/a.js' })]), ran(T0 - 2 * MINUTE + 500, 'VIEW_FILE', 'No such file.', { status: 'ERROR' })]);
  // A turn that went quiet for longer than staleMinutes.
  test(8, [ask(T0 - 50 * MINUTE, 'Wait'), runs(T0 - 45 * MINUTE, 'sleep 9999')]);
  test(9, [ask(T0 - 60 * MINUTE, 'Wait'), runs(T0 - 59 * MINUTE, 'sleep 9999'), ran(T0 - 58 * MINUTE, 'RUN_COMMAND', '', { status: 'RUNNING' })]);
  // The turn ended, but a command it started still runs in the background.
  test(10, [ask(T0 - 9 * MINUTE, 'Start the server'), runs(T0 - 8 * MINUTE, 'npm run dev'), ran(T0 - 8 * MINUTE + 100, 'RUN_COMMAND', '', { status: 'RUNNING' }), reply(T0 - 7 * MINUTE, 'The server runs.')]);
  // The person stopped it.
  test(11, [ask(T0 - 3 * MINUTE, 'Test it'), runs(T0 - 2 * MINUTE, 'npm test'), ran(T0 - 2 * MINUTE + 100, 'RUN_COMMAND', '', { status: 'CANCELED' })]);

  const { poll } = open(root);
  const byId = new Map(poll().sessions.map((s) => [s.id, s]));
  const status = (n) => byId.get(idAt(n)).status;
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map(status), [
    'working', 'working', 'ready', 'idle', 'error', 'error', 'working', 'idle', 'idle', 'working', 'ready',
  ]);
  assert.deepEqual(byId.get(idAt(1)).activity, { tool: 'run_command', detail: 'npm test', at: T0 - MINUTE });
  assert.deepEqual(byId.get(idAt(2)).activity, { tool: 'run_command', detail: 'npm run build', at: T0 - 4 * MINUTE + 500 });
  assert.deepEqual(byId.get(idAt(10)).activity, { tool: 'run_command', detail: 'npm run dev', at: T0 - 8 * MINUTE + 100 });
  assert.equal(byId.get(idAt(7)).activity, null, 'the model is thinking about the error');
  assert.equal(byId.get(idAt(3)).activity, null);
  // Approvals are never shown as "Needs you": a run without a person denies them quietly.
  assert.ok([...byId.values()].every((s) => s.needs === null));

  const tight = new Map(open(root, { window: { activeMinutes: 1, staleMinutes: 5 } }).poll().sessions.map((s) => [s.id, s.status]));
  assert.equal(tight.get(idAt(3)), 'idle', 'finished more than activeMinutes ago');
  assert.equal(tight.get(idAt(2)), 'working');
  assert.equal(tight.get(idAt(10)), 'idle', 'the background command started more than staleMinutes ago');
});

// ---- helpers ----

test('a helper started through INVOKE_SUBAGENT hangs under the conversation that started it', (t) => {
  const root = agyHome(t);
  const at = T0 - 15 * MINUTE;
  writeMeta(root, { [CID]: { summary: { WorkspaceURIs: [`file://${FOLDER}`] } } });
  const lead = writeTranscript(root, CID, [
    ask(at, 'Why is checkout slow?'),
    uses(at + 1000, [call('invoke_subagent', { Subagents: [{ Role: 'Slow query finder', TypeName: 'research', Prompt: 'Find the slow queries.' }] })]),
    invoked(at + 2000, [KID]),
    reply(at + 3000, 'A helper is looking for slow queries.'),
  ]);
  const kid = writeTranscript(root, KID, [
    { ...ask(at + 2500, 'Find the slow queries.'), content: `<subagent_reminder>\nYou are a subagent of ${CID}.\n</subagent_reminder>\n<USER_REQUEST>\nFind the slow queries.\n</USER_REQUEST>` },
    uses(at + 4000, [call('grep_search', { SearchPath: '/home/ada/project/src', Query: 'SELECT' })]),
  ]);

  const { clock, poll } = open(root);
  let byKey = new Map(poll().sessions.map((s) => [s.key, s]));
  let helper = byKey.get(keyOf(KID));
  assert.equal(helper.kind, 'agent');
  assert.equal(helper.parentKey, keyOf(CID));
  assert.equal(helper.spawned, true);
  assert.equal(helper.title, 'Slow query finder', 'named by the role it was given');
  assert.equal(helper.titleSource, 'role');
  assert.equal(helper.cwd, FOLDER, "a helper with no folder of its own takes its conversation's");
  assert.equal(helper.status, 'working');
  assert.deepEqual(helper.activity, { tool: 'grep_search', detail: 'SELECT', at: at + 4000 });
  // The conversation's own turn ended, but it is working while its helper is.
  assert.equal(byKey.get(keyOf(CID)).status, 'working');
  assert.deepEqual(byKey.get(keyOf(CID)).links, [{ at: at + 2500, dir: 'down', other: keyOf(KID), label: 'Slow query finder' }]);

  append(kid, { ...ran(at + 5000, 'GREP_SEARCH', 'orders.sql: SELECT * FROM orders'), step_index: 2 }, { ...reply(at + 6000, 'Three queries read every order.'), step_index: 3 });
  clock.now += SECOND;
  byKey = new Map(poll().sessions.map((s) => [s.key, s]));
  helper = byKey.get(keyOf(KID));
  assert.equal(helper.status, 'done');
  assert.equal(helper.lastText, 'Three queries read every order.');
  assert.equal(byKey.get(keyOf(CID)).status, 'idle', 'its own turn ended 15 minutes ago');
  assert.deepEqual(byKey.get(keyOf(CID)).links.at(-1), { at: at + 6000, dir: 'up', other: keyOf(KID), label: 'Three queries read every order.' });

  // A helper started after the folder was listed shows at once, without waiting for the next listing.
  const other = idAt(77);
  writeTranscript(root, other, [ask(at + 7000, 'Check the indexes'), reply(at + 8000, 'Two indexes are missing.')]);
  append(lead,
    { ...uses(at + 7000, [{ name: 'invoke_subagent', args: { Subagents: [{ Role: 'Index checker' }] } }]), step_index: 4 },
    { ...ran(at + 7500, 'INVOKE_SUBAGENT', JSON.stringify({ subagents: [{ conversation_id: other, role: 'Index auditor' }] })), step_index: 5 });
  byKey = new Map(poll().sessions.map((s) => [s.key, s]));
  assert.equal(byKey.get(keyOf(other)).parentKey, keyOf(CID));
  assert.equal(byKey.get(keyOf(other)).title, 'Index auditor', 'the role in the result comes first');
  assert.equal(byKey.get(keyOf(other)).status, 'done');
});

test('a helper whose parent is not known still shows as a helper, and two conversations naming each other make no loop', (t) => {
  const root = agyHome(t);
  const at = T0 - 3 * MINUTE;
  writeTranscript(root, idAt(1), [
    { ...ask(at, 'Look around'), content: '<subagent_reminder>\nYou are a subagent.\n</subagent_reminder>\n<USER_REQUEST>\nLook around\n</USER_REQUEST>' },
    reply(at + 1000, 'Looked.'),
  ]);
  writeTranscript(root, idAt(2), [ask(at, 'A'), invoked(at + 100, [idAt(3), idAt(2)]), reply(at + 200, 'A done.')]);
  writeTranscript(root, idAt(3), [ask(at, 'B'), invoked(at + 100, [idAt(2)]), reply(at + 200, 'B done.')]);
  const byId = new Map(open(root).poll().sessions.map((s) => [s.id, s]));
  assert.equal(byId.get(idAt(1)).kind, 'agent');
  assert.equal(byId.get(idAt(1)).parentKey, null);
  assert.equal(byId.get(idAt(1)).status, 'done');
  assert.equal(byId.get(idAt(1)).title, 'Look around');
  assert.equal(byId.get(idAt(2)).parentKey, null);
  assert.equal(byId.get(idAt(3)).parentKey, keyOf(idAt(2)));
  assert.equal(byId.get(idAt(2)).kind, 'session');
});

// ---- rewrites, broken lines and big transcripts ----

test('a checkpoint that writes the transcript again, smaller, is read again from the start', (t) => {
  const root = agyHome(t);
  const at = T0 - 8 * MINUTE;
  const big = 'x'.repeat(20000);
  const file = writeTranscript(root, CID, [
    ask(at, 'First request'),
    uses(at + 1000, [call('view_file', { AbsolutePath: '/home/ada/project/big.txt' })]),
    ran(at + 1500, 'VIEW_FILE', big),
    reply(at + 2000, 'First answer.'),
    ask(at + 3000, 'Second request'),
    reply(at + 4000, 'Second answer, the long version.'),
  ]);
  const { clock, source, poll } = open(root);
  let [s] = poll().sessions;
  assert.equal(s.lastText, 'Second answer, the long version.');
  const before = fs.statSync(file).size;

  // Old history squeezed down: the old steps are cleared and the newest written again.
  fs.writeFileSync(file, [
    { ...ask(at, ''), content: '', status: 'CLEARED', step_index: 0 },
    { ...uses(at + 1000, []), status: 'CLEARED', step_index: 1 },
    { ...ran(at + 1500, 'VIEW_FILE', ''), content: '', status: 'CLEARED', step_index: 2 },
    { ...reply(at + 2000, ''), status: 'CLEARED', step_index: 3 },
    { ...ask(at + 3000, 'Second request'), step_index: 4 },
    { ...reply(at + 4000, 'Second answer.'), step_index: 5 },
    { ...note(at + 4500, 'CHECKPOINT', 'Earlier: the person asked to read big.txt.'), step_index: 6 },
  ].map(line).join(''));
  assert.ok(fs.statSync(file).size < before);
  clock.now += SECOND;
  [s] = poll().sessions;
  assert.equal(s.lastText, 'Second answer.');
  assert.equal(s.title, 'First request', 'the first request still names it');
  assert.equal(s.status, 'ready');
  assert.equal(s.startedAt, at);
  const detail = source.detail(keyOf(CID), null);
  assert.deepEqual(detail.events.filter((e) => e.kind !== 'tool').map((e) => [e.kind, e.text]), [
    ['user', 'Second request'],
    ['assistant', 'Second answer.'],
  ]);

  append(file, { ...ask(at + 5000, 'Third request'), step_index: 7 }, { ...reply(at + 6000, 'Third answer.'), step_index: 8 });
  [s] = poll().sessions;
  assert.equal(s.lastText, 'Third answer.');
});

test('a broken line is skipped, and a half-written last line waits for its newline', (t) => {
  const root = agyHome(t);
  const at = T0 - 2 * MINUTE;
  const file = writeTranscript(root, CID, [
    ask(at, 'Hello'),
    'this line is broken\n',
    { ...reply(at + 1000, 'Hi there.'), step_index: 2 },
  ]);
  const half = JSON.stringify({ ...reply(at + 2000, 'More words.'), step_index: 3 });
  fs.appendFileSync(file, half.slice(0, 40));
  const { poll } = open(root);
  let [s] = poll().sessions;
  assert.equal(s.lastText, 'Hi there.');
  assert.equal(s.status, 'ready');
  fs.appendFileSync(file, `${half.slice(40)}\n`);
  [s] = poll().sessions;
  assert.equal(s.lastText, 'More words.');
  assert.equal(s.lastAt, at + 2000);
});

test('a big transcript read from near its end keeps its first request, start and the helpers it named early on', (t) => {
  const root = agyHome(t);
  const at = T0 - 60 * MINUTE;
  const filler = 'y'.repeat(100 * 1024);
  const steps = [
    ask(at, 'Index the whole repository'),
    uses(at + 1000, [call('invoke_subagent', { Subagents: [{ Role: 'Docs indexer' }] })]),
    invoked(at + 2000, [KID]),
  ];
  for (let i = 0; i < 50; i++) steps.push(ran(at + 3000 + i, 'VIEW_FILE', filler));
  steps.push(reply(T0 - 2 * MINUTE, 'The index is ready.'));
  const file = writeTranscript(root, CID, steps, { full: true });
  assert.ok(fs.statSync(file).size > 4 * 1024 * 1024);
  writeTranscript(root, KID, [ask(at + 2500, 'Index the docs'), reply(at + 9000, 'The docs are indexed.')]);
  const byId = new Map(open(root).poll().sessions.map((s) => [s.id, s]));
  const lead = byId.get(CID);
  assert.equal(lead.title, 'Index the whole repository');
  assert.equal(lead.startedAt, at);
  assert.equal(lead.lastText, 'The index is ready.');
  assert.equal(byId.get(KID).parentKey, keyOf(CID));
  assert.equal(byId.get(KID).title, 'Index the docs');
});

// ---- what Pleni opens ----

test('Pleni opens only the transcripts, the two cache lists and history.jsonl, never the login, settings or databases', (t) => {
  const root = agyHome(t);
  const at = T0 - 2 * MINUTE;
  writeMeta(root, { [CID]: { summary: { WorkspaceURIs: [`file://${FOLDER}`] } } });
  writeLast(root, { [FOLDER]: CID });
  writeHistory(root, [{ display: 'Hello', timestamp: at, workspace: FOLDER, conversationId: CID }]);
  writeTranscript(root, CID, [ask(at, 'Hello'), reply(at + 1000, 'Hi there.')]);
  const secret = 'SECRET-TOKEN-1234';
  const files = ['antigravity-oauth-token', 'keybindings.json', `conversations/${CID}.db`, `conversations/${CID}.db-wal`, 'conversation_summaries.db', 'log/cli-1.log',
    `brain/${CID}/implementation_plan.md`, `brain/${CID}/.system_generated/logs/other.jsonl`, 'cache/other.json'];
  for (const name of files) {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, secret);
    fs.chmodSync(file, 0); // no read permission
  }
  fs.mkdirSync(path.join(root, 'settings.json')); // a folder: reading it as a file would fail

  const spies = ['openSync', 'readFileSync', 'readdirSync', 'statSync'].map((name) => t.mock.method(fs, name));
  const { source, poll } = open(root);
  const out = poll();
  const detail = source.detail(keyOf(CID), null);
  const looked = spies
    .flatMap((spy) => spy.mock.calls.map((c) => String(c.arguments[0])))
    .filter((file) => file.startsWith(root))
    .map((file) => path.relative(root, file).split(path.sep).join('/'));
  for (const spy of spies) spy.mock.restore();

  assert.equal(out.sessions.length, 1);
  assert.equal(out.sessions[0].cwd, FOLDER);
  assert.equal(detail.events.length, 2);
  assert.ok(looked.length > 0);
  const allowed = (file) => file === '' || file === 'brain' || file === 'history.jsonl'
    || file === 'cache/conversation_metadata.json' || file === 'cache/last_conversations.json'
    || /^brain\/[^/]+\/\.system_generated\/logs\/transcript(_full)?\.jsonl$/.test(file);
  for (const file of looked) assert.ok(allowed(file), `Pleni looked at ${file}`);
  assert.equal(JSON.stringify([out, detail]).includes(secret), false);
});

// ---- errors ----

test('without its folder, the source says so in plain words', (t) => {
  assert.deepEqual(createAntigravitySource({ root: null, settings: cleanSettings({}) }).poll(), {
    ok: false,
    error: 'No Antigravity CLI folder is set.',
    root: null,
    sessions: [],
  });
  const missing = path.join(agyHome(t), 'missing');
  const out = createAntigravitySource({ root: missing, settings: cleanSettings({}) }).poll();
  assert.deepEqual(out, { ok: false, error: 'Pleni could not find the Antigravity CLI folder.', root: missing, sessions: [] });
  // A folder with no brain folder yet is fine: there is simply nothing to show.
  const empty = agyHome(t);
  assert.deepEqual(createAntigravitySource({ root: empty, settings: cleanSettings({}) }).poll(), { ok: true, error: null, root: empty, sessions: [] });
});
