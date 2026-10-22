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
const VIEWS = ['map', 'list', 'activity', 'mail', 'tasks', 'pulls', 'settings'];
const VIEW_NAMES = { map: 'Map', list: 'List', activity: 'Activity', mail: 'Mail', tasks: 'Tasks', pulls: 'Pull requests', settings: 'Settings' };
// Kept with the dismissed notices: the newest mail the person marked as read (src/model.js).
const MAIL_READ_ID = 'you|mailread';
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
const ATTN_WORDS = {
  needs: 'Needs you', error: 'Error', question: 'Question', review: 'Ready for review',
  alert: 'Relay alert', paused: 'Relay paused', halted: 'Relay halted', note: 'Note for you', stopped: 'Stopped working',
  mail: 'Mail for you',
};
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
  actions: { openTerminal: false, rollover: false, newAgent: false, teleport: false, send: false },
  send: { mode: 'read' },
  github: { live: false, merge: false, mergeMethod: 'squash' },
  models: { edit: false },
  alerts: { stoppedMinutes: 15 },
  rollSoon: { memoryPercent: 70, squeezes: 2, days: 7 },
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
  about: null, // { version, build } of the Pleni this page came with
  aboutNow: null, // the same, from the newest answer
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
  // Live GitHub status: the newest answer, when the page last asked, and the Merge steps.
  gh: { data: null, askedAt: 0, asking: false, error: '', confirm: null, merging: null, msg: null },
  // The Mail page: the newest answer, which list it holds, and a message for the person.
  mail: { data: null, all: false, asking: false, error: '', key: '', msg: null, cmds: [] },
  // Settings > Models: what Codex's settings say, the person's changes, and a message.
  models: { data: null, error: '', busy: false, drafts: {}, msgs: {}, addOpen: {} },
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

// Session storage lasts only while this tab is open.
function readSession(key) {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeSession(key, value) {
  try {
    if (value == null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, value);
  } catch {
    // Blocked storage only means a wrong key gets no "did not work" message.
  }
}

const own = (obj, key) => (obj && Object.hasOwn(obj, key) ? obj[key] : undefined);
const clone = (value) => JSON.parse(JSON.stringify(value));
const cap = (s) => (s ? String(s).charAt(0).toUpperCase() + String(s).slice(1) : '');
const safeClass = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9-]/g, '');
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const f1 = (v) => (Math.round(v * 10) / 10).toString();
const num = (v) => (Number.isFinite(v) ? v : 0);
const str = (v) => (typeof v === 'string' ? v : '');
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
const FOCUS_ATTRS = ['data-node', 'data-dismiss', 'data-open', 'data-teleport', 'data-merge', 'data-merge-yes', 'data-merge-no', 'data-gh-again', 'data-roll', 'data-copy', 'data-copy-addr', 'data-allow', 'data-hide', 'data-zoom', 'data-map-mode', 'data-list-filter', 'data-feed-filter', 'data-tab', 'data-person', 'data-project', 'data-model'];
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
  // A text box keeps its caret, so a repaint while someone types does not move it.
  const caret = restore && typeof active.selectionStart === 'number' ? [active.selectionStart, active.selectionEnd] : null;
  el.innerHTML = html;
  painted.set(el, { html, shape });
  if (restore) {
    const next = el.querySelector(restore);
    if (next) {
      restoringFocus = true;
      try {
        next.focus({ preventScroll: true });
        if (caret && typeof next.selectionStart === 'number') next.setSelectionRange(caret[0], caret[1]);
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

// A worker's model or effort that its sergeant did not choose is marked "(default)".
function modelText(n) {
  const model = n.modelLabel || prettyModel(n.model);
  const effort = EFFORT_WORDS[n.effort] || (n.effort ? `${n.effort} effort` : '');
  const c = n.chosen;
  if (c && model && effort && !c.model && !c.effort) return `${model} · ${effort} (defaults)`;
  const mark = (part, chosen) => (part && c && !chosen ? `${part} (default)` : part);
  return [mark(model, c && c.model), mark(effort, c && c.effort)].filter(Boolean).join(' · ');
}

// Who chose a worker's model and effort: the session that started it, or Claude Code's defaults.
function chosenWords(c) {
  if (c.model && c.effort) return 'The session that started it';
  if (c.model) return 'The session that started it chose the model. The effort is a default.';
  if (c.effort) return 'The session that started it chose the effort. The model is a default.';
  return 'Nobody: both are defaults';
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
  const hidden = S.snap && Array.isArray(S.snap.hiddenSessions) ? S.snap.hiddenSessions.length : 0;
  if (hidden) parts.push(`${hidden} hidden (Settings, Team)`);
  return parts.join(' · ');
}

// ---------------------------------------------------------------------------------------------
// polling
// ---------------------------------------------------------------------------------------------

let pollTimer = 0;
let polling = null; // the poll on its way, so a move can wait for it

function schedule(ms = POLL_MS) {
  clearTimeout(pollTimer);
  // A hidden tab stops asking, unless it has alerts to pop up; then it asks less often.
  if (!document.hidden) pollTimer = setTimeout(poll, ms);
  else if (alertsActive()) pollTimer = setTimeout(poll, HIDDEN_POLL_MS);
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
      checkAlerts();
      if (isTime(body.now)) S.skew = Date.now() - body.now;
    }
    noteVersion(res.headers.get('X-Pleni-Version'), res.headers.get('X-Pleni-Build'));
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
    schedule(); // stops asking, or slows down when alerts are on
    renderFacts();
  } else {
    poll();
  }
});

// ---------------------------------------------------------------------------------------------
// alerts: a pop-up for each new "Needs you" notice, if this browser allows it
// ---------------------------------------------------------------------------------------------

const ALERTS_KEY = 'pleni.alerts'; // 'on' when pop-ups are wanted in this browser
const HIDDEN_POLL_MS = 15000; // how often a hidden tab still asks for news while alerts are on
const MAX_ALERTED = 500;
const MAX_POPUPS = 3; // at once; more become one "and N more"
const alerted = new Map(); // notice id -> the time of the newest version already seen
let alertsSeeded = false;
let askingAlerts = null;

// 'granted', 'denied', 'default' (not asked yet), or 'none' when this browser cannot show them.
function alertSupport() {
  if (typeof Notification !== 'function' || !window.isSecureContext) return 'none';
  return Notification.permission;
}

const alertsWanted = () => readStore(ALERTS_KEY) === 'on';
const alertsActive = () => alertsWanted() && alertSupport() === 'granted';

// Runs with each new snapshot. The first one only notes what is already there, so opening Pleni
// does not pop up everything at once. After that a notice that is new, or newer, pops up.
function checkAlerts() {
  const fresh = [];
  for (const a of attentionItems()) {
    if (typeof a.id !== 'string') continue;
    const seen = alerted.get(a.id);
    if (seen === undefined || num(a.at) > seen) fresh.push(a);
    alerted.delete(a.id); // newest last, so the oldest go first when the list is full
    alerted.set(a.id, seen === undefined ? num(a.at) : Math.max(seen, num(a.at)));
  }
  while (alerted.size > MAX_ALERTED) alerted.delete(alerted.keys().next().value);
  const first = !alertsSeeded;
  alertsSeeded = true;
  if (first || !alertsActive()) return;
  for (const a of fresh.slice(0, MAX_POPUPS)) popUp(a);
  if (fresh.length > MAX_POPUPS) popUp({ id: 'pleni|more', key: '', kind: 'needs', text: `And ${fresh.length - MAX_POPUPS} more. Open Pleni to see them.` });
}

// Shows one pop-up; clicking it opens the tile. Returns false when the browser refuses.
function popUp(a) {
  try {
    const note = new Notification(`${ATTN_WORDS[a.kind] || 'Needs you'} · Pleni`, { body: a.text || keyName(a.key), tag: a.id, icon: '/brand/icon-192.png' });
    note.onclick = () => {
      window.focus();
      note.close();
      if (a.kind === 'mail') location.hash = '#/mail';
      else if (S.index && S.index.byKey.has(a.key)) openDrawer(a.key);
      else if (String(a.key).startsWith('task:')) location.hash = '#/tasks';
    };
    return true;
  } catch {
    // Most phone browsers allow pop-ups only from an installed app, not from a page.
    return false;
  }
}

async function setAlerts(box) {
  if (box.checked) {
    writeStore(ALERTS_KEY, 'on');
    if (alertSupport() === 'default') {
      // The click on the box is what lets the browser ask; ask once even if both input and change fire.
      if (!askingAlerts) askingAlerts = Promise.resolve(Notification.requestPermission()).catch(() => null).finally(() => (askingAlerts = null));
      await askingAlerts;
    }
  } else {
    writeStore(ALERTS_KEY, null);
  }
  paintAlertsRow();
}

function testAlert() {
  const shown = popUp({ id: 'pleni|test', key: '', kind: 'needs', text: 'This is a test. Pleni can pop up alerts in this browser.' });
  if (!shown) setText($('#s-alerts-help'), 'This browser did not show the pop-up. Desktop browsers can show them; most phone browsers cannot.');
}

function alertsHelp(support, on) {
  if (support === 'none') return 'This browser cannot show pop-ups from Pleni. Desktop browsers such as Edge, Chrome and Firefox can; most phone browsers cannot.';
  if (support === 'denied') return "This browser blocks pop-ups from Pleni. Allow notifications for this page in the browser's site settings, then tick the box again.";
  if (on) return 'On in this browser. Pop-ups come while a Pleni tab is open, even in the background, usually within a minute.';
  return 'Kept in this browser only. When you tick it, the browser asks whether Pleni may show notifications.';
}

function alertsRowHtml() {
  const support = alertSupport();
  const on = alertsWanted() && support === 'granted';
  return (
    `<div class="srow"><span class="lbl" id="s-alerts-lbl">Pop-ups</span><div class="checks"><label><input type="checkbox" id="s-alerts" data-local="alerts" aria-describedby="s-alerts-help"${on ? ' checked' : ''}${support === 'none' ? ' disabled' : ''}>` +
    `Pop up an alert in this browser when something new needs you</label><button type="button" class="btn" id="s-alerts-test"${on ? '' : ' hidden'}>Send a test alert</button></div>` +
    `<p class="help" id="s-alerts-help" role="status">${esc(alertsHelp(support, on))}</p></div>`
  );
}

function paintAlertsRow() {
  const box = $('#s-alerts');
  if (!box) return;
  const support = alertSupport();
  const on = alertsWanted() && support === 'granted';
  box.checked = on;
  box.disabled = support === 'none';
  $('#s-alerts-test').hidden = !on;
  setText($('#s-alerts-help'), alertsHelp(support, on));
}

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
  if (v === 'settings') {
    pickSettingsGroupFromHash();
    loadSettings(false);
  }
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
  renderVersion();
  renderSignIn();
  $('#nav-tasks').hidden = !(S.snap && Array.isArray(S.snap.tasks));
  $('#nav-pulls').hidden = !repoGroups().length;
  paintMailNav();
  const asking = (S.snap && S.snap.counts && S.snap.counts.needs) || 0;
  document.title = `${asking ? `(${asking}) ` : ''}${VIEW_NAMES[S.view]} · Pleni`;
  if (S.view === 'map') renderMap();
  else if (S.view === 'list') renderList();
  else if (S.view === 'activity') renderActivity();
  else if (S.view === 'mail') renderMail();
  else if (S.view === 'tasks') renderTasks();
  else if (S.view === 'pulls') renderPulls();
  else if (S.view === 'settings') {
    paintModels();
    loadDevices(false);
  }
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

// ---- version ----
// The first answer says which Pleni this page came with. A later answer from another version means
// Pleni was updated and started again, while this page still runs the old code.
const VERSION_TEXT = /^[0-9A-Za-z.+-]{1,40}$/;

function noteVersion(version, build) {
  if (typeof version !== 'string' || !VERSION_TEXT.test(version)) return;
  const now = { version, build: typeof build === 'string' && /^[0-9a-f]{7,40}$/.test(build) ? build : null };
  if (!S.about) S.about = now;
  S.aboutNow = now;
}

function versionText(about, long) {
  if (!about) return '';
  return about.build ? `${about.version} (${long ? 'commit ' : ''}${about.build})` : about.version;
}

function renderVersion() {
  const el = $('#brand-version');
  setText(el, S.about ? S.about.version : '');
  if (S.about) el.title = `Pleni ${versionText(S.about, true)}`;
  setText($('#settings-version'), S.about ? `This is Pleni ${versionText(S.about, true)}.` : '');
}

function updatedTo() {
  const a = S.about;
  const b = S.aboutNow;
  return a && b && (a.version !== b.version || a.build !== b.build) ? b : null;
}

function renderNotices() {
  const out = [];
  const newer = updatedTo();
  if (newer) out.push(notice(false, 'Pleni was updated.', `It now runs version ${versionText(newer, true)}. Reload this page to use it.`));
  if (S.conn === 'error') out.push(notice(true, 'Cannot reach Pleni.', `${S.connError} The page keeps trying every few seconds.`));
  const src = (S.snap && S.snap.sources) || {};
  for (const [name, label] of [['claude', 'Claude Code'], ['codex', 'Codex'], ['grok', 'Grok'], ['kimi', 'Kimi Code'], ['mailbox', 'The mailbox']]) {
    const s = src[name];
    if (s && s.enabled && s.ok === false) out.push(notice(false, `${label} could not be read.`, s.error || 'Pleni will try again.'));
  }
  setHtml($('#notices'), out.join(''));
}

// ---- sign-in ----
// Without the key cookie the API answers 401. The sign-in box takes the key and opens "/?t=<key>",
// the same address Pleni prints, so the server sets the cookie and sends the browser back to "/".
// The address to bookmark never carries the key.
const SIGNIN_TRIED = 'pleni.signin';
const KEY_TEXT = /^[A-Za-z0-9_-]{16,}$/;

function renderSignIn() {
  const box = $('#signin');
  const locked = S.conn === 'locked';
  // Signed in: forget the try, so a later lock does not blame this key.
  if (S.conn === 'live' && readSession(SIGNIN_TRIED)) writeSession(SIGNIN_TRIED, null);
  if (box.hidden !== locked) return;
  box.hidden = !locked;
  if (!locked) return;
  // Back from a key that did not work: say so once.
  if (readSession(SIGNIN_TRIED)) {
    writeSession(SIGNIN_TRIED, null);
    signInMessage('That key did not work. Check that you copied all of it.');
  }
  // Only take the focus when nothing else has it, so a sign-in box never pulls it away.
  if (document.activeElement === document.body) $('#signin-key').focus();
}

function signInMessage(text) {
  $('#signin-msg').textContent = text;
  if (text) $('#signin-key').setAttribute('aria-invalid', 'true');
  else $('#signin-key').removeAttribute('aria-invalid');
}

// The key alone, or a whole pasted address that holds "?t=<key>".
function keyFromText(text) {
  const t = String(text || '').trim();
  const m = /(?:^|[?&])t=([A-Za-z0-9_-]+)/.exec(t);
  return m ? m[1] : t;
}

function signIn() {
  const key = keyFromText($('#signin-key').value);
  if (!KEY_TEXT.test(key)) {
    signInMessage('That is not a key. A key is a long run of letters, digits, "-" and "_".');
    $('#signin-key').focus();
    return;
  }
  signInMessage('');
  writeSession(SIGNIN_TRIED, '1');
  location.assign(`/?t=${encodeURIComponent(key)}`);
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
    if (a.kind === 'mail') main = `<a class="attn-go" href="#/mail">${inner}</a>`;
    else if (S.index.byKey.has(a.key)) main = `<button type="button" class="attn-go" data-node="${esc(a.key)}">${inner}</button>`;
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
      <p><a href="#/settings/sources">Change where Pleni looks</a></p>
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
      `<span class="tile-model"${model ? ` title="${esc(model)}"` : ''}>${esc(model)}</span>${when || '<span class="tile-ago"></span>'}</span>` +
      (d ? `<span class="tile-text">${doingHtml(d)}</span>` : '');
    label = [title, rank, STATUS_WORDS[status], model, rollSoonText(n)].filter(Boolean).join(', ');
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
  const mail = mailText(n);
  if (mail) label += `, ${mail}`;
  return (
    `<button type="button" class="${cls.join(' ')}" data-node="${esc(n.key)}" style="left:${f1(p.x)}px;top:${f1(p.y)}px" aria-label="${esc(label)}"${described}>` +
    (p.parent ? '<span class="hd l" aria-hidden="true"></span>' : '') +
    (p.kids ? '<span class="hd r" aria-hidden="true"></span>' : '') +
    markHtml(n) +
    `<span class="tile-title">${esc(title)}</span><span class="tile-rank">${esc(rank)}</span>` +
    body +
    (quiet ? `<span class="tile-quiet" aria-hidden="true">+${quiet} quiet</span>` : '') +
    (isSession(n) && n.rollSoon ? '<span class="tile-roll" aria-hidden="true">Roll over soon</span>' : '') +
    (mail ? `<span class="tile-mail" aria-hidden="true">${esc(mail)}</span>` : '') +
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
  // The legend floats over the top of the map, so the tiles fit in the space below it.
  const legend = $('.map-legend', cv);
  const top = legend && legend.offsetHeight ? legend.offsetTop + legend.offsetHeight : 0;
  const ch = Math.max(1, cv.clientHeight - top);
  let k = Math.max(ZOOM_MIN, Math.min(1, cw / L.w, ch / L.h));
  let x = (cw - L.w * k) / 2;
  let y = top + (ch - L.h * k) / 2;
  // On a narrow screen the whole map would be too small to read: fit the height, start at the left.
  if (k < 0.55 && cw < 720) {
    k = Math.max(0.5, Math.min(0.85, ch / L.h));
    x = 0;
    y = top + Math.max(0, (ch - L.h * k) / 2);
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
    `<td><span class="pill">${esc(STATUS_WORDS[status] || 'Unknown')}</span>` +
    `${n.rollSoon ? ` <span class="pill roll-soon" title="${esc(n.rollSoon.join(', '))}">Roll over soon<span class="sr-only">: ${esc(n.rollSoon.join(', '))}</span></span>` : ''}</td>` +
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

// `name` is for a key that is not on the map, such as an agent that only has a mail name. The
// person is "you" in a sentence (bossName), "You" when it starts one (`first`).
function nameHtml(key, name = '', first = false) {
  if (key && S.index.byKey.has(key)) {
    const words = key !== 'you' ? keyName(key) : first ? cap(bossName(key)) : bossName(key);
    return `<button type="button" class="name" data-node="${esc(key)}">${esc(words)}</button>`;
  }
  return `<b>${esc(!key && name ? name : keyName(key))}</b>`;
}

// True when tile `upper` is above tile `lower` on the map (its boss, its boss's boss, ...).
function isAbove(upper, lower) {
  const byKey = S.index.byKey;
  let n = byKey.get(lower);
  for (let i = 0; n && n.parent && i < 64; i++) {
    if (n.parent === upper) return true;
    n = byKey.get(n.parent);
  }
  return false;
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
    case 'mail':
      return { dir: from && to && isAbove(to, from) ? 'up' : 'down', from, to, verb: 'sent mail to', fromName: str(ev.fromName), toName: str(ev.toName) };
    case 'wake':
      return { dir: 'down', from, to, verb: 'woke', toName: str(ev.toName) };
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
  const sentence = `${nameHtml(d.from, d.fromName, true)} ${esc(d.verb)}${d.to || d.toName ? ' ' + nameHtml(d.to, d.toName) : ''}`;
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
      '<p class="empty">Tasks come from a mailbox: a folder where one agent hands out work and another reports back. No mailbox is turned on. You can add one in <a href="#/settings/sources">Settings, under Sources</a>.</p>',
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
// pull requests
// ---------------------------------------------------------------------------------------------

// The GitHub repositories the sessions on the map work in (node.github, read from each folder's git
// settings), with links to their pull requests. With live GitHub status on (Settings, Sources), the
// server also asks GitHub about them through the GitHub CLI (gh) on its computer (GET /api/github),
// about once a minute while this view is open, and may offer Merge there.
const GITHUB_PATH = /^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/;
const LINK_BRANCH = /^[A-Za-z0-9._\/-]{1,200}$/;
const MAIN_BRANCHES = new Set(['main', 'master', 'trunk', 'develop']);
const GITHUB_EVERY_MS = 60 * 1000;
const PULL_ID = /^([A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100})#(\d{1,9})$/;
const COMMIT_ID = /^[0-9a-f]{40}$/;
// [words, color] for the pills on a pull request.
const PULL_STATES = { open: ['Open', 'gh-info'], draft: ['Draft', ''], merged: ['Merged', 'gh-info'], closed: ['Closed', ''] };
const CHECK_WORDS = { passing: ['Checks pass', 'gh-ok'], failing: ['Checks fail', 'gh-bad'], running: ['Checks running', 'gh-wait'], none: ['No checks', ''] };
const REVIEW_WORDS = { approved: ['Approved', 'gh-ok'], changes: ['Changes asked for', 'gh-bad'], needed: ['Needs a review', 'gh-wait'] };
const MERGE_WORDS = { ready: ['Ready to merge', 'gh-ok'], conflict: ['Merge conflict', 'gh-bad'], behind: ['Behind its base branch', 'gh-wait'] };
const METHOD_WORDS = { squash: 'Squash and merge', merge: 'Create a merge commit', rebase: 'Rebase and merge' };

// [[repo, [[branch, sessions], ...]], ...], sorted. Main sessions first; a helper shows only on a
// branch no main session of its repository works on.
function repoGroups() {
  const repos = new Map();
  const nodes = S.index ? S.index.nodes.filter((n) => isSession(n) && n.kind !== 'reviewer' && typeof n.github === 'string' && GITHUB_PATH.test(n.github)) : [];
  for (const pass of ['session', 'agent']) {
    const before = new Map([...repos].map(([repo, branches]) => [repo, new Set(branches.keys())]));
    for (const n of nodes) {
      if ((n.kind === 'session') !== (pass === 'session')) continue;
      const branch = typeof n.subtitle === 'string' ? n.subtitle : '';
      if (pass === 'agent' && before.get(n.github)?.has(branch)) continue;
      if (!repos.has(n.github)) repos.set(n.github, new Map());
      const branches = repos.get(n.github);
      if (!branches.has(branch)) branches.set(branch, []);
      branches.get(branch).push(n);
    }
  }
  const order = (a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' });
  return [...repos]
    .sort((a, b) => order(a[0], b[0]))
    .map(([repo, branches]) => [repo, [...branches].sort((a, b) => Number(MAIN_BRANCHES.has(b[0])) - Number(MAIN_BRANCHES.has(a[0])) || order(a[0], b[0]))]);
}

function githubLink(repo, rest, text) {
  return `<a class="ext" href="${esc(`https://github.com/${repo}${rest}`)}" target="_blank" rel="noopener noreferrer">${esc(text)}<span class="sr-only"> (opens GitHub in a new tab)</span></a>`;
}

// Links for one branch: its pull request (if any) and a page to open one. None for a main branch or
// a name that is not safe in an address.
function branchLinks(repo, branch) {
  if (!branch || MAIN_BRANCHES.has(branch) || !LINK_BRANCH.test(branch)) return '';
  const path = branch.split('/').map(encodeURIComponent).join('/');
  return githubLink(repo, `/pulls?q=${encodeURIComponent(`is:pr head:${branch}`)}`, 'Its pull request') +
    githubLink(repo, `/compare/${path}?expand=1`, 'Open a pull request');
}

function pullSessionHtml(n) {
  const status = statusOf(n);
  return (
    `<li><span class="who">${markHtml(n, 'small')}<button type="button" class="open" data-node="${esc(n.key)}">${esc(titleOf(n))}</button></span>` +
    `<span class="sub">${esc(rankLine(n))}</span><span class="pill">${esc(STATUS_WORDS[status] || 'Unknown')}</span></li>`
  );
}

// ---- live GitHub status ----

function askGithubSoon() {
  if (!S.gh.asking && !document.hidden && Date.now() - S.gh.askedAt >= GITHUB_EVERY_MS) askGithub(false);
}

async function askGithub(fresh) {
  if (S.gh.asking) return;
  S.gh.asking = true;
  S.gh.askedAt = Date.now();
  try {
    const data = await getJson(`/api/github${fresh ? '?fresh=1' : ''}`);
    S.gh.data = data && typeof data === 'object' ? data : null;
    S.gh.error = '';
  } catch (err) {
    S.gh.error = plainError(err);
  } finally {
    S.gh.asking = false;
    S.gh.askedAt = Date.now();
    if (S.view === 'pulls') renderPulls();
  }
}

// What the newest answer says, checked: { on, merge, method, error, repos: Map(repo -> { at, error, pulls }) }.
function githubView() {
  const d = S.gh.data;
  const on = !!(d && d.on === true);
  const repos = new Map();
  for (const r of on && Array.isArray(d.repos) ? d.repos : []) {
    if (!r || typeof r.repo !== 'string' || !GITHUB_PATH.test(r.repo)) continue;
    const pulls = Array.isArray(r.pulls) ? r.pulls.filter((p) => p && Number.isSafeInteger(p.number) && p.number > 0 && Object.hasOwn(PULL_STATES, p.state)) : [];
    repos.set(r.repo, { at: isTime(r.at) ? r.at : null, error: typeof r.error === 'string' ? r.error : '', pulls });
  }
  return {
    on,
    merge: on && d.merge === true && LOCAL_PAGE,
    method: on && Object.hasOwn(METHOD_WORDS, d.method) ? d.method : 'squash',
    error: on && typeof d.error === 'string' ? d.error : '',
    repos,
  };
}

// The pull request of a branch: an open one first, else the newest.
function pullFor(pulls, branch) {
  const mine = pulls.filter((p) => p.branch === branch && p.fork !== true);
  return mine.find((p) => p.state === 'open' || p.state === 'draft') || mine[0] || null;
}

const isOpenPull = (p) => p.state === 'open' || p.state === 'draft';

// A pill from one of the maps above, or '' for a value it does not have.
function ghPill(map, key) {
  if (typeof key !== 'string' || !Object.hasOwn(map, key)) return '';
  const [words, color] = map[key];
  return `<span class="pill${color ? ` ${color}` : ''}">${esc(words)}</span>`;
}

function pullHtml(repo, p, gh) {
  const pills = [ghPill(PULL_STATES, p.state)];
  if (isOpenPull(p)) pills.push(ghPill(CHECK_WORDS, p.checks), ghPill(REVIEW_WORDS, p.review), ghPill(MERGE_WORDS, p.merge));
  const failing = isOpenPull(p) && p.checks === 'failing' && Array.isArray(p.failing) && p.failing.length
    ? `<span class="gh-fail">Failing: ${esc(p.failing.filter((x) => typeof x === 'string').join(', '))}</span>`
    : '';
  return (
    `<div class="pull"><div class="pull-head">${githubLink(repo, `/pull/${p.number}`, `#${p.number} ${typeof p.title === 'string' && p.title ? p.title : 'Pull request'}`)}` +
    `${isTime(p.updatedAt) ? `<span class="quiet">changed ${agoHtml(p.updatedAt)}</span>` : ''}</div>` +
    `<div class="pull-pills">${pills.join('')}${failing}</div>${mergeHtml(repo, p, gh)}</div>`
  );
}

// The Merge button, its confirm step, or why it cannot be merged yet. Only on this computer, when
// the server allows it.
function mergeHtml(repo, p, gh) {
  const id = `${repo}#${p.number}`;
  const msg = S.gh.msg && S.gh.msg.id === id
    ? `<p class="roll-msg${S.gh.msg.bad ? ' bad' : ''}" id="gh-msg" tabindex="-1">${esc(S.gh.msg.text)}</p>`
    : '';
  if (!gh.merge || !isOpenPull(p)) return msg;
  if (S.gh.merging === id) return `<p class="roll-msg">Merging #${p.number}…</p>`;
  if (!p.canMerge || !COMMIT_ID.test(p.head || '')) {
    return `<p class="quiet gh-why">Not ready to merge. ${esc(typeof p.why === 'string' ? p.why : '')}</p>${msg}`;
  }
  if (S.gh.confirm === id) {
    const into = typeof p.base === 'string' && p.base ? `<code>${esc(p.base)}</code>` : 'its base branch';
    return (
      `<div class="merge-ask" role="group" aria-label="${esc(`Merge #${p.number}`)}"><p>Merge #${p.number} into ${into} with “${esc(METHOD_WORDS[gh.method])}”? This changes ${into} on GitHub.</p>` +
      `<div class="merge-buttons"><button type="button" class="btn primary" data-merge-yes="${esc(id)}">Merge now</button>` +
      `<button type="button" class="btn" data-merge-no="${esc(id)}">Cancel</button></div></div>${msg}`
    );
  }
  return `<div class="merge-buttons"><button type="button" class="btn" data-merge="${esc(id)}">Merge</button></div>${msg}`;
}

function findPull(id) {
  const m = PULL_ID.exec(id || '');
  const info = m && githubView().repos.get(m[1]);
  const pull = info && info.pulls.find((p) => p.number === Number(m[2]));
  return pull ? { repo: m[1], pull } : null;
}

function mergeClick(id) {
  if (!findPull(id)) return;
  S.gh.confirm = id;
  S.gh.msg = null;
  renderPulls();
  const yes = $(`[data-merge-yes="${CSS.escape(id)}"]`);
  if (yes) yes.focus();
}

function mergeCancel(id) {
  S.gh.confirm = null;
  renderPulls();
  const btn = $(`[data-merge="${CSS.escape(id)}"]`);
  if (btn) btn.focus();
}

async function mergeNow(id) {
  const found = findPull(id);
  if (!found || S.gh.merging) return;
  const { repo, pull } = found;
  S.gh.merging = id;
  S.gh.confirm = null;
  S.gh.msg = null;
  renderPulls();
  try {
    await postJson('/api/github/merge', { repo, number: pull.number, head: pull.head });
    S.gh.msg = { id, text: `Merged #${pull.number} on GitHub.` };
  } catch (err) {
    S.gh.msg = { id, text: `Not merged. ${plainError(err)}`, bad: true };
  } finally {
    S.gh.merging = null;
    S.gh.askedAt = 0;
    say(S.gh.msg.text);
    renderPulls();
    const msg = $('#gh-msg');
    if (msg) msg.focus();
  }
}

function githubBarHtml(gh) {
  if (!gh.on) return S.gh.error ? `<p class="note bad">GitHub status: ${esc(S.gh.error)}</p>` : '';
  const ats = [...gh.repos.values()].map((r) => r.at).filter(isTime);
  const when = ats.length ? `, checked ${agoHtml(Math.min(...ats))}` : '';
  const errors = [...gh.repos.values()].map((r) => r.error);
  const shared = gh.error || (errors.length && errors.every((e) => e && e === errors[0]) ? errors[0] : '');
  return (
    `<div class="gh-bar"><span>Live from GitHub${when}${S.gh.asking ? '. Asking GitHub…' : ''}</span>` +
    '<button type="button" class="btn" data-gh-again="1">Look again</button></div>' +
    (shared ? `<p class="note bad">${esc(shared)}</p>` : '') +
    (S.gh.error ? `<p class="note bad">${esc(S.gh.error)}</p>` : '')
  );
}

function renderPulls() {
  const groups = repoGroups();
  if (!groups.length) {
    setText($('#pulls-meta'), '');
    setHtml(
      $('#pulls'),
      '<p class="empty">No session on the map works in a GitHub repository. Pleni finds a repository from the git settings in a session\'s folder: the address of its origin remote, on github.com.</p>',
    );
    return;
  }
  askGithubSoon();
  const gh = githubView();
  const errors = [...gh.repos.values()].map((r) => r.error);
  const sharedError = errors.length > 0 && errors.every((e) => e && e === errors[0]);
  const branchCount = groups.reduce((sum, [, branches]) => sum + branches.length, 0);
  const sessionCount = groups.reduce((sum, [, branches]) => sum + branches.reduce((n, [, list]) => n + list.length, 0), 0);
  setText(
    $('#pulls-meta'),
    `${plural(groups.length, 'GitHub repository', 'GitHub repositories')} · ${plural(branchCount, 'branch', 'branches')} · ${plural(sessionCount, 'session', 'sessions')}`,
  );
  const cards = groups.map(([repo, branches], i) => {
    const info = gh.repos.get(repo) || { pulls: [], error: '' };
    const shown = new Set();
    const rows = branches.map(([branch, list]) => {
      const name = branch ? `<code>${esc(branch)}</code>` : '<span class="quiet">No branch known</span>';
      const main = MAIN_BRANCHES.has(branch) ? ' <span class="quiet">(main branch)</span>' : '';
      const pull = branch && !MAIN_BRANCHES.has(branch) ? pullFor(info.pulls, branch) : null;
      if (pull) shown.add(pull.number);
      const links = pull && isOpenPull(pull) ? '' : branchLinks(repo, branch);
      return `<li class="branch"><div class="branch-head"><span class="branch-name">${name}${main}</span><span class="links">${links}</span></div>` +
        `${pull ? pullHtml(repo, pull, gh) : ''}<ul class="branch-who">${list.map(pullSessionHtml).join('')}</ul></li>`;
    });
    // One merged from here stays until the next change, so its message can be read.
    const others = info.pulls.filter((p) => (isOpenPull(p) || (S.gh.msg && S.gh.msg.id === `${repo}#${p.number}`)) && !shown.has(p.number));
    return (
      `<section class="repo" aria-labelledby="repo-${i}"><div class="repo-head"><h2 id="repo-${i}">${esc(repo)}</h2>` +
      `<span class="links">${githubLink(repo, '/pulls', 'Pull requests')}${githubLink(repo, '/branches', 'Branches')}${githubLink(repo, '/actions', 'Checks')}</span></div>` +
      (info.error && !sharedError ? `<p class="note bad">${esc(info.error)}</p>` : '') +
      `<ul class="branches">${rows.join('')}</ul>` +
      (others.length ? `<h3 class="gh-others">Other open pull requests</h3><ul class="pulls-more">${others.map((p) => `<li>${pullHtml(repo, p, gh)}</li>`).join('')}</ul>` : '') +
      '</section>'
    );
  });
  const note = gh.on
    ? 'Pleni asks GitHub through the GitHub CLI (gh) on the computer that runs it, about once a minute while this page is open. The links open GitHub in a new tab.'
    : 'Pleni only links to GitHub; it sends nothing there. To see checks and reviews here, turn on Live GitHub status in Settings, under Sources.';
  setHtml($('#pulls'), githubBarHtml(gh) + cards.join('') + `<p class="note">${esc(note)}</p>`);
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
  S.drawer = { key, tab: 'now', events: [], next: null, loaded: false, error: null, busy: false, frame: '', pick: null, send: newSendState(key), opener: prev ? prev.opener : opener || document.activeElement };
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
  chat: [['now', 'Now'], ['chat', 'Chat'], ['details', 'Details'], ['handoffs', 'Hand-offs']],
  relay: [['now', 'Overview'], ['details', 'Details'], ['handoffs', 'Hand-offs']],
  group: [['now', 'Overview'], ['details', 'Details']],
};
const DRAWER_ABOUT = { session: 'About this session', chat: 'About this session', relay: 'About the relay', group: 'About this group' };

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
        '<p class="dplace-done"><span id="d-boss-msg" role="status"></span><button type="button" class="btn" id="d-boss-undo" data-undo aria-describedby="d-boss-msg" hidden>Undo</button></p></div>' +
        '<div class="dwatch" id="drawer-watch" hidden><label><input type="checkbox" id="d-watch" aria-describedby="d-watch-help d-watch-msg">Tell me if this stops working</label>' +
        '<p class="help" id="d-watch-help">It shows under Needs you once this does no work for a while. Settings, under Alerts, says how long.</p>' +
        '<p class="dwatch-msg" id="d-watch-msg" role="status"></p></div>') +
    `<div class="tabs" role="tablist" aria-label="${DRAWER_ABOUT[frame]}">` +
    tabs
      .map(
        ([id, label]) =>
          `<button type="button" role="tab" id="dtab-${id}" data-tab="${id}" aria-controls="dpanel-${id}" aria-selected="${id === d.tab}" tabindex="${id === d.tab ? 0 : -1}">${label}</button>`,
      )
      .join('') +
    '</div>' +
    (frame === 'session' || frame === 'chat'
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
  if (id === 'chat') sendLoad();
}

function renderDrawerParts() {
  const d = S.drawer;
  if (!d) return;
  const n = S.index && S.index.byKey.get(d.key);
  const group = !!n && !isSession(n);
  const frame = !group ? (canSend(n) ? 'chat' : 'session') : isRelay(n) ? 'relay' : 'group';
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
  if (d.roll && !d.roll.loading && Date.now() - d.roll.at > ROLL_REFRESH_MS) rollLoad();
  paintPlace(n, d);
  paintWatch(n);
  paintMoved();
  if (group) {
    setHtml($('#dpanel-now'), groupNowHtml(n));
    setHtml($('#dpanel-details'), detailsHtml(n));
    if (frame === 'relay') setHtml($('#dpanel-handoffs'), handoffsHtml(d.key));
  } else {
    setHtml($('#dpanel-now'), sessionNowHtml(n, d));
    setHtml($('#dpanel-details'), n ? detailsHtml(n) : '<p class="empty">No details: this session is not listed right now.</p>');
    setHtml($('#dpanel-handoffs'), handoffsHtml(d.key));
    if (frame === 'chat') paintChat(n, d);
  }
}

// "Tell me if this stops working", for sessions and the relay (not a mailbox worker run).
const canWatch = (n) => isRelay(n) || (isSession(n) && !isWorkerKey(n.key));
const watching = new Set(); // tile keys whose change is on its way to Pleni

function paintWatch(n) {
  const box = $('#drawer-watch');
  if (!box) return;
  box.hidden = !canWatch(n);
  if (!box.hidden && !watching.has(n.key)) $('#d-watch').checked = n.watched === true;
}

async function setWatch(input) {
  const d = S.drawer;
  if (!d || watching.has(d.key)) return;
  const { key } = d;
  const want = input.checked;
  watching.add(key);
  setText($('#d-watch-msg'), '');
  try {
    await postJson('/api/watch', { key, watch: want });
    keepPersonField(key, 'watch', want || undefined); // so saving Settings later keeps it
    if (S.drawer === d) setText($('#d-watch-msg'), want ? 'Watching. Pleni will tell you if this stops working.' : 'No longer watched.');
  } catch (err) {
    if (S.drawer === d) {
      input.checked = !want;
      setText($('#d-watch-msg'), `Not changed. ${plainError(err)}`);
    }
  } finally {
    watching.delete(key);
  }
  await pollNow();
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
  if (n && n.rollSoon) out.push(`<p class="dnow roll-soon"><b>Roll over soon:</b> ${esc(sentence(n.rollSoon))}</p>`);
  out.push(mailHtml(n));
  out.push(openHtml(n));
  out.push(rollHtml(n, d));
  out.push(newHtml(n, d));
  out.push(teleportHtml(n));
  out.push(hideHtml(n));
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

// ---- Roll over ----

const ROLL_KEY = /^(claude|codex):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ROLL_REFRESH_MS = 5000; // how often the open section asks again whether the handoff note is there

// Roll over is for a main Claude Code session or Codex thread, on this computer, when it is on.
function canRoll(n) {
  return !!n && LOCAL_PAGE && !!(S.snap && S.snap.actions && S.snap.actions.rollover) && n.kind === 'session' && ROLL_KEY.test(n.key);
}

function rollHtml(n, d) {
  if (!canRoll(n)) return '';
  const r = d.roll;
  if (!r) {
    return (
      '<div class="droll"><button type="button" class="btn" data-roll="open" aria-describedby="d-roll-help">Roll over…</button>' +
      '<p class="help" id="d-roll-help">Start a fresh session with the same name. It picks up from a handoff note, so it stays quick and costs less than a long one.</p></div>'
    );
  }
  let body;
  if (r.error) body = `<p class="empty">${esc(r.error)}</p>`;
  else if (!r.info) body = '<p class="empty">Loading…</p>';
  else if (r.info.problem) body = `<p class="empty">${esc(r.info.problem)}</p>`;
  else body = rollStepsHtml(n, r);
  return (
    '<section class="droll open" aria-labelledby="d-roll-title">' +
    '<div class="droll-head"><h3 id="d-roll-title" tabindex="-1">Roll over</h3><button type="button" class="btn" data-roll="close">Close</button></div>' +
    body +
    '</section>'
  );
}

function rollStepsHtml(n, r) {
  const i = r.info;
  const codex = n.platform === 'codex';
  const exit = codex ? '/quit' : '/exit';
  const found = rollFound(n, i.name);
  const msg = (step) => {
    const m = r.msg[step];
    return `<p class="roll-msg${m && m.bad ? ' bad' : ''}">${m ? esc(m.text) : ''}</p>`;
  };
  const note = isTime(i.handoffAt)
    ? `Pleni sees <code>${esc(i.file)}</code> in the session's folder, written ${agoHtml(i.handoffAt)}.`
    : `Pleni does not see <code>${esc(i.file)}</code> in the session's folder yet.`;
  const copy = (which, what) => `<button type="button" class="btn" data-copy="${which}">Copy ${what}</button>`;
  const check = found
    ? `<p>New session found: <button type="button" class="linkish" data-node="${esc(found.key)}">${esc(titleOf(found))}</button>, started ${agoHtml(found.startedAt)}.` +
      `${found.parent === 'relay' ? ' The relay now wakes it.' : ''}</p>` +
      `<div class="roll-btns"><button type="button" class="btn" data-hide="${esc(n.key)}" data-title="${esc(titleOf(n))}">Hide the old session</button></div>`
    : '<p>Pleni has not found the new session yet.</p>';
  return (
    `<p class="note">The new session gets the name <b>${esc(i.name)}</b> and works in the same folder. It starts by reading a handoff note that this session writes first, with the open work and every standing instruction it follows.${carryHtml(i.carry)}</p>` +
    '<ol class="roll-steps">' +
    '<li><h4>Ask for a handoff note</h4>' +
    `<p>Pleni opens this session in a new PowerShell window and sends it this message:</p><blockquote class="roll-text">${esc(i.ask)}</blockquote>` +
    `<div class="roll-btns"><button type="button" class="btn primary" data-roll="ask">Ask in PowerShell</button>${copy('ask', 'the message')}</div>` +
    msg('ask') +
    `<p class="help">${note} If this session is open in an app, paste the message there instead.</p></li>` +
    `<li><h4>Close the old session</h4><p>When the note is written, type <code>${exit}</code> in that window.</p></li>` +
    '<li><h4>Start the new session</h4>' +
    `<p>Pleni opens a new PowerShell window in the same folder${codex ? '' : ', with the same name,'} and sends this message:</p><blockquote class="roll-text">${esc(i.start)}</blockquote>` +
    `<div class="roll-btns"><button type="button" class="btn primary" data-roll="start">Start in PowerShell</button>${copy('start', 'the message')}</div>` +
    msg('start') +
    (codex
      ? `<p>Then give it the name: type <code>${esc(i.rename)}</code> in the new window.</p><div class="roll-btns">${copy('rename', 'the name command')}</div>${msg('rename')}`
      : '') +
    '</li>' +
    `<li><h4>Check</h4>${check}<p class="help">${
      codex
        ? 'When the new thread says it is ready, keep working in its window, or type <code>/quit</code> and open the thread in the Codex app. You can archive the old thread there too.'
        : 'You can keep its window open to watch it and type to it. While it is open, the mailbox relay waits and keeps its messages. Type <code>/exit</code> when you want the relay to wake it again.'
    } Pleni and the relay find it by its name.</p></li>` +
    '</ol>'
  );
}

const MODE_WORDS = { acceptEdits: 'Accept edits', auto: 'Auto', bypassPermissions: 'Bypass permissions', dontAsk: "Don't ask", plan: 'Plan' };

// " It starts with Opus 5.5, high effort, in Accept edits mode." from what Roll over carries over.
function carryHtml(c) {
  if (!c) return '';
  const parts = [c.model ? prettyModel(c.model) : '', c.effort ? EFFORT_WORDS[c.effort] || `${c.effort} effort` : ''].filter(Boolean);
  const mode = c.mode && MODE_WORDS[c.mode] ? `in ${MODE_WORDS[c.mode]} mode` : '';
  if (!parts.length && !mode) return '';
  return ` It starts with ${esc([...parts, mode].filter(Boolean).join(', '))}, like this one.`;
}

// The newest other session of the same tool with this name, started after this one.
function rollFound(n, name) {
  const want = String(name || '').trim().toLowerCase();
  let best = null;
  for (const m of (S.snap && S.snap.nodes) || []) {
    if (m.key === n.key || m.platform !== n.platform || m.kind !== 'session' || !isTime(m.startedAt)) continue;
    if (String(m.title || '').trim().toLowerCase() !== want || (isTime(n.startedAt) && m.startedAt <= n.startedAt)) continue;
    if (!best || m.startedAt > best.startedAt) best = m;
  }
  return best;
}

// ---- New agent ----
// Starts a new Claude Code or Codex agent in this session's folder, in a PowerShell window. The
// person types its first message there; Pleni sends nothing. The server takes the folder from the
// session, so the page never needs its path.

const NEW_FROM = /^(claude|codex):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// The same marks the server lets through, so most mistakes are caught before a click.
const NEW_NAME = /^[A-Za-z0-9*][A-Za-z0-9 ._#+*,-]*$/;

function canStartHere(n) {
  return !!n && LOCAL_PAGE && !!(S.snap && S.snap.actions && S.snap.actions.newAgent) && isSession(n) && n.kind !== 'reviewer' && NEW_FROM.test(n.key);
}

function newAgentName(a) {
  return String(a.name || '').replace(/\s+/g, ' ').trim();
}

function newNameProblem(name) {
  if (!name) return 'Type a name for the new agent.';
  if (name.length > MAX_NAME) return `Use ${MAX_NAME} letters or fewer for the name.`;
  if (!NEW_NAME.test(name) || !/[A-Za-z0-9]/.test(name)) return 'Use only letters, digits, spaces and . _ - # + * , signs in the name, and start it with a letter or a digit.';
  return '';
}

function newHtml(n, d) {
  if (!canStartHere(n)) return '';
  const a = d.newAgent;
  if (!a) {
    return (
      '<div class="dnew"><button type="button" class="btn" data-new="open" aria-describedby="d-new-help">New agent here…</button>' +
      '<p class="help" id="d-new-help">Start a new Claude Code or Codex session in this folder, in a PowerShell window.</p></div>'
    );
  }
  const name = newAgentName(a);
  const where = n.project ? ` (${esc(n.project)})` : '';
  const radio = (tool, label) => `<label><input type="radio" name="d-new-tool" id="d-new-${tool}" value="${tool}"${a.tool === tool ? ' checked' : ''}>${label}</label>`;
  const rename = a.tool === 'codex'
    ? `<p class="help">Codex cannot take a name when it starts. After its first message, type <code>/rename ${esc(name || 'name')}</code> in the new window.</p>` +
      (name ? '<div class="roll-btns"><button type="button" class="btn" data-copy="new-rename">Copy the name command</button></div>' : '')
    : '';
  return (
    '<section class="droll dnew open" aria-labelledby="d-new-title">' +
    '<div class="droll-head"><h3 id="d-new-title" tabindex="-1">New agent here</h3><button type="button" class="btn" data-new="close">Close</button></div>' +
    `<p class="note">Pleni opens a new PowerShell window in this session's folder${where} and starts a new agent there. You type its first message in that window. Pleni sends it nothing.</p>` +
    `<div class="dnew-row" role="radiogroup" aria-labelledby="d-new-tool-lbl"><span class="lbl" id="d-new-tool-lbl">Tool</span><div class="checks">${radio('claude', 'Claude Code')}${radio('codex', 'Codex')}</div></div>` +
    `<div class="dnew-row"><label for="d-new-name">Name</label><input class="field" id="d-new-name" type="text" value="${esc(a.name)}" maxlength="${MAX_NAME}" autocomplete="off" spellcheck="false"${a.bad ? ' aria-invalid="true"' : ''} aria-describedby="d-new-name-help">` +
    '<p class="help" id="d-new-name-help">For example Sergeant 3. Letters, digits, spaces and . _ - # + * , signs. The relay and your chain of command rules find agents by name.</p></div>' +
    '<div class="roll-btns"><button type="button" class="btn primary" data-new="start">Start in PowerShell</button></div>' +
    `<p class="roll-msg${a.msg && a.msg.bad ? ' bad' : ''}">${a.msg ? esc(a.msg.text) : ''}</p>` +
    rename +
    '</section>'
  );
}

function newClick(what) {
  const d = S.drawer;
  if (!d) return;
  if (what === 'open') {
    d.newAgent = { tool: d.key.startsWith('codex:') ? 'codex' : 'claude', name: '', msg: null, bad: false, busy: false };
    renderDrawerParts();
    $('#d-new-name')?.focus();
  } else if (what === 'close') {
    d.newAgent = null;
    renderDrawerParts();
    $('#drawer [data-new="open"]')?.focus();
  } else if (what === 'start') {
    newStart();
  }
}

async function newStart() {
  const d = S.drawer;
  const a = d && d.newAgent;
  if (!a || a.busy) return;
  const name = newAgentName(a);
  const problem = newNameProblem(name);
  if (problem) {
    a.bad = true;
    a.msg = { text: problem, bad: true };
    renderDrawerParts();
    say(problem);
    $('#d-new-name')?.focus();
    return;
  }
  a.bad = false;
  a.busy = true;
  a.msg = { text: 'Opening a PowerShell window…' };
  renderDrawerParts();
  try {
    await postJson('/api/new', { from: d.key, tool: a.tool, name });
    a.msg = {
      text: a.tool === 'codex'
        ? `A PowerShell window is opening with Codex. Type its first message there, then /rename ${name}.`
        : `A PowerShell window is opening with a new Claude Code session named "${name}". Type its first message there.`,
    };
  } catch (err) {
    a.msg = { text: `Not started. ${plainError(err)}`, bad: true };
  } finally {
    a.busy = false;
    say(a.msg.text); // the message by the button is not a live region: it is rebuilt with the panel
    if (S.drawer === d && d.newAgent === a) renderDrawerParts();
  }
}

async function newCopy() {
  const d = S.drawer;
  const a = d && d.newAgent;
  const name = a ? newAgentName(a) : '';
  if (!name) return;
  try {
    await navigator.clipboard.writeText(`/rename ${name}`);
    a.msg = { text: 'Copied the name command.' };
  } catch {
    a.msg = { text: 'The browser did not allow copying. Select the text and copy it yourself.', bad: true };
  }
  say(a.msg.text);
  if (S.drawer === d) renderDrawerParts();
}

// ---- Bring a cloud session here ----
// A window in this Claude Code session's folder that runs claude --teleport, where the person picks
// one of their claude.ai cloud sessions to go on with on this computer.

const TELEPORT_FROM = /^claude:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function teleportHtml(n) {
  if (!n || !LOCAL_PAGE || !(S.snap && S.snap.actions && S.snap.actions.teleport) || n.kind !== 'session' || !TELEPORT_FROM.test(n.key)) return '';
  return (
    `<div class="dnew"><button type="button" class="btn" data-teleport="${esc(n.key)}" aria-describedby="d-teleport-help">Bring a cloud session here</button>` +
    '<p class="help" id="d-teleport-help">Opens a PowerShell window in this folder that runs <code>claude --teleport</code>. Pick one of your claude.ai cloud sessions there, and it goes on on this computer, where Pleni shows it.</p></div>'
  );
}

async function teleportHere(btn) {
  const key = btn.dataset.teleport;
  const here = S.drawer ? S.drawer.key : key;
  if (!key || opening.has(`teleport:${key}`)) return;
  opening.add(`teleport:${key}`);
  showMoved({ key: here, spot: 'note', text: 'Opening a PowerShell window…' });
  try {
    await postJson('/api/teleport', { from: key });
    showMoved({ key: here, spot: 'note', text: 'A PowerShell window is opening with your cloud sessions. Pick one there. If Claude Code asks you to save or push your changes first, do that, then try again.' });
  } catch (err) {
    showMoved({ key: here, spot: 'note', bad: true, fadeMs: OPEN_ERROR_MS, text: `Not opened. ${plainError(err)}` });
  } finally {
    opening.delete(`teleport:${key}`);
  }
}

// ---- Send a message ----
// The Chat tab of a main Claude Code session or Codex thread, on this computer, when Send is on. The
// person types a message and Pleni sends it as one hidden turn of that session, the same as typing it
// there (src/send.js): the message goes to the program's standard input, never onto a command line.
// The answer shows here as Pleni reads it from the session's own file, like every other event.

const SEND_REFRESH_MS = 4000; // how often the open Chat tab asks whether a message can go out
const MAX_SEND = 8000; // the longest message the server takes
const SEND_COUNT_FROM = 7000; // the count shows from here on
const drafts = new Map(); // session key -> a message typed but not sent yet, kept while the page is open

function canSend(n) {
  return !!n && LOCAL_PAGE && !!(S.snap && S.snap.actions && S.snap.actions.send) && n.kind === 'session' && ROLL_KEY.test(n.key);
}

function newSendState(key) {
  return { text: drafts.get(key) || '', id: null, busy: false, msg: null, info: null, at: 0, loading: false, loadError: null, waiting: false, result: null };
}

// One id per message, so a send that is tried again after a lost answer is not sent twice.
function newSendId() {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

// The tab is built once; afterwards only the conversation and the lines under the box change, so a
// repaint never touches what the person is typing.
function chatFrameHtml() {
  return (
    '<div class="dchat">' +
    '<ol class="dev dchat-log" id="d-chat-log" aria-label="Conversation"></ol>' +
    '<div class="dchat-form">' +
    '<label for="d-chat-text">Message</label>' +
    `<textarea class="field" id="d-chat-text" rows="4" maxlength="${MAX_SEND}" aria-describedby="d-chat-help d-chat-state"></textarea>` +
    '<div class="roll-btns"><button type="button" class="btn primary" id="d-chat-send">Send</button><span class="dchat-count" id="d-chat-count"></span></div>' +
    '<p class="help" id="d-chat-help"></p>' +
    '<p class="roll-msg" id="d-chat-state" role="status"></p>' +
    '</div></div>'
  );
}

function paintChat(n, d) {
  const panel = $('#dpanel-chat');
  if (!panel) return;
  const s = d.send;
  if (!$('.dchat-form', panel)) {
    panel.innerHTML = chatFrameHtml();
    $('#d-chat-text').value = s.text;
  }
  if (d.tab === 'chat' && !s.loading && Date.now() - s.at > SEND_REFRESH_MS) sendLoad();
  const log = $('#d-chat-log');
  const atEnd = log.scrollHeight - log.scrollTop - log.clientHeight < 48;
  if (setHtml(log, chatLogHtml(n, d)) && atEnd) log.scrollTop = log.scrollHeight;
  setText($('#d-chat-help'), sendHelp(n, s));
  const state = sendState(s);
  const line = $('#d-chat-state');
  setText(line, state.text);
  line.classList.toggle('bad', !!state.bad);
  const btn = $('#d-chat-send');
  btn.setAttribute('aria-disabled', String(!!sendBlocked(s)));
  setText(btn, s.busy ? 'Sending…' : 'Send');
  const length = ($('#d-chat-text').value || '').length;
  setText($('#d-chat-count'), length >= SEND_COUNT_FROM ? `${length} of ${MAX_SEND} characters` : '');
}

// The messages to the session and its answers, oldest first, newest at the bottom.
function chatLogHtml(n, d) {
  if (d.error) return `<li class="empty">Could not load the conversation. ${esc(d.error)}</li>`;
  if (!d.loaded) return '<li class="empty">Loading the conversation…</li>';
  const said = d.events.filter((e) => (e.kind === 'user' || e.kind === 'assistant' || e.kind === 'error') && e.text);
  if (!said.length) {
    return d.events.length
      ? '<li class="empty">Nothing to show here. Snippets are turned off in Settings, or there are no messages yet.</li>'
      : '<li class="empty">No messages yet.</li>';
  }
  const label = (e) => (e.kind === 'user' ? 'Message' : e.kind === 'error' ? 'Error' : titleOf(n));
  return said
    .slice(-60)
    .map((e) => `<li class="k-${e.kind}">${timeHtml(e.at, clock(e.at, true)) || '<span></span>'}<div><span class="k">${esc(label(e))}</span><div class="tx">${esc(e.text)}</div></div></li>`)
    .join('');
}

function sendHelp(n, s) {
  const plan = n.platform === 'codex' ? 'ChatGPT' : 'Claude';
  const what = s.info && s.info.mode === 'edit'
    ? 'It may read files, answer, and change files in its folder.'
    : 'It may read files and answer. It cannot change files (Settings, Buttons).';
  return `Pleni sends it as one turn of this session, as if you typed it there, and the answer shows above. ${what} Each message uses your ${plan} plan. Ctrl+Enter sends.`;
}

// Why the Send button would not send now, or ''.
function sendBlocked(s) {
  if (s.busy) return 'Sending…';
  if (!s.info) return '';
  if (s.info.running) return 'Pleni is still waiting for the answer to your last message.';
  return s.info.problem || '';
}

// The line under the box: what happened to the last message, else why a message cannot go out now.
function sendState(s) {
  if (s.busy) return { text: 'Sending…' };
  if (s.msg && s.msg.bad) return s.msg;
  if (s.waiting) return { text: 'Sent. Pleni is waiting for the answer…' };
  if (s.result === 'ok') return { text: 'Answered. The answer is above.' };
  if (s.result === 'bad') return { text: 'The turn ended with an error. Open the session to see what happened.', bad: true };
  if (s.msg) return s.msg;
  if (s.loadError) return { text: `Pleni could not check this session just now. ${s.loadError}`, bad: true };
  if (s.info && s.info.problem) return { text: s.info.problem };
  return { text: '' };
}

async function sendLoad() {
  const d = S.drawer;
  const s = d && d.send;
  if (!s || s.loading || d.frame !== 'chat') return;
  s.loading = true;
  try {
    const info = await getJson(`/api/send?key=${encodeURIComponent(d.key)}`);
    if (S.drawer !== d) return;
    s.info = info && typeof info === 'object' ? info : null;
    s.loadError = null;
    if (s.waiting && s.info && !s.info.running) {
      s.waiting = false;
      s.result = s.info.last ? (s.info.last.ok ? 'ok' : 'bad') : null;
      say(sendState(s).text);
    }
  } catch (err) {
    if (S.drawer === d) s.loadError = plainError(err);
  } finally {
    s.loading = false;
    s.at = Date.now();
    if (S.drawer === d && d.frame === 'chat') paintChat(S.index && S.index.byKey.get(d.key), d);
  }
}

async function sendChat() {
  const d = S.drawer;
  const s = d && d.send;
  if (!s || s.busy) return;
  const n = S.index && S.index.byKey.get(d.key);
  const box = $('#d-chat-text');
  const text = (box ? box.value : s.text).trim();
  const refuse = (msg) => {
    s.msg = { text: msg, bad: true };
    paintChat(n, d);
    say(msg);
    if (box) box.focus();
  };
  if (!text) return refuse('Type a message first.');
  if (text.length > MAX_SEND) return refuse(`This message is too long. Keep it to ${MAX_SEND} characters or fewer.`);
  const blocked = sendBlocked(s);
  if (blocked) return refuse(blocked);
  s.id = s.id || newSendId();
  s.busy = true;
  s.msg = null;
  s.result = null;
  paintChat(n, d);
  try {
    const body = await postJson('/api/send', { key: d.key, text, id: s.id });
    s.id = null;
    s.text = '';
    drafts.delete(d.key);
    if (S.drawer === d && box) box.value = '';
    s.waiting = true;
    s.msg = { text: body && body.repeat ? 'This message was sent already. Pleni is waiting for the answer…' : 'Sent. Pleni is waiting for the answer…' };
  } catch (err) {
    s.msg = { text: `Not sent. ${plainError(err)}`, bad: true };
  } finally {
    s.busy = false;
    say(s.msg.text);
    if (S.drawer === d) {
      s.at = 0; // ask again at once
      paintChat(S.index && S.index.byKey.get(d.key), d);
      if (box && !s.msg.bad) box.focus();
      fetchDrawerEvents();
    }
  }
}

// ---- Roll over soon ----
// The reasons come from Pleni (settings.rollSoon): memory nearly full, squeezed often, or old.

function rollSoonText(n) {
  return n && Array.isArray(n.rollSoon) && n.rollSoon.length ? `roll over soon: ${n.rollSoon.join(', ').toLowerCase()}` : '';
}

// ---- agent mail ----
// Agents send each other mail by name with the relay's agent-mail.ps1 (relay/README.md). Pleni only
// shows it: the Mail page reads it whole, and answers go through agent-mail.ps1 in PowerShell.

// "2 new messages" when mail waits for a tile, else ''.
function mailText(n) {
  const unread = n && n.mail ? num(n.mail.unread) : 0;
  return unread > 0 ? plural(unread, 'new message', 'new messages') : '';
}

// The drawer's mail lines: what waits for this tile and what wakes it to read it, or for the
// person, where to read their mail; and mail this tile sent the person that they have not read.
function mailHtml(n) {
  const m = n && n.mail;
  if (!m) return '';
  const you = n.kind === 'person';
  const who = you ? 'you' : 'it';
  const unread = num(m.unread);
  const name = str(m.name);
  const parts = [unread > 0 ? `${esc(plural(unread, 'new message waits', 'new messages wait'))} for ${who}.` : `No new mail for ${who}.`];
  if (unread > 0 && isTime(m.since)) parts.push(`The first came ${agoHtml(m.since)}.`);
  if (you) parts.push(`<a href="#/mail">${unread > 0 ? `Read ${unread === 1 ? 'it' : 'them'} on the Mail page` : 'Open the Mail page'}</a>.`);
  if (!you) parts.push(m.wakes ? 'The relay wakes it when mail comes.' : 'Nothing wakes it for mail. It sees mail only when it checks.');
  const out = [`<p class="dnow mail"><b>Mail${name ? ` for ${esc(name)}` : ''}:</b> ${parts.join(' ')}</p>`];
  const toYou = num(m.toYou);
  if (!you && toYou > 0) {
    out.push(`<p class="dnow mail"><b>Mail for you:</b> ${esc(`It sent you ${plural(toYou, 'message', 'messages')} you have not read.`)} <a href="#/mail">Read ${toYou === 1 ? 'it' : 'them'} on the Mail page</a>.</p>`);
  }
  return out.join('');
}

// The command that answers a message: agent-mail.ps1 by its full path when Pleni knows the mailbox
// folder, so it runs from any folder. PowerShell writes a ' inside '...' as ''.
function mailAnswerCommand(me, to) {
  const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
  const root = S.roots && typeof S.roots.mailbox === 'string' ? S.roots.mailbox.replace(/[\\/]+$/, '') : '';
  const sep = root.includes('/') && !root.includes('\\') ? '/' : '\\';
  const script = root ? `& ${q(`${root}${sep}bin${sep}agent-mail.ps1`)}` : '.\\bin\\agent-mail.ps1';
  return `${script} -Send -From ${q(me)} -To ${q(to)} -Text 'your answer'`;
}

// ---- the Mail page ----

function paintMailNav() {
  const m = S.snap && S.snap.mail;
  $('#nav-mail').hidden = !m;
  const unread = m ? num(m.unread) : 0;
  const count = $('#nav-mail-count');
  count.hidden = unread <= 0;
  setText(count, unread > 0 ? String(unread) : '');
  const link = $('#nav-mail a');
  if (link) link.setAttribute('aria-label', unread > 0 ? `Mail, ${plural(unread, 'new message', 'new messages')}` : 'Mail');
}

// The page asks again when new mail comes, when mail is read, or when the list changes.
function mailWant() {
  const m = S.snap && S.snap.mail;
  return m ? `${S.mail.all ? 'all' : 'you'}|${num(m.lastAt)}|${num(m.unread)}` : '';
}

async function askMail() {
  if (S.mail.asking) return;
  const want = mailWant();
  S.mail.asking = true;
  try {
    const data = await getJson(`/api/mail${S.mail.all ? '?all=1' : ''}`);
    S.mail.data = data && typeof data === 'object' ? data : null;
    S.mail.error = '';
  } catch (err) {
    S.mail.error = plainError(err);
  } finally {
    S.mail.key = want;
    S.mail.asking = false;
    if (S.view === 'mail') renderMail();
  }
}

// The mailbox folder, for the answer command's full path.
function needRoots() {
  if (S.roots || S.rootsAsked) return;
  S.rootsAsked = true;
  getJson('/api/settings')
    .then((info) => {
      S.roots = (info && info.roots) || {};
      if (S.view === 'mail') renderMail();
    })
    .catch(() => {});
}

function renderMail() {
  const box = $('#mail');
  const m = S.snap && S.snap.mail;
  setHtml(
    $('#mail-filters'),
    m
      ? [['you', 'With you'], ['all', 'All mail']]
        .map(([key, label]) => `<button type="button" class="chip" data-mail-show="${key}" aria-pressed="${(key === 'all') === S.mail.all}">${esc(label)}</button>`)
        .join('')
      : '',
  );
  if (!m) {
    setText($('#mail-meta'), '');
    setHtml(box, '<p class="empty">No agent mail here yet. When your agents write to each other, or to you, with the relay\'s agent-mail.ps1, it shows up here.</p>');
    return;
  }
  setText($('#mail-meta'), S.mail.all ? 'All mail between your agents and with you, newest first.' : 'Mail between you and your agents, newest first.');
  needRoots();
  if (S.mail.key !== mailWant()) askMail();
  const d = S.mail.data;
  if (!d) {
    setHtml(box, S.mail.error ? `<p class="empty">Could not load the mail. ${esc(S.mail.error)}</p>` : '<p class="empty">Loading the mail…</p>');
    return;
  }
  const readAt = isTime(d.readAt) ? d.readAt : null;
  const me = str(d.name) || str(m.name) || personName();
  const list = (Array.isArray(d.messages) ? d.messages : []).filter((x) => x && isTime(x.at));
  const isNew = (x) => x.toYou === true && x.unread === true && !(readAt !== null && x.at <= readAt);
  const fresh = list.filter(isNew);
  const newest = fresh.reduce((at, x) => Math.max(at, x.at), 0);
  S.mail.cmds = [];
  const items = list.map((x) => mailItemHtml(x, isNew(x), me));
  const msg = S.mail.msg ? `<p class="roll-msg${S.mail.msg.bad ? ' bad' : ''}" role="status">${esc(S.mail.msg.text)}</p>` : '';
  setHtml(
    box,
    `<div class="mail-bar"><p>${fresh.length ? esc(plural(fresh.length, 'new message for you.', 'new messages for you.')) : 'No new mail for you.'}</p>` +
      (fresh.length ? `<button type="button" class="btn" data-mail-read="${esc(newest)}">Mark all as read</button>` : '') +
      `</div>${msg}<p class="note">Pleni shows your mail but never sends it. To answer, copy the command under a message and run it in PowerShell. Marking mail as read here changes only what Pleni shows: the mail stays in its folder.</p>` +
      (list.length ? `<ol class="mail-list">${items.join('')}</ol>` : `<p class="empty">${S.mail.all ? 'No mail yet.' : 'No mail with you yet.'}</p>`),
  );
}

function mailItemHtml(x, fresh, me) {
  const from = x.fromYou ? 'You' : str(x.fromName) || str(x.from) || 'Someone';
  const to = x.toYou ? 'you' : str(x.toName) || str(x.to) || 'someone';
  const state = fresh ? '<span class="pill mail-new">New</span>' : !x.toYou && x.unread === true ? '<span class="pill">Not read yet</span>' : '';
  const text = typeof x.text === 'string'
    ? `<div class="mail-text">${esc(x.text)}</div>`
    : '<p class="note">The message is hidden: session text is off in Settings.</p>';
  let answer = '';
  if (x.toYou && !x.fromYou) {
    const i = S.mail.cmds.push(mailAnswerCommand(me, str(x.fromName) || str(x.from))) - 1;
    answer = `<div class="mail-answer"><code>${esc(S.mail.cmds[i])}</code><button type="button" class="btn" data-mail-copy="${i}">Copy the answer command</button></div>`;
  }
  return (
    `<li class="mail-msg${fresh ? ' is-new' : ''}"><div class="mail-head"><span class="mail-who"><b>${esc(from)}</b> to <b>${esc(to)}</b></span>${state}` +
    `${timeHtml(x.at, stamp(x.at))}</div>${text}${answer}</li>`
  );
}

async function mailCopy(i) {
  const text = S.mail.cmds[i];
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    S.mail.msg = { text: 'Copied. Paste it in PowerShell, put your answer in place of "your answer", and press Enter.' };
  } catch {
    S.mail.msg = { text: 'The browser did not allow copying. Select the command and copy it yourself.', bad: true };
  }
  say(S.mail.msg.text);
  renderMail();
}

// Marks the person's mail read up to the newest new message, in Pleni only (a dismissal).
async function markMailRead(at) {
  if (!isTime(at)) return;
  try {
    await postJson('/api/dismiss', { id: MAIL_READ_ID, at });
    S.mail.msg = { text: 'Marked as read in Pleni.' };
  } catch (err) {
    S.mail.msg = { text: `Not marked as read. ${plainError(err)}`, bad: true };
  }
  say(S.mail.msg.text);
  await pollNow().catch(() => {});
  S.mail.key = '';
  renderMail();
}

// ['Memory 87% full', 'Squeezed 3 times'] -> 'Memory 87% full, squeezed 3 times.'
function sentence(parts) {
  return `${parts.map((p, i) => (i ? p.charAt(0).toLowerCase() + p.slice(1) : p)).join(', ')}.`;
}

function tokensText(count) {
  if (count >= 1e6) return `${(count / 1e6).toFixed(count >= 1e7 ? 0 : 1).replace(/\.0$/, '')}M`;
  if (count >= 1e3) return `${Math.round(count / 1e3)}k`;
  return String(count);
}

// How full the context (the model's memory of the conversation) is.
function memoryWords(m) {
  if (m.used === null || m.used === undefined) return '';
  if (!m.size) return `${tokensText(m.used)} tokens in use`;
  return `${tokensText(m.used)} of ${tokensText(m.size)} tokens (${m.percent}% full)`;
}

// How often the history was squeezed into a summary (compacted), and when last.
function squeezedHtml(m) {
  if (!m.squeezes) return m.squeezesAtLeast ? 'Not in the part Pleni read' : 'Never';
  const times = m.squeezes === 1 ? 'Once' : m.squeezes === 2 ? 'Twice' : `${m.squeezes} times`;
  const more = m.squeezesAtLeast ? ' or more' : '';
  return `${esc(times + more)}${isTime(m.squeezedAt) ? `, last ${agoHtml(m.squeezedAt)}` : ''}`;
}

// ---- Hide from the map ----

const HIDE_KEY = /^(claude|codex|grok|kimi):/;
const hiding = new Set(); // tiles whose Hide is on its way to Pleni

function hideHtml(n) {
  if (!n || !isSession(n) || !HIDE_KEY.test(n.key)) return '';
  return (
    `<div class="dhide"><button type="button" class="btn" data-hide="${esc(n.key)}" data-title="${esc(titleOf(n))}" aria-describedby="d-hide-help">Hide from the map</button>` +
    '<p class="help" id="d-hide-help">For an old or test session. Nothing is deleted. To show it again, go to Settings, then Team.</p></div>'
  );
}

// Hides a session (Role: Hide it). The side panel closes, since its tile is gone, and the notice at
// the bottom of the page offers Undo, which puts back the role it had before.
async function hideNode(key, title) {
  if (!key || hiding.has(key)) return;
  hiding.add(key);
  let before = null;
  try {
    const answer = await postJson('/api/hide', { key, hide: true });
    before = answer && typeof answer.role === 'string' ? answer.role : null;
  } catch (err) {
    hiding.delete(key);
    showMoved({ key, spot: 'note', bad: true, text: `Not hidden. ${plainError(err)}` });
    return;
  }
  keepPersonField(key, 'role', 'hidden'); // so saving Settings later keeps it
  hiding.delete(key);
  if (S.drawer && S.drawer.key === key) closeDrawer();
  await pollNow().catch(() => {});
  showMoved({ key, spot: 'note', text: `Hidden from the map: "${title}". To show it again later, go to Settings, then Team.`, undo: () => unhideNode(key, title, before) });
}

async function unhideNode(key, title, role) {
  try {
    await postJson('/api/hide', { key, hide: false, role });
  } catch (err) {
    showMoved({ key, spot: 'note', bad: true, text: `Not undone. ${plainError(err)}` });
    return;
  }
  keepPersonField(key, 'role', role || undefined);
  await pollNow().catch(() => {});
  showMoved({ key, spot: 'note', text: `"${title}" is on the map again.` });
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
  return `<p class="dnow">${esc(cap(countsPlain(c)))}.</p>${mailHtml(n)}<h3>${heading}</h3>${list ? `<ul class="kids">${list}</ul>` : '<p class="empty">Nothing listed right now.</p>'}`;
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
  if (isSession(n) && typeof n.github === 'string' && GITHUB_PATH.test(n.github)) {
    add('GitHub', `<span class="gh-links">${githubLink(n.github, '', n.github)}${branchLinks(n.github, n.subtitle)}</span>`);
  }
  if (isSession(n)) {
    add('Model', esc([n.modelLabel || prettyModel(n.model), n.model && n.modelLabel !== n.model ? `(${n.model})` : ''].filter(Boolean).join(' ')));
    add('Effort', esc(EFFORT_WORDS[n.effort] || n.effort || ''));
    add('Worker type', esc(n.workerType || ''));
    if (n.chosen) add('Who chose them', esc(chosenWords(n.chosen)));
    add('Tier', esc(n.tier === 'senior' ? 'Senior' : n.tier === 'junior' ? 'Junior' : ''));
    if (n.memory) {
      add('Memory', esc(memoryWords(n.memory)));
      add('Squeezed', squeezedHtml(n.memory));
    }
    add('Started', isTime(n.startedAt) ? timeHtml(n.startedAt, stamp(n.startedAt)) : '');
    add('Last active', isTime(n.lastAt) ? `${timeHtml(n.lastAt, stamp(n.lastAt))} (${agoHtml(n.lastAt)})` : '');
    add('Archived', n.archived ? 'Yes' : '');
  }
  add('Key', `<span class="mono">${esc(n.key)}</span>`);
  const from = isRelay(n) || isWorkerKey(n.key) ? 'Read from the mailbox folder on this computer. Pleni never changes it.' : 'Read from the session files on this computer. Pleni never changes them.';
  const defaults = n.chosen && !(n.chosen.model && n.chosen.effort)
    ? "<p class=\"note\">Defaults: a worker gets its type's model, else the worker model in Settings &gt; Models, else the model of the session that started it. It gets its type's effort, else the effort of that session.</p>"
    : '';
  return `<table class="facts-t"><tbody>${rows.join('')}</tbody></table>${defaults}<p class="note">${from}</p>`;
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
  keepPersonField(key, 'reportsTo', reportsTo || undefined);
}

// Puts one field of a tile's entry (people[key]) into Settings' copy; undefined removes it.
function keepPersonField(key, field, value) {
  const st = S.set;
  if (!st || !st.info) return;
  for (const s of [st.info.settings, st.draft]) {
    if (!s || typeof s !== 'object') continue;
    const people = s.people && typeof s.people === 'object' ? s.people : {};
    const entry = { ...(own(people, key) || {}) };
    if (value !== undefined) entry[field] = value;
    else delete entry[field];
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
  // A bad move stays until the next one; a message with `fadeMs` goes away even when it is bad.
  if (!(here && msg.bad) || msg.fadeMs) moved.timer = setTimeout(fadeMoved, msg.fadeMs || MOVED_MS);
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
  if (ev.target.id === 'd-chat-text' && ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) {
    ev.preventDefault();
    sendChat();
    return;
  }
  if (ev.target.id === 'd-new-name' && ev.key === 'Enter') {
    ev.preventDefault();
    newStart();
    return;
  }
  if (ev.target.id !== 'd-boss') return;
  // Enter sends a pick made with the arrow keys at once.
  if (ev.key === 'Enter') {
    keyedAt = 0;
    sendPick();
  } else {
    keyedAt = Date.now();
  }
});
drawerBox.addEventListener('input', (ev) => {
  if (ev.target.id === 'd-chat-text' && S.drawer) {
    const d = S.drawer;
    const s = d.send;
    s.text = ev.target.value;
    if (s.text) drafts.set(d.key, s.text);
    else drafts.delete(d.key);
    s.id = null; // a changed message is a new message
    if (!s.busy) {
      s.msg = null;
      s.result = null;
    }
    paintChat(S.index && S.index.byKey.get(d.key), d);
    return;
  }
  const a = S.drawer && S.drawer.newAgent;
  if (!a || ev.target.id !== 'd-new-name') return;
  a.name = ev.target.value;
  if (a.bad) {
    a.bad = false;
    ev.target.removeAttribute('aria-invalid');
  }
});
drawerBox.addEventListener('change', (ev) => {
  if (ev.target.name === 'd-new-tool' && S.drawer && S.drawer.newAgent) {
    S.drawer.newAgent.tool = ev.target.value;
    return void renderDrawerParts();
  }
  if (ev.target.id === 'd-watch') return void setWatch(ev.target);
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
const OPEN_ERROR_MS = 20000; // how long "Not opened" stays: long enough to read, short enough not to look stuck

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
    // It fades, so the button does not look stuck once the reason has passed.
    showMoved({ key: here, spot: 'note', bad: true, fadeMs: OPEN_ERROR_MS, text: `Not opened. ${plainError(err)}` });
  } finally {
    opening.delete(key);
  }
}

// Roll over: the section in a session's side panel. Pleni builds both messages; the page only
// shows them and says which step to take.
function rollClick(what) {
  const d = S.drawer;
  if (!d) return;
  if (what === 'open') {
    d.roll = { info: null, error: '', loading: false, at: 0, busy: '', msg: {} };
    rollLoad();
    renderDrawerParts();
    $('#d-roll-title')?.focus();
  } else if (what === 'close') {
    d.roll = null;
    renderDrawerParts();
    $('#drawer [data-roll="open"]')?.focus();
  } else if (what === 'ask' || what === 'start') {
    rollStep(what);
  }
}

async function rollLoad() {
  const d = S.drawer;
  const r = d && d.roll;
  if (!r || r.loading) return;
  r.loading = true;
  try {
    const info = await getJson(`/api/rollover?key=${encodeURIComponent(d.key)}`);
    r.info = info;
    r.error = '';
  } catch (err) {
    r.error = plainError(err);
  } finally {
    r.loading = false;
    r.at = Date.now();
    if (S.drawer === d && d.roll === r) renderDrawerParts();
  }
}

async function rollStep(step) {
  const d = S.drawer;
  const r = d && d.roll;
  if (!r || !r.info || !r.info.name || r.busy) return;
  r.busy = step;
  r.msg[step] = { text: 'Opening a PowerShell window…' };
  renderDrawerParts();
  try {
    await postJson('/api/rollover', { key: d.key, step, name: r.info.name });
    r.msg[step] = {
      text: step === 'ask'
        ? 'A PowerShell window is opening with this session. Look for it on your taskbar, and watch it write the note.'
        : 'A PowerShell window is opening with the new session. Look for it on your taskbar.',
    };
  } catch (err) {
    r.msg[step] = { text: `Not opened. ${plainError(err)}`, bad: true };
  } finally {
    say(r.msg[step].text); // the message by the button is not a live region: it is rebuilt with the panel
    r.busy = '';
    if (S.drawer === d && d.roll === r) {
      renderDrawerParts();
      rollLoad();
    }
  }
}

const COPIED = { ask: 'Copied the message for the old session.', start: 'Copied the message for the new session.', rename: 'Copied the name command.' };

// The page that can roll over runs on this computer, where the browser allows copying. The answer
// shows under the step the button belongs to.
async function rollCopy(which) {
  const d = S.drawer;
  const r = d && d.roll;
  const text = r && r.info && r.info[which];
  if (!text) return;
  let said;
  try {
    await navigator.clipboard.writeText(text);
    said = { text: COPIED[which] || 'Copied.' };
  } catch {
    said = { text: 'The browser did not allow copying. Select the text and copy it yourself.', bad: true };
  }
  r.msg[which] = said;
  say(said.text);
  if (S.drawer === d) renderDrawerParts();
}

// ---------------------------------------------------------------------------------------------
// settings
// ---------------------------------------------------------------------------------------------

// The tabs on the Settings page, in order. Each one holds a few short sections.
const SETTINGS_GROUPS = [
  ['basics', 'Basics'],
  ['team', 'Team'],
  ['models', 'Models'],
  ['sources', 'Sources'],
  ['alerts', 'Alerts'],
  ['buttons', 'Buttons'],
  ['devices', 'Devices'],
];

function settingsState() {
  if (!S.set) S.set = { info: null, draft: null, msg: null, search: '', error: null, group: SETTINGS_GROUPS[0][0], find: '' };
  return S.set;
}

// ---- other devices ----
// On this computer, Settings shows the addresses for other devices, copies the key or a sign-in
// link, and lists devices Pleni turned away lately, with Allow. It asks again every few seconds
// while the Devices group is open, so a device that just tried shows up.
const DEVICES_REFRESH_MS = 5000;

async function loadDevices(force) {
  const st = S.set;
  if (!LOCAL_PAGE || !st || !st.info) return;
  const shown = S.view === 'settings' && (st.group === 'devices' || !!st.find);
  if (!force && (!shown || st.devicesBusy || Date.now() - (st.devicesAt || 0) < DEVICES_REFRESH_MS)) return;
  st.devicesBusy = true;
  try {
    st.devices = await getJson('/api/devices');
    st.devicesError = '';
  } catch (err) {
    st.devicesError = plainError(err);
  } finally {
    st.devicesBusy = false;
    st.devicesAt = Date.now();
  }
  paintDevices();
}

function paintDevices() {
  setHtml($('#devices-box'), devicesHtml());
}

function devicesHtml() {
  const st = S.set;
  const here = `${location.origin}/`;
  if (!LOCAL_PAGE) {
    return `<p>You are using Pleni at <code>${esc(here)}</code>. Bookmark this page to come back: in Chrome, press Ctrl+D.</p>` +
      '<p class="help">The key and the list of devices show only on the computer that runs Pleni.</p>';
  }
  const d = st && st.devices;
  if (!d) return `<p class="help">${esc(st && st.devicesError ? `Could not read this. ${st.devicesError}` : 'Loading…')}</p>`;
  const addresses = Array.isArray(d.addresses) ? d.addresses : [];
  const waiting = (Array.isArray(d.knocks) ? d.knocks : []).filter((k) => k && !k.allowed);
  const out = [`<p>On this computer: <code>${esc(here)}</code></p>`];
  if (addresses.length) {
    out.push(
      '<p>On your other devices, open this address and bookmark it:</p><ul class="addr-list">' +
        addresses.map((a, i) => `<li><code>${esc(a)}</code><button type="button" class="btn" data-copy-addr="${i}">Copy the address</button></li>`).join('') +
        '</ul>',
    );
  } else {
    out.push(
      '<p>No other device is set up yet. To set one up:</p><ol class="steps">' +
        `<li>On this computer, in PowerShell, run <code>tailscale serve --bg ${esc(location.port || String(getPath(st.draft, 'port', 8790)))}</code>. It shows an address such as <code>https://my-pc.tail1234.ts.net</code>.</li>` +
        '<li>Open that address on your other device, with Tailscale on. Pleni turns it away the first time, and it shows up here.</li>' +
        '<li>Choose <b>Allow</b> next to it. Then reload the page there.</li></ol>',
    );
  }
  if (waiting.length) {
    out.push(
      '<h3 class="sub-h">Turned away lately</h3><ul class="knocks">' +
        waiting.map((k, i) =>
          `<li><span><code>${esc(k.host)}</code> as <b>${esc(k.login)}</b>, ${agoHtml(k.at)}</span>` +
          `<button type="button" class="btn primary" data-allow="${i}">Allow</button></li>`).join('') +
        '</ul><p class="help">Allow only your own devices, or people you trust with your work: they see everything you see here.</p>',
    );
  }
  out.push(
    '<p>The first time, Pleni on the other device asks for its key.</p>' +
      '<div class="roll-btns"><button type="button" class="btn" id="s-key-copy">Copy the key</button>' +
      (addresses.length ? '<button type="button" class="btn" id="s-link-copy">Copy a sign-in link</button>' : '') +
      '</div><p class="help">Paste the key there. A sign-in link holds the key: open it once on the other device and it signs in by itself. Keep both private, like a password.</p>' +
      `<p class="roll-msg${st.devicesMsg && st.devicesMsg.bad ? ' bad' : ''}">${st.devicesMsg ? esc(st.devicesMsg.text) : ''}</p>`,
  );
  return out.join('');
}

async function copyDevices(what, index) {
  const st = S.set;
  const d = st && st.devices;
  if (!d) return;
  const addresses = Array.isArray(d.addresses) ? d.addresses : [];
  const texts = {
    addr: [addresses[index], 'Copied the address.'],
    key: [d.key, 'Copied the key.'],
    link: [addresses[0] && d.key ? `${addresses[0]}?t=${encodeURIComponent(d.key)}` : '', 'Copied a sign-in link.'],
  };
  const [text, done] = texts[what] || [];
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    st.devicesMsg = { text: done };
  } catch {
    st.devicesMsg = { text: 'The browser did not allow copying. Run "node bin/pleni.js --url" in PowerShell to see the address and the key.', bad: true };
  }
  say(st.devicesMsg.text);
  paintDevices();
}

// Allow fills in the host name and the login, and saves at once when nothing else waits to be
// saved; otherwise it leaves Save to the person, so other changes are not saved by surprise.
function allowDevice(index) {
  const st = S.set;
  const waiting = st && st.devices && Array.isArray(st.devices.knocks) ? st.devices.knocks.filter((k) => k && !k.allowed) : [];
  const k = waiting[index];
  if (!k) return;
  const clean = same(st.draft, st.info.settings);
  if (!st.draft.remote || typeof st.draft.remote !== 'object') st.draft.remote = {};
  for (const [field, value] of [['hosts', k.host], ['tailscaleUsers', k.login]]) {
    const list = Array.isArray(st.draft.remote[field]) ? st.draft.remote[field] : [];
    if (!list.some((v) => String(v).toLowerCase() === value)) list.push(value);
    st.draft.remote[field] = list;
  }
  for (const [id, path] of [['s-hosts', 'remote.hosts'], ['s-users', 'remote.tailscaleUsers']]) {
    const field = $(`#${id}`);
    if (field) field.value = getPath(st.draft, path, []).join(', ');
  }
  if (clean) {
    st.devicesMsg = { text: `Allowing ${k.host} for ${k.login}…` };
    paintDevices();
    saveSettings().then(() => loadDevices(true));
  } else {
    st.devicesMsg = { text: 'Added to the lists below. Choose Save settings to keep it.' };
    say(st.devicesMsg.text);
    paintDevices();
    updateSettingsMsg();
  }
}

// ---- models ----
// Settings > Models shows the model and effort Codex and Claude Code agents start with, read from
// their own settings (GET /api/models). With "Let Pleni change the models Codex and Claude Code
// use" saved and on, on this computer, each tool's Save button changes them (POST /api/models with
// its `app`). Each tool's section keeps its own draft, apart from the other settings, and sends only
// what changed, with the tag it was shown.
const MODEL_OTHER = '__other';
const EFFORT_NAMES = { minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max', ultra: 'Ultra' };
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+[\]-]{0,99}$/;
const TYPE_NAME = /^[a-z][a-z0-9_-]{0,39}$/;
const MAX_TYPE_TEXT = 300;
// What differs between the two tools' sections. `p` starts the id of each field.
const MODEL_APPS = {
  codex: { p: 'm', name: 'Codex', blank: 'Codex default', placeholder: 'For example gpt-6.1-sol' },
  claude: { p: 'mc', name: 'Claude Code', blank: 'Claude Code default', placeholder: 'For example opusplan' },
};

// Changes not saved yet are kept when a tool's files are as they were, unless `keep` is false
// (Look again).
async function loadModels(force, keep = true) {
  const st = S.set;
  const m = S.models;
  if (!st || !st.info || m.busy) return;
  const shown = S.view === 'settings' && (st.group === 'models' || !!st.find);
  if (!force && (!shown || m.data)) return;
  m.busy = true;
  try {
    const before = {};
    for (const app of Object.keys(MODEL_APPS)) {
      const c = m.data && m.data[app];
      before[app] = { tag: c ? c.tag : null, dirty: keep && !!m.drafts[app] && Object.keys(modelChanges(app).out).length > 0 };
    }
    m.data = await getJson('/api/models');
    m.error = '';
    for (const app of Object.keys(MODEL_APPS)) {
      const c = m.data[app];
      if (!(before[app].dirty && c && c.ok && c.tag === before[app].tag)) m.drafts[app] = modelsDraft(c);
    }
  } catch (err) {
    m.error = plainError(err);
  } finally {
    m.busy = false;
  }
  for (const app of Object.keys(MODEL_APPS)) paintAppModels(app);
}

// The values on the page: '' means the line is not there.
function modelsDraft(c) {
  if (!c || !c.ok) return null;
  const pick = (lines) => ({ model: (lines.model && lines.model.value) || '', effort: (lines.effort && lines.effort.value) || '' });
  const types = {};
  for (const t of c.types || []) if (!t.error) types[t.file] = pick(t);
  return { sergeant: pick(c.sergeant), worker: pick(c.worker), types, other: {}, add: { name: '', description: '', model: '' } };
}

// Always repaints: a menu the person changed shows its new choice, which the old markup does not.
function paintAppModels(app) {
  const box = $(`#models-${app}`);
  if (!box) return;
  painted.delete(box);
  setHtml(box, appModelsHtml(app));
}

function modelsCanChange(app) {
  const d = S.models.data;
  return !!(d && d.edit && d.here && d[app] && d[app].ok);
}

function appModelsHtml(app) {
  const m = S.models;
  const a = MODEL_APPS[app];
  const again = `<button type="button" class="btn" id="${a.p}-again" data-models-app="${app}" data-models-act="again">Look again</button>`;
  if (!m.data) return m.error ? `<p class="help">Could not read this. ${esc(m.error)}</p>${again}` : '<p class="help">Loading…</p>';
  const c = m.data[app];
  const d = m.drafts[app];
  if (!c || !c.ok || !d) {
    const file = c && c.file ? `<p class="help">The file: <code>${esc(c.file)}</code></p>` : '';
    return `<p class="note">${esc((c && c.error) || `Pleni could not read ${a.name}'s settings.`)}</p>${file}${again}`;
  }
  const claude = app === 'claude';
  const why = !m.data.edit
    ? 'To change these here, tick the box above, then choose Save settings at the bottom of the page.'
    : !m.data.here
      ? 'Models can be changed only on the computer that runs Pleni.'
      : '';
  const kept = c.found
    ? `${a.name} keeps these in <code>${esc(c.file)}</code>.`
    : `${a.name} has no settings file yet. Pleni makes <code>${esc(c.file)}</code> when you save.`;
  const list = claude
    ? " The menus offer Claude Code's short names, which always point at its newest models, and the models your sessions use."
    : c.listed
      ? ' The models are the ones Codex lists for you, so a new model shows up here once Codex knows it.'
      : ' Codex has not listed its models here yet, so Pleni offers the ones your sessions use. Open Codex once to get its list.';
  const sergeantModel = d.sergeant.model;
  const workerModel = d.worker.model || sergeantModel;
  const p = a.p;
  const out = [
    `<p class="note">${kept}${list}${why ? ` ${esc(why)}` : ''}</p>`,
    ...(Array.isArray(c.notes) ? c.notes : []).map((n) => `<p class="note"><strong>Heads up:</strong> ${esc(n)}</p>`),
    `<h3 class="sub-h">Sergeants and new ${claude ? 'sessions' : 'threads'}</h3>`,
    claude
      ? '<p class="help">Claude Code starts new sessions with these. Claude Code keeps an effort for each model.</p>'
      : '<p class="help">Codex starts new threads with these, and the relay wakes agents with them.</p>',
    modelsRowHtml(`${p}-sergeant-model`, 'Model', modelSelectHtml(app, `${p}-sergeant-model`, 'sergeant', d.sergeant.model, c.sergeant.model, a.blank), c.sergeant.model),
    claude && !sergeantModel
      ? modelsRowHtml(`${p}-sergeant-effort`, 'Effort', effortSelectHtml(app, `${p}-sergeant-effort`, 'sergeant', '', '', { editable: false }, a.blank), null, 'Pick a model first. Claude Code keeps an effort for each model.')
      : modelsRowHtml(`${p}-sergeant-effort`, 'Effort', effortSelectHtml(app, `${p}-sergeant-effort`, 'sergeant', sergeantModel, d.sergeant.effort, c.sergeant.effort, a.blank), c.sergeant.effort),
    '<h3 class="sub-h">Workers</h3>',
    claude
      ? "<p class=\"help\">A sergeant can pick the model and effort for each worker it starts. A worker gets this model when it does not. A worker that is a fork of its sergeant (a copy of its whole conversation) always runs on the sergeant's model.</p>"
      : '<p class="help">A sergeant can pick the model and effort for each worker it starts. A worker gets these when it does not.</p>',
    modelsRowHtml(`${p}-worker-model`, 'Model', modelSelectHtml(app, `${p}-worker-model`, 'worker', d.worker.model, c.worker.model, 'Same as its sergeant'), c.worker.model),
    claude
      ? "<div class=\"srow\"><span class=\"lbl\">Effort</span><p class=\"help\">Claude Code has no setting for this. A sergeant can pick the effort for each worker it starts. When it does not, the worker gets its type's effort, or else the sergeant's own.</p></div>"
      : modelsRowHtml(`${p}-worker-effort`, 'Effort', effortSelectHtml(app, `${p}-worker-effort`, 'worker', workerModel, d.worker.effort, c.worker.effort, 'The sergeant chooses'), c.worker.effort),
    '<h3 class="sub-h">Worker types</h3>',
    claude
      ? "<p class=\"help\">A sergeant picks a worker type by the kind of work. A model or effort the sergeant names when it starts the worker wins over the type's. Claude Code sees a change here within a few seconds.</p>"
      : "<p class=\"help\">A sergeant picks a worker type by the kind of work. The type's model wins over the sergeant's pick. The sergeant still chooses the effort, unless you set one here. A change here counts from the next worker a sergeant starts.</p>",
    modelTypesHtml(app, workerModel),
    modelAddHtml(app),
    '<div class="mbtns">' +
      `<button type="button" class="btn primary" id="${p}-save" data-models-app="${app}" data-models-act="save"${modelsCanChange(app) ? '' : ' disabled'}>Save to ${esc(a.name)}</button>${again}` +
      `<span id="${p}-msg" role="status">${modelsMsgHtml(app)}</span></div>`,
    claude
      ? '<p class="help">Claude Code reads these when a session starts. A session that is running keeps what it started with. Pleni keeps a copy of each file it changes in the backups folder next to its settings.</p>'
      : '<p class="help">Codex reads these when a thread starts, so new threads and the relay\'s wake-ups use them at once. A thread that is running keeps what it started with. Pleni keeps a copy of each file it changes in the backups folder next to its settings.</p>',
  ];
  return out.join('');
}

function modelsRowHtml(id, label, control, line, why) {
  const text = why || (line && !line.editable ? 'This line is written in a way Pleni does not change. Change it in the file.' : '');
  return `<div class="srow"><label for="${id}">${esc(label)}</label><div class="mpick">${control}</div>${text ? `<p class="help">${esc(text)}</p>` : ''}</div>`;
}

function modelChoiceText(app, x) {
  // "Opus, the newest" names itself already; "GPT-6.1 Sol (gpt-6.1-sol)" shows the name Codex uses.
  const named = !x.label || x.label.toLowerCase().startsWith(x.id.toLowerCase());
  const name = named ? x.label || x.id : `${x.label} (${x.id})`;
  return x.unlisted ? `${name}, which ${MODEL_APPS[app].name} does not list` : name;
}

// The models the tool lists for the account. Without such a list, the models on offer, and "Another
// model…", which opens a box to type any name.
function modelSelectHtml(app, id, field, value, line, blank) {
  const c = S.models.data[app];
  const choices = Array.isArray(c.models) ? c.models : [];
  const other = !c.listed && (!!S.models.drafts[app].other[field] || (!!value && !choices.some((x) => x.id === value)));
  const off = !modelsCanChange(app) || (line && !line.editable) ? ' disabled' : '';
  const opts = [
    `<option value=""${!value && !other ? ' selected' : ''}>${esc(blank)}</option>`,
    ...choices.map((x) => `<option value="${esc(x.id)}"${!other && x.id === value ? ' selected' : ''}>${esc(modelChoiceText(app, x))}</option>`),
    ...(c.listed ? [] : [`<option value="${MODEL_OTHER}"${other ? ' selected' : ''}>Another model…</option>`]),
  ];
  let html = `<select class="field" id="${id}" data-m-model="${esc(field)}"${off}>${opts.join('')}</select>`;
  if (other) {
    html +=
      `<label class="sr-only" for="${id}-other">Model name</label>` +
      `<input class="field" id="${id}-other" type="text" data-m-other="${esc(field)}" value="${esc(value)}" maxlength="100" placeholder="${esc(MODEL_APPS[app].placeholder)}" autocomplete="off" spellcheck="false"${off}>`;
  }
  return html;
}

// The levels the model takes when the tool lists them, else every level it knows.
function effortSelectHtml(app, id, field, model, value, line, blank, levelsFor = null) {
  const c = S.models.data[app];
  const known = (Array.isArray(c.models) ? c.models : []).find((x) => x.id === model);
  const all = levelsFor || (Array.isArray(c.efforts) ? c.efforts : []);
  const list = known && Array.isArray(known.efforts) && known.efforts.length ? known.efforts : all;
  const levels = value && !list.includes(value) ? [...list, value] : list;
  const off = !modelsCanChange(app) || (line && !line.editable) ? ' disabled' : '';
  const opts = [
    `<option value=""${value ? '' : ' selected'}>${esc(blank)}</option>`,
    ...levels.map((e) => `<option value="${esc(e)}"${e === value ? ' selected' : ''}>${esc(EFFORT_NAMES[e] || e)}</option>`),
  ];
  return `<select class="field" id="${id}" data-m-effort="${esc(field)}"${off}>${opts.join('')}</select>`;
}

function modelTypesHtml(app, workerModel) {
  const c = S.models.data[app];
  const p = MODEL_APPS[app].p;
  const types = Array.isArray(c.types) ? c.types : [];
  if (!types.length) return '<p class="help">No worker types yet. Add one below, for example one for coding and design work and one for easier tasks.</p>';
  const rows = types.map((t, i) => {
    const name = esc(t.name || t.file);
    if (t.error) return `<tr><td><span class="mname">${name}</span><span class="key">${esc(t.file)}</span></td><td colspan="3">${esc(t.error)}</td></tr>`;
    const slot = S.models.drafts[app].types[t.file];
    const field = `type:${t.file}`;
    const model = modelSelectHtml(app, `${p}-type-${i}-model`, field, slot.model, t.model, 'Same as other workers');
    const effort = effortSelectHtml(app, `${p}-type-${i}-effort`, field, slot.model || workerModel, slot.effort, t.effort, 'The sergeant chooses', c.typeEfforts || null);
    return (
      `<tr><td><span class="mname">${name}</span><span class="key">${esc(t.file)}</span></td><td data-label="When a sergeant uses it">${esc(t.description || '')}</td>` +
      `<td data-label="Model"><label class="sr-only" for="${p}-type-${i}-model">Model for ${name}</label><div class="mpick">${model}</div></td>` +
      `<td data-label="Effort"><label class="sr-only" for="${p}-type-${i}-effort">Effort for ${name}</label>${effort}</td></tr>`
    );
  });
  return (
    '<table class="edit mtypes"><thead><tr><th scope="col">Type</th><th scope="col">When a sergeant uses it</th>' +
    `<th scope="col">Model</th><th scope="col">Effort</th></tr></thead><tbody>${rows.join('')}</tbody></table>`
  );
}

function modelAddHtml(app) {
  if (!modelsCanChange(app)) return '';
  const a = MODEL_APPS[app];
  const add = S.models.drafts[app].add;
  const p = a.p;
  // A repaint (a model picked in the box, say) keeps the box open.
  const box = $(`#${p}-add-box`);
  if (box) S.models.addOpen[app] = box.open;
  return (
    `<details class="smore" id="${p}-add-box"${S.models.addOpen[app] ? ' open' : ''}><summary>Add a worker type</summary>` +
    `<p class="help">Pleni makes a new file for it in ${esc(a.name)}'s agents folder. It never changes a file that is there already.</p>` +
    `<div class="srow"><label for="${p}-add-name">Name</label><div><input class="field" id="${p}-add-name" type="text" data-m-add="name" value="${esc(add.name)}" maxlength="40" placeholder="For example coder" autocomplete="off" spellcheck="false" aria-describedby="${p}-add-name-help"></div>` +
    `<p class="help" id="${p}-add-name-help">Small letters, digits, - and _.</p></div>` +
    `<div class="srow"><label for="${p}-add-description">When a sergeant uses it</label><div><input class="field" id="${p}-add-description" type="text" data-m-add="description" value="${esc(add.description)}" maxlength="${MAX_TYPE_TEXT}" placeholder="For example: coding and design work" autocomplete="off"></div></div>` +
    `<div class="srow"><label for="${p}-add-model">Model</label><div class="mpick">${modelSelectHtml(app, `${p}-add-model`, 'add', add.model, null, 'Same as other workers')}</div></div>` +
    `<div class="mbtns"><button type="button" class="btn" id="${p}-add" data-models-app="${app}" data-models-act="add">Add the worker type</button></div></details>`
  );
}

function modelsMsgHtml(app) {
  const msg = S.models.msgs[app];
  if (msg) return `<span class="saved ${msg.kind}">${esc(msg.text)}</span>`;
  if (S.models.drafts[app] && Object.keys(modelChanges(app).out).length) return `<span class="saved dirty">You have changes that are not saved to ${esc(MODEL_APPS[app].name)} yet.</span>`;
  return '';
}

function updateModelsMsg(app) {
  const el = $(`#${MODEL_APPS[app].p}-msg`);
  if (el) setHtml(el, modelsMsgHtml(app));
}

function modelSlot(app, field) {
  const d = S.models.drafts[app];
  if (field === 'sergeant' || field === 'worker' || field === 'add') return d[field];
  return field.startsWith('type:') ? d.types[field.slice('type:'.length)] : null;
}

function onModelsInput(app, el) {
  const m = S.models;
  const d = m.drafts[app];
  if (!d || !MODEL_APPS[app]) return;
  if (el.dataset.mModel) {
    const field = el.dataset.mModel;
    const slot = modelSlot(app, field);
    if (!slot) return;
    d.other[field] = el.value === MODEL_OTHER;
    slot.model = el.value === MODEL_OTHER ? '' : el.value;
    // Claude Code keeps an effort for each model, so the menu shows the one kept for this model.
    if (app === 'claude' && field === 'sergeant') slot.effort = (m.data.claude.modelEfforts || {})[slot.model] || '';
    m.msgs[app] = null;
    // The effort menu follows the model, and "Another model…" opens its box.
    paintAppModels(app);
    if (el.value === MODEL_OTHER) $(`#${el.id}-other`)?.focus();
    return;
  }
  if (el.dataset.mOther) {
    const slot = modelSlot(app, el.dataset.mOther);
    if (slot) slot.model = el.value.trim();
  } else if (el.dataset.mEffort) {
    const slot = modelSlot(app, el.dataset.mEffort);
    if (slot) slot.effort = el.value;
  } else if (el.dataset.mAdd) {
    d.add[el.dataset.mAdd] = el.value;
    return;
  } else {
    return;
  }
  m.msgs[app] = null;
  updateModelsMsg(app);
}

// What changed from what the tool has: { out: { sergeant?, worker?, types? }, bad: { id, text } |
// null }. null takes a value out. For Claude Code, the sergeant's effort is the one kept for the
// model picked, so it counts as changed only when it differs from that.
function modelChanges(app) {
  const c = S.models.data[app];
  const d = S.models.drafts[app];
  const p = MODEL_APPS[app].p;
  let bad = null;
  const diff = (field, slot, lines, idOf, keptEffort) => {
    const one = {};
    for (const what of ['model', 'effort']) {
      const line = lines[what];
      if (!line || !line.editable) continue;
      const now = String(slot[what] || '').trim();
      if (what === 'model' && d.other[field] && !now) bad = bad || { id: `${idOf('model')}-other`, text: 'Type the name of the model, or pick one from the list.' };
      else if (what === 'model' && now && !MODEL_ID.test(now)) bad = bad || { id: `${idOf('model')}-other`, text: 'A model name has only letters, digits and . - _ : / @ + [ ], up to 100 of them.' };
      const was = what === 'effort' && keptEffort !== undefined ? keptEffort : line.value || '';
      if (now !== was) one[what] = now || null;
    }
    return one;
  };
  const out = {};
  for (const who of ['sergeant', 'worker']) {
    const claudeEffort = app === 'claude' && who === 'sergeant';
    if (claudeEffort && !d.sergeant.model) {
      const one = diff(who, { model: d.sergeant.model }, { model: c.sergeant.model }, (what) => `${p}-${who}-${what}`);
      if (Object.keys(one).length) out[who] = one;
      continue;
    }
    const kept = claudeEffort ? (c.modelEfforts || {})[d.sergeant.model] || '' : undefined;
    const one = diff(who, d[who], c[who], (what) => `${p}-${who}-${what}`, kept);
    if (Object.keys(one).length) out[who] = one;
  }
  const types = [];
  (c.types || []).forEach((t, i) => {
    if (t.error || !d.types[t.file]) return;
    const one = diff(`type:${t.file}`, d.types[t.file], t, (what) => `${p}-type-${i}-${what}`);
    if (Object.keys(one).length) types.push({ file: t.file, ...one });
  });
  if (types.length) out.types = types;
  return { out, bad };
}

function modelsAction(app, act) {
  if (!MODEL_APPS[app]) return undefined;
  if (act === 'save') return saveModels(app);
  if (act === 'add') return addModelType(app);
  S.models.msgs[app] = null;
  return loadModels(true, false);
}

async function saveModels(app) {
  const d = S.models.drafts[app];
  if (!modelsCanChange(app) || !d) return;
  const { out, bad } = modelChanges(app);
  const name = MODEL_APPS[app].name;
  if (bad) {
    S.models.msgs[app] = { kind: 'err', text: `Not saved. ${bad.text}` };
    updateModelsMsg(app);
    $(`#${bad.id}`)?.focus();
    return;
  }
  if (!Object.keys(out).length) {
    S.models.msgs[app] = { kind: 'ok', text: `Nothing to save. ${name} has these already.` };
    updateModelsMsg(app);
    return;
  }
  await sendModels(app, out, (r) => {
    const copy = Array.isArray(r.backups) && r.backups.length ? ` A copy of the old file is in ${r.backups[0]}.` : '';
    const who = app === 'claude' ? 'New sessions use these now.' : "New threads and the relay's wake-ups use these now.";
    return `Saved to ${name}. ${who}${copy}`;
  });
}

async function addModelType(app) {
  const d = S.models.drafts[app];
  if (!modelsCanChange(app) || !d) return;
  const p = MODEL_APPS[app].p;
  const name = d.add.name.trim();
  const description = d.add.description.trim();
  const model = d.add.model.trim();
  const fail = (id, text) => {
    S.models.msgs[app] = { kind: 'err', text: `Not added. ${text}` };
    updateModelsMsg(app);
    $(`#${id}`)?.focus();
  };
  if (!TYPE_NAME.test(name)) return fail(`${p}-add-name`, 'A name starts with a small letter and has only small letters, digits, - and _.');
  if (!description) return fail(`${p}-add-description`, 'Say when a sergeant should use this worker type.');
  if (d.other.add && !model) return fail(`${p}-add-model-other`, 'Type the name of the model, or pick one from the list.');
  if (model && !MODEL_ID.test(model)) return fail(`${p}-add-model-other`, 'A model name has only letters, digits and . - _ : / @ + [ ], up to 100 of them.');
  const later = app === 'claude' ? 'Sergeants can use it within a few seconds.' : 'Sergeants can use it in threads that start from now on.';
  await sendModels(app, { add: { name, description, model: model || null } }, () => `Added the worker type ${name}. ${later}`);
}

async function sendModels(app, changes, done) {
  const m = S.models;
  m.msgs[app] = { kind: '', text: 'Saving…' };
  updateModelsMsg(app);
  let msg;
  try {
    const r = await postJson('/api/models', { app, tag: m.data[app].tag, ...changes });
    msg = { kind: 'ok', text: done(r || {}) };
  } catch (err) {
    msg = { kind: 'err', text: `Not saved. ${plainError(err)}` };
  }
  await loadModels(true);
  m.msgs[app] = msg;
  updateModelsMsg(app);
  say(msg.text);
}

async function loadSettings(force) {
  const st = settingsState();
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
  loadDevices(true);
  loadModels(false);
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
    `<div class="srow"><span class="lbl" id="${id}-lbl">Folder</span><div class="src">` +
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
  const group = (id, intro, body) =>
    `<div role="tabpanel" class="sgroup" id="spanel-${id}" aria-labelledby="stab-${id}" data-name="${groupName(id)}"><p class="sgroup-intro">${intro}</p>${body}</div>`;
  const html = `<form class="settings" id="settings-form" novalidate>
    <div class="sfind"><label for="s-find">Find a setting</label>
      <input class="field" id="s-find" type="search" value="${esc(st.find || '')}" placeholder="For example: name, folder, alerts" autocomplete="off" aria-describedby="s-find-msg">
      <p class="sfind-msg" id="s-find-msg" role="status"></p></div>
    <div class="tabs stabs" role="tablist" aria-label="Groups of settings">${SETTINGS_GROUPS.map(([id, label]) =>
      `<button type="button" role="tab" id="stab-${id}" data-stab="${id}" aria-controls="spanel-${id}" aria-selected="false" tabindex="-1">${label}</button>`).join('')}</div>
    ${group('basics', 'Your name, how the page looks, and which sessions it shows.', `
    <section class="panel" aria-labelledby="s-h-you" data-find="colors colours dark light mode titles military company folders"><h2 id="s-h-you">You and the map</h2>
      ${textRow('s-name', 'Your name', 'displayName', { help: 'Shown on the top tile of the map.', max: 40 })}
      <div class="srow"><label for="s-theme">Theme</label><div><select class="field" id="s-theme" data-local="theme" aria-describedby="s-theme-help">
        <option value="system"${theme === 'system' ? ' selected' : ''}>Match this computer</option>
        <option value="dark"${theme === 'dark' ? ' selected' : ''}>Dark</option>
        <option value="light"${theme === 'light' ? ' selected' : ''}>Light</option>
      </select></div><p class="help" id="s-theme-help">Kept in this browser only. It changes right away.</p></div>
      ${selectRow('s-titles', 'Rank words', 'titles', [['plain', 'Plain: Lead and Agent (plus Superintendent and Coordinator for those roles)'], ['military', 'Military: General, Colonel, Sergeant, Specialist, Private'], ['company', 'Company: Owner, Vice President, Manager, Supervisor, Worker']], 'The words used for ranks on the tiles.')}
      ${selectRow('s-group', 'Group sessions', 'groupBy', [['none', 'Not at all'], ['project', 'By project folder']], 'By project folder puts a folder tile between you and its sessions.')}
    </section>
    <section class="panel" aria-labelledby="s-h-show" data-find="snippets text privacy hours days time window old finished stuck idle reviewers"><h2 id="s-h-show">What the page shows</h2>
      <div class="srow" role="radiogroup" aria-labelledby="s-content-lbl" aria-describedby="s-content-help"><span class="lbl" id="s-content-lbl">Session text</span><div class="checks">
        <label><input type="radio" name="s-content" id="s-content-snippets" data-path="content" data-kind="text" value="snippets"${getPath(st.draft, 'content', 'snippets') === 'snippets' ? ' checked' : ''}>Short snippets of what sessions say and do</label>
        <label><input type="radio" name="s-content" id="s-content-none" data-path="content" data-kind="text" value="none"${getPath(st.draft, 'content', '') === 'none' ? ' checked' : ''}>Only tool names and states</label>
      </div><p class="help" id="s-content-help">Snippets stay on this computer either way.</p></div>
      ${numberRow('s-recent', 'Show sessions from the last', 'window.recentHours', 1, 720, 'Hours. Older sessions are left off the page.')}
      <details class="smore"><summary>More choices</summary>
        ${numberRow('s-active', 'Finished, for', 'window.activeMinutes', 1, 240, 'Minutes. A session that finished its turn this recently shows "Finished".')}
        ${numberRow('s-stale', 'Call a turn stuck after', 'window.staleMinutes', 5, 1440, 'Minutes. A turn whose file has not moved for this long counts as idle.')}
        ${checkRow('s-reviewers', 'Reviewers', 'showReviewers', 'Show the automatic reviewers that Codex starts', '')}
      </details>
    </section>`)}
    ${group('team', 'Names, roles and who reports to whom.', `
    <section class="panel" aria-labelledby="s-h-people" data-find="rename role roles hide hidden show unhide sessions agents"><h2 id="s-h-people">Names and roles</h2>
      <div class="srow"><label for="s-people-search">Find a session</label><div><input class="field" id="s-people-search" type="search" value="${esc(st.search)}" placeholder="Search by name" autocomplete="off" aria-describedby="s-people-search-help"></div>
      <p class="help" id="s-people-search-help">Give a session a shorter name, set its role, or hide it. Hidden sessions are listed here.</p></div>
      <div id="people-rows">${peopleHtml()}</div>
    </section>
    <section class="panel" aria-labelledby="s-h-chain" data-find="boss bosses leader reports rules tree"><h2 id="s-h-chain">Chain of command</h2>
      <p class="note">Say who reports to whom, by name. A rule keeps working when a session is replaced by a new one with the same name.</p>
      <details class="smore"><summary>How the rules work</summary>
        <p class="note">Pleni checks the rules from the top down and uses the first one that fits. A session goes under the newest active session whose name has the "it reports to" text. Leave that empty, or type me, to put it right under you. Pick Automatic under Rank to let Pleni choose the rank.</p>
      </details>
      <div id="chain-rows">${chainHtml()}</div>
      <div class="chain-add"><button type="button" class="btn" id="s-chain-add">Add a rule</button></div>
    </section>
    <section class="panel" aria-labelledby="s-h-projects" data-find="folders rename hide"><h2 id="s-h-projects">Projects</h2>
      <p class="note">Give a project folder a shorter name, or hide all of its sessions.</p>
      <div id="project-rows">${projectsHtml()}</div>
    </section>
    <section class="panel" aria-labelledby="s-h-tiers" data-find="models senior junior specialist private"><h2 id="s-h-tiers">Ranks by model</h2>
      <p class="note">Pick the rank for each model. In the Military titles, workers on a senior model are Specialists and the rest are Privates. Leaders keep their own ranks.</p>
      <div id="model-rows">${modelsHtml()}</div>
      <details class="smore"><summary>Words that set the rank</summary>
        <p class="note">A model on Automatic gets its rank from these words. A rank you pick above always wins.</p>
        ${textRow('s-senior', 'Senior words', 'modelTiers.senior', { kind: 'words', help: 'A model whose name has any of these words is senior. Separate the words with commas.' })}
        ${textRow('s-junior', 'Junior words', 'modelTiers.junior', { kind: 'words', help: 'A model whose name has any of these words is junior. Senior words are checked first.' })}
      </details>
    </section>`)}
    ${group('models', 'The model and effort your Codex and Claude Code agents start with.', `
    <section class="panel" aria-labelledby="s-h-models" data-find="models model effort change edit"><h2 id="s-h-models">Change models</h2>
      ${checkRow('s-models-edit', 'Change models', 'models.edit', 'Let Pleni change the models Codex and Claude Code use', "Pleni then changes only the model and effort lines in their settings, after you choose Save in a section below, and keeps a copy of the old file first. Only on this computer.")}
    </section>
    <section class="panel" aria-labelledby="s-h-codex-models" data-find="models model effort reasoning codex sergeant sergeants worker workers types astra sol luna config"><h2 id="s-h-codex-models">Codex</h2>
      <div id="models-codex" data-models="codex">${appModelsHtml('codex')}</div>
    </section>
    <section class="panel" aria-labelledby="s-h-claude-models" data-find="models model effort claude code opus sonnet haiku fable sergeant sergeants worker workers types agents settings"><h2 id="s-h-claude-models">Claude Code</h2>
      <div id="models-claude" data-models="claude">${appModelsHtml('claude')}</div>
    </section>`)}
    ${group('sources', 'Which tools Pleni reads, and where their files are.', `
    <section class="panel" aria-labelledby="s-h-where" data-find="folders paths sources read claude codex grok kimi desktop"><h2 id="s-h-where">Where Pleni looks</h2>
      ${sourceRow('claude', 'Claude Code', 'Read Claude Code sessions', 'Leave the folder empty to use CLAUDE_CONFIG_DIR, or the .claude folder in your home folder.')}
      ${sourceRow('claudeDesktop', 'Claude desktop app', 'Read session names from the Claude desktop app', 'Gives desktop sessions the names you see in the app.')}
      ${sourceRow('codex', 'Codex', 'Read Codex threads', 'Leave the folder empty to use CODEX_HOME, or the .codex folder in your home folder.')}
      ${sourceRow('grok', 'Grok', 'Read Grok sessions', "Pleni reads Grok's session logs in this folder.")}
      ${sourceRow('kimi', 'Kimi Code', 'Read Kimi Code sessions', "Pleni reads Kimi Code's session logs in this folder.")}
    </section>
    <section class="panel" aria-labelledby="s-h-mailbox" data-find="relay planner coordinator tasks notes folder"><h2 id="s-h-mailbox">Mailbox</h2>
      ${mailboxRows()}
    </section>
    <section class="panel" aria-labelledby="s-h-github" data-find="github gh pull requests checks reviews merge internet network live status"><h2 id="s-h-github">GitHub</h2>
      ${checkRow('s-gh-live', 'Live GitHub status', 'github.live', 'Ask GitHub about pull requests', 'Shows checks, reviews, and whether each pull request can be merged, on the Pull requests page. Pleni runs the GitHub CLI (gh) on this computer to ask GitHub, with your own gh sign-in, about once a minute while that page is open. It asks only about the repositories your sessions work in. Needs gh: install it from cli.github.com, then run gh auth login.')}
      ${checkRow('s-gh-merge', 'Merge button', 'github.merge', 'Show the Merge button', 'Lets you merge a pull request from the Pull requests page, after you confirm. Only on this computer, and only when every check passes and GitHub says it is ready.')}
      ${selectRow('s-gh-method', 'How to merge', 'github.mergeMethod', [['squash', 'Squash and merge'], ['merge', 'Create a merge commit'], ['rebase', 'Rebase and merge']], 'The same choices as the Merge button on GitHub. Your repository must allow the one you pick.')}
    </section>`)}
    ${group('alerts', 'What Pleni points out to you.', `
    <section class="panel" aria-labelledby="s-h-alerts" data-find="alerts notifications pop-ups popups watch stopped questions errors"><h2 id="s-h-alerts">Needs you</h2>
      <p class="note">Questions, errors, notes for you, the relay's alerts, and watched tiles that stop working show under Needs you. To watch a tile, open it and tick Tell me if this stops working.</p>
      ${numberRow('s-stopped', 'Call a watched tile stopped after', 'alerts.stoppedMinutes', 1, 1440, 'Minutes without any work.')}
      ${alertsRowHtml()}
    </section>
    <section class="panel" aria-labelledby="s-h-roll" data-find="memory context full squeeze squeezed compact summary old days long"><h2 id="s-h-roll">Roll over soon</h2>
      <p class="note">A long session gets slow, and it forgets details each time its history is squeezed into a summary. Pleni marks a main session "Roll over soon" when it passes any of these limits. Set one to 0 to turn it off.</p>
      ${numberRow('s-roll-memory', 'Memory full to', 'rollSoon.memoryPercent', 0, 100, 'Percent. For Claude Code, full means the size where it last squeezed the history.')}
      ${numberRow('s-roll-squeezes', 'Squeezed at least', 'rollSoon.squeezes', 0, 100, 'Times its history was squeezed into a summary.')}
      ${numberRow('s-roll-days', 'Older than', 'rollSoon.days', 0, 365, 'Days since the session started.')}
    </section>`)}
    ${group('buttons', 'Buttons that open and start sessions in PowerShell windows, and the message box. Off until you turn them on.', `
    <section class="panel" aria-labelledby="s-h-open" data-find="buttons powershell terminal window resume roll over windows new agent start team cloud teleport web"><h2 id="s-h-open">Open sessions</h2>
      ${checkRow('s-open', 'Open in PowerShell', 'actions.openTerminal', 'Show the Open in PowerShell button', 'Opens a session in a new PowerShell window, so you can see it and type to it. Pleni never types into it. Windows only, this computer only. It will not open a session that is already open in another window.')}
      ${checkRow('s-new', 'New agent', 'actions.newAgent', 'Show the New agent button', 'Starts a new Claude Code or Codex session in the folder of a session you pick, in a new PowerShell window. You type its first message there. Windows only, this computer only.')}
      ${checkRow('s-teleport', 'Bring a cloud session here', 'actions.teleport', 'Show the Bring a cloud session here button', 'Opens a PowerShell window in a Claude Code session\'s folder that runs claude --teleport, so you can pick one of your claude.ai cloud sessions and go on with it on this computer, where Pleni shows it. That folder must hold the same repository with no unsaved changes, and the cloud session\'s branch must be pushed. Windows only, this computer only.')}
      ${checkRow('s-roll', 'Roll over', 'actions.rollover', 'Show the Roll over button', 'Starts a fresh session with the same name, from a handoff note the old one writes. Each step opens a window and sends one short message, which the side panel shows first. Windows only, this computer only, for sessions with a name of their own. It will not send to a session that is busy or open in another window.')}
      ${st.info.platform && st.info.platform !== 'win32' ? '<p class="note">This computer does not run Windows, so these buttons will not show here yet.</p>' : ''}
    </section>
    <section class="panel" aria-labelledby="s-h-send" data-find="send message prompt chat type talk answer turn hidden background"><h2 id="s-h-send">Send messages</h2>
      <p class="note">Type a message to a Claude Code session or Codex thread in its side panel, under Chat. Pleni sends it as one turn of that session, as if you typed it there, and shows the answer. Each message uses your Claude or ChatGPT plan, like typing it yourself.</p>
      ${checkRow('s-send', 'Send messages', 'actions.send', 'Show the Chat tab with a message box', 'Pleni runs the session\'s own program in the background, once for each message, and hands it your message. It never sends to a session that is working, or open in a window or an app. Windows only, this computer only, for main sessions.')}
      ${selectRow('s-send-mode', 'A sent message may', 'send.mode', [['read', 'Read files and answer'], ['edit', 'Also change files in its folder']], 'Read files and answer is the safest: anything else that would need your yes is turned down. Either way, what the session\'s own settings forbid stays forbidden.')}
      ${st.info.platform && st.info.platform !== 'win32' ? '<p class="note">This computer does not run Windows, so the message box will not show here yet.</p>' : ''}
    </section>`)}
    ${group('devices', 'Opening Pleni from another device, and where its settings are kept.', `
    <section class="panel" aria-labelledby="s-h-link" data-find="address url link bookmark key sign in phone laptop chrome allow"><h2 id="s-h-link">Open Pleni on another device</h2>
      <div id="devices-box">${devicesHtml()}</div>
    </section>
    <section class="panel" aria-labelledby="s-h-remote" data-find="phone tablet laptop remote tailscale proxy port host login"><h2 id="s-h-remote">Other devices</h2>
      <p class="note">Pleni only lets in the host names and Tailscale logins listed here. <b>Allow</b> above fills both in for you.</p>
      ${textRow('s-hosts', 'Allowed host names', 'remote.hosts', { kind: 'words', placeholder: 'pleni.example.ts.net', help: 'Separate names with commas. Up to 20.' })}
      ${textRow('s-users', 'Allowed Tailscale logins', 'remote.tailscaleUsers', { kind: 'words', placeholder: 'ada@example.com', help: 'Separate logins with commas. Up to 20.' })}
      ${numberRow('s-port', 'Port', 'port', 1024, 65535, 'Pleni uses a new port the next time it starts.')}
    </section>
    ${st.info.file ? `<section class="panel" aria-labelledby="s-h-file" data-find="file json saved where"><h2 id="s-h-file">Settings file</h2><p class="note">Saved on this computer in <code>${esc(st.info.file)}</code>.</p></section>` : ''}`)}
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
  applySettingsView();
}

function groupName(id) {
  const g = SETTINGS_GROUPS.find((x) => x[0] === id);
  return g ? g[1] : '';
}

// An address such as #/settings/alerts opens that group.
function pickSettingsGroupFromHash() {
  const id = location.hash.replace(/^#\/?/, '').split(/[/?]/)[1];
  if (!groupName(id)) return;
  const st = settingsState();
  st.group = id;
  st.find = '';
}

function selectSettingsGroup(id, focus) {
  const st = S.set;
  if (!st || !groupName(id)) return;
  st.group = id;
  st.find = '';
  const find = $('#s-find');
  if (find) find.value = '';
  history.replaceState(null, '', `#/settings/${id}`);
  applySettingsView();
  if (id === 'devices') loadDevices(true);
  if (id === 'models') loadModels(true);
  if (focus) $(`#stab-${id}`).focus();
}

// The text the Find box looks through: a section's group, heading, notes and rows, plus a few
// extra words. Not the names in its tables, so it finds settings rather than sessions.
function findText(sec) {
  const parts = [sec.closest('.sgroup').dataset.name, sec.dataset.find || ''];
  for (const el of $$('h2, .note, summary, .srow', sec)) parts.push(el.textContent);
  return parts.join(' ');
}

// Shows the open group or, while the Find box has words in it, every section that has them all.
function applySettingsView() {
  const st = S.set;
  const form = $('#settings-form');
  if (!st || !form) return;
  const words = st.find.split(/\s+/).filter(Boolean);
  const finding = words.length > 0;
  // Each word must start a word in the text, so "port" finds Port but not "reports".
  const tests = words.map((w) => new RegExp(`(?<![\\p{L}\\p{N}])${w.replace(/[.*+?^$()|[\]{}\\]/g, '\\$&')}`, 'iu'));
  const has = (text) => tests.every((re) => re.test(text));
  form.classList.toggle('finding', finding);
  $('.stabs', form).hidden = finding;
  let found = 0;
  for (const panel of $$('.sgroup', form)) {
    let any = false;
    for (const sec of $$('section', panel)) {
      const hit = finding && has(findText(sec));
      sec.hidden = finding && !hit;
      for (const row of $$('.srow', sec)) row.classList.toggle('found', hit && has(row.textContent));
      for (const more of $$('details', sec)) if (hit && has(more.textContent)) more.open = true;
      if (hit) {
        any = true;
        found += 1;
      }
    }
    panel.hidden = finding ? !any : panel.id !== `spanel-${st.group}`;
  }
  for (const tab of $$('[data-stab]', form)) {
    const on = tab.dataset.stab === st.group;
    tab.setAttribute('aria-selected', String(on));
    tab.tabIndex = on ? 0 : -1;
  }
  let said = '';
  if (finding) {
    said = found
      ? `${plural(found, 'section has', 'sections have')} what you typed. Clear the box to see the groups again.`
      : 'No setting has what you typed. Try a shorter word, or clear the box to see the groups.';
  }
  setText($('#s-find-msg'), said);
}

// A bad field may sit in another group, under a search, or in a closed More choices box.
function revealSetting(el) {
  const panel = el.closest('.sgroup');
  if (panel && (panel.hidden || el.closest('section[hidden]'))) selectSettingsGroup(panel.id.slice('spanel-'.length), false);
  for (let more = el.closest('details'); more; more = more.parentElement.closest('details')) more.open = true;
}

// The groups that hold a field marked in red, for the message under the form.
function badGroups(problems) {
  const ids = new Set(problems.map(({ el }) => (el.closest('.sgroup') || { id: '' }).id.slice('spanel-'.length)));
  return SETTINGS_GROUPS.filter(([id]) => ids.has(id)).map(([, name]) => name);
}

function markBadTabs() {
  for (const tab of $$('#settings-form [data-stab]')) {
    tab.classList.toggle('bad', !!$(`#spanel-${tab.dataset.stab} [aria-invalid="true"]`));
  }
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
  const modelsBox = el.closest('[data-models]');
  if (modelsBox) {
    onModelsInput(modelsBox.dataset.models, el);
    return;
  }
  if (el.id === 's-people-search') {
    st.search = el.value;
    setHtml($('#people-rows'), peopleHtml());
    return;
  }
  if (el.id === 's-find') {
    st.find = el.value;
    applySettingsView();
    loadModels(false);
    return;
  }
  if (el.dataset.local === 'theme') {
    setTheme(el.value);
    return;
  }
  if (el.dataset.local === 'alerts') {
    setAlerts(el);
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
  markBadTabs();
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
  markBadTabs();
}

// Marks every bad field, moves focus to the first one, and says so. Returns true when all is well.
function checkSettingsForm() {
  const form = $('#settings-form');
  if (!form) return true;
  for (const el of $$('[aria-invalid="true"]', form)) clearFieldError(el);
  const problems = settingsProblems(form);
  for (const { el, text } of problems) showFieldError(el, text);
  if (!problems.length) return true;
  const where = badGroups(problems);
  const names = where.length > 1 ? `${where.slice(0, -1).join(', ')} and ${where[where.length - 1]}` : where[0];
  const under = names ? ` It is under ${names}.` : '';
  S.set.msg = {
    kind: 'err',
    text:
      problems.length === 1
        ? `Not saved. Fix the field marked in red.${under}`
        : `Not saved. Fix the ${problems.length} fields marked in red.${under.replace('It is', 'They are')}`,
  };
  updateSettingsMsg();
  // Prefer a bad field in the group on screen; otherwise go to the first one.
  const first = (problems.find(({ el }) => !el.closest('.sgroup[hidden], section[hidden]')) || problems[0]).el;
  revealSetting(first);
  first.focus();
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
    S.gh.data = null;
    S.gh.askedAt = 0;
    await loadSettings(true);
    // The Models section may have just been turned on or off.
    if (S.models.data) loadModels(true);
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
  // Enter in a search box searches, and the Models section has its own Save button: neither
  // should save the whole form.
  if (ev.key === 'Enter' && (ev.target.id === 's-people-search' || ev.target.id === 's-find' || ev.target.closest('[data-models]'))) ev.preventDefault();
  if (ev.key === 'Escape' && ev.target.id === 's-find' && ev.target.value) {
    ev.preventDefault();
    ev.target.value = '';
    onSettingsInput(ev.target);
    return;
  }
  const tab = ev.target.closest('[data-stab]');
  if (tab && ['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(ev.key)) {
    const tabs = $$('[data-stab]', tab.parentElement);
    let i = tabs.indexOf(tab);
    if (ev.key === 'ArrowRight') i = (i + 1) % tabs.length;
    else if (ev.key === 'ArrowLeft') i = (i - 1 + tabs.length) % tabs.length;
    else if (ev.key === 'Home') i = 0;
    else i = tabs.length - 1;
    ev.preventDefault();
    selectSettingsGroup(tabs[i].dataset.stab, true);
  }
});
settingsBox.addEventListener('submit', (ev) => {
  ev.preventDefault();
  saveSettings();
});

$('#signin').addEventListener('submit', (ev) => {
  ev.preventDefault();
  signIn();
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
  if (el.id === 's-alerts-test') return testAlert();
  if (el.dataset.open) return openInWindow(el);
  if (el.dataset.teleport) return teleportHere(el);
  if (el.dataset.merge) return mergeClick(el.dataset.merge);
  if (el.dataset.mergeYes) return mergeNow(el.dataset.mergeYes);
  if (el.dataset.mergeNo) return mergeCancel(el.dataset.mergeNo);
  if (el.dataset.ghAgain) {
    askGithub(true);
    return renderPulls();
  }
  if (el.dataset.roll) return rollClick(el.dataset.roll);
  if (el.dataset.new) return newClick(el.dataset.new);
  if (el.id === 'd-chat-send') return sendChat();
  if (el.dataset.hide) return hideNode(el.dataset.hide, el.dataset.title || keyName(el.dataset.hide));
  if (el.dataset.copy === 'new-rename') return newCopy();
  if (el.dataset.mailCopy) return mailCopy(Number(el.dataset.mailCopy));
  if (el.dataset.mailRead) return markMailRead(Number(el.dataset.mailRead));
  if (el.dataset.mailShow) {
    S.mail.all = el.dataset.mailShow === 'all';
    S.mail.msg = null;
    renderMail();
    return;
  }
  if (el.dataset.copy) return rollCopy(el.dataset.copy);
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
  if (el.dataset.stab) return selectSettingsGroup(el.dataset.stab, false);
  if (el.dataset.copyAddr) return copyDevices('addr', Number(el.dataset.copyAddr));
  if (el.id === 's-key-copy') return copyDevices('key');
  if (el.id === 's-link-copy') return copyDevices('link');
  if (el.dataset.allow) return allowDevice(Number(el.dataset.allow));
  if (el.id === 's-chain-add') return addChainRule();
  if (el.dataset.modelsAct) return modelsAction(el.dataset.modelsApp, el.dataset.modelsAct);
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
