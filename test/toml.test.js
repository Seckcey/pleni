import { test } from 'node:test';
import assert from 'node:assert/strict';
import { removeTomlKey, scanToml, setTomlText, tomlString, tomlText } from '../src/toml.js';

const SAMPLE = [
  '# Codex settings',
  'model = "gpt-6-astra" # the default',
  "model_reasoning_effort = 'max'",
  'approval_policy = "on-request"',
  'notes = """',
  '[agents]',
  'model = "not a key"',
  '"""',
  'sandbox = [',
  '  "a", # a comment',
  '  "b]",',
  ']',
  'when = 1979-05-27 07:32:00Z',
  '',
  '[mcp_servers.docs]',
  'command = "npx"',
  'env = { KEY = "x}" }',
  '',
  '[agents]',
  'max_threads = 6',
  '',
].join('\n');

function values(text) {
  const scan = scanToml(text);
  assert.equal(scan.ok, true);
  return scan.items;
}

test('scanToml finds the statements and skips strings, arrays and comments', () => {
  const items = values(SAMPLE);
  const paths = items.map((it) => `${it.kind}:${it.path.join('.')}`);
  assert.deepEqual(paths, [
    'value:model',
    'value:model_reasoning_effort',
    'value:approval_policy',
    'value:notes',
    'value:sandbox',
    'value:when',
    'table:mcp_servers.docs',
    'value:mcp_servers.docs.command',
    'value:mcp_servers.docs.env',
    'table:agents',
    'value:agents.max_threads',
  ]);
  assert.deepEqual(tomlText(items, ['model']), { found: true, text: 'gpt-6-astra', editable: true });
  assert.deepEqual(tomlText(items, ['model_reasoning_effort']), { found: true, text: 'max', editable: true });
  assert.deepEqual(tomlText(items, ['notes']), { found: true, text: null, editable: false });
  assert.deepEqual(tomlText(items, ['agents', 'default_subagent_model']), { found: false, text: null, editable: true });
});

test('scanToml reads quoted and dotted keys, escapes, CRLF and a BOM', () => {
  const text = '﻿"model" = "gpt-6\\u002e1-sol"\r\nagents . default_subagent_model = \'gpt-6-astra\'\r\n';
  const items = values(text);
  assert.deepEqual(tomlText(items, ['model']), { found: true, text: 'gpt-6.1-sol', editable: true });
  assert.deepEqual(tomlText(items, ['agents', 'default_subagent_model']), { found: true, text: 'gpt-6-astra', editable: true });
});

test('scanToml gives up on what it cannot read', () => {
  for (const bad of ['model = "open', 'model = ', 'model "x"', '[agents', 'a = [1, 2', 'a = """never closed', 'a = "x" b = "y"', 'a = "line\nbreak"']) {
    assert.equal(scanToml(bad).ok, false, bad);
  }
  assert.equal(scanToml('').ok, true);
  assert.equal(scanToml('# only a comment').ok, true);
});

test('tomlText will not change a key that is there twice or sits inside another value', () => {
  assert.equal(tomlText(values('model = "a"\nmodel = "b"\n'), ['model']).editable, false);
  assert.equal(tomlText(values('model = 5\n'), ['model']).editable, false);
  assert.equal(tomlText(values('agents = { default_subagent_model = "a" }\n'), ['agents', 'default_subagent_model']).editable, false);
  assert.equal(tomlText(values('[[agents]]\nname = "a"\n'), ['agents', 'default_subagent_model']).editable, false);
  assert.equal(tomlText(values('[model]\nname = "a"\n'), ['model']).editable, false);
  assert.equal(tomlText(values('model.name = "a"\n'), ['model']).editable, false);
});

test('setTomlText changes only the value and keeps the comment after it', () => {
  const out = setTomlText(SAMPLE, ['model'], 'gpt-6.1-sol');
  assert.equal(out.ok, true);
  assert.equal(out.text, SAMPLE.replace('model = "gpt-6-astra" # the default', 'model = "gpt-6.1-sol" # the default'));
  const effort = setTomlText(SAMPLE, ['model_reasoning_effort'], 'high');
  assert.equal(effort.text, SAMPLE.replace("model_reasoning_effort = 'max'", 'model_reasoning_effort = "high"'));
});

test('setTomlText adds a key to a table right after its header', () => {
  const out = setTomlText(SAMPLE, ['agents', 'default_subagent_model'], 'gpt-6-astra');
  assert.equal(out.text, SAMPLE.replace('[agents]\nmax_threads', '[agents]\ndefault_subagent_model = "gpt-6-astra"\nmax_threads'));
  assert.deepEqual(tomlText(values(out.text), ['agents', 'default_subagent_model']), { found: true, text: 'gpt-6-astra', editable: true });
  // The multi-line string that holds "[agents]" is left alone.
  assert.ok(out.text.includes('notes = """\n[agents]\nmodel = "not a key"\n"""'));
});

test('setTomlText adds a top-level key after the other top-level values', () => {
  const text = 'approval_policy = "never"\n\n[agents]\nmax_threads = 6\n';
  assert.equal(setTomlText(text, ['model'], 'gpt-6.1-sol').text, 'approval_policy = "never"\nmodel = "gpt-6.1-sol"\n\n[agents]\nmax_threads = 6\n');
  assert.equal(setTomlText('[agents]\nmax_threads = 6\n', ['model'], 'x').text, 'model = "x"\n[agents]\nmax_threads = 6\n');
  assert.equal(setTomlText('', ['model'], 'x').text, 'model = "x"\n');
  assert.equal(setTomlText('approval_policy = "never"', ['model'], 'x').text, 'approval_policy = "never"\nmodel = "x"\n');
});

test('setTomlText makes a new table at the end when there is none', () => {
  assert.equal(setTomlText('model = "x"\n', ['agents', 'default_subagent_model'], 'y').text, 'model = "x"\n\n[agents]\ndefault_subagent_model = "y"\n');
  assert.equal(setTomlText('model = "x"', ['agents', 'default_subagent_model'], 'y').text, 'model = "x"\n\n[agents]\ndefault_subagent_model = "y"\n');
  assert.equal(setTomlText('', ['agents', 'default_subagent_model'], 'y').text, '[agents]\ndefault_subagent_model = "y"\n');
  // A table below it is fine: [agents] can still come after [agents.coder].
  const sub = '[agents.coder]\ndescription = "Code"\n';
  const out = setTomlText(sub, ['agents', 'default_subagent_model'], 'y');
  assert.equal(out.text, `${sub}\n[agents]\ndefault_subagent_model = "y"\n`);
  assert.equal(scanToml(out.text).ok, true);
});

test('setTomlText uses a dotted key when dotted keys already make the table', () => {
  const text = 'model = "x"\nagents.max_threads = 4\n\n[mcp_servers.docs]\ncommand = "npx"\n';
  const out = setTomlText(text, ['agents', 'default_subagent_model'], 'y');
  assert.equal(out.text, 'model = "x"\nagents.max_threads = 4\nagents.default_subagent_model = "y"\n\n[mcp_servers.docs]\ncommand = "npx"\n');
});

test('setTomlText keeps CRLF line breaks and the BOM', () => {
  const text = '﻿approval_policy = "never"\r\n[agents]\r\nmax_threads = 6\r\n';
  const top = setTomlText(text, ['model'], 'x').text;
  assert.equal(top, '﻿approval_policy = "never"\r\nmodel = "x"\r\n[agents]\r\nmax_threads = 6\r\n');
  const inner = setTomlText(top, ['agents', 'default_subagent_model'], 'y').text;
  assert.equal(inner, '﻿approval_policy = "never"\r\nmodel = "x"\r\n[agents]\r\ndefault_subagent_model = "y"\r\nmax_threads = 6\r\n');
  assert.equal(setTomlText('﻿', ['model'], 'x').text, '﻿model = "x"\n');
});

test('setTomlText refuses what it cannot do safely', () => {
  assert.deepEqual(setTomlText('model = "open', ['model'], 'x'), { ok: false, error: 'unreadable' });
  assert.deepEqual(setTomlText('model = 5\n', ['model'], 'x'), { ok: false, error: 'not-simple' });
  assert.deepEqual(setTomlText('model = "a"\nmodel = "b"\n', ['model'], 'x'), { ok: false, error: 'not-simple' });
  assert.deepEqual(setTomlText('agents = { max_threads = 2 }\n', ['agents', 'default_subagent_model'], 'x'), { ok: false, error: 'not-simple' });
  assert.deepEqual(setTomlText('', ['model'], 'line\nbreak'), { ok: false, error: 'bad' });
  assert.deepEqual(setTomlText('', ['a', 'b', 'c'], 'x'), { ok: false, error: 'bad' });
  assert.deepEqual(setTomlText('', ['bad key'], 'x'), { ok: false, error: 'bad' });
});

test('removeTomlKey takes out the whole line and nothing else', () => {
  const out = removeTomlKey(SAMPLE, ['model_reasoning_effort']);
  assert.equal(out.text, SAMPLE.replace("model_reasoning_effort = 'max'\n", ''));
  const inner = setTomlText(SAMPLE, ['agents', 'default_subagent_reasoning_effort'], 'high').text;
  assert.equal(removeTomlKey(inner, ['agents', 'default_subagent_reasoning_effort']).text, SAMPLE);
  assert.deepEqual(removeTomlKey(SAMPLE, ['agents', 'nothing_here']), { ok: true, text: SAMPLE });
  assert.equal(removeTomlKey('model = "x"', ['model']).text, '');
  assert.deepEqual(removeTomlKey('model = "a"\nmodel = "b"\n', ['model']), { ok: false, error: 'not-simple' });
});

test('tomlString escapes backslashes and quotes', () => {
  assert.equal(tomlString('gpt-6.1-sol'), '"gpt-6.1-sol"');
  assert.equal(tomlString('a"b\\c'), '"a\\"b\\\\c"');
});
