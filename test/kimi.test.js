import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cleanSettings } from '../src/config.js';
import { createKimiSource } from '../src/sources/kimi.js';

const MiB = 1024 * 1024;
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const T0 = Math.floor(Date.now() / 1000) * 1000;

const SID = '0199c000-0000-7000-8000-000000000001';
const SID2 = '0199c000-0000-7000-8000-000000000002';
const idAt = (n) => `0199d000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const FOLDER = 'wd_project_0123456789ab';
const keyOf = (id, agent) => (agent ? `kimi:${id}/${agent}` : `kimi:${id}`);
const KEY = keyOf(SID);

// ---- fixture helpers (everything is synthetic) ----

function kimiHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pleni-kimi-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const iso = (ms) => new Date(ms).toISOString();
const line = (record) => `${JSON.stringify(record)}\n`;
const append = (file, ...records) => fs.appendFileSync(file, records.map(line).join(''));
const setMtime = (file, ms) => fs.utimesSync(file, ms / 1000, ms / 1000);
const sessionDir = (root, id, folder = FOLDER) => path.join(root, 'sessions', folder, `session_${id}`);

// state.json in the newer shape, or with `old` in the older one (ISO times, workDir, no id).
function writeState(root, id, fields = {}, { old = false, folder = FOLDER, at = T0 - 30 * MINUTE, mtime } = {}) {
  const dir = sessionDir(root, id, folder);
  fs.mkdirSync(dir, { recursive: true });
  const agents = { main: { homedir: path.join(dir, 'agents', 'main'), type: 'main', parentAgentId: null }, ...fields.agents };
  const state = old
    ? { createdAt: iso(at), updatedAt: iso(at), custom: {}, workDir: '/home/ada/older', ...fields, agents }
    : { id: `session_${id}`, version: 2, cwd: '/home/ada/project', createdAt: at, updatedAt: at, archived: false, custom: {}, ...fields, agents };
  const file = path.join(dir, 'state.json');
  fs.writeFileSync(file, JSON.stringify(state));
  if (mtime !== undefined) setMtime(file, mtime);
  return file;
}

// A helper's entry in state.json.
const helper = (id, extra = {}) => ({ homedir: `/home/ada/.kimi-code/agents/${id}`, type: 'sub', parentAgentId: 'main', labels: { parentAgentId: 'main' }, ...extra });

// An agent's wire.jsonl, starting with the metadata line Kimi Code writes first.
function writeWire(root, id, agent, records, { folder = FOLDER, at = T0 - 30 * MINUTE, mtime, head = true } = {}) {
  const file = path.join(sessionDir(root, id, folder), 'agents', agent, 'wire.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const all = head ? [{ type: 'metadata', protocol_version: '1.5', created_at: at }, ...records] : records;
  fs.writeFileSync(file, all.map(line).join(''));
  if (mtime !== undefined) setMtime(file, mtime);
  return file;
}

// A session: its state.json and its main agent's log.
function kimiSession(root, id, records, { state = {}, ...options } = {}) {
  writeState(root, id, state, options);
  return writeWire(root, id, 'main', records, options);
}

const loop = (ms, event) => ({ type: 'context.append_loop_event', event, time: ms });
const prompt = (ms, text, origin = { kind: 'user' }) => ({ type: 'turn.prompt', input: [{ type: 'text', text }], origin, time: ms });
// The work the agent above gives a helper.
const work = (ms, text) => prompt(ms, text, { kind: 'system_trigger', name: 'subagent' });
const step = (ms, turn, n = 1) => loop(ms, { type: 'step.begin', uuid: `step-${turn}-${n}`, turnId: String(turn), step: n });
const part = (ms, turn, value, n = 1) =>
  loop(ms, { type: 'content.part', uuid: `part-${ms}-${n}`, turnId: String(turn), step: n, stepUuid: `step-${turn}-${n}`, part: value });
const say = (ms, turn, text, n) => part(ms, turn, { type: 'text', text }, n);
const think = (ms, turn, text, n) => part(ms, turn, { type: 'think', think: text, reasoningKey: 'reasoning_one' }, n);
// Kimi Code writes a description with a full path beside each call; Pleni must never show it.
const call = (ms, turn, id, name, args, n = 1) =>
  loop(ms, { type: 'tool.call', uuid: `call-${id}`, turnId: String(turn), step: n, toolCallId: id, name, args, description: `${name} /home/ada/project/private-notes.txt` });
const result = (ms, id, output, extra = {}) => loop(ms, { type: 'tool.result', parentUuid: `call-${id}`, toolCallId: id, result: { output, ...extra } });
const stepEnd = (ms, turn, finishReason = 'end_turn', n = 1) =>
  loop(ms, { type: 'step.end', uuid: `end-${turn}-${n}`, turnId: String(turn), step: n, finishReason, usage: { inputOther: 1, output: 1, inputCacheRead: 0, inputCacheCreation: 0 } });
const ended = (ms, turn, reason = 'completed', extra = {}) => ({ type: 'turn.ended', turnId: turn, reason, durationMs: 1000, time: ms, ...extra });
const cancel = (ms, turn) => ({ type: 'turn.cancel', turnId: turn, target: 'active', reason: 'user_cancelled', time: ms });
const request = (ms, model, effort, extra = {}) =>
  ({ type: 'llm.request', kind: 'loop', provider: 'kimi', model, modelAlias: `kimi-code/${model}`, thinkingEffort: effort, turnStep: '0.1', time: ms, ...extra });
const profile = (ms, alias, effort) => ({
  type: 'profile.bind',
  modelAlias: alias,
  profileName: 'agent',
  thinkingEffort: effort,
  systemPrompt: 'You are Kimi.',
  environmentDisclosure: { cwd: '/home/ada/project' },
  agentsMdPaths: [],
  activeToolNames: ['Bash'],
  disallowedTools: [],
  time: ms,
});
const config = (ms, fields) => ({ type: 'config.update', ...fields, time: ms });
const ask = (ms, id, kind, req, agentId = 'main') => ({
  type: 'interaction.request',
  id,
  kind,
  toolCallId: req.toolCallId ?? id,
  agentId,
  request: { sessionId: `session_${SID}`, agentId, turnId: 0, toolCallId: id, ...req },
  time: ms,
});
const resolved = (ms, id, response = { decision: 'approved', scope: 'session' }) => ({ type: 'interaction.resolved', id, response, time: ms });
const task = (ms, type, info) => ({
  type,
  info: {
    taskId: 'task_one',
    description: 'A background helper',
    status: type === 'task.started' ? 'running' : 'completed',
    detached: true,
    startedAt: ms,
    endedAt: type === 'task.started' ? null : ms,
    kind: 'agent',
    ...info,
  },
  time: ms,
});

// One whole turn: a prompt, a reply and the end.
function turn(ms, n, text = 'Done.') {
  return [prompt(ms, `Prompt ${n}`), step(ms, n), say(ms + 1, n, text), stepEnd(ms + 2, n), ended(ms + 3, n)];
}

function open(root, { content = 'snippets', window } = {}) {
  const clock = { now: T0 };
  const settings = cleanSettings({ content, window });
  const source = createKimiSource({ root, settings, now: () => clock.now });
  const poll = () => {
    const out = source.poll();
    assert.equal(out.ok, true, out.error);
    return out;
  };
  const get = (key) => poll().sessions.find((s) => s.key === key);
  return { clock, source, poll, get };
}

// ---- discovery ----

test('finds sessions in every working folder, in both state.json shapes', (t) => {
  const root = kimiHome(t);
  kimiSession(root, idAt(1), turn(T0 - 5 * MINUTE, 0), { folder: 'wd_alpha_0123456789ab' });
  kimiSession(root, idAt(2), turn(T0 - 5 * MINUTE, 0), { folder: 'wd_beta_0123456789ab', old: true });
  kimiSession(root, idAt(3), turn(T0 - 48 * HOUR, 0), { mtime: T0 - 48 * HOUR }); // older than recentHours
  kimiSession(root, idAt(4), [config(T0 - MINUTE, { modelAlias: 'kimi-code/k3' })]); // opened, nothing done yet
  fs.mkdirSync(path.join(root, 'sessions', '.index-cache'), { recursive: true });
  fs.writeFileSync(path.join(root, 'sessions', '.index-cache', 'scan.json'), '{"version":1,"sessions":{}}');
  fs.mkdirSync(path.join(root, 'sessions', FOLDER, 'session_not-an-id!'), { recursive: true });
  fs.writeFileSync(path.join(root, 'sessions', FOLDER, 'notes.txt'), 'hello\n');

  const { sessions, root: reported } = open(root).poll();
  assert.equal(reported, root);
  assert.deepEqual(sessions.map((s) => s.key), [keyOf(idAt(1)), keyOf(idAt(2))]);
  const [a, b] = sessions;
  assert.equal(a.platform, 'kimi');
  assert.equal(a.id, idAt(1));
  assert.equal(a.kind, 'session');
  assert.equal(a.parentKey, null);
  assert.equal(a.spawned, false);
  assert.equal(a.role, null);
  assert.equal(a.branch, null);
  assert.equal(a.cwd, '/home/ada/project');
  assert.equal(a.lastAt, T0 - 5 * MINUTE + 3);
  assert.equal(a.archived, false);
  assert.equal(b.cwd, '/home/ada/older');
});

test('keeps only the newest 300 sessions', (t) => {
  const root = kimiHome(t);
  for (let n = 1; n <= 305; n++) kimiSession(root, idAt(n), [prompt(T0 - HOUR, 'go')], { mtime: T0 - n * SECOND });
  const ids = open(root).poll().sessions.map((s) => s.id);
  assert.equal(ids.length, 300);
  for (let n = 301; n <= 305; n++) assert.ok(!ids.includes(idAt(n)), `${n} should be left out`);
  assert.ok(ids.includes(idAt(300)));
});

test('looks for new sessions every 30 seconds', (t) => {
  const root = kimiHome(t);
  kimiSession(root, idAt(1), turn(T0 - 5 * MINUTE, 0));
  const { clock, poll } = open(root);
  assert.equal(poll().sessions.length, 1);

  kimiSession(root, idAt(2), turn(T0 - MINUTE, 0));
  clock.now = T0 + 10 * SECOND;
  assert.equal(poll().sessions.length, 1);
  clock.now = T0 + 31 * SECOND;
  assert.equal(poll().sessions.length, 2);
});

test('a new helper shows on the next poll after its session moves', (t) => {
  const root = kimiHome(t);
  const main = kimiSession(root, SID, [prompt(T0 - MINUTE, 'go'), step(T0 - MINUTE, 0)]);
  const { clock, poll } = open(root);
  assert.equal(poll().sessions.length, 1);

  clock.now = T0 + 5 * SECOND;
  writeWire(root, SID, 'agent-0', [work(T0 + 4 * SECOND, 'Look around.'), step(T0 + 4 * SECOND, 0)], { at: T0 + 4 * SECOND });
  append(main, call(T0 + 3 * SECOND, 0, 'call_agent', 'Agent', { description: 'Survey the code', prompt: 'Look around.' }));
  const sessions = poll().sessions;
  assert.deepEqual(sessions.map((s) => s.key), [KEY, keyOf(SID, 'agent-0')]);
  assert.equal(sessions[1].title, 'Survey the code');
});

test('helpers whose log is older than recentHours are left out', (t) => {
  const root = kimiHome(t);
  kimiSession(root, SID, turn(T0 - 5 * MINUTE, 0), { state: { agents: { 'agent-0': helper('agent-0'), 'agent-1': helper('agent-1') } } });
  writeWire(root, SID, 'agent-0', turn(T0 - 48 * HOUR, 0), { mtime: T0 - 48 * HOUR });
  writeWire(root, SID, 'agent-1', [work(T0 - 4 * MINUTE, 'Look.'), step(T0 - 4 * MINUTE, 0)]);
  fs.mkdirSync(path.join(sessionDir(root, SID), 'agents', 'Not An Id'), { recursive: true });
  assert.deepEqual(open(root).poll().sessions.map((s) => s.key), [KEY, keyOf(SID, 'agent-1')]);
});

test('a missing Kimi Code folder is reported, not thrown', (t) => {
  const root = kimiHome(t);
  const gone = createKimiSource({ root: path.join(root, 'nope'), settings: cleanSettings({}) }).poll();
  assert.equal(gone.ok, false);
  assert.match(gone.error, /could not find/);
  assert.deepEqual(gone.sessions, []);

  const unset = createKimiSource({ root: null, settings: cleanSettings({}) }).poll();
  assert.equal(unset.ok, false);
  assert.equal(typeof unset.error, 'string');

  // Kimi Code installed but never used: no sessions folder yet.
  assert.deepEqual(open(root).poll().sessions, []);
});

// ---- state.json ----

test('start times come from the log head, else from state.json in either shape', (t) => {
  const root = kimiHome(t);
  writeState(root, idAt(1), {}, { at: T0 - 25 * MINUTE });
  writeWire(root, idAt(1), 'main', turn(T0 - 5 * MINUTE, 0), { at: T0 - 20 * MINUTE });
  kimiSession(root, idAt(2), turn(T0 - 5 * MINUTE, 0), { at: T0 - 21 * MINUTE, head: false });
  kimiSession(root, idAt(3), turn(T0 - 5 * MINUTE, 0), { at: T0 - 22 * MINUTE, head: false, old: true });
  const starts = Object.fromEntries(open(root).poll().sessions.map((s) => [s.id, s.startedAt]));
  assert.deepEqual(starts, { [idAt(1)]: T0 - 20 * MINUTE, [idAt(2)]: T0 - 21 * MINUTE, [idAt(3)]: T0 - 22 * MINUTE });
});

test('archived sessions and their helpers are archived and need nothing', (t) => {
  const root = kimiHome(t);
  kimiSession(
    root,
    SID,
    [prompt(T0 - 2 * MINUTE, 'go'), step(T0 - 2 * MINUTE, 0), ask(T0 - MINUTE, 'tool_ls', 'approval', { toolName: 'Bash', action: 'Run: ls' })],
    { state: { archived: true, agents: { 'agent-0': helper('agent-0') } } },
  );
  writeWire(root, SID, 'agent-0', [work(T0 - 2 * MINUTE, 'Look.'), step(T0 - 2 * MINUTE, 0)]);
  const { sessions } = open(root).poll();
  assert.deepEqual(sessions.map((s) => [s.key, s.archived]), [[KEY, true], [keyOf(SID, 'agent-0'), true]]);
  assert.equal(sessions[0].needs, null);
});

test("the person's own title always shows; a title made from the first prompt only with snippets", (t) => {
  const root = kimiHome(t);
  const records = turn(T0 - 5 * MINUTE, 0);
  kimiSession(root, idAt(1), records, { state: { title: 'Release checklist', isCustomTitle: true } });
  kimiSession(root, idAt(2), records, {
    state: { title: 'Please fix the login bug on the billing page', isCustomTitle: false, lastPrompt: 'Please fix the login bug on the billing page' },
  });
  kimiSession(root, idAt(3), records, { state: { lastPrompt: 'Words that are never a title' } });
  kimiSession(root, idAt(4), records, { old: true, state: { title: `${'Long title '.repeat(20)}end`, isCustomTitle: true } });

  const titles = (content) => open(root, { content }).poll().sessions.map((s) => [s.title, s.titleSource]);
  const shown = titles('snippets');
  assert.deepEqual(shown.slice(0, 3), [
    ['Release checklist', 'custom-title'],
    ['Please fix the login bug on the billing page', 'first-prompt'],
    [null, null],
  ]);
  assert.ok(shown[3][0].length <= 120 && shown[3][0].endsWith('…'));
  assert.deepEqual(titles('none').slice(0, 3), [['Release checklist', 'custom-title'], [null, null], [null, null]]);

  const hidden = JSON.stringify(open(root, { content: 'none' }).poll());
  assert.equal(hidden.includes('login bug'), false);
  assert.equal(hidden.includes('never a title'), false);
});

test('a state.json that cannot be read leaves the session without its title', (t) => {
  const root = kimiHome(t);
  const file = writeState(root, SID, { title: 'Release checklist', isCustomTitle: true });
  writeWire(root, SID, 'main', [profile(T0 - 3 * MINUTE, 'kimi-code/k3', 'max'), ...turn(T0 - 2 * MINUTE, 0)]);
  fs.writeFileSync(file, '{"title": "Release');
  const s = open(root).get(KEY);
  assert.equal(s.title, null);
  assert.equal(s.cwd, '/home/ada/project'); // from the log instead
  assert.equal(s.status, 'ready');
});

// ---- model, effort and text ----

test('model and effort follow the newest request, profile or setting', (t) => {
  const root = kimiHome(t);
  const file = kimiSession(root, SID, [profile(T0 - 10 * MINUTE, 'kimi-code/kimi-for-coding', 'low'), prompt(T0 - 9 * MINUTE, 'go'), step(T0 - 9 * MINUTE, 0)]);
  const { get } = open(root);
  const pick = () => {
    const s = get(KEY);
    return [s.model, s.effort];
  };
  assert.deepEqual(pick(), ['kimi-for-coding', 'low']);

  append(file, request(T0 - 8 * MINUTE, 'k3', 'max'));
  assert.deepEqual(pick(), ['k3', 'max']);

  // A summary request does not change what the session works with.
  append(file, request(T0 - 7 * MINUTE, 'summary-model', 'low', { kind: 'compaction' }));
  assert.deepEqual(pick(), ['k3', 'max']);

  append(file, config(T0 - 6 * MINUTE, { thinkingEffort: 'high' }));
  assert.deepEqual(pick(), ['k3', 'high']);
  append(file, config(T0 - 5 * MINUTE, { modelAlias: 'kimi-code/kimi-k3', profileName: 'agent' }));
  assert.deepEqual(pick(), ['kimi-k3', 'high']);

  // Settings changes are not work: lastAt stays with the last request.
  assert.equal(get(KEY).lastAt, T0 - 7 * MINUTE);
});

test('lastText is the newest reply; the parts of one step are joined', (t) => {
  const root = kimiHome(t);
  const at = T0 - 3 * MINUTE;
  const file = kimiSession(root, SID, [
    prompt(at, 'go'),
    step(at, 0),
    say(at, 0, 'First   thought.'),
    think(at, 0, 'private musing'),
    say(at, 0, 'Second\n\npart.'),
  ]);
  const { get } = open(root);
  assert.equal(get(KEY).lastText, 'First thought. Second part.');

  append(file, stepEnd(at, 0, 'tool_use'), step(T0 - 2 * MINUTE, 0, 2), say(T0 - 2 * MINUTE, 0, 'x'.repeat(400), 2));
  const text = get(KEY).lastText;
  assert.equal(text.length, 280);
  assert.ok(text.endsWith('…'));
});

// ---- turns and status ----

test('turn status: working, stale, ready, old, error, stopped', (t) => {
  const root = kimiHome(t);
  kimiSession(root, idAt(1), [prompt(T0 - MINUTE, 'go'), step(T0 - MINUTE, 0)]);
  kimiSession(root, idAt(2), [prompt(T0 - 40 * MINUTE, 'go'), step(T0 - 40 * MINUTE, 0)]);
  kimiSession(root, idAt(3), turn(T0 - 5 * MINUTE, 0));
  kimiSession(root, idAt(4), turn(T0 - 25 * MINUTE, 0));
  const failure = { error: { code: 'provider.auth_error', message: 'Bad key', name: 'APIStatusError', retryable: false } };
  kimiSession(root, idAt(5), [
    prompt(T0 - 3 * MINUTE, 'go'),
    step(T0 - 3 * MINUTE, 0),
    stepEnd(T0 - 2 * MINUTE, 0, 'tool_use'),
    step(T0 - 2 * MINUTE, 0, 2),
    ended(T0 - MINUTE, 0, 'failed', failure),
  ]);
  kimiSession(root, idAt(6), [prompt(T0 - 3 * MINUTE, 'go'), step(T0 - 3 * MINUTE, 0), cancel(T0 - 2 * MINUTE, 0), ended(T0 - 2 * MINUTE, 0, 'cancelled')]);
  // The end of the earlier turn, told late, does not end the one that runs now.
  kimiSession(root, idAt(7), [...turn(T0 - 4 * MINUTE, 0), prompt(T0 - 2 * MINUTE, 'more'), step(T0 - 2 * MINUTE, 1), ended(T0 - MINUTE, 0)]);
  // A turn whose start was not seen.
  kimiSession(root, idAt(8), [step(T0 - MINUTE, 7), call(T0 - MINUTE, 7, 'tool_make', 'Bash', { command: 'make' })]);

  const status = Object.fromEntries(open(root).poll().sessions.map((s) => [s.id, s.status]));
  assert.deepEqual(status, {
    [idAt(1)]: 'working',
    [idAt(2)]: 'idle',
    [idAt(3)]: 'ready',
    [idAt(4)]: 'idle',
    [idAt(5)]: 'error',
    [idAt(6)]: 'ready',
    [idAt(7)]: 'working',
    [idAt(8)]: 'working',
  });
});

test('without turn.ended (protocol 1.4) a turn ends with its end_turn step, unless more steps follow', (t) => {
  const root = kimiHome(t);
  const file = kimiSession(root, SID, [prompt(T0 - 5 * MINUTE, 'go'), step(T0 - 5 * MINUTE, 0), say(T0 - 4 * MINUTE, 0, 'First answer.'), stepEnd(T0 - 4 * MINUTE, 0)]);
  const { get } = open(root);
  assert.equal(get(KEY).status, 'ready');

  // The same turn goes on with another step.
  append(file, step(T0 - 3 * MINUTE, 0, 2), call(T0 - 3 * MINUTE, 0, 'tool_test', 'Bash', { command: 'npm test' }, 2));
  let s = get(KEY);
  assert.equal(s.status, 'working');
  assert.deepEqual(s.activity, { tool: 'Bash', detail: 'npm test', at: T0 - 3 * MINUTE });

  const usage = { type: 'usage.record', model: 'k3', usage: { inputOther: 1, output: 1 }, usageScope: 'turn', time: T0 - 2 * MINUTE };
  append(file, result(T0 - 2 * MINUTE, 'tool_test', 'ok'), stepEnd(T0 - 2 * MINUTE, 0, 'end_turn', 2), usage);
  s = get(KEY);
  assert.equal(s.status, 'ready');
  assert.equal(s.activity, null);

  // A step that ends in an error ends its turn with an error.
  append(file, prompt(T0 - MINUTE, 'again'), step(T0 - MINUTE, 1), stepEnd(T0 - MINUTE, 1, 'error'));
  assert.equal(get(KEY).status, 'error');
});

test('the stale and active windows come from settings', (t) => {
  const root = kimiHome(t);
  kimiSession(root, idAt(1), [prompt(T0 - 40 * MINUTE, 'go'), step(T0 - 40 * MINUTE, 0)]);
  kimiSession(root, idAt(2), turn(T0 - 20 * MINUTE, 0));
  const sessions = open(root, { window: { staleMinutes: 60, activeMinutes: 30 } }).poll().sessions;
  assert.deepEqual(Object.fromEntries(sessions.map((s) => [s.id, s.status])), { [idAt(1)]: 'working', [idAt(2)]: 'ready' });
});

test('reads only new bytes and waits for a partial last line', (t) => {
  const root = kimiHome(t);
  const file = kimiSession(root, SID, [prompt(T0 - 2 * MINUTE, 'Start please'), step(T0 - 2 * MINUTE, 0)]);
  const reply = JSON.stringify(say(T0 - MINUTE, 0, 'All set.'));
  fs.appendFileSync(file, reply.slice(0, 40));
  const { get } = open(root);
  let s = get(KEY);
  assert.equal(s.status, 'working');
  assert.equal(s.lastText, null);

  fs.appendFileSync(file, reply.slice(40));
  assert.equal(get(KEY).lastText, null, 'still no newline');

  fs.appendFileSync(file, '\n');
  assert.equal(get(KEY).lastText, 'All set.');

  append(file, stepEnd(T0 - MINUTE, 0), ended(T0 - MINUTE, 0));
  s = get(KEY);
  assert.equal(s.status, 'ready');
  assert.equal(s.lastAt, T0 - MINUTE);
});

test('broken lines and odd field types are skipped without failing', (t) => {
  const root = kimiHome(t);
  const file = kimiSession(root, SID, [prompt(T0 - 2 * MINUTE, 'go')]);
  fs.appendFileSync(file, 'not json\n[1,2]\n{"type":42,"time":"soon"}\n\n');
  append(
    file,
    { type: 'context.append_loop_event', event: 'nope', time: T0 - MINUTE },
    { type: 'context.append_loop_event', event: { type: 'tool.call', turnId: { x: 1 }, toolCallId: 7, name: ['Bash'], args: 'ls' }, time: T0 - MINUTE },
    { type: 'interaction.request', id: 5, kind: 'approval', request: 'x', time: T0 - MINUTE },
    { type: 'task.started', info: 'x', time: T0 - MINUTE },
    { type: 'llm.request', model: 42, thinkingEffort: {}, time: T0 - MINUTE },
    { type: 'agent.message.appended', message: { message: { role: 'assistant', content: 'plain' } }, time: T0 - MINUTE },
  );
  const s = open(root).get(KEY);
  assert.equal(s.status, 'working');
  assert.equal(s.lastAt, T0 - MINUTE);
  assert.equal(s.model, null);
  assert.equal(s.needs, null);
  assert.equal(s.activity, null);
});

// ---- activity ----

test('an open tool call is the activity until its result arrives', (t) => {
  const root = kimiHome(t);
  const file = kimiSession(root, SID, [
    prompt(T0 - 2 * MINUTE, 'go'),
    step(T0 - 2 * MINUTE, 0),
    call(T0 - MINUTE, 0, 'tool_test', 'Bash', { command: '\n  npm   test \nnpm run lint', timeout: 60 }),
  ]);
  const { get } = open(root);
  assert.deepEqual(get(KEY).activity, { tool: 'Bash', detail: 'npm test', at: T0 - MINUTE });

  append(file, result(T0 - MINUTE, 'tool_test', 'ok'));
  let s = get(KEY);
  assert.equal(s.activity, null);
  assert.equal(s.status, 'working');

  append(file, call(T0 - MINUTE, 0, 'tool_read', 'Read', { path: '/home/ada/project/src/app.js', n_lines: 40 }));
  s = get(KEY);
  assert.deepEqual(s.activity, { tool: 'Read', detail: 'app.js', at: T0 - MINUTE });
  assert.equal(JSON.stringify(s).includes('private-notes'), false);

  // A closed turn leaves no activity behind.
  append(file, stepEnd(T0 - MINUTE, 0), ended(T0 - MINUTE, 0));
  assert.equal(get(KEY).activity, null);
});

test('tool details use descriptions, commands, patterns, file names and host names', (t) => {
  const root = kimiHome(t);
  const at = T0 - 3 * MINUTE;
  kimiSession(root, SID, [
    prompt(at, 'go'),
    step(at, 0),
    call(at, 0, 'c1', 'Bash', { command: 'npm run build -- --watch', description: 'Build in the background', run_in_background: true, timeout: 600 }),
    call(at, 0, 'c2', 'Grep', { pattern: 'TODO\\(ada\\)', path: '/home/ada/project/src', output_mode: 'content' }),
    call(at, 0, 'c3', 'Glob', { pattern: '**/*.test.js' }),
    call(at, 0, 'c4', 'Write', { path: 'C:\\Users\\ada\\project\\notes.md', content: 'secret body' }),
    call(at, 0, 'c5', 'FetchURL', { url: 'https://docs.example.com/guide?q=1' }),
    call(at, 0, 'c6', 'WebSearch', { query: 'kimi wire protocol' }),
    call(at, 0, 'c7', 'Agent', { description: 'Survey the code', prompt: 'You are a helper.', subagent_type: 'explore' }),
    call(at, 0, 'c8', 'TodoList', { todos: [{ title: 'one', status: 'pending' }] }),
    call(at, 0, 'c9', 'Skill', { skill: 'release-notes', args: 'v2' }),
  ]);
  const { source, poll } = open(root);
  poll();
  const tools = source.detail(KEY).events.filter((e) => e.kind === 'tool').map((e) => [e.tool, e.text]);
  assert.deepEqual(tools, [
    ['Bash', 'Build in the background'],
    ['Grep', 'TODO\\(ada\\)'],
    ['Glob', '**/*.test.js'],
    ['Write', 'notes.md'],
    ['FetchURL', 'docs.example.com'],
    ['WebSearch', 'kimi wire protocol'],
    ['Agent', 'Survey the code'],
    ['TodoList', null],
    ['Skill', 'release-notes'],
  ]);
});

// ---- what the person must do ----

test('an approval, a question or a plan needs the person until answered or the turn ends', (t) => {
  const root = kimiHome(t);
  const push = { kind: 'command', command: 'git push origin main', cwd: '/home/ada/project', language: 'bash' };
  const file = kimiSession(root, SID, [
    prompt(T0 - 3 * MINUTE, 'go'),
    step(T0 - 3 * MINUTE, 0),
    ask(T0 - 2 * MINUTE, 'tool_push', 'approval', { toolName: 'Bash', action: 'Run: git push origin main', display: push }),
  ]);
  const { get, clock } = open(root);
  let s = get(KEY);
  assert.deepEqual(s.needs, { kind: 'permission', text: 'Run: git push origin main', at: T0 - 2 * MINUTE });
  assert.deepEqual(s.activity, { tool: 'Bash', detail: 'git push origin main', at: T0 - 2 * MINUTE });

  // However long the person takes.
  clock.now = T0 + 2 * HOUR;
  s = get(KEY);
  assert.equal(s.status, 'idle');
  assert.equal(s.needs.kind, 'permission');
  clock.now = T0;

  const approval = { type: 'permission.record_approval_result', turnId: 0, toolCallId: 'tool_push', toolName: 'Bash', result: { decision: 'approved' }, time: T0 - MINUTE };
  append(file, resolved(T0 - MINUTE, 'tool_push'), approval, call(T0 - MINUTE, 0, 'tool_push', 'Bash', { command: 'git push origin main' }));
  s = get(KEY);
  assert.equal(s.needs, null);
  assert.equal(s.activity.tool, 'Bash');

  const question = { question: 'Which database should I use?', header: 'Database', options: [{ label: 'SQLite', description: 'Small' }, { label: 'Postgres', description: 'Big' }] };
  append(
    file,
    result(T0 - 55 * SECOND, 'tool_push', 'pushed'),
    call(T0 - 50 * SECOND, 0, 'tool_ask', 'AskUserQuestion', { questions: [question] }),
    ask(T0 - 50 * SECOND, 'question_0199c000', 'question', { toolCallId: 'tool_ask', questions: [question] }),
  );
  assert.deepEqual(get(KEY).needs, { kind: 'question', text: 'Which database should I use?', at: T0 - 50 * SECOND });

  append(file, resolved(T0 - 40 * SECOND, 'question_0199c000', { answers: { Database: 'SQLite' } }), result(T0 - 40 * SECOND, 'tool_ask', 'SQLite'));
  assert.equal(get(KEY).needs, null);

  append(file, ask(T0 - 30 * SECOND, 'approval_0199c000', 'approval', { toolName: 'ExitPlanMode', action: 'Approve the plan', display: { kind: 'plan_review', plan: '# Plan' } }));
  assert.deepEqual(get(KEY).needs, { kind: 'plan', text: 'Approve the plan', at: T0 - 30 * SECOND });

  // A turn that ends without an answer needs nothing more.
  append(file, ended(T0 - 20 * SECOND, 0, 'cancelled'));
  assert.equal(get(KEY).needs, null);
});

test('a request for approval needs the person only after a moment; a question or a plan at once', (t) => {
  const root = kimiHome(t);
  const file = kimiSession(root, SID, [
    prompt(T0 - MINUTE, 'go'),
    step(T0 - MINUTE, 0),
    ask(T0 - 500, 'tool_ls', 'approval', { toolName: 'Bash', action: 'Run: ls', display: { kind: 'command', command: 'ls' } }),
  ]);
  const { get, clock } = open(root);
  // Approval rules answer many requests within milliseconds, before anyone could see them.
  let s = get(KEY);
  assert.equal(s.needs, null);
  assert.deepEqual(s.activity, { tool: 'Bash', detail: 'ls', at: T0 - 500 });
  clock.now = T0 + 1500;
  assert.deepEqual(get(KEY).needs, { kind: 'permission', text: 'Run: ls', at: T0 - 500 });

  // One answered within the moment never needs the person.
  append(
    file,
    resolved(T0 + 1500, 'tool_ls'),
    call(T0 + 1500, 0, 'tool_ls', 'Bash', { command: 'ls' }),
    result(T0 + 1500, 'tool_ls', 'a.txt'),
    ask(T0 + 1600, 'tool_rm', 'approval', { toolName: 'Bash', action: 'Run: rm a.txt' }),
  );
  clock.now = T0 + 1700;
  assert.equal(get(KEY).needs, null);
  append(file, resolved(T0 + 1610, 'tool_rm'));
  clock.now = T0 + 5000;
  assert.equal(get(KEY).needs, null);

  // A plan to accept and a question count as soon as they are asked.
  append(file, ask(T0 + 5000, 'approval_plan', 'approval', { toolName: 'ExitPlanMode', action: 'Approve the plan', display: { kind: 'plan_review', plan: '# Plan' } }));
  assert.deepEqual(get(KEY).needs, { kind: 'plan', text: 'Approve the plan', at: T0 + 5000 });
  append(
    file,
    resolved(T0 + 5000, 'approval_plan'),
    ask(T0 + 5000, 'question_one', 'question', { questions: [{ question: 'Which one?', header: 'Pick', options: [] }] }),
  );
  assert.deepEqual(get(KEY).needs, { kind: 'question', text: 'Which one?', at: T0 + 5000 });
});

test('a helper waiting for approval needs the person itself', (t) => {
  const root = kimiHome(t);
  const at = T0 - 3 * MINUTE;
  kimiSession(root, SID, [prompt(at, 'go'), step(at, 0), call(at + 1, 0, 'call_agent', 'Agent', { description: 'Clean up', prompt: 'Clean the build.' })], {
    state: { agents: { 'agent-0': helper('agent-0') } },
  });
  writeWire(root, SID, 'agent-0', [
    work(at + 100, 'Clean the build.'),
    step(at + 100, 0),
    ask(T0 - MINUTE, 'tool_rm', 'approval', { toolName: 'Bash', action: 'Run: rm -rf build', display: { kind: 'command', command: 'rm -rf build' } }, 'agent-0'),
  ]);
  const { sessions } = open(root).poll();
  assert.equal(sessions[0].needs, null);
  assert.deepEqual(sessions[1].needs, { kind: 'permission', text: 'Run: rm -rf build', at: T0 - MINUTE });
  assert.deepEqual(sessions[1].activity, { tool: 'Bash', detail: 'rm -rf build', at: T0 - MINUTE });
});

// ---- helpers and hand-offs ----

test('a helper hangs under the agent that started it, named by the call, with hand-off links', (t) => {
  const root = kimiHome(t);
  const start = T0 - 9 * MINUTE;
  const main = kimiSession(
    root,
    SID,
    [
      prompt(T0 - 10 * MINUTE, 'Look around'),
      step(T0 - 10 * MINUTE, 0),
      call(start, 0, 'call_agent', 'Agent', { description: 'Survey the code', prompt: 'You are a helper. Survey it.', subagent_type: 'explore' }),
    ],
    { state: { agents: { 'agent-0': helper('agent-0') } } },
  );
  const sub = writeWire(
    root,
    SID,
    'agent-0',
    [
      config(start + 50, { modelAlias: 'kimi-code/k3', profileName: 'explore', thinkingEffort: 'low', cwd: '/home/ada/project/sub' }),
      work(start + 100, 'You are a helper. Survey it.'),
      step(start + 200, 0),
      call(T0 - 8 * MINUTE, 0, 'tool_read', 'Read', { path: '/home/ada/project/README.md' }),
    ],
    { at: start + 100 },
  );
  const helperKey = keyOf(SID, 'agent-0');
  const { get } = open(root);
  let h = get(helperKey);
  assert.equal(h.platform, 'kimi');
  assert.equal(h.id, 'agent-0');
  assert.equal(h.parentKey, KEY);
  assert.equal(h.kind, 'agent');
  assert.equal(h.spawned, true);
  assert.equal(h.title, 'Survey the code');
  assert.equal(h.titleSource, 'description');
  assert.equal(h.status, 'working');
  assert.deepEqual(h.activity, { tool: 'Read', detail: 'README.md', at: T0 - 8 * MINUTE });
  assert.equal(h.model, 'k3');
  assert.equal(h.effort, 'low');
  assert.equal(h.startedAt, start + 100);
  assert.equal(h.cwd, '/home/ada/project/sub');
  assert.deepEqual(h.links, []);
  assert.deepEqual(get(KEY).links, [{ at: start + 100, dir: 'down', other: helperKey, label: 'Survey the code' }]);

  // The helper reports back, and its parent hears it.
  append(sub, say(T0 - 7 * MINUTE, 0, 'Found three modules.'), stepEnd(T0 - 7 * MINUTE, 0), ended(T0 - 7 * MINUTE + 5, 0));
  append(main, result(T0 - 7 * MINUTE + 10, 'call_agent', 'agent_id: agent-0\nactual_subagent_type: explore\nstatus: completed\n\nFound three modules.'));
  h = get(helperKey);
  assert.equal(h.status, 'done');
  assert.equal(h.activity, null);
  assert.deepEqual(get(KEY).links.map((l) => [l.at, l.dir, l.label]), [
    [start + 100, 'down', 'Survey the code'],
    [T0 - 7 * MINUTE, 'up', 'Found three modules.'],
  ]);

  // Given more work later, it works again: a second hand-off down.
  append(main, call(T0 - 6 * MINUTE, 0, 'call_again', 'Agent', { description: 'Check the tests', prompt: 'Now check the tests.', resume: 'agent-0' }));
  append(sub, work(T0 - 6 * MINUTE + 100, 'Now check the tests.'), step(T0 - 6 * MINUTE + 200, 1));
  h = get(helperKey);
  assert.equal(h.status, 'working');
  assert.equal(h.title, 'Survey the code');
  const downs = get(KEY).links.filter((l) => l.dir === 'down');
  assert.deepEqual(downs.map((l) => [l.at, l.label]), [[start + 100, 'Survey the code'], [T0 - 6 * MINUTE + 100, 'Check the tests']]);
});

test('helpers started together are matched to their calls in order, then by their results', (t) => {
  const root = kimiHome(t);
  const at = T0 - 5 * MINUTE;
  const main = kimiSession(
    root,
    SID,
    [
      prompt(at - MINUTE, 'go'),
      step(at - MINUTE, 0),
      call(at, 0, 'call_one', 'Agent', { description: 'First job', prompt: 'One.' }),
      call(at + 1, 0, 'call_two', 'Agent', { description: 'Second job', prompt: 'Two.' }),
    ],
    { state: { agents: { 'agent-0': helper('agent-0'), 'agent-1': helper('agent-1') } } },
  );
  writeWire(root, SID, 'agent-0', [work(at + 100, 'One.'), step(at + 100, 0)], { at: at + 100 });
  writeWire(root, SID, 'agent-1', [work(at + 150, 'Two.'), step(at + 150, 0)], { at: at + 150 });
  const { get } = open(root);
  assert.equal(get(keyOf(SID, 'agent-0')).title, 'First job');
  assert.equal(get(keyOf(SID, 'agent-1')).title, 'Second job');

  // The results name the helpers the other way round, and they have the last word.
  append(
    main,
    result(at + 2 * MINUTE, 'call_one', 'agent_id: agent-1\nactual_subagent_type: coder\nstatus: completed\n\nok'),
    result(at + 2 * MINUTE, 'call_two', 'agent_id: agent-0\nactual_subagent_type: coder\nstatus: completed\n\nok'),
  );
  const zero = get(keyOf(SID, 'agent-0'));
  assert.equal(zero.title, 'Second job');
  assert.equal(get(keyOf(SID, 'agent-1')).title, 'First job');
  // The parent heard back after each began, so both are done although their own logs look open.
  assert.equal(zero.status, 'done');
  assert.equal(get(keyOf(SID, 'agent-1')).status, 'done');
});

test('a background helper is named by its task, keeps its parent working, and is done when its task ends', (t) => {
  const root = kimiHome(t);
  const at = T0 - 5 * MINUTE;
  const main = kimiSession(
    root,
    SID,
    [
      prompt(at - MINUTE, 'go'),
      step(at - MINUTE, 0),
      call(at, 0, 'call_bg', 'Agent', { description: 'Run the slow checks', prompt: 'Check everything.', run_in_background: true }),
      task(at + 50, 'task.started', { agentId: 'agent-3', description: 'Run the slow checks' }),
      result(at + 60, 'call_bg', 'task_id: task_one\nstatus: running\nagent_id: agent-3\nactual_subagent_type: coder\nautomatic_notification: true'),
      say(at + 70, 0, 'Started the checks.'),
      stepEnd(at + 70, 0),
      ended(at + 80, 0),
    ],
    { state: { agents: { 'agent-3': helper('agent-3') } } },
  );
  const sub = writeWire(
    root,
    SID,
    'agent-3',
    [work(at + 40, 'Check everything.'), step(at + 40, 0), call(T0 - MINUTE, 0, 'tool_test', 'Bash', { command: 'npm test' })],
    { at: at + 40 },
  );
  const helperKey = keyOf(SID, 'agent-3');
  const { get } = open(root);
  let h = get(helperKey);
  let m = get(KEY);
  assert.equal(h.title, 'Run the slow checks');
  assert.equal(h.status, 'working');
  assert.equal(m.status, 'working', 'its helper still works');
  assert.equal(m.activity, null);

  append(sub, say(T0 - 30 * SECOND, 0, 'All checks pass.'), stepEnd(T0 - 30 * SECOND, 0), ended(T0 - 30 * SECOND, 0));
  append(main, task(T0 - 20 * SECOND, 'task.terminated', { agentId: 'agent-3', description: 'Run the slow checks' }));
  h = get(helperKey);
  m = get(KEY);
  assert.equal(h.status, 'done');
  assert.equal(m.status, 'ready');
  assert.deepEqual(m.links.map((l) => [l.dir, l.other, l.label]), [
    ['down', helperKey, 'Run the slow checks'],
    ['up', helperKey, 'All checks pass.'],
  ]);
});

test('swarm helpers are named by their own item with snippets, by the swarm call without', (t) => {
  const root = kimiHome(t);
  const at = T0 - 5 * MINUTE;
  const item = (text) => helper('x', { labels: { parentAgentId: 'main', swarmItem: text } });
  const main = kimiSession(
    root,
    SID,
    [
      prompt(at - MINUTE, 'go'),
      step(at - MINUTE, 0),
      call(at, 0, 'call_swarm', 'AgentSwarm', { description: 'Review the modules', prompt_template: 'Review {item}', items: ['module A', 'module B'] }),
    ],
    { state: { agents: { 'agent-0': item('\n Review module A\nwith care'), 'agent-1': item('Review module B') } } },
  );
  writeWire(root, SID, 'agent-0', [work(at + 100, 'Review module A'), step(at + 100, 0)], { at: at + 100 });
  writeWire(root, SID, 'agent-1', [work(at + 120, 'Review module B'), step(at + 120, 0)], { at: at + 120 });

  const helpers = (sessions) => sessions.filter((s) => s.kind === 'agent');
  const named = (sessions) => helpers(sessions).map((s) => [s.title, s.titleSource]);
  assert.deepEqual(named(open(root, { content: 'none' }).poll().sessions), [
    ['Review the modules', 'description'],
    ['Review the modules', 'description'],
  ]);
  const { poll } = open(root);
  assert.deepEqual(named(poll().sessions), [
    ['Review module A', 'swarm-item'],
    ['Review module B', 'swarm-item'],
  ]);

  const swarmResult = [
    '<agent_swarm_result>',
    '<summary>2 of 2 done</summary>',
    '<subagent agent_id="agent-0" item="Review module A">fine</subagent>',
    '<subagent agent_id="agent-1" item="Review module B">fine</subagent>',
    '</agent_swarm_result>',
  ].join('\n');
  append(main, result(at + MINUTE, 'call_swarm', swarmResult));
  assert.deepEqual(helpers(poll().sessions).map((s) => s.status), ['done', 'done']);
});

test('a helper started by another helper hangs under it', (t) => {
  const root = kimiHome(t);
  const at = T0 - 5 * MINUTE;
  const nested = helper('agent-1', { parentAgentId: 'agent-0', labels: { parentAgentId: 'agent-0' } });
  kimiSession(root, SID, [prompt(at - MINUTE, 'go'), step(at - MINUTE, 0), call(at, 0, 'call_a', 'Agent', { description: 'Lead the review', prompt: 'Lead.' })], {
    state: { agents: { 'agent-0': helper('agent-0'), 'agent-1': nested } },
  });
  writeWire(root, SID, 'agent-0', [work(at + 100, 'Lead.'), step(at + 100, 0), call(at + MINUTE, 0, 'call_b', 'Agent', { description: 'Check one file', prompt: 'Check.' })], {
    at: at + 100,
  });
  writeWire(root, SID, 'agent-1', [work(at + MINUTE + 100, 'Check.'), step(at + MINUTE + 100, 0)], { at: at + MINUTE + 100 });
  const byKey = Object.fromEntries(open(root).poll().sessions.map((s) => [s.key, s]));
  const inner = byKey[keyOf(SID, 'agent-1')];
  assert.equal(inner.parentKey, keyOf(SID, 'agent-0'));
  assert.equal(inner.title, 'Check one file');
  assert.equal(byKey[keyOf(SID, 'agent-0')].title, 'Lead the review');
  assert.deepEqual(byKey[keyOf(SID, 'agent-0')].links.map((l) => [l.dir, l.other]), [['down', keyOf(SID, 'agent-1')]]);
  assert.deepEqual(byKey[KEY].links.map((l) => [l.dir, l.other]), [['down', keyOf(SID, 'agent-0')]]);
});

// ---- big logs ----

test('a turn that began before the part of a big log that is read still counts as open', (t) => {
  const root = kimiHome(t);
  kimiSession(
    root,
    SID,
    [
      request(T0 - 3 * MINUTE, 'kimi-early', 'low'),
      prompt(T0 - 3 * MINUTE, 'go'),
      step(T0 - 3 * MINUTE, 0),
      call(T0 - 3 * MINUTE, 0, 'call_agent', 'Agent', { description: 'Survey the code', prompt: 'Survey.' }),
      call(T0 - 2 * MINUTE, 0, 'tool_cat', 'Bash', { command: 'cat big.log' }),
      result(T0 - 2 * MINUTE, 'tool_cat', 'y'.repeat(5 * MiB)),
      call(T0 - MINUTE, 0, 'tool_test', 'Bash', { command: 'npm test' }),
    ],
    { at: T0 - 4 * MINUTE, state: { agents: { 'agent-0': helper('agent-0') } } },
  );
  writeWire(root, SID, 'agent-0', [work(T0 - 3 * MINUTE + 100, 'Survey.'), step(T0 - 3 * MINUTE + 100, 0)], { at: T0 - 3 * MINUTE + 100 });
  const byKey = Object.fromEntries(open(root).poll().sessions.map((s) => [s.key, s]));
  const s = byKey[KEY];
  assert.equal(s.status, 'working');
  assert.deepEqual(s.activity, { tool: 'Bash', detail: 'npm test', at: T0 - MINUTE });
  // These lie before the part that was read, and are found all the same.
  assert.equal(s.model, 'kimi-early');
  assert.equal(s.effort, 'low');
  assert.equal(s.startedAt, T0 - 4 * MINUTE);
  assert.equal(byKey[keyOf(SID, 'agent-0')].title, 'Survey the code');
});

test('after a long pause, a log that grew a lot is read again from near its end', (t) => {
  const root = kimiHome(t);
  const start = T0 - 20 * MINUTE;
  const file = kimiSession(
    root,
    SID,
    [request(start, 'k3', 'max'), prompt(start, 'go'), step(start, 0), call(start + 1, 0, 'call_agent', 'Agent', { description: 'Survey the code', prompt: 'Survey.' })],
    { at: start, state: { agents: { 'agent-0': helper('agent-0') } } },
  );
  writeWire(root, SID, 'agent-0', [work(start + 100, 'Survey.'), step(start + 100, 0), say(start + 200, 0, 'Done looking.'), stepEnd(start + 200, 0), ended(start + 300, 0)], {
    at: start + 100,
  });
  const { get } = open(root);
  assert.equal(get(KEY).links.length, 2);

  // While nobody polls, about 20 MiB arrive.
  for (let n = 0; n < 20; n++) append(file, result(T0 - 10 * MINUTE, `filler_${n}`, 'y'.repeat(MiB)));
  append(file, ended(T0 - 5 * MINUTE, 0), prompt(T0 - MINUTE, 'next'), step(T0 - MINUTE, 1), call(T0 - MINUTE, 1, 'tool_test', 'Bash', { command: 'npm test' }));
  const s = get(KEY);
  assert.equal(s.status, 'working');
  assert.deepEqual(s.activity, { tool: 'Bash', detail: 'npm test', at: T0 - MINUTE });
  assert.equal(s.model, 'k3');
  assert.equal(s.startedAt, start);
  assert.deepEqual(s.links.map((l) => [l.dir, l.label]), [['down', 'Survey the code'], ['up', 'Done looking.']]);
});

// ---- the drawer and privacy ----

test('detail returns recent events and a cursor for the next poll', (t) => {
  const root = kimiHome(t);
  const at = T0 - 10 * MINUTE;
  const file = kimiSession(root, SID, [
    prompt(at, 'Please list the files'),
    step(at, 0),
    think(at + 1, 0, 'secret thoughts'),
    say(at + 2, 0, 'Listing now.'),
    call(at + 3, 0, 'tool_ls', 'Bash', { command: 'ls -la' }),
    result(at + 4, 'tool_ls', 'a.txt\nb.txt'),
    call(at + 5, 0, 'tool_read', 'Read', { path: '/home/ada/project/missing.txt' }),
    result(at + 6, 'tool_read', [{ type: 'text', text: 'No such file' }], { isError: true }),
    stepEnd(at + 7, 0, 'tool_use'),
    ended(at + 8, 0, 'failed', { error: { code: 'provider.auth_error', message: 'The key was refused', name: 'APIStatusError' } }),
    prompt(at + 9, 'Keep going on the goal', { kind: 'system_trigger', name: 'goal_continuation' }),
    { type: 'turn.steer', input: [{ type: 'text', text: 'Also check the docs' }], origin: { kind: 'user' }, time: at + 10 },
    step(at + 10, 1),
    cancel(at + 11, 1),
    ended(at + 12, 1, 'cancelled'),
  ]);
  const { source, poll } = open(root);
  poll();
  const first = source.detail(KEY);
  assert.deepEqual(first.events.map((e) => [e.at, e.kind, e.tool, e.text]), [
    [at, 'user', null, 'Please list the files'],
    [at + 1, 'thinking', null, null],
    [at + 2, 'assistant', null, 'Listing now.'],
    [at + 3, 'tool', 'Bash', 'ls -la'],
    [at + 4, 'result', 'Bash', 'a.txt\nb.txt'],
    [at + 5, 'tool', 'Read', 'missing.txt'],
    [at + 6, 'error', 'Read', 'No such file'],
    [at + 8, 'error', null, 'The key was refused'],
    [at + 10, 'user', null, 'Also check the docs'],
    [at + 12, 'error', null, 'Stopped'],
  ]);
  assert.equal(first.next, fs.statSync(file).size);
  assert.equal(JSON.stringify(first).includes('secret thoughts'), false);

  append(file, prompt(T0 - MINUTE, 'One more thing'));
  const second = source.detail(KEY, first.next);
  assert.deepEqual(second.events.map((e) => e.text), ['One more thing']);
  assert.equal(second.next, fs.statSync(file).size);
  assert.deepEqual(source.detail(KEY, String(second.next)).events, []);

  const empty = { events: [], next: null };
  assert.deepEqual(source.detail('kimi:0199c000-0000-7000-8000-0000000000ff'), empty);
  assert.deepEqual(source.detail(`${KEY}/main`), empty);
  assert.deepEqual(source.detail(`${KEY}/agent-9`), empty);
  assert.deepEqual(source.detail(`codex:${SID}`), empty);
  assert.deepEqual(source.detail(null), empty);
});

test('detail shows a helper its own work and keeps only the newest 200 events', (t) => {
  const root = kimiHome(t);
  kimiSession(root, SID, turn(T0 - 10 * MINUTE, 0), { state: { agents: { 'agent-0': helper('agent-0') } } });
  const records = [work(T0 - 9 * MINUTE, 'Survey the code base.'), step(T0 - 9 * MINUTE, 0)];
  for (let n = 0; n < 300; n++) records.push(say(T0 - 8 * MINUTE + n, 0, `Line ${n}`, n + 2));
  writeWire(root, SID, 'agent-0', records);
  const { source, poll } = open(root);
  poll();
  const events = source.detail(keyOf(SID, 'agent-0')).events;
  assert.equal(events.length, 200);
  assert.equal(events[0].text, 'Line 100');
  assert.equal(events.at(-1).text, 'Line 299');

  const short = [work(T0 - 9 * MINUTE, 'Survey the code base.'), step(T0 - 9 * MINUTE, 0), say(T0 - 8 * MINUTE, 0, 'Looking.')];
  writeWire(root, SID, 'agent-0', short);
  assert.deepEqual(source.detail(keyOf(SID, 'agent-0')).events.map((e) => [e.kind, e.text]), [
    ['user', 'Survey the code base.'],
    ['assistant', 'Looking.'],
  ]);
});

test('whole messages and agent.turn.ended are read as well', (t) => {
  const root = kimiHome(t);
  const message = (ms, value, source) => ({ type: 'agent.message.appended', message: { message: value, meta: { source } }, kind: 'event', time: ms });
  kimiSession(root, SID, [
    message(T0 - 6 * MINUTE, { role: 'user', content: [{ type: 'text', text: 'Earlier question' }], toolCalls: [] }, 'input'),
    message(
      T0 - 6 * MINUTE,
      {
        role: 'assistant',
        content: [{ type: 'think', think: 'hmm', reasoningKey: 'r' }, { type: 'text', text: 'Earlier answer.' }],
        toolCalls: [{ type: 'function', id: 'tool_old', name: 'Bash', arguments: '{"command":"ls -la"}' }],
      },
      'llm',
    ),
    message(T0 - 6 * MINUTE, { role: 'tool', content: [{ type: 'text', text: 'a.txt' }], toolCallId: 'tool_old' }, 'tool'),
    { type: 'agent.turn.started', turnId: 3, kind: 'event', time: T0 - 4 * MINUTE },
    prompt(T0 - 4 * MINUTE, 'Now this'),
    step(T0 - 4 * MINUTE, 0),
    { type: 'agent.turn.ended', turnId: 3, outcome: 'failed', errorMessage: 'Rate limited', kind: 'event', time: T0 - 3 * MINUTE },
    ended(T0 - 3 * MINUTE, 0, 'failed', { error: { message: 'Rate limited' } }),
  ]);
  const { get, source } = open(root);
  const s = get(KEY);
  assert.equal(s.status, 'error');
  assert.equal(s.lastText, 'Earlier answer.');
  assert.equal(s.activity, null);
  assert.deepEqual(source.detail(KEY).events.map((e) => [e.kind, e.tool, e.text]), [
    ['thinking', null, null],
    ['assistant', null, 'Earlier answer.'],
    ['tool', 'Bash', 'ls -la'],
    ['result', 'Bash', 'a.txt'],
    ['user', null, 'Now this'],
    ['error', null, 'Rate limited'],
  ]);
});

test('content "none" shows no session text anywhere', (t) => {
  const root = kimiHome(t);
  const at = T0 - 5 * MINUTE;
  kimiSession(
    root,
    SID,
    [
      prompt(at, 'A private prompt'),
      step(at, 0),
      think(at, 0, 'private thoughts'),
      say(at, 0, 'A private answer'),
      call(at + 1, 0, 'call_agent', 'Agent', { description: 'Helper task', prompt: 'Private instructions' }),
      call(at + 2, 0, 'tool_cat', 'Bash', { command: 'cat secret.txt', description: 'Read the secret' }),
      ask(at + 3, 'tool_cat', 'approval', { toolName: 'Bash', action: 'Run: cat secret.txt', display: { kind: 'command', command: 'cat secret.txt' } }),
    ],
    { state: { title: 'A private first prompt', lastPrompt: 'A private prompt', agents: { 'agent-0': helper('agent-0') } } },
  );
  writeWire(
    root,
    SID,
    'agent-0',
    [
      work(at + 50, 'Private instructions'),
      step(at + 50, 0),
      say(at + 60, 0, 'Private report'),
      stepEnd(at + 60, 0, 'tool_use'),
      ended(at + 70, 0, 'failed', { error: { message: 'Private failure' } }),
    ],
    { at: at + 50 },
  );
  const { poll, source } = open(root, { content: 'none' });
  const res = poll();
  const main = res.sessions.find((s) => s.key === KEY);
  assert.equal(main.title, null);
  assert.equal(main.lastText, null);
  assert.deepEqual(main.activity, { tool: 'Bash', detail: null, at: at + 2 });
  assert.deepEqual(main.needs, { kind: 'permission', text: null, at: at + 3 });
  assert.equal(main.links.length, 2);
  assert.ok(main.links.every((l) => l.label === null));
  const events = [...source.detail(KEY).events, ...source.detail(keyOf(SID, 'agent-0')).events];
  assert.equal(events.length, 8);
  assert.ok(events.every((e) => e.text === null));
  const shown = JSON.stringify([res, events]);
  for (const secret of ['private prompt', 'private thoughts', 'private answer', 'Private instructions', 'Private report', 'Private failure', 'secret', 'private first prompt', 'private-notes']) {
    assert.equal(shown.includes(secret), false, secret);
  }
});

test('a second session in another working folder is kept apart', (t) => {
  const root = kimiHome(t);
  kimiSession(root, SID, turn(T0 - 5 * MINUTE, 0, 'First.'));
  kimiSession(root, SID2, turn(T0 - 4 * MINUTE, 0, 'Second.'), { folder: 'wd_other_0123456789ab' });
  const { sessions } = open(root).poll();
  assert.deepEqual(sessions.map((s) => [s.key, s.lastText]), [[KEY, 'First.'], [keyOf(SID2), 'Second.']]);
});
