// Stub standing in for Antigravity CLI (agy) in bin\bridge-relay-check.ps1. Costs $0: no network, no model, no login.
// bin\spawn-worker.ps1 runs it as: node stub-agy.js <the exact agy arguments>  (antigravity_exe <path>.js in
// bin\relay-settings.json), with the prompt as one stream-json line on stdin.
// Behaviour per invocation comes from <RELAY_STUB_DIR>\agy-mode.txt (RELAY_STUB_DIR is an environment variable that
// the test sets, as for the other stubs):
//   ok             print stream-json events: init (a new conversation id), one step_update, and a SUCCESS result with
//                  token usage (exit 0)
//   write          like ok, but first change a file in the working folder, the way a real worker does
//   sleep:<s>      like ok, but the run takes <s> seconds after init
//   exit:1         bad input: an ERROR result, and the reason on stderr (exit 1)
//   exit:3         a model or service failure: init, an ERROR result, and an AGY_ERROR line on stderr (exit 3)
//   result-error   init, then an ERROR result, but exit 0 (Antigravity CLI does this in a stream-json session)
//   auth           not signed in: "authentication required" on stderr, and no events (exit 1)
// A stdin line that is not JSON, or has no "event" field, ends the run with an ERROR result (exit 1), as Antigravity
// CLI does.
// It records each call in <RELAY_STUB_DIR>\agy-calls.jsonl: the arguments, the stdin text and what it read from it, the
// working folder, and whether GEMINI_API_KEY is set (true or false only, never the value).
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const argv = process.argv.slice(2);
const stubDir = process.env.RELAY_STUB_DIR || '';
let mode = 'ok';
try { mode = fs.readFileSync(path.join(stubDir, 'agy-mode.txt'), 'utf8').trim() || 'ok'; } catch (e) { /* default */ }

function log(rec) { if (stubDir) fs.appendFileSync(path.join(stubDir, 'agy-calls.jsonl'), JSON.stringify(rec) + '\n'); }
function sleep(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
function event(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }

let input = '';
try { input = fs.readFileSync(0, 'utf8'); } catch (e) { /* no stdin */ }
const lines = input.split('\n').map((l) => l.trim()).filter(Boolean);
const messages = [];
let badInput = '';
for (const line of lines) {
  let m = null;
  try { m = JSON.parse(line); } catch (e) { badInput = 'invalid JSON line on stdin'; break; }
  if (!m || typeof m.event !== 'string') { badInput = 'message missing the event field'; break; }
  messages.push(m);
}
const user = messages.find((m) => m.event === 'user');
const content = user && user.message ? user.message.content : null;
const conversation = randomUUID();
const running = stubDir ? path.join(stubDir, 'agy-running-' + process.pid) : null;
const start = Date.now();

log({
  phase: 'start', t: start, pid: process.pid, mode, args: argv, stdin: input, stdin_lines: lines.length,
  stdin_event: messages.length ? messages[0].event : '', stdin_content: typeof content === 'string' ? content : null,
  conversation_id: conversation, cwd: process.cwd(), gemini_key_present: !!process.env.GEMINI_API_KEY
});
if (running) fs.writeFileSync(running, String(start));

function finish(code, outcome, stderrText) {
  if (stderrText) process.stderr.write(stderrText + '\n');
  log({ phase: 'end', t: Date.now(), pid: process.pid, outcome, code });
  if (running) { try { fs.unlinkSync(running); } catch (e) { /* ignore */ } }
  process.exitCode = code;
}

const noUsage = { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 0 };
function result(status, extra) {
  event({
    event: 'result',
    result: { conversation_id: conversation, status, response: '', duration_seconds: (Date.now() - start) / 1000, num_turns: 1, usage: noUsage, ...extra }
  });
}
function step(fields) { event({ event: 'step_update', step_update: { conversation_id: conversation, ...fields } }); }

if (mode === 'auth') {
  finish(1, 'auth', 'Error: authentication required. Run agy in a terminal to sign in.');
} else if (badInput || mode === 'exit:1') {
  const why = badInput || 'invalid model selection (--model "stub-unknown" --effort ""): model stub-unknown is not recognized as a known model';
  result('ERROR', { conversation_id: '', error: why, num_turns: 0 });
  finish(1, 'exit-1', 'Error: ' + why);
} else {
  event({
    event: 'init', conversation_id: conversation,
    init: { cwd: process.cwd(), tools: ['run_command', 'view_file', 'write_to_file'], permission_mode: 'request-review' }
  });
  const sm = /^sleep:(\d+)$/.exec(mode);
  if (sm) sleep(Number(sm[1]) * 1000);
  if (mode === 'exit:3') {
    step({ step_index: 0, state: 'DONE', step_type: 'user_input' });
    result('ERROR', { error: 'The model is overloaded. Try again later.' });
    const detail = { status: 'UNAVAILABLE', code: 503, retryable: true, error_id: 'stub-error-1', message: 'The model is overloaded. Try again later.' };
    finish(3, 'exit-3', 'AGY_ERROR: ' + JSON.stringify(detail));
  } else if (mode === 'result-error') {
    step({ step_index: 0, state: 'DONE', step_type: 'user_input' });
    result('ERROR', { error: 'simulated model error' });
    finish(0, 'result-error', 'warning: the turn ended with an error');
  } else {
    // Mode 'write': change a file in the working folder, so the launcher has work to commit.
    if (mode === 'write') fs.writeFileSync(path.join(process.cwd(), 'agy-stub-change.txt'), 'changed by the stub Antigravity worker\n');
    const usage = { input_tokens: 10418, output_tokens: 589, thinking_tokens: 551, cache_read_tokens: 8113, total_tokens: 11007 };
    step({ step_index: 1, state: 'DONE', step_type: 'agent_response', text_delta: 'stub Antigravity worker run done\n', usage });
    result('SUCCESS', { response: 'stub Antigravity worker run done\n', usage });
    finish(0, mode === 'write' ? 'write' : 'ok', null);
  }
}
