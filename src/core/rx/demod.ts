// Demodulator for one preset on an already-locked grid.
//
// Input: a ring of per-frame checker values (one number per cell and plane).
// Per symbol it
//   1. picks the frames that lie inside the symbol, away from its edges,
//   2. least-squares fits DC + carrier per cell -> complex amplitude Z,
//   3. fits a phase plane through the pilots (the rolling shutter and the
//      display's own top-to-bottom scan tilt the phase across the grid),
//   4. refines that plane with the data cells once they are decided,
//   5. slices PSK decisions with a per-cell reliability,
//   6. hands whole packets to Reed–Solomon and the CRC.

import { makeLayout, Q_TO_GRAY, type Layout } from '../layout.ts';
import { bytesToCellQ, cellQToBytes, decodePacketBytes, encodePacketBytes, type PacketHeader } from '../packet.ts';
import type { Preset } from '../presets.ts';
import { carrierFit, type PlaneName } from './frame.ts';

export interface CellRing {
  t: number[];
  luma: Float32Array[];
  chroma: Float32Array[];
}

export interface PacketInfo {
  header: PacketHeader;
  block: Uint8Array;
  correctedBytes: number;
  rawBitErrors: number;
  rawBits: number;
  time: number;
}

export interface SymbolDebug {
  index: number;
  /** Centre time of the symbol in ring time. */
  time: number;
  /** Hard decisions per data cell, rotation removed. */
  q: Uint8Array;
  coherence: number;
  orient: number;
  plane: PlaneName;
}

export interface DemodStats {
  symbols: number;
  weakSymbols: number;
  packetsOk: number;
  packetsBad: number;
  rawBits: number;
  rawBitErrors: number;
}

const TWO_PI = 2 * Math.PI;

function wrapTo(x: number, period: number): number {
  let y = x % period;
  if (y >= period / 2) y -= period;
  if (y < -period / 2) y += period;
  return y;
}

interface PlaneFit {
  su: number;
  sv: number;
  theta: number;
  mag: number;
}

/**
 * Finds the phase plane theta + 2*pi*(su*u + sv*v) that best aligns the given
 * unit-modulation-removed phasors, by maximising the coherent sum over a grid
 * of slopes. This is a tiny 2-D spectral peak search and stays well-behaved
 * at low SNR, where phase unwrapping would not.
 */
export function searchPlane(
  zr: Float64Array,
  zi: Float64Array,
  u: Float32Array,
  v: Float32Array,
  n: number,
  cu: number,
  cv: number,
  range: number,
  step: number,
): PlaneFit {
  const steps = Math.max(1, Math.round(range / step));
  const count = 2 * steps + 1;
  const ar = new Float64Array(n);
  const ai = new Float64Array(n);
  // Row phase tables for every sv candidate.
  const cb = new Float64Array(count * n);
  const sb = new Float64Array(count * n);
  for (let b = 0; b < count; b++) {
    const sv = cv + (b - steps) * step;
    for (let k = 0; k < n; k++) {
      const ph = TWO_PI * sv * v[k];
      cb[b * n + k] = Math.cos(ph);
      sb[b * n + k] = Math.sin(ph);
    }
  }
  let best: PlaneFit = { su: cu, sv: cv, theta: 0, mag: -1 };
  for (let a = 0; a < count; a++) {
    const su = cu + (a - steps) * step;
    for (let k = 0; k < n; k++) {
      const ph = TWO_PI * su * u[k];
      const c = Math.cos(ph);
      const s = Math.sin(ph);
      ar[k] = zr[k] * c + zi[k] * s;
      ai[k] = zi[k] * c - zr[k] * s;
    }
    for (let b = 0; b < count; b++) {
      let sr = 0;
      let si = 0;
      const o = b * n;
      for (let k = 0; k < n; k++) {
        sr += ar[k] * cb[o + k] + ai[k] * sb[o + k];
        si += ai[k] * cb[o + k] - ar[k] * sb[o + k];
      }
      const mag = sr * sr + si * si;
      if (mag > best.mag) best = { su, sv: cv + (b - steps) * step, theta: Math.atan2(si, sr), mag };
    }
  }
  best.mag = Math.sqrt(Math.max(0, best.mag));
  return best;
}

export interface PilotCheck {
  coherence: number;
  orient: number;
  conj: boolean;
}

/**
 * How well the pilots of a layout line up in a set of cell phasors, trying
 * both screen orientations and both signs of the alias frequency. Pilots keep
 * their phase relations even in a window that straddles a symbol change (the
 * whole grid rotates together), so this works before symbol timing is known.
 * A grid that is one cell or half a cell off puts data under the pilot
 * positions and scores like noise, about 1/sqrt(pilots).
 */
export function pilotCheck(layout: Layout, zr: Float64Array, zi: Float64Array): PilotCheck {
  const np = layout.pilotCells.length;
  const n = layout.nCells;
  const pr = new Float64Array(np);
  const pi = new Float64Array(np);
  const pu = new Float32Array(np);
  const pv = new Float32Array(np);
  let best: PilotCheck = { coherence: 0, orient: 0, conj: false };
  for (const conj of [false, true]) {
    for (const orient of [0, 2]) {
      let sumAbs = 0;
      for (let k = 0; k < np; k++) {
        const c = layout.pilotCells[k];
        const src = orient === 2 ? n - 1 - c : c;
        const [rr, ii] = derot(zr[src], conj ? -zi[src] : zi[src], layout.pilotQ[c]);
        pr[k] = rr;
        pi[k] = ii;
        pu[k] = ((c % layout.cols) + 0.5) / layout.cols;
        pv[k] = (Math.floor(c / layout.cols) + 0.5) / layout.rows;
        sumAbs += Math.hypot(rr, ii);
      }
      const pf = searchPlane(pr, pi, pu, pv, np, 0, 0, 0.06 * layout.preset.carrierHz, 0.1);
      const coh = sumAbs > 0 ? pf.mag / sumAbs : 0;
      if (coh > best.coherence) best = { coherence: coh, orient, conj };
    }
  }
  return best;
}

export class Demodulator {
  readonly preset: Preset;
  readonly layout: Layout;
  readonly Ts: number;
  readonly guard: number;

  /** Time of one symbol boundary; boundaries are tau0 + i*Ts. */
  private tau0: number | null = null;
  private nextIndex = 0;
  private framesAtTiming = -1e9;
  private frameCounter = 0;
  private timingDisagree = 0;

  plane: PlaneName | null = null;
  orient: number | null = null;
  private planeVotes = new Map<string, number>();
  private slope: { su: number; sv: number; n: number } | null = null;
  private prevTheta: number | null = null;
  private prevIndex = -10;
  private sigma2 = 1;

  private buf: { q: Uint8Array; rel: Float32Array }[] = [];
  private pos = -1;
  private origin: number | null = null;
  private failRun = 0;

  /** Smoothed pilot coherence, 0..1. The lock indicator. */
  coherence = 0;
  /** Pilot SNR estimate in dB. */
  snrDb = 0;
  /** |Z| / sigma per cell in lock-grid order, for the heat map. */
  cellConf: Float32Array;
  lastGoodSymbolTime = -Infinity;
  stats: DemodStats = { symbols: 0, weakSymbols: 0, packetsOk: 0, packetsBad: 0, rawBits: 0, rawBitErrors: 0 };

  onPacket: (info: PacketInfo) => void = () => {};
  onSymbol: ((s: SymbolDebug) => void) | null = null;
  /** Diagnostics: last timing estimate (seconds into the symbol period) and its score profile. */
  timingDebug: { est: number; tau: number; scores: number[] } | null = null;

  private readonly epoch: number;
  private readonly cu: Float32Array;
  private readonly cv: Float32Array;

  constructor(preset: Preset, epoch: number) {
    this.preset = preset;
    this.layout = makeLayout(preset);
    this.Ts = this.layout.symbolSeconds;
    this.guard = this.Ts / 8;
    this.epoch = epoch;
    const { cols, rows, nCells } = this.layout;
    this.cellConf = new Float32Array(nCells);
    this.cu = new Float32Array(nCells);
    this.cv = new Float32Array(nCells);
    for (let i = 0; i < nCells; i++) {
      this.cu[i] = ((i % cols) + 0.5) / cols;
      this.cv[i] = (Math.floor(i / cols) + 0.5) / rows;
    }
  }

  /** Call once per new frame appended to the ring. */
  process(ring: CellRing): void {
    this.frameCounter++;
    const n = ring.t.length;
    if (n < 6) return;
    const newest = ring.t[n - 1];
    const span = newest - ring.t[0];
    if (span < 1.6 * this.Ts) return;

    const fps = (n - 1) / span;
    const framesPerSymbol = Math.max(2, Math.round(fps * this.Ts));
    if (this.tau0 === null || this.frameCounter - this.framesAtTiming >= framesPerSymbol) {
      this.framesAtTiming = this.frameCounter;
      const est = this.estimateTiming(ring);
      if (est !== null) {
        if (this.tau0 === null) {
          this.startAt(est, ring);
        } else {
          const e = wrapTo(est - this.tau0, this.Ts);
          if (Math.abs(e) > this.Ts / 4) {
            if (++this.timingDisagree >= 3) {
              this.startAt(est, ring);
              this.resetAssembly();
            }
          } else {
            this.timingDisagree = 0;
            this.tau0 += 0.35 * e;
          }
        }
      }
    }
    if (this.tau0 === null) return;

    for (let guard = 0; guard < 8; guard++) {
      const start = this.tau0 + this.nextIndex * this.Ts;
      const end = start + this.Ts;
      if (newest < end + this.guard * 0.5) break;
      if (start + this.guard < ring.t[0]) {
        // Symbol already fell out of the ring.
        this.nextIndex++;
        this.prevTheta = null;
        continue;
      }
      this.demodSymbol(ring, this.nextIndex, start);
      this.nextIndex++;
    }
  }

  private startAt(est: number, ring: CellRing): void {
    // Place tau0 so that symbol 0 is the earliest whole symbol in the ring.
    const first = ring.t[0];
    const k = Math.ceil((first - est) / this.Ts);
    this.tau0 = est + k * this.Ts;
    this.nextIndex = 0;
    this.prevTheta = null;
    this.timingDisagree = 0;
  }

  private resetAssembly(): void {
    this.buf = [];
    this.pos = -1;
    this.origin = null;
    this.failRun = 0;
  }

  private framesIn(ring: CellRing, a: number, b: number): number[] {
    const out: number[] = [];
    for (let k = ring.t.length - 1; k >= 0; k--) {
      const t = ring.t[k];
      if (t < a) break;
      if (t <= b) out.push(k);
    }
    return out.reverse();
  }

  /**
   * Symbol timing by model fit. For each candidate boundary phase, fit every
   * cell over the guarded windows and score carrier power over residual
   * power. Frames that straddle a symbol change do not fit either symbol, so
   * the score peaks where every window is clean; the middle of that plateau
   * is returned.
   */
  private estimateTiming(ring: CellRing): number | null {
    const n = ring.t.length;
    const newest = ring.t[n - 1];
    const oldest = Math.max(ring.t[0], newest - 5.2 * this.Ts);
    const cand = 24;
    const planes: PlaneName[] = this.plane ? [this.plane] : ['chroma', 'luma'];
    const nCells = this.layout.nCells;
    const cellStep = nCells > 200 ? 2 : 1;
    let bestPlaneScore = -1;
    let bestScores: Float64Array | null = null;
    for (const pl of planes) {
      const data = ring[pl];
      const scores = new Float64Array(cand);
      for (let j = 0; j < cand; j++) {
        const tau = (j / cand) * this.Ts;
        let amp = 0;
        let rss = 0;
        let dof = 0;
        let cnt = 0;
        let valid = true;
        const i0 = Math.ceil((oldest - tau) / this.Ts);
        for (let i = i0; ; i++) {
          const start = tau + i * this.Ts;
          if (start + this.Ts > newest) break;
          const idx = this.framesIn(ring, start + this.guard, start + this.Ts - this.guard);
          if (idx.length < 3) {
            valid = false;
            break;
          }
          // Three frames fit exactly and leave no residual to score.
          if (idx.length === 3) continue;
          const fit = carrierFit(
            idx.map((k) => ring.t[k]),
            this.preset.carrierHz,
            this.epoch,
          );
          if (!fit.ok) {
            valid = false;
            break;
          }
          const m = idx.length;
          for (let c = 0; c < nCells; c += cellStep) {
            let zr = 0;
            let zi = 0;
            let dc = 0;
            let sxx = 0;
            let sx = 0;
            let sxc = 0;
            let sxs = 0;
            for (let k = 0; k < m; k++) {
              const x = data[idx[k]][c];
              zr += fit.wr[k] * x;
              zi += fit.wi[k] * x;
              dc += fit.wdc[k] * x;
              sxx += x * x;
              sx += x;
              sxc += x * fit.bc[k];
              sxs += x * fit.bs[k];
            }
            amp += zr * zr + zi * zi;
            rss += Math.max(0, sxx - (dc * sx + zr * sxc + zi * sxs));
            dof += m - 3;
            cnt++;
          }
        }
        scores[j] = valid && cnt > 0 && dof > 0 ? amp / cnt / (rss / dof + 1e-4) : 0;
      }
      let mx = 0;
      for (let j = 0; j < cand; j++) mx = Math.max(mx, scores[j]);
      if (mx > bestPlaneScore) {
        bestPlaneScore = mx;
        bestScores = scores;
      }
    }
    if (!bestScores || bestPlaneScore <= 0) return null;
    // Circular centroid of the candidates near the maximum.
    let cr = 0;
    let ci = 0;
    for (let j = 0; j < cand; j++) {
      // Everything above half the peak counts, weighted by how far above.
      if (bestScores[j] >= 0.5 * bestPlaneScore) {
        const w = bestScores[j] - 0.5 * bestPlaneScore;
        cr += w * Math.cos((TWO_PI * j) / cand);
        ci += w * Math.sin((TWO_PI * j) / cand);
      }
    }
    let ph = Math.atan2(ci, cr) / TWO_PI;
    if (ph < 0) ph += 1;
    this.timingDebug = { est: ph * this.Ts, tau: this.tau0 ?? NaN, scores: Array.from(bestScores) };
    return ph * this.Ts;
  }

  private demodSymbol(ring: CellRing, index: number, start: number): void {
    const { layout, preset } = this;
    const nCells = layout.nCells;
    const idx = this.framesIn(ring, start + this.guard, start + this.Ts - this.guard);
    const fit = idx.length >= 3 ? carrierFit(idx.map((k) => ring.t[k]), preset.carrierHz, this.epoch) : null;
    if (!fit || !fit.ok) {
      this.prevTheta = null;
      this.symbolLost();
      return;
    }
    const m = idx.length;
    this.stats.symbols++;

    const planes: PlaneName[] = this.plane ? [this.plane] : ['chroma', 'luma'];
    const orients = this.orient !== null ? [this.orient] : [0, 2];
    const np = layout.pilotCells.length;
    let best: {
      plane: PlaneName;
      orient: number;
      zr: Float64Array;
      zi: Float64Array;
      fit: PlaneFit;
      coh: number;
      sigma2: number;
    } | null = null;

    for (const pl of planes) {
      const data = ring[pl];
      const zr0 = new Float64Array(nCells);
      const zi0 = new Float64Array(nCells);
      let rss = 0;
      for (let c = 0; c < nCells; c++) {
        let zr = 0;
        let zi = 0;
        let dc = 0;
        let sxx = 0;
        let sx = 0;
        let sxc = 0;
        let sxs = 0;
        for (let k = 0; k < m; k++) {
          const x = data[idx[k]][c];
          zr += fit.wr[k] * x;
          zi += fit.wi[k] * x;
          dc += fit.wdc[k] * x;
          sxx += x * x;
          sx += x;
          sxc += x * fit.bc[k];
          sxs += x * fit.bs[k];
        }
        zr0[c] = zr;
        zi0[c] = zi;
        rss += Math.max(0, sxx - (dc * sx + zr * sxc + zi * sxs));
      }
      // Noise on Z: residual variance times the estimator's noise gain. With
      // exactly three frames the fit is exact and leaves no residual, so the
      // previous estimate is reused.
      const sigma2 = m > 3 ? Math.max(1e-6, (rss / (nCells * (m - 3))) * fit.noiseGain) : this.sigma2;

      for (const orient of orients) {
        // Reorder into layout order for this orientation hypothesis.
        const zr = orient === 2 ? zr0.slice().reverse() : zr0;
        const zi = orient === 2 ? zi0.slice().reverse() : zi0;
        const pr = new Float64Array(np);
        const pi = new Float64Array(np);
        const pu = new Float32Array(np);
        const pv = new Float32Array(np);
        let sumAbs = 0;
        for (let k = 0; k < np; k++) {
          const c = layout.pilotCells[k];
          // Remove the known pilot quadrant: multiply by exp(-j*q*pi/2).
          const [rr, ii] = derot(zr[c], zi[c], layout.pilotQ[c]);
          pr[k] = rr;
          pi[k] = ii;
          pu[k] = this.cu[c];
          pv[k] = this.cv[c];
          sumAbs += Math.hypot(rr, ii);
        }
        const range = this.slope && this.slope.n >= 3 ? 0.2 : 0.06 * preset.carrierHz;
        const step = this.slope && this.slope.n >= 3 ? 0.025 : 0.05;
        const pf = searchPlane(pr, pi, pu, pv, np, this.slope?.su ?? 0, this.slope?.sv ?? 0, range, step);
        const coh = sumAbs > 0 ? pf.mag / sumAbs : 0;
        if (!best || coh > best.coh) best = { plane: pl, orient, zr, zi, fit: pf, coh, sigma2 };
      }
    }
    if (!best) return;

    const { zr, zi } = best;
    let pf = best.fit;
    const sigma = Math.sqrt(best.sigma2);
    this.sigma2 = best.sigma2;
    const bpsk = preset.bitsPerCell === 1;
    const nd = layout.dataCells.length;
    const dq = new Uint8Array(nd);
    const rel = new Float32Array(nd);

    // Decide, then refit the plane using every cell with its decision removed.
    const ar = new Float64Array(nCells);
    const ai = new Float64Array(nCells);
    for (let pass = 0; pass < 2; pass++) {
      for (let d = 0; d < nd; d++) {
        const c = layout.dataCells[d];
        const ph = pf.theta + TWO_PI * (pf.su * this.cu[c] + pf.sv * this.cv[c]);
        const cs = Math.cos(ph);
        const sn = Math.sin(ph);
        const xr = zr[c] * cs + zi[c] * sn;
        const xi = zi[c] * cs - zr[c] * sn;
        const ang = Math.atan2(xi, xr);
        const mag = Math.hypot(xr, xi);
        let q: number;
        let margin: number;
        if (bpsk) {
          q = Math.abs(ang) > Math.PI / 2 ? 2 : 0;
          margin = mag * Math.abs(Math.cos(ang));
        } else {
          q = Math.round(ang / (Math.PI / 2)) & 3;
          const off = Math.abs(wrapTo(ang - q * (Math.PI / 2), TWO_PI));
          margin = mag * Math.sin(Math.max(0, Math.PI / 4 - off));
        }
        dq[d] = q;
        rel[d] = margin / (sigma * Math.SQRT1_2 + 1e-9);
        const [rr, ii] = derot(zr[c], zi[c], q);
        ar[c] = rr;
        ai[c] = ii;
      }
      if (pass === 1) break;
      for (let k = 0; k < np; k++) {
        const c = layout.pilotCells[k];
        const [rr, ii] = derot(zr[c], zi[c], layout.pilotQ[c]);
        ar[c] = rr;
        ai[c] = ii;
      }
      // Only trust the decision-directed refit when the pilots already agree.
      if (best.coh > 0.5) pf = searchPlane(ar, ai, this.cu, this.cv, nCells, pf.su, pf.sv, 0.1, 0.02);
    }

    // Diagnostics.
    this.coherence += 0.4 * (best.coh - this.coherence);
    let pilotPow = 0;
    for (let k = 0; k < np; k++) {
      const c = layout.pilotCells[k];
      pilotPow += zr[c] * zr[c] + zi[c] * zi[c];
    }
    pilotPow /= np;
    this.snrDb = 10 * Math.log10(Math.max(1e-9, pilotPow / best.sigma2));
    for (let c = 0; c < nCells; c++) {
      const conf = Math.hypot(zr[c], zi[c]) / (sigma + 1e-9);
      this.cellConf[best.orient === 2 ? nCells - 1 - c : c] = conf;
    }

    const good = best.coh > 0.55;
    if (!good) this.stats.weakSymbols++;
    else this.lastGoodSymbolTime = start + this.Ts / 2;

    // Sticky plane and orientation once they have won a few good symbols.
    if (good && (this.plane === null || this.orient === null)) {
      const key = best.plane + best.orient;
      const votes = (this.planeVotes.get(key) ?? 0) + 1;
      this.planeVotes.set(key, votes);
      if (votes >= 3) {
        this.plane = best.plane;
        this.orient = best.orient;
      }
    }
    if (good) {
      if (!this.slope) this.slope = { su: pf.su, sv: pf.sv, n: 1 };
      else {
        this.slope.su += 0.3 * (pf.su - this.slope.su);
        this.slope.sv += 0.3 * (pf.sv - this.slope.sv);
        this.slope.n++;
      }
    }

    // Whole-grid rotation relative to the previous symbol marks packet starts.
    let marker: 'start' | 'cont' | 'unknown' = 'unknown';
    if (this.prevTheta !== null && this.prevIndex === index - 1) {
      const dTheta = wrapTo(pf.theta - this.prevTheta, TWO_PI);
      const quarter = Math.round(dTheta / (Math.PI / 2)) & 3;
      if (quarter === 2) marker = 'start';
      else if (quarter === 1) marker = 'cont';
    }
    this.prevTheta = good ? pf.theta : null;
    this.prevIndex = index;

    this.onSymbol?.({ index, time: start + this.Ts / 2, q: dq, coherence: best.coh, orient: best.orient, plane: best.plane });
    this.assemble(index, dq, rel, marker, start + this.Ts);
  }

  private symbolLost(): void {
    if (this.origin === null) {
      this.buf = [];
      this.pos = -1;
    }
  }

  private assemble(index: number, q: Uint8Array, rel: Float32Array, marker: string, time: number): void {
    const S = this.preset.symbolsPerPacket;
    if (S === 1) {
      this.tryDecode([{ q, rel }], time);
      return;
    }
    let pos: number;
    if (this.origin !== null) pos = (((index - this.origin) % S) + S) % S;
    else if (marker === 'start') pos = 0;
    else if (marker === 'cont' && this.pos >= 0) pos = this.pos + 1;
    else pos = -1;
    this.pos = pos;
    if (pos < 0) {
      this.buf = [];
      return;
    }
    if (pos === 0) this.buf = [];
    if (this.buf.length !== pos) {
      this.buf = [];
      return;
    }
    this.buf.push({ q, rel });
    if (this.buf.length === S) {
      const ok = this.tryDecode(this.buf, time);
      this.buf = [];
      this.pos = -1;
      if (ok) {
        this.origin = index + 1;
        this.failRun = 0;
      } else if (this.origin !== null && ++this.failRun >= 4) {
        // Lost packet alignment; fall back to the rotation markers.
        this.origin = null;
        this.failRun = 0;
      }
    }
  }

  private tryDecode(syms: { q: Uint8Array; rel: Float32Array }[], time: number): boolean {
    const { layout } = this;
    const { bytes, byteRel } = cellQToBytes(
      layout,
      syms.map((s) => s.q),
      syms.map((s) => s.rel),
    );
    const dec = decodePacketBytes(layout, bytes, byteRel);
    if (!dec) {
      this.stats.packetsBad++;
      return false;
    }
    // Raw (pre-FEC) bit errors: re-encode the verified packet and compare.
    const ref = bytesToCellQ(layout, encodePacketBytes(layout, dec.header, dec.block));
    let errs = 0;
    for (let s = 0; s < syms.length; s++) {
      for (let d = 0; d < ref[s].length; d++) {
        const x = Q_TO_GRAY[ref[s][d]] ^ Q_TO_GRAY[syms[s].q[d]];
        errs += this.preset.bitsPerCell === 1 ? (x ? 1 : 0) : (x & 1) + (x >> 1);
      }
    }
    const bits = syms.length * layout.dataCells.length * this.preset.bitsPerCell;
    this.stats.packetsOk++;
    this.stats.rawBits += bits;
    this.stats.rawBitErrors += errs;
    // A verified packet settles plane and orientation for good.
    this.onPacket({ header: dec.header, block: dec.block, correctedBytes: dec.correctedBytes, rawBitErrors: errs, rawBits: bits, time });
    return true;
  }
}

function derot(zr: number, zi: number, q: number): [number, number] {
  switch (q & 3) {
    case 0:
      return [zr, zi];
    case 1:
      return [zi, -zr];
    case 2:
      return [-zr, -zi];
    default:
      return [-zi, zr];
  }
}
