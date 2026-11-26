// Phase 3A M4: validation of the IMPLEMENTED `measure` task (ADR-0045) in the production image at
// the production limits (2 CPUs, 768 MB, Landlock required, read-only, cap-drop ALL), driven over
// the real task API. Unlike the M0 harness, these are acceptance-grade figures for AC-4 / AC-10.
//
// Usage: QB_TASK_ROOT=<scratch dir> node services/audio/benchmarks/quality/task-check.mjs
// Synthetic inputs only (ADR-0004): the Phase 2B VAD corpus. Throwaway storage root and container;
// the running development service is never touched. Nothing is downloaded: models come from the
// existing `vip_audio-models` volume (read-only). Output: numbers only.
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../../../..');
const contracts = await import(pathToFileURL(join(REPO, 'packages/contracts/dist/index.js')).href);
const SCRATCH = process.env.QB_TASK_ROOT;
if (!SCRATCH) throw new Error('set QB_TASK_ROOT to a scratch directory');
const CORPUS = join(REPO, '.local-benchmarks/vad-corpus');
const ROOT = join(SCRATCH, 'storage');
const IMAGE = 'vip-audio-service:phase3a';
const NAME = 'vip-a1-m4-check';
const PORT = 8011;
const AUDIO = `http://127.0.0.1:${PORT}`;
const WS = '00000000-0000-4000-8000-0000000000c3';
const TOKEN = randomBytes(32).toString('hex'); // never printed or written
const hdr = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
const sh = (c, a, o = {}) => spawnSync(c, a, { encoding: 'utf8', maxBuffer: 1 << 28, ...o });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const VAD = { threshold: 0.4, minSilenceMs: 300, minSpeechMs: 250, paddingMs: 200 };

const CASES = [
  { id: 'white10-76s', src: 'mixtures/test/test-english-s0-white-10.wav', knownSnrDb: 10 },
  { id: 'clean-76s', src: 'mixtures/test/test-english-s0-none-clean.wav', knownSnrDb: null },
  { id: 'long-120min', src: 'long/long-120.wav', knownSnrDb: null },
  { id: 'generated-4h', concat: ['long/long-120.wav', 'long/long-120.wav'], knownSnrDb: null },
];

function prepare(c, rec) {
  const dest = join(ROOT, 'recordings', WS, rec, 'original');
  mkdirSync(dirname(dest), { recursive: true });
  if (c.src) copyFileSync(join(CORPUS, c.src), dest);
  else {
    // 4 h = long-120 twice, written as one 16 kHz mono s16 WAV (Python stdlib only)
    // capped at 4 h - 1 s (the accepted duration limit is 4 h, ADR-0039)
    const py = `import wave,sys\nsrc=[wave.open(p,'rb') for p in sys.argv[2:]]\nout=wave.open(sys.argv[1],'wb')\nout.setparams(src[0].getparams())\nleft=(4*3600-1)*16000\nfor w in src:\n  while left>0:\n    b=w.readframes(min(1<<20,left))\n    if not b: break\n    out.writeframes(b)\n    left-=len(b)//2\nout.close()\n`;
    const r = sh('python3', ['-c', py, dest, ...c.concat.map((p) => join(CORPUS, p))]);
    if (r.status !== 0) throw new Error(`concat failed: ${r.stderr}`);
  }
}

function startContainer() {
  sh('docker', ['rm', '-f', NAME]);
  mkdirSync(join(ROOT, 'derived'), { recursive: true });
  sh('chmod', ['-R', 'a+rwX', ROOT]);
  const r = sh('docker', [
    'run', '-d', '--name', NAME, '--init', '--cpus', '2', '--memory', '768m', '--memory-swap', '768m',
    '--pids-limit', '64', '--read-only', '--tmpfs', '/tmp:size=16m,noexec,nosuid,nodev',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
    '-e', `AUDIO_SERVICE_TOKEN=${TOKEN}`, '-e', 'AUDIO_SERVICE_STORAGE_ROOT=/storage',
    '-e', 'AUDIO_SERVICE_MODELS_DIR=/models', '-e', 'AUDIO_SERVICE_LANDLOCK=required',
    '-e', 'AUDIO_SERVICE_INFERENCE_THREADS=2', '-e', 'OMP_NUM_THREADS=2', '-e', 'AUDIO_SERVICE_HOST=0.0.0.0',
    '-v', `${join(ROOT, 'recordings')}:/storage/recordings:ro`, '-v', `${join(ROOT, 'derived')}:/storage/derived`,
    '-v', 'vip_audio-models:/models:ro', '-p', `127.0.0.1:${PORT}:8001`, IMAGE,
  ]);
  if (r.status !== 0) throw new Error(`docker run failed: ${r.stderr}`);
}

async function waitReady() {
  for (let i = 0; i < 120; i++) {
    try {
      const res = await fetch(`${AUDIO}/health/ready`, { headers: hdr });
      if (res.status === 200) return;
    } catch { /* starting */ }
    await sleep(1000);
  }
  throw new Error('audio service not ready');
}

const anon = () => {
  const r = sh('docker', ['exec', NAME, 'cat', '/sys/fs/cgroup/memory.stat']);
  const m = /^anon (\d+)$/m.exec(r.stdout ?? '');
  return m ? Number(m[1]) : null;
};

async function task(type, rec, prefix, config, key = randomUUID()) {
  const body = {
    contractVersion: contracts.AUDIO_SERVICE_CONTRACT_VERSION, type, idempotencyKey: key,
    workspaceId: WS, recordingId: rec,
    input: { originalKey: `recordings/${WS}/${rec}/original`, outputPrefix: prefix }, config,
  };
  const res = await fetch(`${AUDIO}/v1/tasks`, { method: 'POST', headers: hdr, body: JSON.stringify(body) });
  const acc = await res.json();
  if (res.status !== 202) throw new Error(`${type} rejected ${res.status} ${acc.code ?? ''}`);
  return acc.taskId;
}

async function follow(taskId, { onTick } = {}) {
  const t0 = performance.now();
  let liveFailures = 0;
  let liveProbes = 0;
  let peakAnon = 0;
  for (;;) {
    const st = await (await fetch(`${AUDIO}/v1/tasks/${taskId}`, { headers: hdr })).json();
    liveProbes += 1;
    try {
      if ((await fetch(`${AUDIO}/health/live`)).status !== 200) liveFailures += 1;
    } catch { liveFailures += 1; }
    const a = anon();
    if (a) peakAnon = Math.max(peakAnon, a);
    if (onTick) await onTick(performance.now() - t0);
    if (['succeeded', 'failed', 'cancelled'].includes(st.status))
      return { st, wallS: (performance.now() - t0) / 1000, liveProbes, liveFailures, peakAnonMiB: +(peakAnon / 2 ** 20).toFixed(1) };
    await sleep(500);
  }
}

const results = { image: IMAGE, limits: { cpus: 2, memory: '768m', landlock: 'required', readOnly: true }, cases: {} };
try {
  log('building image', IMAGE);
  const b = sh('docker', ['build', '-f', join(REPO, 'services/audio/Dockerfile'), '--target', 'runtime', '-t', IMAGE, join(REPO, 'services/audio')]);
  if (b.status !== 0) throw new Error(`build failed: ${b.stderr.slice(-2000)}`);
  rmSync(ROOT, { recursive: true, force: true });
  const recs = Object.fromEntries(CASES.map((c) => [c.id, randomUUID()]));
  for (const c of CASES) prepare(c, recs[c.id]);
  startContainer();
  await waitReady();
  const caps = await (await fetch(`${AUDIO}/v1/capabilities`, { headers: hdr })).json();
  results.capabilities = { taskTypes: caps.taskTypes, landlockEnforced: caps.landlock?.enforced ?? null };
  log('capabilities', JSON.stringify(results.capabilities));
  const tv = contracts.toolVersionsFromCapabilities(caps);
  const pconfig = contracts.buildPreprocessConfig(tv);
  const hash = createHash('sha256').update(contracts.canonicalJson(pconfig)).digest('hex');

  for (const c of CASES) {
    const rec = recs[c.id];
    const prefix = `derived/${WS}/${rec}/${hash}`;
    log(c.id, 'preprocess');
    const pre = await follow(await task('preprocess', rec, prefix, pconfig));
    if (pre.st.status !== 'succeeded') throw new Error(`${c.id} preprocess ${pre.st.status} ${pre.st.error?.code}`);
    const samples = pre.st.result.canonical.samples;
    const mconfig = { schemaVersion: 1, audioDurationMs: Math.ceil(samples / 16), vad: VAD, blockMs: 1000, windowMs: 30000, overlapMs: 1000, ltasDropDb: 50, ltasMinHz: 300, snrNearCleanDb: 45 };
    contracts.AudioMeasureConfig.parse(mconfig);
    log(c.id, 'measure', mconfig.audioDurationMs, 'ms');
    const m = await follow(await task('measure', rec, prefix, mconfig));
    const q = (n) => m.st.result?.record?.quantities?.[n]?.value ?? null;
    const entry = {
      audioS: mconfig.audioDurationMs / 1000, status: m.st.status, error: m.st.error?.code ?? null,
      wallS: +m.wallS.toFixed(2), rtf: +(m.wallS / (mconfig.audioDurationMs / 1000)).toFixed(4),
      peakAnonMiB: m.peakAnonMiB, liveProbes: m.liveProbes, liveFailures: m.liveFailures,
      resultValid: contracts.AudioMeasureResult.safeParse(m.st.result).success,
      snrDb: q('snrDb'), knownSnrDb: c.knownSnrDb, speechRatio: q('speechRatio'), bandwidthEdgeHz: q('bandwidthEdgeHz'),
      maxSpansPerWindow: q('maxSpansPerWindow'), levelSpreadDb: q('levelSpreadDb'),
      seriesBlocks: m.st.result?.series?.speechMs?.length ?? null,
      unavailable: m.st.result?.record?.unavailable ?? null, warnings: m.st.result?.warnings ?? null,
    };
    if (c.id === 'white10-76s') {
      const again = await follow(await task('measure', rec, prefix, mconfig));
      entry.determinism = JSON.stringify(again.st.result) === JSON.stringify(m.st.result);
    }
    if (c.id === 'generated-4h') {
      // cancellation: a fresh task, cancelled after 3 s through the existing DELETE path
      const id = await task('measure', rec, prefix, mconfig);
      let sent = false;
      const cancel = await follow(id, {
        onTick: async (ms) => {
          if (!sent && ms > 3000) {
            sent = true;
            await fetch(`${AUDIO}/v1/tasks/${id}`, { method: 'DELETE', headers: hdr });
          }
        },
      });
      entry.cancellation = { status: cancel.st.status, wallS: +cancel.wallS.toFixed(2) };
    }
    results.cases[c.id] = entry;
    log(c.id, JSON.stringify(entry));
  }
  const inspect = JSON.parse(sh('docker', ['inspect', NAME]).stdout)[0];
  results.containerOomKilled = inspect.State.OOMKilled;
  results.cgroupMemoryPeakMiB = +(Number(sh('docker', ['exec', NAME, 'cat', '/sys/fs/cgroup/memory.peak']).stdout) / 2 ** 20).toFixed(1);
  results.note = 'peakAnonMiB is sampled every ~0.5 s via docker exec (each sample adds a short-lived cat process to the cgroup); memory.peak includes page cache of the files read.';
  const out = join(REPO, 'docs/development/phase3a-quality-benchmark/m4-task-check.json');
  writeFileSync(out, JSON.stringify(results, null, 1) + '\n');
  log('wrote', out);
} catch (error) {
  results.error = String(error?.message ?? error);
  writeFileSync(join(REPO, 'docs/development/phase3a-quality-benchmark/m4-task-check.json'), JSON.stringify(results, null, 1) + '\n');
  throw error;
} finally {
  sh('docker', ['rm', '-f', NAME]);
  if (existsSync(ROOT)) rmSync(ROOT, { recursive: true, force: true });
}
