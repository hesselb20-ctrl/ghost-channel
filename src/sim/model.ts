// Analytic model of display x exposure x frame rate. It answers the design
// question "which temporal carrier survives a camera that undersamples it?"
// without running the pixel simulator.

export interface CarrierAnalysis {
  refreshHz: number;
  carrierHz: number;
  cameraFps: number;
  exposure: number;
  /** Frequency at which the carrier shows up in the camera's frame sequence. */
  aliasHz: number;
  /** aliasHz / (fps/2): 0 = lands on DC, 1 = lands on Nyquist. Both are bad. */
  aliasPos: number;
  /** Amplitude lost to the display holding each frame (zero-order hold). */
  holdGain: number;
  /** Amplitude lost to averaging over the exposure time. */
  exposureGain: number;
  /** Combined amplitude gain at the fundamental. */
  gain: number;
  /**
   * Worst case over the unknown display/camera phase of the measurable
   * amplitude, relative to `gain`. A complex (I/Q) estimate needs the alias to
   * sit away from DC and Nyquist; on them only one quadrature is visible and
   * the result depends on a phase nobody controls.
   */
  worstPhaseFactor: number;
  /** Display frames per carrier cycle. */
  framesPerCycle: number;
  usable: boolean;
  why: string;
}

const sinc = (x: number) => (Math.abs(x) < 1e-9 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x));

export function analyseCarrier(refreshHz: number, carrierHz: number, cameraFps: number, exposure: number): CarrierAnalysis {
  const k = Math.round(carrierHz / cameraFps);
  const aliasHz = Math.abs(carrierHz - k * cameraFps);
  const aliasPos = aliasHz / (cameraFps / 2);
  const holdGain = Math.abs(sinc(carrierHz / refreshHz));
  const exposureGain = Math.abs(sinc(carrierHz * exposure));
  const gain = holdGain * exposureGain;
  // Distance of the alias from the nearest degenerate point, as a fraction of
  // the half band. Within ~15 % of DC or Nyquist a short window cannot
  // separate the two quadratures (or the carrier from static content).
  const margin = Math.min(aliasPos, 1 - aliasPos);
  const worstPhaseFactor = margin < 1e-6 ? 0 : Math.min(1, margin / 0.3);
  const framesPerCycle = refreshHz / carrierHz;
  let usable = true;
  let why = 'ok';
  if (framesPerCycle < 2) {
    usable = false;
    why = 'above the display Nyquist rate';
  } else if (margin < 0.15) {
    usable = false;
    why = aliasPos < 0.5 ? 'aliases onto DC: indistinguishable from static content, phase-dependent nulls' : 'aliases onto Nyquist: one quadrature only';
  } else if (gain < 0.25) {
    usable = false;
    why = 'exposure averages the carrier away';
  }
  return { refreshHz, carrierHz, cameraFps, exposure, aliasHz, aliasPos, holdGain, exposureGain, gain, worstPhaseFactor, framesPerCycle, usable, why };
}

/**
 * Fraction of sensor rows on which a carrier that aliases to DC is attenuated
 * below `threshold` of its peak, for a box exposure. This is the "null band"
 * problem of plain complementary frame pairs seen by a camera at half the
 * refresh rate: the bands do not move unless the clocks drift.
 */
export function nullBandFraction(carrierHz: number, exposure: number, threshold: number): { fraction: number; peak: number } {
  const period = 1 / carrierHz;
  const n = 2000;
  let below = 0;
  let peak = 0;
  const vals = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    // Square carrier (+1/-1 per half period) averaged over [t, t+exposure].
    const t = (i / n) * period;
    let acc = 0;
    const steps = 200;
    for (let s = 0; s < steps; s++) {
      const tt = (t + ((s + 0.5) / steps) * exposure) % period;
      acc += tt < period / 2 ? 1 : -1;
    }
    vals[i] = Math.abs(acc / steps);
    peak = Math.max(peak, vals[i]);
  }
  if (peak < 1e-6) return { fraction: 1, peak: 0 };
  for (let i = 0; i < n; i++) if (vals[i] < threshold) below++;
  return { fraction: below / n, peak };
}
