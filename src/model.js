// Builds the snapshot the page draws: the person, projects, sessions and
// sub-agents as a tree, the lines between them, and a feed of hand-offs.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { cleanSettings, isNodeKey } from './config.js';

export const PULSE_MS = 120000;

const MAX_EVENTS = 200;
const MAX_TITLE = 120;
const MAX_TEXT = 280;
const MAX_LABEL = 40;
const MAX_SOURCE = 4000;
const SPAWN_GRACE_MS = 60000;
const HOUR_MS = 3600000;
const MINUTE_MS = 60000;
const STATUSES = ['working', 'ready', 'idle', 'done', 'error'];
const KINDS = ['session', 'agent', 'reviewer'];
const NO_PROJECT = 'Other';
const GIT_CACHE_MAX = 500;

const RANKS = {
  plain: { superintendent: 'Superintendent', coordinator: 'Coordinator', lead: 'Lead', worker: 'Agent' },
  military: { person: 'General', superintendent: 'Colonel', coordinator: 'Sergeant', lead: 'Sergeant', worker: 'Private' },
  company: { person: 'Owner', superintendent: 'Vice President', coordinator: 'Manager', lead: 'Supervisor', worker: 'Worker' },
};

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
const gitCache = new Map();

// `actions` says which actions the page may offer: { openTerminal } is true when the Open in
// PowerShell button is turned on and can work on this computer.
export function buildSnapshot({ now, settings, claude = null, codex = null, grok = null, kimi = null, mailbox = null, dismissed = null, actions = null } = {}) {
  const s = cleanSettings(settings);
  const ctx = {
    now: Number.isFinite(now) ? now : Date.now(),
    settings: s,
    snippets: s.content === 'snippets',
  };
  const box = isObject(mailbox) ? mailbox : null;
  const all = collectSessions([claude, codex, grok, kimi]);
  const workers = mailboxWorkers(box, ctx, all);
  for (const worker of workers) all.set(worker.key, worker);
  ctx.relayWorkers = new Set(workers.map((worker) => worker.key));
  const tree = buildTree(all, ctx, box);
  const links = linkParts(tree, all, ctx);
  const runs = workerRuns(workers, tree, links.pairs, ctx);
  const mail = mailboxParts(box, tree, ctx);
  const nodes = tree.order.map((key) => tree.nodes.get(key));
  markWatched(nodes, ctx);
  const sessionNodes = nodes.filter((node) => KINDS.includes(node.kind));
  const hidden = dismissedAt(dismissed);
  // A dismissed ask stops showing as "Needs you" until a newer one comes.
  for (const node of sessionNodes) {
    if (node.needs && hidden(`${node.key}|needs`) >= (node.needs.at ?? 0)) node.needs = null;
  }
  const tasks = isObject(mailbox) ? cleanTasks(mailbox, ctx) : null;
  return {
    version: 1,
    now: ctx.now,
    sources: {
      claude: sourceInfo(claude, sessionsOf(claude).length),
      codex: sourceInfo(codex, sessionsOf(codex).length),
      grok: sourceInfo(grok, sessionsOf(grok).length),
      kimi: sourceInfo(kimi, sessionsOf(kimi).length),
      mailbox: tasks ? sourceInfo(mailbox, tasks.length) : null,
    },
    nodes,
    edges: mergeEdges([...treeEdges(tree, links.pairs, ctx), ...messageEdges(tree, links.pairs, ctx)], mail.edges, ctx),
    events: sortEvents([...links.events, ...runs, ...mail.events, ...errorEvents(sessionNodes, ctx)]),
    counts: countStatuses(sessionNodes),
    attention: attentionList(sessionNodes, tasks ?? [], [...mailboxAttention(box, tree, ctx), ...watchAttention(nodes, all, box, ctx)])
      .filter((item) => !(hidden(item.id) >= item.at)),
    tasks,
    actions: { openTerminal: actions?.openTerminal === true },
  };
}

// The snapshot's weak ETag. `now` is left out: it changes on every build even when nothing else
// does, and the page uses it only to allow for a clock difference, so a 304 can skip it.
export function snapshotTag(snapshot) {
  const json = JSON.stringify(isObject(snapshot) ? { ...snapshot, now: 0 } : snapshot ?? null);
  return `W/"${crypto.createHash('sha1').update(json).digest('hex')}"`;
}

// ---- names and labels ----

// The last folder of `cwd`, or the repository folder when `cwd` is inside a worktrees folder.
export function projectName(cwd) {
  if (typeof cwd !== 'string' || !cwd.trim()) return NO_PROJECT;
  const clean = cwd.trim().replace(/^\\\\\?\\(UNC\\)?/i, (m) => (m.length > 4 ? '//' : '')).replace(/\\/g, '/');
  const prefix = clean.startsWith('//') ? '//' : clean.startsWith('/') ? '/' : '';
  const parts = clean.split('/').filter((part) => part && part !== '.');
  if (parts.length === 0) return NO_PROJECT;
  const name = worktreeRepo(parts, prefix) || parts[parts.length - 1];
  return clipName(name);
}

function worktreeRepo(parts, prefix) {
  const lower = parts.map((part) => part.toLowerCase());
  for (let i = 0; i < parts.length; i++) {
    // <home>/.codex/worktrees/<id>/<repo>
    if (lower[i] === '.codex' && lower[i + 1] === 'worktrees' && parts[i + 3]) return parts[i + 3];
    // <repo>/.claude/worktrees/<name>
    if (lower[i] === '.claude' && lower[i + 1] === 'worktrees' && i > 0) return parts[i - 1];
    // <anywhere>/_worktrees/<name>: the folder name alone does not say which repository it is.
    if (lower[i] === '_worktrees' && parts[i + 1]) {
      return gitRepoName(parts.slice(0, i + 2), prefix) || parts[i + 1];
    }
  }
  return null;
}

// A worktree has a `.git` file that points into `<repo>/.git/worktrees/<name>`.
// Only local absolute folders are read: a network share could stall every snapshot.
function gitRepoName(dirParts, prefix) {
  const local = prefix === '/' || (process.platform === 'win32' && /^[a-z]:$/i.test(dirParts[0]));
  if (!local) return null;
  const dir = prefix + dirParts.join('/');
  if (gitCache.has(dir)) return gitCache.get(dir);
  let name = null;
  try {
    const file = `${dir}/.git`;
    // stat first: a pipe or a huge file must not block or fill memory.
    const stat = fs.statSync(file);
    if (stat.isFile() && stat.size <= 4096) name = repoFromGitFile(fs.readFileSync(file, 'utf8'), dirParts);
  } catch {
    // Not a worktree, or it was removed: the caller falls back to the folder name.
  }
  if (gitCache.size >= GIT_CACHE_MAX) gitCache.clear();
  gitCache.set(dir, name);
  return name;
}

// `gitdir:` may be relative to the worktree folder (git worktree add --relative-paths).
function repoFromGitFile(text, dirParts) {
  const match = /^gitdir:\s*(.+)$/m.exec(text);
  if (!match) return null;
  const target = match[1].trim().replace(/\\/g, '/');
  const absolute = target.startsWith('/') || /^[a-z]:/i.test(target);
  const parts = [];
  for (const part of [...(absolute ? [] : dirParts), ...target.split('/')]) {
    if (part === '..') parts.pop();
    else if (part && part !== '.') parts.push(part);
  }
  const at = parts.map((part) => part.toLowerCase()).lastIndexOf('worktrees');
  if (at >= 2 && parts[at - 1].toLowerCase() === '.git') return parts[at - 2];
  if (at >= 1 && /.\.git$/i.test(parts[at - 1])) return parts[at - 1].slice(0, -4);
  return null;
}

function clipName(name) {
  const flat = name.replace(/\p{Cc}+/gu, ' ').trim();
  const chars = Array.from(flat);
  const clipped = chars.length <= 120 ? flat : chars.slice(0, 120).join('').trim();
  return clipped || NO_PROJECT;
}

// A short readable model name: 'claude-opus-5-5' -> 'Opus 5.5', 'gpt-6.1-sol' -> 'GPT-6.1 Sol'.
export function modelLabel(model) {
  if (typeof model !== 'string') return null;
  const m = model
    .trim()
    .toLowerCase()
    .replace(/\[[^\]]*\]$/, '')
    .replace(/^.*\//, '')
    .replace(/^([a-z]{2}\.)?anthropic\./, '')
    .replace(/-v\d+(:\d+)?$/, '')
    .replace(/[@-]\d{8}$/, '');
  if (!m || m.startsWith('<')) return null;
  let match = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?$/.exec(m);
  if (match) return clipLabel(`${capital(match[1])} ${version(match[2], match[3])}`);
  match = /^claude-(\d+)(?:-(\d{1,2}))?-([a-z]+)$/.exec(m);
  if (match) return clipLabel(`${capital(match[3])} ${version(match[1], match[2])}`);
  match = /^gpt-(\d[a-z0-9.]*)((?:-[a-z0-9.]+)*)$/.exec(m);
  if (match) return clipLabel([`GPT-${match[1]}`, ...words(match[2])].join(' '));
  // Kimi Code names its models k2, k3 and so on, sometimes with "kimi-" in front.
  match = /^(?:kimi-)?k(\d[a-z0-9.]*)((?:-[a-z0-9.]+)*)$/.exec(m);
  if (match) return clipLabel([`Kimi K${match[1]}`, ...words(match[2])].join(' '));
  return clipLabel(words(m).join(' ')) || null;
}

function version(major, minor) {
  return minor ? `${major}.${minor}` : major;
}

function words(text) {
  return text
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((word) => (/^[a-z]+$/.test(word) ? capital(word) : word));
}

function capital(word) {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

function clipLabel(label) {
  return label.length <= MAX_LABEL ? label : label.slice(0, MAX_LABEL).trim();
}

// 'senior', 'junior' or null, from whole-word matches of the tier words in the model name.
export function modelTier(model, tiers) {
  if (typeof model !== 'string' || !model) return null;
  const name = model.toLowerCase();
  // A model picked by its exact name wins over the words, so "gpt-6.1-sol" can be senior even
  // while the word "sol" is junior.
  if (Array.isArray(tiers?.senior) && tiers.senior.includes(name)) return 'senior';
  if (Array.isArray(tiers?.junior) && tiers.junior.includes(name)) return 'junior';
  if (hasAnyWord(name, tiers?.senior)) return 'senior';
  if (hasAnyWord(name, tiers?.junior)) return 'junior';
  return null;
}

function hasAnyWord(name, list) {
  return Array.isArray(list) && list.some((word) => typeof word === 'string' && hasWord(name, word.toLowerCase()));
}

function hasWord(name, word) {
  if (!word) return false;
  for (let i = name.indexOf(word); i !== -1; i = name.indexOf(word, i + 1)) {
    const end = i + word.length;
    if (!isWordChar(name[i - 1]) && !isWordChar(name[end])) return true;
  }
  return false;
}

function isWordChar(ch) {
  return ch !== undefined && /[a-z0-9]/.test(ch);
}

function rankOf(theme, role, kind, tier) {
  const ranks = RANKS[theme] || RANKS.plain;
  if (kind === 'person') return ranks.person ?? null;
  if (kind === 'project') return null;
  if (theme === 'plain' && kind === 'reviewer' && role === 'worker') return 'Reviewer';
  if (theme === 'military' && role === 'worker' && tier === 'senior') return 'Specialist';
  return ranks[role] ?? null;
}

// ---- sessions ----

function collectSessions(results) {
  const byKey = new Map();
  for (const result of results) {
    for (const raw of sessionsOf(result)) {
      const session = cleanSession(raw);
      if (session && !byKey.has(session.key)) byKey.set(session.key, session);
    }
  }
  return byKey;
}

function cleanSession(raw) {
  if (!isObject(raw) || typeof raw.key !== 'string' || !/^(claude|codex|grok|kimi):./.test(raw.key)) return null;
  const parentKey = typeof raw.parentKey === 'string' && raw.parentKey && raw.parentKey !== raw.key ? raw.parentKey : null;
  return {
    key: raw.key,
    platform: raw.key.slice(0, raw.key.indexOf(':')),
    parentKey,
    kind: KINDS.includes(raw.kind) ? raw.kind : parentKey ? 'agent' : 'session',
    // A source may know a session's role, such as a Codex coordinator from its registry.
    role: ['superintendent', 'coordinator'].includes(raw.role) ? raw.role : null,
    spawned: raw.spawned === true,
    title: text(raw.title, MAX_TITLE),
    cwd: typeof raw.cwd === 'string' && raw.cwd.trim() ? raw.cwd.trim() : null,
    branch: text(raw.branch, MAX_TITLE),
    entrypoint: text(raw.entrypoint, 80),
    model: text(raw.model, 120),
    effort: text(raw.effort, 40),
    startedAt: time(raw.startedAt),
    lastAt: time(raw.lastAt),
    status: STATUSES.includes(raw.status) ? raw.status : 'idle',
    activity: cleanActivity(raw.activity),
    lastText: snippet(raw.lastText, MAX_TEXT),
    needs: cleanNeeds(raw.needs),
    links: Array.isArray(raw.links) ? raw.links : [],
    archived: raw.archived === true,
  };
}

const NEEDS = ['question', 'plan', 'blocked', 'input', 'permission'];
function cleanNeeds(raw) {
  if (!isObject(raw) || !NEEDS.includes(raw.kind)) return null;
  return { kind: raw.kind, text: snippet(raw.text, MAX_TEXT), at: time(raw.at) };
}

function cleanActivity(raw) {
  if (!isObject(raw)) return null;
  const at = time(raw.at);
  if (at === null) return null;
  return { tool: text(raw.tool, 80), detail: snippet(raw.detail, 140), at };
}

function isListed(session, ctx) {
  const { settings } = ctx;
  const at = session.lastAt ?? session.startedAt;
  if (at === null || at < ctx.now - settings.window.recentHours * HOUR_MS) return false;
  if (session.archived) return false;
  if (entry(settings.people, session.key)?.role === 'hidden') return false;
  return session.kind !== 'reviewer' || settings.showReviewers;
}

// A coordinator waiting for the person goes quiet, but it is still the boss of those below it. It
// stays on the map while a chain rule names it or something on the map works for it. Other quiet
// coordinators drop off like any old session.
function quietBosses(all, ctx) {
  const { settings } = ctx;
  const keep = new Set();
  const quiet = (s) => !s.archived && (s.role === 'coordinator' || s.role === 'superintendent') && !isListed(s, ctx);
  for (const session of all.values()) {
    if (quiet(session) && !session.spawned && chainRule(settings.chain, session, settings)) keep.add(session.key);
  }
  for (const session of all.values()) {
    if (!isListed(session, ctx)) continue;
    const boss = all.get(session.parentKey ?? '');
    if (boss && quiet(boss)) keep.add(boss.key);
  }
  return keep;
}

// A sub-agent with no folder of its own belongs to its parent's project.
function projectFor(session, all, memo, depth = 0) {
  if (memo.has(session.key)) return memo.get(session.key);
  let name = NO_PROJECT;
  if (session.cwd) name = projectName(session.cwd);
  else if (session.parentKey && all.has(session.parentKey) && depth < 32) {
    name = projectFor(all.get(session.parentKey), all, memo, depth + 1);
  }
  memo.set(session.key, name);
  return name;
}

// ---- tree ----

function buildTree(all, ctx, mailbox) {
  const { settings } = ctx;
  const memo = new Map();
  const nodes = new Map();
  const homes = new Map();
  const rules = new Map();
  const keep = quietBosses(all, ctx);
  for (const session of [...all.values()].sort(byKey)) {
    if (!isListed(session, ctx) && !keep.has(session.key)) continue;
    const name = projectFor(session, all, memo);
    const project = entry(settings.projects, name);
    if (project?.hidden === true) continue;
    // Rules sort out sessions; a helper that a session started itself stays under that session.
    const rule = session.spawned ? null : chainRule(settings.chain, session, settings);
    if (rule) rules.set(session.key, rule);
    nodes.set(session.key, sessionNode(session, name, ctx, rule));
    homes.set(session.key, settings.groupBy === 'project' ? projectKey(name) : 'you');
  }
  if (mailbox && isObject(mailbox.relay)) {
    const relay = relayNode(mailbox, settings);
    nodes.set(RELAY, relay);
    homes.set(RELAY, 'you');
    const rule = chainRule(settings.chain, { key: RELAY, title: relay.title }, settings);
    if (rule) rules.set(RELAY, rule);
  }

  const parentOf = new Map();
  for (const [key, node] of nodes) {
    const parentKey = all.get(key)?.parentKey ?? null;
    parentOf.set(key, parentKey && nodes.has(parentKey) ? parentKey : homes.get(key));
    node.parent = parentOf.get(key);
  }
  ctx.mailboxKeys = { ...mailboxKeys(mailbox, nodes, settings), workers: ctx.relayWorkers ?? new Set() };
  applyChain(nodes, parentOf, homes, rules, ctx.mailboxKeys, settings);
  breakCycles(nodes, parentOf, homes);

  nodes.set('you', personNode(settings.displayName, settings.titles));
  for (const [key, parent] of parentOf) {
    if (parent.startsWith('project:') && !nodes.has(parent)) {
      const name = parent.slice('project:'.length);
      nodes.set(parent, projectNode(parent, entry(settings.projects, name)?.label || name, name));
      parentOf.set(parent, 'you');
    }
    nodes.get(key).parent = parentOf.get(key);
  }

  const order = treeOrder(nodes, parentOf);
  rollUp(nodes, order);
  return { nodes, parentOf, order };
}

// ---- chain of command ----

// The first rule whose `match` is in the session's name (its own title or the name the person gave
// it), ignoring case.
function chainRule(chain, session, settings) {
  if (!Array.isArray(chain) || chain.length === 0) return null;
  const names = [session.title, entry(settings.people, session.key)?.label].filter(Boolean).map((n) => n.toLowerCase());
  return chain.find((rule) => names.some((name) => name.includes(rule.match.toLowerCase()))) ?? null;
}

// A key that is listed, 'you', or the newest listed session whose name contains the text. Newest by
// last activity, so a rule follows a role when a new session takes it over.
// A whole-name match ("Sergeant Claude" for "**Sergeant Claude", ignoring the marks around a name)
// beats a name that only contains the text ("Sergeant Claude Code"); then the newest wins.
function findSession(ref, nodes, self = null) {
  if (typeof ref !== 'string' || !ref) return null;
  if (ref === 'you') return 'you';
  if (nodes.has(ref)) return ref === self ? null : ref;
  const needle = ref.toLowerCase();
  const whole = bareName(needle);
  let best = null;
  let bestScore = null;
  for (const [key, node] of nodes) {
    const title = String(node.title || '').toLowerCase();
    if (key === self || !title.includes(needle)) continue;
    const score = [bareName(title) === whole ? 1 : 0, node.lastAt ?? -Infinity];
    const better = !best || score[0] > bestScore[0] || (score[0] === bestScore[0] && (score[1] > bestScore[1] || (score[1] === bestScore[1] && key < best)));
    if (better) {
      best = key;
      bestScore = score;
    }
  }
  return best;
}

function bareName(text) {
  return text.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
}

function mailboxKeys(mailbox, nodes, settings) {
  if (!mailbox) return { planner: null, coordinator: null };
  const config = settings.sources.mailbox;
  const relayKey = isObject(mailbox.relay) && typeof mailbox.relay.coordinatorKey === 'string' ? mailbox.relay.coordinatorKey : null;
  const found = findSession(config.coordinator || relayKey, nodes);
  const coordinator = found === 'you' ? null : found;
  // The planner is never the coordinator itself, even when one name contains the other.
  const planner = findSession(config.planner, nodes, coordinator);
  return { planner: planner === 'you' ? null : planner, coordinator };
}

// Who reports to whom, strongest first: the person's own choice (People, the Reports to menu or a
// drag on the map), the mailbox (planner -> relay -> coordinator -> its workers, which are fixed
// links like a helper under the session that started it), a chain rule, and last what the session
// files say. A choice or rule whose boss is not on the map changes nothing.
function applyChain(nodes, parentOf, homes, rules, keys, settings) {
  for (const [key, node] of nodes) {
    let boss = null;
    let placement = 'auto';
    const chosen = entry(settings.people, key)?.reportsTo;
    if (chosen) {
      boss = findSession(chosen, nodes, key);
      if (boss) placement = 'manual';
    }
    if (!boss) boss = mailboxBoss(key, nodes, keys);
    if (!boss && rules.has(key)) {
      boss = findSession(rules.get(key).reportsTo, nodes, key);
      if (boss) placement = 'rule';
    }
    if (boss === 'you') parentOf.set(key, homes.get(key));
    else if (boss) parentOf.set(key, boss);
    node.placement = placement;
  }
  throughRelay(nodes, parentOf, homes, keys);
}

// The relay carries the coordinator's work to and from the boss the relay reports to. So when the
// coordinator is put right under that same boss (a choice made before the relay had a tile, say),
// it goes under the relay instead, which sits between them the way the work really runs.
function throughRelay(nodes, parentOf, homes, keys) {
  const { coordinator } = keys;
  const boss = parentOf.get(RELAY);
  if (!coordinator || !nodes.has(RELAY) || !nodes.has(coordinator) || !boss || boss === coordinator) return;
  if (boss !== homes.get(RELAY) && parentOf.get(coordinator) === boss) parentOf.set(coordinator, RELAY);
}

function mailboxBoss(key, nodes, keys) {
  const relay = nodes.has(RELAY) ? RELAY : null;
  if (key === RELAY) return keys.planner;
  if (key === keys.coordinator) return relay ?? (keys.planner !== key ? keys.planner : null);
  if (keys.workers?.has(key)) return keys.coordinator ?? relay;
  return null;
}

// Malformed parent links could form a loop; the first member of a loop moves to its project.
function breakCycles(nodes, parentOf, homes) {
  for (const key of [...nodes.keys()].sort()) {
    const seen = new Set();
    for (let p = parentOf.get(key); nodes.has(p); p = parentOf.get(p)) {
      if (p === key) {
        parentOf.set(key, homes.get(key));
        break;
      }
      if (seen.has(p)) break;
      seen.add(p);
    }
  }
}

function treeOrder(nodes, parentOf) {
  const children = new Map();
  for (const [key, parent] of parentOf) {
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(key);
  }
  const compare = (a, b) => collator.compare(nodes.get(a).title, nodes.get(b).title) || (a < b ? -1 : a > b ? 1 : 0);
  const order = [];
  const stack = ['you'];
  while (stack.length) {
    const key = stack.pop();
    order.push(key);
    const kids = (children.get(key) || []).sort(compare);
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
  }
  return order;
}

// Projects and the person show how many sessions they hold and when anything last moved.
function rollUp(nodes, order) {
  const counts = new Map();
  for (let i = order.length - 1; i > 0; i--) {
    const node = nodes.get(order[i]);
    const parent = nodes.get(node.parent);
    if (!parent) continue;
    const own = KINDS.includes(node.kind) ? 1 : 0;
    counts.set(parent.key, (counts.get(parent.key) || 0) + own + (counts.get(node.key) || 0));
    if (node.lastAt !== null && (parent.lastAt === null || node.lastAt > parent.lastAt)) parent.lastAt = node.lastAt;
  }
  for (const node of nodes.values()) {
    if (node.kind !== 'project') continue;
    const n = counts.get(node.key) || 0;
    node.subtitle = n === 1 ? '1 session' : `${n} sessions`;
  }
}

function sessionNode(session, project, ctx, rule = null) {
  const { settings, snippets } = ctx;
  const person = entry(settings.people, session.key);
  const role = person?.role || rule?.role || session.role || (session.kind === 'session' ? 'lead' : 'worker');
  const tier = modelTier(session.model, settings.modelTiers);
  const activity = session.activity && { ...session.activity, detail: snippets ? session.activity.detail : null };
  return {
    key: session.key,
    parent: null,
    platform: session.platform,
    kind: session.kind,
    title: person?.label || session.title || fallbackTitle(session),
    subtitle: session.branch,
    rank: rankOf(settings.titles, role, session.kind, tier),
    role,
    tier,
    model: session.model,
    modelLabel: modelLabel(session.model),
    effort: session.effort,
    status: session.status,
    startedAt: session.startedAt,
    lastAt: session.lastAt,
    activity,
    lastText: snippets ? session.lastText : null,
    needs: session.needs && { ...session.needs, text: snippets ? session.needs.text : null },
    project,
    projectLabel: entry(settings.projects, project)?.label || project,
    entrypoint: session.entrypoint,
    hidden: false,
    archived: false,
    named: Boolean(person?.label || session.title),
    placement: 'auto',
  };
}

function fallbackTitle(session) {
  const tail = session.key.slice(Math.max(session.key.lastIndexOf('/'), session.key.indexOf(':')) + 1);
  const word = session.kind === 'session' ? 'Session' : session.kind === 'reviewer' ? 'Reviewer' : 'Agent';
  return `${word} ${tail.slice(0, 8)}`.trim();
}

function personNode(displayName, theme) {
  return groupNode({ key: 'you', parent: null, platform: 'human', kind: 'person', title: displayName, rank: rankOf(theme, null, 'person', null) });
}

function projectNode(key, title, name) {
  return groupNode({ key, parent: 'you', platform: 'group', kind: 'project', title, rank: null, project: name });
}

function groupNode({ key, parent, platform, kind, title, rank, project = null }) {
  return {
    key, parent, platform, kind, title, subtitle: null, rank, role: null, tier: null,
    model: null, modelLabel: null, effort: null, status: null, startedAt: null, lastAt: null,
    activity: null, lastText: null, needs: null, project, projectLabel: project, entrypoint: null, hidden: false, archived: false,
    named: false, placement: null,
  };
}

// ---- mailbox relay and its workers ----

const RELAY = 'relay';
const WORKER_ID = /^W\d{1,4}$/;

// The relay between a mailbox's planner and coordinator, as a tile of its own.
function relayNode(mailbox, settings) {
  const relay = mailbox.relay;
  const node = groupNode({
    key: RELAY, parent: null, platform: 'relay', kind: 'relay',
    title: entry(settings.people, RELAY)?.label || 'Relay', rank: 'Relay',
  });
  node.subtitle = text(mailbox.name, 80);
  node.status = relay.halted ? 'error' : relay.running && !relay.paused ? 'working' : 'idle';
  node.named = true;
  node.placement = 'auto';
  return node;
}

// Each relay worker run goes under the coordinator. When its run note names a Claude Code session
// that Pleni can see, that session is the worker's tile, so it can be watched and opened. Older
// runs kept no session file, so their run note becomes a session-like node instead.
function mailboxWorkers(mailbox, ctx, all) {
  const out = [];
  if (!mailbox || !Array.isArray(mailbox.tasks)) return out;
  for (const task of mailbox.tasks) {
    if (!isObject(task) || typeof task.id !== 'string' || !Array.isArray(task.workers)) continue;
    const about = ctx.snippets ? snippet(task.title, MAX_TITLE) : null;
    for (const run of task.workers) {
      if (!isObject(run) || typeof run.id !== 'string' || !WORKER_ID.test(run.id)) continue;
      const key = `mailbox:${task.id}/${run.id}`;
      if (!isNodeKey(key)) continue;
      const startedAt = time(run.startedAt);
      const finishedAt = time(run.finishedAt);
      const name = about && about !== task.id ? `${run.id} · ${task.id}: ${about}` : `${run.id} · ${task.id}`;
      const runInfo = { startedAt, finishedAt, label: about ? `${task.id}: ${about}` : task.id };
      const own = typeof run.sessionId === 'string' ? all.get(`claude:${run.sessionId}`) : null;
      if (own && !own.parentKey) {
        out.push({ ...own, title: text(name, MAX_TITLE), role: null, run: runInfo });
        continue;
      }
      out.push({
        key, platform: 'claude', parentKey: null, kind: 'agent', role: null,
        title: text(name, MAX_TITLE),
        cwd: typeof run.worktree === 'string' && run.worktree.trim() ? run.worktree.trim() : null,
        branch: null, entrypoint: 'relay worker', model: text(run.model, 120), effort: null,
        startedAt, lastAt: finishedAt ?? startedAt, status: runStatus(run.state, finishedAt),
        activity: null, lastText: null, needs: null, links: [], archived: false,
        run: runInfo,
      });
    }
  }
  return out;
}

function runStatus(state, finishedAt) {
  const s = typeof state === 'string' ? state.toLowerCase() : '';
  if (s.startsWith('fail') || s === 'error') return 'error';
  if ((s === 'running' || s === 'launching') && finishedAt === null) return 'working';
  if (finishedAt !== null || ['finished', 'done', 'complete', 'completed'].includes(s)) return 'done';
  return 'idle';
}

// A worker run lights the line from whoever it hangs under: work going down when it started, a
// report coming up when it finished.
function workerRuns(workers, tree, pairs, ctx) {
  const events = [];
  for (const worker of workers) {
    const node = tree.nodes.get(worker.key);
    const boss = node ? tree.nodes.get(node.parent) : null;
    if (!boss || boss.kind === 'person' || boss.kind === 'project') continue;
    const { startedAt, finishedAt, label } = worker.run;
    const words = ctx.snippets ? label : null;
    if (startedAt !== null) {
      lightPair(pairs, boss.key, worker.key, { dir: 'down', at: startedAt, label: words });
      events.push({ at: startedAt, kind: 'spawn', from: boss.key, to: worker.key, text: words });
    }
    if (finishedAt !== null) {
      lightPair(pairs, boss.key, worker.key, { dir: 'up', at: finishedAt, label: words });
      events.push({ at: finishedAt, kind: 'report', from: worker.key, to: boss.key, text: words });
    }
  }
  return events;
}

// Messages between tiles that are not joined by a tree line (two Sergeants, say) get a line of
// their own, but only while they are moving, so the map does not fill up with old traffic.
function messageEdges(tree, pairs, ctx) {
  const out = [];
  for (const [id, pair] of pairs) {
    const [from, to] = id.split('\n');
    const a = tree.nodes.get(from);
    const b = tree.nodes.get(to);
    if (!a || !b || a.kind === 'person' || a.kind === 'project' || b.kind === 'person' || b.kind === 'project') continue;
    if (b.parent === from || a.parent === to) continue;
    const line = edge(from, to, 'message', pair, ctx);
    if (line.active) out.push(line);
  }
  return out;
}

function projectKey(name) {
  return `project:${name}`;
}

// ---- links, edges and events ----

function linkParts(tree, all, ctx) {
  // Directions follow the map as drawn, after chain rules and the person's choices, so a report
  // from a Sergeant to the Colonel it was moved under lights that line upward.
  const lineage = ancestry(tree.parentOf);
  const records = new Map();
  for (const key of tree.order) {
    if (!all.has(key)) continue;
    const session = all.get(key);
    for (const link of session.links.slice(-50)) {
      const record = cleanLink(link, session, lineage, ctx);
      if (!record) continue;
      const id = `${record.at}|${record.dir}|${record.upper}|${record.lower}`;
      if (!records.has(id)) records.set(id, record);
    }
  }
  const sorted = [...records.values()].sort(
    (a, b) => a.at - b.at || cmp(a.dir, b.dir) || cmp(a.upper, b.upper) || cmp(a.lower, b.lower) || cmp(a.label, b.label),
  );

  const pairs = new Map();
  const seenDown = new Set();
  const events = [];
  for (const record of sorted) {
    let kind = 'report';
    if (record.dir === 'down') {
      const pairId = `${record.upper}\n${record.lower}`;
      const lowerStart = all.get(record.lower)?.startedAt ?? null;
      const first = !seenDown.has(pairId);
      seenDown.add(pairId);
      // Only a parent starts a sub-agent; a hand-off that skips a level is a message.
      const spawn = first && record.hops.length === 1 && (lowerStart === null || record.at <= lowerStart + SPAWN_GRACE_MS);
      kind = spawn ? 'spawn' : 'message';
    }
    const from = record.dir === 'down' ? record.upper : record.lower;
    const to = record.dir === 'down' ? record.lower : record.upper;
    // A known session that is not shown (hidden, archived, old, a reviewer) keeps its hand-offs
    // out of the feed, and off the lines of the sessions in between.
    if (leftOut(tree, all, from) || leftOut(tree, all, to)) continue;
    for (const [upper, lower] of record.hops) lightPair(pairs, upper, lower, record);
    const event = { at: record.at, kind, from: listed(tree, from), to: listed(tree, to), text: record.label };
    if (event.from || event.to) events.push(event);
  }
  return { pairs, events };
}

// Links are mostly kept by the upper party. A session records only what it did itself, so a link
// it keeps toward any of its ancestors (a parent, or "/root" two levels up) is a report up. A link
// toward a descendant keeps its own direction. `hops` are the tree edges the line runs along.
function cleanLink(link, session, lineage, ctx) {
  if (!isObject(link) || typeof link.other !== 'string' || !link.other) return null;
  const at = time(link.at);
  if (at === null || (link.dir !== 'down' && link.dir !== 'up')) return null;
  const label = ctx.snippets ? snippet(link.label, MAX_TITLE) : null;
  const above = lineage(session.key);
  const up = above.indexOf(link.other);
  if (up !== -1) {
    const chain = [session.key, ...above.slice(0, up + 1)];
    return { at, dir: 'up', upper: link.other, lower: session.key, hops: hops(chain), label };
  }
  const below = lineage(link.other);
  const down = below.indexOf(session.key);
  const chain = down === -1 ? [link.other, session.key] : [link.other, ...below.slice(0, down + 1)];
  return { at, dir: link.dir, upper: session.key, lower: link.other, hops: hops(chain), label };
}

// Each session's known ancestors, nearest first. A parent that is not a known session ends the
// chain; so do a loop and a very deep chain.
function ancestry(parentOf) {
  const memo = new Map();
  const up = (key) => {
    const p = parentOf.get(key) ?? null;
    return p === 'you' || (typeof p === 'string' && p.startsWith('project:')) ? null : p;
  };
  return (key) => {
    if (!memo.has(key)) {
      const chain = [];
      let p = up(key);
      while (p && p !== key && !chain.includes(p) && chain.length < 32) {
        chain.push(p);
        p = up(p);
      }
      memo.set(key, chain);
    }
    return memo.get(key);
  };
}

// [child, parent, grandparent, ...] -> [[parent, child], [grandparent, parent], ...]
function hops(chain) {
  const list = [];
  for (let i = 1; i < chain.length; i++) list.push([chain[i], chain[i - 1]]);
  return list;
}

// Records arrive oldest first, so the last one on each edge wins.
function lightPair(pairs, upper, lower, record) {
  const id = `${upper}\n${lower}`;
  if (!pairs.has(id)) pairs.set(id, { lastDown: null, lastUp: null, downLabel: null, upLabel: null });
  const pair = pairs.get(id);
  if (record.dir === 'down') Object.assign(pair, { lastDown: record.at, downLabel: record.label });
  else Object.assign(pair, { lastUp: record.at, upLabel: record.label });
}

function treeEdges(tree, pairs, ctx) {
  const edges = [];
  for (const key of tree.order) {
    const node = tree.nodes.get(key);
    if (!node.parent) continue;
    const parent = tree.nodes.get(node.parent);
    if (parent.kind === 'person' || parent.kind === 'project') {
      edges.push(edge(parent.key, key, 'contains', null, ctx));
    } else {
      edges.push(edge(parent.key, key, 'spawn', pairs.get(`${parent.key}\n${key}`), ctx));
    }
  }
  return edges;
}

// When the mailbox coordinator hangs under its planner, the tree line and the mailbox line are the
// same line: keep one, lit by whichever moved last.
function mergeEdges(treeList, mailList, ctx) {
  const out = [...treeList];
  for (const mail of mailList) {
    const same = out.find((e) => e.from === mail.from && e.to === mail.to);
    if (!same) {
      out.push(mail);
      continue;
    }
    const newer = (a, b) => (a === null ? b : b === null ? a : Math.max(a, b));
    if (mail.lastDown !== null && (same.lastDown === null || mail.lastDown >= same.lastDown)) same.downLabel = mail.downLabel;
    if (mail.lastUp !== null && (same.lastUp === null || mail.lastUp >= same.lastUp)) same.upLabel = mail.upLabel;
    same.lastDown = newer(same.lastDown, mail.lastDown);
    same.lastUp = newer(same.lastUp, mail.lastUp);
    same.kind = 'mailbox';
    same.active = activeFor(same.lastDown, same.lastUp, ctx.now);
  }
  return out;
}

function edge(from, to, kind, stats, ctx) {
  const lastDown = stats?.lastDown ?? null;
  const lastUp = stats?.lastUp ?? null;
  return {
    from,
    to,
    kind,
    lastDown,
    lastUp,
    downLabel: stats?.downLabel ?? null,
    upLabel: stats?.upLabel ?? null,
    active: activeFor(lastDown, lastUp, ctx.now),
  };
}

function activeFor(lastDown, lastUp, now) {
  const down = lastDown !== null && now - lastDown <= PULSE_MS;
  const up = lastUp !== null && now - lastUp <= PULSE_MS;
  if (down && up) return 'both';
  return down ? 'down' : up ? 'up' : null;
}

function mailboxParts(mailbox, tree, ctx) {
  if (!mailbox) return { edges: [], events: [] };
  const { planner, coordinator } = ctx.mailboxKeys ?? { planner: null, coordinator: null };
  const relay = tree.nodes.has(RELAY) ? RELAY : null;
  const stats = { lastDown: null, lastUp: null, downLabel: null, upLabel: null };
  const events = [];
  const raw = Array.isArray(mailbox.events) ? mailbox.events : [];
  for (const item of [...raw].filter(isObject).sort((a, b) => (time(a.at) ?? 0) - (time(b.at) ?? 0))) {
    const at = time(item.at);
    if (at === null || (item.dir !== 'down' && item.dir !== 'up')) continue;
    const label = taskText(item, ctx);
    const down = item.dir === 'down';
    if (down && (stats.lastDown === null || at >= stats.lastDown)) Object.assign(stats, { lastDown: at, downLabel: label });
    if (!down && (stats.lastUp === null || at >= stats.lastUp)) Object.assign(stats, { lastUp: at, upLabel: label });
    events.push({ at, kind: 'mailbox', from: down ? planner : coordinator, to: down ? coordinator : planner, text: label });
  }
  // With a relay the work runs planner -> relay -> coordinator, and both legs light together.
  const legs = relay ? [[planner, relay], [relay, coordinator]] : [[planner, coordinator]];
  const edges = legs.filter(([a, b]) => a && b && a !== b).map(([a, b]) => edge(a, b, 'mailbox', stats, ctx));
  return { edges, events };
}

function taskText(item, ctx) {
  const id = text(item.taskId, 121);
  const title = ctx.snippets ? snippet(item.title, MAX_TITLE) : null;
  if (id && title) return `${id}: ${title}`;
  return id || title;
}

function errorEvents(sessionNodes, ctx) {
  return sessionNodes
    .filter((node) => node.status === 'error')
    .map((node) => ({ at: node.lastAt ?? node.startedAt ?? ctx.now, kind: 'error', from: node.key, to: null, text: node.lastText }));
}

function sortEvents(events) {
  return events
    .sort((a, b) => b.at - a.at || cmp(a.kind, b.kind) || cmp(a.from, b.from) || cmp(a.to, b.to) || cmp(a.text, b.text))
    .slice(0, MAX_EVENTS);
}

// ---- counts and attention ----

function countStatuses(sessionNodes) {
  const counts = { working: 0, ready: 0, idle: 0, done: 0, error: 0, needs: 0, total: sessionNodes.length };
  for (const node of sessionNodes) {
    counts[node.status]++;
    if (node.needs) counts.needs++;
  }
  return counts;
}

const NEEDS_TEXT = {
  question: 'is asking you a question.',
  plan: 'wants you to approve a plan.',
  blocked: 'is blocked until you act.',
  input: 'is asking for your input.',
  permission: 'is asking for permission to use a tool.',
};

function attentionList(sessionNodes, tasks, extra) {
  const list = [...extra];
  for (const node of sessionNodes) {
    const name = snippet(node.title, MAX_TITLE) || node.title;
    if (node.status === 'error') {
      list.push({ key: node.key, kind: 'error', text: `${name} stopped with an error.`, at: node.lastAt });
    }
    // Only a real ask counts. A session that just finished a reply is not waiting for anyone.
    if (node.needs) {
      list.push({ key: node.key, kind: 'needs', text: `${name} ${NEEDS_TEXT[node.needs.kind]}`, at: node.needs.at ?? node.lastAt });
    }
  }
  for (const task of tasks) {
    if (!isObject(task) || typeof task.id !== 'string' || !Array.isArray(task.attention)) continue;
    const name = snippet(task.title, MAX_TITLE) || task.id;
    const at = time(task.updatedAt);
    if (task.attention.includes('question')) {
      list.push({ key: `task:${task.id}`, kind: 'question', text: `${name} has a question that is holding up work.`, at });
    }
    if (task.attention.includes('review')) {
      list.push({ key: `task:${task.id}`, kind: 'review', text: `${name} is ready for review.`, at });
    }
  }
  // Every item has an id to dismiss it by, and a time (0 when unknown) to tell a newer one apart.
  for (const item of list) {
    item.id = `${item.key}|${item.kind}`;
    item.at = item.at ?? 0;
  }
  return list.sort((a, b) => b.at - a.at || cmp(a.key, b.key) || cmp(a.kind, b.kind));
}

// What the mailbox left for the person: the relay's alerts, a paused or halted relay, and the
// newest note in a NEEDS-<NAME>.md file. Alerts and notes older than the window do not count.
function mailboxAttention(mailbox, tree, ctx) {
  const out = [];
  if (!mailbox) return out;
  const since = ctx.now - ctx.settings.window.recentHours * HOUR_MS;
  const relay = isObject(mailbox.relay) && tree.nodes.has(RELAY) ? mailbox.relay : null;
  if (relay) {
    const alertAt = time(relay.alerts?.at);
    if (relay.halted) {
      const why = ctx.snippets ? snippet(relay.haltReason, MAX_TEXT) : null;
      const said = why ? `The relay stopped sending (${why}).` : 'The relay stopped sending. Its alerts.md file says why.';
      out.push({ key: RELAY, kind: 'halted', text: `${said} Fix the cause, then run bridge-relay.ps1 -ClearHalt.`, at: alertAt });
    } else if (alertAt !== null && alertAt >= since) {
      // A halted relay's newest alert is the halt itself, so it is not said twice.
      const what = ctx.snippets ? snippet(relay.alerts.text, MAX_TEXT) : null;
      out.push({ key: RELAY, kind: 'alert', text: what ? `The relay wrote an alert: ${what}` : 'The relay wrote an alert for you.', at: alertAt });
    }
    if (relay.paused) {
      out.push({ key: RELAY, kind: 'paused', text: 'The relay is paused, so it sends nothing. To go on, delete the PAUSE file in its .relay folder.', at: time(relay.pausedAt) });
    }
  }
  const notes = Array.isArray(mailbox.notes) ? mailbox.notes.filter((note) => isObject(note) && time(note.at) !== null) : [];
  const newest = notes.sort((a, b) => b.at - a.at)[0];
  if (newest && newest.at >= since) {
    const coordinator = ctx.mailboxKeys?.coordinator;
    const key = coordinator && tree.nodes.has(coordinator) ? coordinator : 'you';
    const file = text(newest.file, 80) || 'the mailbox';
    const what = ctx.snippets ? snippet(newest.text, MAX_TEXT) : null;
    out.push({ key, kind: 'note', text: what ? `New note for you in ${file}: ${what}` : `There is a new note for you in ${file}.`, at: newest.at });
  }
  return out;
}

// "Tell me if this stops working": a watched session that has done no work for alerts.stoppedMinutes,
// or a watched relay that has not run for that long. A session that asks something, or stopped with
// an error, already has its own notice. A tile's lastAt also counts the work of everything below it
// on the map, so the session's own time is used: a boss whose team still works has still stopped.
// The relay rewrites state.json every few seconds, even while paused, so an old file means it stopped
// or is stuck, even if its program is still there.
function watchAttention(nodes, all, mailbox, ctx) {
  const out = [];
  const minutes = ctx.settings.alerts.stoppedMinutes;
  const limit = minutes * MINUTE_MS;
  const span = minutes === 1 ? '1 minute' : `${minutes} minutes`;
  for (const node of nodes) {
    if (!node.watched) continue;
    if (node.key === RELAY) {
      const lastAt = time(mailbox?.relay?.lastAt);
      if (lastAt === null || ctx.now - lastAt < limit) continue;
      out.push({ key: RELAY, kind: 'stopped', text: `The relay has not run for ${span} or more, so nothing wakes the coordinator.`, at: lastAt });
      continue;
    }
    const lastAt = time(all.get(node.key)?.lastAt);
    if (node.status === 'working' || node.status === 'error' || node.needs || lastAt === null || ctx.now - lastAt < limit) continue;
    const name = snippet(node.title, MAX_TITLE) || node.title;
    out.push({ key: node.key, kind: 'stopped', text: `${name} has done no work for ${span} or more.`, at: lastAt });
  }
  return out;
}

// Sessions and the relay can be watched; mailbox worker runs and groups cannot.
function markWatched(nodes, ctx) {
  for (const node of nodes) {
    const can = node.key === RELAY || (KINDS.includes(node.kind) && !node.key.startsWith('mailbox:'));
    node.watched = can && entry(ctx.settings.people, node.key)?.watch === true;
  }
}

// Reads dismissals given as a Map or a plain object of id -> time.
function dismissedAt(dismissed) {
  return (id) => {
    let at;
    if (dismissed instanceof Map) at = dismissed.get(id);
    else if (isObject(dismissed) && Object.hasOwn(dismissed, id)) at = dismissed[id];
    return Number.isFinite(at) ? at : -Infinity;
  };
}

// ---- small helpers ----

function sourceInfo(result, count) {
  if (!isObject(result)) return { enabled: false, ok: true, error: null, count: 0 };
  const error = typeof result.error === 'string' && result.error ? result.error : null;
  return { enabled: true, ok: result.ok !== false, error, count };
}

function sessionsOf(result) {
  return isObject(result) && Array.isArray(result.sessions) ? result.sessions : [];
}

// Task titles come from assignment text, so with content 'none' a task shows only its id.
function cleanTasks(mailbox, ctx) {
  const tasks = Array.isArray(mailbox.tasks) ? mailbox.tasks : [];
  return tasks
    .filter((task) => isObject(task) && typeof task.id === 'string' && task.id)
    .map((task) => (ctx.snippets ? task : { ...task, title: task.id }));
}

function leftOut(tree, all, key) {
  return all.has(key) && !tree.nodes.has(key);
}

function listed(tree, key) {
  return typeof key === 'string' && tree.nodes.has(key) && KINDS.includes(tree.nodes.get(key).kind) ? key : null;
}

function entry(map, key) {
  return isObject(map) && typeof key === 'string' && Object.hasOwn(map, key) && isObject(map[key]) ? map[key] : null;
}

function text(value, max) {
  if (typeof value !== 'string') return null;
  const flat = value.replace(/\s+/g, ' ').trim();
  if (!flat) return null;
  const chars = Array.from(flat);
  return chars.length <= max ? flat : chars.slice(0, max).join('').trim();
}

// Session text is often Markdown. A snippet shows it as plain words, then clips it like `text`.
function snippet(value, max) {
  if (typeof value !== 'string') return null;
  // Snippets are short, so a huge input only needs its start (and never half a character pair).
  const head = value.length > MAX_SOURCE ? value.slice(0, MAX_SOURCE).replace(/[\uD800-\uDBFF]$/, '') : value;
  return text(plainText(head), max);
}

// A line that is only a rule (---, ***, ___) goes; so do heading, quote and list marks at the
// start of a line. Code keeps what is inside its backticks, a link keeps its label, a bare <url>
// becomes its host name, and ** and __ go.
const RULE_LINE = /^[ \t]*([-*_])(?:[ \t]*\1){2,}[ \t]*$/gm;
const LINE_MARKS = /^[ \t]*(?:(?:#{1,6}|>|[-*+])(?:[ \t]+|$))+/gm;
const INLINE_MARKS = /(`+)([^`]+?)\1(?!`)|!?\[([^[\]]*)\]\(((?:[^()\s]|\([^()\s]*\))*)(?:\)|$)|<([a-z][a-z0-9+.-]*:\/\/[^\s<>]+)>|`+|\*\*|__/gi;

function plainText(value) {
  return value
    .replace(RULE_LINE, '')
    .replace(LINE_MARKS, '')
    .replace(INLINE_MARKS, (match, ticks, code, label, url, autolink) => {
      if (ticks) return code;
      if (label !== undefined) return plainText(label);
      if (autolink) return hostName(autolink);
      return '';
    });
}

function hostName(url) {
  try {
    return new URL(url).hostname || url;
  } catch {
    return url;
  }
}

function time(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function cmp(a, b) {
  const x = a ?? '';
  const y = b ?? '';
  return x < y ? -1 : x > y ? 1 : 0;
}

function byKey(a, b) {
  return cmp(a.key, b.key);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
