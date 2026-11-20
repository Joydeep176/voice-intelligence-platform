import { ArrowLeft, FileQuestion } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { ProcessingStatusPanel } from '@/components/processing-status';
import { EmptyState, ErrorState, PageHeader } from '@/components/states';
import { RecordingStatusBadge } from '@/components/status-badge';
import { TimelinePlaceholder } from '@/components/timeline/timeline-placeholder';
import { ApiRequestError, api } from '@/lib/api';
import { formatBytes, formatDateTime, formatDuration, shortHash } from '@/lib/format';
import { Link } from '@/lib/router';
import { useAsync } from '@/lib/use-async';

const POLL_MS = 10_000;

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="text-sm font-medium break-all">{children}</dd>
    </div>
  );
}

function SeparateChannel({ title, description }: { title: string; description: string }) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
    </Card>
  );
}

export default function RecordingDetailPage({ id }: { id: string }) {
  // Polls in the background so status changes show up without a reload (progress stream: OD-16).
  const state = useAsync((signal) => api.getRecording(id, signal), [id], POLL_MS);

  if (state.status === 'loading') {
    return (
      <div role="status" className="grid gap-6">
        <span className="sr-only">Loading recording</span>
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (state.status === 'error') {
    if (state.error instanceof ApiRequestError && state.error.status === 404) {
      return (
        <EmptyState
          icon={<FileQuestion aria-hidden />}
          title="Recording not found"
          description="It may have been removed, or it belongs to another workspace."
          action={
            <Button asChild variant="outline" size="sm">
              <Link to="/recordings">Back to recordings</Link>
            </Button>
          }
        />
      );
    }
    return <ErrorState error={state.error} onRetry={state.reload} />;
  }

  const r = state.data;
  return (
    <div className="grid gap-6">
      <div>
        <Button asChild variant="ghost" size="sm" className="-ml-2">
          <Link to="/recordings">
            <ArrowLeft aria-hidden data-icon="inline-start" />
            Recordings
          </Link>
        </Button>
      </div>
      <PageHeader title={r.originalFilename} actions={<RecordingStatusBadge status={r.status} />} />

      <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
        <div className="grid min-w-0 gap-6">
          <Card>
            <CardHeader>
              <CardTitle>Recording details</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="grid gap-4 sm:grid-cols-2">
                <Detail label="Format">{r.mimeType}</Detail>
                <Detail label="Size">
                  <span className="tabular-nums">{formatBytes(r.sizeBytes)}</span>
                </Detail>
                <Detail label="Duration">{formatDuration(r.durationMs)}</Detail>
                <Detail label="Uploaded">
                  <time dateTime={r.createdAt}>{formatDateTime(r.createdAt)}</time>
                </Detail>
                <Detail label="SHA-256">
                  <span className="font-mono text-xs" title={r.sha256 ?? undefined}>
                    {shortHash(r.sha256)}
                  </span>
                </Detail>
                <Detail label="Recording ID">
                  <span className="font-mono text-xs">{r.id}</span>
                </Detail>
              </dl>
            </CardContent>
          </Card>
          <TimelinePlaceholder
            data={{ durationMs: r.durationMs, speakers: [], diagnostics: [], uncertainties: [] }}
          />
          {/* Audio limitations and transcription uncertainty are separate sections (FR-9.3). */}
          <div className="grid gap-4 sm:grid-cols-2">
            <SeparateChannel
              title="Audio quality"
              description="Signal-level diagnostics from the Audio Quality Agent. Not available yet."
            />
            <SeparateChannel
              title="Transcription uncertainty"
              description="Model-level uncertainty from the Transcription Agent. Not available yet."
            />
          </div>
        </div>
        <ProcessingStatusPanel
          run={r.latestRun}
          uploaded={r.status === 'uploaded' || r.status === 'valid'}
        />
      </div>
    </div>
  );
}
