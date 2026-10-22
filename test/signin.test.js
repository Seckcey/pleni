import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  LOCK_AFTER,
  MAX_DEVICES,
  PASSWORD_MAX,
  PASSWORD_MIN,
  SIGNIN_MESSAGES,
  createSignin,
  deviceName,
  devicesFile,
  passwordFile,
  passwordProblem,
  waitMessage,
} from '../src/signin.js';

// A small scrypt cost keeps the tests fast; real passwords use the full one.
const COST = { N: 2 ** 10, r: 8, p: 1 };
const PASSWORD = 'correct horse battery';

function tempSettings(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pleni-signin-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'settings.json');
}

function clock(start = 1_000_000) {
  const c = { at: start, now: () => c.at };
  return c;
}

test('a new password must have 8 to 200 characters and not be only spaces', () => {
  assert.equal(passwordProblem('a'.repeat(PASSWORD_MIN)), null);
  assert.equal(passwordProblem('a'.repeat(PASSWORD_MAX)), null);
  assert.equal(passwordProblem('a'.repeat(PASSWORD_MIN - 1)), SIGNIN_MESSAGES.tooShort);
  assert.equal(passwordProblem('a'.repeat(PASSWORD_MAX + 1)), SIGNIN_MESSAGES.tooLong);
  assert.equal(passwordProblem('         '), SIGNIN_MESSAGES.blank);
  assert.equal(passwordProblem(12345678), SIGNIN_MESSAGES.notText);
  // Characters count, not bytes: eight emoji are eight characters.
  assert.equal(passwordProblem('🔑'.repeat(PASSWORD_MIN)), null);
});

test('the password is kept only as a hash, and the right one signs in', async (t) => {
  const file = tempSettings(t);
  const signin = createSignin({ file, cost: COST });
  assert.deepEqual(signin.passwordInfo(), { set: false, at: null, locked: false, problem: null });
  assert.deepEqual(await signin.setPassword(PASSWORD), { ok: true });
  assert.equal(signin.passwordInfo().set, true);
  const text = fs.readFileSync(passwordFile(file), 'utf8');
  assert.ok(!text.includes(PASSWORD), 'the password itself is never written');
  const kept = JSON.parse(text);
  assert.deepEqual(Object.keys(kept).sort(), ['N', 'at', 'hash', 'locked', 'p', 'r', 'salt', 'v', 'waitUntil', 'wrong']);
  if (process.platform !== 'win32') assert.equal(fs.statSync(passwordFile(file)).mode & 0o777, 0o600);
  assert.deepEqual(await signin.checkPassword(PASSWORD), { ok: true });
  assert.equal((await signin.checkPassword('correct horse battery ')).ok, false);
  // A new Pleni reads the same file.
  assert.deepEqual(await createSignin({ file, cost: COST }).checkPassword(PASSWORD), { ok: true });
});

test('the same password typed another way (Unicode forms) still works', async () => {
  const signin = createSignin({ cost: COST });
  await signin.setPassword('café-au-lait');
  assert.deepEqual(await signin.checkPassword('café-au-lait'), { ok: true });
});

test('without a password, a sign-in try says how to set one', async () => {
  const result = await createSignin({ cost: COST }).checkPassword(PASSWORD);
  assert.deepEqual(result, { ok: false, status: 401, error: SIGNIN_MESSAGES.noPassword });
});

test('wrong tries: five are free, then waits that double up to 30 minutes, then the password stops', async (t) => {
  const file = tempSettings(t);
  const c = clock();
  const signin = createSignin({ file, cost: COST, now: c.now });
  await signin.setPassword(PASSWORD);
  for (let i = 1; i < 5; i++) assert.deepEqual(await signin.checkPassword('wrong one'), { ok: false, status: 401, error: SIGNIN_MESSAGES.wrong }, `try ${i}`);
  let result = await signin.checkPassword('wrong one');
  assert.equal(result.status, 429);
  assert.equal(result.wait, 60);
  assert.equal(result.error, `${SIGNIN_MESSAGES.wrong} ${waitMessage(60_000)}`);
  // While Pleni waits, even the right password is turned away, so waiting cannot be skipped.
  result = await signin.checkPassword(PASSWORD);
  assert.equal(result.status, 429);
  assert.equal(result.error, waitMessage(60_000));
  const waits = [];
  for (let i = 6; i < LOCK_AFTER; i++) {
    c.at += 31 * 60 * 1000;
    waits.push((await signin.checkPassword('wrong one')).wait);
  }
  assert.deepEqual(waits.slice(0, 6), [120, 240, 480, 960, 1800, 1800]);
  c.at += 31 * 60 * 1000;
  result = await signin.checkPassword('wrong one');
  assert.deepEqual(result, { ok: false, status: 429, error: SIGNIN_MESSAGES.locked });
  c.at += 24 * 60 * 60 * 1000;
  assert.deepEqual(await signin.checkPassword(PASSWORD), { ok: false, status: 429, error: SIGNIN_MESSAGES.locked });
  assert.equal(signin.passwordInfo().locked, true);
  // The stop is saved: a restart does not give more guesses.
  const again = createSignin({ file, cost: COST, now: c.now });
  assert.equal(again.passwordInfo().locked, true);
  assert.equal((await again.checkPassword(PASSWORD)).status, 429);
  // Only the person at this computer turns it back on.
  assert.deepEqual(again.unlock(), { ok: true });
  assert.deepEqual(await again.checkPassword(PASSWORD), { ok: true });
});

test('the wrong tries and the wait are saved across a restart; a right password clears them', async (t) => {
  const file = tempSettings(t);
  const c = clock();
  const signin = createSignin({ file, cost: COST, now: c.now });
  await signin.setPassword(PASSWORD);
  for (let i = 0; i < 4; i++) await signin.checkPassword('nope nope');
  assert.equal(JSON.parse(fs.readFileSync(passwordFile(file), 'utf8')).wrong, 4);
  const restarted = createSignin({ file, cost: COST, now: c.now });
  assert.equal((await restarted.checkPassword('nope nope')).status, 429, 'the fifth wrong try waits, also after a restart');
  // The wait goes on after another restart, for the right password too.
  const fresh = createSignin({ file, cost: COST, now: c.now });
  assert.equal((await fresh.checkPassword(PASSWORD)).status, 429);
  c.at += 61 * 1000;
  assert.deepEqual(await fresh.checkPassword(PASSWORD), { ok: true });
  const kept = JSON.parse(fs.readFileSync(passwordFile(file), 'utf8'));
  assert.equal(kept.wrong, 0);
  assert.equal(kept.waitUntil, 0);
});

test('a wait never lasts longer than 30 minutes from now, even after the clock goes back', async (t) => {
  const file = tempSettings(t);
  const c = clock(10 * 24 * 60 * 60 * 1000);
  const signin = createSignin({ file, cost: COST, now: c.now });
  await signin.setPassword(PASSWORD);
  for (let i = 0; i < 5; i++) await signin.checkPassword('nope nope');
  c.at -= 24 * 60 * 60 * 1000;
  assert.equal((await signin.checkPassword(PASSWORD)).wait, 1800);
  c.at += 31 * 60 * 1000;
  assert.deepEqual(await signin.checkPassword(PASSWORD), { ok: true });
});

test('two Plenis on one settings folder keep the same password, count and devices', async (t) => {
  const file = tempSettings(t);
  const a = createSignin({ file, cost: COST });
  const b = createSignin({ file, cost: COST });
  await a.setPassword(PASSWORD);
  assert.deepEqual(await b.checkPassword(PASSWORD), { ok: true }, 'b sees the password a set');
  await a.setPassword('a brand new one');
  assert.equal((await b.checkPassword(PASSWORD)).ok, false, 'b no longer takes the old password');
  // b's wrong try counts on the new password and does not bring the old one back.
  assert.deepEqual(await createSignin({ file, cost: COST }).checkPassword('a brand new one'), { ok: true });
  for (let i = 0; i < 2; i++) await a.checkPassword('nope nope');
  for (let i = 0; i < 2; i++) await b.checkPassword('nope nope');
  assert.equal(JSON.parse(fs.readFileSync(passwordFile(file), 'utf8')).wrong, 4, 'one count for both');
  assert.equal((await a.checkPassword('nope nope')).status, 429);
  // A device signed out in one is signed out in the other at once, and stays out.
  const phone = a.addDevice({ name: 'Phone', via: 'password' });
  assert.equal(b.findDevice(phone.pass).name, 'Phone');
  assert.deepEqual(a.removeDevice(phone.device.id), { removed: 1, saved: true });
  assert.equal(b.findDevice(phone.pass), null);
  b.addDevice({ name: 'Tablet', via: 'password' });
  assert.equal(createSignin({ file }).findDevice(phone.pass), null);
});

test('a sign-out that cannot be saved says so, and still works until Pleni stops', (t) => {
  const file = tempSettings(t);
  const signin = createSignin({ file });
  const { pass, device } = signin.addDevice({ name: 'Phone', via: 'password' });
  // A folder where the temporary file goes makes the next save fail.
  const blocker = `${devicesFile(file)}.${process.pid}.tmp`;
  fs.mkdirSync(blocker);
  assert.deepEqual(signin.removeDevice(device.id), { removed: 1, saved: false });
  assert.equal(signin.findDevice(pass), null);
  assert.equal(signin.devicesProblem(), SIGNIN_MESSAGES.devicesUnsaved);
  fs.rmdirSync(blocker);
  assert.deepEqual(signin.removeAllDevices(), { removed: 0, saved: true });
  assert.equal(createSignin({ file }).findDevice(pass), null);
});

test('only one password check runs at a time', async () => {
  const signin = createSignin({ cost: COST });
  await signin.setPassword(PASSWORD);
  const [first, second] = await Promise.all([signin.checkPassword(PASSWORD), signin.checkPassword(PASSWORD)]);
  assert.deepEqual(first, { ok: true });
  assert.deepEqual(second, { ok: false, status: 429, error: SIGNIN_MESSAGES.busy, wait: 1 });
});

test('changing or removing the password', async (t) => {
  const file = tempSettings(t);
  const signin = createSignin({ file, cost: COST });
  await signin.setPassword(PASSWORD);
  await signin.setPassword('a brand new one');
  assert.equal((await signin.checkPassword(PASSWORD)).ok, false);
  assert.deepEqual(await signin.checkPassword('a brand new one'), { ok: true });
  assert.equal((await signin.setPassword('short')).error, SIGNIN_MESSAGES.tooShort);
  assert.deepEqual(signin.removePassword(), { ok: true });
  assert.equal(fs.existsSync(passwordFile(file)), false);
  assert.equal(signin.passwordInfo().set, false);
});

test('a damaged password file means no password, and Settings says so', async (t) => {
  const file = tempSettings(t);
  fs.writeFileSync(passwordFile(file), '{"v":1,"N":3}');
  const signin = createSignin({ file, cost: COST });
  assert.deepEqual(signin.passwordInfo(), { set: false, at: null, locked: false, problem: SIGNIN_MESSAGES.passwordUnread });
  await signin.setPassword(PASSWORD);
  assert.equal(signin.passwordInfo().problem, null);
});

test('each device gets its own pass; only its hash is kept, and removing it signs it out at once', (t) => {
  const file = tempSettings(t);
  const c = clock();
  const signin = createSignin({ file, now: c.now });
  const phone = signin.addDevice({ name: 'iPhone, Safari', via: 'password' });
  const laptop = signin.addDevice({ name: 'Mac, Firefox', via: 'key' });
  assert.match(phone.pass, /^d\.[A-Za-z0-9_-]{43}$/);
  assert.notEqual(phone.pass, laptop.pass);
  const text = fs.readFileSync(devicesFile(file), 'utf8');
  assert.ok(!text.includes(phone.pass) && !text.includes(phone.pass.slice(2)), 'passes are never written');
  if (process.platform !== 'win32') assert.equal(fs.statSync(devicesFile(file)).mode & 0o777, 0o600);
  c.at += 1000;
  assert.equal(signin.findDevice(phone.pass).id, phone.device.id);
  assert.equal(signin.findDevice(`${phone.pass}x`), null);
  assert.equal(signin.findDevice('d.' + 'A'.repeat(43)), null);
  assert.equal(signin.findDevice('not a pass'), null);
  assert.deepEqual(signin.devices().map((d) => [d.name, d.via]), [['iPhone, Safari', 'password'], ['Mac, Firefox', 'key']]);
  // A new Pleni knows the same devices.
  assert.equal(createSignin({ file }).findDevice(laptop.pass).name, 'Mac, Firefox');
  assert.deepEqual(signin.removeDevice(phone.device.id), { removed: 1, saved: true });
  assert.equal(signin.findDevice(phone.pass), null);
  assert.deepEqual(signin.removeDevice(phone.device.id), { removed: 0, saved: true });
  assert.deepEqual(signin.removeAllDevices(), { removed: 1, saved: true });
  assert.equal(signin.findDevice(laptop.pass), null);
  assert.equal(createSignin({ file }).devices().length, 0);
});

test('"last used" is saved now and then, not on every request', (t) => {
  const file = tempSettings(t);
  const c = clock();
  const signin = createSignin({ file, now: c.now });
  const { pass } = signin.addDevice({ name: 'Phone', via: 'password' });
  const saved = () => JSON.parse(fs.readFileSync(devicesFile(file), 'utf8')).devices[0].seen;
  c.at += 60 * 1000;
  signin.findDevice(pass);
  assert.equal(saved(), 1_000_000);
  assert.equal(signin.devices()[0].seen, 1_060_000);
  c.at += 10 * 60 * 1000;
  signin.findDevice(pass);
  assert.equal(saved(), 1_660_000);
});

test('at most 50 devices: the one not used for the longest makes room', () => {
  const c = clock();
  const signin = createSignin({ now: c.now });
  const first = signin.addDevice({ name: 'Old one', via: 'password' });
  for (let i = 1; i < MAX_DEVICES; i++) {
    c.at += 1;
    signin.addDevice({ name: `Device ${i}`, via: 'password' });
  }
  c.at += 1;
  signin.addDevice({ name: 'Newest', via: 'password' });
  assert.equal(signin.devices().length, MAX_DEVICES);
  assert.equal(signin.findDevice(first.pass), null);
});

test('a damaged device list starts empty, and Settings says so', (t) => {
  const file = tempSettings(t);
  fs.writeFileSync(devicesFile(file), 'not json');
  const signin = createSignin({ file });
  assert.equal(signin.devicesProblem(), SIGNIN_MESSAGES.devicesUnread);
  assert.deepEqual(signin.devices(), []);
  signin.addDevice({ name: 'Phone', via: 'password' });
  assert.equal(signin.devicesProblem(), null);
  // Entries that do not look right are left out; the good ones stay.
  const good = JSON.parse(fs.readFileSync(devicesFile(file), 'utf8')).devices[0];
  fs.writeFileSync(devicesFile(file), JSON.stringify({ v: 1, devices: [good, { id: 'x', hash: 'y' }, good] }));
  assert.equal(createSignin({ file }).devices().length, 1);
});

test('device names come from the browser, in plain words', () => {
  const cases = [
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Mobile/15E148 Safari/604.1', 'iPhone, Safari'],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/140.0 Mobile/15E148 Safari/604.1', 'iPhone, Chrome'],
    ['Mozilla/5.0 (Linux; Android 16; Pixel 10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36', 'Android phone, Chrome'],
    ['Mozilla/5.0 (Linux; Android 16; SM-X910) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/28.0 Chrome/140.0 Safari/537.36', 'Android tablet, Samsung Internet'],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36 Edg/140.0', 'Windows computer, Edge'],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 15_6) Gecko/20100101 Firefox/144.0', 'Mac, Firefox'],
    ['Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36', 'Linux computer, Chrome'],
    ['curl/8.0', 'A device'],
    [undefined, 'A device'],
  ];
  for (const [ua, name] of cases) assert.equal(deviceName(ua), name, ua);
});

test('a device name keeps no control characters and stays short', () => {
  const signin = createSignin();
  const { device } = signin.addDevice({ name: `Phone\u0000‮${'x'.repeat(100)}`, via: 'password' });
  assert.ok(!/[\u0000‮]/.test(device.name));
  assert.equal([...device.name].length, 60);
});

test('a password file that cannot be read for a moment keeps the last good copy', async (t) => {
  const file = tempSettings(t);
  const signin = createSignin({ file, cost: COST });
  await signin.setPassword(PASSWORD);
  // A folder in the file's place cannot be read (EISDIR): like a file another program holds.
  const kept = fs.readFileSync(passwordFile(file));
  fs.rmSync(passwordFile(file));
  fs.mkdirSync(passwordFile(file));
  assert.equal(signin.passwordInfo().set, true);
  assert.deepEqual(await signin.checkPassword(PASSWORD), { ok: true });
  fs.rmdirSync(passwordFile(file));
  fs.writeFileSync(passwordFile(file), kept);
  assert.deepEqual(await signin.checkPassword(PASSWORD), { ok: true });
});
