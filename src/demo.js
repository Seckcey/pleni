// A made-up cast that moves on its own, for `node bin/pleni.js --demo`, screenshots and tests.
// Everything is worked out from the clock passed in: the same time always gives the same data.
import { cleanSettings } from './config.js';
import { parsePulls } from './github.js';

export const BEAT_MS = 4000;

const LOOP_BEATS = 24;
const HISTORY_BEATS = 96;
const DETAIL_BEATS = 40;
const MAX_LINKS = 50;
const MAX_DETAIL = 200;
const EPOCH_MS = 10 * 60000;
const MIN = 60000;

const HOME = '/home/ada';
const BILLING = `${HOME}/code/billing-service`;
const FIELD = `${HOME}/code/field-app`;

const PLANNER = 'codex:019a3f2e-7c41-7d20-9b6e-5a1c2d3e4f50';
const SCHEMA = 'codex:019a3f30-1b22-7e31-8c4d-6b2e3f405162';
const NOTES = 'codex:019a3f31-4d55-7a12-9f3e-7c3f40516273';
const REVIEWER = 'codex:019a3f33-8e66-7b43-a04f-8d4051627384';
const COORDINATOR = 'claude:5d0c9a4e-2b7f-4c1a-9e3d-6f8a1b2c3d4e';
const TESTS = `${COORDINATOR}/a3f1c9e2b7d45e01`;
const LAYOUT = `${COORDINATOR}/a7b2d4e6f8091a23`;
const LEDGER = `${COORDINATOR}/ac4e6f8091a2b3c4`;
const LOGIN = 'claude:9e8d7c6b-5a49-4382-a1b0-c9d8e7f6a5b4';
const OFFLINE = 'codex:019a3e10-2f77-7c54-b15a-9e5162738495';
const TILES = 'claude:3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f';
const RATES = 'grok:01a13b20-5c6d-7e8f-9a0b-1c2d3e4f5a6b';
const ROUNDING = 'kimi:7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
// Made-up GitHub repositories for the Pull requests view.
const GITHUB = { billing: 'example/billing-service', field: 'example/field-app' };
const TOOLS = ['claude', 'codex', 'grok', 'kimi'];
const ROOTS = { claude: '.claude', codex: '.codex', grok: '.grok', kimi: '.kimi-code' };

export const DEMO_KEYS = Object.freeze({ planner: PLANNER, coordinator: COORDINATOR });

// Made-up pull requests, shown when live GitHub status is turned on in the demo. `age` is minutes
// since the last change; `checks` are the results of the checks below, in order.
const PULLS = {
  [GITHUB.billing]: [
    { number: 42, title: 'Split the billing API into invoices and refunds', branch: 'refactor/billing-api', age: 3, checks: ['SUCCESS', 'SUCCESS', 'IN_PROGRESS'], review: 'REVIEW_REQUIRED', status: 'BLOCKED' },
    { number: 41, title: 'Add the 2027 sales tax table', branch: 'tax-table-2027', age: 50, checks: ['SUCCESS', 'SUCCESS', 'SUCCESS'], review: 'APPROVED', status: 'CLEAN' },
    { number: 40, title: 'Fix rounding in refund totals', branch: 'fix/refund-rounding', age: 300, state: 'MERGED', checks: ['SUCCESS', 'SUCCESS', 'SUCCESS'], review: 'APPROVED', status: 'UNKNOWN' },
  ],
  [GITHUB.field]: [
    { number: 17, title: 'Polish the login screen', branch: 'login-polish', age: 12, checks: ['SUCCESS', 'SUCCESS', 'SUCCESS'], review: 'APPROVED', status: 'CLEAN' },
    { number: 16, title: 'Try offline sync', branch: 'spike/offline-sync', age: 30, draft: true, checks: ['SUCCESS', 'FAILURE', 'SUCCESS'], review: '', status: 'DRAFT' },
  ],
};
const CHECK_NAMES = ['Test (ubuntu-latest, Node 22)', 'Test (windows-latest, Node 22)', 'Lint'];

// `start` and `end` are minutes before the current ten-minute mark; working sessions have no end.
const CAST = [
  {
    key: PLANNER, kind: 'session', title: 'Q4 billing plan', cwd: BILLING, branch: 'main',
    entrypoint: 'codex_cli_rs', model: 'gpt-6.1-astra', effort: 'high', status: 'working', start: 75,
    prompt: 'Plan the Q4 billing work and hand the tasks out.',
    tools: [
      ['exec', 'git log --oneline -20', '20 commits since the last release.'],
      ['exec', 'rg "invoice_id" src', 'Found 41 matches in 12 files.'],
      ['update_plan', null, 'Plan updated: 4 steps, 2 done.'],
    ],
    texts: ['Schema review is checking the invoice tables next.', 'T-101 is moving. Waiting on the index report.'],
  },
  {
    key: SCHEMA, parent: PLANNER, kind: 'agent', title: 'Schema review', cwd: BILLING, branch: 'main',
    entrypoint: 'codex_cli_rs', model: 'gpt-6.1-sol', effort: 'medium', status: 'working', start: 40,
    prompt: 'Review the invoice database schema',
    tools: [
      ['exec', 'Show the invoices table', 'invoices: 14 columns, 3 indexes.'],
      ['exec', 'Explain the slow invoice query', 'Seq scan on invoices (rows=1.2M).'],
    ],
    texts: ['The invoice query does a full table scan.', 'An index on (account_id, issued_at) should fix it.'],
  },
  {
    key: NOTES, parent: PLANNER, kind: 'agent', title: 'Release notes draft', cwd: BILLING, branch: 'main',
    entrypoint: 'codex_cli_rs', model: 'gpt-6.1-luna', effort: 'low', status: 'done', start: 60, end: 35,
    prompt: 'Draft the release notes for 4.2', last: 'The release notes draft is in docs/release-4.2.md.',
  },
  {
    key: REVIEWER, parent: PLANNER, kind: 'reviewer', title: 'Automatic review', cwd: BILLING, branch: 'main',
    entrypoint: 'codex_cli_rs', model: 'codex-auto-review', effort: null, status: 'done', start: 30, end: 28,
    prompt: 'Review the plan change', last: 'No problems found.',
  },
  {
    key: COORDINATOR, kind: 'session', title: 'Billing API refactor', cwd: BILLING, branch: 'refactor/billing-api',
    entrypoint: 'claude-desktop', model: 'claude-opus-5-5', effort: 'high', status: 'working', start: 90,
    prompt: 'Refactor the billing API into smaller services. Use sub-agents for the tests.',
    tools: [
      ['Read', 'invoice_service.ts', 'Read 412 lines.'],
      ['Bash', 'Run the billing tests', '128 passed, 0 failed.'],
      ['Edit', 'refunds.ts', 'Updated 3 lines.'],
      ['Agent', 'Refund endpoint tests', 'Started a helper.'],
    ],
    texts: ['The invoice service is split in two. Refunds are next.', 'Tests pass. Moving the PDF code into its own module.'],
    // A long session, so the demo shows "Roll over soon".
    context: { used: 690000, size: 780000, squeezes: 3, squeezedAgo: 140 },
  },
  {
    key: TESTS, parent: COORDINATOR, kind: 'agent', title: 'Refund endpoint tests', cwd: BILLING,
    branch: 'refactor/billing-api', entrypoint: 'claude-desktop', model: 'claude-sonnet-5-5', effort: null,
    status: 'working', start: 25, prompt: 'Write tests for the refund endpoint',
    tools: [
      ['Write', 'refunds.test.ts', 'Wrote 86 lines.'],
      ['Bash', 'Run the refund tests', '9 passed, 0 failed.'],
      ['Grep', 'partial_refund', 'Found 6 matches.'],
    ],
    texts: ['Partial refunds are covered. Full refunds next.', 'All refund tests pass.'],
  },
  {
    key: LAYOUT, parent: COORDINATOR, kind: 'agent', title: 'Invoice PDF layout', cwd: BILLING,
    branch: 'refactor/billing-api', entrypoint: 'claude-desktop', model: 'claude-sonnet-5-5', effort: null,
    status: 'ready', start: 30, end: 2, prompt: 'Lay out the new invoice PDF',
    last: 'The first layout draft is ready for a look.',
  },
  {
    key: LEDGER, parent: COORDINATOR, kind: 'agent', title: 'Ledger migration check', cwd: BILLING,
    branch: 'refactor/billing-api', entrypoint: 'claude-desktop', model: 'claude-haiku-5-5', effort: null,
    status: 'done', start: 50, end: 8, prompt: 'Check that the ledger migration is safe to run twice',
    last: 'The migration is safe to run twice.',
  },
  {
    key: LOGIN, kind: 'session', title: 'Login screen polish', cwd: `${FIELD}/.claude/worktrees/login-polish`,
    branch: 'login-polish', entrypoint: 'claude-vscode', model: 'claude-sonnet-5-5', effort: 'medium',
    status: 'ready', start: 45, end: 4, prompt: 'Tidy up the login screen spacing and error text.',
    last: 'The login screen is done. Should I open a pull request or keep polishing?',
    ask: { kind: 'question', text: 'Open a pull request now, or keep polishing?' },
  },
  {
    key: OFFLINE, kind: 'session', title: 'Offline sync spike', cwd: `${HOME}/.codex/worktrees/7f3a/field-app`,
    branch: 'spike/offline-sync', entrypoint: 'codex_cli_rs', model: 'gpt-6.1-sol', effort: 'medium',
    status: 'error', start: 40, end: 6, prompt: 'Try a quick offline sync for the field app.',
    last: 'The sync test server did not start in time.',
  },
  {
    key: RATES, kind: 'session', title: 'Sales tax research', cwd: BILLING, branch: 'main', entrypoint: null,
    model: 'grok-4.7', effort: 'high', status: 'ready', start: 35, end: 3,
    prompt: 'Find the sales tax changes coming next year in our three states.',
    last: 'Two of the three states change their rates next year. My notes are in docs/tax-rates.md.',
  },
  {
    key: ROUNDING, kind: 'session', title: 'Currency rounding check', cwd: FIELD, branch: 'main', entrypoint: null,
    model: 'k3', effort: 'max', status: 'working', start: 20,
    prompt: 'Check that every price is rounded the same way.',
    tools: [
      ['Grep', 'Math.round', 'Found 14 matches in 6 files.'],
      ['ReadFile', 'currency.ts', 'Read 210 lines.'],
      ['Bash', 'Run the money tests', '52 passed, 0 failed.'],
    ],
    texts: ['Two screens round prices down instead of to the nearest cent.', 'The cart and the receipt now round the same way.'],
  },
  {
    key: TILES, kind: 'session', title: 'Map tile cache', cwd: FIELD, branch: 'main', entrypoint: 'cli',
    model: 'claude-opus-5-5', effort: 'low', status: 'idle', start: 140, end: 95,
    prompt: 'Check the map tile cache sizes.', last: 'Cache sizes look fine. Nothing else to do here.',
  },
];

const BY_KEY = new Map(CAST.map((member) => [member.key, member]));

// Hand-offs that happen once per spawn: the spawn itself and, for finished helpers, the report.
const SPAWNS = {
  [SCHEMA]: 'Review the invoice database schema',
  [NOTES]: 'Draft the release notes for 4.2',
  [REVIEWER]: 'Review the plan change',
  [TESTS]: 'Write tests for the refund endpoint',
  [LAYOUT]: 'Lay out the new invoice PDF',
  [LEDGER]: 'Check the ledger migration',
};

// One loop of hand-offs; the number is the beat inside the loop.
const SCRIPT = [
  { beat: 0, parent: COORDINATOR, child: TESTS, dir: 'down', label: 'Add tests for partial refunds' },
  { beat: 3, parent: PLANNER, child: SCHEMA, dir: 'down', label: 'Check the invoice table indexes' },
  { beat: 5, mail: 'down', taskId: 'T-101', file: 'answers.md', title: 'Answer: keep the old PDF route' },
  { beat: 8, parent: COORDINATOR, child: TESTS, dir: 'up', label: 'Partial refund tests pass' },
  { beat: 11, parent: PLANNER, child: SCHEMA, dir: 'up', label: 'Two indexes are missing' },
  { beat: 13, mail: 'up', taskId: 'T-101', file: 'status.md', title: 'Status: the invoice split is half done' },
  { beat: 16, parent: COORDINATOR, child: TESTS, dir: 'down', label: 'Now cover full refunds' },
  { beat: 19, parent: PLANNER, child: SCHEMA, dir: 'down', label: 'Draft the index change' },
  { beat: 21, mail: 'up', taskId: 'T-102', file: 'handoff.md', title: 'Hand-off: refund rules are ready' },
];

// Mailbox entries that happened once, in minutes before the ten-minute mark.
const MAIL_HISTORY = [
  { ago: 85, dir: 'down', taskId: 'T-100', file: 'assignment.md', title: 'Ledger cleanup' },
  { ago: 55, dir: 'up', taskId: 'T-100', file: 'handoff.md', title: 'Hand-off: ledger cleanup done' },
  { ago: 50, dir: 'down', taskId: 'T-100', file: 'review.md', title: 'Review: approved' },
  { ago: 48, dir: 'down', taskId: 'T-102', file: 'assignment.md', title: 'Refund rules for partial orders' },
  { ago: 40, dir: 'down', taskId: 'T-103', file: 'assignment.md', title: 'Tax table update' },
  { ago: 32, dir: 'down', taskId: 'T-101', file: 'assignment.md', title: 'Split the invoice service' },
  { ago: 20, dir: 'up', taskId: 'T-103', file: 'questions.md', title: 'Q1: Which tax year should the table use?' },
];

const TASKS = [
  { id: 'T-100', title: 'Ledger cleanup', state: 'DONE', attention: [], worker: { model: 'claude-haiku-5-5', start: 80, end: 56 } },
  { id: 'T-101', title: 'Split the invoice service', state: 'IN_PROGRESS', attention: [], worker: { model: 'claude-sonnet-5-5', start: 30 } },
  { id: 'T-102', title: 'Refund rules for partial orders', state: 'IN_REVIEW', attention: ['review'] },
  { id: 'T-103', title: 'Tax table update', state: 'BLOCKED', attention: ['question'] },
];

export function createDemoSource({ now = Date.now } = {}) {
  return {
    poll() {
      const clock = clockAt(now());
      const { handoffs, mail } = history(clock);
      const sessions = CAST.map((member) => session(member, clock, handoffs));
      const read = (name) => ({ ok: true, error: null, root: `${HOME}/${ROOTS[name]}`, sessions: sessions.filter((s) => s.platform === name) });
      return { ...Object.fromEntries(TOOLS.map((name) => [name, read(name)])), mailbox: mailbox(clock, mail) };
    },
    detail(key, since) {
      const member = BY_KEY.get(key);
      if (!member) return { events: [], next: null };
      // The demo has no files, so its cursor is the time of the last event sent.
      const cursor = typeof since === 'number' && Number.isFinite(since) && since >= 0 ? since : null;
      const events = detailEvents(member, clockAt(now()))
        .filter((event) => cursor === null || event.at > cursor)
        .slice(-MAX_DETAIL);
      return { events, next: events.length ? events[events.length - 1].at : cursor };
    },
  };
}

// The answer GET /api/github gives in the demo, in the same shape as src/github.js gives it.
export function demoGithub(repos, now = Date.now()) {
  return {
    error: null,
    repos: repos
      .filter((repo) => Object.hasOwn(PULLS, repo))
      .sort()
      .map((repo) => ({ repo, at: now, error: null, pulls: parsePulls(JSON.stringify(PULLS[repo].map((p) => ghPull(p, now))), repo) })),
  };
}

// One made-up pull request as `gh pr list --json` gives it.
function ghPull(p, now) {
  return {
    number: p.number,
    title: p.title,
    state: p.state ?? 'OPEN',
    isDraft: p.draft === true,
    headRefName: p.branch,
    headRefOid: String(p.number).padStart(4, '0').repeat(10),
    baseRefName: 'main',
    isCrossRepository: false,
    updatedAt: new Date(now - p.age * MIN).toISOString(),
    reviewDecision: p.review,
    mergeable: p.state ? 'UNKNOWN' : 'MERGEABLE',
    mergeStateStatus: p.status,
    statusCheckRollup: p.checks.map((result, i) => ({
      __typename: 'CheckRun',
      name: CHECK_NAMES[i],
      status: result === 'IN_PROGRESS' ? 'IN_PROGRESS' : 'COMPLETED',
      conclusion: result === 'IN_PROGRESS' ? '' : result,
    })),
  };
}

// The demo's own people and mailbox wiring, so ranks and the mailbox line show up without setup.
export function demoSettings(settings) {
  const clean = cleanSettings(settings);
  clean.sources.mailbox.planner = PLANNER;
  clean.sources.mailbox.coordinator = COORDINATOR;
  for (const [key, role] of [[PLANNER, 'superintendent'], [COORDINATOR, 'coordinator']]) {
    clean.people[key] = { ...clean.people[key], role: clean.people[key]?.role || role };
  }
  return clean;
}

// `beat` is the current 4-second step; `mark` is the current ten-minute mark.
function clockAt(time) {
  const t = Number.isFinite(time) ? time : 0;
  const beat = Math.floor(t / BEAT_MS);
  return { beat, beatAt: beat * BEAT_MS, mark: Math.floor(t / EPOCH_MS) * EPOCH_MS };
}

function startOf(member, clock) {
  return clock.mark - member.start * MIN;
}

function endOf(member, clock) {
  return member.status === 'working' ? clock.beatAt : clock.mark - member.end * MIN;
}

function history(clock) {
  const handoffs = [];
  const mail = MAIL_HISTORY.map(({ ago, ...rest }) => ({ at: clock.mark - ago * MIN, ...rest }));
  for (const member of CAST) {
    if (!member.parent) continue;
    const started = startOf(member, clock);
    handoffs.push({ at: started - 2000, parent: member.parent, child: member.key, dir: 'down', label: SPAWNS[member.key] });
    if (member.status !== 'working') {
      handoffs.push({ at: endOf(member, clock), parent: member.parent, child: member.key, dir: 'up', label: member.last });
    }
  }
  for (let beat = Math.max(0, clock.beat - HISTORY_BEATS); beat <= clock.beat; beat++) {
    const at = beat * BEAT_MS;
    for (const step of SCRIPT) {
      if (step.beat !== beat % LOOP_BEATS) continue;
      if (step.mail) mail.push({ at, dir: step.mail, taskId: step.taskId, file: step.file, title: step.title });
      else handoffs.push({ at, parent: step.parent, child: step.child, dir: step.dir, label: step.label });
    }
  }
  return { handoffs, mail };
}

function session(member, clock, handoffs) {
  const live = member.status === 'working';
  const tool = live ? member.tools[clock.beat % member.tools.length] : null;
  const loop = Math.floor(clock.beat / LOOP_BEATS);
  const links = handoffs
    .filter((h) => h.parent === member.key)
    .sort((a, b) => a.at - b.at)
    .slice(-MAX_LINKS)
    .map((h) => ({ at: h.at, dir: h.dir, other: h.child, label: h.label }));
  return {
    platform: member.key.slice(0, member.key.indexOf(':')),
    key: member.key,
    id: member.key.slice(member.key.lastIndexOf(member.key.includes('/') ? '/' : ':') + 1),
    parentKey: member.parent ?? null,
    kind: member.kind,
    title: member.title,
    titleSource: 'demo',
    cwd: member.cwd,
    branch: member.branch,
    github: GITHUB[member.cwd.startsWith(FIELD) || member.cwd.includes('field-app') ? 'field' : 'billing'],
    entrypoint: member.entrypoint,
    model: member.model,
    effort: member.effort,
    startedAt: startOf(member, clock),
    lastAt: endOf(member, clock),
    status: member.status,
    activity: live ? { tool: tool[0], detail: tool[1], at: clock.beatAt } : null,
    lastText: live ? member.texts[loop % member.texts.length] : member.last,
    needs: member.ask ? { ...member.ask, at: endOf(member, clock) } : null,
    links,
    archived: false,
    context: member.context
      ? { used: member.context.used, size: member.context.size, squeezes: member.context.squeezes, squeezesAtLeast: false, squeezedAt: clock.mark - member.context.squeezedAgo * MIN }
      : null,
  };
}

function mailbox(clock, mail) {
  const events = mail.sort((a, b) => b.at - a.at).slice(0, 300);
  const tasks = TASKS.map((task) => {
    const newest = events.find((event) => event.taskId === task.id);
    const worker = task.worker && {
      id: 'W1',
      state: task.worker.end ? 'done' : 'running',
      model: task.worker.model,
      startedAt: clock.mark - task.worker.start * MIN,
      finishedAt: task.worker.end ? clock.mark - task.worker.end * MIN : null,
    };
    return {
      id: task.id,
      title: task.title,
      state: task.state,
      updatedAt: newest ? newest.at : null,
      attention: [...task.attention],
      workers: worker ? [worker] : [],
    };
  });
  return {
    ok: true,
    error: null,
    root: `${HOME}/mailboxes/billing`,
    name: 'billing',
    tasks,
    events,
    // A note the coordinator left for the person, in NEEDS-ADA.md at the mailbox root.
    notes: [{ file: 'NEEDS-ADA.md', count: 1, at: clock.mark - 12 * MIN, text: 'Approve the new tax-rate source before W1 ships the change.' }],
    relay: {
      running: true, paused: false, halted: false, coordinatorKey: COORDINATOR,
      lastAt: clock.beatAt, pausedAt: null, haltReason: null, alerts: null,
    },
  };
}

// The side drawer's recent events, oldest first.
function detailEvents(member, clock) {
  const startedAt = startOf(member, clock);
  const events = [{ at: startedAt, kind: 'user', tool: null, text: member.prompt }];
  if (member.status !== 'working') {
    const lastAt = endOf(member, clock);
    const step = Math.max(1000, Math.floor((lastAt - startedAt) / 5));
    events.push(
      { at: startedAt + step, kind: 'thinking', tool: null, text: null },
      { at: startedAt + 2 * step, kind: 'tool', tool: 'Read', text: 'README.md' },
      { at: startedAt + 3 * step, kind: 'result', tool: 'Read', text: 'Read 120 lines.' },
      member.status === 'error'
        ? { at: lastAt, kind: 'error', tool: null, text: member.last }
        : { at: lastAt, kind: 'assistant', tool: null, text: member.last },
    );
    return events;
  }
  for (let beat = clock.beat - DETAIL_BEATS + 1; beat <= clock.beat; beat++) {
    const at = beat * BEAT_MS;
    if (at <= startedAt) continue;
    const [tool, detail, result] = member.tools[Math.floor(beat / 4) % member.tools.length];
    const text = member.texts[Math.floor(beat / LOOP_BEATS) % member.texts.length];
    const step = beat % 4;
    if (step === 0) events.push({ at, kind: 'thinking', tool: null, text: null });
    else if (step === 1) events.push({ at, kind: 'tool', tool, text: detail });
    else if (step === 2) events.push({ at, kind: 'result', tool, text: result });
    else events.push({ at, kind: 'assistant', tool: null, text });
  }
  return events;
}
