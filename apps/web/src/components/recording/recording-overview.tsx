import type { RecordingMetadata } from '@vip/contracts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatBytes, formatDateTime, formatDuration, shortHash } from '@/lib/format';

const FORMATS: Record<string, string> = {
  'audio/wav': 'WAV',
  'audio/x-wav': 'WAV',
  'audio/wave': 'WAV',
  'audio/mpeg': 'MP3',
  'audio/mp3': 'MP3',
  'audio/mp4': 'M4A',
  'audio/x-m4a': 'M4A',
  'audio/flac': 'FLAC',
  'audio/x-flac': 'FLAC',
  'audio/ogg': 'Ogg',
  'audio/webm': 'WebM',
};

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="text-sm font-medium break-all">{children}</dd>
    </div>
  );
}

export function RecordingOverview({ r }: { r: RecordingMetadata }) {
  const friendly = FORMATS[r.mimeType.toLowerCase()];
  return (
    <Card>
      <CardHeader>
        <CardTitle>Recording details</CardTitle>
      </CardHeader>
      <CardContent>
        <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-1">
          <Detail label="Format">
            {friendly ? `${friendly} · ` : ''}
            <span className="font-mono text-xs">{r.mimeType}</span>
          </Detail>
          <Detail label="Size">
            <span className="tabular-nums">{formatBytes(r.sizeBytes)}</span>
          </Detail>
          <Detail label="Duration">
            <span className="tabular-nums">{formatDuration(r.durationMs)}</span>
          </Detail>
          <Detail label="Uploaded">
            <time dateTime={r.createdAt}>{formatDateTime(r.createdAt)}</time>
          </Detail>
          <Detail label="SHA-256">
            <span className="font-mono text-xs" title={r.sha256 ?? undefined}>
              {shortHash(r.sha256)}
            </span>
          </Detail>
          <Detail label="Recording ID">
            <span className="font-mono text-xs">{r.id}</span>
          </Detail>
        </dl>
      </CardContent>
    </Card>
  );
}
