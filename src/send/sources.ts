// Content the modulation rides on: built-in demo scenes drawn with Canvas 2D,
// or any video / image / camera / screen-capture element.

import type { GhostRenderer } from './renderer.ts';
import type { ContentSource } from './sender.ts';

export type DemoKind = 'slide' | 'aurora' | 'portrait' | 'dark';

export const DEMO_LABELS: Record<DemoKind, string> = {
  slide: 'White slide',
  aurora: 'Colour field',
  portrait: 'Talking head (stand-in)',
  dark: 'Dark cinematic',
};

const W = 1280;
const H = 720;

function drawSlide(g: CanvasRenderingContext2D): void {
  g.fillStyle = '#fbfbfd';
  g.fillRect(0, 0, W, H);
  g.fillStyle = '#1d1d1f';
  g.font = '600 54px -apple-system, "SF Pro Display", "Segoe UI", system-ui, sans-serif';
  g.fillText('Quarterly review', 96, 150);
  g.font = '400 28px -apple-system, "SF Pro Text", "Segoe UI", system-ui, sans-serif';
  g.fillStyle = '#424245';
  const lines = [
    'Revenue grew 18 % on the same headcount',
    'Churn fell for the third quarter in a row',
    'Two enterprise pilots converted in March',
    'Next: self-serve onboarding, pricing page test',
  ];
  lines.forEach((t, i) => {
    g.fillStyle = '#0071e3';
    g.beginPath();
    g.arc(108, 232 + i * 62, 6, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#424245';
    g.fillText(t, 132, 242 + i * 62);
  });
  const bars = [0.35, 0.48, 0.44, 0.62, 0.71, 0.9];
  bars.forEach((v, i) => {
    g.fillStyle = i === bars.length - 1 ? '#0071e3' : '#d2d2d7';
    const bh = v * 250;
    const x = 800 + i * 62;
    g.beginPath();
    g.roundRect(x, 600 - bh, 42, bh, 8);
    g.fill();
  });
  g.fillStyle = '#86868b';
  g.font = '400 20px -apple-system, "Segoe UI", system-ui, sans-serif';
  g.fillText('Monthly active teams', 800, 640);
}

function drawAurora(g: CanvasRenderingContext2D, t: number): void {
  g.fillStyle = '#20233a';
  g.fillRect(0, 0, W, H);
  const blobs: [number, number, number, string][] = [
    [0.3 + 0.12 * Math.sin(t * 0.21), 0.4 + 0.1 * Math.cos(t * 0.17), 0.55, 'rgba(94, 132, 255, 0.85)'],
    [0.7 + 0.1 * Math.cos(t * 0.13), 0.35 + 0.12 * Math.sin(t * 0.19), 0.5, 'rgba(255, 122, 162, 0.75)'],
    [0.5 + 0.15 * Math.sin(t * 0.11 + 1), 0.75 + 0.08 * Math.cos(t * 0.23), 0.6, 'rgba(92, 220, 190, 0.7)'],
    [0.15 + 0.08 * Math.cos(t * 0.15), 0.8, 0.4, 'rgba(255, 196, 120, 0.6)'],
  ];
  g.globalCompositeOperation = 'lighter';
  for (const [x, y, r, col] of blobs) {
    const gr = g.createRadialGradient(x * W, y * H, 0, x * W, y * H, r * W);
    gr.addColorStop(0, col);
    gr.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = gr;
    g.fillRect(0, 0, W, H);
  }
  g.globalCompositeOperation = 'source-over';
}

function drawPortrait(g: CanvasRenderingContext2D, t: number): void {
  const room = g.createLinearGradient(0, 0, W, H);
  room.addColorStop(0, '#6f6a62');
  room.addColorStop(0.5, '#8d8478');
  room.addColorStop(1, '#5c574f');
  g.fillStyle = room;
  g.fillRect(0, 0, W, H);
  // Soft window light and a shelf, out of focus.
  const win = g.createRadialGradient(W * 0.82, H * 0.3, 0, W * 0.82, H * 0.3, W * 0.35);
  win.addColorStop(0, 'rgba(255, 240, 214, 0.75)');
  win.addColorStop(1, 'rgba(255, 240, 214, 0)');
  g.fillStyle = win;
  g.fillRect(0, 0, W, H);
  g.fillStyle = 'rgba(60, 52, 46, 0.5)';
  g.fillRect(0, H * 0.58, W * 0.3, 14);
  const sway = Math.sin(t * 1.3) * 8;
  const nod = Math.sin(t * 2.1) * 4;
  const cx = W * 0.5 + sway;
  const cy = H * 0.4 + nod;
  // Shoulders.
  g.fillStyle = '#34496b';
  g.beginPath();
  g.ellipse(cx, H * 1.02, H * 0.46, H * 0.36, 0, 0, Math.PI * 2);
  g.fill();
  // Neck and head.
  g.fillStyle = '#c99a80';
  g.fillRect(cx - 40, cy + 90, 80, 110);
  const skin = g.createRadialGradient(cx - 30, cy - 30, 10, cx, cy, H * 0.26);
  skin.addColorStop(0, '#e9bfa4');
  skin.addColorStop(1, '#b98468');
  g.fillStyle = skin;
  g.beginPath();
  g.ellipse(cx, cy, H * 0.17, H * 0.225, 0, 0, Math.PI * 2);
  g.fill();
  // Hair.
  g.fillStyle = '#3a2a22';
  g.beginPath();
  g.ellipse(cx, cy - H * 0.13, H * 0.18, H * 0.12, 0, Math.PI, 0);
  g.fill();
  // Eyes and a mouth that opens and closes.
  g.fillStyle = '#2b2320';
  const blink = Math.sin(t * 0.9) > 0.97 ? 0.2 : 1;
  g.beginPath();
  g.ellipse(cx - 48, cy - 14, 9, 6 * blink, 0, 0, Math.PI * 2);
  g.ellipse(cx + 48, cy - 14, 9, 6 * blink, 0, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#7c2f36';
  const open = 4 + 10 * Math.abs(Math.sin(t * 7.3) * Math.sin(t * 1.7));
  g.beginPath();
  g.ellipse(cx, cy + 78, 30, open, 0, 0, Math.PI * 2);
  g.fill();
}

let grain: HTMLCanvasElement | null = null;
function drawDark(g: CanvasRenderingContext2D, t: number): void {
  g.fillStyle = '#05060a';
  g.fillRect(0, 0, W, H);
  const lx = W * (0.32 + 0.22 * Math.sin(t * 0.25));
  const glow = g.createRadialGradient(lx, H * 0.46, 0, lx, H * 0.46, W * 0.32);
  glow.addColorStop(0, 'rgba(255, 170, 96, 0.34)');
  glow.addColorStop(0.4, 'rgba(120, 70, 44, 0.16)');
  glow.addColorStop(1, 'rgba(0, 0, 0, 0)');
  g.fillStyle = glow;
  g.fillRect(0, 0, W, H);
  // Skyline silhouette.
  g.fillStyle = '#020204';
  for (let i = 0; i < 18; i++) {
    const bw = 40 + ((i * 53) % 60);
    const bh = 80 + ((i * 97) % 170);
    g.fillRect(i * 74 - 10, H * 0.86 - bh, bw, bh);
  }
  g.fillStyle = 'rgba(8, 10, 22, 1)';
  g.fillRect(0, H * 0.86, W, H * 0.14);
  // Film grain, pre-rendered once and jittered.
  if (!grain) {
    grain = document.createElement('canvas');
    grain.width = 256;
    grain.height = 256;
    const gg = grain.getContext('2d')!;
    const id = gg.createImageData(256, 256);
    for (let i = 0; i < id.data.length; i += 4) {
      const v = Math.random() * 255;
      id.data[i] = v;
      id.data[i + 1] = v;
      id.data[i + 2] = v;
      id.data[i + 3] = 14;
    }
    gg.putImageData(id, 0, 0);
  }
  const f = Math.floor(t * 24);
  const ox = (f * 71) % 256;
  const oy = (f * 113) % 256;
  for (let y = -oy; y < H; y += 256) for (let x = -ox; x < W; x += 256) g.drawImage(grain, x, y);
  // Letterbox bars.
  g.fillStyle = '#000';
  g.fillRect(0, 0, W, H * 0.09);
  g.fillRect(0, H * 0.91, W, H * 0.09);
}

/** Built-in scene. Animated scenes repaint at 30 fps, the slide only once. */
export class DemoSource implements ContentSource {
  readonly canvas: HTMLCanvasElement;
  private readonly g: CanvasRenderingContext2D;
  private readonly kind: DemoKind;
  private lastPaint = -1;

  constructor(kind: DemoKind) {
    this.kind = kind;
    this.canvas = document.createElement('canvas');
    this.canvas.width = W;
    this.canvas.height = H;
    this.g = this.canvas.getContext('2d', { alpha: false })!;
  }

  update(renderer: GhostRenderer, tSec: number): void {
    const step = this.kind === 'slide' ? 0 : Math.floor(tSec * 30);
    if (step === this.lastPaint) return;
    this.lastPaint = step;
    const g = this.g;
    if (this.kind === 'slide') drawSlide(g);
    else if (this.kind === 'aurora') drawAurora(g, tSec);
    else if (this.kind === 'portrait') drawPortrait(g, tSec);
    else drawDark(g, tSec);
    renderer.setContent(this.canvas, W, H);
  }
}

/** Any element the browser can upload as a texture. */
export class ElementSource implements ContentSource {
  private readonly el: HTMLVideoElement | HTMLImageElement | HTMLCanvasElement;
  private readonly cleanup: (() => void) | null;
  private uploadedStill = false;
  private lastTime = -1;

  constructor(el: HTMLVideoElement | HTMLImageElement | HTMLCanvasElement, cleanup: (() => void) | null = null) {
    this.el = el;
    this.cleanup = cleanup;
  }

  update(renderer: GhostRenderer): void {
    const el = this.el;
    if (el instanceof HTMLVideoElement) {
      if (el.readyState < 2 || !el.videoWidth) return;
      // Live streams keep currentTime moving; files may be paused.
      if (el.currentTime === this.lastTime && !el.srcObject) return;
      this.lastTime = el.currentTime;
      renderer.setContent(el, el.videoWidth, el.videoHeight);
    } else if (el instanceof HTMLImageElement) {
      if (this.uploadedStill || !el.complete || !el.naturalWidth) return;
      renderer.setContent(el, el.naturalWidth, el.naturalHeight);
      this.uploadedStill = true;
    } else {
      renderer.setContent(el, el.width, el.height);
    }
  }

  dispose(): void {
    this.cleanup?.();
  }
}

function stopStream(stream: MediaStream): void {
  for (const t of stream.getTracks()) t.stop();
}

function videoFor(stream: MediaStream): Promise<HTMLVideoElement> {
  const v = document.createElement('video');
  v.muted = true;
  v.playsInline = true;
  v.srcObject = stream;
  return v.play().then(() => v);
}

export async function fileSource(file: File): Promise<ContentSource> {
  const url = URL.createObjectURL(file);
  if (file.type.startsWith('video/')) {
    const v = document.createElement('video');
    v.muted = true;
    v.loop = true;
    v.playsInline = true;
    v.src = url;
    await v.play();
    return new ElementSource(v, () => {
      v.pause();
      URL.revokeObjectURL(url);
    });
  }
  const img = new Image();
  img.src = url;
  await img.decode();
  return new ElementSource(img, () => URL.revokeObjectURL(url));
}

/** Screen, window or tab capture, for wrapping a presentation. */
export async function screenSource(): Promise<ContentSource> {
  if (!navigator.mediaDevices?.getDisplayMedia) throw new Error('Screen capture is not available in this browser (iOS Safari does not offer it).');
  const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: false });
  const v = await videoFor(stream);
  return new ElementSource(v, () => stopStream(stream));
}

export async function webcamSource(): Promise<ContentSource> {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('Camera access needs HTTPS (or localhost).');
  const stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' }, audio: false });
  const v = await videoFor(stream);
  return new ElementSource(v, () => stopStream(stream));
}
