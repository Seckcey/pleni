// Stub standing in for claude.exe in bin\bridge-relay-check.ps1. Costs $0: no network, no API, no real session.
// bridge-relay.ps1 runs it as: node stub-claude.js <the exact claude arguments>  (relay -ClaudeExe <path>.js).
// Behaviour per invocation comes from <RELAY_STUB_DIR>\mode.txt:
//   ok                    write the prompt to the fake session transcript, print a success result
//   sleep:<seconds>       like ok, but the turn takes <seconds>
//   die-after-transcript  the prompt reaches the transcript, then the process dies without a result
//   fail                  fail before the session is contacted (stderr only, exit 1)
//   wrong-session         like ok, but the result reports a different session id (copy/fork)
// A missing transcript for --resume <id> behaves like the real CLI: stderr "No conversation found", exit 1.
// It records each call in <RELAY_STUB_DIR>\calls.jsonl. The API key is never written: only booleans about it.
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
if (argv[0] === 'auth' && argv[1] === 'status') {
  // Local auth probe only: no model turn, transcript, network or dispatch call.
  // Successful native probes may also write diagnostics to stderr on Windows.
  process.stderr.write('Subscription auth diagnostic on stderr.\n');
  process.stdout.write(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max' }) + '\n');
  process.exit(0);
}
const stubDir = process.env.RELAY_STUB_DIR || '';
const cfgDir = process.env.RELAY_STUB_CONFIG_DIR || '';

function opt(name) { const i = argv.indexOf(name); return (i >= 0 && i + 1 < argv.length) ? argv[i + 1] : null; }
function log(rec) { if (stubDir) fs.appendFileSync(path.join(stubDir, 'calls.jsonl'), JSON.stringify(rec) + '\n'); }
function sleep(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
function findTranscript(id) {
  if (!cfgDir || !id) return null;
  const pd = path.join(cfgDir, 'projects');
  if (!fs.existsSync(pd)) return null;
  for (const d of fs.readdirSync(pd)) {
    const f = path.join(pd, d, id + '.jsonl');
    if (fs.existsSync(f)) return f;
  }
  return null;
}

let mode = 'ok';
try { mode = fs.readFileSync(path.join(stubDir, 'mode.txt'), 'utf8').trim() || 'ok'; } catch (e) { /* default */ }
const pi = argv.indexOf('-p');
const prompt = (pi >= 0 && pi + 1 < argv.length) ? argv[pi + 1] : '';
const resume = opt('--resume');
const m = /\[bridge-relay ([^\]]+)\]/.exec(prompt);
const key = process.env.ANTHROPIC_API_KEY || '';
const running = stubDir ? path.join(stubDir, 'running-' + process.pid) : null;
const start = Date.now();

log({
  phase: 'start', t: start, pid: process.pid, mode, resume, dispatch: m ? m[1] : '', prompt,
  bare: argv.includes('--bare'), print: argv.includes('-p'), output_format: opt('--output-format'),
  max_budget_usd: opt('--max-budget-usd'), session_id_flag: opt('--session-id'),
  fork_session: argv.includes('--fork-session'),
  continue_flag: argv.includes('--continue') || argv.includes('-c'),
  no_session_persistence: argv.includes('--no-session-persistence'),
  system_append: argv.includes('--append-system-prompt'), allowed_tools: argv.includes('--allowedTools'),
  key_is_dummy: key === 'sk-ant-relay-check-dummy', key_present: key.length > 0,
  oauth_absent: !process.env.CLAUDE_CODE_OAUTH_TOKEN, cwd: process.cwd()
});
if (running) fs.writeFileSync(running, String(start));

function finish(code, outcome, resultObj, stderrText) {
  if (resultObj) process.stdout.write(JSON.stringify(resultObj) + '\n');
  if (stderrText) process.stderr.write(stderrText + '\n');
  log({ phase: 'end', t: Date.now(), pid: process.pid, outcome, code });
  if (running) { try { fs.unlinkSync(running); } catch (e) { /* ignore */ } }
  process.exitCode = code;
}

const transcript = findTranscript(resume);
if (mode === 'fail') {
  finish(1, 'fail', null, 'Error: simulated CLI failure before the session was contacted');
} else if (!resume || !transcript) {
  finish(1, 'no-session', null, 'No conversation found with session ID: ' + resume);
} else {
  fs.appendFileSync(transcript, JSON.stringify({ type: 'user', sessionId: resume, message: { role: 'user', content: prompt } }) + '\n');
  if (mode === 'die-after-transcript') {
    finish(3, 'died', null, 'simulated crash after the prompt reached the session');
  } else {
    const sm = /^sleep:(\d+)$/.exec(mode);
    if (sm) sleep(Number(sm[1]) * 1000);
    const sid = mode === 'wrong-session' ? '99999999-9999-4999-8999-999999999999' : resume;
    const res = {
      type: 'result', subtype: 'success', is_error: false, duration_ms: Date.now() - start, num_turns: 1,
      result: 'stub coordinator turn handled ' + (m ? m[1] : ''), session_id: sid, total_cost_usd: 0
    };
    fs.appendFileSync(transcript, JSON.stringify({ type: 'assistant', sessionId: sid, message: { role: 'assistant', content: res.result } }) + '\n');
    finish(0, 'ok', res, null);
  }
}
