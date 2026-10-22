// HTTP server: a strict host gate, safe headers, the page files and the JSON API.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  cleanSettings,
  isNodeKey,
  loadSettings,
  renameWithRetry,
  resolveRoots,
  saveSettings as saveSettingsFile,
  settingsFile,
} from './config.js';
import { stripBom } from './jsonl.js';
import { snapshotTag } from './model.js';
import { openLimits, openSession } from './open.js';
import { newAgent, teleport } from './newagent.js';
import { GITHUB_MESSAGES, createGithub } from './github.js';
import { MODELS_MESSAGES, createModelSaver, readClaudeModels, readCodexModels } from './models.js';
import { demoClaudeModels, demoGithub, demoModels } from './demo.js';
import { rollover, rolloverInfo } from './rollover.js';
import { createSender, sendLogFile } from './send.js';

const BIND_HOST = '127.0.0.1';
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
// A Tailscale machine name, <machine>.<tailnet>.ts.net, and a Tailscale login such as ada@example.com.
const TS_HOST = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.ts\.net$/;
const KNOCK_LOGIN = /^[^\s@]{1,128}@[^\s@]{1,125}$/;
const MAX_KNOCKS = 5;
const MAX_BODY_BYTES = 64 * 1024;
const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));
const PACKAGE_FILE = new URL('../package.json', import.meta.url);
const APP_DIR = fileURLToPath(new URL('../', import.meta.url));
// A branch name in .git/HEAD: plain path parts, none starting with a dot (so never "..").
const GIT_REF = /^ref: (refs\/(?:(?!\.)[A-Za-z0-9._-]+\/)*(?!\.)[A-Za-z0-9._-]+)$/;
const GIT_SHA = /^[0-9a-f]{40}$/;

const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src-elem 'self'",
  "style-src-attr 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "manifest-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

const BASE_HEADERS = Object.freeze({
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
});

const JSON_TYPE = 'application/json; charset=utf-8';
const HTML_TYPE = 'text/html; charset=utf-8';

const PAGE_FILES = new Map([
  ['/', { dir: '', name: 'index.html', type: HTML_TYPE }],
  ['/app.js', { dir: '', name: 'app.js', type: 'text/javascript; charset=utf-8' }],
  ['/styles.css', { dir: '', name: 'styles.css', type: 'text/css; charset=utf-8' }],
  ['/favicon.ico', { dir: 'brand', name: 'favicon.ico', type: 'image/x-icon' }],
]);

const BRAND_NAME = /^[a-z0-9][a-z0-9._-]*\.(png|svg|ico|webp)$/;
// Names such as "nul.png" or "com1.svg" are devices, not files, on Windows.
const WINDOWS_DEVICE = /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/;
const BRAND_TYPES = { png: 'image/png', svg: 'image/svg+xml', ico: 'image/x-icon', webp: 'image/webp' };
const API_GET = new Set(['/api/health', '/api/snapshot', '/api/session', '/api/devices', '/api/github', '/api/mail', '/api/models']);
// Only the health check answers without the key: it says nothing but "Pleni is running".
const OPEN_API = new Set(['/api/health']);
const READ_ONLY = ['GET', 'HEAD'];
// The page address carries the key as "/?t=<key>" once; after that the browser sends it as a cookie.
const KEY_PARAM = 't';
const KEY_BYTES = 32;

const MESSAGES = {
  host: 'Pleni does not answer requests for this address.',
  noKey: 'Pleni needs its key. Open the full address Pleni printed when it started; the part after "?t=" is the key.',
  notFound: 'There is nothing here.',
  method: 'This kind of request is not allowed here.',
  badKey: 'That session key is not valid.',
  badSince: 'The "since" value must be a whole number.',
  noSession: 'Pleni could not find that session.',
  notPage: 'Settings can only be saved from the Pleni page.',
  notJson: 'Settings must be sent as JSON.',
  tooBig: 'The settings are too big to save.',
  badBody: 'Pleni could not read those settings.',
  saveFailed: 'Pleni could not save the settings.',
  reloadFailed: 'The settings were saved, but Pleni could not use them yet.',
  internal: 'Something went wrong inside Pleni.',
  badMove: 'Pleni could not read that move.',
  goneMove: 'That session is not on the map any more.',
  loopMove: 'A session cannot report to one of its own helpers.',
  badDismiss: 'Pleni could not read which notice to dismiss.',
  badWatch: 'Pleni could not read that. Only a session or the relay can be watched.',
  badHide: 'Pleni could not read that. Only a Claude Code, Codex, Grok or Kimi Code session can be hidden.',
  goneHide: 'That session is not on the map any more, so there is nothing to hide.',
  goneWatch: 'That tile is not on the map any more.',
  openRemote: 'A session can be opened in a window only on the computer that runs Pleni, not from another device.',
  rollRemote: 'A session can be rolled over only on the computer that runs Pleni, not from another device.',
  newRemote: 'A new agent can be started only on the computer that runs Pleni, not from another device.',
  teleportRemote: 'A cloud session can be brought here only on the computer that runs Pleni, not from another device.',
  sendRemote: 'A message can be sent from Pleni only on the computer that runs it, not from another device.',
  mergeRemote: 'A pull request can be merged from Pleni only on the computer that runs it, not from another device.',
  devicesRemote: "Pleni's key and the devices it turned away show only on the computer that runs Pleni.",
  hostPage: 'Pleni does not answer requests for this address yet.\n\nIf this is your own device: on the computer that runs Pleni, open Pleni, go to Settings, then Devices, and choose Allow next to this device. Then reload this page.\n',
};

// A new random key.
export function newKey() {
  return crypto.randomBytes(KEY_BYTES).toString('base64url');
}

const KEY_RE = /^[A-Za-z0-9_-]{16,}$/;
// Windows can hold a file for a moment, mostly just after you sign in (virus scanners, backup
// tools), so reading the key is tried again for about ten seconds before Pleni gives up.
const KEY_RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const KEY_TRIES = 20;
const KEY_PAUSE_MS = 500;

// The key file sits next to the settings file.
export function keyFile(settingsPath) {
  return path.join(path.dirname(settingsPath), 'key');
}

// What the key file holds: { key }, { missing: true } when there is none yet, or
// { problem: 'damaged' | <error code> }. `read` and the waits are there for tests.
export function readKeyFile(file, { tries = KEY_TRIES, pause = KEY_PAUSE_MS, read = fs.readFileSync } = {}) {
  for (let attempt = 1; ; attempt++) {
    let text;
    try {
      text = read(file, 'utf8');
    } catch (err) {
      // ENOTDIR: a file stands where the folder should be, so there is no key file either.
      if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') return { missing: true };
      if (attempt < tries && KEY_RETRY_CODES.has(err?.code)) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, pause);
        continue;
      }
      return { problem: err?.code || 'unknown' };
    }
    const kept = String(text).trim();
    return KEY_RE.test(kept) ? { key: kept } : { problem: 'damaged' };
  }
}

// Why Pleni will not start with this key file. It stops instead of making a new key, because a
// new key would change its address on every device.
export function keyFileError(file, problem) {
  const text = problem === 'damaged'
    ? `Pleni's key file is damaged: ${file}\n` +
      'Pleni did not make a new key, because that would change its address. To make a new key on ' +
      'purpose, start Pleni once with --new-key. Each browser then needs the new key once.'
    : `Pleni could not read its key file (${problem}): ${file}\n` +
      'Pleni did not make a new key, so your bookmarks keep working. Try again in a minute. If this ' +
      'keeps happening, check that no other program holds that file.';
  const err = new Error(text);
  err.code = 'PLENI_KEY_FILE';
  return err;
}

// The key kept in the key file, so Pleni's address stays the same after a restart. Pleni makes a
// key only when there is none yet, or when `renew` asks for one (--new-key). A key file it cannot
// read, or that is damaged, is never replaced: that throws keyFileError. If a new key cannot be
// saved it still works, but only until Pleni stops: { key, saved: false }.
export function loadOrCreateKey(file, { renew = false, tries, pause } = {}) {
  if (!renew) {
    const found = readKeyFile(file, { tries, pause });
    if (found.key) return { key: found.key, saved: true };
    if (!found.missing) throw keyFileError(file, found.problem);
  }
  const key = newKey();
  const temp = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(temp, `${key}\n`, { mode: 0o600 });
    renameWithRetry(temp, file);
    return { key, saved: true };
  } catch {
    try {
      fs.rmSync(temp, { force: true });
    } catch {
      // Nothing was written.
    }
    return { key, saved: false };
  }
}

// getSettings() -> { settings, file, roots }; saveSettings(clean) saves and returns the same shape.
// Without them, settings are read from and saved to the usual settings file.
// `key` is the secret every API request needs (see keyAllowed); a new one is made when it is left out.
// `platform` and `spawnProcess` are for Open in PowerShell (see src/open.js), `github` for live
// GitHub status (see src/github.js), `modelSaver` for the Models page (see src/models.js) and
// `sender` for Send (see src/send.js); tests replace them.
export function createServer({ store, getSettings, saveSettings, publicDir = PUBLIC_DIR, version = readVersion(), build = readBuild(), key = newKey(), platform = process.platform, spawnProcess = null, github = null, modelSaver = null, sender = null }) {
  if (typeof key !== 'string' || !KEY_RE.test(key)) {
    throw new Error('The server key must be at least 16 letters, digits, "-" or "_".');
  }
  const fallback = getSettings && saveSettings ? null : fileSettings(settingsFile());
  const app = {
    store,
    publicDir,
    version,
    build,
    key,
    keyHash: hashKey(key),
    readSettings: getSettings ?? fallback.get,
    writeSettings: saveSettings ?? fallback.save,
    platform,
    spawnProcess,
    opens: openLimits(),
    github: github ?? createGithub(),
    models: modelSaver ?? createModelSaver(),
    sender: sender ?? createSender(spawnProcess ? { spawn: spawnProcess } : {}),
    knocks: new Map(),
  };
  return http.createServer((req, res) => {
    handle(app, req, res).catch(() => {
      if (res.headersSent) res.destroy();
      else sendError(req, res, 500, MESSAGES.internal);
    });
  });
}

export async function start({ port, configFile, demo = false, open = false, renewKey = false } = {}) {
  const file = configFile ? path.resolve(configFile) : settingsFile();
  const settings = fileSettings(file);
  const first = settings.get();
  if (first.error) process.stderr.write(`${first.error}\n`);
  // Demo mode gets a throw-away key, so trying the demo never touches the real one. The key comes
  // first: a key file that cannot be used stops Pleni before anything else starts.
  const kept = demo ? { key: newKey(), saved: false } : loadOrCreateKey(keyFile(file), { renew: renewKey });
  const { key } = kept;
  // Loaded here, not at the top, so createServer works without the sources.
  const { createStore } = await import('./store.js');
  // Dismissed notices are kept next to the settings, so every device sees the same; the demo keeps
  // them only while it runs.
  const store = createStore({ settings: first.settings, roots: first.roots, demo, stateDir: demo ? null : path.dirname(file) });
  const server = createServer({ store, getSettings: settings.get, saveSettings: settings.save, key });
  try {
    await listen(server, port ?? first.settings.port);
  } catch (err) {
    await closeStore(store);
    throw err;
  }
  const url = `http://localhost:${server.address().port}/?${KEY_PARAM}=${key}`;
  let closing = null;
  const close = () => (closing ??= shutdown(server, store));
  if (open) openBrowser(url);
  const remote = demo ? [] : first.settings.remote.hosts.map((h) => `https://${h}/`);
  return { server, url, key, keySaved: kept.saved, remote, close };
}

// The command that opens a web page in the default browser, without a shell.
export function browserCommand(url, platform = process.platform) {
  if (platform === 'win32') return ['cmd', ['/c', 'start', '', url]];
  if (platform === 'darwin') return ['open', [url]];
  return ['xdg-open', [url]];
}

// ---- request handling ----

async function handle(app, req, res) {
  const host = parseHost(req.headers.host);
  if (!hostAllowed(host, req, app.readSettings())) return refuseHost(app, req, res, host);
  const [pathname, query] = splitUrl(req.url);
  const methods = allowedMethods(pathname);
  if (!methods) return sendError(req, res, 404, MESSAGES.notFound);
  if (!methods.includes(req.method)) {
    return sendError(req, res, 405, MESSAGES.method, { Allow: methods.join(', ') });
  }
  if (pathname.startsWith('/api/') && !OPEN_API.has(pathname) && !keyAllowed(app, req)) {
    return sendError(req, res, 401, MESSAGES.noKey);
  }
  if (req.method === 'POST') {
    if (pathname === '/api/placement') return postPlacement(app, req, res, host);
    if (pathname === '/api/dismiss') return postDismiss(app, req, res, host);
    if (pathname === '/api/watch') return postWatch(app, req, res, host);
    if (pathname === '/api/hide') return postHide(app, req, res, host);
    if (pathname === '/api/open') return postOpen(app, req, res, host);
    if (pathname === '/api/rollover') return postRollover(app, req, res, host);
    if (pathname === '/api/new') return postNewAgent(app, req, res, host);
    if (pathname === '/api/teleport') return postTeleport(app, req, res, host);
    if (pathname === '/api/send') return postSend(app, req, res, host);
    if (pathname === '/api/github/merge') return postMerge(app, req, res, host);
    if (pathname === '/api/models') return postModels(app, req, res, host);
    return postSettings(app, req, res, host);
  }
  if (pathname.startsWith('/brand/')) return sendBrand(app, req, res, pathname.slice('/brand/'.length));
  if (pathname === '/' && new URLSearchParams(query).has(KEY_PARAM)) return takeKey(app, req, res, query);
  if (PAGE_FILES.has(pathname)) return sendPageFile(app, req, res, PAGE_FILES.get(pathname));
  if (pathname === '/api/health') return sendJson(req, res, 200, { ok: true, version: app.version });
  if (pathname === '/api/snapshot') return sendSnapshot(app, req, res);
  if (pathname === '/api/session') return sendSession(app, req, res, new URLSearchParams(query));
  if (pathname === '/api/rollover') return sendRollover(app, req, res, host, new URLSearchParams(query));
  if (pathname === '/api/send') return sendSendInfo(app, req, res, host, new URLSearchParams(query));
  if (pathname === '/api/devices') return sendDevices(app, req, res, host);
  if (pathname === '/api/github') return sendGithub(app, req, res, host, new URLSearchParams(query));
  if (pathname === '/api/mail') return sendMail(app, req, res, new URLSearchParams(query));
  if (pathname === '/api/models') return sendModels(app, req, res, host);
  return sendJson(req, res, 200, await settingsPayload(app, app.readSettings()));
}

function allowedMethods(pathname) {
  if (pathname === '/api/settings' || pathname === '/api/rollover' || pathname === '/api/models' || pathname === '/api/send') return ['GET', 'HEAD', 'POST'];
  if (['/api/placement', '/api/dismiss', '/api/watch', '/api/hide', '/api/open', '/api/new', '/api/teleport', '/api/github/merge'].includes(pathname)) return ['POST'];
  if (PAGE_FILES.has(pathname) || API_GET.has(pathname)) return READ_ONLY;
  if (/^\/brand\/[^/]+$/.test(pathname)) return READ_ONLY;
  return null;
}

// The raw path is matched as it is: no decoding and no dot-segment clean-up, so tricks such as
// "/brand/%2e%2e/x" or "/brand/../x" never reach a file.
function splitUrl(url = '') {
  const mark = url.indexOf('?');
  return mark === -1 ? [url, ''] : [url.slice(0, mark), url.slice(mark + 1)];
}

// ---- host gate ----

function parseHost(value) {
  if (typeof value !== 'string') return null;
  const host = value.trim().toLowerCase();
  const match = /^(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::\d{1,5})?$/.exec(host);
  return match ? { host, name: match[1] } : null;
}

// Only the loopback names, or a listed remote name reached by a listed Tailscale login.
// Checking the Host header this way also blocks DNS rebinding.
function hostAllowed(host, req, state) {
  if (!host) return false;
  if (LOCAL_HOSTS.has(host.name)) return true;
  const remote = state?.settings?.remote ?? {};
  const hosts = lowerList(remote.hosts);
  if (!hosts.includes(host.name) && !hosts.includes(host.host)) return false;
  const login = req.headers['tailscale-user-login'];
  return typeof login === 'string' && lowerList(remote.tailscaleUsers).includes(login.trim().toLowerCase());
}

// A turned-away visit through Tailscale is kept (in memory, the last few), so Settings can offer to
// allow that device. A browser that opens a page gets plain words; the API keeps its JSON error.
function refuseHost(app, req, res, host) {
  noteKnock(app, host, req);
  if (String(req.url ?? '').startsWith('/api/')) return sendError(req, res, 403, MESSAGES.host);
  return send(req, res, 403, { 'Content-Type': 'text/plain; charset=utf-8' }, MESSAGES.hostPage);
}

// Only a visit that came through Tailscale counts: a <machine>.<tailnet>.ts.net name, which no web
// site can point at this computer, and the Tailscale login that Tailscale adds.
function noteKnock(app, host, req, now = Date.now()) {
  const login = req.headers['tailscale-user-login'];
  if (!host || !TS_HOST.test(host.name) || typeof login !== 'string') return;
  const who = login.trim().toLowerCase();
  if (!KNOCK_LOGIN.test(who)) return;
  const id = `${host.name}|${who}`;
  app.knocks.delete(id);
  app.knocks.set(id, { host: host.name, login: who, at: now });
  while (app.knocks.size > MAX_KNOCKS) app.knocks.delete(app.knocks.keys().next().value);
}

function lowerList(list) {
  return Array.isArray(list) ? list.filter((item) => typeof item === 'string').map((item) => item.toLowerCase()) : [];
}

// ---- key gate ----
// The host gate stops web sites, but any program or other account on this computer can reach
// 127.0.0.1 and send any header it likes, including Tailscale's. So every API request must also
// carry the per-run key, which only the person who started Pleni has seen.

// One cookie name per port, so two Plenis on one computer do not overwrite each other's key.
function cookieName(req) {
  return `pleni-${req.socket.localPort}`;
}

function hashKey(text) {
  return crypto.createHash('sha256').update(String(text)).digest();
}

// Hashing first gives two buffers of the same length, so the comparison takes the same time
// whatever the guess is.
function keyMatches(app, text) {
  return typeof text === 'string' && text.length > 0 && crypto.timingSafeEqual(hashKey(text), app.keyHash);
}

function keyAllowed(app, req) {
  return keyMatches(app, readCookie(req.headers.cookie, cookieName(req)));
}

function readCookie(header, name) {
  if (typeof header !== 'string') return null;
  for (const part of header.split(';')) {
    const mark = part.indexOf('=');
    if (mark !== -1 && part.slice(0, mark).trim() === name) return part.slice(mark + 1).trim();
  }
  return null;
}

// "/?t=<key>": a right key becomes a cookie the page's own scripts cannot read (HttpOnly) and that
// other sites cannot make the browser send (SameSite=Strict). It lasts a year, so a device signs in
// once while the key stays the same. Either way the browser is sent on to "/", so the key does not
// stay in the address bar.
const COOKIE_SECONDS = 365 * 24 * 60 * 60;
function takeKey(app, req, res, query) {
  const headers = { Location: '/' };
  if (keyMatches(app, new URLSearchParams(query).get(KEY_PARAM))) {
    headers['Set-Cookie'] = `${cookieName(req)}=${app.key}; Path=/; Max-Age=${COOKIE_SECONDS}; HttpOnly; SameSite=Strict`;
  }
  return send(req, res, 303, headers, '');
}

// ---- static files ----

async function sendPageFile(app, req, res, entry) {
  const body = await readInside(path.join(app.publicDir, entry.dir), entry.name);
  if (!body) return sendError(req, res, 404, MESSAGES.notFound);
  const headers = { 'Content-Type': entry.type };
  if (entry.type === HTML_TYPE) headers['Content-Security-Policy'] = CSP;
  return send(req, res, 200, headers, body);
}

async function sendBrand(app, req, res, name) {
  const match = BRAND_NAME.exec(name);
  if (!match || WINDOWS_DEVICE.test(name)) return sendError(req, res, 404, MESSAGES.notFound);
  const body = await readInside(path.join(app.publicDir, 'brand'), name);
  if (!body) return sendError(req, res, 404, MESSAGES.notFound);
  return send(req, res, 200, { 'Content-Type': BRAND_TYPES[match[1]] }, body);
}

// Reads `name` only if, after following links, it is a plain file directly inside `dir`.
async function readInside(dir, name) {
  try {
    const [realDir, realFile] = await Promise.all([
      fs.promises.realpath(dir),
      fs.promises.realpath(path.join(dir, name)),
    ]);
    if (path.dirname(realFile) !== realDir) return null;
    const stat = await fs.promises.stat(realFile);
    return stat.isFile() ? await fs.promises.readFile(realFile) : null;
  } catch {
    return null;
  }
}

// ---- API ----

// Uses the JSON and ETag the store already made, when it made them.
async function sendSnapshot(app, req, res) {
  const snap = await app.store.snapshot();
  const body = typeof snap?.json === 'string' ? snap.json : JSON.stringify(snap ?? null);
  const etag = typeof snap?.etag === 'string' ? snap.etag : snapshotTag(snap);
  // The page shows which Pleni answers, and notices when an update has restarted it.
  const about = { 'X-Pleni-Version': app.version, ...(app.build ? { 'X-Pleni-Build': app.build } : {}) };
  if (etagMatches(req.headers['if-none-match'], etag)) return send(req, res, 304, { ETag: etag, ...about });
  return send(req, res, 200, { 'Content-Type': JSON_TYPE, ETag: etag, ...about }, body);
}

function etagMatches(header, etag) {
  if (typeof header !== 'string') return false;
  const bare = (tag) => tag.trim().replace(/^W\//, '');
  return header.split(',').some((tag) => tag.trim() === '*' || bare(tag) === bare(etag));
}

async function sendSession(app, req, res, params) {
  const key = params.get('key');
  if (!isNodeKey(key)) return sendError(req, res, 400, MESSAGES.badKey);
  const sinceText = params.get('since');
  let since = null;
  if (sinceText !== null && sinceText !== '') {
    if (!/^\d{1,15}$/.test(sinceText)) return sendError(req, res, 400, MESSAGES.badSince);
    since = Number(sinceText);
  }
  const detail = await app.store.detail(key, since);
  if (!detail) return sendError(req, res, 404, MESSAGES.noSession);
  return sendJson(req, res, 200, detail);
}

// The Mail page: { on, name, readAt, messages } with the person's mail, or every message with ?all=1.
// Only reads: marking mail as read is a dismissal ("you|mailread"), kept in Pleni's own folder.
async function sendMail(app, req, res, params) {
  const all = params.get('all') === '1';
  const mail = typeof app.store.mail === 'function' ? await app.store.mail({ all }) : null;
  if (!mail) return sendJson(req, res, 200, { on: false, name: null, readAt: null, messages: [] });
  return sendJson(req, res, 200, { on: true, ...mail });
}

async function settingsPayload(app, state) {
  const snapshot = await app.store.snapshot();
  // Hidden sessions are not on the map, but Settings still names them.
  const all = [...(Array.isArray(snapshot?.nodes) ? snapshot.nodes : []), ...(Array.isArray(snapshot?.hiddenSessions) ? snapshot.hiddenSessions : [])];
  const nodes = all.map(({ key, title, platform, kind }) => ({ key, title, platform, kind }));
  return { settings: state.settings, file: state.file, roots: state.roots, nodes, platform: app.platform };
}

// The key cookie is checked before this. A web page on another site cannot add the X-Pleni header
// without the browser asking first, and that request is refused, so the header plus the Origin
// check also stops cross-site saves.
async function postSettings(app, req, res, host) {
  const body = await readJsonPost(req, res, host);
  if (body === undefined) return undefined;
  return saveAndReload(app, req, res, cleanSettings(body), (state) => settingsPayload(app, state));
}

// "Reports to" from the menu or a drag on the map: { key, reportsTo: node key | 'you' | null }.
// null goes back to automatic. It is saved as the person's choice for that session (people[key]).
async function postPlacement(app, req, res, host) {
  const body = await readJsonPost(req, res, host);
  if (body === undefined) return undefined;
  const key = typeof body.key === 'string' ? body.key : '';
  const boss = body.reportsTo === null ? null : typeof body.reportsTo === 'string' ? body.reportsTo : undefined;
  const movable = (k) => isNodeKey(k) && k !== 'you' && !k.startsWith('project:');
  if (!movable(key) || boss === undefined || (boss !== null && boss !== 'you' && !movable(boss))) {
    return sendError(req, res, 400, MESSAGES.badMove);
  }
  const nodes = new Map((app.store.snapshot()?.nodes ?? []).map((n) => [n.key, n]));
  const named = boss !== null && boss !== 'you';
  if (!nodes.has(key) || (named && !nodes.has(boss))) return sendError(req, res, 404, MESSAGES.goneMove);
  if (named && isUnder(nodes, boss, key)) return sendError(req, res, 400, MESSAGES.loopMove);
  const next = structuredClone(app.readSettings().settings);
  const own = { ...(next.people[key] ?? {}) };
  if (boss === null) delete own.reportsTo;
  else own.reportsTo = boss;
  if (Object.keys(own).length) next.people[key] = own;
  else delete next.people[key];
  return saveAndReload(app, req, res, cleanSettings(next), () => ({ ok: true }));
}

// "Hide from the map" from a session's side panel: { key, hide: true } saves people[key].role =
// 'hidden', the same as Settings' Role "Hide it", and answers { ok: true, role } with the role it
// had before (null for none). Undo sends { key, hide: false, role } to put that role back. Hiding
// only changes Pleni's settings: no session file is touched.
const HIDE_KEY = /^(claude|codex|grok|kimi):/;
const UNHIDE_ROLES = new Set(['superintendent', 'coordinator', 'lead', 'worker']);
async function postHide(app, req, res, host) {
  const body = await readJsonPost(req, res, host);
  if (body === undefined) return undefined;
  const key = typeof body.key === 'string' ? body.key : '';
  const role = body.role ?? null;
  if (!isNodeKey(key) || !HIDE_KEY.test(key) || typeof body.hide !== 'boolean' || (role !== null && !UNHIDE_ROLES.has(role))) {
    return sendError(req, res, 400, MESSAGES.badHide);
  }
  const next = structuredClone(app.readSettings().settings);
  const own = { ...(next.people[key] ?? {}) };
  const before = own.role ?? null;
  if (body.hide) {
    const node = (app.store.snapshot()?.nodes ?? []).find((n) => n.key === key);
    if (!node) return sendError(req, res, 404, MESSAGES.goneHide);
    if (!['session', 'agent', 'reviewer'].includes(node.kind)) return sendError(req, res, 400, MESSAGES.badHide);
    own.role = 'hidden';
  } else if (before === 'hidden') {
    if (role) own.role = role;
    else delete own.role;
  }
  if (Object.keys(own).length) next.people[key] = own;
  else delete next.people[key];
  return saveAndReload(app, req, res, cleanSettings(next), () => ({ ok: true, role: body.hide && before !== 'hidden' ? before : null }));
}

// "Tell me if this stops working" from a tile's side panel: { key, watch: true | false }. Only a
// session or the relay can be watched; it is saved with the person's other choices (people[key]).
async function postWatch(app, req, res, host) {
  const body = await readJsonPost(req, res, host);
  if (body === undefined) return undefined;
  const key = typeof body.key === 'string' ? body.key : '';
  const watchable = key === 'relay' || (isNodeKey(key) && !['you', 'project:', 'mailbox:'].some((start) => key.startsWith(start)));
  if (!watchable || typeof body.watch !== 'boolean') return sendError(req, res, 400, MESSAGES.badWatch);
  const node = (app.store.snapshot()?.nodes ?? []).find((n) => n.key === key);
  if (!node) return sendError(req, res, 404, MESSAGES.goneWatch);
  if (key !== 'relay' && !['session', 'agent', 'reviewer'].includes(node.kind)) return sendError(req, res, 400, MESSAGES.badWatch);
  const next = structuredClone(app.readSettings().settings);
  const own = { ...(next.people[key] ?? {}) };
  if (body.watch) own.watch = true;
  else delete own.watch;
  if (Object.keys(own).length) next.people[key] = own;
  else delete next.people[key];
  return saveAndReload(app, req, res, cleanSettings(next), () => ({ ok: true }));
}

// Dismiss a "Needs you" notice: { id: '<key>|<kind>', at: <its time> }, or { id, at: null } to
// bring it back. It stays hidden until something newer happens.
// "you|mailread" is the time of the newest mail the person marked as read on the Mail page.
const NOTICE_ID = /^[^\s|\p{Cc}]{1,250}\|(needs|error|question|review|alert|paused|halted|note|stopped|mail|mailread)$/u;
async function postDismiss(app, req, res, host) {
  const body = await readJsonPost(req, res, host);
  if (body === undefined) return undefined;
  const { id, at } = body;
  const time = at === null || (Number.isFinite(at) && at >= 0 && at <= 8.64e15);
  if (typeof id !== 'string' || !NOTICE_ID.test(id) || !time) return sendError(req, res, 400, MESSAGES.badDismiss);
  if (typeof app.store.dismiss !== 'function') return sendError(req, res, 500, MESSAGES.internal);
  app.store.dismiss(id, at);
  return sendJson(req, res, 200, { ok: true });
}

// Open in PowerShell: { key: 'claude:<session id>' | 'codex:<thread id>' }. src/open.js makes the
// other checks: the setting is on, Pleni runs on Windows, the session is on the map, and no other
// window has it open.
async function postOpen(app, req, res, host) {
  const body = await readJsonPost(req, res, host);
  if (body === undefined) return undefined;
  if (!isLocalRequest(host, req)) return sendError(req, res, 403, MESSAGES.openRemote);
  const state = app.readSettings();
  const result = await openSession({
    key: body.key,
    settings: state.settings,
    roots: state.roots ?? {},
    store: app.store,
    limits: app.opens,
    platform: app.platform,
    ...(app.spawnProcess ? { spawn: app.spawnProcess } : {}),
  });
  if (result.ok) return sendJson(req, res, 200, { ok: true });
  return sendError(req, res, result.status, result.error);
}

// Roll over, one step at a time: GET /api/rollover?key=<key> answers what the page shows before
// either step ({ name, problem, file, ask, start, rename, handoffAt }), and POST /api/rollover
// { key, step: 'ask' | 'start', name } takes one step. Both work only on this computer, like Open in
// PowerShell; src/rollover.js makes the other checks.
function sendRollover(app, req, res, host, params) {
  if (!isLocalRequest(host, req)) return sendError(req, res, 403, MESSAGES.rollRemote);
  const result = rolloverInfo({ key: params.get('key'), settings: app.readSettings().settings, store: app.store, platform: app.platform });
  if (result.ok) return sendJson(req, res, 200, result.info);
  return sendError(req, res, result.status, result.error);
}

async function postRollover(app, req, res, host) {
  const body = await readJsonPost(req, res, host);
  if (body === undefined) return undefined;
  if (!isLocalRequest(host, req)) return sendError(req, res, 403, MESSAGES.rollRemote);
  const state = app.readSettings();
  const result = await rollover({
    key: body.key,
    step: body.step,
    name: body.name,
    settings: state.settings,
    roots: state.roots ?? {},
    store: app.store,
    limits: app.opens,
    platform: app.platform,
    ...(app.spawnProcess ? { spawn: app.spawnProcess } : {}),
  });
  if (result.ok) return sendJson(req, res, 200, { ok: true });
  return sendError(req, res, result.status, result.error);
}

// New agent: { from: '<session key>', tool: 'claude' | 'codex', name }. Only on this computer, like
// Open in PowerShell; src/newagent.js makes the other checks.
async function postNewAgent(app, req, res, host) {
  const body = await readJsonPost(req, res, host);
  if (body === undefined) return undefined;
  if (!isLocalRequest(host, req)) return sendError(req, res, 403, MESSAGES.newRemote);
  const state = app.readSettings();
  const result = await newAgent({
    from: body.from,
    tool: body.tool,
    name: body.name,
    settings: state.settings,
    roots: state.roots ?? {},
    store: app.store,
    limits: app.opens,
    platform: app.platform,
    ...(app.spawnProcess ? { spawn: app.spawnProcess } : {}),
  });
  if (result.ok) return sendJson(req, res, 200, { ok: true });
  return sendError(req, res, result.status, result.error);
}

// Bring a cloud session here: { from: '<Claude Code session key>' }. Only on this computer, like
// Open in PowerShell; src/newagent.js makes the other checks.
async function postTeleport(app, req, res, host) {
  const body = await readJsonPost(req, res, host);
  if (body === undefined) return undefined;
  if (!isLocalRequest(host, req)) return sendError(req, res, 403, MESSAGES.teleportRemote);
  const state = app.readSettings();
  const result = await teleport({
    from: body.from,
    settings: state.settings,
    roots: state.roots ?? {},
    store: app.store,
    limits: app.opens,
    platform: app.platform,
    ...(app.spawnProcess ? { spawn: app.spawnProcess } : {}),
  });
  if (result.ok) return sendJson(req, res, 200, { ok: true });
  return sendError(req, res, result.status, result.error);
}

// Send a message: GET /api/send?key=<key> answers what the page shows before a send ({ problem,
// running, last, mode }), and POST /api/send { key, text, id } sends one message as a hidden turn of
// that session. Both work only on this computer, like Open in PowerShell; src/send.js makes the other
// checks. The message goes to the program's standard input and is not kept.
function sendSendInfo(app, req, res, host, params) {
  if (!isLocalRequest(host, req)) return sendError(req, res, 403, MESSAGES.sendRemote);
  const result = app.sender.info({ key: params.get('key'), settings: app.readSettings().settings, store: app.store, platform: app.platform });
  if (result.ok) return sendJson(req, res, 200, result.info);
  return sendError(req, res, result.status, result.error);
}

async function postSend(app, req, res, host) {
  const body = await readJsonPost(req, res, host);
  if (body === undefined) return undefined;
  if (!isLocalRequest(host, req)) return sendError(req, res, 403, MESSAGES.sendRemote);
  const state = app.readSettings();
  const result = await app.sender.send({
    key: body.key,
    text: body.text,
    id: body.id,
    settings: state.settings,
    roots: state.roots ?? {},
    store: app.store,
    logFile: sendLogFile(state.file ?? settingsFile()),
    platform: app.platform,
  });
  if (result.ok) return sendJson(req, res, 200, result.repeat ? { ok: true, repeat: true } : { ok: true });
  return sendError(req, res, result.status, result.error);
}

// Live pull request status for the GitHub repositories on the map, when settings.github.live is on.
// `merge` says whether this page may offer Merge: the setting is on and the request is from this
// computer. `?fresh=1` is the Look again button.
async function sendGithub(app, req, res, host, params) {
  const { github } = app.readSettings().settings;
  const base = { on: github.live, merge: github.live && github.merge && isLocalRequest(host, req), method: github.mergeMethod };
  if (!github.live) return sendJson(req, res, 200, { ...base, error: null, repos: [] });
  const repos = reposOnMap(app.store);
  const answer = app.store.demo ? demoGithub(repos) : await app.github.status({ repos, fresh: params.get('fresh') === '1' });
  return sendJson(req, res, 200, { ...base, ...answer });
}

// Merge: { repo: 'owner/name', number, head: '<commit id the page showed>' }. Only on this computer;
// src/github.js looks again and makes the other checks.
async function postMerge(app, req, res, host) {
  const body = await readJsonPost(req, res, host);
  if (body === undefined) return undefined;
  if (!isLocalRequest(host, req)) return sendError(req, res, 403, MESSAGES.mergeRemote);
  const { github } = app.readSettings().settings;
  if (!github.live) return sendError(req, res, 403, GITHUB_MESSAGES.off);
  if (!github.merge) return sendError(req, res, 403, GITHUB_MESSAGES.mergeOff);
  if (app.store.demo) return sendError(req, res, 409, GITHUB_MESSAGES.demo);
  const result = await app.github.merge({
    repo: body.repo,
    number: body.number,
    head: body.head,
    method: github.mergeMethod,
    known: new Set(reposOnMap(app.store)),
  });
  if (result.ok) return sendJson(req, res, 200, { ok: true });
  return sendError(req, res, result.status, result.error);
}

// The Models page: { edit, here, demo, codex, claude }, what Codex's and Claude Code's settings say
// about models and effort (src/models.js). `edit` is settings.models.edit; saving works only when
// `here` (this computer) is true as well.
function sendModels(app, req, res, host) {
  const state = app.readSettings();
  const base = { edit: state.settings.models?.edit === true, here: isLocalRequest(host, req), demo: app.store.demo === true };
  if (app.store.demo) return sendJson(req, res, 200, { ...base, codex: demoModels(), claude: demoClaudeModels() });
  const codex = readCodexModels({ root: state.roots?.codex ?? null, seen: modelsOnMap(app.store, 'codex') });
  const claude = readClaudeModels({ root: state.roots?.claude ?? null, seen: modelsOnMap(app.store, 'claude') });
  return sendJson(req, res, 200, { ...base, codex, claude });
}

// Save to Codex or Save to Claude Code: { app: 'codex' | 'claude', tag, sergeant?, worker?, types?,
// add? }. Only on this computer and with settings.models.edit on; src/models.js makes the other
// checks and keeps a copy of each file it changes, in a "backups" folder next to Pleni's settings.
async function postModels(app, req, res, host) {
  const body = await readJsonPost(req, res, host);
  if (body === undefined) return undefined;
  if (!isLocalRequest(host, req)) return sendError(req, res, 403, MODELS_MESSAGES.remote);
  const state = app.readSettings();
  if (state.settings.models?.edit !== true) return sendError(req, res, 403, MODELS_MESSAGES.off);
  if (app.store.demo) return sendError(req, res, 409, MODELS_MESSAGES.demo);
  const which = body.app === 'claude' ? 'claude' : 'codex';
  const result = app.models.save({
    app: which,
    root: state.roots?.[which] ?? null,
    backupDir: path.join(path.dirname(state.file ?? settingsFile()), 'backups'),
    tag: body.tag,
    changes: { sergeant: body.sergeant, worker: body.worker, types: body.types, add: body.add },
  });
  if (result.ok) return sendJson(req, res, 200, { ok: true, files: result.files, backups: result.backups });
  return sendError(req, res, result.status, result.error);
}

// The models of one tool's sessions on the map, most used first, leaving out Codex's reviewers.
function modelsOnMap(store, platform) {
  const count = new Map();
  for (const n of store.snapshot()?.nodes ?? []) {
    if (n?.platform !== platform || n.kind === 'reviewer' || typeof n.model !== 'string') continue;
    count.set(n.model, (count.get(n.model) ?? 0) + 1);
  }
  return [...count].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([model]) => model);
}

// The GitHub repositories the sessions on the map work in (node.github), not counting reviewers.
function reposOnMap(store) {
  const repos = new Set();
  for (const n of store.snapshot()?.nodes ?? []) {
    if (n && typeof n.github === 'string' && n.kind !== 'reviewer') repos.add(n.github);
  }
  return [...repos];
}

// What Settings shows under Devices, only on this computer: the addresses for other devices, the
// key, and the devices turned away lately (newest first), each with whether it is allowed now.
function sendDevices(app, req, res, host) {
  if (!isLocalRequest(host, req)) return sendError(req, res, 403, MESSAGES.devicesRemote);
  const { settings } = app.readSettings();
  const hosts = lowerList(settings?.remote?.hosts);
  const logins = lowerList(settings?.remote?.tailscaleUsers);
  const knocks = [...app.knocks.values()].reverse().map((k) => ({ ...k, allowed: hosts.includes(k.host) && logins.includes(k.login) }));
  return sendJson(req, res, 200, { addresses: hosts.map((h) => `https://${h}/`), key: app.key, knocks });
}

// A window opens on this computer, so only the person at it may ask: a request passed on by a proxy
// such as tailscale serve (from a phone, say) is refused, even with the key.
function isLocalRequest(host, req) {
  return LOCAL_HOSTS.has(host.name) && req.headers['tailscale-user-login'] === undefined && req.headers['x-forwarded-for'] === undefined;
}

// True when `key` is `top` or sits somewhere below it on the map.
function isUnder(nodes, key, top) {
  const seen = new Set();
  for (let at = key; at && !seen.has(at); at = nodes.get(at)?.parent ?? null) {
    if (at === top) return true;
    seen.add(at);
  }
  return false;
}

async function saveAndReload(app, req, res, clean, answer) {
  let state;
  try {
    state = (await app.writeSettings(clean)) ?? app.readSettings();
  } catch {
    return sendError(req, res, 500, MESSAGES.saveFailed);
  }
  try {
    await app.store.reload(state.settings, state.roots);
  } catch {
    return sendError(req, res, 500, MESSAGES.reloadFailed);
  }
  return sendJson(req, res, 200, await answer(state));
}

// The checks every change must pass: the X-Pleni header, the same origin, JSON and the size limit.
// On a failed check it sends the error itself and returns undefined.
async function readJsonPost(req, res, host) {
  const fail = (status, message) => void sendError(req, res, status, message);
  if (req.headers['x-pleni'] !== 'settings') return fail(403, MESSAGES.notPage);
  const origin = req.headers.origin;
  if (origin !== undefined && originHost(origin) !== host.host) return fail(403, MESSAGES.notPage);
  if (!/^application\/json\s*(;|$)/i.test(req.headers['content-type'] ?? '')) return fail(415, MESSAGES.notJson);
  if (Number(req.headers['content-length']) > MAX_BODY_BYTES) return void sendTooBig(req, res);
  let raw;
  try {
    raw = await readBody(req, MAX_BODY_BYTES);
  } catch (err) {
    if (err.code === 'TOO_BIG') return void sendTooBig(req, res);
    throw err;
  }
  let body;
  try {
    body = JSON.parse(stripBom(raw.toString('utf8')));
  } catch {
    return fail(400, MESSAGES.badBody);
  }
  if (!isPlainObject(body)) return fail(400, MESSAGES.badBody);
  return body;
}

function originHost(origin) {
  try {
    return new URL(origin).host.toLowerCase();
  } catch {
    return null;
  }
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size <= limit) {
        chunks.push(chunk);
        return;
      }
      req.removeAllListeners('data');
      req.resume();
      reject(Object.assign(new Error('body too big'), { code: 'TOO_BIG' }));
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendTooBig(req, res) {
  req.resume();
  return sendError(req, res, 413, MESSAGES.tooBig, { Connection: 'close' });
}

// ---- responses ----

function send(req, res, status, headers, body) {
  const all = { ...BASE_HEADERS, ...headers };
  if (body !== undefined) all['Content-Length'] = Buffer.byteLength(body);
  res.writeHead(status, all);
  res.end(req.method === 'HEAD' ? undefined : body);
}

function sendJson(req, res, status, value, headers = {}) {
  send(req, res, status, { 'Content-Type': JSON_TYPE, ...headers }, JSON.stringify(value));
}

function sendError(req, res, status, message, headers = {}) {
  sendJson(req, res, status, { error: message }, headers);
}

// ---- settings kept in a file ----

function fileSettings(file) {
  let state = null;
  const get = () => {
    if (!state) {
      const loaded = loadSettings(file);
      state = { settings: loaded.settings, file, roots: resolveRoots(loaded.settings), error: loaded.error };
    }
    return state;
  };
  const save = (clean) => {
    const saved = saveSettingsFile(clean, file);
    state = { settings: saved, file, roots: resolveRoots(saved), error: null };
    return state;
  };
  return { get, save };
}

// ---- start and stop ----

function listen(server, port) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      server.off('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen({ port, host: BIND_HOST });
  });
}

async function shutdown(server, store) {
  await new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
  await closeStore(store);
}

async function closeStore(store) {
  try {
    await store?.close?.();
  } catch {
    // Stopping anyway; there is nothing useful to do with this error.
  }
}

function openBrowser(url) {
  const [command, args] = browserCommand(url);
  const cannotOpen = () => process.stderr.write(`Pleni could not open your browser. Open ${url} yourself.\n`);
  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true, windowsHide: true });
    child.on('error', cannotOpen);
    child.unref();
  } catch {
    cannotOpen();
  }
}

function readVersion() {
  try {
    return JSON.parse(fs.readFileSync(PACKAGE_FILE, 'utf8')).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

// The short id of the git commit Pleni runs from, when it runs from a git copy, so a person can tell
// one update from the next while the version number stays the same. Null otherwise (for example an
// npm install). It reads only .git/HEAD and the branch it names, in Pleni's own folder.
export function readBuild(dir = APP_DIR) {
  const git = path.join(dir, '.git');
  let head;
  try {
    head = fs.readFileSync(path.join(git, 'HEAD'), 'utf8').trim();
  } catch {
    return null;
  }
  const ref = GIT_REF.exec(head);
  const sha = ref ? refSha(git, ref[1]) : head;
  return typeof sha === 'string' && GIT_SHA.test(sha) ? sha.slice(0, 7) : null;
}

// A branch's commit: its own file under refs/, else its line in packed-refs.
function refSha(git, ref) {
  try {
    return fs.readFileSync(path.join(git, ...ref.split('/')), 'utf8').trim();
  } catch {
    // Not a loose ref: look in packed-refs.
  }
  try {
    for (const line of fs.readFileSync(path.join(git, 'packed-refs'), 'utf8').split(/\r?\n/)) {
      const [sha, name] = line.trim().split(' ');
      if (name === ref) return sha;
    }
  } catch {
    // No packed-refs.
  }
  return null;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
