// JPEG-like intra-frame compression: YCbCr, 4:2:0 chroma, 8x8 DCT, standard
// quantisation tables scaled by quality. No entropy coding, since only the
// quantisation loss matters to the channel. This is a stand-in for the
// spatial part of a video codec; it has no motion compensation, so real
// inter-frame codecs are harsher on a temporal signal than this is.

const QY = [
  16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87,
  80, 62, 18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92,
  95, 98, 112, 100, 103, 99,
];
const QC = [
  17, 18, 24, 47, 99, 99, 99, 99, 18, 21, 26, 66, 99, 99, 99, 99, 24, 26, 56, 99, 99, 99, 99, 99, 47, 66, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99,
];

const COS = (() => {
  const c = new Float32Array(64);
  for (let u = 0; u < 8; u++) {
    const a = u === 0 ? Math.SQRT1_2 / 2 : 0.5;
    for (let x = 0; x < 8; x++) c[u * 8 + x] = a * Math.cos(((2 * x + 1) * u * Math.PI) / 16);
  }
  return c;
})();

function scaleTable(base: number[], quality: number): Float32Array {
  const q = Math.max(1, Math.min(100, quality));
  const s = q < 50 ? 5000 / q : 200 - 2 * q;
  const t = new Float32Array(64);
  for (let i = 0; i < 64; i++) t[i] = Math.max(1, Math.min(255, Math.floor((base[i] * s + 50) / 100)));
  return t;
}

function codePlane(plane: Float32Array, w: number, h: number, table: Float32Array): void {
  const blk = new Float32Array(64);
  const tmp = new Float32Array(64);
  for (let by = 0; by < h; by += 8) {
    for (let bx = 0; bx < w; bx += 8) {
      for (let y = 0; y < 8; y++) {
        const yy = Math.min(h - 1, by + y);
        for (let x = 0; x < 8; x++) blk[y * 8 + x] = plane[yy * w + Math.min(w - 1, bx + x)] - 128;
      }
      // Forward DCT (rows, then columns).
      for (let y = 0; y < 8; y++) {
        for (let u = 0; u < 8; u++) {
          let s = 0;
          for (let x = 0; x < 8; x++) s += COS[u * 8 + x] * blk[y * 8 + x];
          tmp[y * 8 + u] = s;
        }
      }
      for (let u = 0; u < 8; u++) {
        for (let v = 0; v < 8; v++) {
          let s = 0;
          for (let y = 0; y < 8; y++) s += COS[v * 8 + y] * tmp[y * 8 + u];
          blk[v * 8 + u] = Math.round(s / table[v * 8 + u]) * table[v * 8 + u];
        }
      }
      // Inverse.
      for (let u = 0; u < 8; u++) {
        for (let y = 0; y < 8; y++) {
          let s = 0;
          for (let v = 0; v < 8; v++) s += COS[v * 8 + y] * blk[v * 8 + u];
          tmp[y * 8 + u] = s;
        }
      }
      for (let y = 0; y < 8; y++) {
        const yy = by + y;
        if (yy >= h) break;
        for (let x = 0; x < 8; x++) {
          const xx = bx + x;
          if (xx >= w) break;
          let s = 0;
          for (let u = 0; u < 8; u++) s += COS[u * 8 + x] * tmp[y * 8 + u];
          plane[yy * w + xx] = s + 128;
        }
      }
    }
  }
}

/** Compresses and decompresses an RGBA image in place. */
export function jpegRoundTrip(rgba: Uint8ClampedArray, w: number, h: number, quality: number): void {
  const Y = new Float32Array(w * h);
  const cw = Math.ceil(w / 2);
  const ch = Math.ceil(h / 2);
  const Cb = new Float32Array(cw * ch);
  const Cr = new Float32Array(cw * ch);
  const cnt = new Float32Array(cw * ch);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const r = rgba[i];
      const g = rgba[i + 1];
      const b = rgba[i + 2];
      Y[y * w + x] = 0.299 * r + 0.587 * g + 0.114 * b;
      const c = (y >> 1) * cw + (x >> 1);
      Cb[c] += -0.168736 * r - 0.331264 * g + 0.5 * b + 128;
      Cr[c] += 0.5 * r - 0.418688 * g - 0.081312 * b + 128;
      cnt[c]++;
    }
  }
  for (let i = 0; i < Cb.length; i++) {
    Cb[i] /= cnt[i];
    Cr[i] /= cnt[i];
  }
  codePlane(Y, w, h, scaleTable(QY, quality));
  const tc = scaleTable(QC, quality);
  codePlane(Cb, cw, ch, tc);
  codePlane(Cr, cw, ch, tc);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const c = (y >> 1) * cw + (x >> 1);
      const yy = Y[y * w + x];
      const cb = Cb[c] - 128;
      const cr = Cr[c] - 128;
      rgba[i] = yy + 1.402 * cr;
      rgba[i + 1] = yy - 0.344136 * cb - 0.714136 * cr;
      rgba[i + 2] = yy + 1.772 * cb;
    }
  }
}
