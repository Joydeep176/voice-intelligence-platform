import type { ProcessingStatus } from '@vip/contracts';
import { CheckCircle2, CircleDashed } from 'lucide-react';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { formatDateTime } from '@/lib/format';
import { RunStatusBadge } from './status-badge';

/** Workflow steps (HLD §3). Only ingestion exists in Phase 1; the rest are shown as planned. */
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

export function ProcessingStatusPanel({
  run,
  uploaded,
}: {
  run: ProcessingStatus | null;
  uploaded: boolean;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Processing status</CardTitle>
        <CardDescription>
          {run?.status === 'created'
            ? 'Stored and recorded. Not yet submitted for analysis: the analysis pipeline is not available in this build.'
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
            const done = i === 0 && uploaded;
            return (
              <li key={step} className="flex items-center gap-3 text-sm">
                {done ? (
                  <CheckCircle2 aria-hidden className="text-success size-4 shrink-0" />
                ) : (
                  <CircleDashed aria-hidden className="text-muted-foreground/60 size-4 shrink-0" />
                )}
                <span className={done ? 'font-medium' : 'text-muted-foreground'}>{step}</span>
                <span className="text-muted-foreground ml-auto text-xs">
                  {done ? 'Complete' : i === 0 ? 'Pending' : 'Not available yet'}
                </span>
              </li>
            );
          })}
        </ol>
      </CardContent>
    </Card>
  );
}
