import type { ProcessingState, RecordingMetadata } from '@vip/contracts';
import { ArrowLeft } from 'lucide-react';
import { useCallback, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ProcessingStatusPanel, uploadCompleted } from '@/components/processing-status';
import {
  RECORDING_PAGE_CLASS,
  RecordingBreadcrumb,
  recordingStateFallback,
} from '@/components/recording-frame';
import { PageHeader } from '@/components/states';
import { RecordingStatusBadge } from '@/components/status-badge';
import { ProcessingCard } from '@/components/processing/processing-card';
import { RecordingPlayback } from '@/components/recording/audio-player';
import { RecordingOverview } from '@/components/recording/recording-overview';
import { ReportCard } from '@/components/reports/report-card';
import { TranscriptSection } from '@/components/transcription/transcript-section';
import { api } from '@/lib/api';
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
  // Audio processing must be completed before transcription can start (reported by the card).
  const [processingState, setProcessingState] = useState<ProcessingState | null>(null);
  // Immediate refetch when processing or the run changes, so the header, player, details and
  // sidebar do not wait for the next poll. Not `reload` (it would flash the loading state and
  // remount the cards). Keyed to the polled data, so the next poll supersedes it.
  const [fresh, setFresh] = useState<{ base: unknown; rec: RecordingMetadata } | null>(null);
  const base = state.data;
  const refetch = useCallback(() => {
    api.getRecording(id).then(
      (rec) => setFresh({ base, rec }),
      () => undefined, // the poll still catches up
    );
  }, [id, base]);
  const lastProcessing = useRef<ProcessingState | null>(null);
  const lastRun = useRef<string | null | undefined>(undefined);
  const onProcessingState = (next: ProcessingState) => {
    setProcessingState(next);
    if (lastProcessing.current !== null && lastProcessing.current !== next) refetch();
    lastProcessing.current = next;
  };
  const onRunStatusChange = (next: string | null) => {
    if (lastRun.current !== undefined && lastRun.current !== next) refetch();
    lastRun.current = next;
  };

  const fallback = recordingStateFallback(state, {
    loadingLabel: 'Loading recording',
    backTo: '/recordings',
    backLabel: 'Back to recordings',
    midHeight: 'h-40',
  });
  if (fallback) return fallback;
  if (state.status !== 'success') return null;

  const r = fresh && fresh.base === state.data && fresh.rec.id === id ? fresh.rec : state.data;
  return (
    <div className={RECORDING_PAGE_CLASS}>
      <div className="grid min-w-0 gap-2">
        <Button asChild variant="ghost" size="sm" className="-ml-2 w-fit">
          <Link to="/recordings">
            <ArrowLeft aria-hidden data-icon="inline-start" />
            Back to recordings
          </Link>
        </Button>
        <RecordingBreadcrumb
          items={[
            { label: 'Recordings', to: '/recordings' },
            { label: r.originalFilename, filename: true },
          ]}
        />
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
          <ProcessingCard
            key={`processing-${r.id}`}
            recordingId={r.id}
            onStateChange={onProcessingState}
          />
          <TranscriptSection
            key={`transcript-${r.id}`}
            recordingId={r.id}
            latestRunId={r.latestRun?.id ?? null}
            preprocessingDone={processingState === 'completed'}
            onRunStatusChange={onRunStatusChange}
          />
          {/* Audio limitations and transcription uncertainty are separate sections (FR-9.3). */}
          <div className="grid gap-4 sm:grid-cols-2">
            <SeparateChannel
              title="Audio quality"
              description="Signal-level diagnostics from the Audio Quality Agent. Not available yet."
            />
            <SeparateChannel
              title="Transcription uncertainty"
              description="Model-level markers from the transcription run appear on the transcript segments above (overlapping speech, speaker uncertain). They are separate from audio diagnostics."
            />
          </div>
        </div>
        <div className="grid min-w-0 content-start gap-6">
          <ProcessingStatusPanel
            run={r.latestRun}
            recordingId={r.id}
            uploaded={uploadCompleted(r.status)}
            processing={processingState}
          />
          <ReportCard r={r} />
          <RecordingOverview r={r} />
        </div>
      </div>
    </div>
  );
}
