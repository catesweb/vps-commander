// ═══════════════════════════════════════════════════════════
// VPS COMMANDER — Premium App Icon Generator
// Industrial brutalist aesthetic — tactical shield + terminal motif
// Scale-agnostic: produces standard (256) and Retina (1024) icons
// ═══════════════════════════════════════════════════════════
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

// ── Helpers ───────────────────────────────────────────────
const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// ═══════════════════════════════════════════════════════════
// DRAWING ENGINE — operates on a raw RGBA buffer
// ═══════════════════════════════════════════════════════════

function createCanvas(w, h) {
  return { w, h, raw: Buffer.alloc(w * h * 4) };
}

function setPixel(ctx, x, y, r, g, b, a = 255) {
  x = Math.round(x); y = Math.round(y);
  if (x < 0 || x >= ctx.w || y < 0 || y >= ctx.h) return;
  const i = (y * ctx.w + x) * 4;
  if (a >= 255) {
    ctx.raw[i] = r; ctx.raw[i + 1] = g; ctx.raw[i + 2] = b; ctx.raw[i + 3] = 255;
  } else if (a > 0) {
    const srcA = a / 255;
    const dstA = ctx.raw[i + 3] / 255;
    const outA = srcA + dstA * (1 - srcA);
    if (outA > 0) {
      ctx.raw[i]     = Math.round((r * srcA + ctx.raw[i]     * dstA * (1 - srcA)) / outA);
      ctx.raw[i + 1] = Math.round((g * srcA + ctx.raw[i + 1] * dstA * (1 - srcA)) / outA);
      ctx.raw[i + 2] = Math.round((b * srcA + ctx.raw[i + 2] * dstA * (1 - srcA)) / outA);
      ctx.raw[i + 3] = Math.round(outA * 255);
    }
  }
}

function fillRect(ctx, x, y, w, h, r, g, b, a = 255) {
  for (let dy = 0; dy < h; dy++)
    for (let dx = 0; dx < w; dx++)
      setPixel(ctx, x + dx, y + dy, r, g, b, a);
}

function fillCircle(ctx, cx, cy, radius, r, g, b, a = 255) {
  const r2 = radius * radius;
  for (let y = Math.floor(cy - radius); y <= Math.ceil(cy + radius); y++) {
    for (let x = Math.floor(cx - radius); x <= Math.ceil(cx + radius); x++) {
      const dx = x - cx, dy = y - cy;
      const dist = dx * dx + dy * dy;
      if (dist <= r2) {
        const edgeDist = radius - Math.sqrt(dist);
        const alpha = Math.min(1, edgeDist);
        setPixel(ctx, x, y, r, g, b, Math.round(alpha * a));
      }
    }
  }
}

function fillCircleGlow(ctx, cx, cy, radius, r, g, b, intensity = 0.3) {
  const r2 = radius * radius;
  for (let y = Math.floor(cy - radius); y <= Math.ceil(cy + radius); y++) {
    for (let x = Math.floor(cx - radius); x <= Math.ceil(cx + radius); x++) {
      const dx = x - cx, dy = y - cy;
      const dist = dx * dx + dy * dy;
      if (dist <= r2) {
        const norm = 1 - Math.sqrt(dist) / radius;
        const alpha = Math.round(norm * norm * intensity * 255);
        setPixel(ctx, x, y, r, g, b, alpha);
      }
    }
  }
}

function drawLine(ctx, x0, y0, x1, y1, r, g, b, thickness = 1) {
  const dx = x1 - x0, dy = y1 - y0;
  const steps = Math.max(Math.abs(dx), Math.abs(dy));
  if (steps === 0) { setPixel(ctx, x0, y0, r, g, b, 255); return; }
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = x0 + dx * t, y = y0 + dy * t;
    if (thickness <= 1) {
      setPixel(ctx, Math.round(x), Math.round(y), r, g, b, 255);
    } else {
      fillCircle(ctx, x, y, thickness / 2, r, g, b);
    }
  }
}

// Distance from point to line segment
function distToSeg(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.sqrt((px - x1) ** 2 + (py - y1) ** 2);
  const t = clamp(((px - x1) * dx + (py - y1) * dy) / len2, 0, 1);
  return Math.sqrt((px - (x1 + t * dx)) ** 2 + (py - (y1 + t * dy)) ** 2);
}

// Signed distance from point to polygon (+ outside, − inside)
function signedDistPoly(px, py, points) {
  let inside = false;
  const n = points.length;
  // Ray casting for inside test
  for (let i = 0; i < n; i++) {
    const [x1, y1] = points[i], [x2, y2] = points[(i + 1) % n];
    if ((y1 > py) !== (y2 > py) && px < ((x2 - x1) * (py - y1)) / (y2 - y1) + x1)
      inside = !inside;
  }
  // Min distance to any edge
  let minDist = Infinity;
  for (let i = 0; i < n; i++) {
    const [x1, y1] = points[i], [x2, y2] = points[(i + 1) % n];
    minDist = Math.min(minDist, distToSeg(px, py, x1, y1, x2, y2));
  }
  return inside ? -minDist : minDist;
}

function fillPolygon(ctx, points, r, g, b, a = 255, antiAlias = false) {
  let minY = Infinity, maxY = -Infinity;
  for (const p of points) { minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]); }
  minY = Math.floor(minY); maxY = Math.ceil(maxY);
  const n = points.length;

  for (let y = minY; y <= maxY; y++) {
    const intersections = [];
    for (let i = 0; i < n; i++) {
      const [x1, y1] = points[i], [x2, y2] = points[(i + 1) % n];
      if ((y1 <= y && y2 > y) || (y2 <= y && y1 > y)) {
        intersections.push(x1 + (y - y1) / (y2 - y1) * (x2 - x1));
      }
    }
    intersections.sort((aa, bb) => aa - bb);
    for (let i = 0; i < intersections.length; i += 2) {
      if (i + 1 < intersections.length) {
        const xStart = Math.ceil(intersections[i]);
        const xEnd = Math.floor(intersections[i + 1]);
        for (let x = xStart; x <= xEnd; x++) setPixel(ctx, x, y, r, g, b, a);
      }
    }
    // Anti-alias: blend only the 1px band at each span edge (not full range)
    if (antiAlias && intersections.length >= 2) {
      const blendRange = 2.0;
      for (let i = 0; i < intersections.length; i += 2) {
        if (i + 1 >= intersections.length) break;
        const spanStart = Math.ceil(intersections[i]);
        const spanEnd = Math.floor(intersections[i + 1]);
        // Left edge: check pixels just outside the span
        for (let x = spanStart - 2; x <= spanStart; x++) {
          if (x < 0 || x >= ctx.w) continue;
          const sd = signedDistPoly(x, y, points);
          if (sd > 0 && sd < blendRange) {
            const alpha = Math.round((1 - sd / blendRange) * a);
            if (alpha > 0) setPixel(ctx, x, y, r, g, b, alpha);
          }
        }
        // Right edge: check pixels just outside the span
        for (let x = spanEnd; x <= spanEnd + 2; x++) {
          if (x < 0 || x >= ctx.w) continue;
          const sd = signedDistPoly(x, y, points);
          if (sd > 0 && sd < blendRange) {
            const alpha = Math.round((1 - sd / blendRange) * a);
            if (alpha > 0) setPixel(ctx, x, y, r, g, b, alpha);
          }
        }
      }
    }
  }
}

function fillRoundedRect(ctx, cx, cy, hw, hh, radius, r, g, b, a = 255) {
  for (let y = Math.floor(cy - hh); y <= Math.ceil(cy + hh); y++) {
    for (let x = Math.floor(cx - hw); x <= Math.ceil(cx + hw); x++) {
      let inside = false;
      if (x >= cx - hw + radius && x <= cx + hw - radius) inside = true;
      else if (y >= cy - hh + radius && y <= cy + hh - radius) inside = true;
      else {
        const dxCorner = x < cx ? cx - hw + radius : cx + hw - radius;
        const dyCorner = y < cy ? cy - hh + radius : cy + hh - radius;
        const dist = Math.sqrt((x - dxCorner) ** 2 + (y - dyCorner) ** 2);
        if (dist <= radius) {
          const alpha = Math.min(1, radius - dist + 0.5);
          setPixel(ctx, x, y, r, g, b, Math.round(alpha * a));
          continue;
        }
      }
      if (inside) setPixel(ctx, x, y, r, g, b, a);
    }
  }
}

function radialGradient(ctx, cx, cy, r, colors) {
  const rMax = r;
  for (let y = Math.floor(cy - rMax); y <= Math.ceil(cy + rMax); y++) {
    for (let x = Math.floor(cx - rMax); x <= Math.ceil(cx + rMax); x++) {
      const dx = x - cx, dy = y - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist <= rMax) {
        const t = dist / rMax;
        let c0 = colors[0], c1 = colors[0];
        for (let i = 0; i < colors.length - 1; i++) {
          if (t >= colors[i].pos && t <= colors[i + 1].pos) {
            c0 = colors[i]; c1 = colors[i + 1]; break;
          }
        }
        const localT = c0.pos === c1.pos ? 0 : (t - c0.pos) / (c1.pos - c0.pos);
        const cr = Math.round(lerp(c0.r, c1.r, localT));
        const cg = Math.round(lerp(c0.g, c1.g, localT));
        const cb = Math.round(lerp(c0.b, c1.b, localT));
        const alpha = Math.round((1 - t * t) * 255);
        setPixel(ctx, x, y, cr, cg, cb, alpha);
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════
// ICON COMPOSITION — scale-agnostic drawing
// All dimensions are in units of `s` (scale = size / 256)
// ═══════════════════════════════════════════════════════════

function drawIcon(size) {
  const s = size / 256;
  const ctx = createCanvas(size, size);
  const cx = size / 2, cy = size / 2;

  // 1. Background — deep dark with subtle radial depth
  fillRect(ctx, 0, 0, size, size, 8, 8, 10);
  radialGradient(ctx, cx, cy, 140 * s, [
    { pos: 0, r: 20, g: 18, b: 22 },
    { pos: 0.5, r: 12, g: 12, b: 14 },
    { pos: 1, r: 6, g: 6, b: 8 },
  ]);

  // 2. Outer rounded-square frame
  const frameW = 112 * s, frameH = 112 * s, frameR = 24 * s;
  fillRoundedRect(ctx, cx, cy, frameW, frameH, frameR, 16, 16, 18);

  // Inner bevel — subtle highlight
  for (let x = cx - frameW + frameR; x <= cx + frameW - frameR; x++) {
    setPixel(ctx, x, cy - frameH + 1, 60, 58, 64, 80);
    setPixel(ctx, x, cy - frameH + 2, 45, 43, 48, 40); // 2nd row fade for Retina
  }
  for (let y = cy - frameH + frameR; y <= cy + frameH - frameR; y++) {
    setPixel(ctx, cx - frameW + 1, y, 50, 48, 54, 60);
    setPixel(ctx, cx - frameW + 2, y, 35, 33, 38, 30);
  }

  // 3. Shield shape — pointed badge
  const shieldCY = cy + 2 * s;
  const shieldTop = shieldCY - 62 * s;
  const shieldBot = shieldCY + 62 * s;
  const shieldW = 56 * s;
  const shieldNarrow = 14 * s;

  const shieldPoints = [
    [cx - shieldW, shieldTop + 20 * s],
    [cx - shieldW, shieldTop + 4 * s],
    [cx - shieldW + 12 * s, shieldTop],
    [cx + shieldW - 12 * s, shieldTop],
    [cx + shieldW, shieldTop + 4 * s],
    [cx + shieldW, shieldTop + 20 * s],
    [cx + shieldNarrow, shieldBot - 8 * s],
    [cx, shieldBot],
    [cx - shieldNarrow, shieldBot - 8 * s],
  ];

  // Shield fill with inner gradient for depth (anti-aliased at Retina)
  fillPolygon(ctx, shieldPoints, 18, 18, 22, 255, s >= 3);

  // Inner shield gradient overlay — darker at bottom for depth
  radialGradient(ctx, cx, shieldCY - 10 * s, 60 * s, [
    { pos: 0, r: 28, g: 26, b: 32 },
    { pos: 0.6, r: 18, g: 18, b: 22 },
    { pos: 1, r: 10, g: 10, b: 14 },
  ]);

  // Shield border — red accent, thicker at higher res
  const borderThickness = s >= 3 ? 3 : 2;
  for (let i = 0; i < shieldPoints.length; i++) {
    const j = (i + 1) % shieldPoints.length;
    drawLine(ctx, shieldPoints[i][0], shieldPoints[i][1],
             shieldPoints[j][0], shieldPoints[j][1],
             200, 22, 22, borderThickness * s);
  }

  // 4. Terminal prompt ">_" — the hero element
  const promptY = shieldCY - 6 * s;
  const promptThickness = Math.max(2, 3 * s);

  // ">" — two lines meeting at a point
  const gtTop = { x: cx - 28 * s, y: promptY - 16 * s };
  const gtMid = { x: cx - 10 * s, y: promptY };
  const gtBot = { x: cx - 28 * s, y: promptY + 16 * s };

  drawLine(ctx, gtTop.x, gtTop.y, gtMid.x, gtMid.y, 230, 25, 25, promptThickness);
  drawLine(ctx, gtMid.x, gtMid.y, gtBot.x, gtBot.y, 230, 25, 25, promptThickness);

  // "_" (underscore cursor)
  drawLine(ctx, cx - 4 * s, promptY + 16 * s, cx + 20 * s, promptY + 16 * s, 230, 25, 25, promptThickness);

  // Red glow behind the prompt
  fillCircleGlow(ctx, cx - 4 * s, promptY, 40 * s, 200, 20, 20, 0.08);

  // 5. Server rack lines — horizontal accent lines
  for (let i = 0; i < 3; i++) {
    const ly = shieldCY - 30 * s + i * 8 * s;
    const lx1 = cx - 40 * s;
    const lx2 = cx + 40 * s;
    for (let x = lx1; x <= lx2; x++) {
      const t = (x - lx1) / (lx2 - lx1);
      const edgeFade = t < 0.15 ? t / 0.15 : t > 0.85 ? (1 - t) / 0.15 : 1;
      setPixel(ctx, x, ly, 40, 40, 46, Math.round(50 * edgeFade));
    }
  }

  // 6. Status indicator — green dot (online)
  const dotR = Math.max(4, 5 * s);
  fillCircle(ctx, cx + 38 * s, shieldTop + 12 * s, dotR, 60, 220, 40);
  fillCircleGlow(ctx, cx + 38 * s, shieldTop + 12 * s, dotR * 2, 60, 220, 40, 0.15);

  // 7. Top accent line
  const topLineY = cy - frameH + 8 * s;
  for (let x = cx - frameW + frameR + 10 * s; x <= cx + frameW - frameR - 10 * s; x++) {
    const range = frameW * 2 - frameR * 2 - 20 * s;
    const t = (x - (cx - frameW + frameR + 10 * s)) / range;
    const edgeFade = t < 0.2 ? t / 0.2 : t > 0.8 ? (1 - t) / 0.2 : 1;
    setPixel(ctx, x, topLineY, 200, 22, 22, Math.round(180 * edgeFade));
  }

  // 8. Corner accents — red L-shaped marks
  const cs = Math.max(5, Math.round(6 * s));
  const cm = Math.round(10 * s);
  // Top-left
  fillRect(ctx, cx - frameW + cm, cy - frameH + cm, cs, 1, 200, 22, 22);
  fillRect(ctx, cx - frameW + cm, cy - frameH + cm, 1, cs, 200, 22, 22);
  // Top-right
  fillRect(ctx, cx + frameW - cm - cs, cy - frameH + cm, cs, 1, 200, 22, 22);
  fillRect(ctx, cx + frameW - cm - 1, cy - frameH + cm, 1, cs, 200, 22, 22);
  // Bottom-left
  fillRect(ctx, cx - frameW + cm, cy + frameH - cm - 1, cs, 1, 200, 22, 22);
  fillRect(ctx, cx - frameW + cm, cy + frameH - cm - cs, 1, cs, 200, 22, 22);
  // Bottom-right
  fillRect(ctx, cx + frameW - cm - cs, cy + frameH - cm - 1, cs, 1, 200, 22, 22);
  fillRect(ctx, cx + frameW - cm - 1, cy + frameH - cm - cs, 1, cs, 200, 22, 22);

  // 9. Subtle grid pattern
  const gridStep = Math.max(8, Math.round(16 * s));
  for (let x = 0; x < size; x += gridStep) {
    for (let y = 0; y < size; y++) {
      setPixel(ctx, x, y, 30, 30, 34, 12);
    }
  }
  for (let y = 0; y < size; y += gridStep) {
    for (let x = 0; x < size; x++) {
      setPixel(ctx, x, y, 30, 30, 34, 12);
    }
  }

  // ═══════════════════════════════════════════════════════════
  // RETINA-ONLY ENHANCEMENTS (1024px)
  // ═══════════════════════════════════════════════════════════
  if (s >= 3) {
    // Outer frame border — thin subtle line
    for (let angle = 0; angle < Math.PI * 2; angle += 0.01) {
      // Approximate rounded rect border
      const bx = cx + Math.cos(angle) * (frameW - 2 * s);
      const by = cy + Math.sin(angle) * (frameH - 2 * s);
      setPixel(ctx, bx, by, 35, 35, 40, 60);
    }

    // Inner shield highlight — top edge glow
    for (let x = cx - shieldW + 8 * s; x <= cx + shieldW - 8 * s; x++) {
      const t = (x - (cx - shieldW + 8 * s)) / ((shieldW - 8 * s) * 2);
      const fade = Math.sin(t * Math.PI);
      setPixel(ctx, x, shieldTop + 5 * s, 80, 20, 20, Math.round(40 * fade));
    }

    // Terminal cursor blink effect — subtle second line
    drawLine(ctx, cx - 4 * s, promptY + 16 * s + 2 * s, cx + 20 * s, promptY + 16 * s + 2 * s, 230, 25, 25, Math.round(1.5 * s));

    // Decorative dots around shield — tactical markers
    const markerCount = 12;
    for (let i = 0; i < markerCount; i++) {
      const angle = (i / markerCount) * Math.PI * 2;
      const mx = cx + Math.cos(angle) * (frameW - 4 * s);
      const my = cy + Math.sin(angle) * (frameH - 4 * s);
      // Only draw if within the rounded rect bounds (approximate)
      if (Math.abs(mx - cx) < frameW - 6 * s && Math.abs(my - cy) < frameH - 6 * s) {
        setPixel(ctx, mx, my, 50, 50, 55, 80);
      }
    }

    // Shield inner glow — subtle radial from center
    fillCircleGlow(ctx, cx, shieldCY, 35 * s, 200, 30, 30, 0.03);

    // Fine horizontal scan lines across shield — CRT texture
    for (let y = shieldTop; y < shieldBot; y += Math.max(2, Math.round(3 * s))) {
      for (let x = cx - shieldW + 5 * s; x <= cx + shieldW - 5 * s; x++) {
        setPixel(ctx, x, y, 255, 255, 255, 3);
      }
    }

    // Corner bracket decorations — inner frame
    const bracketSize = Math.round(16 * s);
    const bracketOffset = Math.round(20 * s);
    const bracketThickness = Math.max(1, Math.round(1.5 * s));
    // Top-left bracket
    drawLine(ctx, cx - frameW + bracketOffset, cy - frameH + bracketOffset,
             cx - frameW + bracketOffset + bracketSize, cy - frameH + bracketOffset, 200, 22, 22, bracketThickness);
    drawLine(ctx, cx - frameW + bracketOffset, cy - frameH + bracketOffset,
             cx - frameW + bracketOffset, cy - frameH + bracketOffset + bracketSize, 200, 22, 22, bracketThickness);
    // Top-right bracket
    drawLine(ctx, cx + frameW - bracketOffset, cy - frameH + bracketOffset,
             cx + frameW - bracketOffset - bracketSize, cy - frameH + bracketOffset, 200, 22, 22, bracketThickness);
    drawLine(ctx, cx + frameW - bracketOffset, cy - frameH + bracketOffset,
             cx + frameW - bracketOffset, cy - frameH + bracketOffset + bracketSize, 200, 22, 22, bracketThickness);
    // Bottom-left bracket
    drawLine(ctx, cx - frameW + bracketOffset, cy + frameH - bracketOffset,
             cx - frameW + bracketOffset + bracketSize, cy + frameH - bracketOffset, 200, 22, 22, bracketThickness);
    drawLine(ctx, cx - frameW + bracketOffset, cy + frameH - bracketOffset,
             cx - frameW + bracketOffset, cy + frameH - bracketOffset - bracketSize, 200, 22, 22, bracketThickness);
    // Bottom-right bracket
    drawLine(ctx, cx + frameW - bracketOffset, cy + frameH - bracketOffset,
             cx + frameW - bracketOffset - bracketSize, cy + frameH - bracketOffset, 200, 22, 22, bracketThickness);
    drawLine(ctx, cx + frameW - bracketOffset, cy + frameH - bracketOffset,
             cx + frameW - bracketOffset, cy + frameH - bracketOffset - bracketSize, 200, 22, 22, bracketThickness);

    // Bottom shield point accent — small red glow at tip
    fillCircleGlow(ctx, cx, shieldBot, 8 * s, 200, 30, 30, 0.2);
  }

  return ctx;
}

// ═══════════════════════════════════════════════════════════
// PNG ENCODING
// ═══════════════════════════════════════════════════════════

function rawToPNGFiltered(raw, w, h) {
  const rowLen = w * 4;
  const out = Buffer.alloc((rowLen + 1) * h);
  for (let y = 0; y < h; y++) {
    out[y * (rowLen + 1)] = 0; // filter: none
    raw.copy(out, y * (rowLen + 1) + 1, y * rowLen, (y + 1) * rowLen);
  }
  return out;
}

function crc32(buf) {
  let c;
  const table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c;
  }
  c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function writeChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeB = Buffer.from(type, 'ascii');
  const crcData = Buffer.concat([typeB, data]);
  const crcVal = Buffer.alloc(4);
  crcVal.writeUInt32BE(crc32(crcData), 0);
  return Buffer.concat([len, typeB, data, crcVal]);
}

function encodePNG(ctx) {
  const deflate = zlib.deflateSync(rawToPNGFiltered(ctx.raw, ctx.w, ctx.h));
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(ctx.w, 0);
  ihdr.writeUInt32BE(ctx.h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    sig,
    writeChunk('IHDR', ihdr),
    writeChunk('IDAT', deflate),
    writeChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ═══════════════════════════════════════════════════════════
// ICO ENCODING — multi-size
// ═══════════════════════════════════════════════════════════

function encodeICO(pngBuffers) {
  const count = pngBuffers.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);     // reserved
  header.writeUInt16LE(1, 2);     // type: icon
  header.writeUInt16LE(count, 4); // image count

  // Each entry is 16 bytes; data offset starts after header + all entries
  const dataOffset = 6 + count * 16;
  const entries = [];
  let currentOffset = dataOffset;

  for (const { size, png } of pngBuffers) {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0);  // width (0 = 256)
    entry.writeUInt8(size >= 256 ? 0 : size, 1);  // height
    entry.writeUInt8(0, 2);   // colors
    entry.writeUInt8(0, 3);   // reserved
    entry.writeUInt16LE(1, 4);  // planes
    entry.writeUInt16LE(32, 6); // bpp
    entry.writeUInt32LE(png.length, 8);  // data size
    entry.writeUInt32LE(currentOffset, 12); // data offset
    entries.push(entry);
    currentOffset += png.length;
  }

  return Buffer.concat([header, ...entries, ...pngBuffers.map(e => e.png)]);
}

// ═══════════════════════════════════════════════════════════
// GENERATE
// ═══════════════════════════════════════════════════════════

const outDir = path.join(__dirname, '..', 'public');
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

console.log('\n  VPS Commander — Icon Generator');
console.log('  ─────────────────────────────\n');

// All icon sizes to generate
const sizes = [
  { size: 16,  label: 'favicon-16x16',   out: 'favicon-16x16.png' },
  { size: 32,  label: 'favicon-32x32',   out: 'favicon-32x32.png' },
  { size: 256, label: 'icon',            out: 'icon.png' },
  { size: 1024,label: 'icon@2x',        out: 'icon@2x.png' },
];

const pngBuffers = [];

for (const { size, label, out: filename } of sizes) {
  console.log(`  Generating ${size}×${size} ${label}...`);
  const icon = drawIcon(size);
  const png = encodePNG(icon);
  fs.writeFileSync(path.join(outDir, filename), png);
  pngBuffers.push({ size, png });
  console.log(`  ✓ ${filename} (${(png.length / 1024).toFixed(1)} KB)`);
}

// Generate multi-size ICO (all sizes)
console.log('  Generating multi-size ICO...');
const ico = encodeICO(pngBuffers);
fs.writeFileSync(path.join(outDir, 'icon.ico'), ico);
console.log(`  ✓ icon.ico (${(ico.length / 1024).toFixed(1)} KB)`);

console.log('\n  ─────────────────────────────');
console.log('  Design: Tactical shield + terminal motif');
console.log('  Colors: #0A0A0A bg, #E61919 accent, #4AF626 status');
console.log('  Sizes:  16, 32, 256, 1024 px + multi-size ICO\n');
