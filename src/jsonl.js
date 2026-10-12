// Safe, incremental reading of JSON Lines files that other programs are still writing.
// Lines are split on the 0x0A byte only, so U+2028 and U+2029 inside JSON strings are safe,
// and a line is never parsed before its newline has arrived.
import fs from 'node:fs';

const MiB = 1024 * 1024;
const CHUNK_BYTES = MiB;
const NEWLINE = 0x0a;
const CARRIAGE_RETURN = 0x0d;
const BLANK = Symbol('blank');

export class JsonlTail {
  constructor(file, { maxInitialBytes = 4 * MiB, maxLineBytes = 8 * MiB } = {}) {
    this.file = file;
    this.maxInitialBytes = maxInitialBytes;
    this.maxLineBytes = maxLineBytes;
    this.badLines = 0;
    this._pos = 0;          // next byte to read from the file
    this._id = null;        // identity of the file being read; null = start fresh
    this._carry = [];       // bytes of a line whose newline has not arrived yet
    this._carryBytes = 0;
    this._skipping = false; // dropping the rest of a line (partial first line or too long)
  }

  get offset() {
    return this._pos - this._carryBytes;
  }

  read() {
    let fd;
    try {
      fd = fs.openSync(this.file, 'r');
    } catch (err) {
      if (err.code === 'ENOENT') return { records: [], reset: false, size: 0 };
      throw err;
    }
    try {
      return this._readFrom(fd);
    } finally {
      fs.closeSync(fd);
    }
  }

  _readFrom(fd) {
    const st = fs.fstatSync(fd);
    let reset = false;
    if (this._id && (st.size < this._pos || isReplaced(this._id, st))) {
      reset = true;
      this._id = null;
    }
    if (!this._id) this._start(fd, st.size);
    this._id = { ino: st.ino, birthtimeMs: st.birthtimeMs };

    const records = [];
    while (this._pos < st.size) {
      const chunk = readBytes(fd, this._pos, Math.min(CHUNK_BYTES, st.size - this._pos));
      if (chunk.length === 0) break;
      this._pos += chunk.length;
      this._take(chunk, records);
    }
    return { records, reset, size: st.size };
  }

  _start(fd, size) {
    this._pos = 0;
    this._carry = [];
    this._carryBytes = 0;
    this._skipping = false;
    if (size > this.maxInitialBytes) {
      this._pos = size - this.maxInitialBytes;
      // We landed inside a line unless the byte before us is a newline.
      this._skipping = readBytes(fd, this._pos - 1, 1)[0] !== NEWLINE;
    }
  }

  _take(chunk, records) {
    let start = 0;
    let nl;
    while ((nl = chunk.indexOf(NEWLINE, start)) !== -1) {
      const part = chunk.subarray(start, nl);
      start = nl + 1;
      if (this._skipping) {
        this._skipping = false;
        continue;
      }
      this._finishLine(part, records);
    }
    this._hold(chunk.subarray(start));
  }

  _finishLine(part, records) {
    const size = this._carryBytes + part.length;
    const line = this._carryBytes ? Buffer.concat([...this._carry, part], size) : part;
    this._carry = [];
    this._carryBytes = 0;
    if (size > this.maxLineBytes) {
      this.badLines++;
      return;
    }
    const value = parseLine(line);
    if (value === BLANK) return;
    if (value === null) this.badLines++;
    else records.push(value);
  }

  _hold(rest) {
    if (this._skipping || rest.length === 0) return;
    if (this._carryBytes + rest.length > this.maxLineBytes) {
      this.badLines++;
      this._carry = [];
      this._carryBytes = 0;
      this._skipping = true;
      return;
    }
    this._carry.push(Buffer.from(rest)); // copy, so the whole chunk is not kept alive
    this._carryBytes += rest.length;
  }
}

export function readHeadLine(file, maxBytes = 8 * MiB) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return null;
  }
  try {
    const pieces = [];
    let pos = 0;
    // Read one byte past maxBytes so a line of exactly maxBytes still finds its newline.
    while (pos <= maxBytes) {
      const chunk = readBytes(fd, pos, Math.min(CHUNK_BYTES, maxBytes + 1 - pos));
      if (chunk.length === 0) return null;
      const nl = chunk.indexOf(NEWLINE);
      if (nl !== -1) {
        pieces.push(chunk.subarray(0, nl));
        const value = parseLine(Buffer.concat(pieces));
        return isRecord(value) ? value : null;
      }
      pieces.push(chunk);
      pos += chunk.length;
    }
    return null;
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

export function scanHead(file, maxBytes = 2 * MiB, predicate = null) {
  const found = [];
  let fd;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return found;
  }
  try {
    const size = fs.fstatSync(fd).size;
    const data = readBytes(fd, 0, Math.min(size, maxBytes));
    let start = 0;
    let nl;
    while ((nl = data.indexOf(NEWLINE, start)) !== -1) {
      const value = parseLine(data.subarray(start, nl));
      start = nl + 1;
      if (isRecord(value) && (!predicate || predicate(value))) found.push(value);
    }
  } catch {
    // Return what was found before the error.
  } finally {
    fs.closeSync(fd);
  }
  return found;
}

export function stripBom(text) {
  return typeof text === 'string' && text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export function readJsonFile(file, maxBytes = 16 * MiB) {
  try {
    if (fs.statSync(file).size > maxBytes) return null;
    const value = JSON.parse(stripBom(fs.readFileSync(file, 'utf8')));
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

// Returns the parsed object, null for a bad line, or BLANK for an empty line.
function parseLine(buf) {
  let end = buf.length;
  if (end > 0 && buf[end - 1] === CARRIAGE_RETURN) end--;
  const text = stripBom(buf.toString('utf8', 0, end));
  if (!/\S/.test(text)) return BLANK;
  try {
    const value = JSON.parse(text);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Some Linux systems report ctime as birthtime; a birthtime equal to ctime is ignored
// so that ordinary appends are not mistaken for a new file.
function isReplaced(prev, st) {
  if (st.ino !== prev.ino) return true;
  return st.birthtimeMs !== prev.birthtimeMs && st.birthtimeMs !== st.ctimeMs;
}

function readBytes(fd, position, length) {
  const buf = Buffer.allocUnsafe(length);
  let got = 0;
  while (got < length) {
    const n = fs.readSync(fd, buf, got, length - got, position + got);
    if (n <= 0) break;
    got += n;
  }
  return got === length ? buf : buf.subarray(0, got);
}
