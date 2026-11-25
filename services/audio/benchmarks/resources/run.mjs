// Phase 2B WS9a: resource benchmarks of the hardened audio container (512 MB / 1 CPU, unchanged).
// Usage: node services/audio/benchmarks/resources/run.mjs [--cases id,id] [--out dir]
// Synthetic signals only (ADR-0004). Never touches .local-storage or the development database:
// the container mounts a throwaway root, the service is driven directly over its internal API.
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, linkSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../../../..');
const contracts = await import(pathToFileURL(join(REPO, 'packages/contracts/dist/index.js')).href);
const SCRATCH = process.env.P2B_RES_ROOT ??
  '/private/tmp/claude-501/-Users-joydeepsingh-voice-intelligence-platform/40376644-792f-4829-9cef-f025d3692b5d/scratchpad/phase2b-resources';
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? process.argv[i + 1] : d; };
const OUT = resolve(arg('out', join(REPO, 'docs/development/phase2b-resources')));
const ROOT = join(SCRATCH, 'storage');
const FIX = join(SCRATCH, 'fixtures');
const SIDE_OUT = join(SCRATCH, 'sampler-out');
const IMAGE = 'vip-p2b-e2e-audio-service';
const COMPOSE = ['compose', '-p', 'vip-p2b-e2e', '-f', join(REPO, 'infra/docker/compose.yaml'), '--env-file', join(REPO, '.env'), '--profile', 'audio'];
const WS = '00000000-0000-4000-8000-0000000000b9';
const TOKEN = randomBytes(32).toString('hex'); // never printed or written
const AUDIO = 'http://127.0.0.1:8001';
const env = { ...process.env, AUDIO_SERVICE_TOKEN: TOKEN, AUDIO_STORAGE_HOST_ROOT: ROOT };
const sh = (c, a, o = {}) => spawnSync(c, a, { encoding: 'utf8', maxBuffer: 1 << 28, ...o });
const docker = (...a) => sh('docker', a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mb = (b) => (b === null || b === undefined ? null : +(b / 1048576).toFixed(1));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

/* ---------------- synthetic signal graphs (lavfi) ---------------- */
const gate = "volume='if(lt(mod(t,10),7),1,0)':eval=frame"; // 3 s silence in every 10 s
const speech = (sec, rate, seed) => `anoisesrc=d=${sec}:c=pink:r=${rate}:seed=${seed}:a=0.5,tremolo=f=4:d=0.8,${gate}`;
// 5 s of hard clipping in every 60 s (gain 30 saturates at conversion to s16/FLAC).
const speechClipped = (sec, rate, seed) => `${speech(sec, rate, seed)},volume='if(between(mod(t,60),40,45),30,1)':eval=frame`;
const stereo = (g) => ['-f', 'lavfi', '-i', g, '-ac', '2'];
const mono = (g) => ['-f', 'lavfi', '-i', g, '-ac', '1'];

export const CASES = [
  { id: 'mono16k-10s', label: '10 s mono 16 kHz WAV', durationS: 10, fmt: 'wav', args: [...mono(speech(10, 16000, 1)), '-c:a', 'pcm_s16le'] },
  { id: 'stereo44k-5min-mp3', label: '5 min stereo 44.1 kHz MP3', durationS: 300, fmt: 'mp3', args: [...stereo(speech(300, 44100, 2)), '-c:a', 'libmp3lame', '-b:a', '128k'] },
  { id: 'stereo48k-30min-wav', label: '30 min stereo 48 kHz WAV', durationS: 1800, fmt: 'wav', args: [...stereo(speech(1800, 48000, 3)), '-c:a', 'pcm_s16le'] },
  { id: 'stereo44k-60min-m4a', label: '60 min stereo 44.1 kHz M4A (AAC)', durationS: 3600, fmt: 'ipod', args: [...stereo(speech(3600, 44100, 4)), '-c:a', 'aac', '-b:a', '96k'] },
  { id: 'stereo48k-4h-flac', label: '4 h stereo 48 kHz FLAC (speech-like + silences + clipped sections)', durationS: 14400, fmt: 'flac', args: [...stereo(speechClipped(14400, 48000, 5)), '-c:a', 'flac'] },
  { id: 'silence-10min', label: '10 min silence only (stereo 48 kHz)', durationS: 600, fmt: 'wav', args: [...stereo('anullsrc=r=48000:cl=stereo:d=600'), '-c:a', 'pcm_s16le'] },
  { id: 'whitenoise-10min', label: '10 min white noise (stereo 48 kHz)', durationS: 600, fmt: 'wav', args: [...stereo('anoisesrc=d=600:c=white:r=48000:seed=7:a=0.5'), '-c:a', 'pcm_s16le'] },
  { id: 'clipped-10min', label: '10 min heavily clipped (stereo 48 kHz)', durationS: 600, fmt: 'wav', args: [...stereo('anoisesrc=d=600:c=white:r=48000:seed=8:a=0.9,volume=40'), '-c:a', 'pcm_s16le'] },
  {
    id: '8ch-192k-30s', label: '30 s 8-channel 192 kHz WAV', durationS: 30, fmt: 'wav',
    args: ['-filter_complex', `anoisesrc=d=30:c=pink:r=192000:seed=9:a=0.4,asplit=8${[0, 1, 2, 3, 4, 5, 6, 7].map((i) => `[a${i}]`).join('')};${[0, 1, 2, 3, 4, 5, 6, 7].map((i) => `[a${i}]volume=${(0.2 + i * 0.1).toFixed(1)}[b${i}]`).join(';')};${[0, 1, 2, 3, 4, 5, 6, 7].map((i) => `[b${i}]`).join('')}amerge=inputs=8`, '-c:a', 'pcm_s16le'],
  },
  { id: 'series-5x30min', label: 'Five consecutive 30 min stereo 48 kHz WAV jobs (one container)', durationS: 1800, series: 5, reuse: 'stereo48k-30min-wav' },
];

/* ---------------- fixtures ---------------- */
function originalPath(rec) { return join(ROOT, 'recordings', WS, rec, 'original'); }
function makeOriginal(c, rec) {
  const dest = originalPath(rec);
  mkdirSync(dirname(dest), { recursive: true });
  mkdirSync(FIX, { recursive: true });
  const cache = join(FIX, c.id);
  if (!existsSync(cache)) {
    log(`generating fixture ${c.id} (${c.durationS}s)`);
    const t0 = Date.now();
    const r = docker('run', '--rm', '--entrypoint', 'ffmpeg', '-v', `${FIX}:/out`, IMAGE, '-hide_banner', '-loglevel', 'error', '-y', ...c.args, '-f', c.fmt, `/out/${c.id}.part`);
    if (r.status !== 0) throw new Error(`fixture ${c.id}: ${r.stderr.slice(-400)}`);
    sh('mv', [join(FIX, `${c.id}.part`), cache]);
    log(`  generated ${mb(statSync(cache).size)} MB in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  }
  if (existsSync(dest)) rmSync(dest);
  linkSync(cache, dest); // same file system: no copy, original never modified
  return statSync(dest).size;
}

/* ---------------- container + sampler ---------------- */
function startAudio() {
  const r = sh('docker', [...COMPOSE, 'up', '-d', 'audio-service'], { env });
  if (r.status !== 0) throw new Error(`compose up: ${String(r.stderr).replace(TOKEN, '[token]').slice(-300)}`);
}
const audioId = () => docker('ps', '-q', '--filter', 'label=com.docker.compose.project=vip-p2b-e2e', '--filter', 'label=com.docker.compose.service=audio-service').stdout.trim();
function removeAudio() {
  sh('docker', [...COMPOSE, 'rm', '-sf', 'audio-service'], { env });
}
async function waitHealthy() {
  for (let i = 0; i < 200; i++) { try { if ((await fetch(`${AUDIO}/health/live`)).ok) return; } catch { /* starting */ } await sleep(300); }
  throw new Error('audio service not healthy');
}
const SIDE = 'vip-p2b-sampler';
function startSampler(id) {
  docker('rm', '-f', SIDE);
  mkdirSync(SIDE_OUT, { recursive: true });
  writeFileSync(join(SIDE_OUT, 'case'), 'idle');
  const child = spawn('docker', ['run', '--rm', '--name', SIDE, '--pid', `container:${id}`, '--cgroupns', 'host',
    '-v', '/sys/fs/cgroup:/cg:ro', '-v', `${join(HERE, 'sampler.py')}:/sampler.py:ro`, '-v', `${join(ROOT, 'derived')}:/data/derived:ro`, '-v', `${SIDE_OUT}:/out:ro`,
    '--entrypoint', 'python', IMAGE, '/sampler.py'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const samples = [];
  let ready = null, buf = '';
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) > -1) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      try { const j = JSON.parse(line); if (j.event === 'ready') ready = j; else samples.push(j); } catch { /* partial */ }
    }
  });
  let err = '';
  child.stderr.on('data', (d) => { err += d; });
  return { samples, child, get ready() { return ready; }, get err() { return err; } };
}
async function waitSamplerReady(s) {
  for (let i = 0; i < 100 && !s.ready; i++) await sleep(200);
  if (!s.ready) throw new Error(`sampler not ready: ${s.err.slice(-300)}`);
}
const setCase = (n) => writeFileSync(join(SIDE_OUT, 'case'), n);

/* ---------------- task driver ---------------- */
const hdr = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
let cfgCache;
async function config() {
  if (cfgCache) return cfgCache;
  const caps = await (await fetch(`${AUDIO}/v1/capabilities`, { headers: hdr })).json();
  const tv = contracts.toolVersionsFromCapabilities(caps);
  if (!tv) throw new Error('capabilities: cannot preprocess');
  const config = contracts.buildPreprocessConfig(tv);
  const hash = createHash('sha256').update(contracts.canonicalJson(config)).digest('hex');
  cfgCache = { config, hash, caps };
  return cfgCache;
}
async function runTask(rec) {
  const { config: cfg, hash } = await config();
  const body = {
    contractVersion: contracts.AUDIO_SERVICE_CONTRACT_VERSION, type: 'preprocess', idempotencyKey: `bench:${rec}:${hash.slice(0, 16)}`,
    workspaceId: WS, recordingId: rec,
    input: { originalKey: `recordings/${WS}/${rec}/original`, outputPrefix: `derived/${WS}/${rec}/${hash}` },
    config: cfg,
  };
  const t0 = performance.now();
  const res = await fetch(`${AUDIO}/v1/tasks`, { method: 'POST', headers: hdr, body: JSON.stringify(body) });
  const acc = await res.json();
  if (res.status !== 202) return { ok: false, httpStatus: res.status, error: acc.code ?? acc.title ?? 'rejected', wallS: 0 };
  let st;
  for (;;) {
    st = await (await fetch(`${AUDIO}/v1/tasks/${acc.taskId}`, { headers: hdr })).json();
    if (['succeeded', 'failed', 'cancelled'].includes(st.status)) break;
    await sleep(500);
  }
  const wallS = (performance.now() - t0) / 1000;
  const dir = join(ROOT, 'derived', WS, rec, hash);
  const files = existsSync(dir) ? readdirSync(dir).map((n) => ({ name: n, bytes: statSync(join(dir, n)).size })) : [];
  return { ok: st.status === 'succeeded', status: st.status, error: st.error, wallS, outputFiles: files, outputBytes: files.reduce((a, f) => a + f.bytes, 0), leftoverTmp: readdirSync(join(ROOT, 'derived', WS, rec, hash), { withFileTypes: true }).filter((e) => e.name.startsWith('.tmp-')).length };
}

function summarize(samples, caseName) {
  const s = samples.filter((x) => x.case === caseName && x.anon !== null);
  if (!s.length) return null;
  const max = (k) => Math.max(...s.map((x) => x[k] ?? 0));
  const gaps = s.slice(1).map((x, i) => x.t - s[i].t);
  return {
    samples: s.length,
    sampleHz: +(s.length / Math.max(0.001, s.at(-1).t - s[0].t)).toFixed(2),
    maxGapS: +Math.max(0, ...gaps).toFixed(2),
    cpuSeconds: +(((s.at(-1).cpuUsec ?? 0) - (s[0].cpuUsec ?? 0)) / 1e6).toFixed(2),
    throttledSeconds: +(((s.at(-1).throttledUsec ?? 0) - (s[0].throttledUsec ?? 0)) / 1e6).toFixed(2),
    memoryPeakCgroupMb: mb(s.at(-1).peak), // cumulative since container start (fresh container per case)
    memoryCurrentMaxMb: mb(max('current')),
    anonPeakMb: mb(max('anon')),
    anonAtStartMb: mb(s[0].anon),
    filePeakMb: mb(max('file')),
    pidsMax: max('pids'),
    ffmpegRssSumPeakMb: mb(max('ffRssKb') * 1024),
    ffmpegHwmPeakMb: mb(max('ffHwmKb') * 1024),
    ffmpegMaxConcurrent: max('ffN'),
    tempPeakMb: mb(max('tmpBytes')),
  };
}

function machineState() {
  const o = (c, a) => (sh(c, a).stdout ?? '').trim();
  const vmRss = o('sh', ['-c', "ps -axo rss=,comm= | grep -i 'com.apple.Virtualization.VirtualMachine\\|com.docker.virtualization\\|Docker Desktop' | awk '{s+=$1} END {print s*1024}'"]);
  return {
    at: new Date().toISOString(),
    swapUsage: o('sysctl', ['-n', 'vm.swapusage']),
    memoryPressure: o('sh', ['-c', "memory_pressure -Q 2>/dev/null | tail -1"]),
    dockerVmRssBytes: Number(vmRss) || null,
    vmStat: o('sh', ['-c', "vm_stat | head -8"]),
  };
}
function environment() {
  const o = (c, a) => (sh(c, a).stdout ?? '').trim();
  const info = JSON.parse(o('docker', ['info', '--format', '{{json .}}']));
  const inImage = (cmd) => (docker('run', '--rm', '--entrypoint', 'sh', IMAGE, '-c', cmd).stdout ?? '').trim();
  return {
    macOS: o('sw_vers', ['-productVersion']), build: o('sw_vers', ['-buildVersion']), arch: o('uname', ['-m']),
    cpu: o('sysctl', ['-n', 'machdep.cpu.brand_string']), hostMemoryBytes: Number(o('sysctl', ['-n', 'hw.memsize'])),
    docker: { client: o('docker', ['--version']), serverVersion: info.ServerVersion, operatingSystem: info.OperatingSystem, vmMemoryBytes: info.MemTotal, vmCpus: info.NCPU, cgroupVersion: info.CgroupVersion, cgroupDriver: info.CgroupDriver },
    desktopVersion: o('sh', ['-c', "defaults read /Applications/Docker.app/Contents/Info CFBundleShortVersionString 2>/dev/null"]) || null,
    image: IMAGE, ffmpeg: inImage('ffmpeg -version | head -1'), ffprobe: inImage('ffprobe -version | head -1'), python: inImage('/app/.venv/bin/python --version'),
    container: { memory: '512m', cpus: '1.0', pidsLimit: 64, readOnly: true, capDropAll: true, noNewPrivileges: true, tmpfs: '/tmp:16m noexec,nosuid,nodev', source: 'infra/docker/compose.yaml (unchanged)' },
    sampler: 'sidecar container, --pid container:<audio>, --cgroupns host, /sys/fs/cgroup read-only, 10 Hz',
  };
}

/* ---------------- main ---------------- */
mkdirSync(OUT, { recursive: true });
for (const d of [join(ROOT, 'recordings'), join(ROOT, 'derived')]) mkdirSync(d, { recursive: true });
const only = arg('cases', '').split(',').filter(Boolean);
const resultsPath = join(OUT, 'results.json');
const prior = existsSync(resultsPath) ? JSON.parse(readFileSync(resultsPath, 'utf8')) : {};
const results = { ...prior, environment: undefined, cases: prior.cases ?? {} };
let sideRef = null;
const cleanup = () => { try { sideRef?.child.kill('SIGTERM'); } catch { /* gone */ } docker('rm', '-f', SIDE); removeAudio(); sh('docker', ['network', 'rm', 'vip-p2b-e2e_vip-audio-dev']); };
process.on('SIGINT', () => { cleanup(); process.exit(130); });
try {
  const built = sh('docker', [...COMPOSE, 'build', 'audio-service'], { env });
  if (built.status !== 0) throw new Error('image build failed');
  results.environment = environment();
  results.machineStateAtStart = machineState();
  log('machine state', JSON.stringify(results.machineStateAtStart.memoryPressure), 'dockerVM RSS MB', mb(results.machineStateAtStart.dockerVmRssBytes));
  for (const c of CASES) {
    if (only.length && !only.includes(c.id)) continue;
    log(`=== ${c.id}`);
    rmSync(join(ROOT, 'derived'), { recursive: true, force: true });
    rmSync(join(ROOT, 'recordings'), { recursive: true, force: true });
    mkdirSync(join(ROOT, 'derived'), { recursive: true });
    const jobs = c.series ?? 1;
    const src = c.reuse ? CASES.find((x) => x.id === c.reuse) : c;
    const recs = Array.from({ length: jobs }, () => randomUUID());
    let originalBytes = 0;
    for (const r of recs) originalBytes = makeOriginal(src, r);
    const before = machineState();
    startAudio(); await waitHealthy();
    const side = (sideRef = startSampler(audioId()));
    await waitSamplerReady(side);
    await sleep(1500); // idle baseline
    const runs = [];
    const idleAnon = [];
    for (let j = 0; j < jobs; j++) {
      const name = `${c.id}#${j + 1}`;
      setCase(name); await sleep(300);
      log(`  job ${j + 1}/${jobs}`);
      const r = await runTask(recs[j]);
      await sleep(600); // let the sampler see the post-job state
      setCase('idle'); await sleep(1500);
      const sm = summarize(side.samples, name);
      const idle = side.samples.filter((x) => x.case === 'idle').at(-1);
      idleAnon.push(mb(idle?.anon));
      runs.push({ job: j + 1, ...r, rtf: r.wallS ? +(r.wallS / src.durationS).toFixed(4) : null, wallS: +r.wallS.toFixed(2), audioS: src.durationS, ...sm, idleAnonAfterMb: mb(idle?.anon), idleCurrentAfterMb: mb(idle?.current) });
      log(`  -> ${r.status ?? r.httpStatus} wall ${r.wallS.toFixed(1)} s, RTF ${(r.wallS / src.durationS).toFixed(4)}, anon peak ${sm?.anonPeakMb} MB, cgroup peak ${sm?.memoryPeakCgroupMb} MB, cpu ${sm?.cpuSeconds} s`);
    }
    const caseResult = { label: c.label, originalBytes, audioS: src.durationS, runs, containerStillRunning: audioId() !== '', machineBefore: before, machineAfter: machineState() };
    if (c.series) {
      const peaks = runs.map((x) => x.anonPeakMb);
      const idle = runs.map((x) => x.idleAnonAfterMb);
      caseResult.anonGrowth = {
        jobAnonPeaksMb: peaks, idleAnonAfterEachJobMb: idle,
        peakGrowthPctFirstToLast: +(((peaks.at(-1) - peaks[0]) / peaks[0]) * 100).toFixed(1),
        idleGrowthPctFirstToLast: +(((idle.at(-1) - idle[0]) / idle[0]) * 100).toFixed(1),
      };
    }
    results.cases[c.id] = caseResult;
    side.child.kill('SIGTERM'); docker('rm', '-f', SIDE); sideRef = null;
    const logs = docker('logs', audioId());
    caseResult.tokenInContainerLogs = (logs.stdout + logs.stderr).includes(TOKEN);
    removeAudio();
    rmSync(join(ROOT, 'derived'), { recursive: true, force: true });
    rmSync(join(ROOT, 'recordings'), { recursive: true, force: true });
    writeFileSync(resultsPath, JSON.stringify(results, null, 2) + '\n');
  }
  results.machineStateAtEnd = machineState();
  writeFileSync(resultsPath, JSON.stringify(results, null, 2) + '\n');
} finally {
  cleanup();
}
