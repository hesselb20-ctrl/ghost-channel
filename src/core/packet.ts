// Packet framing: header + fountain block + CRC-32, Reed–Solomon coded,
// byte-interleaved across codewords, whitened, then mapped onto grid cells.

import { crc32 } from './crc32.ts';
import { FountainEncoder } from './fountain.ts';
import { packContainer, type Payload } from './container.ts';
import { CRC_BYTES, GRAY_TO_Q, HEADER_BYTES, makeLayout, Q_TO_GRAY, rotationQ, type Layout } from './layout.ts';
import { mulberry32 } from './prng.ts';
import { PROTOCOL_VERSION, type Preset } from './presets.ts';
import { rsDecode, rsEncode } from './rs.ts';

export interface PacketHeader {
  version: number;
  presetId: number;
  session: number;
  /** Number of fountain source blocks in the object. */
  K: number;
  seq: number;
}

export function encodePacketBytes(layout: Layout, header: PacketHeader, block: Uint8Array): Uint8Array {
  const msg = new Uint8Array(layout.messageBytes);
  msg[0] = ((header.version & 0xf) << 4) | (header.presetId & 0xf);
  msg[1] = header.session & 0xff;
  msg[2] = (header.K >>> 8) & 0xff;
  msg[3] = header.K & 0xff;
  msg[4] = (header.seq >>> 8) & 0xff;
  msg[5] = header.seq & 0xff;
  msg.set(block.subarray(0, layout.blockSize), HEADER_BYTES);
  const c = crc32(msg, 0, msg.length - CRC_BYTES);
  const o = msg.length - CRC_BYTES;
  msg[o] = c >>> 24;
  msg[o + 1] = (c >>> 16) & 0xff;
  msg[o + 2] = (c >>> 8) & 0xff;
  msg[o + 3] = c & 0xff;

  const cws: Uint8Array[] = [];
  let off = 0;
  for (const cw of layout.codewords) {
    const k = cw.len - cw.parity;
    cws.push(rsEncode(msg.subarray(off, off + k), cw.parity));
    off += k;
  }
  const out = new Uint8Array(layout.packetBytes);
  let p = 0;
  const maxLen = Math.max(...layout.codewords.map((c2) => c2.len));
  for (let j = 0; j < maxLen; j++) {
    for (let i = 0; i < cws.length; i++) if (j < cws[i].length) out[p++] = cws[i][j];
  }
  for (let i = 0; i < out.length; i++) out[i] ^= layout.scramble[i];
  return out;
}

export interface DecodedPacket {
  header: PacketHeader;
  block: Uint8Array;
  /** Bytes the RS decoder had to change. */
  correctedBytes: number;
}

/**
 * `coded` is the received packet (hard decisions). `byteRel`, if given, is a
 * per-byte reliability; the weakest bytes are offered to the RS decoder as
 * erasures in a few escalating attempts.
 */
export function decodePacketBytes(layout: Layout, coded: Uint8Array, byteRel?: Float32Array): DecodedPacket | null {
  const nCw = layout.codewords.length;
  const cwBytes: Uint8Array[] = layout.codewords.map((c) => new Uint8Array(c.len));
  const cwRel: Float32Array[] = layout.codewords.map((c) => new Float32Array(c.len));
  let p = 0;
  const maxLen = Math.max(...layout.codewords.map((c) => c.len));
  for (let j = 0; j < maxLen; j++) {
    for (let i = 0; i < nCw; i++) {
      if (j < cwBytes[i].length) {
        cwBytes[i][j] = coded[p] ^ layout.scramble[p];
        cwRel[i][j] = byteRel ? byteRel[p] : 1;
        p++;
      }
    }
  }
  const order = cwRel.map((rel) => Array.from(rel.keys()).sort((a, b) => rel[a] - rel[b]));
  const levels = byteRel ? [0, 0.5, 0.9] : [0];
  for (const level of levels) {
    const msg = new Uint8Array(layout.messageBytes);
    let off = 0;
    let ok = true;
    let corrected = 0;
    for (let i = 0; i < nCw; i++) {
      const { len, parity } = layout.codewords[i];
      const nErase = Math.min(parity, Math.floor(parity * level));
      const work = cwBytes[i].slice();
      const res = rsDecode(work, parity, order[i].slice(0, nErase));
      if (!res.ok) {
        ok = false;
        break;
      }
      corrected += res.corrected;
      msg.set(work.subarray(0, len - parity), off);
      off += len - parity;
    }
    if (!ok) continue;
    const o = msg.length - CRC_BYTES;
    const want = ((msg[o] << 24) | (msg[o + 1] << 16) | (msg[o + 2] << 8) | msg[o + 3]) >>> 0;
    if (crc32(msg, 0, o) !== want) continue;
    const header: PacketHeader = {
      version: msg[0] >>> 4,
      presetId: msg[0] & 0xf,
      session: msg[1],
      K: (msg[2] << 8) | msg[3],
      seq: (msg[4] << 8) | msg[5],
    };
    if (header.version !== PROTOCOL_VERSION || header.presetId !== layout.preset.id || header.K === 0) continue;
    return { header, block: msg.slice(HEADER_BYTES, o), correctedBytes: corrected };
  }
  return null;
}

const padCache = new Map<string, Uint8Array>();
function padBits(layout: Layout): Uint8Array {
  let pad = padCache.get(layout.preset.key);
  if (!pad) {
    const slots = layout.dataCells.length * layout.preset.symbolsPerPacket;
    pad = new Uint8Array(slots * layout.preset.bitsPerCell);
    const rng = mulberry32(0xbad5eed);
    for (let i = 0; i < pad.length; i++) pad[i] = rng() & 1;
    padCache.set(layout.preset.key, pad);
  }
  return pad;
}

/**
 * Coded packet bytes -> data quadrant per (symbol, data cell). Bits are taken
 * MSB first; one cell holds one bit (BPSK: quadrant 0 or 2) or a Gray-coded
 * pair (QPSK). Slots beyond the last whole byte carry fixed filler.
 */
export function bytesToCellQ(layout: Layout, coded: Uint8Array): Uint8Array[] {
  const S = layout.preset.symbolsPerPacket;
  const nData = layout.dataCells.length;
  const bpc = layout.preset.bitsPerCell;
  const pad = padBits(layout);
  const nBits = coded.length * 8;
  const bit = (i: number) => (i < nBits ? (coded[i >>> 3] >>> (7 - (i & 7))) & 1 : pad[i]);
  const out: Uint8Array[] = [];
  let b = 0;
  for (let s = 0; s < S; s++) {
    const q = new Uint8Array(nData);
    for (let d = 0; d < nData; d++) {
      if (bpc === 2) {
        q[d] = GRAY_TO_Q[(bit(b) << 1) | bit(b + 1)];
        b += 2;
      } else {
        q[d] = bit(b) ? 2 : 0;
        b += 1;
      }
    }
    out.push(q);
  }
  return out;
}

/** Inverse of bytesToCellQ, with per-byte reliability = weakest contributing cell. */
export function cellQToBytes(
  layout: Layout,
  q: Uint8Array[],
  rel?: Float32Array[],
): { bytes: Uint8Array; byteRel: Float32Array } {
  const S = layout.preset.symbolsPerPacket;
  const nData = layout.dataCells.length;
  const bpc = layout.preset.bitsPerCell;
  const bytes = new Uint8Array(layout.packetBytes);
  const byteRel = new Float32Array(layout.packetBytes).fill(Infinity);
  const nBits = layout.packetBytes * 8;
  let b = 0;
  for (let s = 0; s < S; s++) {
    for (let d = 0; d < nData; d++) {
      const r = rel ? rel[s][d] : 1;
      const bits = bpc === 2 ? Q_TO_GRAY[q[s][d] & 3] : (q[s][d] & 3) === 2 ? 1 : 0;
      for (let k = bpc - 1; k >= 0; k--) {
        if (b < nBits) {
          if ((bits >>> k) & 1) bytes[b >>> 3] |= 0x80 >>> (b & 7);
          if (r < byteRel[b >>> 3]) byteRel[b >>> 3] = r;
        }
        b++;
      }
    }
  }
  return { bytes, byteRel };
}

/** Turns a payload into the per-symbol cell phases the sender displays. */
export class Transmitter {
  readonly layout: Layout;
  readonly encoder: FountainEncoder;
  readonly session: number;
  readonly objectBytes: number;
  private cachePacket = -1;
  private cacheQ: Uint8Array[] = [];

  constructor(preset: Preset, payload: Payload, session = Math.floor(Math.random() * 256)) {
    this.layout = makeLayout(preset);
    const object = packContainer(payload);
    this.objectBytes = object.length;
    this.session = session & 0xff;
    this.encoder = new FountainEncoder(object, this.layout.blockSize, this.session);
  }

  header(packetIndex: number): PacketHeader {
    return {
      version: PROTOCOL_VERSION,
      presetId: this.layout.preset.id,
      session: this.session,
      K: this.encoder.K,
      seq: packetIndex & 0xffff,
    };
  }

  packetBytes(packetIndex: number): Uint8Array {
    const h = this.header(packetIndex);
    return encodePacketBytes(this.layout, h, this.encoder.packet(h.seq));
  }

  /** Quadrant (0..3) of every grid cell for symbol `i`, rotation included. */
  symbolCells(i: number): Uint8Array {
    const { layout } = this;
    const S = layout.preset.symbolsPerPacket;
    const p = Math.floor(i / S);
    if (p !== this.cachePacket) {
      this.cacheQ = bytesToCellQ(layout, this.packetBytes(p));
      this.cachePacket = p;
    }
    const dq = this.cacheQ[i - p * S];
    const rot = rotationQ(i, S);
    const out = new Uint8Array(layout.nCells);
    for (let k = 0; k < layout.pilotCells.length; k++) {
      const c = layout.pilotCells[k];
      out[c] = (layout.pilotQ[c] + rot) & 3;
    }
    for (let d = 0; d < layout.dataCells.length; d++) out[layout.dataCells[d]] = (dq[d] + rot) & 3;
    return out;
  }
}
