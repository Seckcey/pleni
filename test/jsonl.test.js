import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JsonlTail, readHeadLine, readJsonFile, scanHead, stripBom } from '../src/jsonl.js';

function tempFile(t, name = 'session.jsonl') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pleni-jsonl-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, name);
}

const line = (record) => `${JSON.stringify(record)}\n`;

// Every line is exactly 20 bytes (for n from 10 to 99), so byte positions are easy to reason about.
const fixedLine = (n) => `{"n":${n},"pad":"xx"}\n`;

test('a partial last line waits for its newline', (t) => {
  const file = tempFile(t);
  fs.writeFileSync(file, '{"a":1}\n{"b":');
  const tail = new JsonlTail(file);

  const first = tail.read();
  assert.deepEqual(first.records, [{ a: 1 }]);
  assert.equal(first.reset, false);
  assert.equal(first.size, 13);
  assert.equal(tail.offset, 8);

  fs.appendFileSync(file, '2');
  assert.deepEqual(tail.read().records, []);
  assert.equal(tail.offset, 8);

  fs.appendFileSync(file, '}\n');
  assert.deepEqual(tail.read().records, [{ b: 2 }]);
  assert.equal(tail.offset, 16);
  assert.equal(tail.badLines, 0);
});

test('appended data is read incrementally', (t) => {
  const file = tempFile(t);
  fs.writeFileSync(file, line({ n: 1 }) + line({ n: 2 }));
  const tail = new JsonlTail(file);
  assert.equal(tail.offset, 0);
  assert.deepEqual(tail.read().records, [{ n: 1 }, { n: 2 }]);

  fs.appendFileSync(file, line({ n: 3 }));
  const next = tail.read();
  assert.deepEqual(next.records, [{ n: 3 }]);
  assert.equal(next.reset, false);
  assert.equal(tail.offset, fs.statSync(file).size);

  const idle = tail.read();
  assert.deepEqual(idle.records, []);
  assert.equal(idle.reset, false);
});

test('a file that shrank is read again from the start', (t) => {
  const file = tempFile(t);
  fs.writeFileSync(file, line({ n: 1 }) + line({ n: 2 }) + line({ n: 3 }));
  const tail = new JsonlTail(file);
  tail.read();

  fs.writeFileSync(file, line({ n: 9 }));
  const result = tail.read();
  assert.equal(result.reset, true);
  assert.deepEqual(result.records, [{ n: 9 }]);
  assert.equal(tail.offset, fs.statSync(file).size);

  fs.appendFileSync(file, line({ n: 10 }));
  const after = tail.read();
  assert.equal(after.reset, false);
  assert.deepEqual(after.records, [{ n: 10 }]);
});

test('a replaced file is read again from the start', (t) => {
  const file = tempFile(t);
  fs.writeFileSync(file, line({ old: 1 }));
  const tail = new JsonlTail(file);
  assert.deepEqual(tail.read().records, [{ old: 1 }]);

  // The new file is bigger than the old one, so only its identity tells them apart.
  const replacement = `${file}.new`;
  fs.writeFileSync(replacement, line({ fresh: 1 }) + line({ fresh: 2 }) + line({ fresh: 3 }));
  fs.renameSync(replacement, file);

  const result = tail.read();
  assert.equal(result.reset, true);
  assert.deepEqual(result.records, [{ fresh: 1 }, { fresh: 2 }, { fresh: 3 }]);
});

test('a missing file gives no records and no error', (t) => {
  const file = tempFile(t);
  const tail = new JsonlTail(file);
  assert.deepEqual(tail.read(), { records: [], reset: false, size: 0 });

  fs.writeFileSync(file, line({ n: 1 }));
  assert.deepEqual(tail.read().records, [{ n: 1 }]);
});

test('a big file starts near the end and drops the partial first line', (t) => {
  const file = tempFile(t);
  let text = '';
  for (let n = 10; n < 25; n++) text += fixedLine(n);
  fs.writeFileSync(file, text); // 300 bytes

  // Starts at byte 210, inside the line for 20: that line is dropped.
  const tail = new JsonlTail(file, { maxInitialBytes: 90 });
  const result = tail.read();
  assert.deepEqual(result.records.map((r) => r.n), [21, 22, 23, 24]);
  assert.equal(result.reset, false);
  assert.equal(tail.badLines, 0);

  fs.appendFileSync(file, fixedLine(25));
  assert.deepEqual(tail.read().records.map((r) => r.n), [25]);
});

test('a big file keeps the first line when the start is right after a newline', (t) => {
  const file = tempFile(t);
  let text = '';
  for (let n = 10; n < 25; n++) text += fixedLine(n);
  fs.writeFileSync(file, text);

  // Starts at byte 200, the first byte of the line for 20.
  const tail = new JsonlTail(file, { maxInitialBytes: 100 });
  assert.deepEqual(tail.read().records.map((r) => r.n), [20, 21, 22, 23, 24]);
});

test('a reset on a big file also starts near the end', (t) => {
  const file = tempFile(t);
  fs.writeFileSync(file, fixedLine(11));
  const tail = new JsonlTail(file, { maxInitialBytes: 90 });
  tail.read();

  let text = '';
  for (let n = 40; n < 55; n++) text += fixedLine(n);
  const replacement = `${file}.new`;
  fs.writeFileSync(replacement, text);
  fs.renameSync(replacement, file);

  const result = tail.read();
  assert.equal(result.reset, true);
  assert.deepEqual(result.records.map((r) => r.n), [51, 52, 53, 54]);
});

test('CRLF line endings are accepted', (t) => {
  const file = tempFile(t);
  fs.writeFileSync(file, '{"a":1}\r\n{"b":2}\r\n');
  const tail = new JsonlTail(file);
  assert.deepEqual(tail.read().records, [{ a: 1 }, { b: 2 }]);
  assert.equal(tail.badLines, 0);
});

test('U+2028 and U+2029 inside JSON strings do not split a line', (t) => {
  const file = tempFile(t);
  const text = 'one two three';
  fs.writeFileSync(file, `{"text":"${text}"}\n{"next":true}\n`);
  const tail = new JsonlTail(file);
  assert.deepEqual(tail.read().records, [{ text }, { next: true }]);
  assert.equal(tail.badLines, 0);
});

test('a multi-byte character split across read chunks stays intact', (t) => {
  const file = tempFile(t);
  // '{"t":"' is 6 bytes; the first euro sign (3 bytes) starts at byte 1048575.
  const pad = 'a'.repeat(1048575 - 6);
  fs.writeFileSync(file, `{"t":"${pad}€€€"}\n`);
  const tail = new JsonlTail(file);
  const [record] = tail.read().records;
  assert.equal(record.t, `${pad}€€€`);
  assert.equal(tail.badLines, 0);
});

test('invalid lines are skipped and counted; blank lines are ignored', (t) => {
  const file = tempFile(t);
  fs.writeFileSync(file, '{"a":1}\nnot json\n[1,2]\n42\n\n   \n{"b":2}\n');
  const tail = new JsonlTail(file);
  assert.deepEqual(tail.read().records, [{ a: 1 }, { b: 2 }]);
  assert.equal(tail.badLines, 3);
});

test('a line longer than maxLineBytes is skipped but passed over', (t) => {
  const file = tempFile(t);
  const long = line({ text: 'x'.repeat(200) });
  fs.writeFileSync(file, line({ n: 1 }) + long + line({ n: 3 }));
  const tail = new JsonlTail(file, { maxLineBytes: 50 });
  assert.deepEqual(tail.read().records, [{ n: 1 }, { n: 3 }]);
  assert.equal(tail.badLines, 1);
  assert.equal(tail.offset, fs.statSync(file).size);
});

test('a long line that arrives in pieces is counted once', (t) => {
  const file = tempFile(t);
  fs.writeFileSync(file, `${line({ n: 1 })}{"text":"${'x'.repeat(30)}`);
  const tail = new JsonlTail(file, { maxLineBytes: 50 });
  assert.deepEqual(tail.read().records, [{ n: 1 }]);
  assert.equal(tail.badLines, 0);

  fs.appendFileSync(file, 'x'.repeat(40));
  assert.deepEqual(tail.read().records, []);
  assert.equal(tail.badLines, 1);
  assert.equal(tail.offset, fs.statSync(file).size);

  fs.appendFileSync(file, `${'x'.repeat(40)}"}\n${line({ n: 3 })}`);
  assert.deepEqual(tail.read().records, [{ n: 3 }]);
  assert.equal(tail.badLines, 1);
});

test('a byte order mark at the start is ignored', (t) => {
  const file = tempFile(t);
  fs.writeFileSync(file, '﻿{"a":1}\n{"b":2}\n');
  const tail = new JsonlTail(file);
  assert.deepEqual(tail.read().records, [{ a: 1 }, { b: 2 }]);
  assert.equal(tail.badLines, 0);
});

test('stripBom removes only a leading byte order mark', () => {
  assert.equal(stripBom('﻿{"a":1}'), '{"a":1}');
  assert.equal(stripBom('{"a":1}'), '{"a":1}');
  assert.equal(stripBom('a﻿'), 'a﻿');
  assert.equal(stripBom(''), '');
  assert.equal(stripBom(null), null);
});

test('readJsonFile tolerates a BOM and returns null for anything else', (t) => {
  const file = tempFile(t, 'meta.json');
  fs.writeFileSync(file, '﻿{"agentType":"general","spawnDepth":1}');
  assert.deepEqual(readJsonFile(file), { agentType: 'general', spawnDepth: 1 });

  fs.writeFileSync(file, '{"broken":');
  assert.equal(readJsonFile(file), null);
  fs.writeFileSync(file, '[1,2,3]');
  assert.equal(readJsonFile(file), null);
  assert.equal(readJsonFile(`${file}.missing`), null);
});

test('readHeadLine reads a 5 MB first line', (t) => {
  const file = tempFile(t);
  const blob = 'x'.repeat(5 * 1024 * 1024);
  fs.writeFileSync(file, line({ type: 'session_meta', payload: { id: 'abc', blob } }) + line({ type: 'event_msg' }));
  const head = readHeadLine(file);
  assert.equal(head.type, 'session_meta');
  assert.equal(head.payload.id, 'abc');
  assert.equal(head.payload.blob.length, blob.length);

  assert.equal(readHeadLine(file, 1024 * 1024), null);
});

test('readHeadLine needs a finished, valid first line', (t) => {
  const file = tempFile(t);
  assert.equal(readHeadLine(file), null);

  fs.writeFileSync(file, '{"type":"session_meta"}');
  assert.equal(readHeadLine(file), null);

  fs.writeFileSync(file, '﻿{"type":"session_meta"}\r\n{"type":"x"}\n');
  assert.deepEqual(readHeadLine(file), { type: 'session_meta' });

  fs.writeFileSync(file, 'nope\n{"type":"x"}\n');
  assert.equal(readHeadLine(file), null);

  const exact = '{"a":"bcd"}';
  fs.writeFileSync(file, `${exact}\n`);
  assert.deepEqual(readHeadLine(file, exact.length), { a: 'bcd' });
  assert.equal(readHeadLine(file, exact.length - 1), null);
});

test('scanHead returns matching complete lines from the start of a file', (t) => {
  const file = tempFile(t);
  const records = [
    { type: 'user', n: 1 },
    { type: 'ai-title', aiTitle: 'First' },
    { type: 'assistant', n: 2 },
    { type: 'ai-title', aiTitle: 'Second' },
  ];
  const text = `﻿${records.map(line).join('')}garbage\n`;
  fs.writeFileSync(file, text);

  const titles = scanHead(file, 1024 * 1024, (r) => r.type === 'ai-title');
  assert.deepEqual(titles.map((r) => r.aiTitle), ['First', 'Second']);
  assert.equal(scanHead(file, 1024 * 1024).length, 4);

  // Cut inside the last ai-title line: that line is not complete, so it is left out.
  const cut = Buffer.byteLength(`﻿${records.slice(0, 3).map(line).join('')}`) + 5;
  const partial = scanHead(file, cut, (r) => r.type === 'ai-title');
  assert.deepEqual(partial.map((r) => r.aiTitle), ['First']);

  assert.deepEqual(scanHead(`${file}.missing`, 1024, () => true), []);
});
