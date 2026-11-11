// Simulated display and camera.
//
// Display: sample-and-hold frames at the refresh rate, scanned top to bottom
// over part of the frame period, with an optional sluggish pixel response and
// optional dropped (repeated) frames.
//
// Camera: pinhole projection of the screen, rolling shutter (each sensor row
// starts its exposure a little later), box exposure integrated over the
// display frames it overlaps, lens blur, auto-exposure and white-balance
// drift, hand shake, shot and read noise, gamma encoding, optional JPEG-like
// compression, dropped frames and its own slightly-off clock.

import { symbolAt, renderFrame, decodeDisplay, type ModParams } from '../core/modmath.ts';
import type { Transmitter } from '../core/packet.ts';
import { invertH, squareToQuad, type Quad } from '../core/homography.ts';
import { gaussian, hashInts, mulberry32, toUnit } from '../core/prng.ts';
import { isStatic, renderContent, type ContentKind } from './content.ts';
import { jpegRoundTrip } from './jpeg.ts';

export interface DisplayParams {
  w: number;
  h: number;
  refreshHz: number;
  /** Fraction of the frame period taken to scan from the top row to the bottom row. */
  scanFrac: number;
  /** Fraction of the previous frame still showing (slow pixel response). */
  responseMix: number;
  /** Probability that the sender misses a frame and the previous one repeats. */
  dropProb: number;
  /** True transfer function of the panel: 0 = sRGB, else a power law. */
  trueGamma: number;
  /** Peak white in arbitrary linear units (1 = reference). */
  brightness: number;
}

export const DEFAULT_DISPLAY: DisplayParams = {
  w: 640,
  h: 360,
  refreshHz: 60,
  scanFrac: 0.9,
  responseMix: 0.15,
  dropProb: 0,
  trueGamma: 0,
  brightness: 1,
};

export class DisplaySim {
  readonly p: DisplayParams;
  readonly period: number;
  private readonly tx: Transmitter;
  private readonly mod: ModParams;
  private readonly kind: ContentKind;
  private readonly content: Uint8Array;
  private contentReady = false;
  private readonly bytes: Uint8Array;
  private readonly cache = new Map<number, Float32Array>();
  private readonly lut = new Float32Array(256);
  private readonly seed: number;
  private readonly shown = new Map<number, number>();
  framesRendered = 0;
  framesDropped = 0;

  constructor(p: DisplayParams, tx: Transmitter, mod: ModParams, kind: ContentKind, seed: number) {
    this.p = p;
    this.period = 1 / p.refreshHz;
    this.tx = tx;
    this.mod = mod;
    this.kind = kind;
    this.content = new Uint8Array(p.w * p.h * 3);
    this.bytes = new Uint8Array(p.w * p.h * 3);
    for (let i = 0; i < 256; i++) this.lut[i] = decodeDisplay(i / 255, p.trueGamma) * p.brightness;
    this.seed = seed;
  }

  /** Which rendered frame is on the panel during refresh slot n (drops repeat the previous one). */
  private sourceFrame(n: number): number {
    if (this.p.dropProb <= 0 || n <= 0) return n;
    let s = this.shown.get(n);
    if (s === undefined) {
      const dropped = toUnit(hashInts(this.seed, 0x51ed, n)) < this.p.dropProb;
      s = dropped ? this.sourceFrame(n - 1) : n;
      if (dropped) this.framesDropped++;
      this.shown.set(n, s);
    }
    return s;
  }

  /** Linear-light RGB of the frame shown in refresh slot n. */
  frame(n: number): Float32Array {
    const src = this.sourceFrame(n);
    let f = this.cache.get(src);
    if (f) return f;
    const { w, h } = this.p;
    const t = src * this.period;
    if (!this.contentReady || !isStatic(this.kind)) {
      renderContent(this.kind, w, h, t, this.content);
      this.contentReady = true;
    }
    const pos = symbolAt(t, this.tx.layout.preset, this.mod.edgeGain);
    renderFrame(
      {
        width: w,
        height: h,
        content: this.content,
        contentChannels: 3,
        preset: this.tx.layout.preset,
        cells: this.tx.symbolCells(pos.index),
        t,
        env: pos.env,
        frameIndex: src,
        mod: this.mod,
      },
      this.bytes,
    );
    f = new Float32Array(w * h * 3);
    const { lut, bytes } = this;
    for (let i = 0; i < f.length; i++) f[i] = lut[bytes[i]];
    this.cache.set(src, f);
    this.framesRendered++;
    if (this.cache.size > 16) {
      const oldest = Math.min(...this.cache.keys());
      this.cache.delete(oldest);
    }
    return f;
  }
}

export interface CameraParams {
  w: number;
  h: number;
  fps: number;
  /** Exposure time in seconds. */
  exposure: number;
  /** Rolling-shutter readout time for the full sensor height, seconds. */
  readout: number;
  /** Camera clock error against the display clock, parts per million. */
  clockPpm: number;
  /** Standard deviation of the reported timestamp, seconds. */
  tsJitter: number;
  /** Distance to the screen in screen widths (0.4 m from a 0.3 m wide panel is 1.33). */
  distance: number;
  yawDeg: number;
  pitchDeg: number;
  rollDeg: number;
  /** Horizontal field of view in degrees. */
  fovDeg: number;
  /** Lens and demosaic blur, Gaussian sigma in camera pixels. */
  blurSigma: number;
  /** Noise near black, in 8-bit code values after gamma. */
  noiseRead: number;
  /** Noise at mid-grey (code 128), in 8-bit code values after gamma. */
  noiseMid: number;
  /** Auto-exposure drift: relative gain swing and its period. */
  aeAmp: number;
  aePeriod: number;
  /** White-balance drift of the blue gain. */
  wbAmp: number;
  /** Hand shake: peak displacement in pixels. */
  shakePx: number;
  /** Veiling glare added to the screen area, linear fraction of white. */
  glare: number;
  /** Mains flicker of room light on the background (0 = off), relative depth. */
  ambientFlicker: number;
  ambientHz: number;
  /** Background brightness, linear. */
  background: number;
  dropProb: number;
  /** 0 disables; otherwise JPEG-like quality 1..100. */
  jpegQuality: number;
  /** Overall exposure gain so that display white lands below clipping. */
  gain: number;
}

export const DEFAULT_CAMERA: CameraParams = {
  w: 640,
  h: 360,
  fps: 30,
  exposure: 1 / 100,
  readout: 0.02,
  clockPpm: 120,
  tsJitter: 0.0005,
  distance: 1.33,
  yawDeg: 0,
  pitchDeg: 0,
  rollDeg: 0,
  fovDeg: 65,
  blurSigma: 0.8,
  noiseRead: 1.0,
  noiseMid: 1.5,
  aeAmp: 0.02,
  aePeriod: 3.1,
  wbAmp: 0.01,
  shakePx: 0,
  glare: 0.01,
  ambientFlicker: 0,
  ambientHz: 100,
  background: 0.03,
  dropProb: 0,
  jpegQuality: 0,
  gain: 0.82,
};

/** Screen corners in camera pixels for a pinhole camera looking at the screen centre. */
export function projectScreen(c: CameraParams, aspect: number, dx = 0, dy = 0, extraRoll = 0): Quad {
  const f = c.w / 2 / Math.tan((c.fovDeg * Math.PI) / 360);
  const yaw = (c.yawDeg * Math.PI) / 180;
  const pitch = (c.pitchDeg * Math.PI) / 180;
  const roll = (c.rollDeg * Math.PI) / 180 + extraRoll;
  const corners: [number, number][] = [
    [-0.5, -0.5 / aspect],
    [0.5, -0.5 / aspect],
    [0.5, 0.5 / aspect],
    [-0.5, 0.5 / aspect],
  ];
  return corners.map(([x, y]) => {
    // Rotate the screen plane: yaw about the vertical axis, then pitch about the horizontal.
    const x1 = x * Math.cos(yaw);
    const zYaw = x * Math.sin(yaw);
    const y1 = y * Math.cos(pitch) - zYaw * Math.sin(pitch);
    const z1 = y * Math.sin(pitch) + zYaw * Math.cos(pitch);
    const z = c.distance + z1;
    const px = (f * x1) / z;
    const py = (f * y1) / z;
    const rx = px * Math.cos(roll) - py * Math.sin(roll);
    const ry = px * Math.sin(roll) + py * Math.cos(roll);
    return { x: c.w / 2 + rx + dx, y: c.h / 2 + ry + dy };
  }) as Quad;
}

const NOISE_TABLE = (() => {
  const g = gaussian(mulberry32(0x0badf00d));
  const t = new Float32Array(1 << 18);
  for (let i = 0; i < t.length; i++) t[i] = g();
  return t;
})();

export interface CameraFrame {
  rgba: Uint8ClampedArray;
  /** Timestamp the camera reports (its own clock, with jitter). */
  t: number;
  /** True mid-exposure time of the middle row, display clock. */
  tTrue: number;
  quad: Quad;
}

export class CameraSim {
  readonly p: CameraParams;
  private readonly display: DisplaySim;
  private readonly rng: () => number;
  private readonly gauss: () => number;
  private readonly t0: number;
  private readonly shakePhase: number[];
  private readonly lin: Float32Array;
  private readonly tmp: Float32Array;
  private readonly bg: Float32Array;
  framesProduced = 0;

  constructor(p: CameraParams, display: DisplaySim, seed: number) {
    this.p = p;
    this.display = display;
    this.rng = mulberry32(seed);
    this.gauss = gaussian(this.rng);
    // Random start phase against the display clock and the symbol clock.
    this.t0 = 0.35 + toUnit(this.rng()) * 0.5;
    this.shakePhase = Array.from({ length: 8 }, () => toUnit(this.rng()) * 2 * Math.PI);
    this.lin = new Float32Array(p.w * p.h * 3);
    this.tmp = new Float32Array(p.w * p.h * 3);
    this.bg = new Float32Array(p.w * p.h);
    // Static room behind the screen: soft lighting gradient, a few hard-edged
    // objects of random size and brightness, fine surface texture.
    const brng = mulberry32(seed ^ 0x77aa);
    const s = p.w / 640;
    for (let y = 0; y < p.h; y++) {
      for (let x = 0; x < p.w; x++) {
        this.bg[y * p.w + x] = 0.75 + 0.35 * Math.sin(x / (170 * s) + 1.3) * Math.cos(y / (120 * s));
      }
    }
    for (let i = 0; i < 14; i++) {
      const x0 = Math.floor(toUnit(brng()) * p.w);
      const y0 = Math.floor(toUnit(brng()) * p.h);
      const bw = Math.floor((20 + toUnit(brng()) * 150) * s);
      const bh = Math.floor((15 + toUnit(brng()) * 110) * s);
      const lvl = 0.45 + toUnit(brng()) * 1.1;
      for (let y = y0; y < Math.min(p.h, y0 + bh); y++) {
        for (let x = x0; x < Math.min(p.w, x0 + bw); x++) this.bg[y * p.w + x] = lvl;
      }
    }
    for (let i = 0; i < this.bg.length; i++) this.bg[i] = p.background * this.bg[i] * (0.94 + 0.12 * toUnit(brng()));
  }

  private shake(t: number): { dx: number; dy: number; roll: number } {
    const a = this.p.shakePx;
    if (a <= 0) return { dx: 0, dy: 0, roll: 0 };
    const ph = this.shakePhase;
    // Slow drift plus physiological tremor near 8-10 Hz.
    const dx = a * (0.7 * Math.sin(2 * Math.PI * 0.6 * t + ph[0]) + 0.25 * Math.sin(2 * Math.PI * 2.3 * t + ph[1]) + 0.12 * Math.sin(2 * Math.PI * 9 * t + ph[2]));
    const dy = a * (0.7 * Math.sin(2 * Math.PI * 0.45 * t + ph[3]) + 0.25 * Math.sin(2 * Math.PI * 1.9 * t + ph[4]) + 0.12 * Math.sin(2 * Math.PI * 8.2 * t + ph[5]));
    const roll = (a / this.p.w) * 0.6 * Math.sin(2 * Math.PI * 0.5 * t + ph[6]);
    return { dx, dy, roll };
  }

  /** Renders camera frame k, or null when the camera drops it. */
  capture(k: number): CameraFrame | null {
    const p = this.p;
    const d = this.display;
    const dp = d.p;
    const Td = d.period;
    // Start of exposure of the first sensor row, in display time.
    const ts = this.t0 + (k / p.fps) * (1 + p.clockPpm * 1e-6);
    const tMid = ts + p.readout / 2 + p.exposure / 2;
    const reported = tMid + this.gauss() * p.tsJitter;
    if (p.dropProb > 0 && toUnit(this.rng()) < p.dropProb) return null;

    const sh = this.shake(tMid);
    const quad = projectScreen(p, dp.w / dp.h, sh.dx, sh.dy, sh.roll);
    const Hinv = invertH(squareToQuad(quad));
    const lin = this.lin;
    const scanT = dp.scanFrac * Td;
    const alpha = dp.responseMix;
    const exposure = p.exposure;
    const ae = 1 + p.aeAmp * Math.sin((2 * Math.PI * tMid) / p.aePeriod);
    const gain = p.gain * ae;
    const flick = p.ambientFlicker;

    // Every display frame any pixel of this exposure can touch.
    const nMin = Math.floor((ts - scanT) / Td) - 1;
    const nMax = Math.floor((ts + p.readout + exposure) / Td);
    const F: Float32Array[] = [];
    for (let n = nMin; n <= nMax; n++) F.push(d.frame(Math.max(0, n)));

    for (let y = 0; y < p.h; y++) {
      const rowStart = ts + (y / p.h) * p.readout;
      // Room light flicker integrated over this row's exposure.
      let amb = 1;
      if (flick > 0) {
        const w = 2 * Math.PI * p.ambientHz;
        amb = 1 + (flick * (Math.sin(w * (rowStart + exposure)) - Math.sin(w * rowStart))) / (w * exposure);
      }
      for (let x = 0; x < p.w; x++) {
        const o = (y * p.w + x) * 3;
        const X = x + 0.5;
        const Y = y + 0.5;
        const den = Hinv[6] * X + Hinv[7] * Y + Hinv[8];
        const u = (Hinv[0] * X + Hinv[1] * Y + Hinv[2]) / den;
        const v = (Hinv[3] * X + Hinv[4] * Y + Hinv[5]) / den;
        if (!(u >= 0 && u < 1 && v >= 0 && v < 1)) {
          const b = this.bg[y * p.w + x] * amb * gain;
          lin[o] = b * 1.05;
          lin[o + 1] = b;
          lin[o + 2] = b * 0.9;
          continue;
        }
        // Bilinear sample position in display pixels.
        const fx = u * dp.w - 0.5;
        const fy = v * dp.h - 0.5;
        let x0 = Math.floor(fx);
        let y0 = Math.floor(fy);
        const ax = fx - x0;
        const ay = fy - y0;
        let x1 = x0 + 1;
        let y1 = y0 + 1;
        if (x0 < 0) x0 = 0;
        if (y0 < 0) y0 = 0;
        if (x1 >= dp.w) x1 = dp.w - 1;
        if (y1 >= dp.h) y1 = dp.h - 1;
        const i00 = (y0 * dp.w + x0) * 3;
        const i10 = (y0 * dp.w + x1) * 3;
        const i01 = (y1 * dp.w + x0) * 3;
        const i11 = (y1 * dp.w + x1) * 3;
        const w00 = (1 - ax) * (1 - ay);
        const w10 = ax * (1 - ay);
        const w01 = (1 - ax) * ay;
        const w11 = ax * ay;
        // This display row switched to frame n at n*Td + v*scanT.
        const s = rowStart - v * scanT;
        const e = s + exposure;
        const n0 = Math.floor(s / Td);
        const n1 = Math.floor(e / Td);
        let r = 0;
        let g = 0;
        let b = 0;
        for (let n = n0; n <= n1; n++) {
          const lo = Math.max(s, n * Td);
          const hi = Math.min(e, (n + 1) * Td);
          const wt = (hi - lo) / exposure;
          if (wt <= 0) continue;
          for (let pass = 0; pass < 2; pass++) {
            const ww = pass === 0 ? wt * (1 - alpha) : wt * alpha;
            if (ww <= 0) continue;
            const f = F[(pass === 0 ? n : n - 1) - nMin];
            r += ww * (w00 * f[i00] + w10 * f[i10] + w01 * f[i01] + w11 * f[i11]);
            g += ww * (w00 * f[i00 + 1] + w10 * f[i10 + 1] + w01 * f[i01 + 1] + w11 * f[i11 + 1]);
            b += ww * (w00 * f[i00 + 2] + w10 * f[i10 + 2] + w01 * f[i01 + 2] + w11 * f[i11 + 2]);
          }
        }
        lin[o] = (r + p.glare * amb) * gain;
        lin[o + 1] = (g + p.glare * amb) * gain;
        lin[o + 2] = (b + p.glare * amb) * gain;
      }
    }

    if (p.blurSigma > 0.05) gaussBlur(lin, this.tmp, p.w, p.h, p.blurSigma);

    // Sensor noise in linear space, then white balance, gamma, quantisation.
    const rgba = new Uint8ClampedArray(p.w * p.h * 4);
    const wbB = 1 + p.wbAmp * Math.sin((2 * Math.PI * tMid) / 4.3);
    // Linear-domain model sigma^2 = a^2 + b*v, fitted to the two code-value
    // figures through the slope of the sRGB curve near black (3295 codes per
    // unit) and at mid-grey (273 codes per unit at v = 0.216).
    const na = p.noiseRead / 3295;
    const nb = Math.max(0, ((p.noiseMid / 273) ** 2 - na * na) / 0.216);
    let ni = (this.rng() >>> 0) % NOISE_TABLE.length;
    const mask = NOISE_TABLE.length - 1;
    const n = p.w * p.h;
    for (let i = 0; i < n; i++) {
      const o = i * 3;
      for (let ch = 0; ch < 3; ch++) {
        let v = lin[o + ch];
        v += Math.sqrt(na * na + nb * (v > 0 ? v : 0)) * NOISE_TABLE[ni];
        ni = (ni + 1) & mask;
        if (ch === 2) v *= wbB;
        v = v <= 0 ? 0 : v >= 1 ? 1 : v;
        v = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
        rgba[i * 4 + ch] = v * 255;
      }
      rgba[i * 4 + 3] = 255;
    }
    if (p.jpegQuality > 0) jpegRoundTrip(rgba, p.w, p.h, p.jpegQuality);
    this.framesProduced++;
    return { rgba, t: reported, tTrue: tMid, quad };
  }
}

function gaussBlur(img: Float32Array, tmp: Float32Array, w: number, h: number, sigma: number): void {
  const r = Math.max(1, Math.ceil(sigma * 2.5));
  const k = new Float32Array(2 * r + 1);
  let sum = 0;
  for (let i = -r; i <= r; i++) {
    k[i + r] = Math.exp((-i * i) / (2 * sigma * sigma));
    sum += k[i + r];
  }
  for (let i = 0; i < k.length; i++) k[i] /= sum;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let a = 0;
      let b = 0;
      let c = 0;
      for (let i = -r; i <= r; i++) {
        const xx = x + i < 0 ? 0 : x + i >= w ? w - 1 : x + i;
        const o = (y * w + xx) * 3;
        const kw = k[i + r];
        a += kw * img[o];
        b += kw * img[o + 1];
        c += kw * img[o + 2];
      }
      const o = (y * w + x) * 3;
      tmp[o] = a;
      tmp[o + 1] = b;
      tmp[o + 2] = c;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let a = 0;
      let b = 0;
      let c = 0;
      for (let i = -r; i <= r; i++) {
        const yy = y + i < 0 ? 0 : y + i >= h ? h - 1 : y + i;
        const o = (yy * w + x) * 3;
        const kw = k[i + r];
        a += kw * tmp[o];
        b += kw * tmp[o + 1];
        c += kw * tmp[o + 2];
      }
      const o = (y * w + x) * 3;
      img[o] = a;
      img[o + 1] = b;
      img[o + 2] = c;
    }
  }
}
