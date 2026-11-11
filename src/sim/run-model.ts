// node src/sim/run-model.ts
// Prints the analytic carrier table, then confirms it with the pixel
// simulator and the real decoder for a few carrier choices.

import { writeFileSync, mkdirSync } from 'node:fs';
import { presetByKey, type Preset } from '../core/presets.ts';
import { analyseCarrier, nullBandFraction } from './model.ts';
import { runTrial } from './trial.ts';

const lines: string[] = [];
const out = (s = '') => {
  console.log(s);
  lines.push(s);
};

out('## Analytic model: where does the carrier land, and how much of it is left?');
out();
out('| display | carrier | camera | exposure | alias | hold gain | exposure gain | total gain | verdict |');
out('|---|---|---|---|---|---|---|---|---|');
const cases: [number, number, number, number][] = [];
for (const fps of [30, 60]) {
  for (const exp of [1 / 250, 1 / 100, 1 / 60, 1 / 30]) {
    if (exp > 1 / fps + 1e-9) continue;
    for (const [refresh, carrier] of [
      [60, 30],
      [60, 20],
      [60, 15],
      [60, 10],
      [120, 60],
      [120, 40],
      [120, 20],
    ]) {
      cases.push([refresh, carrier, fps, exp]);
    }
  }
}
for (const [refresh, carrier, fps, exp] of cases) {
  const a = analyseCarrier(refresh, carrier, fps, exp);
  out(
    `| ${refresh} Hz | ${carrier} Hz | ${fps} fps | 1/${Math.round(1 / exp)} s | ${a.aliasHz.toFixed(0)} Hz | ${a.holdGain.toFixed(2)} | ${a.exposureGain.toFixed(2)} | ${a.gain.toFixed(2)} | ${a.usable ? 'usable' : a.why} |`,
  );
}
out();
out('## Complementary pairs seen at half the refresh rate: stationary null bands');
out();
out('A 30 Hz square carrier (+d, -d on a 60 Hz display) aliases to 0 Hz on a 30 fps camera. What each sensor row sees is a constant that depends on where its exposure falls in the pair. Fraction of rows left with less than 30 % of the peak signal:');
out();
out('| exposure | rows below 30 % | peak amplitude left |');
out('|---|---|---|');
for (const exp of [1 / 250, 1 / 120, 1 / 60, 1 / 40, 1 / 30]) {
  const nb = nullBandFraction(30, exp, 0.3);
  out(`| 1/${Math.round(1 / exp)} s | ${(nb.fraction * 100).toFixed(0)} % | ${nb.peak.toFixed(2)} |`);
}
out();

out('## Simulator check: same grid and amplitude, different carriers');
out();
out('16x9 grid, 200 ms symbols, chroma axis at 4 %, grey content, 0.4 m, 30 fps camera. Real transmitter and real receiver.');
out();
out('| carrier | exposure | decoded | time | packets ok | raw BER |');
out('|---|---|---|---|---|---|');
const base = presetByKey('standard');
for (const carrierHz of [30, 25, 20, 15, 10]) {
  for (const exposure of [1 / 100, 1 / 40]) {
    const p: Preset = { ...base, key: `c${carrierHz}`, carrierHz, cyclesPerSymbol: carrierHz / 5 };
    const r = runTrial({ preset: p, content: 'gray', mod: { amplitude: 0.04, axis: 'chroma' }, camera: { exposure }, payloadBytes: 60, maxSeconds: 6, seed: 11 });
    out(
      `| ${carrierHz} Hz | 1/${Math.round(1 / exposure)} s | ${r.decoded ? 'yes' : 'no'} | ${r.tDecode === null ? '-' : r.tDecode.toFixed(1) + ' s'} | ${r.packetsOk}/${r.packetsOk + r.packetsBad} | ${Number.isNaN(r.trueBer) ? '-' : r.trueBer.toExponential(1)} |`,
    );
  }
}
mkdirSync('sim-out', { recursive: true });
writeFileSync('sim-out/model.md', lines.join('\n') + '\n');
