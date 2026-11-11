### A 61-byte link, 0.4 m, colour axis

The sweep sends 60 random bytes as a file, which costs 46 bytes of name and type on top. A link of the same length is a smaller object and needs fewer packets.

| run | decoded | time | packets ok / failed | raw BER | locked via |
|---|---|---|---|---|---|
| far, slide, 4 % | yes | 3.3 s | 3 / 0 | 0.0e+0 | bright |
| far, talking, 4 % | yes | 3.3 s | 3 / 0 | 0.0e+0 | bright |
| far, slide, 2 % | yes | 3.3 s | 3 / 0 | 4.3e-4 | energy |
| far, talking, 2 % | yes | 3.3 s | 3 / 0 | 0.0e+0 | energy |
| standard, slide, 4 % | yes | 1.7 s | 3 / 0 | 0.0e+0 | energy |
| standard, talking, 4 % | yes | 1.7 s | 3 / 0 | 0.0e+0 | energy |
| standard, slide, 2 % | yes | 1.7 s | 3 / 0 | 0.0e+0 | bright |
| standard, talking, 2 % | yes | 1.7 s | 3 / 0 | 9.9e-4 | energy |
| dense, slide, 4 % | yes | 0.5 s | 2 / 0 | 0.0e+0 | bright |
| dense, talking, 4 % | yes | 0.5 s | 2 / 0 | 0.0e+0 | energy |
| dense, slide, 2 % | yes | 0.5 s | 2 / 0 | 0.0e+0 | bright |
| dense, talking, 2 % | yes | 0.5 s | 2 / 0 | 2.5e-3 | bright |

### Dark cinematic content, standard preset, 0.4 m

| run | decoded | time | packets ok / failed | raw BER | locked via |
|---|---|---|---|---|---|
| colour 4 % | no | - | 0 / 0 | - | - |
| brightness 4 % | yes | 2.1 s | 4 / 0 | 1.2e-3 | energy |
| colour 8 % | yes | 2.1 s | 4 / 0 | 4.0e-4 | energy |
| brightness 8 % | yes | 2.1 s | 4 / 0 | 0.0e+0 | energy |
| colour 4 %, shadow boost 2 % | yes | 2.1 s | 4 / 0 | 0.0e+0 | energy |
| brightness 4 %, shadow boost 2 % | yes | 2.1 s | 4 / 0 | 0.0e+0 | energy |
| colour 4 %, corners placed by hand (4 px error) | no | - | 1 / 9 | 3.9e-2 | manual |

### Room light flickering at 100 Hz (30 % depth), 1/250 s exposure, standard preset, colour 4 %, talking-head content

| run | decoded | time | packets ok / failed | raw BER | locked via |
|---|---|---|---|---|---|
| dim room (background 5 % of white) | yes | 2.1 s | 4 / 0 | 0.0e+0 | bright |
| bright wall behind the screen (20 % of white) | yes | 2.1 s | 4 / 0 | 0.0e+0 | energy |
| bright wall, corners placed by hand (4 px error) | yes | 2.1 s | 4 / 0 | 0.0e+0 | manual |

### 2 m with the far preset, brightness 8 %, talking-head content

| run | decoded | time | packets ok / failed | raw BER | locked via |
|---|---|---|---|---|---|
| 1280×720 camera | yes | 3.3 s | 3 / 0 | 8.7e-4 | energy |
| 1920×1080 camera (blur σ 1.9 px, noise 3.5) | yes | 3.3 s | 3 / 0 | 2.6e-2 | energy |

### Sender frame drops (simulated): standard preset, colour 4 %, slide content, 0.4 m

| run | decoded | time | packets ok / failed | raw BER | locked via |
|---|---|---|---|---|---|
| 1 % of display frames repeated | yes | 8.9 s | 21 / 0 | 0.0e+0 | bright |
| 5 % of display frames repeated | yes | 10.5 s | 23 / 1 | 6.9e-3 | bright |
| 15 % of display frames repeated | no | - | 18 / 13 | 6.7e-2 | energy |
