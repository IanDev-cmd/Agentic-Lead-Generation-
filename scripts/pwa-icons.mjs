import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function crc32(buffer) {
  let crc = ~0;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

function chunk(type, data) {
  const name = Buffer.from(type);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, crc]);
}

function inRound(x, y, size, radius) {
  const inner = size - radius;
  if (x >= radius && x < inner) return y >= 0 && y < size;
  if (y >= radius && y < inner) return x >= 0 && x < size;
  const cx = x < radius ? radius : inner;
  const cy = y < radius ? radius : inner;
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= radius * radius;
}

function png(size, paint) {
  const stride = 1 + size * 4;
  const raw = Buffer.alloc(size * stride);
  for (let y = 0; y < size; y += 1) {
    const row = y * stride;
    raw[row] = 0;
    for (let x = 0; x < size; x += 1) {
      const [red, green, blue, alpha] = paint(x, y);
      const offset = row + 1 + x * 4;
      raw[offset] = red;
      raw[offset + 1] = green;
      raw[offset + 2] = blue;
      raw[offset + 3] = alpha;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function distToSegment(x, y, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = dx * dx + dy * dy || 1;
  let t = ((x - x1) * dx + (y - y1) * dy) / len;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy));
}

function alphaInk(x, y, size) {
  const thick = size * 0.07;
  const cx = size * 0.40;
  const cy = size * 0.52;
  const radius = size * 0.155;
  const ring = Math.abs(Math.hypot(x - cx, y - cy) - radius) <= thick * 0.5;
  const legX = cx + radius * 0.55;
  const leg = distToSegment(x, y, legX, size * 0.16, legX, size * 0.84) <= thick * 0.5;
  return ring || leg;
}

function icon(size, maskable) {
  const background = [7, 22, 30, 255];
  const radius = size * 0.22;
  return png(size, (x, y) => {
    if (!maskable && !inRound(x + 0.5, y + 0.5, size, radius)) return [0, 0, 0, 0];
    if (alphaInk(x + 0.5, y + 0.5, size)) return [255, 255, 255, 255];
    return background;
  });
}

const directory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../web/icons');
mkdirSync(directory, { recursive: true });
writeFileSync(path.join(directory, 'icon-192.png'), icon(192, false));
writeFileSync(path.join(directory, 'icon-512.png'), icon(512, false));
writeFileSync(path.join(directory, 'icon-maskable-512.png'), icon(512, true));
writeFileSync(path.join(directory, 'apple-touch-icon.png'), icon(180, true));
