// Renders docs/development/phase2b-resources/README.md tables from results.json (measured numbers only).
// Usage: node services/audio/benchmarks/resources/report.mjs [results.json] > table-fragment.md
import { readFileSync } from 'node:fs';
const path = process.argv[2] ?? new URL('../../../../docs/development/phase2b-resources/results.json', import.meta.url).pathname;
const r = JSON.parse(readFileSync(path, 'utf8'));
const f = (v, d = 1) => (v === null || v === undefined ? 'n/a' : Number(v).toFixed(d));
const rows = [];
for (const [id, c] of Object.entries(r.cases)) {
  for (const x of c.runs) {
    rows.push(`| ${id}${c.runs.length > 1 ? ` #${x.job}` : ''} | ${f(c.originalBytes / 1048576)} | ${x.status ?? `HTTP ${x.httpStatus}`}${x.error?.code ? ` (${x.error.code})` : x.error && typeof x.error === 'string' ? ` (${x.error})` : ''} | ${f(x.wallS)} | ${f(x.rtf, 4)} | ${f(x.cpuSeconds)} | ${f(x.anonPeakMb)} | ${f(x.memoryPeakCgroupMb)} | ${f(x.filePeakMb)} | ${f(x.ffmpegHwmPeakMb)} | ${f(x.tempPeakMb)} | ${f((x.outputBytes ?? 0) / 1048576)} | ${f(x.throttledSeconds)} |`);
  }
}
console.log('| Case | Original MB | Status | Wall s | RTF | CPU s | Anon peak MB | cgroup memory.peak MB | Page cache (file) peak MB | FFmpeg child peak RSS MB | Temp peak MB | Output MB | CPU throttled s |');
console.log('| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
console.log(rows.join('\n'));
const s = r.cases['series-5x30min'];
if (s?.anonGrowth) {
  console.log('\n| Job | Anon peak MB | Idle anon after job MB |\n| ---: | ---: | ---: |');
  s.anonGrowth.jobAnonPeaksMb.forEach((p, i) => console.log(`| ${i + 1} | ${f(p)} | ${f(s.anonGrowth.idleAnonAfterEachJobMb[i])} |`));
  console.log(`\nPeak growth first to last: ${s.anonGrowth.peakGrowthPctFirstToLast} %; idle growth first to last: ${s.anonGrowth.idleGrowthPctFirstToLast} %.`);
}
