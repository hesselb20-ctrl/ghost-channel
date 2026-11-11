Fountain overhead: packets received before the object decodes, divided by K (30 % of packets dropped at random, 40 trials each)
| K | mean | worst |
|---|---|---|
| 3 | 1.058 | 1.667 |
| 12 | 1.192 | 2.000 |
| 60 | 1.079 | 1.667 |
| 300 | 1.019 | 1.153 |
| 781 | 1.014 | 1.346 |
| 2000 | 1.003 | 1.006 |

Pilot check on noise only (complex Gaussian cells, six windows, 200 trials)
| grid | pilots | mean | 99th percentile | max |
|---|---|---|---|---|
| 12×7 @ 20 Hz | 12 | 0.44 | 0.52 | 0.55 |
| 16×9 @ 20 Hz | 18 | 0.36 | 0.44 | 0.46 |
| 24×14 @ 20 Hz | 31 | 0.28 | 0.32 | 0.34 |
| 12×7 @ 10 Hz | 12 | 0.43 | 0.49 | 0.52 |
| 16×9 @ 40 Hz | 18 | 0.38 | 0.44 | 0.44 |
