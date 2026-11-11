// End-to-end: real transmitter -> simulated display and rolling-shutter
// camera -> real receiver. Small and quick on purpose; the full sweep lives in
// src/sim/run-sweep.ts.

import { describe, expect, it } from 'vitest';
import { urlPayload } from '../src/core/container.ts';
import { analyseCarrier } from '../src/sim/model.ts';
import { runTrial } from '../src/sim/trial.ts';

describe('simulated camera channel', () => {
  it('decodes a link at arm’s length on the colour axis', () => {
    const url = 'https://example.org/a/fairly/ordinary/link?with=query&and=more';
    const r = runTrial({ preset: 'standard', content: 'slide', mod: { amplitude: 0.04, axis: 'chroma' }, payload: urlPayload(url), maxSeconds: 6, seed: 4 });
    expect(r.decoded).toBe(true);
    expect(r.payloadOk).toBe(true);
    expect(r.tDecode!).toBeLessThan(5);
    expect(r.presetDetected).toBe('standard');
  });

  it('decodes off-axis with hand shake on the brightness axis', () => {
    const r = runTrial({
      preset: 'far',
      content: 'talking',
      mod: { amplitude: 0.08, axis: 'luma' },
      camera: { yawDeg: 30, shakePx: 3 },
      payloadBytes: 60,
      maxSeconds: 8,
      seed: 9,
    });
    expect(r.decoded).toBe(true);
    expect(r.payloadOk).toBe(true);
  });

  it('does not invent data when nothing is being sent', () => {
    const r = runTrial({ preset: 'standard', content: 'talking', mod: { amplitude: 0 }, payloadBytes: 60, maxSeconds: 4, seed: 2 });
    expect(r.decoded).toBe(false);
    expect(r.packetsOk).toBe(0);
  });
});

describe('carrier model', () => {
  it('rejects frame pairs for a 30 fps camera and accepts 20 Hz', () => {
    expect(analyseCarrier(60, 30, 30, 1 / 100).usable).toBe(false);
    expect(analyseCarrier(60, 15, 30, 1 / 100).usable).toBe(false);
    expect(analyseCarrier(60, 20, 30, 1 / 100).usable).toBe(true);
    expect(analyseCarrier(60, 20, 60, 1 / 100).usable).toBe(true);
    expect(analyseCarrier(120, 40, 30, 1 / 100).usable).toBe(true);
    expect(analyseCarrier(120, 60, 30, 1 / 100).usable).toBe(false);
  });
});
