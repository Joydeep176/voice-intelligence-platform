import type { RecordingMetadata } from '@vip/contracts';

export type EvidenceAvailability = { available: false; label: string; reason: string };

/**
 * There is no evidence API (Context Intelligence, Research and Fact Validation are not
 * connected), so evidence is never available. The reason comes from the recording's real run.
 */
export function evidenceAvailability(recording: RecordingMetadata): EvidenceAvailability {
  const label = 'Not available';
  if (recording.latestRun === null) return { available: false, label, reason: 'No analysis run' };
  if (recording.latestRun.status === 'created') {
    return {
      available: false,
      label,
      reason: 'Run not submitted · research and fact validation not connected',
    };
  }
  return { available: false, label, reason: 'Evidence service not available yet' };
}
