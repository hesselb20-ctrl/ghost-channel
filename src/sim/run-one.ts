// Quick single trial: node src/sim/run-one.ts [preset] [content] [amplitude] [axis]
import { fmt, runTrial } from './trial.ts';
import type { ContentKind } from './content.ts';

const [preset = 'standard', content = 'gray', amp = '0.04', axis = 'chroma'] = process.argv.slice(2);
const t0 = performance.now();
const r = runTrial({
  preset,
  content: content as ContentKind,
  mod: { amplitude: Number(amp), axis: axis as 'luma' | 'chroma' },
  payloadBytes: 60,
  maxSeconds: 8,
  verbose: true,
  seed: 3,
});
console.log(fmt(r));
console.log(`wall ${((performance.now() - t0) / 1000).toFixed(1)} s for ${r.seconds.toFixed(1)} s of camera time`);
