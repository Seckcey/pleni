// Stub standing in for the Gemini CLI in bin\bridge-relay-check.ps1. Costs $0: no network, no model, no real session.
// bin\spawn-worker.ps1 runs it as: node stub-gemini.js <the exact gemini arguments>  (gemini_exe <path>.js in
// bin\relay-settings.json), with the full prompt on stdin. bin\bridge-relay.ps1 runs it for a Gemini coordinator as:
// node stub-gemini.js --resume <session id> -p <words> ...  (relay -GeminiExe <path>.js), with the notice on stdin.
// Behaviour per invocation comes from <RELAY_STUB_DIR>\gemini-mode.txt (RELAY_STUB_DIR is an environment variable that
// the test sets, as for the other stubs). A worker run:
//   ok               print stream-json events: init, an assistant message, and a result with token stats (exit 0)
//   sleep:<seconds>  like ok, but the run takes <seconds> after init
//   fail             fail before any event (stderr only, exit 1)
//   exit:41          not signed in: stderr only, exit 41
//   exit:42          bad input: stderr only, exit 42
//   exit:53          the turn limit: init, an error event, exit 53
//   exit:55          an untrusted folder: stderr only, exit 55
//   wrong-session    like ok, but init reports another session id than --session-id
// A coordinator turn (--resume <id>): like Gemini CLI, it looks for the session only among the sessions of the folder it
// runs in (the tmp folder whose .project_root names that folder), and exits 42 when it is not there.
//   ok, sleep:<s>       the notice (stdin, then the -p words) goes into the session file; init, a reply, a success result
//   exit:41|42|52|55    stopped before the session is touched: stderr only, that exit code
//   exit:53|54          the notice goes into the session file, then init, an error event and that exit code
//   die-after-session   the notice goes into the session file, then the process dies with no events (exit 3)
//   wrong-session       like ok, but init reports another session id
//   skip-defaults       like ok, after Gemini CLI's warning (on stderr) that it skipped the defaults file, as Gemini CLI
//                       0.66 does when people other than an administrator can change that file
//   cap                 Gemini CLI's own session-turn cap: the notice goes into the session file, then init, an error
//                       event, a success result, and exit 0
//   cap-first           the same cap before Gemini CLI asked the model: init, the error event, a success result, and
//                       exit 0, and the notice never reaches the session file
// It records each call in <RELAY_STUB_DIR>\gemini-calls.jsonl: the arguments, the stdin text, the working folder,
// whether GEMINI_API_KEY is set (true or false only, never the value), the text of the --admin-policy file and the text
// of the file that GEMINI_CLI_SYSTEM_DEFAULTS_PATH names.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const argv = process.argv.slice(2);
const stubDir = process.env.RELAY_STUB_DIR || '';
let mode = 'ok';
try { mode = fs.readFileSync(path.join(stubDir, 'gemini-mode.txt'), 'utf8').trim() || 'ok'; } catch (e) { /* default */ }

function opt(name) { const i = argv.indexOf(name); return (i >= 0 && i + 1 < argv.length) ? argv[i + 1] : null; }
function log(rec) { if (stubDir) fs.appendFileSync(path.join(stubDir, 'gemini-calls.jsonl'), JSON.stringify(rec) + '\n'); }
function sleep(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
function readOrNull(file) { try { return file ? fs.readFileSync(file, 'utf8') : null; } catch (e) { return null; } }

let input = '';
try { input = fs.readFileSync(0, 'utf8'); } catch (e) { /* no stdin */ }
const asked = opt('--session-id') || '';
const resumeId = opt('--resume') || '';
const policyPath = opt('--admin-policy') || '';
const defaultsPath = process.env.GEMINI_CLI_SYSTEM_DEFAULTS_PATH || '';
const running = stubDir ? path.join(stubDir, 'gemini-running-' + process.pid) : null;
const start = Date.now();

function event(obj) { process.stdout.write(JSON.stringify({ ...obj, timestamp: new Date().toISOString() }) + '\n'); }
function finish(code, outcome, stderrText) {
  if (stderrText) process.stderr.write(stderrText + '\n');
  log({ phase: 'end', t: Date.now(), pid: process.pid, outcome, code });
  if (running) { try { fs.unlinkSync(running); } catch (e) { /* ignore */ } }
  process.exitCode = code;
}

const early = {
  41: 'Please set an Auth method in your settings.json or specify one of the following environment variables: GEMINI_API_KEY, GOOGLE_GENAI_USE_VERTEXAI',
  42: 'Error: the input was not valid',
  55: 'Error: this folder is not trusted'
};
const exitMatch = /^exit:(\d+)$/.exec(mode);

if (resumeId) runResume(); else runWorker();

// bin\spawn-worker.ps1: a new session (--session-id), the prompt on stdin. The same as before the coordinator mode.
function runWorker() {
  log({
    phase: 'start', t: start, pid: process.pid, mode, args: argv, stdin: input, cwd: process.cwd(), session_id_flag: asked,
    gemini_key_present: !!process.env.GEMINI_API_KEY, policy_path: policyPath, policy: readOrNull(policyPath),
    defaults_path: defaultsPath, defaults: readOrNull(defaultsPath), gemini_cli_home: process.env.GEMINI_CLI_HOME || ''
  });
  if (running) fs.writeFileSync(running, String(start));
  if (mode === 'fail') {
    finish(1, 'fail', 'Error: simulated Gemini CLI failure before the session started');
  } else if (exitMatch && early[exitMatch[1]]) {
    finish(Number(exitMatch[1]), 'exit-' + exitMatch[1], early[exitMatch[1]]);
  } else {
    const id = mode === 'wrong-session' ? '99999999-9999-4999-8999-999999999999' : (asked || randomUUID());
    event({ type: 'init', session_id: id, model: 'gemini-stub' });
    if (exitMatch) {
      event({ type: 'error', severity: 'error', message: 'Maximum session turns exceeded' });
      finish(Number(exitMatch[1]), 'exit-' + exitMatch[1], 'Reached max session turns for this session.');
    } else {
      const sm = /^sleep:(\d+)$/.exec(mode);
      if (sm) sleep(Number(sm[1]) * 1000);
      event({ type: 'message', role: 'assistant', content: 'stub Gemini worker run done' });
      event({
        type: 'result', status: 'success',
        stats: { total_tokens: 1500, input_tokens: 1200, output_tokens: 300, cached: 800, input: 400, duration_ms: Date.now() - start, tool_calls: 0, models: {} }
      });
      finish(0, 'ok', null);
    }
  }
}

function sameFolder(a, b) {
  const real = (p) => { try { return fs.realpathSync.native(p); } catch (e) { return path.resolve(p); } };
  return real(a).toLowerCase() === real(b).toLowerCase();
}

// The session's file, as Gemini CLI keeps it: <GEMINI_CLI_HOME or home>\.gemini\tmp\<project>\chats\session-*.jsonl,
// whose first line names the session, in the one project whose .project_root is the folder this runs in.
function findSession(id, cwd) {
  const tmp = path.join(process.env.GEMINI_CLI_HOME || os.homedir(), '.gemini', 'tmp');
  let dirs = [];
  try { dirs = fs.readdirSync(tmp, { withFileTypes: true }); } catch (e) { return null; }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const root = (readOrNull(path.join(tmp, d.name, '.project_root')) || '').trim();
    if (!root || !sameFolder(root, cwd)) continue;
    const chats = path.join(tmp, d.name, 'chats');
    let files = [];
    try { files = fs.readdirSync(chats); } catch (e) { continue; }
    for (const f of files) {
      if (!/^session-.*\.jsonl$/.test(f)) continue;
      const head = (readOrNull(path.join(chats, f)) || '').split('\n')[0];
      try { if (JSON.parse(head).sessionId === id) return path.join(chats, f); } catch (e) { /* not a session file */ }
    }
  }
  return null;
}

// bin\bridge-relay.ps1: gemini --resume <id> -p <words>, the notice on stdin.
function runResume() {
  const found = findSession(resumeId, process.cwd());
  const words = opt('-p') || '';
  log({
    phase: 'start', kind: 'resume', t: start, pid: process.pid, mode, args: argv, stdin: input, cwd: process.cwd(), resume: resumeId,
    session_file: found, gemini_key_present: !!process.env.GEMINI_API_KEY, policy_path: policyPath, policy: readOrNull(policyPath),
    defaults_path: defaultsPath, defaults: readOrNull(defaultsPath), gemini_cli_home: process.env.GEMINI_CLI_HOME || ''
  });
  if (running) fs.writeFileSync(running, String(start));
  if (mode === 'skip-defaults') {
    process.stderr.write(`[WARNING] Security Warning: Skipping system defaults file '${defaultsPath}': Parent directory '${path.dirname(defaultsPath)}' is insecure: people other than an administrator can change it.\n`);
  }
  const before = { 41: early[41], 42: early[42], 52: 'Error in settings.json: a setting is not valid', 55: early[55] };
  if (exitMatch && before[exitMatch[1]]) return finish(Number(exitMatch[1]), 'exit-' + exitMatch[1], before[exitMatch[1]]);
  if (!found) return finish(42, 'no-session', `Error resuming session: Invalid session identifier "${resumeId}".`);
  const text = input ? `${input}\n\n${words}` : words;
  if (mode === 'cap-first') {
    event({ type: 'init', session_id: resumeId, model: 'gemini-stub' });
    event({ type: 'message', role: 'user', content: text });
    return cap();
  }
  fs.appendFileSync(found, JSON.stringify({ id: randomUUID(), timestamp: new Date().toISOString(), type: 'user', content: [{ text }] }) + '\n');
  if (mode === 'die-after-session') return finish(3, 'died', 'simulated crash after the notice reached the session');
  event({ type: 'init', session_id: mode === 'wrong-session' ? '99999999-9999-4999-8999-999999999999' : resumeId, model: 'gemini-stub' });
  event({ type: 'message', role: 'user', content: text });
  if (mode === 'cap') return cap();
  if (exitMatch) {
    event({ type: 'error', severity: 'error', message: exitMatch[1] === '53' ? 'Maximum session turns exceeded' : 'A tool failed' });
    return finish(Number(exitMatch[1]), 'exit-' + exitMatch[1], 'simulated error after the notice reached the session');
  }
  const sm = /^sleep:(\d+)$/.exec(mode);
  if (sm) sleep(Number(sm[1]) * 1000);
  const reply = 'stub Gemini coordinator turn handled';
  fs.appendFileSync(found, JSON.stringify({ id: randomUUID(), timestamp: new Date().toISOString(), type: 'gemini', content: reply }) + '\n');
  event({ type: 'message', role: 'assistant', content: reply, delta: true });
  event({ type: 'result', status: 'success', stats: { total_tokens: 3, input_tokens: 2, output_tokens: 1, cached: 0 } });
  return finish(0, 'ok', null);
}

// Gemini CLI's own session-turn cap (its core client): an error event, then a success result, and exit 0.
function cap() {
  event({ type: 'error', severity: 'error', message: 'Maximum session turns exceeded' });
  event({ type: 'result', status: 'success', stats: { total_tokens: 0, input_tokens: 0, output_tokens: 0, cached: 0 } });
  return finish(0, 'cap', null);
}
