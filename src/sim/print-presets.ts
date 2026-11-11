// node src/sim/print-presets.ts  -> markdown table of the shipped presets
import { makeLayout } from '../core/layout.ts';
import { PRESETS } from '../core/presets.ts';

console.log('| preset | grid | pilots | modulation | carrier | symbol | packet | RS codeword (n, k) | block | net rate | 60 B link* | 32 KB file* |');
console.log('|---|---|---|---|---|---|---|---|---|---|---|---|');
for (const p of PRESETS) {
  const l = makeLayout(p);
  const cw = l.codewords.map((c) => `(${c.len}, ${c.len - c.parity})`).join(' + ');
  const kUrl = Math.ceil((60 + 10) / l.blockSize);
  const kFile = Math.ceil((32768 + 40) / l.blockSize);
  const t = (k: number) => {
    const s = k * l.packetSeconds;
    return s >= 90 ? `${(s / 60).toFixed(1)} min` : `${s.toFixed(1)} s`;
  };
  console.log(
    `| \`${p.key}\` | ${p.cols}×${p.rows} | ${l.pilotCells.length} | ${p.bitsPerCell === 2 ? 'QPSK' : 'BPSK'} | ${p.carrierHz} Hz | ${(l.symbolSeconds * 1000).toFixed(0)} ms | ${p.symbolsPerPacket} symbol${p.symbolsPerPacket > 1 ? 's' : ''}, ${l.packetBytes} B | ${cw} | ${l.blockSize} B | ${Math.round(l.netBitsPerSecond)} bps | ${t(kUrl)} | ${t(kFile)} |`,
  );
}
console.log('\n\* Air time for exactly K packets with no loss and no acquisition delay.');
