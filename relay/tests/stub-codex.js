// Stub standing in for the Codex CLI in bin\bridge-relay-check.ps1. Costs $0: no network, no model, no real thread.
// bridge-relay.ps1 runs it as: node stub-codex.js <the exact codex arguments>  (relay -CodexExe <path>.js).
// Behaviour per invocation comes from <RELAY_STUB_DIR>\codex-mode.txt:
//   ok                 append the notice to the fake thread file, print JSON events ending in turn.completed
//   sleep:<seconds>    like ok, but the turn takes <seconds>
//   fail               fail before the thread is contacted (stderr only, exit 1)
//   die-after-thread   the notice reaches the thread file, then the process dies without events
//   turn-failed        the notice reaches the thread file, then the turn fails (turn.failed event, exit 1)
//   wrong-thread       like ok, but thread.started names a different thread id
//   not-signed-in      'login status' says Codex is not signed in (exit 1)
//   api-key            'login status' says Codex is signed in with an API key
// A missing thread file behaves like the real CLI: an error on stderr, exit 1.
// It records each call in <RELAY_STUB_DIR>\codex-calls.jsonl. Keys are never written: only booleans about them.
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const stubDir = process.env.RELAY_STUB_DIR || '';
const home = process.env.CODEX_HOME || '';
let mode = 'ok';
try { mode = fs.readFileSync(path.join(stubDir, 'codex-mode.txt'), 'utf8').trim() || 'ok'; } catch (e) { /* default */ }

function log(rec) { if (stubDir) fs.appendFileSync(path.join(stubDir, 'codex-calls.jsonl'), JSON.stringify(rec) + '\n'); }
function sleep(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

if (argv[0] === 'login' && argv[1] === 'status') {
  // Local sign-in probe only: no turn, no thread file.
  log({ phase: 'login', t: Date.now(), pid: process.pid, mode, codex_home: home });
  if (mode === 'not-signed-in') {
    process.stderr.write('Not logged in\n');
    process.exit(1);
  }
  process.stderr.write(mode === 'api-key' ? 'Logged in using an API key - sk-***\n' : 'Logged in using ChatGPT\n');
  process.exit(0);
}

// rollout-<time>-<thread id>.jsonl anywhere under <CODEX_HOME>\sessions, as Codex keeps them.
function findThread(id) {
  const stack = [path.join(home, 'sessions')];
  while (stack.length) {
    const dir = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { continue; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.name.startsWith('rollout-') && entry.name.endsWith(`${id}.jsonl`)) return full;
    }
  }
  return null;
}

const ri = argv.indexOf('resume');
const before = ri >= 0 ? argv.slice(0, ri) : argv;
const thread = ri >= 0 ? (argv[ri + 1] || '') : '';
const prompt = ri >= 0 ? (argv[ri + 2] || '') : '';
const m = /\[bridge-relay ([^\]]+)\]/.exec(prompt);
const running = stubDir ? path.join(stubDir, 'codex-running-' + process.pid) : null;
const start = Date.now();

log({
  phase: 'start', t: start, pid: process.pid, mode, exec: argv[0] === 'exec', thread, prompt, dispatch: m ? m[1] : '',
  json: before.includes('--json'), skip_git: before.includes('--skip-git-repo-check'),
  extra: before.slice(1).filter((a) => a !== '--json' && a !== '--skip-git-repo-check'),
  last: argv.includes('--last'), bypass: argv.some((a) => /danger|bypass|yolo/i.test(a)),
  key_absent: !process.env.OPENAI_API_KEY && !process.env.CODEX_API_KEY, codex_home: home, cwd: process.cwd()
});
if (running) fs.writeFileSync(running, String(start));

function event(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }
function finish(code, outcome, stderrText) {
  if (stderrText) process.stderr.write(stderrText + '\n');
  log({ phase: 'end', t: Date.now(), pid: process.pid, outcome, code });
  if (running) { try { fs.unlinkSync(running); } catch (e) { /* ignore */ } }
  process.exitCode = code;
}

const file = thread ? findThread(thread) : null;
if (mode === 'fail') {
  finish(1, 'fail', 'Error: simulated Codex failure before the thread was contacted');
} else if (argv[0] !== 'exec' || ri < 0 || !file) {
  finish(1, 'no-thread', 'Error: no saved thread found with id ' + thread);
} else {
  const user = { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt }] } };
  fs.appendFileSync(file, JSON.stringify(user) + '\n');
  if (mode === 'die-after-thread') {
    finish(3, 'died', 'simulated crash after the notice reached the thread');
  } else {
    const sm = /^sleep:(\d+)$/.exec(mode);
    if (sm) sleep(Number(sm[1]) * 1000);
    event({ type: 'thread.started', thread_id: mode === 'wrong-thread' ? '99999999-9999-4999-8999-999999999999' : thread });
    event({ type: 'turn.started' });
    if (mode === 'turn-failed') {
      event({ type: 'turn.failed', error: { message: 'simulated model error' } });
      finish(1, 'turn-failed', null);
    } else {
      const text = 'stub planner turn handled ' + (m ? m[1] : '');
      const reply = { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] } };
      fs.appendFileSync(file, JSON.stringify(reply) + '\n');
      event({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text } });
      event({ type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } });
      finish(0, 'ok', null);
    }
  }
}
