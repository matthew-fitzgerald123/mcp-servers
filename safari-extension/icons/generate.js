/**
 * Generates minimal PNG icons for the extension using pure Node.js (no dependencies).
 * Run once: node icons/generate.js
 */
import { createWriteStream } from 'fs';
import { deflateSync } from 'zlib';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

function u32(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n); return b;
}

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) {
    c ^= byte;
    for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const t = Buffer.from(type, 'ascii');
  const c = Buffer.concat([t, data]);
  return Buffer.concat([u32(data.length), c, u32(crc32(c))]);
}

function makePng(size, r, g, b) {
  // PNG signature
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  // IHDR: width, height, bit depth 8, color type 2 (RGB), compression 0, filter 0, interlace 0
  const ihdr = chunk('IHDR', Buffer.concat([u32(size), u32(size),
    Buffer.from([8, 2, 0, 0, 0])]));

  // Raw scanlines: filter byte 0 + RGB pixels
  const row = Buffer.alloc(1 + size * 3);
  row[0] = 0; // filter type None
  for (let x = 0; x < size; x++) {
    row[1 + x * 3]     = r;
    row[1 + x * 3 + 1] = g;
    row[1 + x * 3 + 2] = b;
  }
  const raw = Buffer.concat(Array(size).fill(row));

  const idat = chunk('IDAT', deflateSync(raw));
  const iend = chunk('IEND', Buffer.alloc(0));

  return Buffer.concat([sig, ihdr, idat, iend]);
}

// LinkedIn blue: #0a66c2
const [R, G, B] = [10, 102, 194];

for (const size of [16, 48, 128]) {
  const out  = join(__dirname, `icon${size}.png`);
  const data = makePng(size, R, G, B);
  createWriteStream(out).end(data);
  console.log(`wrote icon${size}.png`);
}
