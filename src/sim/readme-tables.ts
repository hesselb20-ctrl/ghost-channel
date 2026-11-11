// node src/sim/readme-tables.ts
// Rewrites the two condition matrices in README.md from the sweep JSON in
// sim-out/, between the MATRIX markers, so the README cannot drift from the
// measurements. Also prints the tallies used in the text around them.

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';

interface Trial {
  decoded: boolean;
  payloadOk: boolean;
  tDecode: number | null;
}
interface Cell {
  row: string;
  col: string;
  trials: Trial[];
}

const LETTERS = 'ABCDEFGHIJKLMN';
const order = ['far', 'standard', 'dense'];
let readme = readFileSync('README.md', 'utf8').replace(/\r\n/g, '\n');

for (const content of ['talking', 'slide']) {
  const files = readdirSync('sim-out')
    .filter((f) => new RegExp(`^sweep-[a-z]+-${content}\\.json$`).test(f))
    .sort();
  const map = new Map<string, Cell>();
  const cols: string[] = [];
  for (const f of files) {
    for (const c of JSON.parse(readFileSync('sim-out/' + f, 'utf8')) as Cell[]) {
      if (!cols.includes(c.col)) cols.push(c.col);
      const key = c.row + '|' + c.col;
      if (!map.has(key)) map.set(key, c);
    }
  }
  const rows = [...new Set([...map.keys()].map((k) => k.split('|')[0]))].sort(
    (a, b) => order.indexOf(a.split(' ')[0]) - order.indexOf(b.split(' ')[0]),
  );
  const lines: string[] = [];
  lines.push('| preset, axis, amplitude | ' + cols.map((_, i) => LETTERS[i]).join(' | ') + ' |');
  lines.push('|' + '---|'.repeat(cols.length + 1));
  let ok = 0;
  let total = 0;
  let wrong = 0;
  for (const r of rows) {
    const [preset, axis, amp] = r.split(' ');
    const label = `${preset}, ${axis === 'luma' ? 'brightness' : 'colour'} ${Number.parseFloat(amp)} %`;
    const cells = cols.map((c) => {
      const t = map.get(r + '|' + c)?.trials[0];
      if (!t) return '?';
      total++;
      if (t.decoded && !t.payloadOk) wrong++;
      if (t.decoded && t.payloadOk) {
        ok++;
        return t.tDecode!.toFixed(1);
      }
      return 'x';
    });
    lines.push(`| ${label} | ${cells.join(' | ')} |`);
  }
  const start = `<!-- MATRIX:${content}:START -->`;
  const end = `<!-- MATRIX:${content}:END -->`;
  const a = readme.indexOf(start);
  const b = readme.indexOf(end);
  if (a < 0 || b < 0) throw new Error(`README markers for ${content} not found`);
  readme = readme.slice(0, a + start.length) + '\n' + lines.join('\n') + '\n' + readme.slice(b);
  console.log(`${content}: ${ok} of ${total} recovered, ${wrong} wrong payloads`);
  console.log(cols.map((c, i) => `${LETTERS[i]}=${c}`).join('; '));
  console.log(lines.slice(2).join('\n'));
}
writeFileSync('README.md', readme);
