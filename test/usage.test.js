import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cleanSettings } from '../src/config.js';
import { demoUsage } from '../src/demo.js';
import { createUsage, lastDays } from '../src/usage.js';

// Every time here is a local time, so the tests give the same answer in any time zone.
const NOW = new Date(2026, 5, 10, 15, 0, 0).getTime();
const at = (day, hour = 12, minute = 0) => new Date(2026, 5, day, hour, minute, 0).getTime();
const iso = (...args) => new Date(at(...args)).toISOString();
const DAYS = ['2026-06-04', '2026-06-05', '2026-06-06', '2026-06-07', '2026-06-08', '2026-06-09', '2026-06-10'];

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pleni-usage-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function put(file, lines, { mtime = NOW, append = false } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = (Array.isArray(lines) ? lines : [lines]).map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n';
  if (append) fs.appendFileSync(file, body);
  else fs.writeFileSync(file, body);
  fs.utimesSync(file, new Date(mtime), new Date(mtime));
}

// A usage that reads made-up folders. `clock.now` can be moved by a test.
function setup(t, { settings = {}, ...options } = {}) {
  const dir = tempDir(t);
  const roots = {
    claude: path.join(dir, 'claude'),
    claudeDesktop: path.join(dir, 'desktop'),
    codex: path.join(dir, 'codex'),
    grok: path.join(dir, 'grok'),
    kimi: path.join(dir, 'kimi'),
    gemini: path.join(dir, 'gemini'),
  };
  for (const root of Object.values(roots)) fs.mkdirSync(root, { recursive: true });
  const clock = { now: NOW };
  const clean = cleanSettings(settings);
  const usage = createUsage({ getRoots: () => roots, getSettings: () => clean, now: () => clock.now, ...options });
  return { dir, roots, clock, usage };
}

const tokens = (input, output, cacheRead, cacheWrite) => ({ input, output, cacheRead, cacheWrite, total: input + output + cacheWrite });

// ---- Claude Code ----

function claudeLine({ id, uuid = `u-${id}`, when = iso(10, 9), model = 'claude-sonnet-x', input = 10, output = 5, read = 100, write = 20, type = 'assistant' }) {
  return {
    type,
    uuid,
    timestamp: when,
    message: { id, model, role: 'assistant', content: [{ type: 'text', text: 'SECRET-WORDS' }], usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: read, cache_creation_input_tokens: write } },
  };
}

test('Claude Code: one message on several lines counts once, with its largest numbers', async (t) => {
  const { roots, usage } = setup(t);
  const file = path.join(roots.claude, 'projects', '-home-ada-app', '0a1b2c3d-1111-2222-3333-444455556666.jsonl');
  put(file, [
    claudeLine({ id: 'msg_1', output: 5 }),
    claudeLine({ id: 'msg_1', uuid: 'u-b', output: 40 }),
    claudeLine({ id: 'msg_1', uuid: 'u-c', output: 40 }),
    claudeLine({ id: 'msg_2', input: 7, output: 3, read: 50, write: 0 }),
  ]);
  const { tools } = await usage.read();
  assert.deepEqual(tools.claude.today, tokens(17, 43, 150, 20));
  assert.deepEqual(tools.claude.week, tools.claude.today);
  assert.equal(tools.claude.on, true);
  assert.equal(tools.claude.atLeast, false);
  assert.equal(tools.claude.error, null);
  assert.equal(tools.claude.limits, null);
});

test('Claude Code: a number no session can reach is bad data and is left out', async (t) => {
  const { roots, usage } = setup(t);
  const file = path.join(roots.claude, 'projects', '-home-ada-app', '0a1b2c3d-1111-2222-3333-444455556677.jsonl');
  put(file, [
    claudeLine({ id: 'msg_1', input: 1e308, output: 1e308 }),
    claudeLine({ id: 'msg_2', input: 1e308 }),
    claudeLine({ id: 'msg_3', input: 7, output: 3, read: 50, write: 0 }),
  ]);
  const { tools } = await usage.read();
  assert.deepEqual(tools.claude.today, tokens(7, 8, 250, 40));
  assert.equal(JSON.stringify(tools.claude.week).includes('null'), false);
});

test('Claude Code: cache reads are shown apart and never added to the total', async (t) => {
  const { roots, usage } = setup(t);
  put(path.join(roots.claude, 'projects', 'p', '0a1b2c3d-1111-2222-3333-444455556666.jsonl'), claudeLine({ id: 'm', input: 1, output: 2, read: 1000000, write: 4 }));
  const { tools } = await usage.read();
  assert.equal(tools.claude.today.cacheRead, 1000000);
  assert.equal(tools.claude.today.total, 7);
});

test('Claude Code: sub-agent files count, synthetic lines and lines without usage do not', async (t) => {
  const { roots, usage } = setup(t);
  const session = '0a1b2c3d-1111-2222-3333-444455556666';
  const main = path.join(roots.claude, 'projects', 'p', `${session}.jsonl`);
  put(main, [
    claudeLine({ id: 'm1', input: 1, output: 1, read: 0, write: 0 }),
    claudeLine({ id: 'syn', model: '<synthetic>', input: 999, output: 999 }),
    { type: 'user', timestamp: iso(10), message: { role: 'user', content: 'hi' } },
    { type: 'assistant', timestamp: iso(10), message: { id: 'nousage', model: 'x', content: [] } },
    'this is not json',
    '{"type":"assistant","usage":',
  ]);
  put(path.join(roots.claude, 'projects', 'p', session, 'subagents', 'agent-abc123.jsonl'), claudeLine({ id: 'm2', input: 2, output: 2, read: 0, write: 0 }));
  put(path.join(roots.claude, 'projects', 'p', session, 'subagents', 'workflows', 'run1', 'agent-def456.jsonl'), claudeLine({ id: 'm3', input: 4, output: 4, read: 0, write: 0 }));
  const { tools } = await usage.read();
  assert.deepEqual(tools.claude.today, tokens(7, 7, 0, 0));
});

test('Claude Code: two files that share a message id count it once', async (t) => {
  const { roots, usage } = setup(t);
  put(path.join(roots.claude, 'projects', 'p', 'aaaaaaaa-1111-2222-3333-444455556666.jsonl'), claudeLine({ id: 'shared', output: 10 }));
  put(path.join(roots.claude, 'projects', 'q', 'bbbbbbbb-1111-2222-3333-444455556666.jsonl'), [
    claudeLine({ id: 'shared', output: 30 }),
    { ...claudeLine({ id: 'x' }), message: { ...claudeLine({ id: 'x' }).message, id: undefined }, uuid: 'only-a-uuid' },
  ]);
  const { tools } = await usage.read();
  // One shared message (largest output, 30) and one that has only a uuid.
  assert.equal(tools.claude.today.output, 35);
  assert.equal(tools.claude.today.input, 20);
});

test('Claude Code: the Claude Desktop folder is read when it has the same layout', async (t) => {
  const { roots, usage } = setup(t);
  put(path.join(roots.claudeDesktop, 'projects', 'p', 'cccccccc-1111-2222-3333-444455556666.jsonl'), claudeLine({ id: 'd1', input: 3, output: 3, read: 0, write: 0 }));
  assert.equal((await usage.read()).tools.claude.today.input, 3);
  const off = setup(t, { settings: { sources: { claudeDesktop: { enabled: false } } } });
  put(path.join(off.roots.claudeDesktop, 'projects', 'p', 'cccccccc-1111-2222-3333-444455556666.jsonl'), claudeLine({ id: 'd1', input: 3, output: 3, read: 0, write: 0 }));
  assert.equal((await off.usage.read()).tools.claude.today.input, 0);
});

test('days are the computer\'s local days, taken from each record\'s own time', async (t) => {
  const { roots, usage } = setup(t);
  const file = path.join(roots.claude, 'projects', 'p', 'dddddddd-1111-2222-3333-444455556666.jsonl');
  put(file, [
    claudeLine({ id: 'late', when: iso(9, 23, 30), input: 1, output: 0, read: 0, write: 0 }),
    claudeLine({ id: 'early', when: iso(10, 0, 30), input: 10, output: 0, read: 0, write: 0 }),
    claudeLine({ id: 'old', when: iso(4, 0, 5), input: 100, output: 0, read: 0, write: 0 }),
    claudeLine({ id: 'tooold', when: iso(3, 23, 59), input: 1000, output: 0, read: 0, write: 0 }),
    claudeLine({ id: 'future', when: iso(11, 0, 5), input: 10000, output: 0, read: 0, write: 0 }),
  ]);
  const { tools } = await usage.read();
  assert.deepEqual(tools.claude.days.map((d) => d.date), DAYS);
  assert.deepEqual(tools.claude.days.map((d) => d.input), [100, 0, 0, 0, 0, 1, 10]);
  assert.equal(tools.claude.today.input, 10);
  assert.equal(tools.claude.week.input, 111);
  assert.deepEqual(Object.keys(tools.claude.today), ['input', 'output', 'cacheRead', 'cacheWrite', 'total']);
  assert.deepEqual(Object.keys(tools.claude.days[0]), ['date', 'input', 'output', 'cacheRead', 'cacheWrite', 'total']);
  assert.deepEqual(lastDays(NOW).keys, DAYS);
});

test('only files changed since the start of the oldest day are read', async (t) => {
  const { roots, usage } = setup(t);
  const old = path.join(roots.claude, 'projects', 'p', 'eeeeeeee-1111-2222-3333-444455556666.jsonl');
  put(old, claudeLine({ id: 'm', when: iso(10, 9), input: 50, output: 0, read: 0, write: 0 }), { mtime: at(3, 23, 0) });
  assert.equal((await usage.read()).tools.claude.today.input, 0, 'a file last changed before the oldest day is not read');
  fs.utimesSync(old, new Date(at(4, 0, 1)), new Date(at(4, 0, 1)));
  assert.equal((await usage.read({ fresh: true })).tools.claude.today.input, 50);
});

test('a session\'s words never reach the answer', async (t) => {
  const { roots, usage } = setup(t);
  put(path.join(roots.claude, 'projects', 'p', 'ffffffff-1111-2222-3333-444455556666.jsonl'), claudeLine({ id: 'm' }));
  assert.ok(!JSON.stringify(await usage.read()).includes('SECRET-WORDS'));
});

// ---- Codex ----

const meta = (when, extra = {}) => ({ timestamp: when, type: 'session_meta', payload: { id: 'x', timestamp: when, ...extra } });
function count(when, total, extra = {}) {
  const [input, cached, output] = total ?? [0, 0, 0];
  const info = total === null ? null : { total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output, reasoning_output_tokens: 0, total_tokens: input + output }, last_token_usage: {} };
  return { timestamp: when, type: 'event_msg', payload: { type: 'token_count', info, rate_limits: null, ...extra } };
}
const rollout = (roots, day, id) => path.join(roots.codex, 'sessions', '2026', '06', String(day).padStart(2, '0'), `rollout-2026-06-${String(day).padStart(2, '0')}T08-00-00-${id}.jsonl`);
const ID_A = '019a3f2e-7c41-7d20-9b6e-5a1c2d3e4f50';
const ID_B = '019a3f30-1b22-7e31-8c4d-6b2e3f405162';
const ID_C = '019a3f31-4d55-7a12-9f3e-7c3f40516273';

test('Codex: repeated totals count once and a total that goes down starts again', async (t) => {
  const { roots, usage } = setup(t);
  put(rollout(roots, 10, ID_A), [
    meta(iso(10, 8)),
    count(iso(10, 9), [1000, 400, 100]),
    count(iso(10, 9, 1), [1000, 400, 100]),
    count(iso(10, 9, 2), null),
    count(iso(10, 10), [1500, 600, 160]),
    count(iso(10, 10, 5), [1500, 600, 160]),
    count(iso(10, 11), [300, 100, 20]),
    count(iso(10, 12), [350, 100, 30]),
  ]);
  const { tools } = await usage.read();
  // Growth: 1000/400/100, then 500/200/60, then (fresh start) 300/100/20, then 50/0/10.
  // Fresh input = input - cached: 600, then 300, then 200, then 50.
  assert.deepEqual(tools.codex.today, tokens(600 + 300 + 200 + 50, 100 + 60 + 20 + 10, 400 + 200 + 100 + 0, 0));
});

test('Codex: a fork does not count the events it copied from its parent', async (t) => {
  const { roots, usage } = setup(t);
  put(rollout(roots, 9, ID_A), [meta(iso(9, 8)), count(iso(9, 9), [1000, 0, 100]), count(iso(9, 10), [2000, 0, 200])]);
  put(rollout(roots, 10, ID_B), [
    meta(iso(10, 8), { forked_from_id: ID_A }),
    count(iso(9, 9), [1000, 0, 100]),
    count(iso(9, 10), [2000, 0, 200]),
    count(iso(10, 9), [2500, 0, 260]),
  ]);
  const { tools } = await usage.read();
  const byDay = Object.fromEntries(tools.codex.days.map((d) => [d.date, d]));
  assert.equal(byDay['2026-06-09'].input, 2000, 'the parent counts once, on its own day');
  assert.deepEqual([byDay['2026-06-10'].input, byDay['2026-06-10'].output], [500, 60], 'the fork counts only what is new');
});

test('Codex: the same thread in sessions and archived_sessions counts once', async (t) => {
  const { roots, usage } = setup(t);
  put(rollout(roots, 10, ID_A), [meta(iso(10, 8)), count(iso(10, 9), [100, 0, 10])], { mtime: at(10, 9) });
  put(path.join(roots.codex, 'archived_sessions', `rollout-2026-06-10T08-00-00-${ID_A}.jsonl`), [meta(iso(10, 8)), count(iso(10, 9), [100, 0, 10])], { mtime: at(10, 10) });
  assert.equal((await usage.read()).tools.codex.today.input, 100);
});

test('Codex: a long session counts on the days of its events, not of its folder', async (t) => {
  const { roots, usage } = setup(t);
  put(rollout(roots, 1, ID_A), [meta(iso(1, 8)), count(iso(5, 9), [100, 0, 10]), count(iso(10, 9), [160, 0, 14])], { mtime: at(10, 9) });
  const { tools } = await usage.read();
  assert.deepEqual(tools.codex.days.map((d) => d.input), [0, 100, 0, 0, 0, 0, 60]);
});

test('Codex: the limits come from the newest snapshot in any file', async (t) => {
  const { roots, usage } = setup(t);
  const snap = (primary, secondary, extra = {}) => ({ limit_id: 'codex', limit_name: null, primary, secondary, plan_type: 'plus', ...extra });
  const win = (used, minutes, resets) => ({ used_percent: used, window_minutes: minutes, resets_at: resets });
  put(rollout(roots, 10, ID_A), [
    meta(iso(10, 8)),
    count(iso(10, 9), [10, 0, 1], { rate_limits: snap(win(10, 300, 1781200000), win(5, 10080, 1781700000)) }),
    count(iso(10, 11), [20, 0, 2], { rate_limits: snap(win(30, 300, 1781210000), win(6, 10080, 1781700000), { plan_type: 'pro' }) }),
  ]);
  put(rollout(roots, 10, ID_B), [
    meta(iso(10, 8)),
    count(iso(10, 10), [10, 0, 1], { rate_limits: snap(win(99, 300, 1781209999), null) }),
    count(iso(10, 13), [20, 0, 2], { rate_limits: snap(win(55, 60, 1781220000), win(7, 10080, 1781710000), { limit_id: 'codex_other', plan_type: 'enterprise' }) }),
  ]);
  const { tools } = await usage.read();
  assert.deepEqual(tools.codex.limits, {
    at: at(10, 11),
    from: 'files',
    plan: 'pro',
    windows: [
      { minutes: 300, usedPercent: 30, resetsAt: 1781210000 * 1000 },
      { minutes: 10080, usedPercent: 6, resetsAt: 1781700000 * 1000 },
    ],
  });
});

test('Codex: a null window is left out and an empty limit_id is allowed', async (t) => {
  const { roots, usage } = setup(t);
  put(rollout(roots, 10, ID_A), [
    meta(iso(10, 8)),
    count(iso(10, 9), [10, 0, 1], { rate_limits: { limit_id: '', primary: null, secondary: { used_percent: 12.5, window_minutes: null, resets_at: null }, plan_type: null } }),
  ]);
  const { tools } = await usage.read();
  assert.deepEqual(tools.codex.limits, { at: at(10, 9), from: 'files', plan: null, windows: [{ minutes: null, usedPercent: 12.5, resetsAt: null }] });
});

test('Codex: a newer snapshot with no usable window does not hide the older limits', async (t) => {
  const { roots, usage } = setup(t);
  const win = (used, minutes, resets) => ({ used_percent: used, window_minutes: minutes, resets_at: resets });
  put(rollout(roots, 10, ID_A), [
    meta(iso(10, 5)),
    count(iso(10, 5), [10, 0, 1], { rate_limits: { limit_id: 'codex', primary: win(40, 300, 1781200000), secondary: win(10, 10080, 1781700000), plan_type: 'plus' } }),
    count(iso(10, 9), [20, 0, 2], { rate_limits: { limit_id: 'codex', primary: null, secondary: null, plan_type: 'plus', credits: { has_credits: false } } }),
  ]);
  const limits = (await usage.read()).tools.codex.limits;
  assert.equal(limits.at, at(10, 5));
  assert.deepEqual(limits.windows.map((w) => w.usedPercent), [40, 10]);
});

test('Codex: no snapshot means no limits', async (t) => {
  const { roots, usage } = setup(t);
  put(rollout(roots, 10, ID_C), [meta(iso(10, 8)), count(iso(10, 9), [10, 0, 1])]);
  assert.equal((await usage.read()).tools.codex.limits, null);
});

// ---- Grok ----

const turn = (n, ended, input, output, read = 0, write = 0) => ({ turnNumber: n, endedAt: ended, inputTokens: input, outputTokens: output, cachedReadTokens: read, cacheCreationTokens: write, totalTokens: input + output });
const usageJson = (turns) => JSON.stringify({ sessionId: 's', updatedAt: iso(10), session: { inputTokens: 1 }, turns });

test('Grok: turns are counted by when they ended, and copied turns count once', async (t) => {
  const { roots, usage } = setup(t);
  const sessions = path.join(roots.grok, 'sessions', '%2Fhome%2Fada%2Fapp');
  fs.mkdirSync(path.join(sessions, 'one'), { recursive: true });
  fs.mkdirSync(path.join(sessions, 'two'), { recursive: true });
  const first = [turn(1, iso(9, 10), 100, 10, 50, 5), turn(2, iso(10, 10), 200, 20, 60, 6)];
  fs.writeFileSync(path.join(sessions, 'one', 'usage.json'), usageJson(first));
  // A fork copies the first two turns (the second one renumbered, as a resume does) and adds one of its own.
  const renumbered = { ...first[1], turnNumber: 5 };
  fs.writeFileSync(path.join(sessions, 'two', 'usage.json'), usageJson([first[0], renumbered, turn(3, iso(10, 11), 300, 30, 70, 7)]));
  const { tools } = await usage.read();
  assert.deepEqual(tools.grok.today, tokens(500, 50, 130, 13));
  assert.deepEqual(tools.grok.days[5], { date: '2026-06-09', ...tokens(100, 10, 50, 5) });
  assert.equal(tools.grok.limits, null);
});

test('Grok: a usage.json that is too big is skipped and the answer says at least', async (t) => {
  const { roots, usage } = setup(t);
  const dir = path.join(roots.grok, 'sessions', 'g', 'big');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'usage.json'), Buffer.alloc(8 * 1024 * 1024 + 1, 0x20));
  const { tools } = await usage.read();
  assert.equal(tools.grok.atLeast, true);
  assert.equal(tools.grok.today.total, 0);
});

test('Grok: a usage.json marked incomplete says at least, also when it did not change', async (t) => {
  const { roots, usage, clock } = setup(t);
  const dir = path.join(roots.grok, 'sessions', 'g', 'flag');
  fs.mkdirSync(dir, { recursive: true });
  const body = { sessionId: 's', session: { usageIsIncomplete: true }, turns: [turn(1, iso(10, 9), 5, 5)] };
  fs.writeFileSync(path.join(dir, 'usage.json'), JSON.stringify(body));
  const first = (await usage.read()).tools.grok;
  assert.equal(first.today.total, 10);
  assert.equal(first.atLeast, true);
  clock.now += 1000;
  assert.equal((await usage.read({ fresh: true })).tools.grok.atLeast, true, 'the file did not change');
  // A turn can carry the flag too; a clean file does not.
  fs.writeFileSync(path.join(dir, 'usage.json'), JSON.stringify({ turns: [{ ...turn(1, iso(10, 9), 5, 5), usageIsIncomplete: true }] }));
  clock.now += 1000;
  assert.equal((await usage.read({ fresh: true })).tools.grok.atLeast, true);
  fs.writeFileSync(path.join(dir, 'usage.json'), usageJson([turn(1, iso(10, 9), 5, 5)]));
  clock.now += 1000;
  assert.equal((await usage.read({ fresh: true })).tools.grok.atLeast, false);
});

test('Grok: a file caught half-written is tried again later', async (t) => {
  const { roots, usage, clock } = setup(t);
  const file = path.join(roots.grok, 'sessions', 'g', 's1', 'usage.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{"turns": [');
  assert.equal((await usage.read()).tools.grok.today.total, 0);
  fs.writeFileSync(file, usageJson([turn(1, iso(10, 9), 5, 5)]));
  clock.now += 1000;
  assert.equal((await usage.read({ fresh: true })).tools.grok.today.total, 10);
});

// ---- Kimi Code ----

const record = (time, over = {}) => ({ type: 'usage.record', agentId: 'main', model: 'kimi-x', usage: { inputOther: 10, output: 5, inputCacheRead: 100, inputCacheCreation: 20 }, usageScope: 'turn', time, ...over });
const wire = (roots, session, agent) => path.join(roots.kimi, 'sessions', 'wd_app_0123456789ab', `session_${session}`, 'agents', agent, 'wire.jsonl');
const KIMI = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';

test('Kimi Code: only usage records count, helpers count, and a repeated record counts once', async (t) => {
  const { roots, usage } = setup(t);
  put(wire(roots, KIMI, 'main'), [
    record(at(10, 9)),
    record(at(10, 9)),
    record(at(10, 10), { usage: { inputOther: 1, output: 2, inputCacheRead: 3, inputCacheCreation: 4 } }),
    { type: 'step.end', time: at(10, 10), usage: { inputOther: 999, output: 999, inputCacheRead: 999, inputCacheCreation: 999 } },
    { type: 'llm.request', time: at(10, 10), model: 'kimi-x' },
    record(at(9, 22), { usageScope: 'session' }),
  ]);
  put(wire(roots, KIMI, 'agent-0'), record(at(10, 9), { agentId: 'agent-0' }));
  const { tools } = await usage.read();
  // main: 10/5/100/20 once, plus 1/2/3/4; helper: 10/5/100/20 (same time, other agent: its own record).
  assert.deepEqual(tools.kimi.today, tokens(21, 12, 203, 44));
  assert.deepEqual(tools.kimi.days[5], { date: '2026-06-09', ...tokens(10, 5, 100, 20) });
  assert.equal(tools.kimi.limits, null);
});

// ---- Gemini CLI ----

const GEMINI = '5b6c7d8e-0000-4000-8000-000000000001';
const geminiTokens = (over = {}) => ({ input: 110, output: 5, cached: 100, thoughts: 3, tool: 2, total: 120, ...over });
const geminiReply = (id, when, tokens = geminiTokens()) => ({ id, timestamp: when, type: 'gemini', content: 'SECRET-WORDS', model: 'gemini-x', tokens });
const chatFile = (roots, name, folder = 'project') => path.join(roots.gemini, 'tmp', folder, 'chats', name);

test('Gemini CLI: each reply counts once, helpers and older .json files count, and cached tokens are taken out', async (t) => {
  const { roots, usage } = setup(t);
  const name = `session-2026-06-10T09-00-${GEMINI.slice(0, 8)}.jsonl`;
  put(chatFile(roots, name), [
    { sessionId: GEMINI, projectHash: 'a'.repeat(64), startTime: iso(10, 8), lastUpdated: iso(10, 8) },
    { id: 'u1', timestamp: iso(10, 9), type: 'user', content: [{ text: 'SECRET-WORDS' }] },
    geminiReply('g1', iso(10, 9), geminiTokens({ output: 1 })),
    geminiReply('g1', iso(10, 9)), // the same reply written again, with its final numbers
    geminiReply('g2', iso(9, 22), { input: 20, output: 4, cached: 0, total: 24 }),
    { $set: { lastUpdated: iso(10, 9) } },
    { $set: { messages: [geminiReply('g3', iso(10, 10), { input: 50, output: 10, cached: 40, total: 60 })] } },
  ]);
  // A copy of the same session in an older project folder named by a hash counts once.
  put(chatFile(roots, name, 'f'.repeat(64)), geminiReply('g1', iso(10, 9)));
  // A helper, and an older one-object session file.
  put(chatFile(roots, `${GEMINI}/helper-1.jsonl`), geminiReply('h1', iso(10, 11), { input: 7, output: 3, cached: 0, total: 10 }));
  put(chatFile(roots, 'session-2026-06-08T09-00-6c7d8e9f.json'), JSON.stringify({ sessionId: '6c7d8e9f-0000-4000-8000-000000000002', messages: [geminiReply('o1', iso(8, 9), { input: 30, output: 6, cached: 10, total: 36 })] }));
  // Other files are never read.
  put(path.join(roots.gemini, 'tmp', 'project', 'logs.jsonl'), geminiReply('x1', iso(10, 9)));
  put(chatFile(roots, 'notes.jsonl'), geminiReply('x2', iso(10, 9)));
  const { tools } = await usage.read();
  // g1: 110 sent less 100 from memory, plus 2 for tool use = 12; 5 written back plus 3 thinking = 8.
  // g3: 10 and 10, with 40 from memory. h1: 7 and 3.
  assert.deepEqual(tools.gemini.today, tokens(29, 21, 140, 0));
  assert.deepEqual(tools.gemini.days[5], { date: '2026-06-09', ...tokens(20, 4, 0, 0) });
  assert.deepEqual(tools.gemini.days[4], { date: '2026-06-08', ...tokens(20, 6, 10, 0) });
  assert.equal(tools.gemini.on, true);
  assert.equal(tools.gemini.limits, null);
  assert.equal(tools.gemini.error, null);
  assert.equal(tools.gemini.atLeast, false);
});

// ---- reading, reusing and limits ----

test('a file that grows is read from where it stopped, and a half-written last line waits', async (t) => {
  const { roots, usage, clock } = setup(t);
  const file = path.join(roots.claude, 'projects', 'p', '11111111-1111-2222-3333-444455556666.jsonl');
  put(file, claudeLine({ id: 'a', input: 1, output: 0, read: 0, write: 0 }));
  assert.equal((await usage.read()).tools.claude.today.input, 1);
  const half = JSON.stringify(claudeLine({ id: 'b', input: 10, output: 0, read: 0, write: 0 }));
  fs.appendFileSync(file, half.slice(0, 40));
  clock.now += 60 * 1000;
  assert.equal((await usage.read()).tools.claude.today.input, 1, 'the unfinished line is not counted');
  fs.appendFileSync(file, `${half.slice(40)}\n`);
  clock.now += 60 * 1000;
  assert.equal((await usage.read()).tools.claude.today.input, 11);
});

test('the last answer is reused for 30 seconds unless fresh', async (t) => {
  const { roots, usage, clock } = setup(t);
  const file = path.join(roots.claude, 'projects', 'p', '22222222-1111-2222-3333-444455556666.jsonl');
  put(file, claudeLine({ id: 'a', input: 1, output: 0, read: 0, write: 0 }));
  const first = await usage.read();
  put(file, claudeLine({ id: 'b', input: 10, output: 0, read: 0, write: 0 }), { append: true });
  clock.now += 29 * 1000;
  const again = await usage.read();
  assert.equal(again, first);
  assert.equal(again.tools.claude.today.input, 1);
  assert.equal((await usage.read({ fresh: true })).tools.claude.today.input, 11);
  put(file, claudeLine({ id: 'c', input: 100, output: 0, read: 0, write: 0 }), { append: true });
  clock.now += 31 * 1000;
  assert.equal((await usage.read()).tools.claude.today.input, 111);
});

test('a read that has to stop early says at least', async (t) => {
  const files = setup(t, { maxFiles: 1 });
  put(path.join(files.roots.claude, 'projects', 'p', '33333333-1111-2222-3333-444455556666.jsonl'), claudeLine({ id: 'a', input: 1, output: 0, read: 0, write: 0 }), { mtime: at(10, 8) });
  put(path.join(files.roots.claude, 'projects', 'p', '44444444-1111-2222-3333-444455556666.jsonl'), claudeLine({ id: 'b', input: 10, output: 0, read: 0, write: 0 }), { mtime: at(10, 9) });
  const cut = (await files.usage.read()).tools.claude;
  assert.equal(cut.atLeast, true);
  assert.equal(cut.today.input, 10, 'the newest file is read first');

  const bytes = setup(t, { maxBytes: 100 });
  put(path.join(bytes.roots.codex, 'sessions', '2026', '06', '10', `rollout-x-${ID_A}.jsonl`), [meta(iso(10, 8)), count(iso(10, 9), [10, 0, 1]), count(iso(10, 10), [20, 0, 2])]);
  assert.equal((await bytes.usage.read()).tools.codex.atLeast, true);
  const next = (await bytes.usage.read({ fresh: true })).tools.codex;
  assert.equal(next.atLeast, true, 'a small budget keeps reading a little each time');
});

test('a tool that is off is not read, and a missing folder gets a plain message', async (t) => {
  const { roots, usage } = setup(t, { settings: { sources: { codex: { enabled: false } } } });
  put(rollout(roots, 10, ID_A), [meta(iso(10, 8)), count(iso(10, 9), [10, 0, 1])]);
  fs.rmSync(roots.kimi, { recursive: true });
  const { tools } = await usage.read();
  assert.equal(tools.codex.on, false);
  assert.equal(tools.codex.today.total, 0);
  assert.equal(tools.codex.days.length, 7);
  assert.equal(tools.kimi.on, true);
  assert.match(tools.kimi.error, /Kimi Code/);
  assert.equal(tools.claude.error, null);
  const nowhere = createUsage({ getRoots: () => ({}), getSettings: () => cleanSettings({}), now: () => NOW });
  const none = (await nowhere.read()).tools;
  for (const name of ['claude', 'codex', 'grok', 'kimi', 'gemini']) assert.match(none[name].error, /does not know where/);
});

test('Claude Code limits come from the hook, and a hook that fails changes nothing', async (t) => {
  const limits = { at: NOW, from: 'statusLine', plan: null, windows: [{ minutes: 300, usedPercent: 40, resetsAt: NOW + 1000 }] };
  const good = setup(t, { claudeLimits: async () => limits });
  assert.deepEqual((await good.usage.read()).tools.claude.limits, limits);
  const bad = setup(t, { claudeLimits: () => { throw new Error('no'); } });
  const { tools } = await bad.usage.read();
  assert.equal(tools.claude.limits, null);
  assert.equal(tools.claude.error, null);
});

test('the demo answers in the same shape, with limits for Claude Code and Codex only', () => {
  const demo = demoUsage(NOW);
  assert.deepEqual(Object.keys(demo.tools), ['claude', 'codex', 'grok', 'kimi', 'gemini']);
  assert.equal(demo.at, NOW);
  assert.equal(demo.tools.claude.limits.from, 'statusLine');
  assert.equal(demo.tools.codex.limits.from, 'files');
  assert.equal(demo.tools.grok.limits, null);
  assert.equal(demo.tools.kimi.limits, null);
  assert.equal(demo.tools.gemini.limits, null);
  for (const tool of Object.values(demo.tools)) {
    assert.deepEqual(tool.days.map((d) => d.date), DAYS);
    assert.equal(tool.week.total, tool.days.reduce((n, d) => n + d.total, 0));
    assert.equal(tool.today.total, tool.today.input + tool.today.output + tool.today.cacheWrite);
  }
  assert.deepEqual(demoUsage(NOW), demo);
});

test('Claude Code limits are read again on every call, also while the rest is reused', async (t) => {
  let percent = 10;
  const { usage, clock } = setup(t, { claudeLimits: () => ({ at: NOW, from: 'statusLine', plan: null, windows: [{ minutes: 300, usedPercent: percent, resetsAt: NOW + 1000 }] }) });
  const first = await usage.read();
  assert.equal(first.tools.claude.limits.windows[0].usedPercent, 10);
  assert.equal(await usage.read(), first, 'nothing changed, so the same answer');
  percent = 55;
  clock.now += 5 * 1000;
  const again = await usage.read();
  assert.equal(again.tools.claude.limits.windows[0].usedPercent, 55);
  assert.equal(again.at, first.at, 'the token counts are still the reused ones');
});
