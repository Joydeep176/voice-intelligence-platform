import type { ProcessingPreprocessing, ProcessingSnapshot, ProcessingState } from '@vip/contracts';
import {
  AlertCircle,
  Ban,
  CheckCircle2,
  CircleDashed,
  Loader2,
  Play,
  RotateCcw,
  TriangleAlert,
  XCircle,
} from 'lucide-react';
import { type ReactNode, useEffect, useEffectEvent, useRef } from 'react';
import { ErrorState } from '@/components/states';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
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
import { formatDuration } from '@/lib/format';
import { cn } from 'cn';
import { Measurements } from './measurements';
import {
  actionsFor,
  type BadgeKind,
  decodeClassLabel,
  describeFailure,
  isStale,
  mappingExplanation,
  statusView,
  type Tone,
  vadMessage,
} from './model';
import { useProcessing } from './use-processing';

const TONES: Record<Tone, string> = {
  neutral: 'bg-muted text-muted-foreground',
  success: 'bg-success-soft text-success',
  warning: 'bg-warning-soft text-warning',
  danger: 'bg-destructive/10 text-destructive',
  info: 'bg-info-soft text-info',
};

const ICONS: Record<BadgeKind, typeof Loader2> = {
  idle: CircleDashed,
  busy: Loader2,
  done: CheckCircle2,
  error: XCircle,
  stopped: Ban,
  cancelling: Ban,
};

export function Pill({ label, tone, kind }: { label: string; tone: Tone; kind: BadgeKind }) {
  const Icon = ICONS[kind];
  return (
    <Badge variant="secondary" className={cn('gap-1 font-medium', TONES[tone])}>
      <Icon aria-hidden className={cn('size-3', kind === 'busy' && 'motion-safe:animate-spin')} />
      {label}
    </Badge>
  );
}

/**
 * Determinate only from a persisted fraction; otherwise indeterminate with no percentage and no
 * `aria-valuenow`. Plain element (not Radix Progress) to keep Radix out of the shared chunk.
 */
export function ProgressBar({ fraction, label }: { fraction: number | null; label: string }) {
  const percent = fraction === null ? null : Math.round(fraction * 100);
  return (
    <div className="grid gap-1">
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent ?? undefined}
        data-state={percent === null ? 'indeterminate' : 'loading'}
        className="bg-muted relative h-2 w-full overflow-hidden rounded-full"
      >
        <div
          className={cn(
            'bg-primary size-full rounded-full',
            percent === null
              ? 'opacity-40 motion-safe:animate-pulse'
              : 'transition-transform motion-reduce:transition-none',
          )}
          style={percent === null ? undefined : { transform: `translateX(-${100 - percent}%)` }}
        />
      </div>
      <p className="text-muted-foreground text-xs tabular-nums">
        {percent === null ? 'Progress not reported yet' : `${percent}%`}
      </p>
    </div>
  );
}

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-0.5">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="text-sm font-medium">{children}</dd>
    </div>
  );
}

const orDash = (v: ReactNode) => v ?? '—';

function CompletedDetails({ s, p }: { s: ProcessingSnapshot; p: ProcessingPreprocessing }) {
  const canonical = p.measurements.find((m) => m.source === 'canonical')?.record;
  const rate = typeof canonical?.sampleRateHz === 'number' ? canonical.sampleRateHz : null;
  const channels = typeof canonical?.channels === 'number' ? canonical.channels : null;
  const t = p.timeline;
  return (
    <div className="grid gap-5">
      <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
        <Detail label="Processed duration">
          <span className="tabular-nums">
            {p.canonical ? formatDuration(p.canonical.durationMs) : '—'}
          </span>
        </Detail>
        <Detail label="Processed audio">
          <span className="tabular-nums">
            {rate !== null && channels !== null
              ? `${rate.toLocaleString('en-US')} Hz, ${channels} ${channels === 1 ? 'channel' : 'channels'}`
              : '—'}
          </span>
        </Detail>
        <Detail label="Original audio">
          <span className="tabular-nums">
            {s.probe?.sampleRateHz != null && s.probe.channels != null
              ? `${s.probe.sampleRateHz.toLocaleString('en-US')} Hz, ${s.probe.channels} ${s.probe.channels === 1 ? 'channel' : 'channels'}`
              : '—'}
          </span>
        </Detail>
        <Detail label="Decode">{orDash(t ? decodeClassLabel(t.decodeClass) : null)}</Detail>
        <Detail label="Timeline mapping">
          {t ? (
            <>
              <span className="capitalize">{t.mappingStatus.replace('_', ' ')}</span>
              <span className="text-muted-foreground block text-xs font-normal">
                {mappingExplanation(t)}
              </span>
            </>
          ) : (
            'Not available'
          )}
        </Detail>
        <Detail label="Voice activity detection">{vadMessage(p.vad)}</Detail>
        <Detail label="Segments">
          <span className="tabular-nums">{orDash(p.segmentCount)}</span>
        </Detail>
      </dl>
      <div className="grid gap-2">
        <h3 className="text-sm font-semibold">Measurements</h3>
        <Measurements p={p} />
      </div>
    </div>
  );
}

export function ProcessingCard({
  recordingId,
  onStateChange,
}: {
  recordingId: string;
  /** Reports the processing state whenever it changes (for the transcript section's Start button). */
  onStateChange?: (state: ProcessingState) => void;
}) {
  const { load, now, refreshFailed, busy, actionError, run, reload } = useProcessing(recordingId);
  const reportedState = load.status === 'ready' ? load.snapshot.state : null;
  const report = useEffectEvent((state: ProcessingState) => onStateChange?.(state));
  useEffect(() => {
    if (reportedState) report(reportedState);
  }, [reportedState]);
  const statusRef = useRef<HTMLDivElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (actionError) errorRef.current?.focus();
  }, [actionError]);

  const act = async (action: 'start' | 'cancel') => {
    if (await run(action)) statusRef.current?.focus();
  };

  if (load.status === 'loading') {
    return (
      <Card data-testid="processing-card">
        <CardHeader>
          <CardTitle>Audio processing</CardTitle>
        </CardHeader>
        <CardContent>
          <div role="status" aria-label="Loading audio processing status">
            <span className="sr-only">Loading audio processing status</span>
            <Skeleton className="h-16 w-full" />
          </div>
        </CardContent>
      </Card>
    );
  }
  if (load.status === 'error') {
    return (
      <Card data-testid="processing-card">
        <CardHeader>
          <CardTitle>Audio processing</CardTitle>
        </CardHeader>
        <CardContent>
          <ErrorState
            error={load.error}
            onRetry={reload}
            title="Could not load processing status"
          />
        </CardContent>
      </Card>
    );
  }

  const s = load.snapshot;
  const p = s.preprocessing;
  const view = statusView(s);
  const stale = isStale(s, now);
  const actions = actionsFor(s);
  const showProgress = s.state === 'validating' || s.state === 'queued' || s.state === 'processing';
  const fraction = s.state === 'processing' ? (p?.progress?.fraction ?? null) : null;
  const failure = s.state === 'failed' ? describeFailure(s) : null;

  return (
    <Card data-testid="processing-card">
      <CardHeader>
        <CardTitle>Audio processing</CardTitle>
        <CardDescription>
          Decoding, validation and signal measurements. Measurements are numbers only, with no
          quality judgement.
        </CardDescription>
        <CardAction className="flex flex-wrap justify-end gap-1">
          <Pill {...view} />
          {stale ? <Pill label="No update received" tone="warning" kind="idle" /> : null}
        </CardAction>
      </CardHeader>
      <CardContent className="grid gap-4">
        {/* Polite announcements of state changes only (not every progress tick). */}
        <div
          role="status"
          aria-live="polite"
          aria-atomic="true"
          aria-label="Audio processing status"
          className="sr-only"
        >
          {`Audio processing: ${view.label}${stale ? '. No update received for over a minute' : ''}`}
        </div>

        <div
          ref={statusRef}
          tabIndex={-1}
          aria-label="Processing details"
          className="grid gap-4 outline-none"
        >
          {showProgress ? (
            <ProgressBar
              fraction={fraction}
              label={s.state === 'validating' ? 'Validation progress' : 'Processing progress'}
            />
          ) : null}

          {s.state === 'not_started' ? (
            <p className="text-muted-foreground text-sm">
              {s.recording.status === 'invalid'
                ? describeFailure(s).message
                : 'This recording has not been processed yet.'}
            </p>
          ) : null}
          {s.state === 'validating' ? (
            <p className="text-muted-foreground text-sm">Checking that the file is valid audio.</p>
          ) : null}
          {s.state === 'queued' ? (
            <p className="text-muted-foreground text-sm">Waiting for a free worker.</p>
          ) : null}
          {stale ? (
            <p className="text-warning flex items-start gap-1.5 text-sm">
              <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
              No progress update has been received for over a minute. Processing may be stuck; this
              page keeps checking.
            </p>
          ) : null}
          {s.state === 'processing' && p?.cancelRequested ? (
            <p className="text-muted-foreground text-sm">
              Cancellation requested. Waiting for processing to stop.
            </p>
          ) : null}
          {s.state === 'cancelled' ? (
            <p className="text-muted-foreground text-sm">Processing was cancelled.</p>
          ) : null}

          {failure ? (
            <Alert variant="destructive" role="group" aria-label="Processing failure">
              <AlertCircle aria-hidden />
              <AlertTitle>
                {s.recording.status === 'invalid' && !p
                  ? 'Recording rejected'
                  : 'Processing failed'}
              </AlertTitle>
              <AlertDescription>
                <p>{failure.message}</p>
                <p>{failure.retry}</p>
              </AlertDescription>
            </Alert>
          ) : null}

          {s.state === 'completed' && p ? <CompletedDetails s={s} p={p} /> : null}
        </div>

        {actions.remaining !== null && actions.retry ? (
          <p className="text-muted-foreground text-xs">
            {actions.remaining} {actions.remaining === 1 ? 'retry' : 'retries'} remaining.
          </p>
        ) : null}
        {actions.remaining === 0 ? (
          <p className="text-muted-foreground text-xs">No retries left.</p>
        ) : null}

        {actionError ? (
          <div
            ref={errorRef}
            tabIndex={-1}
            role="alert"
            className="text-destructive text-sm outline-none"
          >
            {actionError}
          </div>
        ) : null}
        {refreshFailed ? (
          <p className="text-muted-foreground text-xs">
            Could not refresh the status. Showing the last known state.
          </p>
        ) : null}

        {actions.start || actions.retry || actions.cancel ? (
          <div className="flex flex-wrap gap-2">
            {actions.start ? (
              <Button disabled={busy !== null} onClick={() => void act('start')}>
                {busy === 'start' ? (
                  <Loader2
                    aria-hidden
                    className="motion-safe:animate-spin"
                    data-icon="inline-start"
                  />
                ) : (
                  <Play aria-hidden data-icon="inline-start" />
                )}
                Start processing
              </Button>
            ) : null}
            {actions.retry ? (
              <Button variant="outline" disabled={busy !== null} onClick={() => void act('start')}>
                {busy === 'start' ? (
                  <Loader2
                    aria-hidden
                    className="motion-safe:animate-spin"
                    data-icon="inline-start"
                  />
                ) : (
                  <RotateCcw aria-hidden data-icon="inline-start" />
                )}
                Retry
              </Button>
            ) : null}
            {actions.cancel ? (
              <Button variant="outline" disabled={busy !== null} onClick={() => void act('cancel')}>
                {busy === 'cancel' ? (
                  <Loader2
                    aria-hidden
                    className="motion-safe:animate-spin"
                    data-icon="inline-start"
                  />
                ) : (
                  <Ban aria-hidden data-icon="inline-start" />
                )}
                Cancel processing
              </Button>
            ) : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
