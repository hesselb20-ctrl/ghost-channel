// Receiver state machine: search for the screen, lock the grid, track it,
// demodulate, and feed verified packets to the fountain decoder.
// Pure TypeScript with no DOM access, so the simulator and the browser worker
// run exactly the same code.

import { unpackContainer, type Payload } from '../container.ts';
import { FountainDecoder } from '../fountain.ts';
import { cloneQuad, rotateQuad, type Quad } from '../homography.ts';
import { makeLayout } from '../layout.ts';
import { PRESETS, type Preset } from '../presets.ts';
import { Demodulator, pilotCheck, type CellRing, type PacketInfo, type PilotCheck, type SymbolDebug } from './demod.ts';
import { Detector, type Detection } from './detect.ts';
import { smoothPlane, type Frame, type PlaneName } from './frame.ts';
import {
  GridSampler,
  LockMetric,
  makeLockWindows,
  quadIsSane,
  refineQuad,
  samplingFor,
  searchCorners,
  shiftQuadInGrid,
  subcellPixels,
} from './grid.ts';
import { squareToQuad } from '../homography.ts';

export interface ReceiverOptions {
  presets?: Preset[];
  /** Detector map decimation. 2 is the default; 3 is cheaper on slow phones. */
  mapStep?: number;
  onSymbol?: (preset: Preset, s: SymbolDebug) => void;
  onEvent?: (msg: string) => void;
}

export type RxState = 'search' | 'locked' | 'done';

export interface RxStatus {
  state: RxState;
  fps: number;
  frames: number;
  /** Detected screen corners in processing-frame pixels. */
  quad: Quad | null;
  cols: number;
  rows: number;
  presetKey: string | null;
  plane: PlaneName | null;
  coherence: number;
  snrDb: number;
  /** Per-cell |Z|/sigma in the locked grid's own orientation. */
  cellConf: Float32Array | null;
  K: number;
  rank: number;
  progress: number;
  packetsOk: number;
  packetsBad: number;
  rawBits: number;
  rawBitErrors: number;
  /** Bytes of user payload delivered so far via innovative packets. */
  goodBytes: number;
  tFirstFrame: number;
  tLock: number | null;
  tFirstPacket: number | null;
  tDone: number | null;
  lockAttempts: number;
  detection: string | null;
  result: Payload | null;
  objectCrcOk: boolean | null;
}

interface GridKey {
  cols: number;
  rows: number;
}

interface LockChoice {
  carrier: number;
  pilots: PilotCheck;
  quad: Quad;
  contrast: number;
  grid: GridKey;
  plane: PlaneName;
  pilotCoh: number;
  rank: number;
  kind: Detection['kind'];
}

export class Receiver {
  state: RxState = 'search';
  private readonly presets: Preset[];
  private readonly grids: GridKey[];
  private readonly opt: ReceiverOptions;
  private frames: Frame[] = [];
  private frameCount = 0;
  private fps = 30;
  private detector: Detector | null = null;
  private tFirst: number | null = null;

  private quad: Quad | null = null;
  private grid: GridKey | null = null;
  private sampler: GridSampler | null = null;
  private trackSampler: GridSampler | null = null;
  private lockPlane: PlaneName = 'chroma';
  private smooth = false;
  private now = 0;
  private ring: CellRing = { t: [], luma: [], chroma: [] };
  private demods: Demodulator[] = [];
  private winner: Demodulator | null = null;
  private tLock: number | null = null;
  private tLockLast = 0;
  /** Set when a lock was just applied; the lock's clock starts at the next frame. */
  private lockClockPending = false;
  /** Seconds of received frames since the pilots last agreed / a packet last passed. */
  private quietPilots = 0;
  private quietPackets = 0;
  private prevLockedT = 0;
  private seenGoodSymbols = 0;
  private everCoherent = false;
  private lastTrack = 0;
  private cooldownUntil = -Infinity;
  private lockAttempts = 0;
  private detection: string | null = null;
  private manualQuad: Quad | null = null;
  /** Quads whose lock produced no packets; not retried until the time given. */
  private rejected: { quad: Quad; until: number }[] = [];
  private okAtLock = 0;
  private tLastPacket = 0;

  private decoder: FountainDecoder | null = null;
  private goodBytes = 0;
  private tFirstPacket: number | null = null;
  private tDone: number | null = null;
  private result: Payload | null = null;
  private objectCrcOk: boolean | null = null;

  constructor(opt: ReceiverOptions = {}) {
    this.opt = opt;
    this.presets = opt.presets ?? PRESETS;
    this.grids = [];
    for (const p of this.presets) {
      if (!this.grids.some((g) => g.cols === p.cols && g.rows === p.rows)) this.grids.push({ cols: p.cols, rows: p.rows });
    }
  }

  private log(msg: string): void {
    this.opt.onEvent?.(msg);
  }

  /**
   * Corners the user placed by hand (processing-frame pixels, clockwise from
   * the screen's top-left), used as one more proposal while searching. Pass
   * null to clear.
   */
  setManualQuad(q: Quad | null): void {
    this.manualQuad = q ? cloneQuad(q) : null;
    this.rejected = [];
  }

  /** Forget the lock and any partial object; keep looking. */
  reset(): void {
    this.unlock();
    this.decoder = null;
    this.goodBytes = 0;
    this.result = null;
    this.objectCrcOk = null;
    this.tFirstPacket = null;
    this.tDone = null;
    this.tFirst = null;
    this.state = 'search';
  }

  private unlock(): void {
    this.quad = null;
    this.grid = null;
    this.sampler = null;
    this.demods = [];
    this.winner = null;
    this.ring = { t: [], luma: [], chroma: [] };
    this.detector?.reset();
    if (this.state !== 'done') this.state = 'search';
  }

  pushFrame(frame: Frame): void {
    if (this.tFirst === null) this.tFirst = frame.t;
    this.now = frame.t;
    this.frameCount++;
    const frames = this.frames;
    if (frames.length && (frame.w !== frames[0].w || frame.h !== frames[0].h)) {
      frames.length = 0;
      this.detector = null;
      this.unlock();
    }
    frames.push(frame);
    while (frames.length > 2 && (frames.length > 48 || frame.t - frames[0].t > 0.85)) frames.shift();
    if (frames.length >= 4) {
      const span = frame.t - frames[0].t;
      if (span > 0) this.fps += 0.2 * ((frames.length - 1) / span - this.fps);
    }
    if (this.state === 'done') return;

    if (this.state === 'search') {
      if (!this.detector) this.detector = new Detector(frame.w, frame.h, { step: this.opt.mapStep ?? 2 });
      // A fit window shorter than a symbol, re-evaluated every other frame, so
      // that over time the window meets every alignment against the symbol
      // boundaries and every sensor row sees the same average.
      this.detector.setWindow(Math.round(this.fps / 6));
      this.detector.push(frame);
      const every = 2;
      if (this.detector.ready && this.frameCount % every === 0) {
        for (const hz of this.uniqueCarriers()) this.detector.accumulate(hz);
        if (frame.t >= this.cooldownUntil) {
          // Evaluate every proposal and keep the most convincing one; the
          // first acceptable lock is not always the best aligned.
          const cands = this.detector.find();
          if (this.manualQuad) cands.unshift({ quad: this.manualQuad, plane: 'chroma', score: 0, kind: 'manual' });
          let top: LockChoice | null = null;
          for (const cand of cands) {
            const c = this.evaluateLock(cand);
            if (c && (!top || c.rank > top.rank)) top = c;
          }
          if (top) this.applyLock(top, frame.t);
          else if (cands.length) this.cooldownUntil = frame.t + 0.3;
        }
      }
      return;
    }

    // Locked: sample the grid in this frame and run the demodulators.
    if (this.lockClockPending) {
      this.lockClockPending = false;
      this.tLockLast = frame.t;
      this.lastTrack = frame.t;
      this.prevLockedT = frame.t;
      this.quietPilots = 0;
      this.quietPackets = 0;
      this.seenGoodSymbols = 0;
      this.everCoherent = false;
    }
    const sampler = this.sampler!;
    const lq = new Float32Array(sampler.nCells);
    const cq = new Float32Array(sampler.nCells);
    sampler.sample(this.planeOf(frame, 'luma'), lq);
    sampler.sample(this.planeOf(frame, 'chroma'), cq);
    const ring = this.ring;
    ring.t.push(frame.t);
    ring.luma.push(lq);
    ring.chroma.push(cq);
    const keep = 6.5 * Math.max(...this.demods.map((d) => d.Ts));
    while (ring.t.length > 8 && frame.t - ring.t[0] > keep) {
      ring.t.shift();
      ring.luma.shift();
      ring.chroma.shift();
    }
    for (const d of this.demods) d.process(ring);
    if (this.state !== 'locked') return;

    // Re-centre the grid about twice per second.
    if (frame.t - this.lastTrack > 0.5) {
      this.lastTrack = frame.t;
      this.track();
    }

    // Deciding when to give up on a lock. Time is counted only while frames
    // are actually arriving: on a slow device frames are skipped during an
    // acquisition, and that hole in the timestamps must not be mistaken for
    // "nothing happened for two seconds".
    const lead = this.winner ?? this.bestDemod();
    const dt = Math.min(Math.max(0, frame.t - this.prevLockedT), 0.1);
    this.prevLockedT = frame.t;
    this.quietPilots += dt;
    this.quietPackets += dt;
    const goodCount = lead?.goodSymbols ?? 0;
    if (goodCount !== this.seenGoodSymbols) {
      this.seenGoodSymbols = goodCount;
      // One symbol can look coherent by chance (a dozen pilots, a slope
      // search); the running average cannot for long.
      if ((lead?.coherence ?? 0) > 0.6) {
        this.quietPilots = 0;
        this.everCoherent = true;
      }
    }
    const patience = this.everCoherent ? Math.max(1.6, 5 * (lead?.Ts ?? 0.2)) : Math.max(3, 8 * Math.max(...this.demods.map((d) => d.Ts)));
    if (this.quietPilots > patience) {
      this.log(`lock dropped (no coherent pilots for ${this.quietPilots.toFixed(1)} s of frames)`);
      if (this.quad && !this.everCoherent) this.rejected.push({ quad: cloneQuad(this.quad), until: frame.t + 12 });
      this.unlock();
      this.cooldownUntil = frame.t + 0.2;
      return;
    }
    // Pilots can look fine on a grid that is warped, or on the wrong grid
    // altogether, while no packet ever passes its CRC. Let go and look again.
    if (lead) {
      const pktSec = lead.Ts * lead.preset.symbolsPerPacket;
      if (this.quietPackets > Math.max(2.5, 7 * pktSec)) {
        this.log(`lock dropped (no valid packet for ${this.quietPackets.toFixed(1)} s of frames)`);
        // Coherent pilots with failing packets usually means the right place
        // and a poor signal, so only a lock whose pilots were also doubtful is
        // kept off the list of places to try.
        if (this.quad && this.tFirstPacket === null && lead.coherence < 0.7) this.rejected.push({ quad: cloneQuad(this.quad), until: frame.t + 12 });
        this.unlock();
        this.cooldownUntil = frame.t + 0.2;
      }
    }
  }

  /**
   * Carriers that are distinguishable at the current camera frame rate. Two
   * carriers that alias onto the same frequency give the same energy map, so
   * only one of them is evaluated.
   */
  private uniqueCarriers(filter: (p: Preset) => boolean = () => true): number[] {
    const seen = new Map<number, number>();
    for (const p of this.presets) {
      if (!filter(p)) continue;
      const alias = Math.abs(p.carrierHz - Math.round(p.carrierHz / this.fps) * this.fps);
      const key = Math.round(alias * 2);
      if (!seen.has(key)) seen.set(key, p.carrierHz);
    }
    return [...seen.values()];
  }

  private planeOf(f: Frame, name: PlaneName): Float32Array {
    return this.smooth ? smoothPlane(f, name) : f[name];
  }

  private bestDemod(): Demodulator | null {
    let best: Demodulator | null = null;
    for (const d of this.demods) if (!best || d.coherence > best.coherence) best = d;
    return best;
  }

  private evaluateLock(cand: Detection): LockChoice | null {
    const frames = this.frames;
    const f0 = frames[0];
    const perWindow = Math.max(3, Math.min(8, Math.round(this.fps * 0.1)));
    if (frames.length < 3 * perWindow) return null;
    if (!quadIsSane(cand.quad, f0.w, f0.h)) return null;
    // The pilot check needs several windows of consecutive frames; with one or
    // two, a dozen pilots can be lined up by chance. Right after a slow
    // acquisition attempt the buffer has a hole, so wait for it to refill.
    if (makeLockWindows(frames, this.presets[0].carrierHz, perWindow, 6).length < 4) return null;
    this.lockAttempts++;
    const planes: PlaneName[] = cand.kind === 'energy' ? [cand.plane] : ['chroma', 'luma'];

    // Stage 1: a cheap shift-and-scale scan plus hill climb for every
    // grid / carrier / orientation / plane hypothesis.
    interface Hyp {
      grid: GridKey;
      plane: PlaneName;
      carrier: number;
      metric: LockMetric;
      /** Same sampler over more windows, used only for the pilot check. */
      pilotMetric: LockMetric;
      quad: Quad;
      score: number;
    }
    const hyps: Hyp[] = [];
    for (const grid of this.grids) {
      for (const carrier of this.uniqueCarriers((p) => p.cols === grid.cols && p.rows === grid.rows)) {
        const windows = makeLockWindows(frames, carrier, perWindow, 3);
        // One window is too little evidence to lock on; wait for more gap-free frames.
        if (windows.length < 2) continue;
        for (let rot = 0; rot < 2; rot++) {
          const q0 = rotateQuad(cand.quad, rot);
          const { sx, sy } = subcellPixels(q0, grid.cols, grid.rows);
          // Cells are close to square on a real screen; skip absurd aspect matches.
          if (sx < 2.2 || sy < 2.2 || sx / sy > 1.8 || sy / sx > 1.8) continue;
          for (const plane of planes) {
            const sm = samplingFor(Math.min(sx, sy), 3);
            const sampler = new GridSampler(grid.cols, grid.rows, sm.k, 0.6);
            const metric = new LockMetric(sampler, frames, plane, windows, sm.smooth);
            const res = refineQuad(metric, q0, grid.cols, grid.rows, true);
            if (!quadIsSane(res.quad, f0.w, f0.h)) continue;
            const pilotMetric = new LockMetric(sampler, frames, plane, makeLockWindows(frames, carrier, perWindow, 6), sm.smooth);
            hyps.push({ grid, plane, carrier, metric, pilotMetric, quad: res.quad, score: res.score });
          }
        }
      }
    }
    if (!hyps.length) return null;
    hyps.sort((x, y) => y.score - x.score);

    // Stage 2, for the strongest hypotheses only: fix corners that started
    // several quadrants off, resolve whole-cell and half-cell ambiguity with
    // the pilots, and measure how convincing the result is.
    let best: LockChoice | null = null;
    for (const h of hyps.slice(0, 2)) {
      if (h.score < 0.7 * hyps[0].score) break;
      const { grid, metric } = h;
      const layout = makeLayout(this.presets.find((p) => p.cols === grid.cols && p.rows === grid.rows)!);
      let res: { quad: Quad; score: number } = { quad: h.quad, score: h.score };
      // The per-corner search costs over a thousand metric evaluations. It is
      // only needed when detection put a corner several quadrants off; if the
      // pilots already agree on the quad from stage 1, it is skipped.
      if (pilotCheck(layout, h.pilotMetric.phasors(h.quad)).coherence < 0.85) {
        res = searchCorners(metric, h.quad, grid.cols, grid.rows, 3, 0.5);
        res = refineQuad(metric, res.quad, grid.cols, grid.rows, false);
      }
      // The energy metric has near-equal maxima one cell away and weaker ones
      // half a cell away. Only the pilots can tell them apart.
      const shifts: { quad: Quad; m: number }[] = [];
      for (let dv = -2; dv <= 2; dv++) {
        for (let du = -2; du <= 2; du++) {
          const sq = shiftQuadInGrid(res.quad, grid.cols, grid.rows, du, dv);
          shifts.push({ quad: sq, m: metric.eval(sq) });
        }
      }
      const mMax = Math.max(...shifts.map((s) => s.m));
      let pick: { quad: Quad; coh: number } | null = null;
      for (const s of shifts) {
        if (s.m < 0.4 * mMax) continue;
        const coh = pilotCheck(layout, h.pilotMetric.phasors(s.quad)).coherence;
        if (!pick || coh > pick.coh) pick = { quad: s.quad, coh };
      }
      if (!pick) continue;
      res = refineQuad(metric, pick.quad, grid.cols, grid.rows, false);
      if (!quadIsSane(res.quad, f0.w, f0.h)) continue;
      const pc = pilotCheck(layout, h.pilotMetric.phasors(res.quad));
      const pilotCoh = pc.coherence;
      // Contrast against the same grid shifted by half a quadrant, where the
      // checker correlation of a true signal collapses.
      const off = metric.eval(shiftQuadInGrid(res.quad, grid.cols, grid.rows, 1, 1));
      const contrast = res.score / (off + 1e-6);
      // Rank by pilot coherence first: a wrong grid can collect energy, but it
      // cannot make the pilots agree.
      const rank = pilotCoh * Math.min(contrast, 3);
      if (!best || rank > best.rank) best = { quad: res.quad, contrast, grid, plane: h.plane, pilotCoh, rank, kind: cand.kind, carrier: h.carrier, pilots: pc };
    }
    // Noise alone gives a contrast of 1.0 within a few percent (hundreds of
    // cell-windows are averaged) and a pilot coherence near 1/sqrt(pilots).
    if (!best || best.contrast < 1.5 || best.pilotCoh < 0.6) return null;
    // A place that already locked and then delivered nothing is not worth
    // locking again straight away; it would only hide other proposals.
    this.rejected = this.rejected.filter((r) => r.until > this.now);
    const diag = Math.hypot(best.quad[2].x - best.quad[0].x, best.quad[2].y - best.quad[0].y);
    for (const r of this.rejected) {
      let worst = 0;
      for (let i = 0; i < 4; i++) worst = Math.max(worst, Math.hypot(best.quad[i].x - r.quad[i].x, best.quad[i].y - r.quad[i].y));
      if (worst < 0.08 * diag) return null;
    }
    return best;
  }

  private applyLock(best: LockChoice, now: number): void {
    const frames = this.frames;
    const f0 = frames[0];
    this.quad = best.quad;
    this.grid = best.grid;
    this.lockPlane = best.plane;
    const { sx, sy } = subcellPixels(best.quad, best.grid.cols, best.grid.rows);
    const sm = samplingFor(Math.min(sx, sy), 6);
    this.smooth = sm.smooth;
    this.sampler = new GridSampler(best.grid.cols, best.grid.rows, sm.k, 0.6);
    this.trackSampler = new GridSampler(best.grid.cols, best.grid.rows, Math.min(3, sm.k), 0.6);
    this.sampler.setHomography(squareToQuad(best.quad), f0.w, f0.h);
    this.state = 'locked';
    if (this.tLock === null) this.tLock = now;
    this.tLockLast = now;
    this.lastTrack = now;
    // `now` is the frame that started the acquisition. On a slow device the
    // acquisition itself can take a second, during which frames are skipped,
    // so the allowance for "show me coherent pilots" must start counting at
    // the first frame that arrives after the lock, not here.
    this.lockClockPending = true;
    this.detection = best.kind;
    this.log(
      `locked ${best.grid.cols}x${best.grid.rows} via ${best.kind} (${best.plane}), contrast ${best.contrast.toFixed(1)}, pilots ${best.pilotCoh.toFixed(2)}, quadrant ${sx.toFixed(1)}x${sy.toFixed(1)} px`,
    );

    // Back-fill the cell ring from the frames we already hold, so the
    // demodulator does not have to wait for fresh ones.
    this.ring = { t: [], luma: [], chroma: [] };
    for (const f of frames) {
      const lq = new Float32Array(this.sampler.nCells);
      const cq = new Float32Array(this.sampler.nCells);
      this.sampler.sample(this.planeOf(f, 'luma'), lq);
      this.sampler.sample(this.planeOf(f, 'chroma'), cq);
      this.ring.t.push(f.t);
      this.ring.luma.push(lq);
      this.ring.chroma.push(cq);
    }
    this.demods = [];
    this.winner = null;
    for (const p of this.presets) {
      if (p.cols !== best.grid.cols || p.rows !== best.grid.rows) continue;
      const d = new Demodulator(p, frames[0].t);
      // The slopes measured at lock time hold for a preset whose carrier
      // aliases with the same sign as the one the lock assumed (or with the
      // opposite sign when the pilots only lined up conjugated).
      const sign = (hz: number) => Math.sign(hz - Math.round(hz / this.fps) * this.fps);
      if ((sign(p.carrierHz) === sign(best.carrier)) !== best.pilots.conj) d.setSlopePrior(best.pilots.su, best.pilots.sv);
      d.onPacket = (info) => this.onPacket(d, info);
      if (this.opt.onSymbol) d.onSymbol = (s) => this.opt.onSymbol!(p, s);
      this.demods.push(d);
    }
  }

  private track(): void {
    if (!this.quad || !this.grid || !this.trackSampler || !this.sampler) return;
    const frames = this.frames;
    const lead = this.winner ?? this.bestDemod();
    const carrier = lead?.preset.carrierHz ?? this.presets[0].carrierHz;
    const plane = lead?.plane ?? this.lockPlane;
    const perWindow = Math.max(3, Math.min(8, Math.round(this.fps * 0.1)));
    const windows = makeLockWindows(frames, carrier, perWindow, 2);
    if (!windows.length) return;
    const metric = new LockMetric(this.trackSampler, frames, plane, windows, this.smooth);
    const res = refineQuad(metric, this.quad, this.grid.cols, this.grid.rows, false);
    const f0 = frames[0];
    if (!quadIsSane(res.quad, f0.w, f0.h)) return;
    // Move halfway: the metric is noisy at low amplitude and a full step would
    // let the grid jitter.
    const q = cloneQuad(this.quad);
    for (let i = 0; i < 4; i++) {
      q[i].x += 0.5 * (res.quad[i].x - q[i].x);
      q[i].y += 0.5 * (res.quad[i].y - q[i].y);
    }
    this.quad = q;
    this.sampler.setHomography(squareToQuad(q), f0.w, f0.h);
  }

  private onPacket(d: Demodulator, info: PacketInfo): void {
    if (!this.winner) {
      this.winner = d;
      this.demods = [d];
      d.plane = d.plane ?? this.lockPlane;
      this.log(`first packet: preset ${d.preset.key}, K=${info.header.K}, session ${info.header.session}`);
    }
    // Times reported to the user are when the receiver knew, not when the symbol aired.
    if (this.tFirstPacket === null) this.tFirstPacket = this.now;
    this.tLastPacket = this.now;
    this.quietPackets = 0;
    this.quietPilots = 0;
    this.everCoherent = true;
    const layout = makeLayout(d.preset);
    const h = info.header;
    if (!this.decoder || this.decoder.K !== h.K || this.decoder.session !== h.session || this.decoder.blockSize !== layout.blockSize) {
      if (this.decoder) this.log('payload changed on the sender; starting over');
      this.decoder = new FountainDecoder(h.K, layout.blockSize, h.session);
      this.goodBytes = 0;
    }
    if (this.decoder.add(h.seq, info.block)) this.goodBytes += layout.blockSize;
    if (this.decoder.done && this.state !== 'done') {
      const obj = this.decoder.result()!;
      const payload = unpackContainer(obj);
      this.objectCrcOk = payload !== null;
      if (payload) {
        this.result = payload;
        this.tDone = this.now;
        this.state = 'done';
        this.log(`object complete: ${payload.type}, ${payload.data.length} bytes`);
      } else {
        // Should not happen with CRC-checked packets; start clean if it does.
        this.log('object failed its end-to-end CRC; discarding');
        this.decoder = null;
        this.goodBytes = 0;
      }
    }
  }

  /** Diagnostics only. */
  debugDemods(): Demodulator[] {
    return this.demods;
  }

  status(): RxStatus {
    const lead = this.winner ?? this.bestDemod();
    const st = lead?.stats;
    return {
      state: this.state,
      fps: this.fps,
      frames: this.frameCount,
      quad: this.quad ? cloneQuad(this.quad) : null,
      cols: this.grid?.cols ?? 0,
      rows: this.grid?.rows ?? 0,
      presetKey: this.winner?.preset.key ?? null,
      plane: lead?.plane ?? (this.state === 'locked' ? this.lockPlane : null),
      coherence: lead?.coherence ?? 0,
      snrDb: lead?.snrDb ?? 0,
      cellConf: lead ? lead.cellConf : null,
      K: this.decoder?.K ?? 0,
      rank: this.decoder?.rank ?? 0,
      progress: this.decoder ? this.decoder.progress : 0,
      packetsOk: st?.packetsOk ?? 0,
      packetsBad: st?.packetsBad ?? 0,
      rawBits: st?.rawBits ?? 0,
      rawBitErrors: st?.rawBitErrors ?? 0,
      goodBytes: this.goodBytes,
      tFirstFrame: this.tFirst ?? 0,
      tLock: this.tLock,
      tFirstPacket: this.tFirstPacket,
      tDone: this.tDone,
      lockAttempts: this.lockAttempts,
      detection: this.detection,
      result: this.result,
      objectCrcOk: this.objectCrcOk,
    };
  }
}
