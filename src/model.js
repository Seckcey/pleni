// Builds the snapshot the page draws: the person, projects, sessions and
// sub-agents as a tree, the lines between them, and a feed of hand-offs.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { cleanSettings } from './config.js';

export const PULSE_MS = 120000;

const MAX_EVENTS = 200;
const MAX_TITLE = 120;
const MAX_TEXT = 280;
const MAX_LABEL = 40;
const MAX_SOURCE = 4000;
const SPAWN_GRACE_MS = 60000;
const HOUR_MS = 3600000;
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

export function buildSnapshot({ now, settings, claude = null, codex = null, mailbox = null } = {}) {
  const s = cleanSettings(settings);
  const ctx = {
    now: Number.isFinite(now) ? now : Date.now(),
    settings: s,
    snippets: s.content === 'snippets',
  };
  const all = collectSessions([claude, codex]);
  const tree = buildTree(all, ctx);
  const links = linkParts(tree, all, ctx);
  const mail = mailboxParts(isObject(mailbox) ? mailbox : null, tree, ctx);
  const nodes = tree.order.map((key) => tree.nodes.get(key));
  const sessionNodes = nodes.filter((node) => KINDS.includes(node.kind));
  const tasks = isObject(mailbox) ? cleanTasks(mailbox, ctx) : null;
  return {
    version: 1,
    now: ctx.now,
    sources: {
      claude: sourceInfo(claude, sessionsOf(claude).length),
      codex: sourceInfo(codex, sessionsOf(codex).length),
      mailbox: tasks ? sourceInfo(mailbox, tasks.length) : null,
    },
    nodes,
    edges: [...treeEdges(tree, links.pairs, ctx), ...mail.edges],
    events: sortEvents([...links.events, ...mail.events, ...errorEvents(sessionNodes, ctx)]),
    counts: countStatuses(sessionNodes),
    attention: attentionList(sessionNodes, tasks ?? []),
    tasks,
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
  if (!isObject(raw) || typeof raw.key !== 'string' || !/^(claude|codex):./.test(raw.key)) return null;
  const parentKey = typeof raw.parentKey === 'string' && raw.parentKey && raw.parentKey !== raw.key ? raw.parentKey : null;
  return {
    key: raw.key,
    platform: raw.key.slice(0, raw.key.indexOf(':')),
    parentKey,
    kind: KINDS.includes(raw.kind) ? raw.kind : parentKey ? 'agent' : 'session',
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

const NEEDS = ['question', 'plan', 'blocked', 'input'];
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

function buildTree(all, ctx) {
  const { settings } = ctx;
  const memo = new Map();
  const nodes = new Map();
  const homes = new Map();
  for (const session of [...all.values()].sort(byKey)) {
    if (!isListed(session, ctx)) continue;
    const name = projectFor(session, all, memo);
    const project = entry(settings.projects, name);
    if (project?.hidden === true) continue;
    nodes.set(session.key, sessionNode(session, name, ctx));
    homes.set(session.key, settings.groupBy === 'project' ? projectKey(name) : 'you');
  }

  const parentOf = new Map();
  for (const [key, node] of nodes) {
    const parentKey = all.get(key).parentKey;
    parentOf.set(key, parentKey && nodes.has(parentKey) ? parentKey : homes.get(key));
    node.parent = parentOf.get(key);
  }
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

function sessionNode(session, project, ctx) {
  const { settings, snippets } = ctx;
  const person = entry(settings.people, session.key);
  const role = person?.role || (session.kind === 'session' ? 'lead' : 'worker');
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
  };
}

function projectKey(name) {
  return `project:${name}`;
}

// ---- links, edges and events ----

function linkParts(tree, all, ctx) {
  const lineage = ancestry(all);
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
function ancestry(all) {
  const memo = new Map();
  return (key) => {
    if (!memo.has(key)) {
      const chain = [];
      let p = all.get(key)?.parentKey ?? null;
      while (p && p !== key && !chain.includes(p) && chain.length < 32) {
        chain.push(p);
        p = all.get(p)?.parentKey ?? null;
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
  const config = ctx.settings.sources.mailbox;
  const relayKey = isObject(mailbox.relay) && typeof mailbox.relay.coordinatorKey === 'string' ? mailbox.relay.coordinatorKey : null;
  const planner = listed(tree, config.planner);
  const coordinator = listed(tree, config.coordinator || relayKey);
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
  const edges = planner && coordinator && planner !== coordinator ? [edge(planner, coordinator, 'mailbox', stats, ctx)] : [];
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
};

function attentionList(sessionNodes, tasks) {
  const list = [];
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
  return list.sort((a, b) => (b.at ?? -Infinity) - (a.at ?? -Infinity) || cmp(a.key, b.key) || cmp(a.kind, b.kind));
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
