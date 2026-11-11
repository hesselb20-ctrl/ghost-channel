Preset dense: 32768 bytes = 782 blocks of 42 B, one packet every 0.20 s.
A lossless receiver that needed exactly K packets would take 156 s.

| trial | decoded | bytes correct | time to full file | packets ok / failed | overhead vs K | raw BER | delivered rate |
|---|---|---|---|---|---|---|---|
| 1 | yes | all | 156.9 s | 784 / 0 | 1.003 | 5.3e-4 | 1680 bps |
| 2 | yes | all | 157.6 s | 787 / 0 | 1.006 | 5.8e-4 | 1673 bps |
