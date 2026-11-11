/// <reference lib="webworker" />
// Receiver worker. Frames arrive as ImageBitmaps; a WebGL2 OffscreenCanvas
// downsizes them (mipmapped, so the result is a proper area average), the
// pixels are read back, and the pure-TypeScript receiver does the rest.
// Without WebGL2 in workers it falls back to a 2D OffscreenCanvas; without
// OffscreenCanvas at all, the page sends raw pixels instead.

import { PRESETS } from '../core/presets.ts';
import type { Quad } from '../core/homography.ts';
import { rgbaToFrame } from '../core/rx/frame.ts';
import { Receiver } from '../core/rx/receiver.ts';
import type { ToMain, ToWorker, WireStatus } from './protocol.ts';

const ctx = self as unknown as DedicatedWorkerGlobalScope;
const post = (m: ToMain, transfer: Transferable[] = []) => ctx.postMessage(m, transfer);

let procWidth = 640;
let presetKeys: string[] | null = null;
let lastStatus = 0;
let procMsAvg = 0;
let scaleMsAvg = 0;
let procMsMax = 0;
let resultSent = false;
let receiver = makeReceiver();

function makeReceiver(): Receiver {
  const presets = presetKeys ? PRESETS.filter((p) => presetKeys!.includes(p.key)) : PRESETS;
  resultSent = false;
  return new Receiver({
    presets: presets.length ? presets : PRESETS,
    // Keep the detector map near 320 px wide whatever the processing size.
    mapStep: Math.max(2, Math.round(procWidth / 320)),
    onEvent: (msg) => post({ type: 'log', msg }),
  });
}

// ---- Downscale backends --------------------------------------------------
interface Scaler {
  name: string;
  run(src: ImageBitmap, w: number, h: number): Uint8Array | Uint8ClampedArray;
}

function makeGlScaler(): Scaler | null {
  if (typeof OffscreenCanvas === 'undefined') return null;
  const canvas = new OffscreenCanvas(16, 16);
  const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, premultipliedAlpha: false, preserveDrawingBuffer: false });
  if (!gl) return null;
  const vs = gl.createShader(gl.VERTEX_SHADER)!;
  // Row 0 of the read-back is the top row of the image.
  gl.shaderSource(vs, '#version 300 es\nin vec2 p; out vec2 uv; void main(){ uv = p * 0.5 + 0.5; gl_Position = vec4(p, 0.0, 1.0); }');
  gl.compileShader(vs);
  const fs = gl.createShader(gl.FRAGMENT_SHADER)!;
  gl.shaderSource(fs, '#version 300 es\nprecision mediump float; in vec2 uv; out vec4 o; uniform sampler2D t; void main(){ o = vec4(texture(t, uv).rgb, 1.0); }');
  gl.compileShader(fs);
  const prog = gl.createProgram()!;
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null;
  gl.useProgram(prog);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, 'p');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  let out = new Uint8Array(0);
  return {
    name: 'WebGL2 worker',
    run(src, w, h) {
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      gl.viewport(0, 0, w, h);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
      const shrink = src.width / w;
      if (shrink > 1.5) {
        gl.generateMipmap(gl.TEXTURE_2D);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      } else {
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      }
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      if (out.length !== w * h * 4) out = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, out);
      return out;
    },
  };
}

function make2dScaler(): Scaler | null {
  if (typeof OffscreenCanvas === 'undefined') return null;
  const canvas = new OffscreenCanvas(16, 16);
  const g = canvas.getContext('2d', { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D | null;
  if (!g) return null;
  return {
    name: 'Canvas 2D worker',
    run(src, w, h) {
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      g.imageSmoothingEnabled = true;
      g.imageSmoothingQuality = 'medium';
      g.drawImage(src, 0, 0, w, h);
      return g.getImageData(0, 0, w, h).data;
    },
  };
}

let scaler: Scaler | null = null;
try {
  scaler = makeGlScaler() ?? make2dScaler();
} catch {
  scaler = make2dScaler();
}
post({ type: 'ready', backend: scaler?.name ?? 'main-thread pixels' });

function handle(rgba: Uint8Array | Uint8ClampedArray, w: number, h: number, t: number): void {
  const t0 = performance.now();
  receiver.pushFrame(rgbaToFrame(rgba, w, h, t));
  const ms = performance.now() - t0;
  procMsAvg += 0.1 * (ms - procMsAvg);
  procMsMax = Math.max(procMsMax * 0.98, ms);
  const st = receiver.status();
  const now = performance.now();
  const finished = st.state === 'done' && !resultSent;
  if (now - lastStatus > 90 || finished) {
    lastStatus = now;
    const wire: WireStatus = {
      state: st.state,
      fps: st.fps,
      frames: st.frames,
      quad: st.quad,
      cols: st.cols,
      rows: st.rows,
      presetKey: st.presetKey,
      plane: st.plane,
      coherence: st.coherence,
      snrDb: st.snrDb,
      cellConf: st.cellConf ? Array.from(st.cellConf) : null,
      K: st.K,
      rank: st.rank,
      progress: st.progress,
      packetsOk: st.packetsOk,
      packetsBad: st.packetsBad,
      rawBits: st.rawBits,
      rawBitErrors: st.rawBitErrors,
      goodBytes: st.goodBytes,
      tFirstFrame: st.tFirstFrame,
      tLock: st.tLock,
      tFirstPacket: st.tFirstPacket,
      tDone: st.tDone,
      lockAttempts: st.lockAttempts,
      detection: st.detection,
      procMs: procMsAvg,
      procMsMax,
      scaleMs: scaleMsAvg,
      debug: receiver
        .debugDemods()
        .map((d) => d.debugLine())
        .join(' | '),
      procW: w,
      procH: h,
      t,
    };
    post({ type: 'status', status: wire });
  }
  if (finished && st.result) {
    resultSent = true;
    const data = st.result.data.slice();
    post({ type: 'result', payloadType: st.result.type, name: st.result.name ?? null, mime: st.result.mime ?? null, data }, [data.buffer]);
  }
}

ctx.onmessage = (e: MessageEvent<ToWorker>) => {
  const m = e.data;
  switch (m.type) {
    case 'config':
      if (m.procWidth !== procWidth || JSON.stringify(m.presetKeys) !== JSON.stringify(presetKeys)) {
        procWidth = m.procWidth;
        presetKeys = m.presetKeys;
        receiver = makeReceiver();
      }
      break;
    case 'reset':
      receiver = makeReceiver();
      break;
    case 'manual':
      receiver.setManualQuad(m.quad as Quad | null);
      break;
    case 'frame': {
      try {
        if (scaler) {
          const w = Math.min(procWidth, m.bitmap.width);
          const h = Math.max(2, Math.round((w * m.bitmap.height) / m.bitmap.width));
          const t0 = performance.now();
          const px = scaler.run(m.bitmap, w, h);
          scaleMsAvg += 0.1 * (performance.now() - t0 - scaleMsAvg);
          handle(px, w, h, m.t);
        }
      } catch (err) {
        post({ type: 'log', msg: 'frame failed: ' + (err as Error).message });
      } finally {
        m.bitmap.close();
        post({ type: 'ack' });
      }
      break;
    }
    case 'pixels':
      try {
        handle(new Uint8ClampedArray(m.rgba), m.w, m.h, m.t);
      } finally {
        post({ type: 'ack' });
      }
      break;
  }
};
