// The GitHub repository a session works in, for the Pull requests view. Pleni reads only the
// address of the repository's "origin" remote (else its first remote) from the git settings
// (.git/config), drops any login in it, and keeps it only when it is on github.com. In a worktree it
// first reads the small .git pointer file and the commondir file it leads to. Only folders on a
// local drive are read, each file at most 64 KB, and each answer is kept for a minute.
import fs from 'node:fs';
import path from 'node:path';

const MAX_UP = 16; // folders to climb from the session's folder to the one holding .git
const MAX_CONFIG = 64 * 1024;
const MAX_POINTER = 4096;
const TTL_MS = 60 * 1000;
const CACHE_MAX = 500;
const PART = /^[A-Za-z0-9._-]{1,100}$/;
const GITHUB_HOSTS = new Set(['github.com', 'www.github.com', 'ssh.github.com']);

const cache = new Map();

// 'owner/name' for a folder inside a GitHub repository, else null.
export function githubRepo(cwd, { now = Date.now(), platform = process.platform } = {}) {
  if (!localFolder(cwd, platform)) return null;
  const hit = cache.get(cwd);
  if (hit && now - hit.at < TTL_MS) return hit.repo;
  let repo = null;
  try {
    repo = findRepo(cwd, platform);
  } catch {
    repo = null;
  }
  if (cache.size >= CACHE_MAX) cache.clear();
  cache.set(cwd, { at: now, repo });
  return repo;
}

export function clearRepoCache() {
  cache.clear();
}

// A network share could stall every snapshot, so only an absolute folder on a local drive is read.
function localFolder(dir, platform) {
  if (typeof dir !== 'string' || !dir) return false;
  if (platform === 'win32') return /^[A-Za-z]:[\\/]/.test(dir);
  return dir.startsWith('/') && !dir.startsWith('//');
}

function findRepo(cwd, platform) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  let dir = p.resolve(cwd);
  for (let i = 0; i < MAX_UP; i++) {
    const dotGit = p.join(dir, '.git');
    const stat = statOf(dotGit);
    if (stat) {
      const gitDir = stat.isDirectory() ? dotGit : stat.isFile() ? pointerTarget(dotGit, dir, p) : null;
      return gitDir ? repoFromConfig(p.join(commonDir(gitDir, p), 'config')) : null;
    }
    const up = p.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
  return null;
}

// A worktree's .git is a file: "gitdir: <folder>", relative to the worktree or absolute.
function pointerTarget(file, dir, p) {
  const text = smallFile(file, MAX_POINTER);
  const match = text && /^gitdir:\s*(.+)$/m.exec(text);
  return match ? p.resolve(dir, match[1].trim()) : null;
}

// A worktree's own git folder names the shared one in its "commondir" file (usually "../..").
function commonDir(gitDir, p) {
  const text = smallFile(p.join(gitDir, 'commondir'), MAX_POINTER);
  const target = text && text.trim();
  return target ? p.resolve(gitDir, target) : gitDir;
}

function repoFromConfig(file) {
  const text = smallFile(file, MAX_CONFIG);
  return text ? githubPath(parseRemote(remoteUrl(text))) : null;
}

// The url of [remote "origin"] in a git config file, else of the first remote, else null.
export function remoteUrl(text) {
  if (typeof text !== 'string') return null;
  const urls = new Map();
  let remote = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const head = /^\[\s*remote\s+"([^"]*)"\s*\]$/i.exec(line);
    if (head) {
      remote = head[1];
      continue;
    }
    if (line.startsWith('[')) {
      remote = null;
      continue;
    }
    const url = remote !== null && /^url\s*=\s*(.+)$/i.exec(line);
    if (url && !urls.has(remote)) urls.set(remote, url[1].trim().replace(/^"(.*)"$/, '$1'));
  }
  return urls.get('origin') ?? urls.values().next().value ?? null;
}

// { host, owner, name } from a remote address such as https://github.com/ada/notes.git,
// git@github.com:ada/notes.git or ssh://git@github.com/ada/notes, else null. A login or token in
// the address is never kept.
export function parseRemote(url) {
  if (typeof url !== 'string') return null;
  const text = url.trim();
  let host;
  let rest;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    let u;
    try {
      u = new URL(text);
    } catch {
      return null;
    }
    if (!['https:', 'http:', 'ssh:', 'git:'].includes(u.protocol)) return null;
    host = u.hostname;
    rest = u.pathname;
  } else {
    // user@host:owner/name, the short form ssh uses. A drive letter such as C:/repo has no dot.
    const scp = /^(?:[^@/\s]+@)?([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+):(?!\/)(\S+)$/.exec(text);
    if (!scp) return null;
    host = scp[1];
    rest = scp[2];
  }
  const parts = rest.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '').split('/');
  if (parts.length !== 2 || !parts.every((part) => PART.test(part) && part !== '.' && part !== '..')) return null;
  return { host: host.toLowerCase(), owner: parts[0], name: parts[1] };
}

function githubPath(remote) {
  return remote && GITHUB_HOSTS.has(remote.host) ? `${remote.owner}/${remote.name}` : null;
}

function statOf(file) {
  try {
    return fs.statSync(file);
  } catch {
    return null;
  }
}

// stat first: a pipe or a huge file must not block or fill memory.
function smallFile(file, max) {
  const stat = statOf(file);
  if (!stat || !stat.isFile() || stat.size > max) return null;
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}
