## Analytic model: where does the carrier land, and how much of it is left?

| display | carrier | camera | exposure | alias | hold gain | exposure gain | total gain | verdict |
|---|---|---|---|---|---|---|---|---|
| 60 Hz | 30 Hz | 30 fps | 1/250 s | 0 Hz | 0.64 | 0.98 | 0.62 | aliases onto DC: indistinguishable from static content, phase-dependent nulls |
| 60 Hz | 20 Hz | 30 fps | 1/250 s | 10 Hz | 0.83 | 0.99 | 0.82 | usable |
| 60 Hz | 15 Hz | 30 fps | 1/250 s | 15 Hz | 0.90 | 0.99 | 0.89 | aliases onto Nyquist: one quadrature only |
| 60 Hz | 10 Hz | 30 fps | 1/250 s | 10 Hz | 0.95 | 1.00 | 0.95 | usable |
| 120 Hz | 60 Hz | 30 fps | 1/250 s | 0 Hz | 0.64 | 0.91 | 0.58 | aliases onto DC: indistinguishable from static content, phase-dependent nulls |
| 120 Hz | 40 Hz | 30 fps | 1/250 s | 10 Hz | 0.83 | 0.96 | 0.79 | usable |
| 120 Hz | 20 Hz | 30 fps | 1/250 s | 10 Hz | 0.95 | 0.99 | 0.94 | usable |
| 60 Hz | 30 Hz | 30 fps | 1/100 s | 0 Hz | 0.64 | 0.86 | 0.55 | aliases onto DC: indistinguishable from static content, phase-dependent nulls |
| 60 Hz | 20 Hz | 30 fps | 1/100 s | 10 Hz | 0.83 | 0.94 | 0.77 | usable |
| 60 Hz | 15 Hz | 30 fps | 1/100 s | 15 Hz | 0.90 | 0.96 | 0.87 | aliases onto Nyquist: one quadrature only |
| 60 Hz | 10 Hz | 30 fps | 1/100 s | 10 Hz | 0.95 | 0.98 | 0.94 | usable |
| 120 Hz | 60 Hz | 30 fps | 1/100 s | 0 Hz | 0.64 | 0.50 | 0.32 | aliases onto DC: indistinguishable from static content, phase-dependent nulls |
| 120 Hz | 40 Hz | 30 fps | 1/100 s | 10 Hz | 0.83 | 0.76 | 0.63 | usable |
| 120 Hz | 20 Hz | 30 fps | 1/100 s | 10 Hz | 0.95 | 0.94 | 0.89 | usable |
| 60 Hz | 30 Hz | 30 fps | 1/60 s | 0 Hz | 0.64 | 0.64 | 0.41 | aliases onto DC: indistinguishable from static content, phase-dependent nulls |
| 60 Hz | 20 Hz | 30 fps | 1/60 s | 10 Hz | 0.83 | 0.83 | 0.68 | usable |
| 60 Hz | 15 Hz | 30 fps | 1/60 s | 15 Hz | 0.90 | 0.90 | 0.81 | aliases onto Nyquist: one quadrature only |
| 60 Hz | 10 Hz | 30 fps | 1/60 s | 10 Hz | 0.95 | 0.95 | 0.91 | usable |
| 120 Hz | 60 Hz | 30 fps | 1/60 s | 0 Hz | 0.64 | 0.00 | 0.00 | aliases onto DC: indistinguishable from static content, phase-dependent nulls |
| 120 Hz | 40 Hz | 30 fps | 1/60 s | 10 Hz | 0.83 | 0.41 | 0.34 | usable |
| 120 Hz | 20 Hz | 30 fps | 1/60 s | 10 Hz | 0.95 | 0.83 | 0.79 | usable |
| 60 Hz | 30 Hz | 30 fps | 1/30 s | 0 Hz | 0.64 | 0.00 | 0.00 | aliases onto DC: indistinguishable from static content, phase-dependent nulls |
| 60 Hz | 20 Hz | 30 fps | 1/30 s | 10 Hz | 0.83 | 0.41 | 0.34 | usable |
| 60 Hz | 15 Hz | 30 fps | 1/30 s | 15 Hz | 0.90 | 0.64 | 0.57 | aliases onto Nyquist: one quadrature only |
| 60 Hz | 10 Hz | 30 fps | 1/30 s | 10 Hz | 0.95 | 0.83 | 0.79 | usable |
| 120 Hz | 60 Hz | 30 fps | 1/30 s | 0 Hz | 0.64 | 0.00 | 0.00 | aliases onto DC: indistinguishable from static content, phase-dependent nulls |
| 120 Hz | 40 Hz | 30 fps | 1/30 s | 10 Hz | 0.83 | 0.21 | 0.17 | exposure averages the carrier away |
| 120 Hz | 20 Hz | 30 fps | 1/30 s | 10 Hz | 0.95 | 0.41 | 0.39 | usable |
| 60 Hz | 30 Hz | 60 fps | 1/250 s | 30 Hz | 0.64 | 0.98 | 0.62 | aliases onto Nyquist: one quadrature only |
| 60 Hz | 20 Hz | 60 fps | 1/250 s | 20 Hz | 0.83 | 0.99 | 0.82 | usable |
| 60 Hz | 15 Hz | 60 fps | 1/250 s | 15 Hz | 0.90 | 0.99 | 0.89 | usable |
| 60 Hz | 10 Hz | 60 fps | 1/250 s | 10 Hz | 0.95 | 1.00 | 0.95 | usable |
| 120 Hz | 60 Hz | 60 fps | 1/250 s | 0 Hz | 0.64 | 0.91 | 0.58 | aliases onto DC: indistinguishable from static content, phase-dependent nulls |
| 120 Hz | 40 Hz | 60 fps | 1/250 s | 20 Hz | 0.83 | 0.96 | 0.79 | usable |
| 120 Hz | 20 Hz | 60 fps | 1/250 s | 20 Hz | 0.95 | 0.99 | 0.94 | usable |
| 60 Hz | 30 Hz | 60 fps | 1/100 s | 30 Hz | 0.64 | 0.86 | 0.55 | aliases onto Nyquist: one quadrature only |
| 60 Hz | 20 Hz | 60 fps | 1/100 s | 20 Hz | 0.83 | 0.94 | 0.77 | usable |
| 60 Hz | 15 Hz | 60 fps | 1/100 s | 15 Hz | 0.90 | 0.96 | 0.87 | usable |
| 60 Hz | 10 Hz | 60 fps | 1/100 s | 10 Hz | 0.95 | 0.98 | 0.94 | usable |
| 120 Hz | 60 Hz | 60 fps | 1/100 s | 0 Hz | 0.64 | 0.50 | 0.32 | aliases onto DC: indistinguishable from static content, phase-dependent nulls |
| 120 Hz | 40 Hz | 60 fps | 1/100 s | 20 Hz | 0.83 | 0.76 | 0.63 | usable |
| 120 Hz | 20 Hz | 60 fps | 1/100 s | 20 Hz | 0.95 | 0.94 | 0.89 | usable |
| 60 Hz | 30 Hz | 60 fps | 1/60 s | 30 Hz | 0.64 | 0.64 | 0.41 | aliases onto Nyquist: one quadrature only |
| 60 Hz | 20 Hz | 60 fps | 1/60 s | 20 Hz | 0.83 | 0.83 | 0.68 | usable |
| 60 Hz | 15 Hz | 60 fps | 1/60 s | 15 Hz | 0.90 | 0.90 | 0.81 | usable |
| 60 Hz | 10 Hz | 60 fps | 1/60 s | 10 Hz | 0.95 | 0.95 | 0.91 | usable |
| 120 Hz | 60 Hz | 60 fps | 1/60 s | 0 Hz | 0.64 | 0.00 | 0.00 | aliases onto DC: indistinguishable from static content, phase-dependent nulls |
| 120 Hz | 40 Hz | 60 fps | 1/60 s | 20 Hz | 0.83 | 0.41 | 0.34 | usable |
| 120 Hz | 20 Hz | 60 fps | 1/60 s | 20 Hz | 0.95 | 0.83 | 0.79 | usable |

## Complementary pairs seen at half the refresh rate: stationary null bands

A 30 Hz square carrier (+d, -d on a 60 Hz display) aliases to 0 Hz on a 30 fps camera. What each sensor row sees is a constant that depends on where its exposure falls in the pair. Fraction of rows left with less than 30 % of the peak signal:

| exposure | rows below 30 % | peak amplitude left |
|---|---|---|
| 1/250 s | 7 % | 1.00 |
| 1/120 s | 15 % | 1.00 |
| 1/60 s | 30 % | 1.00 |
| 1/40 s | 44 % | 0.34 |
| 1/30 s | 100 % | 0.01 |

## Simulator check: same grid and amplitude, different carriers

16x9 grid, 200 ms symbols, chroma axis at 4 %, grey content, 0.4 m, 30 fps camera. Real transmitter and real receiver.

| carrier | exposure | decoded | time | packets ok | raw BER |
|---|---|---|---|---|---|
| 30 Hz | 1/100 s | no | - | 0/0 | - |
| 30 Hz | 1/40 s | no | - | 0/0 | - |
| 25 Hz | 1/100 s | yes | 2.0 s | 4/4 | 7.9e-4 |
| 25 Hz | 1/40 s | yes | 2.0 s | 4/4 | 4.0e-3 |
| 20 Hz | 1/100 s | yes | 2.0 s | 4/4 | 0.0e+0 |
| 20 Hz | 1/40 s | yes | 2.0 s | 4/4 | 0.0e+0 |
| 15 Hz | 1/100 s | no | - | 0/0 | - |
| 15 Hz | 1/40 s | no | - | 0/0 | - |
| 10 Hz | 1/100 s | yes | 2.0 s | 4/4 | 0.0e+0 |
| 10 Hz | 1/40 s | yes | 2.0 s | 4/4 | 0.0e+0 |
