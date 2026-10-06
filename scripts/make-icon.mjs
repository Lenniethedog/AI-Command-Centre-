/**
 * Generates the app icon with no image dependencies.
 *
 * PNG is a short list of chunks wrapping deflated scanlines, so writing one
 * directly is a few dozen lines — cheaper than adding an image library for a
 * single build asset. macOS `sips` and `iconutil` do the rest.
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';

const SIZE = 1024;

// --- palette (matches the interface) ---------------------------------------
const BG_TOP = [19, 25, 38];
const BG_BOTTOM = [10, 13, 20];
const ACCENT = [91, 156, 255];
const MID = [88, 116, 176];
const DIM = [52, 66, 96];

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function png(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Signed distance to a rounded rectangle — gives us clean antialiased edges. */
function roundedRectDistance(x, y, cx, cy, halfW, halfH, radius) {
  const dx = Math.abs(x - cx) - (halfW - radius);
  const dy = Math.abs(y - cy) - (halfH - radius);
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
  return outside + Math.min(Math.max(dx, dy), 0) - radius;
}

const pixels = Buffer.alloc(SIZE * SIZE * 4);

// Three stacked bars: a pipeline of tasks, brightest at the top.
const bars = [
  { width: 0.58, colour: ACCENT, offset: -0.17 },
  { width: 0.44, colour: MID, offset: 0.0 },
  { width: 0.3, colour: DIM, offset: 0.17 },
];

for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const i = (y * SIZE + x) * 4;

    // Background: rounded square with a vertical gradient.
    const t = y / SIZE;
    let r = Math.round(BG_TOP[0] + (BG_BOTTOM[0] - BG_TOP[0]) * t);
    let g = Math.round(BG_TOP[1] + (BG_BOTTOM[1] - BG_TOP[1]) * t);
    let b = Math.round(BG_TOP[2] + (BG_BOTTOM[2] - BG_TOP[2]) * t);

    const bgDistance = roundedRectDistance(x, y, SIZE / 2, SIZE / 2, SIZE / 2, SIZE / 2, SIZE * 0.225);
    let alpha = Math.max(0, Math.min(1, 0.5 - bgDistance));

    // Bars composited on top.
    for (const bar of bars) {
      const halfW = (SIZE * bar.width) / 2;
      const halfH = SIZE * 0.055;
      const cy = SIZE / 2 + SIZE * bar.offset;
      const d = roundedRectDistance(x, y, SIZE / 2, cy, halfW, halfH, halfH);
      const coverage = Math.max(0, Math.min(1, 0.5 - d));
      if (coverage > 0) {
        r = Math.round(r * (1 - coverage) + bar.colour[0] * coverage);
        g = Math.round(g * (1 - coverage) + bar.colour[1] * coverage);
        b = Math.round(b * (1 - coverage) + bar.colour[2] * coverage);
        alpha = Math.max(alpha, coverage);
      }
    }

    pixels[i] = r;
    pixels[i + 1] = g;
    pixels[i + 2] = b;
    pixels[i + 3] = Math.round(alpha * 255);
  }
}

const out = process.argv[2] ?? 'icon.png';
mkdirSync(new URL('.', `file://${out}`).pathname, { recursive: true });
writeFileSync(out, png(SIZE, SIZE, pixels));
console.log(`wrote ${out} (${SIZE}×${SIZE})`);
