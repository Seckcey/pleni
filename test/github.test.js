import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { GITHUB_MESSAGES, MAX_REPOS, createGithub, findGh, ghOutcome, isRepoPath, listArgs, mergeArgs, parsePulls } from '../src/github.js';

const HEAD = 'a'.repeat(40);
const OTHER_HEAD = 'b'.repeat(40);
const GH_WIN = 'C:\\Program Files\\GitHub CLI\\gh.exe';

// One pull request as `gh pr list --json` gives it, ready to merge unless changed.
function raw(extra = {}) {
  return {
    number: 7,
    title: 'Fix the invoice totals',
    url: 'https://github.com/ada/notes/pull/7',
    state: 'OPEN',
    isDraft: false,
    headRefName: 'fix/totals',
    headRefOid: HEAD,
    baseRefName: 'main',
    isCrossRepository: false,
    updatedAt: '2026-10-18T08:00:00Z',
    reviewDecision: 'APPROVED',
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    statusCheckRollup: [
      { __typename: 'CheckRun', name: 'Test', status: 'COMPLETED', conclusion: 'SUCCESS' },
      { __typename: 'StatusContext', context: 'ci/old', state: 'SUCCESS' },
    ],
    ...extra,
  };
}

const one = (extra) => parsePulls(JSON.stringify([raw(extra)]), 'ada/notes')[0];

// A stand-in for execFile that answers each gh run from `answer(args)`: { stdout } or { err, stderr }.
function fakeGh(answer = () => ({ stdout: JSON.stringify([raw()]) })) {
  const calls = [];
  const execFile = (file, args, options, done) => {
    calls.push({ file, args, options });
    const a = answer(args, calls.length);
    setImmediate(() => done(a.err ?? null, a.stdout ?? '', a.stderr ?? ''));
  };
  return { calls, execFile };
}

function github(gh, clock = { t: 1000 }, extra = {}) {
  return createGithub({
    execFile: gh.execFile,
    env: { PATH: '/usr/bin', HOME: '/home/ada' },
    platform: 'linux',
    isFile: (file) => file === '/usr/bin/gh',
    now: () => clock.t,
    ...extra,
  });
}

test('isRepoPath takes plain owner/name only', () => {
  for (const good of ['ada/notes', 'ada-lab/notes.app', 'A_1/b.c-d']) assert.equal(isRepoPath(good), true, good);
  for (const bad of ['ada', 'ada/notes/x', '../notes', 'ada/..', 'ada/no tes', 'ada/notes;calc', '', null, 7]) {
    assert.equal(isRepoPath(bad), false, String(bad));
  }
});

test('findGh takes the first gh in an absolute folder on PATH, never the current folder or a share', () => {
  const have = new Set(['C:\\Tools\\gh.exe', GH_WIN, 'D:\\here\\gh.exe']);
  const isFile = (file) => have.has(file);
  const env = { Path: ['.', 'D:here', '\\\\server\\share', '"C:\\Program Files\\GitHub CLI"', 'C:\\Tools'].join(';') };
  assert.equal(findGh(env, 'win32', isFile), GH_WIN, 'Path is read whatever its case, and quotes are dropped');
  assert.equal(findGh({ PATH: 'bin:/opt/gh/bin:/usr/bin' }, 'linux', (f) => f === '/usr/bin/gh' || f === 'bin/gh'), '/usr/bin/gh');
  assert.equal(findGh({ PATH: '/usr/bin' }, 'linux', () => false), null);
  assert.equal(findGh({}, 'linux', () => true), null);
});

test('the gh command lines are fixed words and checked values', () => {
  assert.deepEqual(listArgs('ada/notes'), [
    'pr', 'list', '--repo', 'github.com/ada/notes', '--state', 'all', '--limit', '30', '--json',
    'number,title,url,state,isDraft,headRefName,headRefOid,baseRefName,isCrossRepository,updatedAt,reviewDecision,statusCheckRollup,mergeable,mergeStateStatus',
  ]);
  assert.deepEqual(mergeArgs('ada/notes', 7, 'squash', HEAD), ['pr', 'merge', '7', '--repo', 'github.com/ada/notes', '--squash', '--match-head-commit', HEAD]);
  assert.deepEqual(mergeArgs('ada/notes', 7, 'rebase', HEAD).slice(5, 6), ['--rebase']);
  assert.throws(() => listArgs('ada/notes --web'));
  assert.throws(() => mergeArgs('ada/notes', 0, 'squash', HEAD));
  assert.throws(() => mergeArgs('ada/notes', 7.5, 'squash', HEAD));
  assert.throws(() => mergeArgs('ada/notes', 7, 'admin', HEAD));
  assert.throws(() => mergeArgs('ada/notes', 7, 'squash', 'abc123'));
});

test('parsePulls reads state, checks, review and whether it can be merged', () => {
  const ready = one();
  assert.deepEqual(ready, {
    number: 7,
    title: 'Fix the invoice totals',
    url: 'https://github.com/ada/notes/pull/7',
    state: 'open',
    branch: 'fix/totals',
    base: 'main',
    fork: false,
    head: HEAD,
    updatedAt: Date.parse('2026-10-18T08:00:00Z'),
    checks: 'passing',
    failing: [],
    review: 'approved',
    merge: 'ready',
    why: null,
    canMerge: true,
  });
  assert.equal(one({ url: 'https://evil.example/x' }).url, 'https://github.com/ada/notes/pull/7', 'the address is built, not copied');
  assert.equal(one({ statusCheckRollup: [] }).checks, 'none');
  assert.equal(one({ statusCheckRollup: [] }).canMerge, true, 'no checks is fine');
  assert.equal(one({ mergeStateStatus: 'HAS_HOOKS' }).canMerge, true);
  assert.equal(one({ reviewDecision: '' }).review, null);
  assert.equal(one({ reviewDecision: 'REVIEW_REQUIRED' }).review, 'needed');
  for (const odd of ['__proto__', 'toString', null, 7]) assert.equal(one({ reviewDecision: odd }).review, null, String(odd));
  assert.equal(one({ state: 'MERGED' }).state, 'merged');
  assert.equal(one({ state: 'CLOSED' }).merge, null);
  assert.equal(one({ isCrossRepository: true }).fork, true);
});

test('parsePulls says why a pull request cannot be merged yet', () => {
  const failing = [
    { __typename: 'CheckRun', name: 'Test (windows)', status: 'COMPLETED', conclusion: 'FAILURE' },
    { __typename: 'CheckRun', name: 'Lint', status: 'COMPLETED', conclusion: 'CANCELLED' },
    { __typename: 'StatusContext', context: 'ci/old', state: 'ERROR' },
    { __typename: 'CheckRun', name: 'Fourth', status: 'COMPLETED', conclusion: 'TIMED_OUT' },
  ];
  const cases = [
    [{ state: 'MERGED' }, 'It is merged already.'],
    [{ state: 'CLOSED' }, 'It is closed.'],
    [{ isDraft: true }, 'It is a draft.'],
    [{ mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }, 'It has a merge conflict.'],
    [{ statusCheckRollup: failing }, 'Some checks fail.'],
    [{ mergeStateStatus: 'UNSTABLE' }, 'Some checks fail.'],
    [{ statusCheckRollup: [{ __typename: 'CheckRun', name: 'Test', status: 'IN_PROGRESS', conclusion: '' }] }, 'Checks are still running.'],
    [{ statusCheckRollup: [{ __typename: 'StatusContext', context: 'ci', state: 'PENDING' }] }, 'Checks are still running.'],
    [{ reviewDecision: 'CHANGES_REQUESTED' }, 'A reviewer asked for changes.'],
    [{ mergeStateStatus: 'BEHIND' }, 'It is behind main. Update the branch on GitHub first.'],
    [{ mergeStateStatus: 'BLOCKED' }, 'GitHub says it is blocked. It may need a review, or checks that GitHub requires.'],
    [{ mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' }, 'GitHub is still checking whether it can be merged.'],
    [{ headRefOid: 'not-a-commit' }, 'GitHub is still checking whether it can be merged.'],
  ];
  for (const [extra, why] of cases) {
    const pull = one(extra);
    assert.equal(pull.why, why, JSON.stringify(extra));
    assert.equal(pull.canMerge, false, JSON.stringify(extra));
  }
  const red = one({ statusCheckRollup: failing });
  assert.equal(red.checks, 'failing');
  assert.deepEqual(red.failing, ['Test (windows)', 'Lint', 'ci/old'], 'at most three names');
  assert.equal(one({ statusCheckRollup: [{ __typename: 'CheckRun', name: 'Odd', status: 'COMPLETED', conclusion: 'STALE' }] }).checks, 'failing', 'what Pleni does not know counts as failed');
  assert.equal(one({ statusCheckRollup: [{ __typename: 'CheckRun', name: 'Skip', status: 'COMPLETED', conclusion: 'SKIPPED' }] }).checks, 'passing');
});

test('parsePulls cleans titles and drops what is not a pull request', () => {
  assert.equal(one({ title: 'Fix\u202e txt.exe\u0007  totals\n' }).title, 'Fix txt.exe totals');
  assert.equal(one({ title: 'x'.repeat(300) }).title.length, 200);
  assert.equal(one({ title: 42 }).title, '');
  const list = parsePulls(JSON.stringify([raw(), null, { number: 0 }, { number: 'x' }, raw({ number: 8 })]), 'ada/notes');
  assert.deepEqual(list.map((p) => p.number), [7, 8]);
  assert.equal(parsePulls('{"number":7}', 'ada/notes'), null);
  assert.equal(parsePulls('not json', 'ada/notes'), null);
});

test('ghOutcome turns gh failures into plain words', () => {
  assert.deepEqual(ghOutcome(null, '[]', ''), { ok: true, stdout: '[]', error: null });
  assert.equal(ghOutcome({ code: 'ENOENT' }).error, GITHUB_MESSAGES.noGh);
  assert.equal(ghOutcome({ killed: true, signal: 'SIGTERM' }).error, GITHUB_MESSAGES.slow);
  assert.equal(ghOutcome({ code: 4 }, '', 'To get started with GitHub CLI, please run:  gh auth login').error, GITHUB_MESSAGES.login);
  assert.equal(ghOutcome({ code: 1 }, '', '\nGraphQL: Could not resolve to a Repository with the name \'ada/notes\'.\n').error,
    'GitHub said: GraphQL: Could not resolve to a Repository with the name \'ada/notes\'.');
  assert.equal(ghOutcome({ code: 1 }, '', '').error, GITHUB_MESSAGES.failed);
  assert.equal(ghOutcome({ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }, '', 'x').error, GITHUB_MESSAGES.failed);
});

test('status runs gh by its full path, away from any repository, and keeps answers for a minute', async () => {
  const gh = fakeGh();
  const clock = { t: 1000 };
  const g = github(gh, clock);
  const first = await g.status({ repos: ['ada/notes', 'ada/notes', 'bad repo'] });
  assert.equal(first.error, null);
  assert.deepEqual(first.repos.map((r) => [r.repo, r.at, r.error, r.pulls.length]), [['ada/notes', 1000, null, 1]]);
  assert.equal(gh.calls.length, 1);
  const call = gh.calls[0];
  assert.equal(call.file, '/usr/bin/gh');
  assert.deepEqual(call.args, listArgs('ada/notes'));
  assert.equal(call.options.cwd, os.tmpdir());
  assert.equal(call.options.windowsHide, true);
  assert.equal(call.options.env.GH_PROMPT_DISABLED, '1');
  assert.equal(call.options.env.HOME, '/home/ada');
  assert.ok(call.options.timeout > 0 && call.options.maxBuffer > 0);
  clock.t += 50 * 1000;
  await g.status({ repos: ['ada/notes'] });
  assert.equal(gh.calls.length, 1, 'kept for a minute');
  await g.status({ repos: ['ada/notes'], fresh: true });
  assert.equal(gh.calls.length, 2, 'Look again asks when the answer is older than a few seconds');
  await g.status({ repos: ['ada/notes'], fresh: true });
  assert.equal(gh.calls.length, 2, 'but not twice in a row');
  clock.t += 61 * 1000;
  await g.status({ repos: ['ada/notes'] });
  assert.equal(gh.calls.length, 3);
});

test('status shares one gh run between pages and asks about at most twelve repositories', async () => {
  const gh = fakeGh(() => ({ stdout: '[]' }));
  const g = github(gh);
  const [a, b] = await Promise.all([g.status({ repos: ['ada/notes'] }), g.status({ repos: ['ada/notes'] })]);
  assert.equal(gh.calls.length, 1);
  assert.deepEqual(a, b);
  const many = Array.from({ length: 20 }, (_, i) => `ada/repo${String(i).padStart(2, '0')}`);
  const answer = await g.status({ repos: many });
  assert.equal(answer.repos.length, MAX_REPOS);
  assert.equal(answer.repos[0].repo, 'ada/repo00');
});

test('status says when gh is missing or not signed in', async () => {
  const none = github(fakeGh(), { t: 1000 }, { isFile: () => false });
  assert.deepEqual(await none.status({ repos: ['ada/notes'] }), { error: GITHUB_MESSAGES.noGh, repos: [] });
  const out = github(fakeGh(() => ({ err: { code: 4 }, stderr: 'please run: gh auth login' })));
  const answer = await out.status({ repos: ['ada/notes'] });
  assert.equal(answer.repos[0].error, GITHUB_MESSAGES.login);
  assert.deepEqual(answer.repos[0].pulls, []);
  const odd = github(fakeGh(() => ({ stdout: '{"not":"a list"}' })));
  assert.equal((await odd.status({ repos: ['ada/notes'] })).repos[0].error, GITHUB_MESSAGES.failed);
});

test('merge looks again, then merges the commit the person saw with the chosen method', async () => {
  const gh = fakeGh((args) => (args[1] === 'merge' ? { stdout: '' } : { stdout: JSON.stringify([raw()]) }));
  const clock = { t: 1000 };
  const g = github(gh, clock);
  await g.status({ repos: ['ada/notes'] });
  const known = new Set(['ada/notes']);
  const result = await g.merge({ repo: 'ada/notes', number: 7, head: HEAD, method: 'rebase', known });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(gh.calls.map((c) => c.args[1]), ['list', 'list', 'merge'], 'a fresh look before the merge');
  assert.deepEqual(gh.calls[2].args, mergeArgs('ada/notes', 7, 'rebase', HEAD));
  await g.status({ repos: ['ada/notes'] });
  assert.equal(gh.calls.length, 4, 'after a merge the next look asks GitHub again');
});

test('merge refuses what is not on the map, not ready, or changed since the person looked', async () => {
  let pull = raw();
  const gh = fakeGh((args) => (args[1] === 'merge' ? { stdout: '' } : { stdout: JSON.stringify([pull]) }));
  const clock = { t: 1000 };
  const g = github(gh, clock);
  const known = new Set(['ada/notes']);
  const ask = (extra) => g.merge({ repo: 'ada/notes', number: 7, head: HEAD, method: 'squash', known, ...extra });
  assert.deepEqual(await ask({ repo: 'eve/other' }), { ok: false, status: 404, error: GITHUB_MESSAGES.notOnMap });
  assert.deepEqual(await ask({ repo: '../notes' }), { ok: false, status: 404, error: GITHUB_MESSAGES.notOnMap });
  assert.deepEqual(await ask({ number: '7' }), { ok: false, status: 400, error: GITHUB_MESSAGES.badPull });
  assert.deepEqual(await ask({ head: 'abc' }), { ok: false, status: 400, error: GITHUB_MESSAGES.badPull });
  assert.equal(gh.calls.length, 0, 'nothing ran for a bad request');
  assert.deepEqual(await ask({ number: 9 }), { ok: false, status: 404, error: GITHUB_MESSAGES.gone });
  assert.deepEqual(await ask({ head: OTHER_HEAD }), { ok: false, status: 409, error: GITHUB_MESSAGES.changed });
  clock.t += 61 * 1000;
  pull = raw({ statusCheckRollup: [{ __typename: 'CheckRun', name: 'Test', status: 'IN_PROGRESS', conclusion: '' }] });
  assert.deepEqual(await ask(), { ok: false, status: 409, error: 'Checks are still running.' });
  assert.ok(gh.calls.every((c) => c.args[1] === 'list'), 'no merge ran');
});

test('merge allows three a minute and one at a time per pull request, and passes on gh errors', async () => {
  let release;
  const slow = new Promise((resolve) => {
    release = resolve;
  });
  const gh = {
    calls: [],
    execFile(file, args, options, done) {
      gh.calls.push(args);
      if (args[1] === 'merge' && args[2] === '7') slow.then(() => done(null, '', ''));
      else if (args[1] === 'merge' && args[2] === '8') setImmediate(() => done({ code: 1 }, '', 'Pull request is not mergeable: the base branch policy prohibits the merge.'));
      else setImmediate(() => done(null, JSON.stringify([raw(), raw({ number: 8 }), raw({ number: 9 }), raw({ number: 10 })]), ''));
    },
  };
  const clock = { t: 1000 };
  const g = github(gh, clock);
  const known = new Set(['ada/notes']);
  const ask = (number) => g.merge({ repo: 'ada/notes', number, head: HEAD, method: 'squash', known });
  const first = ask(7);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(await ask(7), { ok: false, status: 429, error: GITHUB_MESSAGES.again });
  assert.deepEqual(await ask(8), { ok: false, status: 502, error: 'GitHub said: Pull request is not mergeable: the base branch policy prohibits the merge.' });
  assert.deepEqual(await ask(9), { ok: true });
  assert.deepEqual(await ask(10), { ok: false, status: 429, error: GITHUB_MESSAGES.tooMany });
  release();
  assert.deepEqual(await first, { ok: true });
  clock.t += 61 * 1000;
  assert.deepEqual(await ask(10), { ok: true });
});

test('merge says when gh is missing', async () => {
  const g = github(fakeGh(), { t: 1000 }, { isFile: () => false });
  assert.deepEqual(await g.merge({ repo: 'ada/notes', number: 7, head: HEAD, method: 'squash', known: new Set(['ada/notes']) }),
    { ok: false, status: 409, error: GITHUB_MESSAGES.noGh });
});
