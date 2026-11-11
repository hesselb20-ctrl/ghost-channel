import { describe, expect, it } from 'vitest';
import { crc32 } from '../src/core/crc32.ts';
import { rsDecode, rsEncode } from '../src/core/rs.ts';
import { FountainDecoder, FountainEncoder, packetNeighbors } from '../src/core/fountain.ts';
import { packContainer, textPayload, unpackContainer, urlPayload } from '../src/core/container.ts';
import { makeLayout, rotationQ } from '../src/core/layout.ts';
import { bytesToCellQ, cellQToBytes, decodePacketBytes, encodePacketBytes, Transmitter } from '../src/core/packet.ts';
import { PRESETS, PROTOCOL_VERSION } from '../src/core/presets.ts';
import { mulberry32 } from '../src/core/prng.ts';
import { carrier, pattern1, pixelDelta, symbolAt, DEFAULT_MOD, LUM_B, LUM_G, LUM_R } from '../src/core/modmath.ts';
import { applyH, invertH, squareToQuad, type Quad } from '../src/core/homography.ts';
import { carrierFit } from '../src/core/rx/frame.ts';

const enc = new TextEncoder();

describe('crc32', () => {
  it('matches the standard check value', () => {
    expect(crc32(enc.encode('123456789'))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array(0))).toBe(0);
  });
});

describe('reed-solomon', () => {
  const rng = mulberry32(42);
  const rand = (n: number) => Uint8Array.from({ length: n }, () => rng() & 0xff);

  it('round-trips clean codewords', () => {
    for (const [k, p] of [[10, 4], [44, 28], [200, 55], [1, 2]]) {
      const data = rand(k);
      const cw = rsEncode(data, p);
      expect(cw.length).toBe(k + p);
      expect(rsDecode(cw, p).ok).toBe(true);
      expect(cw.subarray(0, k)).toEqual(data);
    }
  });

  it('corrects up to parity/2 errors at random positions', () => {
    for (let trial = 0; trial < 300; trial++) {
      const k = 5 + (rng() % 180);
      const p = 2 * (1 + (rng() % 24));
      const data = rand(k);
      const cw = rsEncode(data, p);
      const nErr = rng() % (p / 2 + 1);
      const pos = new Set<number>();
      while (pos.size < nErr) pos.add(rng() % cw.length);
      for (const i of pos) cw[i] ^= 1 + (rng() % 255);
      const res = rsDecode(cw, p);
      expect(res.ok).toBe(true);
      expect(res.corrected).toBe(nErr);
      expect(cw.subarray(0, k)).toEqual(data);
    }
  });

  it('corrects errors plus erasures while 2e + f <= parity', () => {
    for (let trial = 0; trial < 300; trial++) {
      const k = 5 + (rng() % 150);
      const p = 2 * (2 + (rng() % 20));
      const data = rand(k);
      const cw = rsEncode(data, p);
      const f = rng() % (p + 1);
      const e = rng() % (Math.floor((p - f) / 2) + 1);
      const pos = new Set<number>();
      while (pos.size < f + e) pos.add(rng() % cw.length);
      const all = [...pos];
      const erasures = all.slice(0, f);
      for (const i of all) cw[i] ^= 1 + (rng() % 255);
      // Half of the erased positions happen to hold the right value.
      const orig = rsEncode(data, p);
      for (let j = 0; j < erasures.length; j += 2) cw[erasures[j]] = orig[erasures[j]];
      expect(rsDecode(cw, p, erasures).ok).toBe(true);
      expect(cw.subarray(0, k)).toEqual(data);
    }
  });

  it('never returns wrong data silently when overloaded (flagged or caught by re-check)', () => {
    let silentlyWrong = 0;
    for (let trial = 0; trial < 300; trial++) {
      const data = rand(40);
      const p = 8;
      const cw = rsEncode(data, p);
      const pos = new Set<number>();
      while (pos.size < 7) pos.add(rng() % cw.length);
      for (const i of pos) cw[i] ^= 1 + (rng() % 255);
      const res = rsDecode(cw, p);
      // A miscorrection to another valid codeword is possible in principle; the
      // packet CRC exists for that. It must stay rare.
      if (res.ok && !cw.subarray(0, 40).every((b, i) => b === data[i])) silentlyWrong++;
    }
    expect(silentlyWrong).toBeLessThan(3);
  });
});

describe('fountain', () => {
  const rng = mulberry32(7);
  const rand = (n: number) => Uint8Array.from({ length: n }, () => rng() & 0xff);

  it('derives the same neighbours on both sides', () => {
    expect(packetNeighbors(500, 3, 1234)).toEqual(packetNeighbors(500, 3, 1234));
    expect(packetNeighbors(500, 3, 1234)).not.toEqual(packetNeighbors(500, 4, 1234));
  });

  it('small objects decode from any K of K+1 consecutive packets', () => {
    for (let K = 1; K <= 8; K++) {
      const obj = rand(K * 20 - 3);
      const encd = new FountainEncoder(obj, 20, 9);
      expect(encd.K).toBe(K);
      for (let skip = 0; skip <= K; skip++) {
        const dec = new FountainDecoder(K, 20, 9);
        const start = 100 + skip * 3;
        for (let s = start; s < start + K + 1; s++) {
          if ((s - start) === skip) continue;
          dec.add(s, encd.packet(s));
        }
        expect(dec.done).toBe(true);
        expect(dec.result()!.subarray(0, obj.length)).toEqual(obj);
      }
    }
  });

  it('large objects decode from a random start with small overhead, despite loss', () => {
    const overheads: number[] = [];
    for (const K of [12, 60, 300, 900]) {
      for (let trial = 0; trial < 4; trial++) {
        const obj = rand(K * 38);
        const encd = new FountainEncoder(obj, 38, trial);
        const dec = new FountainDecoder(encd.K, 38, trial);
        let seq = rng() % 60000;
        let sent = 0;
        while (!dec.done && sent < K * 3) {
          seq = (seq + 1) & 0xffff;
          sent++;
          if (rng() % 100 < 30) continue; // 30 % packet loss
          dec.add(seq, encd.packet(seq));
        }
        expect(dec.done).toBe(true);
        expect(dec.result()!.subarray(0, obj.length)).toEqual(obj);
        overheads.push(dec.received / K);
      }
    }
    const mean = overheads.reduce((a, b) => a + b, 0) / overheads.length;
    // Received packets needed, relative to K. ML decoding keeps this low.
    expect(mean).toBeLessThan(1.25);
  });
});

describe('container', () => {
  it('round-trips text, url and file, with padding', () => {
    for (const p of [textPayload('héllo ✓'), urlPayload('https://example.org/a?b=c'), { type: 'file' as const, data: new Uint8Array([1, 2, 3, 0, 255]), name: 'a.bin', mime: 'x/y' }]) {
      const packed = packContainer(p);
      const padded = new Uint8Array(packed.length + 37);
      padded.set(packed);
      const back = unpackContainer(padded)!;
      expect(back.type).toBe(p.type);
      expect(back.data).toEqual(p.data);
      if (p.type === 'file') {
        expect(back.name).toBe('a.bin');
        expect(back.mime).toBe('x/y');
      }
    }
  });
  it('rejects corruption', () => {
    const packed = packContainer(textPayload('hello world'));
    packed[8] ^= 4;
    expect(unpackContainer(packed)).toBeNull();
  });
});

describe('layout and packets', () => {
  it('every preset has a sane geometry', () => {
    for (const p of PRESETS) {
      const l = makeLayout(p);
      expect(l.pilotCells.length).toBeGreaterThanOrEqual(8);
      expect(l.pilotCells.length + l.dataCells.length).toBe(l.nCells);
      expect(l.blockSize).toBeGreaterThanOrEqual(8);
      expect(l.codewords.reduce((a, c) => a + c.len, 0)).toBe(l.packetBytes);
      for (const c of l.codewords) expect(c.len).toBeLessThanOrEqual(255);
      // Pilot pattern must not map onto itself under a 180 degree turn, or the
      // receiver could not tell which way up the screen is.
      let same = 0;
      for (const c of l.pilotCells) if (l.isPilot[l.nCells - 1 - c] && l.pilotQ[l.nCells - 1 - c] === l.pilotQ[c]) same++;
      expect(same).toBeLessThan(l.pilotCells.length * 0.5);
    }
  });

  it('rotation advances 90 degrees per symbol and 180 at packet starts', () => {
    for (const S of [1, 2, 4, 6]) {
      for (let i = 1; i < 40; i++) {
        const adv = (rotationQ(i, S) - rotationQ(i - 1, S)) & 3;
        expect(adv).toBe(i % S === 0 ? 2 : 1);
      }
    }
  });

  it('packets survive byte errors up to the RS budget and reject beyond it', () => {
    const rng = mulberry32(5);
    for (const p of PRESETS) {
      const l = makeLayout(p);
      const block = Uint8Array.from({ length: l.blockSize }, () => rng() & 0xff);
      const header = { version: PROTOCOL_VERSION, presetId: p.id, session: 77, K: 321, seq: 54321 };
      const coded = encodePacketBytes(l, header, block);
      expect(coded.length).toBe(l.packetBytes);
      const cells = bytesToCellQ(l, coded);
      expect(cells.length).toBe(p.symbolsPerPacket);
      const { bytes } = cellQToBytes(l, cells);
      expect(bytes).toEqual(coded);

      const budget = Math.floor(Math.min(...l.codewords.map((c) => c.parity)) / 2);
      const hit = bytes.slice();
      const pos = new Set<number>();
      // Spread errors so that no codeword gets more than its budget.
      while (pos.size < budget) pos.add((rng() % Math.floor(l.packetBytes / l.codewords.length)) * l.codewords.length);
      for (const i of pos) hit[i] ^= 0x5a;
      const dec = decodePacketBytes(l, hit)!;
      expect(dec).not.toBeNull();
      expect(dec.header).toEqual(header);
      expect(dec.block).toEqual(block);

      const wrecked = bytes.slice();
      for (let i = 0; i < wrecked.length; i += 2) wrecked[i] ^= 0xff;
      expect(decodePacketBytes(l, wrecked)).toBeNull();
    }
  });

  it('erasure hints extend what a packet survives', () => {
    const rng = mulberry32(11);
    const l = makeLayout(PRESETS[1]);
    const block = Uint8Array.from({ length: l.blockSize }, () => rng() & 0xff);
    const header = { version: PROTOCOL_VERSION, presetId: 1, session: 1, K: 5, seq: 9 };
    const coded = encodePacketBytes(l, header, block);
    const parity = l.codewords[0].parity;
    const nBad = Math.floor(parity * 0.8); // more than parity/2: needs erasures
    const hit = coded.slice();
    const rel = new Float32Array(coded.length).fill(10);
    const pos = new Set<number>();
    while (pos.size < nBad) pos.add(rng() % coded.length);
    for (const i of pos) {
      hit[i] ^= 0x33;
      rel[i] = 0.1;
    }
    expect(decodePacketBytes(l, hit)).toBeNull();
    const dec = decodePacketBytes(l, hit, rel)!;
    expect(dec).not.toBeNull();
    expect(dec.block).toEqual(block);
  });

  it('transmitter -> perfect channel -> fountain decoder recovers a file', () => {
    const rng = mulberry32(3);
    for (const p of PRESETS) {
      const l = makeLayout(p);
      const data = Uint8Array.from({ length: 1500 }, () => rng() & 0xff);
      const tx = new Transmitter(p, { type: 'file', data, name: 'f', mime: 'm' }, 200);
      let dec: FountainDecoder | null = null;
      const S = p.symbolsPerPacket;
      const start = 37 * S; // join mid-stream
      for (let pk = 0; pk < 4000 && !(dec && dec.done); pk++) {
        const syms: Uint8Array[] = [];
        for (let s = 0; s < S; s++) {
          const i = start + pk * S + s;
          const cells = tx.symbolCells(i);
          const rot = rotationQ(i, S);
          syms.push(Uint8Array.from(l.dataCells, (c) => (cells[c] - rot) & 3));
          for (const c of l.pilotCells) expect((cells[c] - rot) & 3).toBe(l.pilotQ[c]);
        }
        const got = decodePacketBytes(l, cellQToBytes(l, syms).bytes)!;
        expect(got).not.toBeNull();
        dec ??= new FountainDecoder(got.header.K, l.blockSize, got.header.session);
        dec.add(got.header.seq, got.block);
      }
      expect(dec!.done).toBe(true);
      const payload = unpackContainer(dec!.result()!)!;
      expect(payload.data).toEqual(data);
    }
  });
});

describe('modulation maths', () => {
  it('every carrier cycle sums to zero on a 60 Hz display', () => {
    for (const p of PRESETS.filter((x) => 60 % x.carrierHz === 0)) {
      const framesPerCycle = 60 / p.carrierHz;
      for (let q = 0; q < 4; q++) {
        for (let cyc = 0; cyc < 12; cyc++) {
          let sum = 0;
          for (let f = 0; f < framesPerCycle; f++) {
            const t = (cyc * framesPerCycle + f) / 60;
            sum += symbolAt(t, p, 0.6).env * carrier(t, p.carrierHz, q);
          }
          expect(Math.abs(sum)).toBeLessThan(1e-9);
        }
      }
    }
  });

  it('the in-cell pattern is balanced and vanishes on cell borders', () => {
    let sum = 0;
    const n = 1000;
    for (let i = 0; i < n; i++) sum += pattern1((i + 0.5) / n, 0.5);
    expect(Math.abs(sum / n)).toBeLessThan(1e-9);
    expect(Math.abs(pattern1(0, 0.5))).toBeLessThan(1e-9);
    expect(Math.abs(pattern1(0.5, 0.5))).toBeLessThan(1e-9);
    expect(pattern1(0.25, 0.5)).toBeCloseTo(1);
    expect(pattern1(0.75, 0.5)).toBeCloseTo(-1);
  });

  it('chroma modulation leaves luminance untouched and never clips', () => {
    const rng = mulberry32(8);
    const d = { dr: 0, dg: 0, db: 0 };
    for (let i = 0; i < 2000; i++) {
      const r = (rng() % 1001) / 1000;
      const g = (rng() % 1001) / 1000;
      const b = (rng() % 1001) / 1000;
      pixelDelta(r, g, b, { ...DEFAULT_MOD, axis: 'chroma', amplitude: 0.1 }, d);
      // Luminance is preserved wherever the excursion was not limited by headroom.
      const dY = LUM_R * d.dr + LUM_G * d.dg + LUM_B * d.db;
      expect(Math.abs(dY)).toBeLessThan(1e-9);
      for (const [c, dc] of [[r, d.dr], [g, d.dg], [b, d.db]]) {
        expect(c + dc).toBeGreaterThanOrEqual(-1e-9);
        expect(c - dc).toBeGreaterThanOrEqual(-1e-9);
        expect(c + dc).toBeLessThanOrEqual(1 + 1e-9);
        expect(c - dc).toBeLessThanOrEqual(1 + 1e-9);
      }
    }
  });
});

describe('geometry and fitting', () => {
  it('homography maps the unit square to the quad and inverts', () => {
    const q: Quad = [{ x: 10, y: 20 }, { x: 300, y: 35 }, { x: 280, y: 190 }, { x: 25, y: 170 }];
    const H = squareToQuad(q);
    const corners = [[0, 0], [1, 0], [1, 1], [0, 1]];
    corners.forEach(([u, v], i) => {
      const p = applyH(H, u, v);
      expect(p.x).toBeCloseTo(q[i].x, 6);
      expect(p.y).toBeCloseTo(q[i].y, 6);
    });
    const inv = invertH(H);
    const p = applyH(H, 0.3, 0.7);
    const back = applyH(inv, p.x, p.y);
    expect(back.x).toBeCloseTo(0.3, 6);
    expect(back.y).toBeCloseTo(0.7, 6);
  });

  it('carrier fit recovers amplitude and phase from uneven samples and ignores DC', () => {
    const rng = mulberry32(2);
    for (let trial = 0; trial < 50; trial++) {
      const f = 20;
      const amp = 1 + (rng() % 100) / 50;
      const phase = ((rng() % 628) / 100) - 3.14;
      const dc = (rng() % 200) - 100;
      const times = Array.from({ length: 5 }, (_, k) => 3.2 + k / 30 + ((rng() % 100) - 50) * 4e-5);
      const x = times.map((t) => dc + amp * Math.cos(2 * Math.PI * f * t + phase));
      const fit = carrierFit(times, f);
      expect(fit.ok).toBe(true);
      let zr = 0;
      let zi = 0;
      for (let k = 0; k < x.length; k++) {
        zr += fit.wr[k] * x[k];
        zi += fit.wi[k] * x[k];
      }
      expect(Math.hypot(zr, zi)).toBeCloseTo(amp, 6);
      expect(Math.cos(Math.atan2(zi, zr) - phase)).toBeCloseTo(1, 6);
    }
  });

  it('carrier fit refuses a carrier that aliases onto DC', () => {
    const times = Array.from({ length: 6 }, (_, k) => k / 30);
    expect(carrierFit(times, 30).ok).toBe(false);
    expect(carrierFit(times, 20).ok).toBe(true);
  });
});
