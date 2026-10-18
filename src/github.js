// Live pull request status from GitHub, and the Merge button. Both are off until the person turns
// them on (settings.github). Pleni does not talk to GitHub itself: it runs the GitHub CLI (gh) on
// this computer, which signs in with the person's own gh login. gh is found by its full path in a
// folder on PATH, every word on its command line is fixed or checked (owner/name, a number, a
// commit id), and no shell reads it. Pleni asks only about the GitHub repositories its sessions
// work in, keeps each answer for a minute, and asks only while a page shows the Pull requests view.
import { execFile as nodeExecFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PART = /^[A-Za-z0-9._-]{1,100}$/;
const SHA = /^[0-9a-f]{40}$/;
const FIELDS = 'number,title,url,state,isDraft,headRefName,headRefOid,baseRefName,isCrossRepository,updatedAt,reviewDecision,statusCheckRollup,mergeable,mergeStateStatus';
const LIST_LIMIT = 30; // the newest pull requests of each repository, open or not
export const MAX_REPOS = 12;
const FRESH_MS = 60 * 1000; // how long an answer is kept
const AGAIN_MS = 10 * 1000; // "Look again" asks no more often than this
const FIND_MS = 60 * 1000; // how long Pleni remembers where gh is
const RUN_MS = 30 * 1000;
const MAX_OUTPUT = 8 * 1024 * 1024;
const MINUTE_MS = 60 * 1000;
const MERGES_PER_MINUTE = 3;
const MAX_NUMBER = 999999999;
const MAX_TITLE = 200;
const MAX_FAILING = 3;
// Control characters, and the marks that turn text around, which could make a title look like
// something else.
const HIDDEN_MARKS = /[\p{Cc}‪-‮⁦-⁩]/gu;
export const MERGE_METHODS = ['squash', 'merge', 'rebase'];
const PASSED = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);
const REVIEWS = { APPROVED: 'approved', CHANGES_REQUESTED: 'changes', REVIEW_REQUIRED: 'needed' };

export const GITHUB_MESSAGES = {
  off: 'Live GitHub status is turned off. Turn it on in Settings, under Sources, first.',
  mergeOff: 'The Merge button is turned off. Turn it on in Settings, under Sources, first.',
  noGh: 'Pleni could not find the GitHub CLI (gh). Install it from cli.github.com and run gh auth login in PowerShell. Then start Pleni again from a new PowerShell window, so it can find gh.',
  login: 'The GitHub CLI (gh) is not signed in. Run gh auth login in PowerShell, then try again.',
  slow: 'GitHub took too long to answer. Try again in a minute.',
  failed: 'GitHub did not answer. Try again in a minute.',
  demo: 'The demo has no real pull requests to merge.',
  notOnMap: 'Pleni merges only pull requests in a repository that a session on the map works in.',
  badPull: 'Pleni does not know that pull request.',
  gone: 'Pleni does not see that pull request on GitHub any more.',
  changed: 'The pull request changed since you looked. Look again, then merge.',
  again: 'Pleni is already merging this pull request.',
  tooMany: 'Pleni merged a few pull requests just now. Wait a minute, then try again.',
};

// Why a pull request cannot be merged from Pleni yet, in plain words.
const WHY = {
  merged: 'It is merged already.',
  closed: 'It is closed.',
  draft: 'It is a draft.',
  conflict: 'It has a merge conflict.',
  failing: 'Some checks fail.',
  running: 'Checks are still running.',
  changes: 'A reviewer asked for changes.',
  blocked: 'GitHub says it is blocked. It may need a review, or checks that GitHub requires.',
  checking: 'GitHub is still checking whether it can be merged.',
};

// 'owner/name' with plain parts, such as 'ada/notes'.
export function isRepoPath(value) {
  if (typeof value !== 'string') return false;
  const parts = value.split('/');
  return parts.length === 2 && parts.every((part) => PART.test(part) && part !== '.' && part !== '..');
}

// The full path of gh: the first gh.exe (gh elsewhere) in a folder on PATH. Only absolute folders
// on this computer count, so a gh in the current folder or on a network share never runs instead.
export function findGh(env = process.env, platform = process.platform, isFile = fileExists) {
  const win = platform === 'win32';
  const p = win ? path.win32 : path.posix;
  const name = win ? 'gh.exe' : 'gh';
  const key = Object.keys(env).find((k) => (win ? k.toUpperCase() === 'PATH' : k === 'PATH'));
  const list = key && typeof env[key] === 'string' ? env[key] : '';
  for (const raw of list.split(win ? ';' : ':')) {
    const dir = raw.trim().replace(/^"(.*)"$/, '$1');
    if (!dir || !p.isAbsolute(dir) || /^[\\/]{2}/.test(dir)) continue;
    const file = p.join(dir, name);
    if (isFile(file)) return file;
  }
  return null;
}

function fileExists(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

// gh never stops to ask a question, check for updates, or color its words.
export function ghEnv(env) {
  return { ...env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', GH_NO_EXTENSION_UPDATE_NOTIFIER: '1', GH_SPINNER_DISABLED: '1', NO_COLOR: '1' };
}

// The repository is named with its host, so a GH_HOST setting for another server cannot change it.
export function listArgs(repo) {
  if (!isRepoPath(repo)) throw new Error('That is not a GitHub repository.');
  return ['pr', 'list', '--repo', `github.com/${repo}`, '--state', 'all', '--limit', String(LIST_LIMIT), '--json', FIELDS];
}

// --match-head-commit makes GitHub refuse the merge if anyone pushed after the person looked.
export function mergeArgs(repo, number, method, head) {
  if (!isRepoPath(repo)) throw new Error('That is not a GitHub repository.');
  if (!Number.isSafeInteger(number) || number < 1 || number > MAX_NUMBER) throw new Error('That is not a pull request number.');
  if (!MERGE_METHODS.includes(method)) throw new Error('That is not a way to merge.');
  if (typeof head !== 'string' || !SHA.test(head)) throw new Error('That is not a commit id.');
  return ['pr', 'merge', String(number), '--repo', `github.com/${repo}`, `--${method}`, '--match-head-commit', head];
}

// gh's JSON list -> the pull requests Pleni shows, or null when it is not a list.
export function parsePulls(text, repo) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(raw)) return null;
  return raw.map((item) => pullOf(item, repo)).filter(Boolean);
}

function pullOf(raw, repo) {
  if (!raw || typeof raw !== 'object' || !Number.isSafeInteger(raw.number) || raw.number < 1 || raw.number > MAX_NUMBER) return null;
  const state = raw.state === 'MERGED' ? 'merged' : raw.state === 'CLOSED' ? 'closed' : raw.isDraft === true ? 'draft' : 'open';
  const checks = checksOf(raw.statusCheckRollup);
  const pull = {
    number: raw.number,
    title: plainText(raw.title, MAX_TITLE),
    url: `https://github.com/${repo}/pull/${raw.number}`,
    state,
    branch: plainText(raw.headRefName, 255) || null,
    base: plainText(raw.baseRefName, 255) || null,
    fork: raw.isCrossRepository === true,
    head: typeof raw.headRefOid === 'string' && SHA.test(raw.headRefOid) ? raw.headRefOid : null,
    updatedAt: timeOf(raw.updatedAt),
    checks: checks.state,
    failing: checks.failing,
    review: Object.hasOwn(REVIEWS, raw.reviewDecision ?? '') ? REVIEWS[raw.reviewDecision] : null,
    merge: state === 'open' ? mergeOf(raw) : null,
    why: null,
    canMerge: false,
  };
  pull.why = whyNot(pull);
  pull.canMerge = pull.why === null;
  return pull;
}

// 'passing', 'failing', 'running' or 'none', with the names of up to three failing checks.
function checksOf(rollup) {
  const out = { state: 'none', failing: [] };
  if (!Array.isArray(rollup)) return out;
  let passed = 0;
  let running = 0;
  let failed = 0;
  for (const check of rollup) {
    const kind = checkKind(check);
    if (kind === 'passed') passed++;
    else if (kind === 'running') running++;
    else if (kind === 'failed') {
      failed++;
      const name = plainText(check.name ?? check.context, 100);
      if (name && out.failing.length < MAX_FAILING) out.failing.push(name);
    }
  }
  out.state = failed ? 'failing' : running ? 'running' : passed ? 'passing' : 'none';
  return out;
}

// A check run (GitHub Actions and apps) or a commit status (older tools). Anything Pleni does not
// know counts as failed, so it never offers Merge by mistake.
function checkKind(check) {
  if (!check || typeof check !== 'object') return null;
  if (check.__typename === 'StatusContext') {
    const state = String(check.state || '').toUpperCase();
    if (state === 'SUCCESS') return 'passed';
    return state === 'PENDING' || state === 'EXPECTED' ? 'running' : 'failed';
  }
  const status = String(check.status || '').toUpperCase();
  if (status && status !== 'COMPLETED') return 'running';
  return PASSED.has(String(check.conclusion || '').toUpperCase()) ? 'passed' : 'failed';
}

function mergeOf(raw) {
  const mergeable = String(raw.mergeable || '').toUpperCase();
  const status = String(raw.mergeStateStatus || '').toUpperCase();
  if (mergeable === 'CONFLICTING' || status === 'DIRTY') return 'conflict';
  if (mergeable !== 'MERGEABLE' || !status || status === 'UNKNOWN') return 'checking';
  if (status === 'CLEAN' || status === 'HAS_HOOKS') return 'ready';
  if (status === 'BEHIND') return 'behind';
  if (status === 'UNSTABLE') return 'unstable';
  if (status === 'DRAFT') return 'draft';
  return 'blocked';
}

// Pleni is stricter than GitHub: it offers Merge only when GitHub says the pull request is ready,
// every check passed (or there are none), and no reviewer asked for changes.
function whyNot(pull) {
  if (pull.state === 'merged') return WHY.merged;
  if (pull.state === 'closed') return WHY.closed;
  if (pull.state === 'draft' || pull.merge === 'draft') return WHY.draft;
  if (pull.merge === 'conflict') return WHY.conflict;
  if (pull.checks === 'failing' || pull.merge === 'unstable') return WHY.failing;
  if (pull.checks === 'running') return WHY.running;
  if (pull.review === 'changes') return WHY.changes;
  if (pull.merge === 'behind') return `It is behind ${pull.base || 'its base branch'}. Update the branch on GitHub first.`;
  if (pull.merge === 'blocked') return WHY.blocked;
  if (pull.merge !== 'ready' || !pull.head) return WHY.checking;
  return null;
}

function plainText(value, max) {
  if (typeof value !== 'string') return '';
  return Array.from(value.replace(HIDDEN_MARKS, ' ').replace(/\s+/g, ' ').trim()).slice(0, max).join('');
}

function timeOf(value) {
  const t = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(t) ? t : null;
}

// What a gh run came to: { ok, stdout, error } with a plain error.
export function ghOutcome(err, stdout, stderr) {
  if (!err) return { ok: true, stdout: String(stdout ?? ''), error: null };
  const fail = (error) => ({ ok: false, stdout: '', error });
  if (err.code === 'ENOENT') return fail(GITHUB_MESSAGES.noGh);
  if (err.killed) return fail(GITHUB_MESSAGES.slow);
  if (err.code === 4) return fail(GITHUB_MESSAGES.login);
  const line = String(stderr ?? '').split(/\r?\n/).map((l) => plainText(l, 200)).find(Boolean);
  return fail(line && typeof err.code === 'number' ? `GitHub said: ${line}` : GITHUB_MESSAGES.failed);
}

// The answers and the merges, kept from one request to the next. `execFile`, `env`, `platform`,
// `isFile` and `now` are for tests.
export function createGithub({ execFile = nodeExecFile, env = process.env, platform = process.platform, isFile = fileExists, now = Date.now } = {}) {
  const answers = new Map(); // repo -> { at, pulls, error }
  const asking = new Map(); // repo -> the answer on its way
  const merging = new Set(); // 'owner/name#number'
  const mergeTimes = []; // when each merge was asked for, for the limit
  let found = { at: -Infinity, file: null };

  function gh(t) {
    if (t - found.at >= FIND_MS) found = { at: t, file: findGh(env, platform, isFile) };
    return found.file;
  }

  function run(file, args) {
    const options = { cwd: os.tmpdir(), env: ghEnv(env), timeout: RUN_MS, maxBuffer: MAX_OUTPUT, windowsHide: true, encoding: 'utf8' };
    return new Promise((resolve) => {
      try {
        execFile(file, args, options, (err, stdout, stderr) => resolve(ghOutcome(err, stdout, stderr)));
      } catch (err) {
        resolve(ghOutcome(err, '', ''));
      }
    });
  }

  // Two pages asking at once share one gh run.
  function ask(repo, file) {
    if (!asking.has(repo)) {
      const answer = run(file, listArgs(repo))
        .then((r) => {
          const pulls = r.ok ? parsePulls(r.stdout, repo) : null;
          const kept = { at: now(), pulls: pulls ?? [], error: r.ok ? (pulls ? null : GITHUB_MESSAGES.failed) : r.error };
          if (answers.size >= MAX_REPOS * 4) answers.clear();
          answers.set(repo, kept);
          return kept;
        })
        .finally(() => asking.delete(repo));
      asking.set(repo, answer);
    }
    return asking.get(repo);
  }

  // { error, repos: [{ repo, at, pulls, error }] } for up to MAX_REPOS repositories. `fresh` asks
  // again when the last answer is more than a few seconds old.
  async function status({ repos = [], fresh = false } = {}) {
    const list = [...new Set(repos.filter(isRepoPath))].sort().slice(0, MAX_REPOS);
    const t = now();
    const file = gh(t);
    if (!file) return { error: GITHUB_MESSAGES.noGh, repos: [] };
    const out = await Promise.all(
      list.map(async (repo) => {
        const kept = answers.get(repo);
        const fine = kept && t - kept.at < (fresh ? AGAIN_MS : FRESH_MS);
        return { repo, ...(fine ? kept : await ask(repo, file)) };
      }),
    );
    return { error: null, repos: out };
  }

  // Merges one pull request after a fresh look: it must still be on the same commit the person saw
  // (`head`) and ready to merge. `known` holds the repositories on the map.
  async function merge({ repo, number, head, method, known }) {
    if (!isRepoPath(repo) || !known?.has(repo)) return refuse(404, GITHUB_MESSAGES.notOnMap);
    if (!Number.isSafeInteger(number) || number < 1 || number > MAX_NUMBER || typeof head !== 'string' || !SHA.test(head)) {
      return refuse(400, GITHUB_MESSAGES.badPull);
    }
    const how = MERGE_METHODS.includes(method) ? method : MERGE_METHODS[0];
    const id = `${repo}#${number}`;
    const t = now();
    while (mergeTimes.length && t - mergeTimes[0] >= MINUTE_MS) mergeTimes.shift();
    if (merging.has(id)) return refuse(429, GITHUB_MESSAGES.again);
    if (mergeTimes.length >= MERGES_PER_MINUTE) return refuse(429, GITHUB_MESSAGES.tooMany);
    const file = gh(t);
    if (!file) return refuse(409, GITHUB_MESSAGES.noGh);
    merging.add(id);
    mergeTimes.push(t);
    try {
      const answer = await ask(repo, file);
      if (answer.error) return refuse(502, answer.error);
      const pull = answer.pulls.find((p) => p.number === number);
      if (!pull) return refuse(404, GITHUB_MESSAGES.gone);
      if (pull.head !== head) return refuse(409, GITHUB_MESSAGES.changed);
      if (pull.why) return refuse(409, pull.why);
      const result = await run(file, mergeArgs(repo, number, how, head));
      answers.delete(repo);
      return result.ok ? { ok: true } : refuse(502, result.error);
    } finally {
      merging.delete(id);
    }
  }

  return { status, merge };
}

function refuse(status, error) {
  return { ok: false, status, error };
}
