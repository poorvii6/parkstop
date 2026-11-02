/**
 * markerBitmap — draws the map's markers as PNG images, in plain JavaScript.
 *
 * Why: react-native-maps turns a custom-view marker into a picture by taking a
 * snapshot of it. Under React Native's new architecture that snapshot is often
 * taken at the wrong size, so markers came out cut off ("incomplete P",
 * half an arrow). Handing the map a finished image avoids snapshots entirely —
 * Google Maps draws the image natively and it can never be clipped.
 *
 * Everything here is pure JS (no native module, no new package):
 *   - shapes with smooth (anti-aliased) edges
 *   - text from pre-rendered Roboto glyphs (utils/markerGlyphs.ts)
 *   - a small PNG encoder (deflate with fixed Huffman codes)
 * Images are drawn at the phone's pixel density so they stay sharp, and cached.
 */
import { PixelRatio } from 'react-native';
import { GLYPHS, GLYPH_SCALE, Glyph } from './markerGlyphs';

type RGBA = [number, number, number, number]; // 0-255, alpha 0-1

const hex = (h: string, a = 1): RGBA => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16), a];

/* ─────────────────────────── base64 ─────────────────────────── */

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_LOOKUP = (() => {
  const t = new Uint8Array(128);
  for (let i = 0; i < B64.length; i++) t[B64.charCodeAt(i)] = i;
  return t;
})();

function toBase64(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63];
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i] << 16;
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + '==';
  } else if (rest === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + '=';
  }
  return out;
}

function fromBase64(s: string): Uint8Array {
  const clean = s.replace(/=+$/, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let o = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const n =
      (B64_LOOKUP[clean.charCodeAt(i)] << 18) |
      (B64_LOOKUP[clean.charCodeAt(i + 1)] << 12) |
      ((i + 2 < clean.length ? B64_LOOKUP[clean.charCodeAt(i + 2)] : 0) << 6) |
      (i + 3 < clean.length ? B64_LOOKUP[clean.charCodeAt(i + 3)] : 0);
    if (o < out.length) out[o++] = (n >> 16) & 255;
    if (o < out.length) out[o++] = (n >> 8) & 255;
    if (o < out.length) out[o++] = n & 255;
  }
  return out;
}

/* ─────────────────────────── PNG encoder ─────────────────────────── */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array, start: number, end: number): number {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

class BitWriter {
  buf = new Uint8Array(1 << 16);
  pos = 0;
  acc = 0; // pending bits, least significant first
  n = 0; // number of pending bits (always < 8 between calls)
  /** Write `len` (<= 16) bits of `value`, least significant bit first. */
  bits(value: number, len: number) {
    this.acc |= value << this.n;
    this.n += len;
    while (this.n >= 8) {
      if (this.pos >= this.buf.length) {
        const nb = new Uint8Array(this.buf.length * 2);
        nb.set(this.buf);
        this.buf = nb;
      }
      this.buf[this.pos++] = this.acc & 255;
      this.acc >>>= 8;
      this.n -= 8;
    }
  }
  finish(): Uint8Array {
    if (this.n > 0) this.bits(0, 8 - this.n);
    return this.buf.subarray(0, this.pos);
  }
}

const reverseBits = (code: number, len: number) => {
  let rev = 0;
  for (let i = 0; i < len; i++) rev |= ((code >>> i) & 1) << (len - 1 - i);
  return rev;
};

// Fixed Huffman codes (RFC 1951 §3.2.6), pre-reversed for LSB-first output.
const LIT_CODE = new Uint16Array(288);
const LIT_LEN = new Uint8Array(288);
for (let v = 0; v < 288; v++) {
  const [code, len] =
    v < 144 ? [0x30 + v, 8] : v < 256 ? [0x190 + (v - 144), 9] : v < 280 ? [v - 256, 7] : [0xc0 + (v - 280), 8];
  LIT_CODE[v] = reverseBits(code, len);
  LIT_LEN[v] = len;
}
const DIST_CODE_REV = new Uint8Array(30);
for (let d = 0; d < 30; d++) DIST_CODE_REV[d] = reverseBits(d, 5);

const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];

const LEN_CODE = (() => {
  const t = new Uint8Array(259);
  for (let c = 0; c < 29; c++) {
    const top = c === 28 ? 258 : LEN_BASE[c] + (1 << LEN_EXTRA[c]) - 1;
    for (let l = LEN_BASE[c]; l <= top && l <= 258; l++) t[l] = c;
  }
  return t;
})();

function distCode(d: number): number {
  let c = 29;
  while (DIST_BASE[c] > d) c--;
  return c;
}

function writeLiteral(w: BitWriter, v: number) {
  w.bits(LIT_CODE[v], LIT_LEN[v]);
}

function writeMatch(w: BitWriter, len: number, dist: number) {
  const lc = LEN_CODE[len];
  writeLiteral(w, 257 + lc);
  if (LEN_EXTRA[lc]) w.bits(len - LEN_BASE[lc], LEN_EXTRA[lc]);
  const dc = distCode(dist);
  w.bits(DIST_CODE_REV[dc], 5);
  if (DIST_EXTRA[dc]) w.bits(dist - DIST_BASE[dc], DIST_EXTRA[dc]);
}

/** zlib stream: one fixed-Huffman deflate block with LZ77 matching. */
function zlibDeflate(data: Uint8Array): Uint8Array {
  const w = new BitWriter();
  w.bits(0x78, 8);
  w.bits(0x01, 8);
  w.bits(1, 1); // final block
  w.bits(1, 2); // fixed Huffman

  const WIN = 32768;
  const HASH = 1 << 15;
  const head = new Int32Array(HASH).fill(-1);
  const prev = new Int32Array(WIN);
  const n = data.length;
  const hash = (i: number) => ((data[i] << 10) ^ (data[i + 1] << 5) ^ data[i + 2]) & (HASH - 1);
  const insert = (i: number) => {
    if (i + 2 >= n) return;
    const h = hash(i);
    prev[i & (WIN - 1)] = head[h];
    head[h] = i;
  };

  let i = 0;
  while (i < n) {
    // Fast path: a run of the previous byte (flat colour after the Sub
    // filter is long runs of zeros). Encoded as distance-1 matches without
    // touching the hash tables — most of a marker image goes this way.
    if (i > 0 && data[i] === data[i - 1]) {
      const v = data[i - 1];
      let r = 0;
      while (r < 258 && i + r < n && data[i + r] === v) r++;
      if (r >= 3) {
        writeMatch(w, r, 1);
        i += r;
        continue;
      }
    }
    let bestLen = 0;
    let bestDist = 0;
    if (i + 2 < n) {
      let cand = head[hash(i)];
      let chain = 8;
      const maxLen = Math.min(258, n - i);
      while (cand >= 0 && i - cand <= WIN && chain-- > 0) {
        if (data[cand + bestLen] === data[i + bestLen]) {
          let l = 0;
          while (l < maxLen && data[cand + l] === data[i + l]) l++;
          if (l > bestLen) {
            bestLen = l;
            bestDist = i - cand;
            if (l === maxLen) break;
          }
        }
        cand = prev[cand & (WIN - 1)];
      }
    }
    if (bestLen >= 3) {
      writeMatch(w, bestLen, bestDist);
      const end = i + bestLen;
      // Index every position for long runs only sparsely — keeps it fast.
      for (let k = i; k < end; k += bestLen > 32 ? 8 : 1) insert(k);
      i = end;
    } else {
      writeLiteral(w, data[i]);
      insert(i);
      i++;
    }
  }
  writeLiteral(w, 256); // end of block

  let a = 1;
  let b = 0;
  for (let k = 0; k < n; k++) {
    a = (a + data[k]) % 65521;
    b = (b + a) % 65521;
  }
  const body = w.finish();
  const out = new Uint8Array(body.length + 4);
  out.set(body);
  const adler = ((b << 16) | a) >>> 0;
  out[body.length] = adler >>> 24;
  out[body.length + 1] = (adler >>> 16) & 255;
  out[body.length + 2] = (adler >>> 8) & 255;
  out[body.length + 3] = adler & 255;
  return out;
}

function encodePng(width: number, height: number, rgba: Uint8Array): Uint8Array {
  // Filter every row with "Sub": flat colour becomes runs of zeros, which
  // compress to almost nothing.
  const stride = width * 4;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const o = y * (stride + 1);
    const s = y * stride;
    raw[o] = 1;
    for (let x = 0; x < stride; x++) {
      raw[o + 1 + x] = (rgba[s + x] - (x >= 4 ? rgba[s + x - 4] : 0)) & 255;
    }
  }
  const idat = zlibDeflate(raw);

  const chunks: Array<[string, Uint8Array]> = [];
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  chunks.push(['IHDR', ihdr], ['IDAT', idat], ['IEND', new Uint8Array(0)]);

  const total = 8 + chunks.reduce((s, [, d]) => s + 12 + d.length, 0);
  const png = new Uint8Array(total);
  png.set([137, 80, 78, 71, 13, 10, 26, 10], 0);
  let p = 8;
  const pdv = new DataView(png.buffer);
  for (const [type, d] of chunks) {
    pdv.setUint32(p, d.length);
    for (let k = 0; k < 4; k++) png[p + 4 + k] = type.charCodeAt(k);
    png.set(d, p + 8);
    pdv.setUint32(p + 8 + d.length, crc32(png, p + 4, p + 8 + d.length));
    p += 12 + d.length;
  }
  return png;
}

/* ─────────────────────────── rasteriser ─────────────────────────── */

/** Premultiplied-alpha float canvas. Coordinates are in dp; `s` = pixels per dp. */
class Canvas {
  w: number;
  h: number;
  px: Float32Array;
  constructor(public wDp: number, public hDp: number, public s: number) {
    this.w = Math.ceil(wDp * s);
    this.h = Math.ceil(hDp * s);
    this.px = new Float32Array(this.w * this.h * 4);
  }

  /** Blend `c` over pixel (x, y) with coverage 0-1. */
  blend(x: number, y: number, c: RGBA, cov: number) {
    if (cov <= 0 || x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const a = c[3] * (cov < 1 ? cov : 1);
    const i = (y * this.w + x) * 4;
    if (a >= 1) {
      // Fully covered by an opaque colour: overwrite.
      this.px[i] = c[0] / 255;
      this.px[i + 1] = c[1] / 255;
      this.px[i + 2] = c[2] / 255;
      this.px[i + 3] = 1;
      return;
    }
    const inv = 1 - a;
    this.px[i] = (c[0] / 255) * a + this.px[i] * inv;
    this.px[i + 1] = (c[1] / 255) * a + this.px[i + 1] * inv;
    this.px[i + 2] = (c[2] / 255) * a + this.px[i + 2] * inv;
    this.px[i + 3] = a + this.px[i + 3] * inv;
  }

  /** Fill using a signed-distance function (negative inside), in pixels. */
  private fillSdf(x0: number, y0: number, x1: number, y1: number, sdf: (x: number, y: number) => number, c: RGBA) {
    const s = this.s;
    const ax = Math.max(0, Math.floor(x0 * s) - 1);
    const ay = Math.max(0, Math.floor(y0 * s) - 1);
    const bx = Math.min(this.w - 1, Math.ceil(x1 * s) + 1);
    const by = Math.min(this.h - 1, Math.ceil(y1 * s) + 1);
    for (let y = ay; y <= by; y++) {
      for (let x = ax; x <= bx; x++) {
        const d = sdf(x + 0.5, y + 0.5);
        this.blend(x, y, c, 0.5 - d);
      }
    }
  }

  roundRect(x: number, y: number, w: number, h: number, r: number, c: RGBA) {
    const s = this.s;
    const cx = (x + w / 2) * s;
    const cy = (y + h / 2) * s;
    const hx = (w / 2) * s;
    const hy = (h / 2) * s;
    const rr = r * s;
    this.fillSdf(x, y, x + w, y + h, (px, py) => {
      const qx = Math.abs(px - cx) - (hx - rr);
      const qy = Math.abs(py - cy) - (hy - rr);
      const ox = Math.max(qx, 0);
      const oy = Math.max(qy, 0);
      return Math.sqrt(ox * ox + oy * oy) + Math.min(Math.max(qx, qy), 0) - rr;
    }, c);
  }

  circle(cx: number, cy: number, r: number, c: RGBA) {
    const s = this.s;
    this.fillSdf(cx - r, cy - r, cx + r, cy + r, (px, py) => Math.hypot(px - cx * s, py - cy * s) - r * s, c);
  }

  /**
   * Any simple polygon (dp points). Edges are smoothed from the distance to
   * the nearest edge — one inside test per pixel, which matters on phones
   * (Hermes has no JIT; 16-sample supersampling took ~0.5 s for the arrow).
   */
  polygon(pts: Array<[number, number]>, c: RGBA) {
    const s = this.s;
    const n = pts.length;
    const X = new Float64Array(n);
    const Y = new Float64Array(n);
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < n; i++) {
      X[i] = pts[i][0] * s;
      Y[i] = pts[i][1] * s;
      if (X[i] < minX) minX = X[i];
      if (X[i] > maxX) maxX = X[i];
      if (Y[i] < minY) minY = Y[i];
      if (Y[i] > maxY) maxY = Y[i];
    }
    const ax = Math.max(0, Math.floor(minX) - 1);
    const bx = Math.min(this.w - 1, Math.ceil(maxX) + 1);
    const ay = Math.max(0, Math.floor(minY) - 1);
    const by = Math.min(this.h - 1, Math.ceil(maxY) + 1);
    for (let y = ay; y <= by; y++) {
      const py = y + 0.5;
      for (let x = ax; x <= bx; x++) {
        const px = x + 0.5;
        let inside = false;
        let best = Infinity;
        for (let i = 0, j = n - 1; i < n; j = i++) {
          const xi = X[i], yi = Y[i], xj = X[j], yj = Y[j];
          if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
          const ex = xj - xi, ey = yj - yi;
          const len2 = ex * ex + ey * ey;
          let t = len2 ? ((px - xi) * ex + (py - yi) * ey) / len2 : 0;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const dx = px - (xi + t * ex), dy = py - (yi + t * ey);
          const d2 = dx * dx + dy * dy;
          if (d2 < best) best = d2;
        }
        const d = Math.sqrt(best);
        const cov = inside ? 0.5 + d : 0.5 - d;
        if (cov > 0) this.blend(x, y, c, cov);
      }
    }
  }

  /** Draw one glyph mask with its top-left at (xPx, yPx) device pixels. */
  private glyph(g: Glyph, mask: Uint8Array, xPx: number, yPx: number, c: RGBA) {
    const k = GLYPH_SCALE / this.s; // mask pixels per device pixel
    const w = Math.ceil(g.w / k);
    const h = Math.ceil(g.h / k);
    const x0 = Math.round(xPx);
    const y0 = Math.round(yPx);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        // Box-filter the mask area under this device pixel.
        const mx0 = x * k, my0 = y * k;
        let sum = 0;
        let cnt = 0;
        for (let my = Math.floor(my0); my < Math.min(g.h, Math.ceil(my0 + k)); my++) {
          for (let mx = Math.floor(mx0); mx < Math.min(g.w, Math.ceil(mx0 + k)); mx++) {
            sum += mask[my * g.w + mx];
            cnt++;
          }
        }
        if (cnt && sum) this.blend(x0 + x, y0 + y, c, sum / cnt / 255);
      }
    }
  }

  textWidth(style: keyof typeof GLYPHS, text: string): number {
    let w = 0;
    for (const ch of text) w += GLYPHS[style].glyphs[ch]?.a ?? 0;
    return w / GLYPH_SCALE; // dp
  }

  /** Draw text with its baseline at (x, baseline) dp. */
  text(style: keyof typeof GLYPHS, text: string, x: number, baseline: number, c: RGBA) {
    let pen = x * this.s;
    const by = baseline * this.s;
    const k = this.s / GLYPH_SCALE;
    for (const ch of text) {
      const g = GLYPHS[style].glyphs[ch];
      if (!g) continue;
      if (g.w && g.h) this.glyph(g, maskOf(style, ch, g), pen + g.x * k, by + g.y * k, c);
      pen += g.a * k;
    }
  }

  /** Draw a single glyph centred (by its ink) on (cx, cy) dp. */
  glyphCentered(style: keyof typeof GLYPHS, ch: string, cx: number, cy: number, c: RGBA) {
    const g = GLYPHS[style].glyphs[ch];
    if (!g) return;
    const k = this.s / GLYPH_SCALE;
    // Masks carry a 1px transparent border on each side.
    this.glyph(g, maskOf(style, ch, g), cx * this.s - (g.w * k) / 2, cy * this.s - (g.h * k) / 2, c);
  }

  toPng(): Uint8Array {
    const out = new Uint8Array(this.w * this.h * 4);
    for (let i = 0; i < this.px.length; i += 4) {
      const a = this.px[i + 3];
      if (a <= 0) continue;
      out[i] = Math.round(Math.min(1, this.px[i] / a) * 255);
      out[i + 1] = Math.round(Math.min(1, this.px[i + 1] / a) * 255);
      out[i + 2] = Math.round(Math.min(1, this.px[i + 2] / a) * 255);
      out[i + 3] = Math.round(Math.min(1, a) * 255);
    }
    return encodePng(this.w, this.h, out);
  }
}

const maskCache = new Map<string, Uint8Array>();
function maskOf(style: string, ch: string, g: Glyph): Uint8Array {
  const key = `${style}:${ch}`;
  let m = maskCache.get(key);
  if (!m) {
    m = fromBase64(g.d);
    maskCache.set(key, m);
  }
  return m;
}

/* ─────────────────────────── scheduling ─────────────────────────── */

// Drawing a new marker takes a few tens of milliseconds. Doing a dozen at once
// would freeze the map as it opens, so new images are made one per tick.
const jobs: Array<() => void> = [];
let pumping = false;
function pump() {
  const job = jobs.shift();
  if (job) {
    try { job(); } catch (e) { console.warn('[markerBitmap]', e); }
  }
  if (jobs.length) setTimeout(pump, 0);
  else pumping = false;
}

/** Run `make` off the current render, one image per tick. */
export function scheduleImage(make: () => MarkerImage): Promise<MarkerImage> {
  return new Promise((resolve, reject) => {
    jobs.push(() => {
      try { resolve(make()); } catch (e) { reject(e); }
    });
    if (!pumping) {
      pumping = true;
      setTimeout(pump, 0);
    }
  });
}

/* ─────────────────────────── markers ─────────────────────────── */

export type MarkerImage = { uri: string; anchor: { x: number; y: number } };

const imageCache = new Map<string, MarkerImage>();
const density = () => Math.max(1, Math.min(4, PixelRatio.get()));
const dataUri = (png: Uint8Array) => `data:image/png;base64,${toBase64(png)}`;

const WHITE: RGBA = [255, 255, 255, 1];

/**
 * Parking-spot balloon: coloured balloon, white rounded "P" badge,
 * "₹price/hr" and "N available" (or "Full"), a pointer tail and an anchor dot
 * sitting exactly on the spot's coordinate.
 */
export function spotMarkerImage(price: number, available: boolean, slots?: number): MarkerImage {
  const s = density();
  const priceStr = `₹${Number.isInteger(price) ? price : Number(price).toFixed(1)}`;
  const slotsStr = slots === undefined ? '' : available ? `${slots} available` : 'Full';
  const key = `spot|${s}|${priceStr}|${available ? 1 : 0}|${slotsStr}`;
  const hit = imageCache.get(key);
  if (hit) return hit;

  const color = hex(available ? '#2962FF' : '#9AA0A6');
  const probe = new Canvas(1, 1, s);
  const priceW = probe.textWidth('price', priceStr) + 1 + probe.textWidth('perHr', '/hr');
  const slotsW = slotsStr ? probe.textWidth('slots', slotsStr) : 0;
  const balloonW = Math.ceil(Math.max(112, 10 + 36 + 8 + Math.max(priceW, slotsW) + 12));
  const W = balloonW + 2;
  const H = 88;
  const cx = W / 2;
  const cv = new Canvas(W, H, s);

  cv.roundRect(1, 1, balloonW, 56, 14, color);
  cv.polygon([[cx - 9, 56.5], [cx + 9, 56.5], [cx, 68]], color);
  cv.roundRect(11, 11, 36, 36, 9, WHITE);
  cv.glyphCentered('badge', 'P', 29, 29, color);

  const tx = 1 + 10 + 36 + 8;
  const priceBase = slotsStr ? 28 : 35;
  cv.text('price', priceStr, tx, priceBase, WHITE);
  cv.text('perHr', '/hr', tx + probe.textWidth('price', priceStr) + 1, priceBase, [255, 255, 255, 0.85]);
  if (slotsStr) cv.text('slots', slotsStr, tx, 44, [255, 255, 255, 0.92]);

  const dotY = 79.5;
  cv.circle(cx, dotY, 6.5, WHITE);
  cv.circle(cx, dotY, 4, color);

  const img = { uri: dataUri(cv.toPng()), anchor: { x: 0.5, y: dotY / H } };
  imageCache.set(key, img);
  return img;
}

/** Red destination pin; its tip sits on the coordinate. */
export function destinationPinImage(): MarkerImage {
  const s = density();
  const key = `dest|${s}`;
  const hit = imageCache.get(key);
  if (hit) return hit;
  const W = 36;
  const H = 46;
  const cv = new Canvas(W, H, s);
  const red = hex('#EA4335');
  // soft shadow under the head
  cv.circle(18, 18, 17, [0, 0, 0, 0.18]);
  cv.circle(18, 16.5, 16, WHITE);
  cv.polygon([[10, 26], [26, 26], [18, 44]], WHITE);
  cv.circle(18, 16.5, 13.5, red);
  cv.polygon([[11.8, 25], [24.2, 25], [18, 41]], red);
  cv.circle(18, 16.5, 4.8, WHITE);
  const img = { uri: dataUri(cv.toPng()), anchor: { x: 0.5, y: 43.5 / H } };
  imageCache.set(key, img);
  return img;
}

/**
 * Navigation arrow, standing upright and pointing up (rotate it to the
 * heading). Blue chevron, white outline, soft shadow and a light halo so it
 * reads on both the light and the dark map.
 */
export function navArrowImage(): MarkerImage {
  const s = density();
  const key = `arrow|${s}`;
  const hit = imageCache.get(key);
  if (hit) return hit;
  const S = 60;
  const c = S / 2;
  const cv = new Canvas(S, S, s);
  cv.circle(c, c, 27, [26, 115, 232, 0.16]);
  const chevron = (k: number, dy = 0): Array<[number, number]> =>
    [[0, -19], [15, 17], [0, 9], [-15, 17]].map(([x, y]) => [c + x * k, c + 1 + y * k + dy] as [number, number]);
  cv.polygon(chevron(1.22, 2), [0, 0, 0, 0.28]); // shadow
  cv.polygon(chevron(1.22), WHITE); // outline
  cv.polygon(chevron(1), hex('#1A73E8')); // body
  const img = { uri: dataUri(cv.toPng()), anchor: { x: 0.5, y: 0.5 } };
  imageCache.set(key, img);
  return img;
}
