import type {
  RunSnapshot,
  SpeakerDto,
  TranscriptPage,
  TranscriptSegmentDto,
  UncertaintyDto,
} from '@vip/contracts';

// Synthetic, content-free-of-real-speech fixtures (ADR-0004). Copied to e2e/transcription-fixtures.ts
// because e2e is a separate TypeScript project.
export const REC_ID = '22222222-2222-4222-8222-222222222222';
export const RUN_ID = '11111111-1111-4111-8111-111111111111';
export const NOW = Date.parse('2026-11-22T10:00:00.000Z');
export const iso = (offsetMs = 0) => new Date(NOW + offsetMs).toISOString();

const FAKE = { id: 'fake', model: 'fake-v1', fake: true };
const REAL = { id: 'local-stt', model: 'm1', fake: false };

export function run(over: Partial<RunSnapshot> = {}): RunSnapshot {
  return {
    id: RUN_ID,
    recordingId: REC_ID,
    status: 'created',
    currentStage: null,
    error: null,
    startedAt: null,
    completedAt: null,
    createdAt: iso(),
    updatedAt: iso(),
    preprocessingId: null,
    scope: ['transcription', 'diarization'],
    stages: [],
    providers: null,
    window: null,
    retryCount: 0,
    maxRetries: 3,
    cancelRequested: false,
    transcriptAvailable: false,
    ...over,
  };
}

export const queued = () => run({ status: 'queued', preprocessingId: PRE_ID });
const PRE_ID = '33333333-3333-4333-8333-333333333333';

export function running(
  transcription: number | null,
  diarization: 'pending' | number | null = 'pending',
): RunSnapshot {
  const progress = (f: number | null) =>
    f === null ? null : { fraction: f, processedMs: Math.round(f * 60_000), updatedAt: iso() };
  return run({
    status: 'running',
    currentStage: 'transcription',
    preprocessingId: PRE_ID,
    providers: { stt: FAKE, diarization: FAKE },
    window: { source: 'fixed_windows', windowMs: 30_000, overlapMs: 1_000, count: 2 },
    stages: [
      {
        node: 'transcription',
        status: 'running',
        attempt: 1,
        progress: progress(transcription),
        startedAt: iso(),
        finishedAt: null,
        error: null,
      },
      ...(diarization === 'pending'
        ? []
        : [
            {
              node: 'diarization' as const,
              status: 'running' as const,
              attempt: 1,
              progress: progress(diarization),
              startedAt: iso(),
              finishedAt: null,
              error: null,
            },
          ]),
    ],
  });
}

export const completed = (fake = true) =>
  run({
    status: 'completed',
    preprocessingId: PRE_ID,
    providers: { stt: fake ? FAKE : REAL, diarization: fake ? FAKE : REAL },
    window: { source: 'fixed_windows', windowMs: 30_000, overlapMs: 1_000, count: 2 },
    transcriptAvailable: true,
    stages: (['transcription', 'diarization'] as const).map((node) => ({
      node,
      status: 'completed' as const,
      attempt: 1,
      progress: { fraction: 1, processedMs: 60_000, updatedAt: iso() },
      startedAt: iso(),
      finishedAt: iso(),
      error: null,
    })),
  });

export const failed = (over: Partial<RunSnapshot> = {}) =>
  run({
    status: 'failed',
    preprocessingId: PRE_ID,
    error: { code: 'PROVIDER_TIMEOUT', node: 'transcription' },
    retryCount: 1,
    ...over,
  });

export const cancelled = () => run({ status: 'cancelled', preprocessingId: PRE_ID });

export const SPK_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const SPK_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

export const speakers: SpeakerDto[] = [
  { id: SPK_A, speakerKey: 'SPEAKER_00', displayName: null, totalSpeechMs: 42_000 },
  { id: SPK_B, speakerKey: 'SPEAKER_01', displayName: 'Interviewer', totalSpeechMs: 18_000 },
];

const seg = (n: number, over: Partial<TranscriptSegmentDto>): TranscriptSegmentDto => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  speakerId: SPK_A,
  startMs: n * 5_000,
  endMs: n * 5_000 + 4_000,
  text: `synthetic line ${n}`,
  language: 'en',
  codeSwitchSpans: null,
  confidence: null,
  words: null,
  ...over,
});

export const segments: TranscriptSegmentDto[] = [
  seg(1, {}),
  seg(2, { speakerId: SPK_B, text: 'यह एक परीक्षण पंक्ति है', language: 'hi' }),
  seg(3, { text: 'mixed line यह test hai', language: 'mixed', confidence: 0.82 }),
  seg(4, { speakerId: null, startMs: 3_725_000, endMs: 3_729_000 }),
];

export const SEG_IDS = segments.map((s) => s.id);

export const uncertainties: UncertaintyDto[] = [
  {
    id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    segmentId: segments[0]!.id,
    startMs: 5_000,
    endMs: 9_000,
    kind: 'overlapping_speech',
    score: null,
  },
  {
    id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    segmentId: segments[1]!.id,
    startMs: 10_000,
    endMs: 14_000,
    kind: 'speaker_uncertain',
    score: null,
  },
];

export function page(over: Partial<TranscriptPage> = {}): TranscriptPage {
  return {
    runId: RUN_ID,
    transcriptId: '44444444-4444-4444-8444-444444444444',
    version: 1,
    kind: 'machine',
    windowSource: 'fixed_windows',
    providers: { stt: FAKE, diarization: FAKE },
    items: segments,
    nextCursor: null,
    ...over,
  };
}
