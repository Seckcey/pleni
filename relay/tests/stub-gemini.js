// Stub standing in for the Gemini CLI in bin\bridge-relay-check.ps1. Costs $0: no network, no model, no real session.
// bin\spawn-worker.ps1 runs it as: node stub-gemini.js <the exact gemini arguments>  (gemini_exe <path>.js in
// bin\relay-settings.json), with the full prompt on stdin.
// Behaviour per invocation comes from <RELAY_STUB_DIR>\gemini-mode.txt (RELAY_STUB_DIR is an environment variable that
// the test sets, as for the other stubs):
//   ok               print stream-json events: init, an assistant message, and a result with token stats (exit 0)
//   sleep:<seconds>  like ok, but the run takes <seconds> after init
//   fail             fail before any event (stderr only, exit 1)
//   exit:41          not signed in: stderr only, exit 41
//   exit:42          bad input: stderr only, exit 42
//   exit:53          the turn limit: init, an error event, exit 53
//   exit:55          an untrusted folder: stderr only, exit 55
//   wrong-session    like ok, but init reports another session id than --session-id
// It records each call in <RELAY_STUB_DIR>\gemini-calls.jsonl: the arguments, the stdin text, the working folder,
// whether GEMINI_API_KEY is set (true or false only, never the value), the text of the --admin-policy file and the text
// of the file that GEMINI_CLI_SYSTEM_DEFAULTS_PATH names.
import fs from 'node:fs';
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
const policyPath = opt('--admin-policy') || '';
const defaultsPath = process.env.GEMINI_CLI_SYSTEM_DEFAULTS_PATH || '';
const running = stubDir ? path.join(stubDir, 'gemini-running-' + process.pid) : null;
const start = Date.now();

log({
  phase: 'start', t: start, pid: process.pid, mode, args: argv, stdin: input, cwd: process.cwd(), session_id_flag: asked,
  gemini_key_present: !!process.env.GEMINI_API_KEY, policy_path: policyPath, policy: readOrNull(policyPath),
  defaults_path: defaultsPath, defaults: readOrNull(defaultsPath), gemini_cli_home: process.env.GEMINI_CLI_HOME || ''
});
if (running) fs.writeFileSync(running, String(start));

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
