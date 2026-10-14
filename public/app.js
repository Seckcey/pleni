// Pleni page logic: polls /api/snapshot and draws the map, list, activity, tasks and settings views.
// Plain ES module, no build step. Every value from the server is escaped or set with textContent.

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const POLL_MS = 2500;
const QUIET_MS = 10 * 60 * 1000; // a session stays on the Working map this long after it was last active
const ANNOUNCE_MS = 15000; // screen readers hear the count summary at most this often
const FEED_PAGE = 150;
const FL = { W: 268, H: 128, GX: 96, GY: 22, PAD: 48 };
const ZOOM_MIN = 0.3;
const ZOOM_MAX = 1.6;
const VIEWS = ['map', 'list', 'activity', 'tasks', 'settings'];
const VIEW_NAMES = { map: 'Map', list: 'List', activity: 'Activity', tasks: 'Tasks', settings: 'Settings' };
const STATUS_WORDS = { needs: 'Needs you', working: 'Working', ready: 'Finished', idle: 'Idle', done: 'Done', error: 'Error' };
const FILTERS = [['all', 'All'], ['needs', 'Needs you'], ['working', 'Working'], ['ready', 'Finished'], ['error', 'Error'], ['idle', 'Idle'], ['done', 'Done']];
const FEED_FILTERS = [['all', 'Everything'], ['down', 'Work handed out'], ['up', 'Reports back'], ['error', 'Errors']];
// Kimi Code models that can only turn thinking on or off record "on" or "off" as their effort.
const EFFORT_WORDS = { minimal: 'minimal effort', low: 'low effort', medium: 'medium effort', high: 'high effort', xhigh: 'extra high effort', max: 'max effort', on: 'thinking on', off: 'thinking off' };
const PLATFORM_WORDS = { claude: 'Claude Code', codex: 'Codex', grok: 'Grok', kimi: 'Kimi Code', relay: 'Mailbox' };
// The tools whose sessions Pleni reads. Each one has a word above and a mark in ICONS.
const TOOLS = ['claude', 'codex', 'grok', 'kimi'];
const KIND_WORDS = { person: 'Person', project: 'Project', session: 'Session', agent: 'Helper agent', reviewer: 'Automatic reviewer', relay: 'Relay' };
const ENTRY_WORDS = { 'claude-desktop': 'Claude desktop app', 'claude-vscode': 'VS Code', cli: 'Terminal', 'sdk-cli': 'Agent SDK', 'relay worker': 'The mailbox relay' };
const PLACEMENT_WORDS = { manual: 'You chose this.', rule: 'Set by a chain rule.', auto: 'Chosen automatically.' };
const MOVE_PX = 6; // how far a pressed tile must travel before it is being moved, not clicked
const PICK_WAIT_MS = 1000; // arrow keys change the Reports to menu one step at a time
const MOVED_MS = 8000; // how long "Moved ... under ..." stays
const ATTN_WORDS = { needs: 'Needs you', error: 'Error', question: 'Question', review: 'Ready for review' };
const EVENT_KIND_WORDS = { user: 'Prompt', assistant: 'Said', thinking: 'Thinking', tool: 'Tool', result: 'Result', error: 'Error' };
const ROLE_OPTIONS = [['', 'Automatic'], ['superintendent', 'Superintendent'], ['coordinator', 'Coordinator'], ['lead', 'Lead'], ['worker', 'Worker'], ['hidden', 'Hide it']];
const RANK_OPTIONS = ROLE_OPTIONS.filter(([v]) => v !== 'hidden');
const TIER_OPTIONS = [['', 'Automatic'], ['senior', 'Specialist (senior)'], ['junior', 'Private (junior)']];
const MAX_CHAIN = 50; // chain-of-command rules the server keeps
const MAX_NAME = 80; // longest session-name text in a rule or a mailbox field
const MAX_TIER_WORD = 40; // longest model word or model name src/config.js keeps (cleanTiers)
const DISMISSED_TEXT = 'Dismissed. It comes back if something new happens.';

// Mirror of DEFAULTS in src/config.js, used by "Restore defaults". Keep the two in step.
const DEFAULTS = {
  version: 1,
  port: 8790,
  displayName: 'You',
  titles: 'plain',
  content: 'snippets',
  groupBy: 'none',
  window: { activeMinutes: 10, recentHours: 24, staleMinutes: 30 },
  showReviewers: false,
  modelTiers: { senior: ['opus', 'fable', 'astra'], junior: ['sonnet', 'haiku', 'sol', 'luna', 'mini'] },
  sources: {
    claude: { enabled: true, root: null },
    claudeDesktop: { enabled: true, root: null },
    codex: { enabled: true, root: null },
    grok: { enabled: true, root: null },
    kimi: { enabled: true, root: null },
    mailbox: { enabled: false, root: null, planner: null, coordinator: null },
  },
  people: {},
  projects: {},
  chain: [],
  remote: { hosts: [], tailscaleUsers: [] },
  actions: { openTerminal: false },
};

const ICONS = {
  claude: '<path d="M12 3.5v17M4.6 7.75l14.8 8.5M4.6 16.25l14.8-8.5"/>',
  codex: '<rect x="3" y="4.5" width="18" height="15" rx="3"/><path d="m7.5 10 3 2.5-3 2.5M13 15.5h3.5"/>',
  // Grok and Kimi Code get plain letters, G and K, not their makers' logos.
  grok: '<path d="M17.75 7.2A7.5 7.5 0 1 0 19.5 12H13"/>',
  kimi: '<path d="M7 4.5v15M17 4.5 7 12.5l10 7"/>',
  human: '<circle cx="12" cy="8.5" r="3.5"/><path d="M5 20a7 7 0 0 1 14 0"/>',
  group: '<path d="M3.5 7.5A1.5 1.5 0 0 1 5 6h4l2 2h8a1.5 1.5 0 0 1 1.5 1.5v8A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5z"/>',
  relay: '<path d="M4 8h13.5M14 4.5 17.5 8 14 11.5M20 16H6.5M10 12.5 6.5 16l3.5 3.5"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
};

const S = {
  view: 'map',
  snap: null,
  index: null,
  etag: null,
  skew: 0,
  conn: 'starting',
  connError: '',
  lastOk: 0,
  mapMode: readStore('pleni.mapMode') === 'all' ? 'all' : 'working',
  fv: { x: 0, y: 0, k: 1, user: false, sig: '' },
  layout: null,
  layoutSig: '',
  dragUntil: 0,
  listFilter: 'all',
  feedFilter: 'all',
  feedLimit: FEED_PAGE,
  drawer: null,
  set: null,
  roots: null,
  recentHours: null,
  rootsAsked: false,
  said: '',
  saidAt: 0,
  sayTimer: 0,
};

const motionQuery = matchMedia('(prefers-reduced-motion: reduce)');
const lightQuery = matchMedia('(prefers-color-scheme: light)');

// ---------------------------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------------------------

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
}

function readStore(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStore(key, value) {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Storage can be blocked (private windows); the page still works without it.
  }
}

const own = (obj, key) => (obj && Object.hasOwn(obj, key) ? obj[key] : undefined);
const clone = (value) => JSON.parse(JSON.stringify(value));
const cap = (s) => (s ? String(s).charAt(0).toUpperCase() + String(s).slice(1) : '');
const safeClass = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9-]/g, '');
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const f1 = (v) => (Math.round(v * 10) / 10).toString();
const num = (v) => (Number.isFinite(v) ? v : 0);
// Dates past 8.64e15 ms make toISOString() throw, which would stop the whole page from drawing.
const isTime = (ms) => Number.isFinite(ms) && ms > 0 && ms < 8.64e15;
const toTime = (v) => (isTime(v) ? v : v && isTime(v.at) ? v.at : null);
const isSession = (n) => !!n && (n.kind === 'session' || n.kind === 'agent' || n.kind === 'reviewer');
// The mailbox relay carries work between a planner and a coordinator. It is a tile, not a session.
const isRelay = (n) => !!n && n.kind === 'relay';
// Sessions and the relay can be put under a new boss; the person and project tiles cannot.
const canMove = (n) => isSession(n) || isRelay(n);
// A mailbox worker run (mailbox:<task>/W1) keeps no session file of its own.
const isWorkerKey = (key) => String(key || '').startsWith('mailbox:');
// Open in PowerShell opens a window on the computer that runs Pleni, so it is offered only on a page
// opened there, not through a proxy from another device.
const LOCAL_PAGE = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
const svgIcon = (paths) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths}</svg>`;

function serverNow() {
  return Date.now() - S.skew;
}

function ago(ms) {
  if (!isTime(ms)) return '';
  const s = Math.max(0, Math.round((serverNow() - ms) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return h === 1 ? '1 hour ago' : `${h} hours ago`;
  const d = Math.round(h / 24);
  return d === 1 ? '1 day ago' : `${d} days ago`;
}

function clock(ms, seconds = false) {
  if (!isTime(ms)) return '';
  const opts = seconds ? { hour: 'numeric', minute: '2-digit', second: '2-digit' } : { hour: 'numeric', minute: '2-digit' };
  return new Date(ms).toLocaleTimeString([], opts);
}

function stamp(ms) {
  if (!isTime(ms)) return '';
  return new Date(ms).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function iso(ms) {
  return isTime(ms) ? new Date(ms).toISOString() : '';
}

function timeHtml(ms, text) {
  if (!isTime(ms)) return '';
  return `<time datetime="${esc(iso(ms))}" title="${esc(stamp(ms))}">${esc(text)}</time>`;
}

// A "5 min ago" that setHtml keeps current in place. Its whole text is ago(ms), nothing else.
function agoHtml(ms, attrs = '') {
  if (!isTime(ms)) return '';
  return `<time${attrs} datetime="${esc(iso(ms))}" title="${esc(stamp(ms))}" data-ago="${esc(ms)}">${esc(ago(ms))}</time>`;
}

function dayLabel(ms) {
  const d = new Date(ms);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const same = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (same(d, today)) return 'Today';
  if (same(d, yesterday)) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
}

// Relative times ("5 min ago") change every minute while nothing else does. Markup is compared
// without them, and when only they changed, their text is set in place instead, so the element
// under the pointer or in focus stays the same element.
const AGO_TEXT = /(<[^>]*\sdata-ago="[^"]*"[^>]*>)[^<]*/g;
const shapeOf = (html) => (html.includes('data-ago="') ? html.replace(AGO_TEXT, '$1') : html);

function refreshAgo(el) {
  for (const t of el.querySelectorAll('[data-ago]')) {
    const text = ago(Number(t.dataset.ago));
    if (t.textContent !== text) t.textContent = text;
  }
}

function setText(el, text) {
  if (el && el.textContent !== text) el.textContent = text;
}

// Repaint a region only when its markup changed, so clicks and focus are not lost to a refresh.
// If something inside had focus, the matching new element gets it back.
const painted = new WeakMap();
const FOCUS_ATTRS = ['data-node', 'data-dismiss', 'data-open', 'data-zoom', 'data-map-mode', 'data-list-filter', 'data-feed-filter', 'data-tab', 'data-person', 'data-project', 'data-model'];
let restoringFocus = false;
function setHtml(el, html) {
  if (!el) return false;
  const last = painted.get(el);
  if (last && last.html === html) return false;
  const shape = shapeOf(html);
  if (last && last.shape === shape) {
    refreshAgo(el);
    last.html = html;
    return false;
  }
  const active = document.activeElement;
  const restore = active && active !== el && el.contains(active) ? focusSelector(active) : null;
  el.innerHTML = html;
  painted.set(el, { html, shape });
  if (restore) {
    const next = el.querySelector(restore);
    if (next) {
      restoringFocus = true;
      try {
        next.focus({ preventScroll: true });
      } finally {
        restoringFocus = false;
      }
    }
  }
  return true;
}

// A repaint between pressing and releasing would swap out the button under the pointer and the
// click would be lost, so timed repaints wait until the press ends (at most a few seconds).
const press = { on: false, at: 0, timer: 0, waiting: false };
// A tile being carried to a new boss on the map (see mapInput). Repaints wait for as long as it moves.
const tileMove = { held: false, on: false, lifted: false, done: false, key: null, id: null, x0: 0, y0: 0, cx: 0, cy: 0, gx: 0, gy: 0, parent: null, below: null, over: null, ghost: null };

function pressing() {
  return tileMove.on || (press.on && Date.now() - press.at < 5000);
}

function releasePress(ms) {
  clearTimeout(press.timer);
  press.timer = setTimeout(() => {
    press.on = false;
    if (press.waiting) {
      press.waiting = false;
      render();
    }
  }, ms);
}

document.addEventListener(
  'pointerdown',
  () => {
    clearTimeout(press.timer);
    press.on = true;
    press.at = Date.now();
  },
  true,
);
// On a touch screen the click comes a little while after the finger lifts.
document.addEventListener('pointerup', () => releasePress(500), true);
document.addEventListener('pointercancel', () => releasePress(0), true);
document.addEventListener('click', () => releasePress(0), true);
window.addEventListener('blur', () => releasePress(0));

function focusSelector(node) {
  if (node.id) return `#${CSS.escape(node.id)}`;
  for (const attr of FOCUS_ATTRS) {
    if (node.hasAttribute(attr)) {
      const field = node.dataset.field ? `[data-field="${CSS.escape(node.dataset.field)}"]` : '';
      return `[${attr}="${CSS.escape(node.getAttribute(attr))}"]${field}`;
    }
  }
  return null;
}

async function readJson(res) {
  try {
    return JSON.parse(await res.text());
  } catch {
    return null;
  }
}

function plainError(err) {
  if (err instanceof TypeError) return 'The Pleni server is not answering. Is it still running?';
  return String((err && err.message) || err || 'Something went wrong.');
}

// The error keeps the HTTP status, so a missing key (401) can be told apart from other problems.
function answerError(res, body) {
  return Object.assign(new Error((body && body.error) || `Pleni answered with code ${res.status}.`), { status: res.status });
}

async function getJson(url) {
  const res = await fetch(url, { cache: 'no-store' });
  const body = await readJson(res);
  if (!res.ok) throw answerError(res, body);
  return body;
}

// "claude-opus-5-5" -> "Opus 5.5", "gpt-6.1-sol" -> "GPT-6.1 Sol". Only used when the server sends no label.
function prettyModel(model) {
  const m = String(model || '').replace(/\[1m\]$/i, '').trim();
  if (!m) return '';
  let x = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:\b|-)/i.exec(m);
  if (x) return `${cap(x[1].toLowerCase())} ${x[2]}${x[3] ? '.' + x[3] : ''}`;
  x = /^gpt-([\d.]+)(?:-([a-z]+))?$/i.exec(m);
  if (x) return `GPT-${x[1]}${x[2] ? ' ' + cap(x[2].toLowerCase()) : ''}`;
  return m;
}

// ---------------------------------------------------------------------------------------------
// snapshot index
// ---------------------------------------------------------------------------------------------

const byTitle = (a, b) => String(a.title || '').localeCompare(String(b.title || '')) || String(a.key).localeCompare(String(b.key));

function indexSnapshot(snap) {
  const nodes = (Array.isArray(snap.nodes) ? snap.nodes : []).filter((n) => n && typeof n.key === 'string' && !n.hidden);
  const byKey = new Map(nodes.map((n) => [n.key, n]));
  const kids = new Map();
  const roots = [];
  for (const n of nodes) {
    const parent = treeParent(n, byKey);
    if (!parent) roots.push(n);
    else if (kids.has(parent)) kids.get(parent).push(n);
    else kids.set(parent, [n]);
  }
  for (const list of kids.values()) list.sort(byTitle);
  roots.sort((a, b) => (b.kind === 'person') - (a.kind === 'person') || byTitle(a, b));
  const edges = (Array.isArray(snap.edges) ? snap.edges : []).filter((e) => e && typeof e.from === 'string' && typeof e.to === 'string');
  const edgeBy = new Map(edges.map((e) => [`${e.from}\n${e.to}`, e]));
  const lit = new Set();
  for (const e of edges) if (e.active) lit.add(e.from).add(e.to);
  const counts = new Map();
  const tally = (n) => {
    const c = { needs: 0, working: 0, ready: 0, error: 0, idle: 0, done: 0, total: 0 };
    for (const k of kids.get(n.key) || []) {
      const kc = tally(k);
      for (const s of Object.keys(c)) c[s] += kc[s];
      if (isSession(k)) {
        c.total++;
        if (Object.hasOwn(c, k.status) && k.status !== 'total') c[k.status]++;
        if (k.needs) c.needs++;
      }
    }
    counts.set(n.key, c);
    return c;
  };
  roots.forEach(tally);
  return { nodes, byKey, kids, roots, edges, edgeBy, lit, counts };
}

// The parent to hang a node under, or null. A broken or looping parent chain makes it a root.
function treeParent(n, byKey) {
  if (!n.parent || n.parent === n.key || !byKey.has(n.parent)) return null;
  const seen = new Set([n.key]);
  for (let p = n.parent; p && byKey.has(p); p = byKey.get(p).parent) {
    if (seen.has(p)) return null;
    seen.add(p);
  }
  return n.parent;
}

function titleOf(n) {
  if (n.title) return String(n.title);
  if (n.kind === 'person') return 'You';
  if (n.kind === 'project') return n.project || 'Project';
  if (n.kind === 'agent') return 'Helper agent';
  if (n.kind === 'reviewer') return 'Reviewer';
  if (n.kind === 'relay') return 'Relay';
  return 'Untitled session';
}

function personName() {
  const person = S.index && S.index.nodes.find((n) => n.kind === 'person');
  return person ? titleOf(person) : 'You';
}

// A readable name for any key: a known node's title, else a short form of the key.
function keyName(key) {
  const n = S.index && S.index.byKey.get(key);
  if (n) return titleOf(n);
  const k = String(key || '');
  if (k === 'you') return personName();
  const m = /^(claude|codex|grok|kimi):([0-9a-f]{8})/i.exec(k);
  if (m) return `${PLATFORM_WORDS[m[1].toLowerCase()]} session ${m[2]}`;
  if (k.startsWith('path:')) return `agent ${k.slice(5).split('/').filter(Boolean).pop() || ''}`.trim();
  if (k.startsWith('project:')) return k.slice(8);
  if (k === 'relay') return 'the mailbox relay';
  const w = /^mailbox:(.+)\/(W\d+)$/.exec(k);
  if (w) return `worker ${w[2]} on ${w[1]}`;
  return k || 'a session not shown here';
}

// Who a tile reports to, for "Moved Ada under ...": "you" for the person, unless they have a name.
function bossName(key) {
  if (key !== 'you') return keyName(key);
  const name = personName();
  return name === 'You' ? 'you' : name;
}

function projectLabel(name) {
  if (!name) return 'No project';
  const n = S.index && S.index.byKey.get(`project:${name}`);
  return n ? titleOf(n) : name;
}

function rankLine(n) {
  if (n.kind === 'person') return [n.rank, n.subtitle].filter(Boolean).join(' · ') || 'Your sessions';
  if (n.kind === 'project') return [n.rank, n.subtitle].filter(Boolean).join(' · ') || 'Project';
  if (isRelay(n)) return ['Relay', n.subtitle].filter(Boolean).join(' · ');
  const folder = S.snap && S.snap.nodes && !S.snap.nodes.some((x) => x.kind === 'project') ? n.projectLabel : null;
  return [n.rank, PLATFORM_WORDS[n.platform], folder, n.subtitle].filter(Boolean).join(' · ');
}

function modelText(n) {
  return [n.modelLabel || prettyModel(n.model), EFFORT_WORDS[n.effort] || (n.effort ? `${n.effort} effort` : '')].filter(Boolean).join(' · ');
}

function statusOf(n) {
  if (isRelay(n)) return Object.hasOwn(STATUS_WORDS, n.status) ? n.status : '';
  if (!isSession(n)) return '';
  if (n.needs) return 'needs';
  return Object.hasOwn(STATUS_WORDS, n.status) ? n.status : '';
}

// What a session is doing now (while working), else what it last said.
const NEEDS_WORDS = {
  question: 'Asking you a question',
  plan: 'Wants you to approve a plan',
  blocked: 'Blocked until you act',
  input: 'Asking for your input',
  permission: 'Asking for permission to use a tool',
};

function doing(n) {
  if (n.needs) return { label: 'Needs you', tool: null, text: n.needs.text || NEEDS_WORDS[n.needs.kind] || 'Waiting for you' };
  const a = n.activity;
  const act = a && (a.tool || a.detail) ? a : null;
  if (act && n.status === 'working') return { label: 'Now', tool: act.tool, text: act.detail };
  if (n.lastText) return { label: 'Last said', tool: null, text: n.lastText };
  if (act) return { label: 'Last step', tool: act.tool, text: act.detail };
  return null;
}

function doingHtml(d) {
  if (!d) return '';
  const tool = d.tool ? `<b>${esc(d.tool)}</b>` : '';
  return tool + (tool && d.text ? ' ' : '') + esc(d.text || '');
}

function markFor(n) {
  let kind = 'codex';
  if (TOOLS.includes(n.platform)) kind = n.platform;
  else if (n.kind === 'relay' || n.platform === 'relay') kind = 'relay';
  else if (n.kind === 'person' || n.platform === 'human') kind = 'human';
  else if (n.kind === 'project' || n.platform === 'group') kind = 'group';
  return { cls: `mk-${kind}`, svg: svgIcon(ICONS[kind]) };
}

function markHtml(n, extra = '') {
  const m = markFor(n);
  return `<span class="mark ${m.cls}${extra ? ' ' + extra : ''}" aria-hidden="true">${m.svg}</span>`;
}

function hasSessions() {
  return !!S.index && S.index.nodes.some(isSession);
}

function countsLine() {
  const c = (S.snap && S.snap.counts) || {};
  const parts = [plural(c.total || 0, 'session', 'sessions'), `${c.working || 0} working`, needYou(c.needs)];
  if (c.error) parts.push(plural(c.error, 'error', 'errors'));
  return parts.join(' · ');
}

// ---------------------------------------------------------------------------------------------
// polling
// ---------------------------------------------------------------------------------------------

let pollTimer = 0;
let polling = null; // the poll on its way, so a move can wait for it

function schedule(ms = POLL_MS) {
  clearTimeout(pollTimer);
  if (!document.hidden) pollTimer = setTimeout(poll, ms);
}

function poll() {
  if (!polling) polling = pollOnce();
  return polling;
}

// After a change, a poll that is already on its way may bring the old map: wait for it, then ask again.
async function pollNow() {
  if (polling) await polling.catch(() => {});
  await poll();
}

async function pollOnce() {
  clearTimeout(pollTimer);
  try {
    const headers = S.etag ? { 'If-None-Match': S.etag } : {};
    const res = await fetch('/api/snapshot', { headers, cache: 'no-store' });
    if (res.status !== 304) {
      const body = await readJson(res);
      if (!res.ok || !body || typeof body !== 'object') throw answerError(res, body);
      S.snap = body;
      S.index = indexSnapshot(body);
      S.etag = res.headers.get('ETag');
      if (isTime(body.now)) S.skew = Date.now() - body.now;
    }
    S.conn = 'live';
    S.connError = '';
    S.lastOk = Date.now();
    if (S.drawer) fetchDrawerEvents();
  } catch (err) {
    S.conn = err && err.status === 401 ? 'locked' : 'error';
    S.connError = plainError(err);
  } finally {
    polling = null;
    // Scheduled first, so a drawing error can never stop the polling.
    schedule();
    render();
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    clearTimeout(pollTimer);
    renderFacts();
  } else {
    poll();
  }
});

// ---------------------------------------------------------------------------------------------
// shell: routing, facts, notices, theme, live summary
// ---------------------------------------------------------------------------------------------

function viewFromHash() {
  const h = location.hash;
  if (h && !h.startsWith('#/')) return null; // an in-page anchor such as the skip link
  const v = h.replace(/^#\/?/, '').split(/[/?]/)[0];
  return VIEWS.includes(v) ? v : 'map';
}

function setView(v, focus) {
  S.view = v;
  for (const id of VIEWS) $(`#view-${id}`).hidden = id !== v;
  for (const a of $$('.views a[data-view]')) {
    if (a.dataset.view === v) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  if (v === 'map' && !S.fv.user) S.fv.sig = '';
  if (v === 'settings') loadSettings(false);
  render();
  if (focus) {
    window.scrollTo(0, 0);
    const h = $(`#${v}-title`);
    if (h) h.focus({ preventScroll: true });
  }
}

window.addEventListener('hashchange', () => {
  const v = viewFromHash();
  if (!v) return;
  closeDrawer();
  setView(v, true);
});

function render() {
  if (pressing()) {
    press.waiting = true;
    return;
  }
  renderFacts();
  renderNotices();
  $('#nav-tasks').hidden = !(S.snap && Array.isArray(S.snap.tasks));
  const asking = (S.snap && S.snap.counts && S.snap.counts.needs) || 0;
  document.title = `${asking ? `(${asking}) ` : ''}${VIEW_NAMES[S.view]} · Pleni`;
  if (S.view === 'map') renderMap();
  else if (S.view === 'list') renderList();
  else if (S.view === 'activity') renderActivity();
  else if (S.view === 'tasks') renderTasks();
  else if (S.view === 'settings') paintModels();
  if (S.drawer) renderDrawerParts();
  announce();
}

function renderFacts() {
  const c = (S.snap && S.snap.counts) || {};
  let live = ['', 'Live'];
  if (S.conn === 'error') live = ['bad', 'Cannot reach Pleni'];
  else if (S.conn === 'locked') live = ['bad', 'Needs its key'];
  else if (document.hidden) live = ['paused', 'Paused'];
  else if (S.conn === 'starting') live = ['paused', 'Starting'];
  const parts = [`<span class="live ${live[0]}">${live[1]}</span>`];
  if (S.snap) {
    parts.push(`<span class="f-working"><b>${num(c.working)}</b> working</span>`);
    parts.push(`<span class="f-needs"><b>${num(c.needs)}</b> ${num(c.needs) === 1 ? 'needs' : 'need'} you</span>`);
    if (num(c.error)) parts.push(`<span class="f-error"><b>${c.error}</b> ${c.error === 1 ? 'error' : 'errors'}</span>`);
    parts.push(`<span class="f-idle"><b>${num(c.idle)}</b> idle</span>`);
  }
  if (S.lastOk) parts.push(`<span class="f-updated">Updated ${esc(clock(S.lastOk, true))}</span>`);
  setHtml($('#facts'), parts.join(''));
}

function notice(bad, title, text) {
  return `<div class="notice${bad ? ' bad' : ''}"><span class="k">${esc(title)}</span><span class="v">${esc(text)}</span></div>`;
}

function renderNotices() {
  const out = [];
  if (S.conn === 'error') out.push(notice(true, 'Cannot reach Pleni.', `${S.connError} The page keeps trying every few seconds.`));
  if (S.conn === 'locked') {
    out.push(notice(true, 'Pleni needs its key.', 'Open the full address Pleni printed in the terminal when it started. It ends with "?t=" and a long key, which keeps other people on this computer out. The address stays the same until someone makes a new key.'));
  }
  const src = (S.snap && S.snap.sources) || {};
  for (const [name, label] of [['claude', 'Claude Code'], ['codex', 'Codex'], ['grok', 'Grok'], ['kimi', 'Kimi Code'], ['mailbox', 'The mailbox']]) {
    const s = src[name];
    if (s && s.enabled && s.ok === false) out.push(notice(false, `${label} could not be read.`, s.error || 'Pleni will try again.'));
  }
  setHtml($('#notices'), out.join(''));
}

function storedTheme() {
  const t = readStore('pleni.theme');
  return t === 'light' || t === 'dark' ? t : null;
}

function applyTheme() {
  const t = storedTheme();
  if (t) document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
  const effective = t || (lightQuery.matches ? 'light' : 'dark');
  const label = effective === 'dark' ? 'Use the light theme' : 'Use the dark theme';
  const btn = $('#theme-toggle');
  btn.setAttribute('aria-label', label);
  btn.title = label;
  const select = $('#s-theme');
  if (select) select.value = t || 'system';
}

function setTheme(choice) {
  writeStore('pleni.theme', choice === 'light' || choice === 'dark' ? choice : null);
  applyTheme();
}

function toggleTheme() {
  const effective = storedTheme() || (lightQuery.matches ? 'light' : 'dark');
  setTheme(effective === 'dark' ? 'light' : 'dark');
}

lightQuery.addEventListener('change', applyTheme);

// The polite live region says the counts out loud, only when they change and at most every 15 s.
function summaryText(c) {
  const parts = [`${c.working || 0} working`, needYou(c.needs)];
  if (c.error) parts.push(`${c.error} with an error`);
  return `${parts.join(', ')}.`;
}

function announce() {
  const c = S.snap && S.snap.counts;
  if (!c) return;
  const text = summaryText(c);
  if (!S.said) {
    S.said = text; // the first numbers are on screen already; stay quiet
    S.saidAt = Date.now();
    return;
  }
  if (text === S.said) {
    clearTimeout(S.sayTimer);
    S.sayTimer = 0;
    return;
  }
  const wait = S.saidAt + ANNOUNCE_MS - Date.now();
  if (wait <= 0) {
    $('#live-summary').textContent = text;
    S.said = text;
    S.saidAt = Date.now();
  } else if (!S.sayTimer) {
    S.sayTimer = setTimeout(() => {
      S.sayTimer = 0;
      announce();
    }, wait);
  }
}

function attentionItems() {
  return (S.snap && Array.isArray(S.snap.attention) ? S.snap.attention : []).filter((a) => a && a.key);
}

// Each notice opens its session (or the Tasks view). Its × sits beside it, not inside it, so
// dismissing a notice never opens it.
function attentionHtml() {
  const list = attentionItems();
  if (!list.length) return '';
  const items = list.slice(0, 6).map((a) => {
    const kind = ATTN_WORDS[a.kind] || cap(a.kind) || 'Needs a look';
    const text = a.text || keyName(a.key);
    const inner = `<span class="k">${esc(kind)}</span><span class="v">${esc(text)}</span>`;
    let main = `<span class="attn-go">${inner}</span>`;
    if (S.index.byKey.has(a.key)) main = `<button type="button" class="attn-go" data-node="${esc(a.key)}">${inner}</button>`;
    else if (String(a.key).startsWith('task:')) main = `<a class="attn-go" href="#/tasks">${inner}</a>`;
    return `<div class="attn k-${safeClass(a.kind)}">${main}${dismissHtml(a, text)}</div>`;
  });
  if (list.length > 6) items.push(`<div class="attn more"><span class="v">and ${list.length - 6} more</span></div>`);
  return `<h2 class="sr-only">Needs you</h2>${items.join('')}`;
}

// The × that hides a notice. A notice without an id (from an older Pleni) cannot be dismissed.
function dismissHtml(a, text) {
  if (typeof a.id !== 'string' || !a.id) return '';
  return `<button type="button" class="attn-x" data-dismiss="${esc(a.id)}" data-at="${esc(num(a.at))}" aria-label="${esc(`Dismiss: ${text}`)}">${svgIcon(ICONS.close)}</button>`;
}

// First run, or nothing recent: say where Pleni looks and how to try the demo.
function welcomeHtml() {
  if (!S.roots && !S.rootsAsked) {
    S.rootsAsked = true;
    getJson('/api/settings')
      .then((info) => {
        S.roots = (info && info.roots) || {};
        S.recentHours = info && info.settings && info.settings.window ? info.settings.window.recentHours : null;
        render();
      })
      .catch(() => {});
  }
  const src = (S.snap && S.snap.sources) || {};
  const roots = S.roots || {};
  const hours = S.recentHours || 24;
  const join = (root, sub) => (root ? root.replace(/[\\/]+$/, '') + (root.includes('\\') && !root.includes('/') ? '\\' : '/') + sub : '');
  const state = (info) => {
    if (!info) return '';
    if (!info.enabled) return ' <span class="quiet">Turned off.</span>';
    if (info.ok === false) return ` <span class="src-bad">Could not read it. ${esc(String(info.error || 'Pleni will try again.').replace(/\.?$/, '.'))}</span>`;
    return ` <span class="src-ok">On, found ${num(info.count)}.</span>`;
  };
  const where = (path, fallback) => `<code>${esc(path || fallback)}</code>`;
  const mailbox = src.mailbox && src.mailbox.enabled
    ? `<li><b>Mailbox:</b> ${where(roots.mailbox, 'the folder you chose')}.${state(src.mailbox)}</li>`
    : '<li><b>Mailbox:</b> off. If two agents hand work to each other through a folder of notes, you can add it in Settings.</li>';
  return `<div class="welcome panel">
    <img src="/brand/pip-welcome.webp" alt="" width="168" height="168">
    <div>
      <h2>No sessions to show yet</h2>
      <p>Pleni shows the Claude Code, Codex, Grok and Kimi Code sessions on this computer that were active in the last ${esc(plural(hours, 'hour', 'hours'))}, the helpers they start, and the work they hand to each other. It only reads their files. It never changes them, and nothing leaves this computer.</p>
      <h3>Where Pleni looks</h3>
      <ul>
        <li><b>Claude Code:</b> ${where(join(roots.claude, 'projects'), '~/.claude/projects')}, or the folder in <code>CLAUDE_CONFIG_DIR</code>.${state(src.claude)}</li>
        <li><b>Claude desktop app:</b> ${where(roots.claudeDesktop, 'its own settings folder')}, for better session names.</li>
        <li><b>Codex:</b> ${where(join(roots.codex, 'sessions'), '~/.codex/sessions')}, or the folder in <code>CODEX_HOME</code>.${state(src.codex)}</li>
        <li><b>Grok:</b> ${where(join(roots.grok, 'sessions'), '~/.grok/sessions')}, or the folder in <code>GROK_HOME</code>.${state(src.grok)}</li>
        <li><b>Kimi Code:</b> ${where(join(roots.kimi, 'sessions'), '~/.kimi-code/sessions')}, or the folder in <code>KIMI_CODE_HOME</code>.${state(src.kimi)}</li>
        ${mailbox}
      </ul>
      <p>Start a Claude Code, Codex, Grok or Kimi Code session and it shows up here within a few seconds.</p>
      <h3>Just want to look around?</h3>
      <p>In the Pleni folder, run <code>node bin/pleni.js --demo</code> in a terminal and open the address it prints. The demo uses made-up sessions, so it needs nothing from you.</p>
      <p><a href="#/settings">Change where Pleni looks</a></p>
    </div>
  </div>`;
}

// ---------------------------------------------------------------------------------------------
// map
// ---------------------------------------------------------------------------------------------

// Working mode keeps the person, sessions that are busy, waiting, failing, carrying a hand-off or
// active in the last 10 minutes, and everything above them.
function workingSet(ix) {
  const keep = new Set();
  const now = serverNow();
  const live = (n) =>
    n.needs || n.status === 'working' || n.status === 'ready' || n.status === 'error' || ix.lit.has(n.key) || (isTime(n.lastAt) && now - n.lastAt < QUIET_MS);
  // A running relay is its normal state, not news: it shows when it halts or carries a hand-off.
  const relayNews = (n) => isRelay(n) && (n.status === 'error' || ix.lit.has(n.key));
  const visit = (n) => {
    let any = false;
    for (const k of ix.kids.get(n.key) || []) any = visit(k) || any;
    if (any || n.kind === 'person' || (isSession(n) && live(n)) || relayNews(n)) {
      keep.add(n.key);
      return true;
    }
    return false;
  };
  ix.roots.forEach(visit);
  return keep;
}

// A left-to-right tidy tree. Positions come from here, not from measuring the page, so lines and
// tiles always agree. Map order is pre-order, which is also the keyboard order of the tiles.
function layoutTree(ix, keep) {
  const pos = new Map();
  const quiet = new Map();
  let depthMax = 0;
  const shown = (n) => !keep || keep.has(n.key);
  const place = (n, depth, y0, parent) => {
    const x = FL.PAD + depth * (FL.W + FL.GX);
    depthMax = Math.max(depthMax, depth);
    pos.set(n.key, null);
    const all = ix.kids.get(n.key) || [];
    const kids = all.filter(shown);
    if (kids.length < all.length) quiet.set(n.key, all.length - kids.length);
    if (!kids.length) {
      pos.set(n.key, { n, x, y: y0, parent, kids: 0 });
      return y0 + FL.H;
    }
    let y = y0;
    for (const k of kids) y = place(k, depth + 1, y, n.key) + FL.GY;
    const first = pos.get(kids[0].key);
    const last = pos.get(kids[kids.length - 1].key);
    const top = Math.max(y0, (first.y + last.y) / 2);
    pos.set(n.key, { n, x, y: top, parent, kids: kids.length });
    return Math.max(y - FL.GY, top + FL.H);
  };
  let bottom = FL.PAD;
  let y = FL.PAD;
  for (const root of ix.roots.filter(shown)) {
    bottom = place(root, 0, y, null);
    y = bottom + FL.GY * 2;
  }
  return { pos, quiet, w: FL.PAD * 2 + (depthMax + 1) * FL.W + depthMax * FL.GX, h: bottom + FL.PAD };
}

// Orthogonal line with softened corners.
function roundPath(pts, r = 7) {
  const p = pts.filter((q, i) => !i || Math.abs(q[0] - pts[i - 1][0]) > 0.01 || Math.abs(q[1] - pts[i - 1][1]) > 0.01);
  let d = `M${f1(p[0][0])} ${f1(p[0][1])}`;
  for (let i = 1; i < p.length - 1; i++) {
    const [x0, y0] = p[i - 1];
    const [x1, y1] = p[i];
    const [x2, y2] = p[i + 1];
    const l1 = Math.hypot(x1 - x0, y1 - y0);
    const l2 = Math.hypot(x2 - x1, y2 - y1);
    const rr = Math.min(r, l1 / 2, l2 / 2);
    if (rr < 0.5) {
      d += ` L${f1(x1)} ${f1(y1)}`;
      continue;
    }
    d += ` L${f1(x1 - ((x1 - x0) / l1) * rr)} ${f1(y1 - ((y1 - y0) / l1) * rr)} Q${f1(x1)} ${f1(y1)} ${f1(x1 + ((x2 - x1) / l2) * rr)} ${f1(y1 + ((y2 - y1) / l2) * rr)}`;
  }
  const z = p[p.length - 1];
  return `${d} L${f1(z[0])} ${f1(z[1])}`;
}

function stepPoints(a, b, o) {
  const sx = a.x + FL.W;
  const sy = a.y + FL.H / 2 + o;
  const tx = b.x;
  const ty = b.y + FL.H / 2 + o;
  const mx = sx + FL.GX / 2 + o;
  return [[sx, sy], [mx, sy], [mx, ty], [tx, ty]];
}

// A curve between two tiles that are not parent and child (for example a mailbox planner and its
// coordinator). Tiles in the same column get an arc that bows out to the right.
function crossPath(a, b) {
  const ay = a.y + FL.H / 2;
  const by = b.y + FL.H / 2;
  if (Math.abs(a.x - b.x) < 1) {
    const x = a.x + FL.W;
    const bow = Math.min(FL.GX * 0.8, 36 + Math.abs(by - ay) / 6);
    return `M${f1(x)} ${f1(ay)} C${f1(x + bow)} ${f1(ay)}, ${f1(x + bow)} ${f1(by)}, ${f1(x)} ${f1(by)}`;
  }
  const right = a.x < b.x;
  const sx = right ? a.x + FL.W : a.x;
  const tx = right ? b.x : b.x + FL.W;
  const dx = Math.max(60, Math.abs(tx - sx) / 2) * (right ? 1 : -1);
  return `M${f1(sx)} ${f1(ay)} C${f1(sx + dx)} ${f1(ay)}, ${f1(tx - dx)} ${f1(by)}, ${f1(tx)} ${f1(by)}`;
}

function packets(d, cls) {
  if (motionQuery.matches) return '';
  return [0, 1, 2]
    .map((i) => `<circle r="3.4" class="${cls}"><animateMotion dur="1.8s" begin="${f1(-i * 0.6)}s" repeatCount="indefinite" path="${d}"/></circle>`)
    .join('');
}

// Glowing line plus packets for each direction that is moving; returns how many are moving.
function flowWires(out, active, down, up) {
  let moving = 0;
  if (active === 'down' || active === 'both') {
    out.push(`<path class="e-flow e-down" d="${down}"/>${packets(down, 'pk-down')}`);
    moving++;
  }
  if (active === 'up' || active === 'both') {
    const u = up();
    out.push(`<path class="e-flow e-up" d="${u}"/>${packets(u, 'pk-up')}`);
    moving++;
  }
  return moving;
}

function needYou(n) {
  const count = n || 0;
  return `${count} ${count === 1 ? 'needs' : 'need'} you`;
}

function countsHtml(c) {
  const parts = [];
  if (c.working) parts.push(`<span class="c-working">${c.working} working</span>`);
  if (c.needs) parts.push(`<span class="c-needs">${needYou(c.needs)}</span>`);
  if (c.error) parts.push(`<span class="c-error">${plural(c.error, 'error', 'errors')}</span>`);
  if (!parts.length) parts.push(`<span>${c.total ? `${plural(c.total, 'session', 'sessions')}, all quiet` : 'No sessions'}</span>`);
  return `<span class="tile-counts">${parts.join('')}</span>`;
}

function countsPlain(c) {
  const parts = [];
  if (c.working) parts.push(`${c.working} working`);
  if (c.needs) parts.push(needYou(c.needs));
  if (c.error) parts.push(plural(c.error, 'error', 'errors'));
  return parts.join(', ') || (c.total ? `${plural(c.total, 'session', 'sessions')}, all quiet` : 'no sessions');
}

// The time is left out of the tile's name and given as its description instead, so the name and
// markup stay the same as the minutes pass and the time can be updated in place.
function tileHtml(p, L, ix, i) {
  const n = p.n;
  const status = statusOf(n);
  const cls = ['tile', `k-${safeClass(n.kind || 'session')}`];
  if (status) cls.push(`st-${status}`);
  if (ix.lit.has(n.key)) cls.push('lit');
  const title = titleOf(n);
  const rank = rankLine(n);
  const quiet = L.quiet.get(n.key) || 0;
  let body;
  let label;
  let described = '';
  if (isSession(n)) {
    const model = modelText(n);
    const d = doing(n);
    const timeId = `tile-ago-${i}`;
    const when = agoHtml(n.lastAt, ` class="tile-ago" id="${timeId}"`);
    if (when) described = ` aria-describedby="${timeId}"`;
    body =
      `<span class="tile-meta"><span class="pill">${esc(STATUS_WORDS[status] || 'Unknown')}</span>` +
      `<span class="tile-model">${esc(model)}</span>${when || '<span class="tile-ago"></span>'}</span>` +
      (d ? `<span class="tile-text">${doingHtml(d)}</span>` : '');
    label = [title, rank, STATUS_WORDS[status], model].filter(Boolean).join(', ');
  } else if (isRelay(n)) {
    const c = ix.counts.get(n.key) || { total: 0 };
    const words = STATUS_WORDS[status] || 'Unknown';
    body = `<span class="tile-meta"><span class="pill">${esc(words)}</span>${c.total ? countsHtml(c) : ''}</span>`;
    label = [title, rank, words, c.total ? countsPlain(c) : ''].filter(Boolean).join(', ');
  } else {
    const c = ix.counts.get(n.key) || { total: 0 };
    body = `<span class="tile-meta">${countsHtml(c)}</span>`;
    label = [title, rank, countsPlain(c)].filter(Boolean).join(', ');
  }
  if (quiet) label += `, ${quiet} quiet not shown`;
  return (
    `<button type="button" class="${cls.join(' ')}" data-node="${esc(n.key)}" style="left:${f1(p.x)}px;top:${f1(p.y)}px" aria-label="${esc(label)}"${described}>` +
    (p.parent ? '<span class="hd l" aria-hidden="true"></span>' : '') +
    (p.kids ? '<span class="hd r" aria-hidden="true"></span>' : '') +
    markHtml(n) +
    `<span class="tile-title">${esc(title)}</span><span class="tile-rank">${esc(rank)}</span>` +
    body +
    (quiet ? `<span class="tile-quiet" aria-hidden="true">+${quiet} quiet</span>` : '') +
    '</button>'
  );
}

function flowsHtml(ix) {
  const flows = [];
  const label = (text) => (text ? `: ${esc(text)}` : '');
  for (const e of ix.edges) {
    if (e.active === 'down' || e.active === 'both') {
      const at = toTime(e.lastDown);
      flows.push({
        at: at || 0,
        html: `<li class="flow down" title="${esc(e.downLabel || '')}"><span class="ar" aria-hidden="true">↓</span><b>${esc(keyName(e.from))}</b> handed work to <b>${esc(keyName(e.to))}</b>${label(e.downLabel)}${at ? `, ${esc(clock(at))}` : ''}</li>`,
      });
    }
    if (e.active === 'up' || e.active === 'both') {
      const at = toTime(e.lastUp);
      flows.push({
        at: at || 0,
        html: `<li class="flow up" title="${esc(e.upLabel || '')}"><span class="ar" aria-hidden="true">↑</span><b>${esc(keyName(e.to))}</b> reported back to <b>${esc(keyName(e.from))}</b>${label(e.upLabel)}${at ? `, ${esc(clock(at))}` : ''}</li>`,
      });
    }
  }
  if (!flows.length) return '<li class="none">No hand-offs moving right now. A line lights up for two minutes after work is handed out or reported back.</li>';
  flows.sort((a, b) => b.at - a.at);
  // Three on a wide screen, one on a phone, then a count of the rest.
  const more =
    (flows.length > 3 ? `<li class="flow more-d">+${flows.length - 3} more moving</li>` : '') +
    (flows.length > 1 ? `<li class="flow more-m">+${flows.length - 1} more moving</li>` : '');
  return flows.slice(0, 3).map((f) => f.html).join('') + more;
}

function renderMap() {
  for (const b of $$('[data-map-mode]')) b.setAttribute('aria-pressed', String(b.dataset.mapMode === S.mapMode));
  if (!S.snap) return;
  const ix = S.index;
  const empty = !hasSessions();
  setText($('#map-meta'), countsLine());
  setHtml($('#map-attention'), attentionHtml());
  setHtml($('#map-welcome'), empty ? welcomeHtml() : '');
  $('#map-body').hidden = empty;
  if (empty) return;

  const keep = S.mapMode === 'all' ? null : workingSet(ix);
  const L = layoutTree(ix, keep);
  S.layout = L;
  const tiles = [];
  const wires = [];
  const treeLinks = new Set();
  let moving = 0;
  for (const [key, p] of L.pos) {
    tiles.push(tileHtml(p, L, ix, tiles.length));
    if (!p.parent) continue;
    const pp = L.pos.get(p.parent);
    const d = roundPath(stepPoints(pp, p, 0));
    wires.push(`<path class="e-base" d="${d}"/>`);
    treeLinks.add(`${p.parent}\n${key}`);
    const e = ix.edgeBy.get(`${p.parent}\n${key}`);
    if (e) moving += flowWires(wires, e.active, d, () => roundPath(stepPoints(pp, p, 4).reverse()));
  }
  for (const e of ix.edges) {
    if (e.kind === 'contains' || treeLinks.has(`${e.from}\n${e.to}`)) continue;
    const a = L.pos.get(e.from);
    const b = L.pos.get(e.to);
    if (!a || !b || a === b) continue;
    const d = crossPath(a, b);
    wires.push(`<path class="e-cross" d="${d}"/>`);
    moving += flowWires(wires, e.active, d, () => crossPath(b, a));
  }
  const svg = $('#map-wires');
  svg.setAttribute('width', L.w);
  svg.setAttribute('height', L.h);
  svg.setAttribute('viewBox', `0 0 ${L.w} ${L.h}`);
  setHtml(svg, wires.join(''));
  setHtml($('#map-nodes'), tiles.join(''));
  setHtml($('#flows'), flowsHtml(ix));

  const onlyPeople = [...L.pos.values()].every((p) => !canMove(p.n));
  const emptyBox = $('#map-empty');
  emptyBox.hidden = !(onlyPeople && S.mapMode === 'working');
  setHtml(
    emptyBox,
    emptyBox.hidden
      ? ''
      : '<img src="/brand/pip-thinking.webp" alt="" width="72" height="72"><p>Nobody is working right now.</p><button type="button" class="btn" data-map-mode="all">Show everyone</button>',
  );
  const foot = S.conn === 'error' ? 'Not live: cannot reach Pleni' : S.conn === 'locked' ? 'Not live: Pleni needs its key' : document.hidden ? 'Paused while this tab is hidden' : `Live · updated ${clock(S.lastOk, true)}`;
  setHtml(
    $('#map-foot'),
    `<span>${esc(foot)}</span><span class="${moving ? 'moving' : ''}">${moving ? esc(plural(moving, 'hand-off', 'hand-offs')) + ' moving' : 'No hand-offs moving'}</span>`,
  );

  // Refit only on first show, or when the content no longer fits and the view was not moved by hand.
  const sig = `${L.w}x${L.h}|${[...L.pos.keys()].join(',')}`;
  S.layoutSig = sig;
  const cv = $('#map-canvas');
  const v = S.fv;
  const fits = v.sig && cv.clientWidth && v.x >= -1 && v.y >= -1 && v.x + L.w * v.k <= cv.clientWidth + 1 && v.y + L.h * v.k <= cv.clientHeight + 1;
  if (!v.user && v.sig !== sig) {
    if (fits) v.sig = sig;
    else if (fitView()) v.sig = sig;
  }
  applyView();
}

function setMapMode(mode) {
  S.mapMode = mode === 'all' ? 'all' : 'working';
  writeStore('pleni.mapMode', S.mapMode);
  if (!S.fv.user) S.fv.sig = '';
  renderMap();
}

// ---------- pan and zoom ----------

function applyView() {
  const v = S.fv;
  const stage = $('#map-stage');
  const cv = $('#map-canvas');
  stage.style.transform = `translate(${f1(v.x)}px, ${f1(v.y)}px) scale(${v.k.toFixed(3)})`;
  const g = 22 * v.k;
  cv.style.backgroundSize = `${f1(g)}px ${f1(g)}px`;
  cv.style.backgroundPosition = `${f1(v.x)}px ${f1(v.y)}px`;
}

function fitView() {
  const cv = $('#map-canvas');
  const L = S.layout;
  if (!cv || !L || !cv.clientWidth) return false;
  const cw = cv.clientWidth;
  const ch = cv.clientHeight;
  let k = Math.max(ZOOM_MIN, Math.min(1, cw / L.w, ch / L.h));
  let x = (cw - L.w * k) / 2;
  let y = (ch - L.h * k) / 2;
  // On a narrow screen the whole map would be too small to read: fit the height, start at the left.
  if (k < 0.55 && cw < 720) {
    k = Math.max(0.5, Math.min(0.85, ch / L.h));
    x = 0;
    y = Math.max(0, (ch - L.h * k) / 2);
  }
  Object.assign(S.fv, { x, y, k, user: false });
  applyView();
  return true;
}

function zoomAt(px, py, k) {
  const v = S.fv;
  const next = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, k));
  v.x = px - (px - v.x) * (next / v.k);
  v.y = py - (py - v.y) * (next / v.k);
  v.k = next;
  v.user = true;
  applyView();
}

function zoomButton(kind) {
  if (kind === 'fit') {
    S.fv.sig = '';
    if (fitView()) S.fv.sig = S.layoutSig;
    return;
  }
  const cv = $('#map-canvas');
  zoomAt(cv.clientWidth / 2, cv.clientHeight / 2, S.fv.k * (kind === 'in' ? 1.25 : 0.8));
}

function panBy(dx, dy) {
  S.fv.x += dx;
  S.fv.y += dy;
  S.fv.user = true;
  applyView();
}

(function mapInput() {
  const cv = $('#map-canvas');
  const down = new Map();
  let g = null;
  let pointerAt = 0;
  const pointerSeen = () => {
    pointerAt = Date.now();
  };
  cv.addEventListener('pointerdown', pointerSeen, true);
  cv.addEventListener('pointerup', pointerSeen, true);
  const local = (p) => {
    const r = cv.getBoundingClientRect();
    return { x: p.x - r.left, y: p.y - r.top };
  };
  const begin = () => {
    const pts = [...down.values()];
    g = { x: S.fv.x, y: S.fv.y, k: S.fv.k, pts: pts.map((p) => ({ ...p })), moved: g ? g.moved : false };
    if (pts.length === 2) {
      g.d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1;
      g.c = local({ x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 });
    }
  };

  // ---- carrying a session tile to a new boss ----
  const stagePoint = (cx, cy) => {
    const p = local({ x: cx, y: cy });
    return { x: (p.x - S.fv.x) / S.fv.k, y: (p.y - S.fv.y) / S.fv.k };
  };
  // A tile can take the carried one when it is the person, a session or the relay, and not the
  // carried tile itself, one of its own helpers, or the boss it has now.
  const bossOk = (key) => {
    const b = S.index && S.index.byKey.get(key);
    if (!b || key === tileMove.key || key === tileMove.parent || tileMove.below.has(key)) return false;
    return b.kind === 'person' || canMove(b);
  };
  const holdTile = (ev) => {
    const tile = ev.target.closest('#map-nodes .tile');
    const n = tile && S.index ? S.index.byKey.get(tile.dataset.node) : null;
    const held = canMove(n);
    Object.assign(tileMove, { held, on: false, lifted: false, done: false, key: held ? n.key : null, id: ev.pointerId, x0: ev.clientX, y0: ev.clientY });
  };
  // Near an edge, the carried tile scrolls the map, so a tile that is off screen can be reached.
  const EDGE = 40;
  let edgeFrame = 0;
  const liftTile = (ev) => {
    const ix = S.index;
    const n = ix && ix.byKey.get(tileMove.key);
    const p = n && S.layout && S.layout.pos.get(n.key);
    const tile = p && $(`#map-nodes [data-node="${CSS.escape(n.key)}"]`);
    if (!tile) {
      tileMove.done = true;
      return false;
    }
    const at = stagePoint(tileMove.x0, tileMove.y0);
    Object.assign(tileMove, { on: true, lifted: true, gx: at.x - p.x, gy: at.y - p.y, parent: n.parent, below: belowKeys(ix, n.key), over: null });
    // The light copy that follows the pointer is only a picture: no ids, no name, no clicks.
    const ghost = document.createElement('div');
    ghost.className = `${tile.className} ghost`;
    ghost.setAttribute('aria-hidden', 'true');
    ghost.innerHTML = tile.innerHTML;
    for (const el of ghost.querySelectorAll('[id]')) el.removeAttribute('id');
    $('#map-stage').append(ghost);
    tileMove.ghost = ghost;
    for (const t of $$('#map-nodes .tile')) {
      if (t === tile) t.classList.add('lifted');
      else if (!bossOk(t.dataset.node)) t.classList.add('no-drop');
    }
    cv.classList.add('moving');
    try {
      cv.setPointerCapture(ev.pointerId);
    } catch {
      // The pointer may already be gone; its pointerup still ends the move.
    }
    return true;
  };
  // Puts the copy under the pointer and lights the tile below it when that tile can take it.
  const carryTo = (cx, cy) => {
    const at = stagePoint(cx, cy);
    tileMove.ghost.style.left = `${f1(at.x - tileMove.gx)}px`;
    tileMove.ghost.style.top = `${f1(at.y - tileMove.gy)}px`;
    const hit = document.elementFromPoint(cx, cy);
    const tile = hit && hit.closest('#map-nodes .tile');
    const over = tile && bossOk(tile.dataset.node) ? tile : null;
    if (over === tileMove.over) return;
    if (tileMove.over) tileMove.over.classList.remove('drop-ok');
    if (over) over.classList.add('drop-ok');
    tileMove.over = over;
  };
  const edgePan = () => {
    edgeFrame = 0;
    if (!tileMove.on) return;
    const r = cv.getBoundingClientRect();
    const { cx, cy } = tileMove;
    if (cx < r.left || cx > r.right || cy < r.top || cy > r.bottom) return;
    const push = (d) => (d < EDGE ? Math.ceil(((EDGE - d) / EDGE) * 12) : 0);
    const dx = push(cx - r.left) - push(r.right - cx);
    const dy = push(cy - r.top) - push(r.bottom - cy);
    if (!dx && !dy) return;
    panBy(dx, dy);
    carryTo(cx, cy);
    edgeFrame = requestAnimationFrame(edgePan);
  };
  const carryTile = (ev) => {
    if (ev.pointerId !== tileMove.id || tileMove.done) return;
    if (!tileMove.on && (Math.hypot(ev.clientX - tileMove.x0, ev.clientY - tileMove.y0) < MOVE_PX || !liftTile(ev))) return;
    tileMove.cx = ev.clientX;
    tileMove.cy = ev.clientY;
    carryTo(ev.clientX, ev.clientY);
    // With reduced motion the map never scrolls by itself; zoom out to reach far tiles instead.
    if (!edgeFrame && !motionQuery.matches) edgeFrame = requestAnimationFrame(edgePan);
  };
  // Ends a move. Dropped on a tile that can take it, Pleni is asked to move it there; anywhere
  // else, Esc or a second finger leave the map as it was.
  const dropTile = (drop) => {
    if (!tileMove.on) return;
    const { key, over } = tileMove;
    Object.assign(tileMove, { on: false, done: true, over: null });
    cancelAnimationFrame(edgeFrame);
    edgeFrame = 0;
    if (tileMove.ghost) tileMove.ghost.remove();
    tileMove.ghost = null;
    for (const t of $$('#map-nodes .lifted, #map-nodes .no-drop, #map-nodes .drop-ok')) t.classList.remove('lifted', 'no-drop', 'drop-ok');
    cv.classList.remove('moving');
    if (drop && over && over.isConnected) moveNode(key, over.dataset.node, 'drag');
  };
  document.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape' || !tileMove.on) return;
    ev.preventDefault();
    dropTile(false);
  });
  window.addEventListener('blur', () => dropTile(false));
  cv.addEventListener('lostpointercapture', (ev) => {
    if (ev.target === cv && ev.pointerId === tileMove.id) dropTile(false);
  });

  cv.addEventListener('pointerdown', (ev) => {
    if ((ev.pointerType === 'mouse' && ev.button !== 0) || ev.target.closest('.map-ctrl, .map-empty')) return;
    down.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    if (down.size === 1) holdTile(ev);
    else {
      // A second finger means a pinch: a tile being carried goes back where it was.
      dropTile(false);
      tileMove.held = false;
    }
    if (down.size <= 2) begin();
  });
  cv.addEventListener('pointermove', (ev) => {
    if (!down.has(ev.pointerId) || !g) return;
    down.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    // A press that starts on a session tile (or the relay) carries the tile; it never pans the map.
    if (tileMove.held && down.size === 1) {
      carryTile(ev);
      return;
    }
    const pts = [...down.values()];
    if (pts.length === 1) {
      const dx = pts[0].x - g.pts[0].x;
      const dy = pts[0].y - g.pts[0].y;
      if (!g.moved && Math.hypot(dx, dy) < 5) return;
      if (!g.moved) {
        g.moved = true;
        try {
          cv.setPointerCapture(ev.pointerId);
        } catch {
          // The pointer may already be gone; panning still works without capture.
        }
        cv.classList.add('dragging');
      }
      Object.assign(S.fv, { x: g.x + dx, y: g.y + dy, user: true });
      applyView();
    } else if (pts.length === 2 && g.d) {
      g.moved = true;
      const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      const c = local({ x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 });
      const k = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, (g.k * d) / g.d));
      Object.assign(S.fv, { x: c.x - (g.c.x - g.x) * (k / g.k), y: c.y - (g.c.y - g.y) * (k / g.k), k, user: true });
      applyView();
    }
  });
  const end = (ev) => {
    if (!down.delete(ev.pointerId)) return;
    if (ev.pointerId === tileMove.id && tileMove.held) {
      dropTile(ev.type === 'pointerup');
      tileMove.held = false;
      if (tileMove.lifted) {
        // The click that follows must not open the tile, and the map may be drawn again at once.
        S.dragUntil = Date.now() + 300;
        releasePress(0);
      }
    }
    if (g && g.moved) S.dragUntil = Date.now() + 300;
    if (down.size) begin();
    else {
      g = null;
      cv.classList.remove('dragging');
    }
  };
  cv.addEventListener('pointerup', end);
  cv.addEventListener('pointercancel', end);
  // A plain wheel scrolls the page; Ctrl (or Cmd) + wheel and trackpad pinch zoom the map.
  cv.addEventListener(
    'wheel',
    (ev) => {
      if (!ev.ctrlKey && !ev.metaKey) return;
      ev.preventDefault();
      const p = local({ x: ev.clientX, y: ev.clientY });
      zoomAt(p.x, p.y, S.fv.k * Math.exp(-ev.deltaY * 0.0025));
    },
    { passive: false },
  );
  // Safari's trackpad pinch.
  let gestureK = 1;
  cv.addEventListener('gesturestart', (ev) => {
    ev.preventDefault();
    gestureK = S.fv.k;
  });
  cv.addEventListener('gesturechange', (ev) => {
    ev.preventDefault();
    const p = local({ x: ev.clientX, y: ev.clientY });
    zoomAt(p.x, p.y, gestureK * ev.scale);
  });
  // Keyboard, while the map or anything in it has focus: arrows move it, + and - zoom, 0 fits.
  cv.addEventListener('keydown', (ev) => {
    if (ev.altKey || ev.ctrlKey || ev.metaKey) return;
    const step = ev.shiftKey ? 240 : 60;
    const zoom = (factor) => zoomAt(cv.clientWidth / 2, cv.clientHeight / 2, S.fv.k * factor);
    const keys = {
      ArrowLeft: () => panBy(step, 0),
      ArrowRight: () => panBy(-step, 0),
      ArrowUp: () => panBy(0, step),
      ArrowDown: () => panBy(0, -step),
      '+': () => zoom(1.25),
      '=': () => zoom(1.25),
      '-': () => zoom(0.8),
      _: () => zoom(0.8),
      0: () => zoomButton('fit'),
    };
    const act = Object.hasOwn(keys, ev.key) ? keys[ev.key] : null;
    if (!act) return;
    ev.preventDefault();
    act();
  });
  // Focus can scroll an overflow box; the map moves only through its own transform.
  cv.addEventListener('scroll', () => {
    cv.scrollLeft = 0;
    cv.scrollTop = 0;
  });
  // Tabbing to a tile that is off screen brings it into view. A click is left alone (the tile
  // would slide out from under the pointer and the click would miss), and so is focus put back
  // after a repaint (that would undo the person's own panning every few seconds).
  cv.addEventListener('focusin', (ev) => {
    if (restoringFocus || Date.now() - pointerAt < 600) return;
    const tile = ev.target.closest('.tile');
    const p = tile && S.layout && S.layout.pos.get(tile.dataset.node);
    if (!p) return;
    const v = S.fv;
    const x0 = v.x + p.x * v.k;
    const y0 = v.y + p.y * v.k;
    if (x0 >= 0 && y0 >= 0 && x0 + FL.W * v.k <= cv.clientWidth && y0 + FL.H * v.k <= cv.clientHeight) return;
    Object.assign(v, { x: cv.clientWidth / 2 - (p.x + FL.W / 2) * v.k, y: cv.clientHeight / 2 - (p.y + FL.H / 2) * v.k, user: true });
    applyView();
  });
  // Fit as soon as the canvas can be measured: first show, a tab coming back, a turned phone.
  if ('ResizeObserver' in window) {
    new ResizeObserver(() => {
      if (S.view !== 'map' || !S.layout) return;
      if (S.fv.user) applyView();
      else if (fitView()) S.fv.sig = S.layoutSig;
    }).observe(cv);
  }
})();

// Packets are drawn in markup, so a change of the motion setting needs a fresh draw.
motionQuery.addEventListener('change', () => {
  if (S.view === 'map') renderMap();
});

// ---------------------------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------------------------

// Sessions in map order with their depth below the nearest top-level session.
function sessionRows(ix) {
  const rows = [];
  const visit = (n, depth) => {
    const self = isSession(n);
    if (self) rows.push({ n, depth });
    for (const k of ix.kids.get(n.key) || []) visit(k, self ? depth + 1 : depth);
  };
  ix.roots.forEach((r) => visit(r, 0));
  return rows;
}

function rowHtml(n, depth) {
  const status = statusOf(n);
  const d = doing(n);
  return (
    `<tr class="${status ? `st-${status}` : ''}">` +
    `<td><div class="who" style="--depth:${depth}">${markHtml(n, 'small')}<span class="tx">` +
    `<button type="button" class="open" data-node="${esc(n.key)}">${esc(titleOf(n))}</button>` +
    `<span class="sub">${esc(rankLine(n))}</span></span></div></td>` +
    `<td><span class="pill">${esc(STATUS_WORDS[status] || 'Unknown')}</span></td>` +
    `<td class="doing">${d ? `<span class="quiet">${esc(d.label)}:</span> ${doingHtml(d)}` : ''}</td>` +
    `<td class="model">${esc(modelText(n))}</td>` +
    `<td class="when">${agoHtml(n.lastAt)}</td></tr>`
  );
}

function renderList() {
  if (!S.snap) {
    setHtml($('#list-body'), '<p class="empty">Reading your sessions…</p>');
    return;
  }
  const ix = S.index;
  setText($('#list-meta'), countsLine());
  setHtml($('#list-attention'), attentionHtml());
  if (!hasSessions()) {
    setHtml($('#list-filters'), '');
    setHtml($('#list-body'), welcomeHtml());
    return;
  }
  const rows = sessionRows(ix);
  const tally = { all: rows.length };
  for (const r of rows) tally[statusOf(r.n)] = (tally[statusOf(r.n)] || 0) + 1;
  setHtml(
    $('#list-filters'),
    FILTERS.map(
      ([key, label]) =>
        `<button type="button" class="chip" data-list-filter="${key}" aria-pressed="${S.listFilter === key}">${esc(label)} <span class="n">${tally[key] || 0}</span></button>`,
    ).join(''),
  );
  const filtered = S.listFilter !== 'all';
  const shown = filtered ? rows.filter((r) => statusOf(r.n) === S.listFilter) : rows;
  if (!shown.length) {
    setHtml($('#list-body'), '<p class="empty">No sessions match this filter right now.</p>');
    return;
  }
  const groups = new Map();
  for (const r of shown) {
    const name = r.n.project || '';
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(r);
  }
  const names = [...groups.keys()].sort((a, b) => (!a) - (!b) || projectLabel(a).localeCompare(projectLabel(b)));
  const bodies = names.map((name) => {
    const list = groups.get(name);
    return (
      `<tbody><tr class="grp"><th scope="rowgroup" colspan="5">${esc(projectLabel(name))}<span class="quiet">${esc(plural(list.length, 'session', 'sessions'))}</span></th></tr>` +
      list.map((r) => rowHtml(r.n, filtered ? 0 : r.depth)).join('') +
      '</tbody>'
    );
  });
  setHtml(
    $('#list-body'),
    `<div class="table-wrap"><table class="list"><caption class="sr-only">Sessions grouped by project</caption>` +
      '<thead><tr><th scope="col">Session</th><th scope="col">Status</th><th scope="col">Doing now or last said</th><th scope="col">Model</th><th scope="col">Last active</th></tr></thead>' +
      `${bodies.join('')}</table></div>`,
  );
}

// ---------------------------------------------------------------------------------------------
// activity
// ---------------------------------------------------------------------------------------------

function nameHtml(key) {
  if (key && S.index.byKey.has(key)) return `<button type="button" class="name" data-node="${esc(key)}">${esc(keyName(key))}</button>`;
  return `<b>${esc(keyName(key))}</b>`;
}

// Direction and wording of a feed event. A report is always told child-to-parent, whichever way
// round the server lists the pair.
function describeEvent(ev) {
  const ix = S.index;
  let from = ev.from;
  let to = ev.to;
  const fwd = ix.edgeBy.has(`${from}\n${to}`);
  const back = ix.edgeBy.has(`${to}\n${from}`);
  switch (ev.kind) {
    case 'spawn':
      return { dir: 'down', from, to, verb: 'handed work to' };
    case 'message':
      return { dir: 'down', from, to, verb: 'sent a message to' };
    case 'report':
      if (fwd && !back) [from, to] = [to, from];
      return { dir: 'up', from, to, verb: 'reported back to' };
    case 'mailbox':
      return back && !fwd ? { dir: 'up', from, to, verb: 'wrote back through the mailbox to' } : { dir: 'down', from, to, verb: 'wrote through the mailbox to' };
    case 'error':
      return { dir: 'error', from, to: null, verb: 'ran into an error' };
    default:
      return { dir: '', from, to, verb: 'passed something to' };
  }
}

function eventHtml(ev) {
  const d = describeEvent(ev);
  const arrow = { down: '↓', up: '↑', error: '!' }[d.dir] || '·';
  const dirWords = { down: 'Work going down.', up: 'Report coming up.', error: 'Error.' }[d.dir] || '';
  const sentence = `${nameHtml(d.from)} ${esc(d.verb)}${d.to ? ' ' + nameHtml(d.to) : ''}`;
  return (
    `<li class="ev dir-${d.dir || 'none'}">${timeHtml(ev.at, clock(ev.at))}` +
    `<span class="dir" aria-hidden="true">${arrow}</span>` +
    `<div><p class="what"><span class="sr-only">${dirWords} </span>${sentence}</p>${ev.text ? `<p class="text">${esc(ev.text)}</p>` : ''}</div></li>`
  );
}

function feedEvents() {
  const list = S.snap && Array.isArray(S.snap.events) ? S.snap.events.filter((e) => e && isTime(e.at)) : [];
  return list.slice().sort((a, b) => b.at - a.at);
}

function renderActivity() {
  if (!S.snap) {
    setHtml($('#feed'), '<p class="empty">Reading your sessions…</p>');
    return;
  }
  const all = feedEvents().map((ev) => ({ ev, dir: describeEvent(ev).dir }));
  const tally = { all: all.length, down: 0, up: 0, error: 0 };
  for (const x of all) if (Object.hasOwn(tally, x.dir)) tally[x.dir]++;
  setHtml(
    $('#feed-filters'),
    FEED_FILTERS.map(
      ([key, label]) =>
        `<button type="button" class="chip" data-feed-filter="${key}" aria-pressed="${S.feedFilter === key}">${esc(label)} <span class="n">${tally[key]}</span></button>`,
    ).join(''),
  );
  const matching = S.feedFilter === 'all' ? all : all.filter((x) => x.dir === S.feedFilter);
  if (!matching.length) {
    const msg = all.length ? 'Nothing matches this filter yet.' : 'No hand-offs yet. When a session starts a helper, sends it work or gets a report back, it shows up here.';
    setHtml($('#feed'), `<p class="empty">${msg}</p>`);
    return;
  }
  const out = [];
  let day = null;
  for (const { ev } of matching.slice(0, S.feedLimit)) {
    const label = dayLabel(ev.at);
    if (label !== day) {
      if (day) out.push('</ol></section>');
      out.push(`<section class="day"><h2>${esc(label)}</h2><ol class="feed">`);
      day = label;
    }
    out.push(eventHtml(ev));
  }
  out.push('</ol></section>');
  const rest = matching.length - S.feedLimit;
  if (rest > 0) out.push(`<button type="button" class="btn older" id="feed-older">Show ${Math.min(FEED_PAGE, rest)} older</button>`);
  setHtml($('#feed'), out.join(''));
}

// ---------------------------------------------------------------------------------------------
// tasks
// ---------------------------------------------------------------------------------------------

const STATE_WORDS = {
  IN_PROGRESS: 'In progress', IN_REVIEW: 'In review', DONE: 'Done', CANCELLED: 'Cancelled', CANCELED: 'Cancelled', COMPLETE: 'Complete',
  COMPLETED: 'Completed', NO_CLAUDE_DISPATCH: 'No Claude dispatch', BLOCKED: 'Blocked', NEW: 'New', ACCEPTED: 'Accepted', RETURNED: 'Sent back for changes',
};
// The same finished states as CLOSED in src/sources/mailbox.js. Keep the two in step.
const CLOSED_STATE = /^(DONE|CANCELL?ED|COMPLETED?|NO_CLAUDE_DISPATCH)(_|$)/;

function taskState(state) {
  const s = String(state || '').trim();
  const word = s.split(/[\s.(]/)[0].toUpperCase();
  let cls = '';
  if (CLOSED_STATE.test(word)) cls = 's-closed';
  else if (/BLOCKED/.test(word)) cls = 's-blocked';
  else if (/REVIEW/.test(word)) cls = 's-review';
  const label = STATE_WORDS[word] || (s ? cap(s.replace(/_/g, ' ').toLowerCase()) : 'No state yet');
  return { label, cls, closed: cls === 's-closed' };
}

function taskHtml(t) {
  const st = taskState(t.state);
  const attention = Array.isArray(t.attention) ? t.attention : [];
  const badges = attention.map((a) => `<span class="badge">${esc(a === 'question' ? 'Has a question' : a === 'review' ? 'Ready for review' : cap(a))}</span>`).join('');
  const workers = (Array.isArray(t.workers) ? t.workers : []).filter((w) => w && typeof w === 'object').map(
    (w) => `<span class="wtag">${esc([w.id, w.state ? String(w.state).toLowerCase() : '', prettyModel(w.model)].filter(Boolean).join(' · '))}</span>`,
  );
  return (
    `<li class="task${attention.length && !st.closed ? ' needs' : ''}"><div class="task-head">` +
    `<span class="task-title">${esc(t.title || t.id)}</span><span class="task-state ${st.cls}">${esc(st.label)}</span>${st.closed ? '' : badges}</div>` +
    `<div class="task-sub"><span class="mono">${esc(t.id)}</span>${isTime(t.updatedAt) ? `<span>updated ${agoHtml(t.updatedAt)}</span>` : ''}${workers.join('')}</div></li>`
  );
}

function renderTasks() {
  const tasks = S.snap && Array.isArray(S.snap.tasks) ? S.snap.tasks.filter((t) => t && t.id) : null;
  if (!tasks) {
    setText($('#tasks-meta'), '');
    setHtml(
      $('#tasks'),
      '<p class="empty">Tasks come from a mailbox: a folder where one agent hands out work and another reports back. No mailbox is turned on. You can add one in <a href="#/settings">Settings</a>.</p>',
    );
    return;
  }
  const sorted = tasks.slice().sort((a, b) => String(b.id).localeCompare(String(a.id)));
  const open = sorted.filter((t) => !taskState(t.state).closed);
  const closed = sorted.filter((t) => taskState(t.state).closed);
  const needs = open.filter((t) => Array.isArray(t.attention) && t.attention.length).length;
  setText($('#tasks-meta'), `${open.length} open · ${needs} need a look · ${closed.length} closed`);
  const details = $('#tasks details.fold');
  const wasOpen = details ? details.open : false;
  setHtml(
    $('#tasks'),
    (open.length ? `<ul class="tasks">${open.map(taskHtml).join('')}</ul>` : '<p class="empty">No open tasks.</p>') +
      (closed.length ? `<details class="fold"${wasOpen ? ' open' : ''}><summary>${esc(plural(closed.length, 'closed task', 'closed tasks'))}</summary><ul class="tasks">${closed.map(taskHtml).join('')}</ul></details>` : ''),
  );
}

// ---------------------------------------------------------------------------------------------
// drawer
// ---------------------------------------------------------------------------------------------

function setInert(on) {
  for (const el of [$('.skip'), $('.appbar'), $('#main')]) el.inert = on;
}

function openDrawer(key, opener) {
  const prev = S.drawer;
  if (prev) leaveDrawer();
  S.drawer = { key, tab: 'now', events: [], next: null, loaded: false, error: null, busy: false, frame: '', pick: null, opener: prev ? prev.opener : opener || document.activeElement };
  $('#layer').hidden = false;
  setInert(true);
  renderDrawerParts();
  $('#drawer [data-close]').focus();
  fetchDrawerEvents();
}

function closeDrawer() {
  if (!S.drawer) return;
  leaveDrawer();
  const { opener, key } = S.drawer;
  S.drawer = null;
  $('#layer').hidden = true;
  setInert(false);
  $('#drawer').innerHTML = '';
  paintMoved();
  let back = opener && opener.isConnected && !opener.closest('[hidden]') ? opener : null;
  if (!back) back = $(`.view:not([hidden]) [data-node="${CSS.escape(key)}"]`) || $('#main');
  back.focus();
}

function focusables(root) {
  return $$('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])', root).filter(
    (el) => !el.closest('[hidden]') && el.getClientRects().length > 0,
  );
}

const DRAWER_TABS = {
  session: [['now', 'Now'], ['details', 'Details'], ['handoffs', 'Hand-offs']],
  relay: [['now', 'Overview'], ['details', 'Details'], ['handoffs', 'Hand-offs']],
  group: [['now', 'Overview'], ['details', 'Details']],
};
const DRAWER_ABOUT = { session: 'About this session', relay: 'About the relay', group: 'About this group' };

// The frame (title, Reports to menu, tabs, empty panels) is rebuilt only when the kind of drawer
// changes. The message under the menu, and the one under the tabs that says a "Needs you" was
// dismissed, are status regions that stay in place, so screen readers hear each new message.
function drawerFrame(frame) {
  const tabs = DRAWER_TABS[frame];
  const d = S.drawer;
  if (!tabs.some(([id]) => id === d.tab)) d.tab = 'now';
  return (
    `<div class="dhead"><span class="mark" id="drawer-mark" aria-hidden="true"></span>` +
    '<div class="dtitles"><h2 id="drawer-title"></h2><p class="dsub" id="drawer-sub"></p></div>' +
    `<button type="button" class="icon-btn" data-close aria-label="Close the details">${svgIcon(ICONS.close)}</button></div>` +
    '<div class="dstatus" id="drawer-status"></div>' +
    (frame === 'group'
      ? ''
      : '<div class="dplace" id="drawer-place" hidden><label for="d-boss">Reports to</label>' +
        '<select class="field" id="d-boss" aria-describedby="d-boss-how d-boss-msg"></select>' +
        '<p class="help" id="d-boss-how"></p>' +
        '<p class="dplace-done"><span id="d-boss-msg" role="status"></span><button type="button" class="btn" id="d-boss-undo" data-undo aria-describedby="d-boss-msg" hidden>Undo</button></p></div>') +
    `<div class="tabs" role="tablist" aria-label="${DRAWER_ABOUT[frame]}">` +
    tabs
      .map(
        ([id, label]) =>
          `<button type="button" role="tab" id="dtab-${id}" data-tab="${id}" aria-controls="dpanel-${id}" aria-selected="${id === d.tab}" tabindex="${id === d.tab ? 0 : -1}">${label}</button>`,
      )
      .join('') +
    '</div>' +
    (frame === 'session'
      ? '<p class="dplace-done dnote" id="d-note"><span id="d-note-msg" role="status"></span><button type="button" class="btn" id="d-note-undo" data-undo aria-describedby="d-note-msg" hidden>Undo</button></p>'
      : '') +
    tabs.map(([id]) => `<div role="tabpanel" id="dpanel-${id}" aria-labelledby="dtab-${id}" tabindex="0"${id === d.tab ? '' : ' hidden'}></div>`).join('')
  );
}

function selectTab(id, focus) {
  if (!S.drawer) return;
  S.drawer.tab = id;
  for (const t of $$('#drawer [role="tab"]')) {
    const on = t.dataset.tab === id;
    t.setAttribute('aria-selected', String(on));
    t.tabIndex = on ? 0 : -1;
    if (on && focus) t.focus();
  }
  for (const p of $$('#drawer [role="tabpanel"]')) p.hidden = p.id !== `dpanel-${id}`;
}

function renderDrawerParts() {
  const d = S.drawer;
  if (!d) return;
  const n = S.index && S.index.byKey.get(d.key);
  const group = !!n && !isSession(n);
  const frame = !group ? 'session' : isRelay(n) ? 'relay' : 'group';
  const drawer = $('#drawer');
  if (d.frame !== frame) {
    const hadFocus = drawer.contains(document.activeElement);
    drawer.innerHTML = drawerFrame(frame);
    d.frame = frame;
    if (hadFocus) $('#drawer [data-close]').focus();
  }
  const mark = n ? markFor(n) : { cls: 'mk-codex', svg: '' };
  const markEl = $('#drawer-mark');
  markEl.className = `mark ${mark.cls}`;
  setHtml(markEl, mark.svg);
  const title = n ? titleOf(n) : keyName(d.key);
  if ($('#drawer-title').textContent !== title) $('#drawer-title').textContent = title;
  const sub = n ? [rankLine(n), isSession(n) ? modelText(n) : ''].filter(Boolean).join(' · ') : '';
  if ($('#drawer-sub').textContent !== sub) $('#drawer-sub').textContent = sub;
  setHtml($('#drawer-status'), drawerStatusHtml(n));
  paintPlace(n, d);
  paintMoved();
  if (group) {
    setHtml($('#dpanel-now'), groupNowHtml(n));
    setHtml($('#dpanel-details'), detailsHtml(n));
    if (frame === 'relay') setHtml($('#dpanel-handoffs'), handoffsHtml(d.key));
  } else {
    setHtml($('#dpanel-now'), sessionNowHtml(n, d));
    setHtml($('#dpanel-details'), n ? detailsHtml(n) : '<p class="empty">No details: this session is not listed right now.</p>');
    setHtml($('#dpanel-handoffs'), handoffsHtml(d.key));
  }
}

// The Reports to menu under the title, for sessions and the relay.
function paintPlace(n, d) {
  const box = $('#drawer-place');
  if (!box) return;
  box.hidden = !canMove(n);
  if (box.hidden) return;
  const select = $('#d-boss');
  // Not rebuilt while it is in use or a move is on its way: that would close the open list, or
  // show the old boss for a moment.
  if (document.activeElement !== select && !d.pick && !placing) setHtml(select, bossOptionsHtml(n));
  setText($('#d-boss-how'), PLACEMENT_WORDS[n.placement] || PLACEMENT_WORDS.auto);
}

// Automatic, Me, then every session and the relay that this tile could report to: not the tile
// itself and nothing below it. Sessions without a real name come last, in a group of their own.
function bossOptionsHtml(n) {
  const ix = S.index;
  const below = belowKeys(ix, n.key);
  const choice = currentChoice(n);
  const bosses = ix.nodes.filter((b) => canMove(b) && b.key !== n.key && !below.has(b.key));
  const count = new Map();
  for (const b of bosses) count.set(titleOf(b), (count.get(titleOf(b)) || 0) + 1);
  // A name that does not say which session it is also says where the session runs.
  const label = (b) => {
    const title = titleOf(b);
    if (b.named !== false && count.get(title) === 1) return title;
    const where = [PLATFORM_WORDS[b.platform], b.project ? projectLabel(b.project) : ''].filter(Boolean).join(', ');
    return where ? `${title} (${where})` : title;
  };
  const opt = (value, text) => `<option value="${esc(value)}"${value === choice ? ' selected' : ''}>${esc(text)}</option>`;
  const list = (items) => items.sort(byTitle).map((b) => opt(b.key, label(b))).join('');
  const unnamed = bosses.filter((b) => b.named === false);
  return (
    opt('', 'Automatic') +
    opt('you', 'Me') +
    list(bosses.filter((b) => b.named !== false)) +
    (unnamed.length ? `<optgroup label="Sessions without a name">${list(unnamed)}</optgroup>` : '')
  );
}

// The person's own choice for a tile, as the menu shows it: '' (Automatic), 'you' or a boss's key.
function currentChoice(n) {
  if (!n || n.placement !== 'manual') return '';
  const boss = S.index && S.index.byKey.get(n.parent);
  return canMove(boss) ? boss.key : 'you';
}

// Every key below a tile: its helpers, their helpers, and so on.
function belowKeys(ix, key) {
  const out = new Set();
  const visit = (k) => {
    for (const c of ix.kids.get(k) || []) {
      if (out.has(c.key)) continue;
      out.add(c.key);
      visit(c.key);
    }
  };
  visit(key);
  return out;
}

function drawerStatusHtml(n) {
  if (!n) return '<span>This session is not listed right now. It may have been quiet for longer than the time window in Settings.</span>';
  if (!canMove(n)) return '';
  const status = statusOf(n);
  const parts = [`<span class="pill st-${status || 'idle'}">${esc(STATUS_WORDS[status] || 'Unknown')}</span>`];
  if (isTime(n.lastAt)) parts.push(`<span>Last active ${agoHtml(n.lastAt)}</span>`);
  if (isTime(n.startedAt)) parts.push(`<span>Started ${timeHtml(n.startedAt, stamp(n.startedAt))}</span>`);
  return parts.join('');
}

// The time of a session's ask, as Pleni compares it when the ask is dismissed. An ask without a
// time of its own goes by the time on its notice, so the notice goes away with it.
function needsAt(n) {
  if (Number.isFinite(n.needs.at)) return n.needs.at;
  const item = attentionItems().find((a) => a.id === `${n.key}|needs`);
  return item && Number.isFinite(item.at) ? item.at : num(n.lastAt);
}

function sessionEventHtml(e) {
  const kind = Object.hasOwn(EVENT_KIND_WORDS, e.kind) ? e.kind : 'other';
  const label = (EVENT_KIND_WORDS[kind] || cap(e.kind) || 'Event') + (e.tool ? `: ${e.tool}` : '');
  const text = kind === 'thinking' ? '' : e.text;
  return `<li class="k-${kind}">${timeHtml(e.at, clock(e.at, true)) || '<span></span>'}<div><span class="k">${esc(label)}</span>${text ? `<div class="tx">${esc(text)}</div>` : ''}</div></li>`;
}

function sessionNowHtml(n, d) {
  const out = [];
  const now = n ? doing(n) : null;
  if (now && n.needs) {
    const dismiss = `<button type="button" class="btn" data-dismiss="${esc(`${n.key}|needs`)}" data-at="${esc(needsAt(n))}" aria-label="${esc(`Dismiss: ${now.text}`)}">Dismiss</button>`;
    out.push(`<p class="dnow has-x"><span><b>${esc(now.label)}:</b> ${doingHtml(now)}</span>${dismiss}</p>`);
  } else if (now) {
    out.push(`<p class="dnow"><b>${esc(now.label)}:</b> ${doingHtml(now)}</p>`);
  }
  out.push(openHtml(n));
  if (isWorkerKey(d.key)) {
    out.push('<p class="empty">This worker keeps no session file.</p>');
    return out.join('');
  }
  out.push('<h3>Recent events</h3>');
  if (d.error) out.push(`<p class="empty">Could not load recent events. ${esc(d.error)}</p>`);
  else if (!d.loaded) out.push('<p class="empty">Loading recent events…</p>');
  else if (!d.events.length) out.push('<p class="empty">No recent events.</p>');
  else out.push(`<ol class="dev">${d.events.slice().reverse().map(sessionEventHtml).join('')}</ol>`);
  if (d.loaded && d.events.length && !d.events.some((e) => e.text)) {
    out.push('<p class="note">Only the kind of each event is shown. Snippets are turned off in Settings, or these events have no text.</p>');
  }
  return out.join('');
}

// What Open in PowerShell would open for this tile: the session itself, or for a Claude Code helper
// (sub-agent) the session it works inside. A Codex helper is a thread of its own, so it opens
// itself. Null when the button is off or cannot work.
function openTarget(n) {
  if (!n || !LOCAL_PAGE || !(S.snap && S.snap.actions && S.snap.actions.openTerminal) || !isSession(n)) return null;
  const id = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
  if (new RegExp(`^codex:${id}$`).test(n.key)) return n.kind === 'reviewer' ? null : { key: n.key, title: titleOf(n), helper: false };
  const m = new RegExp(`^(claude:${id})(/|$)`).exec(n.key);
  if (!m) return null;
  const top = m[1] === n.key ? n : S.index && S.index.byKey.get(m[1]);
  return top ? { key: m[1], title: titleOf(top), helper: top !== n } : null;
}

function openHtml(n) {
  const t = openTarget(n);
  if (!t) return '';
  const label = t.helper ? 'Open its session in PowerShell' : 'Open in PowerShell';
  const help = t.helper
    ? `This helper works inside "${t.title}". Open that session to watch it and type to it.`
    : 'Opens a new PowerShell window where you can see this conversation and type to it.';
  return `<div class="dopen"><button type="button" class="btn" data-open="${esc(t.key)}" data-title="${esc(t.title)}" aria-describedby="d-open-help">${esc(label)}</button><p class="help" id="d-open-help">${esc(help)}</p></div>`;
}

function groupNowHtml(n) {
  const ix = S.index;
  const c = ix.counts.get(n.key) || { total: 0 };
  const kids = ix.kids.get(n.key) || [];
  const list = kids
    .map((k) => {
      const status = statusOf(k);
      const right = status ? `<span class="pill st-${status}">${esc(STATUS_WORDS[status])}</span>` : `<span class="quiet">${esc(countsPlain(ix.counts.get(k.key) || { total: 0 }))}</span>`;
      return `<li><button type="button" data-node="${esc(k.key)}">${markHtml(k, 'small')}<span class="t">${esc(titleOf(k))}</span>${right}</button></li>`;
    })
    .join('');
  const heading = n.kind === 'person' ? 'Under you' : isRelay(n) ? 'Under the relay' : 'In this project';
  return `<p class="dnow">${esc(cap(countsPlain(c)))}.</p><h3>${heading}</h3>${list ? `<ul class="kids">${list}</ul>` : '<p class="empty">Nothing listed right now.</p>'}`;
}

function detailsHtml(n) {
  const rows = [];
  const add = (k, v) => {
    if (v != null && v !== '') rows.push(`<tr><th scope="row">${esc(k)}</th><td>${v}</td></tr>`);
  };
  add('Kind', esc(KIND_WORDS[n.kind] || cap(n.kind)));
  add('Where', esc(PLATFORM_WORDS[n.platform] || ''));
  add('Opened from', esc(ENTRY_WORDS[n.entrypoint] || n.entrypoint || ''));
  add('Rank', esc(n.rank || ''));
  add('Role', esc(cap(n.role || '')));
  add('Project', esc(n.project ? projectLabel(n.project) : ''));
  if (isSession(n)) {
    add('Model', esc([n.modelLabel || prettyModel(n.model), n.model && n.modelLabel !== n.model ? `(${n.model})` : ''].filter(Boolean).join(' ')));
    add('Effort', esc(EFFORT_WORDS[n.effort] || n.effort || ''));
    add('Tier', esc(n.tier === 'senior' ? 'Senior' : n.tier === 'junior' ? 'Junior' : ''));
    add('Started', isTime(n.startedAt) ? timeHtml(n.startedAt, stamp(n.startedAt)) : '');
    add('Last active', isTime(n.lastAt) ? `${timeHtml(n.lastAt, stamp(n.lastAt))} (${agoHtml(n.lastAt)})` : '');
    add('Archived', n.archived ? 'Yes' : '');
  }
  add('Key', `<span class="mono">${esc(n.key)}</span>`);
  const from = isRelay(n) || isWorkerKey(n.key) ? 'Read from the mailbox folder on this computer. Pleni never changes it.' : 'Read from the session files on this computer. Pleni never changes them.';
  return `<table class="facts-t"><tbody>${rows.join('')}</tbody></table><p class="note">${from}</p>`;
}

function handoffsHtml(key) {
  const ix = S.index;
  if (!ix) return '';
  const lines = [];
  const line = (at, dirCls, words, other, text, now) =>
    lines.push({
      at: at || 0,
      html: `<div class="hand"><div class="meta"><span class="${dirCls}">${esc(words)}</span> ${nameHtml(other)}${at ? `, ${timeHtml(at, stamp(at))}` : ''}${now ? ' (moving now)' : ''}</div>${text ? `<div class="tx">${esc(text)}</div>` : ''}</div>`,
    });
  for (const e of ix.edges) {
    if (e.kind === 'contains' || (e.from !== key && e.to !== key)) continue;
    const down = toTime(e.lastDown);
    const up = toTime(e.lastUp);
    const dNow = e.active === 'down' || e.active === 'both';
    const uNow = e.active === 'up' || e.active === 'both';
    if (e.from === key) {
      if (down) line(down, 'd-down', 'Handed work to', e.to, e.downLabel, dNow);
      if (up) line(up, 'd-up', 'Got a report from', e.to, e.upLabel, uNow);
    } else {
      if (down) line(down, 'd-down', 'Got work from', e.from, e.downLabel, dNow);
      if (up) line(up, 'd-up', 'Reported back to', e.from, e.upLabel, uNow);
    }
  }
  lines.sort((a, b) => b.at - a.at);
  const events = feedEvents().filter((ev) => ev.from === key || ev.to === key).slice(0, 50);
  const out = [];
  out.push('<h3>Lines to other sessions</h3>');
  out.push(lines.length ? lines.map((l) => l.html).join('') : '<p class="empty">No hand-offs with other sessions yet.</p>');
  if (events.length) out.push(`<h3>Recent hand-offs</h3><ol class="feed">${events.map(eventHtml).join('')}</ol>`);
  return out.join('');
}

async function fetchDrawerEvents() {
  const d = S.drawer;
  if (!d || d.busy) return;
  const n = S.index && S.index.byKey.get(d.key);
  if ((n && !isSession(n)) || isWorkerKey(d.key)) return;
  d.busy = true;
  try {
    // No cursor on the first call: the server then sends the most recent events.
    const since = d.next === null ? '' : `&since=${encodeURIComponent(d.next)}`;
    const body = await getJson(`/api/session?key=${encodeURIComponent(d.key)}${since}`);
    if (S.drawer !== d) return;
    const list = Array.isArray(body && body.events) ? body.events.filter((e) => e && typeof e === 'object') : [];
    const next = body && Number.isSafeInteger(body.next) && body.next >= 0 ? body.next : d.next;
    const restarted = (body && body.reset) || (d.next !== null && next !== null && next < d.next);
    d.events = restarted ? list : d.events.concat(list);
    d.events = d.events.slice(-200);
    d.next = next;
    d.loaded = true;
    d.error = null;
  } catch (err) {
    if (S.drawer === d) d.error = plainError(err);
  } finally {
    d.busy = false;
    if (S.drawer === d) {
      if (pressing()) press.waiting = true;
      else renderDrawerParts();
    }
  }
}

document.addEventListener('keydown', (ev) => {
  if (!S.drawer) return;
  if (ev.key === 'Escape') {
    ev.preventDefault();
    closeDrawer();
    return;
  }
  const tab = ev.target.closest && ev.target.closest('[role="tab"]');
  if (tab && ['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(ev.key)) {
    const tabs = $$('[role="tab"]', tab.parentElement);
    let i = tabs.indexOf(tab);
    if (ev.key === 'ArrowRight') i = (i + 1) % tabs.length;
    else if (ev.key === 'ArrowLeft') i = (i - 1 + tabs.length) % tabs.length;
    else if (ev.key === 'Home') i = 0;
    else i = tabs.length - 1;
    ev.preventDefault();
    selectTab(tabs[i].dataset.tab, true);
    return;
  }
  if (ev.key !== 'Tab') return;
  // Keep focus inside the open drawer.
  const drawer = $('#drawer');
  const items = focusables(drawer);
  if (!items.length) {
    ev.preventDefault();
    drawer.focus();
    return;
  }
  const first = items[0];
  const last = items[items.length - 1];
  const active = document.activeElement;
  if (ev.shiftKey && (active === first || !drawer.contains(active))) {
    ev.preventDefault();
    last.focus();
  } else if (!ev.shiftKey && (active === last || !drawer.contains(active))) {
    ev.preventDefault();
    first.focus();
  }
});

document.addEventListener('focusin', (ev) => {
  if (S.drawer && !$('#layer').contains(ev.target)) {
    const close = $('#drawer [data-close]');
    if (close) close.focus();
  }
});

// Keyboard focus must never hide under the sticky app bar or the sticky Save row (WCAG 2.4.11).
// The browser scrolls a focused control into view only when it is off screen, not when a sticky
// bar covers it, so this scrolls the control clear of both bars: once right away, and once more
// after the browser's own focus scrolling has run.
const FOCUS_GAP = 8;

function keepFocusClear(el) {
  if (document.activeElement !== el || !el.matches(':focus-visible')) return;
  if ($('#layer').contains(el) || el.closest('.appbar, .btnrow')) return;
  const box = el.getBoundingClientRect();
  if (!box.height) return;
  const bar = $('.appbar');
  const top = bar ? bar.getBoundingClientRect().bottom + FOCUS_GAP : 0;
  const row = el.closest('#view-settings') ? $('#view-settings .btnrow') : null;
  const bottom = row ? row.getBoundingClientRect().top - FOCUS_GAP : innerHeight;
  if (box.top < top) scrollBy(0, box.top - top);
  else if (box.bottom > bottom) scrollBy(0, Math.min(box.bottom - bottom, box.top - top));
}

document.addEventListener('focusin', (ev) => {
  const el = ev.target;
  if (!(el instanceof Element)) return;
  keepFocusClear(el);
  setTimeout(() => keepFocusClear(el), 0);
});

// The app bar's height, for scroll-padding in styles.css (links to parts of the page use it too).
function measureAppBar() {
  const bar = $('.appbar');
  if (bar) document.documentElement.style.setProperty('--pl-appbar-h', `${Math.ceil(bar.getBoundingClientRect().height)}px`);
}
if ('ResizeObserver' in window) new ResizeObserver(measureAppBar).observe($('.appbar'));
measureAppBar();

$('#scrim').addEventListener('click', closeDrawer);

// ---------------------------------------------------------------------------------------------
// who reports to whom: the Reports to menu, moves on the map, and Undo
// ---------------------------------------------------------------------------------------------

// msg: { key, text, bad, undo, spot, where }. `undo` is the function that takes the change back,
// `spot` is 'note' for a dismissed notice (else the message goes under the Reports to menu), and
// `where` is 'drawer' or 'toast'.
const moved = { msg: null, timer: 0 };
let placing = 0; // moves on their way to Pleni
let moveQueue = Promise.resolve();
let keyedAt = 0;

// Sends a change to Pleni with the header and type that every change needs.
async function postJson(url, data) {
  const res = await fetch(url, {
    method: 'POST',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json', 'X-Pleni': 'settings' },
    body: JSON.stringify(data),
  });
  const body = await readJson(res);
  if (!res.ok) throw answerError(res, body);
  return body;
}

// Asks Pleni to put a tile under a new boss: a tile's key, 'you', or null for Automatic.
function postPlacement(key, reportsTo) {
  return postJson('/api/placement', { key, reportsTo });
}

// Moves run one at a time, in the order they were made, each after the map has caught up with the
// one before. `how` is 'menu', 'drag' or 'undo'.
function moveNode(key, reportsTo, how) {
  placing++;
  moveQueue = moveQueue
    .then(() => doMove(key, reportsTo, how))
    .catch(() => {})
    .finally(() => {
      placing--;
    });
  return moveQueue;
}

async function doMove(key, reportsTo, how) {
  const before = S.index && S.index.byKey.get(key);
  if (how === 'menu' && before && currentChoice(before) === (reportsTo || '')) return;
  const name = before ? titleOf(before) : keyName(key);
  // Undo puts back the person's own earlier choice, or Automatic when there was none.
  const back = currentChoice(before) || null;
  const undo = how === 'undo' ? null : () => moveNode(key, back, 'undo');
  try {
    await postPlacement(key, reportsTo);
  } catch (err) {
    const select = $('#d-boss');
    if (select && S.drawer && S.drawer.key === key && !S.drawer.pick) select.value = currentChoice(S.index && S.index.byKey.get(key));
    showMoved({ key, bad: true, text: `Not moved. ${plainError(err)}` });
    return;
  }
  keepPlacement(key, reportsTo);
  await pollNow().catch(() => {});
  const after = S.index && S.index.byKey.get(key);
  const boss = after ? after.parent : reportsTo;
  const text = boss ? `Moved ${name} ${how === 'undo' ? 'back ' : ''}under ${bossName(boss)}.` : `Moved ${name}.`;
  showMoved({ key, text, undo });
}

// While Settings is open it keeps its own copy of the settings. The move goes into that copy too,
// so saving Settings later does not put the old boss back.
function keepPlacement(key, reportsTo) {
  const st = S.set;
  if (!st || !st.info) return;
  for (const s of [st.info.settings, st.draft]) {
    if (!s || typeof s !== 'object') continue;
    const people = s.people && typeof s.people === 'object' ? s.people : {};
    const entry = { ...(own(people, key) || {}) };
    if (reportsTo) entry.reportsTo = reportsTo;
    else delete entry.reportsTo;
    putEntry(people, key, Object.keys(entry).length ? entry : null);
    s.people = people;
  }
}

// A pick in the Reports to menu. One made with the mouse moves the tile at once. The arrow keys
// change a closed menu one step at a time, so a pick made with keys waits a moment, or for Enter.
function pickBoss(value, wait) {
  const d = S.drawer;
  if (!d) return;
  if (d.pick) clearTimeout(d.pick.timer);
  d.pick = { key: d.key, value, timer: wait ? setTimeout(sendPick, wait) : 0 };
  if (!wait) sendPick();
}

function sendPick() {
  const d = S.drawer;
  const pick = d && d.pick;
  if (!pick) return;
  clearTimeout(pick.timer);
  d.pick = null;
  moveNode(pick.key, pick.value || null, 'menu');
}

// Before a drawer closes or shows another tile: a pick still waiting is sent, and a message with
// Undo moves to the page, so it can still be used.
function leaveDrawer() {
  sendPick();
  const m = moved.msg;
  if (!m || m.where !== 'drawer') return;
  if (m.undo) m.where = 'toast';
  else clearMoved();
}

// Shows what a move or a dismissal did: in the side panel when it was made there (under the menu,
// or under the tabs for a dismissal), else in a small notice at the bottom of the page that the
// polite live region reads out. It goes after a few seconds, but not while the pointer is on it or
// its Undo button has focus. An error in the side panel stays until the next change.
function showMoved(msg) {
  clearTimeout(moved.timer);
  const d = S.drawer;
  const box = $(msg.spot === 'note' ? '#d-note' : '#drawer-place');
  const here = !!d && d.key === msg.key && !!box && !box.hidden;
  moved.msg = { ...msg, where: here ? 'drawer' : 'toast' };
  paintMoved();
  if (!here) say(msg.text);
  if (!(here && msg.bad)) moved.timer = setTimeout(fadeMoved, MOVED_MS);
}

function fadeMoved() {
  const active = document.activeElement;
  if ((active && active.matches('[data-undo]')) || $('#toast').matches(':hover') || $('.dplace-done:hover')) {
    moved.timer = setTimeout(fadeMoved, 2000);
    return;
  }
  clearMoved();
}

function clearMoved() {
  clearTimeout(moved.timer);
  moved.msg = null;
  paintMoved();
}

function paintMoved() {
  const m = moved.msg;
  const d = S.drawer;
  const inDrawer = !!m && m.where === 'drawer' && !!d && d.key === m.key;
  const inToast = !!m && m.where === 'toast';
  const atNote = inDrawer && m.spot === 'note';
  const atPlace = inDrawer && !atNote;
  const select = $('#d-boss');
  const text = $('#d-boss-msg');
  if (select && text) {
    setText(text, atPlace ? m.text : '');
    text.classList.toggle('field-error', atPlace && !!m.bad);
    if (atPlace && m.bad) select.setAttribute('aria-invalid', 'true');
    else select.removeAttribute('aria-invalid');
    hideUndo($('#d-boss-undo'), !(atPlace && m.undo), select);
  }
  const note = $('#d-note-msg');
  if (note) {
    setText(note, atNote ? m.text : '');
    note.classList.toggle('field-error', atNote && !!m.bad);
    hideUndo($('#d-note-undo'), !(atNote && m.undo), $('#drawer [role="tab"][aria-selected="true"]'));
  }
  const toast = $('#toast');
  hideUndo($('[data-undo]', toast), !(inToast && m.undo), S.view === 'map' ? $('#map-canvas') : $('#main'));
  toast.hidden = !inToast;
  toast.classList.toggle('bad', inToast && !!m.bad);
  setText($('.toast-text', toast), inToast ? m.text : '');
}

// Hides an Undo button. If it had focus, focus goes to `next` instead of being lost.
function hideUndo(btn, hide, next) {
  if (!btn) return;
  if (hide && document.activeElement === btn && next) next.focus({ preventScroll: true });
  btn.hidden = hide;
}

function undoMove() {
  const m = moved.msg;
  if (!m || !m.undo) return;
  const undo = m.undo;
  m.undo = null; // one Undo for each change
  paintMoved();
  undo();
}

// The polite live region that says the counts also says what a move or a dismissal did. It is
// emptied first, so the same words twice in a row are still read out.
function say(text) {
  const live = $('#live-summary');
  live.textContent = '';
  setTimeout(() => {
    live.textContent = text;
  }, 60);
}

// The notice for moves made on the map and for dismissed notices. index.html has no place for it,
// so it is made here.
(function makeToast() {
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.id = 'toast';
  toast.hidden = true;
  toast.innerHTML = '<span class="toast-text" id="toast-text"></span><button type="button" class="btn" data-undo aria-describedby="toast-text" hidden>Undo</button>';
  document.body.append(toast);
})();

const drawerBox = $('#drawer');
drawerBox.addEventListener('keydown', (ev) => {
  if (ev.target.id !== 'd-boss') return;
  // Enter sends a pick made with the arrow keys at once.
  if (ev.key === 'Enter') {
    keyedAt = 0;
    sendPick();
  } else {
    keyedAt = Date.now();
  }
});
drawerBox.addEventListener('change', (ev) => {
  if (ev.target.id !== 'd-boss') return;
  releasePress(0);
  pickBoss(ev.target.value, Date.now() - keyedAt < 300 ? PICK_WAIT_MS : 0);
});
drawerBox.addEventListener('focusout', (ev) => {
  if (ev.target.id === 'd-boss') sendPick();
});

// ---------------------------------------------------------------------------------------------
// dismissing a notice, and Undo
// ---------------------------------------------------------------------------------------------

const dismissing = new Set(); // notice ids on their way to Pleni

// Hides a notice (or a session's "Needs you") until something new happens. When the button goes
// away with it, focus moves to the next notice's ×, else to the view's heading; in the side panel
// it moves to Undo.
async function dismissNotice(btn) {
  const id = btn.dataset.dismiss;
  if (!id || dismissing.has(id)) return;
  const key = id.slice(0, id.lastIndexOf('|'));
  const at = Number(btn.dataset.at);
  const box = btn.closest('.attention');
  const all = box ? $$('[data-dismiss]', box) : [];
  const place = all.indexOf(btn);
  const after = all.slice(place + 1).map((b) => b.dataset.dismiss);
  dismissing.add(id);
  try {
    await postJson('/api/dismiss', { id, at: Number.isFinite(at) ? at : 0 });
  } catch (err) {
    dismissing.delete(id);
    showMoved({ key, spot: 'note', bad: true, text: `Not dismissed. ${plainError(err)}` });
    return;
  }
  await pollNow().catch(() => {});
  dismissing.delete(id);
  showMoved({ key, spot: 'note', text: DISMISSED_TEXT, undo: () => undismiss(key, id) });
  const active = document.activeElement;
  if (active && active !== document.body) return;
  let next = null;
  if (box) {
    const shown = $$('[data-dismiss]', box);
    next = after.map((x) => shown.find((b) => b.dataset.dismiss === x)).find(Boolean) || shown[Math.max(0, place)] || $('h1', box.closest('.view'));
  } else if (S.drawer) {
    next = [$('#d-note-undo'), $('#dpanel-now'), $('#drawer [data-close]')].find((el) => el && !el.hidden);
  }
  if (next) next.focus();
}

// Undo for a dismissal: the notice shows again.
async function undismiss(key, id) {
  try {
    await postJson('/api/dismiss', { id, at: null });
  } catch (err) {
    showMoved({ key, spot: 'note', bad: true, text: `Not undone. ${plainError(err)}` });
    return;
  }
  await pollNow().catch(() => {});
  showMoved({ key, spot: 'note', text: 'Undone. It shows again.' });
}

// ---------------------------------------------------------------------------------------------
// Open in PowerShell
// ---------------------------------------------------------------------------------------------

const opening = new Set(); // sessions whose window Pleni is opening right now

// Asks Pleni to open the session in a new PowerShell window. The answer shows under the tabs of the
// side panel (or in the notice at the bottom when the panel was closed).
async function openInWindow(btn) {
  const key = btn.dataset.open;
  const here = S.drawer ? S.drawer.key : key;
  const title = btn.dataset.title || keyName(key);
  if (!key || opening.has(key)) return;
  opening.add(key);
  showMoved({ key: here, spot: 'note', text: 'Opening a PowerShell window…' });
  try {
    await postJson('/api/open', { key });
    showMoved({ key: here, spot: 'note', text: `A PowerShell window is opening for "${title}". Look for it on your taskbar.` });
  } catch (err) {
    showMoved({ key: here, spot: 'note', bad: true, text: `Not opened. ${plainError(err)}` });
  } finally {
    opening.delete(key);
  }
}

// ---------------------------------------------------------------------------------------------
// settings
// ---------------------------------------------------------------------------------------------

async function loadSettings(force) {
  if (!S.set) S.set = { info: null, draft: null, msg: null, search: '', error: null };
  const st = S.set;
  if (st.info && !force) {
    renderSettingsForm();
    return;
  }
  if (!st.info) setHtml($('#settings'), '<p class="empty">Loading settings…</p>');
  try {
    const info = await getJson('/api/settings');
    if (!info || typeof info.settings !== 'object') throw new Error('Pleni sent settings this page cannot read.');
    st.info = info;
    st.draft = clone(info.settings);
    st.error = null;
    S.roots = info.roots || S.roots;
    S.recentHours = info.settings.window ? info.settings.window.recentHours : S.recentHours;
  } catch (err) {
    st.error = plainError(err);
  }
  if (S.view === 'settings') renderSettingsForm();
}

function getPath(obj, path, fallback) {
  let v = obj;
  for (const part of path.split('.')) v = v && typeof v === 'object' ? own(v, part) : undefined;
  return v === undefined ? fallback : v;
}

function setPath(obj, path, value) {
  const parts = path.split('.');
  let o = obj;
  for (const part of parts.slice(0, -1)) {
    if (!o[part] || typeof o[part] !== 'object') o[part] = {};
    o = o[part];
  }
  const lastKey = parts[parts.length - 1];
  if (value === undefined) delete o[lastKey];
  else o[lastKey] = value;
}

// Sets a map entry without letting a key such as "__proto__" touch the prototype.
function putEntry(map, key, value) {
  if (value) Object.defineProperty(map, key, { value, enumerable: true, writable: true, configurable: true });
  else delete map[key];
}

function same(a, b) {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return a === b || (a == null && b == null);
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) if (!same(a[k], b[k])) return false;
  return true;
}

function desc(id, help) {
  return help ? ` aria-describedby="${id}-help"` : '';
}

function helpHtml(id, help) {
  return help ? `<p class="help" id="${id}-help">${esc(help)}</p>` : '';
}

function textRow(id, label, path, { help, max, placeholder, kind = 'text' } = {}) {
  const d = S.set.draft;
  let value = getPath(d, path, '');
  if (Array.isArray(value)) value = value.join(', ');
  return (
    `<div class="srow"><label for="${id}">${esc(label)}</label><div><input class="field" id="${id}" type="text" data-path="${path}" data-kind="${kind}"` +
    ` value="${esc(value ?? '')}"${max ? ` maxlength="${max}"` : ''}${placeholder ? ` placeholder="${esc(placeholder)}"` : ''} autocomplete="off" spellcheck="false"${desc(id, help)}></div>${helpHtml(id, help)}</div>`
  );
}

function numberRow(id, label, path, min, max, help) {
  const value = getPath(S.set.draft, path, '');
  return (
    `<div class="srow"><label for="${id}">${esc(label)}</label><div><input class="field num" id="${id}" type="number" inputmode="numeric" step="1"` +
    ` min="${min}" max="${max}" data-path="${path}" data-kind="int" value="${esc(value)}"${desc(id, help)}></div>${helpHtml(id, help)}</div>`
  );
}

function selectRow(id, label, path, options, help) {
  const value = getPath(S.set.draft, path, '');
  const opts = options.map(([v, text]) => `<option value="${esc(v)}"${v === value ? ' selected' : ''}>${esc(text)}</option>`).join('');
  return `<div class="srow"><label for="${id}">${esc(label)}</label><div><select class="field" id="${id}" data-path="${path}" data-kind="text"${desc(id, help)}>${opts}</select></div>${helpHtml(id, help)}</div>`;
}

function checkRow(id, label, path, text, help) {
  const on = getPath(S.set.draft, path, false) === true;
  return (
    `<div class="srow"><span class="lbl" id="${id}-lbl">${esc(label)}</span><div class="checks"><label><input type="checkbox" id="${id}" data-path="${path}" data-kind="bool"${on ? ' checked' : ''}${desc(id, help)}>` +
    `${esc(text)}</label></div>${helpHtml(id, help)}</div>`
  );
}

// Session names offered while typing in the mailbox and chain-of-command fields. Long names are
// cut to the first MAX_NAME letters, which still match because Pleni looks for the text inside a name.
function sessionNamesHtml() {
  const names = new Map();
  for (const n of S.set.info.nodes || []) {
    if (!n || !TOOLS.includes(n.platform)) continue;
    const title = Array.from(String(n.title || '').trim()).slice(0, MAX_NAME).join('').trim();
    if (title && !names.has(title)) names.set(title, PLATFORM_WORDS[n.platform]);
  }
  const opts = [...names].sort((a, b) => a[0].localeCompare(b[0])).map(([title, platform]) => `<option value="${esc(title)}">${esc(platform)}</option>`);
  return `<datalist id="s-session-names">${opts.join('')}</datalist>`;
}

function sessionNameRow(id, label, path, help) {
  const value = getPath(S.set.draft, path, null);
  return (
    `<div class="srow"><label for="${id}">${esc(label)}</label><div><input class="field" id="${id}" type="text" data-path="${path}" data-kind="key" list="s-session-names"` +
    ` value="${esc(value || '')}" placeholder="Part of the session's name" autocomplete="off" spellcheck="false"${desc(id, help)}></div>${helpHtml(id, help)}</div>`
  );
}

function sourceRow(name, label, text, help) {
  const id = `s-src-${name}`;
  const roots = S.set.info.roots || {};
  // A Pleni server older than this page may not send a source yet; it shows its default then.
  const on = getPath(S.set.draft, `sources.${name}.enabled`, getPath(DEFAULTS, `sources.${name}.enabled`, false)) === true;
  const root = getPath(S.set.draft, `sources.${name}.root`, null);
  const auto = roots[name] ? `Automatic: ${roots[name]}` : 'Automatic';
  return (
    `<div class="srow"><span class="lbl" id="${id}-lbl">${esc(label)}</span><div class="src">` +
    `<div class="checks"><label><input type="checkbox" id="${id}-on" data-path="sources.${name}.enabled" data-kind="bool"${on ? ' checked' : ''}>${esc(text)}</label></div>` +
    `<label class="sr-only" for="${id}-root">${esc(label)} folder</label>` +
    `<input class="field" id="${id}-root" type="text" data-path="sources.${name}.root" data-kind="root" value="${esc(root || '')}" placeholder="${esc(auto)}" autocomplete="off" spellcheck="false"${desc(id, help)}>` +
    `</div>${helpHtml(id, help)}</div>`
  );
}

function mailboxRows() {
  const d = S.set.draft;
  const id = 's-src-mailbox';
  const on = getPath(d, 'sources.mailbox.enabled', false) === true;
  const root = getPath(d, 'sources.mailbox.root', null);
  const help = 'A folder where a planner agent hands out tasks and a coordinator agent reports back in Markdown files. Pleni only reads it.';
  return (
    `<div class="srow"><span class="lbl" id="${id}-lbl">Mailbox</span><div class="src">` +
    `<div class="checks"><label><input type="checkbox" id="${id}-on" data-path="sources.mailbox.enabled" data-kind="bool"${on ? ' checked' : ''}>Read a coordination mailbox</label></div>` +
    `<label class="sr-only" for="${id}-root">Mailbox folder</label>` +
    `<input class="field" id="${id}-root" type="text" data-path="sources.mailbox.root" data-kind="root" value="${esc(root || '')}" placeholder="The full path of the mailbox folder" autocomplete="off" spellcheck="false"${desc(id, help)}>` +
    `</div>${helpHtml(id, help)}</div>` +
    sessionNameRow('s-planner', 'Planner', 'sources.mailbox.planner', 'The session that hands out the tasks. Type part of its name, or pick one from the list. Pleni uses the newest session whose name has that text.') +
    sessionNameRow('s-coordinator', 'Coordinator', 'sources.mailbox.coordinator', 'The session that reports back. Type part of its name. If you leave it empty, Pleni uses the one the mailbox names, if any.')
  );
}

function chainRules(create) {
  const d = S.set.draft;
  if (!Array.isArray(d.chain)) {
    if (!create) return [];
    d.chain = [];
  }
  return d.chain;
}

function chainHtml() {
  const rules = chainRules(false);
  if (!rules.length) return '<p class="note">No rules yet. Pleni works out who reports to whom by itself.</p>';
  const items = rules.map((rule, i) => {
    const r = rule && typeof rule === 'object' ? rule : {};
    const id = `s-chain-${i}`;
    const n = `<span class="sr-only"> (rule ${i + 1})</span>`;
    const to = !r.reportsTo || r.reportsTo === 'you' ? '' : r.reportsTo;
    const rank = RANK_OPTIONS.map(([v, text]) => `<option value="${v}"${(r.role || '') === v ? ' selected' : ''}>${esc(text)}</option>`).join('');
    return (
      '<li class="rule">' +
      `<div class="rf"><label for="${id}-match">When the name contains${n}</label><input class="field" id="${id}-match" type="text" data-chain="${i}" data-field="match" value="${esc(r.match || '')}" maxlength="${MAX_NAME}" list="s-session-names" autocomplete="off" spellcheck="false"></div>` +
      `<div class="rf"><label for="${id}-to">it reports to${n}</label><input class="field" id="${id}-to" type="text" data-chain="${i}" data-field="reportsTo" value="${esc(to)}" maxlength="${MAX_NAME}" placeholder="me" list="s-session-names" autocomplete="off" spellcheck="false"></div>` +
      `<div class="rf"><label for="${id}-role">Rank${n}</label><select class="field" id="${id}-role" data-chain="${i}" data-field="role">${rank}</select></div>` +
      `<button type="button" class="btn" id="${id}-remove" data-chain-remove="${i}" aria-label="Remove rule ${i + 1}">Remove</button>` +
      '</li>'
    );
  });
  // The heading row is for the eye only; each field has its own label, which shows on small screens.
  return (
    '<div class="rule rule-head" aria-hidden="true"><span>When the name contains</span><span>it reports to</span><span>Rank</span><span></span></div>' +
    `<ol class="rules" role="list">${items.join('')}</ol>`
  );
}

function paintChain() {
  const box = $('#chain-rows');
  if (!box) return;
  painted.delete(box);
  setHtml(box, chainHtml());
}

function addChainRule() {
  const st = S.set;
  if (!st || !st.draft) return;
  const rules = chainRules(true);
  if (rules.length >= MAX_CHAIN) {
    st.msg = { kind: 'err', text: `You can have up to ${MAX_CHAIN} rules. Remove one to add another.` };
    updateSettingsMsg();
    return;
  }
  rules.push({ match: '', reportsTo: 'you', role: null });
  st.msg = null;
  paintChain();
  updateSettingsMsg();
  const first = $(`#s-chain-${rules.length - 1}-match`);
  if (first) first.focus();
}

function removeChainRule(i) {
  const st = S.set;
  if (!st || !st.draft) return;
  const rules = chainRules(false);
  if (!Number.isInteger(i) || i < 0 || i >= rules.length) return;
  rules.splice(i, 1);
  st.msg = null;
  paintChain();
  updateSettingsMsg();
  const next = $(`#s-chain-${i}-match`) || $('#s-chain-add');
  if (next) next.focus();
}

// One field of one rule. An empty "it reports to", or "me", means the person at the top of the map.
function editRule(i, el) {
  const rule = chainRules(false)[i];
  if (!rule || typeof rule !== 'object') return;
  const v = el.value.trim();
  if (el.dataset.field === 'match') rule.match = v;
  else if (el.dataset.field === 'reportsTo') rule.reportsTo = !v || /^(me|you)$/i.test(v) ? 'you' : v;
  else if (el.dataset.field === 'role') rule.role = el.value || null;
}

function peopleHtml() {
  const st = S.set;
  const people = st.draft.people && typeof st.draft.people === 'object' ? st.draft.people : {};
  const nodes = (st.info.nodes || []).filter((n) => n && typeof n.key === 'string');
  const byKey = new Map(nodes.map((n) => [n.key, n]));
  const q = st.search.trim().toLowerCase();
  const keys = Object.keys(people);
  if (q) {
    for (const n of nodes) {
      if (keys.length >= 60) break;
      if (!Object.hasOwn(people, n.key) && (String(n.title || '').toLowerCase().includes(q) || n.key.toLowerCase().includes(q))) keys.push(n.key);
    }
  }
  if (!keys.length) {
    return `<p class="note">${q ? 'No session matches that search.' : 'No names or roles are set. Search above to give a session a name or a role.'}</p>`;
  }
  const rows = keys.map((key) => {
    const entry = own(people, key) || {};
    const kind = key === 'you' ? 'person' : key.startsWith('project:') ? 'project' : 'session';
    const n = byKey.get(key) || { key, title: '', platform: key.split(':')[0], kind };
    const title = n.title || keyName(key);
    const role = ROLE_OPTIONS.map(([v, text]) => `<option value="${v}"${(entry.role || '') === v ? ' selected' : ''}>${esc(text)}</option>`).join('');
    return (
      `<tr><td><div class="who">${markHtml(n, 'small')}<span>${esc(title)}<span class="key">${esc(key)}</span></span></div></td>` +
      `<td><input class="field" type="text" data-person="${esc(key)}" data-field="label" value="${esc(entry.label || '')}" maxlength="80" placeholder="${esc(title)}" aria-label="${esc(`Name for ${title}`)}" autocomplete="off"></td>` +
      `<td><select class="field" data-person="${esc(key)}" data-field="role" aria-label="${esc(`Role for ${title}`)}">${role}</select></td></tr>`
    );
  });
  return `<table class="edit"><thead><tr><th scope="col">Session</th><th scope="col">Show it as</th><th scope="col">Role</th></tr></thead><tbody>${rows.join('')}</tbody></table>`;
}

function projectsHtml() {
  const st = S.set;
  const projects = st.draft.projects && typeof st.draft.projects === 'object' ? st.draft.projects : {};
  const names = new Set(Object.keys(projects));
  for (const n of st.info.nodes || []) if (n && typeof n.key === 'string' && n.key.startsWith('project:')) names.add(n.key.slice(8));
  if (S.index) for (const n of S.index.nodes) if (n.project) names.add(n.project);
  const list = [...names].filter(Boolean).sort((a, b) => a.localeCompare(b)).slice(0, 200);
  if (!list.length) return '<p class="note">No projects yet. They appear here once Pleni finds sessions.</p>';
  const rows = list.map((name) => {
    const entry = own(projects, name) || {};
    return (
      `<tr><td>${esc(name)}</td>` +
      `<td><input class="field" type="text" data-project="${esc(name)}" data-field="label" value="${esc(entry.label || '')}" maxlength="80" placeholder="${esc(name)}" aria-label="${esc(`Name for project ${name}`)}" autocomplete="off"></td>` +
      `<td><input type="checkbox" data-project="${esc(name)}" data-field="hidden"${entry.hidden ? ' checked' : ''} aria-label="${esc(`Hide project ${name}`)}"></td></tr>`
    );
  });
  return `<table class="edit"><thead><tr><th scope="col">Project folder</th><th scope="col">Show it as</th><th scope="col">Hide</th></tr></thead><tbody>${rows.join('')}</tbody></table>`;
}

// ---- ranks by model ----

// Every model the sessions on the page use, by its exact name in small letters, with how many
// sessions use it.
function pageModels() {
  const byId = new Map();
  for (const n of S.index ? S.index.nodes : []) {
    if (!isSession(n) || typeof n.model !== 'string' || !n.model) continue;
    const id = n.model.toLowerCase();
    const m = byId.get(id) || { id, label: n.modelLabel || prettyModel(n.model) || id, count: 0 };
    m.count++;
    byId.set(id, m);
  }
  return [...byId.values()].sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
}

// A model name Pleni can keep in a list of words: short enough, with no spaces.
const keepable = (id) => id.length <= MAX_TIER_WORD && !/[\s\p{Cc}]/u.test(id);

function tierList(tier) {
  const list = getPath(S.set.draft, `modelTiers.${tier}`, []);
  return Array.isArray(list) ? list.filter((w) => typeof w === 'string').map((w) => w.toLowerCase()) : [];
}

// The rank picked for one model: 'senior', 'junior', or '' (Automatic).
function modelPick(id) {
  if (tierList('senior').includes(id)) return 'senior';
  if (tierList('junior').includes(id)) return 'junior';
  return '';
}

// What Automatic gives a model, the way modelTier in src/model.js works it out: the first senior
// word that is a whole word of its name, else the first junior word. Its own name is left out.
function autoTier(id) {
  for (const tier of ['senior', 'junior']) {
    const word = tierList(tier).find((w) => w !== id && hasWord(id, w));
    if (word) return { tier, word };
  }
  return { tier: null, word: null };
}

// The same whole-word test as hasWord in src/model.js. Keep the two in step.
function hasWord(name, word) {
  if (!word) return false;
  const edge = (ch) => ch === undefined || !/[a-z0-9]/.test(ch);
  for (let i = name.indexOf(word); i !== -1; i = name.indexOf(word, i + 1)) {
    if (edge(name[i - 1]) && edge(name[i + word.length])) return true;
  }
  return false;
}

function modelsHtml() {
  const models = pageModels();
  if (!models.length) return '<p class="note">No models yet. They show up here once Pleni finds sessions.</p>';
  const labels = new Map();
  for (const m of models) labels.set(m.label, (labels.get(m.label) || 0) + 1);
  const rows = models.map((m, i) => {
    const hint = `s-model-${i}-auto`;
    const auto = autoTier(m.id);
    const autoText = `Automatic: ${auto.tier === 'senior' ? 'Specialist' : 'Private'} (${auto.word ? `matches ${auto.word}` : 'no word matches'})`;
    // Two models with the same label are told apart by their names.
    const name = labels.get(m.label) > 1 ? `${m.label} (${m.id})` : m.label;
    const pick = modelPick(m.id);
    const opts = TIER_OPTIONS.map(([v, text]) => `<option value="${v}"${v === pick ? ' selected' : ''}>${esc(text)}</option>`).join('');
    const control = keepable(m.id)
      ? `<select class="field" data-model="${esc(m.id)}" aria-label="${esc(`Rank for ${name}`)}" aria-describedby="${hint}">${opts}</select>`
      : '<span class="quiet">This name is too long to pick here. Use the words below.</span>';
    return (
      `<tr><td><span class="mname">${esc(m.label)}</span>${m.label === m.id ? '' : `<span class="key">${esc(m.id)}</span>`}</td>` +
      `<td class="n">${m.count}</td><td>${control}<span class="auto" id="${hint}">${esc(autoText)}</span></td></tr>`
    );
  });
  return `<table class="edit models"><thead><tr><th scope="col">Model</th><th scope="col">Sessions</th><th scope="col">Rank</th></tr></thead><tbody>${rows.join('')}</tbody></table>`;
}

// Kept current as sessions come and go, but not while one of its menus is in use: that would close
// the open list. It catches up once focus moves on.
function paintModels() {
  const box = $('#model-rows');
  if (!box || !S.set || !S.set.draft || box.contains(document.activeElement)) return;
  setHtml(box, modelsHtml());
}

// A rank picked for one model: its exact name goes into that list and out of the other, and
// Automatic takes it out of both. The word fields show the same lists, so they change too.
function pickModelTier(id, tier) {
  const d = S.set.draft;
  if (!d.modelTiers || typeof d.modelTiers !== 'object') d.modelTiers = {};
  for (const name of ['senior', 'junior']) {
    const list = (Array.isArray(d.modelTiers[name]) ? d.modelTiers[name] : []).filter((w) => String(w).toLowerCase() !== id);
    if (name === tier) list.push(id);
    d.modelTiers[name] = list;
    const field = $(`#s-${name}`);
    if (field) {
      clearFieldError(field);
      field.value = list.join(', ');
    }
  }
}

function settingsMsgHtml() {
  const st = S.set;
  if (st.msg) return `<span class="saved ${st.msg.kind}">${esc(st.msg.text)}</span>`;
  if (st.info && !same(st.draft, st.info.settings)) return '<span class="saved dirty">You have changes that are not saved yet.</span>';
  return '';
}

function renderSettingsForm() {
  const st = S.set;
  if (!st) return;
  if (st.error && !st.info) {
    setHtml($('#settings'), `<p class="empty">Could not load the settings. ${esc(st.error)}</p><button type="button" class="btn" id="s-retry">Try again</button>`);
    return;
  }
  if (!st.info || !st.draft) return;
  const theme = storedTheme() || 'system';
  const html = `<form class="settings" id="settings-form" novalidate>
    ${st.info.file ? `<p class="lead">Saved on this computer in <code>${esc(st.info.file)}</code>.</p>` : ''}
    <section class="panel" aria-labelledby="s-h-you"><h2 id="s-h-you">You and the map</h2>
      ${textRow('s-name', 'Your name', 'displayName', { help: 'Shown on the top tile of the map.', max: 40 })}
      ${selectRow('s-titles', 'Rank words', 'titles', [['plain', 'Plain: Lead and Agent (plus Superintendent and Coordinator for those roles)'], ['military', 'Military: General, Colonel, Sergeant, Specialist, Private'], ['company', 'Company: Owner, Vice President, Manager, Supervisor, Worker']], 'The words used for ranks on the tiles.')}
      ${selectRow('s-group', 'Group sessions', 'groupBy', [['none', 'Not at all'], ['project', 'By project folder']], 'By project folder puts a folder tile between you and its sessions. Without it, each tile names its folder.')}
      ${checkRow('s-reviewers', 'Reviewers', 'showReviewers', 'Show the automatic reviewers that Codex starts', '')}
      <div class="srow"><label for="s-theme">Theme</label><div><select class="field" id="s-theme" data-local="theme" aria-describedby="s-theme-help">
        <option value="system"${theme === 'system' ? ' selected' : ''}>Match this computer</option>
        <option value="dark"${theme === 'dark' ? ' selected' : ''}>Dark</option>
        <option value="light"${theme === 'light' ? ' selected' : ''}>Light</option>
      </select></div><p class="help" id="s-theme-help">Kept in this browser only. It changes right away.</p></div>
    </section>
    <section class="panel" aria-labelledby="s-h-show"><h2 id="s-h-show">What the page shows</h2>
      <div class="srow" role="radiogroup" aria-labelledby="s-content-lbl" aria-describedby="s-content-help"><span class="lbl" id="s-content-lbl">Session text</span><div class="checks">
        <label><input type="radio" name="s-content" id="s-content-snippets" data-path="content" data-kind="text" value="snippets"${getPath(st.draft, 'content', 'snippets') === 'snippets' ? ' checked' : ''}>Short snippets of what sessions say and do</label>
        <label><input type="radio" name="s-content" id="s-content-none" data-path="content" data-kind="text" value="none"${getPath(st.draft, 'content', '') === 'none' ? ' checked' : ''}>Only tool names and states</label>
      </div><p class="help" id="s-content-help">Snippets stay on this computer either way.</p></div>
      ${numberRow('s-recent', 'Show sessions from the last', 'window.recentHours', 1, 720, 'Hours. Older sessions are left off the page.')}
      ${numberRow('s-active', 'Finished, for', 'window.activeMinutes', 1, 240, 'Minutes. A session that finished its turn this recently shows "Finished". Only a real question, plan, block or permission request shows "Needs you".')}
      ${numberRow('s-stale', 'Call a turn stuck after', 'window.staleMinutes', 5, 1440, 'Minutes. A turn whose file has not moved for this long counts as idle.')}
    </section>
    <section class="panel" aria-labelledby="s-h-tiers"><h2 id="s-h-tiers">Ranks by model</h2>
      <p class="note">Pick the rank for each model. In the Military titles, workers on a senior model are Specialists and the rest are Privates. Leaders keep their own ranks.</p>
      <div id="model-rows">${modelsHtml()}</div>
      <h3>Words that set the rank</h3>
      <p class="note">Most people can skip this. A model on Automatic gets its rank from these words. A rank you pick above always wins over them.</p>
      ${textRow('s-senior', 'Senior words', 'modelTiers.senior', { kind: 'words', help: 'A model whose name has any of these words is senior. Separate the words with commas.' })}
      ${textRow('s-junior', 'Junior words', 'modelTiers.junior', { kind: 'words', help: 'A model whose name has any of these words is junior. Senior words are checked first.' })}
    </section>
    <section class="panel" aria-labelledby="s-h-where"><h2 id="s-h-where">Where Pleni looks</h2>
      ${sourceRow('claude', 'Claude Code', 'Read Claude Code sessions', 'Leave the folder empty to use CLAUDE_CONFIG_DIR, or the .claude folder in your home folder.')}
      ${sourceRow('claudeDesktop', 'Claude desktop app', 'Read session names from the Claude desktop app', 'Gives desktop sessions the names you see in the app.')}
      ${sourceRow('codex', 'Codex', 'Read Codex threads', 'Leave the folder empty to use CODEX_HOME, or the .codex folder in your home folder.')}
      ${sourceRow('grok', 'Grok', 'Read Grok sessions', "Pleni reads Grok's session logs in this folder.")}
      ${sourceRow('kimi', 'Kimi Code', 'Read Kimi Code sessions', "Pleni reads Kimi Code's session logs in this folder.")}
      ${mailboxRows()}
    </section>
    <section class="panel" aria-labelledby="s-h-people"><h2 id="s-h-people">Names and roles</h2>
      <div class="srow"><label for="s-people-search">Find a session</label><div><input class="field" id="s-people-search" type="search" value="${esc(st.search)}" placeholder="Search by name" autocomplete="off" aria-describedby="s-people-search-help"></div>
      <p class="help" id="s-people-search-help">Give a session a shorter name, set its role, or hide it.</p></div>
      <div id="people-rows">${peopleHtml()}</div>
    </section>
    <section class="panel" aria-labelledby="s-h-chain"><h2 id="s-h-chain">Chain of command</h2>
      <p class="note">Say who reports to whom. Pleni matches session names, so a rule keeps working when a session is replaced by a new one.</p>
      <p class="note">Pleni checks the rules from the top down and uses the first one that fits. A session goes under the newest active session whose name has the "it reports to" text. Leave that empty, or type me, to put it right under you. Pick Automatic under Rank to let Pleni choose the rank.</p>
      <div id="chain-rows">${chainHtml()}</div>
      <div class="chain-add"><button type="button" class="btn" id="s-chain-add">Add a rule</button></div>
    </section>
    <section class="panel" aria-labelledby="s-h-projects"><h2 id="s-h-projects">Projects</h2>
      <div id="project-rows">${projectsHtml()}</div>
    </section>
    <section class="panel" aria-labelledby="s-h-open"><h2 id="s-h-open">Open sessions</h2>
      <p class="note">Pleni only looks, unless you turn this on. Then each Claude Code and Codex session's side panel gets an Open in PowerShell button. It opens a new PowerShell window in the session's folder and runs <code>claude --resume</code> or <code>codex resume</code> for it, so you can see the conversation and type to it. Pleni never types into a session itself.</p>
      ${checkRow('s-open', 'Open in PowerShell', 'actions.openTerminal', 'Show the Open in PowerShell button', 'It works only on Windows, and only on this computer, not from another device. Pleni will not open a session that is already open in another window.')}
      ${st.info.platform && st.info.platform !== 'win32' ? '<p class="note">This computer does not run Windows, so the button will not show here yet.</p>' : ''}
    </section>
    <section class="panel" aria-labelledby="s-h-remote"><h2 id="s-h-remote">Other devices</h2>
      <p class="note">Pleni only listens on this computer. To open it from another device, put a private proxy such as <code>tailscale serve</code> in front of it, then list the host name and the Tailscale logins that may use it. The other device also needs Pleni's key: open the address Pleni printed when it started, with your Tailscale address in place of the part before <code>/?t=</code>.</p>
      ${textRow('s-hosts', 'Allowed host names', 'remote.hosts', { kind: 'words', placeholder: 'pleni.example.ts.net', help: 'Separate names with commas. Up to 20.' })}
      ${textRow('s-users', 'Allowed Tailscale logins', 'remote.tailscaleUsers', { kind: 'words', placeholder: 'ada@example.com', help: 'Separate logins with commas. Up to 20.' })}
      ${numberRow('s-port', 'Port', 'port', 1024, 65535, 'Pleni uses a new port the next time it starts.')}
    </section>
    <div class="btnrow">
      <button type="submit" class="btn primary" id="s-save">Save settings</button>
      <button type="button" class="btn" id="s-undo">Undo changes</button>
      <button type="button" class="btn" id="s-defaults">Restore defaults</button>
      <span id="s-msg" role="status">${settingsMsgHtml()}</span>
    </div>
    ${sessionNamesHtml()}
  </form>`;
  // Always repaint: typing changes the fields without changing the last painted markup, so after
  // "Undo changes" the markup can match while the fields still show the undone edits.
  const box = $('#settings');
  painted.delete(box);
  setHtml(box, html);
}

function updateSettingsMsg() {
  const el = $('#s-msg');
  if (el) setHtml(el, settingsMsgHtml());
}

function readValue(el) {
  const v = el.value;
  switch (el.dataset.kind) {
    case 'bool':
      return el.checked;
    case 'int':
      return v.trim() === '' ? undefined : Number(v);
    case 'words':
      return [...new Set(v.split(/[\s,]+/).map((w) => w.trim().toLowerCase()).filter(Boolean))];
    case 'root':
    case 'key':
      return v.trim() || null;
    default:
      return v;
  }
}

function onSettingsInput(el) {
  const st = S.set;
  if (!st || !st.draft) return;
  if (el.id === 's-people-search') {
    st.search = el.value;
    setHtml($('#people-rows'), peopleHtml());
    return;
  }
  if (el.dataset.local === 'theme') {
    setTheme(el.value);
    return;
  }
  if (el.dataset.path) {
    if (el.type === 'radio' && !el.checked) return;
    clearFieldError(el);
    setPath(st.draft, el.dataset.path, readValue(el));
    if (el.dataset.path.startsWith('modelTiers.')) paintModels();
  } else if (el.dataset.model) {
    pickModelTier(el.dataset.model, el.value);
  } else if (el.dataset.person) {
    if (!st.draft.people || typeof st.draft.people !== 'object') st.draft.people = {};
    editEntry(st.draft.people, el.dataset.person, el);
  } else if (el.dataset.project) {
    if (!st.draft.projects || typeof st.draft.projects !== 'object') st.draft.projects = {};
    editEntry(st.draft.projects, el.dataset.project, el);
  } else if (el.dataset.chain) {
    clearFieldError(el);
    editRule(Number(el.dataset.chain), el);
  } else {
    return;
  }
  st.msg = null;
  updateSettingsMsg();
}

// One person or project entry; an entry with nothing left in it is removed.
function editEntry(map, key, el) {
  const entry = { ...(own(map, key) || {}) };
  const field = el.dataset.field;
  if (field === 'label') {
    const label = el.value.trim();
    if (label) entry.label = label;
    else delete entry.label;
  } else if (field === 'role') {
    if (el.value) entry.role = el.value;
    else delete entry.role;
  } else if (field === 'hidden') {
    if (el.checked) entry.hidden = true;
    else delete entry.hidden;
  }
  putEntry(map, key, Object.keys(entry).length ? entry : null);
}

// ---- checking the form before it is saved ----

const HOST_NAME = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*|\[[0-9a-f:.]+\])(?::\d{1,5})?$/i;
const LOGIN = /^[^\s@]+@[^\s@]+$/;
const MAX_REMOTE = 20;
// A full folder path on Windows (C:\ or \\server) or on macOS and Linux (/). The server makes the
// final check for its own system.
const FULL_PATH = /^(?:[A-Za-z]:[\\/]|[\\/])/;
// A session key, as isNodeKey in src/config.js checks it.
const NODE_KEY = /^(claude|codex|grok|kimi):[0-9a-f-]{8,64}(\/[0-9a-z_-]{1,64})?$/;

function listWords(el) {
  return el.value.split(/[\s,]+/).map((w) => w.trim()).filter(Boolean);
}

// Each field that cannot be saved as typed, with what to do about it in plain words.
function settingsProblems(form) {
  const problems = [];
  const add = (el, text) => problems.push({ el, text });
  for (const el of $$('input[data-kind="int"]', form)) {
    const v = el.value.trim();
    const n = Number(v);
    if (!el.checkValidity() || v === '' || !Number.isInteger(n) || n < Number(el.min) || n > Number(el.max)) {
      add(el, `Type a whole number from ${el.min} to ${el.max}.`);
    }
  }
  for (const el of $$('input[data-kind="root"]', form)) {
    const v = el.value.trim();
    if (v && !FULL_PATH.test(v)) add(el, 'Type the full path of a folder, such as /home/ada/project or C:\\Users\\ada\\project. Or leave it empty.');
  }
  // A mailbox field holds part of a session name, or a session key saved by an older Pleni.
  for (const el of $$('input[data-kind="key"]', form)) {
    const v = el.value.trim();
    if (v && !NODE_KEY.test(v) && Array.from(v).length > MAX_NAME) add(el, `Type ${MAX_NAME} letters or fewer, or pick a session from the list.`);
  }
  $$('input[data-chain][data-field="match"]', form).forEach((el, i) => {
    const v = el.value.trim();
    if (!v) add(el, 'Type part of a session name, or remove this rule.');
    else if (Array.from(v).length > MAX_NAME) add(el, `Type ${MAX_NAME} letters or fewer.`);
    else if (i >= MAX_CHAIN) add(el, `Pleni keeps up to ${MAX_CHAIN} rules. Remove this one or one above it.`);
  });
  for (const el of $$('input[data-chain][data-field="reportsTo"]', form)) {
    if (Array.from(el.value.trim()).length > MAX_NAME) add(el, `Type ${MAX_NAME} letters or fewer.`);
  }
  const remote = [
    ['s-hosts', HOST_NAME, 'is not a host name. Use a name such as pleni.example.ts.net.'],
    ['s-users', LOGIN, 'is not a Tailscale login. A login looks like ada@example.com.'],
  ];
  for (const [id, pattern, what] of remote) {
    const el = $(`#${id}`, form);
    if (!el) continue;
    const words = listWords(el);
    const bad = words.find((w) => !pattern.test(w));
    if (bad) add(el, `"${bad.length > 60 ? `${bad.slice(0, 59)}…` : bad}" ${what}`);
    else if (new Set(words.map((w) => w.toLowerCase())).size > MAX_REMOTE) add(el, `List up to ${MAX_REMOTE}. There are ${words.length} now.`);
  }
  // In page order, so focus goes to the first bad field on the page.
  return problems.sort((a, b) => (a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
}

function fieldLabel(el) {
  const label = el.id ? $(`label[for="${el.id}"]`) : null;
  return label ? label.textContent.trim() : '';
}

function showFieldError(el, text) {
  const id = `${el.id}-error`;
  el.setAttribute('aria-invalid', 'true');
  const described = (el.getAttribute('aria-describedby') || '').split(' ').filter((x) => x && x !== id);
  el.setAttribute('aria-describedby', [id, ...described].join(' '));
  const note = document.createElement('p');
  note.className = 'field-error';
  note.id = id;
  note.textContent = text;
  el.insertAdjacentElement('afterend', note);
}

function clearFieldError(el) {
  if (!el || el.getAttribute('aria-invalid') !== 'true') return;
  const id = `${el.id}-error`;
  el.removeAttribute('aria-invalid');
  const rest = (el.getAttribute('aria-describedby') || '').split(' ').filter((x) => x && x !== id);
  if (rest.length) el.setAttribute('aria-describedby', rest.join(' '));
  else el.removeAttribute('aria-describedby');
  const note = document.getElementById(id);
  if (note) note.remove();
}

// Marks every bad field, moves focus to the first one, and says so. Returns true when all is well.
function checkSettingsForm() {
  const form = $('#settings-form');
  if (!form) return true;
  for (const el of $$('[aria-invalid="true"]', form)) clearFieldError(el);
  const problems = settingsProblems(form);
  for (const { el, text } of problems) showFieldError(el, text);
  if (!problems.length) return true;
  S.set.msg = {
    kind: 'err',
    text: problems.length === 1 ? 'Not saved. Fix the field marked in red.' : `Not saved. Fix the ${problems.length} fields marked in red.`,
  };
  updateSettingsMsg();
  problems[0].el.focus();
  return false;
}

// The fields whose saved value is not what was sent, because Pleni had to change it.
function changedOnSave(sent, saved) {
  const show = (v, path) => {
    if (Array.isArray(v)) return v.length ? v.join(', ') : 'empty';
    if (v === null || v === undefined || v === '') return path.endsWith('.root') ? 'automatic' : 'not set';
    return String(v);
  };
  const out = [];
  for (const el of $$('#settings-form [data-path]')) {
    if (el.type === 'radio' || el.type === 'checkbox') continue;
    const path = el.dataset.path;
    const before = getPath(sent, path, null);
    const after = getPath(saved, path, null);
    const sameText = typeof before === 'string' && typeof after === 'string' && before.trim() === after;
    if (!sameText && !same(before, after)) out.push(`${fieldLabel(el) || path} is now ${show(after, path)}`);
  }
  const sentChain = Array.isArray(sent.chain) ? sent.chain : [];
  const savedChain = Array.isArray(saved.chain) ? saved.chain : [];
  if (!same(sentChain, savedChain)) {
    out.push(sentChain.length === savedChain.length ? 'Some chain of command rules were changed' : `Chain of command now has ${plural(savedChain.length, 'rule', 'rules')}`);
  }
  return out;
}

async function saveSettings() {
  const st = S.set;
  if (!st || !st.draft) return;
  if (!checkSettingsForm()) return;
  st.msg = { kind: '', text: 'Saving…' };
  updateSettingsMsg();
  try {
    const sent = clone(st.draft);
    const res = await fetch('/api/settings', {
      method: 'POST',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json', 'X-Pleni': 'settings' },
      body: JSON.stringify(sent),
    });
    const body = await readJson(res);
    if (!res.ok) throw answerError(res, body);
    const saved = body && body.settings && typeof body.settings === 'object' ? body.settings : sent;
    const changed = changedOnSave(sent, saved);
    const portChanged = saved.port !== st.info.settings.port;
    const done = portChanged ? 'Saved. Pleni uses the new port the next time it starts.' : 'Saved. The page uses the new settings now.';
    st.msg = changed.length
      ? { kind: 'dirty', text: `${done} Pleni had to change what you typed: ${changed.join('; ')}.` }
      : { kind: 'ok', text: done };
    S.etag = null;
    S.roots = null;
    S.rootsAsked = false;
    await loadSettings(true);
    poll();
  } catch (err) {
    st.msg = { kind: 'err', text: `Not saved. ${plainError(err)}` };
    updateSettingsMsg();
  }
}

const settingsBox = $('#settings');
settingsBox.addEventListener('input', (ev) => onSettingsInput(ev.target));
settingsBox.addEventListener('change', (ev) => onSettingsInput(ev.target));
settingsBox.addEventListener('keydown', (ev) => {
  // Enter in the search box searches; it should not save the whole form.
  if (ev.key === 'Enter' && ev.target.id === 's-people-search') ev.preventDefault();
});
settingsBox.addEventListener('submit', (ev) => {
  ev.preventDefault();
  saveSettings();
});

// ---------------------------------------------------------------------------------------------
// clicks
// ---------------------------------------------------------------------------------------------

document.addEventListener('click', (ev) => {
  const el = ev.target.closest('button, a.skip');
  if (!el) return;
  if (el.matches('a.skip')) {
    ev.preventDefault();
    $('#main').focus();
    return;
  }
  if (el.hasAttribute('data-undo')) return undoMove();
  // A drag across the map must not also open the tile it ended on.
  if (el.closest('#map-canvas') && S.dragUntil > Date.now()) return;
  if (el.hasAttribute('data-close')) return closeDrawer();
  if (el.id === 'theme-toggle') return toggleTheme();
  if (el.dataset.zoom) return zoomButton(el.dataset.zoom);
  if (el.dataset.mapMode) return setMapMode(el.dataset.mapMode);
  if (el.dataset.tab) return selectTab(el.dataset.tab, false);
  if (el.dataset.dismiss) return dismissNotice(el);
  if (el.dataset.open) return openInWindow(el);
  if (el.dataset.node) return openDrawer(el.dataset.node, el);
  if (el.dataset.listFilter) {
    S.listFilter = el.dataset.listFilter;
    renderList();
    return;
  }
  if (el.dataset.feedFilter) {
    S.feedFilter = el.dataset.feedFilter;
    S.feedLimit = FEED_PAGE;
    renderActivity();
    return;
  }
  if (el.id === 'feed-older') {
    S.feedLimit += FEED_PAGE;
    renderActivity();
    return;
  }
  if (el.id === 's-retry') return loadSettings(true);
  if (el.id === 's-chain-add') return addChainRule();
  if (el.dataset.chainRemove) return removeChainRule(Number(el.dataset.chainRemove));
  if (el.id === 's-undo' && S.set && S.set.info) {
    S.set.draft = clone(S.set.info.settings);
    S.set.msg = { kind: 'ok', text: 'Your changes were undone.' };
    renderSettingsForm();
    return;
  }
  if (el.id === 's-defaults' && S.set && S.set.draft) {
    S.set.draft = clone(DEFAULTS);
    S.set.msg = { kind: 'dirty', text: 'The defaults are in the form. Choose Save settings to keep them.' };
    renderSettingsForm();
  }
});

// ---------------------------------------------------------------------------------------------
// start
// ---------------------------------------------------------------------------------------------

applyTheme();
setView(viewFromHash() || 'map', false);
poll();
