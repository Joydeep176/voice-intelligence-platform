import {
  AUDIO_SERVICE_CONTRACT_VERSION,
  type AudioServiceCapabilities,
  type AudioTaskAccepted,
  type AudioTaskCreateRequest,
  type AudioTaskState,
} from '@vip/contracts';
import { readFileSync } from 'node:fs';
import { AudioClientError, type AudioTasks } from '../../src/processing/audio-client';

const fixture = (name: string): Record<string, unknown> =>
  JSON.parse(
    readFileSync(
      new URL(
        `../../../../packages/contracts/fixtures/audio-service/${name}`,
        `file://${__dirname}/`,
      ),
      'utf8',
    ),
  ) as Record<string, unknown>;

export const CAPABILITIES = {
  contractVersion: AUDIO_SERVICE_CONTRACT_VERSION,
  serviceVersion: '0.1.0',
  python: '3.12.8',
  ffmpeg: { version: '7.1.2' },
  numpy: '2.5.5',
  vad: 'none',
  landlock: { supported: true, abi: 4, enforced: true },
  taskTypes: ['probe', 'preprocess'],
} as unknown as AudioServiceCapabilities;

/** A contract-valid `preprocess` result whose keys sit under the request's output prefix. */
export function preprocessResult(request: AudioTaskCreateRequest): Record<string, unknown> {
  const result = fixture('preprocess-result.valid.json') as {
    canonical: Record<string, unknown>;
    artifacts: Record<string, unknown>;
    toolVersions: Record<string, unknown>;
  };
  const prefix = request.input.outputPrefix;
  result.canonical.key = `${prefix}/canonical.wav`;
  result.artifacts.levelSeriesKey = `${prefix}/level-series.json`;
  result.artifacts.manifestKey = `${prefix}/manifest.json`;
  return result;
}

export const probeResult = (): Record<string, unknown> =>
  fixture('probe-result.wav-no-start.valid.json');

export type Plan =
  | { status: 'running'; progress?: AudioTaskState['progress']; deadlineAt?: number }
  | { status: 'succeeded'; result?: Record<string, unknown> }
  | { status: 'failed'; code: string; retryable: boolean }
  | { status: 'cancelled' };

/**
 * In-process audio service double with real idempotency semantics: a repeated key returns the
 * earlier task. Each task's polls follow a script (a plan per poll); the last plan repeats.
 */
export class FakeAudioTasks implements AudioTasks {
  readonly submits: AudioTaskCreateRequest[] = [];
  readonly cancels: string[] = [];
  readonly polls: string[] = [];
  /** Errors thrown by the next `submit` calls, in order. */
  submitErrors: AudioClientError[] = [];
  /** Throws on every call (service down). */
  down: AudioClientError | null = null;
  /** Task IDs that answer 404 TASK_NOT_FOUND once (the service forgot them). */
  readonly lost = new Set<string>();
  /** Scripts by task type, consumed per submission (not per key). */
  scripts: Record<AudioTaskCreateRequest['type'], Plan[][]> = {
    probe: [],
    preprocess: [],
    transcribe: [],
    diarize: [],
  };
  private readonly byKey = new Map<string, string>();
  private readonly tasks = new Map<
    string,
    { request: AudioTaskCreateRequest; plans: Plan[]; n: number }
  >();

  capabilities(): Promise<AudioServiceCapabilities> {
    if (this.down) return Promise.reject(this.down);
    return Promise.resolve(CAPABILITIES);
  }

  submit(request: AudioTaskCreateRequest): Promise<AudioTaskAccepted> {
    if (this.down) return Promise.reject(this.down);
    const error = this.submitErrors.shift();
    if (error) return Promise.reject(error);
    const known = this.byKey.get(request.idempotencyKey);
    if (known) return Promise.resolve({ taskId: known, status: 'queued' });
    const taskId = crypto.randomUUID();
    this.byKey.set(request.idempotencyKey, taskId);
    this.submits.push(request);
    const plans = this.scripts[request.type].shift() ?? [
      { status: 'running' },
      { status: 'succeeded' },
    ];
    this.tasks.set(taskId, { request, plans, n: 0 });
    return Promise.resolve({ taskId, status: 'queued' });
  }

  get(taskId: string): Promise<AudioTaskState> {
    if (this.down) return Promise.reject(this.down);
    this.polls.push(taskId);
    if (this.lost.delete(taskId)) {
      this.tasks.delete(taskId);
      return Promise.reject(new AudioClientError('LOST', 'TASK_NOT_FOUND', 404));
    }
    const task = this.tasks.get(taskId);
    if (!task) return Promise.reject(new AudioClientError('LOST', 'TASK_NOT_FOUND', 404));
    const plan = task.plans[Math.min(task.n, task.plans.length - 1)]!;
    task.n += 1;
    const base = { taskId, type: task.request.type, progress: null, result: null, error: null };
    switch (plan.status) {
      case 'running':
        return Promise.resolve({
          ...base,
          status: 'running',
          ...(plan.deadlineAt === undefined ? {} : { deadlineAt: plan.deadlineAt }),
          progress: plan.progress ?? { stage: 'decode', fraction: 0.5, processedMs: 1000 },
        });
      case 'succeeded':
        return Promise.resolve({
          ...base,
          status: 'succeeded',
          result:
            plan.result ??
            (task.request.type === 'probe' ? probeResult() : preprocessResult(task.request)),
        });
      case 'failed':
        return Promise.resolve({
          ...base,
          status: 'failed',
          error: { code: plan.code, retryable: plan.retryable },
        } as AudioTaskState);
      case 'cancelled':
        return Promise.resolve({ ...base, status: 'cancelled' });
    }
  }

  cancel(taskId: string): Promise<AudioTaskAccepted> {
    if (this.down) return Promise.reject(this.down);
    this.cancels.push(taskId);
    const task = this.tasks.get(taskId);
    if (task) task.plans = [{ status: 'cancelled' }];
    return Promise.resolve({ taskId, status: 'running' });
  }
}
