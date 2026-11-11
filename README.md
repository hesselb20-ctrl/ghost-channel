# Ghost Channel

An invisible QR code. Ghost Channel hides a link, a message or a small file inside whatever a screen is showing, using colour changes too small and too fast to notice. A phone pointed at the screen reads the data through an ordinary web page. Sender and receiver both run in the browser: no app, no backend, no accounts, no paid services.

- **Send** (`/send/`): pick a message and a picture (demo scene, image, video, a shared screen or a webcam) and start broadcasting.
- **Receive** (`/receive/`): point the rear camera at the screen. A ring fills as packets arrive; links open only after you tap.
- **Blind test** (`/abtest/`): find the amplitude at which you can no longer tell a modulated clip from a clean one.
- The landing page (`/`) is itself broadcasting a message from its hero picture.

## Status, honestly

| | Where it has been verified |
|---|---|
| Codecs: CRC-32, Reed–Solomon with erasures, fountain code, framing | 21 unit tests on a perfect channel |
| Modulation and the full receiver | A simulated rolling-shutter camera (`src/sim`), running the real transmitter and the real decoder |
| Browser build: WebGL2 sender, camera pipeline, worker, decoder | Loop-back in desktop Chromium: the sender's canvas is captured as a video stream and fed to the receiver |
| WebGL shader equals the simulator's renderer | Compared in the browser: every pixel within one code value (the dither) |
| Survival of video compression | Real H.264 and VP9 via ffmpeg, decoder fed the decoded frames |
| **A phone pointed at a screen** | **Not done.** No phone was available to the build. Milestones 2–5 of the brief are verified in the simulator only |
| **Invisibility to people** | **Not measured.** The blind-test page exists; nobody has taken it yet |

All numbers are in [RESULTS.md](RESULTS.md), each labelled with where it came from. The design and the reasoning behind it are in [DESIGN.md](DESIGN.md).

## Run it

```bash
npm install
```

```bash
npm run dev
```

Open the printed address. `/receive/` has a **Self-test without a camera** button that runs the real sender and receiver against each other inside one tab; it is the quickest check that a browser can do everything the receiver needs.

```bash
npm test
```

```bash
npm run build
```

`dist/` is a plain static site with relative paths. The included workflow (`.github/workflows/pages.yml`) builds and publishes it to GitHub Pages on every push to `main`; in the repository settings, set Pages → Source to "GitHub Actions" once.

Node 22.18 or newer is needed for the simulator scripts (they run TypeScript directly); the site itself builds on Node 20+.

## Testing on a phone (camera access needs HTTPS)

Browsers only hand out the camera on `https://` pages (or `localhost`). Three free ways to get there, simplest first.

**1. GitHub Pages.** Push, let the workflow deploy, open the Pages address on both devices. Nothing to install.

**2. A Cloudflare quick tunnel.** No account needed.

```bash
npm run dev
```

```bash
cloudflared tunnel --url http://localhost:5173
```

`cloudflared` prints an `https://<random>.trycloudflare.com` address; open it on the phone. The dev server already accepts that host name (`server.allowedHosts` in `vite.config.ts`). The laptop can keep using `http://localhost:5173/send/`.

**3. mkcert on your own network.** Works offline.

```bash
mkcert -install
```

```bash
mkdir .cert
```

```bash
mkcert -cert-file .cert/cert.pem -key-file .cert/key.pem localhost 192.168.1.23
```

```bash
npm run dev:lan
```

Replace `192.168.1.23` with the laptop's address on your network. When `.cert/cert.pem` and `.cert/key.pem` exist, the dev server switches to HTTPS by itself. The phone has to trust mkcert's root certificate: `mkcert -CAROOT` shows the folder holding `rootCA.pem`; send that file to the phone and install it (iOS: install the profile, then Settings → General → About → Certificate Trust Settings and switch it on; Android: Settings → Security → Install a certificate → CA certificate).

The HTTPS switch was checked on this machine with a throwaway certificate. `mkcert` and `cloudflared` themselves were not installed here, so those two recipes are written from their documentation and not from a run.

## Doing the device tests the build could not do

The brief asks for measurements that need a phone, a screen and a person. Here is the shortest path to each; the receiver's diagnostics panel has a **Copy as text** button so results can be pasted straight into an issue or this file.

1. **Visible mode, 40 cm** (milestone 2). Sender: Standard preset, Brightness axis, "Make modulation visible". Receiver: defaults. Write down *time to full decode*, *pilot SNR*, *bit error rate before FEC*, *camera frame rate* and *exposure*.
2. **Robustness** (milestone 3). Repeat at 30° off-axis, at 1 m (switch the receiver to 1280 px processing, sender to Far if Standard fails), handheld, with "Ask for 60 fps" on and off, and on a 120 Hz display with the High refresh preset.
3. **Stealth** (milestone 4). Colour axis. Take the blind test for each of the three clips at your usual viewing distance, 20 trials per amplitude. Then set the sender to the highest amplitude that scored 60 % or less and record the receiver's throughput.
4. **Join anytime** (milestone 5). Send a 32 KB file on Dense (or Standard), start the receiver at an arbitrary moment, record *time to full decode*.

If a step fails, the heat map shows which cells are unreadable and the diagnostics say whether the problem is acquisition (never leaves "Searching"), synchronisation (pilot coherence low) or noise (coherence fine, bit errors high). The same conditions can then be reproduced in the simulator with `npm run sim:one` and `src/sim/run-matrix.ts`.

## Presets

| preset | grid | modulation | carrier | symbol | packet | net rate | 60 B link* | 32 KB file* | use |
|---|---|---|---|---|---|---|---|---|---|
| `far` | 12×7 | QPSK | 20 Hz | 200 ms | 4 symbols | 340 bps | 2.4 s | 12.9 min | 1 m and beyond, small screens |
| `standard` | 16×9 | QPSK | 20 Hz | 200 ms | 2 symbols | 620 bps | 1.2 s | 7.1 min | default, laptop at arm's length |
| `dense` | 24×14 | QPSK | 20 Hz | 200 ms | 1 symbol | 1680 bps | 0.4 s | 2.6 min | close range, steady hand |
| `fast` | 24×14 | QPSK | 20 Hz | 100 ms | 1 symbol | 3360 bps | 0.2 s | 78 s | needs a true 60 fps camera |
| `export` | 12×7 | BPSK | 10 Hz | 400 ms | 6 symbols | 73 bps | 9.6 s | 59.7 min | recorded or streamed video; visible |
| `hfr` | 16×9 | QPSK | 40 Hz | 200 ms | 2 symbols | 620 bps | 1.2 s | 7.1 min | 120 Hz and faster displays |

\* Air time for exactly the needed packets, with no loss and no acquisition delay. The receiver detects the preset by itself.

Sender controls: amplitude (0.25–10 % of the local pixel value), axis (colour or brightness), shadow boost (extra signal on dark pixels), headroom at black and white, checker edge softness, display transfer curve, grid overlay, a visible-flicker debug mode with a photosensitivity warning, and the "ghost" badge.

## Performance

Full tables: [RESULTS.md](RESULTS.md). The summary below is filled from those tables.

<!-- PERFORMANCE:START -->
_Pending: this section is rewritten from RESULTS.md once the experiment scripts have finished._
<!-- PERFORMANCE:END -->

## Browser support

Target: iOS Safari 17+, Android Chrome, desktop Chrome, Edge, Firefox and Safari. Only desktop Chromium was actually run during the build; the rest of this table is from the platform documentation, and each fallback is in the code.

| Feature | Used for | Missing on | What happens instead |
|---|---|---|---|
| WebGL2 | sender shader, receiver downscale | very old devices | Sender shows a message and does not start. Receiver falls back to Canvas 2D |
| WebGPU | – | – | Not used. WebGL2 does everything needed, so there is nothing to fall back from |
| `requestVideoFrameCallback` | per-frame camera timestamps | Firefox before 132 | Polls on `requestAnimationFrame` and snaps wall-clock times onto the camera's frame grid |
| `captureTime` in frame metadata | best timestamps | Safari, Firefox | Uses `mediaTime`; if intervals jitter by more than 1.5 ms they are snapped to the frame grid. The panel shows which source is in use |
| OffscreenCanvas with WebGL2 in a worker | downscale off the main thread | Safari before 17 | Canvas 2D in the worker; without OffscreenCanvas, pixels are read on the main thread and transferred |
| `createImageBitmap(video)` | handing frames to the worker | – | Main-thread pixel read |
| `applyConstraints` exposure and white-balance lock, zoom | steady camera | iOS Safari (no exposure control), most desktops | Controls are hidden or report "not supported"; the receiver's differential detection does not need a locked exposure |
| 60 fps `frameRate` constraint | Fast preset | many Android phones in low light | Camera stays at 30 fps; Fast will not decode, the others are unaffected |
| `getDisplayMedia` | wrapping a live presentation | iOS Safari | That source is refused with a message; use an image, a video or the webcam |
| Fullscreen API on an element | presenting | iPhone Safari | A message explains it; rotate the phone and hide the toolbars |
| `MediaRecorder` on a canvas stream | export | – on current browsers | Export button reports that it is unavailable |
| Module workers | receiver | Firefox before 114 | No fallback: the receiver needs a current browser |

## Safety

- The sender shows a small **ghost badge** on the picture by default, so an audience can tell a screen is carrying data. A presenter can turn it off.
- The receiver **never navigates by itself**. A received link is shown in full, with its host name as the title, and opens in a new tab only when the button is tapped. Anything that is not `http` or `https` is shown as text.
- **Payloads are untrusted.** Text is rendered as plain text, never as HTML. Files are offered as downloads with a neutral content type and a sanitised name; nothing is previewed or executed.
- **Photosensitivity.** In normal use the modulation is below what can be seen. The debug mode that makes it visible asks for confirmation, shows a warning, and caps amplitude at 9 %. The carrier is 20 Hz on a 60 Hz screen, which is inside the 3–30 Hz range that matters for photosensitive epilepsy and cannot be moved higher on such a screen (30 Hz frame pairs do not survive a 30 fps camera, see DESIGN.md). On 120 Hz and faster displays the High refresh preset moves it to 40 Hz. The Export preset uses 10 Hz and is visible by design; keep its amplitude low and treat it like any flickering content.
- No analytics, no network requests after the page has loaded, no storage beyond blind-test results in `localStorage`.

## Known limitations

- **Untested on real hardware.** The simulator leaves out the camera's temporal noise reduction, demosaicing, moiré between pixel grids, focus hunting and OLED PWM. Temporal noise reduction in particular could attenuate the signal on phones that apply it heavily.
- **Dark content.** The modulation is proportional to pixel value, so near-black pictures carry almost nothing. In the simulator a dark cinematic scene did not lock at 4 %; it decoded at 8 % on the brightness axis, or at 4 % colour with shadow boost raised to 2 %. Shadow boost lifts flicker on black, which is where it is easiest to see.
- **Strong mains flicker with a short exposure.** Room light flickering at 100 Hz aliases onto the same 10 Hz as the carrier. The data survives (the in-cell checker cancels it), but automatic screen detection locks onto the room instead of the screen. Placing the corners by hand works (simulator).
- **2 m at 720p.** Far-preset quadrants shrink to about 6 camera pixels and the lock is no longer accurate enough. A 1080p capture or optical zoom should help; not tested.
- **Automatic detection needs either a clearly brighter screen or a signal of a few percent.** At stealth amplitudes on a screen that is not the brightest thing in view, use "Place corners by hand".
- **12-pilot grids (`far`, `export`) have a thin false-lock margin**: the pilot check scores up to 0.55 on pure noise against a threshold of 0.6. A false lock is dropped within seconds, but it costs time.
- **Export through `MediaRecorder` is at the browser's mercy**: frame rate and bitrate requests are hints. The codec numbers in RESULTS.md come from ffmpeg, not from a browser recording.
- The grid is locked to the sender's canvas, so anything drawn over it (the badge, browser UI in a shared tab) costs cells; Reed–Solomon absorbs a few.

## What I would try next

1. Run the device checklist above and replace the simulator column in the performance table.
2. Use the known homography for the phase plane (camera row time and display row time as two physical slopes) instead of a free plane; that removes most of the pilot check's freedom and its false-lock margin.
3. Per-frame global motion tracking between grid re-locks, for handheld use at distance.
4. Crop-and-zoom processing: once locked, process only the screen region at native camera resolution.
5. Soft-decision decoding (LDPC or soft RS) in place of hard-decision RS with erasures; the demodulator already produces reliabilities.
6. Content-adaptive amplitude: more signal where texture masks it, less on flat areas.
7. WebCodecs export with explicit frame rate and bitrate, and a re-filmed (codec plus camera) test.

## Project layout

```
src/core/        pure TypeScript, no DOM: CRC, Reed–Solomon, fountain, framing,
                 container, presets, modulation maths, reference renderer
src/core/rx/     receiver: screen detection, grid lock, demodulator, state machine
src/sim/         display and camera simulator, experiments (model, sweep, join, codec)
src/send/        WebGL2 renderer, sender engine, content sources, send page
src/receive/     camera pipeline, worker, receive page
src/abtest/      blind two-interval test
src/landing/     landing page with the live broadcast
tests/           unit tests (vitest)
```

Scripts: `npm run sim:model`, `sim:sweep`, `sim:join`, `sim:codec`, `sim:micro`, `sim:presets`, `sim:one`. `sim:codec` needs `ffmpeg` on the path. `node src/sim/build-results.ts` rebuilds RESULTS.md from their output.

Dependencies: none at run time. Development: Vite, TypeScript, Vitest.

## Prior work

Ghost Channel reuses ideas from research prototypes that ran as native apps. As described in the build brief:

- **HiLight** (Dartmouth, MobiSys 2015): data in changes of pixel translucency, about 1.1 kbps at 84–91 % accuracy on arbitrary content, with frequency-shift keying chosen to survive the camera's undersampling. The deliberate-aliasing idea here comes from it.
- **InFrame and InFrame++** (MobiSys 2015): complementary frame pairs inside full-frame video. The zero-mean principle is theirs; DESIGN.md explains why pairs became triplets.
- **Uber-in-Light** (Rutgers): modulation along a complementary colour axis, because colour flicker is harder to see than brightness flicker. The default blue–yellow axis follows that.
- **Revelio** (arXiv 2501.02349): data in the shapes of pixel regions, robust to rolling shutter and to timing mismatch between screen and camera.

The papers were not fetched during the build; the summaries above are the brief's, not independent readings.

## Licence

MIT.
