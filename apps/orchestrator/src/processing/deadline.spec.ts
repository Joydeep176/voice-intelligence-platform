import { INTERIM_PROCESSING_LIMITS } from '@vip/contracts';
import { SERVICE_TASK_SLOTS, backstopDeadlineAt } from './deadline';

const cfg = { deadlineBaseMs: 120_000, deadlineGraceMs: 60_000 };

describe('backstopDeadlineAt', () => {
  it('uses the service-reported deadline plus grace when it exists', () => {
    expect(
      backstopDeadlineAt(
        { kind: 'preprocess', submittedAt: 1_000, reportedDeadlineAt: 50_000, durationMs: 10 },
        cfg,
      ),
    ).toBe(110_000);
  });

  it('derives the interim bound from the duration, counted from the first running observation', () => {
    expect(
      backstopDeadlineAt(
        {
          kind: 'preprocess',
          submittedAt: 1_000,
          runningSince: 7_000,
          reportedDeadlineAt: null,
          durationMs: 600_000,
        },
        cfg,
      ),
    ).toBe(7_000 + 120_000 + 300_000 + 60_000);
  });

  it('uses the longest accepted recording when the duration is unknown', () => {
    expect(
      backstopDeadlineAt(
        {
          kind: 'preprocess',
          submittedAt: 0,
          runningSince: 0,
          reportedDeadlineAt: undefined,
          durationMs: null,
        },
        cfg,
      ),
    ).toBe(120_000 + 0.5 * INTERIM_PROCESSING_LIMITS.maxDurationMs + 60_000);
  });

  it('bounds a running probe by the base only', () => {
    expect(
      backstopDeadlineAt(
        {
          kind: 'probe',
          submittedAt: 5_000,
          runningSince: 5_000,
          reportedDeadlineAt: undefined,
          durationMs: 9e9,
        },
        cfg,
      ),
    ).toBe(5_000 + 120_000 + 60_000);
  });

  it('does not time out a short task still queued behind a long one, but stays bounded', () => {
    const queued = backstopDeadlineAt(
      { kind: 'preprocess', submittedAt: 0, reportedDeadlineAt: undefined, durationMs: 10_000 },
      cfg,
    );
    const ownBound = 120_000 + 5_000 + 60_000;
    expect(queued).toBeGreaterThan(ownBound);
    expect(queued).toBe(
      SERVICE_TASK_SLOTS * (120_000 + 0.5 * INTERIM_PROCESSING_LIMITS.maxDurationMs) + 60_000,
    );
  });
});
