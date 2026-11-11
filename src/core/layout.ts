// Grid layout and packet geometry derived from a preset.

import { hashInts, mulberry32 } from './prng.ts';
import type { Preset } from './presets.ts';

export const HEADER_BYTES = 6;
export const CRC_BYTES = 4;

export interface Codeword {
  len: number;
  parity: number;
}

export interface Layout {
  preset: Preset;
  cols: number;
  rows: number;
  nCells: number;
  /** 1 where the cell is a pilot. */
  isPilot: Uint8Array;
  /** Known pilot quadrant (0..3) per cell; 0 for data cells. */
  pilotQ: Uint8Array;
  pilotCells: Int32Array;
  dataCells: Int32Array;
  /** Coded bytes per packet. */
  packetBytes: number;
  codewords: Codeword[];
  /** RS message bytes per packet: header + block + CRC. */
  messageBytes: number;
  /** Fountain block size (user bytes per packet). */
  blockSize: number;
  symbolSeconds: number;
  packetSeconds: number;
  /** User bits per second while packets flow without loss. */
  netBitsPerSecond: number;
  /** Fixed whitening sequence, one byte per coded byte. */
  scramble: Uint8Array;
}

const cache = new Map<string, Layout>();

export function makeLayout(preset: Preset): Layout {
  const hit = cache.get(preset.key);
  if (hit && hit.preset === preset) return hit;
  const { cols, rows } = preset;
  const nCells = cols * rows;
  const isPilot = new Uint8Array(nCells);
  const pilotQ = new Uint8Array(nCells);
  const pilots: number[] = [];
  const data: number[] = [];
  const rng = mulberry32(hashInts(0x6c0c, cols, rows, preset.pilotMod));
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      if ((c + 3 * r) % preset.pilotMod === 0) {
        isPilot[i] = 1;
        pilotQ[i] = rng() & 3;
        pilots.push(i);
      } else {
        data.push(i);
      }
    }
  }
  const bitsPerPacket = data.length * preset.bitsPerCell * preset.symbolsPerPacket;
  const packetBytes = Math.floor(bitsPerPacket / 8);
  const nCw = Math.ceil(packetBytes / 255);
  const codewords: Codeword[] = [];
  let messageBytes = 0;
  for (let i = 0; i < nCw; i++) {
    const len = Math.floor(packetBytes / nCw) + (i < packetBytes % nCw ? 1 : 0);
    const parity = Math.max(2, 2 * Math.round((len * preset.parityFrac) / 2));
    codewords.push({ len, parity });
    messageBytes += len - parity;
  }
  const blockSize = messageBytes - HEADER_BYTES - CRC_BYTES;
  if (blockSize < 4) throw new Error(`preset ${preset.key}: packet too small`);
  const symSec = preset.cyclesPerSymbol / preset.carrierHz;
  const scr = new Uint8Array(packetBytes);
  const srng = mulberry32(0x5eed6c0c);
  for (let i = 0; i < packetBytes; i++) scr[i] = srng() & 0xff;
  const layout: Layout = {
    preset,
    cols,
    rows,
    nCells,
    isPilot,
    pilotQ,
    pilotCells: Int32Array.from(pilots),
    dataCells: Int32Array.from(data),
    packetBytes,
    codewords,
    messageBytes,
    blockSize,
    symbolSeconds: symSec,
    packetSeconds: symSec * preset.symbolsPerPacket,
    netBitsPerSecond: (blockSize * 8) / (symSec * preset.symbolsPerPacket),
    scramble: scr,
  };
  cache.set(preset.key, layout);
  return layout;
}

/**
 * Whole-grid phase rotation, in quarter turns, applied to symbol `i`.
 * Every symbol advances by 90°; the first symbol of a packet advances by an
 * extra 90° (180° in total). That gives the receiver a transition at every
 * symbol boundary for timing, and marks packet starts without spending cells.
 */
export function rotationQ(i: number, symbolsPerPacket: number): number {
  return (i + 1 + Math.floor(i / symbolsPerPacket) + 1) & 3;
}

/** Gray mapping between a bit pair and a quadrant index. */
export const GRAY_TO_Q = [0, 1, 3, 2];
export const Q_TO_GRAY = [0, 1, 3, 2];
