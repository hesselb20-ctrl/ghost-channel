// Sender engine: owns the requestAnimationFrame loop, measures the display
// refresh rate, counts dropped frames, and drives the renderer with the right
// symbol and carrier phase for each displayed frame.

import type { Payload } from '../core/container.ts';
import { DEFAULT_MOD, symbolAt, type ModParams } from '../core/modmath.ts';
import { Transmitter } from '../core/packet.ts';
import type { Preset } from '../core/presets.ts';
import { GhostRenderer, type Fit } from './renderer.ts';

export interface ContentSource {
  /** Called once per displayed frame; uploads into the renderer when the picture changed. */
  update(renderer: GhostRenderer, tSec: number): void;
  dispose?(): void;
}

export interface SenderStats {
  running: boolean;
  /** Measured refresh rate, Hz. */
  refreshHz: number;
  /** Rate the modulation is locked to (the measurement snapped to a standard rate). */
  nominalHz: number;
  frames: number;
  dropped: number;
  dropPct: number;
  symbolIndex: number;
  packetIndex: number;
  carrierHz: number;
  framesPerCycle: number;
  netBps: number;
  K: number;
  objectBytes: number;
  /** Seconds for a receiver to collect K packets with no loss. */
  passSeconds: number;
}

const STANDARD_RATES = [24, 30, 48, 50, 60, 72, 75, 90, 100, 120, 144, 165, 180, 240, 360];

export function snapRefresh(hz: number): number {
  let best = hz;
  let err = Infinity;
  for (const r of STANDARD_RATES) {
    const e = Math.abs(hz - r) / r;
    if (e < err) {
      err = e;
      best = r;
    }
  }
  return err < 0.02 ? best : hz;
}

export class GhostSender {
  readonly canvas: HTMLCanvasElement;
  readonly renderer: GhostRenderer;
  mod: ModParams = { ...DEFAULT_MOD };
  fit: Fit = 'cover';
  showGrid = false;
  /** When false the picture is drawn with zero amplitude (used by the A/B test). */
  modulate = true;
  /** Keep the canvas at its own width/height instead of following CSS size (off-screen use). */
  fixedSize = false;
  onStats: ((s: SenderStats) => void) | null = null;

  private tx: Transmitter | null = null;
  private preset: Preset | null = null;
  private source: ContentSource | null = null;
  private raf = 0;
  private running = false;
  private deltas: number[] = [];
  private lastTs = 0;
  private refreshHz = 60;
  private nominalHz = 60;
  private t0 = 0;
  private n = 0;
  private frames = 0;
  private dropped = 0;
  private lastSymbol = -1;
  private startCycle = 0;
  private stopCycle = -1;
  private lastStats = 0;
  private settled = false;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.renderer = new GhostRenderer(canvas);
  }

  configure(preset: Preset, payload: Payload): void {
    this.preset = preset;
    this.tx = new Transmitter(preset, payload);
    this.lastSymbol = -1;
  }

  setSource(source: ContentSource | null): void {
    this.source?.dispose?.();
    this.source = source;
  }

  get transmitter(): Transmitter | null {
    return this.tx;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastTs = 0;
    this.frames = 0;
    this.dropped = 0;
    this.settled = false;
    this.stopCycle = -1;
    this.startCycle = -1;
    this.raf = requestAnimationFrame(this.tick);
  }

  /** Fades the modulation out over half a second, then stops the loop. */
  stop(immediate = false): void {
    if (!this.running) return;
    if (immediate || !this.preset) {
      this.running = false;
      cancelAnimationFrame(this.raf);
      this.emitStats(true);
      return;
    }
    this.stopCycle = Math.floor((this.n / this.nominalHz) * this.preset.carrierHz) + Math.ceil(this.preset.carrierHz / 2);
  }

  resetCounters(): void {
    this.frames = 0;
    this.dropped = 0;
  }

  private resize(): void {
    if (this.fixedSize) return;
    const c = this.canvas;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(2, Math.round(c.clientWidth * dpr));
    const h = Math.max(2, Math.round(c.clientHeight * dpr));
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
    }
  }

  private tick = (ts: number): void => {
    if (!this.running) return;
    this.raf = requestAnimationFrame(this.tick);
    const preset = this.preset;
    const tx = this.tx;
    if (!preset || !tx) return;

    // Refresh rate: median of recent frame intervals, robust to the odd long frame.
    if (this.lastTs > 0) {
      const d = ts - this.lastTs;
      if (d > 0.5 && d < 250) {
        this.deltas.push(d);
        if (this.deltas.length > 120) this.deltas.shift();
      }
      if (this.deltas.length >= 20 && this.frames % 15 === 0) {
        const sorted = this.deltas.slice().sort((a, b) => a - b);
        const med = sorted[sorted.length >> 1];
        this.refreshHz = 1000 / med;
        const snapped = snapRefresh(this.refreshHz);
        if (!this.settled || Math.abs(snapped - this.nominalHz) / this.nominalHz > 0.03) {
          // Refresh rate became known or changed (window moved to another display).
          this.nominalHz = snapped;
          this.t0 = ts - this.n * med;
          this.settled = this.deltas.length >= 40;
        }
      }
    } else {
      this.t0 = ts;
      this.n = 0;
    }
    this.lastTs = ts;

    // Display-frame counter. A jump of more than one means we missed a refresh.
    const periodMs = 1000 / this.refreshHz;
    const ideal = (ts - this.t0) / periodMs;
    let n = Math.round(ideal);
    if (n <= this.n && this.frames > 0) n = this.n + 1;
    if (this.frames > 0 && n - this.n > 1 && this.settled) this.dropped += n - this.n - 1;
    // Slowly re-anchor so rounding never drifts across a frame boundary.
    this.t0 += 0.02 * (ideal - n) * periodMs;
    this.n = n;
    this.frames++;

    // The modulation clock counts displayed frames at the nominal rate, so the
    // carrier stays locked to whole frames (exact zero-sum triplets at 60 Hz).
    const t = n / this.nominalHz;
    const pos = symbolAt(t, preset, this.mod.edgeGain);
    if (pos.index !== this.lastSymbol) {
      this.renderer.setCells(preset.cols, preset.rows, tx.symbolCells(pos.index));
      this.lastSymbol = pos.index;
    }
    const cycle = Math.floor(t * preset.carrierHz + 1e-7);
    if (this.startCycle < 0) this.startCycle = cycle;
    const rampCycles = Math.max(2, Math.round(preset.carrierHz / 2));
    let fade = Math.min(1, (cycle - this.startCycle + 1) / rampCycles);
    if (this.stopCycle >= 0) {
      fade = Math.min(fade, Math.max(0, (this.stopCycle - cycle) / rampCycles));
      if (cycle >= this.stopCycle) {
        this.running = false;
        cancelAnimationFrame(this.raf);
      }
    }
    const cyc = t * preset.carrierHz;
    const phase = 2 * Math.PI * (cyc - Math.floor(cyc));

    this.resize();
    this.source?.update(this.renderer, ts / 1000);
    this.renderer.draw({
      phase,
      env: this.modulate ? pos.env * fade : 0,
      frame: n,
      mod: this.mod,
      fit: this.fit,
      showGrid: this.showGrid,
    });
    if (ts - this.lastStats > 250) {
      this.lastStats = ts;
      this.emitStats(false);
    }
  };

  stats(): SenderStats {
    const tx = this.tx;
    const preset = this.preset;
    const layout = tx?.layout;
    const S = preset?.symbolsPerPacket ?? 1;
    return {
      running: this.running,
      refreshHz: this.refreshHz,
      nominalHz: this.nominalHz,
      frames: this.frames,
      dropped: this.dropped,
      dropPct: this.frames ? (100 * this.dropped) / (this.frames + this.dropped) : 0,
      symbolIndex: Math.max(0, this.lastSymbol),
      packetIndex: Math.floor(Math.max(0, this.lastSymbol) / S),
      carrierHz: preset?.carrierHz ?? 0,
      framesPerCycle: preset ? this.nominalHz / preset.carrierHz : 0,
      netBps: layout?.netBitsPerSecond ?? 0,
      K: tx?.encoder.K ?? 0,
      objectBytes: tx?.objectBytes ?? 0,
      passSeconds: layout && tx ? tx.encoder.K * layout.packetSeconds : 0,
    };
  }

  private emitStats(_final: boolean): void {
    this.onStats?.(this.stats());
  }
}
