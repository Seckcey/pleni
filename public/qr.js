// A small QR code maker for Pleni's own addresses, so a phone can open Pleni by pointing its camera
// at the screen. It makes byte-mode codes with medium error correction (level M), versions 1 to 10:
// up to 213 bytes, plenty for an address. It follows ISO/IEC 18004; the steps and tables are the
// standard ones, as in Project Nayuki's public QR code generator.

const ECC_PER_BLOCK = [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
const BLOCKS = [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5];
const MAX_VERSION = 10;
const FORMAT_M = 0;

// The modules (squares) a version has for data and error correction, after the fixed patterns.
function rawModules(version) {
  let n = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const align = Math.floor(version / 7) + 2;
    n -= (25 * align - 10) * align - 55;
    if (version >= 7) n -= 36;
  }
  return n;
}

function dataBytes(version) {
  return Math.floor(rawModules(version) / 8) - ECC_PER_BLOCK[version] * BLOCKS[version];
}

// The most bytes of text each version holds: the mode (4 bits) and the length (8 or 16 bits) come first.
function capacity(version) {
  return Math.floor((dataBytes(version) * 8 - 4 - (version < 10 ? 8 : 16)) / 8);
}

export const QR_MAX_BYTES = capacity(MAX_VERSION);

// ---- Reed-Solomon error correction over GF(256) ----

function gfMultiply(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}

function rsDivisor(degree) {
  const result = new Array(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = gfMultiply(result[j], root);
      if (j + 1 < degree) result[j] ^= result[j + 1];
    }
    root = gfMultiply(root, 2);
  }
  return result;
}

function rsRemainder(data, divisor) {
  const result = new Array(divisor.length).fill(0);
  for (const b of data) {
    const factor = b ^ result.shift();
    result.push(0);
    divisor.forEach((coef, i) => {
      result[i] ^= gfMultiply(coef, factor);
    });
  }
  return result;
}

// ---- the bits: mode, length, text, padding, then error correction, interleaved ----

function codewords(bytes, version) {
  const bits = [];
  const put = (value, length) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  put(0b0100, 4);
  put(bytes.length, version < 10 ? 8 : 16);
  for (const b of bytes) put(b, 8);
  const room = dataBytes(version) * 8;
  put(0, Math.min(4, room - bits.length));
  put(0, (8 - (bits.length % 8)) % 8);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((n, bit) => (n << 1) | bit, 0));
  for (let pad = 0xec; data.length < dataBytes(version); pad ^= 0xec ^ 0x11) data.push(pad);

  const blocks = BLOCKS[version];
  const eccLength = ECC_PER_BLOCK[version];
  const total = Math.floor(rawModules(version) / 8);
  const shortBlocks = blocks - (total % blocks);
  const shortLength = Math.floor(total / blocks);
  const divisor = rsDivisor(eccLength);
  const parts = [];
  for (let i = 0, k = 0; i < blocks; i++) {
    const part = data.slice(k, k + shortLength - eccLength + (i < shortBlocks ? 0 : 1));
    k += part.length;
    const ecc = rsRemainder(part, divisor);
    if (i < shortBlocks) part.push(0);
    parts.push(part.concat(ecc));
  }
  const out = [];
  for (let i = 0; i < parts[0].length; i++) {
    parts.forEach((part, j) => {
      if (i !== shortLength - eccLength || j >= shortBlocks) out.push(part[i]);
    });
  }
  return out;
}

// ---- the picture ----

function alignmentPositions(version, size) {
  if (version === 1) return [];
  const count = Math.floor(version / 7) + 2;
  const step = Math.ceil((version * 4 + 4) / (count * 2 - 2)) * 2;
  const out = [6];
  for (let pos = size - 7; out.length < count; pos -= step) out.splice(1, 0, pos);
  return out;
}

function makeGrid(version) {
  const size = version * 4 + 17;
  const dark = Array.from({ length: size }, () => new Array(size).fill(false));
  const fixed = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (x, y, on) => {
    dark[y][x] = on;
    fixed[y][x] = true;
  };
  for (let i = 0; i < size; i++) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        const ring = Math.max(Math.abs(dx), Math.abs(dy));
        if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, ring !== 2 && ring !== 4);
      }
    }
  }
  const align = alignmentPositions(version, size);
  const last = align.length - 1;
  align.forEach((ay, i) => {
    align.forEach((ax, j) => {
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) set(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    });
  });
  const grid = { size, dark, fixed, set };
  drawFormat(grid, 0);
  if (version >= 7) {
    let rem = version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const on = ((bits >>> i) & 1) === 1;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      set(a, b, on);
      set(b, a, on);
    }
  }
  return grid;
}

function drawFormat({ size, set }, mask) {
  const data = (FORMAT_M << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = ((data << 10) | rem) ^ 0x5412;
  const bit = (i) => ((bits >>> i) & 1) === 1;
  for (let i = 0; i <= 5; i++) set(8, i, bit(i));
  set(8, 7, bit(6));
  set(8, 8, bit(7));
  set(7, 8, bit(8));
  for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
  for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
  set(8, size - 8, true);
}

function drawData({ size, dark, fixed }, words) {
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!fixed[y][x] && i < words.length * 8) {
          dark[y][x] = ((words[i >>> 3] >>> (7 - (i & 7))) & 1) === 1;
          i++;
        }
      }
    }
  }
}

const MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

function applyMask({ size, dark, fixed }, mask) {
  const flip = MASKS[mask];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) if (!fixed[y][x] && flip(x, y)) dark[y][x] = !dark[y][x];
  }
}

// The standard's penalty for patterns that make a code hard to read; the lowest one is used.
function penalty({ size, dark }) {
  let score = 0;
  const line = (get) => {
    let color = false;
    let run = 0;
    const history = [0, 0, 0, 0, 0, 0, 0];
    const add = (length) => {
      if (history[0] === 0) length += size;
      history.pop();
      history.unshift(length);
    };
    const finders = () => {
      const n = history[1];
      const core = n > 0 && history[2] === n && history[3] === n * 3 && history[4] === n && history[5] === n;
      return (core && history[0] >= n * 4 && history[6] >= n ? 1 : 0) + (core && history[6] >= n * 4 && history[0] >= n ? 1 : 0);
    };
    for (let i = 0; i < size; i++) {
      if (get(i) === color) {
        run++;
        if (run === 5) score += 3;
        else if (run > 5) score++;
      } else {
        add(run);
        if (!color) score += finders() * 40;
        color = get(i);
        run = 1;
      }
    }
    if (color) {
      add(run);
      run = 0;
    }
    add(run + size);
    score += finders() * 40;
  };
  for (let y = 0; y < size; y++) line((x) => dark[y][x]);
  for (let x = 0; x < size; x++) line((y) => dark[y][x]);
  let count = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (dark[y][x]) count++;
      if (x < size - 1 && y < size - 1) {
        const c = dark[y][x];
        if (c === dark[y][x + 1] && c === dark[y + 1][x] && c === dark[y + 1][x + 1]) score += 3;
      }
    }
  }
  const total = size * size;
  score += (Math.ceil(Math.abs(count * 20 - total * 10) / total) - 1) * 10;
  return score;
}

// The QR code for `text`: { version, mask, size, dark } where dark[y][x] is true for a dark module.
// `mask` picks one of the eight masks; without it, the one the standard prefers is used. Text
// longer than QR_MAX_BYTES (in UTF-8) throws.
export function qrCode(text, { mask } = {}) {
  const bytes = [...new TextEncoder().encode(String(text))];
  let version = 1;
  while (version <= MAX_VERSION && capacity(version) < bytes.length) version++;
  if (version > MAX_VERSION) throw new RangeError(`A QR code here holds at most ${QR_MAX_BYTES} bytes.`);
  const grid = makeGrid(version);
  drawData(grid, codewords(bytes, version));
  let best = Number.isInteger(mask) && mask >= 0 && mask < 8 ? mask : -1;
  if (best < 0) {
    let lowest = Infinity;
    for (let m = 0; m < 8; m++) {
      applyMask(grid, m);
      drawFormat(grid, m);
      const score = penalty(grid);
      if (score < lowest) {
        lowest = score;
        best = m;
      }
      applyMask(grid, m);
    }
  }
  applyMask(grid, best);
  drawFormat(grid, best);
  return { version, mask: best, size: grid.size, dark: grid.dark };
}

// The QR code as an SVG picture: dark squares on a light background, with the four-module quiet
// zone around it that cameras need. `label` names it for screen readers.
export function qrSvg(text, { label = 'QR code' } = {}) {
  const { size, dark } = qrCode(text);
  const border = 4;
  const side = size + border * 2;
  const path = [];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) if (dark[y][x]) path.push(`M${x + border},${y + border}h1v1h-1z`);
  }
  const name = String(label).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  return `<svg xmlns="http://www.w3.org/2000/svg" class="qr" viewBox="0 0 ${side} ${side}" role="img" aria-label="${name}" shape-rendering="crispEdges">` +
    `<rect width="${side}" height="${side}" fill="#fff"/><path fill="#000" d="${path.join('')}"/></svg>`;
}
