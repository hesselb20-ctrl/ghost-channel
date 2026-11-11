// 3x3 projective transforms, row-major: [a b c; d e f; g h 1].

export type Mat3 = Float64Array;
export interface Pt {
  x: number;
  y: number;
}
/** Corners in grid order: top-left, top-right, bottom-right, bottom-left. */
export type Quad = [Pt, Pt, Pt, Pt];

/** Maps the unit square (0,0)-(1,0)-(1,1)-(0,1) onto `q`. */
export function squareToQuad(q: Quad): Mat3 {
  const [p0, p1, p2, p3] = q;
  const dx1 = p1.x - p2.x;
  const dx2 = p3.x - p2.x;
  const sx = p0.x - p1.x + p2.x - p3.x;
  const dy1 = p1.y - p2.y;
  const dy2 = p3.y - p2.y;
  const sy = p0.y - p1.y + p2.y - p3.y;
  const den = dx1 * dy2 - dx2 * dy1;
  const g = den !== 0 ? (sx * dy2 - dx2 * sy) / den : 0;
  const h = den !== 0 ? (dx1 * sy - sx * dy1) / den : 0;
  return Float64Array.from([
    p1.x - p0.x + g * p1.x,
    p3.x - p0.x + h * p3.x,
    p0.x,
    p1.y - p0.y + g * p1.y,
    p3.y - p0.y + h * p3.y,
    p0.y,
    g,
    h,
    1,
  ]);
}

export function applyH(m: Mat3, u: number, v: number): Pt {
  const w = m[6] * u + m[7] * v + m[8];
  return { x: (m[0] * u + m[1] * v + m[2]) / w, y: (m[3] * u + m[4] * v + m[5]) / w };
}

export function invertH(m: Mat3): Mat3 {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  const out = Float64Array.from([
    A,
    -(b * i - c * h),
    b * f - c * e,
    B,
    a * i - c * g,
    -(a * f - c * d),
    C,
    -(a * h - b * g),
    a * e - b * d,
  ]);
  for (let k = 0; k < 9; k++) out[k] /= det;
  return out;
}

export function quadArea(q: Quad): number {
  let a = 0;
  for (let i = 0; i < 4; i++) {
    const p = q[i];
    const n = q[(i + 1) & 3];
    a += p.x * n.y - n.x * p.y;
  }
  return Math.abs(a) / 2;
}

export function cloneQuad(q: Quad): Quad {
  return q.map((p) => ({ x: p.x, y: p.y })) as Quad;
}

/** Rotates corner order by `k` quarter turns (which physical corner is "top-left"). */
export function rotateQuad(q: Quad, k: number): Quad {
  const n = ((k % 4) + 4) % 4;
  return [q[n], q[(n + 1) & 3], q[(n + 2) & 3], q[(n + 3) & 3]];
}
