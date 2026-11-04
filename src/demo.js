// A made-up cast that moves on its own, for `node bin/pleni.js --demo`, screenshots and tests.
// Everything is worked out from the clock passed in: the same time always gives the same data.
import { cleanSettings } from './config.js';
import { parseTasks } from './cloud.js';
import { parsePulls } from './github.js';
import { lastDays } from './usage.js';

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
// The demo's mailboxes: an HQ, whose orchestrator plans two projects, each with a mailbox, a relay
// and a coordinator of its own (made with the relay's -NewProject, in HQ's projects folder).
const HQ = `${HOME}/hq`;

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
const HELP_PAGES = 'gemini:4b5c6d7e-8f90-4a1b-9c2d-3e4f5a6b7c8d';
const SCREENSHOTS = `${HELP_PAGES}/codebase_investigator-5e6f`;
const FIELD_LEAD = 'claude:6e1f2a3b-4c5d-4e6f-8a7b-9c0d1e2f3a4b';
const DOWNLOADS = 'claude:7f2a3b4c-5d6e-4f70-8a9b-0c1d2e3f4a5c';
// Made-up GitHub repositories for the Pull requests view.
const GITHUB = { billing: 'example/billing-service', field: 'example/field-app' };
const TOOLS = ['claude', 'codex', 'grok', 'kimi', 'gemini'];
const ROOTS = { claude: '.claude', codex: '.codex', grok: '.grok', kimi: '.kimi-code', gemini: '.gemini' };

// The planner is HQ's orchestrator; the coordinator runs the Billing service project mailbox.
export const DEMO_KEYS = Object.freeze({ planner: PLANNER, coordinator: COORDINATOR, fieldCoordinator: FIELD_LEAD });

// Made-up pull requests, shown when live GitHub status is turned on in the demo. `age` is minutes
// since the last change; `checks` are the results of the checks below, in order.
const PULLS = {
  [GITHUB.billing]: [
    { number: 43, title: 'Add late fee rules to invoices', branch: 'claude/late-fee-rules-k2p7', age: 25, checks: ['SUCCESS', 'SUCCESS', 'SUCCESS'], review: 'REVIEW_REQUIRED', status: 'BLOCKED' },
    { number: 42, title: 'Split the billing API into invoices and refunds', branch: 'refactor/billing-api', age: 3, checks: ['SUCCESS', 'SUCCESS', 'IN_PROGRESS'], review: 'REVIEW_REQUIRED', status: 'BLOCKED' },
    { number: 41, title: 'Add the 2027 sales tax table', branch: 'tax-table-2027', age: 50, checks: ['SUCCESS', 'SUCCESS', 'SUCCESS'], review: 'APPROVED', status: 'CLEAN' },
    { number: 40, title: 'Fix rounding in refund totals', branch: 'fix/refund-rounding', age: 300, state: 'MERGED', checks: ['SUCCESS', 'SUCCESS', 'SUCCESS'], review: 'APPROVED', status: 'UNKNOWN' },
  ],
  [GITHUB.field]: [
    { number: 17, title: 'Polish the login screen', branch: 'login-polish', age: 12, checks: ['SUCCESS', 'SUCCESS', 'SUCCESS'], review: 'APPROVED', status: 'CLEAN' },
    { number: 18, title: 'Cache map tiles for offline use', branch: 'claude/offline-map-tiles-q9d4', age: 140, draft: true, checks: ['SUCCESS', 'IN_PROGRESS', 'SUCCESS'], review: '', status: 'DRAFT' },
    { number: 16, title: 'Try offline sync', branch: 'spike/offline-sync', age: 30, draft: true, checks: ['SUCCESS', 'FAILURE', 'SUCCESS'], review: '', status: 'DRAFT' },
  ],
};
const CHECK_NAMES = ['Test (ubuntu-latest, Node 22)', 'Test (windows-latest, Node 22)', 'Lint'];

// `start` and `end` are minutes before the current ten-minute mark; working sessions have no end.
const CAST = [
  {
    key: PLANNER, kind: 'session', title: 'Orchestrator', cwd: HQ, branch: null,
    entrypoint: 'codex_cli_rs', model: 'gpt-6.1-astra', effort: 'high', status: 'working', start: 75,
    prompt: 'Plan the Q4 work of every project and hand the tasks out.',
    tools: [
      ['exec', 'Read the Billing service status', 'T-101 is half done. T-102 waits for a review.'],
      ['exec', 'Read the Field app status', 'T-201 has two workers.'],
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
    branch: 'refactor/billing-api', entrypoint: 'claude-desktop', model: 'claude-sonnet-5-5', effort: 'medium',
    workerType: 'general-purpose', chosen: { model: true, effort: true },
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
    branch: 'refactor/billing-api', entrypoint: 'claude-desktop', model: 'claude-opus-5-5', effort: 'high',
    // Started without a pick, so it runs on its sergeant's model and effort.
    workerType: 'general-purpose', chosen: { model: false, effort: false },
    status: 'ready', start: 30, end: 2, prompt: 'Lay out the new invoice PDF',
    last: 'The first layout draft is ready for a look.',
  },
  {
    key: LEDGER, parent: COORDINATOR, kind: 'agent', title: 'Ledger migration check', cwd: BILLING,
    branch: 'refactor/billing-api', entrypoint: 'claude-desktop', model: 'claude-haiku-5-5', effort: 'high',
    workerType: 'Explore', chosen: { model: true, effort: false },
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
    key: HELP_PAGES, kind: 'session', title: 'Help pages refresh', cwd: FIELD, branch: 'main', entrypoint: null,
    model: 'gemini-3-pro-preview', effort: null, status: 'working', start: 28,
    prompt: 'Bring the help pages up to date with the new login screen.',
    tools: [
      ['ReadFile', 'login-help.md', 'Read 64 lines.'],
      ['Shell', 'Build the help pages', 'Built 12 pages.'],
      ['WriteFile', 'login-help.md', 'Wrote 70 lines.'],
    ],
    texts: ['The login help page still shows the old buttons.', 'The help pages now match the new login screen.'],
  },
  {
    key: SCREENSHOTS, parent: HELP_PAGES, kind: 'agent', title: 'Find the old screenshots', cwd: FIELD, branch: 'main',
    entrypoint: null, model: 'gemini-3-flash-preview', effort: null, status: 'done', start: 24, end: 14,
    prompt: 'Find every help page that shows the old login screen.',
    last: 'Three help pages show the old login screen: login-help.md, first-run.md and faq.md.',
  },
  {
    key: TILES, kind: 'session', title: 'Map tile cache', cwd: FIELD, branch: 'main', entrypoint: 'cli',
    model: 'claude-opus-5-5', effort: 'low', status: 'idle', start: 140, end: 95,
    prompt: 'Check the map tile cache sizes.', last: 'Cache sizes look fine. Nothing else to do here.',
  },
  // The Field app project mailbox's coordinator, which its relay wakes, and its worker W2.
  {
    key: FIELD_LEAD, kind: 'session', title: 'Field app coordinator', cwd: `${HQ}/projects/field-app`, branch: null,
    entrypoint: 'cli', model: 'claude-opus-5-5', effort: 'high', status: 'working', start: 55,
    prompt: 'Read the Field app mailbox and run task T-201.',
    tools: [
      ['Read', 'assignment.md', 'Read 38 lines.'],
      ['Bash', 'Check on the W2 worker', 'W2 is still running.'],
      ['Edit', 'status.md', 'Updated 2 lines.'],
    ],
    texts: ['W1 finished the tile cache. W2 is on the download screen.', 'T-201 is moving. W2 should be done soon.'],
  },
  {
    key: DOWNLOADS, kind: 'session', title: 'Download screen', cwd: `${FIELD}/.claude/worktrees/t-201`, branch: 'claude/T-201',
    entrypoint: 'sdk-cli', model: 'claude-sonnet-5-5', effort: 'medium', status: 'working', start: 15,
    prompt: 'Build the screen that downloads map tiles for offline use.',
    tools: [
      ['Write', 'download-screen.tsx', 'Wrote 120 lines.'],
      ['Bash', 'Run the screen tests', '14 passed, 0 failed.'],
      ['Edit', 'tile-store.ts', 'Updated 6 lines.'],
    ],
    texts: ['The download screen shows each area and its size.', 'Downloads pause and go on again when the phone sleeps.'],
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
  [SCREENSHOTS]: 'Find the help pages with old screenshots',
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

// Agent mail (relay/bin/agent-mail.ps1), in HQ: sessions and the person write to each other by
// name. HQ's relay wakes the orchestrator when mail waits for it. `read` is how many beats a message
// waits.
const MAIL_AGENTS = [
  { key: 'orchestrator', name: 'Orchestrator', thread: PLANNER },
  { key: 'sales-tax-research', name: 'Sales tax research', thread: null },
  { key: 'ada', name: 'Ada', thread: null },
];
const MAIL_NAMES = new Map(MAIL_AGENTS.map((a) => [a.key, a.name]));
const LETTERS = [
  { ago: 34, from: 'orchestrator', to: 'sales-tax-research', text: 'Find the sales tax changes coming next year in our three states.' },
  {
    ago: 6, from: 'sales-tax-research', to: 'ada', unread: true,
    text: 'Two of our three states change their sales tax next year:\n\n- North: 6.5% from January 1\n- South: 7% from July 1\n\nShould I update the tax table now, or wait for T-103?',
  },
  { ago: 52, from: 'ada', to: 'sales-tax-research', text: 'Please find the sales tax changes coming next year in our three states, and tell me before you change anything.' },
];
const LETTER_SCRIPT = [
  { beat: 6, from: 'orchestrator', to: 'sales-tax-research', read: 4, text: 'Which of the rate changes start in January?' },
  { beat: 10, from: 'sales-tax-research', to: 'orchestrator', read: 2, text: 'Both of them. The dates are in docs/tax-rates.md.' },
  { beat: 18, from: 'ada', to: 'sales-tax-research', read: 3, text: 'Thanks. Wait for T-103 before you change the table.' },
];

// The Billing service project mailbox's tasks.
const TASKS = [
  { id: 'T-100', title: 'Ledger cleanup', state: 'DONE', attention: [], workers: [{ id: 'W1', model: 'claude-haiku-5-5', start: 80, end: 56 }] },
  { id: 'T-101', title: 'Split the invoice service', state: 'IN_PROGRESS', attention: [], workers: [{ id: 'W1', model: 'claude-sonnet-5-5', start: 30 }] },
  { id: 'T-102', title: 'Refund rules for partial orders', state: 'IN_REVIEW', attention: ['review'] },
  { id: 'T-103', title: 'Tax table update', state: 'BLOCKED', attention: ['question'] },
];

// The Field app project mailbox: one task with two workers, W2 a Claude Code session of its own.
const FIELD_TASKS = [
  {
    id: 'T-201', title: 'Offline map tiles', state: 'IN_PROGRESS', attention: [],
    workers: [{ id: 'W1', model: 'claude-sonnet-5-5', start: 50, end: 20 }, { id: 'W2', model: 'claude-sonnet-5-5', start: 15, session: DOWNLOADS }],
  },
];
const FIELD_HISTORY = [
  { ago: 58, dir: 'down', taskId: 'T-201', file: 'assignment.md', title: 'Offline map tiles' },
  { ago: 52, dir: 'up', taskId: 'T-201', file: 'status.md', title: 'Status: accepted, W1 is on the tile cache' },
];
const FIELD_SCRIPT = [
  { beat: 2, dir: 'up', taskId: 'T-201', file: 'status.md', title: 'Status: W2 started the download screen' },
  { beat: 9, dir: 'up', taskId: 'T-201', file: 'questions.md', title: 'Q1: Keep the tiles for 7 or 30 days?' },
  { beat: 15, dir: 'down', taskId: 'T-201', file: 'answers.md', title: 'A1: Keep them for 30 days' },
];

// HQ's own board: work with no project.
const HQ_TASKS = [{ id: 'T-001', title: 'Pick the Q4 projects', state: 'DONE', attention: [] }];
const HQ_HISTORY = [
  { ago: 130, dir: 'down', taskId: 'T-001', file: 'assignment.md', title: 'Pick the Q4 projects' },
  { ago: 110, dir: 'down', taskId: 'T-001', file: 'review.md', title: 'Review: done, two projects' },
];
// HQ's relay wakes the orchestrator a moment after something new waits for it in a project.
const PLANNER_WAKES = [{ beat: 10, count: 1 }, { beat: 22, count: 1 }];
// The two project mailboxes, in HQ's bin/relay-settings.json order.
const PROJECTS = [
  { id: 'billing', name: 'Billing service', folder: `${HQ}/projects/billing` },
  { id: 'field-app', name: 'Field app', folder: `${HQ}/projects/field-app` },
];

export function createDemoSource({ now = Date.now } = {}) {
  return {
    poll() {
      const clock = clockAt(now());
      const past = history(clock);
      const sessions = CAST.map((member) => session(member, clock, past.handoffs));
      const read = (name) => ({ ok: true, error: null, root: `${HOME}/${ROOTS[name]}`, sessions: sessions.filter((s) => s.platform === name) });
      return { ...Object.fromEntries(TOOLS.map((name) => [name, read(name)])), mailbox: hqMailbox(clock, past) };
    },
    // The Mail page's messages, in the shape src/sources/mailbox.js gives them.
    mail({ keys = [], all = false } = {}) {
      const mine = new Set(keys);
      return history(clockAt(now())).letters
        .filter((m) => all || mine.has(m.to) || mine.has(m.from))
        .sort((a, b) => b.at - a.at)
        .slice(0, 100)
        .map((m) => ({
          id: `${m.to}/${m.unread ? 'new' : 'read'}/${m.at}-${m.from}`,
          to: m.to,
          toName: MAIL_NAMES.get(m.to) ?? null,
          from: m.from,
          fromName: MAIL_NAMES.get(m.from) ?? null,
          at: m.at,
          unread: m.unread,
          text: m.text,
          // The demo's mail is in HQ's mailbox.
          box: 'hq',
          boxName: 'HQ',
        }));
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

// Made-up Codex cloud tasks, as `codex cloud list --json` writes them: every status once.
const CLOUD_TASKS = [
  { id: 'task_demo_a1', title: 'Add a refund note to the invoice email', status: 'pending', age: 4, env: 'billing-service', files: 2, added: 31, removed: 4, review: false, tries: 1 },
  { id: 'task_demo_b2', title: 'Fix the rounding in the monthly invoice total', status: 'ready', age: 95, env: 'billing-service', files: 3, added: 120, removed: 14, review: true, tries: 2 },
  { id: 'task_demo_c3', title: 'Show the sync time on the field app home screen', status: 'applied', age: 60 * 26, env: 'field-app', files: 1, added: 18, removed: 2, review: true, tries: 1 },
  { id: 'task_demo_d4', title: 'Speed up the offline photo upload', status: 'error', age: 60 * 50, env: 'field-app', files: null, added: null, removed: null, review: false, tries: 3 },
  { id: 'task_demo_e5', title: 'Write tests for the late fee rules', status: 'ready', age: 60 * 80, env: 'billing-service', files: 4, added: 210, removed: 0, review: false, tries: 1 },
];

// The answer GET /api/cloud gives in the demo, in the same shape as src/cloud.js gives it.
export function demoCloud(now = Date.now()) {
  const raw = CLOUD_TASKS.map((t) => ({
    id: t.id,
    url: `https://chatgpt.com/codex/tasks/${t.id}`,
    title: t.title,
    status: t.status,
    updated_at: new Date(now - t.age * MIN).toISOString(),
    environment_id: null,
    environment_label: t.env,
    summary: { files_changed: t.files, lines_added: t.added, lines_removed: t.removed },
    is_review: t.review,
    attempt_total: t.tries,
  }));
  return { at: now, tasks: parseTasks(JSON.stringify({ tasks: raw, cursor: null })), error: null };
}

// What GET /api/models gives in the demo, in the same shape as readCodexModels in src/models.js.
export function demoModels() {
  const line = (value) => ({ value, set: value !== null, editable: true });
  const levels = ['low', 'medium', 'high', 'xhigh'];
  return {
    ok: true,
    error: null,
    folder: `${HOME}/${ROOTS.codex}`,
    file: `${HOME}/${ROOTS.codex}/config.toml`,
    found: true,
    tag: 'demo',
    listed: true,
    sergeant: { model: line('gpt-6.1-sol'), effort: line('high') },
    worker: { model: line('gpt-6-astra'), effort: line(null) },
    types: [
      { file: 'coder.toml', name: 'coder', description: 'Coding and design work.', model: line('gpt-6-astra'), effort: line(null), pleni: true, error: null },
      { file: 'helper.toml', name: 'helper', description: 'Easier tasks: small fixes, checks and notes.', model: line('gpt-6.1-sol'), effort: line(null), pleni: true, error: null },
    ],
    models: [
      { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', efforts: [...levels, 'max', 'ultra'], defaultEffort: 'medium', unlisted: false },
      { id: 'gpt-6-astra', label: 'GPT-6 Astra', efforts: [...levels, 'max', 'ultra'], defaultEffort: 'high', unlisted: false },
      { id: 'gpt-6.1-luna', label: 'GPT-6.1 Luna', efforts: [...levels, 'max'], defaultEffort: 'medium', unlisted: false },
    ],
    efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  };
}

// What GET /api/models gives for Claude Code in the demo, in the same shape as readClaudeModels.
export function demoClaudeModels() {
  const line = (value) => ({ value, set: value !== null, editable: true });
  const alias = (id, label) => ({ id, label: `${label}, the newest`, efforts: null, defaultEffort: null, unlisted: false });
  return {
    ok: true,
    error: null,
    folder: `${HOME}/${ROOTS.claude}`,
    file: `${HOME}/${ROOTS.claude}/settings.json`,
    found: true,
    tag: 'demo',
    listed: false,
    sergeant: { model: line('opus'), effort: line('high') },
    worker: { model: line('sonnet'), effort: null },
    types: [
      { file: 'coder.md', name: 'coder', description: 'Coding and design work.', model: line('opus'), effort: line(null), pleni: false, error: null },
      { file: 'helper.md', name: 'helper', description: 'Easier tasks: small fixes, checks and notes.', model: line('sonnet'), effort: line(null), pleni: false, error: null },
    ],
    models: [alias('fable', 'Fable'), alias('opus', 'Opus'), alias('sonnet', 'Sonnet'), alias('haiku', 'Haiku')],
    efforts: ['low', 'medium', 'high', 'xhigh'],
    typeEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    modelEfforts: { opus: 'high' },
    notes: [],
  };
}

// What GET /api/usage gives in the demo, in the same shape as createUsage().read() in src/usage.js:
// made-up token counts for the last 7 days, limits for Claude Code (from its status line) and Codex
// (from its files), and none for Grok, Kimi Code and Gemini CLI. The same time always gives the same numbers.
export function demoUsage(now = Date.now()) {
  const win = lastDays(now);
  // [input, output, cacheRead, cacheWrite] per day, oldest first, in thousands of tokens.
  const SHAPES = {
    claude: [[310, 120, 5200, 410], [280, 96, 4100, 380], [0, 0, 0, 0], [0, 0, 0, 0], [350, 140, 6100, 450], [420, 170, 7300, 520], [190, 82, 3300, 260]],
    codex: [[150, 60, 900, 0], [220, 80, 1400, 0], [180, 70, 1100, 0], [0, 0, 0, 0], [260, 95, 1700, 0], [310, 120, 2100, 0], [140, 52, 800, 0]],
    grok: [[80, 30, 200, 20], [0, 0, 0, 0], [95, 38, 260, 24], [60, 22, 150, 12], [0, 0, 0, 0], [110, 44, 310, 30], [45, 18, 120, 9]],
    kimi: [[0, 0, 0, 0], [120, 50, 640, 70], [140, 56, 700, 80], [0, 0, 0, 0], [90, 36, 480, 52], [0, 0, 0, 0], [75, 30, 400, 44]],
    gemini: [[60, 22, 310, 0], [0, 0, 0, 0], [0, 0, 0, 0], [130, 48, 880, 0], [85, 31, 540, 0], [0, 0, 0, 0], [105, 40, 690, 0]],
  };
  const tool = (name, limits) => {
    const days = win.keys.map((date, i) => {
      const [input, output, cacheRead, cacheWrite] = SHAPES[name][i].map((k) => k * 1000);
      return { date, input, output, cacheRead, cacheWrite, total: input + output + cacheWrite };
    });
    const sum = (field) => days.reduce((n, d) => n + d[field], 0);
    const week = { input: sum('input'), output: sum('output'), cacheRead: sum('cacheRead'), cacheWrite: sum('cacheWrite'), total: sum('total') };
    const { date, ...today } = days[days.length - 1];
    return { on: true, today, week, days, atLeast: false, limits, error: null };
  };
  const DAY = 24 * 60 * MIN;
  return {
    at: now,
    tools: {
      claude: tool('claude', {
        at: now - 2 * MIN,
        from: 'statusLine',
        plan: null,
        windows: [
          { minutes: 300, usedPercent: 42, resetsAt: now + 95 * MIN },
          { minutes: 10080, usedPercent: 18, resetsAt: now + 4 * DAY },
        ],
      }),
      codex: tool('codex', {
        at: now - 9 * MIN,
        from: 'files',
        plan: 'plus',
        windows: [
          { minutes: 300, usedPercent: 27, resetsAt: now + 160 * MIN },
          { minutes: 10080, usedPercent: 11, resetsAt: now + 5 * DAY },
        ],
      }),
      grok: tool('grok', null),
      kimi: tool('kimi', null),
      gemini: tool('gemini', null),
    },
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

// The demo's own people and mailbox wiring, so ranks and the mailbox lines show up without setup.
// HQ's orchestrator comes from its relay (relay.plannerKey); the planner here is the same thread.
export function demoSettings(settings) {
  const clean = cleanSettings(settings);
  clean.sources.mailbox.planner = PLANNER;
  clean.sources.mailbox.coordinator = COORDINATOR;
  // Always the two made-up projects: the demo never shows the person's own projects (its pictures
  // go on the website) and never changes them. The Codex worktree under HOME matches Field app by
  // its repository name, because its folder is not on this disk.
  clean.projectList = cleanSettings({
    projectList: [
      { id: 'demobilling01', name: 'Billing service', folder: BILLING, repo: GITHUB.billing },
      { id: 'demofieldapp1', name: 'Field app', folder: FIELD, repo: GITHUB.field },
    ],
  }).projectList;
  for (const [key, role] of [[PLANNER, 'superintendent'], [COORDINATOR, 'coordinator'], [FIELD_LEAD, 'coordinator'], [DOWNLOADS, 'worker']]) {
    clean.people[key] = { ...clean.people[key], role: clean.people[key]?.role || role };
  }
  // The demo always shows the Cloud page, with made-up tasks: it runs nothing.
  clean.codexCloud = { live: true };
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
  const ago = (list) => list.map(({ ago: minutes, ...rest }) => ({ at: clock.mark - minutes * MIN, ...rest }));
  const mail = ago(MAIL_HISTORY);
  const field = ago(FIELD_HISTORY);
  const own = ago(HQ_HISTORY);
  const letters = LETTERS.map(({ ago: minutes, unread = false, ...rest }) => ({ ...rest, at: clock.mark - minutes * MIN, unread }));
  // Each scripted letter and wake once, at the last time the loop sent it, so nothing shows twice.
  for (const step of LETTER_SCRIPT) {
    const beat = lastBeat(clock, step.beat);
    if (beat >= 0) letters.push({ from: step.from, to: step.to, text: step.text, at: beat * BEAT_MS, unread: clock.beat - beat < step.read });
  }
  const wakes = [];
  for (const step of PLANNER_WAKES) {
    const beat = lastBeat(clock, step.beat);
    const running = clock.beat - beat < 2;
    if (beat >= 0) wakes.push({ at: beat * BEAT_MS, endAt: running ? null : beat * BEAT_MS + 6000, running, count: step.count });
  }
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
    for (const { beat: when, ...step } of FIELD_SCRIPT) if (when === beat % LOOP_BEATS) field.push({ at, ...step });
  }
  return { handoffs, mail, field, own, letters, wakes };
}

// The newest beat at or before now on which a step of the loop came round (negative before the first).
function lastBeat(clock, step) {
  return clock.beat - (((clock.beat - step) % LOOP_BEATS) + LOOP_BEATS) % LOOP_BEATS;
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
    github: githubOf(member.cwd),
    entrypoint: member.entrypoint,
    model: member.model,
    effort: member.effort,
    workerType: member.workerType ?? null,
    chosen: member.chosen ?? null,
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

// The made-up repositories the sessions work in; HQ's folders are no repository.
function githubOf(cwd) {
  if (cwd.startsWith(HQ)) return null;
  return GITHUB[cwd.startsWith(FIELD) || cwd.includes('field-app') ? 'field' : 'billing'];
}

// HQ's mailbox, in the shape src/sources/mailbox.js's createMailboxesSource gives it: its own board,
// its relay (which wakes the orchestrator, for mail and for new items in the projects), the agent
// mail, and the two project mailboxes, each with a relay and a coordinator of its own.
function hqMailbox(clock, past) {
  const billing = projectMailbox(clock, {
    name: 'billing', folder: PROJECTS[0].folder, tasks: TASKS, events: past.mail, coordinator: COORDINATOR,
    // A note the coordinator left for the person, in NEEDS-ADA.md at the mailbox root.
    notes: [{ file: 'NEEDS-ADA.md', count: 1, at: clock.mark - 12 * MIN, text: 'Approve the new tax-rate source before W1 ships the change.' }],
  });
  const field = projectMailbox(clock, { name: 'field-app', folder: PROJECTS[1].folder, tasks: FIELD_TASKS, events: past.field, coordinator: FIELD_LEAD, notes: [] });
  const own = projectMailbox(clock, { name: 'hq', folder: HQ, tasks: HQ_TASKS, events: past.own, coordinator: null, notes: [] });
  const threadId = PLANNER.slice(PLANNER.indexOf(':') + 1);
  const plannerWakes = past.wakes.map((w) => ({ key: null, name: null, ...w, planner: true, threadId }));
  own.relay.plannerKey = PLANNER;
  own.relay.wakes = [...relayWakes(past.letters), ...plannerWakes].sort((a, b) => b.at - a.at);
  return {
    ...own,
    mail: agentMail(past.letters),
    hq: {
      projects: [
        { id: PROJECTS[0].id, name: PROJECTS[0].name, mailbox: billing },
        { id: PROJECTS[1].id, name: PROJECTS[1].name, mailbox: field },
      ],
      skipped: [],
    },
  };
}

// One mailbox, as createMailboxSource gives it, with its relay running.
function projectMailbox(clock, { name, folder, tasks: list, events: all, coordinator, notes }) {
  const events = all.sort((a, b) => b.at - a.at).slice(0, 300);
  const tasks = list.map((task) => {
    const newest = events.find((event) => event.taskId === task.id);
    return {
      id: task.id,
      title: task.title,
      state: task.state,
      updatedAt: newest ? newest.at : null,
      attention: [...task.attention],
      workers: (task.workers ?? []).map((w) => ({
        id: w.id,
        state: w.end ? 'done' : 'running',
        model: w.model,
        startedAt: clock.mark - w.start * MIN,
        finishedAt: w.end ? clock.mark - w.end * MIN : null,
        ...(w.session ? { sessionId: w.session.slice(w.session.indexOf(':') + 1) } : {}),
      })),
    };
  });
  return {
    ok: true,
    error: null,
    root: folder,
    name,
    tasks,
    events,
    notes,
    relay: {
      running: true, paused: false, halted: false, coordinatorKey: coordinator,
      lastAt: clock.beatAt, pausedAt: null, haltReason: null, alerts: null, wakes: [],
    },
    mail: null,
  };
}

// HQ's relay wakes each agent it knows, a moment after mail comes for it.
function relayWakes(letters) {
  const woken = new Map(MAIL_AGENTS.filter((a) => a.thread).map((a) => [a.key, a.name]));
  return letters
    .filter((m) => woken.has(m.to))
    .map((m) => ({ key: m.to, name: woken.get(m.to), at: m.at + 1000, endAt: m.unread ? null : m.at + 6000, running: m.unread, count: 1 }))
    .sort((a, b) => b.at - a.at);
}

// The mail part of the mailbox, in the shape src/sources/mailbox.js gives it.
function agentMail(letters) {
  const messages = letters
    .map((m) => ({ to: m.to, from: m.from, fromName: MAIL_NAMES.get(m.from), at: m.at, unread: m.unread, text: m.text }))
    .sort((a, b) => b.at - a.at);
  const agents = MAIL_AGENTS.map((a) => {
    const waiting = messages.filter((m) => m.to === a.key && m.unread);
    return {
      key: a.key,
      name: a.name,
      unread: waiting.length,
      since: waiting.length ? Math.min(...waiting.map((m) => m.at)) : null,
      wakes: a.thread !== null,
      threadId: a.thread ? a.thread.slice(a.thread.indexOf(':') + 1) : null,
    };
  });
  return { owner: 'Ada', agents, messages };
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
