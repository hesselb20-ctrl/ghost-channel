import { MAX_PAYLOAD_BYTES, textPayload, urlPayload, type Payload } from '../core/container.ts';
import { makeLayout } from '../core/layout.ts';
import { PRESETS, presetByKey } from '../core/presets.ts';
import { GhostSender, type SenderStats } from './sender.ts';
import { DemoSource, fileSource, screenSource, webcamSource, type DemoKind } from './sources.ts';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const canvas = $<HTMLCanvasElement>('canvas');
const stage = $('stage');
const stageMsg = $('stageMsg');

let sender: GhostSender;
try {
  sender = new GhostSender(canvas);
} catch (e) {
  stageMsg.hidden = false;
  stageMsg.textContent = 'This browser cannot create a WebGL2 context, which the sender needs. ' + (e as Error).message;
  throw e;
}

// ---- Message -------------------------------------------------------------
type MsgType = 'url' | 'text' | 'file';
let msgType: MsgType = 'url';
let filePayload: Payload | null = null;
const payloadError = $('payloadError');

function currentPayload(): Payload | null {
  payloadError.hidden = true;
  const fail = (m: string) => {
    payloadError.textContent = m;
    payloadError.hidden = false;
    return null;
  };
  if (msgType === 'url') {
    const raw = $<HTMLInputElement>('urlInput').value.trim();
    if (!raw) return fail('Enter a link.');
    try {
      const u = new URL(raw);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return fail('Only http and https links are sent as links. Use Text for anything else.');
    } catch {
      return fail('That does not look like a complete link (include https://).');
    }
    return urlPayload(raw);
  }
  if (msgType === 'text') {
    const p = textPayload($<HTMLTextAreaElement>('textInput').value);
    if (!p.data.length) return fail('Enter some text.');
    if (p.data.length > MAX_PAYLOAD_BYTES) return fail('Text is limited to 64 KB.');
    return p;
  }
  if (!filePayload) return fail('Choose a file.');
  return filePayload;
}

for (const b of $('typeSeg').querySelectorAll('button')) {
  b.addEventListener('click', () => {
    msgType = b.dataset.type as MsgType;
    for (const o of $('typeSeg').querySelectorAll('button')) o.setAttribute('aria-pressed', String(o === b));
    $('urlField').hidden = msgType !== 'url';
    $('textField').hidden = msgType !== 'text';
    $('fileField').hidden = msgType !== 'file';
    reconfigure();
  });
}
$('urlInput').addEventListener('change', reconfigure);
$('textInput').addEventListener('change', reconfigure);
$('fileBtn').addEventListener('click', () => $<HTMLInputElement>('fileInput').click());
$<HTMLInputElement>('fileInput').addEventListener('change', async (e) => {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (!f) return;
  if (f.size > MAX_PAYLOAD_BYTES) {
    filePayload = null;
    $('fileInfo').textContent = `${f.name} is ${(f.size / 1024).toFixed(0)} KB. The limit is 64 KB.`;
  } else {
    filePayload = { type: 'file', data: new Uint8Array(await f.arrayBuffer()), name: f.name, mime: f.type || 'application/octet-stream' };
    $('fileInfo').textContent = `${f.name} · ${f.size.toLocaleString()} bytes`;
  }
  reconfigure();
});

// ---- Channel -------------------------------------------------------------
const presetSel = $<HTMLSelectElement>('presetSel');
for (const p of PRESETS) {
  const o = document.createElement('option');
  o.value = p.key;
  o.textContent = `${p.label} · ${Math.round(makeLayout(p).netBitsPerSecond)} bps`;
  presetSel.append(o);
}
presetSel.value = 'standard';
presetSel.addEventListener('change', reconfigure);

const amp = $<HTMLInputElement>('amp');
const debugSwitch = $<HTMLInputElement>('debugSwitch');
let debugConfirmed = false;

function applyMod(): void {
  const debug = debugSwitch.checked;
  const a = debug ? 9 : Number(amp.value);
  sender.mod.amplitude = a / 100;
  $('ampOut').textContent = debug ? '9 % (debug)' : `${Number(amp.value).toFixed(2)} %`;
  amp.disabled = debug;
  sender.mod.floor = Number($<HTMLInputElement>('floor').value) / 100;
  $('floorOut').textContent = `${Number($<HTMLInputElement>('floor').value).toFixed(1)} %`;
  sender.mod.rangeCompress = Number($<HTMLInputElement>('range').value) / 100;
  $('rangeOut').textContent = `${Number($<HTMLInputElement>('range').value).toFixed(1)} %`;
  sender.mod.softness = Number($<HTMLInputElement>('soft').value);
  $('softOut').textContent = sender.mod.softness.toFixed(2);
  sender.mod.displayGamma = Number($<HTMLSelectElement>('gammaSel').value);
  sender.showGrid = $<HTMLInputElement>('gridSwitch').checked;
  $('debugNote').hidden = !debug;
}
for (const id of ['amp', 'floor', 'range', 'soft', 'gammaSel', 'gridSwitch']) $(id).addEventListener('input', applyMod);
debugSwitch.addEventListener('change', () => {
  if (debugSwitch.checked && !debugConfirmed) {
    debugConfirmed = window.confirm(
      'Debug mode makes the picture flicker visibly at the carrier frequency (20 Hz on a 60 Hz screen).\n\nFlicker in this range can trigger seizures in people with photosensitive epilepsy. Do not turn it on if that could affect you or anyone who can see this screen.\n\nTurn on visible flicker?',
    );
    if (!debugConfirmed) debugSwitch.checked = false;
  }
  applyMod();
});
for (const b of $('axisSeg').querySelectorAll('button')) {
  b.addEventListener('click', () => {
    sender.mod.axis = b.dataset.axis as 'chroma' | 'luma';
    for (const o of $('axisSeg').querySelectorAll('button')) o.setAttribute('aria-pressed', String(o === b));
  });
}
$<HTMLInputElement>('badgeSwitch').addEventListener('change', (e) => {
  $('badge').hidden = !(e.target as HTMLInputElement).checked;
});

function reconfigure(): void {
  const preset = presetByKey(presetSel.value);
  $('presetNote').textContent = preset.note;
  const payload = currentPayload();
  if (!payload) return;
  sender.configure(preset, payload);
  renderStats(sender.stats());
}

// ---- Picture -------------------------------------------------------------
const sourceSel = $<HTMLSelectElement>('sourceSel');
const sourceError = $('sourceError');
let lastGoodSource = sourceSel.value;

async function applySource(): Promise<void> {
  sourceError.hidden = true;
  const v = sourceSel.value;
  try {
    if (v.startsWith('demo:')) sender.setSource(new DemoSource(v.slice(5) as DemoKind));
    else if (v === 'screen') sender.setSource(await screenSource());
    else if (v === 'webcam') sender.setSource(await webcamSource());
    else if (v === 'file') {
      $<HTMLInputElement>('mediaInput').click();
      return;
    }
    lastGoodSource = v;
  } catch (e) {
    sourceError.textContent = (e as Error).message || 'That source could not be opened.';
    sourceError.hidden = false;
    sourceSel.value = lastGoodSource.startsWith('demo:') ? lastGoodSource : 'demo:aurora';
    sender.setSource(new DemoSource(sourceSel.value.slice(5) as DemoKind));
  }
}
sourceSel.addEventListener('change', applySource);
$<HTMLInputElement>('mediaInput').addEventListener('change', async (e) => {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (!f) {
    sourceSel.value = lastGoodSource;
    return;
  }
  try {
    sender.setSource(await fileSource(f));
    lastGoodSource = 'file';
  } catch (err) {
    sourceError.textContent = 'This file could not be shown: ' + ((err as Error).message || 'unsupported format');
    sourceError.hidden = false;
  }
});

// ---- Run state -----------------------------------------------------------
const toggle = $<HTMLButtonElement>('toggle');
const statePill = $('statePill');
let broadcasting = false;

function setBroadcast(on: boolean): void {
  if (on && !sender.transmitter) {
    reconfigure();
    if (!sender.transmitter) return;
  }
  broadcasting = on;
  sender.modulate = on;
  toggle.textContent = on ? 'Stop broadcast' : 'Start broadcast';
  toggle.classList.toggle('primary', !on);
  statePill.textContent = on ? 'On air' : 'Idle';
  statePill.className = on ? 'pill good live' : 'pill';
  if (on) sender.resetCounters();
}
toggle.addEventListener('click', () => setBroadcast(!broadcasting));

$('fullscreen').addEventListener('click', () => {
  const el = stage as HTMLElement & { webkitRequestFullscreen?: () => void };
  if (el.requestFullscreen) el.requestFullscreen().catch(() => {});
  else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
  else {
    sourceError.textContent = 'Full screen is not available here (iPhone Safari only allows it for video). Rotate the phone and hide the toolbars instead.';
    sourceError.hidden = false;
  }
});
$('exitFs').addEventListener('click', () => document.exitFullscreen?.());
document.addEventListener('fullscreenchange', () => {
  $('exitFs').hidden = !document.fullscreenElement;
});

function renderStats(s: SenderStats): void {
  $('sRefresh').textContent = s.frames > 30 ? `${s.refreshHz.toFixed(2)} Hz` : 'measuring…';
  $('sCarrier').textContent = s.carrierHz ? `${s.carrierHz} Hz · ${s.framesPerCycle.toFixed(2)} frames/cycle` : '–';
  $('sDropped').textContent = `${s.dropped} (${s.dropPct.toFixed(2)} %)`;
  $('sBps').textContent = `${Math.round(s.netBps)} bps`;
  $('sSize').textContent = `${s.objectBytes} B in ${s.K} block${s.K === 1 ? '' : 's'}`;
  $('sPass').textContent = s.passSeconds >= 60 ? `${(s.passSeconds / 60).toFixed(1)} min` : `${s.passSeconds.toFixed(1)} s`;
  const warn = $('dropWarn');
  const msgs: string[] = [];
  if (s.frames > 600 && s.dropPct > 1) msgs.push(`The browser is missing ${s.dropPct.toFixed(1)} % of display frames; each one corrupts part of a symbol. Close other tabs or pick a lighter picture source.`);
  if (s.carrierHz && s.framesPerCycle < 2.5) msgs.push('This display is too slow for the chosen carrier. Pick a preset with a lower carrier.');
  const preset = presetByKey(presetSel.value);
  if (preset.key === 'hfr' && s.frames > 60 && s.nominalHz < 100) msgs.push('High refresh needs a 120 Hz or faster display; this one runs at ' + s.nominalHz.toFixed(0) + ' Hz.');
  warn.hidden = msgs.length === 0;
  warn.textContent = msgs.join(' ');
  $('summary').textContent = broadcasting ? `${Math.round(s.netBps)} bps · packet ${s.packetIndex}` : '';
}
sender.onStats = renderStats;

// ---- Export --------------------------------------------------------------
$('exportBtn').addEventListener('click', async () => {
  const info = $('exportInfo');
  const btn = $<HTMLButtonElement>('exportBtn');
  if (typeof MediaRecorder === 'undefined' || !canvas.captureStream) {
    info.textContent = 'MediaRecorder or canvas capture is not available in this browser.';
    return;
  }
  const types = ['video/mp4;codecs=avc1.640028', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4'];
  const mime = types.find((t) => MediaRecorder.isTypeSupported(t));
  if (!mime) {
    info.textContent = 'No supported recording format.';
    return;
  }
  if (!broadcasting) setBroadcast(true);
  const secs = Number($<HTMLSelectElement>('exportSecs').value);
  const stream = canvas.captureStream(30);
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 16_000_000 });
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  rec.onstop = () => {
    const blob = new Blob(chunks, { type: mime.split(';')[0] });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `ghost-channel-${presetSel.value}.${mime.includes('mp4') ? 'mp4' : 'webm'}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 30_000);
    info.textContent = `Saved ${(blob.size / 1e6).toFixed(1)} MB as ${mime}. Recorded at 30 fps, 16 Mbit/s requested.`;
    btn.disabled = false;
  };
  btn.disabled = true;
  rec.start(1000);
  let left = secs;
  info.textContent = `Recording… ${left} s`;
  const timer = setInterval(() => {
    left--;
    info.textContent = `Recording… ${Math.max(0, left)} s`;
    if (left <= 0) {
      clearInterval(timer);
      rec.stop();
      for (const t of stream.getTracks()) t.stop();
    }
  }, 1000);
});

// ---- Boot ----------------------------------------------------------------
applyMod();
sender.modulate = false;
reconfigure();
void applySource();
sender.start();

// A `?auto=1` link starts broadcasting straight away (used by the self-test).
const params = new URLSearchParams(location.search);
if (params.get('preset') && PRESETS.some((p) => p.key === params.get('preset'))) {
  presetSel.value = params.get('preset')!;
  reconfigure();
}
if (params.get('auto') === '1') setBroadcast(true);
