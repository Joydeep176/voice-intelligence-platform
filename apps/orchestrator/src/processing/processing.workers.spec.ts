import { DelayedError, UnrecoverableError } from 'bullmq';
import { runStep } from './processing.workers';
import { FINISH, TransientError, type ProcessingDeps, type StepOutcome } from './types';

const deps = { now: () => 1000, log: jest.fn() } as unknown as ProcessingDeps;
const makeJob = (attemptsMade = 0, attempts = 3) => ({
  data: { a: 1 },
  attemptsMade,
  opts: { attempts },
  updateData: jest.fn().mockResolvedValue(undefined),
  moveToDelayed: jest.fn().mockResolvedValue(undefined),
});
const step = (outcome: StepOutcome) => jest.fn().mockResolvedValue(outcome);

describe('runStep', () => {
  it('finishes the job when the step finishes', async () => {
    const job = makeJob();
    await runStep(deps, job as never, 'tok', step(FINISH), jest.fn());
    expect(job.moveToDelayed).not.toHaveBeenCalled();
  });

  it('moves the job to the delayed set (freeing the worker) and merges the data', async () => {
    const job = makeJob();
    await expect(
      runStep(
        deps,
        job as never,
        'tok',
        step({ kind: 'delay', delayMs: 2000, data: { taskId: 't' } }),
        jest.fn(),
      ),
    ).rejects.toBeInstanceOf(DelayedError);
    expect(job.updateData).toHaveBeenCalledWith({ a: 1, taskId: 't' });
    expect(job.moveToDelayed).toHaveBeenCalledWith(3000, 'tok');
  });

  it('rethrows a transient failure while BullMQ attempts remain', async () => {
    const job = makeJob(0, 3);
    const exhausted = jest.fn();
    await expect(
      runStep(
        deps,
        job as never,
        't',
        jest.fn().mockRejectedValue(new TransientError('X')),
        exhausted,
      ),
    ).rejects.toBeInstanceOf(TransientError);
    expect(exhausted).not.toHaveBeenCalled();
  });

  it('runs the exhaustion handler on the last attempt instead of throwing', async () => {
    const job = makeJob(2, 3);
    const exhausted = jest.fn().mockResolvedValue(undefined);
    await runStep(
      deps,
      job as never,
      't',
      jest.fn().mockRejectedValue(new TransientError('X')),
      exhausted,
    );
    expect(exhausted).toHaveBeenCalledWith(deps, job.data);
  });

  it('treats a malformed payload as unrecoverable', async () => {
    const zodError = Object.assign(new Error('bad'), { name: 'ZodError' });
    await expect(
      runStep(deps, makeJob() as never, 't', jest.fn().mockRejectedValue(zodError), jest.fn()),
    ).rejects.toBeInstanceOf(UnrecoverableError);
  });

  it('keeps a thenPreprocess set on the live job while the step ran (no lost explicit start)', async () => {
    const job = makeJob();
    (job.data as Record<string, unknown>).thenPreprocess = false;
    const latest = jest.fn().mockResolvedValue({ a: 1, thenPreprocess: true });
    await expect(
      runStep(
        deps,
        job as never,
        'tok',
        step({ kind: 'delay', delayMs: 10, data: { taskId: 't' } }),
        jest.fn(),
        latest,
      ),
    ).rejects.toBeInstanceOf(DelayedError);
    expect(job.updateData).toHaveBeenCalledWith({ a: 1, thenPreprocess: true, taskId: 't' });
  });
});
