// A small reader and line editor for the settings block ("front matter") at the top of a Claude Code
// agent file, for the Models page (src/models.js):
//
//   ---
//   name: coder
//   description: Coding and design work.
//   model: opus
//   ---
//
// It reads `key: value` lines and changes, adds or removes one simple value while keeping every
// other byte. It gives up on anything it does not understand, so Pleni never writes a file it could
// not read back.
import { stripBom } from './jsonl.js';

const KEY_LINE = /^([A-Za-z_][A-Za-z0-9_-]*)[ \t]*:(.*)$/;
const PLAIN = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/;
const KEY = /^[A-Za-z_][A-Za-z0-9_-]*$/;

// { ok: true, items, end } or { ok: false }. Each item is a top-level `key: value` line:
// { key, start, next, valueStart, valueEnd, text, simple }, where `start` is where its line starts,
// `next` where the next line starts, and `text` the value when it is a one-line plain or quoted
// string (else null; `simple` is false then). `end` is where the closing --- line starts.
export function scanFrontmatter(source) {
  const s = String(source);
  const at = s.charCodeAt(0) === 0xfeff ? 1 : 0;
  const first = lineAt(s, at);
  if (first.text !== '---') return { ok: false };
  const items = [];
  for (let i = first.next; i < s.length; ) {
    const line = lineAt(s, i);
    if (line.text === '---') return { ok: true, items, end: i };
    const t = line.text;
    if (t.trim() === '' || t.trimStart().startsWith('#')) {
      i = line.next;
      continue;
    }
    // An indented line or a list item belongs to the key above it, which is then not simple.
    if (/^[ \t-]/.test(t)) {
      if (!items.length) return { ok: false };
      Object.assign(items[items.length - 1], { simple: false, text: null });
      i = line.next;
      continue;
    }
    const m = KEY_LINE.exec(t);
    if (!m) return { ok: false };
    const raw = m[2];
    const lead = raw.length - raw.trimStart().length;
    const valueStart = i + t.length - raw.length + lead;
    const value = readValue(raw.trimStart());
    items.push({
      key: m[1],
      start: i,
      next: line.next,
      valueStart,
      valueEnd: valueStart + (value ? value.length : 0),
      text: value ? value.text : null,
      simple: !!value,
    });
    i = line.next;
  }
  return { ok: false };
}

// What the block says for `key`: { found, text, editable }. Not editable when the key is there
// twice or its value is not a one-line string.
export function frontmatterText(items, key) {
  const found = items.filter((it) => it.key === key);
  if (found.length > 1) return { found: true, text: null, editable: false };
  if (!found.length) return { found: false, text: null, editable: true };
  return { found: true, text: found[0].text, editable: found[0].simple };
}

// Sets `key` to `value`: { ok: true, text } or { ok: false, error }. Only the value changes on a line
// that is there already (a comment after it stays); a new line goes just before the closing ---.
export function setFrontmatterValue(source, key, value) {
  const s = String(source);
  if (!KEY.test(key) || typeof value !== 'string' || !value || /\p{Cc}/u.test(value)) return { ok: false, error: 'bad' };
  const scan = scanFrontmatter(s);
  if (!scan.ok) return { ok: false, error: 'unreadable' };
  const now = frontmatterText(scan.items, key);
  if (!now.editable) return { ok: false, error: 'not-simple' };
  const written = yamlValue(value);
  const found = scan.items.find((it) => it.key === key);
  if (found) return { ok: true, text: s.slice(0, found.valueStart) + written + s.slice(found.valueEnd) };
  return { ok: true, text: `${s.slice(0, scan.end)}${key}: ${written}${lineBreak(s)}${s.slice(scan.end)}` };
}

// Takes out the line that sets `key`: { ok: true, text } (the same text when it is not there).
export function removeFrontmatterKey(source, key) {
  const s = String(source);
  if (!KEY.test(key)) return { ok: false, error: 'bad' };
  const scan = scanFrontmatter(s);
  if (!scan.ok) return { ok: false, error: 'unreadable' };
  const now = frontmatterText(scan.items, key);
  if (!now.found) return { ok: true, text: s };
  if (!now.editable) return { ok: false, error: 'not-simple' };
  const found = scan.items.find((it) => it.key === key);
  return { ok: true, text: s.slice(0, found.start) + s.slice(found.next) };
}

// A value as Pleni writes it: plain when it is a simple word, else in double quotes.
export function yamlValue(value) {
  const v = String(value);
  return PLAIN.test(v) && !/^(true|false|yes|no|on|off|null|~)$/i.test(v) ? v : `"${v.replace(/[\\"]/g, '\\$&')}"`;
}

// A one-line value: plain, or in single or double quotes, with an optional # comment after it.
// { text, length } with `length` the characters the value itself takes, or null.
function readValue(raw) {
  if (!raw || raw.startsWith('#')) return null;
  const c = raw[0];
  if (c === '"' || c === "'") {
    let text = '';
    for (let j = 1; j < raw.length; j++) {
      const ch = raw[j];
      if (c === "'" && ch === "'" && raw[j + 1] === "'") {
        text += "'";
        j++;
      } else if (ch === c) {
        return afterValue(raw, j + 1) ? { text, length: j + 1 } : null;
      } else if (c === '"' && ch === '\\') {
        const e = raw[j + 1];
        if (e !== '"' && e !== '\\') return null;
        text += e;
        j++;
      } else {
        text += ch;
      }
    }
    return null;
  }
  // Block values (| and >), lists and maps written on one line, and anchors are not simple.
  if (/^[|>[{&*!%@`]/.test(raw)) return null;
  const hash = raw.search(/\s#/);
  const text = (hash === -1 ? raw : raw.slice(0, hash)).trimEnd();
  return text ? { text, length: text.length } : null;
}

function afterValue(raw, i) {
  const rest = raw.slice(i);
  return rest.trim() === '' || /^\s+#/.test(rest);
}

// The line that starts at `i`, without its line break, and where the next one starts.
function lineAt(s, i) {
  const n = s.indexOf('\n', i);
  const end = n === -1 ? s.length : n;
  const text = s.slice(i, end > i && s[end - 1] === '\r' ? end - 1 : end);
  return { text, next: n === -1 ? s.length : n + 1 };
}

function lineBreak(s) {
  const n = stripBom(s).indexOf('\n');
  return n > 0 && stripBom(s)[n - 1] === '\r' ? '\r\n' : '\n';
}
