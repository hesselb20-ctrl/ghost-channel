// node src/sim/run-join.ts [preset] [bytes] [trials]
// Join-anytime: a file is broadcast on a loop; the receiver starts at a
// random moment (random symbol phase, random packet, random point in the
// fountain sequence) and we time how long it needs to recover every byte.

import { mkdirSync, writeFileSync } from 'node:fs';
import { makeLayout } from '../core/layout.ts';
import { presetByKey } from '../core/presets.ts';
import { runTrial } from './trial.ts';

const presetKey = process.argv[2] ?? 'dense';
const bytes = Number(process.argv[3] ?? 32 * 1024);
const trials = Number(process.argv[4] ?? 2);
const amplitude = Number(process.argv[5] ?? 0.04);
const layout = makeLayout(presetByKey(presetKey));
const K = Math.ceil((bytes + 40) / layout.blockSize);
const ideal = K * layout.packetSeconds;
const lines: string[] = [];
const out = (s: string) => {
  console.log(s);
  lines.push(s);
};
out(`Preset ${presetKey}: ${bytes} bytes = ${K} blocks of ${layout.blockSize} B, one packet every ${layout.packetSeconds.toFixed(2)} s.`);
out(`A lossless receiver that needed exactly K packets would take ${ideal.toFixed(0)} s.`);
out('');
out('| trial | decoded | bytes correct | time to full file | packets ok / failed | overhead vs K | raw BER | delivered rate |');
out('|---|---|---|---|---|---|---|---|');
for (let i = 0; i < trials; i++) {
  const t0 = performance.now();
  const r = runTrial({
    preset: presetKey,
    content: 'talking',
    mod: { amplitude, axis: 'chroma' },
    payloadBytes: bytes,
    maxSeconds: ideal * 1.6 + 20,
    // The camera's start offset and the fountain session both derive from the seed.
    seed: 101 + i * 37,
  });
  out(
    `| ${i + 1} | ${r.decoded ? 'yes' : 'no'} | ${r.payloadOk ? 'all' : 'no'} | ${r.tDecode === null ? '-' : r.tDecode.toFixed(1) + ' s'} | ${r.packetsOk} / ${r.packetsBad} | ${(r.packetsOk / K).toFixed(3)} | ${Number.isNaN(r.trueBer) ? '-' : r.trueBer.toExponential(1)} | ${r.throughputBps.toFixed(0)} bps |`,
  );
  console.error(`   (trial ${i + 1} took ${((performance.now() - t0) / 1000).toFixed(0)} s of wall time)`);
  mkdirSync('sim-out', { recursive: true });
  writeFileSync(`sim-out/join-${presetKey}-${bytes}.md`, lines.join('\n') + '\n');
}
