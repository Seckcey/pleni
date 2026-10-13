import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { cleanSettings } from '../src/config.js';
import { browserCommand, createServer, loadOrCreateKey, newKey } from '../src/server.js';

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
    key: TEST_KEY,
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

test('the kept key survives a restart and --new-key replaces it', (t) => {
  const dir = tempDir(t, 'pleni-key-');
  const file = path.join(dir, 'nested', 'key');
  const first = loadOrCreateKey(file);
  assert.equal(first.saved, true);
  assert.match(first.key, /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(loadOrCreateKey(file), first);
  const renewed = loadOrCreateKey(file, { renew: true });
  assert.notEqual(renewed.key, first.key);
  assert.equal(loadOrCreateKey(file).key, renewed.key);
  fs.writeFileSync(file, 'not a key!');
  const repaired = loadOrCreateKey(file);
  assert.notEqual(repaired.key, renewed.key);
  assert.equal(fs.readFileSync(file, 'utf8').trim(), repaired.key);
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
  assert.deepEqual(Object.keys(res.json).sort(), ['file', 'nodes', 'roots', 'settings']);
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
  for (const bad of [{ id: 'x|nope', at: 1 }, { id: '|needs', at: 1 }, { id: 'a b|needs', at: 1 }, { id: `${SESSION_KEY}|needs`, at: -1 }, { id: `${SESSION_KEY}|needs`, at: '1' }, { id: `${SESSION_KEY}|needs` }, { at: 1 }]) {
    assert.equal((await post(bad)).status, 400, JSON.stringify(bad));
  }
  assert.equal((await post({ id: 'task:T-1|review', at: 1 }, { 'x-pleni': undefined })).status, 403);
  assert.equal((await post({ id: 'task:T-1|review', at: 1 }, { cookie: undefined })).status, 401);
  assert.equal((await request(port, { path: '/api/dismiss' })).status, 405);
  assert.deepEqual(store.dismissed, [[`${SESSION_KEY}|needs`, 1234], ['task:T-1|question', null]]);
});
