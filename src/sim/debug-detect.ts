import { DEFAULT_MOD } from '../core/modmath.ts';
import { Transmitter } from '../core/packet.ts';
import { presetByKey } from '../core/presets.ts';
import { rgbaToFrame } from '../core/rx/frame.ts';
import { Detector } from '../core/rx/detect.ts';
import { CameraSim, DEFAULT_CAMERA, DEFAULT_DISPLAY, DisplaySim } from './camera.ts';
import { randomPayload } from './trial.ts';
import type { ContentKind } from './content.ts';
import { invertH, squareToQuad, applyH } from '../core/homography.ts';

const [presetKey = 'standard', content = 'gray', amp = '0.04', axis = 'chroma'] = process.argv.slice(2);
const preset = presetByKey(presetKey);
const tx = new Transmitter(preset, randomPayload(60, 1), 1);
const mod = { ...DEFAULT_MOD, amplitude: Number(amp), axis: axis as 'luma' | 'chroma' };
const display = new DisplaySim(DEFAULT_DISPLAY, tx, mod, content as ContentKind, 1);
const cam = new CameraSim(DEFAULT_CAMERA, display, 99);
const det = new Detector(DEFAULT_CAMERA.w, DEFAULT_CAMERA.h);
let quad: any = null;
for (let k = 0; k < 30; k++) {
  const f = cam.capture(k)!;
  quad = f.quad;
  det.push(rgbaToFrame(f.rgba, DEFAULT_CAMERA.w, DEFAULT_CAMERA.h, f.t));
  if (det.ready && k % 2 === 0) {
    det.accumulate(preset.carrierHz);
    const found = det.find();
    const Hinv = invertH(squareToQuad(quad));
    let inS = 0, inN = 0, outS = 0, outN = 0, inMax = 0, outMax = 0;
    const r = det.ratio;
    for (let y = 0; y < det.mh; y++) for (let x = 0; x < det.mw; x++) {
      const p = applyH(Hinv, x * 2 + 0.5, y * 2 + 0.5);
      const inside = p.x > 0.05 && p.x < 0.95 && p.y > 0.05 && p.y < 0.95;
      const v = r[y * det.mw + x];
      if (inside) { inS += v; inN++; inMax = Math.max(inMax, v); } else if (p.x < -0.05 || p.x > 1.05 || p.y < -0.05 || p.y > 1.05) { outS += v; outN++; outMax = Math.max(outMax, v); }
    }
    console.log(`k=${k} found=${found.map((d) => d.kind + ':' + d.plane).join(',') || 'none'} ratio in=${(inS / inN).toFixed(2)} (max ${inMax.toFixed(1)}) out=${(outS / outN).toFixed(2)} (max ${outMax.toFixed(1)})`);
    for (const d of found) console.log('    ', d.kind, d.quad.map((p) => `${p.x.toFixed(0)},${p.y.toFixed(0)}`).join(' '), ' true', quad.map((p: any) => `${p.x.toFixed(0)},${p.y.toFixed(0)}`).join(' '));
  }
}
{
  const y = Math.floor(det.mh / 2);
  let line = '';
  for (let x = 40; x < 280; x += 4) line += det.ratio[y * det.mw + x].toFixed(1) + ' ';
  console.log('mid row ratio (map x=40..280 step 4; true edges at ' + (quad[0].x / 2).toFixed(0) + ' and ' + (quad[1].x / 2).toFixed(0) + '):\n' + line);
  const x = Math.floor(det.mw / 2);
  line = '';
  for (let yy = 20; yy < 160; yy += 4) line += det.ratio[yy * det.mw + x].toFixed(1) + ' ';
  console.log('mid col ratio (map y=20..160 step 4; true edges at ' + (quad[0].y / 2).toFixed(0) + ' and ' + (quad[3].y / 2).toFixed(0) + '):\n' + line);
}

{
  let x0 = 1e9, x1 = -1, y0 = 1e9, y1 = -1, n = 0;
  const rowsW: string[] = [];
  for (let y = 0; y < det.mh; y++) {
    let lo = -1, hi = -1;
    for (let x = 0; x < det.mw; x++) if (det.ratio[y * det.mw + x] > det.lastCut) { if (lo < 0) lo = x; hi = x; n++; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    if (y % 10 === 0) rowsW.push(y + ':' + lo + '-' + hi);
  }
  console.log('cut', det.lastCut.toFixed(2), 'mask bbox (map px)', x0, x1, y0, y1, 'area', n, 'rows', rowsW.join(' '));
}
