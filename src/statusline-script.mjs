// Pleni's status line for Claude Code. Pleni copies this file into its own settings folder as
// pleni-statusline.mjs when the person chooses Connect for plan limits (src/statusline.js).
// Claude Code runs it after each reply and sends it JSON on standard input.
//
// What it does:
//   1. Saves Claude Code's 5-hour and weekly limits (only numbers) in claude-limits.json, next to
//      this file. It saves nothing else from the input: no folders, no session ids, no text.
//   2. Prints the status line. If the person had a status line of their own before Connect, it is
//      kept in statusline.json next to this file: this script runs it the way Claude Code would,
//      with the same input, and prints what it prints. Otherwise it prints one short line.
//
// It never stops with an error: on any problem it prints what it can and ends with code 0.
// Keep this file ASCII-only and free of packages: it is copied as it is.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const MAX_INPUT = 1024 * 1024;
const INPUT_WAIT_MS = 5000;
const PREVIOUS_WAIT_MS = 10000;
const WINDOWS = { five_hour: 300, seven_day: 10080, spend_limit: null };
const LABELS = { five_hour: '5-hour', seven_day: 'week', spend_limit: 'spend' };

const here = path.dirname(fileURLToPath(import.meta.url));

main().catch(() => finish(0));

async function main() {
  const input = await readInput();
  let data = null;
  try {
    data = JSON.parse(input.toString('utf8'));
  } catch {
    data = null;
  }
  const windows = limitWindows(data);
  if (windows.length > 0) saveLimits(windows);
  const previous = readPrevious();
  if (previous) return runPrevious(previous, input);
  process.stdout.write(`${plainLine(data, windows)}\n`, () => finish(0));
  return undefined;
}

// ---- the input ----

// All of standard input up to 1 MB, or what came in 5 seconds.
function readInput() {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let done = false;
    const end = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(Buffer.concat(chunks));
    };
    const timer = setTimeout(end, INPUT_WAIT_MS);
    process.stdin.on('data', (chunk) => {
      if (size >= MAX_INPUT) return end();
      chunks.push(chunk.subarray(0, MAX_INPUT - size));
      size += chunk.length;
      if (size >= MAX_INPUT) end();
      return undefined;
    });
    process.stdin.on('end', end);
    process.stdin.on('error', end);
  });
}

// ---- the limits ----

// [{ name, minutes, usedPercent, resetsAt (ms) }] for each window that has two real numbers.
function limitWindows(data) {
  const limits = data && typeof data === 'object' && typeof data.rate_limits === 'object' ? data.rate_limits : null;
  if (!limits) return [];
  const out = [];
  for (const name of Object.keys(WINDOWS)) {
    const w = limits[name];
    if (!w || typeof w !== 'object') continue;
    const used = w.used_percentage;
    const reset = w.resets_at;
    if (typeof used !== 'number' || !Number.isFinite(used) || typeof reset !== 'number' || !Number.isFinite(reset) || reset <= 0) continue;
    out.push({ name, minutes: WINDOWS[name], usedPercent: Math.min(100, Math.max(0, used)), resetsAt: Math.round(reset * 1000) });
  }
  return out;
}

// A temporary file in the same folder, then a rename, so Pleni never reads half a file.
function saveLimits(windows) {
  const file = path.join(here, 'claude-limits.json');
  const temp = path.join(here, `.claude-limits.json.${process.pid}.tmp`);
  try {
    fs.writeFileSync(temp, JSON.stringify({ v: 1, at: Date.now(), windows }), { flag: 'w', mode: 0o600 });
    for (let tries = 0; ; tries++) {
      try {
        fs.renameSync(temp, file);
        return;
      } catch (err) {
        if (tries >= 5) throw err;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      }
    }
  } catch {
    try {
      fs.rmSync(temp, { force: true });
    } catch {
      // Nothing more to do.
    }
  }
}

// ---- the line Pleni prints when the person had no status line ----

function plainLine(data, windows) {
  const parts = [];
  const model = data && typeof data === 'object' && data.model && typeof data.model === 'object' ? data.model.display_name : null;
  if (typeof model === 'string') {
    const name = model.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);
    if (name) parts.push(name);
  }
  for (const w of windows) parts.push(`${LABELS[w.name]} ${Math.round(w.usedPercent)}%`);
  return parts.length ? parts.join(' \u00b7 ') : 'Claude Code';
}

// ---- the status line the person had before ----

// The saved statusLine object's command, or null.
function readPrevious() {
  try {
    const old = JSON.parse(fs.readFileSync(path.join(here, 'statusline.json'), 'utf8'));
    const command = old && typeof old === 'object' && typeof old.command === 'string' ? old.command.trim() : '';
    // A saved line that calls this script again would start itself over and over: never run it.
    return command && !/pleni-statusline\.mjs/i.test(command) ? old.command : null;
  } catch {
    return null;
  }
}

// The program and words that run a command the way Claude Code does: through Git Bash on Windows
// when it is installed, else Windows PowerShell; on other systems through bash or zsh (the only
// two Claude Code uses): the person's own, else the first one found, else sh.
function shellFor(command) {
  if (process.platform !== 'win32') {
    const shell = process.env.SHELL;
    const own = shell && path.isAbsolute(shell) && ['bash', 'zsh'].includes(path.basename(shell)) && isFile(shell) ? shell : null;
    const found = ['/bin/bash', '/usr/bin/bash', '/bin/zsh', '/usr/bin/zsh', '/bin/sh'].find(isFile);
    return { file: own ?? found ?? '/bin/sh', args: ['-c', command] };
  }
  const bash = findGitBash();
  if (bash) return { file: bash, args: ['-c', command] };
  return { file: 'powershell.exe', args: ['-NoProfile', '-Command', command] };
}

function findGitBash() {
  const given = process.env.CLAUDE_CODE_GIT_BASH_PATH;
  if (given && isFile(given)) return given;
  for (const dir of (process.env.PATH ?? process.env.Path ?? '').split(';')) {
    if (!dir.trim() || !isFile(path.win32.join(dir.replace(/"/g, ''), 'git.exe'))) continue;
    const base = path.win32.dirname(dir.replace(/"/g, ''));
    for (const candidate of [path.win32.join(base, 'bin', 'bash.exe'), path.win32.join(path.win32.dirname(base), 'bin', 'bash.exe')]) {
      if (isFile(candidate)) return candidate;
    }
  }
  const usual = 'C:/Program Files/Git/bin/bash.exe';
  return isFile(usual) ? usual : null;
}

function isFile(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

// Runs the old command with the same input, prints its output, and ends with its code. It is
// stopped after 10 seconds.
function runPrevious(command, input) {
  let child;
  try {
    const shell = shellFor(command);
    child = spawn(shell.file, shell.args, { stdio: ['pipe', 'inherit', 'inherit'], windowsHide: true });
  } catch {
    process.stdout.write('Claude Code\n', () => finish(0));
    return;
  }
  let over = false;
  const timer = setTimeout(() => {
    over = true;
    try {
      child.kill();
    } catch {
      // It ended on its own.
    }
    setTimeout(() => finish(0), 500);
  }, PREVIOUS_WAIT_MS);
  child.stdin.on('error', () => {});
  child.on('error', () => {
    clearTimeout(timer);
    finish(0);
  });
  child.on('close', (code) => {
    clearTimeout(timer);
    finish(over || typeof code !== 'number' ? 0 : code);
  });
  try {
    child.stdin.end(input);
  } catch {
    // The old command did not want the input.
  }
}

function finish(code) {
  process.exit(code);
}
