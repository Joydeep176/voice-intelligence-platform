import { FoundationCheckJob, type FoundationCheckResult } from '@vip/contracts';
import { UnrecoverableError } from 'bullmq';

/**
 * Phase 1 FOUNDATION TEST job. It validates the payload and returns an acknowledgement so the
 * queue boundary (producer → worker → result) can be exercised. It does NOT process audio and
 * touches no storage, database or provider.
 */
export function processFoundationCheck(
  data: unknown,
  now: () => Date = () => new Date(),
): FoundationCheckResult {
  const parsed = FoundationCheckJob.safeParse(data);
  // A malformed payload can never succeed, so it is not retried.
  if (!parsed.success) throw new UnrecoverableError('INVALID_PAYLOAD');
  return {
    checkId: parsed.data.checkId,
    processedBy: 'orchestrator',
    processedAt: now().toISOString(),
  };
}
