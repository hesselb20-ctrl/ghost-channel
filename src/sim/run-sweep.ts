// node src/sim/run-sweep.ts [group] [seeds]
// Sweep table: rows are presets x amplitude, columns are simulated camera
// conditions. Each cell: decoded?, raw (pre-FEC) bit error rate, delivered
// throughput. Results go to sim-out/sweep-<group>.md and .json.
//
// Every number here comes from the simulator, not from a phone.

import { mkdirSync, writeFileSync } from 'node:fs';
import { runTrial, type TrialConfig, type TrialResult } from './trial.ts';
import type { ContentKind } from './content.ts';

interface Row {
  name: string;
  cfg: Partial<TrialConfig> & { preset: string };
}
interface Col {
  name: string;
  cfg: Partial<TrialConfig>;
}

const HD = { w: 1280, h: 720 };
// Blur and noise are specified per pixel; at 1280x720 the same lens gives a
// wider blur in pixels and the unbinned pixels are noisier.
const hdCam = { ...HD, blurSigma: 1.3, noiseMid: 2.4, noiseRead: 1.6 };

const conditions: Col[] = [
  { name: '0.4 m head-on', cfg: {} },
  { name: '0.4 m, 30° off-axis', cfg: { camera: { yawDeg: 30 } } },
  { name: '1 m head-on (720p)', cfg: { camera: { ...hdCam, distance: 3.33 }, mapStep: 4 } },
  { name: '1 m, 30° (720p)', cfg: { camera: { ...hdCam, distance: 3.33, yawDeg: 30 }, mapStep: 4 } },
  { name: '2 m head-on (720p)', cfg: { camera: { ...hdCam, distance: 6.67 }, mapStep: 4 } },
  { name: 'handheld 3 px shake', cfg: { camera: { shakePx: 3 } } },
  { name: '1 m handheld (720p)', cfg: { camera: { ...hdCam, distance: 3.33, shakePx: 4 }, mapStep: 4 } },
  { name: '60 fps camera', cfg: { camera: { fps: 60, exposure: 1 / 120, readout: 0.012 } } },
  { name: '120 Hz display', cfg: { display: { refreshHz: 120 } } },
  { name: 'dim: 1/30 s exposure', cfg: { camera: { exposure: 1 / 30.5, noiseMid: 2.5 } } },
  { name: 'noise x2', cfg: { camera: { noiseMid: 3, noiseRead: 2 } } },
  { name: 'JPEG q60', cfg: { camera: { jpegQuality: 60 } } },
  { name: 'AE drift 10 % + 5 % drops', cfg: { camera: { aeAmp: 0.1, aePeriod: 1.3, dropProb: 0.05 }, display: { dropProb: 0.01 } } },
  { name: 'room light flicker 100 Hz', cfg: { camera: { ambientFlicker: 0.3, exposure: 1 / 250, background: 0.2 } } },
];

function rows(group: string): Row[] {
  const out: Row[] = [];
  const add = (preset: string, axis: 'chroma' | 'luma', amplitude: number) =>
    out.push({ name: `${preset} ${axis} ${(amplitude * 100).toFixed(1)}%`, cfg: { preset, mod: { axis, amplitude } } });
  if (group === 'main') {
    for (const preset of ['far', 'standard', 'dense']) {
      add(preset, 'luma', 0.08);
      add(preset, 'chroma', 0.04);
      add(preset, 'chroma', 0.02);
      add(preset, 'chroma', 0.01);
    }
  } else if (group === 'far' || group === 'standard' || group === 'dense') {
    // One preset per process, so the three can run side by side.
    add(group, 'luma', 0.08);
    add(group, 'chroma', 0.04);
    add(group, 'chroma', 0.02);
    add(group, 'chroma', 0.01);
  } else if (group === 'quick') {
    add('standard', 'chroma', 0.04);
    add('far', 'chroma', 0.02);
  }
  return out;
}

// Optional 5th argument: comma-separated column numbers (1-based) to run.
const onlyCols = process.argv[5] ? process.argv[5].split(',').map(Number) : null;
const group = process.argv[2] ?? 'main';
const seeds = Number(process.argv[3] ?? '1');
const content = (process.argv[4] ?? 'talking') as ContentKind;
const rowList = rows(group);
const results: { row: string; col: string; trials: TrialResult[] }[] = [];
const cell = (trials: TrialResult[]): string => {
  const ok = trials.filter((t) => t.decoded && t.payloadOk).length;
  const bers = trials.map((t) => t.trueBer).filter((b) => !Number.isNaN(b));
  const ber = bers.length ? bers.reduce((a, b) => a + b, 0) / bers.length : NaN;
  const bps = trials.reduce((a, t) => a + t.throughputBps, 0) / trials.length;
  const times = trials.filter((t) => t.tDecode !== null).map((t) => t.tDecode!);
  const time = times.length ? times.reduce((a, b) => a + b, 0) / times.length : NaN;
  if (ok === 0) return `fail (BER ${Number.isNaN(ber) ? 'n/a' : ber.toExponential(0)})`;
  return `${ok}/${trials.length} · ${time.toFixed(1)} s · BER ${ber < 1e-5 ? '0' : ber.toExponential(0)} · ${bps.toFixed(0)} bps`;
};

mkdirSync('sim-out', { recursive: true });
const t0 = performance.now();
const table: string[][] = [];
for (const row of rowList) {
  const line: string[] = [row.name];
  for (const [ci, col] of conditions.entries()) {
    if (onlyCols && !onlyCols.includes(ci + 1)) continue;
    const trials: TrialResult[] = [];
    for (let s = 0; s < seeds; s++) {
      const cfg: TrialConfig = {
        payloadBytes: 60,
        maxSeconds: 9,
        content,
        ...col.cfg,
        ...row.cfg,
        runFullDuration: false,
        seed: 21 + s * 17,
        mod: { ...(col.cfg.mod ?? {}), ...(row.cfg.mod ?? {}) },
        camera: { ...(col.cfg.camera ?? {}) },
        display: { ...(col.cfg.display ?? {}) },
      };
      trials.push(runTrial(cfg));
    }
    results.push({ row: row.name, col: col.name, trials });
    line.push(cell(trials));
    console.log(`[${((performance.now() - t0) / 1000).toFixed(0)}s] ${row.name} | ${col.name} | ${cell(trials)}`);
  }
  table.push(line);
  const md = [
    `Content: ${content}. Payload: 60 bytes. Each cell: trials decoded · mean time to decode · raw bit error rate before FEC · delivered bits per second. ${seeds} seed(s) per cell.`,
    '',
    '| preset, axis, amplitude | ' + conditions.map((c) => c.name).join(' | ') + ' |',
    '|' + '---|'.repeat(conditions.length + 1),
    ...table.map((l) => '| ' + l.join(' | ') + ' |'),
    '',
  ].join('\n');
  const tag = onlyCols ? `aa${group}` : group;
  writeFileSync(`sim-out/sweep-${tag}-${content}.md`, md);
  writeFileSync(`sim-out/sweep-${tag}-${content}.json`, JSON.stringify(results.map((r) => ({ row: r.row, col: r.col, trials: r.trials.map((t) => ({ ...t, events: undefined })) })), null, 1));
}
console.log('done');
