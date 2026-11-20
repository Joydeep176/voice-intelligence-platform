import type { RecordingMetadata, RecordingStatus } from '@vip/contracts';

export type StatusFilter = 'all' | 'ready' | 'progress' | 'rejected';
export type SortKey = 'newest' | 'oldest' | 'name' | 'largest';

export const FILTERS: { key: StatusFilter; label: string; statuses: RecordingStatus[] | null }[] = [
  { key: 'all', label: 'All', statuses: null },
  { key: 'ready', label: 'Ready', statuses: ['uploaded', 'valid'] },
  { key: 'progress', label: 'In progress', statuses: ['uploading', 'validating'] },
  { key: 'rejected', label: 'Rejected', statuses: ['invalid'] },
];

export const SORTS: { key: SortKey; label: string }[] = [
  { key: 'newest', label: 'Newest first' },
  { key: 'oldest', label: 'Oldest first' },
  { key: 'name', label: 'Name A–Z' },
  { key: 'largest', label: 'Largest first' },
];

const FORMATS: Record<string, string> = {
  'audio/wav': 'WAV',
  'audio/x-wav': 'WAV',
  'audio/wave': 'WAV',
  'audio/mpeg': 'MP3',
  'audio/mp4': 'M4A',
  'audio/x-m4a': 'M4A',
  'audio/flac': 'FLAC',
  'audio/ogg': 'OGG',
  'audio/webm': 'WEBM',
};

export function formatLabel(mime: string): string {
  const key = (mime.toLowerCase().split(';')[0] ?? '').trim();
  return FORMATS[key] ?? (key.split('/')[1] || key).toUpperCase();
}

export function matchesFilter(r: RecordingMetadata, filter: StatusFilter): boolean {
  const statuses = FILTERS.find((f) => f.key === filter)?.statuses;
  return !statuses || statuses.includes(r.status);
}

export function filterCounts(items: RecordingMetadata[]): Record<StatusFilter, number> {
  return {
    all: items.length,
    ready: items.filter((r) => matchesFilter(r, 'ready')).length,
    progress: items.filter((r) => matchesFilter(r, 'progress')).length,
    rejected: items.filter((r) => matchesFilter(r, 'rejected')).length,
  };
}

const time = (iso: string) => {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
};

export function visibleRecordings(
  items: RecordingMetadata[],
  query: string,
  filter: StatusFilter,
  sort: SortKey,
): RecordingMetadata[] {
  const q = query.trim().toLowerCase();
  const out = items.filter(
    (r) => matchesFilter(r, filter) && (!q || r.originalFilename.toLowerCase().includes(q)),
  );
  // Array#sort is stable, so ties keep the API's newest-first order.
  switch (sort) {
    case 'oldest':
      return out.sort((a, b) => time(a.createdAt) - time(b.createdAt));
    case 'name':
      return out.sort((a, b) => a.originalFilename.localeCompare(b.originalFilename));
    case 'largest':
      return out.sort((a, b) => b.sizeBytes - a.sizeBytes);
    default:
      return out.sort((a, b) => time(b.createdAt) - time(a.createdAt));
  }
}
