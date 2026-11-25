import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SttRequest } from '@vip/contracts';
import { alignSpeakers } from '../runs/align';
import { stitchWindows } from '../runs/stitch';
import { planWindows } from '../runs/windowing';
import { FakeDiarizationProvider } from './diarization/fake';
import { UnknownProviderError } from './errors';
import {
  diarizationRawKey,
  LocalRawStore,
  obtainRawOutput,
  RawOutputExistsError,
  sttRawKey,
} from './raw-store';
import { resolveProviders } from './registry';
import { FakeSttProvider } from './stt/fake';

const WS = '11111111-1111-4111-8111-111111111111';
const RUN = '22222222-2222-4222-8222-222222222222';

let root: string;
let store: LocalRawStore;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'vip-providers-'));
  store = new LocalRawStore(root);
});
afterEach(() => rm(root, { recursive: true, force: true }));

const request = (
  index: number,
  startMs: number,
  endMs: number,
  durationMs: number,
): SttRequest => ({
  audioUri: 'local://normalized/x',
  offsetMs: startMs,
  audioDurationMs: durationMs,
  window: { index, startMs, endMs },
  rawKey: sttRawKey(WS, RUN, index),
});

describe('fake STT provider', () => {
  it('is deterministic: same window, same output and same raw bytes', async () => {
    const a = await new FakeSttProvider(store).transcribe(request(3, 87_000, 117_000, 200_000));
    const b = await new FakeSttProvider(store).transcribe(request(3, 87_000, 117_000, 200_000));
    expect(b.segments).toEqual(a.segments);
    expect(b.raw.sha256).toBe(a.raw.sha256);
  });

  it('reports fake output: placeholder text, language en, no confidence, fake capabilities', async () => {
    const stt = new FakeSttProvider(store);
    expect(stt.capabilities()).toMatchObject({
      fake: true,
      languages: ['en'],
      wordTimestamps: false,
    });
    const out = await stt.transcribe(request(0, 0, 30_000, 100_000));
    expect(out.segments.length).toBeGreaterThan(0);
    for (const s of out.segments) {
      expect(s.text).toMatch(/^\[fake transcript\] window 0 \(\d\d:\d\d:\d\d–\d\d:\d\d:\d\d\)$/);
      expect(s.language).toBe('en');
      expect(Object.hasOwn(s, 'confidence')).toBe(false);
    }
    expect(out.segments[0]!.text).toBe('[fake transcript] window 0 (00:00:00–00:00:10)');
  });

  it('stores the raw payload first, atomically, and its sha256 matches the stored bytes', async () => {
    const out = await new FakeSttProvider(store).transcribe(request(2, 58_000, 88_000, 100_000));
    const key = sttRawKey(WS, RUN, 2);
    const bytes = await readFile(join(root, key));
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(out.raw.sha256);
    expect(out.raw.payloadUri).toBe(`local://${key}`);
    expect(out.raw.providerModel).toBe('fake-stt-1');
    const names = await readdir(join(root, 'runs', WS, RUN, 'stt'));
    expect(names).toEqual(['2.json']); // no temp files left behind
  });

  it('mapRaw reproduces the segments from the stored payload', async () => {
    const stt = new FakeSttProvider(store);
    const req = request(1, 29_000, 59_000, 100_000);
    const out = await stt.transcribe(req);
    const stored = await store.get(req.rawKey);
    expect(stt.mapRaw(stored.payload, req)).toEqual(out.segments);
    expect(() => stt.mapRaw({ nope: true }, req)).toThrow(/RAW_OUTPUT_INVALID/);
  });

  it('windows plus stitching cover the recording once, with no duplicate or missing segment', async () => {
    for (const durationMs of [4_000, 29_500, 30_500, 100_000, 3_600_000 / 6]) {
      // Each duration is a different recording: its own store, since raw output is write-once.
      const stt = new FakeSttProvider(new LocalRawStore(join(root, String(durationMs))));
      const plan = planWindows({ durationMs });
      const results = [];
      for (const w of plan.windows) {
        const out = await stt.transcribe(request(w.index, w.startMs, w.endMs, durationMs));
        results.push({ window: w, segments: out.segments, rawOutputId: `r${String(w.index)}` });
      }
      const stitched = stitchWindows(results);
      const starts = stitched.map((s) => s.startMs);
      expect(new Set(starts).size).toBe(starts.length);
      expect(stitched[0]!.startMs).toBe(0);
      expect(stitched.at(-1)!.endMs).toBe(durationMs);
      for (let i = 1; i < stitched.length; i += 1) {
        expect(stitched[i]!.startMs).toBe(stitched[i - 1]!.endMs); // contiguous grid
      }
    }
  });
});

describe('fake diarization provider', () => {
  const req = (durationMs: number) => ({
    audioUri: 'local://normalized/x',
    durationMs,
    rawKey: diarizationRawKey(WS, RUN),
  });

  it('is deterministic and alternates two speakers on a fixed grid with an overlap every third turn', async () => {
    const d = new FakeDiarizationProvider(store);
    const a = await d.diarize(req(45_000));
    const b = await d.diarize(req(45_000));
    expect(b.turns).toEqual(a.turns);
    expect(a.raw.sha256).toBe(b.raw.sha256);
    expect(a.turns).toEqual([
      { startMs: 0, endMs: 10_000, speakerKey: 'SPEAKER_00' },
      { startMs: 10_000, endMs: 20_000, speakerKey: 'SPEAKER_01' },
      { startMs: 20_000, endMs: 30_500, speakerKey: 'SPEAKER_00' },
      { startMs: 30_000, endMs: 40_000, speakerKey: 'SPEAKER_01' },
      { startMs: 40_000, endMs: 45_000, speakerKey: 'SPEAKER_00' },
    ]);
    expect(d.capabilities()).toMatchObject({ fake: true, windowed: false });
  });

  it('end to end with fake STT: every segment gets a speaker and the overlap is flagged', async () => {
    const stt = new FakeSttProvider(store);
    const d = new FakeDiarizationProvider(store);
    const durationMs = 45_000;
    const plan = planWindows({ durationMs });
    const results = [];
    for (const w of plan.windows) {
      const out = await stt.transcribe(request(w.index, w.startMs, w.endMs, durationMs));
      results.push({ window: w, segments: out.segments, rawOutputId: 'r' });
    }
    const segments = stitchWindows(results);
    const { turns } = await d.diarize(req(durationMs));
    const { assignments, uncertainties } = alignSpeakers(segments, turns);
    expect(assignments.map((a) => a.speakerKey)).toEqual(
      ['SPEAKER_00', 'SPEAKER_01', 'SPEAKER_00', 'SPEAKER_01', 'SPEAKER_00'].slice(
        0,
        segments.length,
      ),
    );
    expect(uncertainties).toEqual([
      expect.objectContaining({ kind: 'overlapping_speech', startMs: 30_000, endMs: 30_500 }),
    ]);
  });
});

describe('raw store', () => {
  it('refuses keys that are not built from IDs and indexes', async () => {
    await expect(store.put('../escape.json', {})).rejects.toThrow('Invalid raw output key');
    await expect(store.put(`runs/${WS}/${RUN}/stt/../../x.json`, {})).rejects.toThrow();
    await expect(store.get('runs/a/b/stt/0.json')).rejects.toThrow('Invalid raw output key');
  });

  /* Regression (Phase 2C audit §11.4): raw output is write-once. */
  const key = sttRawKey(WS, RUN, 3);
  const raw = (sha256: string) => ({ payloadUri: store.uriFor(key), sha256, providerModel: 'm' });

  it('never overwrites a stored object: different bytes throw and the stored bytes stay', async () => {
    const first = await store.put(key, { n: 1 });
    await expect(store.put(key, { n: 2 })).rejects.toBeInstanceOf(RawOutputExistsError);
    const stored = await store.get(key);
    expect(stored.payload).toEqual({ n: 1 });
    expect(stored.sha256).toBe(first.sha256);
  });

  it('writing identical bytes again is an idempotent no-op with the same hash', async () => {
    const first = await store.put(key, { n: 1 });
    await expect(store.put(key, { n: 1 })).resolves.toEqual(first);
  });

  it('concurrent writes of different payloads: exactly one wins and nothing is left behind', async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, (_, n) => store.put(key, { n })),
    );
    const won = results.filter((r) => r.status === 'fulfilled');
    expect(won).toHaveLength(1);
    for (const r of results.filter((x) => x.status === 'rejected')) {
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(RawOutputExistsError);
    }
    const stored = await store.get(key);
    expect(stored.sha256).toBe((won[0] as PromiseFulfilledResult<{ sha256: string }>).value.sha256);
    expect(await readdir(join(root, 'runs', WS, RUN, 'stt'))).toEqual(['3.json']); // no temp files
  });

  it('find resolves null for a missing object and the object once stored', async () => {
    await expect(store.find(key)).resolves.toBeNull();
    await store.put(key, { n: 1 });
    await expect(store.find(key)).resolves.toMatchObject({ payload: { n: 1 } });
  });

  it('obtainRawOutput adopts an object left by a stopped attempt instead of calling the provider', async () => {
    const stored = await store.put(key, { n: 1 });
    const call = jest.fn();
    const out = await obtainRawOutput(store, key, 'm', call, (p) => ({ value: p }));
    expect(call).not.toHaveBeenCalled();
    expect(out).toEqual({ value: { n: 1 }, raw: raw(stored.sha256) });
  });

  it('obtainRawOutput calls the provider when nothing is stored and returns its result', async () => {
    let result: { value: string; raw: ReturnType<typeof raw> } | undefined;
    const out = await obtainRawOutput(
      store,
      key,
      'm',
      async () => {
        result = { value: 'fresh', raw: raw((await store.put(key, { n: 1 })).sha256) };
        return result;
      },
      () => ({ value: 'mapped' }),
    );
    expect(out).toBe(result);
  });

  it('obtainRawOutput refuses a provider result whose hash does not match the stored bytes', async () => {
    await expect(
      obtainRawOutput(
        store,
        key,
        'm',
        async () => {
          await store.put(key, { n: 1 });
          return { raw: raw('a'.repeat(64)) }; // adapter misreports the hash
        },
        () => ({}),
      ),
    ).rejects.toMatchObject({ code: 'RAW_OUTPUT_CORRUPT', retryable: false });
  });

  it('obtainRawOutput refuses a provider result that stored nothing', async () => {
    await expect(
      obtainRawOutput(
        store,
        key,
        'm',
        () => Promise.resolve({ raw: raw('a'.repeat(64)) }),
        () => ({}),
      ),
    ).rejects.toMatchObject({ code: 'RAW_OUTPUT_CORRUPT' });
  });

  it('a stored object that is not valid JSON is a non-retryable RAW_OUTPUT_CORRUPT', async () => {
    await mkdir(join(root, 'runs', WS, RUN, 'stt'), { recursive: true });
    await writeFile(join(root, key), '{not json');
    await expect(store.find(key)).rejects.toMatchObject({
      code: 'RAW_OUTPUT_CORRUPT',
      retryable: false,
    });
  });

  it('obtainRawOutput uses the stored object when a concurrent attempt stored first', async () => {
    let winner = '';
    const out = await obtainRawOutput(
      store,
      key,
      'm',
      async () => {
        winner = (await store.put(key, { by: 'other attempt' })).sha256; // lands between find and put
        await store.put(key, { by: 'this attempt' });
        throw new Error('unreachable');
      },
      (p) => ({ value: p }),
    );
    expect(out).toEqual({ value: { by: 'other attempt' }, raw: raw(winner) });
  });

  it('obtainRawOutput passes other provider errors through', async () => {
    await expect(
      obtainRawOutput(
        store,
        key,
        'm',
        () => Promise.reject(new Error('boom')),
        () => ({}),
      ),
    ).rejects.toThrow('boom');
  });
});

const NO_AUDIO = {
  audio: {
    audio: {
      capabilities: () => Promise.reject(new Error('unused')),
      submit: () => Promise.reject(new Error('unused')),
      get: () => Promise.reject(new Error('unused')),
      cancel: () => Promise.reject(new Error('unused')),
    },
    pollMs: 1,
  },
  diarization: {
    clusteringThreshold: 0.6,
    minDurationOnMs: 300,
    minDurationOffMs: 500,
    wholeFileMaxMs: 600_000,
    windowMs: 600_000,
    overlapMs: 30_000,
    matchThreshold: 0.5,
  },
  vad: { threshold: 0.4, minSilenceMs: 300, minSpeechMs: 250, paddingMs: 200 },
};

describe('provider registry', () => {
  it('resolves the fake adapters', () => {
    const p = resolveProviders(
      { sttProvider: 'fake', diarizationProvider: 'fake' },
      store,
      NO_AUDIO,
    );
    expect(p.stt.id).toBe('fake');
    expect(p.diarization.id).toBe('fake');
  });

  it('an unknown key is a startup error naming the variable and key, not content', () => {
    expect(() =>
      resolveProviders({ sttProvider: 'whisper', diarizationProvider: 'fake' }, store, NO_AUDIO),
    ).toThrow(UnknownProviderError);
    expect(() =>
      resolveProviders({ sttProvider: 'fake', diarizationProvider: 'x' }, store, NO_AUDIO),
    ).toThrow(/DIARIZATION_PROVIDER/);
    expect(() =>
      resolveProviders(
        { sttProvider: 'constructor', diarizationProvider: 'fake' },
        store,
        NO_AUDIO,
      ),
    ).toThrow(UnknownProviderError);
  });

  it('resolves the selected self-hosted adapters (ADR-0036 / ADR-0037)', () => {
    const p = resolveProviders(
      { sttProvider: 'whisper-cpp', diarizationProvider: 'sherpa-onnx' },
      store,
      NO_AUDIO,
    );
    expect([p.stt.id, p.stt.capabilities().fake]).toEqual(['whisper-cpp', false]);
    expect([p.diarization.id, p.diarization.capabilities().fake]).toEqual(['sherpa-onnx', false]);
  });
});
