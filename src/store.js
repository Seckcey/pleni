// Owns the sources, polls them when the page asks (at most every 2 seconds),
// and caches the snapshot with its ETag.
import fs from 'node:fs';
import path from 'node:path';
import { cleanSettings, isNodeKey } from './config.js';
import { stripBom } from './jsonl.js';
import { createDemoSource, demoSettings } from './demo.js';
import { buildSnapshot, snapshotTag } from './model.js';
import { createClaudeSource } from './sources/claude.js';
import { createCodexSource } from './sources/codex.js';
import { createMailboxSource } from './sources/mailbox.js';

export const POLL_MS = 2000;

const FACTORIES = {
  claude: createClaudeSource,
  codex: createCodexSource,
  mailbox: createMailboxSource,
  demo: createDemoSource,
};
const NAMES = { claude: 'Claude Code', codex: 'Codex', mailbox: 'the mailbox', demo: 'the demo' };
// Settings that only change how the snapshot is drawn. Changing them keeps the
// sources, so they do not have to read every session file again.
const VIEW_ONLY = new Set(['displayName', 'titles', 'groupBy', 'modelTiers', 'people', 'projects', 'chain', 'remote', 'port']);
const DISMISSED_FILE = 'dismissed.json';
const MAX_DISMISSED = 1000;

// `factories` replaces the source constructors (tests use it to inject fake sources).
// `stateDir` is where dismissed notices are kept (next to the settings); without it they last
// only while Pleni runs, which is how the demo works.
export function createStore({ settings, roots, demo = false, now = Date.now, factories = {}, stateDir = null } = {}) {
  const make = { ...FACTORIES, ...factories };
  let current = cleanSettings(settings);
  let currentRoots = { ...roots };
  let sources = {};
  let signature = null;
  let cache = null;
  const dismissed = loadDismissed(stateDir);

  openSources();

  function openSources() {
    const next = demo ? 'demo' : JSON.stringify([currentRoots, sourceSettings(current)]);
    if (next === signature) return;
    closeSources();
    signature = next;
    sources = demo ? { demo: start('demo', { now }, null) } : openReal();
  }

  function openReal() {
    const config = current.sources;
    const r = currentRoots;
    const desktopRoot = config.claudeDesktop.enabled ? r.claudeDesktop ?? null : null;
    return {
      claude: config.claude.enabled ? start('claude', { root: r.claude, desktopRoot, settings: current, now }, r.claude) : null,
      codex: config.codex.enabled ? start('codex', { root: r.codex, settings: current, now }, r.codex) : null,
      mailbox: config.mailbox.enabled ? start('mailbox', { root: r.mailbox, settings: current, now }, r.mailbox) : null,
    };
  }

  function start(name, options, root) {
    if (name !== 'demo' && !root) {
      const error = name === 'mailbox'
        ? 'Choose a mailbox folder in Settings.'
        : `Pleni does not know where ${NAMES[name]} keeps its files.`;
      return { name, source: null, root: null, error };
    }
    try {
      return { name, source: make[name](options), root, error: null };
    } catch {
      return { name, source: null, root, error: `Pleni could not start reading ${NAMES[name]}.` };
    }
  }

  function closeSources() {
    for (const entry of Object.values(sources)) {
      if (typeof entry?.source?.close !== 'function') continue;
      try {
        entry.source.close();
      } catch {
        // A source that fails to close must not stop the others from closing.
      }
    }
    sources = {};
  }

  function pollAll() {
    if (!demo) return { claude: poll(sources.claude), codex: poll(sources.codex), mailbox: poll(sources.mailbox) };
    const result = sources.demo ? poll(sources.demo) : null;
    if (result && result.ok !== false) {
      return { claude: result.claude ?? null, codex: result.codex ?? null, mailbox: result.mailbox ?? null };
    }
    const error = result?.error || 'Pleni could not build the demo just now.';
    return { claude: failed('claude', null, error), codex: failed('codex', null, error), mailbox: failed('mailbox', null, error) };
  }

  function snapshot() {
    const t = now();
    if (cache && t >= cache.at && t - cache.at < POLL_MS) return cache.snapshot;
    const snap = buildSnapshot({ now: t, settings: demo ? demoSettings(current) : current, dismissed, ...pollAll() });
    // Not enumerable, so they never show up in the JSON itself.
    Object.defineProperties(snap, { etag: { value: snapshotTag(snap) }, json: { value: JSON.stringify(snap) } });
    cache = { at: t, snapshot: snap };
    return snap;
  }

  function detail(key, since) {
    if (!isNodeKey(key) || key === 'you' || key.startsWith('project:')) return null;
    // The relay and its worker runs keep no session file: there are no events to show.
    if (key === 'relay' || key.startsWith('mailbox:')) return { events: [], next: null };
    const entry = demo ? sources.demo : sources[key.slice(0, key.indexOf(':'))];
    if (typeof entry?.source?.detail !== 'function') return null;
    let result;
    try {
      result = entry.source.detail(key, cursorOf(since));
    } catch {
      return null;
    }
    if (!isObject(result)) return null;
    return current.content === 'none' ? withoutText(result) : result;
  }

  function reload(nextSettings, nextRoots = currentRoots) {
    current = cleanSettings(nextSettings);
    currentRoots = { ...nextRoots };
    openSources();
    cache = null;
  }

  // Hides a "Needs you" notice until something newer happens; `at: null` brings it back.
  function dismiss(id, at) {
    if (at === null) dismissed.delete(id);
    else dismissed.set(id, at);
    while (dismissed.size > MAX_DISMISSED) dismissed.delete(dismissed.keys().next().value);
    saveDismissed(stateDir, dismissed);
    cache = null;
  }

  function close() {
    closeSources();
    signature = null;
    cache = null;
  }

  return { snapshot, detail, reload, close, dismiss };
}

function loadDismissed(dir) {
  const out = new Map();
  if (!dir) return out;
  try {
    const raw = JSON.parse(stripBom(fs.readFileSync(path.join(dir, DISMISSED_FILE), 'utf8')));
    const items = isObject(raw) && isObject(raw.items) ? raw.items : {};
    for (const [id, at] of Object.entries(items)) {
      if (typeof id === 'string' && id.length <= 300 && Number.isFinite(at)) out.set(id, at);
      if (out.size >= MAX_DISMISSED) break;
    }
  } catch {
    // No file yet, or a damaged one: nothing is dismissed.
  }
  return out;
}

// Written through a temp file, so a crash never leaves half a file. A failed save keeps the
// dismissals in memory for this run.
function saveDismissed(dir, dismissed) {
  if (!dir) return;
  const file = path.join(dir, DISMISSED_FILE);
  const temp = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(temp, `${JSON.stringify({ version: 1, items: Object.fromEntries(dismissed) })}\n`);
    fs.renameSync(temp, file);
  } catch {
    try {
      fs.rmSync(temp, { force: true });
    } catch {
      // Nothing more to do.
    }
  }
}

function poll(entry) {
  if (!entry) return null;
  if (!entry.source) return failed(entry.name, entry.root, entry.error);
  try {
    const result = entry.source.poll();
    if (isObject(result)) return result;
  } catch {
    // Sources should never throw; if one does, show a plain message, not the error text.
  }
  return failed(entry.name, entry.root, `Pleni could not read ${NAMES[entry.name]} just now.`);
}

function failed(name, root, error) {
  if (name === 'demo') return { ok: false, error };
  if (name === 'mailbox') return { ok: false, error, root, name: null, tasks: [], events: [], relay: null };
  return { ok: false, error, root, sessions: [] };
}

function sourceSettings(settings) {
  return Object.fromEntries(Object.entries(settings).filter(([key]) => !VIEW_ONLY.has(key)));
}

function cursorOf(since) {
  if (typeof since === 'number' && Number.isSafeInteger(since) && since >= 0) return since;
  if (typeof since === 'string' && /^\d{1,15}$/.test(since)) return Number(since);
  return null;
}

function withoutText(result) {
  const events = Array.isArray(result.events) ? result.events : [];
  return { ...result, events: events.map((event) => (isObject(event) ? { ...event, text: null } : event)) };
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
