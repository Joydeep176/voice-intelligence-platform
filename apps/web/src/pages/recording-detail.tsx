import type { ProcessingState, RecordingMetadata } from '@vip/contracts';
import { ArrowLeft } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
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
import { AudioQualityCard } from '@/components/audio-quality/audio-quality-card';
import { useAudioDiagnostics } from '@/components/audio-quality/use-audio-diagnostics';
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

  // A1 audio-quality assessment of the recording's run (Phase 3A, ADR-0044). Hooks run before any
  // early return; refreshed when processing changes so a finished preprocessing shows up at once.
  const diagnosticsRunId =
    (fresh && fresh.base === state.data ? fresh.rec : state.data)?.latestRun?.id ?? null;
  const diagnostics = useAudioDiagnostics(diagnosticsRunId);
  const refreshDiagnostics = diagnostics.refresh;
  useEffect(() => {
    if (processingState === 'completed') refreshDiagnostics();
  }, [processingState]); // eslint-disable-line react-hooks/exhaustive-deps
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
            diagnostics={
              diagnostics.load.status === 'ready' && diagnostics.load.snapshot.diagnostics
                ? diagnostics.load.snapshot.diagnostics.flags.flatMap((f) =>
                    f.startMs === null || f.endMs === null
                      ? []
                      : [
                          {
                            kind: f.kind,
                            severity: f.severity,
                            startMs: f.startMs,
                            endMs: f.endMs,
                          },
                        ],
                  )
                : []
            }
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
            <AudioQualityCard
              load={diagnostics.load}
              onRetry={() => void diagnostics.retry()}
              busy={diagnostics.busy}
              actionError={diagnostics.actionError}
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
            audioQuality={
              diagnostics.load.status === 'ready' ? diagnostics.load.snapshot.state : null
            }
          />
          <ReportCard r={r} />
          <RecordingOverview r={r} />
        </div>
      </div>
    </div>
  );
}
