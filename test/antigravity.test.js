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
// A step cleared to save space: no words, and no time left.
const cleared = (step, index) => ({ ...step, created_at: undefined, content: '', status: 'CLEARED', step_index: index });

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

test('looks for new conversations every 30 seconds, and reads the cache and history files again then', (t) => {
  const root = agyHome(t);
  const at = T0 - 5 * MINUTE;
  writeTranscript(root, idAt(1), [ask(at, 'First request'), reply(at + 1000, 'Done.')]);
  writeHistory(root, [{ display: 'Another one', timestamp: at, workspace: '/home/ada/elsewhere', conversationId: idAt(9) }]);
  const { clock, poll } = open(root);
  const seen = () => poll().sessions.map((s) => [s.id, s.title, s.titleSource, s.cwd]);
  assert.deepEqual(seen(), [[idAt(1), 'First request', 'first-prompt', null]]);

  // A new conversation, a title and folder for the first one, and a history line for the new one.
  writeTranscript(root, idAt(2), [ask(T0 - MINUTE, 'Second request'), reply(T0 - MINUTE + 1000, 'Done too.')]);
  writeMeta(root, { [idAt(1)]: { summary: { Title: 'Named later', WorkspaceURIs: [`file://${FOLDER}`] } } });
  fs.appendFileSync(path.join(root, 'history.jsonl'), line({ display: 'Second request', timestamp: T0 - MINUTE, workspace: '/home/ada/history-project', conversationId: idAt(2) }));
  clock.now = T0 + 10 * SECOND;
  assert.deepEqual(seen(), [[idAt(1), 'First request', 'first-prompt', null]], 'not yet: the folder was listed 10 seconds ago');
  clock.now = T0 + 31 * SECOND;
  assert.deepEqual(seen(), [
    [idAt(1), 'Named later', 'summary', FOLDER],
    [idAt(2), 'Second request', 'first-prompt', '/home/ada/history-project'],
  ]);
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
    { display: 'fix login pls', timestamp: at, workspace: FOLDER, conversationId: idAt(1) }, // the first request comes first
    { display: '/model', timestamp: at, workspace: FOLDER, conversationId: idAt(3) }, // a command, not a name
    { display: 'Tidy the docs folder', timestamp: at, workspace: FOLDER, conversationId: idAt(3) },
  ]);
  writeTranscript(root, idAt(4), [ask(at, 'A long first request'), reply(at + 1000, 'Done.')]);
  writeMeta(root, { [idAt(4)]: { summary: { title: 'Named by Antigravity', WorkspaceURIs: [] } } });
  // A first request with no words that was never cleared (only a picture): the first request with
  // words names it, not history.jsonl, which comes first only after a squeeze.
  writeTranscript(root, idAt(5), [
    { ...ask(at, ''), content: [{ inline_data: { mime_type: 'image/png' } }] },
    reply(at + 1000, 'I see a login form.'),
    ask(at + 2000, 'Make the button blue'),
    reply(at + 3000, 'Done.'),
  ]);
  fs.appendFileSync(path.join(root, 'history.jsonl'), line({ display: '[Image #1]', timestamp: at, workspace: FOLDER, conversationId: idAt(5) }));

  const byId = new Map(open(root).poll().sessions.map((s) => [s.id, [s.title, s.titleSource]]));
  assert.deepEqual(byId.get(idAt(1)), ['Fix the login page It shows a blank screen.', 'first-prompt']);
  assert.deepEqual(byId.get(idAt(2)), ['Plain words here', 'first-prompt']);
  assert.deepEqual(byId.get(idAt(3)), ['Tidy the docs folder', 'history']);
  assert.deepEqual(byId.get(idAt(4)), ['Named by Antigravity', 'summary']);
  assert.deepEqual(byId.get(idAt(5)), ['Make the button blue', 'first-prompt']);
});

test('a request without tags keeps the person\'s own words, even an upper-case <WORD> in them', (t) => {
  const root = agyHome(t);
  const at = T0 - 4 * MINUTE;
  const said = [
    'Fill in the <TODO> parts of main.js',
    'Replace <YOUR_PROJECT_ID> in deploy.sh with my project and run it',
    'Use <ENTER> to submit, not <TAB>',
    `What does the <API_KEY> setting in config.json do?\n${ADDED}`,
    // A closed block inside a sentence is the person's own too, and so is one at the start of a
    // line with more words after it on that line.
    'Why does <TITLE>Home</TITLE> not show?',
    '<TITLE>Home</TITLE> does not show on the page',
    'Fix this:\n<NOTE>keep it short</NOTE> and add a test',
    'Wrap the output in <CODE>\nconsole.log(1)\n</CODE> and send it back',
    // A closed block on lines of its own is one Antigravity CLI added, whatever its name.
    'Sum up the thread\n<PREVIOUS_CONVERSATION_THREAD>\nEarlier words.\n</PREVIOUS_CONVERSATION_THREAD>',
    // A known block may run on to the end of a text that was cut short.
    'Short ask\n<ADDITIONAL_METADATA>\nThe current local time is: 2026-11-04T10:',
  ];
  said.forEach((content, i) => writeTranscript(root, idAt(i + 1), [{ ...ask(at, ''), content }, reply(at + 1000, 'Done.')]));
  // A pasted log with a tag on each of many lines, never closed after it (a closing tag before it
  // does not close it): the words stay, and they are read in one go, so even a long log is quick.
  // A clock checks that: the old pattern took many seconds here (a test's timeout cannot stop it).
  const pasted = Array.from({ length: 40000 }, (_, i) => `<WARN>\nDisk is ${i % 100}% full.`).join('\n');
  writeTranscript(root, idAt(20), [{ ...ask(at, ''), content: `What does </WARN> mean in this log?\n${pasted}` }, reply(at + 1000, 'The disk fills up.')]);
  const { source, get, poll } = open(root);
  let started = performance.now();
  const titles = poll().sessions.filter((s) => s.id !== idAt(20)).map((s) => s.title);
  assert.ok(performance.now() - started < 3000, 'a long pasted log is read quickly');
  const words = [
    'Fill in the <TODO> parts of main.js',
    'Replace <YOUR_PROJECT_ID> in deploy.sh with my project and run it',
    'Use <ENTER> to submit, not <TAB>',
    'What does the <API_KEY> setting in config.json do?',
    'Why does <TITLE>Home</TITLE> not show?',
    '<TITLE>Home</TITLE> does not show on the page',
    'Fix this: <NOTE>keep it short</NOTE> and add a test',
    'Wrap the output in <CODE> console.log(1) </CODE> and send it back',
    'Sum up the thread',
    'Short ask',
  ];
  assert.deepEqual(titles, words);
  const shown = (id) => source.detail(keyOf(id), null).events[0].text;
  assert.deepEqual(said.map((_, i) => shown(idAt(i + 1)).replace(/\s+/g, ' ')), words, 'the side panel shows the same words');
  assert.match(get(keyOf(idAt(20))).title, /^What does <\/WARN> mean in this log\? <WARN> Disk is 0% full\. <WARN> Disk is 1% full\./);
  started = performance.now();
  assert.match(shown(idAt(20)), /^What does <\/WARN> mean in this log\?\n<WARN>\nDisk is 0% full\.\n<WARN>\nDisk is 1% full\./);
  assert.ok(performance.now() - started < 3000, 'the side panel reads a long pasted log quickly');
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
  writeTranscript(root, CID, [
    ask(at, 'Private request'),
    uses(at + 1000, [call('run_command', { CommandLine: 'npm test -- --secret', Cwd: FOLDER })], { thinking: THOUGHT }),
  ]);
  // Helpers too: a role from the call or from a JSON result is words the model wrote.
  const lead = idAt(5);
  writeTranscript(root, lead, [
    ask(at, 'Private plan'),
    uses(at + 1000, [call('invoke_subagent', { Subagents: [{ Role: 'Private role' }] })]),
    invoked(at + 1500, [KID]),
    uses(at + 1600, [call('invoke_subagent', { Subagents: [{ Role: 'Private role too' }] })]),
    ran(at + 1700, 'INVOKE_SUBAGENT', JSON.stringify({ subagents: [{ conversation_id: idAt(6), role: 'Private result role' }] })),
    reply(at + 2000, 'Private summary.'),
  ]);
  writeTranscript(root, KID, [ask(at + 1550, 'Private task'), reply(at + 1800, 'Private answer.')]);
  writeTranscript(root, idAt(6), [ask(at + 1750, 'Private task two'), reply(at + 1900, 'Private answer two.')]);
  writeMeta(root, {
    [CID]: { summary: { Title: 'Private title', WorkspaceURIs: [`file://${FOLDER}`] } },
    [KID]: { summary: { Title: 'Private helper title' } },
  });
  const { source, poll } = open(root, { content: 'none' });
  const sessions = poll().sessions;
  const s = sessions.find((x) => x.id === CID);
  assert.equal(s.cwd, FOLDER, 'the folder is not session text');
  assert.equal(s.status, 'working');
  assert.deepEqual(s.activity, { tool: 'run_command', detail: null, at: at + 1000 });
  assert.deepEqual(sessions.map((x) => [x.id, x.parentKey]), [[idAt(5), null], [idAt(6), keyOf(lead)], [CID, null], [KID, keyOf(lead)]]);
  for (const x of sessions) {
    assert.deepEqual([x.title, x.titleSource, x.lastText], [null, null, null], x.id);
    assert.ok(x.links.every((link) => link.label === null), x.id);
  }
  assert.equal(/private|secret/i.test(JSON.stringify(sessions)), false);
  const detail = source.detail(keyOf(CID), null);
  assert.deepEqual(detail.events.map((e) => [e.kind, e.tool, e.text]), [['user', null, null], ['thinking', null, null], ['tool', 'run_command', null]]);
  for (const x of sessions) assert.equal(/private|secret/i.test(JSON.stringify(source.detail(x.key, null))), false, x.id);
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

test('a step written again keeps the place of its first copy, and its newest copy wins', (t) => {
  const root = agyHome(t);
  const at = T0 - 3 * MINUTE;
  const file = writeTranscript(root, CID, [
    ask(at, 'Start the server'),
    uses(at + 1000, [call('run_command', { CommandLine: 'npm run dev' })]),
    ran(at + 1500, 'RUN_COMMAND', '', { status: 'RUNNING' }),
    reply(at + 2000, 'The server runs.'),
  ]);
  const { clock, source, get } = open(root);
  assert.equal(get(keyOf(CID)).status, 'working', 'the command still runs');
  // The command ends after the reply that ended the turn: its step is written again, done.
  append(file, { ...ran(at + 1500, 'RUN_COMMAND', 'The server stopped.'), step_index: 2 });
  clock.now += SECOND;
  const s = get(keyOf(CID));
  assert.equal(s.status, 'ready', 'the result still comes before the reply, so the turn stays ended');
  assert.equal(s.activity, null);
  assert.deepEqual(source.detail(keyOf(CID), null).events.map((e) => [e.kind, e.tool, e.text]), [
    ['user', null, 'Start the server'],
    ['tool', 'run_command', 'npm run dev'],
    ['result', 'run_command', 'The server stopped.'],
    ['assistant', null, 'The server runs.'],
  ]);
});

test('a tool\'s result answers the waiting call with its own name, even when it comes back first', (t) => {
  const root = agyHome(t);
  const at = T0 - 2 * MINUTE;
  const login = { AbsolutePath: '/home/ada/project/src/login.js' };
  // view_file is asked for first, but run_command's step comes back first, still running.
  writeTranscript(root, idAt(1), [
    ask(at, 'Read it and test it'),
    uses(at + 1000, [call('view_file', login), call('run_command', { CommandLine: 'npm test' })]),
    ran(at + 1500, 'RUN_COMMAND', '', { status: 'RUNNING' }),
  ]);
  // The other way round: the file comes back before the command's result.
  writeTranscript(root, idAt(2), [
    ask(at, 'Test it and read it'),
    uses(at + 1000, [call('run_command', { CommandLine: 'npm test' }), call('view_file', login)]),
    ran(at + 1500, 'VIEW_FILE', 'The login page.'),
    ran(at + 2000, 'RUN_COMMAND', '12 passed'),
    reply(at + 2500, 'All good.'),
  ]);
  // A result whose name fits no call answers the first call that still waits.
  writeTranscript(root, idAt(3), [
    ask(at, 'Find it'),
    uses(at + 1000, [call('grep_search', { Query: 'login' }), call('view_file', login)]),
    ran(at + 1500, 'FIND_TEXT', 'src/login.js'),
    ran(at + 2000, 'VIEW_FILE', 'The login page.'),
    reply(at + 2500, 'Found it.'),
  ]);
  const { source, get } = open(root);
  assert.deepEqual(get(keyOf(idAt(1))).activity, { tool: 'run_command', detail: 'npm test', at: at + 1500 });
  const results = (n) => source.detail(keyOf(idAt(n)), null).events.filter((e) => e.kind === 'result').map((e) => [e.tool, e.text]);
  assert.deepEqual(results(2), [['view_file', 'The login page.'], ['run_command', '12 passed']]);
  assert.deepEqual(results(3), [['grep_search', 'src/login.js'], ['view_file', 'The login page.']]);
});

test('the side panel explains a failed or stopped reply, a stopped tool, and a failure with no words', (t) => {
  const root = agyHome(t);
  const at = T0 - 5 * MINUTE;
  writeTranscript(root, CID, [
    ask(at, 'Go'),
    reply(at + 1000, '', { status: 'ERROR' }),
    ask(at + 2000, 'Again'),
    reply(at + 3000, '', { status: 'CANCELED' }),
    ask(at + 4000, 'Run it'),
    uses(at + 5000, [call('run_command', { CommandLine: 'npm test' })]),
    ran(at + 6000, 'RUN_COMMAND', '', { status: 'CANCELED' }),
    ask(at + 7000, 'Read it'),
    uses(at + 8000, [call('view_file', { AbsolutePath: '/home/ada/project/a.js' })]),
    { ...ran(at + 9000, 'VIEW_FILE', ''), content: '', status: 'ERROR' },
    { source: 'SYSTEM', type: 'ERROR_MESSAGE', status: 'DONE', created_at: iso(at + 10000), content: '' },
  ]);
  const { source, poll } = open(root);
  poll();
  const errors = source.detail(keyOf(CID), null).events.filter((e) => e.kind === 'error').map((e) => [e.at - at, e.tool, e.text]);
  assert.deepEqual(errors, [
    [1000, null, 'Antigravity CLI stopped with an error.'],
    [3000, null, 'Stopped'],
    [6000, 'run_command', 'Stopped'],
    [9000, 'view_file', 'The tool failed.'],
    [10000, null, 'Antigravity CLI stopped with an error.'],
  ]);
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
  // No step here waits for the person to allow it.
  assert.ok([...byId.values()].every((s) => s.needs === null));

  const tight = new Map(open(root, { window: { activeMinutes: 1, staleMinutes: 5 } }).poll().sessions.map((s) => [s.id, s.status]));
  assert.equal(tight.get(idAt(3)), 'idle', 'finished more than activeMinutes ago');
  assert.equal(tight.get(idAt(2)), 'working');
  assert.equal(tight.get(idAt(10)), 'idle', 'the background command started more than staleMinutes ago');
});

test('a tool that waits for the person to allow it, or to answer its question, needs them once it has waited 15 seconds', (t) => {
  const root = agyHome(t);
  const runs = (ms, command) => uses(ms, [call('run_command', { CommandLine: command, Cwd: FOLDER })]);
  const waits = (ms, status = 'WAITING') => ran(ms, 'RUN_COMMAND', '', { status });
  const asking = writeTranscript(root, idAt(1), [ask(T0 - MINUTE, 'Clean the build'), runs(T0 - 20 * SECOND, 'rm -rf build'), waits(T0 - 10 * SECOND)]);
  // A PENDING step has not started yet: it does not wait for the person.
  writeTranscript(root, idAt(2), [ask(T0 - MINUTE, 'Test it'), runs(T0 - 50 * SECOND, 'npm test'), waits(T0 - 40 * SECOND, 'PENDING')]);
  // A helper's start waits for the helper, not the person.
  writeTranscript(root, idAt(3), [
    ask(T0 - MINUTE, 'Ask a helper'),
    uses(T0 - 50 * SECOND, [call('invoke_subagent', { Subagents: [{ Role: 'Checker' }] })]),
    ran(T0 - 40 * SECOND, 'INVOKE_SUBAGENT', '', { status: 'WAITING' }),
  ]);
  // A wait in an earlier turn is over once the person asked something else.
  writeTranscript(root, idAt(4), [
    ask(T0 - 10 * MINUTE, 'Clean it'), runs(T0 - 9 * MINUTE, 'rm -rf dist'), waits(T0 - 9 * MINUTE),
    ask(T0 - 2 * MINUTE, 'Never mind, test it'), runs(T0 - MINUTE, 'npm test'),
  ]);
  // A wait whose turn ended is over too, though its step was never written again.
  writeTranscript(root, idAt(5), [ask(T0 - MINUTE, 'Clean it'), runs(T0 - 50 * SECOND, 'rm -rf dist'), waits(T0 - 40 * SECOND), reply(T0 - 30 * SECOND, 'I left the folder as it is.')]);
  // A question the agent asks waits for the person's answer: it is not a request to use a tool.
  const question = { questions: [{ question: 'Which database should I use?', options: ['Postgres', 'SQLite'], is_multi_select: false }] };
  const asks = (n, name, type) => writeTranscript(root, idAt(n), [ask(T0 - MINUTE, 'Set up the database'), uses(T0 - 40 * SECOND, [call(name, question)]), ran(T0 - 30 * SECOND, type, '', { status: 'WAITING' })]);
  asks(6, 'ask_question', 'ASK_QUESTION');
  // The name of the step is Pleni's guess: an ask_question call asks, whatever its step is called,
  // and so does an ASK_QUESTION step whose call has another name (that call's words are not shown).
  asks(7, 'ask_question', 'ASK_USER_QUESTION');
  asks(8, 'ask_user', 'ASK_QUESTION');

  const { clock, get } = open(root);
  const needs = (n) => get(keyOf(idAt(n))).needs;
  assert.equal(needs(1), null, 'not yet: Auto mode may still allow it on its own');
  clock.now = T0 + 6 * SECOND;
  const s = get(keyOf(idAt(1)));
  assert.deepEqual(s.needs, { kind: 'permission', text: 'Asks to use run_command: rm -rf build', at: T0 - 10 * SECOND });
  assert.equal(s.status, 'working');
  assert.deepEqual(s.activity, { tool: 'run_command', detail: 'rm -rf build', at: T0 - 10 * SECOND });
  assert.deepEqual([2, 3, 4, 5].map(needs), [null, null, null, null]);
  assert.deepEqual(needs(6), { kind: 'question', text: 'Which database should I use?', at: T0 - 30 * SECOND });
  assert.deepEqual(needs(7), { kind: 'question', text: 'Which database should I use?', at: T0 - 30 * SECOND });
  assert.deepEqual(needs(8), { kind: 'question', text: null, at: T0 - 30 * SECOND });
  const quiet = open(root, { content: 'none' });
  quiet.clock.now = T0 + 6 * SECOND;
  assert.deepEqual(quiet.get(keyOf(idAt(1))).needs, { kind: 'permission', text: null, at: T0 - 10 * SECOND });
  assert.deepEqual(quiet.get(keyOf(idAt(6))).needs, { kind: 'question', text: null, at: T0 - 30 * SECOND });

  // It stays, however long the person takes, until the step is written again as it runs.
  clock.now = T0 + 2 * HOUR;
  assert.equal(needs(1).kind, 'permission');
  append(asking, { ...ran(T0 + 2 * HOUR, 'RUN_COMMAND', '', { status: 'RUNNING' }), step_index: 2 });
  clock.now += SECOND;
  assert.equal(needs(1), null);
});

test('activity is what the turn going now does, not a command an earlier turn left running', (t) => {
  const root = agyHome(t);
  const server = (ms) => [
    ask(ms, 'Start the server'),
    uses(ms + 1000, [call('run_command', { CommandLine: 'npm run dev' })]),
    ran(ms + 1100, 'RUN_COMMAND', '', { status: 'RUNNING' }),
    reply(ms + 2000, 'The server runs.'),
  ];
  const read = (ms) => [ask(ms, 'Now read the login page'), uses(ms + 1000, [call('view_file', { AbsolutePath: '/home/ada/project/src/login.js' })])];
  // The command started 50 minutes ago, longer than staleMinutes: it counts as gone.
  writeTranscript(root, idAt(1), [...server(T0 - 50 * MINUTE), ...read(T0 - MINUTE)]);
  // The command may still run, but the turn going now waits on its own call.
  writeTranscript(root, idAt(2), [...server(T0 - 8 * MINUTE), ...read(T0 - MINUTE)]);
  // The newer turn ended; only the command of the first one still runs.
  writeTranscript(root, idAt(3), [...server(T0 - 8 * MINUTE), ask(T0 - 2 * MINUTE, 'Thanks'), reply(T0 - MINUTE, 'You are welcome.')]);
  // The model thinks about a result, and the old command counts as gone.
  writeTranscript(root, idAt(4), [...server(T0 - 50 * MINUTE), ...read(T0 - 2 * MINUTE), ran(T0 - MINUTE, 'VIEW_FILE', 'The login page.')]);
  const byId = new Map(open(root).poll().sessions.map((s) => [s.id, s]));
  const login = { tool: 'view_file', detail: 'login.js', at: T0 - MINUTE + 1000 };
  assert.deepEqual(byId.get(idAt(1)).activity, login);
  assert.deepEqual(byId.get(idAt(2)).activity, login);
  assert.equal(byId.get(idAt(3)).status, 'working');
  assert.deepEqual(byId.get(idAt(3)).activity, { tool: 'run_command', detail: 'npm run dev', at: T0 - 8 * MINUTE + 1100 });
  assert.equal(byId.get(idAt(4)).status, 'working');
  assert.equal(byId.get(idAt(4)).activity, null);
});

test('a checkpoint or history step keeps the books by its type, and so does any step from SYSTEM', (t) => {
  const root = agyHome(t);
  const at = T0 - 3 * MINUTE;
  const done = [ask(at, 'Check it'), reply(at + 1000, 'All done.')];
  writeTranscript(root, idAt(1), [...done, { ...note(T0 - 10 * SECOND, 'CHECKPOINT', 'Earlier: checked it.'), source: 'MODEL' }]);
  writeTranscript(root, idAt(2), [...done, { ...note(T0 - 10 * SECOND, 'CONVERSATION_HISTORY'), source: undefined }]);
  writeTranscript(root, idAt(3), [...done, note(T0 - 10 * SECOND, 'KNOWLEDGE_ARTIFACTS', 'Notes.')]);
  const byId = new Map(open(root).poll().sessions.map((s) => [s.id, s]));
  for (const n of [1, 2, 3]) assert.deepEqual([byId.get(idAt(n)).status, byId.get(idAt(n)).lastAt], ['ready', at + 1000], `conversation ${n}`);
});

test('a tool\'s detail comes from its arguments, such as an image name or the agent a message goes to', (t) => {
  const root = agyHome(t);
  const waits = (n, name, values) => writeTranscript(root, idAt(n), [ask(T0 - MINUTE, 'Go'), uses(T0 - 30 * SECOND, [call(name, values)])]);
  waits(1, 'send_message', { Recipient: 'code-reviewer', Message: 'Please look at the login page.' });
  waits(2, 'generate_image', { Prompt: 'A small logo', ImageName: 'logo_v2' });
  waits(3, 'run_command', { command: 'npm test\nnpm run lint' });
  waits(4, 'read_url_content', { url: 'https://example.com/docs/page' });
  const byId = new Map(open(root).poll().sessions.map((s) => [s.id, s]));
  assert.deepEqual([1, 2, 3, 4].map((n) => byId.get(idAt(n)).activity.detail), ['code-reviewer', 'logo_v2', 'npm test', 'example.com']);
});

// ---- helpers ----

test('a helper started through INVOKE_SUBAGENT hangs under the conversation that started it', (t) => {
  const root = agyHome(t);
  const at = T0 - 15 * MINUTE;
  // The helper's own title in the metadata comes after the role it was given.
  writeMeta(root, { [CID]: { summary: { WorkspaceURIs: [`file://${FOLDER}`] } }, [KID]: { summary: { Title: 'Summary of the helper' } } });
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
  const reminded = (ms, text, caller) => ({
    ...ask(ms, text),
    content: `<subagent_reminder>\nYou are a subagent.${caller ? `\nThe caller agent that started you has id: ${caller}` : ''}\n</subagent_reminder>\n<USER_REQUEST>\n${text}\n</USER_REQUEST>`,
  });
  writeTranscript(root, idAt(1), [reminded(at, 'Look around'), reply(at + 1000, 'Looked.')]);
  writeTranscript(root, idAt(2), [ask(at, 'A'), invoked(at + 100, [idAt(3), idAt(2)]), reply(at + 200, 'A done.')]);
  writeTranscript(root, idAt(3), [ask(at, 'B'), invoked(at + 100, [idAt(2)]), reply(at + 200, 'B done.')]);
  // The conversation its reminder names last changed two days ago, so Pleni does not show it.
  writeTranscript(root, idAt(4), [reminded(at, 'Keep checking the build', idAt(5)), uses(T0 - MINUTE, [call('run_command', { CommandLine: 'npm run build' })])]);
  writeTranscript(root, idAt(5), [ask(T0 - 49 * HOUR, 'Start a long helper'), reply(T0 - 49 * HOUR, 'Started.')], { mtime: T0 - 48 * HOUR });
  // Two helpers whose reminders name each other.
  writeTranscript(root, idAt(6), [reminded(at, 'Check the left side', idAt(7)), reply(at + 1000, 'Left is fine.')]);
  writeTranscript(root, idAt(7), [reminded(at, 'Check the right side', idAt(6)), reply(at + 1000, 'Right is fine.')]);
  const byId = new Map(open(root).poll().sessions.map((s) => [s.id, s]));
  assert.equal(byId.get(idAt(1)).kind, 'agent');
  assert.equal(byId.get(idAt(1)).parentKey, null);
  assert.equal(byId.get(idAt(1)).status, 'done');
  assert.equal(byId.get(idAt(1)).title, 'Look around');
  assert.equal(byId.get(idAt(2)).parentKey, null);
  assert.equal(byId.get(idAt(3)).parentKey, keyOf(idAt(2)));
  assert.equal(byId.get(idAt(2)).kind, 'session');
  assert.equal(byId.has(idAt(5)), false);
  assert.deepEqual([byId.get(idAt(4)).kind, byId.get(idAt(4)).parentKey, byId.get(idAt(4)).status], ['agent', null, 'working']);
  assert.deepEqual([6, 7].map((n) => byId.get(idAt(n)).parentKey), [keyOf(idAt(7)), null]);
});

test('a helper hangs under the conversation its reminder names, not under a fork that copied the steps that started it', (t) => {
  const root = agyHome(t);
  const at = T0 - 30 * MINUTE;
  const parent = idAt(20);
  const forks = [idAt(10), idAt(30)]; // made later, with copies of the parent's steps; one id sorts first
  const helper = idAt(40);
  const lost = idAt(41); // started first; its start is cleared in the parent now, but not in the forks
  const started = [
    ask(at, 'Why is checkout slow?'),
    uses(at + 1000, [call('invoke_subagent', { Subagents: [{ Role: 'Index checker' }] })]),
    invoked(at + 1500, [lost]),
    uses(at + 1600, [call('invoke_subagent', { Subagents: [{ Role: 'Slow query finder' }] })]),
    invoked(at + 2000, [helper]),
    reply(at + 3000, 'Two helpers are on it.'),
  ];
  // After the forks were made, the parent's oldest steps were squeezed.
  writeTranscript(root, parent, [...started.slice(0, 3).map((step, i) => cleared(step, i)), ...started.slice(3)]);
  for (const id of forks) writeTranscript(root, id, [...started, ask(at + 60000, 'Something else'), reply(at + 61000, 'Done.')]);
  const reminded = (ms, line, text) => ({ ...ask(ms, text), content: `<subagent_reminder>\nYou are a subagent.\n${line}\n</subagent_reminder>\n<USER_REQUEST>\n${text}\n</USER_REQUEST>` });
  writeTranscript(root, helper, [reminded(at + 2500, `The caller agent that started you has id: ${parent}`, 'Find the slow queries.'), uses(T0 - MINUTE, [call('grep_search', { Query: 'SELECT' })])]);
  // Its own id comes first: the line that names the caller agent wins.
  writeTranscript(root, lost, [reminded(at + 1550, `Your conversation id: ${lost}\n<caller agent id="${parent}">`, 'Check the indexes.'), reply(at + 9000, 'Two indexes are missing.')]);

  const byId = new Map(open(root).poll().sessions.map((s) => [s.id, s]));
  assert.equal(byId.get(helper).parentKey, keyOf(parent));
  assert.equal(byId.get(helper).title, 'Slow query finder', 'it keeps the role its parent gave it');
  assert.equal(byId.get(lost).parentKey, keyOf(parent), 'the reminder links a helper that only the forks name now');
  assert.equal(byId.get(parent).status, 'working', 'the parent waits for its helper');
  assert.deepEqual(byId.get(parent).links.map((l) => [l.dir, l.other]), [['down', keyOf(lost)], ['down', keyOf(helper)], ['up', keyOf(lost)]]);
  for (const id of forks) {
    assert.equal(byId.get(id).status, 'idle', 'a fork does not wait for a helper it did not start');
    assert.deepEqual(byId.get(id).links, []);
  }
});

test('a helper forked from a helper hangs under the one that started it, though its transcript starts with a copy of that one\'s steps', (t) => {
  const root = agyHome(t);
  const at = T0 - 20 * MINUTE;
  // The forks' ids sort before their parent's, so a wrong link would show.
  const [main, worker, tester, coordinator, linter] = [idAt(1), idAt(2), idAt(3), idAt(4), idAt(5)];
  const reminded = (ms, caller, text) => ({
    ...ask(ms, text),
    content: `<subagent_reminder>\nThe caller agent that started you has id: ${caller}\n</subagent_reminder>\n<USER_REQUEST>\n${text}\n</USER_REQUEST>`,
  });
  const starts = (ms, role) => uses(ms, [call('invoke_subagent', { Subagents: [{ Role: role }] })]);
  const works = (command) => uses(T0 - MINUTE, [call('run_command', { CommandLine: command })]);
  writeTranscript(root, main, [ask(at, 'Speed up the build'), starts(at + 1000, 'Build coordinator'), invoked(at + 1500, [coordinator]), reply(at + 2000, 'A coordinator is on it.')]);
  // The coordinator starts a tester, then a worker whose start is not written yet, then reads 30
  // files and starts a linter. Each is forked: its transcript starts with a copy of the
  // coordinator's steps so far, the coordinator's reminder and the tester's start too.
  const steps = [
    reminded(at + 1600, main, 'Make the build faster'),
    starts(at + 1700, 'Test worker'),
    invoked(at + 1710, [tester]),
    starts(at + 1720, 'Cache worker'),
    ran(at + 1730, 'INVOKE_SUBAGENT', '', { status: 'WAITING' }),
  ];
  for (let i = 0; i < 30; i++) steps.push(uses(at + 1800 + i, [call('view_file', { AbsolutePath: `/home/ada/project/src/part${i}.js` })]), ran(at + 1800 + i, 'VIEW_FILE', 'A part.'));
  steps.push(starts(at + 1900, 'Lint worker'));
  const lead = writeTranscript(root, coordinator, [...steps, invoked(at + 1910, [linter]), reply(at + 2000, 'Three workers are on it.')]);
  writeTranscript(root, tester, [...steps.slice(0, 2), reminded(at + 1705, coordinator, 'Run the tests'), works('npm test')]);
  writeTranscript(root, worker, [...steps.slice(0, 4), reminded(at + 1725, coordinator, 'Add a build cache'), works('npm run build')]);
  // The linter's own reminder comes after its first 50 steps, so only the copy is read.
  writeTranscript(root, linter, [...steps, reminded(at + 1905, coordinator, 'Lint the code'), works('npm run lint')]);

  const { clock, poll } = open(root);
  let byId = new Map(poll().sessions.map((s) => [s.id, s]));
  assert.deepEqual([main, coordinator, tester, worker, linter].map((id) => [byId.get(id).parentKey, byId.get(id).status]), [
    [null, 'working'],
    [keyOf(main), 'working'],
    [keyOf(coordinator), 'working'],
    [keyOf(coordinator), 'working'],
    [keyOf(coordinator), 'working'],
  ]);
  assert.deepEqual([tester, linter].map((id) => byId.get(id).title), ['Test worker', 'Lint worker']);
  // The worker's start is written now: it gets its role, and stays where it is.
  append(lead, { ...invoked(at + 1730, [worker]), step_index: 4 });
  clock.now += SECOND;
  byId = new Map(poll().sessions.map((s) => [s.id, s]));
  assert.deepEqual([byId.get(worker).parentKey, byId.get(worker).title], [keyOf(coordinator), 'Cache worker']);
  // They all start with the same copied step, so their links share a time.
  assert.deepEqual(byId.get(coordinator).links.map((l) => `${l.dir} ${l.other}`).sort(), [worker, tester, linter].map((id) => `down ${keyOf(id)}`));

  // Later the coordinator's oldest steps are squeezed, with its starts of the tester and the worker,
  // and Pleni starts again. The worker's copy of those steps still names the tester, but the tester's
  // own reminder, not a copy, names the coordinator: so the tester stays there.
  writeTranscript(root, coordinator, [...steps.slice(0, 5).map((step, i) => cleared(step, i)), ...steps.slice(5), invoked(at + 1910, [linter]), reply(at + 2000, 'Three workers are on it.')]);
  byId = new Map(open(root).poll().sessions.map((s) => [s.id, s]));
  assert.deepEqual([tester, worker].map((id) => byId.get(id).parentKey), [keyOf(coordinator), keyOf(coordinator)]);
  assert.deepEqual(byId.get(worker).links, [], 'the worker did not start the tester');
});

test('a helper\'s own reminder is told from a sibling\'s copy by its step too, when the times are whole seconds', (t) => {
  const root = agyHome(t);
  const at = T0 - 20 * MINUTE; // whole seconds, as real transcripts write them
  const [main, worker, tester, coordinator] = [idAt(1), idAt(2), idAt(3), idAt(4)];
  const reminded = (ms, caller, text) => ({
    ...ask(ms, text),
    content: `<subagent_reminder>\nThe caller agent that started you has id: ${caller}\n</subagent_reminder>\n<USER_REQUEST>\n${text}\n</USER_REQUEST>`,
  });
  const starts = (ms, role) => uses(ms, [call('invoke_subagent', { Subagents: [{ Role: role }] })]);
  const works = (command) => uses(T0 - MINUTE, [call('run_command', { CommandLine: command })]);
  writeTranscript(root, main, [ask(at, 'Speed up the build'), starts(at, 'Build coordinator'), invoked(at, [coordinator]), reply(at + SECOND, 'A coordinator is on it.')]);
  // The coordinator starts a tester, then a worker, each forked: its transcript starts with a copy
  // of the coordinator's steps so far. The two helpers' own reminders are written in one second.
  const steps = [reminded(at, main, 'Make the build faster'), starts(at, 'Test worker'), invoked(at, [tester]), starts(at, 'Cache worker'), invoked(at, [worker])];
  writeTranscript(root, tester, [...steps.slice(0, 2), reminded(at + SECOND, coordinator, 'Run the tests'), works('npm test')]);
  writeTranscript(root, worker, [...steps.slice(0, 4), reminded(at + SECOND, coordinator, 'Add a build cache'), works('npm run build')]);
  // The coordinator's starts are squeezed away, so only the reminders say who started whom. The
  // worker's copy still names the tester, but the tester's own reminder is at another step.
  writeTranscript(root, coordinator, [...steps.map((step, i) => cleared(step, i)), reply(at + 2 * SECOND, 'Two workers are on it.')]);
  const byId = new Map(open(root).poll().sessions.map((s) => [s.id, s]));
  assert.deepEqual([tester, worker].map((id) => byId.get(id).parentKey), [keyOf(coordinator), keyOf(coordinator)]);
  assert.deepEqual(byId.get(worker).links, [], 'the worker did not start the tester');
});

test('two helpers forked late from one conversation both hang under it, whatever their ids', (t) => {
  const root = agyHome(t);
  const at = T0 - 20 * MINUTE;
  // The second helper's id sorts before the coordinator's, so a wrong link would show.
  const [main, second, coordinator, first] = [idAt(1), idAt(2), idAt(3), idAt(4)];
  const reminded = (ms, caller, text) => ({
    ...ask(ms, text),
    content: `<subagent_reminder>\nThe caller agent that started you has id: ${caller}\n</subagent_reminder>\n<USER_REQUEST>\n${text}\n</USER_REQUEST>`,
  });
  const starts = (ms, role) => uses(ms, [call('invoke_subagent', { Subagents: [{ Role: role }] })]);
  const works = (command) => uses(T0 - MINUTE, [call('run_command', { CommandLine: command })]);
  writeTranscript(root, main, [ask(at, 'Tidy the code'), starts(at + 1000, 'Tidy coordinator'), invoked(at + 1500, [coordinator]), reply(at + 2000, 'A coordinator is on it.')]);
  // The coordinator reads 30 files, then starts two forked helpers. Each one's transcript starts
  // with a copy of the coordinator's steps, so its own reminder comes after its first 50 steps
  // and only the copy of the coordinator's reminder is read. The second one's copy names the first.
  const steps = [reminded(at + 1600, main, 'Tidy the code')];
  for (let i = 0; i < 30; i++) steps.push(uses(at + 1700 + i, [call('view_file', { AbsolutePath: `/home/ada/project/src/part${i}.js` })]), ran(at + 1700 + i, 'VIEW_FILE', 'A part.'));
  const startFirst = [starts(at + 1800, 'Lint worker'), invoked(at + 1810, [first])];
  const startSecond = [starts(at + 1820, 'Docs worker'), invoked(at + 1830, [second])];
  writeTranscript(root, coordinator, [...steps, ...startFirst, ...startSecond, reply(at + 2000, 'Two workers are on it.')]);
  writeTranscript(root, first, [...steps, startFirst[0], reminded(at + 1815, coordinator, 'Lint the code'), works('npm run lint')]);
  writeTranscript(root, second, [...steps, ...startFirst, startSecond[0], reminded(at + 1835, coordinator, 'Write the docs'), works('npm run docs')]);
  const byId = new Map(open(root).poll().sessions.map((s) => [s.id, s]));
  assert.deepEqual([first, second].map((id) => byId.get(id).parentKey), [keyOf(coordinator), keyOf(coordinator)]);
  assert.deepEqual(byId.get(second).links, [], 'the second helper did not start the first');
  assert.deepEqual([first, second].map((id) => byId.get(id).title), ['Lint worker', 'Docs worker']);
});

test('a helper of a helper that works keeps every conversation above it working', (t) => {
  const root = agyHome(t);
  const at = T0 - 20 * MINUTE;
  const [main, coordinator, worker] = [idAt(1), idAt(2), idAt(3)];
  const starts = (ms, role, id) => [uses(ms, [call('invoke_subagent', { Subagents: [{ Role: role }] })]), invoked(ms + 500, [id])];
  writeTranscript(root, main, [ask(at, 'Speed up the build'), ...starts(at + 1000, 'Build coordinator', coordinator), reply(at + 2000, 'A coordinator is on it.')]);
  writeTranscript(root, coordinator, [ask(at + 1600, 'Make the build faster'), ...starts(at + 3000, 'Cache worker', worker), reply(at + 4000, 'A worker adds a cache.')]);
  writeTranscript(root, worker, [ask(at + 3600, 'Add a build cache'), uses(T0 - MINUTE, [call('run_command', { CommandLine: 'npm run build' })])]);
  const byId = new Map(open(root).poll().sessions.map((s) => [s.id, s]));
  assert.deepEqual([main, coordinator, worker].map((id) => [byId.get(id).parentKey, byId.get(id).status]), [
    [null, 'working'],
    [keyOf(main), 'working'],
    [keyOf(coordinator), 'working'],
  ]);
  assert.deepEqual(byId.get(worker).activity, { tool: 'run_command', detail: 'npm run build', at: T0 - MINUTE });
});

test('a helper is named where the result labels it, so a conversation that the task only mentions stays where it is', (t) => {
  const root = agyHome(t);
  const at = T0 - 10 * MINUTE;
  // The helper's id sorts first, so a wrong link would turn the tree upside down.
  const [helper, other, lead, nested, plainLead, plain] = [idAt(1), idAt(2), idAt(3), idAt(4), idAt(5), idAt(6)];
  const starts = (ms, role, result) => [uses(ms, [call('invoke_subagent', { Subagents: [{ Role: role }] })]), ran(ms + 500, 'INVOKE_SUBAGENT', result)];
  writeTranscript(root, other, [ask(at - 5 * MINUTE, 'Clean up the old build'), reply(at - 4 * MINUTE, 'Cleaned.')]);
  writeTranscript(root, lead, [
    ask(at, `What did conversation ${other} change?`),
    ...starts(at + 1000, 'Change finder', `Started a subagent.\nconversationId: "${helper}"\nTask: Read the transcript of conversation ${other}`),
    reply(at + 2000, 'A helper is reading it.'),
  ]);
  writeTranscript(root, helper, [
    ask(at + 1600, `Read the transcript of conversation ${other}`),
    ...starts(at + 2500, 'Line counter', `conversation_id: ${nested}\nReport to the lead, ${lead}.`),
    reply(at + 3500, 'Counting the lines.'),
  ]);
  writeTranscript(root, nested, [ask(at + 3100, 'Count the lines'), reply(at + 4000, 'Ten lines changed.')]);
  // A result with no label at all: any conversation id in it.
  writeTranscript(root, plainLead, [ask(at, 'Plan it'), ...starts(at + 1000, 'Planner', `Started ${plain}.`), reply(at + 2000, 'A planner plans it.')]);
  writeTranscript(root, plain, [ask(at + 1600, 'Plan the work'), reply(at + 3000, 'Planned.')]);

  const byId = new Map(open(root).poll().sessions.map((s) => [s.id, s]));
  const placed = (id) => [byId.get(id).parentKey, byId.get(id).kind, byId.get(id).title];
  assert.deepEqual(placed(other), [null, 'session', 'Clean up the old build']);
  assert.equal(byId.get(other).status, 'idle');
  assert.deepEqual(placed(lead), [null, 'session', `What did conversation ${other} change?`]);
  assert.deepEqual(placed(helper), [keyOf(lead), 'agent', 'Change finder']);
  assert.deepEqual(placed(nested), [keyOf(helper), 'agent', 'Line counter']);
  assert.deepEqual(placed(plain), [keyOf(plainLead), 'agent', 'Planner']);
  assert.deepEqual(byId.get(lead).links.map((l) => l.other), [keyOf(helper), keyOf(helper)]);
});

test('each INVOKE_SUBAGENT step takes its roles from the call it answers', (t) => {
  const root = agyHome(t);
  const at = T0 - 10 * MINUTE;
  const asks = (...roles) => uses(at + 1000, roles.map((role) => call('invoke_subagent', { Subagents: [{ Role: role }] })));
  // Two calls in one reply, each answered by a step of its own.
  writeTranscript(root, idAt(1), [ask(at, 'Check the app'), asks('API checker', 'UI checker'), invoked(at + 2000, [idAt(2)]), invoked(at + 2100, [idAt(3)]), reply(at + 3000, 'Two helpers check the app.')]);
  // Two calls answered by one step that names both helpers.
  writeTranscript(root, idAt(4), [ask(at, 'Check the docs'), asks('Spell checker', 'Link checker'), invoked(at + 2000, [idAt(5), idAt(6)]), reply(at + 3000, 'Two helpers check the docs.')]);
  const helper = (n, text) => writeTranscript(root, idAt(n), [ask(at + 2050, text), reply(at + 5000, 'Done.')]);
  helper(2, 'Check every API route');
  helper(3, 'Check every page');
  helper(5, 'Check the spelling');
  helper(6, 'Check the links');
  const byId = new Map(open(root).poll().sessions.map((s) => [s.id, [s.title, s.titleSource]]));
  assert.deepEqual([2, 3, 5, 6].map((n) => byId.get(idAt(n))), [
    ['API checker', 'role'],
    ['UI checker', 'role'],
    ['Spell checker', 'role'],
    ['Link checker', 'role'],
  ]);
});

test('a working helper never hides its parent\'s error, a helper\'s own error shows, and one named twice stays with the first by id', (t) => {
  const root = agyHome(t);
  const at = T0 - 5 * MINUTE;
  const busy = (n) => writeTranscript(root, idAt(n), [ask(at + 600, 'Check it'), uses(T0 - MINUTE, [call('run_command', { CommandLine: 'npm test' })])]);
  // The parent's reply failed, or an error step ended its turn, while its helper still works.
  writeTranscript(root, idAt(1), [ask(at, 'Go'), invoked(at + 500, [idAt(11)]), reply(at + 1000, '', { status: 'ERROR' })]);
  writeTranscript(root, idAt(2), [ask(at, 'Go'), invoked(at + 500, [idAt(12)]), { source: 'SYSTEM', type: 'ERROR_MESSAGE', status: 'DONE', created_at: iso(at + 1000), content: 'Quota used up.' }]);
  busy(11);
  busy(12);
  // A helper whose own reply failed.
  writeTranscript(root, idAt(3), [ask(at, 'Go'), invoked(at + 500, [idAt(13)]), reply(at + 1000, 'A helper checks it.')]);
  writeTranscript(root, idAt(13), [ask(at + 600, 'Check it'), reply(at + 2000, '', { status: 'ERROR' })]);
  // Two conversations name the same helper.
  writeTranscript(root, idAt(4), [ask(at, 'A'), invoked(at + 100, [idAt(14)]), reply(at + 200, 'A done.')]);
  writeTranscript(root, idAt(5), [ask(at, 'B'), invoked(at + 100, [idAt(14)]), reply(at + 200, 'B done.')]);
  writeTranscript(root, idAt(14), [ask(at + 150, 'Shared work'), reply(at + 300, 'Shared work done.')]);

  const byId = new Map(open(root).poll().sessions.map((s) => [s.id, s]));
  const status = (n) => byId.get(idAt(n)).status;
  assert.deepEqual([1, 11, 2, 12].map(status), ['error', 'working', 'error', 'working']);
  assert.equal(status(13), 'error');
  assert.deepEqual(byId.get(idAt(3)).links.map((l) => [l.dir, l.other, l.at]), [['down', keyOf(idAt(13)), at + 600], ['up', keyOf(idAt(13)), at + 2000]]);
  assert.equal(byId.get(idAt(14)).parentKey, keyOf(idAt(4)));
  assert.deepEqual(byId.get(idAt(4)).links.map((l) => l.dir), ['down', 'up']);
  assert.deepEqual(byId.get(idAt(5)).links, []);
});

// ---- rewrites, broken lines and big transcripts ----

test('a checkpoint that writes the transcript again, smaller, is read again, keeping the first request, the start time and the helpers', (t) => {
  const root = agyHome(t);
  const at = T0 - 8 * MINUTE;
  const big = 'x'.repeat(20000);
  const file = writeTranscript(root, CID, [
    ask(at, 'First request'),
    uses(at + 1000, [call('invoke_subagent', { Subagents: [{ Role: 'Slow query finder' }] })]),
    invoked(at + 1200, [KID]),
    uses(at + 1300, [call('view_file', { AbsolutePath: '/home/ada/project/big.txt' })]),
    ran(at + 1500, 'VIEW_FILE', big),
    reply(at + 2000, 'First answer.'),
    ask(at + 3000, 'Second request'),
    reply(at + 4000, 'Second answer, the long version.'),
  ]);
  writeTranscript(root, KID, [ask(at + 1100, 'Find the slow queries.'), reply(at + 1900, 'Three queries read every order.')]);
  writeHistory(root, [{ display: 'First request', timestamp: at, workspace: FOLDER, conversationId: CID }]);
  const { clock, source, poll } = open(root);
  let byId = new Map(poll().sessions.map((s) => [s.id, s]));
  assert.equal(byId.get(CID).lastText, 'Second answer, the long version.');
  assert.equal(byId.get(KID).parentKey, keyOf(CID));
  const before = fs.statSync(file).size;

  // Old history squeezed down: the old steps are cleared and the newest written again.
  fs.writeFileSync(file, [
    cleared(ask(at, ''), 0),
    cleared(uses(at + 1000, []), 1),
    cleared(ran(at + 1200, 'INVOKE_SUBAGENT', ''), 2),
    cleared(uses(at + 1300, []), 3),
    cleared(ran(at + 1500, 'VIEW_FILE', ''), 4),
    cleared(reply(at + 2000, ''), 5),
    { ...ask(at + 3000, 'Second request'), step_index: 6 },
    { ...reply(at + 4000, 'Second answer.'), step_index: 7 },
    { ...note(at + 4500, 'CHECKPOINT', 'Earlier: the person asked to read big.txt.'), step_index: 8 },
  ].map(line).join(''));
  assert.ok(fs.statSync(file).size < before);
  clock.now += SECOND;
  byId = new Map(poll().sessions.map((s) => [s.id, s]));
  const s = byId.get(CID);
  assert.equal(s.lastText, 'Second answer.');
  assert.deepEqual([s.title, s.titleSource], ['First request', 'first-prompt'], 'the first request still names it');
  assert.equal(s.status, 'ready');
  assert.equal(s.startedAt, at, 'the start time is kept, though the cleared steps have no time');
  const kid = byId.get(KID);
  assert.deepEqual([kid.parentKey, kid.kind, kid.title], [keyOf(CID), 'agent', 'Slow query finder'], 'the helpers found before are kept');
  const detail = source.detail(keyOf(CID), null);
  assert.deepEqual(detail.events.filter((e) => e.kind !== 'tool').map((e) => [e.kind, e.text]), [
    ['user', 'Second request'],
    ['assistant', 'Second answer.'],
  ]);

  // A Pleni started after the squeeze never saw the first request: history.jsonl still names it.
  const fresh = open(root).get(keyOf(CID));
  assert.deepEqual([fresh.title, fresh.titleSource], ['First request', 'history']);

  append(file, { ...ask(at + 5000, 'Third request'), step_index: 9 }, { ...reply(at + 6000, 'Third answer.'), step_index: 10 });
  assert.equal(poll().sessions.find((x) => x.id === CID).lastText, 'Third answer.');
});

test('a transcript written again in place is read again, even when it grew past where Pleni stopped', (t) => {
  const root = agyHome(t);
  const at = T0 - 20 * MINUTE;
  const file = writeTranscript(root, CID, [
    ask(at, 'Fix the docs'),
    uses(at + 1000, [call('view_file', { AbsolutePath: '/home/ada/project/README.md' })]),
    ran(at + 1500, 'VIEW_FILE', 'x'.repeat(200 * 1024)),
    reply(at + 2000, 'The docs are read.'),
  ]);
  const { clock, poll } = open(root);
  poll();
  const before = fs.statSync(file);

  // While nobody looks, old history is squeezed down in the same file, and the conversation goes on.
  const now = T0 - MINUTE;
  fs.writeFileSync(file, [
    cleared(ask(at, ''), 0),
    cleared(uses(at + 1000, []), 1),
    cleared(ran(at + 1500, 'VIEW_FILE', ''), 2),
    { ...reply(at + 2000, 'The docs are read.'), step_index: 3 },
    { ...note(at + 2500, 'CHECKPOINT', 'Earlier: the person asked to fix the docs.'), step_index: 4 },
    { ...ask(now - 30 * SECOND, 'Check the docs with a helper, and read the big log'), step_index: 5 },
    { ...uses(now - 20 * SECOND, [call('invoke_subagent', { Subagents: [{ Role: 'Docs checker' }] })]), step_index: 6 },
    { ...invoked(now - 15 * SECOND, [KID]), step_index: 7 },
    { ...uses(now - 10 * SECOND, [call('view_file', { AbsolutePath: '/home/ada/project/big.log' })]), step_index: 8 },
    { ...ran(now - 5 * SECOND, 'VIEW_FILE', 'y'.repeat(300 * 1024)), step_index: 9 },
    { ...reply(now - 4 * SECOND, 'A helper checks the docs.'), step_index: 10 },
  ].map(line).join(''));
  writeTranscript(root, KID, [ask(now - 14 * SECOND, 'Check the docs'), uses(now, [call('grep_search', { Query: 'TODO' })])]);
  const after = fs.statSync(file);
  assert.equal(after.ino, before.ino, 'the same file, written again in place');
  assert.ok(after.size > before.size, 'it grew past where Pleni stopped');

  clock.now += 31 * SECOND;
  const byId = new Map(poll().sessions.map((s) => [s.id, s]));
  const kid = byId.get(KID);
  assert.deepEqual([kid.parentKey, kid.kind, kid.title], [keyOf(CID), 'agent', 'Docs checker']);
  assert.equal(byId.get(CID).lastText, 'A helper checks the docs.');
  assert.equal(byId.get(CID).status, 'working', 'its helper works');
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

test('a big transcript read from near its end keeps its first request, start and the helpers it named early on, with their roles', (t) => {
  const at = T0 - 60 * MINUTE;
  const MiB = 1024 * 1024;
  const kids = [KID, idAt(3), idAt(4), idAt(5)];
  const start = (index, ms, ids, status = 'DONE') => ({ ...invoked(ms, ids), status, step_index: index });
  const helps = (role) => call('invoke_subagent', { Subagents: [{ Role: role }] });
  const first = [call('view_file', { AbsolutePath: '/home/ada/project/notes/transcript.jsonl' }), helps('Docs indexer'), helps('Code indexer'), helps('Test indexer')];
  // One reply reads a file and starts three helpers. Antigravity CLI writes a step again when it
  // changes: the reply while it runs, before all its calls are there, and once it is done, and the
  // first start before it names its helper, and again only when that helper is done, after a later
  // reply.
  const steps = [
    { ...ask(at, 'Index the whole repository'), step_index: 0 },
    { ...uses(at + 1000, first.slice(0, 1), { status: 'RUNNING' }), step_index: 1 },
    // The file holds a reply of another conversation: words in a tool's result are not a reply.
    { ...ran(at + 1500, 'VIEW_FILE', '{"type":"PLANNER_RESPONSE","content":"Done."}'), step_index: 2 },
    start(3, at + 2000, [], 'WAITING'),
    { ...uses(at + 1000, first), step_index: 1 },
    start(4, at + 2100, [kids[1]], 'RUNNING'),
    start(4, at + 2100, [kids[1]]),
    start(5, at + 2200, [kids[2]]),
    // A later reply writes a long file and starts one more. In the big transcript, the part that
    // is read starts within this reply's line, so the start comes after the reply's place.
    { ...uses(at + 2300, [call('write_to_file', { TargetFile: '/home/ada/project/index.md', CodeContent: 'z'.repeat(300 * 1024) }), helps('Link checker')]), step_index: 6 },
    { ...ran(at + 2350, 'WRITE_TO_FILE', 'Wrote index.md.'), step_index: 7 },
    start(8, at + 2400, [kids[3]]),
  ];
  const read = (big) => {
    const root = agyHome(t);
    const filler = Array.from({ length: 39 }, (_, i) => ({ ...ran(at + 3000 + i, 'VIEW_FILE', 'y'.repeat(big ? 100 * 1024 : 10)), step_index: 9 + i }));
    const all = [...steps, ...filler, start(3, at + 2000, [kids[0]]), { ...reply(T0 - 2 * MINUTE, 'The index is ready.'), step_index: 48 }];
    const file = writeTranscript(root, CID, all, { full: true });
    const size = fs.statSync(file).size;
    assert.equal(size > 4 * MiB, big);
    if (big) {
      const before = numbered(steps.slice(0, 8)).map(line).join('').length;
      assert.ok(size - 4 * MiB > before && size - 4 * MiB < before + line(steps[8]).length, 'the read part starts within the later reply');
    }
    for (const id of kids) writeTranscript(root, id, [ask(at + 2500, 'Index one part'), reply(at + 9000, 'Done.')]);
    return new Map(open(root).poll().sessions.map((s) => [s.id, s]));
  };
  const helpers = (byId) => kids.map((id) => [byId.get(id).parentKey, byId.get(id).title, byId.get(id).titleSource]);
  const want = ['Docs indexer', 'Code indexer', 'Test indexer', 'Link checker'].map((role) => [keyOf(CID), role, 'role']);
  assert.deepEqual(helpers(read(false)), want, 'read whole');
  const byId = read(true);
  assert.deepEqual(helpers(byId), want, 'the roles their calls gave them, as when the transcript was small');
  const lead = byId.get(CID);
  assert.equal(lead.title, 'Index the whole repository');
  assert.equal(lead.startedAt, at);
  assert.equal(lead.lastText, 'The index is ready.');
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
