// ═══════════════════════════════════════════════════════════
// VPS COMMANDER — App icon builder
// Source artwork: assets/icon-source.png (1024×1024)
// Emits public/icon.png, favicon-16x16.png, favicon-32x32.png, icon.ico
// (512 minimum — electron-builder rejects macOS icons under 512px)
// ═══════════════════════════════════════════════════════════
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

// ═══════════════════════════════════════════════════════════
// PNG DECODE — 8-bit, non-interlaced, colour types 0/2/4/6
// ═══════════════════════════════════════════════════════════

const CHANNELS = { 0: 1, 2: 3, 4: 2, 6: 4 };

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

function decodePNG(buf) {
  assert(buf.readUInt32BE(0) === 0x89504e47, 'not a PNG');
  let pos = 8, ihdr = null;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') ihdr = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  const w = ihdr.readUInt32BE(0), h = ihdr.readUInt32BE(4);
  const depth = ihdr[8], colorType = ihdr[9];
  assert(depth === 8, `unsupported bit depth ${depth}`);
  assert(ihdr[12] === 0, 'interlaced PNG unsupported');
  const bpp = CHANNELS[colorType];
  assert(bpp, `unsupported colour type ${colorType}`);

  const inflated = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * bpp;
  const px = Buffer.alloc(h * stride);

  for (let y = 0; y < h; y++) {
    const filter = inflated[y * (stride + 1)];
    const row = inflated.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? px[y * stride + i - bpp] : 0;
      const b = y > 0 ? px[(y - 1) * stride + i] : 0;
      const c = i >= bpp && y > 0 ? px[(y - 1) * stride + i - bpp] : 0;
      let v = row[i];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) v += paeth(a, b, c);
      px[y * stride + i] = v & 0xff;
    }
  }

  // Normalise to RGBA
  const raw = Buffer.alloc(w * h * 4);
  for (let i = 0, n = w * h; i < n; i++) {
    const s = i * bpp, d = i * 4;
    if (colorType === 6) px.copy(raw, d, s, s + 4);
    else if (colorType === 2) { px.copy(raw, d, s, s + 3); raw[d + 3] = 255; }
    else if (colorType === 4) { raw.fill(px[s], d, d + 3); raw[d + 3] = px[s + 1]; }
    else { raw.fill(px[s], d, d + 3); raw[d + 3] = 255; }
  }
  return { w, h, raw };
}

// ═══════════════════════════════════════════════════════════
// DOWNSCALE — box average in premultiplied alpha (no edge halos)
// ═══════════════════════════════════════════════════════════

function resize(src, size) {
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    const y0 = Math.floor(y * src.h / size), y1 = Math.max(y0 + 1, Math.floor((y + 1) * src.h / size));
    for (let x = 0; x < size; x++) {
      const x0 = Math.floor(x * src.w / size), x1 = Math.max(x0 + 1, Math.floor((x + 1) * src.w / size));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const i = (sy * src.w + sx) * 4;
          const sa = src.raw[i + 3] / 255;
          r += src.raw[i] * sa; g += src.raw[i + 1] * sa; b += src.raw[i + 2] * sa;
          a += src.raw[i + 3]; n++;
        }
      }
      const d = (y * size + x) * 4;
      const avgA = a / n;
      const un = avgA > 0 ? 255 / avgA : 0; // un-premultiply
      out[d] = Math.min(255, Math.round(r / n * un));
      out[d + 1] = Math.min(255, Math.round(g / n * un));
      out[d + 2] = Math.min(255, Math.round(b / n * un));
      out[d + 3] = Math.round(avgA);
    }
  }
  return { w: size, h: size, raw: out };
}

// ═══════════════════════════════════════════════════════════
// PNG ENCODE — Paeth-filtered (keeps the 512px art off 3 MB)
// ═══════════════════════════════════════════════════════════

function crc32(buf) {
  const table = crc32.table || (crc32.table = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    return c >>> 0;
  }));
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function writeChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePNG(img) {
  const stride = img.w * 4;
  const filtered = Buffer.alloc((stride + 1) * img.h);
  for (let y = 0; y < img.h; y++) {
    filtered[y * (stride + 1)] = 4; // Paeth
    for (let i = 0; i < stride; i++) {
      const a = i >= 4 ? img.raw[y * stride + i - 4] : 0;
      const b = y > 0 ? img.raw[(y - 1) * stride + i] : 0;
      const c = i >= 4 && y > 0 ? img.raw[(y - 1) * stride + i - 4] : 0;
      filtered[y * (stride + 1) + 1 + i] = (img.raw[y * stride + i] - paeth(a, b, c)) & 0xff;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(img.w, 0);
  ihdr.writeUInt32BE(img.h, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    writeChunk('IHDR', ihdr),
    writeChunk('IDAT', zlib.deflateSync(filtered, { level: 9 })),
    writeChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ═══════════════════════════════════════════════════════════
// ICO ENCODING — multi-size, PNG-compressed entries (Vista+)
// ═══════════════════════════════════════════════════════════

function encodeICO(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);

  let offset = 6 + entries.length * 16;
  const dir = entries.map(({ size, png }) => {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0);
    e.writeUInt8(size >= 256 ? 0 : size, 1);
    e.writeUInt16LE(1, 4);   // planes
    e.writeUInt16LE(32, 6);  // bpp
    e.writeUInt32LE(png.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += png.length;
    return e;
  });

  return Buffer.concat([header, ...dir, ...entries.map(e => e.png)]);
}

// ═══════════════════════════════════════════════════════════
// BUILD
// ═══════════════════════════════════════════════════════════

const srcPath = path.join(__dirname, '..', 'assets', 'icon-source.png');
const outDir = path.join(__dirname, '..', 'public');

const source = decodePNG(fs.readFileSync(srcPath));
assert(source.w === source.h, 'source icon must be square');
assert(source.w >= 1024, 'source icon must be at least 1024×1024');

console.log('\n  VPS Commander — Icon Builder');
console.log('  ─────────────────────────────\n');
console.log(`  Source: assets/icon-source.png (${source.w}×${source.h})\n`);

const cache = new Map();
const render = (size) => {
  if (!cache.has(size)) cache.set(size, encodePNG(size === source.w ? source : resize(source, size)));
  return cache.get(size);
};

for (const [size, filename] of [[512, 'icon.png'], [32, 'favicon-32x32.png'], [16, 'favicon-16x16.png']]) {
  const png = render(size);
  fs.writeFileSync(path.join(outDir, filename), png);
  console.log(`  ✓ ${filename.padEnd(20)} ${size}×${size}  (${(png.length / 1024).toFixed(1)} KB)`);
}

const ico = encodeICO([16, 32, 48, 64, 128, 256].map(size => ({ size, png: render(size) })));
fs.writeFileSync(path.join(outDir, 'icon.ico'), ico);
console.log(`  ✓ ${'icon.ico'.padEnd(20)} 16–256   (${(ico.length / 1024).toFixed(1)} KB)`);

// Self-check: the emitted 512 must decode back to a square, non-transparent icon.
const check = decodePNG(fs.readFileSync(path.join(outDir, 'icon.png')));
assert(check.w === 512 && check.h === 512, 'icon.png is not 512×512');
assert(check.raw.some((v, i) => i % 4 === 3 && v > 0), 'icon.png is fully transparent');

console.log('\n  ─────────────────────────────');
console.log('  Round-trip verified: icon.png 512×512, opaque pixels present\n');
