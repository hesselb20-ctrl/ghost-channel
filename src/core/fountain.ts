// Fountain code across packets.
//
// The object is cut into K source blocks. Every packet carries the XOR of a
// set of blocks that both ends derive from (K, session, seq) alone, so a
// receiver can join at any point and needs no particular packets, just enough
// of them.
//
//  K <= 8 : carousel of the K blocks plus one XOR-of-all parity packet. Any K
//           of the K+1 packets in a cycle recover the object.
//  K  > 8 : LT code with a robust-soliton degree distribution. Decoding is
//           incremental Gaussian elimination over GF(2) (maximum-likelihood),
//           which needs far less overhead than belief propagation at the
//           block counts we care about (tens to a few thousand).

import { hashInts, mulberry32, toUnit } from './prng.ts';

const SMALL_K = 8;
const cdfCache = new Map<number, Float64Array>();

function degreeCdf(K: number): Float64Array {
  let cdf = cdfCache.get(K);
  if (cdf) return cdf;
  const c = 0.1;
  const delta = 0.5;
  const R = c * Math.log(K / delta) * Math.sqrt(K);
  const spike = Math.max(1, Math.min(K, Math.round(K / R)));
  const p = new Float64Array(K + 1);
  let sum = 0;
  for (let d = 1; d <= K; d++) {
    let v = d === 1 ? 1 / K : 1 / (d * (d - 1));
    if (d < spike) v += R / (d * K);
    else if (d === spike) v += (R * Math.log(R / delta)) / K;
    p[d] = Math.max(v, 0);
    sum += p[d];
  }
  cdf = new Float64Array(K + 1);
  let acc = 0;
  for (let d = 1; d <= K; d++) {
    acc += p[d] / sum;
    cdf[d] = acc;
  }
  cdf[K] = 1;
  cdfCache.set(K, cdf);
  return cdf;
}

/** Source block indices combined into packet `seq`. Deterministic. */
export function packetNeighbors(K: number, session: number, seq: number): number[] {
  if (K <= SMALL_K) {
    const j = seq % (K + 1);
    if (j < K) return [j];
    return Array.from({ length: K }, (_, i) => i);
  }
  const rng = mulberry32(hashInts(K, session, seq));
  const cdf = degreeCdf(K);
  const u = toUnit(rng());
  let lo = 1;
  let hi = K;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cdf[mid] >= u) hi = mid;
    else lo = mid + 1;
  }
  const d = lo;
  const picked = new Set<number>();
  while (picked.size < d) picked.add(rng() % K);
  return [...picked];
}

export class FountainEncoder {
  readonly K: number;
  readonly blockSize: number;
  readonly session: number;
  private readonly blocks: Uint8Array[];

  constructor(object: Uint8Array, blockSize: number, session: number) {
    this.blockSize = blockSize;
    this.session = session & 0xff;
    this.K = Math.max(1, Math.ceil(object.length / blockSize));
    this.blocks = [];
    for (let i = 0; i < this.K; i++) {
      const b = new Uint8Array(blockSize);
      b.set(object.subarray(i * blockSize, Math.min(object.length, (i + 1) * blockSize)));
      this.blocks.push(b);
    }
  }

  packet(seq: number): Uint8Array {
    const out = new Uint8Array(this.blockSize);
    for (const idx of packetNeighbors(this.K, this.session, seq)) {
      const b = this.blocks[idx];
      for (let i = 0; i < out.length; i++) out[i] ^= b[i];
    }
    return out;
  }
}

interface Row {
  bits: Uint32Array;
  data: Uint8Array;
}

export class FountainDecoder {
  readonly K: number;
  readonly blockSize: number;
  readonly session: number;
  private readonly words: number;
  private readonly pivots: (Row | null)[];
  private rankCount = 0;
  private seen = new Set<number>();
  private solved: Uint8Array | null = null;
  received = 0;

  constructor(K: number, blockSize: number, session: number) {
    this.K = K;
    this.blockSize = blockSize;
    this.session = session;
    this.words = Math.ceil(K / 32);
    this.pivots = new Array(K).fill(null);
  }

  get rank(): number {
    return this.rankCount;
  }
  get done(): boolean {
    return this.rankCount === this.K;
  }
  get progress(): number {
    return this.rankCount / this.K;
  }

  /** Returns true when the packet added new information. */
  add(seq: number, payload: Uint8Array): boolean {
    if (this.done || this.seen.has(seq)) return false;
    this.seen.add(seq);
    this.received++;
    const bits = new Uint32Array(this.words);
    for (const idx of packetNeighbors(this.K, this.session, seq)) bits[idx >>> 5] ^= 1 << (idx & 31);
    const data = payload.slice(0, this.blockSize);

    for (let w = 0; w < this.words; w++) {
      while (bits[w] !== 0) {
        const bit = 31 - Math.clz32(bits[w] & -bits[w]);
        const col = (w << 5) + bit;
        const pivot = this.pivots[col];
        if (!pivot) {
          this.pivots[col] = { bits, data };
          this.rankCount++;
          return true;
        }
        for (let i = w; i < this.words; i++) bits[i] ^= pivot.bits[i];
        for (let i = 0; i < data.length; i++) data[i] ^= pivot.data[i];
      }
    }
    return false;
  }

  /** Concatenated source blocks, or null until rank K is reached. */
  result(): Uint8Array | null {
    if (!this.done) return null;
    if (this.solved) return this.solved;
    // Back-substitution: clear every bit above the diagonal.
    for (let col = this.K - 1; col >= 0; col--) {
      const src = this.pivots[col]!;
      const w = col >>> 5;
      const mask = 1 << (col & 31);
      for (let r = 0; r < col; r++) {
        const row = this.pivots[r]!;
        if (row.bits[w] & mask) {
          row.bits[w] ^= mask;
          for (let i = 0; i < row.data.length; i++) row.data[i] ^= src.data[i];
        }
      }
    }
    const out = new Uint8Array(this.K * this.blockSize);
    for (let i = 0; i < this.K; i++) out.set(this.pivots[i]!.data, i * this.blockSize);
    this.solved = out;
    return out;
  }
}
