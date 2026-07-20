// Generates packages/desktop/build/icon.png (1024²) — the Mantra mark, no image deps.
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const S = 1024;
const buf = Buffer.alloc(S * S * 4);
const lerp = (a, b, t) => Math.round(a + (b - a) * t);
const coral = [255, 122, 89], violet = [182, 92, 255];
const cx = S / 2, cy = S / 2;
const radius = 210; // rounded-square corner radius
const inSquare = (x, y) => {
  const dx = Math.max(0, Math.abs(x - cx) - (S / 2 - radius));
  const dy = Math.max(0, Math.abs(y - cy) - (S / 2 - radius));
  return Math.hypot(dx, dy) <= radius;
};
// ring geometry
const ringOuter = 300, ringInner = 238, dotR = 70;

for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    const i = (y * S + x) * 4;
    if (!inSquare(x, y)) { buf[i + 3] = 0; continue; }
    const t = (x + y) / (2 * S);
    let r = lerp(coral[0], violet[0], t), g = lerp(coral[1], violet[1], t), b = lerp(coral[2], violet[2], t);
    const d = Math.hypot(x - cx, y - cy);
    if ((d <= ringOuter && d >= ringInner) || d <= dotR) { r = g = b = 255; } // white ring + center dot
    buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = 255;
  }
}

// PNG encode (filter 0 per scanline)
const raw = Buffer.alloc(S * (S * 4 + 1));
for (let y = 0; y < S; y++) {
  raw[y * (S * 4 + 1)] = 0;
  buf.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4);
}
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
};
function crc32(b) {
  let c = ~0;
  for (let i = 0; i < b.length; i++) {
    c ^= b[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
  }
  return ~c;
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4); ihdr[8] = 8; ihdr[9] = 6;
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw)),
  chunk("IEND", Buffer.alloc(0)),
]);

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "packages", "desktop", "build");
mkdirSync(out, { recursive: true });
writeFileSync(join(out, "icon.png"), png);
console.log("icon.png written:", png.length, "bytes");
