// Reed–Solomon over GF(2^8), written from scratch.
// Field: primitive polynomial x^8+x^4+x^3+x^2+1 (0x11d), generator alpha = 2.
// Code: systematic, first consecutive root alpha^0, n <= 255.
// Decoder: syndromes -> erasure locator -> Forney syndromes -> Berlekamp–Massey
// -> Chien search -> Forney magnitudes. Corrects e errors and f erasures
// whenever 2e + f <= parity.

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

export function gfMul(a: number, b: number): number {
  return a && b ? EXP[LOG[a] + LOG[b]] : 0;
}
function gfDiv(a: number, b: number): number {
  if (!b) throw new Error('GF division by zero');
  return a ? EXP[LOG[a] + 255 - LOG[b]] : 0;
}
function gfPow(e: number): number {
  return EXP[((e % 255) + 255) % 255];
}

const GEN_CACHE = new Map<number, Uint8Array>();
/** Generator polynomial, highest degree first, length parity + 1. */
function generator(parity: number): Uint8Array {
  const hit = GEN_CACHE.get(parity);
  if (hit) return hit;
  let g: Uint8Array = new Uint8Array([1]);
  for (let i = 0; i < parity; i++) {
    const next: Uint8Array = new Uint8Array(g.length + 1);
    const root = EXP[i];
    for (let j = 0; j < g.length; j++) {
      next[j] ^= g[j];
      next[j + 1] ^= gfMul(g[j], root);
    }
    g = next;
  }
  GEN_CACHE.set(parity, g);
  return g;
}

/** Returns data followed by `parity` check bytes. */
export function rsEncode(data: Uint8Array, parity: number): Uint8Array {
  const n = data.length + parity;
  if (n > 255) throw new Error(`RS codeword too long: ${n}`);
  const out = new Uint8Array(n);
  out.set(data);
  if (parity === 0) return out;
  const g = generator(parity);
  const rem = new Uint8Array(parity);
  for (let i = 0; i < data.length; i++) {
    const fb = data[i] ^ rem[0];
    rem.copyWithin(0, 1);
    rem[parity - 1] = 0;
    if (fb) for (let j = 0; j < parity; j++) rem[j] ^= gfMul(g[j + 1], fb);
  }
  out.set(rem, data.length);
  return out;
}

function syndromes(cw: Uint8Array, parity: number): { s: Uint8Array; clean: boolean } {
  const s = new Uint8Array(parity);
  let clean = true;
  for (let i = 0; i < parity; i++) {
    const a = EXP[i];
    let v = 0;
    for (let j = 0; j < cw.length; j++) v = gfMul(v, a) ^ cw[j];
    s[i] = v;
    if (v) clean = false;
  }
  return { s, clean };
}

export interface RsResult {
  ok: boolean;
  /** Number of byte positions changed (errors + filled erasures that differed). */
  corrected: number;
}

/**
 * Corrects `cw` in place. `erasures` are byte positions (0 = first byte) that
 * the demodulator flagged as unreliable.
 */
export function rsDecode(cw: Uint8Array, parity: number, erasures: number[] = []): RsResult {
  const n = cw.length;
  if (parity === 0) return { ok: true, corrected: 0 };
  if (erasures.length > parity) return { ok: false, corrected: 0 };
  const { s, clean } = syndromes(cw, parity);
  if (clean) return { ok: true, corrected: 0 };

  // Polynomials below are lowest degree first.
  // Erasure locator: product of (1 - X_k x), X_k = alpha^(n-1-pos).
  let gamma = new Uint8Array([1]);
  for (const pos of erasures) {
    const X = gfPow(n - 1 - pos);
    const next = new Uint8Array(gamma.length + 1);
    for (let j = 0; j < gamma.length; j++) {
      next[j] ^= gamma[j];
      next[j + 1] ^= gfMul(gamma[j], X);
    }
    gamma = next;
  }
  const f = erasures.length;

  // Forney (modified) syndromes: xi = gamma * S mod x^parity. Entries f..parity-1
  // obey the recurrence of the pure-error locator.
  const xi = new Uint8Array(parity);
  for (let i = 0; i < parity; i++) {
    let v = 0;
    for (let j = 0; j <= Math.min(i, f); j++) v ^= gfMul(gamma[j], s[i - j]);
    xi[i] = v;
  }

  // Berlekamp–Massey on xi[f..].
  const N = parity - f;
  let C = new Uint8Array(N + 2);
  let B = new Uint8Array(N + 2);
  C[0] = 1;
  B[0] = 1;
  let L = 0;
  let m = 1;
  let b = 1;
  for (let i = 0; i < N; i++) {
    let d = xi[f + i];
    for (let j = 1; j <= L; j++) d ^= gfMul(C[j], xi[f + i - j]);
    if (d === 0) {
      m++;
    } else {
      const coef = gfDiv(d, b);
      if (2 * L <= i) {
        const T = C.slice();
        for (let j = 0; j + m < C.length; j++) C[j + m] ^= gfMul(coef, B[j]);
        L = i + 1 - L;
        B = T;
        b = d;
        m = 1;
      } else {
        for (let j = 0; j + m < C.length; j++) C[j + m] ^= gfMul(coef, B[j]);
        m++;
      }
    }
  }
  if (2 * L > N) return { ok: false, corrected: 0 };

  // Errata locator psi = lambda * gamma.
  const psi = new Uint8Array(L + f + 1);
  for (let i = 0; i <= L; i++) {
    if (!C[i]) continue;
    for (let j = 0; j <= f; j++) psi[i + j] ^= gfMul(C[i], gamma[j]);
  }
  const degPsi = L + f;

  // Chien search over the n codeword positions.
  const positions: number[] = [];
  for (let pos = 0; pos < n; pos++) {
    const xinv = gfPow(-(n - 1 - pos));
    let v = 0;
    for (let j = degPsi; j >= 0; j--) v = gfMul(v, xinv) ^ psi[j];
    if (v === 0) positions.push(pos);
  }
  if (positions.length !== degPsi) return { ok: false, corrected: 0 };

  // Evaluator omega = S * psi mod x^parity.
  const omega = new Uint8Array(parity);
  for (let i = 0; i < parity; i++) {
    let v = 0;
    for (let j = 0; j <= Math.min(i, degPsi); j++) v ^= gfMul(psi[j], s[i - j]);
    omega[i] = v;
  }

  let corrected = 0;
  for (const pos of positions) {
    const X = gfPow(n - 1 - pos);
    const xinv = gfPow(-(n - 1 - pos));
    let om = 0;
    for (let j = parity - 1; j >= 0; j--) om = gfMul(om, xinv) ^ omega[j];
    // Formal derivative of psi at xinv: only odd-degree terms survive in GF(2^m).
    let der = 0;
    for (let j = 1; j <= degPsi; j += 2) der ^= gfMul(psi[j], gfPow(-(n - 1 - pos) * (j - 1)));
    if (der === 0) return { ok: false, corrected: 0 };
    const mag = gfMul(X, gfDiv(om, der));
    if (mag) {
      cw[pos] ^= mag;
      corrected++;
    }
  }
  if (!syndromes(cw, parity).clean) return { ok: false, corrected };
  return { ok: true, corrected };
}
