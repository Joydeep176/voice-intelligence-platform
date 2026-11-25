import type { ProcessingState, ProcessingStatus, RecordingStatus } from '@vip/contracts';
import { ArrowRight, CheckCircle2, CircleDashed } from 'lucide-react';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { formatDateTime } from '@/lib/format';
import { Link } from '@/lib/router';
import { RunStatusBadge } from './status-badge';

/** Workflow steps (HLD §3). Ingestion, preprocessing (Phase 2B) and transcription with diarization
 * (Phase 2C) report their real state; the steps of later phases are shown as planned. */
const STEPS = [
  'Ingestion and upload',
  'Validation and preprocessing',
  'Audio quality analysis',
  'Transcription and diarization',
  'Context intelligence',
  'Research',
  'Fact validation',
  'Reporting',
  'Quality assurance',
] as const;

/** The upload finished once the recording left `uploading` (validation and rejection come after it). */
export const uploadCompleted = (status: RecordingStatus): boolean =>
  status !== 'uploading' && status !== 'deleting';

type StepState = 'Complete' | 'In progress' | 'Failed' | 'Cancelled' | 'Pending';

const PROCESSING_STEP: Record<ProcessingState, StepState> = {
  not_started: 'Pending',
  validating: 'In progress',
  queued: 'In progress',
  processing: 'In progress',
  completed: 'Complete',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

const RUN_STEP: Record<ProcessingStatus['status'], StepState> = {
  created: 'Pending',
  queued: 'In progress',
  running: 'In progress',
  cancelling: 'In progress',
  cancelled: 'Cancelled',
  completed: 'Complete',
  failed: 'Failed',
  needs_review: 'Complete',
};

function stepState(
  i: number,
  uploaded: boolean,
  processing: ProcessingState | null | undefined,
  run: ProcessingStatus | null,
): StepState | null {
  if (i === 0) return uploaded ? 'Complete' : 'Pending';
  if (i === 1) return processing ? PROCESSING_STEP[processing] : 'Pending';
  if (i === 3) return run ? RUN_STEP[run.status] : 'Pending';
  return null; // a later phase
}

export function ProcessingStatusPanel({
  run,
  uploaded,
  recordingId,
  processing,
}: {
  run: ProcessingStatus | null;
  uploaded: boolean;
  recordingId?: string;
  /** Audio processing state, as reported by the processing card. */
  processing?: ProcessingState | null;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Processing status</CardTitle>
        <CardDescription>
          {run?.status === 'created'
            ? 'Stored and recorded. Transcription has not been started.'
            : run
              ? `Last updated ${formatDateTime(run.updatedAt)}`
              : 'A processing run is created once the upload completes.'}
        </CardDescription>
        {run ? (
          <CardAction>
            <RunStatusBadge status={run.status} />
          </CardAction>
        ) : null}
      </CardHeader>
      <CardContent>
        <ol aria-label="Workflow steps" className="grid gap-2">
          {STEPS.map((step, i) => {
            const state = stepState(i, uploaded, processing, run);
            const done = state === 'Complete';
            return (
              <li key={step} className="flex items-center gap-3 text-sm">
                {done ? (
                  <CheckCircle2 aria-hidden className="text-success size-4 shrink-0" />
                ) : (
                  <CircleDashed aria-hidden className="text-muted-foreground/60 size-4 shrink-0" />
                )}
                <span className={done ? 'font-medium' : 'text-muted-foreground'}>{step}</span>
                <span className="text-muted-foreground ml-auto text-xs">
                  {state ?? 'Not available yet'}
                </span>
              </li>
            );
          })}
        </ol>
        {recordingId ? (
          <Link
            to={`/pipeline?recording=${recordingId}`}
            className="text-primary focus-visible:ring-ring/50 mt-4 inline-flex items-center gap-1 rounded-sm text-sm font-medium underline-offset-4 outline-none hover:underline focus-visible:ring-3"
          >
            View pipeline
            <ArrowRight aria-hidden className="size-3.5" />
          </Link>
        ) : null}
      </CardContent>
    </Card>
  );
}
