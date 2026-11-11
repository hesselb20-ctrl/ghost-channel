// Procedural stand-ins for the kinds of content the sender has to carry.
// They are not real footage; they are built to stress the same things:
// near-white with sharp text edges, mid-tone with slow motion, near-black.

import { hashInts } from '../core/prng.ts';

export type ContentKind = 'slide' | 'talking' | 'dark' | 'gray' | 'noise' | 'white' | 'black';

export const CONTENT_KINDS: ContentKind[] = ['slide', 'talking', 'dark', 'gray', 'noise', 'white', 'black'];

const NOISE_N = 256;
let noiseTex: Float32Array | null = null;
/** Tileable multi-octave value noise in [0, 1]. */
function noise(): Float32Array {
  if (noiseTex) return noiseTex;
  const out = new Float32Array(NOISE_N * NOISE_N);
  let amp = 0.5;
  let total = 0;
  for (let cell = 64; cell >= 2; cell >>= 1) {
    const g = NOISE_N / cell;
    for (let y = 0; y < NOISE_N; y++) {
      const fy = y / cell;
      const y0 = Math.floor(fy);
      const ty = smooth(fy - y0);
      for (let x = 0; x < NOISE_N; x++) {
        const fx = x / cell;
        const x0 = Math.floor(fx);
        const tx = smooth(fx - x0);
        const a = lattice(x0 % g, y0 % g, cell);
        const b = lattice((x0 + 1) % g, y0 % g, cell);
        const c = lattice(x0 % g, (y0 + 1) % g, cell);
        const d = lattice((x0 + 1) % g, (y0 + 1) % g, cell);
        out[y * NOISE_N + x] += amp * (a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty);
      }
    }
    total += amp;
    amp *= 0.5;
  }
  for (let i = 0; i < out.length; i++) out[i] /= total;
  noiseTex = out;
  return out;
}
function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}
function lattice(x: number, y: number, s: number): number {
  return hashInts(x, y, s) / 4294967296;
}
function sampleNoise(u: number, v: number): number {
  const n = noise();
  const x = ((Math.floor(u) % NOISE_N) + NOISE_N) % NOISE_N;
  const y = ((Math.floor(v) % NOISE_N) + NOISE_N) % NOISE_N;
  return n[y * NOISE_N + x];
}

/** True when the content does not change over time (lets callers cache). */
export function isStatic(kind: ContentKind): boolean {
  return kind === 'slide' || kind === 'gray' || kind === 'white' || kind === 'black';
}

/** Fills `out` (RGB bytes, sRGB encoded) with the content at time t. */
export function renderContent(kind: ContentKind, w: number, h: number, t: number, out: Uint8Array): void {
  switch (kind) {
    case 'white':
      out.fill(255);
      return;
    case 'black':
      out.fill(0);
      return;
    case 'gray':
      out.fill(128);
      return;
    case 'slide': {
      out.fill(250);
      // Title bar and lines of "text": dark runs of varying length.
      const line = Math.max(3, Math.round(h * 0.03));
      const fill = (x0: number, y0: number, x1: number, y1: number, r: number, g: number, b: number) => {
        for (let y = Math.max(0, y0); y < Math.min(h, y1); y++) {
          for (let x = Math.max(0, x0); x < Math.min(w, x1); x++) {
            const o = (y * w + x) * 3;
            out[o] = r;
            out[o + 1] = g;
            out[o + 2] = b;
          }
        }
      };
      fill(Math.round(w * 0.08), Math.round(h * 0.1), Math.round(w * 0.62), Math.round(h * 0.1) + 2 * line, 24, 24, 28);
      for (let row = 0; row < 9; row++) {
        const y0 = Math.round(h * 0.26 + row * line * 2.1);
        let x = Math.round(w * 0.08);
        let k = 0;
        while (x < w * 0.86) {
          const len = Math.round(w * (0.015 + (hashInts(row, k, 7) % 100) / 2200));
          fill(x, y0, x + len, y0 + line, 40, 40, 46);
          x += len + Math.round(w * 0.012);
          k++;
        }
      }
      // One accent chart block so the slide is not purely grey.
      fill(Math.round(w * 0.7), Math.round(h * 0.62), Math.round(w * 0.9), Math.round(h * 0.88), 0, 113, 227);
      return;
    }
    case 'talking': {
      // Warm blurred room, a head-and-shoulders shape that sways and "talks".
      const hx = w * (0.5 + 0.015 * Math.sin(t * 1.3));
      const hy = h * (0.42 + 0.01 * Math.sin(t * 2.1));
      const mouth = 0.5 + 0.5 * Math.sin(t * 9.0);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const n = sampleNoise(x * 0.35 + 11, y * 0.35 + 5);
          let r = 96 + 50 * n + 30 * (x / w);
          let g = 84 + 44 * n + 18 * (x / w);
          let b = 78 + 40 * n;
          const dx = (x - hx) / (h * 0.17);
          const dy = (y - hy) / (h * 0.23);
          const head = dx * dx + dy * dy;
          const sx = (x - hx) / (h * 0.42);
          const sy = (y - h * 1.02) / (h * 0.38);
          if (sx * sx + sy * sy < 1) {
            r = 52 + 14 * n;
            g = 70 + 14 * n;
            b = 110 + 20 * n;
          }
          if (head < 1) {
            const shade = 1 - 0.25 * head;
            r = 214 * shade;
            g = 168 * shade;
            b = 140 * shade;
            const mx = (x - hx) / (h * 0.06);
            const my = (y - (hy + h * 0.11)) / (h * (0.008 + 0.018 * mouth));
            if (mx * mx + my * my < 1) {
              r = 120;
              g = 50;
              b = 55;
            }
          }
          const o = (y * w + x) * 3;
          out[o] = r;
          out[o + 1] = g;
          out[o + 2] = b;
        }
      }
      return;
    }
    case 'dark': {
      // Night scene: almost black, one slow warm light, fine grain.
      const lx = w * (0.3 + 0.25 * Math.sin(t * 0.4));
      const ly = h * 0.45;
      const frame = Math.floor(t * 24);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const d2 = ((x - lx) * (x - lx) + (y - ly) * (y - ly)) / (h * h * 0.09);
          const glow = 46 / (1 + 3 * d2);
          const n = sampleNoise(x * 0.5 + t * 6, y * 0.5);
          const grain = ((hashInts(x, y, frame) & 0xff) / 255 - 0.5) * 5;
          const base = 6 + 14 * n + grain;
          const o = (y * w + x) * 3;
          out[o] = Math.max(0, Math.min(255, base + glow * 1.0));
          out[o + 1] = Math.max(0, Math.min(255, base + glow * 0.72));
          out[o + 2] = Math.max(0, Math.min(255, base * 1.15 + glow * 0.4));
        }
      }
      return;
    }
    case 'noise': {
      // Busy natural-looking texture that pans: worst case for texture x shake.
      const ox = t * 14;
      const oy = t * 5;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const n1 = sampleNoise(x * 0.9 + ox, y * 0.9 + oy);
          const n2 = sampleNoise(x * 0.45 + 90 - ox * 0.3, y * 0.45 + 40);
          const o = (y * w + x) * 3;
          out[o] = 40 + 190 * n1;
          out[o + 1] = 50 + 150 * (0.6 * n1 + 0.4 * n2);
          out[o + 2] = 60 + 160 * n2;
        }
      }
      return;
    }
  }
}
