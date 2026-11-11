// node src/sim/run-codec.ts
// What does real video compression do to the signal?
//
// Sender frames are rendered with the CPU reference renderer, written as raw
// video, compressed with ffmpeg (x264 and VP9 at several qualities), decoded
// back to raw frames, and handed to the real receiver as if a perfect camera
// had filmed a perfect screen. Only the codec stands between sender and
// receiver, so the numbers isolate its effect. Requires ffmpeg on PATH.

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { textPayload } from '../core/container.ts';
import { makeLayout } from '../core/layout.ts';
import { DEFAULT_MOD, renderFrame, symbolAt, type ModParams } from '../core/modmath.ts';
import { Transmitter } from '../core/packet.ts';
import { presetByKey } from '../core/presets.ts';
import { rgbaToFrame } from '../core/rx/frame.ts';
import { Receiver } from '../core/rx/receiver.ts';
import { renderContent, type ContentKind } from './content.ts';

const W = 640;
const H = 360;
const SECONDS = 20;
const dir = 'sim-out/codec';
mkdirSync(dir, { recursive: true });

interface Case {
  preset: string;
  axis: 'luma' | 'chroma';
  amplitude: number;
  fps: number;
  content: ContentKind;
}
interface Codec {
  name: string;
  ext: string;
  args: string[];
}

const codecs: Codec[] = [
  { name: 'none (raw frames)', ext: '', args: [] },
  { name: 'H.264 CRF 18', ext: 'mp4', args: ['-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p'] },
  { name: 'H.264 CRF 23', ext: 'mp4', args: ['-c:v', 'libx264', '-preset', 'medium', '-crf', '23', '-pix_fmt', 'yuv420p'] },
  { name: 'H.264 CRF 28', ext: 'mp4', args: ['-c:v', 'libx264', '-preset', 'medium', '-crf', '28', '-pix_fmt', 'yuv420p'] },
  { name: 'VP9 CRF 32', ext: 'webm', args: ['-c:v', 'libvpx-vp9', '-crf', '32', '-b:v', '0', '-deadline', 'good', '-cpu-used', '4', '-pix_fmt', 'yuv420p'] },
];

const cases: Case[] = [
  { preset: 'export', axis: 'luma', amplitude: 0.08, fps: 30, content: 'talking' },
  { preset: 'export', axis: 'luma', amplitude: 0.04, fps: 30, content: 'talking' },
  { preset: 'export', axis: 'chroma', amplitude: 0.08, fps: 30, content: 'talking' },
  { preset: 'far', axis: 'luma', amplitude: 0.08, fps: 60, content: 'talking' },
  { preset: 'standard', axis: 'chroma', amplitude: 0.04, fps: 60, content: 'talking' },
  { preset: 'standard', axis: 'luma', amplitude: 0.08, fps: 60, content: 'talking' },
];

const MESSAGE = 'https://example.org/ghost-channel/exported-video-test';

function renderRaw(c: Case, path: string): void {
  const preset = presetByKey(c.preset);
  const tx = new Transmitter(preset, textPayload(MESSAGE), 77);
  const mod: ModParams = { ...DEFAULT_MOD, axis: c.axis, amplitude: c.amplitude };
  const content = new Uint8Array(W * H * 3);
  const frame = new Uint8Array(W * H * 3);
  const n = SECONDS * c.fps;
  const all = new Uint8Array(n * W * H * 3);
  for (let i = 0; i < n; i++) {
    const t = i / c.fps;
    renderContent(c.content, W, H, t, content);
    const pos = symbolAt(t, preset, mod.edgeGain);
    renderFrame({ width: W, height: H, content, contentChannels: 3, preset, cells: tx.symbolCells(pos.index), t, env: pos.env, frameIndex: i, mod }, frame);
    all.set(frame, i * W * H * 3);
  }
  writeFileSync(path, all);
}

function decode(rawPath: string, c: Case): { ok: boolean; time: number | null; pkOk: number; pkBad: number; ber: number } {
  const raw = readFileSync(rawPath);
  const frameBytes = W * H * 3;
  const n = Math.floor(raw.length / frameBytes);
  const rx = new Receiver({ presets: [presetByKey(c.preset)] });
  // The picture fills the frame: tell the receiver so, as a user would by
  // dragging the corners, and let it refine from there.
  rx.setManualQuad([{ x: 0, y: 0 }, { x: W, y: 0 }, { x: W, y: H }, { x: 0, y: H }]);
  const rgba = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < n; i++) {
    const f = raw.subarray(i * frameBytes, (i + 1) * frameBytes);
    for (let p = 0, q = 0; p < frameBytes; p += 3, q += 4) {
      rgba[q] = f[p];
      rgba[q + 1] = f[p + 1];
      rgba[q + 2] = f[p + 2];
      rgba[q + 3] = 255;
    }
    rx.pushFrame(rgbaToFrame(rgba, W, H, i / c.fps));
    if (rx.state === 'done') break;
  }
  const st = rx.status();
  const text = st.result ? new TextDecoder().decode(st.result.data) : '';
  return {
    ok: text === MESSAGE,
    time: st.tDone,
    pkOk: st.packetsOk,
    pkBad: st.packetsBad,
    ber: st.rawBits ? st.rawBitErrors / st.rawBits : NaN,
  };
}

const lines: string[] = [];
const out = (s: string) => {
  console.log(s);
  lines.push(s);
};
out(`640x360, ${SECONDS} s clips, talking-head stand-in content, message: a ${MESSAGE.length}-byte text. Decoder sees the decoded video frames directly (no camera).`);
out('');
out('| preset | axis, amplitude | video fps | codec | file bitrate | decoded | time | packets ok / failed | raw BER |');
out('|---|---|---|---|---|---|---|---|---|');
for (const c of cases) {
  const base = `${dir}/${c.preset}-${c.axis}-${Math.round(c.amplitude * 100)}-${c.fps}`;
  const rawIn = `${base}.rgb`;
  renderRaw(c, rawIn);
  for (const codec of codecs) {
    let rawOut = rawIn;
    let kbps = '-';
    if (codec.ext) {
      const enc = `${base}-${codec.name.replace(/[^a-z0-9]+/gi, '_')}.${codec.ext}`;
      rawOut = `${enc}.rgb`;
      const e = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${W}x${H}`, '-r', String(c.fps), '-i', rawIn, ...codec.args, enc]);
      if (e.status !== 0) {
        out(`| ${c.preset} | ${c.axis} ${(c.amplitude * 100).toFixed(0)} % | ${c.fps} | ${codec.name} | encode failed: ${String(e.stderr).slice(0, 80)} | | | | |`);
        continue;
      }
      kbps = ((statSync(enc).size * 8) / SECONDS / 1000).toFixed(0) + ' kbit/s';
      const d = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', enc, '-f', 'rawvideo', '-pix_fmt', 'rgb24', rawOut]);
      if (d.status !== 0) continue;
    }
    const r = decode(rawOut, c);
    out(
      `| ${c.preset} (${Math.round(makeLayout(presetByKey(c.preset)).netBitsPerSecond)} bps) | ${c.axis} ${(c.amplitude * 100).toFixed(0)} % | ${c.fps} | ${codec.name} | ${kbps} | ${r.ok ? 'yes' : 'no'} | ${r.time === null ? '-' : r.time.toFixed(1) + ' s'} | ${r.pkOk} / ${r.pkBad} | ${Number.isNaN(r.ber) ? '-' : r.ber.toExponential(1)} |`,
    );
    if (codec.ext) rmSync(rawOut, { force: true });
    writeFileSync('sim-out/codec.md', lines.join('\n') + '\n');
  }
  rmSync(rawIn, { force: true });
}
