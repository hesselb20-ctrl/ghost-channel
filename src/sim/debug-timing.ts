import { DEFAULT_MOD } from '../core/modmath.ts';
import { Transmitter } from '../core/packet.ts';
import { presetByKey } from '../core/presets.ts';
import { rgbaToFrame } from '../core/rx/frame.ts';
import { Receiver } from '../core/rx/receiver.ts';
import { CameraSim, DEFAULT_CAMERA, DEFAULT_DISPLAY, DisplaySim } from './camera.ts';
import { randomPayload } from './trial.ts';
import type { ContentKind } from './content.ts';

const [presetKey = 'dense', content = 'slide', amp = '0.04', axis = 'chroma', seedS = '5'] = process.argv.slice(2);
const seed = Number(seedS);
const preset = presetByKey(presetKey);
const tx = new Transmitter(preset, randomPayload(60, seed + 99), seed & 0xff);
const mod = { ...DEFAULT_MOD, amplitude: Number(amp), axis: axis as 'luma' | 'chroma' };
const display = new DisplaySim(DEFAULT_DISPLAY, tx, mod, content as ContentKind, seed);
const cam = new CameraSim(DEFAULT_CAMERA, display, seed * 7919 + 13);
const rx = new Receiver({ onEvent: (m) => console.log('  rx:', m) });
for (let k = 0; k < 120; k++) {
  const f = cam.capture(k)!;
  rx.pushFrame(rgbaToFrame(f.rgba, DEFAULT_CAMERA.w, DEFAULT_CAMERA.h, f.t));
  if (k % 10 === 9) {
    for (const d of rx.debugDemods()) {
      const td = d.timingDebug;
      if (!td) continue;
      const Ts = d.Ts;
      const mod1 = (x: number) => ((x % Ts) + Ts) % Ts;
      console.log(`k=${k} ${d.preset.key} est=${(mod1(td.est) * 1000).toFixed(0)}ms tau=${(mod1(td.tau) * 1000).toFixed(0)}ms coh=${d.coherence.toFixed(2)} plane=${d.plane} orient=${d.orient} ok=${d.stats.packetsOk} bad=${d.stats.packetsBad}`);
      console.log('     scores', td.scores.map((v) => v.toFixed(1)).join(' '));
    }
    const st = rx.status();
    const q = st.quad;
    if (q) console.log('     quad', q.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' '), ' true', f.quad.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' '));
  }
}
