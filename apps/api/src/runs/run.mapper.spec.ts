import { RunSnapshot } from '@vip/contracts';
import type { PipelineRun, PipelineStageRun } from '@vip/db';
import { toRunSnapshot } from './run.mapper';

const T = new Date('2026-11-22T10:00:00.000Z');
const ID = '11111111-1111-4111-8111-111111111111';

const run = (over: Partial<PipelineRun> = {}): PipelineRun => ({
  id: ID,
  workspaceId: ID,
  recordingId: ID,
  status: 'running',
  currentNode: 'transcription',
  error: null,
  retryCount: 0,
  preprocessingId: ID,
  config: {
    schemaVersion: 1,
    stages: ['transcription', 'diarization'],
    providers: {
      stt: { id: 'fake', model: 'fake-stt-1', fake: true },
      diarization: { id: 'fake', model: 'fake-diarization-1', fake: true },
    },
    window: { source: 'fixed_windows', windowMs: 30000, overlapMs: 1000, count: 4 },
  },
  cancelRequestedAt: null,
  startedAt: T,
  finishedAt: null,
  createdAt: T,
  updatedAt: T,
  ...over,
});

const stage = (over: Partial<PipelineStageRun>): PipelineStageRun => ({
  id: ID,
  workspaceId: ID,
  runId: ID,
  node: 'transcription',
  attempt: 1,
  status: 'running',
  progress: { fraction: 0.5, processedMs: 1000, updatedAt: T.toISOString() },
  jobIds: null,
  startedAt: T,
  finishedAt: null,
  error: null,
  createdAt: T,
  updatedAt: T,
  ...over,
});

describe('toRunSnapshot', () => {
  it('builds a valid snapshot with per-stage status, progress, providers and window', () => {
    const snap = toRunSnapshot(run(), [stage({})], 3, false);
    expect(RunSnapshot.safeParse(snap).success).toBe(true);
    expect(snap.stages).toEqual([
      expect.objectContaining({
        node: 'transcription',
        status: 'running',
        progress: expect.objectContaining({ fraction: 0.5 }),
      }),
      expect.objectContaining({
        node: 'diarization',
        status: 'pending',
        attempt: 0,
        progress: null,
      }),
    ]);
    expect(snap.providers?.stt).toEqual({ id: 'fake', model: 'fake-stt-1', fake: true });
    expect(snap.window?.source).toBe('fixed_windows');
    expect(snap.currentStage).toBe('transcription');
  });

  it('uses the newest attempt of a stage (rows come newest first)', () => {
    const snap = toRunSnapshot(
      run({ retryCount: 1 }),
      [
        stage({ attempt: 2, status: 'running' }),
        stage({ attempt: 1, status: 'failed', error: { code: 'X' } }),
      ],
      3,
      false,
    );
    expect(snap.stages[0]).toMatchObject({ attempt: 2, status: 'running', error: null });
  });

  it('reports a failed stage with its code only', () => {
    const snap = toRunSnapshot(
      run({ status: 'failed', error: { code: 'PROVIDER_REJECTED', node: 'transcription' } }),
      [stage({ status: 'failed', error: { code: 'PROVIDER_REJECTED' } })],
      3,
      false,
    );
    expect(snap.error).toEqual({ code: 'PROVIDER_REJECTED', node: 'transcription' });
    expect(snap.stages[0]!.error).toEqual({ code: 'PROVIDER_REJECTED' });
  });

  it('a created run without config shows the default scope as pending and no providers', () => {
    const snap = toRunSnapshot(
      run({
        status: 'created',
        config: null,
        preprocessingId: null,
        currentNode: null,
        startedAt: null,
      }),
      [],
      3,
      false,
    );
    expect(snap.scope).toEqual(['transcription', 'diarization']);
    expect(snap.stages.every((s) => s.status === 'pending')).toBe(true);
    expect(snap.providers).toBeNull();
    expect(snap.window).toBeNull();
    expect(RunSnapshot.safeParse(snap).success).toBe(true);
  });

  it('cancelRequested is true for a cancelling run or a recorded request; garbage progress becomes null', () => {
    expect(toRunSnapshot(run({ status: 'cancelling' }), [], 3, false).cancelRequested).toBe(true);
    expect(toRunSnapshot(run({ cancelRequestedAt: T }), [], 3, false).cancelRequested).toBe(true);
    expect(toRunSnapshot(run(), [], 3, false).cancelRequested).toBe(false);
    const snap = toRunSnapshot(run(), [stage({ progress: { nonsense: 1 } })], 3, true);
    expect(snap.stages[0]!.progress).toBeNull();
    expect(snap.transcriptAvailable).toBe(true);
  });
});
