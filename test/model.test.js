import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cleanSettings } from '../src/config.js';
import { PULSE_MS, buildSnapshot, modelLabel, modelTier, projectName } from '../src/model.js';

const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);
const MIN = 60000;
const HOUR = 60 * MIN;

const LEAD = 'claude:aaaaaaaa-0000-4000-8000-000000000001';
const HELPER = `${LEAD}/a1b2c3d4e5f60001`;
const NESTED = `${LEAD}/a1b2c3d4e5f60002`;
const PLANNER = 'codex:bbbbbbbb-0000-4000-8000-000000000001';
const CHILD = 'codex:bbbbbbbb-0000-4000-8000-000000000002';
const REVIEWER = 'codex:bbbbbbbb-0000-4000-8000-000000000003';
const OTHER = 'claude:cccccccc-0000-4000-8000-000000000001';

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pleni-model-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function session(key, extra = {}) {
  return {
    platform: key.slice(0, key.indexOf(':')),
    key,
    id: key.slice(key.indexOf(':') + 1),
    parentKey: null,
    kind: 'session',
    title: null,
    titleSource: null,
    cwd: '/home/ada/code/alpha',
    branch: 'main',
    entrypoint: 'cli',
    model: 'claude-opus-5-5',
    effort: null,
    startedAt: NOW - 30 * MIN,
    lastAt: NOW - MIN,
    status: 'idle',
    activity: null,
    lastText: null,
    links: [],
    archived: false,
    ...extra,
  };
}

function snap({ settings = {}, claude = [], codex = [], mailbox = null, now = NOW } = {}) {
  return buildSnapshot({
    now,
    settings: cleanSettings({ groupBy: 'project', ...settings }),
    claude: { ok: true, error: null, root: '/home/ada/.claude', sessions: claude },
    codex: { ok: true, error: null, root: '/home/ada/.codex', sessions: codex },
    mailbox,
  });
}

function node(snapshot, key) {
  return snapshot.nodes.find((n) => n.key === key);
}

function edgeTo(snapshot, key, kind) {
  return snapshot.edges.find((e) => e.to === key && (!kind || e.kind === kind));
}

// A typical cast: a Claude lead with a helper, a nested helper and a Codex planner with a child.
function cast() {
  return {
    claude: [
      session(LEAD, { title: 'Billing API refactor', status: 'working' }),
      session(HELPER, { parentKey: LEAD, kind: 'agent', title: 'Refund tests', model: 'claude-sonnet-5-5', status: 'done' }),
      session(NESTED, { parentKey: HELPER, kind: 'agent', title: 'Fixture builder', model: 'claude-haiku-5-5', status: 'ready' }),
      session(OTHER, { title: 'Map tile cache', cwd: '/home/ada/code/beta', status: 'error', lastText: 'The server did not start.' }),
    ],
    codex: [
      session(PLANNER, { title: 'Q4 plan', model: 'gpt-6.1-astra', status: 'ready' }),
      session(CHILD, { parentKey: PLANNER, kind: 'agent', title: 'Schema review', model: 'gpt-6.1-sol', status: 'working' }),
    ],
  };
}

test('projectName uses the last folder of the path', () => {
  assert.equal(projectName('/home/ada/code/billing-service'), 'billing-service');
  assert.equal(projectName('/home/ada/code/billing-service/'), 'billing-service');
  assert.equal(projectName('C:\\Users\\ada\\project\\'), 'project');
  assert.equal(projectName('\\\\?\\C:\\Users\\ada\\project'), 'project');
  assert.equal(projectName('\\\\?\\UNC\\server\\share\\repo'), 'repo');
  assert.equal(projectName('\\\\server\\share\\repo'), 'repo');
});

test('projectName gives a fallback name when there is no folder', () => {
  for (const cwd of [null, undefined, '', '   ', '/', '\\', 42]) assert.equal(projectName(cwd), 'Other');
});

test('projectName uses the repository folder inside Claude and Codex worktrees', () => {
  assert.equal(projectName('/home/ada/code/alpha/.claude/worktrees/fix-login'), 'alpha');
  assert.equal(projectName('/home/ada/code/alpha/.claude/worktrees/fix-login/src/lib'), 'alpha');
  assert.equal(projectName('C:\\Users\\ada\\code\\alpha\\.Claude\\Worktrees\\fix-login'), 'alpha');
  assert.equal(projectName('/home/ada/.codex/worktrees/7f3a/alpha'), 'alpha');
  assert.equal(projectName('C:\\Users\\ada\\.codex\\worktrees\\7f3a\\alpha\\packages\\web'), 'alpha');
});

test('projectName reads the repository of a _worktrees folder from its .git file', (t) => {
  const dir = tempDir(t);
  const repoGit = path.join(dir, 'repos', 'beta', '.git', 'worktrees', 'beta-fix');
  fs.mkdirSync(repoGit, { recursive: true });
  const tree = path.join(dir, '_worktrees', 'beta-fix');
  fs.mkdirSync(path.join(tree, 'src'), { recursive: true });
  fs.writeFileSync(path.join(tree, '.git'), `gitdir: ${repoGit}\n`);

  const bare = path.join(dir, '_worktrees', 'gamma-docs');
  fs.mkdirSync(bare, { recursive: true });
  fs.writeFileSync(path.join(bare, '.git'), 'gitdir: /home/ada/repos/gamma.git/worktrees/gamma-docs\n');

  assert.equal(projectName(tree), 'beta');
  assert.equal(projectName(path.join(tree, 'src')), 'beta');
  assert.equal(projectName(bare), 'gamma');
  // A removed worktree (no .git file) falls back to its own folder name.
  assert.equal(projectName(path.join(dir, '_worktrees', 'delta-fix', 'src')), 'delta-fix');
});

test('projectName follows a relative gitdir and skips .git folders', (t) => {
  const dir = tempDir(t);
  const repo = path.join(dir, 'alpha');
  fs.mkdirSync(path.join(repo, '.git', 'worktrees', 'fix'), { recursive: true });
  const tree = path.join(repo, '_worktrees', 'fix');
  fs.mkdirSync(tree, { recursive: true });
  fs.writeFileSync(path.join(tree, '.git'), 'gitdir: ../../.git/worktrees/fix\n');
  assert.equal(projectName(tree), 'alpha');

  // A whole repository kept in a _worktrees folder has a .git folder, not a file.
  const plain = path.join(dir, '_worktrees', 'epsilon');
  fs.mkdirSync(path.join(plain, '.git'), { recursive: true });
  assert.equal(projectName(plain), 'epsilon');
});

test('projectName never reads from a network share', (t) => {
  const stat = t.mock.method(fs, 'statSync');
  const read = t.mock.method(fs, 'readFileSync');
  assert.equal(projectName('\\\\server\\share\\_worktrees\\fix'), 'fix');
  assert.equal(projectName('\\\\?\\UNC\\server\\share\\_worktrees\\fix\\src'), 'fix');
  assert.equal(projectName('//server/share/_worktrees/fix'), 'fix');
  assert.equal(stat.mock.callCount(), 0);
  assert.equal(read.mock.callCount(), 0);
});

test('modelLabel makes short readable names', () => {
  const cases = [
    ['claude-opus-5-5', 'Opus 5.5'],
    ['claude-sonnet-5-5', 'Sonnet 5.5'],
    ['claude-sonnet-4-5-20250929', 'Sonnet 4.5'],
    ['claude-opus-4-1', 'Opus 4.1'],
    ['claude-opus-4', 'Opus 4'],
    ['claude-3-5-haiku-20241022', 'Haiku 3.5'],
    ['claude-opus-4-6[1m]', 'Opus 4.6'],
    ['gpt-6.1-sol', 'GPT-6.1 Sol'],
    ['gpt-6.1', 'GPT-6.1'],
    ['gpt-5-codex-mini', 'GPT-5 Codex Mini'],
    ['gpt-4o', 'GPT-4o'],
    ['codex-auto-review', 'Codex Auto Review'],
    ['o3', 'o3'],
  ];
  for (const [model, label] of cases) assert.equal(modelLabel(model), label, model);
  for (const model of [null, undefined, '', '<synthetic>', 7]) assert.equal(modelLabel(model), null);
});

test('modelTier matches whole words from the tier lists', () => {
  const tiers = cleanSettings({}).modelTiers;
  assert.equal(modelTier('claude-opus-5-5', tiers), 'senior');
  assert.equal(modelTier('gpt-6.1-astra', tiers), 'senior');
  assert.equal(modelTier('claude-sonnet-5-5', tiers), 'junior');
  assert.equal(modelTier('gpt-6.1-sol', tiers), 'junior');
  assert.equal(modelTier('gpt-5-codex-mini', tiers), 'junior');
  assert.equal(modelTier('gpt-6.1-solar', tiers), null);
  assert.equal(modelTier('gpt-6.1', tiers), null);
  assert.equal(modelTier(null, tiers), null);
  assert.equal(modelTier('gpt-6.1-pro', { senior: ['6.1-pro'], junior: [] }), 'senior');
});

test('the tree runs from the person through projects to sessions and sub-agents', () => {
  const s = snap({ ...cast() });
  assert.deepEqual(s.nodes.map((n) => n.key), [
    'you',
    'project:alpha',
    LEAD,
    HELPER,
    NESTED,
    PLANNER,
    CHILD,
    'project:beta',
    OTHER,
  ]);
  assert.equal(node(s, 'you').parent, null);
  assert.equal(node(s, 'project:alpha').parent, 'you');
  assert.equal(node(s, LEAD).parent, 'project:alpha');
  assert.equal(node(s, NESTED).parent, HELPER);
  assert.equal(node(s, CHILD).parent, PLANNER);
  assert.equal(node(s, 'you').platform, 'human');
  assert.equal(node(s, 'project:alpha').platform, 'group');
  assert.equal(node(s, 'project:alpha').subtitle, '5 sessions');
  assert.equal(node(s, 'project:beta').subtitle, '1 session');
  assert.equal(node(s, 'project:alpha').lastAt, NOW - MIN);
  assert.equal(node(s, LEAD).project, 'alpha');
  assert.equal(node(s, LEAD).subtitle, 'main');
});

test('edges join every node to its parent', () => {
  const s = snap({ ...cast() });
  assert.equal(s.edges.length, s.nodes.length - 1);
  assert.equal(edgeTo(s, 'project:alpha').kind, 'contains');
  assert.equal(edgeTo(s, LEAD).kind, 'contains');
  assert.equal(edgeTo(s, HELPER).kind, 'spawn');
  assert.equal(edgeTo(s, HELPER).from, LEAD);
  assert.equal(edgeTo(s, NESTED).from, HELPER);
  for (const e of s.edges) {
    assert.deepEqual(Object.keys(e), ['from', 'to', 'kind', 'lastDown', 'lastUp', 'downLabel', 'upLabel', 'active']);
  }
});

test('a sub-agent whose parent is not listed hangs under its project', () => {
  const { claude } = cast();
  const s = snap({ claude: claude.filter((x) => x.key !== LEAD) });
  assert.equal(node(s, HELPER).parent, 'project:alpha');
  assert.equal(edgeTo(s, HELPER).kind, 'contains');
  assert.equal(node(s, NESTED).parent, HELPER);
});

test('a sub-agent with no folder uses its parent project', () => {
  const s = snap({
    claude: [
      session(LEAD, { cwd: '/home/ada/code/gamma', archived: true }),
      session(HELPER, { parentKey: LEAD, kind: 'agent', cwd: null }),
    ],
  });
  assert.equal(node(s, HELPER).parent, 'project:gamma');
  assert.equal(node(s, HELPER).project, 'gamma');
});

test('groupBy none puts sessions straight under the person', () => {
  const s = snap({ ...cast(), settings: { groupBy: 'none' } });
  assert.equal(s.nodes.filter((n) => n.kind === 'project').length, 0);
  assert.equal(node(s, LEAD).parent, 'you');
  assert.equal(node(s, OTHER).parent, 'you');
  assert.equal(node(s, LEAD).project, 'alpha');
});

test('old, archived, hidden and reviewer sessions are left out', () => {
  const claude = [
    session(LEAD, { title: 'Recent' }),
    session(OTHER, { lastAt: NOW - 25 * HOUR, startedAt: NOW - 26 * HOUR }),
    session('claude:dddddddd-0000-4000-8000-000000000001', { archived: true }),
    session('claude:dddddddd-0000-4000-8000-000000000002', { title: 'Secret' }),
    session('claude:dddddddd-0000-4000-8000-000000000003', { cwd: '/home/ada/code/private' }),
    session('claude:dddddddd-0000-4000-8000-000000000004', { lastAt: null, startedAt: null }),
  ];
  const codex = [
    session(PLANNER, { model: 'gpt-6.1' }),
    session(REVIEWER, { parentKey: PLANNER, kind: 'reviewer', model: 'codex-auto-review' }),
  ];
  const settings = {
    people: { 'claude:dddddddd-0000-4000-8000-000000000002': { role: 'hidden' } },
    projects: { private: { hidden: true } },
  };
  const s = snap({ claude, codex, settings });
  const keys = s.nodes.filter((n) => n.kind !== 'person' && n.kind !== 'project').map((n) => n.key);
  assert.deepEqual(keys, [LEAD, PLANNER]);
  assert.equal(node(s, 'project:private'), undefined);
  assert.equal(s.counts.total, 2);

  const withReviewers = snap({ claude, codex, settings: { ...settings, showReviewers: true } });
  assert.equal(node(withReviewers, REVIEWER).parent, PLANNER);
  assert.equal(node(withReviewers, REVIEWER).kind, 'reviewer');

  const longer = snap({ claude, codex, settings: { ...settings, window: { recentHours: 48 } } });
  assert.ok(node(longer, OTHER));
});

test('settings rename projects and people', () => {
  const s = snap({
    ...cast(),
    settings: {
      displayName: 'Ada',
      projects: { alpha: { label: 'Alpha app' } },
      people: { [LEAD]: { label: 'Main lead' } },
    },
  });
  assert.equal(node(s, 'you').title, 'Ada');
  assert.equal(node(s, 'project:alpha').title, 'Alpha app');
  // `project` stays the folder name: it is the key the Settings page edits.
  assert.equal(node(s, LEAD).project, 'alpha');
  assert.equal(node(s, 'project:alpha').project, 'alpha');
  assert.equal(node(s, LEAD).title, 'Main lead');
  assert.equal(node(s, HELPER).title, 'Refund tests');
});

test('sessions without a title get a short plain name', () => {
  const s = snap({ claude: [session(LEAD), session(HELPER, { parentKey: LEAD, kind: 'agent' })] });
  assert.equal(node(s, LEAD).title, 'Session aaaaaaaa');
  assert.equal(node(s, HELPER).title, 'Agent a1b2c3d4');
});

test('ranks follow the plain theme', () => {
  const s = snap({
    ...cast(),
    codex: [...cast().codex, session(REVIEWER, { parentKey: PLANNER, kind: 'reviewer', model: 'codex-auto-review' })],
    settings: { showReviewers: true, people: { [PLANNER]: { role: 'superintendent' }, [OTHER]: { role: 'coordinator' } } },
  });
  assert.equal(node(s, 'you').rank, null);
  assert.equal(node(s, 'project:alpha').rank, null);
  assert.equal(node(s, LEAD).rank, 'Lead');
  assert.equal(node(s, HELPER).rank, 'Agent');
  assert.equal(node(s, REVIEWER).rank, 'Reviewer');
  assert.equal(node(s, PLANNER).rank, 'Superintendent');
  assert.equal(node(s, OTHER).rank, 'Coordinator');
  assert.equal(node(s, LEAD).role, 'lead');
  assert.equal(node(s, HELPER).role, 'worker');
  assert.equal(node(s, PLANNER).role, 'superintendent');
});

test('ranks follow the military theme', () => {
  const s = snap({
    ...cast(),
    settings: {
      titles: 'military',
      people: { [PLANNER]: { role: 'superintendent' }, [OTHER]: { role: 'coordinator' }, [NESTED]: { role: 'worker' } },
    },
  });
  assert.equal(node(s, 'you').rank, 'General');
  assert.equal(node(s, PLANNER).rank, 'Colonel');
  assert.equal(node(s, OTHER).rank, 'Sergeant');
  assert.equal(node(s, LEAD).rank, 'Sergeant');
  assert.equal(node(s, HELPER).rank, 'Private');
  assert.equal(node(s, NESTED).rank, 'Private');

  const senior = snap({
    claude: [session(LEAD), session(HELPER, { parentKey: LEAD, kind: 'agent', model: 'claude-opus-5-5' })],
    settings: { titles: 'military' },
  });
  assert.equal(node(senior, HELPER).tier, 'senior');
  assert.equal(node(senior, HELPER).rank, 'Specialist');
});

test('ranks follow the company theme', () => {
  const s = snap({
    ...cast(),
    settings: { titles: 'company', people: { [PLANNER]: { role: 'superintendent' }, [OTHER]: { role: 'coordinator' } } },
  });
  assert.equal(node(s, 'you').rank, 'Owner');
  assert.equal(node(s, PLANNER).rank, 'Vice President');
  assert.equal(node(s, OTHER).rank, 'Manager');
  assert.equal(node(s, LEAD).rank, 'Supervisor');
  assert.equal(node(s, HELPER).rank, 'Worker');
});

test('nodes carry tier, model label and session fields', () => {
  const s = snap({ ...cast() });
  const lead = node(s, LEAD);
  assert.equal(lead.tier, 'senior');
  assert.equal(lead.modelLabel, 'Opus 5.5');
  assert.equal(node(s, HELPER).tier, 'junior');
  assert.equal(node(s, CHILD).modelLabel, 'GPT-6.1 Sol');
  assert.equal(node(s, 'you').tier, null);
  assert.deepEqual(Object.keys(lead), [
    'key', 'parent', 'platform', 'kind', 'title', 'subtitle', 'rank', 'role', 'tier', 'model', 'modelLabel',
    'effort', 'status', 'startedAt', 'lastAt', 'activity', 'lastText', 'needs', 'project', 'projectLabel', 'entrypoint',
    'hidden', 'archived',
  ]);
  assert.deepEqual(Object.keys(node(s, 'you')), Object.keys(lead));
  assert.deepEqual(Object.keys(node(s, 'project:alpha')), Object.keys(lead));
});

test('links become spawn, message and report events and light the spawn edge', () => {
  const links = [
    { at: NOW - 20 * MIN - 1000, dir: 'down', other: HELPER, label: 'Write the refund tests' },
    { at: NOW - 5 * MIN, dir: 'up', other: HELPER, label: 'First tests pass' },
    { at: NOW - 30000, dir: 'down', other: HELPER, label: 'Add one for partial refunds' },
  ];
  const s = snap({
    claude: [
      session(LEAD, { links }),
      session(HELPER, { parentKey: LEAD, kind: 'agent', startedAt: NOW - 20 * MIN, status: 'working' }),
    ],
  });
  const e = edgeTo(s, HELPER);
  assert.equal(e.lastDown, NOW - 30000);
  assert.equal(e.downLabel, 'Add one for partial refunds');
  assert.equal(e.lastUp, NOW - 5 * MIN);
  assert.equal(e.upLabel, 'First tests pass');
  assert.equal(e.active, 'down');
  assert.deepEqual(s.events.map((ev) => [ev.kind, ev.from, ev.to, ev.text]), [
    ['message', LEAD, HELPER, 'Add one for partial refunds'],
    ['report', HELPER, LEAD, 'First tests pass'],
    ['spawn', LEAD, HELPER, 'Write the refund tests'],
  ]);
});

test('edges are active only within PULSE_MS', () => {
  const build = (downAgo, upAgo) => snap({
    claude: [
      session(LEAD, {
        links: [
          { at: NOW - downAgo, dir: 'down', other: HELPER, label: null },
          { at: NOW - upAgo, dir: 'up', other: HELPER, label: null },
        ],
      }),
      session(HELPER, { parentKey: LEAD, kind: 'agent', startedAt: NOW - HOUR }),
    ],
  });
  assert.equal(edgeTo(build(10000, 5000), HELPER).active, 'both');
  assert.equal(edgeTo(build(PULSE_MS, PULSE_MS + 1), HELPER).active, 'down');
  assert.equal(edgeTo(build(PULSE_MS + 1, 1000), HELPER).active, 'up');
  assert.equal(edgeTo(build(PULSE_MS + 1, PULSE_MS + 1), HELPER).active, null);
  assert.equal(edgeTo(build(10000, 5000), LEAD).active, null);
});

test('a hand-off recorded by both sides is counted once', () => {
  const at = NOW - 10000;
  const s = snap({
    codex: [
      session(PLANNER, { links: [{ at, dir: 'up', other: CHILD, label: 'Done' }] }),
      session(CHILD, { parentKey: PLANNER, kind: 'agent', links: [{ at, dir: 'up', other: PLANNER, label: 'Done' }] }),
    ],
  });
  assert.equal(s.events.length, 1);
  assert.deepEqual(s.events[0], { at, kind: 'report', from: CHILD, to: PLANNER, text: 'Done' });
  assert.equal(edgeTo(s, CHILD).active, 'up');
});

test('a message from deep down to any ancestor is a report drawn up the tree', () => {
  const GRAND = 'codex:bbbbbbbb-0000-4000-8000-000000000004';
  const at = NOW - 10000;
  const s = snap({
    codex: [
      session(PLANNER, { startedAt: NOW - HOUR }),
      session(CHILD, { parentKey: PLANNER, kind: 'agent', startedAt: NOW - HOUR }),
      // A sub-agent two levels down sends to "/root". One source marks it up, one marks it down.
      session(GRAND, {
        parentKey: CHILD,
        kind: 'agent',
        startedAt: NOW - HOUR,
        links: [
          { at, dir: 'up', other: PLANNER, label: 'Found the slow query' },
          { at: NOW - 20000, dir: 'down', other: PLANNER, label: 'Still looking' },
        ],
      }),
    ],
  });
  assert.deepEqual(s.events.map((e) => [e.kind, e.from, e.to, e.text]), [
    ['report', GRAND, PLANNER, 'Found the slow query'],
    ['report', GRAND, PLANNER, 'Still looking'],
  ]);
  for (const key of [CHILD, GRAND]) {
    const e = edgeTo(s, key);
    assert.equal(e.kind, 'spawn');
    assert.equal(e.lastUp, at, key);
    assert.equal(e.upLabel, 'Found the slow query', key);
    assert.equal(e.lastDown, null, key);
    assert.equal(e.active, 'up', key);
  }
  assert.equal(edgeTo(s, PLANNER).active, null);

  // A report to a hidden ancestor stays off the lines in between.
  const hidden = snap({
    codex: [
      session(PLANNER, { startedAt: NOW - HOUR }),
      session(CHILD, { parentKey: PLANNER, kind: 'agent', startedAt: NOW - HOUR }),
      session(GRAND, { parentKey: CHILD, kind: 'agent', links: [{ at, dir: 'up', other: PLANNER, label: 'Private note' }] }),
    ],
    settings: { people: { [PLANNER]: { role: 'hidden' } } },
  });
  assert.deepEqual(hidden.events, []);
  assert.equal(JSON.stringify(hidden).includes('Private note'), false);
});

test('a message a sub-agent keeps toward its own parent is a report up', () => {
  const s = snap({
    claude: [
      session(LEAD),
      session(HELPER, { parentKey: LEAD, kind: 'agent' }),
      session(NESTED, { parentKey: HELPER, kind: 'agent', links: [{ at: NOW - 3000, dir: 'down', other: HELPER, label: 'Done here' }] }),
    ],
  });
  assert.deepEqual(s.events, [{ at: NOW - 3000, kind: 'report', from: NESTED, to: HELPER, text: 'Done here' }]);
  assert.equal(edgeTo(s, NESTED).active, 'up');
  assert.equal(edgeTo(s, HELPER).active, null);
});

test('a message to a descendant goes down every edge in between and is not a spawn', () => {
  const at = NOW - 5000;
  const s = snap({
    claude: [
      session(LEAD, {
        links: [
          { at, dir: 'down', other: NESTED, label: 'Use the small fixture' },
          { at: NOW - 2000, dir: 'up', other: NESTED, label: 'Fixture ready' },
        ],
      }),
      session(HELPER, { parentKey: LEAD, kind: 'agent', startedAt: NOW - HOUR }),
      session(NESTED, { parentKey: HELPER, kind: 'agent', startedAt: at - 1000 }),
    ],
  });
  assert.deepEqual(s.events.map((e) => [e.kind, e.from, e.to, e.text]), [
    ['report', NESTED, LEAD, 'Fixture ready'],
    ['message', LEAD, NESTED, 'Use the small fixture'],
  ]);
  for (const key of [HELPER, NESTED]) {
    const e = edgeTo(s, key);
    assert.equal(e.lastDown, at, key);
    assert.equal(e.downLabel, 'Use the small fixture', key);
    assert.equal(e.lastUp, NOW - 2000, key);
    assert.equal(e.upLabel, 'Fixture ready', key);
    assert.equal(e.active, 'both', key);
  }
});

test('a message between relatives that are not in one line keeps its own direction', () => {
  const SIBLING = `${LEAD}/a1b2c3d4e5f60003`;
  const s = snap({
    claude: [
      session(LEAD),
      session(HELPER, { parentKey: LEAD, kind: 'agent', links: [{ at: NOW - 4000, dir: 'down', other: SIBLING, label: 'Your turn' }] }),
      session(SIBLING, { parentKey: LEAD, kind: 'agent', startedAt: NOW - HOUR }),
    ],
  });
  assert.deepEqual(s.events, [{ at: NOW - 4000, kind: 'message', from: HELPER, to: SIBLING, text: 'Your turn' }]);
  assert.ok(s.edges.every((e) => e.active === null));
});

test('a loop of parent links with hand-offs still finishes', () => {
  const s = snap({
    claude: [
      session(LEAD, { parentKey: OTHER, kind: 'agent', links: [{ at: NOW - 1000, dir: 'down', other: OTHER, label: 'Ping' }] }),
      session(OTHER, { parentKey: LEAD, kind: 'agent', links: [{ at: NOW - 900, dir: 'down', other: LEAD, label: 'Pong' }] }),
    ],
  });
  assert.equal(s.events.length, 2);
  assert.equal(s.nodes.length, 4);
});

test('hand-offs to an unknown codex agent path keep the known side', () => {
  const s = snap({
    codex: [session(PLANNER, { links: [{ at: NOW - 1000, dir: 'down', other: 'path:/root/worker_1', label: 'Check the docs' }] })],
  });
  assert.deepEqual(s.events, [{ at: NOW - 1000, kind: 'spawn', from: PLANNER, to: null, text: 'Check the docs' }]);
});

test('hand-offs with a hidden session or reviewer stay out of the feed', () => {
  const claude = [
    session(LEAD, { links: [{ at: NOW - 5000, dir: 'down', other: HELPER, label: 'Private helper job' }] }),
    session(HELPER, { parentKey: LEAD, kind: 'agent' }),
  ];
  const codex = [
    session(PLANNER, { links: [{ at: NOW - 4000, dir: 'down', other: REVIEWER, label: 'Review the plan' }] }),
    session(REVIEWER, { parentKey: PLANNER, kind: 'reviewer' }),
  ];
  const s = snap({ claude, codex, settings: { people: { [HELPER]: { role: 'hidden' } } } });
  assert.deepEqual(s.events, []);
  assert.equal(JSON.stringify(s).includes('Private helper job'), false);

  const shown = snap({ claude, codex, settings: { showReviewers: true } });
  assert.deepEqual(shown.events.map((e) => e.to), [REVIEWER, HELPER]);
});

test('bad links and sessions are skipped', () => {
  const s = snap({
    claude: [
      null,
      'session',
      { key: 'you', status: 'working', lastAt: NOW },
      { key: 'project:alpha', lastAt: NOW },
      session(LEAD, {
        status: 'busy',
        links: [null, { at: 'soon', dir: 'down', other: HELPER }, { at: NOW, dir: 'sideways', other: HELPER }, { at: NOW, dir: 'up' }],
      }),
      session(LEAD, { title: 'Duplicate' }),
    ],
  });
  assert.equal(s.counts.total, 1);
  assert.equal(node(s, LEAD).status, 'idle');
  assert.equal(node(s, LEAD).title, 'Session aaaaaaaa');
  assert.deepEqual(s.events, []);
});

test('a loop of parent links does not lose sessions', () => {
  const s = snap({
    claude: [
      session(LEAD, { parentKey: OTHER, kind: 'agent' }),
      session(OTHER, { parentKey: LEAD, kind: 'agent' }),
      session(HELPER, { parentKey: LEAD, kind: 'agent' }),
    ],
  });
  assert.equal(s.nodes.length, 5);
  assert.equal(node(s, LEAD).parent, 'project:alpha');
  assert.equal(node(s, OTHER).parent, LEAD);
  assert.equal(node(s, HELPER).parent, LEAD);
});

function mailbox(extra = {}) {
  return {
    ok: true,
    error: null,
    root: '/home/ada/mailbox',
    name: 'mailbox',
    tasks: [
      { id: 'T-1', title: 'Split the service', state: 'IN_PROGRESS', updatedAt: NOW - 2 * MIN, attention: ['question'], workers: [] },
      { id: 'T-2', title: 'Refund rules', state: 'IN_REVIEW', updatedAt: NOW - 3 * MIN, attention: ['review'], workers: [] },
      { id: 'T-3', title: 'Old work', state: 'DONE', updatedAt: NOW - HOUR, attention: [], workers: [] },
    ],
    events: [
      { at: NOW - 2 * MIN, dir: 'up', taskId: 'T-1', file: 'questions.md', title: 'Q1 Which tax year?' },
      { at: NOW - 10 * MIN, dir: 'down', taskId: 'T-1', file: 'assignment.md', title: 'Split the service' },
    ],
    relay: { running: true, paused: false, halted: false, coordinatorKey: LEAD },
    ...extra,
  };
}

test('mailbox events draw a line from the planner to the coordinator', () => {
  const s = snap({ ...cast(), mailbox: mailbox(), settings: { sources: { mailbox: { enabled: true, planner: PLANNER } } } });
  const line = s.edges.find((e) => e.kind === 'mailbox');
  assert.deepEqual(line, {
    from: PLANNER,
    to: LEAD,
    kind: 'mailbox',
    lastDown: NOW - 10 * MIN,
    lastUp: NOW - 2 * MIN,
    downLabel: 'T-1: Split the service',
    upLabel: 'T-1: Q1 Which tax year?',
    active: 'up',
  });
  const mail = s.events.filter((e) => e.kind === 'mailbox');
  assert.deepEqual(mail[0], { at: NOW - 2 * MIN, kind: 'mailbox', from: LEAD, to: PLANNER, text: 'T-1: Q1 Which tax year?' });
  assert.equal(mail[1].from, PLANNER);
  assert.deepEqual(s.sources.mailbox, { enabled: true, ok: true, error: null, count: 3 });
  assert.equal(s.tasks.length, 3);
});

test('a set coordinator wins over the relay, and no line is drawn without a planner', () => {
  const settings = { sources: { mailbox: { enabled: true, planner: PLANNER, coordinator: OTHER } } };
  const s = snap({ ...cast(), mailbox: mailbox(), settings });
  assert.equal(s.edges.find((e) => e.kind === 'mailbox').to, OTHER);

  const none = snap({ ...cast(), mailbox: mailbox() });
  assert.equal(none.edges.some((e) => e.kind === 'mailbox'), false);
  assert.equal(none.events.filter((e) => e.kind === 'mailbox')[0].from, LEAD);
  assert.equal(none.events.filter((e) => e.kind === 'mailbox')[0].to, null);
});

test('counts add up the listed sessions by status', () => {
  const s = snap({ ...cast() });
  assert.deepEqual(s.counts, { working: 2, ready: 2, idle: 0, done: 1, error: 1, needs: 0, total: 6 });
});

test('attention lists real asks, errors and mailbox tasks, newest first', () => {
  const s = snap({ ...cast(), mailbox: mailbox() });
  // A session that only finished a reply ("ready") is not waiting for anyone.
  assert.deepEqual(s.attention.map((a) => [a.key, a.kind]), [
    [OTHER, 'error'],
    ['task:T-1', 'question'],
    ['task:T-2', 'review'],
  ]);
  assert.equal(s.attention[0].text, 'Map tile cache stopped with an error.');
});

test('a session that asks, wants a plan approved, is blocked or wants input needs you', () => {
  const kinds = [['question', 'is asking you a question.'], ['plan', 'wants you to approve a plan.'],
    ['blocked', 'is blocked until you act.'], ['input', 'is asking for your input.']];
  for (const [kind, words] of kinds) {
    const s = snap({ claude: [session(LEAD, { title: 'Main lead', needs: { kind, text: 'Pick a **plan**', at: NOW - 1000 } })] });
    assert.deepEqual(node(s, LEAD).needs, { kind, text: 'Pick a plan', at: NOW - 1000 });
    assert.equal(s.counts.needs, 1);
    assert.deepEqual(s.attention.map((a) => [a.key, a.kind, a.text]), [[LEAD, 'needs', `Main lead ${words}`]]);
  }
  const hidden = snap({ claude: [session(LEAD, { needs: { kind: 'question', text: 'secret', at: NOW } })], settings: { content: 'none' } });
  assert.equal(node(hidden, LEAD).needs.text, null);
  const junk = snap({ claude: [session(LEAD, { needs: { kind: 'nope' } })] });
  assert.equal(node(junk, LEAD).needs, null);
  assert.equal(junk.attention.length, 0);
});

test('events are newest first, include errors and stop at 200', () => {
  const links = [];
  for (let i = 0; i < 50; i++) links.push({ at: NOW - (300 - i) * 1000, dir: i % 2 ? 'up' : 'down', other: HELPER, label: `Step ${i}` });
  const claude = [session(LEAD, { links }), session(HELPER, { parentKey: LEAD, kind: 'agent', startedAt: NOW - HOUR })];
  for (let n = 0; n < 5; n++) {
    const key = `claude:eeeeeeee-0000-4000-8000-00000000000${n}`;
    const child = `${key}/f${n}`;
    const many = [];
    for (let i = 0; i < 50; i++) many.push({ at: NOW - (1000 + i) * 1000, dir: 'down', other: child, label: null });
    claude.push(session(key, { links: many }), session(child, { parentKey: key, kind: 'agent' }));
  }
  claude.push(session(OTHER, { status: 'error', lastAt: NOW - 1, lastText: 'Crashed' }));
  const s = snap({ claude });
  assert.equal(s.events.length, 200);
  assert.deepEqual(s.events[0], { at: NOW - 1, kind: 'error', from: OTHER, to: null, text: 'Crashed' });
  for (let i = 1; i < s.events.length; i++) assert.ok(s.events[i - 1].at >= s.events[i].at);
});

test('content none removes snippets but keeps tool names', () => {
  const claude = [
    session(LEAD, {
      lastText: 'Working on refunds',
      activity: { tool: 'Bash', detail: 'npm test', at: NOW },
      links: [{ at: NOW - 1000, dir: 'down', other: HELPER, label: 'Write tests' }],
    }),
    session(HELPER, { parentKey: LEAD, kind: 'agent' }),
  ];
  const s = snap({ claude, mailbox: mailbox(), settings: { content: 'none', sources: { mailbox: { enabled: true, planner: LEAD } } } });
  assert.equal(node(s, LEAD).lastText, null);
  assert.deepEqual(node(s, LEAD).activity, { tool: 'Bash', detail: null, at: NOW });
  assert.equal(edgeTo(s, HELPER).downLabel, null);
  assert.ok(s.events.every((e) => e.text === null || /^T-\d$/.test(e.text)));
  // Task titles come from the assignment text, so they go too.
  assert.deepEqual(s.tasks.map((task) => task.title), ['T-1', 'T-2', 'T-3']);
  assert.equal(JSON.stringify(s.attention).includes('Split the service'), false);
  assert.equal(JSON.stringify(s).includes('Refund rules'), false);
});

function lastTextOf(lastText) {
  return node(snap({ claude: [session(LEAD, { lastText })] }), LEAD).lastText;
}

test('snippets turn Markdown into plain words', () => {
  const cases = [
    [
      '## Summary\n- **Fixed** the [refund bug](https://example.com/issues/12) in `refund.js`\n- See <https://docs.example.com/guide/refunds>',
      'Summary Fixed the refund bug in refund.js See docs.example.com',
    ],
    ['> __Note:__ tests   pass', 'Note: tests pass'],
    ['* one\n+ two\n  - three\n> - four', 'one two three four'],
    ['### Done\n---\nNext step', 'Done Next step'],
    ['![chart](https://example.com/c.png) is ready', 'chart is ready'],
    ['Read [the **guide**](https://example.com/a_(b)) first', 'Read the guide first'],
    ['See [the guide](https://example.com/gui', 'See the guide'],
    ['Keep `__init__` and ``a ** b`` as typed', 'Keep __init__ and a ** b as typed'],
    ['```js\nconst x = 1;\n```', 'js const x = 1;'],
    ['<http://localhost:8080/health> answered', 'localhost answered'],
  ];
  for (const [input, output] of cases) assert.equal(lastTextOf(input), output, input);
});

test('snippets leave ordinary text alone', () => {
  const cases = [
    'Use a < b and Array<string> here',
    'C# and F# are fine, so is issue #12',
    'It is -5 outside and 3 * 4 = 12',
    'A *single* star stays',
    'Generics like Map<K, V> stay',
    'snake_case and a_b_c stay',
  ];
  for (const input of cases) assert.equal(lastTextOf(input), input);
  assert.equal(lastTextOf('**  **'), null);
  assert.equal(lastTextOf(42), null);
});

test('snippets keep their length limits after Markdown is removed', () => {
  const long = lastTextOf('**word** '.repeat(200));
  assert.equal(long.includes('*'), false);
  assert.ok(Array.from(long).length <= 280 && long.length > 270, String(long.length));
  const huge = lastTextOf(`# Title\n${'x'.repeat(100000)}`);
  assert.equal(huge, `Title ${'x'.repeat(274)}`);
});

test('activity, hand-off, mailbox and attention text are plain words too', () => {
  const claude = [
    session(LEAD, {
      title: '**Main** lead',
      status: 'ready',
      activity: { tool: 'Bash', detail: '> Run `npm test`', at: NOW },
      links: [{ at: NOW - 1000, dir: 'down', other: HELPER, label: '- Write the **refund** tests' }],
    }),
    session(HELPER, { parentKey: LEAD, kind: 'agent' }),
    session(OTHER, { status: 'error', lastText: '## Failed\nSee [the log](https://example.com/log)' }),
  ];
  const box = mailbox();
  box.tasks[0].title = '__Split__ the [service](https://example.com/t1)';
  box.events[0].title = '**Q1** Which `tax` year?';
  const s = snap({ claude, mailbox: box, settings: { sources: { mailbox: { enabled: true, planner: PLANNER } } } });
  assert.deepEqual(node(s, LEAD).activity, { tool: 'Bash', detail: 'Run npm test', at: NOW });
  assert.equal(edgeTo(s, HELPER).downLabel, 'Write the refund tests');
  assert.ok(s.events.some((e) => e.from === LEAD && e.to === HELPER && e.text === 'Write the refund tests'));
  assert.ok(s.events.some((e) => e.kind === 'mailbox' && e.text === 'T-1: Q1 Which tax year?'));
  assert.ok(s.events.some((e) => e.kind === 'error' && e.text === 'Failed See the log'));
  const texts = s.attention.map((a) => a.text);
  assert.ok(texts.includes('Split the service has a question that is holding up work.'), texts.join(' | '));
});

test('odd mailbox tasks are skipped', () => {
  const box = mailbox();
  box.tasks = [null, 'T-9', { id: 7 }, { id: '' }, ...box.tasks];
  const s = snap({ mailbox: box });
  assert.deepEqual(s.tasks.map((task) => task.id), ['T-1', 'T-2', 'T-3']);
  assert.equal(s.sources.mailbox.count, 3);
});

test('sorting is by title, then key, and never by activity', () => {
  const titles = ['Agent 10', 'agent 2', 'Agent 1', 'Same', 'Same'];
  const kids = titles.map((title, i) => session(`${LEAD}/k${i}`, {
    parentKey: LEAD,
    kind: 'agent',
    title,
    lastAt: NOW - i * 1000,
    status: i % 2 ? 'working' : 'idle',
  }));
  const one = snap({ claude: [session(LEAD), ...kids] });
  const two = snap({ claude: [...kids].reverse().concat(session(LEAD)) });
  const order = one.nodes.filter((n) => n.parent === LEAD).map((n) => n.title + ' ' + n.key.slice(-2));
  assert.deepEqual(order, ['Agent 1 k2', 'agent 2 k1', 'Agent 10 k0', 'Same k3', 'Same k4']);
  assert.deepEqual(two, one);

  const busier = kids.map((k) => ({ ...k, status: 'working', lastAt: NOW, activity: { tool: 'Bash', detail: null, at: NOW } }));
  const three = snap({ claude: [session(LEAD), ...busier] });
  assert.deepEqual(three.nodes.map((n) => n.key), one.nodes.map((n) => n.key));
});

test('source info reports what each source said', () => {
  const s = buildSnapshot({
    now: NOW,
    settings: cleanSettings({}),
    claude: { ok: false, error: 'Pleni could not open the Claude folder.', root: '/home/ada/.claude', sessions: [] },
    codex: null,
    mailbox: null,
  });
  assert.deepEqual(s.sources.claude, { enabled: true, ok: false, error: 'Pleni could not open the Claude folder.', count: 0 });
  assert.deepEqual(s.sources.codex, { enabled: false, ok: true, error: null, count: 0 });
  assert.equal(s.sources.mailbox, null);
  assert.equal(s.tasks, null);
  assert.equal(s.version, 1);
  assert.equal(s.now, NOW);
  assert.deepEqual(s.nodes.map((n) => n.key), ['you']);
  assert.deepEqual(s.counts, { working: 0, ready: 0, idle: 0, done: 0, error: 0, needs: 0, total: 0 });
});

test('buildSnapshot copes with missing settings and sources', () => {
  const s = buildSnapshot({ now: NOW });
  assert.equal(s.nodes[0].title, 'You');
  assert.deepEqual(s.edges, []);
  assert.deepEqual(s.events, []);
  assert.deepEqual(s.attention, []);
});

test('a role a source knows sets the rank unless the person chose one', () => {
  const s = snap({ claude: [session(LEAD, { role: 'coordinator' }), session(OTHER, { role: 'boss' })], settings: { titles: 'military' } });
  assert.equal(node(s, LEAD).role, 'coordinator');
  assert.equal(node(s, LEAD).rank, 'Sergeant');
  assert.equal(node(s, OTHER).role, 'lead');
  const chosen = snap({ claude: [session(LEAD, { role: 'coordinator' })], settings: { people: { [LEAD]: { role: 'superintendent' } } } });
  assert.equal(node(chosen, LEAD).role, 'superintendent');
});
