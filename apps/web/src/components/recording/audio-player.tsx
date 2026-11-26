import type { RecordingStatus } from '@vip/contracts';
import { Pause, Play, TriangleAlert } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { TimelinePlaceholder } from '@/components/timeline/timeline-placeholder';
import type { TimelineData } from '@/components/timeline/types';
import { issuePlaybackUrl } from './playback-url';

type Phase = 'issuing' | 'loading' | 'ready' | 'error';

const finite = (n: number) => Number.isFinite(n) && n >= 0;

function clock(seconds: number): string {
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

export function isPlayable(status: RecordingStatus): boolean {
  return status === 'uploaded' || status === 'valid';
}

/**
 * The audio player and the timeline share the playback position. Holding it here keeps the
 * ~4 Hz time updates from re-rendering the rest of the page.
 */
export function RecordingPlayback({
  recordingId,
  status,
  durationMs,
  diagnostics = [],
}: {
  recordingId: string;
  status: RecordingStatus;
  durationMs: number | null;
  /** Timestamped A1 flags of the run (Phase 3A); whole-recording flags are not drawn on a track. */
  diagnostics?: TimelineData['diagnostics'];
}) {
  const [position, setPosition] = useState(0);
  const [fileDuration, setFileDuration] = useState<number | null>(null);
  const known = fileDuration !== null ? fileDuration * 1000 : durationMs;
  return (
    <>
      <AudioPlayer
        recordingId={recordingId}
        playable={isPlayable(status)}
        storedDurationMs={durationMs}
        onTime={setPosition}
        onDuration={setFileDuration}
      />
      <TimelinePlaceholder
        data={{ durationMs: known, speakers: [], diagnostics, uncertainties: [] }}
        positionMs={position * 1000}
      />
    </>
  );
}

function AudioPlayer({
  recordingId,
  playable,
  storedDurationMs,
  onTime,
  onDuration,
}: {
  recordingId: string;
  playable: boolean;
  storedDurationMs: number | null;
  onTime: (seconds: number) => void;
  onDuration: (seconds: number) => void;
}) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const retried = useRef(false);
  const resumeAt = useRef(0);
  const [phase, setPhase] = useState<Phase>('issuing');
  const [reason, setReason] = useState<'not-playable' | 'unavailable'>('unavailable');
  const [url, setUrl] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState<number | null>(null);

  // Issues once per page view: scoped to the recording, its playable status and explicit retries.
  useEffect(() => {
    if (!playable) return;
    const controller = new AbortController();
    void issuePlaybackUrl(recordingId, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      if (result.ok) {
        setUrl(result.url);
        setPhase('loading');
      } else {
        setReason(result.reason);
        setPhase('error');
      }
    });
    return () => controller.abort();
  }, [recordingId, playable, attempt]);

  // Pause and release the media resource on unmount.
  useEffect(() => {
    const el = audioRef.current;
    return () => {
      if (!el) return;
      el.pause();
      el.removeAttribute('src');
      el.load();
    };
  }, []);

  const reissue = () => {
    resumeAt.current = current;
    setPlaying(false);
    setUrl(null);
    setPhase('issuing');
    setAttempt((n) => n + 1);
  };

  const onError = (el: HTMLAudioElement) => {
    if (!el.getAttribute('src')) return; // released on unmount
    if (!retried.current) {
      retried.current = true; // an expired URL: re-issue once
      reissue();
    } else {
      setPlaying(false);
      setReason('unavailable');
      setPhase('error');
    }
  };

  const retry = () => {
    retried.current = false;
    resumeAt.current = 0;
    reissue();
  };

  const toggle = () => {
    const el = audioRef.current;
    if (!el) return;
    if (el.paused)
      el.play().catch(() => undefined); // failures surface through the error event
    else el.pause();
  };

  const seek = (seconds: number) => {
    const el = audioRef.current;
    if (!el) return;
    el.currentTime = seconds;
    setCurrent(seconds);
    onTime(seconds);
  };

  const total = duration ?? (storedDurationMs !== null ? storedDurationMs / 1000 : null);
  const busy = phase === 'issuing' || phase === 'loading';

  return (
    <Card>
      <CardHeader>
        <CardTitle>Audio player</CardTitle>
        <CardDescription>Plays the stored original recording.</CardDescription>
      </CardHeader>
      <CardContent>
        {!playable ? (
          <p className="text-muted-foreground text-sm">
            Playback is available once the upload has completed.
          </p>
        ) : null}
        {playable && phase === 'error' ? (
          <div role="alert" className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <p className="text-destructive flex items-center gap-2 text-sm font-medium">
              <TriangleAlert aria-hidden className="size-4 shrink-0" />
              {reason === 'not-playable'
                ? 'Playback is available once the upload has completed.'
                : 'Playback unavailable'}
            </p>
            <Button variant="outline" className="h-11 sm:h-8" onClick={retry}>
              Try again
            </Button>
          </div>
        ) : null}
        {playable && busy ? (
          <div role="status" className="flex items-center gap-4">
            <span className="sr-only">Loading audio</span>
            <Skeleton className="size-12 shrink-0 rounded-full motion-reduce:animate-none" />
            <Skeleton className="h-3 flex-1 motion-reduce:animate-none" />
          </div>
        ) : null}
        <audio
          ref={audioRef}
          src={url ?? undefined}
          preload="metadata"
          onLoadedMetadata={(e) => {
            const d = e.currentTarget.duration;
            if (finite(d)) {
              setDuration(d);
              onDuration(d);
            }
            if (resumeAt.current > 0) e.currentTarget.currentTime = resumeAt.current;
            resumeAt.current = 0;
            setPhase('ready');
          }}
          onTimeUpdate={(e) => {
            setCurrent(e.currentTarget.currentTime);
            onTime(e.currentTarget.currentTime);
          }}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => setPlaying(false)}
          onError={(e) => onError(e.currentTarget)}
        />
        {playable && phase === 'ready' ? (
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-4">
            <Button
              type="button"
              size="icon-lg"
              aria-label={playing ? 'Pause' : 'Play'}
              onClick={toggle}
              className="h-14 w-full rounded-full sm:size-11"
            >
              {playing ? (
                <Pause aria-hidden className="size-5" />
              ) : (
                <Play aria-hidden className="size-5" />
              )}
            </Button>
            <input
              type="range"
              aria-label="Seek"
              min={0}
              max={total ?? 0}
              step={1}
              value={Math.min(current, total ?? 0)}
              disabled={total === null}
              onChange={(e) => seek(Number(e.currentTarget.value))}
              aria-valuetext={total === null ? undefined : `${clock(current)} of ${clock(total)}`}
              className="accent-primary focus-visible:ring-ring/50 h-11 min-w-0 flex-1 cursor-pointer rounded-md outline-none focus-visible:ring-3 disabled:cursor-not-allowed disabled:opacity-50 sm:h-6"
            />
            <div className="text-sm tabular-nums sm:text-right">
              <span className="font-medium">{clock(current)}</span>
              <span className="text-muted-foreground">
                {' / '}
                {total === null ? '–:––' : clock(total)}
              </span>
              {storedDurationMs === null && duration !== null ? (
                <p className="text-muted-foreground text-xs">Duration from the audio file</p>
              ) : null}
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
