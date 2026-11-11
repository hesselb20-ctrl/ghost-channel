// Blind two-interval forced-choice test.
//
// Each trial shows the same clip twice, once with modulation and once
// without (same range compression, same dither, amplitude zero). The viewer
// picks the interval that carried data. Guessing scores 50 %, so the highest
// amplitude whose score is statistically indistinguishable from 50 % is the
// invisibility threshold for that viewer, screen, room and clip.

import { textPayload } from '../core/container.ts';
import { makeLayout } from '../core/layout.ts';
import { PRESETS, presetByKey } from '../core/presets.ts';
import { GhostSender } from '../send/sender.ts';
import { DemoSource, fileSource, webcamSource, type DemoKind } from '../send/sources.ts';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const cover = $('cover');
const coverInner = $('coverInner');
const label = $('label');
const answerRow = $('answerRow');
const progress = $('progress');
const setupError = $('setupError');

interface Trial {
  amplitude: number;
  /** 1 or 2: which interval carried the modulation. */
  signalIn: 1 | 2;
  answer: 1 | 2 | null;
  correct: boolean | null;
  responseMs: number | null;
}
interface Session {
  startedAt: string;
  content: string;
  preset: string;
  axis: string;
  clipSeconds: number;
  refreshHz: number;
  screen: string;
  userAgent: string;
  trials: Trial[];
}

const STORE = 'ghost-channel-abtest';
let session: Session | null = null;
let history: Session[] = [];
try {
  history = JSON.parse(localStorage.getItem(STORE) ?? '[]');
} catch {
  history = [];
}

let sender: GhostSender;
try {
  sender = new GhostSender($<HTMLCanvasElement>('canvas'));
} catch (e) {
  coverInner.replaceChildren(Object.assign(document.createElement('p'), { textContent: 'This test needs WebGL2, which this browser did not provide.' }));
  throw e;
}

const presetSel = $<HTMLSelectElement>('presetSel');
for (const p of PRESETS) {
  const o = document.createElement('option');
  o.value = p.key;
  o.textContent = p.label;
  presetSel.append(o);
}
presetSel.value = 'standard';

let axis: 'chroma' | 'luma' = 'chroma';
for (const b of $('axisSeg').querySelectorAll('button')) {
  b.addEventListener('click', () => {
    axis = b.dataset.axis as 'chroma' | 'luma';
    for (const o of $('axisSeg').querySelectorAll('button')) o.setAttribute('aria-pressed', String(o === b));
  });
}

const contentSel = $<HTMLSelectElement>('contentSel');
let contentReady = false;
async function applyContent(): Promise<void> {
  setupError.hidden = true;
  contentReady = false;
  const v = contentSel.value;
  try {
    if (v.startsWith('demo:')) sender.setSource(new DemoSource(v.slice(5) as DemoKind));
    else if (v === 'webcam') sender.setSource(await webcamSource());
    else {
      $<HTMLInputElement>('mediaInput').click();
      return;
    }
    contentReady = true;
  } catch (e) {
    setupError.textContent = (e as Error).message || 'That clip could not be opened.';
    setupError.hidden = false;
    contentSel.value = 'demo:portrait';
    sender.setSource(new DemoSource('portrait'));
    contentReady = true;
  }
}
contentSel.addEventListener('change', applyContent);
$<HTMLInputElement>('mediaInput').addEventListener('change', async (e) => {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (!f) return;
  try {
    sender.setSource(await fileSource(f));
    contentReady = true;
  } catch {
    setupError.textContent = 'This file could not be played.';
    setupError.hidden = false;
  }
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function showCover(html: HTMLElement | string): void {
  if (typeof html === 'string') {
    const d = document.createElement('div');
    d.className = 'big';
    d.textContent = html;
    coverInner.replaceChildren(d);
  } else {
    coverInner.replaceChildren(html);
  }
  cover.hidden = false;
  label.hidden = true;
}

let waiting: ((a: 1 | 2) => void) | null = null;
function answer(a: 1 | 2): void {
  waiting?.(a);
}
$('ans1').addEventListener('click', () => answer(1));
$('ans2').addEventListener('click', () => answer(2));
document.addEventListener('keydown', (e) => {
  if (e.key === '1') answer(1);
  if (e.key === '2') answer(2);
});

async function playInterval(n: 1 | 2, modulated: boolean, amplitude: number, secs: number): Promise<void> {
  // Switch while the picture is covered, so the change itself is never seen.
  showCover(String(n));
  sender.mod.amplitude = amplitude;
  sender.mod.axis = axis;
  sender.modulate = modulated;
  await sleep(650);
  cover.hidden = true;
  label.textContent = n === 1 ? 'First' : 'Second';
  label.hidden = false;
  await sleep(secs * 1000);
}

async function run(): Promise<void> {
  setupError.hidden = true;
  const levels = $<HTMLInputElement>('levels')
    .value.split(/[,\s]+/)
    .map(Number)
    .filter((x) => Number.isFinite(x) && x > 0);
  if (!levels.length) {
    setupError.textContent = 'List at least one amplitude, for example 1, 2, 4.';
    setupError.hidden = false;
    return;
  }
  if (levels.some((x) => x > 9)) {
    setupError.textContent = 'Amplitudes above 9 % are refused: they would flicker visibly at a frequency that is unsafe for photosensitive viewers.';
    setupError.hidden = false;
    return;
  }
  if (!contentReady) await applyContent();
  const perLevel = Number($<HTMLSelectElement>('trialsSel').value);
  const secs = Number($<HTMLSelectElement>('secsSel').value);
  const preset = presetByKey(presetSel.value);
  sender.configure(preset, textPayload('Blind test payload. '.repeat(40)));
  sender.modulate = false;
  sender.start();

  const trials: Trial[] = [];
  for (const amplitude of levels) {
    for (let i = 0; i < perLevel; i++) {
      // Balanced: the signal is in each interval equally often per level.
      trials.push({ amplitude, signalIn: i % 2 === 0 ? 1 : 2, answer: null, correct: null, responseMs: null });
    }
  }
  for (let i = trials.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [trials[i], trials[j]] = [trials[j], trials[i]];
  }
  session = {
    startedAt: new Date().toISOString(),
    content: contentSel.options[contentSel.selectedIndex].text,
    preset: preset.key,
    axis,
    clipSeconds: secs,
    refreshHz: 0,
    screen: `${screen.width}x${screen.height} @${window.devicePixelRatio}x`,
    userAgent: navigator.userAgent,
    trials,
  };
  $('setup').querySelectorAll('select, input, button').forEach((el) => ((el as HTMLInputElement).disabled = true));

  for (let i = 0; i < trials.length; i++) {
    const t = trials[i];
    progress.textContent = `Trial ${i + 1} of ${trials.length}`;
    answerRow.hidden = true;
    await playInterval(1, t.signalIn === 1, t.amplitude / 100, secs);
    await playInterval(2, t.signalIn === 2, t.amplitude / 100, secs);
    sender.modulate = false;
    showCover('?');
    answerRow.hidden = false;
    const t0 = performance.now();
    const a = await new Promise<1 | 2>((resolve) => (waiting = resolve));
    waiting = null;
    t.answer = a;
    t.correct = a === t.signalIn;
    t.responseMs = Math.round(performance.now() - t0);
    session.refreshHz = sender.stats().refreshHz;
    render(session);
  }
  answerRow.hidden = true;
  progress.textContent = 'Finished.';
  sender.stop(true);
  history.push(session);
  try {
    localStorage.setItem(STORE, JSON.stringify(history.slice(-20)));
  } catch {
    /* storage unavailable: results stay on screen */
  }
  const done = document.createElement('div');
  done.className = 'ab-cover-inner';
  const h = document.createElement('h2');
  h.textContent = 'Done';
  const p = document.createElement('p');
  p.textContent = 'Your results are in the panel on the right. Download them to keep a record.';
  const again = document.createElement('button');
  again.className = 'primary';
  again.textContent = 'Run again';
  again.addEventListener('click', () => location.reload());
  done.append(h, p, again);
  showCover(done);
  $('setup').querySelectorAll('select, input, button').forEach((el) => ((el as HTMLInputElement).disabled = false));
}

/** Wilson score interval for a binomial proportion. */
function wilson(k: number, n: number): [number, number] {
  if (!n) return [0, 1];
  const z = 1.96;
  const p = k / n;
  const den = 1 + (z * z) / n;
  const mid = (p + (z * z) / (2 * n)) / den;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / den;
  return [Math.max(0, mid - half), Math.min(1, mid + half)];
}

function render(s: Session): void {
  const byLevel = new Map<number, { n: number; k: number }>();
  for (const t of s.trials) {
    if (t.correct === null) continue;
    const e = byLevel.get(t.amplitude) ?? { n: 0, k: 0 };
    e.n++;
    if (t.correct) e.k++;
    byLevel.set(t.amplitude, e);
  }
  const rows = [...byLevel.entries()].sort((a, b) => a[0] - b[0]);
  const tbody = $('table').querySelector('tbody')!;
  tbody.replaceChildren();
  for (const [amp, { n, k }] of rows) {
    const [lo, hi] = wilson(k, n);
    const tr = document.createElement('tr');
    for (const cell of [`${amp} %`, `${k}/${n}`, `${((100 * k) / n).toFixed(0)} %`, `${(lo * 100).toFixed(0)}–${(hi * 100).toFixed(0)} %`]) {
      const td = document.createElement('td');
      td.textContent = cell;
      tr.append(td);
    }
    tbody.append(tr);
  }
  $('table').hidden = rows.length === 0;
  $<HTMLButtonElement>('exportBtn').disabled = rows.length === 0;

  // Highest amplitude that scored 60 % or less while every lower one did too.
  let invisible: number | null = null;
  for (const [amp, { n, k }] of rows) {
    if (k / n <= 0.6) invisible = amp;
    else break;
  }
  const total = s.trials.filter((t) => t.correct !== null).length;
  const layout = makeLayout(presetByKey(s.preset));
  const minN = rows.length ? Math.min(...rows.map(([, v]) => v.n)) : 0;
  const verdict = $('verdict');
  if (total === 0) {
    verdict.textContent = '';
  } else if (total < s.trials.length && minN < 6) {
    // Too few answers to say anything yet; a verdict now would just be noise.
    verdict.textContent = `${total} of ${s.trials.length} trials answered.`;
  } else {
    const caveat = minN < 20 ? ` With ${minN} trial${minN === 1 ? '' : 's'} per level the interval is wide; treat this as a first look and repeat with 20.` : '';
    verdict.textContent =
      invisible === null
        ? `You picked the right clip more than 60 % of the time even at the lowest amplitude tested on this clip.${caveat}`
        : `Detection stays at or below 60 % up to ${invisible} % amplitude on “${s.content}” (${s.axis} axis). The ${s.preset} preset carries ${Math.round(layout.netBitsPerSecond)} bps when every packet arrives; whether a camera can decode at ${invisible} % is a separate measurement (see the README).${caveat}`;
  }
}

$('beginBtn').addEventListener('click', () => void run());
$('exportBtn').addEventListener('click', () => {
  const data = session ?? history[history.length - 1];
  if (!data) return;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  a.download = `ghost-channel-blind-test-${data.startedAt.slice(0, 19).replace(/[:T]/g, '-')}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 30_000);
});
$('clearBtn').addEventListener('click', () => {
  history = [];
  session = null;
  try {
    localStorage.removeItem(STORE);
  } catch {
    /* nothing stored */
  }
  $('table').hidden = true;
  $('verdict').textContent = 'Cleared.';
  $<HTMLButtonElement>('exportBtn').disabled = true;
});

void applyContent();
if (history.length) render(history[history.length - 1]);
