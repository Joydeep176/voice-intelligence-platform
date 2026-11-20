import type { RecordingMetadata } from '@vip/contracts';
import { FolderOpen } from 'lucide-react';
import { RecordingStatusBadge, RunStatusBadge } from '@/components/status-badge';
import { EmptyState, ErrorState } from '@/components/states';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { formatBytes, formatDateTime } from '@/lib/format';
import { Link } from '@/lib/router';
import type { Loaded } from './kpi-cards';

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

function Row({ r }: { r: RecordingMetadata }) {
  return (
    <li>
      <Link
        to={`/recordings/${r.id}`}
        className="hover:bg-muted/60 focus-visible:ring-ring/50 -mx-3 grid gap-1.5 rounded-lg px-3 py-3 outline-none focus-visible:ring-[3px] sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:gap-4"
      >
        <span className="grid min-w-0 gap-1">
          <span className="truncate text-sm font-medium" title={r.originalFilename}>
            {r.originalFilename}
          </span>
          <span className="text-muted-foreground flex flex-wrap items-center gap-x-2 text-xs tabular-nums">
            <span>{formatDateTime(r.createdAt)}</span>
            <span aria-hidden>·</span>
            <span>{formatLabel(r.mimeType)}</span>
            <span aria-hidden>·</span>
            <span>{formatBytes(r.sizeBytes)}</span>
          </span>
        </span>
        <span className="flex flex-wrap items-center gap-1.5">
          <RecordingStatusBadge status={r.status} />
          {r.latestRun ? (
            <RunStatusBadge status={r.latestRun.status} />
          ) : (
            <span className="text-muted-foreground px-1 text-xs">No run</span>
          )}
        </span>
      </Link>
    </li>
  );
}

export function RecentRecordings({ data, onRetry }: { data: Loaded; onRetry: () => void }) {
  return (
    <Card className="gap-2">
      <CardHeader>
        <CardTitle>
          <h2 className="text-lg">Recent recordings</h2>
        </CardTitle>
        <CardDescription>Latest uploads to this workspace.</CardDescription>
        <CardAction>
          <Button variant="ghost" size="sm" asChild>
            <Link to="/recordings">View all</Link>
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        {data.status === 'loading' ? (
          <div role="status" aria-live="polite" className="divide-y">
            <span className="sr-only">Loading recordings</span>
            {Array.from({ length: 4 }, (_, i) => (
              <div key={i} className="grid gap-2 py-3 sm:grid-cols-[1fr_auto] sm:items-center">
                <div className="grid gap-2">
                  <Skeleton className="h-4 w-2/3" />
                  <Skeleton className="h-3 w-1/2" />
                </div>
                <Skeleton className="h-5 w-32" />
              </div>
            ))}
          </div>
        ) : null}
        {data.status === 'error' ? <ErrorState error={data.error} onRetry={onRetry} /> : null}
        {data.status === 'success' && data.items.length === 0 ? (
          <EmptyState
            icon={<FolderOpen aria-hidden />}
            title="No recordings yet"
            description="Upload a synthetic or explicitly consented audio file to get started."
            action={
              <Button asChild size="sm">
                <Link to="/recordings/new">Upload recording</Link>
              </Button>
            }
          />
        ) : null}
        {data.status === 'success' && data.items.length > 0 ? (
          <ul className="divide-y">
            {data.items.slice(0, 6).map((r) => (
              <Row key={r.id} r={r} />
            ))}
          </ul>
        ) : null}
      </CardContent>
    </Card>
  );
}
