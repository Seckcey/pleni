// Repository checks: every script parses, the relay's PowerShell scripts are plain ASCII and define
// each function once, and no text file holds a personal Windows folder path or a real e-mail address.
// Usage: node scripts/check.js [folder]
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(process.argv[2] ?? fileURLToPath(new URL('..', import.meta.url)));
const CODE_DIRS = ['bin', 'src', 'public', 'scripts', 'test', 'relay'];
const CODE_EXTENSIONS = new Set(['.js', '.mjs']);
// Windows PowerShell 5.1 reads a script without a byte order mark as the local code page, so any
// letter outside ASCII in a relay script would change meaning on some computers.
const ASCII_DIR = 'relay';
const ASCII_EXTENSIONS = new Set(['.ps1']);
const SKIP_DIRS = new Set(['.git', 'node_modules']);
const MAX_SCAN_BYTES = 5 * 1024 * 1024;

// C:\Users\<name>, also written with doubled backslashes or forward slashes.
const WINDOWS_PROFILE = /\b[a-z]:(?:\\+|\/+)users(?:\\+|\/+)([^\\/\s'"`<>|:*?,;()[\]]+)/gi;
// Folder names that are examples or system folders, not a person.
const EXAMPLE_USERS = new Set(['ada', 'you', 'me', 'user', 'username', 'name', 'example', 'public', 'default', 'all']);
const PLACEHOLDER = /^[$%{]/;

// Each part has a size limit, as real addresses do, so a long run of letters cannot make the
// search take minutes.
const EMAIL = /[a-z0-9._%+-]{1,64}@[a-z0-9-]{1,63}(?:\.[a-z0-9-]{1,63}){0,10}\.[a-z]{2,63}\b/gi;
const EXAMPLE_DOMAINS = ['example.com', 'example.org', 'example.net'];
const RESERVED_ENDINGS = ['.example', '.test', '.invalid', '.localhost'];
const ALLOWED_ADDRESSES = new Set(['noreply@github.com', 'git@github.com']);
// "logo@2x.png" is a file name, not an address.
const FILE_ENDINGS = /\.(png|jpe?g|gif|svg|webp|ico|js|mjs|css|json|html?)$/i;

const problems = [];
const parsed = checkSyntax();
checkAscii();
checkFunctionNames();
const scanned = scanFiles();

if (problems.length) {
  process.stdout.write(`Found ${problems.length} problem(s):\n`);
  for (const problem of problems) process.stdout.write(`  ${problem}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`All clear: ${parsed} script(s) parsed, ${scanned} text file(s) scanned.\n`);
}

function checkSyntax() {
  let count = 0;
  for (const dir of CODE_DIRS) {
    for (const file of walk(path.join(ROOT, dir))) {
      if (!CODE_EXTENSIONS.has(path.extname(file))) continue;
      count++;
      const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
      if (result.status !== 0) problems.push(`${relative(file)}: does not parse (run node --check on it to see why)`);
    }
  }
  return count;
}

function checkAscii() {
  for (const file of walk(path.join(ROOT, ASCII_DIR))) {
    if (!ASCII_EXTENSIONS.has(path.extname(file))) continue;
    const bytes = fs.readFileSync(file);
    const at = bytes.findIndex((byte) => byte > 0x7f);
    if (at !== -1) {
      const line = bytes.subarray(0, at).toString('latin1').split('\n').length;
      problems.push(`${relative(file)}:${line}: a character that is not plain ASCII`);
    }
  }
}

// PowerShell keeps the last definition of a function name (in any letter case), so a second
// function with an old name silently replaces the first one for every caller.
function checkFunctionNames() {
  for (const file of walk(path.join(ROOT, ASCII_DIR))) {
    if (!ASCII_EXTENSIONS.has(path.extname(file))) continue;
    const first = new Map();
    fs.readFileSync(file, 'latin1').split('\n').forEach((text, index) => {
      const m = /^\s*function\s+([A-Za-z][\w-]*)/i.exec(text);
      if (!m) return;
      const name = m[1].toLowerCase();
      if (first.has(name)) {
        problems.push(`${relative(file)}:${index + 1}: function ${m[1]} is defined again (first at line ${first.get(name)}); the later one replaces it`);
      } else {
        first.set(name, index + 1);
      }
    });
  }
}

// Prints only where a match is, never the match itself, so the check does not leak it either.
function scanFiles() {
  let count = 0;
  for (const name of listFiles()) {
    const text = readText(path.join(ROOT, name));
    if (text === null) continue;
    count++;
    let lineOf = lineCounter(text);
    for (const match of text.matchAll(WINDOWS_PROFILE)) {
      if (isExampleUser(match[1])) continue;
      problems.push(`${toSlash(name)}:${lineOf(match.index)}: a personal Windows folder path`);
    }
    lineOf = lineCounter(text);
    for (const match of text.matchAll(EMAIL)) {
      if (isExampleAddress(match[0])) continue;
      problems.push(`${toSlash(name)}:${lineOf(match.index)}: an e-mail address that is not an example`);
    }
  }
  return count;
}

function isExampleUser(name) {
  return PLACEHOLDER.test(name) || EXAMPLE_USERS.has(name.toLowerCase());
}

function isExampleAddress(address) {
  const lower = address.toLowerCase();
  const domain = lower.slice(lower.lastIndexOf('@') + 1);
  if (ALLOWED_ADDRESSES.has(lower) || FILE_ENDINGS.test(domain)) return true;
  if (EXAMPLE_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`))) return true;
  return RESERVED_ENDINGS.some((ending) => domain.endsWith(ending));
}

// Files git knows about (tracked or new but not ignored); every file when git is not available.
function listFiles() {
  const git = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: ROOT,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (git.status === 0) return git.stdout.split('\0').filter(Boolean);
  return walk(ROOT).map((file) => path.relative(ROOT, file));
}

// Text only: binary files (a zero byte near the start), big files and missing files are skipped.
function readText(file) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MAX_SCAN_BYTES) return null;
    const bytes = fs.readFileSync(file);
    if (bytes.subarray(0, 8000).includes(0)) return null;
    return bytes.toString('utf8');
  } catch {
    return null;
  }
}

function walk(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && !SKIP_DIRS.has(entry.name)) files.push(...walk(full));
    else if (entry.isFile()) files.push(full);
  }
  return files;
}

// Line numbers for offsets that only grow, so a file with many matches is read through once.
function lineCounter(text) {
  let line = 1;
  let from = 0;
  return (index) => {
    for (let i = text.indexOf('\n', from); i !== -1 && i < index; i = text.indexOf('\n', i + 1)) line++;
    from = Math.max(from, index);
    return line;
  };
}

function relative(file) {
  return toSlash(path.relative(ROOT, file));
}

function toSlash(name) {
  return name.split(path.sep).join('/');
}
