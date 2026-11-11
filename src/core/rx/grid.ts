// Sampling the grid through a homography, and locking the homography onto
// the modulation.
//
// Every cell carries a 2x2 checker of opposite signs. Summing the four
// quadrants with those signs ("checker value") cancels anything that is
// smooth across the cell: local brightness, auto-exposure drift, ambient
// light flicker. Only the modulation and fine content texture survive.

import { applyH, cloneQuad, squareToQuad, type Mat3, type Pt, type Quad } from '../homography.ts';
import { carrierFit, smoothPlane, type Frame, type PlaneName } from './frame.ts';

export class GridSampler {
  readonly cols: number;
  readonly rows: number;
  readonly nCells: number;
  readonly k: number;
  private readonly u: Float32Array;
  private readonly v: Float32Array;
  private readonly idx: Int32Array;
  private readonly perQuad: number;

  /**
   * @param k      sample lattice per quadrant side (k*k points per quadrant)
   * @param inner  fraction of each quadrant that is sampled, centred, so that
   *               small registration errors stay inside the right quadrant
   */
  constructor(cols: number, rows: number, k = 3, inner = 0.6) {
    this.cols = cols;
    this.rows = rows;
    this.nCells = cols * rows;
    this.k = k;
    this.perQuad = k * k;
    const n = this.nCells * 4 * this.perQuad;
    this.u = new Float32Array(n);
    this.v = new Float32Array(n);
    this.idx = new Int32Array(n);
    const margin = (1 - inner) / 2;
    let p = 0;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        for (let qy = 0; qy < 2; qy++) {
          for (let qx = 0; qx < 2; qx++) {
            for (let j = 0; j < k; j++) {
              for (let i = 0; i < k; i++) {
                this.u[p] = (2 * c + qx + margin + (inner * (i + 0.5)) / k) / (2 * cols);
                this.v[p] = (2 * r + qy + margin + (inner * (j + 0.5)) / k) / (2 * rows);
                p++;
              }
            }
          }
        }
      }
    }
  }

  /** Fixes the unit-square -> image mapping used by sample(). */
  setHomography(m: Mat3, w: number, h: number): void {
    const { u, v, idx } = this;
    for (let p = 0; p < idx.length; p++) {
      const den = m[6] * u[p] + m[7] * v[p] + m[8];
      const x = Math.round((m[0] * u[p] + m[1] * v[p] + m[2]) / den - 0.5);
      const y = Math.round((m[3] * u[p] + m[4] * v[p] + m[5]) / den - 0.5);
      idx[p] = x >= 0 && y >= 0 && x < w && y < h ? y * w + x : -1;
    }
  }

  /** Checker value per cell: (Q00 - Q01 - Q10 + Q11) / 4. */
  sample(plane: Float32Array, out: Float32Array): void {
    const { idx, perQuad } = this;
    let p = 0;
    for (let c = 0; c < this.nCells; c++) {
      let acc = 0;
      for (let q = 0; q < 4; q++) {
        let s = 0;
        let n = 0;
        for (let i = 0; i < perQuad; i++, p++) {
          const ix = idx[p];
          if (ix >= 0) {
            s += plane[ix];
            n++;
          }
        }
        const mean = n ? s / n : 0;
        acc += q === 0 || q === 3 ? mean : -mean;
      }
      out[c] = acc * 0.25;
    }
  }
}

export interface LockWindow {
  /** Indices into the frame list. */
  frames: number[];
  wr: Float64Array;
  wi: Float64Array;
}

/**
 * Splits the newest frames into short windows, each with its own carrier fit.
 * A window is only used if its frames follow each other without a gap. When
 * the device is slow and frames get skipped, a window that spans a gap mixes
 * two symbols; such windows made the right grid look bad and, seen on a live
 * page, let a wrong grid win the lock.
 */
export function makeLockWindows(frames: Frame[], carrierHz: number, perWindow: number, count: number): LockWindow[] {
  const out: LockWindow[] = [];
  if (frames.length < perWindow) return out;
  const gaps: number[] = [];
  for (let i = 1; i < frames.length; i++) gaps.push(frames[i].t - frames[i - 1].t);
  const sorted = gaps.slice().sort((a, b) => a - b);
  const nominal = sorted.length ? sorted[sorted.length >> 1] : 0;
  let end = frames.length;
  while (out.length < count && end - perWindow >= 0) {
    let contiguous = true;
    for (let i = end - perWindow + 1; i < end; i++) {
      if (gaps[i - 1] > 1.6 * nominal) {
        contiguous = false;
        break;
      }
    }
    if (!contiguous) {
      end -= 1;
      continue;
    }
    const ids: number[] = [];
    for (let i = end - perWindow; i < end; i++) ids.push(i);
    const fit = carrierFit(
      ids.map((i) => frames[i].t),
      carrierHz,
      frames[0].t,
    );
    if (fit.ok) out.push({ frames: ids, wr: fit.wr, wi: fit.wi });
    end -= perWindow;
  }
  return out;
}

/** Sum over cells and windows of |Z|^2 for a candidate quad. */
export class LockMetric {
  private readonly q: Float32Array[];
  private readonly used: number[];
  private readonly sampler: GridSampler;
  private readonly frames: Frame[];
  private readonly planes: Float32Array[];
  private readonly windows: LockWindow[];
  evaluations = 0;

  constructor(sampler: GridSampler, frames: Frame[], plane: PlaneName, windows: LockWindow[], smooth: boolean) {
    this.sampler = sampler;
    this.frames = frames;
    this.windows = windows;
    this.planes = frames.map((f) => f[plane]);
    const set = new Set<number>();
    for (const w of windows) for (const f of w.frames) set.add(f);
    this.used = [...set];
    if (smooth) for (const i of this.used) this.planes[i] = smoothPlane(frames[i], plane);
    this.q = frames.map(() => new Float32Array(sampler.nCells));
  }

  eval(quad: Quad): number {
    this.evaluations++;
    const { sampler, frames } = this;
    const f0 = frames[0];
    sampler.setHomography(squareToQuad(quad), f0.w, f0.h);
    for (const i of this.used) sampler.sample(this.planes[i], this.q[i]);
    let m = 0;
    const n = sampler.nCells;
    for (const w of this.windows) {
      for (let c = 0; c < n; c++) {
        let zr = 0;
        let zi = 0;
        for (let j = 0; j < w.frames.length; j++) {
          const x = this.q[w.frames[j]][c];
          zr += w.wr[j] * x;
          zi += w.wi[j] * x;
        }
        m += zr * zr + zi * zi;
      }
    }
    return m / (n * Math.max(1, this.windows.length));
  }

  /** Per-window complex cell amplitudes for a quad (lock-grid order). */
  phasors(quad: Quad): { zr: Float64Array; zi: Float64Array }[] {
    this.eval(quad);
    const n = this.sampler.nCells;
    return this.windows.map((w) => {
      const zr = new Float64Array(n);
      const zi = new Float64Array(n);
      for (let c = 0; c < n; c++) {
        let r = 0;
        let i = 0;
        for (let j = 0; j < w.frames.length; j++) {
          const x = this.q[w.frames[j]][c];
          r += w.wr[j] * x;
          i += w.wi[j] * x;
        }
        zr[c] = r;
        zi[c] = i;
      }
      return { zr, zi };
    });
  }
}

/** Quad moved by (du, dv) quadrants in the grid's own (perspective-correct) coordinates. */
export function shiftQuadInGrid(q: Quad, cols: number, rows: number, du: number, dv: number): Quad {
  const m = squareToQuad(q);
  const a = du / (2 * cols);
  const b = dv / (2 * rows);
  return [applyH(m, a, b), applyH(m, 1 + a, b), applyH(m, 1 + a, 1 + b), applyH(m, a, 1 + b)];
}

function centroid(q: Quad): Pt {
  return { x: (q[0].x + q[1].x + q[2].x + q[3].x) / 4, y: (q[0].y + q[1].y + q[2].y + q[3].y) / 4 };
}
function transformQuad(q: Quad, scale: number, dx: number, dy: number): Quad {
  const c = centroid(q);
  return q.map((p) => ({ x: c.x + (p.x - c.x) * scale + dx, y: c.y + (p.y - c.y) * scale + dy })) as Quad;
}
function dist(a: Pt, b: Pt): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Approximate size of a quadrant (half a cell) in image pixels. */
export function subcellPixels(q: Quad, cols: number, rows: number): { sx: number; sy: number } {
  const wTop = dist(q[0], q[1]);
  const wBot = dist(q[3], q[2]);
  const hL = dist(q[0], q[3]);
  const hR = dist(q[1], q[2]);
  return { sx: (wTop + wBot) / 2 / (2 * cols), sy: (hL + hR) / 2 / (2 * rows) };
}

export interface LockResult {
  quad: Quad;
  score: number;
}

/**
 * Hill-climbs the four corners to maximise the lock metric.
 * `coarse` adds a global shift-and-scale scan first, for use right after
 * detection when the starting quad is only good to a couple of pixels.
 */
export function refineQuad(metric: LockMetric, start: Quad, cols: number, rows: number, coarse: boolean): LockResult {
  const { sx, sy } = subcellPixels(start, cols, rows);
  let best = cloneQuad(start);
  let bestScore = metric.eval(best);

  if (coarse) {
    const top = transformQuad(start, 1, 0, 0);
    let topScore = bestScore;
    let topQuad = top;
    for (const scale of [1, 1.03, 1.06, 1.1, 0.97]) {
      for (let iy = -2; iy <= 2; iy++) {
        for (let ix = -2; ix <= 2; ix++) {
          const cand = transformQuad(start, scale, ix * 0.5 * sx, iy * 0.5 * sy);
          const s = metric.eval(cand);
          if (s > topScore) {
            topScore = s;
            topQuad = cand;
          }
        }
      }
    }
    best = topQuad;
    bestScore = topScore;
  }

  let step = coarse ? 0.5 : 0.25;
  const minStep = Math.max(0.04, 0.2 / Math.max(sx, sy));
  let guard = 0;
  while (step >= minStep && guard++ < 40) {
    let improved = false;
    // Whole-quad moves first (translate, scale), then individual corners.
    const moves: ((q: Quad) => Quad)[] = [
      (q) => transformQuad(q, 1, step * sx, 0),
      (q) => transformQuad(q, 1, -step * sx, 0),
      (q) => transformQuad(q, 1, 0, step * sy),
      (q) => transformQuad(q, 1, 0, -step * sy),
      (q) => transformQuad(q, 1 + (step * 0.5) / Math.max(cols, rows), 0, 0),
      (q) => transformQuad(q, 1 - (step * 0.5) / Math.max(cols, rows), 0, 0),
    ];
    for (let ci = 0; ci < 4; ci++) {
      for (const [dx, dy] of [
        [step * sx, 0],
        [-step * sx, 0],
        [0, step * sy],
        [0, -step * sy],
      ]) {
        moves.push((q) => {
          const n = cloneQuad(q);
          n[ci].x += dx;
          n[ci].y += dy;
          return n;
        });
      }
    }
    for (const mv of moves) {
      const cand = mv(best);
      const s = metric.eval(cand);
      if (s > bestScore * 1.002) {
        best = cand;
        bestScore = s;
        improved = true;
      }
    }
    if (!improved) step /= 2;
  }
  return { quad: best, score: bestScore };
}

/**
 * Exhaustive per-corner search: each corner in turn is tried on a lattice of
 * offsets (in quadrant units) with the other three held, twice round. This
 * recovers a corner that detection placed a few quadrants off, which the
 * hill climb alone cannot (the metric ripples with a one-quadrant period).
 */
export function searchCorners(metric: LockMetric, start: Quad, cols: number, rows: number, radius: number, step: number): LockResult {
  const { sx, sy } = subcellPixels(start, cols, rows);
  let best = cloneQuad(start);
  let bestScore = metric.eval(best);
  const n = Math.round(radius / step);
  for (let round = 0; round < 2; round++) {
    let moved = false;
    for (let ci = 0; ci < 4; ci++) {
      const base = cloneQuad(best);
      for (let iy = -n; iy <= n; iy++) {
        for (let ix = -n; ix <= n; ix++) {
          if (ix === 0 && iy === 0) continue;
          const cand = cloneQuad(base);
          cand[ci].x += ix * step * sx;
          cand[ci].y += iy * step * sy;
          const s = metric.eval(cand);
          if (s > bestScore * 1.01) {
            best = cand;
            bestScore = s;
            moved = true;
          }
        }
      }
    }
    if (!moved) break;
  }
  return { quad: best, score: bestScore };
}

export function quadIsSane(q: Quad, w: number, h: number): boolean {
  // Convex, clockwise in image coordinates, not degenerate, mostly on screen.
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i];
    const b = q[(i + 1) & 3];
    const c = q[(i + 2) & 3];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (cross === 0) return false;
    const s = Math.sign(cross);
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  for (const p of q) {
    if (p.x < -0.25 * w || p.x > 1.25 * w || p.y < -0.25 * h || p.y > 1.25 * h) return false;
  }
  const c = applyH(squareToQuad(q), 0.5, 0.5);
  return c.x > 0 && c.y > 0 && c.x < w && c.y < h;
}

/**
 * Sample lattice for a grid whose quadrants are "sub" pixels across. With
 * quadrants of 5 px or more the planes are box-filtered 3x3 and sampled about
 * every 3 px; smaller quadrants are sampled directly.
 */
export function samplingFor(sub: number, maxK: number): { k: number; smooth: boolean } {
  if (sub < 5) return { k: 2, smooth: false };
  return { k: Math.max(2, Math.min(maxK, Math.round((sub * 0.6) / 3))), smooth: true };
}
