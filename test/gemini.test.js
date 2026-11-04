import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cleanSettings } from '../src/config.js';
import { createGeminiSource } from '../src/sources/gemini.js';

const MiB = 1024 * 1024;
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const T0 = Math.floor(Date.now() / 1000) * 1000;

const SID = '3f2a1b4c-5d6e-4f70-8a91-b2c3d4e5f601';
const SID2 = '3f2a1b4c-5d6e-4f70-8a91-b2c3d4e5f602';
const idAt = (n) => `4a5b6c7d-0000-4000-8000-${String(n).padStart(12, '0')}`;
const SLUG = 'project';
const FOLDER = '/home/ada/project';
const keyOf = (id, agent) => (agent ? `gemini:${id}/${agent}` : `gemini:${id}`);
const KEY = keyOf(SID);
const DISPLAY = { run_shell_command: 'Shell', read_file: 'ReadFile', write_file: 'WriteFile' };

// ---- fixture helpers (everything is synthetic) ----

function geminiHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pleni-gemini-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const iso = (ms) => new Date(ms).toISOString();
const line = (record) => `${JSON.stringify(record)}\n`;
const append = (file, ...records) => fs.appendFileSync(file, records.map(line).join(''));
const setMtime = (file, ms) => fs.utimesSync(file, ms / 1000, ms / 1000);
const chats = (root, slug = SLUG) => path.join(root, 'tmp', slug, 'chats');

// A project folder in tmp, with the .project_root file that names its working folder (none for null).
function project(root, slug = SLUG, folder = FOLDER) {
  fs.mkdirSync(chats(root, slug), { recursive: true });
  if (folder !== null) fs.writeFileSync(path.join(root, 'tmp', slug, '.project_root'), `${folder}\n`);
}

const meta = (id, at, extra = {}) => ({ sessionId: id, projectHash: 'a'.repeat(64), startTime: iso(at), lastUpdated: iso(at), kind: 'main', ...extra });

// A session's log: its metadata line, then its records. Gemini CLI puts the first 8 characters of
// the id in the name; these names use the last 8, since Pleni reads the id from the metadata.
function writeLog(root, id, records, { slug = SLUG, at = T0 - 30 * MINUTE, mtime, head = {} } = {}) {
  const file = path.join(chats(root, slug), `session-2026-11-03T10-00-${id.slice(-8)}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, [meta(id, at, head), ...records].map(line).join(''));
  if (mtime !== undefined) setMtime(file, mtime);
  return file;
}

// A helper's log, in the folder named after the session that started it.
function writeHelper(root, parentId, agentId, records, { slug = SLUG, at = T0 - 20 * MINUTE } = {}) {
  const file = path.join(chats(root, slug), parentId, `${agentId}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, [meta('9e8d7c6b-0000-4000-8000-0000000000a1', at, { kind: 'subagent' }), ...records].map(line).join(''));
  return file;
}

const user = (ms, text, extra = {}) => ({ id: `u-${ms}`, timestamp: iso(ms), type: 'user', content: [{ text }], ...extra });
const reply = (ms, content, extra = {}) => ({ id: `g-${ms}`, timestamp: iso(ms), type: 'gemini', content, model: 'gemini-3-pro-preview', ...extra });
const call = (ms, id, name, args, status, extra = {}) => ({
  id,
  name,
  args,
  status,
  timestamp: iso(ms),
  displayName: DISPLAY[name] ?? name,
  // Gemini CLI writes the tool's own long description beside each call; Pleni never shows it.
  description: `${name} works on /home/ada/project/private-notes.txt`,
  ...extra,
});
const uses = (ms, calls, extra = {}) => reply(ms, '', { toolCalls: calls, ...extra });
const failure = (ms, text) => ({ id: `e-${ms}`, timestamp: iso(ms), type: 'error', content: text });
const set = (fields) => ({ $set: fields });
const rewindTo = (id) => ({ $rewindTo: id });
const patch = (fields) => ({ $patch: fields });

// One whole turn: a prompt and its reply.
const turn = (ms, n, text = 'Done.') => [user(ms, `Prompt ${n}`), reply(ms + 1, text)];

function open(root, { content = 'snippets', window } = {}) {
  const clock = { now: T0 };
  const settings = cleanSettings({ content, window });
  const source = createGeminiSource({ root, settings, now: () => clock.now });
  const poll = () => {
    const out = source.poll();
    assert.equal(out.ok, true, out.error);
    return out;
  };
  const get = (key) => poll().sessions.find((s) => s.key === key);
  return { clock, source, poll, get };
}

// ---- discovery ----

test('finds sessions in each project folder, with the working folder from .project_root or projects.json', (t) => {
  const root = geminiHome(t);
  project(root, 'alpha', '/home/ada/alpha');
  project(root, 'beta', null); // no .project_root: projects.json names it
  fs.writeFileSync(path.join(root, 'projects.json'), JSON.stringify({ projects: { '/home/ada/beta': 'beta', '/home/ada/other': 'alpha' } }));
  writeLog(root, SID, turn(T0 - 5 * MINUTE, 1), { slug: 'alpha', at: T0 - 6 * MINUTE });
  writeLog(root, SID2, turn(T0 - 4 * MINUTE, 1), { slug: 'beta' });
  writeLog(root, idAt(3), turn(T0 - 48 * HOUR, 1), { slug: 'beta', mtime: T0 - 48 * HOUR }); // older than recentHours
  writeLog(root, idAt(4), [user(T0 - MINUTE, '/stats')], { slug: 'beta' }); // only a command: nothing happened yet
  writeLog(root, idAt(5), [], { slug: 'beta' }); // only the metadata line
  fs.writeFileSync(path.join(chats(root, 'beta'), 'notes.txt'), 'hello\n');
  fs.writeFileSync(path.join(chats(root, 'beta'), 'session-bad.jsonl'), line({ sessionId: 'not an id!', startTime: iso(T0) }) + line(user(T0 - MINUTE, 'Hi')));

  const { sessions, root: reported } = open(root).poll();
  assert.equal(reported, root);
  assert.deepEqual(sessions.map((s) => s.key), [keyOf(SID), keyOf(SID2)]);
  const [a, b] = sessions;
  assert.equal(a.platform, 'gemini');
  assert.equal(a.id, SID);
  assert.equal(a.kind, 'session');
  assert.equal(a.parentKey, null);
  assert.equal(a.spawned, false);
  assert.equal(a.role, null);
  assert.equal(a.branch, null);
  assert.equal(a.entrypoint, null);
  assert.equal(a.effort, null);
  assert.equal(a.cwd, '/home/ada/alpha', '.project_root wins over projects.json');
  assert.equal(a.startedAt, T0 - 6 * MINUTE);
  assert.equal(a.lastAt, T0 - 5 * MINUTE + 1);
  assert.equal(a.model, 'gemini-3-pro-preview');
  assert.equal(a.title, 'Prompt 1');
  assert.equal(a.titleSource, 'first-prompt');
  assert.equal(a.lastText, 'Done.');
  assert.equal(a.archived, false);
  assert.deepEqual(a.links, []);
  assert.equal(b.cwd, '/home/ada/beta');
});

test('looks for new sessions every 30 seconds', (t) => {
  const root = geminiHome(t);
  project(root);
  writeLog(root, SID, turn(T0 - 5 * MINUTE, 1));
  const { clock, poll } = open(root);
  assert.equal(poll().sessions.length, 1);

  writeLog(root, SID2, turn(T0 - MINUTE, 1));
  clock.now = T0 + 10 * SECOND;
  assert.equal(poll().sessions.length, 1);
  clock.now = T0 + 31 * SECOND;
  assert.equal(poll().sessions.length, 2);
});

test('a copy in an older project folder named by a hash shows once: the copy with the newest lastUpdated', (t) => {
  const root = geminiHome(t);
  project(root);
  const hash = crypto.createHash('sha256').update(FOLDER).digest('hex');
  fs.writeFileSync(path.join(root, 'projects.json'), JSON.stringify({ projects: { [FOLDER]: SLUG } }));
  const at = T0 - 3 * MINUTE;
  writeLog(root, SID, [user(at, 'Hello'), reply(at + 1000, 'The newer copy'), set({ lastUpdated: iso(at + 2000) })]);
  writeLog(root, SID, [user(at, 'Hello'), reply(at + 500, 'The older copy')], { slug: hash });
  // Here the copy in the hash folder is the newer one.
  writeLog(root, idAt(3), [user(at, 'Hello'), reply(at + 500, 'Older here')]);
  writeLog(root, idAt(3), [user(at, 'Hello'), reply(at + 900, 'Newer there')], { slug: hash, head: { lastUpdated: iso(at + 9000) } });
  // A session only in the hash folder finds its working folder through projects.json.
  writeLog(root, SID2, turn(at, 1), { slug: hash });

  const sessions = open(root).poll().sessions;
  assert.deepEqual(sessions.map((s) => s.key), [KEY, keyOf(SID2), keyOf(idAt(3))].sort());
  const get = (key) => sessions.find((s) => s.key === key);
  assert.equal(get(KEY).lastText, 'The newer copy');
  assert.equal(get(keyOf(idAt(3))).lastText, 'Newer there');
  assert.equal(get(keyOf(SID2)).cwd, FOLDER);
});

// ---- reading the log ----

test('a log is read with its changes: $set, $rewindTo and $patch', (t) => {
  const root = geminiHome(t);
  project(root);
  const at = T0 - 5 * MINUTE;
  const file = writeLog(root, SID, [user(at, 'First question'), reply(at + 1000, 'First answer'), user(at + 2000, 'Second question'), reply(at + 3000, 'Second answer')]);
  const { get } = open(root);
  assert.equal(get(KEY).lastText, 'Second answer');

  // Going back to the second question takes it away, and the answer after it.
  append(file, rewindTo(`u-${at + 2000}`));
  let s = get(KEY);
  assert.equal(s.lastText, 'First answer');
  assert.equal(s.status, 'ready');
  assert.equal(s.lastAt, at + 3000, 'what was taken out still happened');

  // $set merges into the metadata: Gemini CLI's summary names the session.
  append(file, set({ summary: 'Fix the login page', lastUpdated: iso(at + 4000), memoryScratchpad: 'Never shown' }));
  s = get(KEY);
  assert.equal(s.title, 'Fix the login page');
  assert.equal(s.titleSource, 'summary');

  // $patch with an id changes the fields it has; `updates` does the same for each message it names.
  append(file, patch({ id: `g-${at + 1000}`, content: 'First answer, fixed' }));
  assert.equal(get(KEY).lastText, 'First answer, fixed');
  append(file, patch({ updates: [{ id: `g-${at + 1000}`, content: 'First answer, fixed again' }] }));
  assert.equal(get(KEY).lastText, 'First answer, fixed again');

  // removeIds takes messages out.
  append(file, user(at + 5000, 'Third question'));
  assert.equal(get(KEY).status, 'working');
  append(file, patch({ removeIds: [`u-${at + 5000}`] }));
  assert.equal(get(KEY).status, 'ready');

  // A patch to a tool call changes only that call.
  append(file, user(at + 6000, 'Run the tests'), uses(at + 7000, [call(at + 7000, 'c1', 'run_shell_command', { command: 'npm test' }, 'executing')]));
  s = get(KEY);
  assert.equal(s.status, 'working');
  assert.deepEqual(s.activity, { tool: 'Shell', detail: 'npm test', at: at + 7000 });
  append(file, patch({ id: `g-${at + 7000}`, toolCalls: [{ id: 'c1', status: 'success' }] }));
  s = get(KEY);
  assert.equal(s.status, 'working', 'the results go back to the model, which goes on');
  assert.equal(s.activity, null);
  append(file, reply(at + 8000, 'All tests pass.'));
  assert.equal(get(KEY).status, 'ready');

  // orderIds puts the messages it names in its order, here the reply before the tool call.
  append(file, patch({ orderIds: [`g-${at + 8000}`, `g-${at + 7000}`] }));
  assert.equal(get(KEY).status, 'working');

  // The older way: $set with `messages` gives the whole list.
  append(file, set({ messages: [user(at + 9000, 'Only this'), reply(at + 10000, 'Only that')] }));
  s = get(KEY);
  assert.equal(s.lastText, 'Only that');
  assert.equal(s.status, 'ready');
  assert.equal(s.title, 'Fix the login page');
  assert.equal(JSON.stringify(s).includes('Never shown'), false);
});

test('a message written again keeps its first place, and its newest copy wins', (t) => {
  const root = geminiHome(t);
  project(root);
  const at = T0 - 2 * MINUTE;
  writeLog(root, SID, [
    user(at, 'First'),
    reply(at + 1000, 'Old words'),
    user(at + 2000, 'Second'),
    reply(at + 1000, 'New words'), // the same message again, after the second prompt
  ]);
  const { source, get } = open(root);
  const s = get(KEY);
  // In place order the newest message is still the person's second prompt: a turn is running.
  assert.equal(s.status, 'working');
  assert.equal(s.lastText, 'New words');
  const events = source.detail(KEY, null).events;
  assert.deepEqual(events.map((e) => [e.kind, e.text]), [['user', 'First'], ['assistant', 'New words'], ['user', 'Second']]);
});

test('a line that does not parse is skipped, and a half-written last line waits for its newline', (t) => {
  const root = geminiHome(t);
  project(root);
  const at = T0 - 2 * MINUTE;
  const file = writeLog(root, SID, [user(at, 'Go')]);
  fs.appendFileSync(file, '{"id": "broken", "type": "gemini",\n');
  const half = line(reply(at + 1000, 'Finished the work.'));
  fs.appendFileSync(file, half.slice(0, 30));
  const { get } = open(root);
  assert.equal(get(KEY).status, 'working');
  fs.appendFileSync(file, half.slice(30));
  const s = get(KEY);
  assert.equal(s.status, 'ready');
  assert.equal(s.lastText, 'Finished the work.');
});

test('an older one-object .json session is read whole, and one that is too big is skipped', (t) => {
  const root = geminiHome(t);
  project(root);
  const at = T0 - 3 * MINUTE;
  const file = path.join(chats(root), `session-2026-11-03T10-00-${SID.slice(0, 8)}.json`);
  const old = { sessionId: SID, projectHash: 'b'.repeat(64), startTime: iso(at), lastUpdated: iso(at + 1000), summary: 'An older session', messages: [user(at, 'Old style'), reply(at + 1000, 'Still read.')] };
  fs.writeFileSync(file, JSON.stringify(old, null, 2));
  const big = path.join(chats(root), `session-2026-11-03T11-00-${SID2.slice(0, 8)}.json`);
  fs.writeFileSync(big, JSON.stringify({ sessionId: SID2, startTime: iso(at), lastUpdated: iso(at), messages: [user(at, 'x'.repeat(17 * MiB))] }));

  const { source, poll } = open(root);
  let sessions = poll().sessions;
  assert.deepEqual(sessions.map((s) => s.key), [KEY]);
  assert.equal(sessions[0].title, 'An older session');
  assert.equal(sessions[0].lastText, 'Still read.');
  assert.equal(sessions[0].status, 'ready');
  assert.equal(sessions[0].cwd, FOLDER);
  assert.equal(sessions[0].startedAt, at);
  const events = source.detail(KEY, null);
  assert.deepEqual(events.events.map((e) => [e.kind, e.text]), [['user', 'Old style'], ['assistant', 'Still read.']]);
  assert.equal(events.reset, true);

  // Gemini CLI writes the whole file again when the session goes on.
  old.messages.push(user(at + 2000, 'And now?'));
  fs.writeFileSync(file, JSON.stringify(old, null, 2));
  sessions = poll().sessions;
  assert.equal(sessions[0].status, 'working');
});

test('a big log is read from near its end, and keeps the first prompt from its start as its title', (t) => {
  const root = geminiHome(t);
  project(root);
  const at = T0 - 3 * MINUTE;
  const filler = 'x'.repeat(MiB);
  const records = [user(at, 'Read the big files')];
  for (let i = 1; i <= 5; i++) {
    records.push(uses(at + i * SECOND, [call(at + i * SECOND, `c${i}`, 'read_file', { absolute_path: `/home/ada/project/big${i}.txt` }, 'success', { result: filler })]));
  }
  records.push(reply(at + 9 * SECOND, 'Read them all.', { model: 'gemini-3-flash-preview' }));
  writeLog(root, SID, records);
  const s = open(root).get(KEY);
  assert.equal(s.title, 'Read the big files');
  assert.equal(s.startedAt, T0 - 30 * MINUTE, 'the metadata line is read on its own');
  assert.equal(s.status, 'ready');
  assert.equal(s.lastText, 'Read them all.');
  assert.equal(s.model, 'gemini-3-flash-preview');
});

test('commands, help and context that Gemini CLI or a hook adds are not the person talking', (t) => {
  const root = geminiHome(t);
  project(root);
  const at = T0 - 2 * MINUTE;
  writeLog(root, SID, [
    user(at, '/model'),
    user(at + 100, '?'),
    user(at + 200, '<session_context>Today is a weekday.</session_context>'),
    user(at + 300, '<hook_context>Follow the house rules.</hook_context>'),
    user(at + 400, 'The real question'),
    reply(at + 500, 'The real answer.'),
    user(at + 600, '/stats'),
  ]);
  const { source, get } = open(root);
  const s = get(KEY);
  assert.equal(s.title, 'The real question');
  assert.equal(s.status, 'ready', 'a command after the answer starts no turn');
  assert.deepEqual(source.detail(KEY, null).events.map((e) => [e.kind, e.text]), [['user', 'The real question'], ['assistant', 'The real answer.']]);
});

test('tool results going back to the model are not the person talking, and keep the turn going', (t) => {
  const root = geminiHome(t);
  project(root);
  const at = T0 - 2 * MINUTE;
  const response = { functionResponse: { id: 'c1', name: 'read_file', response: { output: 'The file says hi.' } } };
  writeLog(root, SID, [
    user(at, 'Read the file'),
    reply(at + 1000, [{ functionCall: { id: 'c1', name: 'read_file', args: { absolute_path: '/home/ada/project/a.txt' } } }]),
    user(at + 2000, null, { content: [response] }),
  ]);
  const { source, get } = open(root);
  const s = get(KEY);
  assert.equal(s.title, 'Read the file');
  assert.equal(s.status, 'working');
  assert.deepEqual(source.detail(KEY, null).events.map((e) => [e.kind, e.tool, e.text]), [
    ['user', null, 'Read the file'],
    ['tool', 'read_file', 'a.txt'],
    ['result', 'read_file', 'The file says hi.'],
  ]);
});

// ---- helpers ----

test('a helper hangs under the session that started it, with hand-offs both ways', (t) => {
  const root = geminiHome(t);
  project(root);
  const at = T0 - 5 * MINUTE;
  const main = writeLog(root, SID, [
    user(at, 'Look through the code'),
    uses(at + 1000, [call(at + 1000, 'c1', 'codebase_investigator', { objective: 'Find the login code' }, 'executing')]),
  ]);
  const one = writeHelper(root, SID, 'codebase_investigator-a1b2', [
    user(at + 2000, 'Find the login code'),
    uses(at + 3000, [call(at + 3000, 'h1', 'read_file', { absolute_path: '/home/ada/project/src/login.js' }, 'executing')]),
  ], { at: at + 2000 });
  writeHelper(root, SID, 'helper-two', [user(at + 2500, 'Count the files')], { at: at + 2500 });
  const ONE = keyOf(SID, 'codebase_investigator-a1b2');
  const TWO = keyOf(SID, 'helper-two');
  const { poll } = open(root);
  let sessions = poll().sessions;
  assert.deepEqual(sessions.map((s) => s.key), [KEY, ONE, TWO]);
  let [lead, helper, other] = sessions;
  assert.equal(helper.kind, 'agent');
  assert.equal(helper.id, 'codebase_investigator-a1b2');
  assert.equal(helper.parentKey, KEY);
  assert.equal(helper.spawned, true);
  assert.equal(helper.cwd, FOLDER);
  assert.equal(helper.startedAt, at + 2000);
  assert.equal(helper.title, 'Find the login code');
  assert.equal(helper.status, 'working');
  assert.deepEqual(helper.activity, { tool: 'ReadFile', detail: 'login.js', at: at + 3000 });
  assert.equal(other.status, 'working');
  assert.equal(lead.status, 'working');
  assert.deepEqual(lead.activity, { tool: 'codebase_investigator', detail: null, at: at + 1000 });
  assert.deepEqual(lead.links, [
    { at: at + 2000, dir: 'down', other: ONE, label: 'Find the login code' },
    { at: at + 2500, dir: 'down', other: TWO, label: 'Count the files' },
  ]);

  // The first helper hands back its result with its last call: it is done, and its report goes up.
  append(one, reply(at + 4000, 'The login code is in src/login.js.', { toolCalls: [call(at + 4000, 'h2', 'complete_task', { result: 'src/login.js' }, 'success')] }));
  sessions = poll().sessions;
  [lead, helper, other] = sessions;
  assert.equal(helper.status, 'done');
  assert.equal(helper.activity, null);
  assert.equal(other.status, 'working');
  assert.deepEqual(lead.links.at(-1), { at: at + 4000, dir: 'up', other: ONE, label: 'The login code is in src/login.js.' });

  // The session goes on after its tool call ended: the other helper's log looks open, but the
  // session heard back from it, so it is done too.
  append(main, uses(at + 1000, [call(at + 5000, 'c1', 'codebase_investigator', { objective: 'Find the login code' }, 'success')]), reply(at + 6000, 'Found it.'));
  sessions = poll().sessions;
  [lead, helper, other] = sessions;
  assert.equal(lead.status, 'ready');
  assert.equal(other.status, 'done');
  assert.equal(other.needs, null);
});

test('a new helper shows on the next poll after its session moves', (t) => {
  const root = geminiHome(t);
  project(root);
  const at = T0 - MINUTE;
  const main = writeLog(root, SID, [user(at, 'Go')]);
  const { poll } = open(root);
  assert.equal(poll().sessions.length, 1);
  writeHelper(root, SID, 'helper-1', [user(at + 1000, 'Look around')]);
  assert.equal(poll().sessions.length, 1, 'the session did not move, and the folders are listed every 30 seconds');
  append(main, uses(at + 2000, [call(at + 2000, 'c1', 'codebase_investigator', { objective: 'Look around' }, 'executing')]));
  assert.deepEqual(poll().sessions.map((s) => s.key), [KEY, keyOf(SID, 'helper-1')]);
});

// ---- status ----

test('status: needs you, working, error, finished and quiet', (t) => {
  const root = geminiHome(t);
  project(root);
  const at = T0 - 2 * MINUTE;
  const ids = { ask: idAt(1), run: idAt(2), fail: idAt(3), done: idAt(4), stale: idAt(5), old: idAt(6), stop: idAt(7), going: idAt(8), info: idAt(9) };
  const shell = (status, args = { command: 'npm test' }) => [user(at, 'Go'), uses(at + 1000, [call(at + 1000, 'c1', 'run_shell_command', args, status)])];
  writeLog(root, ids.ask, shell('awaiting_approval', { command: 'rm -rf build', description: 'Remove the build folder' }));
  writeLog(root, ids.run, shell('executing'));
  writeLog(root, ids.fail, [user(at, 'Go'), failure(at + 1000, 'The quota ran out.')]);
  writeLog(root, ids.done, turn(at, 1));
  writeLog(root, ids.stale, [user(T0 - 40 * MINUTE, 'Go')]); // a turn that looks open but went quiet
  writeLog(root, ids.old, turn(T0 - 20 * MINUTE, 1)); // finished longer ago than activeMinutes
  writeLog(root, ids.stop, shell('cancelled'));
  writeLog(root, ids.going, shell('success'));
  // A note from Gemini CLI itself changes nothing.
  writeLog(root, ids.info, [...turn(at, 1), { id: 'n-1', timestamp: iso(at + 2000), type: 'info', content: 'Switched model.' }]);

  const { get } = open(root);
  const ask = get(keyOf(ids.ask));
  assert.equal(ask.status, 'working');
  assert.deepEqual(ask.needs, { kind: 'permission', text: 'Asks to use Shell: Remove the build folder', at: at + 1000 });
  assert.deepEqual(ask.activity, { tool: 'Shell', detail: 'Remove the build folder', at: at + 1000 });
  const run = get(keyOf(ids.run));
  assert.equal(run.status, 'working');
  assert.equal(run.needs, null);
  assert.deepEqual(run.activity, { tool: 'Shell', detail: 'npm test', at: at + 1000 });
  assert.equal(get(keyOf(ids.fail)).status, 'error');
  assert.equal(get(keyOf(ids.done)).status, 'ready');
  assert.equal(get(keyOf(ids.done)).activity, null);
  assert.equal(get(keyOf(ids.stale)).status, 'idle');
  assert.equal(get(keyOf(ids.old)).status, 'idle');
  assert.equal(get(keyOf(ids.stop)).status, 'ready', 'a stopped tool call ends the turn');
  assert.equal(get(keyOf(ids.going)).status, 'working', 'the tool ran, and the model goes on');
  assert.equal(get(keyOf(ids.info)).status, 'ready');

  // The window settings count: with a longer stale time, the quiet turn is still working.
  assert.equal(open(root, { window: { staleMinutes: 60 } }).get(keyOf(ids.stale)).status, 'working');
});

test('a tool call needs the person only once it has waited a moment for approval', (t) => {
  const root = geminiHome(t);
  project(root);
  writeLog(root, SID, [user(T0 - 1000, 'Go'), uses(T0 - 500, [call(T0 - 500, 'c1', 'write_file', { file_path: '/home/ada/project/notes.md' }, 'awaiting_approval')])]);
  const { clock, get } = open(root);
  assert.equal(get(KEY).needs, null, 'approval rules answer most calls at once');
  clock.now = T0 + 2 * SECOND;
  assert.deepEqual(get(KEY).needs, { kind: 'permission', text: 'Asks to use WriteFile: notes.md', at: T0 - 500 });
  // It stays, however long the person takes.
  clock.now = T0 + 2 * HOUR;
  assert.equal(get(KEY).needs.kind, 'permission');
});

// ---- what may show ----

test('with content set to none, no session text shows: no titles, last words, tool details or event text', (t) => {
  const root = geminiHome(t);
  project(root);
  const at = T0 - 2 * MINUTE;
  writeLog(root, SID, [user(at, 'Secret plan for the launch'), uses(at + 1000, [call(at + 1000, 'c1', 'run_shell_command', { command: 'cat launch.txt' }, 'awaiting_approval')])], { head: { summary: 'Secret launch' } });
  writeLog(root, SID2, [user(at, 'Another secret'), reply(at + 1000, 'Secret answer')]);
  const { source, poll } = open(root, { content: 'none' });
  const sessions = poll().sessions;
  assert.equal(sessions.length, 2);
  for (const s of sessions) {
    assert.equal(s.title, null);
    assert.equal(s.titleSource, null);
    assert.equal(s.lastText, null);
  }
  const a = sessions.find((s) => s.key === KEY);
  assert.deepEqual(a.needs, { kind: 'permission', text: null, at: at + 1000 });
  assert.deepEqual(a.activity, { tool: 'Shell', detail: null, at: at + 1000 });
  assert.equal(/secret|launch/i.test(JSON.stringify(sessions)), false);
  for (const key of [KEY, keyOf(SID2)]) {
    const { events } = source.detail(key, null);
    assert.ok(events.length > 0);
    for (const e of events) assert.equal(e.text, null);
  }
});

test('thoughts never show, in the poll or in the side panel', (t) => {
  const root = geminiHome(t);
  project(root);
  const at = T0 - 2 * MINUTE;
  const thoughts = [{ subject: 'THOUGHT-SUBJECT', description: 'THOUGHT-WORDS', timestamp: iso(at + 500) }];
  writeLog(root, SID, [
    user(at, 'Plan the work'),
    reply(at + 1000, [{ text: 'THOUGHT-PART', thought: true }, { text: 'Here is the plan.' }], { thoughts }),
    uses(at + 2000, [call(at + 2000, 'c1', 'read_file', { absolute_path: '/home/ada/project/plan.md' }, 'executing')], { thoughts }),
  ]);
  const { source, poll } = open(root);
  const out = poll();
  assert.equal(JSON.stringify(out).includes('THOUGHT'), false);
  assert.equal(out.sessions[0].lastText, 'Here is the plan.');
  const detail = source.detail(KEY, null);
  assert.equal(JSON.stringify(detail).includes('THOUGHT'), false);
  assert.deepEqual(detail.events.map((e) => [e.kind, e.text]), [
    ['user', 'Plan the work'],
    ['thinking', null],
    ['assistant', 'Here is the plan.'],
    ['thinking', null],
    ['tool', 'plan.md'],
  ]);
  assert.equal(detail.events[1].at, at + 500);
});

test('Pleni opens only the chats folders, .project_root and projects.json, never login or settings files', (t) => {
  const root = geminiHome(t);
  project(root);
  fs.writeFileSync(path.join(root, 'projects.json'), JSON.stringify({ projects: { [FOLDER]: SLUG } }));
  const at = T0 - 2 * MINUTE;
  writeLog(root, SID, [user(at, 'Hello'), reply(at + 1000, 'Hi there.')]);
  const secret = 'SECRET-TOKEN-1234';
  for (const name of ['oauth_creds.json', 'google_accounts.json', 'gemini-credentials.json', 'trustedFolders.json', '.env']) {
    const file = path.join(root, name);
    fs.writeFileSync(file, secret);
    fs.chmodSync(file, 0); // no read permission
  }
  fs.mkdirSync(path.join(root, 'settings.json')); // a folder: reading it as a file would fail
  fs.writeFileSync(path.join(root, 'tmp', SLUG, '.env'), secret);
  fs.writeFileSync(path.join(chats(root), '.env'), secret);

  const spies = ['openSync', 'readFileSync', 'readdirSync', 'statSync'].map((name) => t.mock.method(fs, name));
  const { source, poll } = open(root);
  const out = poll();
  const detail = source.detail(KEY, null);
  const looked = spies
    .flatMap((spy) => spy.mock.calls.map((c) => String(c.arguments[0])))
    .filter((file) => file.startsWith(root))
    .map((file) => path.relative(root, file).split(path.sep).join('/'));
  for (const spy of spies) spy.mock.restore();

  assert.equal(out.sessions.length, 1);
  assert.equal(detail.events.length, 2);
  assert.ok(looked.length > 0);
  const allowed = (file) => file === '' || file === 'projects.json' || file === 'tmp'
    || /^tmp\/[^/]+\/\.project_root$/.test(file) || /^tmp\/[^/]+\/chats(\/.*)?$/.test(file);
  const forbidden = new Set(['oauth_creds.json', 'google_accounts.json', 'gemini-credentials.json', 'settings.json', 'trustedFolders.json']);
  for (const file of looked) {
    assert.ok(allowed(file), `Pleni looked at ${file}`);
    assert.ok(!forbidden.has(path.posix.basename(file)) && !file.endsWith('.env'), `Pleni opened ${file}`);
  }
  assert.equal(JSON.stringify([out, detail]).includes(secret), false);
});

// ---- the side panel ----

test('the side panel shows prompts, replies, tool calls and results, each message once', (t) => {
  const root = geminiHome(t);
  project(root);
  const at = T0 - 2 * MINUTE;
  const output = [{ functionResponse: { id: 'c1', name: 'run_shell_command', response: { output: 'Build passed' } } }];
  const file = writeLog(root, SID, [
    user(at, 'Fix the build with @src/build.js', { displayContent: 'Fix the build' }),
    user(at + 100, '<session_context>This is Gemini CLI.</session_context>'),
    reply(at + 1000, 'Looking.', { toolCalls: [call(at + 1000, 'c1', 'run_shell_command', { command: 'npm run build' }, 'executing')] }),
    reply(at + 1000, 'Looking.', { toolCalls: [call(at + 1500, 'c1', 'run_shell_command', { command: 'npm run build' }, 'success', { result: output })] }),
    user(at + 2000, null, { content: output }), // the same result, going back to the model
    uses(at + 3000, [call(at + 3000, 'c2', 'write_file', { file_path: '/home/ada/project/build.js' }, 'error', { result: 'The disk is full.' })]),
    reply(at + 4000, 'The build works now.'),
    failure(at + 5000, 'The model is busy. Try again.'),
  ]);
  const { source, poll } = open(root);
  poll();
  const first = source.detail(KEY, null);
  assert.equal(first.reset, true, 'each answer is the whole recent list');
  assert.equal(first.next, fs.statSync(file).size);
  assert.deepEqual(first.events.map((e) => [e.at, e.kind, e.tool, e.text]), [
    [at, 'user', null, 'Fix the build'],
    [at + 1000, 'assistant', null, 'Looking.'],
    [at + 1500, 'tool', 'Shell', 'npm run build'],
    [at + 1500, 'result', 'Shell', 'Build passed'],
    [at + 3000, 'tool', 'WriteFile', 'build.js'],
    [at + 3000, 'error', 'WriteFile', 'The disk is full.'],
    [at + 4000, 'assistant', null, 'The build works now.'],
    [at + 5000, 'error', null, 'The model is busy. Try again.'],
  ]);
  assert.equal(JSON.stringify(first).includes('private-notes'), false, "a tool's own description never shows");

  // Nothing new since the last answer: no events, and the page keeps what it has.
  assert.deepEqual(source.detail(KEY, first.next), { events: [], next: first.next });
  append(file, user(at + 6000, 'One more thing'));
  const later = source.detail(KEY, first.next);
  assert.equal(later.reset, true);
  assert.deepEqual(later.events.at(-1), { at: at + 6000, kind: 'user', tool: null, text: 'One more thing' });
  assert.equal(later.events.length, 9);

  assert.deepEqual(source.detail(keyOf(SID2), null), { events: [], next: null });
  assert.deepEqual(source.detail(`kimi:${SID}`, null), { events: [], next: null });
  assert.deepEqual(source.detail(42, null), { events: [], next: null });
});

// ---- errors ----

test('without its folder, the source says so in plain words', (t) => {
  assert.deepEqual(createGeminiSource({ root: null, settings: cleanSettings({}) }).poll(), {
    ok: false,
    error: 'No Gemini CLI folder is set.',
    root: null,
    sessions: [],
  });
  const missing = path.join(geminiHome(t), 'missing');
  const out = createGeminiSource({ root: missing, settings: cleanSettings({}) }).poll();
  assert.deepEqual(out, { ok: false, error: 'Pleni could not find the Gemini CLI folder.', root: missing, sessions: [] });
});
