// WebGL2 renderer: content frame in, content + modulation out.
// The fragment shader is the GLSL twin of core/modmath.ts renderFrame();
// keep the two in step.

import type { ModParams } from '../core/modmath.ts';

const VERT = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() {
  // vUv has its origin at the top-left, like image rows.
  vUv = vec2(aPos.x * 0.5 + 0.5, 0.5 - aPos.y * 0.5);
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const FRAG = `#version 300 es
precision highp float;
precision highp int;
in vec2 vUv;
out vec4 outColor;

uniform sampler2D uContent;
uniform sampler2D uCells;
uniform vec2 uGrid;        // cols, rows
uniform vec4 uFit;         // content uv = vUv * uFit.xy + uFit.zw
uniform float uPhase;      // 2*pi*carrier*t, wrapped
uniform float uEnv;        // symbol envelope times global fade
uniform float uAmp;
uniform float uAxis;       // 0 luma, 1 chroma
uniform float uFloor;
uniform float uSoft;
uniform float uRange;
uniform float uGamma;      // 0 = sRGB
uniform float uFrame;
uniform float uShowGrid;   // debug overlay

const float PI = 3.14159265358979;
const vec3 LUM = vec3(0.2126, 0.7152, 0.0722);

vec3 decodeDisplay(vec3 c) {
  if (uGamma > 0.0) return pow(c, vec3(uGamma));
  vec3 lo = c / 12.92;
  vec3 hi = pow((c + 0.055) / 1.055, vec3(2.4));
  return mix(lo, hi, step(vec3(0.04045), c));
}
vec3 encodeDisplay(vec3 c) {
  if (uGamma > 0.0) return pow(c, vec3(1.0 / uGamma));
  vec3 lo = c * 12.92;
  vec3 hi = 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055;
  return mix(lo, hi, step(vec3(0.0031308), c));
}
// One axis of the in-cell checker: + on the first half, - on the second,
// falling smoothly to zero at every quadrant border.
float pattern1(float f) {
  float s = sin(2.0 * PI * f);
  float t = clamp(abs(s) / max(uSoft, 1e-3), 0.0, 1.0);
  return sign(s) * t * t * (3.0 - 2.0 * t);
}
float hash(vec3 p) {
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yzx + 33.33);
  return fract((p.x + p.y) * p.z);
}

void main() {
  vec2 cuv = vUv * uFit.xy + uFit.zw;
  vec3 c = vec3(0.0);
  if (cuv.x >= 0.0 && cuv.x <= 1.0 && cuv.y >= 0.0 && cuv.y <= 1.0) c = texture(uContent, cuv).rgb;
  // Leave headroom at both ends so white and black can still carry signal.
  c = uRange + c * (1.0 - 2.0 * uRange);
  vec3 lin = decodeDisplay(c);

  vec2 g = vUv * uGrid;
  vec2 cell = min(floor(g), uGrid - 1.0);
  vec2 f = g - cell;
  float q = floor(texelFetch(uCells, ivec2(cell), 0).r * 255.0 + 0.5);
  float wave = uEnv * cos(uPhase + 0.5 * PI * q);
  float m = pattern1(f.x) * pattern1(f.y) * wave;

  // Peak excursion in linear light, proportional to the pixel (Weber).
  vec3 base = lin + uFloor;
  vec3 d;
  if (uAxis < 0.5) {
    d = uAmp * base;
  } else {
    // Blue up; red and green down by just enough to keep luminance constant.
    float db = uAmp * base.b;
    float k = LUM.b * db / (LUM.r * base.r + LUM.g * base.g);
    d = vec3(-k * base.r, -k * base.g, db);
  }
  // Scale down symmetrically where the pixel lacks room, so +d and -d cancel.
  vec3 room = min(lin, 1.0 - lin);
  vec3 ad = abs(d);
  float s = 1.0;
  if (ad.r > room.r) s = min(s, room.r / ad.r);
  if (ad.g > room.g) s = min(s, room.g / ad.g);
  if (ad.b > room.b) s = min(s, room.b / ad.b);
  s = max(s, 0.0);

  vec3 o = encodeDisplay(clamp(lin + m * s * d, 0.0, 1.0));
  if (uShowGrid > 0.5) {
    vec2 e = min(f, 1.0 - f) * uGrid;
    if (min(e.x, e.y) < 0.03 * max(uGrid.x, uGrid.y) / 16.0) o = mix(o, vec3(1.0, 0.2, 0.6), 0.5);
  }
  // Triangular dither of one code value so that sub-LSB modulation survives
  // 8-bit quantisation on average.
  vec2 px = gl_FragCoord.xy;
  vec3 n = vec3(
    hash(vec3(px, uFrame)) + hash(vec3(px + 17.0, uFrame + 3.0)),
    hash(vec3(px + 31.0, uFrame + 7.0)) + hash(vec3(px + 53.0, uFrame + 11.0)),
    hash(vec3(px + 71.0, uFrame + 13.0)) + hash(vec3(px + 97.0, uFrame + 17.0))) * 0.5 - 0.5;
  outColor = vec4(o + n / 255.0, 1.0);
}`;

export type Fit = 'cover' | 'contain' | 'stretch';

export interface DrawState {
  /** Carrier phase in radians. */
  phase: number;
  env: number;
  frame: number;
  mod: ModParams;
  fit: Fit;
  showGrid?: boolean;
}

export class GhostRenderer {
  readonly gl: WebGL2RenderingContext;
  private readonly prog: WebGLProgram;
  private readonly u: Record<string, WebGLUniformLocation | null> = {};
  private readonly contentTex: WebGLTexture;
  private readonly cellTex: WebGLTexture;
  private cols = 1;
  private rows = 1;
  private contentW = 1;
  private contentH = 1;
  lost = false;

  constructor(canvas: HTMLCanvasElement | OffscreenCanvas) {
    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: false,
    }) as WebGL2RenderingContext | null;
    if (!gl) throw new Error('WebGL2 is not available in this browser');
    this.gl = gl;
    const compile = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('shader: ' + gl.getShaderInfoLog(s));
      return s;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error('link: ' + gl.getProgramInfoLog(prog));
    this.prog = prog;
    gl.useProgram(prog);
    for (const name of ['uContent', 'uCells', 'uGrid', 'uFit', 'uPhase', 'uEnv', 'uAmp', 'uAxis', 'uFloor', 'uSoft', 'uRange', 'uGamma', 'uFrame', 'uShowGrid']) {
      this.u[name] = gl.getUniformLocation(prog, name);
    }
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'aPos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    this.contentTex = gl.createTexture()!;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.contentTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([128, 128, 128, 255]));

    this.cellTex = gl.createTexture()!;
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.cellTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, 1, 1, 0, gl.RED, gl.UNSIGNED_BYTE, new Uint8Array([0]));
    gl.uniform1i(this.u.uContent, 0);
    gl.uniform1i(this.u.uCells, 1);

    const c = canvas as HTMLCanvasElement;
    if (typeof c.addEventListener === 'function') {
      c.addEventListener('webglcontextlost', (e) => {
        e.preventDefault();
        this.lost = true;
      });
    }
  }

  /** Quadrant index (0..3) per grid cell for the current symbol. */
  setCells(cols: number, rows: number, q: Uint8Array): void {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.cellTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    if (cols !== this.cols || rows !== this.rows) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, cols, rows, 0, gl.RED, gl.UNSIGNED_BYTE, q);
      this.cols = cols;
      this.rows = rows;
    } else {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, cols, rows, gl.RED, gl.UNSIGNED_BYTE, q);
    }
  }

  setContent(src: TexImageSource, w: number, h: number): void {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.contentTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
    this.contentW = Math.max(1, w);
    this.contentH = Math.max(1, h);
  }

  /** Raw RGB(A) bytes as content; used by the CPU-parity self-check. */
  setContentBytes(rgba: Uint8Array, w: number, h: number): void {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.contentTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
    this.contentW = w;
    this.contentH = h;
  }

  draw(s: DrawState): void {
    const gl = this.gl;
    const W = gl.drawingBufferWidth;
    const H = gl.drawingBufferHeight;
    gl.viewport(0, 0, W, H);
    gl.useProgram(this.prog);
    const ca = this.contentW / this.contentH;
    const va = W / H;
    let sx = 1;
    let sy = 1;
    if (s.fit === 'cover') {
      if (ca > va) sx = va / ca;
      else sy = ca / va;
    } else if (s.fit === 'contain') {
      if (ca > va) sy = ca / va;
      else sx = va / ca;
    }
    gl.uniform4f(this.u.uFit, sx, sy, (1 - sx) / 2, (1 - sy) / 2);
    gl.uniform2f(this.u.uGrid, this.cols, this.rows);
    gl.uniform1f(this.u.uPhase, s.phase);
    gl.uniform1f(this.u.uEnv, s.env);
    gl.uniform1f(this.u.uAmp, s.mod.amplitude);
    gl.uniform1f(this.u.uAxis, s.mod.axis === 'luma' ? 0 : 1);
    gl.uniform1f(this.u.uFloor, s.mod.floor);
    gl.uniform1f(this.u.uSoft, s.mod.softness);
    gl.uniform1f(this.u.uRange, s.mod.rangeCompress);
    gl.uniform1f(this.u.uGamma, s.mod.displayGamma);
    gl.uniform1f(this.u.uFrame, s.frame % 4096);
    gl.uniform1f(this.u.uShowGrid, s.showGrid ? 1 : 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  /** Top row first, RGBA. Must be called right after draw(). */
  readPixels(): Uint8Array {
    const gl = this.gl;
    const W = gl.drawingBufferWidth;
    const H = gl.drawingBufferHeight;
    const raw = new Uint8Array(W * H * 4);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, raw);
    const out = new Uint8Array(W * H * 4);
    for (let y = 0; y < H; y++) out.set(raw.subarray((H - 1 - y) * W * 4, (H - y) * W * 4), y * W * 4);
    return out;
  }
}
