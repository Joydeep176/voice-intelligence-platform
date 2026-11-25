import type { RunSnapshot } from '@vip/contracts';
import { AlertCircle, Ban, FlaskConical, Loader2, Play, RotateCcw } from 'lucide-react';
import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { ErrorState } from '@/components/states';
import { Pill, ProgressBar } from '@/components/processing/processing-card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
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
import {
  FAKE_BANNER,
  failureView,
  hasFakeProvider,
  retriesLeft,
  runActions,
  runView,
  scopeText,
  stageRows,
  windowNote,
} from './model';
import { SpeakersPanel } from './speakers-panel';
import { TranscriptView } from './transcript-view';
import { useRun } from './use-run';
import { useTranscript } from './use-transcript';

/** Non-dismissible: fake output must never read as a real transcription. */
export function FakeProviderBanner() {
  return (
    <div
      role="note"
      aria-label="Development placeholder"
      data-testid="fake-provider-banner"
      className="border-warning bg-warning-soft text-foreground flex items-start gap-2 rounded-md border-2 border-dashed p-3 text-sm font-medium"
    >
      <FlaskConical aria-hidden className="text-warning mt-0.5 size-4 shrink-0" />
      <p>{FAKE_BANNER}</p>
    </div>
  );
}

const STATE_TEXT = {
  pending: 'Waiting',
  running: 'In progress',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
} as const;

function Stages({ s }: { s: RunSnapshot }) {
  const rows = stageRows(s);
  if (rows.length === 0) return null;
  const showBars = s.status === 'running' || s.status === 'cancelling';
  return (
    <ul className="grid gap-3" aria-label="Run stages">
      {rows.map((r) => (
        <li key={r.node} className="grid gap-1">
          <p className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
            <span className="font-medium">{r.label}</span>
            <span className="text-muted-foreground text-xs">{STATE_TEXT[r.state]}</span>
          </p>
          {showBars && r.state === 'running' ? (
            <ProgressBar fraction={r.fraction} label={`${r.label} progress`} />
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function TranscriptBody({
  runId,
  runFake,
  announce,
}: {
  runId: string;
  runFake: boolean;
  announce: (message: string) => void;
}) {
  const t = useTranscript(runId);
  if (t.page.status === 'loading') {
    return (
      <div role="status" aria-label="Loading transcript">
        <span className="sr-only">Loading transcript</span>
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }
  if (t.page.status === 'error') {
    return (
      <ErrorState error={t.page.error} onRetry={t.reload} title="Could not load the transcript" />
    );
  }
  const page = t.page;
  const speakers = t.speakers.status === 'ready' ? t.speakers.items : [];
  // The run snapshot already shows the banner; this covers a transcript page that says otherwise.
  const pageFake = hasFakeProvider(page.providers);
  const fake = runFake || pageFake;
  return (
    <div
      className={fake ? 'grid gap-5 rounded-md border border-dashed p-3' : 'grid gap-5'}
      data-fake={fake ? 'true' : undefined}
    >
      {pageFake && !runFake ? <FakeProviderBanner /> : null}

      {t.versions.length > 1 ? (
        <div className="flex items-center gap-2 text-sm">
          <label htmlFor="transcript-version" className="text-muted-foreground">
            Version
          </label>
          <select
            id="transcript-version"
            value={page.version}
            onChange={(e) => t.selectVersion(Number(e.target.value))}
            className="border-input bg-background h-8 rounded-lg border px-2 text-sm"
          >
            {t.versions.map((v) => (
              <option key={v.id} value={v.version}>
                {`v${v.version} · ${v.kind === 'machine' ? 'machine' : 'user correction'}`}
              </option>
            ))}
          </select>
        </div>
      ) : null}

      <section aria-labelledby="speakers-heading" className="grid gap-2">
        <h3 id="speakers-heading" className="text-sm font-semibold">
          Speakers
        </h3>
        {t.speakers.status === 'loading' ? <Skeleton className="h-12 w-full" /> : null}
        {t.speakers.status === 'error' ? (
          <p role="alert" className="text-destructive text-sm">
            Could not load speakers. Speaker names are unavailable.{' '}
            <Button variant="link" size="sm" className="h-auto p-0" onClick={t.reload}>
              Retry
            </Button>
          </p>
        ) : null}
        {t.speakers.status === 'ready' ? (
          <SpeakersPanel speakers={speakers} rename={t.rename} announce={announce} />
        ) : null}
      </section>

      <section aria-labelledby="segments-heading" className="grid gap-2">
        <h3 id="segments-heading" className="text-sm font-semibold">
          Segments
        </h3>
        {t.uncertaintyFailed ? (
          <p className="text-muted-foreground text-xs">
            Uncertainty markers could not be loaded; segments are shown without them.
          </p>
        ) : null}
        <TranscriptView
          items={page.items}
          speakers={speakers}
          uncertainties={t.uncertainties}
          nextCursor={page.nextCursor}
          loadingMore={t.loadingMore}
          moreFailed={t.moreFailed}
          onLoadMore={() => void t.loadMore()}
        />
      </section>
    </div>
  );
}

/**
 * Transcript section of the recording page (Phase 2C C2): run status and actions, the fake-provider
 * notice, speakers (rename) and the time-ordered segments. `preprocessingDone` comes from the audio
 * processing card; the API still enforces the precondition (409 is explained in plain language).
 */
export function TranscriptSection({
  recordingId,
  latestRunId,
  preprocessingDone,
  onRunStatusChange,
}: {
  recordingId: string;
  latestRunId: string | null;
  preprocessingDone: boolean;
  /** Reports the run status (null = no run) once loaded and whenever it changes. */
  onRunStatusChange?: (status: RunSnapshot['status'] | null) => void;
}) {
  const { load, refreshFailed, busy, actionError, act, reload } = useRun(recordingId, latestRunId);
  const [message, setMessage] = useState('');
  const statusRef = useRef<HTMLDivElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);

  const snapshot = load.status === 'ready' ? load.snapshot : null;
  const view = runView(snapshot);
  const lastLabel = useRef<string | null>(null);

  // Polite announcement of state changes only (not every progress tick).
  useEffect(() => {
    if (load.status === 'loading') return;
    if (lastLabel.current !== null && lastLabel.current !== view.label) {
      setMessage(`Transcription: ${view.label}`);
    }
    lastLabel.current = view.label;
  }, [load.status, view.label]);

  const runStatus = snapshot?.status ?? null;
  const loaded = load.status === 'ready' || load.status === 'none';
  const report = useEffectEvent((status: RunSnapshot['status'] | null) =>
    onRunStatusChange?.(status),
  );
  useEffect(() => {
    if (loaded) report(runStatus);
  }, [loaded, runStatus]);

  useEffect(() => {
    if (actionError) errorRef.current?.focus();
  }, [actionError]);

  const run = async (action: 'start' | 'cancel' | 'retry') => {
    if (await act(action)) statusRef.current?.focus();
  };

  const header = (
    <CardHeader>
      <CardTitle>Transcript</CardTitle>
      <CardDescription>
        Speech to text with speaker labels, as produced. Nothing here is judged for quality or
        accuracy.
      </CardDescription>
      {load.status === 'ready' || load.status === 'none' ? (
        <CardAction>
          <Pill {...view} />
        </CardAction>
      ) : null}
    </CardHeader>
  );

  if (load.status === 'loading') {
    return (
      <Card data-testid="transcription-section">
        {header}
        <CardContent>
          <div role="status" aria-label="Loading transcription status">
            <span className="sr-only">Loading transcription status</span>
            <Skeleton className="h-16 w-full" />
          </div>
        </CardContent>
      </Card>
    );
  }
  if (load.status === 'error') {
    return (
      <Card data-testid="transcription-section">
        {header}
        <CardContent>
          <ErrorState
            error={load.error}
            onRetry={reload}
            title="Could not load transcription status"
          />
        </CardContent>
      </Card>
    );
  }

  const actions = runActions(snapshot);
  const failure = snapshot?.status === 'failed' ? failureView(snapshot) : null;
  const window = snapshot ? windowNote(snapshot.window) : null;
  const fake = hasFakeProvider(snapshot?.providers);
  const active =
    snapshot?.status === 'queued' ||
    snapshot?.status === 'running' ||
    snapshot?.status === 'cancelling';

  return (
    <Card data-testid="transcription-section">
      {header}
      <CardContent className="grid gap-4">
        <div
          role="status"
          aria-live="polite"
          aria-atomic="true"
          aria-label="Transcription status"
          className="sr-only"
        >
          {message}
        </div>

        {fake ? <FakeProviderBanner /> : null}

        <div
          ref={statusRef}
          tabIndex={-1}
          aria-label="Transcription run details"
          className="grid gap-3 outline-none"
        >
          <p className="text-muted-foreground text-sm">{scopeText(snapshot)}</p>
          {window ? <p className="text-muted-foreground text-xs">{window}</p> : null}

          {snapshot?.status === 'queued' ? (
            <p className="text-muted-foreground text-sm">Waiting for a free worker.</p>
          ) : null}
          {snapshot && active ? <Stages s={snapshot} /> : null}
          {snapshot &&
          (snapshot.status === 'cancelling' ||
            (snapshot.status === 'running' && snapshot.cancelRequested)) ? (
            <p className="text-muted-foreground text-sm">
              Cancellation requested. Waiting for the run to stop.
            </p>
          ) : null}
          {snapshot?.status === 'cancelled' ? (
            <p className="text-muted-foreground text-sm">
              The run was cancelled. No transcript was stored.
            </p>
          ) : null}
          {failure ? (
            <Alert variant="destructive" role="group" aria-label="Transcription failure">
              <AlertCircle aria-hidden />
              <AlertTitle>Transcription failed</AlertTitle>
              <AlertDescription>
                <p>{failure.message}</p>
                <p>{failure.retry}</p>
              </AlertDescription>
            </Alert>
          ) : null}
          {snapshot?.status === 'completed' && !snapshot.transcriptAvailable ? (
            <p className="text-muted-foreground text-sm">
              The run completed but stored no transcript.
            </p>
          ) : null}
          {actions.start && !preprocessingDone ? (
            <p className="text-muted-foreground text-sm">
              Transcription can start once audio processing has completed.
            </p>
          ) : null}
        </div>

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
        {snapshot && actions.retry ? (
          <p className="text-muted-foreground text-xs">
            {retriesLeft(snapshot)} {retriesLeft(snapshot) === 1 ? 'retry' : 'retries'} remaining.
          </p>
        ) : null}

        {(actions.start && preprocessingDone) || actions.retry || actions.cancel ? (
          <div className="flex flex-wrap gap-2">
            {actions.start && preprocessingDone ? (
              <Button disabled={busy !== null} onClick={() => void run('start')}>
                {busy === 'start' ? (
                  <Loader2
                    aria-hidden
                    className="motion-safe:animate-spin"
                    data-icon="inline-start"
                  />
                ) : (
                  <Play aria-hidden data-icon="inline-start" />
                )}
                Start transcription
              </Button>
            ) : null}
            {actions.retry ? (
              <Button variant="outline" disabled={busy !== null} onClick={() => void run('retry')}>
                {busy === 'retry' ? (
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
              <Button variant="outline" disabled={busy !== null} onClick={() => void run('cancel')}>
                {busy === 'cancel' ? (
                  <Loader2
                    aria-hidden
                    className="motion-safe:animate-spin"
                    data-icon="inline-start"
                  />
                ) : (
                  <Ban aria-hidden data-icon="inline-start" />
                )}
                Cancel
              </Button>
            ) : null}
          </div>
        ) : null}

        {snapshot?.transcriptAvailable ? (
          <TranscriptBody
            key={snapshot.id}
            runId={snapshot.id}
            runFake={fake}
            announce={setMessage}
          />
        ) : null}
      </CardContent>
    </Card>
  );
}
