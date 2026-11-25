import type { SpeakerDto, TranscriptSegmentDto, UncertaintyDto } from '@vip/contracts';
import { Loader2, TriangleAlert } from 'lucide-react';
import { useMemo } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  formatTimestamp,
  LANGUAGES,
  speakerLabel,
  uncertaintiesFor,
  uncertaintyLabel,
} from './model';

function Segment({
  segment,
  label,
  markers,
}: {
  segment: TranscriptSegmentDto;
  label: string;
  markers: UncertaintyDto[];
}) {
  const language = LANGUAGES[segment.language];
  return (
    <li className="grid gap-1 border-b py-3 last:border-b-0" data-testid="segment">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        <span className="text-muted-foreground font-mono tabular-nums">
          <span className="sr-only">Time </span>
          {formatTimestamp(segment.startMs)}
          <span aria-hidden>–</span>
          <span className="sr-only"> to </span>
          {formatTimestamp(segment.endMs)}
        </span>
        <span className="text-foreground font-medium">{label}</span>
        <Badge variant="outline">
          <span className="sr-only">Language: </span>
          {language.label}
        </Badge>
        {segment.confidence !== null ? (
          <span className="text-muted-foreground tabular-nums">
            Confidence {Math.round(segment.confidence * 100)}%
          </span>
        ) : null}
        {markers.map((m) => (
          <Badge key={m.id} variant="secondary" className="bg-warning-soft text-foreground gap-1">
            <TriangleAlert aria-hidden className="text-warning size-3" />
            <span className="sr-only">Uncertainty: </span>
            {uncertaintyLabel(m.kind)}
            {m.score !== null ? (
              <span className="tabular-nums"> {Math.round(m.score * 100)}%</span>
            ) : null}
          </Badge>
        ))}
      </div>
      {/* Provider text exactly as produced; `lang` only when the language is a single one. */}
      <p lang={language.lang} className="text-sm leading-relaxed break-words">
        {segment.text}
      </p>
    </li>
  );
}

export function TranscriptView({
  items,
  speakers,
  uncertainties,
  nextCursor,
  loadingMore,
  moreFailed,
  onLoadMore,
}: {
  items: TranscriptSegmentDto[];
  speakers: SpeakerDto[];
  uncertainties: UncertaintyDto[];
  nextCursor: string | null;
  loadingMore: boolean;
  moreFailed: boolean;
  onLoadMore: () => void;
}) {
  const bySpeaker = useMemo(() => new Map(speakers.map((s) => [s.id, s])), [speakers]);
  if (items.length === 0) {
    return <p className="text-muted-foreground text-sm">This transcript has no segments.</p>;
  }
  return (
    <div className="grid gap-3">
      <ol aria-label="Transcript segments" className="grid">
        {items.map((seg) => (
          <Segment
            key={seg.id}
            segment={seg}
            label={speakerLabel(seg, bySpeaker)}
            markers={uncertaintiesFor(seg, uncertainties)}
          />
        ))}
      </ol>
      {moreFailed ? (
        <p role="alert" className="text-destructive text-sm">
          Could not load more segments. Try again.
        </p>
      ) : null}
      {nextCursor ? (
        <Button variant="outline" className="w-fit" disabled={loadingMore} onClick={onLoadMore}>
          {loadingMore ? (
            <Loader2 aria-hidden className="motion-safe:animate-spin" data-icon="inline-start" />
          ) : null}
          Load more
        </Button>
      ) : (
        <p className="text-muted-foreground text-xs">End of transcript.</p>
      )}
    </div>
  );
}
