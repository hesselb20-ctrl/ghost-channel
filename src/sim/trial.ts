// One end-to-end trial: real transmitter -> simulated display and camera ->
// real receiver. Everything the receiver reports is what the browser build
// would report; `trueBer` additionally uses the simulator's knowledge of what
// was sent.

import type { Payload } from '../core/container.ts';
import { makeLayout, Q_TO_GRAY, rotationQ } from '../core/layout.ts';
import { DEFAULT_MOD, type ModParams } from '../core/modmath.ts';
import { Transmitter } from '../core/packet.ts';
import { PRESETS, presetByKey, type Preset } from '../core/presets.ts';
import { mulberry32 } from '../core/prng.ts';
import { rgbaToFrame } from '../core/rx/frame.ts';
import { Receiver } from '../core/rx/receiver.ts';
import { CameraSim, DEFAULT_CAMERA, DEFAULT_DISPLAY, DisplaySim, projectScreen, type CameraParams, type DisplayParams } from './camera.ts';
import type { Quad } from '../core/homography.ts';
import type { ContentKind } from './content.ts';

export interface TrialConfig {
  /** Preset key, or a full preset object for experiments outside the shipped list. */
  preset: string | Preset;
  mod?: Partial<ModParams>;
  content?: ContentKind;
  display?: Partial<DisplayParams>;
  camera?: Partial<CameraParams>;
  /** Payload size in bytes (random data sent as a file), or an explicit payload. */
  payloadBytes?: number;
  payload?: Payload;
  /** Stop after this many seconds of camera time even if not decoded. */
  maxSeconds?: number;
  /** Keep running after the object is complete, to measure steady-state rates. */
  runFullDuration?: boolean;
  seed?: number;
  /** Presets the receiver is allowed to try. Default: all. */
  rxPresets?: Preset[];
  /** Detector decimation; raise it with the camera resolution. */
  mapStep?: number;
  verbose?: boolean;
  /**
   * Simulates the user dragging the four corner handles onto the screen, with
   * this many pixels of error per corner (the receiver's manual-assist path).
   */
  manualCornersPx?: number;
}

export interface TrialResult {
  decoded: boolean;
  payloadOk: boolean;
  /** Seconds from the first camera frame to ... */
  tLock: number | null;
  tFirstPacket: number | null;
  tDecode: number | null;
  packetsOk: number;
  packetsBad: number;
  packetSuccess: number;
  /** Pre-FEC bit error rate measured by the receiver on verified packets. */
  rawBer: number;
  /** Pre-FEC bit error rate over every demodulated symbol, from ground truth. */
  trueBer: number;
  trueBits: number;
  /** User bits per second actually delivered between first lock and the end. */
  throughputBps: number;
  /** Rate the preset would deliver with zero packet loss. */
  nominalBps: number;
  coherence: number;
  snrDb: number;
  lockAttempts: number;
  detection: string | null;
  presetDetected: string | null;
  seconds: number;
  events: string[];
  senderDroppedFrames: number;
}

export function randomPayload(bytes: number, seed: number): Payload {
  const rng = mulberry32(seed);
  const data = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i++) data[i] = rng() & 0xff;
  return { type: 'file', data, name: 'blob.bin', mime: 'application/octet-stream' };
}

export function runTrial(cfg: TrialConfig): TrialResult {
  const seed = cfg.seed ?? 1;
  const preset = typeof cfg.preset === 'string' ? presetByKey(cfg.preset) : cfg.preset;
  const layout = makeLayout(preset);
  const mod: ModParams = { ...DEFAULT_MOD, ...cfg.mod };
  const payload = cfg.payload ?? randomPayload(cfg.payloadBytes ?? 60, seed + 99);
  const tx = new Transmitter(preset, payload, seed & 0xff);
  const dparams: DisplayParams = { ...DEFAULT_DISPLAY, ...cfg.display };
  const cparams: CameraParams = { ...DEFAULT_CAMERA, ...cfg.camera };
  const display = new DisplaySim(dparams, tx, mod, cfg.content ?? 'gray', seed);
  const camera = new CameraSim(cparams, display, seed * 7919 + 13);

  const events: string[] = [];
  let trueBits = 0;
  let trueErrs = 0;
  // Camera timestamps are mid-exposure of the middle row in display time
  // (plus jitter), so a symbol's centre time maps straight to its index.
  const rx = new Receiver({
    presets: cfg.rxPresets ?? (typeof cfg.preset === 'string' ? PRESETS : [preset]),
    mapStep: cfg.mapStep,
    onEvent: (m) => {
      events.push(m);
      if (cfg.verbose) console.log('   rx:', m);
    },
    onSymbol: (p, s) => {
      if (p.key !== preset.key || s.coherence < 0.55) return;
      const idx = Math.floor(s.time / layout.symbolSeconds);
      const sent = tx.symbolCells(idx);
      const rot = rotationQ(idx, preset.symbolsPerPacket);
      for (let d = 0; d < layout.dataCells.length; d++) {
        const want = (sent[layout.dataCells[d]] - rot) & 3;
        const x = Q_TO_GRAY[want] ^ Q_TO_GRAY[s.q[d]];
        if (preset.bitsPerCell === 1) {
          trueErrs += x ? 1 : 0;
          trueBits += 1;
        } else {
          trueErrs += (x & 1) + (x >> 1);
          trueBits += 2;
        }
      }
    },
  });

  if (cfg.manualCornersPx !== undefined) {
    const rng = mulberry32(seed * 31 + 7);
    const e = cfg.manualCornersPx;
    const q = projectScreen(cparams, dparams.w / dparams.h).map((p) => ({ x: p.x + ((rng() % 2001) / 1000 - 1) * e, y: p.y + ((rng() % 2001) / 1000 - 1) * e }));
    rx.setManualQuad(q as Quad);
  }
  const maxSeconds = cfg.maxSeconds ?? 12;
  const nFrames = Math.ceil(maxSeconds * cparams.fps);
  let tFirst: number | null = null;
  let tLast = 0;
  for (let k = 0; k < nFrames; k++) {
    const f = camera.capture(k);
    if (!f) continue;
    if (tFirst === null) tFirst = f.t;
    tLast = f.t;
    rx.pushFrame(rgbaToFrame(f.rgba, cparams.w, cparams.h, f.t));
    if (rx.state === 'done' && !cfg.runFullDuration) break;
  }
  const st = rx.status();
  const t0 = tFirst ?? 0;
  const rel = (t: number | null) => (t === null ? null : t - t0);
  let payloadOk = false;
  if (st.result) {
    payloadOk = st.result.data.length === payload.data.length && st.result.data.every((b, i) => b === payload.data[i]);
  }
  const span = st.tLock !== null ? Math.max(1e-6, (st.tDone ?? tLast) - st.tLock) : 0;
  return {
    decoded: st.result !== null,
    payloadOk,
    tLock: rel(st.tLock),
    tFirstPacket: rel(st.tFirstPacket),
    tDecode: rel(st.tDone),
    packetsOk: st.packetsOk,
    packetsBad: st.packetsBad,
    packetSuccess: st.packetsOk + st.packetsBad > 0 ? st.packetsOk / (st.packetsOk + st.packetsBad) : 0,
    rawBer: st.rawBits ? st.rawBitErrors / st.rawBits : NaN,
    trueBer: trueBits ? trueErrs / trueBits : NaN,
    trueBits,
    throughputBps: span > 0 ? (st.goodBytes * 8) / span : 0,
    nominalBps: layout.netBitsPerSecond,
    coherence: st.coherence,
    snrDb: st.snrDb,
    lockAttempts: st.lockAttempts,
    detection: st.detection,
    presetDetected: st.presetKey,
    seconds: tLast - t0,
    events,
    senderDroppedFrames: display.framesDropped,
  };
}

export function fmt(r: TrialResult): string {
  const f = (v: number | null, d = 2) => (v === null || Number.isNaN(v) ? '  -  ' : v.toFixed(d));
  return [
    r.decoded ? (r.payloadOk ? 'OK  ' : 'BAD ') : 'FAIL',
    `lock ${f(r.tLock)}s`,
    `first ${f(r.tFirstPacket)}s`,
    `done ${f(r.tDecode)}s`,
    `pkts ${r.packetsOk}/${r.packetsOk + r.packetsBad}`,
    `BER ${Number.isNaN(r.trueBer) ? '  -  ' : r.trueBer.toExponential(1)}`,
    `${r.throughputBps.toFixed(0)} bps`,
    `coh ${r.coherence.toFixed(2)}`,
    `snr ${r.snrDb.toFixed(1)}dB`,
    r.presetDetected ?? '',
  ].join('  ');
}
