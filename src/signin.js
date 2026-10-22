// Signing in from other devices: Pleni's password, the devices that signed in, and the waits after
// wrong tries. The password is kept only as an scrypt hash, and each device only as the SHA-256 of
// its own random pass, both in Pleni's own folder, so these files alone let nobody in.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { renameWithRetry } from './config.js';

export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 200;
export const MAX_DEVICES = 50;
// After this many wrong tries in a row the password stops working until the person turns it on
// again on this computer. The count is saved, so a restart gives nobody more guesses.
export const LOCK_AFTER = 20;
// About 32 MB and a tenth of a second for each check: slow for someone guessing from a copy of the
// file, quick for one sign-in.
const COST = Object.freeze({ N: 2 ** 15, r: 8, p: 1 });
const MAX_MEMORY = 128 * 1024 * 1024;
const HASH_BYTES = 32;
const SALT_BYTES = 16;
// A device's pass is "d." and 43 base64url characters. Pleni's key never has a dot.
const PASS_RE = /^d\.[A-Za-z0-9_-]{43}$/;
const ID_RE = /^[A-Za-z0-9_-]{12}$/;
const HASH_RE = /^[0-9a-f]{64}$/;
const B64_RE = /^[A-Za-z0-9_-]{16,200}$/;
const FREE_TRIES = 5;
const FIRST_WAIT_MS = 60 * 1000;
const MAX_WAIT_MS = 30 * 60 * 1000;
// A device's "last used" time is saved at most this often, not on every request.
const SEEN_SAVE_MS = 10 * 60 * 1000;
// Longer text is never a password Pleni would have taken, so it is not worth hashing.
const LONGEST_TRY = PASSWORD_MAX * 4;
const READ_RETRY = new Set(['EPERM', 'EACCES', 'EBUSY']);

export const SIGNIN_MESSAGES = {
  wrong: 'That password is not right.',
  noPassword: "That is not Pleni's key, and no password is set yet. On the computer that runs Pleni, set one in Settings, then Devices.",
  locked: 'Password sign-in is off after too many wrong tries. On the computer that runs Pleni, turn it back on in Settings, then Devices.',
  busy: 'Pleni is checking another sign-in. Try again in a moment.',
  notText: 'Pleni could not read that password.',
  tooShort: `Use at least ${PASSWORD_MIN} characters.`,
  tooLong: `Use at most ${PASSWORD_MAX} characters.`,
  blank: 'A password cannot be only spaces.',
  saveFailed: 'Pleni could not save the password, so it did not change.',
  removeFailed: 'Pleni could not remove the password file, so the password still works.',
  passwordUnread: 'Pleni could not read its password file, so the password does not work now. Set a password again.',
  devicesUnread: 'Pleni could not read its list of signed-in devices, so each device has to sign in again.',
  devicesUnsaved: 'Pleni could not save its list of signed-in devices. A device that signs in now stays signed in only until Pleni stops.',
  removeUnsaved: 'Pleni signed it out for now, but could not save that. After Pleni restarts, it could sign in again. Try again in a moment.',
};

export function waitMessage(ms) {
  const minutes = Math.max(1, Math.ceil(ms / 60000));
  return `Too many wrong tries. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`;
}

export function passwordFile(settingsPath) {
  return path.join(path.dirname(settingsPath), 'password');
}

export function devicesFile(settingsPath) {
  return path.join(path.dirname(settingsPath), 'devices.json');
}

// Why Pleni would not take this as a new password, or null when it would.
export function passwordProblem(text) {
  if (typeof text !== 'string') return SIGNIN_MESSAGES.notText;
  const length = [...text.normalize('NFKC')].length;
  if (length < PASSWORD_MIN) return SIGNIN_MESSAGES.tooShort;
  if (length > PASSWORD_MAX) return SIGNIN_MESSAGES.tooLong;
  if (!text.trim()) return SIGNIN_MESSAGES.blank;
  return null;
}

// A short name for a device from its browser's User-Agent, such as "iPhone, Safari".
export function deviceName(userAgent) {
  const ua = typeof userAgent === 'string' ? userAgent.slice(0, 512) : '';
  const kind = /iPhone/.test(ua) ? 'iPhone'
    : /iPad/.test(ua) ? 'iPad'
      : /Android/.test(ua) ? (/Mobile/.test(ua) ? 'Android phone' : 'Android tablet')
        : /CrOS/.test(ua) ? 'Chromebook'
          : /Windows/.test(ua) ? 'Windows computer'
            : /Macintosh|Mac OS X/.test(ua) ? 'Mac'
              : /Linux/.test(ua) ? 'Linux computer'
                : 'A device';
  const browser = /EdgA?\/|EdgiOS/.test(ua) ? 'Edge'
    : /OPR\/|OPiOS/.test(ua) ? 'Opera'
      : /SamsungBrowser/.test(ua) ? 'Samsung Internet'
        : /Firefox\/|FxiOS/.test(ua) ? 'Firefox'
          : /Chrome\/|CriOS/.test(ua) ? 'Chrome'
            : /Safari\//.test(ua) ? 'Safari'
              : '';
  return browser ? `${kind}, ${browser}` : kind;
}

function scrypt(text, salt, cost) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(Buffer.from(text.normalize('NFKC'), 'utf8'), salt, HASH_BYTES, { ...cost, maxmem: MAX_MEMORY }, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
}

function passHash(pass) {
  return crypto.createHash('sha256').update(pass).digest('hex');
}

// `file` is Pleni's settings file: the password and the device list sit next to it. Without one
// (tests, the demo) they live in memory only. `cost` is the scrypt cost for new passwords; tests
// make it small. The files are the truth: another Pleni on the same settings folder may change
// them, so each one is read again whenever it changed since this Pleni last read or wrote it.
export function createSignin({ file = null, now = Date.now, cost = COST } = {}) {
  const files = file ? { password: passwordFile(file), devices: devicesFile(file) } : null;
  const state = { password: null, passwordProblem: null, passwordStamp: null, devices: [], devicesProblem: null, devicesStamp: null, busy: false };
  const savedSeen = new Map();

  // A file another program holds for a moment is read again at the next call; until then the last
  // good copy stays. Only a missing or damaged file replaces it.
  function syncPassword() {
    if (!files) return;
    const seen = stamp(files.password);
    if (seen === null || seen === state.passwordStamp) return;
    const found = readJson(files.password);
    if (found.problem && found.problem !== 'damaged') return;
    state.passwordStamp = seen;
    state.password = null;
    state.passwordProblem = null;
    if (found.missing) return;
    const record = found.value === undefined ? null : cleanPassword(found.value);
    if (record) state.password = record;
    else state.passwordProblem = SIGNIN_MESSAGES.passwordUnread;
  }

  function syncDevices() {
    if (!files) return;
    const seen = stamp(files.devices);
    if (seen === null || seen === state.devicesStamp) return;
    const found = readJson(files.devices);
    if (found.problem && found.problem !== 'damaged') return;
    state.devicesStamp = seen;
    state.devices = [];
    state.devicesProblem = null;
    savedSeen.clear();
    if (found.missing) return;
    const list = found.value?.v === 1 && Array.isArray(found.value.devices) ? found.value.devices : null;
    if (!list) {
      state.devicesProblem = SIGNIN_MESSAGES.devicesUnread;
      return;
    }
    const ids = new Set();
    for (const d of list) {
      const device = cleanDevice(d);
      if (!device || ids.has(device.id) || state.devices.length >= MAX_DEVICES) continue;
      ids.add(device.id);
      state.devices.push(device);
      savedSeen.set(device.id, device.seen);
    }
  }

  function savePassword() {
    if (!files) return true;
    try {
      if (state.password) writeJson(files.password, { v: 1, ...state.password });
      else fs.rmSync(files.password, { force: true });
      state.passwordStamp = stamp(files.password);
      state.passwordProblem = null;
      return true;
    } catch {
      return false;
    }
  }

  // True when saved. When not, the change lasts until Pleni stops, and Settings says so.
  function saveDevices() {
    if (!files) return true;
    try {
      writeJson(files.devices, { v: 1, devices: state.devices });
      state.devicesStamp = stamp(files.devices);
      savedSeen.clear();
      for (const d of state.devices) savedSeen.set(d.id, d.seen);
      state.devicesProblem = null;
      return true;
    } catch {
      state.devicesProblem = SIGNIN_MESSAGES.devicesUnsaved;
      return false;
    }
  }

  function passwordInfo() {
    syncPassword();
    const p = state.password;
    return { set: !!p, at: p?.at ?? null, locked: p?.locked === true, problem: state.passwordProblem };
  }

  async function setPassword(text) {
    const problem = passwordProblem(text);
    if (problem) return { ok: false, status: 400, error: problem };
    const salt = crypto.randomBytes(SALT_BYTES);
    const hash = await scrypt(text, salt, cost);
    syncPassword();
    const before = state.password;
    state.password = { ...cost, salt: salt.toString('base64url'), hash: hash.toString('base64url'), at: now(), wrong: 0, locked: false, waitUntil: 0 };
    if (!savePassword()) {
      state.password = before;
      return { ok: false, status: 500, error: SIGNIN_MESSAGES.saveFailed };
    }
    return { ok: true };
  }

  function removePassword() {
    syncPassword();
    const before = state.password;
    state.password = null;
    if (!savePassword()) {
      state.password = before;
      return { ok: false, status: 500, error: SIGNIN_MESSAGES.removeFailed };
    }
    return { ok: true };
  }

  // Turn the password back on after it stopped for too many wrong tries.
  function unlock() {
    syncPassword();
    if (!state.password) return { ok: true };
    state.password = { ...state.password, wrong: 0, locked: false, waitUntil: 0 };
    savePassword();
    return { ok: true };
  }

  // { ok: true } for the right password; otherwise { ok: false, status, error, wait? } with the
  // seconds to wait. Only one check runs at a time, and each wrong try counts. The count and the
  // wait are saved, so a restart changes neither.
  async function checkPassword(text) {
    syncPassword();
    const record = state.password;
    if (!record) return { ok: false, status: 401, error: SIGNIN_MESSAGES.noPassword };
    if (record.locked) return { ok: false, status: 429, error: SIGNIN_MESSAGES.locked };
    let wait = record.waitUntil - now();
    // A wait never lasts longer than the longest one from now, even after the clock goes back.
    if (wait > MAX_WAIT_MS) {
      wait = MAX_WAIT_MS;
      state.password = { ...record, waitUntil: now() + MAX_WAIT_MS };
      savePassword();
    }
    if (wait > 0) return { ok: false, status: 429, error: waitMessage(wait), wait: Math.ceil(wait / 1000) };
    if (state.busy) return { ok: false, status: 429, error: SIGNIN_MESSAGES.busy, wait: 1 };
    state.busy = true;
    let right = false;
    try {
      right = typeof text === 'string' && text.length > 0 && text.length <= LONGEST_TRY && await matches(record, text);
    } finally {
      state.busy = false;
    }
    syncPassword();
    const current = state.password;
    // The password was changed or removed while this one was checked: it says nothing about the new one.
    if (!current || current.hash !== record.hash || current.salt !== record.salt) return { ok: false, status: 401, error: SIGNIN_MESSAGES.wrong };
    if (current.locked) return { ok: false, status: 429, error: SIGNIN_MESSAGES.locked };
    if (right) {
      if (current.wrong || current.waitUntil) {
        state.password = { ...current, wrong: 0, waitUntil: 0 };
        savePassword();
      }
      return { ok: true };
    }
    const wrong = current.wrong + 1;
    const pause = wrong >= FREE_TRIES && wrong < LOCK_AFTER ? Math.min(FIRST_WAIT_MS * 2 ** (wrong - FREE_TRIES), MAX_WAIT_MS) : 0;
    state.password = { ...current, wrong, locked: wrong >= LOCK_AFTER, waitUntil: pause ? now() + pause : 0 };
    savePassword();
    if (wrong >= LOCK_AFTER) return { ok: false, status: 429, error: SIGNIN_MESSAGES.locked };
    if (!pause) return { ok: false, status: 401, error: SIGNIN_MESSAGES.wrong };
    return { ok: false, status: 429, error: `${SIGNIN_MESSAGES.wrong} ${waitMessage(pause)}`, wait: Math.ceil(pause / 1000) };
  }

  async function matches(record, text) {
    const hash = await scrypt(text, Buffer.from(record.salt, 'base64url'), { N: record.N, r: record.r, p: record.p });
    const kept = Buffer.from(record.hash, 'base64url');
    return kept.length === hash.length && crypto.timingSafeEqual(kept, hash);
  }

  // A new device: { pass, device }. The pass goes into that browser's cookie and is never kept.
  function addDevice({ name, via }) {
    syncDevices();
    const pass = `d.${crypto.randomBytes(32).toString('base64url')}`;
    const at = now();
    const device = { id: crypto.randomBytes(9).toString('base64url'), hash: passHash(pass), name: cleanName(name), via: via === 'key' ? 'key' : 'password', at, seen: at };
    state.devices.push(device);
    // The one not used for the longest makes room.
    while (state.devices.length > MAX_DEVICES) {
      const oldest = state.devices.reduce((a, b) => (b.seen < a.seen ? b : a));
      state.devices = state.devices.filter((d) => d !== oldest);
    }
    saveDevices();
    return { pass, device: publicDevice(device) };
  }

  // The device whose pass this is, or null. Its "last used" time moves on.
  function findDevice(pass) {
    if (typeof pass !== 'string' || !PASS_RE.test(pass)) return null;
    syncDevices();
    const hash = passHash(pass);
    const device = state.devices.find((d) => d.hash === hash);
    if (!device) return null;
    device.seen = now();
    if (device.seen - (savedSeen.get(device.id) ?? 0) >= SEEN_SAVE_MS) saveDevices();
    return publicDevice(device);
  }

  // { removed, saved }: how many devices were signed out, and whether that was saved. One that
  // was not saved is signed out only until Pleni stops.
  function removeDevice(id) {
    syncDevices();
    const before = state.devices.length;
    state.devices = state.devices.filter((d) => d.id !== id);
    const removed = before - state.devices.length;
    return { removed, saved: removed ? saveDevices() : true };
  }

  function removeAllDevices() {
    syncDevices();
    const removed = state.devices.length;
    state.devices = [];
    return { removed, saved: saveDevices() };
  }

  function devices() {
    syncDevices();
    return state.devices.map(publicDevice).sort((a, b) => b.seen - a.seen);
  }

  function devicesProblem() {
    syncDevices();
    return state.devicesProblem;
  }

  return {
    passwordInfo,
    setPassword,
    removePassword,
    unlock,
    checkPassword,
    addDevice,
    findDevice,
    removeDevice,
    removeAllDevices,
    devices,
    devicesProblem,
  };
}

// What a file looks like now: a new value after every write (a write renames a new file into place).
// 'none' when there is no file; null when Pleni cannot tell, so it keeps what it has.
function stamp(file) {
  try {
    const st = fs.statSync(file);
    return `${st.ino}:${st.size}:${st.mtimeMs}`;
  } catch (err) {
    return err?.code === 'ENOENT' || err?.code === 'ENOTDIR' ? 'none' : null;
  }
}

function publicDevice({ id, name, via, at, seen }) {
  return { id, name, via, at, seen };
}

function cleanName(name) {
  const text = typeof name === 'string' ? name.replace(/[\p{Cc}\p{Cf}]/gu, ' ').trim() : '';
  return [...(text || 'A device')].slice(0, 60).join('');
}

function cleanPassword(raw) {
  if (raw?.v !== 1) return null;
  const { N, r, p, salt, hash, at, wrong, locked, waitUntil } = raw;
  const power = Number.isInteger(N) && N >= 2 ** 10 && N <= 2 ** 20 && (N & (N - 1)) === 0;
  if (!power || !Number.isInteger(r) || r < 1 || r > 32 || !Number.isInteger(p) || p < 1 || p > 16) return null;
  if (typeof salt !== 'string' || !B64_RE.test(salt) || typeof hash !== 'string' || !B64_RE.test(hash)) return null;
  return {
    N,
    r,
    p,
    salt,
    hash,
    at: Number.isFinite(at) ? at : null,
    wrong: Number.isInteger(wrong) && wrong > 0 ? wrong : 0,
    locked: locked === true,
    waitUntil: Number.isFinite(waitUntil) && waitUntil > 0 ? waitUntil : 0,
  };
}

function cleanDevice(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const { id, hash, name, via, at, seen } = raw;
  if (typeof id !== 'string' || !ID_RE.test(id) || typeof hash !== 'string' || !HASH_RE.test(hash)) return null;
  const when = Number.isFinite(at) ? at : 0;
  return { id, hash, name: cleanName(name), via: via === 'key' ? 'key' : 'password', at: when, seen: Number.isFinite(seen) ? seen : when };
}

// { value } | { missing: true } | { problem: 'damaged' | <error code> }. A Windows virus scanner can
// hold a file for a moment, so a read that fails that way is tried a few more times.
function readJson(file) {
  for (let attempt = 1; ; attempt++) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (err) {
      if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') return { missing: true };
      if (attempt < 5 && READ_RETRY.has(err?.code)) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100 * attempt);
        continue;
      }
      return { problem: err?.code || 'unknown' };
    }
    try {
      return { value: JSON.parse(text.replace(/^﻿/, '')) };
    } catch {
      return { problem: 'damaged' };
    }
  }
}

// Written through a temp file, so a crash never leaves half a file, and readable only by this account.
function writeJson(file, value) {
  const temp = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    renameWithRetry(temp, file);
  } catch (err) {
    try {
      fs.rmSync(temp, { force: true });
    } catch {
      // Nothing more to clean up.
    }
    throw err;
  }
}
