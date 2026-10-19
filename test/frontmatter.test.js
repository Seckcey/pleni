import { test } from 'node:test';
import assert from 'node:assert/strict';
import { frontmatterText, removeFrontmatterKey, scanFrontmatter, setFrontmatterValue, yamlValue } from '../src/frontmatter.js';

const AGENT = [
  '---',
  'name: coder',
  'description: "Coding and design work. Use it for \\"real\\" code."',
  'tools: Read, Grep, Bash',
  'model: opus # the strong one',
  'skills:',
  '  - review',
  '---',
  '',
  'You write code.',
  'model: this line is not in the block',
  '',
].join('\n');

function items(text) {
  const scan = scanFrontmatter(text);
  assert.equal(scan.ok, true);
  return scan.items;
}

test('scanFrontmatter reads the keys of the block at the top, and nothing below it', () => {
  const list = items(AGENT);
  assert.deepEqual(list.map((it) => [it.key, it.text, it.simple]), [
    ['name', 'coder', true],
    ['description', 'Coding and design work. Use it for "real" code.', true],
    ['tools', 'Read, Grep, Bash', true],
    ['model', 'opus', true],
    ['skills', null, false],
  ]);
  assert.deepEqual(frontmatterText(list, 'model'), { found: true, text: 'opus', editable: true });
  assert.deepEqual(frontmatterText(list, 'effort'), { found: false, text: null, editable: true });
  assert.deepEqual(frontmatterText(list, 'skills'), { found: true, text: null, editable: false });
});

test('scanFrontmatter gives up on a file without a block at the top, or one that never ends', () => {
  for (const bad of ['You write code.\n', '---\nname: coder\n', '\n---\nname: x\n---\n', '---\n  indented: first\n---\n', '---\nnot a key line\n---\n']) {
    assert.equal(scanFrontmatter(bad).ok, false, JSON.stringify(bad));
  }
  assert.equal(scanFrontmatter('﻿---\r\nname: x\r\n---\r\n').ok, true);
  assert.deepEqual(frontmatterText(items("---\nname: 'it''s'\nmodel: |\n  opus\n---\n"), 'name'), { found: true, text: "it's", editable: true });
  assert.equal(frontmatterText(items('---\nmodel: a\nmodel: b\n---\n'), 'model').editable, false);
});

test('setFrontmatterValue changes only the value, and keeps the comment after it', () => {
  const out = setFrontmatterValue(AGENT, 'model', 'sonnet');
  assert.equal(out.text, AGENT.replace('model: opus # the strong one', 'model: sonnet # the strong one'));
  const quoted = setFrontmatterValue(AGENT, 'model', 'opus[1m]');
  assert.ok(quoted.text.includes('model: "opus[1m]" # the strong one'));
  assert.equal(frontmatterText(items(quoted.text), 'model').text, 'opus[1m]');
});

test('setFrontmatterValue adds a new key just before the end of the block', () => {
  const out = setFrontmatterValue(AGENT, 'effort', 'high');
  assert.equal(out.text, AGENT.replace('  - review\n---\n', '  - review\neffort: high\n---\n'));
  const crlf = '---\r\nname: x\r\n---\r\nBody\r\n';
  assert.equal(setFrontmatterValue(crlf, 'model', 'haiku').text, '---\r\nname: x\r\nmodel: haiku\r\n---\r\nBody\r\n');
});

test('setFrontmatterValue and removeFrontmatterKey refuse what they cannot do safely', () => {
  assert.deepEqual(setFrontmatterValue('No block here.\n', 'model', 'x'), { ok: false, error: 'unreadable' });
  assert.deepEqual(setFrontmatterValue(AGENT, 'skills', 'x'), { ok: false, error: 'not-simple' });
  assert.deepEqual(setFrontmatterValue(AGENT, 'model', ''), { ok: false, error: 'bad' });
  assert.deepEqual(setFrontmatterValue(AGENT, 'model', 'two\nlines'), { ok: false, error: 'bad' });
  assert.deepEqual(setFrontmatterValue(AGENT, 'bad key', 'x'), { ok: false, error: 'bad' });
  assert.deepEqual(removeFrontmatterKey(AGENT, 'skills'), { ok: false, error: 'not-simple' });
});

test('removeFrontmatterKey takes out the whole line, and nothing below the block', () => {
  const out = removeFrontmatterKey(AGENT, 'model');
  assert.equal(out.text, AGENT.replace('model: opus # the strong one\n', ''));
  assert.ok(out.text.includes('model: this line is not in the block'));
  assert.deepEqual(removeFrontmatterKey(AGENT, 'effort'), { ok: true, text: AGENT });
});

test('yamlValue quotes what YAML would read another way', () => {
  assert.equal(yamlValue('claude-opus-5-5'), 'claude-opus-5-5');
  assert.equal(yamlValue('opus[1m]'), '"opus[1m]"');
  assert.equal(yamlValue('yes'), '"yes"');
  assert.equal(yamlValue('Coding: and "design"'), '"Coding: and \\"design\\""');
});
