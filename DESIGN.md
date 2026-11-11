# Ghost Channel: design

This document records the modulation scheme, why it was chosen over the alternatives, the frame format, the presets and the receiver pipeline. Every number in it comes from `npm run sim:model` or `npm run sim:sweep` unless it says otherwise. Nothing here has been measured on a physical phone yet; see the README for the split between simulator, browser loop-back and real-device results.

## 1. The scheme in one paragraph

The picture is divided into a grid of cells. Inside each cell a 2×2 checker of opposite signs is added to the content, and the whole checker is multiplied by a 20 Hz carrier whose **phase** carries the data (QPSK, two bits per cell per symbol). The excursion is proportional to the local pixel value (Weber contrast, typically 1–4 %), is applied in linear light, and by default runs along the blue–yellow axis with luminance held constant. On a 60 Hz display one carrier cycle is exactly three frames with weights that sum to zero, so every three frames average back to the original picture. A 30 fps camera undersamples the 20 Hz carrier into a 10 Hz beat; a three-parameter least-squares fit per cell (DC, in-phase, quadrature) recovers the complex amplitude, and pilots give the phase reference. Reed–Solomon protects each packet, a fountain code runs across packets.

## 2. Why this and not the alternatives

The build prompt lists three ways to get a fast flicker through a slow camera. All three were evaluated with the analytic model in `src/sim/model.ts`; the carrier choice was then confirmed with the pixel simulator and the real decoder.

### 2.1 Complementary frame pairs (+δ, −δ at 60 Hz) do not survive a 30 fps camera

A frame pair is a 30 Hz carrier. Sampled at 30 fps it aliases to 0 Hz: each sensor row sees a constant offset whose size and sign depend on where that row's exposure falls inside the pair. Three consequences:

| exposure | sensor rows left with under 30 % of the signal | best-case amplitude |
|---|---|---|
| 1/250 s | 7 % | 1.00 |
| 1/120 s | 15 % | 1.00 |
| 1/60 s | 30 % | 1.00 |
| 1/40 s | 44 % | 0.34 |
| 1/30 s | 100 % | 0.01 |

1. The rolling shutter turns the phase dependence into horizontal **null bands** across the image.
2. With display and camera clocks this close, the bands barely move (a 59.94 Hz panel against a 30.00 fps camera gives one pass every 33 s; two nominally equal clocks can sit still for minutes), so the same cells stay dead and no amount of fountain coding recovers them.
3. An offset at 0 Hz is indistinguishable from the content itself, so it can only be read against a neighbouring region, never against time.

The same happens to 60 Hz pairs on a 120 Hz display at both 30 and 60 fps.

### 2.2 A carrier that aliases to a third of the camera rate has no nulls

| display | carrier | camera | exposure | lands at | hold gain | exposure gain | total |
|---|---|---|---|---|---|---|---|
| 60 Hz | 30 Hz (pairs) | 30 fps | 1/100 s | 0 Hz | 0.64 | 0.86 | unusable: DC |
| 60 Hz | 20 Hz | 30 fps | 1/100 s | 10 Hz | 0.83 | 0.94 | 0.77 |
| 60 Hz | 20 Hz | 30 fps | 1/60 s | 10 Hz | 0.83 | 0.83 | 0.68 |
| 60 Hz | 20 Hz | 30 fps | 1/30 s | 10 Hz | 0.83 | 0.41 | 0.34 |
| 60 Hz | 15 Hz | 30 fps | any | 15 Hz | 0.90 | – | unusable: Nyquist, one quadrature only |
| 60 Hz | 20 Hz | 60 fps | 1/100 s | 20 Hz | 0.83 | 0.94 | 0.77 |
| 120 Hz | 40 Hz | 30 fps | 1/100 s | 10 Hz | 0.83 | 0.76 | 0.63 |
| 120 Hz | 40 Hz | 30 fps | 1/60 s | 10 Hz | 0.83 | 0.41 | 0.34 |
| 120 Hz | 20 Hz | 30 fps | 1/60 s | 10 Hz | 0.95 | 0.83 | 0.79 |

("Hold gain" is what the display's sample-and-hold costs at the carrier frequency; "exposure gain" is what averaging over the exposure costs.)

At 20 Hz the alias sits at a third of the camera rate, where three consecutive frames see the carrier at 0°, 240° and 120°. Both quadratures are observable, so the measured **amplitude does not depend on the unknown phase** between display and camera, only the measured phase does, and that is a smooth plane across the image (section 5). 20 Hz also keeps a third of its amplitude at a 1/30 s exposure, where pairs are gone.

Simulator check, same 16×9 grid, 200 ms symbols, colour axis at 4 %, grey content, 0.4 m, 30 fps, real transmitter and receiver:

| carrier | 1/100 s exposure | 1/40 s exposure |
|---|---|---|
| 30 Hz (frame pairs) | never locks | never locks |
| 25 Hz | decoded in 2.0 s, raw BER 0 | decoded in 2.0 s, raw BER 9e-4 |
| **20 Hz** | decoded in 2.0 s, raw BER 0 | decoded in 2.0 s, raw BER 0 |
| 15 Hz | never locks | never locks |
| 10 Hz | decoded in 2.0 s, raw BER 0 | decoded in 2.0 s, raw BER 0 |

20 Hz is the highest of the working carriers that is frame-locked on a 60 Hz panel (25 Hz needs 2.4 frames per cycle and no longer sums to zero over a whole number of frames). Higher is better for invisibility, so 20 Hz is the default; 40 Hz is offered for 120 Hz panels (`hfr`), 10 Hz only for exported video (`export`), where a 30 fps file cannot hold anything faster.

### 2.3 The rolling shutter as a data source

Reading stripes inside one camera frame needs a carrier period shorter than the readout time of one cell (about 1–2 ms), that is a carrier of several hundred hertz. A 60 Hz display cannot produce it. The rolling shutter is therefore handled, not exploited: it tilts the carrier phase linearly down the image, and the receiver fits and removes that tilt.

### 2.4 Zero-mean, as the prompt asks, with triplets instead of pairs

The requirement behind "pair every frame with a complementary frame" is that the time average equals the original. With a 20 Hz carrier on a 60 Hz panel the per-frame weights are `cos(2πn/3 + φ)`: for φ = 0 they are (+1, −½, −½), and for every φ they sum to zero over three frames (unit test: `every carrier cycle sums to zero on a 60 Hz display`). The symbol envelope is constant within a carrier cycle, so ramping at symbol edges does not break the zero sum.

## 3. Staying invisible

- **Weber-proportional amplitude in linear light.** `Δ = A · (pixel + floor)`; a 2 % setting moves a mid-grey by about half an 8-bit code value and white by about one. A triangular one-code dither keeps sub-code modulation correct on average.
- **Blue–yellow axis, luminance-neutral per pixel.** Blue goes up by `A·B`, red and green go down by just enough that `0.2126 R + 0.7152 G + 0.0722 B` is unchanged (unit test: `chroma modulation leaves luminance untouched and never clips`). The brightness axis is available for robustness.
- **Spatial cancellation.** The 2×2 checker inside every cell has zero mean, and data makes neighbouring cells differ in phase, so no area of the picture pulses as a whole. The checker falls smoothly to zero at every quadrant border (no hard grid lines).
- **Symmetric headroom.** Where a pixel is too close to black or white for the full excursion, the excursion is scaled down for both signs, never clipped on one side. Content is compressed to 1.5 %–98.5 % of the encoded range so that pure white and black keep a little room.
- **Display transfer.** Content is decoded with the sRGB curve (or a chosen power law), modified in linear light, and re-encoded, so +δ and −δ cancel in emitted light and not merely in code values.
- **Ramps.** The first and last carrier cycle of each symbol run at 70 % amplitude; starting and stopping a broadcast ramps over half a second.

The amplitude at which a viewer stops seeing it is an empirical question for the blind test page; it has not been measured (section 8).

## 4. Frame format

```
symbol   one grid frame, 200 ms (4 carrier cycles of 20 Hz)
           every cell: QPSK phase = data or pilot, plus a whole-grid rotation
packet   S consecutive symbols (S = 1, 2, 4 or 6 by preset)
           bytes = header(6) | fountain block | CRC-32(4), then Reed–Solomon
object   container(type, length, [name, mime], data, CRC-32), cut into K blocks
```

**Cells.** A cell is a pilot when `(col + 3·row) mod m = 0` (m = 7, 8 or 11). Pilots carry a fixed pseudo-random quadrant; the pattern does not map onto itself under a half turn, so it also tells the receiver which way up the screen is. All other cells carry data: Gray-coded QPSK (or BPSK in `export`).

**Preamble and timing without spending cells.** The whole grid is rotated by 90° at every symbol and by 180° at the first symbol of a packet. Every cell therefore changes at every symbol boundary (which is what symbol timing recovery needs) and packet starts are marked by the size of the jump in the pilot phase reference. There is no separate preamble interval, so a receiver can lock at any symbol.

**Header (6 bytes, in every packet).** Version (4 bits), preset id (4 bits), session id (8 bits, changes when the payload changes), K = number of fountain blocks (16 bits), packet sequence number (16 bits). The RS parameters follow from the preset id. Payload type and length live in the container, which is the first thing in the fountain-coded object.

**CRC-32** (IEEE) over header and block, in every packet. A second CRC-32 closes the container and is checked before anything is shown to the user.

**Reed–Solomon** over GF(2⁸) (polynomial 0x11d), written for this project, errors-and-erasures decoding. The demodulator passes a per-byte reliability; the decoder tries no erasures, then the weakest 50 % and 90 % of the parity budget as erasures. Bytes are whitened with a fixed sequence so uniform data does not make a uniform picture.

**Fountain code.** Up to 8 blocks: a carousel of the K blocks plus one XOR-of-all packet, any K of K+1 suffice. More than 8 blocks: LT code with a robust-soliton degree distribution (c = 0.1, δ = 0.5), neighbours derived from (K, session, sequence number). Decoding is incremental Gaussian elimination over GF(2) (maximum-likelihood), which wastes far fewer packets than belief propagation at these sizes. Measured with `node src/sim/run-micro.ts`, starting at a random point with 30 % of packets dropped: packets needed divided by K is 1.019 at K = 300, 1.014 at K = 781 (a 32 KB file on `dense`) and 1.003 at K = 2000. Small objects are less efficient: 1.19 at K = 12, 1.08 at K = 60.

## 5. Receiver pipeline

1. **Planes.** Each camera frame is downscaled (mipmapped, in a worker) and turned into two planes: luma `(R+2G+B)/4` and blue–yellow chroma `B − (R+G)/2`. The chroma plane is blind to neutral edges such as black text on white, which is where hand shake hurts most.
2. **Finding the screen without markers.** For every pixel of a reduced map, fit DC + carrier over the last five frames and compare carrier power with residual power. Only modulated pixels have a ratio above the noise-only value (0.67–0.89 depending on window length); moving or shaking scene content raises both and stays at the noise value. The outline of that region gives four corners. A second proposal comes from plain brightness (the lit screen), and a third from corner handles the user can drag.
3. **Locking the grid.** Summing a cell's four quadrants with the checker signs cancels everything that is smooth across the cell (brightness, auto-exposure drift, room-light flicker). The lock maximises the total checker-carrier energy over the corner positions: a shift-and-scale scan, a per-corner exhaustive search (±3 quadrants), then hill climbing.
4. **Alignment check with pilots.** The energy has near-equal maxima one cell away. The pilots are evaluated at each of the 25 nearby alignments; they must agree on one phase plane across six windows, with each pilot's magnitude clipped so that a few strong cells cannot fake agreement. On pure noise the score averages 0.28 (31 pilots), 0.36 (18 pilots) and 0.44 (12 pilots) and never exceeded 0.55 in 200 trials (`node src/sim/run-micro.ts`); a lock needs 0.6. The margin is thinnest for the 12-pilot grids.
5. **Symbol timing.** For 24 candidate boundary positions, fit every cell over guarded windows and score carrier power over residual. Frames that straddle a symbol change fit neither symbol; the score peaks where every window is clean.
6. **Demodulation.** Per symbol: least-squares fit per cell using the real frame timestamps (handles jitter and dropped frames), phase plane through the pilots (the rolling shutter and the display's own top-to-bottom scan tilt the phase across the grid), one decision-directed refit using all cells, then PSK slicing with a reliability per cell.
7. **Packets.** Rotation jumps mark packet starts until the first CRC passes; after that packet positions are kept by counting. Reed–Solomon with erasures, CRC-32, fountain decoder, container CRC.
8. **Tracking and recovery.** The grid is re-centred twice a second. A lock is released when the running pilot average stays below 0.6 (1.6 s once it has been healthy, 3 s for a new lock) or when seven packet times pass without a valid packet. Both allowances count received frames only, at most 0.1 s per frame, because a slow device skips frames while it acquires and the hole in the timestamps is not evidence of anything. A place that locked with doubtful pilots and delivered nothing is not retried for 12 s.
9. **Acquisition discipline.** A lock attempt needs at least four windows of consecutive frames (windows spanning a skipped frame are discarded), cells within 1.8:1 of square, and the expensive per-corner search runs only when the pilots do not already agree. These rules came out of running the deployed site in a second browser, not out of the simulator, whose frames never arrive late.

## 6. Presets

| preset | grid | pilots | modulation | carrier | symbol | packet | RS codeword (n, k) | block | net rate | 60 B link* | 32 KB file* |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `far` | 12×7 | 12 | QPSK | 20 Hz | 200 ms | 4 symbols, 72 B | (72, 44) | 34 B | 340 bps | 2.4 s | 12.9 min |
| `standard` | 16×9 | 18 | QPSK | 20 Hz | 200 ms | 2 symbols, 63 B | (63, 41) | 31 B | 620 bps | 1.2 s | 7.1 min |
| `dense` | 24×14 | 31 | QPSK | 20 Hz | 200 ms | 1 symbol, 76 B | (76, 52) | 42 B | 1680 bps | 0.4 s | 2.6 min |
| `fast` | 24×14 | 31 | QPSK | 20 Hz | 100 ms | 1 symbol, 76 B | (76, 52) | 42 B | 3360 bps | 0.2 s | 78 s |
| `export` | 12×7 | 12 | BPSK | 10 Hz | 400 ms | 6 symbols, 54 B | (54, 32) | 22 B | 73 bps | 9.6 s | 59.7 min |
| `hfr` | 16×9 | 18 | QPSK | 40 Hz | 200 ms | 2 symbols, 63 B | (63, 41) | 31 B | 620 bps | 1.2 s | 7.1 min |

\* Air time for exactly K packets with no loss and no acquisition delay. Regenerate with `node src/sim/print-presets.ts`.

`fast` needs a camera that really delivers 60 fps (at 30 fps a 100 ms symbol holds three frames, which leaves nothing to fit a residual against). `hfr` needs a 120 Hz or faster display and a short exposure (see the 40 Hz rows in section 2.2). `export` is the only preset whose carrier fits in a 30 fps video file; 10 Hz is visible.

## 7. The simulator

`src/sim/camera.ts` renders what a camera would see: a pinhole view of the screen at a given distance, yaw, pitch and roll; sample-and-hold display frames scanned top to bottom, with sluggish pixel response and optional dropped frames; a rolling shutter with a per-row box exposure integrated across the display frames it overlaps; lens blur; auto-exposure and white-balance drift; hand shake (slow drift plus tremor near 8–10 Hz); shot and read noise; gamma; optional JPEG-like compression; dropped camera frames; a camera clock that is off by 120 ppm with 0.5 ms timestamp jitter; and optional 100 Hz room-light flicker. The sender frames come from `renderFrame()` in `src/core/modmath.ts`, the CPU twin of the WebGL shader (checked in a browser: every pixel within one code value, the dither).

Default noise is 1.5 code values per pixel at mid-grey on a 640×360 frame, which corresponds to roughly 3 code values at 1280×720 before downscaling. That is on the pessimistic side for a phone in room light pointed at a bright screen.

What the simulator does not model: demosaicing and chroma subsampling in the camera, the camera's own temporal noise reduction (which would attenuate a temporal signal), lens distortion, moiré between the pixel grids, focus hunting, OLED PWM, and real auto-exposure dynamics. Those are the reasons the simulator results are not presented as device results.

## 8. What is still open

- **No physical device has been tested.** Milestones 2–5 of the brief need a phone and a screen in the same room.
- **The invisibility threshold is unmeasured.** It needs human viewers and the blind test page.
- **Dark content.** Proportional modulation leaves little signal on near-black pixels. In the simulator a dark scene decodes at 4 % on the brightness axis; the colour axis needs 8 % or the shadow-boost control (README, known limitations).
- **Strong room-light flicker with a short exposure** defeats automatic screen detection in the simulator; manual corner placement works.
