import type { AudioDiagnosticsSnapshot } from '@vip/contracts';
import { AlertTriangle, RotateCcw } from 'lucide-react';
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
import { cn } from '@/lib/utils';
import {
  BASIS_LABEL,
  canRetryDiagnostics,
  CLASS_DESCRIPTION,
  CLASS_LABEL,
  CLASS_TONE,
  FLAG_LABEL,
  flagRange,
  NOT_ASSESSED_LABEL,
  REASON_LABEL,
  RECOMMENDATION_TEXT,
  SEVERITY_LABEL,
  SEVERITY_TONE,
  STATE_MESSAGE,
  SUITABILITY_LABEL,
} from './model';
import type { DiagnosticsLoad } from './use-audio-diagnostics';

const MAX_FLAGS = 8;

/**
 * The Audio Quality Agent's assessment (A1, ADR-0043). A separate channel from transcription
 * uncertainty (FR-9.3): different heading, wording and colour family. Confidence is categorical and
 * rule-based, never shown as a number.
 */
export function AudioQualityCard({
  load,
  onRetry,
  busy = false,
  actionError = false,
}: {
  load: DiagnosticsLoad;
  onRetry?: () => void;
  busy?: boolean;
  actionError?: boolean;
}) {
  return (
    <Card size="sm" aria-labelledby="audio-quality-title">
      <CardHeader>
        <CardTitle id="audio-quality-title">Audio quality</CardTitle>
        <CardDescription>
          Assessment by the Audio Quality Agent from objective audio measurements. Separate from
          transcription uncertainty.
        </CardDescription>
        {load.status === 'ready' && canRetryDiagnostics(load.snapshot.state) && onRetry ? (
          <CardAction>
            <Button size="sm" variant="outline" onClick={onRetry} disabled={busy}>
              <RotateCcw aria-hidden className="size-3.5" />
              {load.snapshot.state === 'failed' ? 'Retry assessment' : 'Assess audio'}
            </Button>
          </CardAction>
        ) : null}
      </CardHeader>
      <CardContent className="grid gap-3 text-sm">
        <Body load={load} />
        {actionError ? (
          <p role="alert" className="text-destructive text-xs">
            The assessment could not be requested. Try again.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function Body({ load }: { load: DiagnosticsLoad }) {
  if (load.status === 'none')
    return <p className="text-muted-foreground">Available once the recording has a run.</p>;
  if (load.status === 'loading') return <Skeleton className="h-16 w-full" />;
  if (load.status === 'error')
    return (
      <p className="text-muted-foreground">The audio-quality assessment could not be loaded.</p>
    );
  const { snapshot } = load;
  if (snapshot.state !== 'completed' || !snapshot.diagnostics)
    return (
      <p className="text-muted-foreground" aria-live="polite">
        {STATE_MESSAGE[snapshot.state === 'completed' ? 'pending' : snapshot.state]}
      </p>
    );
  return <Assessment diagnostics={snapshot.diagnostics} />;
}

function Assessment({
  diagnostics,
}: {
  diagnostics: NonNullable<AudioDiagnosticsSnapshot['diagnostics']>;
}) {
  const { summary, flags, recommendations } = diagnostics;
  const rank = { high: 0, medium: 1, low: 2 } as const;
  // Significant problems (medium/high) are listed, worst first; low-severity observations are
  // counted, so many minor flags never crowd out the assessment.
  const significant = flags
    .filter((f) => f.severity !== 'low')
    .sort((a, b) => rank[a.severity] - rank[b.severity]);
  const shown = significant.slice(0, MAX_FLAGS);
  const lowCount = flags.length - significant.length;
  return (
    <>
      <div className="grid gap-1">
        <p className="flex flex-wrap items-baseline gap-x-2">
          <span className={cn('text-base font-semibold', CLASS_TONE[summary.overall])}>
            {CLASS_LABEL[summary.overall]}
          </span>
          <span className="text-muted-foreground text-xs">
            Confidence: {summary.confidence} (rule-based, not a probability)
          </span>
        </p>
        <p className="text-muted-foreground">{CLASS_DESCRIPTION[summary.overall]}</p>
        {summary.provisional ? (
          <p className="text-muted-foreground flex items-center gap-1 text-xs">
            <AlertTriangle aria-hidden className="size-3.5" />
            Provisional thresholds ({summary.ruleVersion}): not yet calibrated or approved.
          </p>
        ) : null}
      </div>

      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        {(['transcription', 'diarization'] as const).map((k) => {
          const s = summary.suitability[k];
          const reasons = s.reasons
            .map((r) => REASON_LABEL[r] ?? (FLAG_LABEL as Record<string, string>)[r]?.toLowerCase())
            .filter(Boolean);
          return (
            <div key={k} className="contents">
              <dt className="text-muted-foreground">
                {k === 'transcription' ? 'For transcription' : 'For speaker separation'}
              </dt>
              <dd>
                {SUITABILITY_LABEL[s.value]}
                {reasons.length ? ` (${reasons.join('; ')})` : ''}
              </dd>
            </div>
          );
        })}
      </dl>

      {shown.length ? (
        <div className="grid gap-1.5">
          <h3 className="text-xs font-medium">Detected problems</h3>
          <ul className="grid gap-1" aria-label="Detected audio problems">
            {shown.map((f) => (
              <li key={f.id} className="flex flex-wrap items-center gap-2 text-xs">
                <Badge variant="outline" className={SEVERITY_TONE[f.severity]}>
                  {SEVERITY_LABEL[f.severity]}
                </Badge>
                <span className="font-medium">{FLAG_LABEL[f.kind]}</span>
                <span className="text-muted-foreground tabular-nums">
                  {flagRange(f.startMs, f.endMs)}
                </span>
                <span className="text-muted-foreground">· {BASIS_LABEL[f.basis]}</span>
              </li>
            ))}
          </ul>
          {significant.length > shown.length ? (
            <p className="text-muted-foreground text-xs">
              {significant.length - shown.length} more not shown.
            </p>
          ) : null}
        </div>
      ) : (
        <p className="text-muted-foreground text-xs">No significant audio problems detected.</p>
      )}
      {lowCount > 0 ? (
        <p className="text-muted-foreground text-xs">
          {lowCount} low-severity {lowCount === 1 ? 'observation' : 'observations'} (
          {[
            ...new Set(
              flags
                .filter((f) => f.severity === 'low')
                .map((f) => FLAG_LABEL[f.kind].toLowerCase()),
            ),
          ].join(', ')}
          ) do not affect the assessment.
        </p>
      ) : null}

      {recommendations.length ? (
        <div className="grid gap-1">
          <h3 className="text-xs font-medium">Recommendations</h3>
          <ul className="text-muted-foreground list-disc pl-4 text-xs">
            {recommendations.map((r) => (
              <li key={r.code}>{RECOMMENDATION_TEXT[r.code] ?? r.code}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <p className="text-muted-foreground text-xs">
        Not assessed:{' '}
        {summary.notAssessed.map((n) => NOT_ASSESSED_LABEL[n.dimension] ?? n.dimension).join(', ')}.
      </p>
    </>
  );
}
