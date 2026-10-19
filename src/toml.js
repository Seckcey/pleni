// A small TOML reader and line editor for the Models page (src/models.js). It finds each statement
// in a file (a table header, or a key = value line) without parsing all of TOML, reads plain text
// values, and changes, adds or removes one text value while keeping every other byte as it was.
// It gives up (ok: false) on anything it does not understand, so Pleni never writes a file it could
// not read back.
import { stripBom } from './jsonl.js';

const BARE_KEY = /^[A-Za-z0-9_-]+$/;
const KEY_CHAR = /[A-Za-z0-9_-]/;
const SCALAR_END = /[\s#,\]}]/;
const ESCAPES = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', e: '\x1b', '"': '"', '\\': '\\' };
const HEX = { u: 4, U: 8, x: 2 };

// { ok: true, items } or { ok: false, at }. Each item is a statement:
// { kind: 'table' | 'array' | 'value', path, start, end, next } where `path` is the full key path,
// `start` is where its line starts, `end` where the statement ends (before the line break) and `next`
// where the next line starts. A value item also has `key` (the key as written, without its table)
// and `value`: { kind: 'text' | 'inline' | 'other', text, start, end }. `text` is set for a
// one-line string, the only kind of value Pleni changes.
export function scanToml(source) {
  const s = String(source);
  const items = [];
  let table = [];
  let i = s.charCodeAt(0) === 0xfeff ? 1 : 0;
  while (i < s.length) {
    const start = i;
    let j = skipComment(s, skipSpace(s, i));
    if (isLineEnd(s, j)) {
      i = nextLine(s, j);
      continue;
    }
    if (s[j] === '[') {
      const double = s[j + 1] === '[';
      const key = readKey(s, skipSpace(s, j + (double ? 2 : 1)));
      if (!key) return { ok: false, at: j };
      j = skipSpace(s, key.end);
      if (s[j] !== ']' || (double && s[j + 1] !== ']')) return { ok: false, at: j };
      j = skipComment(s, skipSpace(s, j + (double ? 2 : 1)));
      if (!isLineEnd(s, j)) return { ok: false, at: j };
      table = key.path;
      items.push({ kind: double ? 'array' : 'table', path: key.path, start, end: j, next: nextLine(s, j) });
      i = nextLine(s, j);
      continue;
    }
    const key = readKey(s, j);
    if (!key) return { ok: false, at: j };
    j = skipSpace(s, key.end);
    if (s[j] !== '=') return { ok: false, at: j };
    const value = readValue(s, skipSpace(s, j + 1));
    if (!value) return { ok: false, at: j };
    const end = skipComment(s, skipSpace(s, value.end));
    if (!isLineEnd(s, end)) return { ok: false, at: end };
    items.push({ kind: 'value', path: [...table, ...key.path], key: key.path, start, end, next: nextLine(s, end), value });
    i = nextLine(s, end);
  }
  return { ok: true, items };
}

// What the file says at `path`: { found, text, editable }. `text` is null unless the value is a
// one-line string. Not editable when the key is there twice, its value is not a one-line string, or
// it sits inside a value Pleni does not change (an inline table, an array of tables).
export function tomlText(items, path) {
  const found = items.filter((it) => it.kind === 'value' && samePath(it.path, path));
  if (blocked(items, path) || found.length > 1) return { found: found.length > 0, text: null, editable: false };
  if (!found.length) return { found: false, text: null, editable: true };
  const { value } = found[0];
  return { found: true, text: value.kind === 'text' ? value.text : null, editable: value.kind === 'text' };
}

// Sets `path` to the text `value`: { ok: true, text } with the new file, or { ok: false, error }.
// A path is a top-level key (['model']) or a key in a table one level down
// (['agents', 'default_subagent_model']). Only the value changes on a line that is there already; a
// new line goes after the table's header, or after the top-level values, or in a new table at the end.
export function setTomlText(source, path, value) {
  const s = String(source);
  if (!validPath(path) || typeof value !== 'string' || /[\p{Cc}]/u.test(value)) return { ok: false, error: 'bad' };
  const scan = scanToml(s);
  if (!scan.ok) return { ok: false, error: 'unreadable' };
  const { items } = scan;
  const now = tomlText(items, path);
  if (!now.editable) return { ok: false, error: 'not-simple' };
  const quoted = tomlString(value);
  const found = items.find((it) => it.kind === 'value' && samePath(it.path, path));
  if (found) return { ok: true, text: s.slice(0, found.value.start) + quoted + s.slice(found.value.end) };
  const eol = lineBreak(s);
  if (path.length === 1) return { ok: true, text: insertLine(s, afterTopValues(s, items), `${keyText(path)} = ${quoted}`, eol) };
  const header = items.find((it) => it.kind === 'table' && samePath(it.path, path.slice(0, 1)));
  if (header) return { ok: true, text: insertLine(s, header.next, `${keyText(path.slice(1))} = ${quoted}`, eol) };
  // A table made by dotted keys at the top ("agents.max_threads = 4") cannot get a header later.
  if (items.some((it) => it.kind === 'value' && it.path.length === it.key.length && it.key.length > 1 && it.key[0] === path[0])) {
    return { ok: true, text: insertLine(s, afterTopValues(s, items), `${keyText(path)} = ${quoted}`, eol) };
  }
  const body = s.length && !s.endsWith('\n') ? s + eol : s;
  const gap = stripBom(body).trim() ? eol : '';
  return { ok: true, text: `${body}${gap}[${keyText(path.slice(0, 1))}]${eol}${keyText(path.slice(1))} = ${quoted}${eol}` };
}

// Removes the line that sets `path`: { ok: true, text } (the same text when it is not there), or
// { ok: false, error } when Pleni cannot tell which line it is.
export function removeTomlKey(source, path) {
  const s = String(source);
  if (!validPath(path)) return { ok: false, error: 'bad' };
  const scan = scanToml(s);
  if (!scan.ok) return { ok: false, error: 'unreadable' };
  const now = tomlText(scan.items, path);
  if (!now.found) return { ok: true, text: s };
  if (!now.editable) return { ok: false, error: 'not-simple' };
  const found = scan.items.find((it) => it.kind === 'value' && samePath(it.path, path));
  return { ok: true, text: s.slice(0, found.start) + s.slice(found.next) };
}

// A TOML basic string. The values Pleni writes are checked first, so this only needs \ and ".
export function tomlString(value) {
  return `"${String(value).replace(/[\\"]/g, '\\$&')}"`;
}

// ---- reading ----

function readKey(s, i) {
  const path = [];
  let at = i;
  for (;;) {
    const part = readSimpleKey(s, at);
    if (!part) return null;
    path.push(part.text);
    const dot = skipSpace(s, part.end);
    if (s[dot] !== '.') return { path, end: part.end };
    at = skipSpace(s, dot + 1);
  }
}

function readSimpleKey(s, i) {
  if (s[i] === '"') return readBasic(s, i);
  if (s[i] === "'") return readLiteral(s, i);
  let j = i;
  while (j < s.length && KEY_CHAR.test(s[j])) j++;
  return j > i ? { text: s.slice(i, j), end: j } : null;
}

function readValue(s, i) {
  if (s.startsWith('"""', i) || s.startsWith("'''", i)) return readMultiline(s, i);
  if (s[i] === '"' || s[i] === "'") {
    const str = s[i] === '"' ? readBasic(s, i) : readLiteral(s, i);
    return str && { kind: 'text', text: str.text, start: i, end: str.end };
  }
  if (s[i] === '[' || s[i] === '{') return readNested(s, i);
  return readScalar(s, i);
}

// "..." on one line, with its escapes worked out.
function readBasic(s, i) {
  let text = '';
  for (let j = i + 1; j < s.length; j++) {
    const c = s[j];
    if (c === '"') return { text, end: j + 1 };
    if (c === '\n' || c === '\r') return null;
    if (c !== '\\') {
      text += c;
      continue;
    }
    const e = s[j + 1];
    if (Object.hasOwn(ESCAPES, e)) {
      text += ESCAPES[e];
      j++;
      continue;
    }
    const size = Object.hasOwn(HEX, e) ? HEX[e] : 0;
    const digits = s.slice(j + 2, j + 2 + size);
    if (!size || digits.length !== size || !/^[0-9A-Fa-f]+$/.test(digits)) return null;
    const code = Number.parseInt(digits, 16);
    if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return null;
    text += String.fromCodePoint(code);
    j += 1 + size;
  }
  return null;
}

// '...' on one line: no escapes.
function readLiteral(s, i) {
  for (let j = i + 1; j < s.length; j++) {
    if (s[j] === "'") return { text: s.slice(i + 1, j), end: j + 1 };
    if (s[j] === '\n' || s[j] === '\r') return null;
  }
  return null;
}

// """...""" or '''...''', which may hold line breaks. One or two quotes right before the closing
// three still belong to the text.
function readMultiline(s, i) {
  const q = s[i];
  const three = q.repeat(3);
  for (let j = i + 3; j < s.length; j++) {
    if (q === '"' && s[j] === '\\') {
      j++;
      continue;
    }
    if (!s.startsWith(three, j)) continue;
    let end = j + 3;
    for (let extra = 0; extra < 2 && s[end] === q; extra++) end++;
    return { kind: 'other', text: null, start: i, end };
  }
  return null;
}

// An array or an inline table, which may run over several lines and hold strings and comments.
function readNested(s, i) {
  const open = [];
  for (let j = i; j < s.length; ) {
    const c = s[j];
    if (c === '[' || c === '{') {
      open.push(c === '[' ? ']' : '}');
      j++;
    } else if (c === ']' || c === '}') {
      if (open.pop() !== c) return null;
      j++;
      if (!open.length) return { kind: s[i] === '{' ? 'inline' : 'other', text: null, start: i, end: j };
    } else if (c === '#') {
      j = lineEndAt(s, j);
    } else if (c === '"' || c === "'") {
      const str = s.startsWith(c.repeat(3), j) ? readMultiline(s, j) : c === '"' ? readBasic(s, j) : readLiteral(s, j);
      if (!str) return null;
      j = str.end;
    } else {
      j++;
    }
  }
  return null;
}

// A number, true or false, or a date. A date and a time may be split by one space.
function readScalar(s, i) {
  let j = i;
  while (j < s.length && !SCALAR_END.test(s[j])) j++;
  if (j === i) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s.slice(i, j)) && s[j] === ' ' && /\d/.test(s[j + 1] ?? '')) {
    j++;
    while (j < s.length && !SCALAR_END.test(s[j])) j++;
  }
  return { kind: 'other', text: null, start: i, end: j };
}

// ---- helpers ----

function skipSpace(s, i) {
  let j = i;
  while (s[j] === ' ' || s[j] === '\t') j++;
  return j;
}

function skipComment(s, i) {
  return s[i] === '#' ? lineEndAt(s, i) : i;
}

// Where the line break after `i` starts (its \r for \r\n), or the end of the text.
function lineEndAt(s, i) {
  const n = s.indexOf('\n', i);
  const at = n === -1 ? s.length : n;
  return at > i && s[at - 1] === '\r' ? at - 1 : at;
}

function isLineEnd(s, i) {
  return i >= s.length || s[i] === '\n' || (s[i] === '\r' && s[i + 1] === '\n');
}

function nextLine(s, i) {
  if (i >= s.length) return s.length;
  return s[i] === '\r' ? i + 2 : i + 1;
}

function samePath(a, b) {
  return a.length === b.length && a.every((part, i) => part === b[i]);
}

function startsWith(path, prefix) {
  return prefix.length <= path.length && prefix.every((part, i) => part === path[i]);
}

// A value or an array of tables at a shorter path holds `path` inside it, and a longer path below
// `path` makes it a table: either way Pleni leaves it alone.
function blocked(items, path) {
  return items.some((it) => {
    if (it.kind === 'value') return (it.path.length < path.length && startsWith(path, it.path)) || (it.path.length > path.length && startsWith(it.path, path));
    if (it.kind === 'array') return startsWith(path, it.path) || startsWith(it.path, path);
    return startsWith(it.path, path);
  });
}

function validPath(path) {
  return Array.isArray(path) && path.length >= 1 && path.length <= 2 && path.every((p) => typeof p === 'string' && BARE_KEY.test(p));
}

function keyText(parts) {
  return parts.join('.');
}

function lineBreak(s) {
  const n = s.indexOf('\n');
  return n > 0 && s[n - 1] === '\r' ? '\r\n' : '\n';
}

// Where a new top-level line goes: after the last top-level value, else at the very start.
function afterTopValues(s, items) {
  const firstTable = items.findIndex((it) => it.kind !== 'value');
  const top = (firstTable === -1 ? items : items.slice(0, firstTable)).filter((it) => it.kind === 'value');
  if (top.length) return top[top.length - 1].next;
  return s.charCodeAt(0) === 0xfeff ? 1 : 0;
}

function insertLine(s, at, line, eol) {
  const before = s.slice(0, at);
  const needsBreak = before.length > 0 && stripBom(before) !== '' && !before.endsWith('\n');
  return `${before}${needsBreak ? eol : ''}${line}${eol}${s.slice(at)}`;
}
