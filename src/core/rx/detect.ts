// Finding the screen without any visible marker.
//
// Only modulated pixels oscillate at the carrier frequency. For every pixel of
// a reduced-size map we fit DC + carrier over the last few frames and compare
// the carrier power with the residual power. The ratio is high on the sender's
// canvas and near its noise-only value everywhere else, including on moving
// or shaking scene content (which raises carrier and residual power alike).
// The outline of that region gives the four corners.
//
// A second detector thresholds plain brightness; it proposes the lit screen
// when the modulation is too faint for the energy map and leaves it to the
// lock metric to accept or reject the proposal.

import type { Pt, Quad } from '../homography.ts';
import { carrierFit, smoothPlane, type Frame, type PlaneName } from './frame.ts';

export interface DetectorOptions {
  /** Map pixels are point samples of the frame taken every `step` pixels. */
  step: number;
  /** Number of frames per fit. */
  window: number;
  /** Box radius, in map pixels, for smoothing the power maps. */
  smoothRadius: number;
  /** Smallest plateau-above-floor ratio difference that counts as a screen. */
  minRise: number;
  minAreaFrac: number;
}

export interface Detection {
  quad: Quad;
  plane: PlaneName;
  score: number;
  kind: 'energy' | 'bright' | 'manual';
}

export class Detector {
  readonly mw: number;
  readonly mh: number;
  private readonly opt: DetectorOptions;
  private readonly ring: { t: number; luma: Float32Array; chroma: Float32Array }[] = [];
  /** Running carrier-power and residual-power maps, one set per carrier. */
  private readonly acc = new Map<
    number,
    { a: Record<PlaneName, Float32Array>; r: Record<PlaneName, Float32Array>; n: number; floor: number }
  >();
  private lastLuma: Float32Array | null = null;
  /** Last ratio map, for diagnostics. */
  ratio: Float32Array;
  private ratioScore = -1;
  /** Threshold used on `ratio` in the last find(), for diagnostics. */
  lastCut = 0;
  readonly w: number;
  readonly h: number;

  constructor(w: number, h: number, opt: Partial<DetectorOptions> = {}) {
    this.w = w;
    this.h = h;
    this.opt = { step: 2, window: 5, smoothRadius: 6, minRise: 0.12, minAreaFrac: 0.012, ...opt };
    this.mw = Math.floor(w / this.opt.step);
    this.mh = Math.floor(h / this.opt.step);
    this.ratio = new Float32Array(this.mw * this.mh);
  }

  reset(): void {
    this.ring.length = 0;
    this.acc.clear();
  }

  setWindow(n: number): void {
    this.opt.window = Math.max(4, Math.min(16, n));
  }

  get ready(): boolean {
    return this.ring.length >= this.opt.window;
  }

  push(frame: Frame): void {
    const { mw, mh } = this;
    const step = this.opt.step;
    const luma = new Float32Array(mw * mh);
    const chroma = new Float32Array(mw * mh);
    // Point samples of the 3x3-filtered planes: each map pixel averages nine
    // frame pixels (9x less noise power) without mixing neighbouring quadrants.
    const srcL = smoothPlane(frame, 'luma');
    const srcC = smoothPlane(frame, 'chroma');
    for (let y = 0; y < mh; y++) {
      const row = y * step * frame.w;
      for (let x = 0; x < mw; x++) {
        luma[y * mw + x] = srcL[row + x * step];
        chroma[y * mw + x] = srcC[row + x * step];
      }
    }
    this.lastLuma = luma;
    // Remove the local mean so that spatially smooth temporal changes
    // (auto-exposure, mains flicker of room lights) do not count as signal.
    this.ring.push({ t: frame.t, luma: highpass(luma, mw, mh, 6), chroma: highpass(chroma, mw, mh, 6) });
    while (this.ring.length > this.opt.window) this.ring.shift();
  }

  /** Runs the fit for the given carrier and folds it into the running maps. */
  accumulate(carrierHz: number): boolean {
    if (!this.ready) return false;
    const n = this.ring.length;
    const fit = carrierFit(
      this.ring.map((f) => f.t),
      carrierHz,
      this.ring[0].t,
    );
    if (!fit.ok || n < 4) return false;
    const N = this.mw * this.mh;
    const decay = 0.93;
    let slot = this.acc.get(carrierHz);
    if (!slot) {
      slot = {
        a: { luma: new Float32Array(N), chroma: new Float32Array(N) },
        r: { luma: new Float32Array(N), chroma: new Float32Array(N) },
        n: 0,
        floor: fit.noiseGain,
      };
      this.acc.set(carrierHz, slot);
    }
    for (const p of ['luma', 'chroma'] as PlaneName[]) {
      const accA = slot.a[p];
      const accR = slot.r[p];
      const planes = this.ring.map((f) => f[p]);
      for (let i = 0; i < N; i++) {
        let zr = 0;
        let zi = 0;
        let dc = 0;
        let sxx = 0;
        let sx = 0;
        let sxc = 0;
        let sxs = 0;
        for (let k = 0; k < n; k++) {
          const x = planes[k][i];
          zr += fit.wr[k] * x;
          zi += fit.wi[k] * x;
          dc += fit.wdc[k] * x;
          sxx += x * x;
          sx += x;
          sxc += x * fit.bc[k];
          sxs += x * fit.bs[k];
        }
        // Residual sum of squares of a least-squares fit: x'x - beta'B'x.
        const rss = Math.max(0, sxx - (dc * sx + zr * sxc + zi * sxs));
        accA[i] = accA[i] * decay + zr * zr + zi * zi;
        accR[i] = accR[i] * decay + rss / (n - 3);
      }
    }
    slot.n++;
    slot.floor += 0.2 * (fit.noiseGain - slot.floor);
    return true;
  }

  /** Candidate quads in frame pixel coordinates, best first. */
  find(): Detection[] {
    const out: Detection[] = [];
    const { mw, mh } = this;
    const N = mw * mh;
    const step = this.opt.step;
    let best: Detection | null = null;
    this.ratioScore = -1;
    for (const slot of this.acc.values()) {
      if (slot.n < 2) continue;
      for (const p of ['luma', 'chroma'] as PlaneName[]) {
        const sA = boxBlur(slot.a[p], mw, mh, this.opt.smoothRadius);
        const sR = boxBlur(slot.r[p], mw, mh, this.opt.smoothRadius);
        const ratio = new Float32Array(N);
        const mask = new Uint8Array(N);
        // 0.02 is a noise floor in squared code values; it stops noiseless
        // flat regions from producing huge ratios.
        for (let i = 0; i < N; i++) ratio[i] = sA[i] / (sR[i] + 0.02);
        // With noise alone the ratio sits at the fit's noise gain (0.67 for six
        // evenly spaced frames). The screen forms a plateau above it. Cutting
        // halfway up puts the contour on the true edge even though the maps
        // are heavily smoothed.
        const floor = slot.floor;
        const above: number[] = [];
        for (let i = 0; i < N; i++) if (ratio[i] > floor + this.opt.minRise) above.push(ratio[i]);
        const enough = above.length >= this.opt.minAreaFrac * N;
        above.sort((x, y) => x - y);
        const plateau = enough ? above[above.length >> 1] : floor;
        const cut = floor + 0.5 * (plateau - floor);
        for (let i = 0; i < N; i++) mask[i] = enough && ratio[i] > cut ? 1 : 0;
        let score = 0;
        for (let i = 0; i < N; i++) if (mask[i]) score += Math.min(ratio[i], 20);
        if (score > this.ratioScore) {
          this.ratioScore = score;
          this.ratio = ratio;
          this.lastCut = cut;
        }
        const res = maskToQuad(mask, mw, mh, this.opt.minAreaFrac);
        if (res && (!best || score > best.score)) best = { quad: scaleQuad(res, step), plane: p, score, kind: 'energy' };
      }
    }
    if (best) out.push(best);
    if (this.lastLuma) {
      const thr = otsu(this.lastLuma);
      const mask = new Uint8Array(N);
      for (let i = 0; i < N; i++) mask[i] = this.lastLuma[i] > thr ? 1 : 0;
      const res = maskToQuad(mask, mw, mh, 0.03);
      if (res) out.push({ quad: scaleQuad(res, step), plane: 'chroma', score: 0, kind: 'bright' });
    }
    return out;
  }
}

function scaleQuad(q: Quad, s: number): Quad {
  // Map sample (x, y) sits at frame pixel centre (x*s + 0.5, y*s + 0.5).
  return q.map((p) => ({ x: (p.x - 0.5) * s + 0.5, y: (p.y - 0.5) * s + 0.5 })) as Quad;
}

export function boxBlur(src: Float32Array, w: number, h: number, r: number): Float32Array {
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  for (let y = 0; y < h; y++) {
    const o = y * w;
    let acc = 0;
    let cnt = 0;
    for (let x = 0; x < Math.min(w, r + 1); x++) {
      acc += src[o + x];
      cnt++;
    }
    for (let x = 0; x < w; x++) {
      tmp[o + x] = acc / cnt;
      const add = x + r + 1;
      const sub = x - r;
      if (add < w) {
        acc += src[o + add];
        cnt++;
      }
      if (sub >= 0) {
        acc -= src[o + sub];
        cnt--;
      }
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0;
    let cnt = 0;
    for (let y = 0; y < Math.min(h, r + 1); y++) {
      acc += tmp[y * w + x];
      cnt++;
    }
    for (let y = 0; y < h; y++) {
      out[y * w + x] = acc / cnt;
      const add = y + r + 1;
      const sub = y - r;
      if (add < h) {
        acc += tmp[add * w + x];
        cnt++;
      }
      if (sub >= 0) {
        acc -= tmp[sub * w + x];
        cnt--;
      }
    }
  }
  return out;
}

function highpass(src: Float32Array, w: number, h: number, r: number): Float32Array {
  const blur = boxBlur(src, w, h, r);
  for (let i = 0; i < src.length; i++) blur[i] = src[i] - blur[i];
  return blur;
}

function otsu(v: Float32Array): number {
  const hist = new Float64Array(256);
  for (let i = 0; i < v.length; i++) hist[Math.max(0, Math.min(255, v[i] | 0))]++;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let wB = 0;
  let sumB = 0;
  let best = 0;
  let thr = 127;
  for (let i = 0; i < 256; i++) {
    wB += hist[i];
    if (!wB) continue;
    const wF = v.length - wB;
    if (!wF) break;
    sumB += i * hist[i];
    const d = sumB / wB - (sum - sumB) / wF;
    const between = wB * wF * d * d;
    if (between > best) {
      best = between;
      thr = i;
    }
  }
  return thr;
}

/** Largest connected region of the mask, reduced to a convex quadrilateral. */
export function maskToQuad(mask: Uint8Array, w: number, h: number, minAreaFrac: number): Quad | null {
  // Connected components (4-neighbour) by stack flood fill.
  const label = new Int32Array(w * h);
  const stack = new Int32Array(w * h);
  let bestLabel = 0;
  let bestArea = 0;
  let next = 0;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i] || label[i]) continue;
    next++;
    let sp = 0;
    stack[sp++] = i;
    label[i] = next;
    let area = 0;
    while (sp) {
      const p = stack[--sp];
      area++;
      const x = p % w;
      if (x > 0 && mask[p - 1] && !label[p - 1]) {
        label[p - 1] = next;
        stack[sp++] = p - 1;
      }
      if (x < w - 1 && mask[p + 1] && !label[p + 1]) {
        label[p + 1] = next;
        stack[sp++] = p + 1;
      }
      if (p >= w && mask[p - w] && !label[p - w]) {
        label[p - w] = next;
        stack[sp++] = p - w;
      }
      if (p < w * (h - 1) && mask[p + w] && !label[p + w]) {
        label[p + w] = next;
        stack[sp++] = p + w;
      }
    }
    if (area > bestArea) {
      bestArea = area;
      bestLabel = next;
    }
  }
  if (bestArea < minAreaFrac * w * h) return null;

  // Outline: first and last pixel of the region on every row and column.
  const pts: Pt[] = [];
  for (let y = 0; y < h; y++) {
    let lo = -1;
    let hi = -1;
    for (let x = 0; x < w; x++) {
      if (label[y * w + x] === bestLabel) {
        if (lo < 0) lo = x;
        hi = x;
      }
    }
    if (lo >= 0) {
      pts.push({ x: lo, y: y + 0.5 }, { x: hi + 1, y: y + 0.5 });
    }
  }
  for (let x = 0; x < w; x++) {
    let lo = -1;
    let hi = -1;
    for (let y = 0; y < h; y++) {
      if (label[y * w + x] === bestLabel) {
        if (lo < 0) lo = y;
        hi = y;
      }
    }
    if (lo >= 0) pts.push({ x: x + 0.5, y: lo }, { x: x + 0.5, y: hi + 1 });
  }
  const hull = convexHull(pts);
  if (hull.length < 4) return null;
  const hullArea = polyArea(hull);
  // A screen fills its own hull; ragged blobs do not.
  if (bestArea < 0.55 * hullArea) return null;

  // Rough corners: the hull points that reach furthest along the four
  // diagonals (upright screen) or along the four axes (screen turned ~45
  // degrees). Whichever quadrilateral is larger is the better inscribed fit.
  const extreme = (fx: number, fy: number): Pt => {
    let best = hull[0];
    let bv = -Infinity;
    for (const p of hull) {
      const v = p.x * fx + p.y * fy;
      if (v > bv) {
        bv = v;
        best = p;
      }
    }
    return best;
  };
  const diag = [extreme(-1, -1), extreme(1, -1), extreme(1, 1), extreme(-1, 1)];
  const axis = [extreme(0, -1), extreme(1, 0), extreme(0, 1), extreme(-1, 0)];
  const poly = polyArea(diag) >= polyArea(axis) ? diag : axis;

  // Refit each side as a line through the outline points near it (the rough
  // corners sit on the rounded part of the smoothed mask), then intersect
  // neighbouring sides.
  const lines: { nx: number; ny: number; d: number }[] = [];
  for (let i = 0; i < 4; i++) {
    const a = poly[i];
    const b = poly[(i + 1) & 3];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len < 4) return null;
    const tx = (b.x - a.x) / len;
    const ty = (b.y - a.y) / len;
    const tol = Math.max(2.5, 0.06 * len);
    let near: Pt[] = [];
    for (const p of pts) {
      const along = (p.x - a.x) * tx + (p.y - a.y) * ty;
      const off = Math.abs(-(p.x - a.x) * ty + (p.y - a.y) * tx);
      if (along > 0.12 * len && along < 0.88 * len && off < tol) near.push(p);
    }
    let line = near.length >= 4 ? fitLine(near) : fitLine([a, b]);
    // One trimming pass: drop points far from the first fit and refit.
    if (near.length >= 8) {
      const res = near.map((p) => Math.abs(line.nx * p.x + line.ny * p.y - line.d));
      const sorted = res.slice().sort((x, y) => x - y);
      const lim = Math.max(1, 2.5 * sorted[sorted.length >> 1]);
      near = near.filter((_, k) => res[k] <= lim);
      if (near.length >= 4) line = fitLine(near);
    }
    lines.push(line);
  }
  const corners: Pt[] = [];
  for (let i = 0; i < 4; i++) {
    const l1 = lines[(i + 3) & 3];
    const l2 = lines[i];
    const det = l1.nx * l2.ny - l2.nx * l1.ny;
    if (Math.abs(det) < 1e-6) return null;
    corners.push({ x: (l1.d * l2.ny - l2.d * l1.ny) / det, y: (l1.nx * l2.d - l2.nx * l1.d) / det });
  }
  return orderQuad(corners);
}

function fitLine(pts: Pt[]): { nx: number; ny: number; d: number } {
  let mx = 0;
  let my = 0;
  for (const p of pts) {
    mx += p.x;
    my += p.y;
  }
  mx /= pts.length;
  my /= pts.length;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (const p of pts) {
    sxx += (p.x - mx) * (p.x - mx);
    sxy += (p.x - mx) * (p.y - my);
    syy += (p.y - my) * (p.y - my);
  }
  // Direction of largest variance; the normal is perpendicular to it.
  const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const nx = -Math.sin(ang);
  const ny = Math.cos(ang);
  return { nx, ny, d: nx * mx + ny * my };
}

function polyArea(p: Pt[]): number {
  let a = 0;
  for (let i = 0; i < p.length; i++) {
    const q = p[(i + 1) % p.length];
    a += p[i].x * q.y - q.x * p[i].y;
  }
  return Math.abs(a) / 2;
}

function convexHull(points: Pt[]): Pt[] {
  const p = points.slice().sort((a, b) => a.x - b.x || a.y - b.y);
  if (p.length < 3) return p;
  const cross = (o: Pt, a: Pt, b: Pt) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Pt[] = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper: Pt[] = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/** Clockwise in image coordinates (y down), starting at the top-left-most corner. */
function orderQuad(c: Pt[]): Quad {
  const cx = (c[0].x + c[1].x + c[2].x + c[3].x) / 4;
  const cy = (c[0].y + c[1].y + c[2].y + c[3].y) / 4;
  const sorted = c.slice().sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
  let start = 0;
  let best = Infinity;
  for (let i = 0; i < 4; i++) {
    const s = sorted[i].x + sorted[i].y;
    if (s < best) {
      best = s;
      start = i;
    }
  }
  return [sorted[start], sorted[(start + 1) & 3], sorted[(start + 2) & 3], sorted[(start + 3) & 3]];
}
