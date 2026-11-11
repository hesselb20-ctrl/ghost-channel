// The landing page's hero picture is itself a live broadcast.

import { textPayload } from '../core/container.ts';
import { makeLayout } from '../core/layout.ts';
import { presetByKey } from '../core/presets.ts';
import { GhostSender } from '../send/sender.ts';
import { DemoSource } from '../send/sources.ts';

const MESSAGE = 'You are reading light. This message rode on the picture at the top of the Ghost Channel page, 20 times a second, in the blue channel.';

const canvas = document.getElementById('demoCanvas') as HTMLCanvasElement;
const fallback = document.getElementById('demoFallback')!;
const stats = document.getElementById('demoStats')!;

const fmtRate = (bps: number) => (bps >= 1000 ? `${(bps / 1000).toFixed(1)} kbps` : `${Math.round(bps)} bps`);
document.getElementById('fStandard')!.textContent = fmtRate(makeLayout(presetByKey('standard')).netBitsPerSecond);
document.getElementById('fDense')!.textContent = fmtRate(makeLayout(presetByKey('dense')).netBitsPerSecond);

try {
  const sender = new GhostSender(canvas);
  const preset = presetByKey('standard');
  sender.configure(preset, textPayload(MESSAGE));
  sender.setSource(new DemoSource('aurora'));
  sender.mod.amplitude = 0.03;
  sender.start();
  sender.onStats = (s) => {
    if (s.frames < 60) return;
    stats.textContent = `Standard preset, ${fmtRate(s.netBps)}, ${s.refreshHz.toFixed(0)} Hz display, ${s.dropped} dropped frames.`;
  };
  document.getElementById('demoGrid')!.addEventListener('change', (e) => {
    sender.showGrid = (e.target as HTMLInputElement).checked;
  });
  // Stop drawing while the tab is hidden; the browser pauses rAF anyway, this
  // just keeps the dropped-frame counter honest.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) sender.stop(true);
    else sender.start();
  });
} catch (e) {
  fallback.hidden = false;
  fallback.textContent = 'The live demo needs WebGL2, which this browser did not provide.';
  document.getElementById('demoBadge')!.hidden = true;
  console.warn(e);
}
