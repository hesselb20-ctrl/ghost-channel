import { textPayload, type PayloadType } from '../core/container.ts';
import { applyH, squareToQuad, type Quad } from '../core/homography.ts';
import { makeLayout } from '../core/layout.ts';
import { PRESETS, presetByKey } from '../core/presets.ts';
import { GhostSender } from '../send/sender.ts';
import { DemoSource } from '../send/sources.ts';
import type { ToMain, ToWorker, WireStatus } from './protocol.ts';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const video = $<HTMLVideoElement>('video');
const overlay = $<HTMLCanvasElement>('overlay');
const finder = $('finder');
const logEl = $('log');

function log(msg: string): void {
  const t = new Date().toLocaleTimeString([], { hour12: false });
  logEl.textContent = `${t}  ${msg}\n` + (logEl.textContent ?? '').split('\n').slice(0, 60).join('\n');
}

// ---- Worker --------------------------------------------------------------
const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
const send = (m: ToWorker, transfer: Transferable[] = []) => worker.postMessage(m, transfer);
let workerBackend = 'starting…';
let inFlight = 0;
let skipped = 0;
let status: WireStatus | null = null;
let selfTestExpect: string | null = null;

worker.onmessage = (e: MessageEvent<ToMain>) => {
  const m = e.data;
  if (m.type === 'ready') {
    workerBackend = m.backend;
    $('dBackend').textContent = m.backend;
  } else if (m.type === 'ack') {
    inFlight = Math.max(0, inFlight - 1);
  } else if (m.type === 'log') {
    log(m.msg);
  } else if (m.type === 'status') {
    status = m.status;
    renderStatus();
  } else if (m.type === 'result') {
    showResult(m.payloadType, m.data, m.name, m.mime);
  }
};
worker.onerror = (e) => log('worker error: ' + e.message);

// ---- Settings ------------------------------------------------------------
const procSel = $<HTMLSelectElement>('procSel');
const presetSel = $<HTMLSelectElement>('presetSel');
for (const p of PRESETS) {
  const o = document.createElement('option');
  o.value = p.key;
  o.textContent = p.label;
  presetSel.append(o);
}
function pushConfig(): void {
  send({ type: 'config', procWidth: Number(procSel.value), presetKeys: presetSel.value ? [presetSel.value] : null });
  status = null;
}
procSel.addEventListener('change', pushConfig);
presetSel.addEventListener('change', pushConfig);

// ---- Timestamps ----------------------------------------------------------
// The demodulator needs to know when each frame was captured. Preference:
// captureTime (Chrome, real camera clock) > mediaTime > snapped wall clock.
// Whatever the source, if the intervals jitter by more than ~1.5 ms they are
// snapped onto the camera's own frame grid, which is what a sensor really does.
class FrameClock {
  source = '–';
  private last = -1;
  private out = 0;
  private intervals: number[] = [];
  private period = 1 / 30;
  private snapped = false;

  next(raw: number, source: string): number {
    this.source = source;
    if (this.last < 0) {
      this.last = raw;
      this.out = raw;
      return raw;
    }
    const d = raw - this.last;
    this.last = raw;
    if (d > 0.002 && d < 0.5) {
      this.intervals.push(d);
      if (this.intervals.length > 45) this.intervals.shift();
    }
    if (this.intervals.length >= 15) {
      const s = this.intervals.slice().sort((a, b) => a - b);
      const med = s[s.length >> 1];
      // Frame period from the single-frame intervals only.
      const singles = s.filter((x) => Math.abs(x - med) < med * 0.3);
      this.period = singles.reduce((a, b) => a + b, 0) / singles.length;
      const mad = s.map((x) => Math.abs(x - Math.round(x / this.period) * this.period)).sort((a, b) => a - b)[s.length >> 1];
      this.snapped = mad > 0.0015;
    }
    if (this.snapped) {
      const steps = Math.max(1, Math.round(d / this.period));
      this.out += steps * this.period;
      // Keep the snapped clock from drifting away from the raw one.
      this.out += 0.02 * (raw - this.out);
    } else {
      this.out = raw;
    }
    return this.out;
  }
  get label(): string {
    return this.source + (this.snapped ? ' (snapped to frame grid)' : '');
  }
  reset(): void {
    this.last = -1;
    this.intervals = [];
    this.snapped = false;
  }
}
const clock = new FrameClock();

// ---- Frame pump ----------------------------------------------------------
let running = false;
let stream: MediaStream | null = null;
let rvfcId = 0;
let rafId = 0;
let lastVideoTime = -1;
let fallbackCanvas: HTMLCanvasElement | null = null;
const hasRvfc = 'requestVideoFrameCallback' in HTMLVideoElement.prototype;

interface FrameMeta {
  captureTime?: number;
  mediaTime?: number;
  expectedDisplayTime?: number;
}

async function pump(meta: FrameMeta | null): Promise<void> {
  if (!running || video.readyState < 2 || !video.videoWidth) return;
  let raw: number;
  let src: string;
  if (meta && typeof meta.captureTime === 'number' && meta.captureTime > 0) {
    raw = meta.captureTime / 1000;
    src = 'captureTime';
  } else if (meta && typeof meta.mediaTime === 'number' && meta.mediaTime > 0) {
    raw = meta.mediaTime;
    src = 'mediaTime';
  } else {
    raw = performance.now() / 1000;
    src = 'wall clock';
  }
  const t = clock.next(raw, src);
  // Up to five frames may wait for the worker. A stall shorter than about
  // 150 ms then costs no frames; only a long one (a full re-acquisition on a
  // slow device) does.
  if (inFlight >= 5) {
    skipped++;
    return;
  }
  inFlight++;
  try {
    if (typeof createImageBitmap === 'function' && workerBackend !== 'main-thread pixels') {
      const bitmap = await createImageBitmap(video);
      send({ type: 'frame', bitmap, t }, [bitmap]);
    } else {
      // Last resort: read pixels on the main thread.
      const w = Math.min(Number(procSel.value), video.videoWidth);
      const h = Math.max(2, Math.round((w * video.videoHeight) / video.videoWidth));
      fallbackCanvas ??= document.createElement('canvas');
      fallbackCanvas.width = w;
      fallbackCanvas.height = h;
      const g = fallbackCanvas.getContext('2d', { willReadFrequently: true })!;
      g.drawImage(video, 0, 0, w, h);
      const data = g.getImageData(0, 0, w, h).data;
      send({ type: 'pixels', rgba: data.buffer, w, h, t }, [data.buffer]);
    }
  } catch (err) {
    inFlight = Math.max(0, inFlight - 1);
    log('capture failed: ' + (err as Error).message);
  }
}

function scheduleFrames(): void {
  if (hasRvfc) {
    const cb = (_now: number, meta: FrameMeta) => {
      if (!running) return;
      rvfcId = (video as HTMLVideoElement & { requestVideoFrameCallback: (c: typeof cb) => number }).requestVideoFrameCallback(cb);
      void pump(meta);
    };
    rvfcId = (video as HTMLVideoElement & { requestVideoFrameCallback: (c: typeof cb) => number }).requestVideoFrameCallback(cb);
  } else {
    // No requestVideoFrameCallback: poll for a new frame on every repaint.
    const loop = () => {
      if (!running) return;
      rafId = requestAnimationFrame(loop);
      if (video.currentTime !== lastVideoTime) {
        lastVideoTime = video.currentTime;
        void pump(null);
      }
    };
    rafId = requestAnimationFrame(loop);
  }
}

// ---- Camera --------------------------------------------------------------
type Caps = MediaTrackCapabilities & {
  zoom?: { min: number; max: number; step: number };
  exposureMode?: string[];
  whiteBalanceMode?: string[];
  focusMode?: string[];
  exposureTime?: { min: number; max: number; step: number };
};
type Settings = MediaTrackSettings & { exposureMode?: string; exposureTime?: number; whiteBalanceMode?: string; zoom?: number };
let track: MediaStreamTrack | null = null;
let caps: Caps = {};
let exposureNote = 'not controllable';

function readTrack(): void {
  if (!track) return;
  caps = (track.getCapabilities?.() ?? {}) as Caps;
  const s = track.getSettings() as Settings;
  const parts = [`${s.width}×${s.height}`, s.frameRate ? `${Math.round(s.frameRate)} fps` : null];
  const feats: string[] = [];
  feats.push('exposure lock: ' + (caps.exposureMode?.includes('manual') ? 'yes' : 'no'));
  feats.push('white balance lock: ' + (caps.whiteBalanceMode?.includes('manual') ? 'yes' : 'no'));
  feats.push('zoom: ' + (caps.zoom ? `${caps.zoom.min}–${caps.zoom.max}×` : 'no'));
  $('capInfo').textContent = parts.filter(Boolean).join(' · ') + '. ' + feats.join(', ') + '.';
  if (caps.zoom) {
    const z = $<HTMLInputElement>('zoom');
    z.min = String(caps.zoom.min);
    z.max = String(Math.min(caps.zoom.max, 8));
    z.step = String(caps.zoom.step || 0.1);
    z.value = String(s.zoom ?? caps.zoom.min);
    $('zoomRow').hidden = false;
  } else {
    $('zoomRow').hidden = true;
  }
  if (s.exposureMode) {
    // exposureTime is reported in units of 100 microseconds.
    const et = typeof s.exposureTime === 'number' ? ` · ${(s.exposureTime / 10).toFixed(1)} ms` : '';
    exposureNote = `${s.exposureMode}${et}`;
  } else {
    exposureNote = 'automatic (browser gives no control)';
  }
  $('dExp').textContent = exposureNote;
}

async function applyLock(): Promise<void> {
  if (!track) return;
  const want = $<HTMLInputElement>('lockAe').checked;
  const adv: Record<string, unknown>[] = [];
  if (caps.exposureMode?.includes(want ? 'manual' : 'continuous')) adv.push({ exposureMode: want ? 'manual' : 'continuous' });
  if (caps.whiteBalanceMode?.includes(want ? 'manual' : 'continuous')) adv.push({ whiteBalanceMode: want ? 'manual' : 'continuous' });
  if (!adv.length) {
    if (want) log('this camera does not allow exposure or white-balance lock; relying on differential detection');
    return;
  }
  try {
    await track.applyConstraints({ advanced: adv as MediaTrackConstraintSet[] });
    log(want ? 'exposure and white balance locked' : 'exposure and white balance automatic');
  } catch (e) {
    log('lock refused: ' + (e as Error).message);
  }
  readTrack();
}
$('lockAe').addEventListener('change', applyLock);
$('zoom').addEventListener('input', async (e) => {
  const v = Number((e.target as HTMLInputElement).value);
  $('zoomOut').textContent = v.toFixed(1) + '×';
  try {
    await track?.applyConstraints({ advanced: [{ zoom: v } as MediaTrackConstraintSet] });
  } catch {
    /* zoom not applied */
  }
});
$('fps60').addEventListener('change', async () => {
  if (!track) return;
  try {
    await track.applyConstraints({ frameRate: { ideal: $<HTMLInputElement>('fps60').checked ? 60 : 30 } });
  } catch (e) {
    log('frame rate request refused: ' + (e as Error).message);
  }
  clock.reset();
  readTrack();
});

function beginSession(): void {
  running = true;
  skipped = 0;
  inFlight = 0;
  clock.reset();
  status = null;
  $('empty').hidden = true;
  finder.classList.remove('is-empty');
  $('hud').hidden = false;
  $('actions').hidden = false;
  if (video.videoWidth) finder.style.aspectRatio = `${video.videoWidth} / ${video.videoHeight}`;
  pushConfig();
  send({ type: 'reset' });
  scheduleFrames();
}

async function startCamera(): Promise<void> {
  const err = $('startError');
  err.hidden = true;
  if (!navigator.mediaDevices?.getUserMedia) {
    err.textContent = 'Camera access needs a secure page. Open this site over HTTPS (see the README for a free way to do that on your own network).';
    err.hidden = false;
    return;
  }
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: $<HTMLInputElement>('fps60').checked ? 60 : 30 },
      },
    });
  } catch (e) {
    const name = (e as DOMException).name;
    err.textContent =
      name === 'NotAllowedError'
        ? 'Camera permission was refused. Allow it in the browser’s site settings and try again.'
        : name === 'NotFoundError'
          ? 'No camera found on this device. You can still run the self-test.'
          : 'Could not start the camera: ' + (e as Error).message;
    err.hidden = false;
    return;
  }
  selfTestExpect = null;
  video.srcObject = stream;
  await video.play();
  track = stream.getVideoTracks()[0];
  readTrack();
  await applyLock();
  beginSession();
  log('camera started');
}

function stopAll(): void {
  running = false;
  if (rvfcId && 'cancelVideoFrameCallback' in video) (video as HTMLVideoElement & { cancelVideoFrameCallback: (id: number) => void }).cancelVideoFrameCallback(rvfcId);
  cancelAnimationFrame(rafId);
  for (const t of stream?.getTracks() ?? []) t.stop();
  stream = null;
  track = null;
  video.srcObject = null;
  selfSender?.stop(true);
  selfSender = null;
  $('empty').hidden = false;
  finder.classList.add('is-empty');
  finder.style.aspectRatio = '';
  $('hud').hidden = true;
  $('actions').hidden = true;
  $('statePill').textContent = 'Idle';
  $('statePill').className = 'pill';
  const g = overlay.getContext('2d')!;
  g.clearRect(0, 0, overlay.width, overlay.height);
}

$('startBtn').addEventListener('click', startCamera);
$('stopBtn').addEventListener('click', stopAll);
$('restartBtn').addEventListener('click', () => {
  send({ type: 'reset' });
  status = null;
  log('started over');
});

// ---- Self-test -----------------------------------------------------------
// The real WebGL sender renders into an off-screen canvas; its capture stream
// stands in for the camera. This exercises every part of the receive path
// except the optics.
let selfSender: GhostSender | null = null;
async function startSelfTest(): Promise<void> {
  const canvas = $<HTMLCanvasElement>('selfCanvas');
  const params = new URLSearchParams(location.search);
  const presetKey = params.get('preset') ?? 'standard';
  selfTestExpect = 'Self-test: WebGL sender → canvas capture → worker → decoder. Preset ' + presetKey + '.';
  try {
    selfSender = new GhostSender(canvas);
    selfSender.fixedSize = true;
    selfSender.mod.amplitude = Number(params.get('amp') ?? '4') / 100;
    selfSender.mod.axis = params.get('axis') === 'luma' ? 'luma' : 'chroma';
    selfSender.configure(presetByKey(presetKey), textPayload(selfTestExpect));
    selfSender.setSource(new DemoSource((params.get('scene') as 'aurora') ?? 'aurora'));
    selfSender.start();
    stream = canvas.captureStream(Number(params.get('fps') ?? '30'));
    video.srcObject = stream;
    await video.play();
    track = null;
    $('capInfo').textContent = `Self-test source: 1280×720 canvas capture, preset ${presetKey}.`;
    $('dExp').textContent = 'n/a (self-test)';
    beginSession();
    log('self-test started: ' + makeLayout(presetByKey(presetKey)).netBitsPerSecond.toFixed(0) + ' bps nominal');
  } catch (e) {
    const err = $('startError');
    err.textContent = 'Self-test could not start: ' + (e as Error).message;
    err.hidden = false;
  }
}
$('selfTestBtn').addEventListener('click', startSelfTest);

// ---- Manual corners ------------------------------------------------------
let manual: { x: number; y: number }[] | null = null;
let dragging = -1;
$('manualBtn').addEventListener('click', () => {
  const on = manual === null;
  $('manualBtn').setAttribute('aria-pressed', String(on));
  if (on && status) {
    const w = status.procW;
    const h = status.procH;
    manual = status.quad?.map((p) => ({ ...p })) ?? [
      { x: 0.18 * w, y: 0.18 * h },
      { x: 0.82 * w, y: 0.18 * h },
      { x: 0.82 * w, y: 0.82 * h },
      { x: 0.18 * w, y: 0.82 * h },
    ];
    send({ type: 'manual', quad: manual });
    send({ type: 'reset' });
    log('drag the four dots onto the corners of the broadcasting picture, clockwise from its top-left');
  } else {
    manual = null;
    send({ type: 'manual', quad: null });
  }
  overlay.style.pointerEvents = manual ? 'auto' : 'none';
});
overlay.style.pointerEvents = 'none';
function toProc(ev: PointerEvent): { x: number; y: number } {
  const r = overlay.getBoundingClientRect();
  const s = (status?.procW ?? 640) / r.width;
  return { x: (ev.clientX - r.left) * s, y: (ev.clientY - r.top) * s };
}
overlay.addEventListener('pointerdown', (ev) => {
  if (!manual) return;
  const p = toProc(ev);
  let best = -1;
  let bd = Infinity;
  manual.forEach((m, i) => {
    const d = Math.hypot(m.x - p.x, m.y - p.y);
    if (d < bd) {
      bd = d;
      best = i;
    }
  });
  dragging = best;
  overlay.setPointerCapture(ev.pointerId);
});
overlay.addEventListener('pointermove', (ev) => {
  if (!manual || dragging < 0) return;
  manual[dragging] = toProc(ev);
  drawOverlay();
});
overlay.addEventListener('pointerup', () => {
  if (!manual || dragging < 0) return;
  dragging = -1;
  send({ type: 'manual', quad: manual });
  send({ type: 'reset' });
});

// ---- Overlay and status --------------------------------------------------
let ppsPrev = { t: 0, ok: 0, pps: 0 };

function drawOverlay(): void {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const cw = Math.round(overlay.clientWidth * dpr);
  const ch = Math.round(overlay.clientHeight * dpr);
  if (overlay.width !== cw || overlay.height !== ch) {
    overlay.width = cw;
    overlay.height = ch;
  }
  const g = overlay.getContext('2d')!;
  g.clearRect(0, 0, cw, ch);
  if (!status) return;
  const s = cw / status.procW;
  const q = status.quad;
  if (q && status.cols) {
    const H = squareToQuad(q.map((p) => ({ x: p.x * s, y: p.y * s })) as Quad);
    const { cols, rows, cellConf } = status;
    if (cellConf) {
      // Heat map: red is a cell the demodulator cannot read, green is solid.
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const conf = Math.min(1, cellConf[r * cols + c] / 8);
          const a = applyH(H, c / cols, r / rows);
          const b = applyH(H, (c + 1) / cols, r / rows);
          const d = applyH(H, (c + 1) / cols, (r + 1) / rows);
          const e = applyH(H, c / cols, (r + 1) / rows);
          g.fillStyle = `hsla(${Math.round(conf * 130)}, 90%, 50%, 0.3)`;
          g.beginPath();
          g.moveTo(a.x, a.y);
          g.lineTo(b.x, b.y);
          g.lineTo(d.x, d.y);
          g.lineTo(e.x, e.y);
          g.closePath();
          g.fill();
        }
      }
    }
    g.lineWidth = 2 * dpr;
    g.strokeStyle = status.packetsOk > 0 ? '#30d158' : '#0a84ff';
    g.lineJoin = 'round';
    g.beginPath();
    q.forEach((p, i) => (i ? g.lineTo(p.x * s, p.y * s) : g.moveTo(p.x * s, p.y * s)));
    g.closePath();
    g.stroke();
  }
  if (manual) {
    g.strokeStyle = 'rgba(255,255,255,0.9)';
    g.lineWidth = 1.5 * dpr;
    g.setLineDash([6 * dpr, 6 * dpr]);
    g.beginPath();
    manual.forEach((p, i) => (i ? g.lineTo(p.x * s, p.y * s) : g.moveTo(p.x * s, p.y * s)));
    g.closePath();
    g.stroke();
    g.setLineDash([]);
    manual.forEach((p, i) => {
      g.fillStyle = i === 0 ? '#ff9f0a' : '#fff';
      g.beginPath();
      g.arc(p.x * s, p.y * s, 9 * dpr, 0, Math.PI * 2);
      g.fill();
    });
  }
}

function renderStatus(): void {
  if (!status) return;
  const st = status;
  drawOverlay();
  const pct = Math.round(st.progress * 100);
  $('ringFill').style.strokeDashoffset = String(119.4 * (1 - st.progress));
  $('ringText').textContent = st.state === 'done' ? '✓' : `${pct}%`;
  $('ring').setAttribute('aria-valuenow', String(pct));
  const now = st.t;
  if (now - ppsPrev.t >= 1) {
    ppsPrev = { t: now, ok: st.packetsOk, pps: ppsPrev.t ? (st.packetsOk - ppsPrev.ok) / (now - ppsPrev.t) : 0 };
  }
  const elapsed = st.tLock !== null ? Math.max(0.001, (st.tDone ?? now) - st.tLock) : 0;
  const bps = elapsed ? (st.goodBytes * 8) / elapsed : 0;
  const title = $('hudTitle');
  const sub = $('hudSub');
  const pill = $('statePill');
  if (st.state === 'search') {
    title.textContent = 'Looking for a screen…';
    sub.textContent = st.lockAttempts > 6 ? 'Nothing yet. Move closer, or place the corners by hand.' : 'Hold steady and fill most of the view with the screen.';
    pill.textContent = 'Searching';
    pill.className = 'pill';
  } else if (st.state === 'locked' && st.packetsOk === 0) {
    title.textContent = 'Screen found. Synchronising…';
    sub.textContent = `${st.cols}×${st.rows} grid · pilots ${(st.coherence * 100).toFixed(0)} %`;
    pill.textContent = 'Locked';
    pill.className = 'pill good live';
  } else if (st.state === 'locked') {
    title.textContent = `Receiving · ${pct}%`;
    sub.textContent = `${st.rank} of ${st.K} blocks · ${Math.round(bps)} bps`;
    pill.textContent = 'Receiving';
    pill.className = 'pill good live';
  } else {
    title.textContent = 'Done';
    sub.textContent = `${st.goodBytes} bytes in ${elapsed.toFixed(1)} s`;
    pill.textContent = 'Done';
    pill.className = 'pill good';
  }
  const rel = (t: number | null) => (t === null ? '–' : `${(t - st.tFirstFrame).toFixed(2)} s`);
  $('dState').textContent = st.state + (st.detection ? ` (${st.detection})` : '');
  $('dFps').textContent = `${st.fps.toFixed(1)} fps`;
  $('dSkip').textContent = String(skipped);
  $('dProc').textContent = `${st.procMs.toFixed(1)} ms (peak ${st.procMsMax.toFixed(0)}) + ${st.scaleMs.toFixed(1)} ms scale at ${st.procW}×${st.procH}`;
  $('dTs').textContent = clock.label;
  document.body.dataset.debug = st.debug;
  $('dPreset').textContent = `${st.presetKey ?? (st.cols ? `${st.cols}×${st.rows}?` : '–')} · ${st.plane ?? '–'}`;
  $('dCoh').textContent = st.state === 'search' ? '–' : st.coherence.toFixed(2);
  $('dSnr').textContent = st.state === 'search' ? '–' : `${st.snrDb.toFixed(1)} dB`;
  $('dBer').textContent = st.rawBits ? (st.rawBitErrors / st.rawBits).toExponential(1) + ` (${st.rawBitErrors}/${st.rawBits})` : '–';
  $('dBerPost').textContent = st.packetsOk ? `0 in ${st.packetsOk} CRC-verified packets` : '–';
  $('dPkts').textContent = `${st.packetsOk} / ${st.packetsBad}`;
  $('dPps').textContent = ppsPrev.pps.toFixed(1);
  $('dBps').textContent = `${Math.round(bps)} bps`;
  $('dLock').textContent = rel(st.tLock);
  $('dFirst').textContent = rel(st.tFirstPacket);
  $('dDone').textContent = rel(st.tDone);
}
window.addEventListener('resize', drawOverlay);

$('copyDiag').addEventListener('click', async () => {
  const rows = [...document.querySelectorAll('.rx-side dl.kv dt')].map((dt) => `${dt.textContent}: ${dt.nextElementSibling?.textContent ?? ''}`);
  const text = rows.join('\n') + '\n\n' + (logEl.textContent ?? '');
  try {
    await navigator.clipboard.writeText(text);
    log('diagnostics copied');
  } catch {
    log('clipboard not available');
  }
});

// ---- Result --------------------------------------------------------------
// Payloads are untrusted. Text is shown as text, links are never followed
// without a tap on a button that sits next to the full address, and files are
// only ever offered as downloads with a neutral content type.
const dlg = $<HTMLDialogElement>('resultDlg');
function button(label: string, primary: boolean, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.textContent = label;
  if (primary) b.className = 'primary';
  b.addEventListener('click', onClick);
  return b;
}
function showResult(type: PayloadType, data: Uint8Array, name: string | null, mime: string | null): void {
  const body = $('resBody');
  const actions = $('resActions');
  const meta = $('resMeta');
  actions.replaceChildren();
  const text = new TextDecoder('utf-8', { fatal: false }).decode(data);
  const copy = (t: string) => button('Copy', false, () => void navigator.clipboard?.writeText(t).catch(() => {}));
  const close = button('Close', false, () => dlg.close());
  const st = status;
  const took = st && st.tDone !== null ? `Decoded in ${(st.tDone - st.tFirstFrame).toFixed(1)} s. ` : '';
  if (type === 'url') {
    $('resKind').textContent = 'Received a link';
    let safe: URL | null = null;
    try {
      const u = new URL(text);
      if (u.protocol === 'https:' || u.protocol === 'http:') safe = u;
    } catch {
      safe = null;
    }
    $('resTitle').textContent = safe ? safe.hostname : 'Not a web link';
    body.textContent = text;
    meta.textContent = took + (safe ? 'Check the full address above before opening. Nothing opens until you tap the button.' : 'This is not an http(s) address, so it is shown as text only.');
    if (safe) actions.append(button('Open link', true, () => window.open(safe!.href, '_blank', 'noopener,noreferrer')));
    actions.append(copy(text), close);
  } else if (type === 'text') {
    $('resKind').textContent = 'Received text';
    $('resTitle').textContent = `${data.length} bytes`;
    body.textContent = text;
    meta.textContent = took + 'Shown as plain text.';
    actions.append(copy(text), close);
    if (selfTestExpect !== null) {
      const ok = text === selfTestExpect;
      log(ok ? 'SELF-TEST PASS: decoded text matches what the sender encoded' : 'SELF-TEST FAIL: decoded text differs');
      meta.textContent = took + (ok ? 'Self-test passed: byte-for-byte match.' : 'Self-test FAILED: text differs from what was sent.');
      document.body.dataset.selftest = ok ? 'pass' : 'fail';
    }
  } else {
    $('resKind').textContent = 'Received a file';
    const clean = (name ?? 'file.bin').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 120) || 'file.bin';
    $('resTitle').textContent = clean;
    body.textContent = `${data.length.toLocaleString()} bytes\nDeclared type: ${mime ?? 'unknown'}`;
    meta.textContent = took + 'The file is not opened or run here. Download it only if you trust the sender.';
    actions.append(
      button('Download', true, () => {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([data as BlobPart], { type: 'application/octet-stream' }));
        a.download = clean;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 30_000);
      }),
      close,
    );
  }
  if (!dlg.open) dlg.showModal();
}
dlg.addEventListener('close', () => {
  if (running) {
    send({ type: 'reset' });
    status = null;
  }
});

if (new URLSearchParams(location.search).get('selftest') === '1') void startSelfTest();
