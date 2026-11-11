// Parameter presets. A preset fixes everything the receiver must know before
// it can demodulate: grid, carrier, symbol length, packet span and RS rate.
// The receiver tries every preset during acquisition, so the user does not
// have to match settings by hand.

export interface Preset {
  /** 0..15, carried in every packet header as a cross-check. */
  id: number;
  key: string;
  label: string;
  cols: number;
  rows: number;
  /** A cell is a pilot when (col + 3*row) % pilotMod === 0. */
  pilotMod: number;
  /** 1 = BPSK, 2 = QPSK. */
  bitsPerCell: 1 | 2;
  /** Carrier frequency of the temporal modulation, in Hz. */
  carrierHz: number;
  /** Carrier cycles per symbol; symbol duration = cycles / carrierHz. */
  cyclesPerSymbol: number;
  /** Symbols (grid frames) per packet. */
  symbolsPerPacket: number;
  /** Fraction of each RS codeword spent on parity. */
  parityFrac: number;
  /** Lowest camera frame rate that leaves >= 4 usable frames per symbol. */
  minCameraFps: number;
  note: string;
}

export const PRESETS: Preset[] = [
  {
    id: 0,
    key: 'far',
    label: 'Far (12×7)',
    cols: 12,
    rows: 7,
    pilotMod: 7,
    bitsPerCell: 2,
    carrierHz: 20,
    cyclesPerSymbol: 4,
    symbolsPerPacket: 4,
    parityFrac: 0.4,
    minCameraFps: 25,
    note: 'Large cells for 1–2 m or small screens.',
  },
  {
    id: 1,
    key: 'standard',
    label: 'Standard (16×9)',
    cols: 16,
    rows: 9,
    pilotMod: 8,
    bitsPerCell: 2,
    carrierHz: 20,
    cyclesPerSymbol: 4,
    symbolsPerPacket: 2,
    parityFrac: 0.34,
    minCameraFps: 25,
    note: 'Default. Laptop screen at arm’s length.',
  },
  {
    id: 2,
    key: 'dense',
    label: 'Dense (24×14)',
    cols: 24,
    rows: 14,
    pilotMod: 11,
    bitsPerCell: 2,
    carrierHz: 20,
    cyclesPerSymbol: 4,
    symbolsPerPacket: 1,
    parityFrac: 0.32,
    minCameraFps: 25,
    note: 'Close range, steady hand. Highest rate at 30 fps.',
  },
  {
    id: 3,
    key: 'fast',
    label: 'Fast (24×14, 60 fps camera)',
    cols: 24,
    rows: 14,
    pilotMod: 11,
    bitsPerCell: 2,
    carrierHz: 20,
    cyclesPerSymbol: 2,
    symbolsPerPacket: 1,
    parityFrac: 0.32,
    minCameraFps: 50,
    note: '100 ms symbols. Needs a camera that really delivers 60 fps.',
  },
  {
    id: 4,
    key: 'export',
    label: 'Export-safe (12×7 BPSK)',
    cols: 12,
    rows: 7,
    pilotMod: 7,
    bitsPerCell: 1,
    carrierHz: 10,
    cyclesPerSymbol: 4,
    symbolsPerPacket: 6,
    parityFrac: 0.4,
    minCameraFps: 25,
    note: 'Low-rate mode for exported or compressed video. 10 Hz carrier fits inside a 30 fps file but is visible.',
  },
  {
    id: 5,
    key: 'hfr',
    label: 'High refresh (16×9, 40 Hz carrier)',
    cols: 16,
    rows: 9,
    pilotMod: 8,
    bitsPerCell: 2,
    carrierHz: 40,
    cyclesPerSymbol: 8,
    symbolsPerPacket: 2,
    parityFrac: 0.34,
    minCameraFps: 25,
    note: 'For 120 Hz and faster displays: the carrier moves to 40 Hz, above the range where flicker is easiest to see.',
  },
];

export function presetByKey(key: string): Preset {
  const p = PRESETS.find((x) => x.key === key);
  if (!p) throw new Error(`unknown preset ${key}`);
  return p;
}

export function symbolSeconds(p: Preset): number {
  return p.cyclesPerSymbol / p.carrierHz;
}

export const PROTOCOL_VERSION = 1;
