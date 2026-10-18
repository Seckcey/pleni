import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { clearRepoCache, githubRepo, parseRemote, remoteUrl } from '../src/repos.js';

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pleni-repos-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// A repository folder whose .git/config names `url` as the origin.
function repo(t, url, extra = '') {
  const dir = tempDir(t);
  fs.mkdirSync(path.join(dir, '.git'));
  fs.writeFileSync(path.join(dir, '.git', 'config'), `[core]\n\tbare = false\n[remote "origin"]\n\turl = ${url}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n${extra}`);
  return dir;
}

const look = (dir, now = 1000) => githubRepo(dir, { now });
// A made-up login and token, as an address can hold them: https://<user>:<token>@github.com/...
const LOGIN = 'ada:secret-token';

test('parseRemote reads the usual GitHub address forms and drops any login', () => {
  const want = { host: 'github.com', owner: 'ada', name: 'notes' };
  for (const url of [
    'https://github.com/ada/notes.git',
    'https://github.com/ada/notes',
    `https://${LOGIN}@github.com/ada/notes.git`,
    'git@github.com:ada/notes.git',
    'ssh://git@github.com/ada/notes.git',
    'ssh://git@github.com:22/ada/notes',
    'git://github.com/ada/notes',
  ]) {
    assert.deepEqual(parseRemote(url), want, url);
  }
  assert.equal(JSON.stringify(parseRemote(`https://${LOGIN}@github.com/ada/notes`)).includes('secret'), false);
  assert.deepEqual(parseRemote('https://gitlab.com/ada/notes'), { host: 'gitlab.com', owner: 'ada', name: 'notes' });
});

test('parseRemote refuses what is not owner/name on a named host', () => {
  for (const url of ['C:/repos/notes', 'C:\\repos\\notes', '/home/ada/notes.git', 'file:///home/ada/notes', 'https://github.com/ada',
    'https://github.com/ada/notes/tree/main', 'https://github.com/../notes', 'ftp://github.com/ada/notes', 'git@github.com:/ada/notes',
    'https://github.com/ada/no tes', '', null, 42]) {
    assert.equal(parseRemote(url), null, String(url));
  }
});

test('remoteUrl takes origin, else the first remote, and skips comments and other sections', () => {
  const both = '[remote "upstream"]\n\turl = https://github.com/up/notes\n[remote "origin"]\n\turl = git@github.com:ada/notes.git\n';
  assert.equal(remoteUrl(both), 'git@github.com:ada/notes.git');
  assert.equal(remoteUrl('[remote "fork"]\n url = https://github.com/fork/notes\n'), 'https://github.com/fork/notes');
  assert.equal(remoteUrl('; [remote "origin"]\n# url = https://github.com/x/y\n[branch "main"]\n\turl = https://github.com/x/y\n'), null);
  assert.equal(remoteUrl('[remote "origin"]\r\n\turl = "https://github.com/ada/notes"\r\n'), 'https://github.com/ada/notes');
  assert.equal(remoteUrl(null), null);
});

test('githubRepo finds the repository from the session folder or any folder inside it', (t) => {
  clearRepoCache();
  const dir = repo(t, `https://${LOGIN}@github.com/ada/notes.git`);
  assert.equal(look(dir), 'ada/notes');
  const inner = path.join(dir, 'src', 'lib');
  fs.mkdirSync(inner, { recursive: true });
  assert.equal(look(inner), 'ada/notes');
});

test('githubRepo follows a worktree to the repository it belongs to', (t) => {
  clearRepoCache();
  const main = repo(t, 'git@github.com:ada/notes.git');
  const shared = path.join(main, '.git', 'worktrees', 'fix');
  fs.mkdirSync(shared, { recursive: true });
  fs.writeFileSync(path.join(shared, 'commondir'), '../..\n');
  const tree = path.join(tempDir(t), 'fix');
  fs.mkdirSync(tree);
  fs.writeFileSync(path.join(tree, '.git'), `gitdir: ${shared}\n`);
  assert.equal(look(tree), 'ada/notes');
});

test('githubRepo gives null for other hosts, no remote, no repository, big files and network folders', (t) => {
  clearRepoCache();
  assert.equal(look(repo(t, 'https://gitlab.com/ada/notes.git')), null);
  const bare = tempDir(t);
  fs.mkdirSync(path.join(bare, '.git'));
  fs.writeFileSync(path.join(bare, '.git', 'config'), '[core]\n\tbare = false\n');
  assert.equal(look(bare), null);
  assert.equal(look(path.join(tempDir(t), 'none')), null);
  const big = repo(t, 'https://github.com/ada/notes.git', `# ${'x'.repeat(70 * 1024)}\n`);
  assert.equal(look(big), null, 'a config file over 64 KB is not read');
  assert.equal(githubRepo('\\\\server\\share\\notes', { platform: 'win32' }), null);
  assert.equal(githubRepo('//server/share/notes', { platform: 'linux' }), null);
  assert.equal(githubRepo('notes', { platform: 'linux' }), null);
  assert.equal(githubRepo(null), null);
});

test('githubRepo keeps an answer for a minute', (t) => {
  clearRepoCache();
  const dir = repo(t, 'https://github.com/ada/notes.git');
  assert.equal(look(dir, 1000), 'ada/notes');
  fs.writeFileSync(path.join(dir, '.git', 'config'), '[remote "origin"]\n\turl = https://github.com/ada/other.git\n');
  assert.equal(look(dir, 30 * 1000), 'ada/notes');
  assert.equal(look(dir, 62 * 1000), 'ada/other');
});
