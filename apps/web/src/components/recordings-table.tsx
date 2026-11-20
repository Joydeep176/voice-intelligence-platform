import type { RecordingMetadata } from '@vip/contracts';
import { FileAudio } from 'lucide-react';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatBytes, formatDateTime } from '@/lib/format';
import { Link } from '@/lib/router';
import { RecordingStatusBadge, RunStatusBadge } from './status-badge';

/** Priority columns stay visible on narrow screens; the rest hide (layout-responsive.md). */
export function RecordingsTable({
  items,
  caption,
}: {
  items: RecordingMetadata[];
  caption: string;
}) {
  return (
    <Table>
      <caption className="sr-only">{caption}</caption>
      <TableHeader>
        <TableRow>
          <TableHead>Recording</TableHead>
          <TableHead>Status</TableHead>
          <TableHead className="hidden md:table-cell">Processing</TableHead>
          <TableHead className="hidden text-right sm:table-cell">Size</TableHead>
          <TableHead className="hidden lg:table-cell">Uploaded</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((r) => (
          <TableRow key={r.id}>
            <TableCell className="max-w-0 w-full">
              <Link
                to={`/recordings/${r.id}`}
                className="focus-visible:ring-ring/50 flex min-w-0 items-center gap-2 rounded-sm font-medium outline-none hover:underline focus-visible:ring-3"
              >
                <FileAudio aria-hidden className="text-muted-foreground size-4 shrink-0" />
                <span className="truncate">{r.originalFilename}</span>
              </Link>
            </TableCell>
            <TableCell>
              <RecordingStatusBadge status={r.status} />
            </TableCell>
            <TableCell className="hidden md:table-cell">
              {r.latestRun ? (
                <RunStatusBadge status={r.latestRun.status} />
              ) : (
                <span className="text-muted-foreground text-xs">—</span>
              )}
            </TableCell>
            <TableCell className="hidden text-right tabular-nums sm:table-cell">
              {formatBytes(r.sizeBytes)}
            </TableCell>
            <TableCell className="text-muted-foreground hidden lg:table-cell">
              <time dateTime={r.createdAt}>{formatDateTime(r.createdAt)}</time>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
