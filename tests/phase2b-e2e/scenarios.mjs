import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { api, getRecording, sha256File, snapshot, upload } from './lib/client.mjs';
import * as S from './lib/stack.mjs';

const uploaded = []; // every original uploaded: { id, sha256, label }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rows = async (ctx, q) => (await ctx.db.d.execute(q)).rows;

async function up(ctx, path, label, opts) {
  const u = await upload(path, opts);
  if (u.id) uploaded.push({ id: u.id, sha256: u.sha256, label });
  return u;
}
const settle = (id, pred, what, timeoutMs = 120000) =>
  S.waitUntil(
    async () => {
      const s = (await snapshot(id)).json;
      return pred(s) ? s : null;
    },
    { what, timeoutMs, intervalMs: 100 },
  );
const waitValid = (id) =>
  settle(
    id,
    (s) => s.recording.status === 'valid' || s.recording.status === 'invalid',
    `probe of ${id}`,
  );
const derivedDir = (id, hash) => join(S.STORAGE, 'derived', S.WORKSPACE_ID, id, hash);
const tmpDirs = () => {
  const out = [];
  const root = join(S.STORAGE, 'derived');
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name.startsWith('.tmp-')) out.push(join(d, e.name));
      else if (e.isDirectory()) walk(join(d, e.name));
    }
  };
  walk(root);
  return out;
};
const ffprocs = () => {
  const r = S.docker('top', S.audioContainer(), '-eo', 'pid,comm');
  return r.stdout.split('\n').filter((l) => /ffmpeg|ffprobe/.test(l)).length;
};
const hasKey = (o, k) =>
  o && typeof o === 'object' && (k in o || Object.values(o).some((v) => hasKey(v, k)));
const runToEnd = async (id) => {
  await waitValid(id);
  const r = await api('POST', `/recordings/${id}/processing`);
  assert.ok([200, 202].includes(r.status), `start status ${r.status}`);
  return settle(
    id,
    (s) => ['completed', 'failed', 'cancelled'].includes(s.state),
    `processing of ${id}`,
    600000,
  );
};

export const scenarios = [];
const sc = (name, fn) => scenarios.push({ name, fn });

sc('0 isolation: test DB, throwaway storage, redis db 14, audio on loopback', async (ctx) => {
  assert.ok(S.testDbName().endsWith('_test'));
  assert.ok(S.STORAGE.startsWith('/private/tmp/'));
  const ports = S.docker('port', S.audioContainer(), '8001').stdout;
  assert.match(ports, /^127\.0\.0\.1:8001/m);
  assert.doesNotMatch(ports, /0\.0\.0\.0|\[::\]/);
  ctx.note(`db=${S.testDbName()} redisDb=14 apiPort=${S.API_PORT}`);
});

sc('1 upload + consent -> automatic probe -> valid with probe metadata (no tags)', async (ctx) => {
  const u = await up(ctx, ctx.f.speech20mp3, 'speech20mp3');
  assert.equal(u.created.status, 201);
  assert.equal(u.complete.status, 200);
  ctx.rec1 = u.id;
  const s = await waitValid(u.id);
  assert.equal(s.recording.status, 'valid', JSON.stringify(s.recording));
  assert.equal(s.probe.channels, 2);
  assert.equal(s.probe.sampleRateHz, 44100);
  assert.ok(Math.abs(s.probe.durationMs - 20000) < 200, `duration ${s.probe.durationMs}`);
  const [r] = await rows(
    ctx,
    ctx.db
      .sql`select duration_ms, sample_rate, channels, media_probe from recordings where id = ${u.id}`,
  );
  assert.ok(r.duration_ms > 0 && r.sample_rate === 44100 && r.channels === 2);
  assert.ok(r.media_probe && typeof r.media_probe === 'object');
  assert.equal(hasKey(r.media_probe, 'tags'), false, 'media_probe contains tags');
  assert.equal((await getRecording(u.id)).json.status, 'valid');
});

sc(
  '2 processing -> persisted progress -> completed; canonical, manifest, measurements, timeline, vad, audit',
  async (ctx) => {
    const u = await up(ctx, ctx.f.conc1, 'conc1-scenario2');
    ctx.rec2 = u.id;
    await waitValid(u.id);
    const seen = new Set();
    let progressSeen = 0;
    const start = await api('POST', `/recordings/${u.id}/processing`);
    assert.equal(start.status, 202);
    assert.equal(start.json.state, 'queued');
    const states = [start.json.state];
    const fin = await S.waitUntil(
      async () => {
        const s = (await snapshot(u.id)).json;
        if (!seen.has(s.state)) {
          seen.add(s.state);
          states.push(s.state);
        }
        if (s.preprocessing?.progress) progressSeen++;
        return ['completed', 'failed', 'cancelled'].includes(s.state) ? s : null;
      },
      { what: 'completion', timeoutMs: 300000, intervalMs: 50 },
    );
    assert.equal(fin.state, 'completed', JSON.stringify(fin.preprocessing?.error));
    ctx.note(`states=${states.join('>')} snapshotsWithProgress=${progressSeen}`);
    assert.ok(states.includes('processing'), 'never observed state "processing"');
    assert.ok(
      progressSeen >= 1,
      'no persisted progress update observed (snapshot.progress never non-null)',
    );
    const p = fin.preprocessing;
    const dir = derivedDir(u.id, p.configHash);
    assert.ok(existsSync(join(dir, 'canonical.wav')), 'canonical.wav missing');
    const sha = await sha256File(join(dir, 'canonical.wav'));
    const [row] = await rows(
      ctx,
      ctx.db
        .sql`select canonical_sha256, canonical_duration_ms, normalized_uri, vad, timeline from audio_preprocessings where id = ${p.id}`,
    );
    assert.equal(sha, row.canonical_sha256);
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
    const onDisk = readdirSync(dir)
      .filter((n) => n !== 'manifest.json')
      .sort();
    assert.deepEqual(manifest.files.map((x) => x.name).sort(), onDisk);
    for (const f of manifest.files)
      assert.equal(await sha256File(join(dir, f.name)), f.sha256, `manifest sha ${f.name}`);
    // WAV data bytes / 2 bytes / 16 samples per ms == duration
    const wav = readFileSync(join(dir, 'canonical.wav'));
    let off = 12,
      dataBytes = -1;
    while (off + 8 <= wav.length) {
      const id = wav.toString('latin1', off, off + 4);
      const sz = wav.readUInt32LE(off + 4);
      if (id === 'data') {
        dataBytes = sz;
        break;
      }
      off += 8 + sz;
    }
    assert.ok(dataBytes > 0);
    assert.equal(dataBytes / 2 / 16, Number(row.canonical_duration_ms));
    assert.ok(Math.abs(Number(row.canonical_duration_ms) - 120000) < 200);
    const m = await rows(
      ctx,
      ctx.db
        .sql`select source, segment_id from audio_measurements where preprocessing_id = ${p.id} order by source`,
    );
    assert.deepEqual(
      m.map((x) => x.source),
      ['canonical', 'original_decoded'],
    );
    assert.ok(m.every((x) => x.segment_id === null));
    assert.ok(row.timeline && row.timeline.mappingStatus, 'timeline not persisted');
    assert.equal(row.vad.status, 'not_configured');
    const [{ n }] = await rows(
      ctx,
      ctx.db.sql`select count(*)::int n from audio_segments where preprocessing_id = ${p.id}`,
    );
    assert.equal(n, 0);
    assert.equal(p.segmentCount, 0);
    const audit = await rows(
      ctx,
      ctx.db
        .sql`select action, resource_type, metadata from audit_events where workspace_id = ${S.WORKSPACE_ID} and (resource_id = ${u.id} or resource_id = ${p.id})`,
    );
    assert.ok(audit.length >= 1, 'no audit events');
    const blob = JSON.stringify(audit);
    assert.ok(
      !blob.includes('conc1.flac') &&
        !blob.includes(S.secrets.audioToken) &&
        !blob.includes('local://') &&
        !blob.includes('/storage'),
      'audit leaks names/paths/secret',
    );
    for (const a of audit)
      for (const v of Object.values(a.metadata ?? {}))
        assert.ok(['string', 'number', 'boolean'].includes(typeof v) || v === null);
    ctx.note(`audit actions: ${[...new Set(audit.map((a) => a.action))].join(',')}`);
    ctx.p2 = p;
  },
);

sc(
  '3 idempotency: second POST -> same row, no new task; concurrent double POST -> one row',
  async (ctx) => {
    const before = await rows(
      ctx,
      ctx.db
        .sql`select id, attempt, updated_at, finished_at from audio_preprocessings where recording_id = ${ctx.rec2}`,
    );
    assert.equal(before.length, 1);
    const again = await api('POST', `/recordings/${ctx.rec2}/processing`);
    assert.equal(again.status, 200);
    assert.equal(again.json.preprocessing.id, ctx.p2.id);
    await sleep(1500);
    const after = await rows(
      ctx,
      ctx.db
        .sql`select id, attempt, updated_at, finished_at from audio_preprocessings where recording_id = ${ctx.rec2}`,
    );
    assert.equal(after.length, 1);
    assert.equal(after[0].attempt, before[0].attempt);
    assert.equal(String(after[0].updated_at), String(before[0].updated_at));
    assert.equal(String(after[0].finished_at), String(before[0].finished_at));
    // fresh recording, two POSTs at once
    const u = await up(ctx, ctx.f.sine10, 'sine10-idem');
    await waitValid(u.id);
    const [a, b] = await Promise.all([
      api('POST', `/recordings/${u.id}/processing`),
      api('POST', `/recordings/${u.id}/processing`),
    ]);
    assert.equal(a.json.preprocessing.id, b.json.preprocessing.id);
    const fin = await settle(u.id, (s) => s.state === 'completed', 'idem completion');
    const rs = await rows(
      ctx,
      ctx.db.sql`select attempt from audio_preprocessings where recording_id = ${u.id}`,
    );
    assert.equal(rs.length, 1);
    assert.equal(rs[0].attempt, 1, `attempt ${rs[0].attempt}: task ran more than once`);
    const third = await api('POST', `/recordings/${u.id}/processing`);
    assert.equal(third.status, 200);
    assert.equal(third.json.preprocessing.id, fin.preprocessing.id);
  },
);

sc('4 corrupt / garbage / truncated / renamed HLS playlist rejected', async (ctx) => {
  const where = {};
  for (const [label, path, mime] of [
    ['garbage-wav', ctx.f.garbage, 'audio/wav'],
    ['truncated-flac', ctx.f.truncated, 'audio/flac'],
    ['hls-as-mp3', ctx.f.playlist, 'audio/mpeg'],
  ]) {
    const u = await up(ctx, path, label, { mimeType: mime });
    if (!u.id || u.complete?.status >= 400) {
      where[label] =
        `upload rejected (${u.created?.status}/${u.complete?.status} ${u.complete?.json?.code ?? u.created?.json?.code ?? ''})`;
      continue;
    }
    const s = await waitValid(u.id);
    assert.equal(s.recording.status, 'invalid', `${label}: ${JSON.stringify(s.recording)}`);
    assert.match(s.recording.validationError ?? '', /^[A-Z_]+$/, `${label}: missing error code`);
    where[label] = `probe invalid ${s.recording.validationError}`;
    const start = await api('POST', `/recordings/${u.id}/processing`);
    assert.ok(
      start.status >= 400,
      `${label}: processing start allowed on invalid recording (${start.status})`,
    );
  }
  ctx.note(JSON.stringify(where));
});

sc(
  '5 cancellation of a 12 min file with the real service; no ffmpeg/ffprobe/.tmp left',
  async (ctx) => {
    const u = await up(ctx, ctx.f.long12, 'long12-cancel');
    await waitValid(u.id);
    const start = await api('POST', `/recordings/${u.id}/processing`);
    assert.equal(start.status, 202);
    await S.waitUntil(() => ffprocs() > 0, {
      what: 'ffmpeg running',
      timeoutMs: 60000,
      intervalMs: 100,
    });
    const t0 = Date.now();
    const c = await api('POST', `/recordings/${u.id}/processing/cancel`);
    assert.equal(c.status, 202);
    const fin = await settle(
      u.id,
      (s) => ['cancelled', 'completed', 'failed'].includes(s.state),
      'cancelled',
      120000,
    );
    const tState = Date.now() - t0;
    assert.equal(fin.state, 'cancelled', `state ${fin.state}`);
    await S.waitUntil(() => ffprocs() === 0, {
      what: 'no ffmpeg',
      timeoutMs: 30000,
      intervalMs: 100,
    });
    const tProcs = Date.now() - t0;
    assert.deepEqual(tmpDirs(), []);
    ctx.note(`cancel->state=cancelled ${tState} ms; cancel->no ffmpeg/ffprobe ${tProcs} ms`);
  },
);

sc(
  '6 recovery: docker restart of audio container mid-task -> resubmitted, output identical to clean run',
  async (ctx) => {
    const a = await up(ctx, ctx.f.long12, 'long12-recovery');
    await waitValid(a.id);
    await api('POST', `/recordings/${a.id}/processing`);
    await S.waitUntil(() => ffprocs() > 0, {
      what: 'ffmpeg running',
      timeoutMs: 60000,
      intervalMs: 100,
    });
    const logBefore = readFileSync(S.logPath('orchestrator'), 'utf8').length;
    const t0 = Date.now();
    const r = S.docker('restart', '-t', '3', S.audioContainer());
    assert.equal(r.status, 0, r.stderr);
    await S.waitUntil(async () => (await fetch(`${S.AUDIO_URL}/health/live`)).ok, {
      what: 'audio back',
      timeoutMs: 90000,
    });
    const fin = await settle(
      a.id,
      (s) => ['completed', 'failed', 'cancelled'].includes(s.state),
      'recovery completion',
      600000,
    );
    assert.equal(fin.state, 'completed', JSON.stringify(fin.preprocessing?.error));
    const recoveryMs = Date.now() - t0;
    const clean = await up(ctx, ctx.f.long12, 'long12-clean');
    const cf = await runToEnd(clean.id);
    assert.equal(cf.state, 'completed');
    assert.equal(
      fin.preprocessing.canonical.sha256,
      cf.preprocessing.canonical.sha256,
      'canonical WAV differs from clean run',
    );
    const dirOf = (id, f) => derivedDir(id, f.preprocessing.configHash);
    const same = {};
    for (const name of ['canonical.wav', 'level-series.json']) {
      same[name] =
        (await sha256File(join(dirOf(a.id, fin), name))) ===
        (await sha256File(join(dirOf(clean.id, cf), name)));
      assert.ok(same[name], `${name} differs between recovered and clean run`);
    }
    const norm = (id, f) =>
      readFileSync(join(dirOf(id, f), 'result.json'), 'utf8')
        .split(id)
        .join('<rec>');
    const resultSame = norm(a.id, fin) === norm(clean.id, cf);
    assert.ok(resultSame, 'result.json differs beyond the recording id in storage keys');
    const x = resultSame,
      y = true;
    const [ra] = await rows(
      ctx,
      ctx.db.sql`select attempt from audio_preprocessings where id = ${fin.preprocessing.id}`,
    );
    assert.deepEqual(tmpDirs(), []);
    ctx.note(
      `restart->completed ${recoveryMs} ms; attempt=${ra.attempt}; canonical.wav + level-series.json byte-identical; result.json identical modulo recording id=${x && y}`,
    );
  },
);

sc(
  '7 concurrency: 3 recordings together -> all complete, service runs <= 1 task, no errors; 7b backpressure with 7',
  async (ctx) => {
    const ids = [];
    for (const n of [1, 2, 3]) {
      const u = await up(ctx, ctx.f[`conc${n}`], `conc${n}`);
      ids.push(u.id);
    }
    for (const id of ids) await waitValid(id);
    const errsBefore = ['api', 'orchestrator'].map(
      (n) => (readFileSync(S.logPath(n), 'utf8').match(/"level":"error"/g) ?? []).length,
    );
    const since = new Date().toISOString();
    const known = new Set();
    let maxRunningInService = 0,
      maxDbRunning = 0,
      maxFf = 0,
      polls = 0,
      stop = false;
    const refresh = () => {
      const l = S.docker('logs', '--since', since, S.audioContainer());
      for (const m of (l.stdout + l.stderr).matchAll(
        /"msg": "task_queued".*?"taskId": "([0-9a-f-]{36})"/g,
      ))
        known.add(m[1]);
    };
    const sampler = (async () => {
      let i = 0;
      while (!stop) {
        if (i++ % 5 === 0) refresh();
        const states = await Promise.all(
          [...known].map((t) =>
            fetch(`${S.AUDIO_URL}/v1/tasks/${t}`, {
              headers: { authorization: `Bearer ${S.secrets.audioToken}` },
            })
              .then((r) => r.json())
              .then(
                (j) => j.status,
                () => 'err',
              ),
          ),
        );
        maxRunningInService = Math.max(
          maxRunningInService,
          states.filter((x) => x === 'running').length,
        );
        polls++;
        const [{ n }] = await rows(
          ctx,
          ctx.db.sql`select count(*)::int n from audio_preprocessings where status = 'running'`,
        );
        maxDbRunning = Math.max(maxDbRunning, n);
        if (i % 3 === 0) maxFf = Math.max(maxFf, ffprocs());
        await sleep(80);
      }
    })();
    const starts = await Promise.all(ids.map((id) => api('POST', `/recordings/${id}/processing`)));
    assert.ok(starts.every((s) => s.status === 202));
    const fins = await Promise.all(
      ids.map((id) =>
        settle(
          id,
          (s) => ['completed', 'failed', 'cancelled'].includes(s.state),
          'concurrent completion',
          600000,
        ),
      ),
    );
    stop = true;
    await sampler;
    assert.ok(
      fins.every((f) => f.state === 'completed'),
      fins.map((f) => f.state).join(','),
    );
    assert.ok(known.size >= 3, `saw only ${known.size} service tasks`);
    assert.ok(maxRunningInService <= 1, `service ran ${maxRunningInService} tasks at once`);
    const errsAfter = ['api', 'orchestrator'].map(
      (n) => (readFileSync(S.logPath(n), 'utf8').match(/"level":"error"/g) ?? []).length,
    );
    assert.deepEqual(errsAfter, errsBefore, 'error-level log lines during concurrency window');
    ctx.note(
      `service tasks seen=${known.size} maxRunningInService=${maxRunningInService} (${polls} samples) maxDbRunningRows=${maxDbRunning} maxFfmpegProcs=${maxFf}`,
    );
    // 7b: more recordings than the service queue bound (max_queued_tasks default 4)
    const many = [];
    for (let i = 0; i < 7; i++) {
      const u = await up(ctx, ctx.f.sine10, `sine10-burst${i}`);
      many.push(u.id);
    }
    for (const id of many) await waitValid(id);
    await Promise.all(many.map((id) => api('POST', `/recordings/${id}/processing`)));
    const f2 = await Promise.all(
      many.map((id) =>
        settle(
          id,
          (s) => ['completed', 'failed', 'cancelled'].includes(s.state),
          'burst completion',
          600000,
        ),
      ),
    );
    const states = f2.map((f) => f.state);
    const att = (
      await rows(
        ctx,
        ctx.db
          .sql`select attempt from audio_preprocessings where recording_id in (${ctx.db.sql.join(
          many.map((i) => ctx.db.sql`${i}`),
          ctx.db.sql`, `,
        )})`,
      )
    ).map((r) => r.attempt);
    ctx.note(`7b burst of 7: states=${states.join(',')} attempts=${att.join(',')}`);
    assert.ok(
      states.every((x) => x === 'completed'),
      `burst states ${states.join(',')}`,
    );
  },
);

sc('8 auth: loopback only; 401 without/wrong token; token absent from logs', async (ctx) => {
  const url = `${S.AUDIO_URL}/v1/capabilities`;
  assert.equal((await fetch(url)).status, 401);
  assert.equal(
    (
      await fetch(url, {
        headers: { authorization: 'Bearer wrong-token-wrong-token-wrong-token-0000' },
      })
    ).status,
    401,
  );
  assert.equal(
    (await fetch(url, { headers: { authorization: `Bearer ${S.secrets.audioToken}` } })).status,
    200,
  );
  assert.equal(
    (await fetch(`${S.AUDIO_URL}/v1/tasks/00000000-0000-4000-8000-000000000009`)).status,
    401,
  );
  const lan = Object.values(networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);
  let lanResult = 'no non-loopback IPv4 interface';
  for (const ip of lan.slice(0, 1)) {
    const r = await fetch(`http://${ip}:8001/health/live`, {
      signal: AbortSignal.timeout(4000),
    }).then(
      () => 'REACHABLE',
      () => 'unreachable',
    );
    lanResult = `${r} on LAN address`;
    assert.equal(r, 'unreachable', 'audio port answers on a non-loopback address');
  }
  const dockerLogs = S.docker('logs', S.audioContainer());
  for (const text of [
    dockerLogs.stdout,
    dockerLogs.stderr,
    readFileSync(S.logPath('api'), 'utf8'),
    readFileSync(S.logPath('orchestrator'), 'utf8'),
  ]) {
    assert.ok(!text.includes(S.secrets.audioToken), 'token found in a log');
    assert.ok(!text.includes(S.secrets.signing), 'signing secret found in a log');
  }
  ctx.note(lanResult);
});

sc('9 originals unchanged (SHA-256) after all scenarios', async () => {
  assert.ok(uploaded.length >= 10);
  for (const o of uploaded) {
    const p = join(S.STORAGE, 'recordings', S.WORKSPACE_ID, o.id, 'original');
    if (!existsSync(p)) continue; // an upload rejected before storage commit leaves no original
    assert.equal(await sha256File(p), o.sha256, `original of ${o.label} changed`);
  }
  assert.deepEqual(tmpDirs(), [], 'leftover .tmp-* directories');
});
