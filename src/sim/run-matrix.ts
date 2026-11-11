// Exploratory matrix: node src/sim/run-matrix.ts [presets] [contents] [axes] [amplitude] [extra-json]
import { fmt, runTrial, type TrialConfig } from './trial.ts';
import type { ContentKind } from './content.ts';

const args = process.argv.slice(2);
const presets = (args[0] ?? 'far,standard,dense').split(',');
const contents = (args[1] ?? 'gray,slide,talking,dark,noise').split(',') as ContentKind[];
const axes = (args[2] ?? 'chroma,luma').split(',') as ('chroma' | 'luma')[];
const amp = Number(args[3] ?? '0.04');
const extra: Partial<TrialConfig> = args[4] ? JSON.parse(args[4]) : {};
for (const preset of presets) {
  for (const content of contents) {
    for (const axis of axes) {
      const cfg: TrialConfig = {
        preset,
        content,
        payloadBytes: 60,
        maxSeconds: preset === 'export' ? 24 : 8,
        seed: 5,
        ...extra,
        mod: { amplitude: amp, axis, ...(extra.mod ?? {}) },
        display: { ...(preset === 'hfr' ? { refreshHz: 120 } : {}), ...(extra.display ?? {}) },
      };
      const t0 = performance.now();
      const r = runTrial(cfg);
      console.log(`${preset.padEnd(8)} ${content.padEnd(7)} ${axis.padEnd(6)}`, fmt(r), `[${((performance.now() - t0) / 1000).toFixed(0)}s] ${r.detection ?? ''} tries=${r.lockAttempts}`);
    }
  }
}
