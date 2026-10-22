import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { QR_MAX_BYTES, qrCode, qrSvg } from '../public/qr.js';

// The expected codes come from Project Nayuki's QR code generator (byte mode, level M, no boost),
// which Pleni's follows. A QR reader (zxing) read Pleni's codes back as well when they were made.
const PLENI = [
  '#######..####.#######',
  '#.....#.......#.....#',
  '#.###.#.#..#..#.###.#',
  '#.###.#.#...#.#.###.#',
  '#.###.#.#.#.#.#.###.#',
  '#.....#.#.##..#.....#',
  '#######.#.#.#.#######',
  '........###..........',
  '#.#####..#.#..#####..',
  '#.##.....#.####..#..#',
  '#..#.##.###.#.##..##.',
  '##.###.###.####..##..',
  '#.#.###.###.#..#.....',
  '........#.#.#..#.###.',
  '#######..###.#..####.',
  '#.....#.##.....#####.',
  '#.###.#.####.#..#..#.',
  '#.###.#.#.######.#...',
  '#.###.#.#...#.##.....',
  '#.....#..#.####..##..',
  '#######.#.#.#..##..#.',
];

const picture = (code) => code.dark.map((row) => row.map((d) => (d ? '#' : '.')).join(''));
const hash = (code) => crypto.createHash('sha256').update(code.dark.map((row) => row.map((d) => (d ? 1 : 0)).join('')).join('\n')).digest('hex');

test('a short text makes the same QR code as the reference', () => {
  const code = qrCode('Pleni');
  assert.equal(code.version, 1);
  assert.equal(code.mask, 2);
  assert.equal(code.size, 21);
  assert.deepEqual(picture(code), PLENI);
});

test('addresses and longer texts match the reference too, up to version 10', () => {
  const cases = [
    ['http://192.168.1.23:8790/', 2, 5, 'be84914db0118353307e4c1ee2c23cc2deb2f22a59ceb07232126f2941e4f697'],
    ['http://10.0.0.5:8790/', 2, 5, '27ae0ffd60360eb489252ddb681b63f514252d2e54b10762b78e54b1a14da152'],
    ['u'.repeat(122), 7, 1, '033ab7ae61a068f94b1f91b75c6e5b687bbf7901573689d33293c0eec60cbf7b'],
    [`${'Pleni, made by 8 West Ventures, LLC. '.repeat(5)}${'x'.repeat(13)}`, 10, 2, 'dc4c2a60f72bf14f832c3647714a9c207a3380228f1f97690c190fd86f8271a8'],
  ];
  for (const [text, version, mask, sha] of cases) {
    const code = qrCode(text);
    assert.equal(code.version, version, text);
    assert.equal(code.mask, mask, text);
    assert.equal(code.size, version * 4 + 17, text);
    assert.equal(hash(code), sha, text);
  }
});

test('each version holds what the standard says, and longer text is refused', () => {
  const sizes = [[14, 1], [15, 2], [26, 2], [27, 3], [42, 3], [43, 4], [62, 4], [84, 5], [106, 6], [122, 7], [152, 8], [180, 9], [181, 10], [213, 10]];
  for (const [length, version] of sizes) assert.equal(qrCode('x'.repeat(length)).version, version, String(length));
  assert.equal(QR_MAX_BYTES, 213);
  assert.throws(() => qrCode('x'.repeat(214)), RangeError);
  // Bytes count, not characters: é is two bytes in UTF-8.
  assert.equal(qrCode('é'.repeat(7)).version, 1);
  assert.equal(qrCode('é'.repeat(8)).version, 2);
});

test('the SVG has a light quiet zone, dark squares, and a label for screen readers', () => {
  const svg = qrSvg('http://192.168.1.23:8790/', { label: 'QR code for "Pleni" & more' });
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" class="qr" viewBox="0 0 33 33" role="img" aria-label="QR code for &quot;Pleni&quot; &amp; more" shape-rendering="crispEdges">/);
  assert.ok(svg.includes('<rect width="33" height="33" fill="#fff"/>'));
  const squares = svg.match(/M\d+,\d+h1v1h-1z/g);
  const dark = qrCode('http://192.168.1.23:8790/').dark.flat().filter(Boolean).length;
  assert.equal(squares.length, dark);
  // The first square is the top-left corner of a finder pattern, inside the four-module border.
  assert.equal(squares[0], 'M4,4h1v1h-1z');
  assert.ok(!/<script|on\w+=/i.test(svg));
});
