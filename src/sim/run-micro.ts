// node src/sim/run-micro.ts
// Two small measurements quoted in DESIGN.md:
//  1. fountain-code overhead (packets needed / K) from a random start, with loss;
//  2. chance level of the pilot check: its score on pure noise.
import { FountainDecoder, FountainEncoder } from '../core/fountain.ts';
import { makeLayout } from '../core/layout.ts';
import { PRESETS } from '../core/presets.ts';
import { gaussian, mulberry32 } from '../core/prng.ts';
import { pilotCheck } from '../core/rx/demod.ts';

const rng = mulberry32(2024);
console.log('Fountain overhead: packets received before the object decodes, divided by K (30 % of packets dropped at random, 40 trials each)');
console.log('| K | mean | worst |');
console.log('|---|---|---|');
for (const K of [3, 12, 60, 300, 781, 2000]) {
  let sum = 0;
  let worst = 0;
  const trials = 40;
  for (let t = 0; t < trials; t++) {
    const obj = Uint8Array.from({ length: K * 8 }, () => rng() & 0xff);
    const enc = new FountainEncoder(obj, 8, t);
    const dec = new FountainDecoder(enc.K, 8, t);
    let seq = rng() & 0xffff;
    while (!dec.done) {
      seq = (seq + 1) & 0xffff;
      if (rng() % 100 < 30) continue;
      dec.add(seq, enc.packet(seq));
    }
    const o = dec.received / K;
    sum += o;
    worst = Math.max(worst, o);
  }
  console.log(`| ${K} | ${(sum / trials).toFixed(3)} | ${worst.toFixed(3)} |`);
}

console.log('\nPilot check on noise only (complex Gaussian cells, six windows, 200 trials)');
console.log('| grid | pilots | mean | 99th percentile | max |');
console.log('|---|---|---|---|---|');
const g = gaussian(mulberry32(99));
const seen = new Set<string>();
for (const p of PRESETS) {
  const key = `${p.cols}x${p.rows}/${p.carrierHz}`;
  if (seen.has(key)) continue;
  seen.add(key);
  const l = makeLayout(p);
  const scores: number[] = [];
  for (let t = 0; t < 200; t++) {
    const windows = Array.from({ length: 6 }, () => ({ zr: Float64Array.from({ length: l.nCells }, () => g()), zi: Float64Array.from({ length: l.nCells }, () => g()) }));
    scores.push(pilotCheck(l, windows).coherence);
  }
  scores.sort((a, b) => a - b);
  console.log(`| ${p.cols}×${p.rows} @ ${p.carrierHz} Hz | ${l.pilotCells.length} | ${(scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(2)} | ${scores[197].toFixed(2)} | ${scores[199].toFixed(2)} |`);
}
