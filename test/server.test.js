import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { cleanSettings } from '../src/config.js';
import { GITHUB_MESSAGES } from '../src/github.js';
import { NEW_MESSAGES } from '../src/newagent.js';
import { OPEN_MESSAGES } from '../src/open.js';
import { ROLL_MESSAGES } from '../src/rollover.js';
import { SEND_MESSAGES, createSender } from '../src/send.js';
import { browserCommand, createServer, keyFile, loadOrCreateKey, newKey, readBuild, readKeyFile } from '../src/server.js';

const CSP = "default-src 'none'; script-src 'self'; style-src-elem 'self'; style-src-attr 'unsafe-inline'; " +
  "img-src 'self' data:; connect-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'none'; " +
  "frame-ancestors 'none'";

const BASE_HEADERS = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
};

const SESSION_KEY = 'claude:0f8e2c4a-1b3d-4e5f-8a9b-0c1d2e3f4a5b';
const AGENT_KEY = `${SESSION_KEY}/a1b2c3`;
// The made-up per-run secret the test servers use.
const TEST_KEY = 'test-key-0123456789abcdef_XYZ';
const keyCookie = (port, key = TEST_KEY) => `pleni-${port}=${key}`;

function tempDir(t, prefix = 'pleni-server-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// A stand-in for public/: the real page files are not needed to test the server.
function makePublicDir(t) {
  const root = tempDir(t);
  const publicDir = path.join(root, 'public');
  fs.mkdirSync(path.join(publicDir, 'brand'), { recursive: true });
  fs.writeFileSync(path.join(publicDir, 'index.html'), '<!doctype html><title>test page</title>');
  fs.writeFileSync(path.join(publicDir, 'app.js'), 'export const app = 1;\n');
  fs.writeFileSync(path.join(publicDir, 'styles.css'), 'body { margin: 0; }\n');
  fs.writeFileSync(path.join(publicDir, 'brand', 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  fs.writeFileSync(path.join(publicDir, 'brand', 'mark-2.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  fs.writeFileSync(path.join(publicDir, 'brand', 'favicon.ico'), Buffer.from([0, 0, 1, 0]));
  fs.writeFileSync(path.join(publicDir, 'brand', 'notes.txt'), 'not served');
  fs.mkdirSync(path.join(publicDir, 'brand', 'sub'));
  fs.writeFileSync(path.join(publicDir, 'brand', 'sub', 'deep.png'), 'deep');
  fs.writeFileSync(path.join(publicDir, 'secret.png'), 'secret inside public');
  fs.writeFileSync(path.join(root, 'outside.png'), 'secret outside public');
  return { root, publicDir };
}

function fakeStore() {
  const store = {
    current: {
      version: 1,
      now: 1000,
      nodes: [
        { key: 'you', title: 'You', platform: 'human', kind: 'person', status: 'idle', lastText: 'x' },
        { key: SESSION_KEY, title: 'Build the thing', platform: 'claude', kind: 'session', status: 'working' },
      ],
      edges: [],
      events: [],
    },
    detailCalls: [],
    reloads: [],
    closed: false,
    snapshot() {
      return store.current;
    },
    detail(key, since) {
      store.detailCalls.push({ key, since });
      if (key !== SESSION_KEY) return null;
      return { events: [{ at: 1, kind: 'user', tool: null, text: 'hello' }], next: 42 };
    },
    reload(settings, roots) {
      store.reloads.push({ settings, roots });
    },
    close() {
      store.closed = true;
    },
  };
  return store;
}

function memorySettings(raw = {}) {
  const state = {
    settings: cleanSettings(raw),
    file: path.join(os.tmpdir(), 'pleni-memory', 'settings.json'),
    roots: { claude: null, claudeDesktop: null, codex: null, mailbox: null },
  };
  return {
    state,
    saved: [],
    getSettings: () => state,
    saveSettings(clean) {
      this.saved.push(clean);
      state.settings = clean;
      return state;
    },
  };
}

async function startServer(t, options = {}) {
  const { publicDir } = options.publicDir ? options : makePublicDir(t);
  const store = options.store ?? fakeStore();
  const memory = options.memory ?? memorySettings(options.settings);
  const server = createServer({
    store,
    publicDir,
    version: '9.9.9-test',
    build: options.build ?? null,
    key: TEST_KEY,
    ...(options.platform ? { platform: options.platform } : {}),
    ...(options.spawnProcess ? { spawnProcess: options.spawnProcess } : {}),
    ...(options.github ? { github: options.github } : {}),
    ...(options.sender ? { sender: options.sender } : {}),
    ...(options.hookKey ? { hookKey: options.hookKey } : {}),
    ...(options.useFileSettings
      ? {}
      : { getSettings: memory.getSettings, saveSettings: memory.saveSettings.bind(memory) }),
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  }));
  const port = server.address().port;
  return { server, store, memory, port, publicDir };
}

// Raw HTTP so the test controls the Host header and every other header. The key cookie is sent
// unless the test passes its own `cookie` (or `cookie: undefined` to send none).
function request(port, { method = 'GET', path: urlPath = '/', headers = {}, body, chunked = false } = {}) {
  const all = { host: `localhost:${port}`, cookie: keyCookie(port), ...headers };
  for (const name of Object.keys(all)) if (all[name] === undefined) delete all[name];
  return new Promise((resolve, reject) => {
    let answered = false;
    const req = http.request({
      host: '127.0.0.1',
      port,
      method,
      path: urlPath,
      headers: all,
      agent: false,
    }, (res) => {
      answered = true;
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, headers: res.headers, text, json: parseJson(text) });
      });
    });
    req.on('error', (err) => {
      if (!answered) reject(err);
    });
    if (body !== undefined && chunked) {
      const data = Buffer.from(body);
      for (let i = 0; i < data.length; i += 8192) req.write(data.subarray(i, i + 8192));
    } else if (body !== undefined) {
      req.setHeader('content-length', Buffer.byteLength(body));
      req.write(body);
    }
    req.end();
  });
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function assertBaseHeaders(res, label) {
  for (const [name, value] of Object.entries(BASE_HEADERS)) {
    assert.equal(res.headers[name], value, `${label}: ${name}`);
  }
}

function assertPlainError(res, status) {
  assert.equal(res.status, status);
  assert.equal(res.headers['content-type'], 'application/json; charset=utf-8');
  assert.deepEqual(Object.keys(res.json), ['error']);
  assert.equal(typeof res.json.error, 'string');
  assert.ok(res.json.error.length > 0);
  assert.ok(!/\bat\s.+:\d+:\d+/.test(res.text), 'no stack trace');
}

const postSettings = (port, body, headers = {}) => request(port, {
  method: 'POST',
  path: '/api/settings',
  headers: { 'x-pleni': 'settings', 'content-type': 'application/json', ...headers },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});

// ---- host gate ----

test('local host names are allowed with any port', async (t) => {
  const { port } = await startServer(t);
  for (const host of ['localhost', `localhost:${port}`, '127.0.0.1', `127.0.0.1:${port}`, '[::1]', `[::1]:${port}`, 'LOCALHOST:1']) {
    const res = await request(port, { path: '/api/health', headers: { host } });
    assert.equal(res.status, 200, host);
    assert.deepEqual(res.json, { ok: true, version: '9.9.9-test' });
  }
});

test('other host names are refused, which also stops DNS rebinding', async (t) => {
  const { port } = await startServer(t);
  const hosts = [
    'attacker.example.com',
    `attacker.example.com:${port}`,
    'localhost.attacker.example',
    '127.0.0.1.attacker.example',
    '127.0.0.2',
    '0.0.0.0',
    '[::2]',
    'localhost:80@attacker.example',
    'localhost/evil',
  ];
  for (const host of hosts) {
    const res = await request(port, { path: '/api/health', headers: { host } });
    assertPlainError(res, 403);
    assertBaseHeaders(res, host);
  }
});

test('a remote host needs both a listed name and a listed Tailscale login', async (t) => {
  const settings = { remote: { hosts: ['box.example.ts.net'], tailscaleUsers: ['ada@example.com'] } };
  const { port } = await startServer(t, { settings });
  const ask = (headers) => request(port, { path: '/api/health', headers });

  assert.equal((await ask({ host: 'box.example.ts.net' })).status, 403);
  assert.equal((await ask({ host: 'box.example.ts.net', 'tailscale-user-login': 'grace@example.com' })).status, 403);
  assert.equal((await ask({ host: 'other.example.ts.net', 'tailscale-user-login': 'ada@example.com' })).status, 403);
  assert.equal((await ask({ host: 'box.example.ts.net', 'tailscale-user-login': 'ada@example.com' })).status, 200);
  assert.equal((await ask({ host: 'Box.Example.TS.net:443', 'tailscale-user-login': 'ADA@Example.com' })).status, 200);
});

test('a listed Tailscale login alone does not open the gate', async (t) => {
  const settings = { remote: { hosts: [], tailscaleUsers: ['ada@example.com'] } };
  const { port } = await startServer(t, { settings });
  const res = await request(port, {
    path: '/api/health',
    headers: { host: 'box.example.ts.net', 'tailscale-user-login': 'ada@example.com' },
  });
  assert.equal(res.status, 403);
});

// ---- key gate ----

test('the API refuses requests without the key, even from this computer', async (t) => {
  const { port, memory, store } = await startServer(t);
  const settingsBody = JSON.stringify({ displayName: 'Changed by another account', remote: { hosts: ['attacker.example'] } });
  const cookies = [
    undefined,
    '',
    keyCookie(port, 'wrong-key-0123456789abcdef'),
    keyCookie(port, ''),
    keyCookie(port + 1),
    `pleni=${TEST_KEY}`,
    `other=1; pleni-${port}x=${TEST_KEY}`,
  ];
  for (const cookie of cookies) {
    for (const urlPath of ['/api/snapshot', `/api/session?key=${encodeURIComponent(SESSION_KEY)}`, '/api/settings']) {
      const res = await request(port, { path: urlPath, headers: { cookie } });
      assertPlainError(res, 401);
      assertBaseHeaders(res, `${urlPath} ${cookie}`);
      assert.ok(!res.text.includes('hello'), 'no session text');
    }
    const post = await request(port, {
      method: 'POST',
      path: '/api/settings',
      headers: { cookie, 'x-pleni': 'settings', 'content-type': 'application/json' },
      body: settingsBody,
    });
    assertPlainError(post, 401);
  }
  assert.equal(store.detailCalls.length, 0);
  assert.equal(memory.saved.length, 0);
  assert.equal(store.reloads.length, 0);
});

test('a remote request that passes the Tailscale check still needs the key', async (t) => {
  const settings = { remote: { hosts: ['box.example.ts.net'], tailscaleUsers: ['ada@example.com'] } };
  const { port } = await startServer(t, { settings });
  const remote = { host: 'box.example.ts.net', 'tailscale-user-login': 'ada@example.com' };
  assertPlainError(await request(port, { path: '/api/snapshot', headers: { ...remote, cookie: undefined } }), 401);
  assert.equal((await request(port, { path: '/api/snapshot', headers: remote })).status, 200);
});

test('the key cookie lets the API answer; the health check and page files need no key', async (t) => {
  const { port } = await startServer(t);
  assert.equal((await request(port, { path: '/api/snapshot' })).status, 200);
  assert.equal((await request(port, { path: '/api/settings', headers: { cookie: `a=1; ${keyCookie(port)}; b=2` } })).status, 200);
  for (const urlPath of ['/', '/app.js', '/styles.css', '/brand/logo.svg', '/favicon.ico', '/api/health']) {
    assert.equal((await request(port, { path: urlPath, headers: { cookie: undefined } })).status, 200, urlPath);
  }
});

test('opening /?t=<key> turns the key into a cookie and drops it from the address', async (t) => {
  const { port } = await startServer(t);
  for (const method of ['GET', 'HEAD']) {
    const res = await request(port, { method, path: `/?t=${TEST_KEY}`, headers: { cookie: undefined } });
    assert.equal(res.status, 303, method);
    assert.equal(res.headers.location, '/');
    assert.deepEqual(res.headers['set-cookie'], [`pleni-${port}=${TEST_KEY}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Strict`]);
    assert.equal(res.text, '');
    assertBaseHeaders(res, method);
  }
  const cookie = (await request(port, { path: `/?t=${TEST_KEY}`, headers: { cookie: undefined } })).headers['set-cookie'][0].split(';')[0];
  assert.equal((await request(port, { path: '/api/snapshot', headers: { cookie } })).status, 200);

  for (const wrong of ['nope', '', `${TEST_KEY}x`, TEST_KEY.slice(1)]) {
    const res = await request(port, { path: `/?t=${encodeURIComponent(wrong)}`, headers: { cookie: undefined } });
    assert.equal(res.status, 303, wrong);
    assert.equal(res.headers.location, '/');
    assert.equal(res.headers['set-cookie'], undefined, wrong);
  }
});

test('a server is never made without a usable key', () => {
  const store = fakeStore();
  const memory = memorySettings();
  const make = (key) => createServer({ store, getSettings: memory.getSettings, saveSettings: memory.saveSettings, key });
  for (const key of ['', 'short', 'has space 0123456789', 'semi;colon0123456789', 42]) {
    assert.throws(() => make(key), /key/, String(key));
  }
  assert.ok(make(undefined) instanceof http.Server);
  const keys = new Set([newKey(), newKey(), newKey()]);
  assert.equal(keys.size, 3);
  for (const key of keys) assert.match(key, /^[A-Za-z0-9_-]{43}$/);
});

test('the kept key survives a restart and only --new-key replaces it', (t) => {
  const dir = tempDir(t, 'pleni-key-');
  const file = path.join(dir, 'nested', 'key');
  assert.equal(keyFile(path.join(dir, 'nested', 'settings.json')), file);
  const first = loadOrCreateKey(file);
  assert.equal(first.saved, true);
  assert.match(first.key, /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(loadOrCreateKey(file), first);
  const renewed = loadOrCreateKey(file, { renew: true });
  assert.notEqual(renewed.key, first.key);
  assert.equal(loadOrCreateKey(file).key, renewed.key);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['key'], 'no temp file is left behind');
});

test('a damaged or unreadable key file stops Pleni instead of changing its address', (t) => {
  const dir = tempDir(t, 'pleni-key-');
  const file = path.join(dir, 'key');
  fs.writeFileSync(file, 'not a key!');
  const damaged = (err) => err.code === 'PLENI_KEY_FILE' && /damaged/.test(err.message) && /--new-key/.test(err.message);
  assert.throws(() => loadOrCreateKey(file), damaged);
  assert.equal(fs.readFileSync(file, 'utf8'), 'not a key!', 'the file is left alone');
  // --new-key still replaces it, on purpose.
  const renewed = loadOrCreateKey(file, { renew: true });
  assert.equal(fs.readFileSync(file, 'utf8').trim(), renewed.key);
  // A folder where the file should be cannot be read: nothing is replaced.
  const folder = path.join(dir, 'folder');
  fs.mkdirSync(folder);
  const unreadable = (err) => err.code === 'PLENI_KEY_FILE' && /could not read its key file/.test(err.message);
  assert.throws(() => loadOrCreateKey(folder, { tries: 1 }), unreadable);
  assert.ok(fs.statSync(folder).isDirectory());
});

test('a key file that Windows holds for a moment is read again', () => {
  let calls = 0;
  const failing = (code) => () => {
    calls += 1;
    throw Object.assign(new Error(code), { code });
  };
  const busyTwice = () => {
    calls += 1;
    if (calls < 3) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
    return '\uFEFFabcdefghijklmnopqrstuvwxyz0123456789ABCDEFG\r\n';
  };
  assert.deepEqual(readKeyFile('key', { pause: 1, read: busyTwice }), { key: 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG' });
  assert.equal(calls, 3);
  calls = 0;
  assert.deepEqual(readKeyFile('key', { tries: 4, pause: 1, read: failing('EPERM') }), { problem: 'EPERM' });
  assert.equal(calls, 4);
  calls = 0;
  assert.deepEqual(readKeyFile('key', { pause: 1, read: failing('EISDIR') }), { problem: 'EISDIR' });
  assert.equal(calls, 1, 'other problems are not tried again');
  assert.deepEqual(readKeyFile('key', { read: failing('ENOENT') }), { missing: true });
  assert.deepEqual(readKeyFile('key', { read: failing('ENOTDIR') }), { missing: true });
  assert.deepEqual(readKeyFile('key', { read: () => 'short' }), { problem: 'damaged' });
});

test('a key that cannot be saved still works for this run', (t) => {
  const dir = tempDir(t, 'pleni-key-');
  const blocker = path.join(dir, 'file');
  fs.writeFileSync(blocker, 'x');
  const result = loadOrCreateKey(path.join(blocker, 'key'));
  assert.equal(result.saved, false);
  assert.match(result.key, /^[A-Za-z0-9_-]{43}$/);
});

// ---- headers ----

test('every response carries the safety headers; only HTML gets the CSP', async (t) => {
  const { port, store } = await startServer(t);
  const etag = (await request(port, { path: '/api/snapshot' })).headers.etag;
  const cases = [
    ['page', { path: '/' }, 200],
    ['script', { path: '/app.js' }, 200],
    ['styles', { path: '/styles.css' }, 200],
    ['brand', { path: '/brand/logo.svg' }, 200],
    ['health', { path: '/api/health' }, 200],
    ['snapshot', { path: '/api/snapshot' }, 200],
    ['not modified', { path: '/api/snapshot', headers: { 'if-none-match': etag } }, 304],
    ['head', { method: 'HEAD', path: '/' }, 200],
    ['missing', { path: '/nope' }, 404],
    ['method', { method: 'DELETE', path: '/api/snapshot' }, 405],
    ['host', { path: '/', headers: { host: 'attacker.example.com' } }, 403],
    ['csrf', { method: 'POST', path: '/api/settings', headers: { 'content-type': 'application/json' }, body: '{}' }, 403],
  ];
  for (const [label, options, status] of cases) {
    const res = await request(port, options);
    assert.equal(res.status, status, label);
    assertBaseHeaders(res, label);
    const isPage = label === 'page' || label === 'head';
    assert.equal(res.headers['content-security-policy'], isPage ? CSP : undefined, label);
  }
  assert.equal(store.reloads.length, 0);
});

// ---- static routes ----

test('the page files are served with the right types', async (t) => {
  const { port, publicDir } = await startServer(t);
  const expect = [
    ['/', 'text/html; charset=utf-8', 'index.html'],
    ['/app.js', 'text/javascript; charset=utf-8', 'app.js'],
    ['/styles.css', 'text/css; charset=utf-8', 'styles.css'],
    ['/brand/logo.svg', 'image/svg+xml', 'brand/logo.svg'],
    ['/brand/mark-2.png', 'image/png', 'brand/mark-2.png'],
    ['/brand/favicon.ico', 'image/x-icon', 'brand/favicon.ico'],
    ['/favicon.ico', 'image/x-icon', 'brand/favicon.ico'],
  ];
  for (const [urlPath, type, file] of expect) {
    const res = await request(port, { path: urlPath });
    assert.equal(res.status, 200, urlPath);
    assert.equal(res.headers['content-type'], type, urlPath);
    const bytes = fs.readFileSync(path.join(publicDir, file));
    assert.equal(Number(res.headers['content-length']), bytes.length, urlPath);
  }
  assert.equal((await request(port, { path: '/?from=link' })).status, 200);
});

test('brand files cannot reach outside the brand folder', async (t) => {
  const { port } = await startServer(t);
  const paths = [
    '/brand/../secret.png',
    '/brand/..%2fsecret.png',
    '/brand/%2e%2e%2fsecret.png',
    '/brand/%2e%2e/secret.png',
    '/brand/..%5csecret.png',
    '/brand/..\\secret.png',
    '/brand/..',
    '/brand/.',
    '/brand/',
    '/brand/sub/deep.png',
    '/brand/sub',
    '/brand/notes.txt',
    '/brand/LOGO.SVG',
    '/brand/logo.svg%00.png',
    '/brand/missing.png',
    '/brand/nul.png',
    '/brand/.hidden.png',
    '/secret.png',
    '/index.html',
    '/public/app.js',
    '//brand/logo.svg',
  ];
  for (const urlPath of paths) {
    const res = await request(port, { path: urlPath });
    assertPlainError(res, 404);
    assert.ok(!res.text.includes('secret'), urlPath);
  }
});

test('a link inside the brand folder that points outside is not followed', async (t) => {
  const { publicDir, root } = makePublicDir(t);
  const { port } = await startServer(t, { publicDir });
  try {
    fs.symlinkSync(path.join(root, 'outside.png'), path.join(publicDir, 'brand', 'link.png'));
  } catch {
    t.skip('this computer does not allow file links');
    return;
  }
  const res = await request(port, { path: '/brand/link.png' });
  assertPlainError(res, 404);
});

test('a missing page file gives 404, not an error', async (t) => {
  const { publicDir } = makePublicDir(t);
  fs.rmSync(path.join(publicDir, 'app.js'));
  const { port } = await startServer(t, { publicDir });
  assertPlainError(await request(port, { path: '/app.js' }), 404);
});

// ---- methods ----

test('unknown paths get 404 and wrong methods get 405', async (t) => {
  const { port } = await startServer(t);
  for (const urlPath of ['/nope', '/api', '/api/nope', '/api/snapshot/', '/app.js/x']) {
    assertPlainError(await request(port, { path: urlPath }), 404);
  }
  const wrong = [
    ['POST', '/', 'GET, HEAD'],
    ['PUT', '/app.js', 'GET, HEAD'],
    ['DELETE', '/api/snapshot', 'GET, HEAD'],
    ['POST', '/api/health', 'GET, HEAD'],
    ['OPTIONS', '/api/settings', 'GET, HEAD, POST'],
    ['PUT', '/api/settings', 'GET, HEAD, POST'],
    ['PATCH', '/brand/logo.svg', 'GET, HEAD'],
  ];
  for (const [method, urlPath, allow] of wrong) {
    const res = await request(port, { method, path: urlPath });
    assertPlainError(res, 405);
    assert.equal(res.headers.allow, allow, `${method} ${urlPath}`);
  }
});

test('HEAD mirrors GET without a body', async (t) => {
  const { port } = await startServer(t);
  for (const urlPath of ['/', '/brand/logo.svg', '/api/health', '/api/snapshot', '/nope']) {
    const get = await request(port, { path: urlPath });
    const head = await request(port, { method: 'HEAD', path: urlPath });
    assert.equal(head.status, get.status, urlPath);
    assert.equal(head.text, '', urlPath);
    assert.equal(head.headers['content-type'], get.headers['content-type'], urlPath);
    assert.equal(head.headers['content-length'], get.headers['content-length'], urlPath);
    assert.equal(head.headers.etag, get.headers.etag, urlPath);
  }
});

// ---- snapshot ----

test('the snapshot has a weak ETag and answers 304 when it has not changed', async (t) => {
  const { port, store } = await startServer(t);
  const first = await request(port, { path: '/api/snapshot' });
  assert.equal(first.status, 200);
  assert.equal(first.headers['content-type'], 'application/json; charset=utf-8');
  assert.match(first.headers.etag, /^W\/"[0-9a-f]{40}"$/);
  assert.deepEqual(first.json, store.current);

  const same = await request(port, { path: '/api/snapshot', headers: { 'if-none-match': first.headers.etag } });
  assert.equal(same.status, 304);
  assert.equal(same.text, '');
  assert.equal(same.headers.etag, first.headers.etag);

  const listed = await request(port, {
    path: '/api/snapshot',
    headers: { 'if-none-match': `W/"0000", ${first.headers.etag}` },
  });
  assert.equal(listed.status, 304);

  const stale = await request(port, { path: '/api/snapshot', headers: { 'if-none-match': 'W/"0000"' } });
  assert.equal(stale.status, 200);

  store.current = { ...store.current, events: [{ at: 1500, kind: 'spawn', from: 'you', to: SESSION_KEY, text: null }] };
  const changed = await request(port, { path: '/api/snapshot', headers: { 'if-none-match': first.headers.etag } });
  assert.equal(changed.status, 200);
  assert.notEqual(changed.headers.etag, first.headers.etag);
  assert.equal(changed.json.events.length, 1);
});

test('a snapshot that changed only its time still answers 304', async (t) => {
  const { port, store } = await startServer(t);
  const first = await request(port, { path: '/api/snapshot' });
  store.current = { ...store.current, now: 2000 };
  const later = await request(port, { path: '/api/snapshot', headers: { 'if-none-match': first.headers.etag } });
  assert.equal(later.status, 304);
  assert.equal(later.headers.etag, first.headers.etag);
});

test('the snapshot JSON and ETag the store made are sent as they are', async (t) => {
  const store = fakeStore();
  const made = { version: 1, now: 5, nodes: [] };
  Object.defineProperties(made, { json: { value: '{"made":"by the store"}' }, etag: { value: 'W/"made-by-store"' } });
  store.snapshot = () => made;
  const { port } = await startServer(t, { store });
  const res = await request(port, { path: '/api/snapshot' });
  assert.equal(res.status, 200);
  assert.equal(res.text, '{"made":"by the store"}');
  assert.equal(res.headers.etag, 'W/"made-by-store"');
  const again = await request(port, { path: '/api/snapshot', headers: { 'if-none-match': 'W/"made-by-store"' } });
  assert.equal(again.status, 304);
});

// ---- session detail ----

test('/api/session checks the key and the cursor', async (t) => {
  const { port, store } = await startServer(t);
  const ok = await request(port, { path: `/api/session?key=${encodeURIComponent(SESSION_KEY)}&since=1234` });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers['content-type'], 'application/json; charset=utf-8');
  assert.equal(ok.json.next, 42);
  assert.deepEqual(store.detailCalls.at(-1), { key: SESSION_KEY, since: 1234 });

  const noCursor = await request(port, { path: `/api/session?key=${encodeURIComponent(SESSION_KEY)}` });
  assert.equal(noCursor.status, 200);
  assert.deepEqual(store.detailCalls.at(-1), { key: SESSION_KEY, since: null });

  const calls = store.detailCalls.length;
  const badKeys = ['', '../settings', 'claude:XYZ', 'claude:short', 'codex:0f8e2c4a/../../x', 'project:', 'you2'];
  assertPlainError(await request(port, { path: '/api/session' }), 400);
  for (const key of badKeys) {
    assertPlainError(await request(port, { path: `/api/session?key=${encodeURIComponent(key)}` }), 400);
  }
  for (const since of ['-1', 'abc', '1e3', '1.5', '9999999999999999']) {
    const res = await request(port, { path: `/api/session?key=${encodeURIComponent(SESSION_KEY)}&since=${since}` });
    assertPlainError(res, 400);
  }
  assert.equal(store.detailCalls.length, calls, 'bad requests never reach the store');

  const unknown = await request(port, { path: `/api/session?key=${encodeURIComponent(AGENT_KEY)}` });
  assertPlainError(unknown, 404);
});

// ---- settings ----

test('GET /api/settings returns settings, file, roots and a short node list', async (t) => {
  const { port, memory } = await startServer(t, { settings: { displayName: 'Ada' } });
  const res = await request(port, { path: '/api/settings' });
  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.json).sort(), ['file', 'nodes', 'platform', 'roots', 'settings']);
  assert.equal(res.json.platform, process.platform);
  assert.equal(res.json.settings.displayName, 'Ada');
  assert.equal(res.json.file, memory.state.file);
  assert.deepEqual(res.json.roots, memory.state.roots);
  assert.deepEqual(res.json.nodes, [
    { key: 'you', title: 'You', platform: 'human', kind: 'person' },
    { key: SESSION_KEY, title: 'Build the thing', platform: 'claude', kind: 'session' },
  ]);
});

test('POST /api/settings refuses requests that did not come from the page', async (t) => {
  const { port, memory, store } = await startServer(t);
  const body = { displayName: 'Mallory' };

  assertPlainError(await postSettings(port, body, { 'x-pleni': '' }), 403);
  assertPlainError(await postSettings(port, body, { 'x-pleni': 'yes' }), 403);
  assertPlainError(await request(port, {
    method: 'POST',
    path: '/api/settings',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }), 403);

  assertPlainError(await postSettings(port, body, { origin: 'http://attacker.example.com' }), 403);
  assertPlainError(await postSettings(port, body, { origin: `http://localhost:${port + 1}` }), 403);
  assertPlainError(await postSettings(port, body, { origin: 'null' }), 403);

  for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', 'application/jsonp']) {
    assertPlainError(await postSettings(port, body, { 'content-type': type }), 415);
  }

  assert.equal(memory.saved.length, 0);
  assert.equal(store.reloads.length, 0);
});

test('POST /api/settings refuses bodies over 64 KB and bodies that are not settings', async (t) => {
  const { port, memory } = await startServer(t);
  const pad = (size) => JSON.stringify({ displayName: 'x'.repeat(size - 18) });
  assert.equal(Buffer.byteLength(pad(1000)), 1000);

  const tooBig = await postSettings(port, pad(64 * 1024 + 1));
  assertPlainError(tooBig, 413);
  assert.equal(tooBig.headers.connection, 'close');

  const streamed = await request(port, {
    method: 'POST',
    path: '/api/settings',
    headers: { 'x-pleni': 'settings', 'content-type': 'application/json' },
    body: pad(200 * 1024),
    chunked: true,
  });
  assertPlainError(streamed, 413);

  assertPlainError(await postSettings(port, '{"displayName": '), 400);
  assertPlainError(await postSettings(port, '[]'), 400);
  assertPlainError(await postSettings(port, '"settings"'), 400);
  assert.equal(memory.saved.length, 0);

  const atLimit = await postSettings(port, pad(64 * 1024));
  assert.equal(atLimit.status, 200);
  assert.equal(memory.saved.length, 1);
});

test('POST /api/settings saves into PLENI_HOME and reloads the store', async (t) => {
  const home = tempDir(t, 'pleni-home-');
  const before = process.env.PLENI_HOME;
  process.env.PLENI_HOME = home;
  t.after(() => {
    if (before === undefined) delete process.env.PLENI_HOME;
    else process.env.PLENI_HOME = before;
  });
  const { port, store } = await startServer(t, { useFileSettings: true });

  const res = await postSettings(port, {
    displayName: '  Ada  ',
    titles: 'military',
    unknownKey: 'dropped',
    window: { activeMinutes: 9999 },
    remote: { hosts: ['Box.Example.TS.net'], tailscaleUsers: [] },
  }, { origin: `http://localhost:${port}`, 'content-type': 'application/json; charset=utf-8' });

  assert.equal(res.status, 200);
  const file = path.join(home, 'settings.json');
  assert.equal(res.json.file, file);
  assert.equal(res.json.settings.displayName, 'Ada');
  assert.equal(res.json.settings.titles, 'military');
  assert.equal(res.json.settings.window.activeMinutes, 240);
  assert.equal(res.json.settings.unknownKey, undefined);
  assert.equal(res.json.nodes.length, 2);

  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(saved, res.json.settings);
  assert.deepEqual(saved.remote.hosts, ['box.example.ts.net']);

  assert.equal(store.reloads.length, 1);
  assert.deepEqual(store.reloads[0].settings, saved);
  assert.deepEqual(Object.keys(store.reloads[0].roots).sort(), ['claude', 'claudeDesktop', 'codex', 'grok', 'kimi', 'mailbox']);

  const again = await request(port, { path: '/api/settings' });
  assert.equal(again.json.settings.displayName, 'Ada');
  assert.equal(again.json.file, file);
});

test('a failed save gives a plain message and leaves the store alone', async (t) => {
  const memory = memorySettings();
  memory.saveSettings = () => {
    throw new Error('EACCES: permission denied, open /home/ada/.config/pleni/settings.json');
  };
  const { port, store } = await startServer(t, { memory });
  const res = await postSettings(port, { displayName: 'Ada' });
  assertPlainError(res, 500);
  assert.ok(!res.text.includes('EACCES'));
  assert.ok(!res.text.includes('settings.json'));
  assert.equal(store.reloads.length, 0);
});

test('a store that fails gives a plain 500', async (t) => {
  const store = fakeStore();
  store.snapshot = () => {
    throw new Error('boom at /home/ada/project');
  };
  const { port } = await startServer(t, { store });
  const res = await request(port, { path: '/api/snapshot' });
  assertPlainError(res, 500);
  assert.ok(!res.text.includes('/home/ada'));
  assertBaseHeaders(res, 'store failure');
});

// ---- browser ----

test('the browser is opened without a shell on every platform', () => {
  const url = 'http://localhost:8790/';
  assert.deepEqual(browserCommand(url, 'win32'), ['cmd', ['/c', 'start', '', url]]);
  assert.deepEqual(browserCommand(url, 'darwin'), ['open', [url]]);
  assert.deepEqual(browserCommand(url, 'linux'), ['xdg-open', [url]]);
});

// ---- reports to ----

const BOSS_KEY = 'codex:0f8e2c4a-1b3d-4e5f-8a9b-000000000001';

function treeStore() {
  const store = fakeStore();
  store.current = {
    ...store.current,
    nodes: [
      { key: 'you', title: 'You', kind: 'person', parent: null },
      { key: BOSS_KEY, title: 'Colonel', kind: 'session', parent: 'you' },
      { key: SESSION_KEY, title: 'Build the thing', kind: 'session', parent: BOSS_KEY },
      { key: AGENT_KEY, title: 'Helper', kind: 'agent', parent: SESSION_KEY },
    ],
  };
  return store;
}

const move = (port, body, headers = {}) => request(port, {
  method: 'POST',
  path: '/api/placement',
  headers: { 'content-type': 'application/json', 'x-pleni': 'settings', ...headers },
  body: JSON.stringify(body),
});

test('placement saves who a session reports to, and null goes back to automatic', async (t) => {
  const { port, memory, store } = await startServer(t, { store: treeStore(), settings: { people: { [SESSION_KEY]: { label: 'Builder' } } } });
  let res = await move(port, { key: SESSION_KEY, reportsTo: 'you' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.json, { ok: true });
  assert.deepEqual(memory.state.settings.people[SESSION_KEY], { label: 'Builder', reportsTo: 'you' });
  assert.equal(store.reloads.length, 1);
  res = await move(port, { key: AGENT_KEY, reportsTo: BOSS_KEY });
  assert.equal(res.status, 200);
  assert.equal(memory.state.settings.people[AGENT_KEY].reportsTo, BOSS_KEY);
  res = await move(port, { key: AGENT_KEY, reportsTo: null });
  assert.equal(res.status, 200);
  assert.equal(memory.state.settings.people[AGENT_KEY], undefined);
  assert.deepEqual(memory.state.settings.people[SESSION_KEY], { label: 'Builder', reportsTo: 'you' });
});

test('placement refuses loops, unknown sessions, bad bodies and cross-site requests', async (t) => {
  const { port, memory } = await startServer(t, { store: treeStore() });
  assert.equal((await move(port, { key: SESSION_KEY, reportsTo: AGENT_KEY })).status, 400, 'under its own helper');
  assert.equal((await move(port, { key: SESSION_KEY, reportsTo: SESSION_KEY })).status, 400, 'under itself');
  assert.equal((await move(port, { key: 'codex:0f8e2c4a-1b3d-4e5f-8a9b-00000000dead', reportsTo: 'you' })).status, 404);
  assert.equal((await move(port, { key: SESSION_KEY, reportsTo: 'codex:0f8e2c4a-1b3d-4e5f-8a9b-00000000dead' })).status, 404);
  assert.equal((await move(port, { key: 'you', reportsTo: BOSS_KEY })).status, 400);
  assert.equal((await move(port, { key: SESSION_KEY, reportsTo: 'project:alpha' })).status, 400);
  assert.equal((await move(port, { key: SESSION_KEY })).status, 400);
  assert.equal((await move(port, { key: SESSION_KEY, reportsTo: 'you' }, { 'x-pleni': undefined })).status, 403);
  assert.equal((await move(port, { key: SESSION_KEY, reportsTo: 'you' }, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await move(port, { key: SESSION_KEY, reportsTo: 'you' }, { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await move(port, { key: SESSION_KEY, reportsTo: 'you' }, { cookie: undefined })).status, 401);
  const get = await request(port, { path: '/api/placement' });
  assert.equal(get.status, 405);
  assert.deepEqual(memory.saved, []);
});

// ---- watch ----

const watch = (port, body, headers = {}) => request(port, {
  method: 'POST',
  path: '/api/watch',
  headers: { 'content-type': 'application/json', 'x-pleni': 'settings', ...headers },
  body: JSON.stringify(body),
});

test('watch saves "tell me if this stops working" for a session or the relay, and false undoes it', async (t) => {
  const store = treeStore();
  store.current.nodes.push({ key: 'relay', title: 'Relay', kind: 'relay', parent: 'you' });
  const { port, memory } = await startServer(t, { store, settings: { people: { [SESSION_KEY]: { label: 'Builder' } } } });
  let res = await watch(port, { key: SESSION_KEY, watch: true });
  assert.equal(res.status, 200);
  assert.deepEqual(res.json, { ok: true });
  assert.deepEqual(memory.state.settings.people[SESSION_KEY], { label: 'Builder', watch: true });
  assert.equal((await watch(port, { key: 'relay', watch: true })).status, 200);
  assert.deepEqual(memory.state.settings.people.relay, { watch: true });
  assert.equal((await watch(port, { key: SESSION_KEY, watch: false })).status, 200);
  assert.deepEqual(memory.state.settings.people[SESSION_KEY], { label: 'Builder' });
  assert.equal((await watch(port, { key: 'relay', watch: false })).status, 200);
  assert.equal(memory.state.settings.people.relay, undefined, 'an empty choice is removed');
});

test('watch refuses groups, worker runs, unknown tiles, bad bodies and cross-site requests', async (t) => {
  const store = treeStore();
  store.current.nodes.push({ key: 'mailbox:T-1/W1', title: 'W1', kind: 'agent', parent: SESSION_KEY });
  // A tile with a session's kind of key that is not a session is refused too.
  store.current.nodes.push({ key: 'claude:0f8e2c4a-1b3d-4e5f-8a9b-00000000cafe', title: 'Odd', kind: 'project', parent: 'you' });
  const { port, memory } = await startServer(t, { store });
  for (const key of ['you', 'project:alpha', 'mailbox:T-1/W1', 'nonsense', 'claude:0f8e2c4a-1b3d-4e5f-8a9b-00000000cafe']) {
    assert.equal((await watch(port, { key, watch: true })).status, 400, key);
  }
  assert.equal((await watch(port, { key: SESSION_KEY, watch: 'yes' })).status, 400);
  assert.equal((await watch(port, { key: SESSION_KEY })).status, 400);
  assert.equal((await watch(port, { key: 'codex:0f8e2c4a-1b3d-4e5f-8a9b-00000000dead', watch: true })).status, 404);
  assert.equal((await watch(port, { key: SESSION_KEY, watch: true }, { 'x-pleni': undefined })).status, 403);
  assert.equal((await watch(port, { key: SESSION_KEY, watch: true }, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await watch(port, { key: SESSION_KEY, watch: true }, { cookie: undefined })).status, 401);
  assert.equal((await request(port, { path: '/api/watch' })).status, 405);
  assert.deepEqual(memory.saved, []);
});

// ---- dismiss ----

test('dismiss passes a valid notice to the store and refuses bad ones', async (t) => {
  const store = fakeStore();
  store.dismissed = [];
  store.dismiss = (id, at) => store.dismissed.push([id, at]);
  const { port } = await startServer(t, { store });
  const post = (body, headers = {}) => request(port, {
    method: 'POST',
    path: '/api/dismiss',
    headers: { 'content-type': 'application/json', 'x-pleni': 'settings', ...headers },
    body: JSON.stringify(body),
  });
  assert.equal((await post({ id: `${SESSION_KEY}|needs`, at: 1234 })).status, 200);
  assert.equal((await post({ id: 'task:T-1|question', at: null })).status, 200);
  for (const kind of ['alert', 'paused', 'halted', 'note', 'stopped']) {
    assert.equal((await post({ id: `relay|${kind}`, at: 5 })).status, 200, kind);
  }
  for (const bad of [{ id: 'x|nope', at: 1 }, { id: '|needs', at: 1 }, { id: 'a b|needs', at: 1 }, { id: `${SESSION_KEY}|needs`, at: -1 }, { id: `${SESSION_KEY}|needs`, at: '1' }, { id: `${SESSION_KEY}|needs` }, { at: 1 }]) {
    assert.equal((await post(bad)).status, 400, JSON.stringify(bad));
  }
  assert.equal((await post({ id: 'task:T-1|review', at: 1 }, { 'x-pleni': undefined })).status, 403);
  assert.equal((await post({ id: 'task:T-1|review', at: 1 }, { cookie: undefined })).status, 401);
  assert.equal((await request(port, { path: '/api/dismiss' })).status, 405);
  assert.equal((await post({ id: `${SESSION_KEY}|mail`, at: 7 })).status, 200, 'a "Mail for you" notice');
  assert.equal((await post({ id: 'you|mailread', at: 8 })).status, 200, 'mail marked as read on the Mail page');
  assert.deepEqual(store.dismissed, [
    [`${SESSION_KEY}|needs`, 1234], ['task:T-1|question', null],
    ['relay|alert', 5], ['relay|paused', 5], ['relay|halted', 5], ['relay|note', 5], ['relay|stopped', 5],
    [`${SESSION_KEY}|mail`, 7], ['you|mailread', 8],
  ]);
});

test('the Mail page reads the person\'s mail, or every message with ?all=1', async (t) => {
  const store = fakeStore();
  store.mailCalls = [];
  store.mail = ({ all }) => {
    store.mailCalls.push(all);
    return { name: 'Ada', readAt: 50, messages: [{ id: 'ada/new/x.md', to: 'ada', from: 'sergeant-bo', fromName: 'Sergeant Bo', at: 60, unread: true, text: 'Done.', toYou: true, fromYou: false }] };
  };
  const { port } = await startServer(t, { store });
  const res = await request(port, { path: '/api/mail' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.json, { on: true, name: 'Ada', readAt: 50, messages: [{ id: 'ada/new/x.md', to: 'ada', from: 'sergeant-bo', fromName: 'Sergeant Bo', at: 60, unread: true, text: 'Done.', toYou: true, fromYou: false }] });
  assert.equal((await request(port, { path: '/api/mail?all=1' })).status, 200);
  assert.deepEqual(store.mailCalls, [false, true]);
  assert.equal((await request(port, { path: '/api/mail', headers: { cookie: undefined } })).status, 401);
  assert.equal((await request(port, { method: 'POST', path: '/api/mail', headers: { 'content-type': 'application/json', 'x-pleni': 'settings' }, body: '{}' })).status, 405);
  store.mail = () => null;
  assert.deepEqual((await request(port, { path: '/api/mail' })).json, { on: false, name: null, readAt: null, messages: [] }, 'no mail folder');
});

// ---- Open in PowerShell ----

// A store whose one Claude Code session works in `folder`, and a stand-in for spawn that records
// each call instead of opening a window.
function openStore(folder) {
  const store = fakeStore();
  store.demo = false;
  store.session = (key) => (key === SESSION_KEY ? { id: SESSION_KEY.slice('claude:'.length), cwd: folder, status: 'idle' } : null);
  return store;
}

function recordSpawns() {
  const calls = [];
  const spawn = (file, args, options) => {
    calls.push({ file, args, options });
    const child = { handlers: {}, once(name, fn) { this.handlers[name] = fn; }, unref() {} };
    process.nextTick(() => child.handlers.spawn?.());
    return child;
  };
  spawn.calls = calls;
  return spawn;
}

const openReq = (port, body, headers = {}) => request(port, {
  method: 'POST',
  path: '/api/open',
  headers: { 'content-type': 'application/json', 'x-pleni': 'settings', ...headers },
  body: JSON.stringify(body),
});

const OPEN_ON = { actions: { openTerminal: true } };

test('open starts PowerShell for a Claude Code session on the map', async (t) => {
  const folder = tempDir(t);
  const spawnProcess = recordSpawns();
  const { port } = await startServer(t, { store: openStore(folder), settings: OPEN_ON, platform: 'win32', spawnProcess });
  const res = await openReq(port, { key: SESSION_KEY });
  assert.equal(res.status, 200);
  assert.deepEqual(res.json, { ok: true });
  assert.equal(spawnProcess.calls.length, 1);
  assert.equal(spawnProcess.calls[0].options.cwd, folder);
  assert.ok(spawnProcess.calls[0].args.at(-1).includes(`claude --resume '${SESSION_KEY.slice('claude:'.length)}'`));
  // A second click right away is refused instead of opening a second window.
  const again = await openReq(port, { key: SESSION_KEY });
  assertPlainError(again, 429);
  assert.equal(again.json.error, OPEN_MESSAGES.again);
  assert.equal(spawnProcess.calls.length, 1);
});

test('open needs the key and the same checks as every other change', async (t) => {
  const spawnProcess = recordSpawns();
  const { port } = await startServer(t, { store: openStore(tempDir(t)), settings: OPEN_ON, platform: 'win32', spawnProcess });
  assertPlainError(await openReq(port, { key: SESSION_KEY }, { cookie: undefined }), 401);
  assertPlainError(await openReq(port, { key: SESSION_KEY }, { 'x-pleni': undefined }), 403);
  assertPlainError(await openReq(port, { key: SESSION_KEY }, { origin: 'https://evil.example' }), 403);
  assertPlainError(await openReq(port, { key: SESSION_KEY }, { 'content-type': 'text/plain' }), 415);
  assertPlainError(await request(port, { path: '/api/open' }), 405);
  assert.equal(spawnProcess.calls.length, 0);
});

test('open is refused from another device, even one that may see Pleni', async (t) => {
  const spawnProcess = recordSpawns();
  const settings = { ...OPEN_ON, remote: { hosts: ['box.example.ts.net'], tailscaleUsers: ['ada@example.com'] } };
  const { port } = await startServer(t, { store: openStore(tempDir(t)), settings, platform: 'win32', spawnProcess });
  const remote = { host: 'box.example.ts.net', 'tailscale-user-login': 'ada@example.com' };
  assert.equal((await request(port, { path: '/api/health', headers: remote })).status, 200, 'the device may see Pleni');
  for (const headers of [remote, { 'tailscale-user-login': 'ada@example.com' }, { 'x-forwarded-for': '100.64.0.7' }]) {
    const res = await openReq(port, { key: SESSION_KEY }, headers);
    assertPlainError(res, 403);
    assert.match(res.json.error, /only on the computer that runs Pleni/);
  }
  assert.equal(spawnProcess.calls.length, 0);
});

test('open gives a Codex thread the Codex folder Pleni reads', async (t) => {
  const codexKey = 'codex:0f8e2c4a-1b3d-4e5f-8a9b-0c1d2e3f4a5c';
  const folder = tempDir(t);
  const codexRoot = tempDir(t);
  const store = fakeStore();
  store.demo = false;
  store.current = { ...store.current, nodes: [...store.current.nodes, { key: codexKey, title: 'Plan the release', platform: 'codex', kind: 'session' }] };
  store.session = (key) => (key === codexKey ? { id: codexKey.slice('codex:'.length), cwd: folder, status: 'idle', kind: 'session' } : null);
  const memory = memorySettings(OPEN_ON);
  memory.state.roots = { ...memory.state.roots, codex: codexRoot };
  const spawnProcess = recordSpawns();
  const { port } = await startServer(t, { store, memory, platform: 'win32', spawnProcess });
  const res = await openReq(port, { key: codexKey });
  assert.equal(res.status, 200);
  assert.equal(spawnProcess.calls.length, 1);
  assert.equal(spawnProcess.calls[0].options.cwd, folder);
  assert.equal(spawnProcess.calls[0].options.env.CODEX_HOME, codexRoot);
  assert.ok(spawnProcess.calls[0].args.at(-1).includes(`codex resume '${codexKey.slice('codex:'.length)}'`));
});

// ---- Roll over ----

// A store whose one Claude Code session, named by the person, works in `folder`.
function rollStore(folder) {
  const store = fakeStore();
  store.demo = false;
  store.session = (key) => (key === SESSION_KEY
    ? { id: SESSION_KEY.slice('claude:'.length), cwd: folder, status: 'idle', kind: 'session', title: 'Sergeant Ada', titleSource: 'custom-title' }
    : null);
  return store;
}

const rollReq = (port, body, headers = {}) => request(port, {
  method: 'POST',
  path: '/api/rollover',
  headers: { 'content-type': 'application/json', 'x-pleni': 'settings', ...headers },
  body: JSON.stringify(body),
});
const rollInfo = (port, headers = {}) => request(port, { path: `/api/rollover?key=${encodeURIComponent(SESSION_KEY)}`, headers });

const ROLL_ON = { actions: { rollover: true } };

test('rollover first says what each step will send, then takes the step it is asked for', async (t) => {
  const folder = tempDir(t);
  const spawnProcess = recordSpawns();
  const { port } = await startServer(t, { store: rollStore(folder), settings: ROLL_ON, platform: 'win32', spawnProcess });
  const info = await rollInfo(port);
  assert.equal(info.status, 200);
  assert.equal(info.json.name, 'Sergeant Ada');
  assert.equal(info.json.file, 'HANDOFF-sergeant-ada.md');
  assert.equal(info.json.handoffAt, null);
  assert.equal(spawnProcess.calls.length, 0, 'asking what a step sends starts nothing');
  const res = await rollReq(port, { key: SESSION_KEY, step: 'start', name: 'Sergeant Ada' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.json, { ok: true });
  assert.equal(spawnProcess.calls.length, 1);
  assert.equal(spawnProcess.calls[0].options.cwd, folder);
  assert.ok(spawnProcess.calls[0].args.at(-1).includes(`claude --name 'Sergeant Ada' '${info.json.start}'`));
});

test('rollover needs the key, the page itself, and this computer', async (t) => {
  const spawnProcess = recordSpawns();
  const settings = { ...ROLL_ON, remote: { hosts: ['box.example.ts.net'], tailscaleUsers: ['ada@example.com'] } };
  const { port } = await startServer(t, { store: rollStore(tempDir(t)), settings, platform: 'win32', spawnProcess });
  const body = { key: SESSION_KEY, step: 'ask', name: 'Sergeant Ada' };
  assertPlainError(await rollInfo(port, { cookie: undefined }), 401);
  assertPlainError(await rollReq(port, body, { cookie: undefined }), 401);
  assertPlainError(await rollReq(port, body, { 'x-pleni': undefined }), 403);
  assertPlainError(await rollReq(port, body, { origin: 'https://evil.example' }), 403);
  assertPlainError(await rollReq(port, body, { 'content-type': 'text/plain' }), 415);
  assertPlainError(await request(port, { method: 'PUT', path: '/api/rollover' }), 405);
  const remote = { host: 'box.example.ts.net', 'tailscale-user-login': 'ada@example.com' };
  for (const headers of [remote, { 'x-forwarded-for': '100.64.0.7' }]) {
    const asked = await rollInfo(port, headers);
    assertPlainError(asked, 403);
    assert.match(asked.json.error, /only on the computer that runs Pleni/);
    assertPlainError(await rollReq(port, body, headers), 403);
  }
  assert.equal(spawnProcess.calls.length, 0);
});

test('rollover is off until it is turned on, and says why in plain words', async (t) => {
  const spawnProcess = recordSpawns();
  const { port } = await startServer(t, { store: rollStore(tempDir(t)), settings: { actions: { openTerminal: true } }, platform: 'win32', spawnProcess });
  const info = await rollInfo(port);
  assertPlainError(info, 403);
  assert.equal(info.json.error, ROLL_MESSAGES.off);
  const res = await rollReq(port, { key: SESSION_KEY, step: 'ask', name: 'Sergeant Ada' });
  assertPlainError(res, 403);
  assert.equal(res.json.error, ROLL_MESSAGES.off);
  assert.equal(spawnProcess.calls.length, 0);
});

test('open is off until it is turned on, and says why in plain words', async (t) => {
  const spawnProcess = recordSpawns();
  const { port } = await startServer(t, { store: openStore(tempDir(t)), platform: 'win32', spawnProcess });
  const res = await openReq(port, { key: SESSION_KEY });
  assertPlainError(res, 403);
  assert.equal(res.json.error, OPEN_MESSAGES.off);
  const linux = await startServer(t, { store: openStore(tempDir(t)), settings: OPEN_ON, platform: 'linux', spawnProcess });
  const other = await openReq(linux.port, { key: SESSION_KEY });
  assertPlainError(other, 409);
  assert.equal(other.json.error, OPEN_MESSAGES.windowsOnly);
  const helper = await startServer(t, { store: openStore(tempDir(t)), settings: OPEN_ON, platform: 'win32', spawnProcess });
  const sub = await openReq(helper.port, { key: AGENT_KEY });
  assertPlainError(sub, 400);
  assert.equal(sub.json.error, OPEN_MESSAGES.helper);
  assert.equal(spawnProcess.calls.length, 0);
});

// ---- other devices ----

test('a device Tailscale brings that is not allowed yet gets plain words, and Settings can see it', async (t) => {
  const settings = { remote: { hosts: [], tailscaleUsers: [] } };
  const { port, memory } = await startServer(t, { settings });
  const visit = { host: 'desk.tail1234.ts.net', 'tailscale-user-login': 'Ada@Example.com' };
  const page = await request(port, { path: '/', headers: visit });
  assert.equal(page.status, 403);
  assert.match(page.headers['content-type'], /^text\/plain/);
  assert.match(page.text, /Settings, then Devices, and choose Allow/);
  assertPlainError(await request(port, { path: '/api/snapshot', headers: visit }), 403);
  const devices = await request(port, { path: '/api/devices' });
  assert.equal(devices.status, 200);
  assert.deepEqual(devices.json.addresses, []);
  assert.equal(devices.json.key, TEST_KEY);
  assert.equal(devices.json.knocks.length, 1);
  assert.deepEqual({ ...devices.json.knocks[0], at: 0 }, { host: 'desk.tail1234.ts.net', login: 'ada@example.com', at: 0, allowed: false });
  memory.state.settings = cleanSettings({ remote: { hosts: ['desk.tail1234.ts.net'], tailscaleUsers: ['ada@example.com'] } });
  const after = await request(port, { path: '/api/devices' });
  assert.deepEqual(after.json.addresses, ['https://desk.tail1234.ts.net/']);
  assert.equal(after.json.knocks[0].allowed, true);
  assert.equal((await request(port, { path: '/api/health', headers: visit })).status, 200, 'now it gets in');
});

test('only visits through Tailscale are kept, the last five', async (t) => {
  const { port } = await startServer(t, { settings: { remote: { hosts: [], tailscaleUsers: [] } } });
  await request(port, { path: '/', headers: { host: 'evil.example.com', 'tailscale-user-login': 'ada@example.com' } });
  await request(port, { path: '/', headers: { host: 'desk.tail1234.ts.net' } });
  await request(port, { path: '/', headers: { host: 'desk.tail1234.ts.net', 'tailscale-user-login': 'not a login' } });
  assert.deepEqual((await request(port, { path: '/api/devices' })).json.knocks, []);
  for (let i = 0; i < 7; i += 1) {
    await request(port, { path: '/', headers: { host: `pc${i}.tail1234.ts.net`, 'tailscale-user-login': 'ada@example.com' } });
  }
  const knocks = (await request(port, { path: '/api/devices' })).json.knocks;
  assert.deepEqual(knocks.map((k) => k.host), ['pc6.tail1234.ts.net', 'pc5.tail1234.ts.net', 'pc4.tail1234.ts.net', 'pc3.tail1234.ts.net', 'pc2.tail1234.ts.net']);
});

test('the devices list needs the key and works only on this computer', async (t) => {
  const settings = { remote: { hosts: ['box.example.ts.net'], tailscaleUsers: ['ada@example.com'] } };
  const { port } = await startServer(t, { settings });
  assertPlainError(await request(port, { path: '/api/devices', headers: { cookie: undefined } }), 401);
  for (const headers of [{ host: 'box.example.ts.net', 'tailscale-user-login': 'ada@example.com' }, { 'x-forwarded-for': '100.64.0.7' }]) {
    const res = await request(port, { path: '/api/devices', headers });
    assertPlainError(res, 403);
    assert.equal(res.json.key, undefined);
  }
  assertPlainError(await request(port, { method: 'POST', path: '/api/devices' }), 405);
});

// ---- New agent ----

const newReq = (port, body, headers = {}) => request(port, {
  method: 'POST',
  path: '/api/new',
  headers: { 'content-type': 'application/json', 'x-pleni': 'settings', ...headers },
  body: JSON.stringify(body),
});

const NEW_ON = { actions: { newAgent: true } };

test('new agent starts a named Claude Code session in the folder of the session it starts next to', async (t) => {
  const folder = tempDir(t);
  const spawnProcess = recordSpawns();
  const { port } = await startServer(t, { store: rollStore(folder), settings: NEW_ON, platform: 'win32', spawnProcess });
  const res = await newReq(port, { from: SESSION_KEY, tool: 'claude', name: 'Sergeant 3' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.json, { ok: true });
  assert.equal(spawnProcess.calls.length, 1);
  assert.equal(spawnProcess.calls[0].options.cwd, folder);
  assert.ok(spawnProcess.calls[0].args.at(-1).includes(`-Command "claude --name 'Sergeant 3'"`));
  const again = await newReq(port, { from: SESSION_KEY, tool: 'claude', name: 'Sergeant 4' });
  assertPlainError(again, 429);
  assert.equal(again.json.error, NEW_MESSAGES.again);
  assert.equal(spawnProcess.calls.length, 1);
});

test('new agent needs the key, the page itself, this computer, and the switch', async (t) => {
  const spawnProcess = recordSpawns();
  const settings = { ...NEW_ON, remote: { hosts: ['box.example.ts.net'], tailscaleUsers: ['ada@example.com'] } };
  const { port } = await startServer(t, { store: rollStore(tempDir(t)), settings, platform: 'win32', spawnProcess });
  const body = { from: SESSION_KEY, tool: 'codex', name: 'Sergeant 3' };
  assertPlainError(await newReq(port, body, { cookie: undefined }), 401);
  assertPlainError(await newReq(port, body, { 'x-pleni': undefined }), 403);
  assertPlainError(await newReq(port, body, { origin: 'https://evil.example' }), 403);
  assertPlainError(await newReq(port, body, { 'content-type': 'text/plain' }), 415);
  assertPlainError(await request(port, { path: '/api/new' }), 405);
  for (const headers of [{ host: 'box.example.ts.net', 'tailscale-user-login': 'ada@example.com' }, { 'x-forwarded-for': '100.64.0.7' }]) {
    const res = await newReq(port, body, headers);
    assertPlainError(res, 403);
    assert.match(res.json.error, /only on the computer that runs Pleni/);
  }
  const off = await startServer(t, { store: rollStore(tempDir(t)), settings: { actions: { openTerminal: true, rollover: true } }, platform: 'win32', spawnProcess });
  const res = await newReq(off.port, body);
  assertPlainError(res, 403);
  assert.equal(res.json.error, NEW_MESSAGES.off);
  const bad = await newReq(port, { ...body, name: `Ada' ; calc ; '` });
  assertPlainError(bad, 400);
  assert.equal(bad.json.error, NEW_MESSAGES.badName);
  assert.equal(spawnProcess.calls.length, 0);
});

// ---- Bring a cloud session here ----

test('teleport opens claude --teleport for a Claude Code session, only on this computer', async (t) => {
  const folder = tempDir(t);
  const spawnProcess = recordSpawns();
  const settings = { actions: { teleport: true }, remote: { hosts: ['box.example.ts.net'], tailscaleUsers: ['ada@example.com'] } };
  const { port } = await startServer(t, { store: rollStore(folder), settings, platform: 'win32', spawnProcess });
  const send = (headers = {}) => request(port, {
    method: 'POST',
    path: '/api/teleport',
    headers: { 'content-type': 'application/json', 'x-pleni': 'settings', ...headers },
    body: JSON.stringify({ from: SESSION_KEY }),
  });
  assertPlainError(await send({ cookie: undefined }), 401);
  assertPlainError(await send({ 'x-pleni': undefined }), 403);
  const remote = await send({ host: 'box.example.ts.net', 'tailscale-user-login': 'ada@example.com' });
  assertPlainError(remote, 403);
  assert.match(remote.json.error, /only on the computer that runs Pleni/);
  assert.equal(spawnProcess.calls.length, 0);
  const res = await send();
  assert.equal(res.status, 200);
  assert.equal(spawnProcess.calls.length, 1);
  assert.equal(spawnProcess.calls[0].options.cwd, folder);
  assert.ok(spawnProcess.calls[0].args.at(-1).includes('-Command "claude --teleport"'));
  assertPlainError(await request(port, { path: '/api/teleport' }), 405);
});

// ---- live GitHub status and Merge ----

// A stand-in for src/github.js that records what the server asks for.
function fakeGithub() {
  const fake = {
    calls: [],
    async status(args) {
      fake.calls.push(['status', args]);
      return { error: null, repos: [...args.repos].sort().map((repo) => ({ repo, at: 5, error: null, pulls: [] })) };
    },
    async merge(args) {
      fake.calls.push(['merge', args]);
      return args.number === 7 ? { ok: true } : { ok: false, status: 409, error: 'Checks are still running.' };
    },
  };
  return fake;
}

// Sessions in two repositories, and a reviewer in a third that does not count.
function githubStore(demo = false) {
  const store = fakeStore();
  store.demo = demo;
  store.current.nodes[1].github = demo ? 'example/field-app' : 'ada/notes';
  store.current.nodes.push(
    { key: 'codex:019a3f2e-7c41-7d20-9b6e-5a1c2d3e4f50', title: 'Site', platform: 'codex', kind: 'session', status: 'idle', github: 'ada/site' },
    { key: 'codex:019a3f33-8e66-7b43-a04f-8d4051627384', title: 'Review', platform: 'codex', kind: 'reviewer', status: 'idle', github: 'eve/other' },
  );
  return store;
}

const REMOTE = { remote: { hosts: ['box.example.ts.net'], tailscaleUsers: ['ada@example.com'] } };
const FROM_LAPTOP = { host: 'box.example.ts.net', 'tailscale-user-login': 'ada@example.com' };
const HEAD = 'c'.repeat(40);

test('GitHub status is off until it is turned on, and offers Merge only on this computer', async (t) => {
  const github = fakeGithub();
  const off = await startServer(t, { store: githubStore(), github, settings: REMOTE });
  const quiet = await request(off.port, { path: '/api/github' });
  assert.equal(quiet.status, 200);
  assert.deepEqual(quiet.json, { on: false, merge: false, method: 'squash', error: null, repos: [] });
  assert.equal(github.calls.length, 0, 'nothing asked GitHub');

  const on = await startServer(t, { store: githubStore(), github, settings: { ...REMOTE, github: { live: true, merge: true, mergeMethod: 'rebase' } } });
  const res = await request(on.port, { path: '/api/github' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.json, {
    on: true,
    merge: true,
    method: 'rebase',
    error: null,
    repos: [{ repo: 'ada/notes', at: 5, error: null, pulls: [] }, { repo: 'ada/site', at: 5, error: null, pulls: [] }],
  });
  assert.deepEqual(github.calls[0], ['status', { repos: ['ada/notes', 'ada/site'], fresh: false }], 'only the repositories on the map, no reviewers');
  assert.equal((await request(on.port, { path: '/api/github?fresh=1' })).status, 200);
  assert.equal(github.calls[1][1].fresh, true);
  const laptop = await request(on.port, { path: '/api/github', headers: FROM_LAPTOP });
  assert.equal(laptop.status, 200);
  assert.equal(laptop.json.on, true);
  assert.equal(laptop.json.merge, false, 'another device sees the status but not Merge');
  assertPlainError(await request(on.port, { path: '/api/github', headers: { cookie: undefined } }), 401);
  assertPlainError(await request(on.port, { method: 'POST', path: '/api/github' }), 405);
  const noMerge = await startServer(t, { store: githubStore(), github, settings: { github: { live: true } } });
  assert.equal((await request(noMerge.port, { path: '/api/github' })).json.merge, false);
});

test('GitHub status in the demo is made up, and asks nothing', async (t) => {
  const github = fakeGithub();
  const { port } = await startServer(t, { store: githubStore(true), github, settings: { github: { live: true } } });
  const res = await request(port, { path: '/api/github' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.json.repos.map((r) => r.repo), ['example/field-app']);
  assert.ok(res.json.repos[0].pulls.some((p) => p.number === 17 && p.canMerge === true));
  assert.equal(github.calls.length, 0);
});

test('merge runs only on this computer, with both switches on, for repositories on the map', async (t) => {
  const github = fakeGithub();
  const settings = { ...REMOTE, github: { live: true, merge: true, mergeMethod: 'merge' } };
  const { port } = await startServer(t, { store: githubStore(), github, settings });
  const send = (body, headers = {}, to = port) => request(to, {
    method: 'POST',
    path: '/api/github/merge',
    headers: { 'content-type': 'application/json', 'x-pleni': 'settings', ...headers },
    body: JSON.stringify(body),
  });
  const body = { repo: 'ada/notes', number: 7, head: HEAD };
  assertPlainError(await send(body, { cookie: undefined }), 401);
  assertPlainError(await send(body, { 'x-pleni': undefined }), 403);
  assertPlainError(await send(body, { origin: 'https://evil.example' }), 403);
  const remote = await send(body, FROM_LAPTOP);
  assertPlainError(remote, 403);
  assert.match(remote.json.error, /only on the computer that runs it/);
  assertPlainError(await request(port, { path: '/api/github/merge' }), 405);
  assert.equal(github.calls.length, 0);

  const ok = await send(body);
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.json, { ok: true });
  const [kind, args] = github.calls[0];
  assert.equal(kind, 'merge');
  assert.deepEqual({ ...args, known: [...args.known].sort() }, { repo: 'ada/notes', number: 7, head: HEAD, method: 'merge', known: ['ada/notes', 'ada/site'] });
  const notReady = await send({ ...body, number: 8 });
  assertPlainError(notReady, 409);
  assert.equal(notReady.json.error, 'Checks are still running.');

  for (const [github2, error] of [[{ live: false, merge: true }, GITHUB_MESSAGES.off], [{ live: true, merge: false }, GITHUB_MESSAGES.mergeOff]]) {
    const other = await startServer(t, { store: githubStore(), github, settings: { github: github2 } });
    const res = await send(body, {}, other.port);
    assertPlainError(res, 403);
    assert.equal(res.json.error, error);
  }
  const demo = await startServer(t, { store: githubStore(true), github, settings });
  const res = await send(body, {}, demo.port);
  assertPlainError(res, 409);
  assert.equal(res.json.error, GITHUB_MESSAGES.demo);
  assert.equal(github.calls.length, 2, 'no merge ran for a refused request');
});

// ---- version ----

test('snapshot answers say which Pleni sent them, also when nothing changed', async (t) => {
  const { port } = await startServer(t, { build: '0c5808a' });
  const first = await request(port, { path: '/api/snapshot' });
  assert.equal(first.status, 200);
  assert.equal(first.headers['x-pleni-version'], '9.9.9-test');
  assert.equal(first.headers['x-pleni-build'], '0c5808a');
  const again = await request(port, { path: '/api/snapshot', headers: { 'if-none-match': first.headers.etag } });
  assert.equal(again.status, 304);
  assert.equal(again.headers['x-pleni-version'], '9.9.9-test');
  assert.equal(again.headers['x-pleni-build'], '0c5808a');
  const plain = await startServer(t);
  assert.equal((await request(plain.port, { path: '/api/snapshot' })).headers['x-pleni-build'], undefined, 'no build header without a git copy');
});

test('readBuild finds the commit of a git copy from its branch, packed refs or a detached head', (t) => {
  const sha = '0c5808a1b2c3d4e5f60718293a4b5c6d7e8f9012';
  const other = 'ffeeddccbbaa99887766554433221100ffeeddcc';
  const make = (files) => {
    const dir = tempDir(t, 'pleni-build-');
    for (const [name, text] of Object.entries(files)) {
      const file = path.join(dir, '.git', ...name.split('/'));
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
    }
    return dir;
  };
  assert.equal(readBuild(make({ HEAD: 'ref: refs/heads/main\n', 'refs/heads/main': `${sha}\n` })), '0c5808a');
  assert.equal(readBuild(make({ HEAD: 'ref: refs/heads/claude/work\n', 'packed-refs': `# pack-refs with: peeled\n${other} refs/heads/main\n${sha} refs/heads/claude/work\n` })), '0c5808a');
  assert.equal(readBuild(make({ HEAD: `${sha}\n` })), '0c5808a', 'a detached head names its commit itself');
  assert.equal(readBuild(make({ HEAD: 'ref: refs/heads/gone\n' })), null, 'a branch with no commit yet');
  const climb = make({ HEAD: 'ref: refs/../../secret\n' });
  fs.writeFileSync(path.join(climb, 'secret'), `${sha}\n`);
  assert.equal(readBuild(climb), null, 'a ref that climbs out of .git is not read');
  assert.equal(readBuild(make({ HEAD: 'not a ref\n' })), null);
  assert.equal(readBuild(tempDir(t, 'pleni-build-')), null, 'no .git folder (an npm install)');
});

// ---- hide from the map ----

const hide = (port, body, headers = {}) => request(port, {
  method: 'POST',
  path: '/api/hide',
  headers: { 'content-type': 'application/json', 'x-pleni': 'settings', ...headers },
  body: JSON.stringify(body),
});

test('hide saves Role "Hide it" for a session, says the role it had, and Undo puts that role back', async (t) => {
  const store = treeStore();
  const { port, memory } = await startServer(t, { store, settings: { people: { [SESSION_KEY]: { label: 'Builder', role: 'coordinator' } } } });
  let res = await hide(port, { key: SESSION_KEY, hide: true });
  assert.equal(res.status, 200);
  assert.deepEqual(res.json, { ok: true, role: 'coordinator' });
  assert.deepEqual(memory.state.settings.people[SESSION_KEY], { label: 'Builder', role: 'hidden' });
  // Undo: the tile is off the map now, so it does not need to be on the map to come back.
  store.current = { ...store.current, nodes: store.current.nodes.filter((n) => n.key !== SESSION_KEY) };
  res = await hide(port, { key: SESSION_KEY, hide: false, role: 'coordinator' });
  assert.equal(res.status, 200);
  assert.deepEqual(memory.state.settings.people[SESSION_KEY], { label: 'Builder', role: 'coordinator' });
  // A helper with no entry: hiding makes one, and showing it again removes it.
  assert.deepEqual((await hide(port, { key: AGENT_KEY, hide: true })).json, { ok: true, role: null });
  assert.deepEqual(memory.state.settings.people[AGENT_KEY], { role: 'hidden' });
  assert.equal((await hide(port, { key: AGENT_KEY, hide: false, role: null })).status, 200);
  assert.equal(memory.state.settings.people[AGENT_KEY], undefined);
  // Showing a session that is not hidden changes nothing.
  assert.equal((await hide(port, { key: BOSS_KEY, hide: false, role: 'worker' })).status, 200);
  assert.equal(memory.state.settings.people[BOSS_KEY], undefined);
});

test('hide refuses the person, groups, the relay, worker runs, bad roles, unknown tiles and cross-site requests', async (t) => {
  const store = treeStore();
  store.current.nodes.push({ key: 'relay', title: 'Relay', kind: 'relay', parent: 'you' });
  store.current.nodes.push({ key: 'mailbox:T-1/W1', title: 'W1', kind: 'agent', parent: SESSION_KEY });
  const { port, memory } = await startServer(t, { store });
  for (const key of ['you', 'project:alpha', 'relay', 'mailbox:T-1/W1', 'nonsense']) {
    assert.equal((await hide(port, { key, hide: true })).status, 400, key);
  }
  assert.equal((await hide(port, { key: SESSION_KEY, hide: 'yes' })).status, 400);
  assert.equal((await hide(port, { key: SESSION_KEY, hide: false, role: 'hidden' })).status, 400);
  assert.equal((await hide(port, { key: SESSION_KEY, hide: false, role: 'boss' })).status, 400);
  assert.equal((await hide(port, { key: 'codex:0f8e2c4a-1b3d-4e5f-8a9b-00000000dead', hide: true })).status, 404);
  assert.equal((await hide(port, { key: SESSION_KEY, hide: true }, { 'x-pleni': undefined })).status, 403);
  assert.equal((await hide(port, { key: SESSION_KEY, hide: true }, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await hide(port, { key: SESSION_KEY, hide: true }, { cookie: undefined })).status, 401);
  assert.equal((await request(port, { path: '/api/hide' })).status, 405);
  assert.deepEqual(memory.state.settings.people, {}, 'nothing was saved');
});

test('settings name hidden sessions, which are not on the map', async (t) => {
  const store = fakeStore();
  store.current = { ...store.current, hiddenSessions: [{ key: 'codex:0f8e2c4a-1b3d-4e5f-8a9b-00000000beef', title: 'Old helper', platform: 'codex', kind: 'session' }] };
  const { port } = await startServer(t, { store });
  const res = await request(port, { path: '/api/settings' });
  assert.equal(res.status, 200);
  assert.ok(res.json.nodes.some((n) => n.key === 'codex:0f8e2c4a-1b3d-4e5f-8a9b-00000000beef' && n.title === 'Old helper'));
});

// ---- Models ----

function modelsSetup(t, settings = {}) {
  const dir = tempDir(t, 'pleni-models-server-');
  const codex = path.join(dir, 'codex');
  fs.mkdirSync(codex);
  fs.writeFileSync(path.join(codex, 'config.toml'), 'model = "gpt-6-astra"\nmodel_reasoning_effort = "max"\n');
  const memory = memorySettings({ ...REMOTE, ...settings });
  memory.state.file = path.join(dir, 'pleni', 'settings.json');
  memory.state.roots = { ...memory.state.roots, codex };
  const store = fakeStore();
  store.current.nodes.push(
    { key: 'codex:019a3f33-8e66-7b43-a04f-000000000001', title: 'Sergeant Lark', platform: 'codex', kind: 'session', model: 'gpt-6.1-sol' },
    { key: 'codex:019a3f33-8e66-7b43-a04f-000000000002', title: 'Sergeant Wren', platform: 'codex', kind: 'session', model: 'gpt-6.1-sol' },
    { key: 'codex:019a3f33-8e66-7b43-a04f-000000000003', title: 'Helper', platform: 'codex', kind: 'agent', model: 'gpt-6-astra' },
    { key: 'codex:019a3f33-8e66-7b43-a04f-000000000004', title: 'Review', platform: 'codex', kind: 'reviewer', model: 'codex-auto-review' },
  );
  return { dir, codex, memory, store };
}

const modelsReq = (port, body, headers = {}) => request(port, {
  method: 'POST',
  path: '/api/models',
  headers: { 'content-type': 'application/json', 'x-pleni': 'settings', ...headers },
  body: JSON.stringify(body),
});

test("GET /api/models reads Codex's model lines, and says where they can be changed", async (t) => {
  const { memory, store } = modelsSetup(t);
  const { port } = await startServer(t, { store, memory });
  const res = await request(port, { path: '/api/models' });
  assert.equal(res.status, 200);
  assert.deepEqual([res.json.edit, res.json.here, res.json.demo], [false, true, false]);
  assert.equal(res.json.codex.ok, true);
  assert.equal(res.json.codex.sergeant.model.value, 'gpt-6-astra');
  assert.equal(res.json.codex.sergeant.effort.value, 'max');
  assert.deepEqual(res.json.codex.models.map((m) => m.id), ['gpt-6.1-sol', 'gpt-6-astra'], 'the models in use, most used first, no reviewers');
  const laptop = await request(port, { path: '/api/models', headers: FROM_LAPTOP });
  assert.equal(laptop.status, 200);
  assert.equal(laptop.json.here, false);
  assertPlainError(await request(port, { path: '/api/models', headers: { cookie: undefined } }), 401);
  assertPlainError(await request(port, { method: 'PUT', path: '/api/models' }), 405);
});

test('Save to Codex works only on this computer, with the switch on, and keeps a copy', async (t) => {
  const { dir, codex, memory, store } = modelsSetup(t, { models: { edit: true } });
  const { port } = await startServer(t, { store, memory });
  const { tag } = (await request(port, { path: '/api/models' })).json.codex;
  const body = { tag, sergeant: { model: 'gpt-6.1-sol', effort: 'high' }, worker: { model: 'gpt-6-astra' } };
  assertPlainError(await modelsReq(port, body, { cookie: undefined }), 401);
  assertPlainError(await modelsReq(port, body, { 'x-pleni': undefined }), 403);
  assertPlainError(await modelsReq(port, body, { origin: 'https://evil.example' }), 403);
  const remote = await modelsReq(port, body, FROM_LAPTOP);
  assertPlainError(remote, 403);
  assert.match(remote.json.error, /only on the computer that runs Pleni/);
  assert.equal(fs.readFileSync(path.join(codex, 'config.toml'), 'utf8'), 'model = "gpt-6-astra"\nmodel_reasoning_effort = "max"\n');

  const ok = await modelsReq(port, body);
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.json.files, [path.join(codex, 'config.toml')]);
  assert.equal(ok.json.backups.length, 1);
  assert.equal(path.dirname(ok.json.backups[0]), path.join(dir, 'pleni', 'backups'));
  assert.equal(
    fs.readFileSync(path.join(codex, 'config.toml'), 'utf8'),
    'model = "gpt-6.1-sol"\nmodel_reasoning_effort = "high"\n\n[agents]\ndefault_subagent_model = "gpt-6-astra"\n',
  );
  const stale = await modelsReq(port, body);
  assertPlainError(stale, 409);
  assert.match(stale.json.error, /changed since you looked/);
});

test('Save to Codex is refused while the switch is off, and in the demo', async (t) => {
  const off = modelsSetup(t);
  const a = await startServer(t, { store: off.store, memory: off.memory });
  const { tag } = (await request(a.port, { path: '/api/models' })).json.codex;
  const refused = await modelsReq(a.port, { tag, sergeant: { model: 'gpt-6.1-sol' } });
  assertPlainError(refused, 403);
  assert.match(refused.json.error, /turned off/);

  const demo = modelsSetup(t, { models: { edit: true } });
  demo.store.demo = true;
  const b = await startServer(t, { store: demo.store, memory: demo.memory });
  const shown = await request(b.port, { path: '/api/models' });
  assert.equal(shown.json.demo, true);
  assert.equal(shown.json.codex.sergeant.model.value, 'gpt-6.1-sol', 'the demo shows made-up settings');
  assert.equal(shown.json.claude.sergeant.model.value, 'opus');
  const saved = await modelsReq(b.port, { tag: 'demo', sergeant: { model: 'gpt-6-astra' } });
  assertPlainError(saved, 409);
  assert.equal(fs.readFileSync(path.join(demo.codex, 'config.toml'), 'utf8'), 'model = "gpt-6-astra"\nmodel_reasoning_effort = "max"\n');
});

test("the Models page reads and saves Claude Code's settings too", async (t) => {
  const { dir, memory, store } = modelsSetup(t, { models: { edit: true } });
  const claude = path.join(dir, 'claude');
  fs.mkdirSync(claude);
  fs.writeFileSync(path.join(claude, 'settings.json'), '{\n  "model": "opus",\n  "theme": "dark"\n}\n');
  memory.state.roots = { ...memory.state.roots, claude };
  store.current.nodes.push({ key: 'claude:0f8e2c4a-1b3d-4e5f-8a9b-0c1d2e3f4a5c', title: 'Sergeant Claude', platform: 'claude', kind: 'session', model: 'claude-opus-5-5' });
  const { port } = await startServer(t, { store, memory });
  const shown = (await request(port, { path: '/api/models' })).json;
  assert.equal(shown.claude.ok, true);
  assert.equal(shown.claude.sergeant.model.value, 'opus');
  assert.ok(shown.claude.models.some((m) => m.id === 'claude-opus-5-5'), 'the models in use are offered');
  assert.ok(!shown.claude.models.some((m) => m.id === 'gpt-6.1-sol'), 'only Claude Code models');
  const ok = await modelsReq(port, { app: 'claude', tag: shown.claude.tag, sergeant: { effort: 'high' }, worker: { model: 'sonnet' } });
  assert.equal(ok.status, 200, ok.text);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(claude, 'settings.json'), 'utf8')), {
    model: 'opus',
    theme: 'dark',
    modelSettings: { opus: { effortLevel: 'high' } },
    env: { CLAUDE_CODE_SUBAGENT_MODEL: 'sonnet' },
  });
  assert.match(path.basename(ok.json.backups[0]), /^claude-settings-\d{8}-\d{6}\.json$/);
  // The Codex file was not touched by a Claude Code save.
  assert.equal(fs.readFileSync(path.join(dir, 'codex', 'config.toml'), 'utf8'), 'model = "gpt-6-astra"\nmodel_reasoning_effort = "max"\n');
});

// ---- Send ----

const sendReq = (port, body, headers = {}) => request(port, {
  method: 'POST',
  path: '/api/send',
  headers: { 'content-type': 'application/json', 'x-pleni': 'settings', ...headers },
  body: JSON.stringify(body),
});

const SEND_ON = { actions: { send: true } };

// A sender that records what the server passes on, and answers what the test says.
function recordSender(answer = { ok: true }) {
  const calls = { info: [], send: [] };
  return {
    calls,
    info(args) {
      calls.info.push(args);
      return { ok: true, info: { problem: null, running: false, last: null, mode: 'read' } };
    },
    async send(args) {
      calls.send.push(args);
      return answer;
    },
  };
}

test('send passes the message, the session and the record file to the sender', async (t) => {
  const sender = recordSender();
  const memory = memorySettings(SEND_ON);
  const { port } = await startServer(t, { store: openStore(tempDir(t)), memory, platform: 'win32', sender });
  const res = await sendReq(port, { key: SESSION_KEY, text: 'Run the tests.', id: 'page-message-000001' });
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(res.json, { ok: true });
  assert.equal(sender.calls.send.length, 1);
  const call = sender.calls.send[0];
  assert.equal(call.key, SESSION_KEY);
  assert.equal(call.text, 'Run the tests.');
  assert.equal(call.id, 'page-message-000001');
  assert.equal(call.settings.actions.send, true);
  assert.equal(call.logFile, path.join(path.dirname(memory.state.file), 'sent.jsonl'));
  assert.equal(call.platform, 'win32');
  const info = await request(port, { path: `/api/send?key=${encodeURIComponent(SESSION_KEY)}` });
  assert.equal(info.status, 200);
  assert.deepEqual(info.json, { problem: null, running: false, last: null, mode: 'read' });
  assert.equal(sender.calls.info[0].key, SESSION_KEY);
});

test('send needs the key, the page header, the same origin, JSON, and this computer', async (t) => {
  const sender = recordSender();
  const settings = { ...SEND_ON, remote: { hosts: ['box.example.ts.net'], tailscaleUsers: ['ada@example.com'] } };
  const { port } = await startServer(t, { store: openStore(tempDir(t)), settings, platform: 'win32', sender });
  const body = { key: SESSION_KEY, text: 'hello', id: 'page-message-000002' };
  assertPlainError(await sendReq(port, body, { cookie: undefined }), 401);
  assertPlainError(await sendReq(port, body, { 'x-pleni': undefined }), 403);
  assertPlainError(await sendReq(port, body, { origin: 'https://evil.example' }), 403);
  assertPlainError(await sendReq(port, body, { 'content-type': 'text/plain' }), 415);
  const remote = { host: 'box.example.ts.net', 'tailscale-user-login': 'ada@example.com' };
  for (const headers of [remote, { 'x-forwarded-for': '100.64.0.7' }]) {
    const res = await sendReq(port, body, headers);
    assertPlainError(res, 403);
    assert.match(res.json.error, /only on the computer that runs it/);
    assertPlainError(await request(port, { path: `/api/send?key=${encodeURIComponent(SESSION_KEY)}`, headers }), 403);
  }
  assertPlainError(await request(port, { method: 'PUT', path: '/api/send' }), 405);
  assert.equal(sender.calls.send.length, 0);
  assert.equal(sender.calls.info.length, 0);
});

test('send answers a refusal with its status and plain words, and a repeat as done', async (t) => {
  const refused = recordSender({ ok: false, status: 409, error: SEND_MESSAGES.busy });
  const a = await startServer(t, { store: openStore(tempDir(t)), settings: SEND_ON, platform: 'win32', sender: refused });
  const res = await sendReq(a.port, { key: SESSION_KEY, text: 'hello', id: 'page-message-000003' });
  assertPlainError(res, 409);
  assert.equal(res.json.error, SEND_MESSAGES.busy);
  const repeat = recordSender({ ok: true, repeat: true });
  const b = await startServer(t, { store: openStore(tempDir(t)), settings: SEND_ON, platform: 'win32', sender: repeat });
  assert.deepEqual((await sendReq(b.port, { key: SESSION_KEY, text: 'hello', id: 'page-message-000003' })).json, { ok: true, repeat: true });
});

test('the real sender is off by default and works only on Windows', async (t) => {
  const off = await startServer(t, { store: openStore(tempDir(t)), platform: 'win32', sender: createSender() });
  const res = await sendReq(off.port, { key: SESSION_KEY, text: 'hello', id: 'page-message-000004' });
  assertPlainError(res, 403);
  assert.equal(res.json.error, SEND_MESSAGES.off);
  const linux = await startServer(t, { store: openStore(tempDir(t)), settings: SEND_ON, platform: 'linux', sender: createSender() });
  const elsewhere = await request(linux.port, { path: `/api/send?key=${encodeURIComponent(SESSION_KEY)}` });
  assertPlainError(elsewhere, 409);
  assert.equal(elsewhere.json.error, SEND_MESSAGES.windowsOnly);
});

// ---- answering questions ----

const HOOK_SECRET = 'hook-secret-0123456789abcdefghijklmnopqrstuv';
const SESSION_ID = SESSION_KEY.slice('claude:'.length);

const hookReq = (port, body, headers = {}) => request(port, {
  method: 'POST',
  path: '/api/hook',
  headers: { host: `127.0.0.1:${port}`, cookie: undefined, 'content-type': 'application/json', 'x-pleni-hook': HOOK_SECRET, ...headers },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});

const answerReq = (port, path, body, headers = {}) => request(port, {
  method: 'POST',
  path,
  headers: { 'content-type': 'application/json', 'x-pleni': 'settings', ...headers },
  body: JSON.stringify(body),
});

const askedQuestion = {
  session_id: SESSION_ID,
  hook_event_name: 'PreToolUse',
  tool_name: 'AskUserQuestion',
  tool_input: { questions: [{ question: 'Ship it now?', header: 'Ship', multiSelect: false, options: [{ label: 'Yes' }, { label: 'Not yet' }] }] },
};

const ANSWERING = { actions: { answers: true }, people: { [SESSION_KEY]: { answer: true } } };

// A store that keeps the questions the server hands it, like the real one.
function answerStore() {
  const store = fakeStore();
  store.asks = [];
  store.setAsks = (list) => {
    store.asks = list;
  };
  return store;
}

test('a hook call needs the secret, this computer, and JSON', async (t) => {
  const settings = { ...ANSWERING, remote: { hosts: ['box.example.ts.net'], tailscaleUsers: ['ada@example.com'] } };
  const { port } = await startServer(t, { store: answerStore(), settings, hookKey: HOOK_SECRET });
  assertPlainError(await hookReq(port, askedQuestion, { 'x-pleni-hook': undefined }), 403);
  assertPlainError(await hookReq(port, askedQuestion, { 'x-pleni-hook': `${HOOK_SECRET}x` }), 403);
  assertPlainError(await hookReq(port, askedQuestion, { host: 'box.example.ts.net', 'tailscale-user-login': 'ada@example.com' }), 403);
  assertPlainError(await hookReq(port, askedQuestion, { 'x-forwarded-for': '100.64.0.7' }), 403);
  assertPlainError(await hookReq(port, askedQuestion, { 'content-type': 'text/plain' }), 415);
  assertPlainError(await request(port, { path: '/api/hook' }), 405);
  // A page's key is not the hook's secret.
  assertPlainError(await hookReq(port, askedQuestion, { 'x-pleni-hook': undefined, cookie: keyCookie(port) }), 403);
  // Without a secret at all (the demo), no call is answered.
  const demo = await startServer(t, { store: answerStore(), settings });
  assertPlainError(await hookReq(demo.port, askedQuestion), 403);
});

test('a hook call Pleni does not hold gets no decision at once', async (t) => {
  const cases = [
    { settings: { people: { [SESSION_KEY]: { answer: true } } } },               // answering is off
    { settings: { actions: { answers: true } } },                                // not switched on for this session
    { settings: { ...ANSWERING, content: 'none' } },                             // no session text shown
    { settings: ANSWERING, body: { ...askedQuestion, tool_name: 'Bash' } },     // not a question Pleni shows
    { settings: ANSWERING, body: 'not json' },
  ];
  for (const c of cases) {
    const { port } = await startServer(t, { store: answerStore(), settings: c.settings, hookKey: HOOK_SECRET });
    const res = await hookReq(port, c.body ?? askedQuestion);
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(res.json, {});
  }
});

test('a held question waits for the answer from the page, and the hook gets it', async (t) => {
  const store = answerStore();
  const { port } = await startServer(t, { store, settings: ANSWERING, hookKey: HOOK_SECRET });
  const pending = hookReq(port, askedQuestion);
  let tries = 0;
  while (!store.asks.length && tries++ < 500) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(store.asks.length, 1);
  const [ask] = store.asks;
  assert.equal(ask.key, SESSION_KEY);
  assert.equal(ask.kind, 'question');
  assert.equal(ask.questions[0].question, 'Ship it now?');
  assertPlainError(await answerReq(port, '/api/answer', { id: ask.id, answer: { answers: ['Yes'] } }, { 'tailscale-user-login': 'ada@example.com' }), 403);
  assertPlainError(await answerReq(port, '/api/answer', { id: ask.id, answer: { answers: [] } }), 400);
  assertPlainError(await answerReq(port, '/api/answer', { id: 'f'.repeat(24), answer: { answers: ['Yes'] } }), 404);
  const ok = await answerReq(port, '/api/answer', { id: ask.id, answer: { answers: ['Not yet'] } });
  assert.deepEqual(ok.json, { ok: true });
  const res = await pending;
  assert.equal(res.status, 200);
  assert.deepEqual(res.json.hookSpecificOutput, {
    hookEventName: 'PreToolUse',
    permissionDecision: 'allow',
    updatedInput: { ...askedQuestion.tool_input, answers: { 'Ship it now?': 'Not yet' } },
  });
  assert.deepEqual(store.asks, []);
});

test('"Answer in the session instead" gives the question back with no decision', async (t) => {
  const store = answerStore();
  const { port } = await startServer(t, { store, settings: ANSWERING, hookKey: HOOK_SECRET });
  const pending = hookReq(port, askedQuestion);
  let tries = 0;
  while (!store.asks.length && tries++ < 500) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual((await answerReq(port, '/api/answer', { id: store.asks[0].id, release: true })).json, { ok: true });
  assert.deepEqual((await pending).json, {});
});

test('a session is switched to answer from Pleni only on this computer, and only a main Claude Code session', async (t) => {
  const { port, memory } = await startServer(t, { store: answerStore(), settings: { actions: { answers: true } } });
  assert.deepEqual((await answerReq(port, '/api/answering', { key: SESSION_KEY, on: true })).json, { ok: true });
  assert.equal(memory.state.settings.people[SESSION_KEY].answer, true);
  assert.deepEqual((await answerReq(port, '/api/answering', { key: SESSION_KEY, on: false })).json, { ok: true });
  assert.equal(memory.state.settings.people[SESSION_KEY], undefined);
  assertPlainError(await answerReq(port, '/api/answering', { key: 'codex:0f8e2c4a-1b3d-4e5f-8a9b-0c1d2e3f4a5b', on: true }), 400);
  assertPlainError(await answerReq(port, '/api/answering', { key: SESSION_KEY, on: 'yes' }), 400);
  assertPlainError(await answerReq(port, '/api/answering', { key: 'claude:1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d', on: true }), 404);
  assertPlainError(await answerReq(port, '/api/answering', { key: SESSION_KEY, on: true }, { 'x-forwarded-for': '100.64.0.7' }), 403);
  assertPlainError(await answerReq(port, '/api/answering', { key: SESSION_KEY, on: true }, { cookie: undefined }), 401);
});

test('Connect adds Pleni\'s hooks to Claude Code\'s settings and turns answering on; Disconnect undoes both', async (t) => {
  const dir = tempDir(t);
  const claude = path.join(dir, 'claude');
  fs.mkdirSync(claude);
  fs.writeFileSync(path.join(claude, 'settings.json'), '{\n  "model": "opus"\n}\n');
  const memory = memorySettings({});
  memory.state.file = path.join(dir, 'pleni', 'settings.json');
  memory.state.roots = { ...memory.state.roots, claude };
  const { port } = await startServer(t, { store: answerStore(), memory, hookKey: HOOK_SECRET });
  const before = (await request(port, { path: '/api/hooks' })).json;
  assert.equal(before.on, false);
  assert.equal(before.connected, false);
  assert.equal(before.port, port);
  assert.ok(!JSON.stringify(before).includes(HOOK_SECRET), 'the page never sees the secret');
  assertPlainError(await request(port, { path: '/api/hooks', headers: { 'x-forwarded-for': '100.64.0.7' } }), 403);
  assertPlainError(await answerReq(port, '/api/hooks', { connect: true }, { 'tailscale-user-login': 'ada@example.com' }), 403);
  const done = await answerReq(port, '/api/hooks', { connect: true });
  assert.equal(done.status, 200, done.text);
  assert.match(path.basename(done.json.backup), /^claude-settings-\d{8}-\d{6}\.json$/);
  assert.equal(memory.state.settings.actions.answers, true);
  const saved = JSON.parse(fs.readFileSync(path.join(claude, 'settings.json'), 'utf8'));
  assert.equal(saved.model, 'opus');
  assert.equal(saved.hooks.PreToolUse[0].hooks[0].url, `http://127.0.0.1:${port}/api/hook`);
  assert.equal(saved.hooks.PreToolUse[0].hooks[0].headers['X-Pleni-Hook'], HOOK_SECRET);
  assert.equal((await request(port, { path: '/api/hooks' })).json.connected, true);
  assert.equal((await answerReq(port, '/api/hooks', { connect: false })).status, 200);
  assert.equal(memory.state.settings.actions.answers, false);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(claude, 'settings.json'), 'utf8')), { model: 'opus' });
  assertPlainError(await answerReq(port, '/api/hooks', { connect: 'yes' }), 400);
});
