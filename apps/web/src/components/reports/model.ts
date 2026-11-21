import type { RecordingMetadata } from '@vip/contracts';

export type ReportSortKey = 'newest' | 'oldest' | 'name';

export const REPORT_SORTS: { key: ReportSortKey; label: string }[] = [
  { key: 'newest', label: 'Newest first' },
  { key: 'oldest', label: 'Oldest first' },
  { key: 'name', label: 'Name A–Z' },
];

export type ReportAvailability = { available: false; label: string; reason: string };

/**
 * There is no report API (A6 Reporting and A7 QA are not connected), so a report is never
 * available, whatever the run status. The reason is derived from the recording's real run.
 */
export function reportAvailability(recording: RecordingMetadata): ReportAvailability {
  const label = 'Not generated';
  if (recording.latestRun === null) return { available: false, label, reason: 'No analysis run' };
  if (recording.latestRun.status === 'created') {
    return { available: false, label, reason: 'Run not submitted · pipeline not connected' };
  }
  return { available: false, label, reason: 'Report service not available yet' };
}

const time = (iso: string) => {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
};

export function visibleReports(
  items: RecordingMetadata[],
  query: string,
  sort: ReportSortKey,
): RecordingMetadata[] {
  const q = query.trim().toLowerCase();
  const out = items.filter((r) => !q || r.originalFilename.toLowerCase().includes(q));
  switch (sort) {
    case 'oldest':
      return out.sort((a, b) => time(a.createdAt) - time(b.createdAt));
    case 'name':
      return out.sort((a, b) => a.originalFilename.localeCompare(b.originalFilename));
    default:
      return out.sort((a, b) => time(b.createdAt) - time(a.createdAt));
  }
}
