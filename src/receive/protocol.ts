// Messages between the receive page and its worker.

import type { PayloadType } from '../core/container.ts';

export interface WirePt {
  x: number;
  y: number;
}

export interface WireStatus {
  state: 'search' | 'locked' | 'done';
  fps: number;
  frames: number;
  quad: WirePt[] | null;
  cols: number;
  rows: number;
  presetKey: string | null;
  plane: string | null;
  coherence: number;
  snrDb: number;
  cellConf: number[] | null;
  K: number;
  rank: number;
  progress: number;
  packetsOk: number;
  packetsBad: number;
  rawBits: number;
  rawBitErrors: number;
  goodBytes: number;
  tFirstFrame: number;
  tLock: number | null;
  tFirstPacket: number | null;
  tDone: number | null;
  lockAttempts: number;
  detection: string | null;
  /** Mean worker time per frame, ms. */
  procMs: number;
  /** Recent worst-case worker time per frame, ms. */
  procMsMax: number;
  /** Mean time to downscale and read back a frame, ms. */
  scaleMs: number;
  /** One line per active demodulator, for the diagnostics panel. */
  debug: string;
  procW: number;
  procH: number;
  /** Timestamp of the frame this status describes. */
  t: number;
}

export type ToWorker =
  | { type: 'config'; procWidth: number; presetKeys: string[] | null }
  | { type: 'reset' }
  | { type: 'manual'; quad: WirePt[] | null }
  | { type: 'frame'; bitmap: ImageBitmap; t: number }
  | { type: 'pixels'; rgba: ArrayBuffer; w: number; h: number; t: number };

export type ToMain =
  | { type: 'ready'; backend: string }
  | { type: 'ack' }
  | { type: 'log'; msg: string }
  | { type: 'status'; status: WireStatus }
  | { type: 'result'; payloadType: PayloadType; name: string | null; mime: string | null; data: Uint8Array };
