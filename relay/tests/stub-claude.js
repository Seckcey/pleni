// Stub standing in for claude.exe in bin\bridge-relay-check.ps1. Costs $0: no network, no API, no real session.
// bridge-relay.ps1 runs it as: node stub-claude.js <the exact claude arguments>  (relay -ClaudeExe <path>.js).
// Behaviour per invocation comes from <RELAY_STUB_DIR>\mode.txt:
//   ok                    write the prompt to the fake session transcript, print a success result
//   sleep:<seconds>       like ok, but the turn takes <seconds>
//   die-after-transcript  the prompt reaches the transcript, then the process dies without a result
//   fail                  fail before the session is contacted (stderr only, exit 1)
//   wrong-session         like ok, but the result reports a different session id (copy/fork)
//   no-title              like ok, but a new agent's first turn writes no agent-name record (see below)
// A missing transcript for --resume <id> behaves like the real CLI: stderr "No conversation found", exit 1.
// A worker run (bin\spawn-worker.ps1: a new session with --session-id <id> and no --resume) prints a success result
// with that session id, a cost and token counts, and its start record also holds the exact arguments.
// Phase 7 (each gated by a call that no older test makes):
//   -p with no value (the next argument starts with --, or -p is last): the prompt is standard input, as Pleni's Send
//   and the relay's agent turns pass it. Such a call also logs its arguments and RELAY_AGENT_NAME, RELAY_AGENT_MAILBOX,
//   RELAY_AGENT_FOLDER and RELAY_MAIL_HOP (no key). An agent's mail turn (-p --resume <id>, the notice on standard
//   input) takes the resume branch: the notice goes into the transcript, and wrong-session, die-after-transcript,
//   fail and sleep:<s> work for it as for a coordinator turn.
//   A new session (--session-id, no --resume) with --name and a [bridge-relay A...] notice on standard input is a new
//   agent's first turn: it writes <config>\projects\<its folder, each other mark as ->\<id>.jsonl with the notice, an
//   agent-name record (not in mode no-title) and a reply, then prints a success result that cost 0.01. Its folder is
//   RELAY_AGENT_FOLDER (the relay sets it), else the folder it runs in.
//   Every start record also says whether the prompt came on standard input (stdin_prompt) and holds the --name value
//   (name_flag, null without one).
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
const pv = (pi >= 0 && pi + 1 < argv.length) ? argv[pi + 1] : null;
const fromStdin = pi >= 0 && (pv === null || /^--[a-z]/.test(pv));
let prompt = pv ?? '';
if (fromStdin) { try { prompt = fs.readFileSync(0, 'utf8'); } catch (e) { prompt = ''; } }
const resume = opt('--resume');
const sessionIdFlag = opt('--session-id');
const worker = !resume && !!sessionIdFlag;
const newAgent = worker && fromStdin && argv.includes('--name') && /\[bridge-relay A/.test(prompt);
const relayEnv = fromStdin ? {
  name: process.env.RELAY_AGENT_NAME || '', mailbox: process.env.RELAY_AGENT_MAILBOX || '',
  folder: process.env.RELAY_AGENT_FOLDER || '', hop: process.env.RELAY_MAIL_HOP || ''
} : undefined;
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
  oauth_absent: !process.env.CLAUDE_CODE_OAUTH_TOKEN, cwd: process.cwd(),
  stdin_prompt: fromStdin, relay_env: relayEnv, name_flag: opt('--name'), args: (worker || fromStdin) ? argv : undefined
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
} else if (newAgent && !cfgDir) {
  // Never a session file outside the fixture's own config folder.
  finish(1, 'no-config', null, 'Error: RELAY_STUB_CONFIG_DIR is not set, so the stub has no folder for a new session');
} else if (newAgent) {
  const folder = process.env.RELAY_AGENT_FOLDER || process.cwd();
  const dir = path.join(cfgDir, 'projects', folder.replace(/[^A-Za-z0-9]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, sessionIdFlag + '.jsonl');
  fs.appendFileSync(file, JSON.stringify({ type: 'user', sessionId: sessionIdFlag, message: { role: 'user', content: prompt } }) + '\n');
  if (mode !== 'no-title') fs.appendFileSync(file, JSON.stringify({ type: 'agent-name', agentName: opt('--name') || '', sessionId: sessionIdFlag }) + '\n');
  const sm = /^sleep:(\d+)$/.exec(mode);
  if (sm) sleep(Number(sm[1]) * 1000);   // a slow first turn (scenario 33: a relay stop while it runs)
  const res = {
    type: 'result', subtype: 'success', is_error: false, duration_ms: Date.now() - start, num_turns: 1,
    result: 'stub new agent ready ' + (m ? m[1] : ''), session_id: sessionIdFlag, total_cost_usd: 0.01
  };
  fs.appendFileSync(file, JSON.stringify({ type: 'assistant', sessionId: sessionIdFlag, message: { role: 'assistant', content: res.result } }) + '\n');
  finish(0, 'ok', res, null);
} else if (worker) {
  const sm = /^sleep:(\d+)$/.exec(mode);
  if (sm) sleep(Number(sm[1]) * 1000);
  finish(0, 'ok', {
    type: 'result', subtype: 'success', is_error: false, duration_ms: Date.now() - start, num_turns: 2,
    result: 'stub worker run done', session_id: sessionIdFlag, total_cost_usd: 0.05,
    usage: { input_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000, output_tokens: 50 },
    modelUsage: { 'claude-opus-5-5': { inputTokens: 10, outputTokens: 50, cacheReadInputTokens: 1000, cacheCreationInputTokens: 100 } }
  }, null);
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
