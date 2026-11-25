import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  AudioServiceCapabilities,
  AudioTaskAccepted,
  AudioTaskCreateRequest,
  AudioTaskState,
  SttRequest,
} from '@vip/contracts';
import type { AudioTasks } from '../processing/audio-client';
import { providerTimeoutMs, runDeadlineMs } from '../runs/run.step';
import { SherpaOnnxDiarizationProvider } from './diarization/sherpa-onnx';
import { ProviderError } from './errors';
import { diarizationRawKey, LocalRawStore, sttRawKey } from './raw-store';
import { WhisperCppSttProvider } from './stt/whisper-cpp';

const WS = '11111111-1111-4111-8111-111111111111';
const REC = '33333333-3333-4333-8333-333333333333';
const RUN = '22222222-2222-4222-8222-222222222222';
const HASH = 'c'.repeat(64);
const source = { workspaceId: WS, recordingId: REC, preprocessingConfigHash: HASH };

const ENGINE = {
  id: 'whisper-cpp',
  model: 'ggml-small-q5_1',
  modelSha256: 'ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb',
  runtime: 'pywhispercpp 1.5.1',
  threads: 1,
};

/** Scripted audio service: each submit gets the next result (or failure) after one `running` poll. */
class ScriptedAudio implements AudioTasks {
  submits: AudioTaskCreateRequest[] = [];
  outcomes: Array<{ result?: Record<string, unknown>; error?: AudioTaskState['error'] }> = [];
  /** Statuses returned for the next submits as an existing, already finished task of that key. */
  terminalOnSubmit: Array<'failed' | 'cancelled'> = [];
  private states = new Map<string, AudioTaskState[]>();

  capabilities(): Promise<AudioServiceCapabilities> {
    return Promise.reject(new Error('unused'));
  }
  submit(request: AudioTaskCreateRequest): Promise<AudioTaskAccepted> {
    this.submits.push(request);
    const taskId = crypto.randomUUID();
    const earlier = this.terminalOnSubmit.shift();
    if (earlier) {
      const error = {
        code: earlier === 'failed' ? ('TIMEOUT' as const) : ('CANCELLED' as const),
        retryable: true,
      };
      const state = { taskId, type: request.type, progress: null, deadlineAt: null };
      this.states.set(taskId, [{ ...state, status: earlier, result: null, error }]);
      return Promise.resolve({ taskId, status: earlier });
    }
    const outcome = this.outcomes.shift() ?? {};
    const base = { taskId, type: request.type, progress: null, deadlineAt: null };
    this.states.set(taskId, [
      { ...base, status: 'running', result: null, error: null },
      outcome.error
        ? { ...base, status: 'failed', result: null, error: outcome.error }
        : { ...base, status: 'succeeded', result: outcome.result ?? null, error: null },
    ]);
    return Promise.resolve({ taskId, status: 'queued' });
  }
  get(taskId: string): Promise<AudioTaskState> {
    const list = this.states.get(taskId)!;
    return Promise.resolve(list.length > 1 ? list.shift()! : list[0]!);
  }
  cancel(): Promise<AudioTaskAccepted> {
    return Promise.reject(new Error('unused'));
  }
}

let root: string;
let store: LocalRawStore;
let audio: ScriptedAudio;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'vip-self-hosted-'));
  store = new LocalRawStore(root);
  audio = new ScriptedAudio();
});
afterEach(() => rm(root, { recursive: true, force: true }));

const deps = () => ({ audio, pollMs: 0, sleep: () => Promise.resolve() });
const VAD = { threshold: 0.4, minSilenceMs: 300, minSpeechMs: 250, paddingMs: 200 };

const sttRequest = (overrides: Partial<SttRequest> = {}): SttRequest => ({
  audioUri: 'local://derived/x/canonical.wav',
  offsetMs: 29_000,
  audioDurationMs: 75_000,
  window: { index: 1, startMs: 29_000, endMs: 59_000 },
  languageHints: ['en', 'hi'],
  rawKey: sttRawKey(WS, RUN, 1),
  source,
  ...overrides,
});

const transcribeResult = (
  segments: Array<{ startMs: number; endMs: number; text: string; language?: 'en' | 'hi' }>,
) => ({
  schemaVersion: 1,
  engine: ENGINE,
  vad: {
    model: 'silero-vad-v6.2.3',
    sha256: '1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3',
    settings: VAD,
  },
  window: { startMs: 29_000, endMs: 59_000 },
  spans: segments.map((s) => ({
    startMs: s.startMs,
    endMs: s.endMs,
    detected: s.language ?? 'hi',
    probability: 0.9,
    decodedAs: s.language ?? 'hi',
  })),
  segments: segments.map((s) => ({ language: 'hi', ...s, tokenProbability: 0.8 })),
  warnings: [],
});

describe('whisper-cpp STT adapter (ADR-0036)', () => {
  it('submits a transcribe task for the canonical audio of the preprocessing version', async () => {
    audio.outcomes.push({ result: transcribeResult([]) });
    await new WhisperCppSttProvider(store, deps(), VAD).transcribe(sttRequest());
    const [sent] = audio.submits;
    expect(sent).toMatchObject({
      type: 'transcribe',
      workspaceId: WS,
      recordingId: REC,
      input: {
        originalKey: `recordings/${WS}/${REC}/original`,
        outputPrefix: `derived/${WS}/${REC}/${HASH}`,
      },
      config: {
        schemaVersion: 1,
        engine: 'whisper-cpp',
        window: { startMs: 29_000, endMs: 59_000 },
        audioDurationMs: 75_000,
        vad: VAD,
        languageHints: ['en', 'hi'],
      },
    });
  });

  it('stores the task config and result verbatim first, then maps segments without inventing confidence', async () => {
    audio.outcomes.push({
      result: transcribeResult([
        { startMs: 29_000, endMs: 33_000, text: 'नमस्ते' },
        { startMs: 33_000, endMs: 34_000, text: '[BLANK_AUDIO]' },
        { startMs: 34_000, endMs: 40_000, text: 'I am fine.', language: 'en' },
      ]),
    });
    const provider = new WhisperCppSttProvider(store, deps(), VAD);
    const out = await provider.transcribe(sttRequest());
    expect(out.segments).toEqual([
      { startMs: 29_000, endMs: 33_000, text: 'नमस्ते', language: 'hi' },
      { startMs: 34_000, endMs: 40_000, text: 'I am fine.', language: 'en' },
    ]);
    const stored = await store.get(sttRawKey(WS, RUN, 1));
    expect(stored.sha256).toBe(out.raw.sha256);
    expect(stored.payload).toMatchObject({ schema: 'audio-service-transcribe-v1' });
    // The marker stays in the raw output; only the mapping drops it.
    expect(JSON.stringify(stored.payload)).toContain('[BLANK_AUDIO]');
    expect(provider.mapRaw(stored.payload, sttRequest())).toEqual(out.segments);
  });

  it('derives the idempotency key from the task content, so a repeated submit joins the same task', async () => {
    // A submit whose response was lost (timeout, paused service) and its retry must not queue a
    // second identical inference task behind the first.
    audio.outcomes.push({ result: transcribeResult([]) }, { result: transcribeResult([]) });
    const provider = new WhisperCppSttProvider(store, deps(), VAD);
    await provider.transcribe(sttRequest());
    await provider.transcribe(sttRequest({ rawKey: sttRawKey(WS, RUN, 2) }));
    const keys = audio.submits.map((s) => s.idempotencyKey);
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toMatch(/^transcribe:[0-9a-f]{32}$/);
  });

  it('gives different windows different keys', async () => {
    audio.outcomes.push({ result: transcribeResult([]) }, { result: transcribeResult([]) });
    const provider = new WhisperCppSttProvider(store, deps(), VAD);
    await provider.transcribe(sttRequest());
    await provider.transcribe(
      sttRequest({
        offsetMs: 0,
        window: { index: 0, startMs: 0, endMs: 30_000 },
        rawKey: sttRawKey(WS, RUN, 0),
      }),
    );
    expect(new Set(audio.submits.map((s) => s.idempotencyKey)).size).toBe(2);
  });

  it('never replays an earlier failed or cancelled task: it resubmits under a fresh key', async () => {
    audio.terminalOnSubmit.push('failed', 'cancelled');
    audio.outcomes.push({ result: transcribeResult([]) });
    const provider = new WhisperCppSttProvider(store, deps(), VAD);
    await provider.transcribe(sttRequest());
    const keys = audio.submits.map((s) => s.idempotencyKey);
    expect(keys).toHaveLength(3);
    expect(keys[1]).toBe(`${keys[0]}:1`);
    expect(keys[2]).toBe(`${keys[0]}:2`);
  });

  it('maps task failures to ProviderError with the service retryability', async () => {
    audio.outcomes.push({ error: { code: 'TIMEOUT', retryable: true } });
    audio.outcomes.push({ error: { code: 'UNSUPPORTED_TASK_TYPE', retryable: false } });
    const provider = new WhisperCppSttProvider(store, deps(), VAD);
    await expect(provider.transcribe(sttRequest())).rejects.toMatchObject({
      code: 'AUDIO_TIMEOUT',
      retryable: true,
    });
    await expect(provider.transcribe(sttRequest())).rejects.toMatchObject({
      code: 'AUDIO_UNSUPPORTED_TASK_TYPE',
      retryable: false,
    });
  });

  it('needs the audio source and refuses output that breaks the contract', async () => {
    const provider = new WhisperCppSttProvider(store, deps(), VAD);
    await expect(provider.transcribe(sttRequest({ source: undefined }))).rejects.toMatchObject({
      code: 'AUDIO_SOURCE_REQUIRED',
      retryable: false,
    });
    audio.outcomes.push({
      result: transcribeResult([{ startMs: 1000, endMs: 2000, text: 'outside the window' }]),
    });
    await expect(provider.transcribe(sttRequest())).rejects.toMatchObject({
      code: 'PROVIDER_OUTPUT_INVALID',
    });
    await expect(store.find(sttRawKey(WS, RUN, 1))).resolves.toBeNull(); // nothing stored
  });

  it('refuses a stored payload from another model or another window', async () => {
    const provider = new WhisperCppSttProvider(store, deps(), VAD);
    const payload = {
      schema: 'audio-service-transcribe-v1',
      request: {
        schemaVersion: 1,
        engine: 'whisper-cpp',
        window: { startMs: 29_000, endMs: 59_000 },
        audioDurationMs: 75_000,
        vad: VAD,
      },
      result: transcribeResult([]),
    };
    expect(() =>
      provider.mapRaw(
        {
          ...payload,
          result: { ...payload.result, engine: { ...ENGINE, model: 'ggml-medium-q5_0' } },
        },
        sttRequest(),
      ),
    ).toThrow(ProviderError);
    expect(() =>
      provider.mapRaw(
        payload,
        sttRequest({ window: { index: 2, startMs: 58_000, endMs: 75_000 } }),
      ),
    ).toThrow(/RAW_OUTPUT_CONFLICT|Provider error/);
    expect(provider.capabilities()).toMatchObject({
      fake: false,
      languages: ['en', 'hi'],
      codeSwitching: false,
    });
  });
});

describe('sherpa-onnx diarization adapter (ADR-0037)', () => {
  const settings = {
    clusteringThreshold: 0.6,
    minDurationOnMs: 300,
    minDurationOffMs: 500,
    wholeFileMaxMs: 600_000,
    windowMs: 600_000,
    overlapMs: 30_000,
    matchThreshold: 0.5,
  };
  const diarizeResult = {
    schemaVersion: 1,
    engine: {
      id: 'sherpa-onnx',
      runtime: 'sherpa-onnx 2.0.2',
      threads: 1,
      segmentation: { model: 'pyannote-segmentation-3.0', sha256: '1'.repeat(64) },
      embedding: { model: '3dspeaker-campplus-en-voxceleb-16k', sha256: '2'.repeat(64) },
    },
    mode: 'whole',
    canonicalSha256: '3'.repeat(64),
    windows: [{ startMs: 0, endMs: 75_000, localSpeakers: 2 }],
    turns: [
      { startMs: 0, endMs: 10_000, speakerKey: 'SPEAKER_00' },
      { startMs: 10_000, endMs: 20_000, speakerKey: 'SPEAKER_01' },
    ],
    speakerCount: 2,
    warnings: [],
  };
  const request = {
    audioUri: 'local://x',
    durationMs: 75_000,
    rawKey: diarizationRawKey(WS, RUN),
    source,
  };

  it('sends the configured parameters, stores the raw output and maps the turns', async () => {
    audio.outcomes.push({ result: diarizeResult });
    const provider = new SherpaOnnxDiarizationProvider(store, deps(), settings);
    const out = await provider.diarize(request);
    expect(audio.submits[0]).toMatchObject({
      type: 'diarize',
      config: { engine: 'sherpa-onnx', audioDurationMs: 75_000, ...settings },
    });
    expect(out.turns).toEqual(diarizeResult.turns);
    expect((await store.get(request.rawKey)).sha256).toBe(out.raw.sha256);
    expect(provider.capabilities()).toEqual({ windowed: true, fake: false });
  });

  it('refuses a stored payload for another duration or another embedding model', async () => {
    audio.outcomes.push({ result: diarizeResult });
    const provider = new SherpaOnnxDiarizationProvider(store, deps(), settings);
    await provider.diarize(request);
    const stored = (await store.get(request.rawKey)).payload as Record<string, unknown>;
    expect(() => provider.mapRaw(stored, { ...request, durationMs: 80_000 })).toThrow(
      ProviderError,
    );
    const other = JSON.parse(JSON.stringify(stored)) as {
      result: { engine: { embedding: { model: string } } };
    };
    other.result.engine.embedding.model = 'wespeaker-resnet34';
    expect(() => provider.mapRaw(other, request)).toThrow(ProviderError);
  });
});

describe('duration-scaled bounds (interim OD-10)', () => {
  it('scales the provider-call bound and the run deadline with the audio duration', () => {
    const config = {
      providerTimeoutMs: 120_000,
      providerTimeoutPerAudioPermille: 5000,
      deadlineMs: 3_600_000,
      deadlinePerAudioPermille: 6000,
    };
    expect(providerTimeoutMs(config, 30_000)).toBe(270_000);
    expect(runDeadlineMs(config, 3_600_000)).toBe(3_600_000 + 21_600_000);
  });
});
