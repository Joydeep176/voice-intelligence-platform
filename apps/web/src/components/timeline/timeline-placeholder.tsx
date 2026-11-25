import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { formatDuration } from '@/lib/format';
import { cn } from 'cn';
import type { TimelineData } from './types';

interface Track {
  id: string;
  label: string;
  /** Token family used once data exists (diagnostics and uncertainty never share one). */
  swatch: string;
  empty: string;
}

const TRACKS: Track[] = [
  {
    id: 'waveform',
    label: 'Waveform',
    swatch: 'bg-muted-foreground/40',
    empty: 'Waveform data source not decided yet (OD-39).',
  },
  {
    id: 'speakers',
    label: 'Speakers',
    swatch: 'bg-speaker-1',
    empty: 'Speakers are listed in the Transcript section. The timeline track is not drawn yet.',
  },
  {
    id: 'diagnostics',
    label: 'Audio quality',
    swatch: 'bg-diag-medium',
    empty: 'Produced by the Audio Quality Agent (later phase).',
  },
  {
    id: 'uncertainty',
    label: 'Transcription uncertainty',
    swatch: 'bg-uncert-medium',
    empty:
      'Uncertainty markers appear on the Transcript segments. The timeline track is not drawn yet.',
  },
];

/**
 * Structure of the aligned timeline (audio-visualisation.md): one shared time axis with separate
 * tracks. Phase 1 renders the layout only. No waveform is computed and no audio is decoded
 * in the browser.
 */
export function TimelinePlaceholder({
  data,
  positionMs = null,
}: {
  data: TimelineData;
  /** Current playback position. The playhead is drawn only when the duration is known. */
  positionMs?: number | null;
}) {
  const playheadPct =
    data.durationMs && data.durationMs > 0 && positionMs !== null
      ? Math.min(100, Math.max(0, (positionMs / data.durationMs) * 100))
      : null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Timeline</CardTitle>
        <CardDescription>
          Aligned tracks are not drawn yet. Audio quality arrives in a later phase.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {/* Focusable so keyboard users can scroll the tracks on narrow screens (WCAG 2.1.1). */}
        <div
          role="region"
          aria-label="Timeline tracks"
          tabIndex={0}
          className="focus-visible:ring-ring/50 overflow-x-auto rounded-md outline-none focus-visible:ring-3"
        >
          <div className="relative sm:min-w-[32rem]">
            <div
              aria-hidden
              className="text-muted-foreground mb-2 flex sm:ml-[11.25rem] justify-between text-xs tabular-nums"
            >
              <span>0:00</span>
              <span>
                {data.durationMs === null
                  ? 'Duration not yet determined'
                  : formatDuration(data.durationMs)}
              </span>
            </div>
            <ul className="grid gap-2">
              {TRACKS.map((track) => (
                <li
                  key={track.id}
                  className="grid gap-1.5 sm:grid-cols-[10.5rem_1fr] sm:items-center sm:gap-3"
                >
                  <span className="flex items-center gap-2 text-sm font-medium">
                    <span aria-hidden className={cn('size-2.5 rounded-full', track.swatch)} />
                    {track.label}
                  </span>
                  <div className="bg-muted/50 text-muted-foreground relative flex min-h-9 items-center rounded-md border border-dashed px-3 py-1.5 text-xs">
                    {track.empty}
                    {playheadPct !== null ? (
                      <div
                        aria-hidden
                        className="bg-primary pointer-events-none absolute inset-y-0 w-0.5 -translate-x-1/2 rounded-full sm:hidden"
                        style={{ left: `${playheadPct}%` }}
                      />
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
            {playheadPct !== null ? (
              <div
                aria-hidden
                className="pointer-events-none absolute inset-y-0 right-0 left-[11.25rem] hidden sm:block"
              >
                <div
                  data-testid="timeline-playhead"
                  className="bg-primary absolute inset-y-0 w-0.5 -translate-x-1/2 rounded-full"
                  style={{ left: `${playheadPct}%` }}
                />
              </div>
            ) : null}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
