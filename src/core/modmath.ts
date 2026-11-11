// Modulation maths: the temporal waveform, the in-cell spatial pattern and a
// CPU reference of the sender's fragment shader. The simulator renders with
// this file; src/send/shader.ts implements the same formulas in GLSL.

import type { Preset } from './presets.ts';

export type Axis = 'luma' | 'chroma';

export interface ModParams {
  /** Peak modulation as a fraction of the local pixel value (Weber contrast). */
  amplitude: number;
  axis: Axis;
  /** Additive floor in linear light so dark pixels still carry a little signal. */
  floor: number;
  /** In-cell checker edge softness, 0 (hard) .. 1 (pure sine). */
  softness: number;
  /** Envelope of the first and last carrier cycle of each symbol. */
  edgeGain: number;
  /** Encoded-range compression: content is remapped to [h, 1-h] to leave headroom. */
  rangeCompress: number;
  /** Display transfer: 0 = sRGB piecewise curve, otherwise a pure power law. */
  displayGamma: number;
}

export const DEFAULT_MOD: ModParams = {
  amplitude: 0.03,
  axis: 'chroma',
  floor: 0.004,
  softness: 0.5,
  edgeGain: 0.7,
  rangeCompress: 0.015,
  displayGamma: 0,
};

// Rec. 709 luminance weights (linear light).
export const LUM_R = 0.2126;
export const LUM_G = 0.7152;
export const LUM_B = 0.0722;

export function srgbToLinear(v: number): number {
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}
export function linearToSrgb(v: number): number {
  return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}
export function decodeDisplay(v: number, gamma: number): number {
  return gamma > 0 ? Math.pow(v, gamma) : srgbToLinear(v);
}
export function encodeDisplay(v: number, gamma: number): number {
  return gamma > 0 ? Math.pow(v, 1 / gamma) : linearToSrgb(v);
}

export interface SymbolPos {
  /** Symbol index since t = 0. */
  index: number;
  /** Envelope for this instant (edge cycles are attenuated). */
  env: number;
}

/**
 * Symbol index and envelope at time t. The envelope is constant across each
 * carrier cycle, so every cycle stays zero-mean on its own.
 */
export function symbolAt(t: number, preset: Preset, edgeGain: number): SymbolPos {
  const cyclesTotal = t * preset.carrierHz + 1e-7;
  const n = preset.cyclesPerSymbol;
  const index = Math.floor(cyclesTotal / n);
  const cyc = Math.floor(cyclesTotal - index * n);
  const edge = n > 2 && (cyc === 0 || cyc === n - 1);
  return { index, env: edge ? edgeGain : 1 };
}

/** Carrier value for a cell with quadrant q (0..3) at time t. */
export function carrier(t: number, carrierHz: number, q: number): number {
  return Math.cos(2 * Math.PI * carrierHz * t + (Math.PI / 2) * q);
}

function smooth01(x: number): number {
  const t = x < 0 ? 0 : x > 1 ? 1 : x;
  return t * t * (3 - 2 * t);
}

/** One axis of the in-cell pattern: + on the first half, − on the second. */
export function pattern1(frac: number, softness: number): number {
  const s = Math.sin(2 * Math.PI * frac);
  const e = Math.max(softness, 1e-3);
  return s >= 0 ? smooth01(s / e) : -smooth01(-s / e);
}

export interface PixelDelta {
  dr: number;
  dg: number;
  db: number;
}

/**
 * Peak linear-light excursion for one pixel, before the pattern and carrier
 * are applied. The excursion is scaled down symmetrically wherever the pixel
 * lacks headroom, so +delta and -delta always cancel.
 */
export function pixelDelta(r: number, g: number, b: number, m: ModParams, out: PixelDelta): void {
  const A = m.amplitude;
  let dr: number;
  let dg: number;
  let db: number;
  if (m.axis === 'luma') {
    dr = A * (r + m.floor);
    dg = A * (g + m.floor);
    db = A * (b + m.floor);
  } else {
    // Blue up, red and green down by just enough to hold luminance constant.
    db = A * (b + m.floor);
    const denom = LUM_R * (r + m.floor) + LUM_G * (g + m.floor);
    const k = (LUM_B * db) / denom;
    dr = -k * (r + m.floor);
    dg = -k * (g + m.floor);
  }
  let s = 1;
  const ar = Math.abs(dr);
  const ag = Math.abs(dg);
  const ab = Math.abs(db);
  const hr = Math.min(r, 1 - r);
  const hg = Math.min(g, 1 - g);
  const hb = Math.min(b, 1 - b);
  if (ar > hr) s = Math.min(s, hr / ar);
  if (ag > hg) s = Math.min(s, hg / ag);
  if (ab > hb) s = Math.min(s, hb / ab);
  if (s < 0) s = 0;
  out.dr = dr * s;
  out.dg = dg * s;
  out.db = db * s;
}

/** Deterministic per-pixel dither in [-0.5, 0.5), triangular-ish, varies per frame. */
export function ditherNoise(x: number, y: number, frame: number, ch: number): number {
  let h = (Math.imul(x, 0x1f123bb5) ^ Math.imul(y, 0x5f356495) ^ Math.imul(frame, 0x6c8e9cf5) ^ Math.imul(ch + 1, 0x3c6ef372)) >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  h = Math.imul(h, 0x297a2d39);
  h ^= h >>> 15;
  const a = (h & 0xffff) / 65536;
  const b = (h >>> 16) / 65536;
  return (a + b) * 0.5 - 0.5;
}

export interface RenderInput {
  width: number;
  height: number;
  /** sRGB-encoded content, RGBA or RGB bytes. */
  content: Uint8Array | Uint8ClampedArray;
  contentChannels: 3 | 4;
  preset: Preset;
  /** Quadrant per grid cell for the current symbol (Transmitter.symbolCells). */
  cells: Uint8Array;
  /** Presentation time of this display frame, seconds. */
  t: number;
  /** Envelope from symbolAt(), times any global fade. */
  env: number;
  frameIndex: number;
  mod: ModParams;
}

const LUT_CACHE = new Map<string, Float32Array>();
/** 8-bit content code -> linear light, with the range compression folded in. */
function contentLut(gamma: number, h: number): Float32Array {
  const key = gamma + '/' + h;
  let lut = LUT_CACHE.get(key);
  if (!lut) {
    lut = new Float32Array(256);
    for (let i = 0; i < 256; i++) lut[i] = decodeDisplay(h + (i / 255) * (1 - 2 * h), gamma);
    LUT_CACHE.set(key, lut);
  }
  return lut;
}
const ENC_N = 8192;
const ENC_CACHE = new Map<number, Float32Array>();
function encodeLut(gamma: number): Float32Array {
  let lut = ENC_CACHE.get(gamma);
  if (!lut) {
    lut = new Float32Array(ENC_N + 2);
    for (let i = 0; i <= ENC_N + 1; i++) lut[i] = encodeDisplay(Math.min(1, i / ENC_N), gamma) * 255;
    ENC_CACHE.set(gamma, lut);
  }
  return lut;
}

/** Renders one modulated display frame into `out` (RGB bytes, sRGB encoded). */
export function renderFrame(inp: RenderInput, out: Uint8Array): void {
  const { width: W, height: H, content, contentChannels: cc, preset, cells, mod } = inp;
  const { cols, rows } = preset;
  const lut = contentLut(mod.displayGamma, mod.rangeCompress);
  const enc = encodeLut(mod.displayGamma);
  const wave = new Float32Array(cols * rows);
  for (let i = 0; i < wave.length; i++) wave[i] = inp.env * carrier(inp.t, preset.carrierHz, cells[i]);
  const px = new Float32Array(W);
  const cx = new Int32Array(W);
  for (let x = 0; x < W; x++) {
    const u = ((x + 0.5) / W) * cols;
    cx[x] = Math.min(cols - 1, Math.floor(u));
    px[x] = pattern1(u - cx[x], mod.softness);
  }
  const d: PixelDelta = { dr: 0, dg: 0, db: 0 };
  const f = inp.frameIndex;
  for (let y = 0; y < H; y++) {
    const v = ((y + 0.5) / H) * rows;
    const cy = Math.min(rows - 1, Math.floor(v));
    const py = pattern1(v - cy, mod.softness);
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * cc;
      const r = lut[content[i]];
      const g = lut[content[i + 1]];
      const b = lut[content[i + 2]];
      pixelDelta(r, g, b, mod, d);
      const m = px[x] * py * wave[cy * cols + cx[x]];
      const o = (y * W + x) * 3;
      out[o] = quant(enc, r + m * d.dr, x, y, f, 0);
      out[o + 1] = quant(enc, g + m * d.dg, x, y, f, 1);
      out[o + 2] = quant(enc, b + m * d.db, x, y, f, 2);
    }
  }
}

function quant(enc: Float32Array, lin: number, x: number, y: number, f: number, ch: number): number {
  const p = (lin < 0 ? 0 : lin > 1 ? 1 : lin) * ENC_N;
  const i = p | 0;
  const v = enc[i] + (enc[i + 1] - enc[i]) * (p - i);
  const q = Math.floor(v + 0.5 + ditherNoise(x, y, f, ch));
  return q < 0 ? 0 : q > 255 ? 255 : q;
}
