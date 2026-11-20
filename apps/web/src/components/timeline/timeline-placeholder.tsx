import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
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
    empty: 'Produced by transcription and diarization (later phase).',
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
    empty: 'Produced by the Transcription Agent (later phase).',
  },
];

/**
 * Structure of the aligned timeline (audio-visualisation.md): one shared time axis with separate
 * tracks. Phase 1 renders the layout only. No waveform is computed and no audio is decoded
 * in the browser.
 */
export function TimelinePlaceholder({ data }: { data: TimelineData }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Timeline</CardTitle>
        <CardDescription>
          Speakers, audio quality and transcription uncertainty appear here once analysis is
          available.
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
          <div className="min-w-[32rem]">
            <div
              aria-hidden
              className="text-muted-foreground mb-2 ml-44 flex justify-between text-xs tabular-nums"
            >
              <span>0:00</span>
              <span>{data.durationMs === null ? 'Duration not yet determined' : ''}</span>
            </div>
            <ul className="grid gap-2">
              {TRACKS.map((track) => (
                <li key={track.id} className="grid grid-cols-[10.5rem_1fr] items-center gap-3">
                  <span className="flex items-center gap-2 text-sm font-medium">
                    <span aria-hidden className={cn('size-2.5 rounded-full', track.swatch)} />
                    {track.label}
                  </span>
                  <div className="bg-muted/50 text-muted-foreground flex h-9 items-center rounded-md border border-dashed px-3 text-xs">
                    {track.empty}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
