import { ArrowLeft, ChevronRight, FileQuestion } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { ProcessingStatusPanel } from '@/components/processing-status';
import { EmptyState, ErrorState, PageHeader } from '@/components/states';
import { RecordingStatusBadge } from '@/components/status-badge';
import { RecordingPlayback } from '@/components/recording/audio-player';
import { RecordingOverview } from '@/components/recording/recording-overview';
import { TranscriptCard } from '@/components/recording/transcript-card';
import { ApiRequestError, api } from '@/lib/api';
import { Link } from '@/lib/router';
import { useAsync } from '@/lib/use-async';

const POLL_MS = 10_000;

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
      <div className="grid gap-2">
        <Button asChild variant="ghost" size="sm" className="-ml-2 w-fit">
          <Link to="/recordings">
            <ArrowLeft aria-hidden data-icon="inline-start" />
            Back to recordings
          </Link>
        </Button>
        <nav aria-label="Breadcrumb">
          <ol className="text-muted-foreground flex min-w-0 items-center gap-1.5 text-xs">
            <li>
              <Link
                to="/recordings"
                className="hover:text-foreground underline-offset-4 hover:underline"
              >
                Recordings
              </Link>
            </li>
            <li aria-hidden>
              <ChevronRight className="size-3" />
            </li>
            <li aria-current="page" className="min-w-0 truncate">
              {r.originalFilename}
            </li>
          </ol>
        </nav>
      </div>
      <PageHeader title={r.originalFilename} actions={<RecordingStatusBadge status={r.status} />} />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="grid min-w-0 content-start gap-6">
          <RecordingPlayback
            key={r.id}
            recordingId={r.id}
            status={r.status}
            durationMs={r.durationMs}
          />
          <TranscriptCard />
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
        <div className="grid min-w-0 content-start gap-6">
          <ProcessingStatusPanel
            run={r.latestRun}
            recordingId={r.id}
            uploaded={r.status === 'uploaded' || r.status === 'valid'}
          />
          <RecordingOverview r={r} />
        </div>
      </div>
    </div>
  );
}
