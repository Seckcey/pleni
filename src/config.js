// Settings: defaults, cleaning, load/save, and where to find the session folders.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stripBom } from './jsonl.js';

export const DEFAULTS = deepFreeze({
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
  chain: [], // [{ match, reportsTo, role }] who reports to whom, by session name; first match wins
  remote: { hosts: [], tailscaleUsers: [] },
  actions: { openTerminal: false, rollover: false }, // Open in PowerShell and Roll over (Windows, this computer only)
  alerts: { stoppedMinutes: 15 }, // a watched tile counts as stopped after this long without work
});

const TITLES = ['plain', 'military', 'company'];
const CONTENT = ['snippets', 'none'];
const GROUP_BY = ['project', 'none'];
const ROLES = ['superintendent', 'coordinator', 'lead', 'worker', 'hidden'];
const RANGES = {
  port: [1024, 65535],
  activeMinutes: [1, 240],
  recentHours: [1, 720],
  staleMinutes: [5, 1440],
  stoppedMinutes: [1, 1440],
};
const MAX_PEOPLE = 500;
const MAX_CHAIN = 50;
const MAX_NAME = 80;
const MAX_PROJECTS = 200;
const MAX_REMOTE = 20;
const MAX_TIER_WORDS = 50;
const MAX_PATH = 4096;
const NODE_KEY = /^(claude|codex|grok|kimi):[0-9a-f-]{8,64}(\/[0-9a-z_-]{1,64})?$/;
// A mailbox worker run: mailbox:<task id>/W<n>. It keeps no session file of its own.
const MAILBOX_KEY = /^mailbox:[A-Za-z0-9][A-Za-z0-9._-]{0,120}\/W\d{1,4}$/;
const CONTROL = /\p{Cc}/u;
const RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

export function configDir(env = process.env, platform = process.platform, home = os.homedir()) {
  const p = pathFor(platform);
  const own = envPath(env, 'PLENI_HOME', p);
  if (own) return own;
  if (platform === 'win32') return p.join(appData(env, home, p), 'pleni');
  if (platform === 'darwin') return p.join(home, 'Library', 'Application Support', 'pleni');
  return p.join(envPath(env, 'XDG_CONFIG_HOME', p) || p.join(home, '.config'), 'pleni');
}

export function settingsFile(env = process.env, platform = process.platform, home = os.homedir()) {
  return pathFor(platform).join(configDir(env, platform, home), 'settings.json');
}

export function resolveRoots(settings, env = process.env, platform = process.platform, home = os.homedir()) {
  const p = pathFor(platform);
  const sources = isObject(settings?.sources) ? settings.sources : {};
  const pick = (name, fallback) => rootFor(sources[name]?.root, p) ?? fallback;
  return {
    claude: pick('claude', envPath(env, 'CLAUDE_CONFIG_DIR', p) || p.join(home, '.claude')),
    claudeDesktop: pick('claudeDesktop', desktopRoot(env, platform, home, p)),
    codex: pick('codex', envPath(env, 'CODEX_HOME', p) || p.join(home, '.codex')),
    grok: pick('grok', envPath(env, 'GROK_HOME', p) || p.join(home, '.grok')),
    kimi: pick('kimi', envPath(env, 'KIMI_CODE_HOME', p) || p.join(home, '.kimi-code')),
    mailbox: pick('mailbox', null),
  };
}

export function isNodeKey(s) {
  if (typeof s !== 'string') return false;
  if (s === 'you' || s === 'relay' || NODE_KEY.test(s) || MAILBOX_KEY.test(s)) return true;
  return s.startsWith('project:') && isProjectName(s.slice('project:'.length));
}

export function cleanSettings(raw) {
  const r = isObject(raw) ? raw : {};
  return {
    version: 1,
    port: cleanInt(r.port, DEFAULTS.port, RANGES.port),
    displayName: cleanText(r.displayName, 40) || DEFAULTS.displayName,
    titles: oneOf(r.titles, TITLES, DEFAULTS.titles),
    content: oneOf(r.content, CONTENT, DEFAULTS.content),
    groupBy: oneOf(r.groupBy, GROUP_BY, DEFAULTS.groupBy),
    window: cleanWindow(r.window),
    showReviewers: cleanBool(r.showReviewers, DEFAULTS.showReviewers),
    modelTiers: cleanTiers(r.modelTiers),
    sources: cleanSources(r.sources),
    people: cleanPeople(r.people),
    projects: cleanProjects(r.projects),
    chain: cleanChain(r.chain),
    remote: cleanRemote(r.remote),
    actions: cleanActions(r.actions),
    alerts: cleanAlerts(r.alerts),
  };
}

export function loadSettings(file = settingsFile()) {
  const fallback = (error) => ({ settings: cleanSettings({}), file, error });
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return fallback(null);
    return fallback(`Pleni could not open the settings file (${err.code || 'unknown problem'}), so it is using the default settings.`);
  }
  let raw;
  try {
    raw = JSON.parse(stripBom(text));
  } catch {
    return fallback('The settings file is damaged, so Pleni is using the default settings.');
  }
  if (!isObject(raw)) return fallback('The settings file does not hold settings, so Pleni is using the default settings.');
  return { settings: cleanSettings(raw), file, error: null };
}

export function saveSettings(settings, file = settingsFile()) {
  const clean = cleanSettings(settings);
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const temp = path.join(dir, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  try {
    writeSynced(temp, `${JSON.stringify(clean, null, 2)}\n`);
    renameWithRetry(temp, file);
  } catch (err) {
    try {
      fs.rmSync(temp, { force: true });
    } catch {
      // Keep the first error; it says what really went wrong.
    }
    throw err;
  }
  return clean;
}

// ---- cleaning helpers ----

function cleanWindow(raw) {
  const w = isObject(raw) ? raw : {};
  const d = DEFAULTS.window;
  return {
    activeMinutes: cleanInt(w.activeMinutes, d.activeMinutes, RANGES.activeMinutes),
    recentHours: cleanInt(w.recentHours, d.recentHours, RANGES.recentHours),
    staleMinutes: cleanInt(w.staleMinutes, d.staleMinutes, RANGES.staleMinutes),
  };
}

function cleanTiers(raw) {
  const t = isObject(raw) ? raw : {};
  return {
    senior: cleanList(t.senior, 40, MAX_TIER_WORDS, DEFAULTS.modelTiers.senior),
    junior: cleanList(t.junior, 40, MAX_TIER_WORDS, DEFAULTS.modelTiers.junior),
  };
}

function cleanSources(raw) {
  const s = isObject(raw) ? raw : {};
  const out = {};
  for (const name of ['claude', 'claudeDesktop', 'codex', 'grok', 'kimi']) {
    const src = isObject(s[name]) ? s[name] : {};
    out[name] = { enabled: cleanBool(src.enabled, DEFAULTS.sources[name].enabled), root: cleanRoot(src.root) };
  }
  const m = isObject(s.mailbox) ? s.mailbox : {};
  out.mailbox = {
    enabled: cleanBool(m.enabled, DEFAULTS.sources.mailbox.enabled),
    root: cleanRoot(m.root),
    planner: cleanKeyOrName(m.planner),
    coordinator: cleanKeyOrName(m.coordinator),
  };
  return out;
}

function cleanPeople(raw) {
  return cleanMap(raw, MAX_PEOPLE, isNodeKey, (value, key) => {
    const entry = {};
    const label = cleanText(value.label, 80);
    if (label) entry.label = label;
    if (ROLES.includes(value.role)) entry.role = value.role;
    // Who this session reports to, chosen by the person: a node key or 'you'.
    const boss = typeof value.reportsTo === 'string' ? value.reportsTo.trim() : '';
    if (boss && boss !== key && isNodeKey(boss) && !boss.startsWith('project:')) entry.reportsTo = boss;
    // "Tell me if this stops working" in the tile's side panel.
    if (value.watch === true) entry.watch = true;
    return entry;
  });
}

function cleanProjects(raw) {
  return cleanMap(raw, MAX_PROJECTS, isProjectName, (value) => {
    const entry = {};
    const label = cleanText(value.label, 80);
    if (label) entry.label = label;
    if (typeof value.hidden === 'boolean') entry.hidden = value.hidden;
    return entry;
  });
}

// Keeps up to `max` entries whose key is valid and whose cleaned value is not empty.
function cleanMap(raw, max, isKey, cleanEntry) {
  const out = {};
  if (!isObject(raw)) return out;
  let count = 0;
  for (const [key, value] of Object.entries(raw)) {
    if (count >= max) break;
    if (!isKey(key) || !isObject(value)) continue;
    const entry = cleanEntry(value, key);
    if (Object.keys(entry).length === 0) continue;
    // defineProperty, so a key such as "__proto__" stays a plain entry.
    Object.defineProperty(out, key, { value: entry, enumerable: true, writable: true, configurable: true });
    count++;
  }
  return out;
}

function cleanRemote(raw) {
  const r = isObject(raw) ? raw : {};
  return {
    hosts: cleanList(r.hosts, 253, MAX_REMOTE, []),
    tailscaleUsers: cleanList(r.tailscaleUsers, 254, MAX_REMOTE, []),
  };
}

function cleanActions(raw) {
  const a = isObject(raw) ? raw : {};
  return {
    openTerminal: cleanBool(a.openTerminal, DEFAULTS.actions.openTerminal),
    rollover: cleanBool(a.rollover, DEFAULTS.actions.rollover),
  };
}

function cleanAlerts(raw) {
  const a = isObject(raw) ? raw : {};
  return { stoppedMinutes: cleanInt(a.stoppedMinutes, DEFAULTS.alerts.stoppedMinutes, RANGES.stoppedMinutes) };
}

// A list of short lower-case words: no spaces, de-duplicated, at most `max` entries.
function cleanList(raw, maxLength, max, fallback) {
  if (!Array.isArray(raw)) return [...fallback];
  const words = raw
    .filter((item) => typeof item === 'string')
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item && item.length <= maxLength && !/[\s\p{Cc}]/u.test(item));
  return [...new Set(words)].slice(0, max);
}

function cleanText(value, max) {
  if (typeof value !== 'string') return '';
  const flat = value.replace(/\p{Cc}+/gu, ' ').trim();
  const chars = Array.from(flat);
  return chars.length <= max ? flat : chars.slice(0, max).join('').trim();
}

function cleanInt(value, fallback, [min, max]) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function cleanBool(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

function oneOf(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

// A rule: a session whose name contains `match` reports to the newest session whose name contains
// `reportsTo`, or to the person when it is 'you'. `role` (optional) sets its rank.
function cleanChain(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const rule of raw) {
    if (out.length >= MAX_CHAIN) break;
    if (!isObject(rule)) continue;
    const match = cleanText(rule.match, MAX_NAME);
    if (!match) continue;
    const to = cleanText(rule.reportsTo, MAX_NAME);
    const reportsTo = !to || /^(you|me)$/i.test(to) ? 'you' : to;
    const role = ROLES.includes(rule.role) && rule.role !== 'hidden' ? rule.role : null;
    out.push({ match, reportsTo, role });
  }
  return out;
}

// A node key, or a session name to look for (the newest session whose name contains it).
function cleanKeyOrName(value) {
  if (typeof value !== 'string') return null;
  const key = value.trim();
  if (isNodeKey(key)) return key;
  return cleanText(key, MAX_NAME) || null;
}

function cleanRoot(value) {
  if (typeof value !== 'string') return null;
  const root = value.trim();
  if (!root || root.length > MAX_PATH || CONTROL.test(root)) return null;
  return path.isAbsolute(root) ? root : null;
}

function isProjectName(name) {
  const length = Array.from(name).length;
  return length >= 1 && length <= 120 && !CONTROL.test(name);
}

// ---- path helpers ----

function pathFor(platform) {
  return platform === 'win32' ? path.win32 : path.posix;
}

function envPath(env, name, p) {
  const value = env?.[name];
  if (typeof value !== 'string' || !value.trim()) return null;
  return p.resolve(value.trim());
}

function appData(env, home, p) {
  return envPath(env, 'APPDATA', p) || p.join(home, 'AppData', 'Roaming');
}

function desktopRoot(env, platform, home, p) {
  if (platform === 'win32') return p.join(appData(env, home, p), 'Claude');
  if (platform === 'darwin') return p.join(home, 'Library', 'Application Support', 'Claude');
  return p.join(home, '.config', 'Claude');
}

function rootFor(value, p) {
  if (typeof value !== 'string') return null;
  const root = value.trim();
  return root && p.isAbsolute(root) ? root : null;
}

// ---- file helpers ----

function writeSynced(file, text) {
  const fd = fs.openSync(file, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, text, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

// On Windows a virus scanner or sync tool can hold the old file for a moment.
export function renameWithRetry(from, to) {
  for (let attempt = 1; ; attempt++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (err) {
      if (attempt >= 5 || !RETRY_CODES.has(err.code)) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50 * attempt);
    }
  }
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function deepFreeze(value) {
  for (const child of Object.values(value)) {
    if (child && typeof child === 'object') deepFreeze(child);
  }
  return Object.freeze(value);
}
