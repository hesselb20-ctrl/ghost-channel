// Camera frames as the receiver sees them: two float planes plus a timestamp.

export interface Frame {
  w: number;
  h: number;
  /** (R + 2G + B) / 4, camera-encoded units 0..255. */
  luma: Float32Array;
  /** B - (R + G) / 2: blue-yellow opponent axis; zero for neutral greys. */
  chroma: Float32Array;
  /** Capture time in seconds (any epoch, monotonic). */
  t: number;
  /** Lazily built 3x3 box-filtered copies (see smoothPlane). */
  lumaS?: Float32Array;
  chromaS?: Float32Array;
}

/**
 * 3x3 box-filtered plane, cached on the frame. Point samples of this plane
 * are area averages, so a sparse sample lattice still uses every pixel of a
 * quadrant and gets the full noise averaging.
 */
export function smoothPlane(frame: Frame, name: PlaneName): Float32Array {
  const key = name === 'luma' ? 'lumaS' : 'chromaS';
  let s = frame[key];
  if (s) return s;
  const src = frame[name];
  const { w, h } = frame;
  const tmp = new Float32Array(src.length);
  s = new Float32Array(src.length);
  for (let y = 0; y < h; y++) {
    const o = y * w;
    tmp[o] = (2 * src[o] + src[o + 1]) / 3;
    for (let x = 1; x < w - 1; x++) tmp[o + x] = (src[o + x - 1] + src[o + x] + src[o + x + 1]) / 3;
    tmp[o + w - 1] = (src[o + w - 2] + 2 * src[o + w - 1]) / 3;
  }
  for (let x = 0; x < w; x++) {
    s[x] = (2 * tmp[x] + tmp[w + x]) / 3;
    s[(h - 1) * w + x] = (tmp[(h - 2) * w + x] + 2 * tmp[(h - 1) * w + x]) / 3;
  }
  for (let y = 1; y < h - 1; y++) {
    const o = y * w;
    for (let x = 0; x < w; x++) s[o + x] = (tmp[o - w + x] + tmp[o + x] + tmp[o + w + x]) / 3;
  }
  frame[key] = s;
  return s;
}

export type PlaneName = 'luma' | 'chroma';

export function rgbaToFrame(rgba: Uint8Array | Uint8ClampedArray, w: number, h: number, t: number): Frame {
  const n = w * h;
  const luma = new Float32Array(n);
  const chroma = new Float32Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const r = rgba[j];
    const g = rgba[j + 1];
    const b = rgba[j + 2];
    luma[i] = (r + 2 * g + b) * 0.25;
    chroma[i] = b - (r + g) * 0.5;
  }
  return { w, h, luma, chroma, t };
}

/**
 * Least-squares weights for fitting x[k] = DC + Re{ Z * exp(j*2*pi*f*t[k]) }.
 * With them, Z = sum((wr[k] + j*wi[k]) * x[k]). The fit uses the real sample
 * times, so uneven frame spacing and dropped frames are handled, and the DC
 * term removes static scene content exactly.
 */
export interface CarrierFit {
  ok: boolean;
  wr: Float64Array;
  wi: Float64Array;
  wdc: Float64Array;
  /** cos and -sin basis values per sample, for residual computation. */
  bc: Float64Array;
  bs: Float64Array;
  /** Noise gain: var(Re Z) + var(Im Z) for unit-variance samples. */
  noiseGain: number;
}

export function carrierFit(times: ArrayLike<number>, f: number, t0 = 0): CarrierFit {
  const n = times.length;
  const bc = new Float64Array(n);
  const bs = new Float64Array(n);
  const wr = new Float64Array(n);
  const wi = new Float64Array(n);
  const wdc = new Float64Array(n);
  const bad: CarrierFit = { ok: false, wr, wi, wdc, bc, bs, noiseGain: Infinity };
  if (n < 3) return bad;
  // Normal matrix of the basis [1, cos, -sin].
  let s1 = 0;
  let sc = 0;
  let ss = 0;
  let scc = 0;
  let sss = 0;
  let scs = 0;
  for (let k = 0; k < n; k++) {
    const ph = 2 * Math.PI * f * (times[k] - t0);
    const c = Math.cos(ph);
    const s = -Math.sin(ph);
    bc[k] = c;
    bs[k] = s;
    s1 += 1;
    sc += c;
    ss += s;
    scc += c * c;
    sss += s * s;
    scs += c * s;
  }
  // Symmetric 3x3 inverse.
  const a = s1;
  const b = sc;
  const c = ss;
  const d = scc;
  const e = scs;
  const g = sss;
  const A = d * g - e * e;
  const B = -(b * g - c * e);
  const C = b * e - c * d;
  const det = a * A + b * B + c * C;
  // A healthy fit has det ~ n^3/4; it collapses when the carrier aliases onto DC.
  if (!(Math.abs(det) > 0.005 * n * n * n)) return bad;
  const D = a * g - c * c;
  const E = -(a * e - b * c);
  const F = a * d - b * b;
  for (let k = 0; k < n; k++) {
    wdc[k] = (A + B * bc[k] + C * bs[k]) / det;
    wr[k] = (B + D * bc[k] + E * bs[k]) / det;
    wi[k] = (C + E * bc[k] + F * bs[k]) / det;
  }
  return { ok: true, wr, wi, wdc, bc, bs, noiseGain: (D + F) / det };
}
