// node src/sim/run-extra.ts
// Individual simulator runs behind specific statements in the README:
// dark content, room-light flicker with and without manual corners, a real
// link (not a random blob) on each preset, and distance at higher resolution.

import { mkdirSync, writeFileSync } from 'node:fs';
import { urlPayload } from '../core/container.ts';
import { runTrial, type TrialConfig, type TrialResult } from './trial.ts';

const lines: string[] = [];
const out = (s: string) => {
  console.log(s);
  lines.push(s);
  mkdirSync('sim-out', { recursive: true });
  writeFileSync('sim-out/extra.md', lines.join('\n') + '\n');
};
const cell = (r: TrialResult) =>
  `${r.decoded && r.payloadOk ? 'yes' : 'no'} | ${r.tDecode === null ? '-' : r.tDecode.toFixed(1) + ' s'} | ${r.packetsOk} / ${r.packetsBad} | ${Number.isNaN(r.trueBer) ? '-' : r.trueBer.toExponential(1)} | ${r.detection ?? '-'}`;
const head = () => {
  out('| run | decoded | time | packets ok / failed | raw BER | locked via |');
  out('|---|---|---|---|---|---|');
};
const run = (name: string, cfg: TrialConfig) => out(`| ${name} | ${cell(runTrial({ maxSeconds: 9, seed: 31, payloadBytes: 60, ...cfg }))} |`);

const URL60 = 'https://example.org/events/2026/ghost-channel?seat=14C&ref=qr';
out(`### A ${URL60.length}-byte link, 0.4 m, colour axis`);
out('');
out('The sweep sends 60 random bytes as a file, which costs 46 bytes of name and type on top. A link of the same length is a smaller object and needs fewer packets.');
out('');
head();
for (const preset of ['far', 'standard', 'dense']) {
  for (const amplitude of [0.04, 0.02]) {
    for (const content of ['slide', 'talking'] as const) {
      run(`${preset}, ${content}, ${(amplitude * 100).toFixed(0)} %`, { preset, content, mod: { amplitude, axis: 'chroma' }, payload: urlPayload(URL60), payloadBytes: undefined });
    }
  }
}
out('');

out('### Dark cinematic content, standard preset, 0.4 m');
out('');
head();
run('colour 4 %', { preset: 'standard', content: 'dark', mod: { amplitude: 0.04, axis: 'chroma' } });
run('brightness 4 %', { preset: 'standard', content: 'dark', mod: { amplitude: 0.04, axis: 'luma' } });
run('colour 8 %', { preset: 'standard', content: 'dark', mod: { amplitude: 0.08, axis: 'chroma' } });
run('brightness 8 %', { preset: 'standard', content: 'dark', mod: { amplitude: 0.08, axis: 'luma' } });
run('colour 4 %, shadow boost 2 %', { preset: 'standard', content: 'dark', mod: { amplitude: 0.04, axis: 'chroma', floor: 0.02 } });
run('brightness 4 %, shadow boost 2 %', { preset: 'standard', content: 'dark', mod: { amplitude: 0.04, axis: 'luma', floor: 0.02 } });
run('colour 4 %, corners placed by hand (4 px error)', { preset: 'standard', content: 'dark', mod: { amplitude: 0.04, axis: 'chroma' }, manualCornersPx: 4 });
out('');

out('### Room light flickering at 100 Hz (30 % depth), 1/250 s exposure, standard preset, colour 4 %, talking-head content');
out('');
head();
const flick = { ambientFlicker: 0.3, exposure: 0.004 };
run('dim room (background 5 % of white)', { preset: 'standard', content: 'talking', mod: { amplitude: 0.04 }, camera: { ...flick, background: 0.05 } });
run('bright wall behind the screen (20 % of white)', { preset: 'standard', content: 'talking', mod: { amplitude: 0.04 }, camera: { ...flick, background: 0.2 } });
run('bright wall, corners placed by hand (4 px error)', { preset: 'standard', content: 'talking', mod: { amplitude: 0.04 }, camera: { ...flick, background: 0.2 }, manualCornersPx: 4 });
out('');

out('### 2 m with the far preset, brightness 8 %, talking-head content');
out('');
head();
const hd = { blurSigma: 1.3, noiseMid: 2.4, noiseRead: 1.6, distance: 6.67 };
run('1280×720 camera', { preset: 'far', content: 'talking', mod: { amplitude: 0.08, axis: 'luma' }, camera: { ...hd, w: 1280, h: 720 }, mapStep: 4 });
run('1920×1080 camera (blur σ 1.9 px, noise 3.5)', {
  preset: 'far',
  content: 'talking',
  mod: { amplitude: 0.08, axis: 'luma' },
  camera: { ...hd, w: 1920, h: 1080, blurSigma: 1.9, noiseMid: 3.5, noiseRead: 2.3 },
  mapStep: 6,
  maxSeconds: 7,
});
out('');

out('### Sender frame drops (simulated): standard preset, colour 4 %, slide content, 0.4 m');
out('');
head();
for (const dropProb of [0.01, 0.05, 0.15]) {
  run(`${(dropProb * 100).toFixed(0)} % of display frames repeated`, { preset: 'standard', content: 'slide', mod: { amplitude: 0.04 }, display: { dropProb }, payloadBytes: 600, maxSeconds: 14 });
}
