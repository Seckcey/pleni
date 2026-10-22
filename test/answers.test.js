import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ANSWER_MESSAGES,
  HOOK_HEADER,
  MAX_ASKS,
  NO_DECISION,
  askKey,
  askView,
  createAsks,
  createHookSaver,
  hookAnswer,
  hookKeyFile,
  hookKeyMatches,
  isPleniHook,
  loadOrCreateHookKey,
  pleniEntries,
  readHookSetup,
  withPleniHooks,
} from '../src/answers.js';

const ID = '0f8e2c4a-1b3d-4e5f-8a9b-0c1d2e3f4a5b';
const SECRET = 'hook-secret-0123456789abcdefghijklmnopqrstuv';

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pleni-answers-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const question = (patch = {}) => ({
  session_id: ID,
  hook_event_name: 'PreToolUse',
  tool_name: 'AskUserQuestion',
  tool_input: {
    questions: [
      { question: 'Which test runner should I use?', header: 'Tests', multiSelect: false, options: [{ label: 'node:test', description: 'Built in' }, { label: 'Other runner', description: 'Needs a package' }] },
      { question: 'Which parts should I check?', header: 'Parts', multiSelect: true, options: [{ label: 'Server' }, { label: 'Page' }] },
    ],
  },
  ...patch,
});
// Claude Code puts the plan from its plan file into the input of the permission prompt.
const plan = { session_id: ID, hook_event_name: 'PermissionRequest', tool_name: 'ExitPlanMode', tool_input: { plan: '# Plan\n\n1. Read the code.\n2. Fix the bug.', planFilePath: 'C:\\Users\\ada\\.claude\\plans\\fix-the-bug.md' } };
const permission = { session_id: ID, hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'npm test', description: 'Run the tests' } };

test('the secret is made once, kept next to the settings, and compared in constant time', (t) => {
  const dir = tempDir(t);
  const file = hookKeyFile(path.join(dir, 'settings.json'));
  assert.equal(file, path.join(dir, 'hook-key'));
  const first = loadOrCreateHookKey(file);
  assert.match(first, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(loadOrCreateHookKey(file), first);
  fs.writeFileSync(file, 'short\n');
  const next = loadOrCreateHookKey(file);
  assert.notEqual(next, first);
  assert.equal(hookKeyMatches(next, next), true);
  assert.equal(hookKeyMatches(`${next}x`, next), false);
  assert.equal(hookKeyMatches(undefined, next), false);
  assert.equal(hookKeyMatches('', ''), false);
});

test('a call is shown as a question, a plan or a prompt, and nothing else is held', () => {
  assert.deepEqual(askView(question()), {
    kind: 'question',
    questions: [
      { index: 0, question: 'Which test runner should I use?', header: 'Tests', multiSelect: false, options: [{ label: 'node:test', description: 'Built in' }, { label: 'Other runner', description: 'Needs a package' }] },
      { index: 1, question: 'Which parts should I check?', header: 'Parts', multiSelect: true, options: [{ label: 'Server', description: null }, { label: 'Page', description: null }] },
    ],
  });
  assert.deepEqual(askView(plan), { kind: 'plan', plan: '# Plan\n\n1. Read the code.\n2. Fix the bug.' });
  assert.deepEqual(askView(permission), { kind: 'permission', tool: 'Bash', detail: 'npm test' });
  assert.deepEqual(askView({ ...permission, tool_name: 'Write', tool_input: { file_path: 'C:\\Users\\ada\\project\\notes.md', content: 'x' } }).detail, 'C:\\Users\\ada\\project\\notes.md');
  assert.equal(askView({ ...plan, tool_input: {} }), null);
  // A plan comes through the permission prompt only, and a question through PreToolUse only: when
  // the person gives a question back, Claude Code asks again with a permission prompt, and Pleni
  // must not hold it twice.
  assert.equal(askView({ ...plan, hook_event_name: 'PreToolUse' }), null);
  assert.equal(askView({ ...question(), hook_event_name: 'PermissionRequest' }), null);
  assert.equal(askView(question({ tool_input: { questions: [] } })), null);
  assert.equal(askView({ ...question(), tool_name: 'Bash' }), null);
  assert.equal(askView({ ...permission, hook_event_name: 'PostToolUse' }), null);
  assert.equal(askView(null), null);
  assert.equal(askKey(question()), `claude:${ID}`);
  assert.equal(askKey({ session_id: ID.toUpperCase() }), `claude:${ID}`);
  assert.equal(askKey({ session_id: 'not-an-id' }), null);
  const long = askView(question({ tool_input: { questions: [{ question: 'x'.repeat(900), options: [{ label: 'Yes' }] }] } }));
  assert.equal(long.questions[0].question.length, 500);
});

test('answers become the hook\'s answer in the shape Claude Code reads', () => {
  const input = question();
  const view = askView(input);
  assert.deepEqual(hookAnswer(input, view, { answers: ['node:test', 'Server, Page'] }), {
    body: {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        updatedInput: { ...input.tool_input, answers: { 'Which test runner should I use?': 'node:test', 'Which parts should I check?': 'Server, Page' } },
      },
    },
  });
  assert.equal(hookAnswer(input, view, { answers: ['node:test'] }).error, ANSWER_MESSAGES.badAnswer);
  assert.equal(hookAnswer(input, view, { answers: ['node:test', '  '] }).error, ANSWER_MESSAGES.noAnswer);
  assert.equal(hookAnswer(input, view, { answers: ['node:test', 'x'.repeat(2001)] }).error, ANSWER_MESSAGES.longAnswer);
  // A long question is shown cut short, but answered by its own full words.
  const longInput = question({ tool_input: { questions: [{ question: `${'Why '.repeat(200)}?`, options: [{ label: 'Because' }] }] } });
  const longAnswer = hookAnswer(longInput, askView(longInput), { answers: ['Because'] });
  assert.deepEqual(Object.keys(longAnswer.body.hookSpecificOutput.updatedInput.answers), [`${'Why '.repeat(200)}?`]);
  const planView = askView(plan);
  // Claude Code approves a plan only when the answer hands back the plan it was given.
  assert.deepEqual(hookAnswer(plan, planView, { approve: true }), {
    body: { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow', updatedInput: plan.tool_input } } },
  });
  assert.deepEqual(hookAnswer(plan, planView, { approve: false, feedback: 'Add a test first.' }), {
    body: { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: 'Add a test first.' } } },
  });
  assert.match(hookAnswer(plan, planView, { approve: false }).body.hookSpecificOutput.decision.message, /Keep planning/);
  assert.equal(hookAnswer(plan, planView, { approve: 'yes' }).error, ANSWER_MESSAGES.badAnswer);
  const promptView = askView(permission);
  assert.deepEqual(hookAnswer(permission, promptView, { allow: true }), { body: { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } } });
  assert.deepEqual(hookAnswer(permission, promptView, { allow: false, reason: 'Not on main.' }), {
    body: { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: 'Not on main.' } } },
  });
  assert.equal(hookAnswer(permission, promptView, { allow: 'yes' }).error, ANSWER_MESSAGES.badAnswer);
  assert.equal(hookAnswer(permission, promptView, null).error, ANSWER_MESSAGES.badAnswer);
});

test('a held question waits for the person, and is given back when time runs out', async () => {
  const timers = [];
  let changes = 0;
  const asks = createAsks({
    now: () => 1000,
    onChange: () => changes++,
    setTimer: (fn, ms) => {
      const timer = { fn, ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      if (timer) timer.cleared = true;
    },
  });
  const input = question();
  const held = asks.hold({ key: `claude:${ID}`, input, view: askView(input), waitMs: 600_000 });
  assert.match(held.id, /^[0-9a-f]{24}$/);
  assert.equal(timers[0].ms, 600_000);
  assert.deepEqual(asks.list().map((a) => [a.id, a.key, a.kind, a.at, a.until]), [[held.id, `claude:${ID}`, 'question', 1000, 601_000]]);
  assert.equal(asks.answer(held.id, { answers: ['node:test'] }).error, ANSWER_MESSAGES.badAnswer);
  assert.deepEqual(asks.answer(held.id, { answers: ['node:test', 'Server'] }), { ok: true });
  const body = await held.answer;
  assert.equal(body.hookSpecificOutput.permissionDecision, 'allow');
  assert.equal(timers[0].cleared, true);
  assert.deepEqual(asks.list(), []);
  assert.deepEqual(asks.answer(held.id, { answers: ['node:test', 'Server'] }), { ok: false, status: 404, error: ANSWER_MESSAGES.gone });
  // Time runs out: no decision, so the session asks in its own window.
  const late = asks.hold({ key: `claude:${ID}`, input: plan, view: askView(plan), waitMs: 1000 });
  timers.at(-1).fn();
  assert.equal(await late.answer, NO_DECISION);
  // The person gives it back, and Pleni stopping gives back the rest.
  const back = asks.hold({ key: `claude:${ID}`, input: permission, view: askView(permission), waitMs: 1000 });
  assert.deepEqual(asks.release(back.id), { ok: true });
  assert.equal(await back.answer, NO_DECISION);
  const last = asks.hold({ key: `claude:${ID}`, input: permission, view: askView(permission), waitMs: 1000 });
  asks.close();
  assert.equal(await last.answer, NO_DECISION);
  assert.equal(asks.release('nope').status, 400);
  assert.ok(changes >= 6);
});

test('a plan or prompt answered in the session\'s own window is let go', async () => {
  let now = 1_700_000_000_000;
  const asks = createAsks({ now: () => now, setTimer: () => null, clearTimer: () => {} });
  const key = `claude:${ID}`;
  const node = (activity) => [{ key: 'you', kind: 'person' }, { key, kind: 'session', activity }];
  const prompt = asks.hold({ key, input: permission, view: askView(permission), waitMs: 600_000 });
  let promptAnswer = null;
  prompt.answer.then((body) => (promptAnswer = body));
  // Pleni has not read the call from the session's log yet: an older Bash call is not this one.
  asks.settle(node({ tool: 'Bash', detail: null, at: now - 90_000 }));
  asks.settle(node(null));
  assert.equal(asks.size(), 1);
  // The log shows the call waiting, then a snapshot where it is gone: the person answered there.
  asks.settle(node({ tool: 'Bash', detail: 'Run the tests', at: now - 400 }));
  asks.settle(node({ tool: 'Bash', detail: 'Run the tests', at: now - 400 }));
  assert.equal(asks.size(), 1, 'still waiting while the call is open');
  asks.settle(node({ tool: 'Read', detail: 'notes.md', at: now + 3000 }));
  assert.equal(asks.size(), 0);
  await Promise.resolve();
  assert.equal(promptAnswer, NO_DECISION);
  // A newer call of the same tool is not the held one either.
  now += 60_000;
  const second = asks.hold({ key, input: plan, view: askView(plan), waitMs: 600_000 });
  asks.settle(node({ tool: 'ExitPlanMode', detail: null, at: now - 200 }));
  asks.settle(node({ tool: 'ExitPlanMode', detail: null, at: now + 9000 }));
  assert.equal(await second.answer, NO_DECISION);
  // A session Pleni had not read before the person answered: its log already went on past the call.
  now += 60_000;
  const quick = asks.hold({ key, input: permission, view: askView(permission), waitMs: 600_000 });
  asks.settle([{ key, kind: 'session', activity: { tool: 'Read', detail: null, at: now - 200 }, lastAt: now - 200 }]);
  asks.settle([{ key, kind: 'session', activity: null, lastAt: now + 500 }]);
  assert.equal(asks.size(), 1, 'a line written as the call began is not an answer');
  asks.settle([{ key, kind: 'session', activity: null, lastAt: now + 4000 }]);
  assert.equal(await quick.answer, NO_DECISION);
  // While the call waits, newer lines from the session do not let it go.
  now += 60_000;
  const busy = asks.hold({ key, input: permission, view: askView(permission), waitMs: 600_000 });
  asks.settle([{ key, kind: 'session', activity: { tool: 'Bash', detail: null, at: now - 100 }, lastAt: now + 5000 }]);
  assert.equal(asks.size(), 1);
  assert.equal(asks.release(busy.id).ok, true);
  // Another session's calls, or a session not on the map, change nothing.
  const third = asks.hold({ key, input: permission, view: askView(permission), waitMs: 600_000 });
  asks.settle(node({ tool: 'Bash', detail: null, at: now }));
  asks.settle([{ key: 'claude:1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d', kind: 'session', activity: null }]);
  asks.settle(null);
  assert.equal(asks.size(), 1);
  assert.equal(asks.release(third.id).ok, true);
});

test('only a few questions are held at once', async () => {
  const asks = createAsks({ setTimer: () => null, clearTimer: () => {} });
  for (let i = 0; i < MAX_ASKS; i++) assert.ok(asks.hold({ key: `claude:${ID}`, input: permission, view: askView(permission), waitMs: 1000 }).id);
  const extra = asks.hold({ key: `claude:${ID}`, input: permission, view: askView(permission), waitMs: 1000 });
  assert.equal(extra.id, null);
  assert.equal(await extra.answer, NO_DECISION);
  asks.close();
});

test('Pleni\'s hooks are told apart from the person\'s own', () => {
  const entries = pleniEntries(8790, SECRET);
  // Questions come before the tool runs; plans and every other "may I?" through the permission prompt.
  assert.deepEqual([entries.PreToolUse[0].matcher, entries.PermissionRequest[0].matcher], ['AskUserQuestion', '*']);
  const [mine] = entries.PreToolUse[0].hooks;
  assert.deepEqual(mine, { type: 'http', url: 'http://127.0.0.1:8790/api/hook', timeout: 3900, headers: { [HOOK_HEADER]: SECRET } });
  assert.equal(isPleniHook(mine), true);
  assert.equal(isPleniHook({ ...mine, url: 'http://127.0.0.1:9100/api/hook' }), true);
  assert.equal(isPleniHook({ ...mine, url: 'http://example.com:8790/api/hook' }), false);
  assert.equal(isPleniHook({ ...mine, headers: {} }), false);
  assert.equal(isPleniHook({ type: 'command', command: 'echo hi' }), false);
  const own = { matcher: 'Bash', hooks: [{ type: 'command', command: 'check.ps1' }] };
  const settings = { model: 'opus', hooks: { PreToolUse: [own], Stop: [{ hooks: [{ type: 'command', command: 'done.ps1' }] }] } };
  const connected = withPleniHooks(settings, pleniEntries(8790, SECRET));
  assert.deepEqual(connected.hooks.PreToolUse[0], own);
  assert.equal(connected.hooks.PreToolUse.length, 2);
  assert.equal(connected.hooks.PermissionRequest.length, 1);
  assert.deepEqual(connected.hooks.Stop, settings.hooks.Stop);
  // Connecting twice, or on another port, leaves one set of Pleni hooks.
  const again = withPleniHooks(connected, pleniEntries(9100, SECRET));
  assert.equal(again.hooks.PreToolUse.length, 2);
  assert.equal(again.hooks.PreToolUse[1].hooks[0].url, 'http://127.0.0.1:9100/api/hook');
  // Disconnecting leaves the person's own hooks exactly as they were.
  assert.deepEqual(withPleniHooks(again, null), settings);
  assert.deepEqual(withPleniHooks({ model: 'opus' }, null), { model: 'opus' });
  // A Pleni hook that shares an entry with the person's own is taken out on its own.
  const shared = { hooks: { PermissionRequest: [{ matcher: '*', hooks: [{ type: 'command', command: 'log.ps1' }, mine] }] } };
  assert.deepEqual(withPleniHooks(shared, null), { hooks: { PermissionRequest: [{ matcher: '*', hooks: [{ type: 'command', command: 'log.ps1' }] }] } });
  assert.equal(withPleniHooks({ hooks: 'none' }, null), null);
  assert.equal(withPleniHooks({ hooks: { PreToolUse: {} } }, null), null);
});

test('Connect and Disconnect change only Pleni\'s hooks, after a copy of the file', (t) => {
  const root = tempDir(t);
  const backupDir = path.join(tempDir(t), 'backups');
  const file = path.join(root, 'settings.json');
  const before = '{\r\n    "model": "opus",\r\n    "hooks": {\r\n        "Stop": [{ "hooks": [{ "type": "command", "command": "done.ps1" }] }]\r\n    }\r\n}\r\n';
  fs.writeFileSync(file, before);
  let now = 1_700_000_000_000;
  const saver = createHookSaver({ now: () => now });
  assert.equal(readHookSetup({ root, port: 8790, secret: SECRET }).connected, false);
  const done = saver.connect({ root, backupDir, port: 8790, secret: SECRET });
  assert.equal(done.ok, true, done.error);
  assert.match(path.basename(done.backup), /^claude-settings-\d{8}-\d{6}\.json$/);
  assert.equal(fs.readFileSync(done.backup, 'utf8'), before);
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(text.startsWith('{\r\n    "model": "opus"'), 'the old indent and line breaks are kept');
  const saved = JSON.parse(text);
  assert.equal(saved.model, 'opus');
  assert.deepEqual(saved.hooks.Stop, [{ hooks: [{ type: 'command', command: 'done.ps1' }] }]);
  const setup = readHookSetup({ root, port: 8790, secret: SECRET });
  assert.equal(setup.connected, true);
  assert.equal(setup.stale, false);
  assert.ok(!setup.lines.includes(SECRET), 'the lines shown never hold the secret');
  // Another port, or another secret, is connected the old way: Connect again fixes it.
  assert.equal(readHookSetup({ root, port: 9100, secret: SECRET }).stale, true);
  assert.equal(readHookSetup({ root, port: 8790, secret: `${SECRET}x` }).stale, true);
  now += 1000;
  assert.equal(saver.disconnect({ root, backupDir }).ok, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), JSON.parse(before));
  assert.equal(readHookSetup({ root, port: 8790, secret: SECRET }).stale, false);
  // No settings file yet: Connect makes one with only the hooks.
  const fresh = tempDir(t);
  assert.equal(saver.connect({ root: fresh, backupDir, port: 8790, secret: SECRET }).ok, true);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(fresh, 'settings.json'), 'utf8'))), ['hooks']);
  // A file Pleni cannot read safely is left alone.
  fs.writeFileSync(path.join(fresh, 'settings.json'), '{ "hooks": { "PreToolUse": "odd" } }');
  assert.equal(saver.connect({ root: fresh, backupDir, port: 8790, secret: SECRET }).error, ANSWER_MESSAGES.notSimple);
  fs.writeFileSync(path.join(fresh, 'settings.json'), '[1, 2]');
  assert.equal(saver.connect({ root: fresh, backupDir, port: 8790, secret: SECRET }).error, ANSWER_MESSAGES.notObject);
  assert.equal(saver.connect({ root: null, backupDir, port: 8790, secret: SECRET }).error, ANSWER_MESSAGES.noRoot);
});
