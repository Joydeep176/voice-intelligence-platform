// Phase 3A M6 (evidence for the user's threshold decision, OD-52): runs the REAL A1 engine
// (apps/orchestrator dist) with the provisional rule config over the M0 per-mixture speech-aware
// estimates of the Phase 2B VAD corpus test split (known mixing SNR = ground truth). It reports how
// the provisional noise / speech-presence bands classify each SNR level and noise type, and the
// false-flag rate on clean speech. Synthetic corpus only: NOT real-world accuracy.
// Usage: node m6-calibration.mjs <M0 estimates.json> <out.json>
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = new URL('../../../', import.meta.url).pathname;
const { assess } = require(`${ROOT}apps/orchestrator/dist/agents/audio-quality/engine.js`);
const { A1_RULE_CONFIG } = require(`${ROOT}apps/orchestrator/dist/agents/audio-quality/rule-config.js`);
const [estimatesPath, outPath] = process.argv.slice(2);
const rows = JSON.parse(readFileSync(estimatesPath, 'utf8')).filter((r) => r.split === 'test');

const e = (value) => ({ value, kind: 'estimate' });
const d = (value) => ({ value, kind: 'derived' });
const result = (r) => {
  const quantities = { speechRatio: d(r.speechRatioEst), speechMs: d(Math.round(r.speechRatioEst * 75_000)) };
  if (r.vadSnr.value !== null) quantities.snrDb = e(r.vadSnr.value);
  return assess(
    {
      durationMs: 75_000,
      canonical: { quantities: { peakDbfs: { value: -3, kind: 'measured' } } },
      original: null,
      levelSeries: null,
      timeline: null,
      tier1: { state: 'available', quantities, series: null },
    },
    A1_RULE_CONFIG,
  );
};

const groups = {};
for (const r of rows) {
  const out = result(r);
  const noise = out.flags.find((f) => f.kind === 'noise')?.severity ?? 'none';
  for (const key of [`snr:${r.snr}`, `noise:${r.noise}:${r.snr}`, `lang:${r.language}:${r.snr}`]) {
    const g = (groups[key] ??= { n: 0, overall: {}, noiseFlag: {} });
    g.n += 1;
    g.overall[out.overall] = (g.overall[out.overall] ?? 0) + 1;
    g.noiseFlag[noise] = (g.noiseFlag[noise] ?? 0) + 1;
  }
}
const clean = groups['snr:clean'];
const report = {
  ruleVersion: A1_RULE_CONFIG.ruleVersion,
  provisional: A1_RULE_CONFIG.provisional,
  snrBands: A1_RULE_CONFIG.snrDb,
  note: 'Engine run on M0 harness estimates (same algorithms as the measure task); synthetic corpus; not real-world accuracy. Tier 0 inputs are neutral, so only the noise and speech-presence rules decide.',
  cleanFalseNoiseFlagRate: clean ? +(1 - (clean.noiseFlag.none ?? 0) / clean.n).toFixed(3) : null,
  groups,
};
writeFileSync(outPath, JSON.stringify(report, null, 1) + '\n');
for (const s of ['clean', 20, 10, 5, 0]) console.log(s, JSON.stringify(groups[`snr:${s}`]));
